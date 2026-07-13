const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const path       = require('path');
const cron       = require('node-cron');
// Resolve .env from the frontend root (two levels up: server/ → oriven-backand-clean/ → C:\files).
// Frontend is the single source of truth for .env.
// NOTE: dotenv does NOT override variables already present in the process
// environment (e.g. set by Render dashboard). If a key shows the wrong value
// at runtime, update it in the Render dashboard — not just in .env.
const _dotenvPath = path.resolve(__dirname, '..', '..', '.env');
const _dotenvResult = require('dotenv').config({ path: _dotenvPath });
console.log(
  '[dotenv] Loaded from:', _dotenvPath,
  '| error:', _dotenvResult.error ? _dotenvResult.error.message : 'none'
);

const app = express();
const PORT = parseInt(process.env.PORT || '5500', 10);

console.log(
  "[Config] Stripe key suffix:",
  process.env.STRIPE_SECRET_KEY?.slice(-4)
);
const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY            || 'missing');


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
  _ck(process.env.AIML_API_KEY, 'AIML_API_KEY');


  // AIML API — all AI generation routes
  const _aiml   = require('./providers/aimlProvider');
  const _router = require('./services/modelRouter');
  _aiml.diagnose();
  _router.logSummary();

  // ── Stripe ───────────────────────────────────────────────────────
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk || sk === 'missing') {
    console.error('❌ [ENV] STRIPE_SECRET_KEY is not set — payments will fail');
  } else {
    console.log('✅ [ENV] STRIPE_SECRET_KEY =', sk.startsWith('sk_live') ? '✅ LIVE key' : '⚠️  TEST key');
  }
  // Stripe Price IDs — set these in Render environment variables.
  // Create prices in Stripe Dashboard → Products, then copy the price_... ID.
  // STRIPE_PRICE_STARTER      → Starter plan       €9.95/month
  // STRIPE_PRICE_CREATOR      → Creator plan        €29.95/month
  // STRIPE_PRICE_PROFESSIONAL → Professional plan   €59.95/month
  // Agency is Contact Sales — no Stripe price ID required.
  const _price = (k) => console.log(' ', k, '=', process.env[k] || '❌ NOT SET');
  _price('STRIPE_PRICE_STARTER');
  _price('STRIPE_PRICE_CREATOR');
  _price('STRIPE_PRICE_PROFESSIONAL');

  // ── SMTP ─────────────────────────────────────────────────────────
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('⚠️  [ENV] SMTP_USER / SMTP_PASS not fully set — verification emails will be skipped');
  } else {
    console.log('✅ [ENV] SMTP configured for', process.env.SMTP_USER);
  }

  // ── Google OAuth ──────────────────────────────────────────────────
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn('⚠️  [ENV] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google Ads OAuth disabled');
  } else {
    const _resolvedRedirect = process.env.GOOGLE_REDIRECT_URI
      || (process.env.RENDER ? 'https://oriven-backand-clean.onrender.com/auth/google/callback' : 'http://localhost:5500/auth/google/callback');
    console.log('✅ [ENV] Google OAuth configured | redirect:', _resolvedRedirect,
      process.env.GOOGLE_REDIRECT_URI ? '(from env)' : process.env.RENDER ? '(Render default)' : '(localhost default)');
  }

  console.log('═══════════════════════════════════════════════════\n');
})();

const PRICE_IDS = {
  starter:      process.env.STRIPE_PRICE_STARTER,
  creator:      process.env.STRIPE_PRICE_CREATOR,
  professional: process.env.STRIPE_PRICE_PROFESSIONAL,
};

app.use(cors());

// ── Static files — serve the frontend from the project root ────
// This makes Express the single origin for both HTML and API routes,
// so relative /api/... URLs from the browser resolve to this process.
// Must come before express.json() but after cors() so CORS headers
// are present on static responses too.
app.use(express.static(path.resolve(__dirname, '..', '..')));

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
  console.log("[Checkout Debug] Using creator/professional plan mapping");
  const validPlans = ['starter', 'creator', 'professional'];
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
    let raw = (await _aimlText('web', systemPrompt, userPrompt, { max_tokens: 8000 })).trim();

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

// ── Subscription enforcement middleware ───────────────────────────
// Two tiers:
//
// requireSubscription     — strict: auth token required AND subscription required.
//                           Use for account-management routes (plan change, invite).
//
// requireSubIfAuthed      — lenient: no-auth requests pass through (guest demo);
//                           authenticated-but-unpaid requests are blocked with 403.
//                           Use for all generation routes shared with the guest demo.

const PAID_PLANS = ['starter', 'creator', 'professional'];

