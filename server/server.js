const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const path       = require('path');
const cron       = require('node-cron');
// Resolve .env from the project root (parent of this server/ dir) so the key is
// found whether the server is started from c:\files\ OR c:\files\server\
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const app = express();
const PORT = parseInt(process.env.PORT || '5500', 10);

// Anthropic and Stripe are initialized eagerly with a 'missing' sentinel so
// the process always starts. Routes call _requireEnv() and get a clean 503
// if a key is absent rather than a confusing auth error from the SDK.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'missing' });
const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY            || 'missing');

// OpenAI is initialized LAZILY — only on first use — so a missing key or
// empty balance never prevents startup or blocks unrelated services
// (HeyGen avatar/voice loading, Supabase, Stripe, Anthropic all remain up).
let _openaiInstance = null;
function _getOpenAI() {
  if (!_openaiInstance) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    _openaiInstance = new OpenAI({ apiKey: key });
  }
  return _openaiInstance;
}

// ── Resolved config constants ─────────────────────────────────────
// Single definition for every value that would otherwise be duplicated
// across multiple routes as process.env.X || 'hardcoded-default'.
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://orivenai.com';
const SMTP_HOST    = process.env.SMTP_HOST    || 'smtp-mail.outlook.com';
const SMTP_PORT    = parseInt(process.env.SMTP_PORT || '587', 10);

// Decode a JWT payload without any library
function decodeJwtRole(token) {
  try {
    const payload = token.split('.')[1];
    const base64  = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json    = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json).role || null;
  } catch (_) {
    return null;
  }
}

// Admin Supabase client — must use service_role key to bypass RLS
// Server-side options: disable session persistence (no localStorage in Node)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Startup sanity checks ───────────────────────────────────────
(function checkEnv() {
  const srk  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const role = decodeJwtRole(srk);

  console.log('\n══════════════ ORIVEN SERVER STARTUP ══════════════');

  if (!srk) {
    console.error('❌ [ENV] SUPABASE_SERVICE_ROLE_KEY is not set');
  } else if (!role) {
    console.error('❌ [ENV] SUPABASE_SERVICE_ROLE_KEY is not a valid JWT');
    console.error('   Get the service_role key from: Supabase Dashboard → Settings → API');
  } else if (role !== 'service_role') {
    console.error(`❌ [ENV] SUPABASE_SERVICE_ROLE_KEY JWT role = "${role}" — expected "service_role"`);
    console.error('   ⚡ You set the ANON key as the service role key — this is the most common mistake');
    console.error('   ⚡ The anon key cannot bypass RLS. Supabase updates in the webhook WILL be silently blocked.');
    console.error('   Fix: Supabase Dashboard → Settings → API → copy the "service_role" key (labeled DANGER)');
    console.error('   Then update SUPABASE_SERVICE_ROLE_KEY in server/.env and restart the server');
  } else {
    console.log('✅ [ENV] SUPABASE_SERVICE_ROLE_KEY JWT role = "service_role" ← correct');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ [ENV] STRIPE_WEBHOOK_SECRET is not set — all webhooks will be rejected');
  } else {
    console.log('✅ [ENV] STRIPE_WEBHOOK_SECRET is set');
  }

  if (!process.env.FRONTEND_URL) {
    console.error('❌ [ENV] FRONTEND_URL is not set — Stripe will redirect to wrong URL after payment');
    console.error('   Fix: set FRONTEND_URL to https://orivenai.com in Render environment variables');
  } else {
    console.log('✅ [ENV] FRONTEND_URL =', process.env.FRONTEND_URL);
  }

  // ── AI keys ─────────────────────────────────────────────────────
  const _ck = (val, label) => {
    if (!val || val === 'missing') { console.error('❌ [ENV] ' + label + ' is not set'); }
    else { console.log('✅ [ENV] ' + label + ' = ' + val.slice(0, 10) + '...'); }
  };
  _ck(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY');
  _ck(process.env.OPENAI_API_KEY,    'OPENAI_API_KEY');
  _ck(process.env.HEYGEN_API_KEY,    'HEYGEN_API_KEY');

  // ── Stripe ───────────────────────────────────────────────────────
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk || sk === 'missing') {
    console.error('❌ [ENV] STRIPE_SECRET_KEY is not set — payments will fail');
  } else {
    console.log('✅ [ENV] STRIPE_SECRET_KEY =', sk.startsWith('sk_live') ? '✅ LIVE key' : '⚠️  TEST key');
  }
  const _price = (k) => console.log(' ', k, '=', process.env[k] || '❌ NOT SET');
  _price('STRIPE_PRICE_STARTER');
  _price('STRIPE_PRICE_PREMIUM');
  _price('STRIPE_PRICE_BUSINESS');

  // ── SMTP ─────────────────────────────────────────────────────────
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('⚠️  [ENV] SMTP_USER / SMTP_PASS not fully set — verification emails will be skipped');
  } else {
    console.log('✅ [ENV] SMTP configured for', process.env.SMTP_USER);
  }

  console.log('═══════════════════════════════════════════════════\n');
})();

const PRICE_IDS = {
  starter:  process.env.STRIPE_PRICE_STARTER,
  premium:  process.env.STRIPE_PRICE_PREMIUM,
  business: process.env.STRIPE_PRICE_BUSINESS,
};

app.use(cors());

// ── Static files — serve the frontend from the project root ────
// This makes Express the single origin for both HTML and API routes,
// so relative /api/... URLs from the browser resolve to this process.
// Must come before express.json() but after cors() so CORS headers
// are present on static responses too.
app.use(express.static(path.resolve(__dirname, '..')));

// ── Stripe webhook — must be registered BEFORE express.json() ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('\n──────────────────────────────────────────');
  console.log('[Webhook] ▶ Route hit');

  // 1. Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('[Webhook] ✅ Signature verified');
  } catch (err) {
    console.error('[Webhook] ❌ Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Log event type
  console.log('[Webhook] Event type:', event.type);
  console.log('[Webhook] Event id:  ', event.id);

  // ── Subscription deleted (cancellation applied) ──────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    console.log('[Webhook] subscription.deleted → customer:', customerId);
    if (customerId) {
      const { error } = await supabaseAdmin.from('profiles')
        .update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null })
        .eq('stripe_customer_id', customerId);
      if (error) console.error('[Webhook] subscription.deleted DB error:', error.message);
      else console.log('[Webhook] ✅ Plan reset to free for customer:', customerId);
    }
    return res.json({ received: true });
  }

  // ── Subscription updated (paid-to-paid switch) ────────────────
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const customerId = sub.customer;
    const pendingPlan = sub.metadata && sub.metadata.pending_plan;
    if (pendingPlan && sub.status === 'active') {
      console.log('[Webhook] subscription.updated → applying plan:', pendingPlan);
      const { error } = await supabaseAdmin.from('profiles')
        .update({ subscription_status: pendingPlan, pending_plan: null, pending_plan_date: null })
        .eq('stripe_customer_id', customerId);
      if (error) console.error('[Webhook] subscription.updated DB error:', error.message);
      else console.log('[Webhook] ✅ Plan updated to:', pendingPlan, 'for customer:', customerId);
    } else {
      console.log('[Webhook] subscription.updated — no pending_plan or not active, skipping');
    }
    return res.json({ received: true });
  }

  if (event.type !== 'checkout.session.completed') {
    console.log('[Webhook] ℹ️  Ignoring event type:', event.type);
    return res.json({ received: true });
  }

  const session = event.data.object;

  // 3. Log full metadata for debugging
  console.log('[Webhook] payment_status:', session.payment_status);
  console.log('[Webhook] session.metadata:', JSON.stringify(session.metadata));

  // 4. Extract userId and plan
  const userId = session.metadata && session.metadata.userId;
  const plan   = session.metadata && session.metadata.plan;

  console.log('[Webhook] Extracted userId:', userId || '(MISSING)');
  console.log('[Webhook] Extracted plan:  ', plan   || '(MISSING)');

  // 5. Guard: both fields must be present
  if (!userId) {
    console.error('[Webhook] ❌ userId missing from metadata — cannot update Supabase');
    return res.json({ received: true });
  }
  if (!plan) {
    console.error('[Webhook] ❌ plan missing from metadata — cannot update Supabase');
    return res.json({ received: true });
  }

  // 6. Guard: plan must be a known value
  const validPlans = ['starter', 'premium', 'business'];
  if (!validPlans.includes(plan)) {
    console.error(`[Webhook] ❌ Unknown plan "${plan}" — expected one of: ${validPlans.join(', ')}`);
    return res.json({ received: true });
  }

  // 7. Guard: payment must be confirmed
  if (session.payment_status !== 'paid') {
    console.warn(`[Webhook] ⚠️  payment_status is "${session.payment_status}", not "paid" — skipping update`);
    return res.json({ received: true });
  }

  // 8. Attempt Supabase update
  console.log(`[Webhook] 🔄 UPDATE profiles SET subscription_status = '${plan}' WHERE id = '${userId}'`);

  const { data: updateData, error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({
      subscription_status: plan,
      stripe_subscription_id: session.subscription || null,
      stripe_customer_id: session.customer || null
    })
    .eq('id', userId)
    .select('id, subscription_status');

  // Log raw update result — never assume success without checking
  console.log('[Webhook] Raw update response:');
  console.log('           data: ', JSON.stringify(updateData));
  console.log('           error:', JSON.stringify(updateError));

  if (updateError) {
    console.error('[Webhook] ❌ UPDATE failed');
    console.error('           code:   ', updateError.code);
    console.error('           message:', updateError.message);
    console.error('           details:', updateError.details);
    console.error('           hint:   ', updateError.hint);
    if (updateError.code === '42501') {
      console.error('[Webhook] ❌ RLS policy blocked the update — service_role key is probably wrong');
    }
  } else if (!updateData || updateData.length === 0) {
    console.warn('[Webhook] ⚠️  UPDATE matched 0 rows');
    console.warn('           This means no profile row has id =', userId);
    console.warn('           Checking whether the row exists at all...');

    const { data: checkData, error: checkError } = await supabaseAdmin
      .from('profiles')
      .select('id, subscription_status')
      .eq('id', userId)
      .maybeSingle();

    if (checkError) {
      console.error('[Webhook] ❌ Existence check failed:', checkError.message);
    } else if (!checkData) {
      console.error('[Webhook] ❌ No profile row found for userId:', userId);
      console.error('           The user may not have a profiles row yet');
    } else {
      console.log('[Webhook] ℹ️  Row exists but was not updated:', JSON.stringify(checkData));
      console.log('[Webhook]    This is likely an RLS permission problem');
    }
  } else {
    console.log('[Webhook] ✅ UPDATE succeeded — rows changed:', updateData.length);
    console.log('[Webhook]    Updated row:', JSON.stringify(updateData[0]));
  }

  // 9. Independent post-update verification SELECT — confirms what's in the DB right now
  console.log('[Webhook] 🔎 Verifying current DB value...');
  const { data: verifyData, error: verifyError } = await supabaseAdmin
    .from('profiles')
    .select('id, subscription_status')
    .eq('id', userId)
    .maybeSingle();

  if (verifyError) {
    console.error('[Webhook] ❌ Verification SELECT failed:', verifyError.message);
  } else if (!verifyData) {
    console.error('[Webhook] ❌ Verification: no row found in profiles for userId:', userId);
  } else {
    const actual = verifyData.subscription_status;
    if (actual === plan) {
      console.log(`[Webhook] ✅ CONFIRMED — DB shows subscription_status = "${actual}"`);
    } else {
      console.error(`[Webhook] ❌ MISMATCH — expected "${plan}" but DB shows "${actual}"`);
      console.error('[Webhook]    The update did not persist — check service_role key and RLS policies');
    }
  }

  console.log('──────────────────────────────────────────\n');
  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// ── Web generator — registered immediately after json middleware ──
app.post('/api/generate-web', async (req, res) => {
  if (!_requireEnv('ANTHROPIC_API_KEY', res, 'Anthropic')) return;
  const {
    brand_name, product, goal,
    style, animations, sections,
    primary_color, secondary_color, accent_color,
    background_color, text_color,
    web_type, layout,
    prompt
  } = req.body;

  // Resolve colors with fallbacks
  const bgColor   = background_color || '#0a0a0a';
  const txtColor  = text_color       || '#f0f0f0';
  const primColor = primary_color    || '#B7FF2A';
  const secColor  = secondary_color  || '#9FE81F';
  const accColor  = accent_color     || '#BFA07A';

  const conversionGoalLabels = {
    signup:    'Sign up / free trial — every CTA drives toward account creation or trial',
    purchase:  'Purchase — product-first, overcome buying hesitation, clear price and value',
    contact:   'Contact / enquiry — build trust first, make reaching out feel low-friction',
    download:  'Download — surface the benefit immediately, single-click CTA',
    book_call: 'Book a call — social proof heavy, calendar CTA prominent',
    awareness: 'Brand awareness — storytelling over selling, memorability over conversion',
  };
  const goalDescription = (goal && conversionGoalLabels[goal]) || (goal ? `Goal: ${goal}` : null);

  const userPrompt = prompt || [
    brand_name       ? `Brand name: ${brand_name}`                   : null,
    web_type         ? `Website type: ${web_type}`                   : null,
    product          ? `Promoting: ${product}`                       : null,
    goalDescription  ? `Conversion goal: ${goalDescription}`         : null,
    style            ? `Design style: ${style}`                      : null,
    layout           ? `Layout direction: ${layout}`                 : null,
    animations       ? `Animations: ${animations}`                   : null,
    sections         ? `Sections: ${sections}`                       : null,
    `Background color: ${bgColor}`,
    `Text color: ${txtColor}`,
    `Primary color: ${primColor}`,
    `Secondary color: ${secColor}`,
    `Accent color: ${accColor}`,
  ].filter(Boolean).join('\n');

  if (!userPrompt) return res.status(400).json({ error: 'No input provided' });

  console.log('[Web] Anthropic → generating brand-aligned landing page');

  const systemPrompt = `You are a senior web designer and frontend engineer who builds pixel-perfect, brand-aligned landing pages.

Generate a complete, production-ready HTML landing page that STRICTLY follows the brand identity provided in the brief.

BRAND IDENTITY RULES — NON-NEGOTIABLE:
- Page background MUST be exactly the "Background color" value from the brief
- All body text MUST use exactly the "Text color" value from the brief
- Primary buttons, hero sections, and main CTAs MUST use the "Primary color"
- Secondary blocks, alternate sections, and supporting elements MUST use the "Secondary color"
- Borders, dividers, highlights, and accent details MUST use the "Accent color"
TECHNICAL REQUIREMENTS:
- Output ONLY a complete HTML document starting with <!DOCTYPE html>
- All CSS inside a <style> tag in <head> — no external stylesheets, no CDN links
- Define CSS custom properties at :root for all brand colors and use them throughout
- Use system fonts (system-ui, -apple-system, Georgia, serif) — no web font CDNs
- No icons, no emojis, no SVG illustrations
- All copy must be specific to the product/brand in the brief — no lorem ipsum
- Include: a nav bar, all sections listed in the brief, and a footer
- Footer must include small text: "Generated by ORIVEN"
- Fully responsive — mobile and desktop
- Animations: use CSS keyframes only if the brief requests them

OUTPUT: Return ONLY the HTML document. No explanation, no preamble, no markdown fences. Start directly with <!DOCTYPE html>.`;

  try {
    const response = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 8000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }]
    });

    let raw = response.content[0].text.trim();

    // Strip markdown code fences if Claude wrapped the output
    raw = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    // Extract only the HTML document
    const start  = raw.search(/<!DOCTYPE\s+html/i);
    const end    = raw.search(/<\/html\s*>/i);
    const match  = raw.match(/<\/html\s*>/i);
    const html   = (start !== -1 && end !== -1 && match)
      ? raw.slice(start, end + match[0].length)
      : raw;

    if (!html || html.length < 100) {
      console.error('[Web] response too short or missing HTML');
      return res.status(500).json({ error: 'Failed to generate website' });
    }

    console.log(`[Web] page ready — ${html.length} chars`);
    res.json({ html });
  } catch (err) {
    console.error('[Web] Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to generate website' });
  }
});