async function requireSubscription(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session', code: 'AUTH_INVALID' });
  try {
    const { data } = await supabaseAdmin
      .from('profiles').select('subscription_status').eq('id', user.id).maybeSingle();
    if (!PAID_PLANS.includes((data && data.subscription_status) || '')) {
      return res.status(403).json({ error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] Subscription check error:', err.message);
    return res.status(500).json({ error: 'Could not verify subscription' });
  }
}

async function requireSubIfAuthed(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth) return next(); // unauthenticated — guest demo, pass through
  const user = await getUserFromToken(req);
  if (!user) return next(); // bad token — pass through gracefully
  try {
    const { data } = await supabaseAdmin
      .from('profiles').select('subscription_status').eq('id', user.id).maybeSingle();
    if (!PAID_PLANS.includes((data && data.subscription_status) || '')) {
      return res.status(403).json({ error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    }
    req.user = user;
    next();
  } catch (_) { next(); } // fail open for generation routes
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

// ── Strip markdown/quote fences from HTML output ────────────────
function extractHtml(raw) {
  let s = (raw || '').trim();
  // Strip backtick fences: ```html ... ``` or ``` ... ```
  s = s.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Strip triple-quote fences: """html ... """ or """ ... """
  s = s.replace(/^"{3}(?:html)?\s*/i, '').replace(/\s*"{3}\s*$/i, '').trim();
  // If there's any preamble before the actual HTML, skip it
  const htmlStart = s.search(/<(!DOCTYPE|html)[^>]*>/i);
  if (htmlStart > 0) s = s.slice(htmlStart);
  return s;
}


// ── Extract a concise image prompt from a structured brief via AIML ─
async function _briefToDallEPrompt(fullBrief, contextHint) {
  const system = `You are a visual art director. Convert the following structured brief into a single image generation prompt.

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

  const result = await _aimlText('visuals-copy', system, userMsg, { max_tokens: 200 });
  return result.trim().slice(0, 450);
}

// ── Text — Anthropic only ───────────────────────────────────────
// Used by: Text, Brand Assistant, Ideas, Video
// ── Shared helper: format BrandCore context for AI prompts ──────
function _buildBrandSection(bc) {
  if (!bc || !bc.name) return '';
  const lines = [];
  if (bc.name)            lines.push(`Brand: ${bc.name}`);
  if (bc.tagline)         lines.push(`Tagline: ${bc.tagline}`);
  if (bc.toneOfVoice)     lines.push(`Tone of Voice: ${bc.toneOfVoice}`);
  if (bc.personality)     lines.push(`Brand Personality: ${bc.personality}`);
  if (bc.audience)        lines.push(`Target Audience: ${bc.audience}`);
  if (bc.positioning)     lines.push(`Positioning: ${bc.positioning}`);
  if (bc.visualDirection) lines.push(`Visual Direction: ${bc.visualDirection}`);
  return lines.map(l => '  - ' + l).join('\n');
}

// ── Generation helpers — all routes through AIML ─────────────────
// Provider and model are determined entirely by modelRouter.js.

// Size ↔ ratio conversion utilities
function _sizeToRatio(size) {
  const map = { '1024x1024': '1:1', '1024x1536': '9:16', '1536x1024': '16:9', '1792x1024': '16:9', '1024x1792': '9:16' };
  return map[size] || '1:1';
}

function _ratioToSize(ratio) {
  const map = { '1:1': '1024x1024', '9:16': '1024x1536', '16:9': '1536x1024' };
  return map[ratio] || '1024x1024';
}

async function _aimlText(taskType, system, user, opts = {}) {
  const router = require('./services/modelRouter');
  const route  = router.routeTask(taskType);
  const aiml   = require('./providers/aimlProvider');
  return aiml.generateText(system, user, { model: route.model, ...opts });
}

async function _aimlImage(taskType, prompt, opts = {}) {
  const router = require('./services/modelRouter');
  const route  = router.routeTask(taskType);
  const aiml   = require('./providers/aimlProvider');
  console.log(`[${taskType}] Provider: AIML | Model: ${route.model} | Endpoint: /v1/images/generations`);
  const urls = await aiml.generateImage(prompt, { model: route.model, ...opts });
  return urls[0] || null;
}

async function _aimlVision(taskType, system, user, imageDataUrl, opts = {}) {
  const router = require('./services/modelRouter');
  const route  = router.routeTask(taskType);
  const aiml   = require('./providers/aimlProvider');
  return aiml.generateTextWithVision(system, user, imageDataUrl, { model: route.model, ...opts });
}

// ── Image prompt builder ──────────────────────────────────────────
// Turns a brief into a focused image generation prompt via Anthropic,
// then the caller passes the result to _aimlImage for rendering.

async function _briefToImagePrompt(brief, contextHint, taskType) {
  const system = `You are a visual art director. Convert this brief into a single vivid image generation prompt of 150–300 characters. Describe what's seen — composition, color palette, mood, lighting. Reference brand colors by hex if provided. No text, logos, or UI elements. Output ONLY the prompt.`;
  const user   = (contextHint ? `Context: ${contextHint}\n\nBrief:\n` : 'Brief:\n') + brief.slice(0, 2000);
  return _aimlText(taskType || 'visuals-copy', system, user, { max_tokens: 300 });
}

app.post('/api/generate-text', async (req, res) => {
  const { prompt, type, brandContext } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const brandSection = _buildBrandSection(brandContext);
  const hasBrand     = brandSection.length > 0;

  console.log(`[Text/${type || 'default'}] Anthropic → prompt received | brand: ${hasBrand ? brandContext.name : 'none'}`);

  let systemPrompt;

  if (type === 'assistant') {
    systemPrompt = `You are a smart, helpful AI assistant for brand owners and marketers. You have deep knowledge of marketing, branding, strategy, copywriting, campaigns, content, and creative direction.${hasBrand ? `\n\nYou have access to the user's brand context below. Use it when it's relevant to their question — but don't reference it in every response. When someone says "hi" or makes small talk, just respond naturally and briefly.\n\nBRAND CONTEXT (draw on this when relevant):\n${brandSection}` : ''}

Be conversational and natural. Match the energy of the message — brief for casual, thorough for strategic questions. Think like a knowledgeable colleague, not a branded bot. Never start with hollow affirmations like "Great!" or "Absolutely!". Be direct.`;

  } else if (type === 'text' || type === 'video' || type === 'ideas') {
    systemPrompt = `You are a senior brand copywriter and content strategist.
Generate structured, professional content based on the brief provided.
Output must be specific, intentional, and ready to use — no preamble, no meta-commentary, no filler.
Never respond conversationally. Never say "Sure!" or "Great!" or explain what you're about to do.
Just produce the requested content, formatted cleanly and directly.${hasBrand ? `\n\nBRAND CONTEXT — every output must reflect this brand identity exactly:\n${brandSection}` : ''}`;

  } else {
    systemPrompt = `You are a senior brand copywriter. Generate professional brand content based on the brief.
Be specific and direct. No preamble or filler.${hasBrand ? `\n\nBRAND CONTEXT:\n${brandSection}` : ''}`;
  }

  try {
    const result = await _aimlText('text-copy', systemPrompt, prompt);
    console.log(`[Text/${type || 'default'}] AIML → response ready`);
    res.json({ result });
  } catch (err) {
    console.error(`[Text/${type || 'default'}] AIML error:`, err.message);
    res.status(500).json({ error: 'Failed to generate text. Please try again.' });
  }
});

// ── Email Designer — Anthropic ─────────────────────────────────
// Used by: Email Designer generator
// Receives: { prompt }  Returns: { html }
app.post('/api/generate-email', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const system = `You are an expert email marketing designer and copywriter. Generate a complete, production-ready HTML email.

CRITICAL: Output ONLY raw HTML starting with <!DOCTYPE html>. No markdown. No code fences. No explanation. No """ or \`\`\` wrappers. The very first character must be <.

TECHNICAL REQUIREMENTS:
- Table-based layout for maximum email client compatibility (Gmail, Outlook, Apple Mail)
- Inline every CSS style — attribute style="" on every element (no <style> blocks)
- Max-width 600px, centered with auto margins
- Include realistic, compelling sections: header with brand name/logo text, main content body, CTA button, footer with unsubscribe link

DESIGN REQUIREMENTS:
- Apply brand colours from BrandCore as inline hex values throughout
- Use web-safe fonts (Arial, Georgia, Helvetica)
- Every section must have visible content — no blank areas
- CTA button must be a styled table cell with solid background colour, not a plain link
- Write all copy based on the brief — zero placeholder text`;

  try {
    const html = extractHtml(await _aimlText('email', system, prompt, { max_tokens: 4096 }));
    res.json({ html });
  } catch (err) {
    console.error('[Email] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate email. Please try again.' });
  }
});

// ── Presentation Generator — Anthropic ─────────────────────────
// Used by: Presentation Generator
// Receives: { prompt }  Returns: { slides: [{slide, title, content, notes}] }
app.post('/api/generate-deck', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const system = `You are a world-class presentation designer and strategist. Generate a complete slide deck with rich visual structure.

CRITICAL: Respond with ONLY a valid JSON object. No markdown. No code fences. No explanation. Start directly with {

OUTPUT SCHEMA — every slide must use this structure:
{
  "slides": [
    {
      "slide": 1,
      "layout": "title",
      "title": "The main headline",
      "subtitle": "Supporting line (title/closing slides only)",
      "eyebrow": "SMALL LABEL (optional, title slides only)",
      "bullets": ["Bullet point 1", "Bullet point 2", "Bullet point 3"],
      "content": "Paragraph or quote text (content/quote slides)",
      "metrics": [{"value": "10x", "label": "Growth"}, {"value": "$2M", "label": "ARR"}],
      "cta": "Call to action text (closing slides only)",
      "attribution": "Quote author (quote slides only)",
      "notes": "Speaker notes — what to say while this slide is shown"
    }
  ]
}

LAYOUT TYPES — assign the best layout for each slide:
- "title" — Opening slide. Large title + subtitle. ALWAYS use for slide 1.
- "content" — Standard slide. Headline + bullet points (3–5 max). Most slides use this.
- "stats" — Data slide. Use "metrics" array (2–4 items, each with value + label). Use for any slide with numbers.
- "feature" — Showcase slide. Use "bullets" as feature names (3–6 items in a grid). Use for feature/benefit lists.
- "quote" — Impact statement. Use "content" for the quote, "attribution" for the source.
- "closing" — Final slide. Title + body + CTA. ALWAYS use for the last slide.

RULES:
- Slide 1 MUST be "title" layout. Last slide MUST be "closing" layout.
- Use "stats" for any slide with metrics, percentages, or numbers.
- Bullets: max 5 items per slide. Each bullet must be punchy and concise (under 12 words).
- Metrics values should be dramatic and formatted (e.g. "3.2x", "$4.8M", "94%").
- Apply the brand voice and tone from BrandCore to every word.
- Every slide must have a strong, memorable title.`;

  try {
    const raw = (await _aimlText('presentations', system, prompt, { max_tokens: 3000 })).trim();
    let parsed;
    try {
      // Strip markdown fences if present
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error('[Deck] JSON parse failed:', e.message, raw.slice(0, 200));
      return res.status(500).json({ error: 'AI returned invalid slide structure. Please try again.' });
    }
    res.json({ slides: parsed.slides || [] });
  } catch (err) {
    console.error('[Deck] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate deck. Please try again.' });
  }
});

// ── Poster Generator — Anthropic ───────────────────────────────
// Used by: Poster Generator
// Receives: { prompt }  Returns: { html }
app.post('/api/generate-poster', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const system = `You are a world-class graphic designer. Generate a bold, complete HTML/CSS poster rendered in a browser.

CRITICAL: Output ONLY raw HTML starting with <!DOCTYPE html>. No markdown. No code fences. No explanation. No """ or \`\`\` wrappers. The very first character must be <.

MANDATORY DOCUMENT STRUCTURE:
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    /* All styles here */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #111; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 20px; font-family: 'Arial', sans-serif; }
    .poster { width: 794px; min-height: 1123px; position: relative; overflow: hidden; /* brand background */ }
    /* All other styles... */
  </style>
</head>
<body>
  <div class="poster">
    <!-- SECTION 1: Header with brand name (large, bold, brand color) -->
    <!-- SECTION 2: Hero visual area (CSS gradients, geometric shapes — NO <img> tags) -->
    <!-- SECTION 3: Headline (DOMINANT element — largest text on the poster) -->
    <!-- SECTION 4: Supporting copy and body text -->
    <!-- SECTION 5: CTA section (button or URL in brand color) -->
    <!-- SECTION 6: Footer with brand details -->
  </div>
</body>
</html>

DESIGN REQUIREMENTS:
- Apply brand colours from BrandCore as the primary palette throughout
- Headline must be LARGE (80px+) and DOMINANT — the first thing the eye sees
- Use CSS gradients, shapes, borders, and pseudo-elements for all visual interest (no <img>)
- High contrast — dark background with bright brand-coloured accents, or vice versa
- Every section must have VISIBLE CONTENT — zero blank areas
- Bold typographic hierarchy: headline > subheading > body > CTA
- Include all copy from the brief verbatim — no placeholder text

POSTER MUST INCLUDE ALL OF THESE SECTIONS:
1. Brand header (brand name or logo text, brand colour)
2. Hero/visual area (abstract CSS shapes, gradient backdrop, geometric composition)
3. Main headline (the largest, most dominant text)
4. Supporting body text
5. CTA area (styled button or highlighted URL)
6. Footer (tagline or brand detail)`;

  try {
    const html = extractHtml(await _aimlText('poster', system, prompt, { max_tokens: 4096 }));
    res.json({ html });
  } catch (err) {
    console.error('[Poster] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate poster. Please try again.' });
  }
});

app.post('/api/generate-infographic', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const system = `You are a world-class infographic designer. Generate a bold, complete HTML/CSS infographic rendered in a browser.

CRITICAL: Output ONLY raw HTML starting with <!DOCTYPE html>. No markdown. No code fences. No explanation. No """ or \`\`\` wrappers. The very first character must be <.

MANDATORY DOCUMENT STRUCTURE:
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0F0F0F; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 20px; font-family: 'Arial', sans-serif; }
    .infographic { width: 794px; min-height: 1123px; position: relative; overflow: hidden; }
  </style>
</head>
<body>
  <div class="infographic">
    <!-- SECTION 1: Title header with brand name and infographic title -->
    <!-- SECTION 2: Introduction / context line -->
    <!-- SECTION 3: Main data visualisation (charts, bars, steps, timeline, icons — all CSS only) -->
    <!-- SECTION 4: Key statistics or callout facts -->
    <!-- SECTION 5: CTA footer with brand name -->
  </div>
</body>
</html>

DESIGN REQUIREMENTS:
- Apply brand colours from BrandCore as the primary palette throughout
- Title must be prominent (56px+) at the top of the infographic
- Use CSS-only visualisations: bar charts, progress bars, icon shapes, numbered circles, connecting lines — NO <img> tags
- Data must be visually encoded — numbers should be LARGE and immediately readable
- High visual hierarchy: title > section headers > data points > supporting text
- All copy from the brief included verbatim — no placeholder text
- Sections clearly separated with whitespace, dividers, or background contrast

INFOGRAPHIC MUST INCLUDE ALL OF THESE:
1. Brand header (brand name, brand colour, infographic title)
2. Main data section (visually rich — charts, steps, icons, stats, all CSS)
3. At least one prominent callout stat or highlight box
4. CTA footer (brand-coloured, action-oriented)`;

  try {
    const html = extractHtml(await _aimlText('infographic', system, prompt, { max_tokens: 4096 }));
    res.json({ html });
  } catch (err) {
    console.error('[Infographic] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate infographic. Please try again.' });
  }
});

// ── Image — OpenAI DALL-E only ──────────────────────────────────
// Used by: Image (guided flow)
// Receives: { prompt, size, imageType, imageFormat, refImageData? }
// If refImageData is provided, Anthropic vision extracts style cues
// which are appended to the DALL-E prompt as a style guide.
app.post('/api/generate-image', requireSubIfAuthed, async (req, res) => {
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
        const imageDataUrl = `data:${mediaType};base64,${b64data}`;
        const analysis = (await _aimlVision('vision', visionSystem, visionPrompt, imageDataUrl, { max_tokens: 160 })).trim();
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
    const imageUrl = await _aimlImage('visuals', finalPrompt, { aspect_ratio: _sizeToRatio(resolvedSize) });
    console.log('[Image] AIML → image ready');
    res.json({ imageUrl });
  } catch (err) {
    console.error('[Image] AIML error:', err.message);
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
      _aimlText('ads-copy', copySystem, prompt),
      _briefToImagePrompt(prompt, `${adFormat || 'feed'} advertisement visual`, 'visuals-copy'),
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

  console.log(`[Ads] Step 3 — AIML image → ratio: ${_sizeToRatio(resolvedSize)}`);
  let imageUrl = null;
  try {
    imageUrl = await _aimlImage('visuals', dallePrompt, { aspect_ratio: _sizeToRatio(resolvedSize) });
    console.log('[Ads] Step 3 — AIML → image ready');
  } catch (err) {
    console.warn('[Ads] Step 3 — AIML image failed (non-fatal):', err.message);
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
app.post('/api/generate-campaign', requireSubIfAuthed, async (req, res) => {
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

    const raw     = await _aimlText('campaigns-copy', system, prompt);
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
    console.error('[Campaign] AIML error:', err.message);
    return res.status(500).json({ error: 'Failed to generate campaign variations' });
  }

  // ── Step 2: Generate all images in parallel ──────────────────────────
  console.log(`[Campaign] Step 2 — generating ${variations.length} images in parallel (size: ${resolvedSize})...`);
  const imageResults = await Promise.allSettled(
    variations.map(async (v, i) => {
      const imgPrompt = (v.imagePrompt || '').trim();
      if (!imgPrompt) return null;
      try {
        const url = await _aimlImage('campaigns-image', imgPrompt, { aspect_ratio: _sizeToRatio(resolvedSize) });
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
app.post('/api/generate-brandcore', requireSubIfAuthed, async (req, res) => {
  const {
    brandName, description, industry, targetAudience,
    brandType, visualStyle, colorDir, brandFeeling,
    // legacy fields kept for backward compatibility
    type, colorMood, brandStyle, personality
  } = req.body;

  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  const effectiveIndustry    = industry    || type         || '';
  const effectiveVisualStyle = visualStyle || brandStyle   || '';
  const effectiveColorDir    = colorDir    || colorMood    || '';
  const effectivePersonality = personality || brandType    || '';

  console.log('[BrandCore] Generating complete brand identity for:', brandName);

  const system = `You are ORIVEN BrandCore AI — a world-class brand strategist, creative director, design systems architect, and visual identity specialist.

Your task is to generate a COMPLETE, real brand identity system from a user brief. Every field must be specific, intentional, and commercially believable.

STRICT RULES:
- Never produce generic, placeholder, or cliché output
- Every color must be a purposeful hex code justified by the brand's emotional register, industry, and audience
- Fonts must be real, widely available typefaces with genuine strategic reasoning
- Personality must be exactly 4 distinct, powerful single-word keywords (not phrases)
- Tone of Voice must be exactly one clear sentence describing how the brand speaks
- Positioning must be exactly one sentence: what the brand is, who it serves, and what makes it distinct
- Tagline must be punchy, memorable, and ≤ 8 words
- Visual direction must be a vivid, specific description of the visual language (not generic adjectives)
- Logo concept imagePrompt must be visual-only, contain NO text or letterforms, suitable for AI image generation
- Choose typography that feels intentional: pair a distinctive heading font with a high-readability body font

COLOR SYSTEM REQUIREMENTS:
- Primary color: anchors brand recognition
- Secondary color: supports layouts and background surfaces
- Accent color: highlights interactive elements and key moments
- Text color: ensures readability (usually near-black or near-white depending on background direction)
- Support Color 1: neutral surface for content areas
- Support Color 2: secondary surfaces, dividers, subtle backgrounds
- All 6 colors must work together as a cohesive system

AVAILABLE FONTS (choose from this list or similar quality equivalents):
Instrument Serif, Fraunces, Playfair Display, Lora, DM Serif Display, Cormorant Garamond, Libre Baskerville, Geist, Inter, DM Sans, Plus Jakarta Sans, Syne, Cabinet Grotesk, Satoshi, Space Grotesk, Montserrat, Raleway, Work Sans

OUTPUT FORMAT:
Reply ONLY with valid JSON. No markdown fences. No extra text. No preamble.

{
  "brandName": "string",
  "tagline": "string — ≤8 words, punchy, brand-defining",
  "colorSystem": {
    "primary":   { "hex": "#XXXXXX", "name": "Primary",   "reason": "string — why this color for this brand" },
    "secondary": { "hex": "#XXXXXX", "name": "Secondary", "reason": "string — why this color for this brand" },
    "accent":    { "hex": "#XXXXXX", "name": "Accent",    "reason": "string — why this color for this brand" },
    "text":      { "hex": "#XXXXXX", "name": "Text",      "reason": "string — readability and contrast rationale" },
    "support1":  { "hex": "#XXXXXX", "name": "Support 1", "reason": "string — usage context" },
    "support2":  { "hex": "#XXXXXX", "name": "Support 2", "reason": "string — usage context" }
  },
  "typography": {
    "heading": { "family": "string", "reason": "string — why this font matches the brand personality" },
    "body":    { "family": "string", "reason": "string — why this font supports readability and brand feel" }
  },
  "brandStrategy": {
    "positioning":    "string — exactly one sentence",
    "targetAudience": "string — specific psychographic and demographic description",
    "personality":    ["keyword1", "keyword2", "keyword3", "keyword4"],
    "toneOfVoice":   "string — exactly one sentence describing how the brand speaks"
  },
  "brandCore": {
    "brandPromise": "string — one sharp sentence the customer can hold the brand to",
    "mission":      "string — why the brand exists beyond profit",
    "vision":       "string — what success looks like in 5 years",
    "values":       ["string", "string", "string"]
  },
  "visualDirection": "string — vivid, specific description of the complete visual language and aesthetic direction",
  "logoConcept": {
    "description":  "string — strategic rationale: what the logo communicates and why",
    "style":       "string — wordmark / lettermark / icon / combination mark and why",
    "imagePrompt": "string — specific DALL-E prompt, visual only, no text, no letterforms"
  }
}`;

  const userPrompt = `Generate a complete BrandCore for the following brand brief. Use ALL provided context to make every decision specific and intentional.

BRAND BRIEF:
Brand Name: ${brandName}
What the brand does: ${description || 'not specified'}
Industry: ${effectiveIndustry || 'not specified'}
Target Audience: ${targetAudience || 'not specified'}
Brand Character / Type: ${brandType || effectivePersonality || 'not specified'}
Visual Style Preference: ${effectiveVisualStyle || 'not specified'}
Color Direction: ${effectiveColorDir || 'not specified'}
Desired Brand Feeling: ${brandFeeling || 'not specified'}

Generate the complete BrandCore JSON now. Every field must be specific to this brand — no generic placeholders.`;

  try {
    const raw = await _aimlText('brand-core', system, userPrompt, { max_tokens: 3000 });

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let bc;
    try {
      bc = JSON.parse(cleaned);
    } catch {
      console.error('[BrandCore] JSON parse failed. Raw length:', raw.length);
      console.error('[BrandCore] Raw preview:', raw.slice(0, 500));
      return res.status(500).json({ error: 'Failed to parse brand identity. Please try again.' });
    }

    console.log('[BrandCore] Generated for:', brandName, '| tagline:', bc.tagline);
    res.json(bc);
  } catch (err) {
    console.error('[BrandCore] Generation error:', err.message);
    res.status(500).json({ error: 'Brand generation failed. Please try again.' });
  }
});

// ── Brand Check — OpenAI Quality Analysis ────────────────────────
app.post('/api/brand-check', requireSubIfAuthed, async (req, res) => {
  const {
    brandName, tagline, colors, fonts, brandPromise, description,
    targetAudience, styleDirection, colorMood, mission, vision,
    personality, toneOfVoice, values, positioning, logoConcept,
  } = req.body;
  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  console.log('[BrandCheck] AIML → analysing brand:', brandName);
  try {
    const system = `You are a world-class brand strategist with 20 years of experience advising high-growth companies, DTC brands, and funded startups.

Your role: Perform an intelligent, quality-driven brand audit. This is NOT a completeness check.
A brand with every field filled in can still score poorly if the positioning is weak, the personality is generic, or the visual direction is inconsistent.

Evaluate quality across ten dimensions:
1. Consistency — do all elements reinforce each other?
2. Differentiation — does this brand stand out or blend in?
3. Clarity — is the positioning instantly understandable?
4. Positioning Strength — is it specific, ownable, and meaningful?
5. Audience Alignment — does the identity match who it's speaking to?
6. Visual Coherence — do colors, typography, and style direction work as a system?
7. Brand Personality Strength — is it distinctive or generic?
8. Tone of Voice Alignment — does the tone match the personality and audience?
9. Typography Suitability — does the font choice reinforce the brand feeling?
10. Color Harmony — does the palette feel intentional and emotionally right?

Score calibration:
- 30–50: Weak positioning, generic personality, poor alignment
- 51–65: Some elements working but lacks coherence or differentiation
- 66–79: Solid foundation with clear opportunities to sharpen
- 80–89: Strong, coherent identity with minor gaps
- 90–100: Exceptional clarity, differentiation, and system coherence

Return ONLY valid JSON — no markdown, no extra text — matching this exact structure:
{
  "score": number,
  "professionalLevel": "string",
  "summary": "string",
  "strengths": ["string"],
  "opportunities": ["string"],
  "recommendations": ["string"]
}

Rules:
- score: integer 0–100 based entirely on quality, not completeness. Be honest — inflation destroys trust.
- professionalLevel: one of "developing", "emerging", "established", "advanced", "premium"
- summary: 2–3 sentences. The most important strategic truth about this brand. Direct, warm, insightful — write as a trusted advisor to a founder, not a report generator.
- strengths: 3–5 items. Specific and concrete. Reference actual brand elements. No vague praise.
- opportunities: 3–5 items. Where recognition is being left on the table. Frame as strategic guidance. Be specific about what to improve and why it matters for audience connection or market differentiation.
- recommendations: 3–5 items. Concrete, prioritized actions the brand owner should take next. Most impactful first. Each must be immediately actionable.
- Every line must be specific to THIS brand. Generic feedback is a failure.`;

    // Build rich brand context
    const lines = [`BRAND NAME: ${brandName}`];
    if (tagline)        lines.push(`Tagline / Brand Promise: ${tagline}`);
    else if (brandPromise) lines.push(`Brand Promise: ${brandPromise}`);
    if (positioning)    lines.push(`Positioning Statement: ${positioning}`);
    if (description)    lines.push(`Brand Description: ${description}`);
    if (mission)        lines.push(`Mission: ${mission}`);
    if (vision)         lines.push(`Vision: ${vision}`);
    if (personality)    lines.push(`Brand Personality: ${personality}`);
    if (toneOfVoice)    lines.push(`Tone of Voice: ${toneOfVoice}`);
    if (values)         lines.push(`Brand Values / Keywords: ${values}`);
    if (targetAudience) lines.push(`Target Audience: ${targetAudience}`);
    if (colors && (Array.isArray(colors) ? colors.length : colors)) {
      lines.push(`Color Palette: ${Array.isArray(colors) ? colors.join(' | ') : colors}`);
    }
    if (colorMood)      lines.push(`Color Mood / Direction: ${colorMood}`);
    if (fonts && (Array.isArray(fonts) ? fonts.length : fonts)) {
      lines.push(`Typography: ${Array.isArray(fonts) ? fonts.join(' | ') : fonts}`);
    }
    if (styleDirection) lines.push(`Visual Style Direction: ${styleDirection}`);
    if (logoConcept)    lines.push(`Logo Concept: ${logoConcept}`);

    const userMsg = `Perform a comprehensive brand audit for the following brand identity. Evaluate quality rigorously — not just whether fields are filled in. Return your full strategic analysis as JSON.\n\n${lines.join('\n')}`;

    const raw = await _aimlText('brand-core', system, userMsg, { max_tokens: 1200 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[BrandCheck] JSON parse failed');
      return res.status(500).json({ error: 'Failed to parse brand check output' });
    }

    console.log('[BrandCheck] AIML → analysis ready for:', brandName, '| Score:', report.score);
    res.json(report);
  } catch (err) {
    console.error('[BrandCheck] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to run brand check' });
  }
});

// ── Competitor Intelligence v2 ──────────────────────────────────
app.post('/api/competitor-intelligence', requireSubIfAuthed, async (req, res) => {
  const { competitor, brandCore } = req.body;

  if (!competitor || typeof competitor !== 'string' || !competitor.trim()) {
    return res.status(400).json({ error: 'A competitor URL is required' });
  }

  const url = competitor.trim();
  console.log('[CompetitorIntel] Analyzing:', url);

  const bcLines = [];
  if (brandCore) {
    if (brandCore.name)        bcLines.push(`Brand Name: ${brandCore.name}`);
    if (brandCore.tagline)     bcLines.push(`Tagline: ${brandCore.tagline}`);
    if (brandCore.positioning) bcLines.push(`Positioning: ${brandCore.positioning}`);
    if (brandCore.audience)    bcLines.push(`Target Audience: ${brandCore.audience}`);
    if (brandCore.toneOfVoice) bcLines.push(`Tone of Voice: ${brandCore.toneOfVoice}`);
    if (brandCore.personality) bcLines.push(`Personality: ${Array.isArray(brandCore.personality) ? brandCore.personality.join(', ') : brandCore.personality}`);
    if (brandCore.mission)     bcLines.push(`Mission: ${brandCore.mission}`);
    if (brandCore.desc)        bcLines.push(`Description: ${brandCore.desc}`);
    if (brandCore.ind)         bcLines.push(`Industry: ${brandCore.ind}`);
    if (brandCore.colors)      bcLines.push(`Colors: ${Array.isArray(brandCore.colors) ? brandCore.colors.join(', ') : brandCore.colors}`);
    if (brandCore.fonts)       bcLines.push(`Typography: ${Array.isArray(brandCore.fonts) ? brandCore.fonts.join(', ') : brandCore.fonts}`);
  }

  const system = `You are a world-class brand strategist and competitive intelligence analyst.

Analyze the competitor brand at the given URL using your comprehensive knowledge of that brand. Compare it to the user's brand to produce a visual brand intelligence dashboard.

For colors: return accurate HEX codes. For major brands (Apple, Nike, Google, etc.) use their real brand colors. For less-known brands, make a reasonable inference.
For typography: name the actual typeface the brand uses.
Keep every label short — 2–6 words max. Only the "insight" field may be longer (3–4 sentences).

Return ONLY valid JSON with zero markdown, matching this exact structure:

{
  "competitor": {
    "name": "Brand Name",
    "industry": "Short industry label",
    "positioning": "3–5 word positioning statement",
    "tone": "Single word",
    "audience": "2–4 word description",
    "visualStyle": "Single word",
    "colors": ["#hex1", "#hex2", "#hex3"],
    "typography": "Font family name",
    "designAdjectives": ["word1", "word2", "word3", "word4"],
    "toneWords": ["word1", "word2", "word3", "word4"]
  },
  "userBrand": {
    "designAdjectives": ["word1", "word2", "word3", "word4"],
    "toneWords": ["word1", "word2", "word3", "word4"]
  },
  "positioning": {
    "competitorOwns": "2–5 word phrase",
    "userOwns": "2–5 word phrase",
    "overlap": ["word1", "word2", "word3"]
  },
  "differentiation": {
    "theyOwn": "2–5 word phrase",
    "youOwn": "2–5 word phrase",
    "opportunity": "2–5 word phrase",
    "risk": "2–5 word phrase"
  },
  "insight": "3–4 sentence strategic insight. Direct, specific, and actionable.",
  "verdict": {
    "strength": "2–4 word phrase",
    "weakness": "2–4 word phrase",
    "advantage": "2–4 word phrase",
    "position": "2–5 word phrase"
  }
}

Rules:
- userBrand fields must reflect the provided Brand Core data. If no data: use strategic defaults.
- Be specific to the actual brand — no generic filler.
- All values are scannable at a glance.`;

  const userMsg = `Competitor URL: ${url}\n\n${bcLines.length ? `User's Brand Core:\n${bcLines.join('\n')}` : 'No brand core provided — use strategic defaults for the user brand.'}`;

  try {
    const raw = await _aimlText('competitor-intel', system, userMsg, { max_tokens: 1800 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[CompetitorIntel] JSON parse failed:', cleaned.slice(0, 200));
      return res.status(500).json({ error: 'Failed to parse competitor analysis' });
    }

    console.log('[CompetitorIntel] Analysis complete for:', url);
    res.json(report);
  } catch (err) {
    console.error('[CompetitorIntel] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to run competitor intelligence analysis' });
  }
});

// ── Stripe checkout session ─────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  const { plan, userId, userEmail, source } = req.body;

  console.log(`[Checkout] ▶ Request received — plan: ${plan}, userId: ${userId}, email: ${userEmail || '(none)'}`);

  if (!plan || !userId) {
    console.error('[Checkout] ❌ Missing required fields — plan:', plan, 'userId:', userId);
    return res.status(400).json({ error: 'plan and userId are required' });
  }

  const validPlans = ['starter', 'creator', 'professional'];
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
  // All checkout cancels return to /app — hard paywall will re-appear for unpaid users.
  const cancelPath = '/app?canceled=true';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail || undefined,
      metadata: { userId, plan },
      success_url: `${frontendUrl}/app?success=true`,
      cancel_url:  `${frontendUrl}${cancelPath}`,
    });

    console.log(`[Checkout] ✅ Session created`);
    console.log(`[Checkout]    Session ID:   ${session.id}`);
    console.log(`[Checkout]    userId:       ${userId}`);
    console.log(`[Checkout]    plan:         ${plan}`);
    console.log(`[Checkout]    priceId:      ${priceId}`);
    console.log(`[Checkout]    success_url:  ${frontendUrl}/app?success=true`);
    console.log(`[Checkout]    cancel_url:   ${frontendUrl}${cancelPath}`);
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
app.post('/api/schedule-plan-change', requireSubscription, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { plan } = req.body;
  if (!plan) return res.status(400).json({ error: 'plan is required' });

  const validPlans = ['free', 'starter', 'creator', 'professional'];
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
app.post('/api/cancel-plan-change', requireSubscription, async (req, res) => {
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
// Body: { count?: number }  — credits consumed (default 1, capped at 20)
app.post('/api/increment-usage', requireSubscription, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const amount       = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 20);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const currentDay   = new Date().toISOString().slice(0, 10);
  try {
    const { data } = await supabaseAdmin.from('profiles')
      .select('usage_data').eq('id', user.id).maybeSingle();
    const prev         = (data && data.usage_data) || {};
    const monthlyCount = prev.monthly_key === currentMonth ? (prev.monthly_count || 0) + amount : amount;
    const dailyCount   = prev.daily_key   === currentDay   ? (prev.daily_count   || 0) + amount : amount;
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

  // Upsert profile row — using upsert (not insert) so a Supabase auth trigger that
  // pre-creates the row cannot block the write or leave a stale subscription_status.
  const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
    id:                   user.id,
    first_name:           firstName,
    last_name:            lastName || null,
    email,
    phone:                phone || null,
    subscription_status:  'free',
    email_verified:        false,
    onboarding_completed:  false,
    verification_token:    verificationToken,
    verification_sent_at:  new Date().toISOString()
  }, { onConflict: 'id' });
  if (profileError) console.error('[Signup] Profile upsert error:', profileError.message);
  else console.log('[Signup] Profile upserted with subscription_status=free for user:', user.id);

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
app.post('/api/send-invite', requireSubscription, async (req, res) => {
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
        <a href="https://orivenai.com/app" style="display:inline-block;background:#B7FF2A;color:#000;font-size:14px;font-weight:600;text-decoration:none;padding:13px 32px;border-radius:8px;letter-spacing:.01em;">
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
      text:    `Hi ${recipientName},\n\nYou've been invited to join "${senderWorkspace}" on ORIVEN as a ${roleLabel}.\n\nVisit https://orivenai.com/app to accept.\n\n— The ORIVEN Team`
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
app.post('/api/generate-logo', requireSubIfAuthed, async (req, res) => {
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

    const rawPrompt = await _aimlText('logo-copy', system, userMsg);
    const imagePrompt = rawPrompt.trim().replace(/^["']|["']$/g, '').slice(0, 450);

    console.log(`[LogoGen] Image prompt: ${imagePrompt}`);
    const imageUrl = await _aimlImage('logo', imagePrompt, { aspect_ratio: '1:1' });
    console.log(`[LogoGen] ✅ Logo generated for: ${brandName}`);
    res.json({ imageUrl, prompt: imagePrompt });
  } catch (err) {
    console.error('[LogoGen] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate logo: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// UGC — AI VIDEO GENERATION (AIML / Kling)
// ════════════════════════════════════════════════════════════════

// Static creator presets — displayed in the UGC avatar picker.
// Avatar-based video is no longer used; these represent creator styles
// that inform the video prompt sent to Kling.
const UGC_PRESET_AVATARS = [
  { avatar_id: 'creator_founder',   avatar_name: 'Startup Founder',    gender: 'neutral' },
  { avatar_id: 'creator_lifestyle', avatar_name: 'Lifestyle Creator',   gender: 'neutral' },
  { avatar_id: 'creator_tech',      avatar_name: 'Tech Reviewer',       gender: 'neutral' },
  { avatar_id: 'creator_fitness',   avatar_name: 'Fitness Creator',     gender: 'neutral' },
];

const UGC_PRESET_VOICES = [
  { voice_id: 'v_warm',       name: 'Warm',       language: 'English', gender: 'female' },
  { voice_id: 'v_dynamic',    name: 'Dynamic',    language: 'English', gender: 'male'   },
  { voice_id: 'v_confident',  name: 'Confident',  language: 'English', gender: 'male'   },
  { voice_id: 'v_energetic',  name: 'Energetic',  language: 'English', gender: 'female' },
];

// ── GET /api/ugc-avatars ─────────────────────────────────────────
app.get('/api/ugc-avatars', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ avatars: UGC_PRESET_AVATARS });
});

// ── GET /api/ugc-voices ──────────────────────────────────────────
app.get('/api/ugc-voices', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ voices: UGC_PRESET_VOICES });
});

console.log("UGC ROUTE REGISTERED");

// ── POST /api/generate-ugc ──────────────────────────────────────
// AIML writes the script, Kling (via AIML) generates the video.
// Frontend calls one endpoint, gets back a videoId to poll.
app.post('/api/generate-ugc', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log("UGC ROUTE HIT");
  console.log("UGC BODY", JSON.stringify(req.body));

  const { adFeeling, adGoal, adContext, avatarId, voiceId, avatarStyle,
          brandName, brandDesc,
          brandTone, brandToneOfVoice, brandPersonality,
          brandAudience, brandPositioning, brandPromise, brandDiff,
          brandVisualDir, brandWords,
          background, customScript, format } = req.body || {};

  const formatAspect = { vertical: '9:16', square: '1:1', landscape: '16:9' };
  const aspectRatio  = formatAspect[format] || '9:16';
  console.log('[UGC] Received → adFeeling:', adFeeling, '| adGoal:', adGoal, '| format:', format, '| aspect:', aspectRatio, '| scriptMode:', customScript ? 'custom' : 'ai');

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

  // ── Step 1: Script — use provided or generate with AI ────────
  let script;
  if (customScript && customScript.trim()) {
    script = customScript.trim();
    console.log('[UGC] Using custom script (', script.length, 'chars )');
  } else {
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

      // Build brand context block — prefer new BrandCore fields, fall back to legacy fields
      const effectiveTone = brandToneOfVoice || brandTone || '';
      const effectivePos  = brandPositioning || brandPromise || brandDiff || '';

      const brandLines = [
        brandName        ? `Brand: ${brandName}` : '',
        brandDesc        ? `What it does: ${brandDesc}` : '',
        effectiveTone    ? `Tone of Voice: ${effectiveTone}` : '',
        brandPersonality ? `Brand Personality: ${brandPersonality}` : '',
        brandAudience    ? `Target Audience: ${brandAudience}` : '',
        effectivePos     ? `Positioning: ${effectivePos}` : '',
        brandVisualDir   ? `Visual Direction: ${brandVisualDir}` : '',
        brandWords       ? `Key Vocabulary: ${brandWords}` : '',
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

      script = (await _aimlText('ugc-script', system, userMsg, { max_tokens: 1024 })).trim();
      if (!script) return res.status(500).json({ error: 'AIML returned an empty script' });
      console.log('[UGC] Script generated (', script.length, 'chars ) | feeling:', adFeeling, '| goal:', adGoal || 'none');
    } catch (err) {
      console.error('[UGC] Script generation error:', err.message);
      return res.status(500).json({ error: 'Failed to write script: ' + err.message });
    }
  }

  // ── Step 2: Generate video via AIML (Kling) ──────────────────
  try {
    const aiml      = require('./providers/aimlProvider');
    const router    = require('./services/modelRouter');
    const vidRoute  = router.routeTask('ugc-video');
    const videoPrompt = `${adFeeling ? adFeeling + ' style' : 'energetic'} social media ad video. ${script.slice(0, 300)}`;
    console.log('[UGC] Submitting to AIML Kling | model:', vidRoute.model, '| aspect:', aspectRatio);
    const { generationId } = await aiml.generateVideo(videoPrompt, {
      model:        vidRoute.model,
      aspect_ratio: aspectRatio,
      duration:     5,
    });
    console.log('[UGC] Video submitted to AIML:', generationId, '| user:', user.id);
    return res.json({ ok: true, videoId: generationId, status: 'processing' });
  } catch (err) {
    console.error('[UGC] AIML video submission error:', err.message);
    return res.status(500).json({ error: 'Failed to submit video: ' + err.message });
  }
});

// ── POST /api/generate-ugc-script ───────────────────────────────
// Standalone script-only endpoint (used by test page / direct integrations).
// Aligned with the simplified UGC flow — no product/niche/audience required.
app.post('/api/generate-ugc-script', requireSubIfAuthed, async (req, res) => {
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
    const script = (await _aimlText('ugc-script', system, userMsg, { max_tokens: 1024 })).trim();
    if (!script) return res.status(500).json({ error: 'Empty script generated' });

    console.log('[UGC] Script generated | user:', user.id);
    return res.json({ ok: true, script });
  } catch (err) {
    console.error('[UGC] Script generation error:', err.message);
    return res.status(500).json({ error: 'Failed to generate script: ' + err.message });
  }
});

// ── POST /api/generate-ugc-video ─────────────────────────────────
// Generates a video from a script via AIML (Kling text-to-video).
// avatarId and voiceId are accepted for API compatibility but unused.
app.post('/api/generate-ugc-video', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { script } = req.body || {};
  if (!script || !script.trim()) return res.status(400).json({ error: 'Script is required' });

  try {
    const aiml     = require('./providers/aimlProvider');
    const router   = require('./services/modelRouter');
    const vidRoute = router.routeTask('ugc-video');
    const videoPrompt = `Energetic social media ad video. ${script.trim().slice(0, 300)}`;
    console.log('[UGC/video] Submitting to AIML Kling | model:', vidRoute.model);
    const { generationId } = await aiml.generateVideo(videoPrompt, {
      model:        vidRoute.model,
      aspect_ratio: '9:16',
      duration:     5,
    });
    console.log('[UGC/video] Submitted:', generationId, '| user:', user.id);
    return res.json({ ok: true, videoId: generationId, status: 'processing' });
  } catch (err) {
    console.error('[UGC/video] Error:', err.message);
    return res.status(500).json({ error: 'Failed to start video generation: ' + err.message });
  }
});

// ── GET /api/ugc-video-status/:videoId ──────────────────────────
app.get('/api/ugc-video-status/:videoId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { videoId } = req.params;
  try {
    const aiml = require('./providers/aimlProvider');
    const { status, videoUrl, failureReason } = await aiml.getVideoStatus(videoId);
    return res.json({
      status,
      videoUrl,
      thumbnailUrl: null,
      error:        failureReason || null,
    });
  } catch (err) {
    console.error('[UGC] Status error:', err.message);
    return res.status(500).json({ error: 'Failed to check video status' });
  }
});


// ── POST /api/video-ads/generate ──────────────────────────────────
// Three modes: 'ai' (Anthropic builds prompt) | 'script' (user prompt) | 'image' (image-to-video)
// Provider: AIML API via aimlProvider (AIML_API_KEY).
// API key is read from env only — never hardcoded or sent to frontend.
app.post('/api/video-ads/generate', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { mode, brand, product, audience, goal, style, script, imageUrl, imageUrl2, prompt, length, brandCore, customPrompt } = req.body || {};

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Video Ads is not configured — set AIML_API_KEY in environment variables.' });
  }

  const _rawDuration = Number(String(length || '5').replace(/[^0-9]/g, '')) || 5;
  const normDuration = _rawDuration <= 7 ? 5 : 10;
  const t1 = Math.round(normDuration * 0.33);
  const t2  = Math.round(normDuration * 0.72);

  // ── Image-to-video mode ───────────────────────────────────────
  if (mode === 'image') {
    if (!imageUrl || !imageUrl.trim()) return res.status(400).json({ error: 'An image URL is required for image-to-video.' });
    const vidPrompt = (prompt && prompt.trim()) || `Slow cinematic push-in on product. Soft studio lighting. Product holds centre-frame throughout.`;
    console.log('[VideoAds/image] image:', imageUrl.slice(0, 80), '| image2:', imageUrl2 ? imageUrl2.slice(0, 40) : 'none');
    try {
      const result = await aiml.generateVideoFromImage(imageUrl.trim(), vidPrompt, {
        image_end_url: imageUrl2 ? imageUrl2.trim() : undefined,
        duration:      normDuration,
        aspect_ratio:  '16:9',
      });
      console.log('[VideoAds/image] Generation started:', result.generationId, '— user:', user.id);
      return res.json({ generationId: result.generationId, status: 'queued' });
    } catch (err) {
      console.error('[VideoAds/image] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Script mode — user provides the creative brief directly ──
  if (mode === 'script') {
    if (!script || !script.trim()) return res.status(400).json({ error: 'A script or creative brief is required.' });
    console.log('[VideoAds/script] prompt:', script.trim().slice(0, 120));
    try {
      const result = await aiml.generateVideo(script.trim(), { duration: normDuration, aspect_ratio: '16:9' });
      console.log('[VideoAds/script] Generation started:', result.generationId, '— user:', user.id);
      return res.json({ generationId: result.generationId, status: 'queued' });
    } catch (err) {
      console.error('[VideoAds/script] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── AI mode (default) — Anthropic builds a scene-based Kling prompt ──
  if (!product || !product.trim()) return res.status(400).json({ error: 'Product or promotion description is required.' });

  let vidPrompt;
  if (customPrompt && customPrompt.trim()) {
    vidPrompt = customPrompt.trim();
    console.log('[VideoAds/ai] 1. Custom prompt from preview:', vidPrompt.slice(0, 120));
  } else {
    try {
      const systemPrompt = `You are a video director writing prompts for Kling AI video generation.

Write a concrete scene-by-scene visual description — 50 to 80 words total.

Use this exact format:
Scene 1 [0s–${t1}s]: <camera movement> + <subject> + <action>
Scene 2 [${t1}s–${t2}s]: <camera movement> + <subject> + <action>
Scene 3 [${t2}s–${normDuration}s]: <product or brand name clearly visible> + <closing shot>

Rules:
- Camera: "slow push in", "static overhead", "tracking left", "quick cut to close-up"
- Lighting: "soft backlight", "warm golden rim", "cool studio fill", "neon edge light"
- Name the real product, surface, material, and any people
- End on the product or brand name clearly readable on screen
- No "represents", "powerful", "evokes", "dynamic" — only what the camera sees
- Output ONLY the prompt. No preamble, no quotes.`;

      const userContext = [
        `Promoting: ${product.trim()}`,
        brand    ? `Brand: ${brand}`       : '',
        style    ? `Visual style: ${style}` : '',
        goal     ? `Goal: ${goal}`          : '',
        audience ? `Audience: ${audience}`  : '',
        `Duration: ${normDuration} seconds`,
      ].filter(Boolean).join('\n');

      console.log('[VideoAds/ai] 1. User brief:', JSON.stringify({ product: product.trim(), brand, style, goal, duration: normDuration }));
      vidPrompt = (await _aimlText('video-ads-copy', systemPrompt, userContext)).trim();
      console.log('[VideoAds/ai] 2. Generated prompt:', vidPrompt);
    } catch (err) {
      console.warn('[VideoAds/ai] Anthropic build failed, using fallback:', err.message);
      vidPrompt = `Scene 1 [0s–${t1}s]: Static close-up shot of ${product.trim()} on a clean surface, soft studio lighting. Scene 2 [${t1}s–${t2}s]: Slow push-in revealing product detail, warm rim light. Scene 3 [${t2}s–${normDuration}s]: Product centred, ${brand || 'brand'} name fades in below.`;
    }
  }

  console.log(`[VideoAds/ai] 3. Final Kling prompt: ${vidPrompt}`);
  try {
    const result = await aiml.generateVideo(vidPrompt, { duration: normDuration, aspect_ratio: '16:9' });
    console.log('[VideoAds/ai] Generation started:', result.generationId, '— user:', user.id);
    return res.json({ generationId: result.generationId, status: 'queued' });
  } catch (err) {
    console.error('[VideoAds/ai] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/video-ads/status/:generationId ────────────────────────
// Polls AIML API for video generation status.
app.get('/api/video-ads/status/:generationId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Video Ads is not configured — set AIML_API_KEY in environment variables.' });
  }

  try {
    const result = await aiml.getVideoStatus(req.params.generationId);
    return res.json({
      status:        result.status,
      videoUrl:      result.videoUrl,
      failureReason: result.failureReason,
    });
  } catch (err) {
    console.error('[VideoAds] Status error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to check video status.' });
  }
});

// ── POST /api/motion-graphics/generate ────────────────────────────
// Generates branded motion graphic videos via AIML API (kling-video).
// Anthropic writes a cinematic video prompt with Brand Core injection.
// Returns { generationId, status: 'queued' } — client polls /status/:id.
app.post('/api/motion-graphics/generate', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { style, duration, notes, brandCore, logoUrl, customPrompt } = req.body || {};

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Motion Graphics is not available — set AIML_API_KEY in environment variables.' });
  }

  // Style → animation-specific visual instructions for Kling
  const styleMap = {
    logo:       { label: 'Logo Reveal',        motion: 'The brand logo animates onto screen — it must visibly appear, scale up or slide in, and hold centre-frame.' },
    kinetic:    { label: 'Kinetic Typography', motion: 'Text elements fly, snap, and animate across the frame — words must appear, move, and land with precision.' },
    social:     { label: 'Social Motion Post', motion: 'Bold graphic elements animate in from off-screen, stop sharply, and hold for impact.' },
    intro:      { label: 'Brand Intro',        motion: 'A dramatic reveal sequence: elements build from black, converge, and settle into a final branded frame.' },
    transition: { label: 'Transition Video',   motion: 'Shapes sweep across frame left-to-right, wiping from one colour field to another.' },
    custom:     { label: 'Motion Graphic',     motion: 'Branded graphic elements animate with intentional movement and visual rhythm.' },
  };
  const styleInfo    = styleMap[style] || styleMap.custom;
  const normDuration = parseInt(duration || '5', 10) <= 7 ? 5 : 10;

  // Extract only the visual elements from Brand Core (colours + name — no brand strategy in video prompts)
  const bc    = brandCore || {};
  const bcName = bc.name || '';
  const bcClrs = (() => {
    const clrs = bc.colors || [];
    const c1   = clrs[0] ? (clrs[0].hex || clrs[0]) : (bc.primaryColor   || '');
    const c2   = clrs[1] ? (clrs[1].hex || clrs[1]) : (bc.secondaryColor || '');
    return [c1, c2].filter(Boolean).join(' and ');
  })();
  const t1 = Math.round(normDuration * 0.4);
  const t2  = Math.round(normDuration * 0.8);

  // Anthropic builds a short scene-based prompt for Kling (skipped if user provided customPrompt)
  let videoPrompt;
  if (customPrompt && customPrompt.trim()) {
    videoPrompt = customPrompt.trim();
    console.log('[MotionGraphics] 1. Custom prompt from preview:', videoPrompt.slice(0, 120));
  } else {
    try {
      const systemPrompt = `You are a motion graphics director writing prompts for Kling AI video generation.

Write a short, concrete scene-by-scene description — 40 to 60 words total.

Use this exact format:
[0s–${t1}s]: <what literally appears and how it moves>
[${t1}s–${t2}s]: <what happens next — specific motion>
[${t2}s–${normDuration}s]: <final frame — what is visible>

Strict rules:
- Describe EXACTLY what the viewer sees — no metaphors, no moods
- ${styleInfo.motion}
- Specify direction: "slides in from left", "fades up", "scales from 0 to full", "rotates in"
- Name colours when relevant
- No "powerful", "dynamic", "evokes", "cinematic" — only visual facts
- Output ONLY the prompt. No preamble, no quotes.`;

      const userContext = [
        `Animation type: ${styleInfo.label}`,
        bcName ? `Brand name: ${bcName}` : '',
        bcClrs ? `Brand colours: ${bcClrs}` : '',
        notes  ? `Direction: ${notes}` : '',
      ].filter(Boolean).join('\n');

      console.log('[MotionGraphics] 1. User brief:', JSON.stringify({ style, duration: normDuration, notes: notes || '', brand: bcName }));
      videoPrompt = (await _aimlText('motion-graphics-copy', systemPrompt, userContext)).trim();
      console.log('[MotionGraphics] 2. Generated prompt:', videoPrompt);
    } catch (err) {
      console.warn('[MotionGraphics] Anthropic failed, using fallback:', err.message);
      videoPrompt = `[0s–${t1}s]: ${bcName || 'Brand'} logo fades in from black, centred on screen. [${t1}s–${t2}s]: Logo scales up smoothly${bcClrs ? ', ' + bcClrs + ' glow' : ''}. [${t2}s–${normDuration}s]: Logo holds full-frame on solid background.`;
    }
  }

  console.log(`[MotionGraphics] 3. Final Kling prompt: ${videoPrompt}`);
  console.log(`[MotionGraphics]    Model: kling-video | Duration: ${normDuration}s | logoUrl: ${logoUrl ? 'yes' : 'no'} | User: ${user.id}`);
  try {
    // If logo URL provided, use image-to-video so the brand logo is preserved
    const genOpts = { duration: normDuration, aspect_ratio: '16:9' };
    const result = logoUrl
      ? await aiml.generateVideoFromImage(logoUrl, videoPrompt, genOpts)
      : await aiml.generateVideo(videoPrompt, genOpts);
    console.log('[MotionGraphics] Generation queued:', result.generationId);
    return res.json({ generationId: result.generationId, status: 'queued' });
  } catch (err) {
    console.error('[MotionGraphics] Generation error:', err.message);
    return res.status(500).json({ error: err.message || 'Motion graphic generation failed.' });
  }
});

// ── GET /api/motion-graphics/status/:generationId ─────────────────
// Polls AIML API for motion graphic video generation status.
app.get('/api/motion-graphics/status/:generationId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Motion Graphics is not configured — set AIML_API_KEY in environment variables.' });
  }

  try {
    const result = await aiml.getVideoStatus(req.params.generationId);
    return res.json({
      status:        result.status,
      videoUrl:      result.videoUrl,
      failureReason: result.failureReason,
    });
  } catch (err) {
    console.error('[MotionGraphics] Status error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to check motion graphic status.' });
  }
});

// ── POST /api/product-shoots/generate ─────────────────────────────
// Professional product photography via gpt-image-1 (same stack as Visuals/Logos).
// Anthropic builds the photography prompt from product + style + goal.
app.post('/api/product-shoots/generate', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { product, style, goal, notes, customPrompt } = req.body || {};
  if (!product || !product.trim()) return res.status(400).json({ error: 'Product description is required.' });

  // Derive aspect ratio from goal (ecommerce/social → square; advertising/website → wide)
  const ratioFromGoal = { ecommerce: '1:1', social: '1:1', advertising: '16:9', website: '16:9' };
  const aimlRatio = ratioFromGoal[goal] || '1:1';

  const styleLabels = {
    studio:       'clean professional studio photography, pure background, controlled key lighting',
    lifestyle:    'lifestyle photography in a natural aspirational setting, soft ambient light',
    minimal:      'minimal white photography, bright even lighting, airy and ecommerce-ready',
    dark_premium: 'dark premium photography, dramatic directional light, deep moody shadows',
  };
  const goalLabels = {
    ecommerce:   'product listing — sharp focus, clean composition, product fills the frame',
    social:      'social media — creative composition, lifestyle feel, thumb-stopping',
    advertising: 'advertising — brand-aligned, persuasive, high production value',
    website:     'website hero — editorial, full-bleed composition, premium presentation',
  };

  const styleDesc = styleLabels[style] || styleLabels.studio;
  const goalDesc  = goalLabels[goal]   || goalLabels.ecommerce;

  let dallEPrompt;
  if (customPrompt && customPrompt.trim()) {
    dallEPrompt = customPrompt.trim();
    console.log('[ProductShoots] 1. Custom prompt from preview:', dallEPrompt.slice(0, 120));
  } else {
    try {
      const system = `You are a professional product photographer and creative director.
Write a single image generation prompt for gpt-image-1 to create commercial product photography.
The image must look like a real photograph — not a render, illustration, or CGI.
Include: lighting setup, camera angle, depth of field, surface, and background.
Keep the product as the clear hero of the frame.
Output ONLY the prompt. 2–3 sentences. No quotes, no preamble.`;

      const brief = [
        `Product: ${product.trim()}`,
        `Style: ${styleDesc}`,
        `Goal: ${goalDesc}`,
        notes ? `Creative direction: ${notes.trim()}` : '',
      ].filter(Boolean).join('\n');

      console.log('[ProductShoots] 1. User brief:', JSON.stringify({ product: product.trim(), style, goal }));
      dallEPrompt = (await _aimlText('product-shoots-copy', system, brief)).trim();
      console.log('[ProductShoots] 2. Generated prompt:', dallEPrompt.slice(0, 200));
    } catch (err) {
      console.warn('[ProductShoots] Prompt build failed, using fallback:', err.message);
      dallEPrompt = `Professional commercial product photograph of ${product.trim()}. ${styleDesc}. ${goalDesc}. Sharp focus, high resolution, marketing-ready.`;
    }
  }

  const _psRoute = require('./services/modelRouter').routeTask('product-shoots');
  console.log('[ProductShoots] Provider:', _psRoute.provider.toUpperCase());
  console.log('[ProductShoots] Model:', _psRoute.model);
  console.log('[ProductShoots] Endpoint:', _psRoute.endpoint || '/v1/images/generations');
  console.log(`[ProductShoots] 3. Final prompt (ratio ${aimlRatio}): ${dallEPrompt.slice(0, 180)}`);
  try {
    const url = await _aimlImage('product-shoots', dallEPrompt, { aspect_ratio: aimlRatio });
    console.log('[ProductShoots] Image generated successfully');
    return res.json({ images: [url], ratio: aimlRatio, prompt: dallEPrompt });
  } catch (err) {
    console.error('[ProductShoots] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Image generation failed.' });
  }
});

// ── POST /api/daily-brief ─────────────────────────────────────────
app.post('/api/daily-brief', requireSubIfAuthed, async (req, res) => {
  const { brandCore, marketContext, competitorContext, opportunityContext } = req.body;

  const ctxLines = [];
  if (brandCore) {
    if (brandCore.name)        ctxLines.push(`Brand: ${brandCore.name}`);
    if (brandCore.ind)         ctxLines.push(`Industry: ${brandCore.ind}`);
    if (brandCore.positioning || brandCore.promise) ctxLines.push(`Positioning: ${brandCore.positioning || brandCore.promise}`);
    if (brandCore.audience)    ctxLines.push(`Audience: ${brandCore.audience}`);
    if (brandCore.tagline)     ctxLines.push(`Tagline: ${brandCore.tagline}`);
  }
  if (marketContext)     ctxLines.push(`Market context: ${marketContext}`);
  if (competitorContext) ctxLines.push(`Competitor insight: ${competitorContext}`);
  if (opportunityContext) ctxLines.push(`Top opportunity: ${opportunityContext}`);

  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const system = `You are the Brand Brain daily intelligence system for a brand strategist.

Today is ${today}. Generate a concise morning brief for this brand — a strategic starting point for the day.

Return ONLY valid JSON with zero markdown:

{
  "date": "${today}",
  "headline": "One punchy sentence that captures the brand's most important focus today (max 12 words)",
  "items": [
    { "type": "insight | action | alert", "title": "Short title (4-6 words)", "body": "1-2 sentences. Specific and actionable." },
    { "type": "insight | action | alert", "title": "...", "body": "..." },
    { "type": "insight | action | alert", "title": "...", "body": "..." },
    { "type": "action", "title": "...", "body": "..." }
  ],
  "focus": "One strategic sentence: the single most important thing for this brand to focus on today"
}

Rules:
- Include exactly 4 items. Mix types: at least 1 insight, 1 action, 1 alert
- Be specific to this brand — no generic advice
- If limited context: focus on brand-building fundamentals appropriate to their stage
- The focus line should feel like a clear directive, not a question`;

  const userMsg = ctxLines.length
    ? `Brand context:\n${ctxLines.join('\n')}`
    : 'No brand context provided — generate a brief for an early-stage brand getting started.';

  try {
    const raw = await _aimlText('daily-brief', system, userMsg, { max_tokens: 800 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let brief;
    try {
      brief = JSON.parse(cleaned);
    } catch {
      console.error('[DailyBrief] JSON parse failed:', cleaned.slice(0, 200));
      return res.status(500).json({ error: 'Failed to parse daily brief' });
    }
    console.log('[DailyBrief] Generated for:', brandCore && brandCore.name);
    res.json(brief);
  } catch (err) {
    console.error('[DailyBrief] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate daily brief' });
  }
});

// ── POST /api/website-monitor ─────────────────────────────────────
app.post('/api/website-monitor', requireSubIfAuthed, async (req, res) => {
  const { url, brandCore } = req.body;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'A website URL is required' });
  }

  const bcLines = [];
  if (brandCore) {
    if (brandCore.name)        bcLines.push(`Brand Name: ${brandCore.name}`);
    if (brandCore.tagline)     bcLines.push(`Tagline: ${brandCore.tagline}`);
    if (brandCore.positioning || brandCore.promise) bcLines.push(`Positioning: ${brandCore.positioning || brandCore.promise}`);
    if (brandCore.audience)    bcLines.push(`Target Audience: ${brandCore.audience}`);
    if (brandCore.toneOfVoice) bcLines.push(`Tone of Voice: ${brandCore.toneOfVoice}`);
    if (brandCore.personality) bcLines.push(`Personality: ${Array.isArray(brandCore.personality) ? brandCore.personality.join(', ') : brandCore.personality}`);
    if (brandCore.ind)         bcLines.push(`Industry: ${brandCore.ind}`);
  }

  const system = `You are a senior brand consistency analyst.

Analyze the website at the given URL using your knowledge of that brand's public web presence and messaging. Compare it against the provided Brand Core to assess brand consistency.

Return ONLY valid JSON with zero markdown:

{
  "url": "cleaned URL",
  "score": 0-100,
  "grade": "A | B | C | D | F",
  "summary": "2-3 sentence overall assessment",
  "strengths": [
    "Specific strength (1 sentence each)",
    "...",
    "..."
  ],
  "issues": [
    { "area": "Area name (e.g. Messaging, Visual, Tone)", "severity": "high | medium | low", "desc": "What the issue is and why it matters (1-2 sentences)" },
    { "area": "...", "severity": "...", "desc": "..." }
  ],
  "recommendations": [
    "Specific, actionable recommendation (1 sentence)",
    "...",
    "..."
  ]
}

Rules:
- Score reflects how consistently the website reflects the Brand Core values and positioning
- If no Brand Core: assess against general brand best practices and the brand's own implied identity
- Identify 2-4 strengths and 2-5 issues
- Issues should be ordered by severity (high first)
- Recommendations should be concrete and prioritized`;

  const userMsg = `Website URL: ${url.trim()}\n\n${bcLines.length ? `Brand Core:\n${bcLines.join('\n')}` : 'No brand core — assess against best practices.'}`;

  try {
    const raw = await _aimlText('website-monitor', system, userMsg, { max_tokens: 1200 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[WebsiteMonitor] JSON parse failed:', cleaned.slice(0, 200));
      return res.status(500).json({ error: 'Failed to parse website report' });
    }
    console.log('[WebsiteMonitor] Analysis complete for:', url);
    res.json(report);
  } catch (err) {
    console.error('[WebsiteMonitor] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to monitor website' });
  }
});

// ── POST /api/market-research ─────────────────────────────────────
app.post('/api/market-research', requireSubIfAuthed, async (req, res) => {
  const { brandCore } = req.body;

  const bcLines = [];
  if (brandCore) {
    if (brandCore.name)        bcLines.push(`Brand Name: ${brandCore.name}`);
    if (brandCore.ind)         bcLines.push(`Industry: ${brandCore.ind}`);
    if (brandCore.desc)        bcLines.push(`Description: ${brandCore.desc}`);
    if (brandCore.positioning) bcLines.push(`Positioning: ${brandCore.positioning}`);
    if (brandCore.promise)     bcLines.push(`Promise: ${brandCore.promise}`);
    if (brandCore.audience)    bcLines.push(`Target Audience: ${brandCore.audience}`);
    if (brandCore.tagline)     bcLines.push(`Tagline: ${brandCore.tagline}`);
  }

  const system = `You are a world-class market research analyst and brand strategist.

Analyze the market the provided brand operates in. Produce a structured intelligence report covering market dynamics, key trends, audience segments, and competitive landscape.

Return ONLY valid JSON with zero markdown, matching this exact structure:

{
  "market": {
    "name": "Market / industry name (3–5 words)",
    "size": "Market scale description (e.g. '$12B global market')",
    "growth": "Growth trajectory (e.g. 'Growing 18% YoY')",
    "maturity": "emerging | growing | mature | declining"
  },
  "trends": [
    { "title": "Short trend name (3–5 words)", "desc": "2–3 sentence explanation of the trend and its relevance", "impact": "high | medium | low" },
    { "title": "...", "desc": "...", "impact": "..." },
    { "title": "...", "desc": "...", "impact": "..." },
    { "title": "...", "desc": "...", "impact": "..." }
  ],
  "segments": [
    { "name": "Segment name", "desc": "2-sentence description of this audience segment", "fit": "Strong fit | Medium fit | Weak fit" },
    { "name": "...", "desc": "...", "fit": "..." },
    { "name": "...", "desc": "...", "fit": "..." }
  ],
  "competitive": {
    "intensity": "high | medium | low",
    "dynamics": "3–4 sentence summary of the competitive landscape",
    "whitespace": "Key underserved gap or opportunity area (1 sentence)"
  },
  "summary": "3–4 sentence strategic summary of the market and the brand's position within it"
}

Rules:
- Be specific to the actual industry — no generic boilerplate
- All trend, segment, and competitive data should be actionable
- Tailor segments and whitespace to the brand's specific positioning`;

  const userMsg = bcLines.length
    ? `Brand Core:\n${bcLines.join('\n')}`
    : 'No brand core provided — analyze a general D2C brand in a competitive consumer market.';

  try {
    const raw = await _aimlText('market-research', system, userMsg, { max_tokens: 1800 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[MarketResearch] JSON parse failed:', cleaned.slice(0, 200));
      return res.status(500).json({ error: 'Failed to parse market research' });
    }
    console.log('[MarketResearch] Complete for:', brandCore && brandCore.name);
    res.json(report);
  } catch (err) {
    console.error('[MarketResearch] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate market research' });
  }
});