// ── Service key guard ─────────────────────────────────────────────
// Call at the top of any route that needs a specific env var.
// Returns true if the key exists; otherwise sends a 503 and returns false.
function _requireEnv(key, res, label) {
  const val = process.env[key];
  if (!val || val === 'missing') {
    const svc = label || key;
    console.error('[503] ' + key + ' is not configured');
    res.status(503).json({ error: svc + ' is not configured. Set ' + key + ' in environment variables.' });
    return false;
  }
  return true;
}

// ── Auth helper — verify Supabase JWT and return user ───────────
async function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user;
  } catch (_) { return null; }
}

// ── Shared SMTP transporter factory ─────────────────────────────
function _smtpTransporter() {
  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { ciphers: 'SSLv3' }
  });
}

// ── Verification email HTML ──────────────────────────────────────
function _verificationEmailHtml(firstName, verifyUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verify your ORIVEN email</title></head>
<body style="margin:0;padding:0;background:#F5F3F0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 24px rgba(0,0,0,.08)">
    <div style="background:#0A0A0A;padding:32px 40px 28px">
      <div style="font-size:22px;font-weight:700;color:#B7FF2A;letter-spacing:-.5px">ORIVEN</div>
      <div style="font-size:13px;color:rgba(255,255,255,.5);margin-top:4px">Brand Intelligence Platform</div>
    </div>
    <div style="padding:36px 40px">
      <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111">Hi ${firstName},</p>
      <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6">
        Thanks for joining ORIVEN. Please verify your email address to keep your account active.
        You have <strong>14 days</strong> from sign-up to complete this.
      </p>
      <a href="${verifyUrl}" style="display:inline-block;background:#B7FF2A;color:#000;font-size:14px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px">
        Verify Email Address
      </a>
      <p style="margin:24px 0 0;font-size:12px;color:#999;line-height:1.6">
        Or paste this link into your browser:<br>
        <a href="${verifyUrl}" style="color:#555;word-break:break-all">${verifyUrl}</a>
      </p>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #F0EDE8">
      <p style="margin:0;font-size:12px;color:#999;line-height:1.6">
        If you didn't create an ORIVEN account, you can safely ignore this email.<br>
        Questions? <a href="mailto:studio.oriven@outlook.com" style="color:#555">studio.oriven@outlook.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});


// ── Shared helpers ──────────────────────────────────────────────

async function callAnthropic(systemPrompt, userPrompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY missing)');
  const params = {
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (systemPrompt) params.system = systemPrompt;
  const response = await anthropic.messages.create(params);
  return response.content[0].text;
}

// ── DALL-E 3 supported sizes: 1024x1024 | 1024x1792 | 1792x1024 ─
async function callDallE(imagePrompt, size = '1024x1024') {
  const client = _getOpenAI();
  if (!client) throw new Error('OpenAI API key not configured (OPENAI_API_KEY missing)');
  const validSizes = ['1024x1024', '1024x1792', '1792x1024'];
  const safeSize   = validSizes.includes(size) ? size : '1024x1024';

  const response = await client.images.generate({
    model:   'dall-e-3',
    prompt:  imagePrompt,
    n:       1,
    size:    safeSize,
    quality: 'hd',
  });
  return response.data[0].url;
}

// ── Extract a concise DALL-E image prompt from a structured brief ─
// Uses Anthropic to translate a multi-section brief into a vivid,
// DALL-E-optimised image description (150–300 characters).
async function _briefToDallEPrompt(fullBrief, contextHint) {
  const system = `You are a visual art director. Convert the following structured brief into a single DALL-E 3 image generation prompt.

The prompt must:
- Be 150–300 characters
- Describe a specific, photorealistic or design-art visual scene
- Reference brand colours from the brief by name or hex if present — e.g. "neon green (#B7FF2A) accent on black background"
- Match the composition, mood, and format requirements in the brief
- NOT mention text, headlines, logos, buttons, or UI elements
- NOT start with "Generate" or "Create" — just describe what is seen

Output ONLY the image prompt. No labels. No explanation. No quotes.`;

  const userMsg = (contextHint ? 'Context: ' + contextHint + '\n\n' : '')
    + 'Brief:\n' + fullBrief.slice(0, 2000);

  const response = await anthropic.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 200,
    system,
    messages:   [{ role: 'user', content: userMsg }]
  });
  return response.content[0].text.trim().slice(0, 450);
}

// ── Text — Anthropic only ───────────────────────────────────────
// Used by: Text, Brand Assistant, Ideas, Video
app.post('/api/generate-text', async (req, res) => {
  if (!_requireEnv('ANTHROPIC_API_KEY', res, 'Anthropic')) return;
  const { prompt, type } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  console.log(`[Text/${type || 'default'}] Anthropic → prompt received`);

  let systemPrompt;

  if (type === 'assistant') {
    // Fully conversational — responds naturally to anything including greetings
    systemPrompt = `You are a strategic brand advisor and creative consultant embedded in a professional AI brand platform called ORIVEN.
You are in a real-time conversation with a brand owner or marketer about their brand.
Be conversational, insightful, and warm. Respond naturally to greetings and casual messages.
When brand context is provided in the message, use it to give specific, tailored advice.
Keep responses focused and practical — think like a senior brand strategist having a genuine working conversation.
Never refuse to engage. Never give generic, hollow advice. Always be direct and specific.`;
  } else if (type === 'text' || type === 'video' || type === 'ideas') {
    // Structured output generator — no casual replies
    systemPrompt = `You are a senior brand copywriter and content strategist.
Generate structured, professional content based on the brief provided.
Output must be specific, intentional, and ready to use — no preamble, no meta-commentary, no filler.
Never respond conversationally. Never say "Sure!" or "Great!" or explain what you're about to do.
Just produce the requested content, formatted cleanly and directly.`;
  } else {
    // Fallback for any unrecognised type
    systemPrompt = `You are a senior brand copywriter. Generate professional brand content based on the brief.
Be specific and direct. No preamble or filler.`;
  }

  try {
    const result = await callAnthropic(systemPrompt, prompt);
    console.log(`[Text/${type || 'default'}] Anthropic → response ready`);
    res.json({ result });
  } catch (err) {
    console.error(`[Text/${type || 'default'}] Anthropic error:`, err.message);
    res.status(500).json({ error: 'Failed to generate text. Please try again.' });
  }
});