// ── POST /api/opportunities ────────────────────────────────────────
app.post('/api/opportunities', requireSubIfAuthed, async (req, res) => {
  const { brandCore, marketResearch, competitorReport } = req.body;

  const ctxLines = [];
  if (brandCore) {
    if (brandCore.name)        ctxLines.push(`Brand: ${brandCore.name}`);
    if (brandCore.ind)         ctxLines.push(`Industry: ${brandCore.ind}`);
    if (brandCore.positioning) ctxLines.push(`Positioning: ${brandCore.positioning}`);
    if (brandCore.promise)     ctxLines.push(`Promise: ${brandCore.promise}`);
    if (brandCore.audience)    ctxLines.push(`Audience: ${brandCore.audience}`);
    if (brandCore.tagline)     ctxLines.push(`Tagline: ${brandCore.tagline}`);
    if (brandCore.personality) ctxLines.push(`Personality: ${Array.isArray(brandCore.personality) ? brandCore.personality.join(', ') : brandCore.personality}`);
  }
  if (marketResearch && marketResearch.competitive && marketResearch.competitive.whitespace) {
    ctxLines.push(`Market Whitespace: ${marketResearch.competitive.whitespace}`);
  }
  if (marketResearch && marketResearch.market) {
    ctxLines.push(`Market Maturity: ${marketResearch.market.maturity}`);
  }
  if (competitorReport && competitorReport.differentiation) {
    ctxLines.push(`Competitor Advantage: ${competitorReport.differentiation.theyOwn}`);
    ctxLines.push(`Brand Advantage vs Competitor: ${competitorReport.differentiation.youOwn}`);
    if (competitorReport.differentiation.opportunity) {
      ctxLines.push(`Competitor Gap: ${competitorReport.differentiation.opportunity}`);
    }
  }

  const system = `You are a world-class brand strategist and growth advisor.

Identify 5 high-leverage strategic opportunities for the provided brand. Base your analysis on their positioning, market context, competitive landscape, and audience fit.

Return ONLY valid JSON with zero markdown, matching this exact structure:

{
  "opportunities": [
    {
      "title": "Short opportunity title (4–7 words)",
      "category": "content | product | market | partnership | positioning | community",
      "desc": "2–3 sentences describing the opportunity and why it exists now",
      "why": "1 sentence: why this specific brand is positioned to capture it",
      "effort": "low | medium | high",
      "impact": "low | medium | high",
      "action": "Specific, actionable first step (1 sentence starting with a verb)"
    }
  ],
  "summary": "2–3 sentence strategic overview of the opportunity landscape for this brand"
}

Rules:
- All 5 opportunities must be distinct categories
- Be specific to this brand — no generic 'improve your social media' suggestions
- Rank opportunities from highest impact to lowest in the array
- Every 'action' must be a concrete, executable next step`;

  const userMsg = ctxLines.length
    ? `Context:\n${ctxLines.join('\n')}`
    : 'No context provided — identify opportunities for an early-stage consumer brand in a competitive market.';

  try {
    const raw = await _aimlText('opportunities', system, userMsg, { max_tokens: 1600 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[Opportunities] JSON parse failed:', cleaned.slice(0, 200));
      return res.status(500).json({ error: 'Failed to parse opportunities' });
    }
    console.log('[Opportunities] Complete for:', brandCore && brandCore.name);
    res.json(report);
  } catch (err) {
    console.error('[Opportunities] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate opportunities' });
  }
});

// ── Public routes — all served by index.html (router handles view) ──
app.get('/signup',     function(req, res) { res.sendFile(path.resolve(__dirname, '..', '..', 'index.html')); });
app.get('/login',      function(req, res) { res.sendFile(path.resolve(__dirname, '..', '..', 'index.html')); });
app.get('/plan',       function(req, res) { res.redirect(302, '/app'); });
app.get('/onboarding', function(req, res) { res.redirect(302, '/app?tour=1'); });

// ── /app → ORIVEN application ─────────────────────────────────────
app.get('/app', function(req, res) {
  res.sendFile(path.resolve(__dirname, '..', '..', 'app.html'));
});

// ════════════════════════════════════════════════════════════════
// GOOGLE ADS OAUTH
// ════════════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI
  || (process.env.RENDER
      ? 'https://oriven-backand-clean.onrender.com/auth/google/callback'
      : 'http://localhost:5500/auth/google/callback');

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/adwords'
].join(' ');

const GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';

// Fetch all accessible Google Ads accounts for a given access token.
// Returns { accounts: [{customer_id, name, currency, timezone}], error }
async function _fetchGoogleAdsAccounts(accessToken) {
  if (!GOOGLE_ADS_DEVELOPER_TOKEN) {
    console.warn('[Google Ads] GOOGLE_ADS_DEVELOPER_TOKEN not set — skipping account fetch');
    return { accounts: [], error: 'GOOGLE_ADS_DEVELOPER_TOKEN not configured' };
  }

  const GADS_TIMEOUT_MS = 10000; // 10 s — well inside Render's 30 s limit
  const headers = {
    'Authorization':   'Bearer ' + accessToken,
    'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN
  };

  function _fetchWithTimeout(url, opts) {
    const ctrl = new AbortController();
    const tid   = setTimeout(function() { ctrl.abort(); }, GADS_TIMEOUT_MS);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
      .finally(function() { clearTimeout(tid); });
  }

  // Step 1 — list all customer resource names the token can access
  let resourceNames;
  try {
    const listUrl = 'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers';
    console.log('[Google Ads] GET', listUrl);
    const listRes  = await _fetchWithTimeout(listUrl, { headers });

    const listCT   = listRes.headers.get('content-type') || '';
    const listText = await listRes.text();
    console.log('[Google Ads] listAccessibleCustomers status:', listRes.status);
    console.log('[Google Ads] listAccessibleCustomers content-type:', listCT);
    console.log('[Google Ads] listAccessibleCustomers body:', listText.slice(0, 500));

    if (!listRes.ok) {
      let msg = 'Google Ads API error ' + listRes.status;
      if (listCT.includes('application/json')) {
        try { const j = JSON.parse(listText); msg = (j.error && j.error.message) ? j.error.message : msg; } catch (_) {}
      }
      return { accounts: [], error: msg };
    }

    if (!listCT.includes('application/json')) {
      return { accounts: [], error: 'Unexpected content-type from Google Ads API: ' + listCT + ' | body: ' + listText.slice(0, 200) };
    }

    let listData;
    try { listData = JSON.parse(listText); } catch (parseErr) {
      return { accounts: [], error: 'JSON parse failed: ' + parseErr.message + ' | body: ' + listText.slice(0, 200) };
    }
    resourceNames = listData.resourceNames || [];
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Google Ads API timed out (>10 s)' : 'Network error: ' + err.message;
    console.error('[Google Ads] listAccessibleCustomers threw:', err.name, msg);
    return { accounts: [], error: msg };
  }

  const customerIds = resourceNames.map(function(r) { return r.replace('customers/', ''); });
  console.log('[Google Ads] accessible customer IDs:', customerIds);
  if (customerIds.length === 0) return { accounts: [], error: null };

  // Step 2 — fetch name, currency, manager flag, status for each direct customer (up to 20)
  const accounts = [];
  for (const customerId of customerIds.slice(0, 20)) {
    let acctName   = customerId;
    let acctCur    = null;
    let acctTz     = null;
    let isManager  = false;
    let acctStatus = 'UNKNOWN';

    try {
      const searchUrl = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/googleAds:search';
      console.log('[Google Ads] POST', searchUrl);
      const searchRes = await _fetchWithTimeout(searchUrl, {
        method:  'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'login-customer-id': customerId }, headers),
        body:    JSON.stringify({
          query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1'
        })
      });
      const searchCT   = searchRes.headers.get('content-type') || '';
      const searchText = await searchRes.text();
      console.log('[Google Ads] customer', customerId, 'status:', searchRes.status, '| body:', searchText.slice(0, 300));

      if (searchRes.ok && searchCT.includes('application/json')) {
        try {
          const sd = JSON.parse(searchText);
          const c  = (sd.results && sd.results.length > 0 && sd.results[0].customer) ? sd.results[0].customer : null;
          if (c) {
            acctName   = c.descriptiveName || customerId;
            acctCur    = c.currencyCode    || null;
            acctTz     = c.timeZone        || null;
            isManager  = c.manager === true;
            acctStatus = c.status          || 'UNKNOWN';
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[Google Ads] customer query threw for', customerId, ':', err.message);
    }

    console.log('[Google Ads] account', customerId, '| name:', acctName, '| is_manager:', isManager, '| status:', acctStatus);
    accounts.push({
      customer_id: customerId,
      name:        acctName,
      currency:    acctCur,
      timezone:    acctTz,
      is_manager:  isManager,
      status:      acctStatus
    });

    // For manager accounts — fetch direct (level=1) non-manager sub-clients
    if (isManager) {
      try {
        const subUrl = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/googleAds:search';
        const subRes = await _fetchWithTimeout(subUrl, {
          method:  'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', 'login-customer-id': customerId }, headers),
          body:    JSON.stringify({
            query: `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager,
                           customer_client.status, customer_client.currency_code, customer_client.time_zone
                    FROM customer_client
                    WHERE customer_client.level = 1 AND customer_client.manager = false`
          })
        });
        const subCT   = subRes.headers.get('content-type') || '';
        const subText = await subRes.text();
        console.log('[Google Ads] sub-clients for', customerId, 'status:', subRes.status, '| body:', subText.slice(0, 400));

        if (subRes.ok && subCT.includes('application/json')) {
          const subData = JSON.parse(subText);
          (subData.results || []).forEach(function(r) {
            const cc = r.customerClient || {};
            if (!cc.id) return;
            const subId = String(cc.id);
            // Don't duplicate if already in the direct list
            if (accounts.some(function(a) { return a.customer_id === subId; })) return;
            console.log('[Google Ads] sub-client', subId, '| name:', cc.descriptiveName, '| status:', cc.status);
            accounts.push({
              customer_id:       subId,
              name:              cc.descriptiveName || subId,
              currency:          cc.currencyCode    || null,
              timezone:          cc.timeZone        || null,
              is_manager:        false,
              status:            cc.status          || 'UNKNOWN',
              parent_manager_id: customerId
            });
          });
        }
      } catch (subErr) {
        console.warn('[Google Ads] sub-client fetch failed for MCC', customerId, ':', subErr.message);
      }
    }
  }

  console.log('[Google Ads] final accounts:', JSON.stringify(accounts));
  return { accounts, error: null };
}

// State store: random hex → { userId, expires }. Expires after 10 min.
const _googleOAuthStates = new Map();
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of _googleOAuthStates.entries()) {
    if (v.expires < now) _googleOAuthStates.delete(k);
  }
}, 5 * 60 * 1000);

// GET /api/google/auth-url — authenticated, returns the Google OAuth URL
app.get('/api/google/auth-url', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google OAuth not configured on server' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  _googleOAuthStates.set(state, { userId: user.id, expires: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         GOOGLE_SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state:         state
  });
  res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
});

// GET /auth/google/callback — OAuth callback from Google
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  // Mirror the GOOGLE_REDIRECT_URI detection logic: explicit env var wins,
  // then fall back to Render (production) vs localhost (local dev).
  const frontendBase = process.env.FRONTEND_URL
    || (process.env.RENDER ? 'https://orivenai.com' : 'http://localhost:5500');

  if (error) {
    console.error('[Google OAuth] Denied or error:', error);
    return res.redirect(frontendBase + '/app.html?google_error=' + encodeURIComponent(error));
  }
  if (!code || !state) {
    return res.redirect(frontendBase + '/app.html?google_error=missing_params');
  }

  const stateData = _googleOAuthStates.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    _googleOAuthStates.delete(state);
    return res.redirect(frontendBase + '/app.html?google_error=invalid_state');
  }
  _googleOAuthStates.delete(state);
  const userId = stateData.userId;

  let tokens;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code'
      }).toString()
    });
    tokens = await tokenRes.json();
    if (tokens.error) {
      console.error('[Google OAuth] Token exchange error:', tokens.error, tokens.error_description);
      return res.redirect(frontendBase + '/app.html?google_error=token_exchange');
    }
  } catch (err) {
    console.error('[Google OAuth] Token exchange network error:', err.message);
    return res.redirect(frontendBase + '/app.html?google_error=network');
  }

  let googleEmail = null;
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    const profile = await profileRes.json();
    googleEmail = profile.email || null;
  } catch (_) {}

  const tokenExpiry = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  // Fetch Google Ads accounts immediately (non-fatal if dev token not configured yet)
  const { accounts: gadsAccounts } = await _fetchGoogleAdsAccounts(tokens.access_token).catch(function() {
    return { accounts: [] };
  });

  const { error: dbError } = await supabaseAdmin
    .from('integrations')
    .upsert({
      user_id:               userId,
      provider:              'google_ads',
      google_email:          googleEmail,
      access_token:          tokens.access_token,
      refresh_token:         tokens.refresh_token || null,
      token_expiry:          tokenExpiry,
      connected_at:          new Date().toISOString(),
      google_ads_accounts:   gadsAccounts
    }, { onConflict: 'user_id,provider' });

  if (dbError) {
    console.error('[Google OAuth] DB upsert error:', dbError.message);
    return res.redirect(frontendBase + '/app.html?google_error=db');
  }

  console.log('[Google OAuth] ✅ Connected | user:', userId, '| email:', googleEmail, '| accounts:', gadsAccounts.length);
  return res.redirect(frontendBase + '/app.html?google_connected=1');
});

// GET /api/google/status — return connection status for the authenticated user
app.get('/api/google/status', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { data, error } = await supabaseAdmin
    .from('integrations')
    .select('google_email, connected_at, token_expiry, refresh_token, google_ads_accounts, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'google_ads')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Database error' });
  if (!data)  return res.json({ connected: false });

  let status = 'connected';
  if (data.token_expiry && new Date(data.token_expiry) < new Date() && !data.refresh_token) {
    status = 'disconnected';
  }

  res.json({
    connected:           true,
    status,
    google_email:        data.google_email,
    connected_at:        data.connected_at,
    google_ads_accounts: data.google_ads_accounts || [],
    active_ad_account:   data.active_ad_account   || null
  });
});

// GET /api/google/accounts — re-fetch accessible Google Ads accounts and store them
app.get('/api/google/accounts', async (req, res) => {
  console.log('[Accounts] request received');
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    console.log('[Accounts] user:', user.id);

    const { data: integration, error: fetchErr } = await supabaseAdmin
      .from('integrations')
      .select('access_token, refresh_token, token_expiry')
      .eq('user_id', user.id)
      .eq('provider', 'google_ads')
      .maybeSingle();

    if (fetchErr) {
      console.error('[Accounts] DB fetch error:', fetchErr.message);
      return res.status(500).json({ error: 'Database error', detail: fetchErr.message });
    }
    if (!integration) return res.status(404).json({ error: 'Google Ads not connected' });
    console.log('[Accounts] integration found, token_expiry:', integration.token_expiry);

    // Refresh access token if expired
    let accessToken = integration.access_token;
    if (integration.token_expiry && new Date(integration.token_expiry) < new Date()) {
      if (!integration.refresh_token) return res.status(401).json({ error: 'Token expired — reconnect Google Ads' });
      console.log('[Accounts] token expired, refreshing…');
      try {
        const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
            client_id:     GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: integration.refresh_token,
            grant_type:    'refresh_token'
          }).toString()
        });
        const refreshed = await refreshRes.json();
        if (refreshed.error) {
          console.error('[Accounts] token refresh failed:', refreshed.error);
          return res.status(401).json({ error: 'Token refresh failed — reconnect Google Ads' });
        }
        accessToken = refreshed.access_token;
        await supabaseAdmin.from('integrations').update({
          access_token: refreshed.access_token,
          token_expiry: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString()
        }).eq('user_id', user.id).eq('provider', 'google_ads');
        console.log('[Accounts] token refreshed OK');
      } catch (err) {
        console.error('[Accounts] token refresh threw:', err.message);
        return res.status(500).json({ error: 'Token refresh network error' });
      }
    }

    console.log('[Accounts] calling _fetchGoogleAdsAccounts…');
    const { accounts, error: gadsErr } = await _fetchGoogleAdsAccounts(accessToken);
    console.log('[Accounts] result — accounts:', accounts.length, '| error:', gadsErr);

    if (gadsErr && accounts.length === 0) {
      return res.status(503).json({ error: gadsErr });
    }

    // Persist updated account list (non-fatal if column not yet migrated)
    const { error: updateErr } = await supabaseAdmin.from('integrations')
      .update({ google_ads_accounts: accounts })
      .eq('user_id', user.id)
      .eq('provider', 'google_ads');
    if (updateErr) console.warn('[Accounts] update warning (column missing?):', updateErr.message);

    res.json({ accounts });
  } catch (err) {
    console.error('[Accounts] unexpected error:', err.message, err.stack);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// POST /api/google/disconnect — revoke and delete integration
app.post('/api/google/disconnect', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  try {
    const { data } = await supabaseAdmin
      .from('integrations')
      .select('access_token')
      .eq('user_id', user.id)
      .eq('provider', 'google_ads')
      .maybeSingle();
    if (data && data.access_token) {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(data.access_token), { method: 'POST' });
    }
  } catch (_) {}

  const { error } = await supabaseAdmin
    .from('integrations')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', 'google_ads');

  if (error) return res.status(500).json({ error: 'Database error' });

  console.log('[Google OAuth] Disconnected | user:', user.id);
  res.json({ success: true });
});