// ── Image — OpenAI DALL-E only ──────────────────────────────────
// Used by: Image (guided flow)
// Receives: { prompt, size, imageType, imageFormat, refImageData? }
// If refImageData is provided, Anthropic vision extracts style cues
// which are appended to the DALL-E prompt as a style guide.
app.post('/api/generate-image', async (req, res) => {
  const { prompt, size, imageType, imageFormat, refImageData, uploadType } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const resolvedSize = size || '1024x1024';
  console.log(`[Image] type=${imageType || '?'} format=${imageFormat || '?'} uploadType=${uploadType || 'none'} → DALL-E size: ${resolvedSize}`);

  let finalPrompt = prompt;

  // Context-aware vision analysis based on upload type
  if (refImageData) {
    try {
      const match = refImageData.match(/^data:([a-zA-Z0-9+/]+\/[a-zA-Z0-9+/]+);base64,(.+)$/);
      if (match) {
        const mediaType = match[1];
        const b64data   = match[2];

        let visionSystem, visionPrompt, promptLabel;

        if (uploadType === 'product') {
          visionSystem = 'You are a product photographer and art director. Analyze this product image precisely.';
          visionPrompt = 'Describe this product in detail for a DALL-E image generation prompt: exact shape, color, material, finish, proportions, and any distinguishing features. Be specific and literal — this description will be used to faithfully recreate the product in a scene. 60–80 words max.';
          promptLabel  = 'PRODUCT TO FEATURE';
        } else if (uploadType === 'logo') {
          visionSystem = 'You are a brand identity analyst. Analyze this logo for its design language.';
          visionPrompt = 'Analyze this brand logo and extract its visual design language: color palette, geometric forms, negative space usage, visual weight, and the overall aesthetic feeling it conveys. Do NOT describe the logo itself — describe the design principles that could inform a photograph or scene. 50–70 words max.';
          promptLabel  = 'BRAND VISUAL LANGUAGE FROM LOGO';
        } else {
          // reference (default)
          visionSystem = 'You are a visual art director. Analyze reference images for style extraction.';
          visionPrompt = 'Extract the key visual style cues from this reference image for use in a DALL-E generation prompt. Focus on: color palette and temperature, lighting character and direction, composition approach, texture and material feel, depth of field, overall mood and aesthetic. Specific observations only. 60–80 words max.';
          promptLabel  = 'REFERENCE IMAGE STYLE';
        }

        console.log(`[Image] Running ${uploadType || 'reference'} vision analysis…`);
        const visionResult = await anthropic.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 160,
          system: visionSystem,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64data } },
              { type: 'text', text: visionPrompt }
            ]
          }]
        });

        const analysis = visionResult.content[0].text.trim();
        finalPrompt = finalPrompt + '\n\n' + promptLabel + ': ' + analysis;
        console.log(`[Image] Vision analysis appended (${uploadType || 'reference'}).`);
      }
    } catch (err) {
      console.warn('[Image] Vision analysis failed (non-fatal):', err.message);
    }
  }

  // Hard safety clamp before DALL-E — API limit is 4000 chars
  const DALLE_MAX = 3900;
  console.log(`[Image] Prompt length before DALL-E: ${finalPrompt.length}`);
  if (finalPrompt.length > DALLE_MAX) {
    finalPrompt = finalPrompt.slice(0, DALLE_MAX);
    console.warn(`[Image] Prompt clamped to ${DALLE_MAX} chars — check prompt builder for verbosity.`);
  }
  console.log(`[Image] Final prompt length: ${finalPrompt.length}`);

  try {
    const imageUrl = await callDallE(finalPrompt, resolvedSize);
    console.log('[Image] DALL-E → image ready');
    res.json({ imageUrl });
  } catch (err) {
    console.error('[Image] DALL-E error:', err.message);
    res.status(500).json({ error: 'Failed to generate image. ' + err.message });
  }
});

// ── Ads — Anthropic (copy) + Anthropic→DALL-E (visual) ──────────
// Used by: Ads
// Receives: { prompt, size, adFormat }
// Steps 1 and 2 (copy + visual prompt) run in parallel via Promise.all
// to minimise total latency before DALL-E is called.
app.post('/api/generate-ad', async (req, res) => {
  const { prompt, size, adFormat } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const resolvedSize = size || '1024x1024';
  console.log(`[Ads] format=${adFormat || '?'} → DALL-E size: ${resolvedSize}`);
  console.log('[Ads] Step 1+2 — Anthropic (copy + visual prompt) in parallel...');

  const copySystem = `You are a senior creative advertising director.
Generate ONE complete, platform-specific ad concept based on the brief provided.
Every element must reflect the brand identity in the brief — not be generic.
Use the brand tone, colours, audience, and positioning provided. Every word earns its place.
Reply ONLY with valid JSON (no markdown fences, no extra text):
{"title":"...","headline":"...","body":"...","cta":"..."}
- title: ad concept name (max 6 words, brand-specific, not generic)
- headline: punchy, platform-optimised (max 10 words), brand tone and voice specific
- body: benefit-led copy in brand voice (2-3 sentences, no filler, no generic phrases)
- cta: action-driven, brand-appropriate (max 4 words)`;

  let adCopy, dallePrompt;
  try {
    // Run copy generation and visual prompt extraction in parallel
    const [rawCopy, rawVisual] = await Promise.all([
      callAnthropic(copySystem, prompt),
      _briefToDallEPrompt(prompt, `${adFormat || 'feed'} advertisement visual`)
    ]);

    // Parse ad copy JSON
    const cleaned = rawCopy.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      adCopy = JSON.parse(cleaned);
    } catch {
      adCopy = { headline: '', body: rawCopy, cta: 'Learn More' };
    }
    dallePrompt = rawVisual;
    console.log('[Ads] Step 1+2 — copy and visual prompt ready');
  } catch (err) {
    console.error('[Ads] Anthropic error:', err.message);
    return res.status(500).json({ error: 'Failed to generate ad copy' });
  }

  console.log(`[Ads] Step 3 — DALL-E → size: ${resolvedSize}`);
  let imageUrl = null;
  try {
    imageUrl = await callDallE(dallePrompt, resolvedSize);
    console.log('[Ads] Step 3 — DALL-E → image ready');
  } catch (err) {
    console.warn('[Ads] Step 3 — DALL-E failed (non-fatal):', err.message);
  }

  res.json({
    title:    adCopy.title    || '',
    headline: adCopy.headline || '',
    body:     adCopy.body     || '',
    cta:      adCopy.cta      || '',
    imageUrl,
  });
});

// ── Campaign — N adset-style variations, each with image + copy ─
// Used by: Campaign builder
// Receives: { prompt, size }
// Step 1: Anthropic generates N variation objects (title/headline/body/cta/imagePrompt)
// Step 2: All N DALL-E images generated in parallel
// Returns: { variations: [{title,headline,body,cta,imageUrl},...] }
app.post('/api/generate-campaign', async (req, res) => {
  const { prompt, size } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const resolvedSize = size || '1024x1024';

  // ── Step 1: Generate all variation copy + image prompts via Anthropic ──
  console.log('[Campaign] Step 1 — Anthropic → generating campaign variations...');
  let variations;
  try {
    const system = `You are a strategic brand marketing expert and senior creative director.
Generate a complete set of campaign adset-style variation concepts based on the brief.
Each variation must use a genuinely different creative angle — not repetitions of the same idea.
The brand identity in the brief must be unmistakable in every variation.
Reply ONLY with a valid JSON array — no markdown fences, no extra text, nothing else.
[{"title":"...","headline":"...","body":"...","cta":"...","imagePrompt":"..."},...]
Rules:
- title: variation concept name, max 5 words, unique per variation
- headline: platform-optimised, max 10 words, brand-voice specific
- body: benefit-led copy in brand voice, 2-3 sentences, no generic filler
- cta: direct action CTA, max 4 words
- imagePrompt: 100-180 character DALL-E 3 visual description for this variation.
  CRITICAL: must be 100% text-free. Must reference brand colours from the brief if provided.
  Describes subject, composition, mood, and colour palette. No text/letters/logos/UI in image.`;

    const raw     = await callAnthropic(system, prompt);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      variations = JSON.parse(cleaned);
      if (!Array.isArray(variations) || !variations.length) throw new Error('Empty or non-array');
    } catch (parseErr) {
      console.error('[Campaign] JSON parse failed. Raw output:', raw.slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse campaign variations output' });
    }
    console.log(`[Campaign] Step 1 — ${variations.length} variations ready`);
  } catch (err) {
    console.error('[Campaign] Anthropic error:', err.message);
    return res.status(500).json({ error: 'Failed to generate campaign variations' });
  }

  // ── Step 2: Generate all images in parallel ──────────────────────────
  console.log(`[Campaign] Step 2 — generating ${variations.length} images in parallel (size: ${resolvedSize})...`);
  const imageResults = await Promise.allSettled(
    variations.map(async (v, i) => {
      const imgPrompt = (v.imagePrompt || '').trim();
      if (!imgPrompt) return null;
      try {
        const url = await callDallE(imgPrompt, resolvedSize);
        console.log(`[Campaign] Image ${i + 1}/${variations.length} ready`);
        return url;
      } catch (err) {
        console.warn(`[Campaign] Image ${i + 1} failed (non-fatal):`, err.message);
        return null;
      }
    })
  );

  const variationsWithImages = variations.map((v, i) => ({
    title:    v.title    || '',
    headline: v.headline || '',
    body:     v.body     || '',
    cta:      v.cta      || '',
    imageUrl: imageResults[i].status === 'fulfilled' ? imageResults[i].value : null,
  }));

  console.log(`[Campaign] Done — ${variationsWithImages.length} variations with images`);
  res.json({ variations: variationsWithImages });
});

// ── Video — placeholder (not implemented) ───────────────────────
// The frontend handles this locally; no route needed.