// POST /api/google/active-account — set the active Google Ads account for a user
app.post('/api/google/active-account', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { account_id, account_name, is_manager, status, parent_manager_id } = req.body || {};
    if (!account_id) return res.status(400).json({ error: 'account_id is required' });

    const active_ad_account = {
      platform:          'google_ads',
      account_id:        String(account_id),
      account_name:      String(account_name || ''),
      is_manager:        !!is_manager,
      status:            status            || null,
      parent_manager_id: parent_manager_id ? String(parent_manager_id) : null
    };

    const { error } = await supabaseAdmin
      .from('integrations')
      .update({ active_ad_account })
      .eq('user_id', user.id)
      .eq('provider', 'google_ads');

    if (error) {
      console.error('[ActiveAccount] DB error:', error.message);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log('[ActiveAccount] Set | user:', user.id, '| account:', account_id, account_name);
    res.json({ ok: true, active_ad_account });
  } catch (err) {
    console.error('[ActiveAccount] unexpected error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/google — server-side redirect to Google OAuth consent screen.
// Accepts ?token= (Supabase JWT) so the frontend can build a plain link or
// window.location redirect without a separate fetch call.
// Example: window.location.href = '/auth/google?token=' + supabaseSession.access_token
app.get('/auth/google', async (req, res) => {
  const frontendBase = process.env.FRONTEND_URL
    || (process.env.RENDER ? 'https://orivenai.com' : 'http://localhost:5500');

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn('[Google OAuth] /auth/google hit but credentials not configured');
    return res.redirect(frontendBase + '/app.html?google_error=not_configured');
  }

  const token = (req.query.token || '').toString().trim();
  if (!token) {
    console.warn('[Google OAuth] /auth/google hit with no token');
    return res.redirect(frontendBase + '/app.html?google_error=missing_token');
  }

  let userId;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) {
      console.warn('[Google OAuth] /auth/google invalid token:', error && error.message);
      return res.redirect(frontendBase + '/app.html?google_error=invalid_token');
    }
    userId = data.user.id;
  } catch (err) {
    console.error('[Google OAuth] /auth/google token validation threw:', err.message);
    return res.redirect(frontendBase + '/app.html?google_error=auth_error');
  }

  const state = crypto.randomBytes(16).toString('hex');
  _googleOAuthStates.set(state, { userId, expires: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         GOOGLE_SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state
  });

  console.log('[Google OAuth] Redirecting user', userId, '→ Google consent screen');
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// GET /api/google-ads/accounts — spec-exact endpoint
// Returns: { accounts: [{ customer_id, account_name, currency_code, is_manager, status }] }
// Reuses the same token-refresh logic and _fetchGoogleAdsAccounts helper.
app.get('/api/google-ads/accounts', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { data: intg, error: fetchErr } = await supabaseAdmin
      .from('integrations')
      .select('access_token, refresh_token, token_expiry')
      .eq('user_id', user.id)
      .eq('provider', 'google_ads')
      .maybeSingle();

    if (fetchErr) {
      console.error('[google-ads/accounts] DB error:', fetchErr.message);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!intg) return res.status(404).json({ error: 'Google Ads not connected' });

    let accessToken = intg.access_token;

    if (intg.token_expiry && new Date(intg.token_expiry) < new Date()) {
      if (!intg.refresh_token) {
        return res.status(401).json({ error: 'Token expired — reconnect Google Ads' });
      }
      console.log('[google-ads/accounts] Token expired — refreshing…');
      const rfRes  = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: intg.refresh_token,
          grant_type:    'refresh_token'
        }).toString()
      });
      const rfData = await rfRes.json();
      if (!rfRes.ok || rfData.error || !rfData.access_token) {
        console.error('[google-ads/accounts] Token refresh failed:', rfData.error);
        return res.status(401).json({ error: 'Token refresh failed — reconnect Google Ads' });
      }
      accessToken = rfData.access_token;
      await supabaseAdmin.from('integrations').update({
        access_token: accessToken,
        token_expiry: new Date(Date.now() + (rfData.expires_in || 3600) * 1000).toISOString()
      }).eq('user_id', user.id).eq('provider', 'google_ads');
    }

    const { accounts, error: gadsErr } = await _fetchGoogleAdsAccounts(accessToken);
    if (gadsErr && accounts.length === 0) {
      return res.status(503).json({ error: gadsErr });
    }

    // Persist updated list (non-fatal)
    await supabaseAdmin.from('integrations')
      .update({ google_ads_accounts: accounts })
      .eq('user_id', user.id)
      .eq('provider', 'google_ads');

    res.json({
      accounts: accounts.map(a => ({
        customer_id:   a.customer_id,
        account_name:  a.name,
        currency_code: a.currency  || null,
        is_manager:    a.is_manager || false,
        status:        a.status     || null
      }))
    });
  } catch (err) {
    console.error('[google-ads/accounts] unexpected error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// GET /api/google-ads/campaigns — spec-exact endpoint
// Returns: { campaigns: [{ campaign_name, campaign_id, status, clicks, impressions, cost, ctr, conversions }] }
// ?date_range= LAST_7_DAYS | LAST_14_DAYS | LAST_30_DAYS | LAST_90_DAYS (default: LAST_30_DAYS)
app.get('/api/google-ads/campaigns', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range = VALID_RANGES.includes(req.query.date_range) ? req.query.date_range : 'LAST_30_DAYS';

    const results = await _gadsQuery(accessToken, customerId, `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.conversions,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING ${range}
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `, loginCustomerId);

    const campaigns = results.map(r => {
      const c           = r.campaign || {};
      const m           = r.metrics  || {};
      const costMicros  = Number(m.costMicros  || 0);
      const impressions = Number(m.impressions  || 0);
      const clicks      = Number(m.clicks       || 0);
      const conversions = Number(m.conversions  || 0);
      const cost        = costMicros / 1e6;
      return {
        campaign_name: c.name   || 'Unnamed',
        campaign_id:   c.id     || '',
        status:        c.status || 'UNKNOWN',
        clicks,
        impressions,
        cost:        parseFloat(cost.toFixed(2)),
        ctr:         parseFloat((impressions > 0 ? (clicks / impressions) * 100 : 0).toFixed(4)),
        conversions: parseFloat(conversions.toFixed(2))
      };
    });

    console.log('[google-ads/campaigns] Returned', campaigns.length, 'campaigns for', customerId, '|', range);
    res.json({ campaigns, date_range: range, customer_id: customerId });
  } catch (err) {
    console.error('[google-ads/campaigns]', err.message);
    res.status(err.status || 500).json({
      error:       err.message          || 'Internal server error',
      gads_status: err.gadsStatus       || null,
      gads_codes:  err.gadsErrorCodes   || null
    });
  }
});

// ════════════════════════════════════════════════════════════════
// TIKTOK ADS INTEGRATION
// ════════════════════════════════════════════════════════════════

const TIKTOK_APP_ID     = process.env.TIKTOK_APP_ID     || '';
const TIKTOK_APP_SECRET = process.env.TIKTOK_APP_SECRET || '';
const TIKTOK_REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI
  || (process.env.RENDER
    ? 'https://oriven-backand-clean.onrender.com/auth/tiktok/callback'
    : 'http://localhost:5500/auth/tiktok/callback');

const _tiktokOAuthStates = new Map();
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of _tiktokOAuthStates.entries()) {
    if (v.expires < now) _tiktokOAuthStates.delete(k);
  }
}, 5 * 60 * 1000);

// GET /api/tiktok/auth-url — returns TikTok OAuth authorization URL
app.get('/api/tiktok/auth-url', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (!TIKTOK_APP_ID || !TIKTOK_APP_SECRET) {
    return res.status(503).json({ error: 'TikTok OAuth not configured on server' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  _tiktokOAuthStates.set(state, { userId: user.id, expires: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    app_id:       TIKTOK_APP_ID,
    state:        state,
    redirect_uri: TIKTOK_REDIRECT_URI
  });
  // TODO: replace with real TikTok auth URL once app is registered
  res.json({ url: 'https://business-api.tiktok.com/portal/auth?' + params.toString() });
});

// GET /auth/tiktok/callback — OAuth callback from TikTok
app.get('/auth/tiktok/callback', async (req, res) => {
  const { auth_code, state, error } = req.query;
  const frontendBase = process.env.FRONTEND_URL
    || (process.env.RENDER ? 'https://orivenai.com' : 'http://localhost:5500');

  if (error) {
    console.error('[TikTok OAuth] Error from provider:', error);
    return res.redirect(frontendBase + '/app.html?tiktok_error=' + encodeURIComponent(error));
  }
  if (!auth_code || !state) {
    return res.redirect(frontendBase + '/app.html?tiktok_error=missing_params');
  }

  const stateData = _tiktokOAuthStates.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    _tiktokOAuthStates.delete(state);
    return res.redirect(frontendBase + '/app.html?tiktok_error=invalid_state');
  }
  _tiktokOAuthStates.delete(state);
  const userId = stateData.userId;

  // TODO: exchange auth_code for access_token via TikTok token endpoint
  // POST https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/
  // body: { app_id, secret, auth_code }
  // response: { data: { access_token, advertiser_ids: [], scope: "" } }
  console.log('[TikTok OAuth] Placeholder callback — auth_code received, real exchange not implemented');
  return res.redirect(frontendBase + '/app.html?tiktok_error=not_implemented');
});

// GET /api/tiktok/status — return TikTok connection status for the authenticated user
app.get('/api/tiktok/status', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { data, error } = await supabaseAdmin
    .from('integrations')
    .select('tiktok_display_name, connected_at, token_expiry, tiktok_ads_accounts, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'tiktok_ads')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Database error' });
  if (!data)  return res.json({ connected: false });

  res.json({
    connected:            true,
    tiktok_display_name:  data.tiktok_display_name  || null,
    connected_at:         data.connected_at          || null,
    tiktok_ads_accounts:  data.tiktok_ads_accounts   || [],
    active_ad_account:    data.active_ad_account      || null
  });
});

// GET /api/tiktok/accounts — re-fetch accessible TikTok Ads accounts
app.get('/api/tiktok/accounts', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  // TODO: fetch from TikTok Business API:
  // GET https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/
  // header: Access-Token: <access_token>
  // Returns list of { advertiser_id, advertiser_name, currency, timezone }
  res.status(503).json({ error: 'TikTok account fetch not yet implemented' });
});

// POST /api/tiktok/disconnect — delete TikTok integration row
app.post('/api/tiktok/disconnect', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { error } = await supabaseAdmin
    .from('integrations')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', 'tiktok_ads');

  if (error) {
    console.error('[TikTok disconnect] DB error:', error.message);
    return res.status(500).json({ error: 'Could not disconnect' });
  }
  console.log('[TikTok disconnect] Removed | user:', user.id);
  res.json({ ok: true });
});

// POST /api/tiktok/active-account — set active TikTok Ads account for a user
app.post('/api/tiktok/active-account', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { advertiser_id, advertiser_name, currency } = req.body || {};
  if (!advertiser_id) return res.status(400).json({ error: 'advertiser_id is required' });

  const active_ad_account = {
    platform:      'tiktok_ads',
    account_id:    String(advertiser_id),
    account_name:  String(advertiser_name || ''),
    currency:      currency || null
  };

  const { error } = await supabaseAdmin
    .from('integrations')
    .update({ active_ad_account })
    .eq('user_id', user.id)
    .eq('provider', 'tiktok_ads');

  if (error) {
    console.error('[TikTok ActiveAccount] DB error:', error.message);
    return res.status(500).json({ error: 'Could not update active account' });
  }
  res.json({ ok: true, active_ad_account });
});

// GET /api/ads/tiktok/overview — placeholder for TikTok campaign KPIs
app.get('/api/ads/tiktok/overview', async (req, res) => {
  // TODO: implement using TikTok Reporting API
  // POST https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/
  res.status(503).json({ error: 'TikTok Ads reporting not yet implemented' });
});

// GET /api/ads/tiktok/campaigns — placeholder for TikTok campaign list
app.get('/api/ads/tiktok/campaigns', async (req, res) => {
  // TODO: implement using TikTok Campaign API
  // GET https://business-api.tiktok.com/open_api/v1.3/campaign/get/
  res.status(503).json({ error: 'TikTok Ads campaigns not yet implemented' });
});

// ════════════════════════════════════════════════════════════════
// ADS DASHBOARD — campaign data, AI analysis, recommendations
// ════════════════════════════════════════════════════════════════

// Resolve a valid Google Ads access token + active account for a user.
// Refreshes token if expired. Throws with .status set for HTTP codes.
async function _getGadsAccess(user) {
  const { data: intg, error } = await supabaseAdmin
    .from('integrations')
    .select('access_token, refresh_token, token_expiry, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'google_ads')
    .maybeSingle();

  if (error || !intg) {
    const e = new Error('Google Ads not connected'); e.status = 400; throw e;
  }

  let accessToken = intg.access_token;

  if (intg.token_expiry && new Date(intg.token_expiry) < new Date()) {
    if (!intg.refresh_token) {
      const e = new Error('Token expired — reconnect Google Ads'); e.status = 401; throw e;
    }
    const rfRes  = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: intg.refresh_token,
        grant_type:    'refresh_token'
      })
    });
    const rfData = await rfRes.json();
    if (!rfRes.ok || !rfData.access_token) {
      const e = new Error('Token refresh failed — reconnect Google Ads'); e.status = 401; throw e;
    }
    accessToken = rfData.access_token;
    await supabaseAdmin.from('integrations').update({
      access_token: accessToken,
      token_expiry: new Date(Date.now() + (rfData.expires_in || 3600) * 1000).toISOString()
    }).eq('user_id', user.id).eq('provider', 'google_ads');
  }

  const active = intg.active_ad_account;
  console.log('[GadsAccess] active_ad_account from DB:', JSON.stringify(active));

  if (!active || !active.account_id) {
    const e = new Error('No active Google Ads account selected — go to Integrations and choose an account.'); e.status = 400; throw e;
  }

  if (active.is_manager) {
    const e = new Error('The selected account is a Manager Account (MCC) and has no campaigns. Please select a Client Account in the Integrations page.');
    e.status = 400; throw e;
  }

  // Strip dashes if present (Google Ads IDs must be pure digits)
  const customerId      = String(active.account_id).replace(/-/g, '');
  const loginCustomerId = active.parent_manager_id
    ? String(active.parent_manager_id).replace(/-/g, '')
    : customerId;

  console.log('[GadsAccess] customerId:', customerId, '| loginCustomerId:', loginCustomerId, '| via MCC:', !!active.parent_manager_id);

  return { accessToken, customerId, accountName: active.account_name || customerId, loginCustomerId, activeAccount: active };
}

// Execute a GAQL search query against the Ads API. Returns results[].
// loginCustomerId is the Manager Account ID when querying through MCC.
// When absent it defaults to customerId (direct account access).
async function _gadsQuery(accessToken, customerId, query, loginCustomerId) {
  const TIMEOUT_MS = 20000;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const effectiveLoginId = loginCustomerId || customerId;
  const url     = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/googleAds:search';
  const headers = {
    'Authorization':     'Bearer ' + accessToken,
    'developer-token':   GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type':      'application/json',
    'login-customer-id': effectiveLoginId
  };

  const requestBody = JSON.stringify({ query });
  console.log('[GAQL] ▶ POST', url);
  console.log('[GAQL]   customer_id (URL)   :', customerId);
  console.log('[GAQL]   login-customer-id    :', effectiveLoginId);
  console.log('[GAQL]   query               :', query.trim().replace(/\s+/g, ' '));
  console.log('[GAQL]   request body        :', requestBody);

  try {
    const res  = await fetch(url, { method: 'POST', headers, body: requestBody, signal: ctrl.signal })
      .finally(() => clearTimeout(tid));
    const text = await res.text();

    console.log('[GAQL] ◀ HTTP', res.status, url);

    if (!res.ok) {
      // Parse and log the full Google Ads error payload — no truncation
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}

      const gadsErr    = parsed && parsed.error;
      const statusCode = gadsErr && gadsErr.status;
      const message    = (gadsErr && gadsErr.message) || ('Google Ads API error ' + res.status);

      // Extract granular error codes + triggers from GoogleAdsFailure details
      let errorCodes = [];
      let triggers   = [];
      if (gadsErr && Array.isArray(gadsErr.details)) {
        gadsErr.details.forEach(function(detail) {
          if (Array.isArray(detail.errors)) {
            detail.errors.forEach(function(e) {
              if (e.errorCode) errorCodes.push(JSON.stringify(e.errorCode));
              if (e.message)   errorCodes.push('msg:' + e.message);
              if (e.trigger)   triggers.push(JSON.stringify(e.trigger));
            });
          }
        });
      }

      console.error('[GAQL] ✗ FULL ERROR BODY:', text);
      console.error('[GAQL]   status       :', statusCode);
      console.error('[GAQL]   message      :', message);
      console.error('[GAQL]   errorCodes   :', errorCodes.join(' | '));
      console.error('[GAQL]   triggers     :', triggers.join(' | '));

      const detail = errorCodes.length ? ' [' + errorCodes.join('; ') + ']' : '';
      const err = new Error(message + detail);
      err.gadsStatus     = statusCode;
      err.gadsErrorCodes = errorCodes;
      err.gadsTriggers   = triggers;
      err.gadsRawBody    = text;
      throw err;
    }

    const data = JSON.parse(text);
    console.log('[GAQL] ✓ results:', (data.results || []).length);
    return data.results || [];
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Google Ads API timed out (>20 s)');
    throw err;
  }
}

// ── GET /api/ads/overview — account KPIs + campaign list ─────────
app.get('/api/ads/overview', async (req, res) => {
  let _diagCustomerId = null, _diagLoginId = null, _diagActive = null, _diagQuery = null;
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, accountName, loginCustomerId, activeAccount } = await _getGadsAccess(user);
    _diagCustomerId = customerId;
    _diagLoginId    = loginCustomerId;
    _diagActive     = activeAccount;

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range = VALID_RANGES.includes(req.query.date_range) ? req.query.date_range : 'LAST_30_DAYS';

    _diagQuery = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.conversions, metrics.cost_per_conversion, metrics.conversions_value FROM campaign WHERE segments.date DURING ${range} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 100`;

    const results = await _gadsQuery(accessToken, customerId, `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.conversions,
        metrics.cost_per_conversion,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING ${range}
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `, loginCustomerId);

    let totalCostMicros = 0, totalImpr = 0, totalClicks = 0, totalConv = 0, totalConvVal = 0;

    const campaigns = results.map(r => {
      const c  = r.campaign || {};
      const m  = r.metrics  || {};
      const cm = m.costMicros     ? Number(m.costMicros)     : 0;
      const im = m.impressions    ? Number(m.impressions)    : 0;
      const cl = m.clicks         ? Number(m.clicks)         : 0;
      const cv = m.conversions    ? Number(m.conversions)    : 0;
      const vl = m.conversionsValue ? Number(m.conversionsValue) : 0;
      const sp = cm / 1e6;

      totalCostMicros += cm;
      totalImpr       += im;
      totalClicks     += cl;
      totalConv       += cv;
      totalConvVal    += vl;

      return {
        id:               c.id     || '',
        name:             c.name   || 'Unnamed',
        status:           c.status || 'UNKNOWN',
        type:             c.advertisingChannelType || '',
        spend:            sp,
        impressions:      im,
        clicks:           cl,
        ctr:              im > 0 ? (cl / im) * 100 : 0,
        conversions:      cv,
        cpa:              cv > 0 ? sp / cv : 0,
        roas:             sp > 0 ? vl / sp : 0,
        conversions_value: vl
      };
    });

    const totalSpend = totalCostMicros / 1e6;
    res.json({
      account:    { id: customerId, name: accountName },
      date_range: range,
      overview: {
        spend:             totalSpend,
        impressions:       totalImpr,
        clicks:            totalClicks,
        ctr:               totalImpr > 0 ? (totalClicks / totalImpr) * 100 : 0,
        conversions:       totalConv,
        cpa:               totalConv > 0 ? totalSpend / totalConv : 0,
        roas:              totalSpend > 0 ? totalConvVal / totalSpend : 0,
        conversions_value: totalConvVal
      },
      campaigns
    });
  } catch (err) {
    let rawError = null;
    try { rawError = err.gadsRawBody ? JSON.parse(err.gadsRawBody) : null; } catch (_) {}
    console.error('[Ads/overview] DIAGNOSTIC DUMP:');
    console.error('  active_ad_account :', JSON.stringify(_diagActive));
    console.error('  customer_id       :', _diagCustomerId);
    console.error('  login_customer_id :', _diagLoginId);
    console.error('  parent_manager_id :', _diagActive && _diagActive.parent_manager_id);
    console.error('  gaql              :', _diagQuery);
    console.error('  gads_status       :', err.gadsStatus);
    console.error('  gads_codes        :', JSON.stringify(err.gadsErrorCodes));
    console.error('  triggers          :', JSON.stringify(err.gadsTriggers));
    console.error('  raw_gads_error    :', err.gadsRawBody);
    res.status(err.status || 500).json({
      error:             err.message || 'Internal server error',
      active_ad_account: _diagActive         || null,
      customer_id:       _diagCustomerId      || null,
      login_customer_id: _diagLoginId         || null,
      parent_manager_id: (_diagActive && _diagActive.parent_manager_id) || null,
      gaql:              _diagQuery           || null,
      gads_status:       err.gadsStatus       || null,
      gads_codes:        err.gadsErrorCodes   || null,
      triggers:          err.gadsTriggers     || null,
      raw_gads_error:    rawError             || null
    });
  }
});

// ── GET /api/ads/campaigns — dedicated campaigns list endpoint ────
app.get('/api/ads/campaigns', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, accountName, loginCustomerId } = await _getGadsAccess(user);

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range = VALID_RANGES.includes(req.query.date_range) ? req.query.date_range : 'LAST_30_DAYS';

    const results = await _gadsQuery(accessToken, customerId, `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.bidding_strategy_type,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.conversions,
        metrics.cost_per_conversion,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING ${range}
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `, loginCustomerId);

    let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalConv = 0, totalConvVal = 0;
    const campaigns = results.map(r => {
      const c = r.campaign || {}, m = r.metrics || {};
      const cm = Number(m.costMicros || 0), im = Number(m.impressions || 0);
      const cl = Number(m.clicks || 0), cv = Number(m.conversions || 0), vl = Number(m.conversionsValue || 0);
      const sp = cm / 1e6;
      totalSpend += sp; totalImpr += im; totalClicks += cl; totalConv += cv; totalConvVal += vl;
      return {
        id:          c.id     || '',
        name:        c.name   || 'Unnamed',
        status:      c.status || 'UNKNOWN',
        type:        c.advertisingChannelType  || '',
        bidding:     c.biddingStrategyType     || '',
        spend:       sp,
        impressions: im,
        clicks:      cl,
        ctr:         im > 0 ? (cl / im) * 100 : 0,
        conversions: cv,
        cpa:         cv > 0 ? sp / cv : 0,
        roas:        sp > 0 ? vl / sp : 0,
        conversions_value: vl
      };
    });

    res.json({
      account:    { id: customerId, name: accountName },
      date_range: range,
      overview: {
        spend:       totalSpend,
        impressions: totalImpr,
        clicks:      totalClicks,
        ctr:         totalImpr > 0 ? (totalClicks / totalImpr) * 100 : 0,
        conversions: totalConv,
        cpa:         totalConv > 0 ? totalSpend / totalConv : 0,
        roas:        totalSpend > 0 ? totalConvVal / totalSpend : 0,
        conversions_value: totalConvVal
      },
      campaigns
    });
  } catch (err) {
    console.error('[Ads/campaigns]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', gads_status: err.gadsStatus || null, gads_codes: err.gadsErrorCodes || null });
  }
});

// ── GET /api/ads/campaign/:id — ads + keywords for one campaign ──
app.get('/api/ads/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    const campaignId = req.params.id.replace(/\D/g, ''); // digits only
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range = VALID_RANGES.includes(req.query.date_range) ? req.query.date_range : 'LAST_30_DAYS';

    const [adsRows, kwRows, stRows, agRows, campInfoRows] = await Promise.all([
      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group_ad.ad.id,
          ad_group_ad.ad.type,
          ad_group_ad.status,
          ad_group.name,
          ad_group_ad.ad.final_urls,
          ad_group_ad.ad.display_url,
          ad_group_ad.ad.responsive_search_ad.headlines,
          ad_group_ad.ad.responsive_search_ad.descriptions,
          ad_group_ad.ad.expanded_text_ad.headline_part1,
          ad_group_ad.ad.expanded_text_ad.headline_part2,
          ad_group_ad.ad.expanded_text_ad.headline_part3,
          ad_group_ad.ad.expanded_text_ad.description,
          ad_group_ad.ad.expanded_text_ad.description2,
          ad_group_ad.ad.responsive_display_ad.headlines,
          ad_group_ad.ad.responsive_display_ad.descriptions,
          ad_group_ad.ad.responsive_display_ad.business_name,
          ad_group_ad.ad.responsive_display_ad.long_headline,
          ad_group_ad.ad.responsive_display_ad.marketing_images,
          ad_group_ad.ad.responsive_display_ad.logo_images,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.conversions,
          metrics.cost_micros
        FROM ad_group_ad
        WHERE campaign.id = ${campaignId}
          AND segments.date DURING ${range}
          AND ad_group_ad.status != 'REMOVED'
        ORDER BY metrics.impressions DESC
        LIMIT 50
      `, loginCustomerId),
      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          ad_group.name,
          ad_group.id,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.cost_micros
        FROM keyword_view
        WHERE campaign.id = ${campaignId}
          AND segments.date DURING ${range}
          AND ad_group_criterion.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
        LIMIT 100
      `, loginCustomerId).catch(() => []),
      _gadsQuery(accessToken, customerId, `
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          ad_group.name,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.cost_micros
        FROM search_term_view
        WHERE campaign.id = ${campaignId}
          AND segments.date DURING ${range}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId).catch(() => []),
      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group.id,
          ad_group.name,
          ad_group.status,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.cost_micros
        FROM ad_group
        WHERE campaign.id = ${campaignId}
          AND segments.date DURING ${range}
          AND ad_group.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
        LIMIT 30
      `, loginCustomerId).catch(() => []),

      // Campaign budget + channel info
      _gadsQuery(accessToken, customerId, `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.bidding_strategy_type,
          campaign_budget.amount_micros,
          campaign_budget.delivery_method,
          campaign_budget.type
        FROM campaign
        WHERE campaign.id = ${campaignId}
        LIMIT 1
      `, loginCustomerId).catch(() => [])
    ]);

    // Extract budget from campaign info query
    const campInfo = campInfoRows[0] || {};
    const budget = campInfo.campaignBudget ? {
      daily_micros:    Number(campInfo.campaignBudget.amountMicros || 0),
      daily_euros:     Number(campInfo.campaignBudget.amountMicros || 0) / 1e6,
      delivery_method: campInfo.campaignBudget.deliveryMethod || '',
      type:            campInfo.campaignBudget.type || ''
    } : null;

    const camp = campInfo.campaign || {};
    const campaign_info = {
      name:     camp.name    || '',
      status:   camp.status  || '',
      type:     camp.advertisingChannelType || '',
      bidding:  camp.biddingStrategyType    || '',
      budget
    };

    const ads = adsRows.map(r => {
      const aga = r.adGroupAd  || {};
      const a   = aga.ad       || {};
      const ag  = r.adGroup    || {};
      const m   = r.metrics    || {};
      const rsa = a.responsiveSearchAd  || {};
      const eta = a.expandedTextAd      || {};
      const rda = a.responsiveDisplayAd || {};

      // All headlines (for preview)
      const rsaHeadlines = (rsa.headlines || []).map(h => h && h.text ? h.text : '').filter(Boolean);
      const etaHeadlines = [eta.headlinePart1, eta.headlinePart2, eta.headlinePart3].filter(Boolean);
      const rdaHeadlines = (rda.headlines || []).map(h => h && h.text ? h.text : '').filter(Boolean);
      const headlines_all = rsaHeadlines.length ? rsaHeadlines : (etaHeadlines.length ? etaHeadlines : rdaHeadlines);

      // Headline for table (first two joined)
      let headline = '';
      if (headlines_all.length > 0) {
        headline = headlines_all[0] + (headlines_all[1] ? ' | ' + headlines_all[1] : '');
      }

      // All descriptions
      const rsaDescs = (rsa.descriptions || []).map(d => d && d.text ? d.text : '').filter(Boolean);
      const etaDescs = [eta.description, eta.description2].filter(Boolean);
      const rdaDescs = (rda.descriptions || []).map(d => d && d.text ? d.text : '').filter(Boolean);
      const descriptions_all = rsaDescs.length ? rsaDescs : (etaDescs.length ? etaDescs : rdaDescs);

      // Final URL + display URL
      const final_url    = (a.finalUrls && a.finalUrls[0]) ? a.finalUrls[0] : '';
      const display_url  = a.displayUrl || '';

      // Display ad specific
      const business_name   = rda.businessName  || '';
      const long_headline   = rda.longHeadline && rda.longHeadline.text ? rda.longHeadline.text : '';

      // Image asset resource names (resolve via /assets endpoint)
      const marketing_images = (rda.marketingImages || []).map(img => img && img.asset ? img.asset : '').filter(Boolean);
      const logo_images      = (rda.logoImages      || []).map(img => img && img.asset ? img.asset : '').filter(Boolean);

      const cl = Number(m.clicks      || 0);
      const im = Number(m.impressions || 0);
      return {
        id:               a.id       || '',
        type:             a.type     || '',
        status:           aga.status || 'UNKNOWN',
        ad_group:         ag.name    || '',
        headline,
        headlines_all,
        descriptions_all,
        final_url,
        display_url,
        business_name,
        long_headline,
        marketing_images,
        logo_images,
        impressions: im,
        clicks:      cl,
        ctr:         im > 0 ? (cl / im) * 100 : 0,
        conversions: Number(m.conversions || 0),
        spend:       Number(m.costMicros  || 0) / 1e6
      };
    });

    const keywords = kwRows.map(r => {
      const agc = r.adGroupCriterion || {};
      const kw  = agc.keyword        || {};
      const ag  = r.adGroup          || {};
      const m   = r.metrics          || {};
      const cl  = Number(m.clicks      || 0);
      const im  = Number(m.impressions || 0);
      return {
        text:         kw.text      || '',
        match_type:   kw.matchType || '',
        status:       agc.status   || 'UNKNOWN',
        ad_group:     ag.name      || '',
        ad_group_id:  String(ag.id || ''),
        impressions:  im,
        clicks:       cl,
        ctr:          im > 0 ? (cl / im) * 100 : 0,
        conversions:  Number(m.conversions || 0),
        spend:        Number(m.costMicros  || 0) / 1e6
      };
    });

    const search_terms = stRows.map(r => {
      const st = r.searchTermView || {};
      const m  = r.metrics        || {};
      const cl = Number(m.clicks      || 0);
      const im = Number(m.impressions || 0);
      return {
        term:        st.searchTerm  || '',
        status:      st.status      || 'UNKNOWN',
        ad_group:    (r.adGroup && r.adGroup.name) || '',
        impressions: im,
        clicks:      cl,
        ctr:         im > 0 ? (cl / im) * 100 : 0,
        conversions: Number(m.conversions || 0),
        spend:       Number(m.costMicros  || 0) / 1e6
      };
    });

    const ad_groups = agRows.map(r => {
      const ag = r.adGroup  || {};
      const m  = r.metrics  || {};
      const cl = Number(m.clicks      || 0);
      const im = Number(m.impressions || 0);
      return {
        id:          ag.id     || '',
        name:        ag.name   || '',
        status:      ag.status || 'UNKNOWN',
        impressions: im,
        clicks:      cl,
        ctr:         im > 0 ? (cl / im) * 100 : 0,
        conversions: Number(m.conversions || 0),
        spend:       Number(m.costMicros  || 0) / 1e6
      };
    });

    res.json({ campaign_info, ads, keywords, search_terms, ad_groups, date_range: range });
  } catch (err) {
    console.error('[Ads/campaign]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', gads_status: err.gadsStatus || null, gads_codes: err.gadsErrorCodes || null });
  }
});

// ── GET /api/ads/campaign/:id/assets — resolve image asset URLs ──
// Fetches actual image URLs for asset resource names returned in the
// responsive_display_ad.marketing_images / logo_images arrays.
app.get('/api/ads/campaign/:id/assets', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    const campaignId = req.params.id.replace(/\D/g, '');
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });

    const rows = await _gadsQuery(accessToken, customerId, `
      SELECT
        asset.resource_name,
        asset.id,
        asset.type,
        asset.image_asset.full_size.url,
        asset.image_asset.full_size.width_pixels,
        asset.image_asset.full_size.height_pixels
      FROM ad_group_ad_asset_view
      WHERE campaign.id = ${campaignId}
        AND asset.type = 'IMAGE'
      ORDER BY asset.id
      LIMIT 50
    `, loginCustomerId).catch(() => []);

    const assets = rows.map(r => {
      const a  = r.asset || {};
      const ia = a.imageAsset && a.imageAsset.fullSize ? a.imageAsset.fullSize : {};
      return {
        resource_name: a.resourceName || '',
        id:            a.id           || '',
        url:           ia.url         || '',
        width:         ia.widthPixels  || 0,
        height:        ia.heightPixels || 0
      };
    }).filter(a => a.url);

    res.json({ assets });
  } catch (err) {
    console.error('[Ads/assets]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

// ── POST /api/ads/analyze — self-contained AI analysis ──────────
// Fetches fresh data directly from Google Ads API. Accepts only
// { date_range } from the request body — no client data passthrough.
app.post('/api/ads/analyze', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, accountName, loginCustomerId } = await _getGadsAccess(user);

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range = VALID_RANGES.includes(req.body && req.body.date_range) ? req.body.date_range : 'LAST_30_DAYS';

    // Fetch all data in parallel from Google Ads API
    const [campResults, kwResults, stResults, adResults] = await Promise.all([

      // Campaigns — performance totals
      _gadsQuery(accessToken, customerId, `
        SELECT
          campaign.id, campaign.name, campaign.status,
          campaign.advertising_channel_type,
          metrics.cost_micros, metrics.impressions, metrics.clicks,
          metrics.ctr, metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date DURING ${range}
          AND campaign.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId),

      // Keywords — top spenders for quality analysis
      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.impressions,
          metrics.ctr, metrics.conversions
        FROM keyword_view
        WHERE segments.date DURING ${range}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId).catch(() => []),

      // Search terms — detect irrelevant queries and wasted spend
      _gadsQuery(accessToken, customerId, `
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          campaign.name,
          ad_group.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions,
          metrics.impressions
        FROM search_term_view
        WHERE segments.date DURING ${range}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId).catch(() => []),

      // Ads — detect low-performing creatives
      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group_ad.status,
          ad_group_ad.ad.responsive_search_ad.headlines,
          ad_group_ad.ad.expanded_text_ad.headline_part1,
          campaign.name,
          ad_group.name,
          metrics.impressions, metrics.clicks, metrics.ctr,
          metrics.conversions, metrics.cost_micros
        FROM ad_group_ad
        WHERE segments.date DURING ${range}
          AND ad_group_ad.status != 'REMOVED'
          AND metrics.impressions > 0
        ORDER BY metrics.impressions DESC
        LIMIT 30
      `, loginCustomerId).catch(() => [])
    ]);

    const f = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '0');

    // Process campaigns into summary rows
    let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalConv = 0, totalConvVal = 0;
    const campaigns = campResults.map(r => {
      const c = r.campaign || {}, m = r.metrics || {};
      const cm = Number(m.costMicros || 0), im = Number(m.impressions || 0);
      const cl = Number(m.clicks || 0), cv = Number(m.conversions || 0), vl = Number(m.conversionsValue || 0);
      const sp = cm / 1e6;
      totalSpend += sp; totalImpr += im; totalClicks += cl; totalConv += cv; totalConvVal += vl;
      return { name: c.name || '', status: c.status || '', type: c.advertisingChannelType || '',
        spend: sp, impressions: im, clicks: cl, ctr: im > 0 ? (cl / im) * 100 : 0,
        conversions: cv, cpa: cv > 0 ? sp / cv : 0, roas: sp > 0 ? vl / sp : 0 };
    });

    // Keywords summary — top 15 by spend
    const kwLines = kwResults.slice(0, 15).map(r => {
      const agc = r.adGroupCriterion || {}, kw = agc.keyword || {}, m = r.metrics || {};
      const sp = Number(m.costMicros || 0) / 1e6;
      const im = Number(m.impressions || 0), cl = Number(m.clicks || 0);
      const cv = Number(m.conversions || 0);
      return `[${kw.matchType || '?'}] "${kw.text}" | ${r.campaign?.name || ''} | €${f(sp)} spend | CTR: ${im > 0 ? f((cl/im)*100) : '0.00'}% | Conv: ${f(cv)}`;
    });

    // Search terms with spend but zero conversions (wasted spend candidates)
    const wastedLines = stResults.filter(r => {
      const m = r.metrics || {};
      return Number(m.costMicros || 0) > 500000 && Number(m.conversions || 0) === 0; // >€0.50
    }).slice(0, 10).map(r => {
      const st = r.searchTermView || {}, m = r.metrics || {};
      return `"${st.searchTerm}" | ${r.campaign?.name || ''} | €${f(Number(m.costMicros || 0)/1e6)} | ${m.clicks || 0} clicks | 0 conv`;
    });

    // Campaigns with high spend and zero conversions (budget efficiency)
    const zeroCampLines = campaigns.filter(c => c.spend > 5 && c.conversions === 0).map(c =>
      `${c.name} | €${f(c.spend)} spend | ${c.clicks} clicks | 0 conversions`
    );

    const campSummary = campaigns.map(c =>
      `${c.name} | ${c.status} | €${f(c.spend)} | ${c.impressions} impr | ${c.clicks} clicks | CTR: ${f(c.ctr)}% | Conv: ${f(c.conversions)} | CPA: €${c.cpa > 0 ? f(c.cpa) : 'N/A'} | ROAS: ${f(c.roas)}x`
    ).join('\n');

    const system = `You are a senior Google Ads performance analyst. Analyze this account data and return ONLY valid JSON — no markdown, no code fences, no explanation. Start your response with {.

Return exactly this structure:
{
  "score": <integer 0-100>,
  "findings": [
    {
      "type": "wasted_spend|low_ctr|conversion_issue|scaling_opportunity|keyword_opportunity|budget|landing_page",
      "severity": "high|medium|low",
      "title": "Short specific title (max 8 words)",
      "detail": "Specific insight with real numbers and campaign/keyword names from the data",
      "action": "Concrete action the advertiser should take right now"
    }
  ],
  "recommendations": [
    {
      "type": "budget|keyword|negative|bid|copy|structure",
      "campaign": "exact campaign name or 'Account-wide'",
      "title": "Short recommendation title",
      "detail": "Specific action with numbers",
      "priority": "high|medium|low"
    }
  ],
  "strengths": ["specific one-liner with real metric or campaign name"],
  "weaknesses": ["specific one-liner with real metric or campaign name"],
  "opportunities": ["specific one-liner with real metric or campaign name"]
}

Score guide: 70+ good, 45-69 average, below 45 poor. Weight: CTR quality 25%, conversion rate 35%, ROAS 25%, spend efficiency 15%.
Rules: max 6 findings, max 6 recommendations, 3 strengths, 3 weaknesses, 3 opportunities. High severity = major spend impact. Reference real names and numbers. If minimal data, score conservatively and note it.`;

    const userMsg = `Account: ${accountName} (ID: ${customerId}) | Period: ${range}

TOTALS — Spend: €${f(totalSpend)} | Impressions: ${totalImpr} | Clicks: ${totalClicks} | CTR: ${totalImpr > 0 ? f((totalClicks/totalImpr)*100) : '0.00'}% | Conversions: ${f(totalConv)} | CPA: €${totalConv > 0 ? f(totalSpend/totalConv) : 'N/A'} | ROAS: ${totalSpend > 0 ? f(totalConvVal/totalSpend) : '0.00'}x | Revenue: €${f(totalConvVal)}

CAMPAIGNS (by spend):
${campSummary || 'No campaign spend in this period'}

TOP KEYWORDS BY SPEND:
${kwLines.length > 0 ? kwLines.join('\n') : 'No keyword data'}

SEARCH TERMS WITH SPEND BUT ZERO CONVERSIONS (potential wasted spend):
${wastedLines.length > 0 ? wastedLines.join('\n') : 'None identified'}

HIGH-SPEND CAMPAIGNS WITH ZERO CONVERSIONS:
${zeroCampLines.length > 0 ? zeroCampLines.join('\n') : 'None — all campaigns with spend have conversions'}`;

    const raw = await _aimlText('text-copy', system, userMsg, { max_tokens: 2200 });

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
    } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) { console.error('[Ads/analyze] unparseable AI response:', raw.slice(0, 300)); return res.status(500).json({ error: 'AI response could not be parsed — try again' }); }
      parsed = JSON.parse(m[0]);
    }

    console.log('[Ads/analyze] score:', parsed.score, '| findings:', parsed.findings?.length, '| recs:', parsed.recommendations?.length);
    res.json({
      score:           parsed.score           || 0,
      findings:        parsed.findings        || [],
      recommendations: parsed.recommendations || [],
      strengths:       parsed.strengths       || [],
      weaknesses:      parsed.weaknesses      || [],
      opportunities:   parsed.opportunities   || [],
      account:   { id: customerId, name: accountName },
      date_range: range
    });
  } catch (err) {
    console.error('[Ads/analyze]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', gads_status: err.gadsStatus || null, gads_codes: err.gadsErrorCodes || null });
  }
});