// ── BrandCore — AI Generate ─────────────────────────────────────
app.post('/api/generate-brandcore', async (req, res) => {
  const { brandName, type, industry, description, targetAudience, colorMood, brandStyle, personality } = req.body;
  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  console.log('[BrandCore] Anthropic → generating brand identity for:', brandName);
  try {
    const system = `You are ORIVEN BrandCore AI — a world-class combination of brand strategist, creative director, UI/UX design systems architect, conversion designer, and visual identity specialist.

Before generating anything, you MUST deeply reason through the brand:
- Analyze the niche, audience, positioning, emotional tone, and desired perception
- Consider conversion goals, market sophistication, visual expectations, pricing level, trust requirements, and cultural aesthetic
- Reason through the psychology of the brand FIRST — then design

You MUST NEVER:
- Generate generic AI branding
- Reuse repetitive startup aesthetics or predictable design outputs
- Default to minimal black-and-white unless strategically justified
- Use random gradients unless emotionally purposeful
- Output vague, placeholder, or cliché language

Every brand must feel: strategically unique, emotionally intentional, commercially believable, visually consistent, and professionally designed.

COLOR SYSTEM RULES:
- Colors must be purposeful hex codes that reflect industry, audience, emotional tone, and pricing perception
- Primary color must anchor the brand's emotional identity
- Secondary and accent colors must create deliberate contrast and hierarchy
- Avoid generic palettes — every color choice must be explainable

TYPOGRAPHY RULES:
- Heading font must reflect the brand's authority and emotional register
- Body font must support readability and perceived quality
- Choose real, widely available fonts (e.g. Montserrat, Inter, Playfair Display, DM Sans, Lora, Geist, Syne, Cabinet Grotesk, Fraunces, Plus Jakarta Sans)
- Font pairing must feel intentional, not default

LOGO CONCEPT RULES:
- logoConcept.imagePrompt must be specific, visual, contain NO text or letterforms, and be suitable for AI image generation
- Describe the mark itself: shape language, geometry, metaphor, weight, mood
- Style must match the brand's positioning (e.g. not "futuristic wordmark" for an artisan brand)

OUTPUT FORMAT:
Reply ONLY with valid JSON — no markdown fences, no extra text, no explanation, no preamble.
The JSON must match this exact structure:
{
  "brandName": "string",
  "brandStrategy": {
    "positioning": "string (2–3 sentences: what the brand is, who it serves, and what makes it distinct)",
    "targetAudience": "string (specific psychographic + demographic description)",
    "brandPersonality": "string (3–5 personality traits with brief reasoning)",
    "toneOfVoice": "string (how the brand speaks: register, vocabulary, energy level)"
  },
  "brandCore": {
    "brandPromise": "string (one sharp sentence the customer can hold the brand to)",
    "mission": "string (why the brand exists beyond profit)",
    "vision": "string (what success looks like in 5–10 years)",
    "values": ["string", "string", "string"]
  },
  "visualIdentity": {
    "primaryColor": "string (hex)",
    "secondaryColor": "string (hex)",
    "accentColor": "string (hex)",
    "headingFont": "string",
    "bodyFont": "string",
    "styleDirection": "string (vivid description of the overall visual language and feel)",
    "colorMood": "string (the emotional effect of the palette)"
  },
  "logoConcept": {
    "description": "string (strategic rationale — what the logo communicates and why)",
    "style": "string (wordmark / lettermark / icon / combination mark — and why)",
    "imagePrompt": "string (visual-only DALL-E prompt for the logo mark — no text, no letterforms)"
  }
}`;

    const userPrompt = `Generate a complete brand identity for the following brief:

Brand Name: ${brandName}
Brand Type: ${type || 'not specified'}
Industry: ${industry || 'not specified'}
Description: ${description || 'not specified'}
Target Audience: ${targetAudience || 'not specified'}
Color Mood: ${colorMood || 'not specified'}
Brand Style: ${brandStyle || 'not specified'}
Personality Tags: ${personality || 'not specified'}

Return the full JSON brand identity object.`;

    const raw = await callAnthropic(system, userPrompt);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let brandcore;
    try {
      brandcore = JSON.parse(cleaned);
    } catch {
      console.error('[BrandCore] JSON parse failed, raw output:', raw);
      return res.status(500).json({ error: 'Failed to parse brand identity output' });
    }

    console.log('[BrandCore] Anthropic → brand identity ready for:', brandName);
    res.json(brandcore);
  } catch (err) {
    console.error('[BrandCore] Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to generate brand identity' });
  }
});

// ── Brand Check — AI Analysis ───────────────────────────────────
app.post('/api/brand-check', async (req, res) => {
  const {
    brandName, colors, fonts, brandPromise, description, targetAudience,
    styleDirection, colorMood, mission, vision, personality, toneOfVoice,
    values, positioning, logoConcept, imageData,
  } = req.body;
  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  const hasImage = !!(imageData);
  console.log('[BrandCheck] Anthropic → analysing brand:', brandName, hasImage ? '(with image)' : '(manual/BrandCore)');
  try {
    const system = `You are a senior brand strategist and consultant with 20 years of experience evaluating brand identities.
Your task is to critically assess the complete brand setup provided and deliver an honest, expert-level analysis.
Reply ONLY with valid JSON — no markdown fences, no extra text, no explanation.
The JSON must match this exact structure:
{
  "score": number,
  "summary": "string",
  "strengths": ["string", "string"],
  "weaknesses": ["string", "string"],
  "improvements": ["string", "string"],
  "consistencyCheck": "string",
  "professionalLevel": "string"
}

Rules:
- score is 0–100 reflecting overall brand strength and professionalism
- summary is 2–3 sentences: honest, strategic, high-level verdict on the brand as a whole
- strengths: 2–4 specific, concrete positives — reference actual brand elements, avoid vague praise
- weaknesses: 2–4 specific gaps or problems — be direct and honest but constructive
- improvements: 2–4 actionable, prioritised recommendations — be specific about what to change and why
- consistencyCheck: assess alignment between colors, fonts, promise, mission, vision, audience, style, and tone — call out gaps explicitly
- professionalLevel: one of "beginner", "developing", "intermediate", "advanced", "premium"
- Evaluate clarity of positioning, memorability, audience fit, and whether the brand feels cohesive
- If an image is provided, assess it visually — check color usage, typography, layout, and brand alignment
- Never produce vague, generic, or repetitive feedback — this should read like a premium brand audit`;

    // Build a rich brand context block from all available fields
    const lines = [];
    lines.push(`Brand Name: ${brandName}`);
    if (positioning)    lines.push(`Positioning: ${positioning}`);
    if (brandPromise)   lines.push(`Brand Promise: ${brandPromise}`);
    if (mission)        lines.push(`Mission: ${mission}`);
    if (vision)         lines.push(`Vision: ${vision}`);
    if (values)         lines.push(`Brand Values: ${values}`);
    if (personality)    lines.push(`Brand Personality: ${personality}`);
    if (toneOfVoice)    lines.push(`Tone of Voice: ${toneOfVoice}`);
    if (targetAudience) lines.push(`Target Audience: ${targetAudience}`);
    if (description)    lines.push(`Description: ${description}`);
    if (colors) lines.push(`Color Palette: ${Array.isArray(colors) ? colors.join(', ') : colors}`);
    if (fonts)  lines.push(`Typography: ${Array.isArray(fonts) ? fonts.join(', ') : fonts}`);
    if (styleDirection) lines.push(`Style Direction: ${styleDirection}`);
    if (colorMood)      lines.push(`Color Mood: ${colorMood}`);
    if (logoConcept)    lines.push(`Logo Concept: ${logoConcept}`);

    // Build message content — support vision if image provided
    const content = [];

    if (hasImage) {
      const match = imageData.match(/^data:([a-zA-Z0-9+/]+\/[a-zA-Z0-9+/]+);base64,(.+)$/);
      if (match) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] },
        });
        content.push({
          type: 'text',
          text: `Analyse this uploaded brand asset for "${brandName}". Check visual alignment with the brand identity below, then return a full brand check report.\n\nFull brand identity:\n${lines.join('\n')}`,
        });
      } else {
        // Invalid data URL — fall through to text-only
        content.push({ type: 'text', text: `Perform a comprehensive brand audit and return a full brand check report for the following brand identity:\n\n${lines.join('\n')}` });
      }
    } else {
      content.push({ type: 'text', text: `Perform a comprehensive brand audit and return a full brand check report for the following brand identity:\n\n${lines.join('\n')}` });
    }

    // Direct Anthropic call so we can pass structured content (vision support)
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content }],
    });

    const raw = response.content[0].text;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[BrandCheck] JSON parse failed, raw output:', raw);
      return res.status(500).json({ error: 'Failed to parse brand check output' });
    }

    console.log('[BrandCheck] Anthropic → analysis ready for:', brandName, '| Score:', report.score);
    res.json(report);
  } catch (err) {
    console.error('[BrandCheck] Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to run brand check' });
  }
});

// ── Stripe checkout session ─────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  const { plan, userId, userEmail } = req.body;

  console.log(`[Checkout] ▶ Request received — plan: ${plan}, userId: ${userId}, email: ${userEmail || '(none)'}`);

  if (!plan || !userId) {
    console.error('[Checkout] ❌ Missing required fields — plan:', plan, 'userId:', userId);
    return res.status(400).json({ error: 'plan and userId are required' });
  }

  const validPlans = ['starter', 'premium', 'business'];
  if (!validPlans.includes(plan)) {
    console.error(`[Checkout] ❌ Unrecognised plan name: "${plan}" — expected one of: ${validPlans.join(', ')}`);
    return res.status(400).json({ error: `Unrecognised plan: ${plan}` });
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    console.error(`[Checkout] ❌ No price ID configured for plan "${plan}"`);
    console.error('[Checkout]    STRIPE_PRICE_' + plan.toUpperCase(), '= (NOT SET in environment)');
    console.error('[Checkout]    Fix: add this variable in the Render dashboard and redeploy');
    return res.status(400).json({ error: `No price configured for plan: ${plan}. Contact support.` });
  }

  const frontendUrl = FRONTEND_URL;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail || undefined,
      metadata: { userId, plan },
      success_url: `${frontendUrl}?success=true`,
      cancel_url:  `${frontendUrl}?canceled=true`,
    });

    console.log(`[Checkout] ✅ Session created`);
    console.log(`[Checkout]    Session ID:   ${session.id}`);
    console.log(`[Checkout]    userId:       ${userId}`);
    console.log(`[Checkout]    plan:         ${plan}`);
    console.log(`[Checkout]    priceId:      ${priceId}`);
    console.log(`[Checkout]    success_url:  ${frontendUrl}?success=true`);
    res.json({ url: session.url });
  } catch (err) {
    // Log every available field on Stripe errors for easy debugging
    console.error('[Checkout] ❌ Stripe error creating session');
    console.error('           message:', err.message);
    console.error('           type:   ', err.type    || '(none)');
    console.error('           code:   ', err.code    || '(none)');
    console.error('           param:  ', err.param   || '(none)');
    console.error('           raw:    ', err.raw ? JSON.stringify(err.raw) : '(none)');
    console.error('           plan:   ', plan);
    console.error('           priceId:', priceId);
    res.status(500).json({ error: 'Could not create checkout session. Please try again.' });
  }
});