// ── POST /api/ads/recommend — self-contained AI copy + keyword recs
// Fetches fresh campaign and keyword data directly from Google Ads.
// Accepts only { date_range } from the request body.
app.post('/api/ads/recommend', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, accountName, loginCustomerId } = await _getGadsAccess(user);

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range = VALID_RANGES.includes(req.body && req.body.date_range) ? req.body.date_range : 'LAST_30_DAYS';

    const [campResults, kwResults, stResults] = await Promise.all([

      _gadsQuery(accessToken, customerId, `
        SELECT
          campaign.id, campaign.name, campaign.status,
          campaign.advertising_channel_type,
          metrics.cost_micros, metrics.impressions, metrics.clicks,
          metrics.ctr, metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date DURING ${range}
          AND campaign.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
        LIMIT 20
      `, loginCustomerId),

      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.ctr,
          metrics.conversions, metrics.impressions
        FROM keyword_view
        WHERE segments.date DURING ${range}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 30
      `, loginCustomerId).catch(() => []),

      // Search terms with spend but no conversions → negative keyword candidates
      _gadsQuery(accessToken, customerId, `
        SELECT
          search_term_view.search_term,
          campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM search_term_view
        WHERE segments.date DURING ${range}
          AND metrics.cost_micros > 1000000
        ORDER BY metrics.cost_micros DESC
        LIMIT 30
      `, loginCustomerId).catch(() => [])
    ]);

    const f = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '0');

    let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalConv = 0, totalConvVal = 0;
    const campSummary = campResults.map(r => {
      const c = r.campaign || {}, m = r.metrics || {};
      const sp = Number(m.costMicros || 0) / 1e6;
      const im = Number(m.impressions || 0), cl = Number(m.clicks || 0);
      const cv = Number(m.conversions || 0), vl = Number(m.conversionsValue || 0);
      totalSpend += sp; totalImpr += im; totalClicks += cl; totalConv += cv; totalConvVal += vl;
      return `${c.name} | ${c.status || ''} | ${c.advertisingChannelType || ''} | Spend: €${f(sp)} | CTR: ${im > 0 ? f((cl/im)*100) : '0.00'}% | Conv: ${f(cv)} | CPA: €${cv > 0 ? f(sp/cv) : 'N/A'} | ROAS: ${sp > 0 ? f(vl/sp) : '0.00'}x`;
    }).join('\n');

    const kwSummary = kwResults.slice(0, 20).map(r => {
      const agc = r.adGroupCriterion || {}, kw = agc.keyword || {}, m = r.metrics || {};
      const sp = Number(m.costMicros || 0) / 1e6;
      const im = Number(m.impressions || 0), cl = Number(m.clicks || 0);
      return `[${kw.matchType || '?'}] "${kw.text}" | ${r.campaign?.name || ''} | €${f(sp)} | CTR: ${im > 0 ? f((cl/im)*100) : '0.00'}% | Conv: ${f(Number(m.conversions || 0))}`;
    }).join('\n');

    // Search terms with spend but no conversions = negative keyword candidates
    const negCandidates = stResults.filter(r => Number(r.metrics?.conversions || 0) === 0).slice(0, 15).map(r => {
      const st = r.searchTermView || {}, m = r.metrics || {};
      return `"${st.searchTerm}" | ${r.campaign?.name || ''} | €${f(Number(m.costMicros || 0)/1e6)} | ${m.clicks || 0} clicks | 0 conv`;
    }).join('\n');

    const system = `You are an expert Google Ads copywriter and performance strategist. Return ONLY valid JSON — no markdown, no code fences, no explanation. Start your response with {.

Return exactly this structure:
{
  "headlines": ["headline 1", "headline 2", ...],
  "descriptions": ["desc 1", "desc 2", ...],
  "keywords": [
    { "keyword": "...", "match_type": "BROAD|PHRASE|EXACT", "rationale": "one sentence why" }
  ],
  "negative_keywords": [
    { "keyword": "...", "rationale": "one sentence why to exclude" }
  ],
  "budget_recommendations": [
    { "campaign": "exact campaign name", "action": "increase|decrease|pause", "rationale": "one sentence with specific numbers" }
  ]
}

Rules:
- 15 headlines (benefit-focused, ≤30 chars each, varied angles)
- 10 descriptions (include a CTA, ≤90 chars each, specific to this business)
- 10 keyword suggestions based on gaps in existing keyword coverage
- 10 negative keywords (use the search term data provided to identify irrelevant queries)
- One budget recommendation per campaign with actual numbers`;

    const userMsg = `Account: ${accountName} | Period: ${range}

TOTALS — Spend: €${f(totalSpend)} | CTR: ${totalImpr > 0 ? f((totalClicks/totalImpr)*100) : '0.00'}% | Conv: ${f(totalConv)} | CPA: €${totalConv > 0 ? f(totalSpend/totalConv) : 'N/A'} | ROAS: ${totalSpend > 0 ? f(totalConvVal/totalSpend) : '0.00'}x

CAMPAIGNS:
${campSummary || 'No campaign spend in this period'}

CURRENT KEYWORDS (top by spend):
${kwSummary || 'No keyword data'}

SEARCH TERMS WITH SPEND BUT NO CONVERSIONS (negative keyword candidates):
${negCandidates || 'None with significant spend'}`;

    const raw = await _aimlText('text-copy', system, userMsg, { max_tokens: 2400 });

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
    } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) { console.error('[Ads/recommend] unparseable AI response:', raw.slice(0, 300)); return res.status(500).json({ error: 'AI response could not be parsed — try again' }); }
      parsed = JSON.parse(m[0]);
    }

    console.log('[Ads/recommend] headlines:', parsed.headlines?.length, '| negatives:', parsed.negative_keywords?.length);
    res.json(parsed);
  } catch (err) {
    console.error('[Ads/recommend]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', gads_status: err.gadsStatus || null, gads_codes: err.gadsErrorCodes || null });
  }
});

// GET /api/google/diag — non-destructive diagnostic: token state + dev token presence
app.get('/api/google/diag', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { data, error } = await supabaseAdmin
      .from('integrations')
      .select('google_email, token_expiry, refresh_token, google_ads_accounts')
      .eq('user_id', user.id)
      .eq('provider', 'google_ads')
      .maybeSingle();

    res.json({
      dev_token_set:        !!GOOGLE_ADS_DEVELOPER_TOKEN,
      connected:            !!data && !error,
      db_error:             error ? error.message : null,
      google_email:         data ? data.google_email : null,
      token_expired:        data && data.token_expiry ? new Date(data.token_expiry) < new Date() : null,
      has_refresh_token:    data ? !!data.refresh_token : null,
      stored_accounts:      data ? (data.google_ads_accounts || []) : [],
      google_ads_col_exists: error ? false : data !== undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/debug/routes — list all registered Express routes
// Express 5 stores the router at app.router; Express 4 uses app._router.
app.get('/api/debug/routes', function(req, res) {
  try {
    const router = app.router || app._router;
    if (!router) {
      return res.status(500).json({
        error: 'Router not accessible',
        _routerDefined: !!app._router,
        routerDefined:  !!app.router
      });
    }
    const stack = router.stack || [];
    const routes = [];
    stack.forEach(function(layer) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .filter(function(m) { return layer.route.methods[m]; })
          .map(function(m) { return m.toUpperCase(); });
        routes.push(methods.join(',') + ' ' + layer.route.path);
      }
    });
    res.json({ count: routes.length, routes: routes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback — after all routes ──────────────────────────────────
// /api/* paths return a JSON 404 so the frontend fetch wrapper gets
// parseable JSON instead of an HTML error page.
// All other paths return index.html (public landing page).
app.use(function(req, res) {
  if (req.path.startsWith('/api/')) {
    console.warn('[404]', req.method, req.url);
    return res.status(404).json({ error: 'Route not found: ' + req.method + ' ' + req.url });
  }
  res.sendFile(path.resolve(__dirname, '..', '..', 'index.html'));
});

// ── Global error handler — catches unhandled errors in routes ───
// Express requires exactly 4 arguments for error handlers.
app.use(function(err, req, res, _next) {
  console.error('[ServerError]', req.method, req.url, err.message);
  console.error('[ServerError] stack:', err.stack);
  console.error('[ServerError] gadsRawBody:', err.gadsRawBody || '(none)');
  let rawGadsError = null;
  try { rawGadsError = err.gadsRawBody ? JSON.parse(err.gadsRawBody) : null; } catch (_) {}
  res.status(err.status || 500).json({
    error:          err.message   || 'Internal server error',
    gads_status:    err.gadsStatus     || null,
    gads_codes:     err.gadsErrorCodes || null,
    triggers:       err.gadsTriggers   || null,
    raw_gads_error: rawGadsError       || null,
    stack:          err.stack          || null
  });
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

  // Google OAuth route registration check
  console.log('[Startup] GOOGLE_CLIENT_ID loaded:',     !!GOOGLE_CLIENT_ID);
  console.log('[Startup] GOOGLE_CLIENT_SECRET loaded:',  !!GOOGLE_CLIENT_SECRET);
  const _checkRouter = app.router || app._router;
  const _checkStack  = (_checkRouter && _checkRouter.stack) ? _checkRouter.stack : [];
  const _googleRoutes = [
    'GET /api/google/auth-url',
    'GET /api/google/status',
    'POST /api/google/disconnect',
    'GET /auth/google/callback',
    'GET /auth/google',
    'GET /api/google-ads/accounts',
    'GET /api/google-ads/campaigns'
  ];
  _googleRoutes.forEach(function(sig) {
    const [method, path] = sig.split(' ');
    const found = _checkStack.some(function(l) {
      return l.route && l.route.path === path && l.route.methods[method.toLowerCase()];
    });
    console.log('[Startup] Route', sig, found ? '✅ registered' : '❌ NOT FOUND');
  });

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