// ── GET /api/get-subscription ───────────────────────────────────
app.get('/api/get-subscription', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('subscription_status, pending_plan, pending_plan_date')
      .eq('id', user.id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.json({ subscription_status: 'free', pending_plan: null, pending_plan_date: null });

    res.json({
      subscription_status: data.subscription_status || 'free',
      pending_plan:        data.pending_plan        || null,
      pending_plan_date:   data.pending_plan_date   || null,
    });
  } catch (err) {
    console.error('[GetSubscription] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ── POST /api/schedule-plan-change ──────────────────────────────
app.post('/api/schedule-plan-change', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { plan } = req.body;
  if (!plan) return res.status(400).json({ error: 'plan is required' });

  const validPlans = ['free', 'starter', 'premium', 'business'];
  if (!validPlans.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('subscription_status, stripe_subscription_id, stripe_customer_id')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) return res.status(500).json({ error: profileError.message });

  const currentPlan = (profile && profile.subscription_status) || 'free';
  const subId = profile && profile.stripe_subscription_id;

  if (plan === currentPlan) return res.json({ ok: true, message: 'Already on this plan' });

  // Upgrading from free to paid — tell client to use checkout
  if (currentPlan === 'free' && plan !== 'free') {
    return res.json({ requiresCheckout: true });
  }

  // Cancelling to free — schedule cancel_at_period_end on Stripe, fallback to immediate DB update
  if (plan === 'free') {
    if (!subId) {
      // No Stripe subscription on record — just update DB immediately
      await supabaseAdmin.from('profiles')
        .update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null })
        .eq('id', user.id);
      return res.json({ ok: true, subscription_status: 'free', pending_plan: null, pending_plan_date: null });
    }
    try {
      const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
      await supabaseAdmin.from('profiles')
        .update({ pending_plan: 'free', pending_plan_date: periodEnd })
        .eq('id', user.id);
      console.log('[SchedulePlan] Cancellation scheduled for:', periodEnd);
      return res.json({ ok: true, pending_plan: 'free', pending_plan_date: periodEnd });
    } catch (err) {
      // Stripe failed (invalid/missing sub) — downgrade in DB immediately
      console.error('[SchedulePlan] Stripe cancel failed, falling back to DB downgrade:', err.message);
      await supabaseAdmin.from('profiles')
        .update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null, stripe_subscription_id: null })
        .eq('id', user.id);
      return res.json({ ok: true, subscription_status: 'free', pending_plan: null, pending_plan_date: null });
    }
  }

  // Switching between paid plans — update Stripe subscription, fallback to DB-only change
  const newPriceId = PRICE_IDS[plan];
  if (!newPriceId) return res.status(400).json({ error: 'Price not configured for plan: ' + plan });

  if (!subId) {
    // No Stripe subscription — apply plan change directly in DB (edge case: manual override)
    await supabaseAdmin.from('profiles')
      .update({ subscription_status: plan, pending_plan: null, pending_plan_date: null })
      .eq('id', user.id);
    console.log('[SchedulePlan] No sub ID — applied plan directly in DB:', plan);
    return res.json({ ok: true, subscription_status: plan });
  }

  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    const itemId = sub.items.data[0].id;
    const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

    await stripe.subscriptions.update(subId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: 'create_prorations',
      metadata: { pending_plan: plan },
    });

    await supabaseAdmin.from('profiles')
      .update({ pending_plan: plan, pending_plan_date: periodEnd })
      .eq('id', user.id);

    console.log('[SchedulePlan] Plan change to', plan, 'scheduled for:', periodEnd);
    return res.json({ ok: true, pending_plan: plan, pending_plan_date: periodEnd });
  } catch (err) {
    // Stripe failed — apply plan change directly in DB so the user isn't stuck
    console.error('[SchedulePlan] Stripe update failed, falling back to DB plan change:', err.message);
    await supabaseAdmin.from('profiles')
      .update({ subscription_status: plan, pending_plan: null, pending_plan_date: null })
      .eq('id', user.id);
    return res.json({ ok: true, subscription_status: plan });
  }
});

// ── POST /api/cancel-plan-change ────────────────────────────────
app.post('/api/cancel-plan-change', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('pending_plan, stripe_subscription_id')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) return res.status(500).json({ error: profileError.message });

  // If the pending change was a cancellation, un-cancel in Stripe
  if (profile && profile.pending_plan === 'free' && profile.stripe_subscription_id) {
    try {
      await stripe.subscriptions.update(profile.stripe_subscription_id, { cancel_at_period_end: false });
      console.log('[CancelPlanChange] Un-canceled Stripe subscription:', profile.stripe_subscription_id);
    } catch (err) {
      console.error('[CancelPlanChange] Stripe un-cancel error:', err.message);
    }
  }

  await supabaseAdmin.from('profiles')
    .update({ pending_plan: null, pending_plan_date: null })
    .eq('id', user.id);

  res.json({ ok: true });
});

// ── GET /api/get-usage ───────────────────────────────────────────
app.get('/api/get-usage', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabaseAdmin.from('profiles')
      .select('usage_data').eq('id', user.id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const usage = (data && data.usage_data) || {};
    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentDay   = new Date().toISOString().slice(0, 10);
    res.json({
      monthly_count: usage.monthly_key === currentMonth ? (usage.monthly_count || 0) : 0,
      monthly_key:   currentMonth,
      daily_count:   usage.daily_key   === currentDay   ? (usage.daily_count   || 0) : 0,
      daily_key:     currentDay,
    });
  } catch (err) {
    console.error('[GetUsage] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// ── POST /api/increment-usage ────────────────────────────────────
app.post('/api/increment-usage', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const currentMonth = new Date().toISOString().slice(0, 7);
  const currentDay   = new Date().toISOString().slice(0, 10);
  try {
    const { data } = await supabaseAdmin.from('profiles')
      .select('usage_data').eq('id', user.id).maybeSingle();
    const prev         = (data && data.usage_data) || {};
    const monthlyCount = prev.monthly_key === currentMonth ? (prev.monthly_count || 0) + 1 : 1;
    const dailyCount   = prev.daily_key   === currentDay   ? (prev.daily_count   || 0) + 1 : 1;
    await supabaseAdmin.from('profiles').update({
      usage_data: { monthly_count: monthlyCount, monthly_key: currentMonth, daily_count: dailyCount, daily_key: currentDay }
    }).eq('id', user.id);
    res.json({ monthly_count: monthlyCount, daily_count: dailyCount });
  } catch (err) {
    console.error('[IncrementUsage] Error:', err.message);
    res.status(500).json({ error: 'Failed to increment usage' });
  }
});

// ── POST /api/signup ─────────────────────────────────────────────
// Creates a user immediately (email_confirm:true bypasses Supabase gate),
// stores email_verified:false in profiles, sends verification email.
// Body: { firstName, lastName, email, password, phone }
app.post('/api/signup', async (req, res) => {
  const { firstName, lastName, email, password, phone } = req.body || {};
  if (!firstName || !email || !password) {
    return res.status(400).json({ error: 'First name, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // Create user — email_confirm:true means Supabase won't block signInWithPassword
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName || '', phone: phone || null }
  });

  if (authError) {
    console.error('[Signup] Auth user creation failed:', authError.message);
    const msg = authError.message || '';
    if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists')) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
    return res.status(500).json({ error: msg || 'Could not create account' });
  }

  const user = authData.user;
  const verificationToken = crypto.randomBytes(32).toString('hex');

  // Create profile row (email_verified: false — user must confirm within 14 days)
  const { error: profileError } = await supabaseAdmin.from('profiles').insert({
    id:                   user.id,
    first_name:           firstName,
    last_name:            lastName || null,
    email,
    phone:                phone || null,
    email_verified:        false,
    onboarding_completed:  false,
    verification_token:    verificationToken,
    verification_sent_at:  new Date().toISOString()
  });
  if (profileError) console.warn('[Signup] Profile insert warning:', profileError.message);

  // Send verification email (best-effort — signup succeeds even if email fails)
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpUser && smtpPass) {
    const verifyUrl = `${FRONTEND_URL}?verify_token=${verificationToken}`;
    try {
      await _smtpTransporter().sendMail({
        from:    process.env.SMTP_FROM || `ORIVEN <${smtpUser}>`,
        to:      email,
        subject: 'Verify your ORIVEN email address',
        html:    _verificationEmailHtml(firstName, verifyUrl),
        text:    `Hi ${firstName},\n\nVerify your email:\n${verifyUrl}\n\nThis link is valid for 14 days.\n\n— ORIVEN`
      });
      console.log('[Signup] Verification email sent to', email);
    } catch (emailErr) {
      console.error('[Signup] Verification email failed (non-fatal):', emailErr.message);
    }
  } else {
    console.warn('[Signup] SMTP not configured — skipping verification email');
  }

  console.log('[Signup] ✅ User created:', user.id, email);
  res.json({ ok: true, userId: user.id });
});

// ── POST /api/verify-email ───────────────────────────────────────
// No auth required — the token itself is the credential.
// Body: { token }
app.post('/api/verify-email', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token required' });

  const { data, error } = await supabaseAdmin.from('profiles')
    .select('id')
    .eq('verification_token', token)
    .maybeSingle();

  if (error)  return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Verification link is invalid or has already been used' });

  await supabaseAdmin.from('profiles').update({
    email_verified:     true,
    verification_token: null
  }).eq('id', data.id);

  console.log('[VerifyEmail] ✅ Email verified for user:', data.id);
  res.json({ ok: true });
});

// ── POST /api/resend-verification ───────────────────────────────
// Requires auth. Generates a fresh token and resends the email.
app.post('/api/resend-verification', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return res.status(503).json({ error: 'Email service not configured — set SMTP_USER and SMTP_PASS' });
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verifyUrl = `${FRONTEND_URL}?verify_token=${verificationToken}`;

  const { data: profile } = await supabaseAdmin.from('profiles')
    .select('first_name, email').eq('id', user.id).maybeSingle();
  const firstName = (profile && profile.first_name) || 'there';
  const toEmail   = (profile && profile.email)       || user.email;

  await supabaseAdmin.from('profiles').update({
    verification_token:   verificationToken,
    verification_sent_at: new Date().toISOString()
  }).eq('id', user.id);

  try {
    await _smtpTransporter().sendMail({
      from:    process.env.SMTP_FROM || `ORIVEN <${smtpUser}>`,
      to:      toEmail,
      subject: 'Verify your ORIVEN email address',
      html:    _verificationEmailHtml(firstName, verifyUrl),
      text:    `Hi ${firstName},\n\nVerify your email:\n${verifyUrl}\n\nThis link is valid for 14 days.\n\n— ORIVEN`
    });
    console.log('[ResendVerify] ✅ Sent to', toEmail);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ResendVerify] Failed:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ── POST /api/send-invite ────────────────────────────────────────
// Sends a team invite email via Outlook SMTP.
// Body: { name, email, role, message, workspaceName }
app.post('/api/send-invite', async (req, res) => {
  const { name, email, role, message, workspaceName } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    console.error('[Invite] ❌ SMTP credentials not configured — set SMTP_USER and SMTP_PASS in .env');
    return res.status(503).json({ error: 'Email service not configured' });
  }

  const transporter = _smtpTransporter();

  const recipientName    = name  || email.split('@')[0];
  const senderWorkspace  = workspaceName || 'ORIVEN Workspace';
  const roleLabel        = role  || 'Member';
  const personalNote     = message ? `<p style="margin:0 0 14px;color:#374151;font-size:14px;line-height:1.6;font-style:italic;">"${message}"</p>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>You're invited to ${senderWorkspace}</title></head>
<body style="margin:0;padding:0;background:#F6F3EE;font-family:'Geist',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.07);">

    <!-- Header -->
    <div style="background:#0A0A0A;padding:28px 32px;">
      <div style="font-size:20px;font-weight:700;color:#B7FF2A;letter-spacing:-.01em;">ORIVEN</div>
      <div style="font-size:12px;color:rgba(255,255,255,.5);margin-top:3px;letter-spacing:.04em;">AI BRAND STUDIO</div>
    </div>

    <!-- Body -->
    <div style="padding:32px 32px 28px;">
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#18181A;line-height:1.25;">
        You've been invited to join<br><span style="color:#18181A;">${senderWorkspace}</span>
      </h1>
      <p style="margin:0 0 22px;color:#555;font-size:14px;line-height:1.6;">
        Hi ${recipientName}, you've been invited to collaborate as a <strong>${roleLabel}</strong> in the
        ${senderWorkspace} workspace on ORIVEN.
      </p>

      ${personalNote}

      <!-- Role chip -->
      <div style="display:inline-block;background:rgba(183,255,42,0.1);border:1px solid rgba(183,255,42,0.3);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:600;color:#3A7A06;margin-bottom:24px;">
        Role: ${roleLabel}
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin:8px 0 28px;">
        <a href="https://oriven.app" style="display:inline-block;background:#B7FF2A;color:#000;font-size:14px;font-weight:600;text-decoration:none;padding:13px 32px;border-radius:8px;letter-spacing:.01em;">
          Accept Invitation &rarr;
        </a>
      </div>

      <p style="margin:0;font-size:12px;color:#999;line-height:1.6;border-top:1px solid #F0EDE8;padding-top:18px;">
        If you weren't expecting this invite, you can ignore this email.<br>
        Questions? Reply to <a href="mailto:studio.oriven@outlook.com" style="color:#555;">studio.oriven@outlook.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || `ORIVEN <${smtpUser}>`,
      to:      email,
      subject: `You've been invited to ${senderWorkspace} on ORIVEN`,
      html:    html,
      text:    `Hi ${recipientName},\n\nYou've been invited to join "${senderWorkspace}" on ORIVEN as a ${roleLabel}.\n\nVisit https://oriven.app to accept.\n\n— The ORIVEN Team`
    });

    console.log(`[Invite] ✅ Invite sent to ${email} (role: ${roleLabel}, workspace: ${senderWorkspace})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Invite] ❌ Failed to send invite email:', err.message);
    res.status(500).json({ error: 'Failed to send invite email: ' + err.message });
  }
});

// ── AI Logo Generation ──────────────────────────────────────────
// Receives: { brandName, description, logoStyle, styleDirection, colorPalette }
// Returns: { imageUrl, prompt }
app.post('/api/generate-logo', async (req, res) => {
  const { brandName, description, logoStyle, styleDirection, colorPalette } = req.body;
  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  console.log(`[LogoGen] Generating AI logo for: ${brandName}`);

  // Use Anthropic to craft an optimised DALL-E logo prompt
  const system = `You are a logo design expert and art director.
Your job is to write a precise DALL-E 3 prompt that will generate a professional brand logo concept.

Rules:
- Output is 120–250 characters — a single, vivid visual description
- Describe a logo SYMBOL or MARK — geometric shapes, abstract forms, icons, emblems — never letters or text
- Describe the specific visual form: shape, geometry, composition, colour treatment
- Reference the style direction and logo type requested
- End with: ", isolated on white background, vector-style clean design, professional brand identity mark"
- CRITICAL: Do NOT include ANY readable text, letters, words, numbers, or typographic elements of any kind
- Do NOT include the brand name, initials, taglines, or ANY characters that form words
- DALL-E cannot reliably render text — the output must be a pure visual symbol with zero written elements
- Do NOT say "Generate" or "Create" — just describe what is seen in the image
- Output ONLY the prompt. No labels. No quotes. No explanation.`;

  try {
    const userMsg = `Brand: ${brandName}
Logo type: ${logoStyle || 'minimal icon / symbol'}
Style direction: ${styleDirection || 'minimal premium'}
Colour palette: ${colorPalette || 'professional neutral palette'}
Brand description: ${description || 'a professional brand'}`;

    const rawPrompt = await callAnthropic(system, userMsg);
    const dallePrompt = rawPrompt.trim().replace(/^["']|["']$/g, '').slice(0, 450);

    console.log(`[LogoGen] DALL-E prompt: ${dallePrompt}`);
    const imageUrl = await callDallE(dallePrompt, '1024x1024');
    console.log(`[LogoGen] ✅ Logo generated for: ${brandName}`);
    res.json({ imageUrl, prompt: dallePrompt });
  } catch (err) {
    console.error('[LogoGen] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate logo: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// HEYGEN — AI UGC VIDEO GENERATION
// ════════════════════════════════════════════════════════════════

const HEYGEN_BASE = 'https://api.heygen.com';

// Safely extract an array from either v1 or v2 HeyGen response shapes:
//   v1: { code: 100, data: { avatars: [...] } }
//   v2: { error: null, data: { avatars: [...] } }
function _heygenExtract(parsed, key) {
  if (!parsed) return [];
  if (parsed.data && Array.isArray(parsed.data[key])) return parsed.data[key];
  if (Array.isArray(parsed[key])) return parsed[key];
  return [];
}

// Known-good public HeyGen stock avatars — used as last-resort fallback
// when the API key is missing or the account has no avatars yet.
const HEYGEN_FALLBACK_AVATARS = [
  { avatar_id: 'Abigail_expressive_2024112501', avatar_name: 'Abigail (Upper Body)', gender: 'female' },
  { avatar_id: 'Abigail_standing_office_front', avatar_name: 'Abigail Office Front', gender: 'female' },
  { avatar_id: 'Aditya_public_1',               avatar_name: 'Aditya (Blue blazer)',  gender: 'male'   },
  { avatar_id: 'Aditya_public_4',               avatar_name: 'Aditya (Brown blazer)', gender: 'male'   },
];

const HEYGEN_FALLBACK_VOICES = [
  { voice_id: 'f38a635bee7a4d1f9b0a654a31d050d2', name: 'Chill Brian',  language: 'English', gender: 'male'   },
  { voice_id: 'cef3bc4e0a84424cafcde6f2cf466c97', name: 'Ivy',          language: 'English', gender: 'female' },
  { voice_id: 'f8c69e517f424cafaecde32dde57096b', name: 'Allison',       language: 'English', gender: 'female' },
  { voice_id: 'd2f4f24783d04e22ab49ee8fdc3715e0', name: 'Chill Brian 2', language: 'English', gender: 'male'   },
];

// ── GET /api/ugc-avatars ─────────────────────────────────────────
// Fetches both v2 (user-created studio) + v1 (full stock library),
// merges and deduplicates, quality-sorts, returns all.
// Falls back to HEYGEN_FALLBACK_AVATARS when no API key is configured.
app.get('/api/ugc-avatars', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    console.error('[UGC/Avatars] HEYGEN_API_KEY not set — returning static fallback');
    return res.json({ avatars: HEYGEN_FALLBACK_AVATARS, fallback: true });
  }

  try {
    // Fetch v2 (user-created) and v1 (stock library) in parallel
    const [v2Res, v1Res] = await Promise.all([
      fetch(`${HEYGEN_BASE}/v2/avatars`,    { headers: { 'X-Api-Key': apiKey } }),
      fetch(`${HEYGEN_BASE}/v1/avatar.list`, { headers: { 'X-Api-Key': apiKey } }),
    ]);

    const [v2Body, v1Body] = await Promise.all([v2Res.text(), v1Res.text()]);
    console.log('[UGC/Avatars] v2 HTTP', v2Res.status, '| v1 HTTP', v1Res.status);
    console.log('[UGC/Avatars] v2 sample:', v2Body.slice(0, 400));
    console.log('[UGC/Avatars] v1 sample:', v1Body.slice(0, 400));

    let v2Data, v1Data;
    try { v2Data = JSON.parse(v2Body); } catch (_) { v2Data = null; }
    try { v1Data = JSON.parse(v1Body); } catch (_) { v1Data = null; }

    // v2 returns user-created avatars; v1 returns the full stock library
    const v2Avatars = _heygenExtract(v2Data, 'avatars');
    let   v1Avatars = _heygenExtract(v1Data, 'avatars');

    // If v1 returned 0 avatars, try talking_photo (for photo-based accounts)
    if (!v1Avatars.length) {
      const photos = _heygenExtract(v1Data, 'talking_photo');
      if (photos.length) {
        v1Avatars = photos.map(p => ({
          avatar_id:         p.talking_photo_id || p.id,
          avatar_name:       p.talking_photo_name || p.name || 'Photo Creator',
          gender:            '',
          preview_image_url: p.preview_image_url || '',
          preview_video_url: p.preview_video_url || '',
        }));
      }
    }

    console.log('[UGC/Avatars] v2 count:', v2Avatars.length, '| v1 count:', v1Avatars.length);

    // Merge: v2 (user's own) first, then v1 stock — deduplicate by avatar_id
    const seen = new Set();
    const merged = [...v2Avatars, ...v1Avatars].filter(a => {
      if (!a.avatar_id || seen.has(a.avatar_id)) return false;
      seen.add(a.avatar_id);
      return true;
    });

    if (!merged.length) {
      console.warn('[UGC/Avatars] No avatars found in either endpoint — using static fallback');
      return res.json({ avatars: HEYGEN_FALLBACK_AVATARS, fallback: true });
    }

    // Quality sort: avatars with both preview_video_url + preview_image_url first,
    // then image-only, then plain. This surfaces cinematic/premium avatars to the top.
    const score = a => (a.preview_video_url ? 2 : 0) + (a.preview_image_url ? 1 : 0);
    merged.sort((a, b) => score(b) - score(a));

    console.log('[UGC/Avatars] Returning', merged.length, 'avatars (quality-sorted)');
    return res.json({ avatars: merged });

  } catch (err) {
    console.error('[UGC/Avatars] Fetch error:', err.message);
    return res.json({ avatars: HEYGEN_FALLBACK_AVATARS, fallback: true });
  }
});

// ── GET /api/ugc-voices ──────────────────────────────────────────
app.get('/api/ugc-voices', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    console.error('[UGC/Voices] HEYGEN_API_KEY is not set — returning static fallback voices');
    return res.json({ voices: HEYGEN_FALLBACK_VOICES, fallback: true });
  }

  try {
    console.log('[UGC/Voices] Fetching v2/voices…');
    const v2Res  = await fetch(`${HEYGEN_BASE}/v2/voices`, { headers: { 'X-Api-Key': apiKey } });
    const v2Body = await v2Res.text();
    console.log('[UGC/Voices] v2 HTTP', v2Res.status);
    console.log('[UGC/Voices] v2 body:', v2Body.slice(0, 600));

    let v2Data;
    try { v2Data = JSON.parse(v2Body); } catch (_) { v2Data = null; }

    let voices = _heygenExtract(v2Data, 'voices');
    console.log('[UGC/Voices] Total voices from API:', voices.length);

    if (!voices.length) {
      console.warn('[UGC/Voices] API returned 0 voices — using static fallback');
      return res.json({ voices: HEYGEN_FALLBACK_VOICES, fallback: true });
    }

    // Normalise names (some have leading newlines / trailing spaces)
    voices = voices.map(v => ({ ...v, name: (v.name || '').trim() || v.voice_id }));

    // Prefer English voices; fall back to all if none match
    const en = voices.filter(v => {
      const lang = (v.language || '').toLowerCase();
      return lang.includes('english') || lang.startsWith('en');
    });
    const result = (en.length ? en : voices).slice(0, 60);

    console.log('[UGC/Voices] Returning', result.length, 'voices (English preferred)');
    return res.json({ voices: result });

  } catch (err) {
    console.error('[UGC/Voices] Fetch error:', err.message);
    console.warn('[UGC/Voices] Using static fallback due to error');
    return res.json({ voices: HEYGEN_FALLBACK_VOICES, fallback: true });
  }
});

console.log("UGC ROUTE REGISTERED");

// ── POST /api/generate-ugc ──────────────────────────────────────
// Combined: Anthropic writes the script, HeyGen generates the video.
// Frontend calls one endpoint, gets back a videoId to poll.
app.post('/api/generate-ugc', async (req, res) => {
  const user = await getUserFromToken(req);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log("UGC ROUTE HIT");
  console.log("UGC BODY", JSON.stringify(req.body));

  const { adFeeling, adGoal, adContext, avatarId, voiceId, avatarStyle,
          brandName, brandDesc, brandTone, brandAudience, brandPromise, brandDiff, brandWords,
          background, customScript, format } = req.body || {};

  const formatDimensions = {
    vertical:  { width: 720,  height: 1280 },
    square:    { width: 1080, height: 1080 },
    landscape: { width: 1280, height: 720  },
  };
  const dimension = formatDimensions[format] || formatDimensions.vertical;
  if (!avatarId) return res.status(400).json({ error: 'Avatar ID is required' });
  if (!voiceId)  return res.status(400).json({ error: 'Voice ID is required' });

  const heygenKey = process.env.HEYGEN_API_KEY;
  if (!heygenKey) return res.status(500).json({ error: 'HeyGen API key not configured' });

  console.log('[UGC] Received → adFeeling:', adFeeling, '| adGoal:', adGoal, '| avatarId:', avatarId, '| format:', format, '| scriptMode:', customScript ? 'custom' : 'ai');

  // ── Cinematic brief registry — each style is a full creative direction ──
  const CREATOR_BRIEFS = {
    startup_founder: {
      context:   'A bold startup founder speaking directly from their workspace — authentic, disruptive, has been in the trenches and knows the audience\'s exact pain point.',
      hookStyle: 'Lead with the problem the audience already knows. One line. Then flip it hard.',
      language:  'Founder energy: "we built this", "shipped it last week", "changed the way I work completely"',
      ctaStyle:  'Direct and urgent: "try it now", "link in bio", "ship faster starting today"',
    },
    podcast_creator: {
      context:   'A trusted podcast host mid-recommendation — relaxed, genuinely enthusiastic, talking like they\'re in the middle of a real conversation with a close friend.',
      hookStyle: 'Start mid-story or mid-thought. Like you jumped into a conversation already in progress.',
      language:  'Warm and authentic: "honestly", "I\'ve been using this for months now", "you need to hear about this"',
      ctaStyle:  'Soft confidence: "worth checking out", "grab the link below", "you\'ll thank me later"',
    },
    fitness_creator: {
      context:   'A results-obsessed fitness creator in their element — pumped, direct, every single word carries physical energy and drive.',
      hookStyle: 'Open with a transformation or a challenge. Make them feel the intensity in the first sentence.',
      language:  'Active and relentless: "gains", "no excuses", "I don\'t stop until", "results speak for themselves"',
      ctaStyle:  'No hesitation: "get it now", "stop waiting", "your move"',
    },
    luxury_influencer: {
      context:   'A luxury lifestyle creator speaking from a premium environment — measured, deliberate, every word is intentional and earns its place.',
      hookStyle: 'Paint the aspirational scene first. Let the audience want the life before they hear anything about the product.',
      language:  'Elevated and sparse: "exceptional", "the kind of quality that stays with you", "not for everyone — and that\'s the point"',
      ctaStyle:  'Restrained and exclusive: "discover it", "if you know, you know", "for those who notice the difference"',
    },
    tech_reviewer: {
      context:   'An authoritative tech reviewer who has tested everything, cuts through the noise, and only recommends what genuinely works.',
      hookStyle: 'Lead with your boldest claim immediately, then back it up with specifics. Credibility through detail.',
      language:  'Informed and precise: "tested this for 30 days straight", "here\'s what actually surprised me", "the feature that changes everything"',
      ctaStyle:  'Confident endorsement: "worth every penny", "link in the description", "upgraded and never looked back"',
    },
    street_creator: {
      context:   'A spontaneous street creator filming on-the-go — raw, unfiltered energy, just discovered something and physically cannot wait to share it.',
      hookStyle: 'React first. "Okay wait—" or "I need to stop and talk about this right now" — pull them into the urgency.',
      language:  'Raw and viral: "no cap", "lowkey obsessed", "fr fr", "I can\'t believe this actually works"',
      ctaStyle:  'Impulsive and urgent: "grab it fr", "link in bio right now", "you\'re welcome in advance"',
    },
    vacation_creator: {
      context:   'A travel creator on location — relaxed, fully in their element, makes the audience want the experience before they even know what the product is.',
      hookStyle: 'Pull them into the scene. Set where you are and how it feels before revealing anything.',
      language:  'Lifestyle and discovery: "couldn\'t leave without it", "this changed how I travel", "the vibe here is completely different"',
      ctaStyle:  'Aspirational close: "take me back", "get yours before they\'re gone", "you genuinely deserve this"',
    },
    office_creator: {
      context:   'A sharp professional in a clean modern workspace — focused, outcome-driven, respects the audience\'s time and treats them as intelligent adults.',
      hookStyle: 'Name the professional pain point in the first sentence. Time is the asset — get to the solution fast.',
      language:  'Direct and measurable: "saves me two hours every day", "our entire team switched", "the ROI showed up immediately"',
      ctaStyle:  'Measured and clear: "try it free", "book the demo", "your workflow will thank you"',
    },
  };

  // Ad feeling → voice speed (real HeyGen parameter)
  const feelingSpeed = {
    viral:       1.08,
    cinematic:   0.9,
    emotional:   0.93,
    aggressive:  1.12,
    luxury:      0.85,
    startup:     1.05,
    friendly:    1.0,
    high_energy: 1.15,
  }[adFeeling] || 1.0;

  // Background: solid color only for styles that use it.
  // All others leave background unset — HeyGen uses the avatar's natural scene.
  const bgHeyGenMap = {
    white_studio: { type: 'color', value: '#FFFFFF' },
    minimal_dark: { type: 'color', value: '#0D0D0D' },
  };

  // ── Step 1: Script — use provided or generate with AI ────────
  let script;
  if (customScript && customScript.trim()) {
    script = customScript.trim();
    console.log('[UGC] Using custom script (', script.length, 'chars )');
  } else {
    if (!_requireEnv('ANTHROPIC_API_KEY', res, 'Anthropic')) return;
    try {
      // Ad feeling → directorial instruction (energy, pacing, sentence structure)
      const feelingInstruction = {
        viral:       'Make this spread. Rapid-fire energy, punchy hooks designed to be shared. Short sentences. Bold, declarative statements.',
        cinematic:   'Write like a film director narrating a moment — evocative, visual language. Every sentence paints a picture. Slow and deliberate. Emotionally charged.',
        emotional:   'Lead with heart. Personal story, raw honesty, vulnerability that earns real connection. Make them feel something before you ask them to do anything.',
        aggressive:  'No warmup. Direct, hard-hitting, zero fluff. Bold claims, urgency in every line. This is a closer — make them feel like they\'re missing out right now.',
        luxury:      'Nothing is rushed. Sparse, aspirational language where every word earns its place. The silence between sentences matters. Elevated throughout.',
        startup:     'Scrappy and exciting. Disruptive framing, founder-level conviction, the energy of someone who genuinely believes they\'re changing something.',
        friendly:    'Warm, genuine, completely likeable. Feels exactly like a trusted friend giving an honest recommendation with zero agenda.',
        high_energy: 'Maximum energy from the first word. Fast pace, exclamation, nonstop forward momentum. There is no gear below fifth.',
      }[adFeeling] || 'Write in a genuine, natural first-person voice with authentic energy.';

      // Ad goal → hook angle + CTA direction
      const goalInstruction = {
        sales:     'GOAL: Drive immediate purchase. Build desire fast, remove hesitation, close with urgency. CTA should push "buy now", "get it", "grab yours".',
        awareness: 'GOAL: Build brand recall and desire. Plant the seed — intrigue over hard sell. CTA should invite discovery: "check it out", "learn more", "look it up".',
        downloads: 'GOAL: Drive app installs. Highlight how fast and easy it is to get started. CTA should push "download it", "get the app", "it\'s free to start".',
        clicks:    'GOAL: Pull to a link or page. Create enough curiosity that clicking feels inevitable. CTA should be "link in bio", "tap the link", "click below".',
        launch:    'GOAL: Announce a new launch. Create FOMO and excitement for something that just dropped. CTA should signal scarcity or newness: "just launched", "early access", "be first".',
      }[adGoal] || '';

      // Build brand context block for the system prompt
      const brandLines = [
        brandName     ? `Brand name: ${brandName}` : '',
        brandDesc     ? `What it is: ${brandDesc}` : '',
        brandTone     ? `Tone of voice: ${brandTone}` : '',
        brandAudience ? `Target audience: ${brandAudience}` : '',
        brandPromise  ? `Brand promise: ${brandPromise}` : '',
        brandDiff     ? `What makes it unique: ${brandDiff}` : '',
        brandWords    ? `Key vocabulary to use naturally: ${brandWords}` : '',
      ].filter(Boolean);

      const system = `You are an expert UGC ad scriptwriter and creative director for TikTok, Instagram Reels, and YouTube Shorts.
${brandLines.length ? '\nBRAND CONTEXT — write as if you live inside this brand:\n' + brandLines.map(l => '- ' + l).join('\n') : ''}
AD FEELING — apply this to every sentence (HIGHEST PRIORITY): ${feelingInstruction}
${goalInstruction ? '\nAD GOAL — shape your hook angle and CTA around this: ' + goalInstruction : ''}
Script rules:
- Open with a strong attention-grabbing hook that stops the scroll in the first 3 seconds
- Speak in a genuine first-person voice as an authentic creator living in this brand's world
- Weave in the brand's vocabulary and tone naturally — not as a checklist, as character
- End with a clear, natural call-to-action aligned with the goal above
- First person only — no "you should" constructions at the start
- No stage directions, brackets, parenthetical actions, or scene descriptions
- Output ONLY the spoken script — nothing else, no titles, no labels
- Target 8–12 sentences for a 30–45 second read`;

      const userMsg = [
        'Write a UGC ad script.',
        adContext ? `Additional context: ${adContext}` : '',
        `Ad feeling: ${adFeeling || 'viral'}`,
        adGoal    ? `Ad goal: ${adGoal}` : '',
        '',
        'Output ONLY the spoken script.',
      ].filter(Boolean).join('\n');

      script = (await callAnthropic(system, userMsg)).trim();
      if (!script) return res.status(500).json({ error: 'Anthropic returned an empty script' });
      console.log('[UGC] Script generated (', script.length, 'chars ) | feeling:', adFeeling, '| goal:', adGoal || 'none');
    } catch (err) {
      console.error('[UGC] Script generation error:', err.message);
      return res.status(500).json({ error: 'Failed to write script: ' + err.message });
    }
  }

  // ── Step 2: Submit to HeyGen ──────────────────────────────────
  try {
    const videoInput = {
      character: { type: 'avatar', avatar_id: avatarId, avatar_style: avatarStyle || 'normal' },
      voice:     { type: 'text',   input_text: script,  voice_id: voiceId, speed: feelingSpeed },
    };
    // Only inject background when we have an explicit solid-color mapping.
    // Unset → HeyGen uses the avatar's natural built-in scene.
    const heygenBg = bgHeyGenMap[background];
    if (heygenBg) videoInput.background = heygenBg;

    const heygenPayload = {
      video_inputs: [videoInput],
      dimension,
      test: false,
    };
    console.log('[UGC] HeyGen payload:', JSON.stringify(heygenPayload));

    const heygenRes = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': heygenKey },
      body: JSON.stringify(heygenPayload),
    });

    const heygenData = await heygenRes.json();

    if (!heygenRes.ok || heygenData.error) {
      const errMsg = (heygenData.error && (heygenData.error.message || JSON.stringify(heygenData.error))) || heygenData.message || 'HeyGen error';
      console.error('[UGC] HeyGen submission failed:', errMsg);
      return res.status(400).json({ error: errMsg });
    }

    const videoId = heygenData.data && heygenData.data.video_id;
    if (!videoId) return res.status(500).json({ error: 'HeyGen did not return a video ID' });

    console.log('[UGC] Video submitted to HeyGen:', videoId, '| user:', user.id);
    return res.json({ ok: true, videoId, status: 'processing' });
  } catch (err) {
    console.error('[UGC] HeyGen submission error:', err.message);
    return res.status(500).json({ error: 'Failed to submit to HeyGen: ' + err.message });
  }
});

// ── POST /api/generate-ugc-script ───────────────────────────────
// Standalone script-only endpoint (used by test page / direct integrations).
// Aligned with the simplified UGC flow — no product/niche/audience required.
app.post('/api/generate-ugc-script', async (req, res) => {
  if (!_requireEnv('ANTHROPIC_API_KEY', res, 'Anthropic')) return;
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { creatorStyle, adFeeling, brandName, brandDesc } = req.body || {};

  const CREATOR_BRIEFS = {
    startup_founder:   { context: 'A bold startup founder speaking directly from their workspace — authentic, disruptive, knows the audience\'s pain point firsthand.', hookStyle: 'Lead with the problem the audience already knows. One line. Then flip it.', language: 'Founder energy: "we built this", "shipped it", "changed the way I work"', ctaStyle: 'Direct and urgent: "try it now", "link in bio", "ship faster today"' },
    podcast_creator:   { context: 'A trusted podcast host mid-recommendation — relaxed, genuine, talking like they\'re in conversation with a close friend.', hookStyle: 'Start mid-story or mid-thought. Like jumping into a conversation already in progress.', language: 'Warm: "honestly", "I\'ve been using this for months", "you need to hear this"', ctaStyle: 'Soft confidence: "worth checking out", "grab the link", "you\'ll thank me"' },
    fitness_creator:   { context: 'A results-obsessed fitness creator in their element — pumped, direct, every word carries physical energy.', hookStyle: 'Open with a transformation claim or challenge. Make them feel the intensity.', language: 'Active: "gains", "no excuses", "results don\'t lie"', ctaStyle: 'No hesitation: "get it now", "stop waiting", "your move"' },
    luxury_influencer: { context: 'A luxury lifestyle creator in a premium environment — measured, deliberate, every word is intentional.', hookStyle: 'Paint the aspirational scene first. Let the audience want the life before the product.', language: 'Elevated: "exceptional", "the kind of quality that stays with you", "not for everyone"', ctaStyle: 'Restrained: "discover it", "if you know, you know", "for those who notice"' },
    tech_reviewer:     { context: 'An authoritative tech reviewer who only recommends what genuinely works. Credibility through specificity.', hookStyle: 'Lead with the boldest claim immediately, then back it up with detail.', language: 'Precise: "tested for 30 days", "here\'s what surprised me", "the feature that matters"', ctaStyle: 'Confident: "worth every penny", "link in description", "never looked back"' },
    street_creator:    { context: 'A spontaneous street creator filming on-the-go — raw, just discovered something and can\'t wait to share it.', hookStyle: 'React first. "Okay wait—" or "I need to talk about this right now".', language: 'Raw: "no cap", "lowkey obsessed", "fr fr", "can\'t believe this works"', ctaStyle: 'Urgent: "grab it fr", "link in bio now", "you\'re welcome"' },
    vacation_creator:  { context: 'A travel creator on location — relaxed, makes the audience want the experience before they know the product.', hookStyle: 'Set the scene first. Pull them into where you are and how it feels.', language: 'Lifestyle: "couldn\'t leave without it", "changed how I travel", "the vibe is different"', ctaStyle: 'Aspirational: "get yours", "you deserve this", "take me back"' },
    office_creator:    { context: 'A sharp professional in a clean workspace — focused, outcome-driven, respects the audience\'s time.', hookStyle: 'Name the pain point in the first sentence. Get to the solution fast.', language: 'Measurable: "saves me two hours daily", "whole team switched", "ROI showed up immediately"', ctaStyle: 'Clear: "try it free", "book the demo", "your workflow will thank you"' },
  };

  const feelingInstruction = {
    viral:       'Make this spread. Rapid-fire energy, punchy hooks designed to be shared. Short sentences, bold statements.',
    cinematic:   'Write like a film director — evocative, visual language. Every sentence paints a picture. Slow, deliberate, emotionally charged.',
    emotional:   'Lead with heart. Raw honesty and vulnerability that earns real connection.',
    aggressive:  'No warmup. Direct, hard-hitting, urgency in every line. Make them feel like they\'re missing out right now.',
    luxury:      'Nothing is rushed. Sparse, aspirational language where every word earns its place.',
    startup:     'Scrappy and exciting. Disruptive framing, founder conviction, energy of someone changing something.',
    friendly:    'Warm, genuine, completely likeable — a trusted friend giving an honest recommendation.',
    high_energy: 'Maximum energy from the first word. Fast pace, nonstop forward momentum. No lower gear.',
  }[adFeeling] || 'Write in a genuine, natural first-person voice.';

  const brief = CREATOR_BRIEFS[creatorStyle] || {};

  const system = `You are an expert UGC ad scriptwriter and creative director for TikTok, Instagram Reels, and YouTube Shorts.

CREATOR PROFILE: ${brief.context || 'An authentic creator speaking directly to camera.'}
HOOK STYLE: ${brief.hookStyle || 'Open with a strong attention-grabbing hook.'}
LANGUAGE GUIDE: ${brief.language || 'Conversational, first-person, authentic.'}
CTA STYLE: ${brief.ctaStyle || 'End with a clear, natural call-to-action.'}

AD FEELING (HIGHEST PRIORITY): ${feelingInstruction}

Rules: first-person only, no stage directions, no brackets, output ONLY the spoken script, 8–12 sentences.`;

  const userMsg = [
    'Write a UGC ad script.',
    brandName ? `Brand: ${brandName}` : '',
    brandDesc ? `About: ${brandDesc}` : '',
    `Creator: ${(creatorStyle || '').replace(/_/g, ' ')}`,
    `Feeling: ${adFeeling || 'viral'}`,
    '',
    'Output ONLY the spoken script.',
  ].filter(Boolean).join('\n');

  try {
    const script = (await callAnthropic(system, userMsg)).trim();
    if (!script) return res.status(500).json({ error: 'Empty script generated' });

    console.log('[UGC] Script generated | user:', user.id);
    return res.json({ ok: true, script });
  } catch (err) {
    console.error('[UGC] Script generation error:', err.message);
    return res.status(500).json({ error: 'Failed to generate script: ' + err.message });
  }
});

// ── POST /api/generate-ugc-video ─────────────────────────────────
app.post('/api/generate-ugc-video', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { script, avatarId, voiceId } = req.body || {};
  if (!script || !script.trim()) return res.status(400).json({ error: 'Script is required' });
  if (!avatarId)                  return res.status(400).json({ error: 'Avatar ID is required' });
  if (!voiceId)                   return res.status(400).json({ error: 'Voice ID is required' });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'HeyGen API key not configured' });

  try {
    const response = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        video_inputs: [{
          character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
          voice:     { type: 'text',   input_text: script.trim(), voice_id: voiceId, speed: 1.0 }
        }],
        dimension: { width: 720, height: 1280 },
        test: false
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errMsg = (data.error && (data.error.message || JSON.stringify(data.error))) || data.message || 'HeyGen error';
      console.error('[UGC] Generation failed:', errMsg);
      return res.status(400).json({ error: errMsg });
    }

    const videoId = data.data && data.data.video_id;
    if (!videoId) return res.status(500).json({ error: 'No video ID returned from HeyGen' });

    console.log('[UGC] Generation started:', videoId, 'for user:', user.id);
    return res.json({ ok: true, videoId, status: 'processing' });
  } catch (err) {
    console.error('[UGC] Generation error:', err.message);
    return res.status(500).json({ error: 'Failed to start video generation' });
  }
});

// ── GET /api/ugc-video-status/:videoId ──────────────────────────
app.get('/api/ugc-video-status/:videoId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { videoId } = req.params;
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'HeyGen API key not configured' });

  try {
    const response = await fetch(`${HEYGEN_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
      headers: { 'X-Api-Key': apiKey }
    });
    const data = await response.json();
    const video = (data && data.data) || {};
    return res.json({
      status:       video.status        || 'unknown',
      videoUrl:     video.video_url     || null,
      thumbnailUrl: video.thumbnail_url || null,
      error:        video.error         || null
    });
  } catch (err) {
    console.error('[UGC] Status error:', err.message);
    return res.status(500).json({ error: 'Failed to check video status' });
  }
});

// ── Fallback — after all routes ──────────────────────────────────
// /api/* paths return a JSON 404 so the frontend fetch wrapper gets
// parseable JSON instead of an HTML error page.
// All other paths (SPA routes like /app, /studio, /settings, etc.)
// return index.html so the client-side router takes over on refresh.
app.use(function(req, res) {
  if (req.path.startsWith('/api/')) {
    console.warn('[404]', req.method, req.url);
    return res.status(404).json({ error: 'Route not found: ' + req.method + ' ' + req.url });
  }
  res.sendFile(path.resolve(__dirname, '..', 'index.html'));
});

// ── Global error handler — catches unhandled errors in routes ───
// Express requires exactly 4 arguments for error handlers.
app.use(function(err, req, res, _next) {
  console.error('[ServerError]', req.method, req.url, err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Daily cron: delete unverified accounts older than 14 days ───
// Runs at 02:00 UTC every day. Safe to re-run — only targets accounts
// where email_verified = false AND created_at < 14 days ago.
cron.schedule('0 2 * * *', async () => {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[Cron] Cleanup run — cutoff: ${cutoff}`);
  try {
    const { data: stale, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('email_verified', false)
      .lt('created_at', cutoff);

    if (error) { console.error('[Cron] Query error:', error.message); return; }
    if (!stale || stale.length === 0) { console.log('[Cron] No stale unverified accounts'); return; }

    console.log(`[Cron] Deleting ${stale.length} unverified account(s)...`);
    for (const row of stale) {
      try {
        const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(row.id);
        if (delErr) console.error('[Cron] Delete failed for', row.id, ':', delErr.message);
        else        console.log('[Cron] Deleted:', row.id, row.email);
      } catch (e) {
        console.error('[Cron] Exception deleting', row.id, ':', e.message);
      }
    }
  } catch (err) {
    console.error('[Cron] Unexpected error:', err.message);
  }
}, { timezone: 'UTC' });


app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Live Supabase admin connectivity test — runs every server start
  console.log('[Startup] Testing Supabase admin client...');
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, subscription_status')
      .limit(1);

    if (error) {
      console.error('[Startup] ❌ Supabase admin query FAILED:', error.message, '| code:', error.code);
      if (error.code === '42501') {
        console.error('[Startup]    RLS blocked the query — SUPABASE_SERVICE_ROLE_KEY is wrong');
        console.error('[Startup]    Fix: get the service_role key from Supabase Dashboard → Settings → API');
      }
    } else {
      console.log('[Startup] ✅ Supabase admin client can read profiles table');
      if (data && data.length > 0) {
        console.log('[Startup]    Sample row:', JSON.stringify(data[0]));
      } else {
        console.log('[Startup]    profiles table is empty (no rows yet)');
      }
    }
  } catch (e) {
    console.error('[Startup] ❌ Supabase admin test threw an exception:', e.message);
  }
});
