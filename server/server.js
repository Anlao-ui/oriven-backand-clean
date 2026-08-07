const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const path       = require('path');
const cron       = require('node-cron');
// Resolve .env from the frontend root (two levels up: server/ â†’ oriven-backand-clean/ â†’ C:\files).
// Frontend is the single source of truth for .env.
// NOTE: dotenv does NOT override variables already present in the process
// environment (e.g. set by Render dashboard). If a key shows the wrong value
// at runtime, update it in the Render dashboard â€” not just in .env.
const _dotenvPath = path.resolve(__dirname, '..', '..', '.env');
const _dotenvResult = require('dotenv').config({ path: _dotenvPath });
console.log(
  '[dotenv] Loaded from:', _dotenvPath,
  '| error:', _dotenvResult.error ? _dotenvResult.error.message : 'none'
);

const app = express();
const PORT = parseInt(process.env.PORT || '5500', 10);

const toolRouter = require('./services/toolRouter');
require('./tools/campaignTools'); // registers Tool Router entries as a side effect
require('./tools/businessTools'); // V7 Phase 1 — registers remember_business_fact
const creditManager = require('./services/creditManager'); // no client of its own -- initialized below, right after supabaseAdmin exists
const campaignGoals = require('./services/campaignGoals'); // single source of truth for the 4 campaign goals across every platform

console.log(
  "[Config] Stripe key suffix:",
  process.env.STRIPE_SECRET_KEY?.slice(-4)
);
const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY            || 'missing');


// â”€â”€ Resolved config constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Single definition for every value that would otherwise be duplicated
// across multiple routes as process.env.X || 'hardcoded-default'.
// On Render, RENDER_EXTERNAL_URL is automatically set to the service's own public URL
// (e.g. https://oriven-backand-clean.onrender.com). That URL serves the NEW app.html
// at /app, so it is always the correct redirect target after OAuth.
// Override with FRONTEND_URL in the Render dashboard if you move to a custom domain.
const FRONTEND_URL = process.env.FRONTEND_URL
  || process.env.RENDER_EXTERNAL_URL   // Render injects this automatically
  || 'http://localhost:5500';
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

// Admin Supabase client â€” must use service_role key to bypass RLS
// Server-side options: disable session persistence (no localStorage in Node)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
// Credit Manager shares this exact client -- one Supabase connection for
// the whole app, and no risk of it racing dotenv at import time (see
// services/creditManager.js's init() doc comment for why that mattered).
creditManager.init(supabaseAdmin);

// â”€â”€ Startup sanity checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function checkEnv() {
  const srk  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const role = decodeJwtRole(srk);

  console.log('\nâ•â•â•â•â•â•â•â•â•â•â•â•â•â• ORIVEN SERVER STARTUP â•â•â•â•â•â•â•â•â•â•â•â•â•â•');

  if (!srk) {
    console.error('âŒ [ENV] SUPABASE_SERVICE_ROLE_KEY is not set');
  } else if (!role) {
    console.error('âŒ [ENV] SUPABASE_SERVICE_ROLE_KEY is not a valid JWT');
    console.error('   Get the service_role key from: Supabase Dashboard â†’ Settings â†’ API');
  } else if (role !== 'service_role') {
    console.error(`âŒ [ENV] SUPABASE_SERVICE_ROLE_KEY JWT role = "${role}" â€” expected "service_role"`);
    console.error('   âš¡ You set the ANON key as the service role key â€” this is the most common mistake');
    console.error('   âš¡ The anon key cannot bypass RLS. Supabase updates in the webhook WILL be silently blocked.');
    console.error('   Fix: Supabase Dashboard â†’ Settings â†’ API â†’ copy the "service_role" key (labeled DANGER)');
    console.error('   Then update SUPABASE_SERVICE_ROLE_KEY in server/.env and restart the server');
  } else {
    console.log('âœ… [ENV] SUPABASE_SERVICE_ROLE_KEY JWT role = "service_role" â† correct');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('âŒ [ENV] STRIPE_WEBHOOK_SECRET is not set â€” all webhooks will be rejected');
  } else {
    console.log('âœ… [ENV] STRIPE_WEBHOOK_SECRET is set');
  }

  if (!process.env.FRONTEND_URL && !process.env.RENDER_EXTERNAL_URL) {
    console.warn('âš ï¸  [ENV] Neither FRONTEND_URL nor RENDER_EXTERNAL_URL is set â€” defaulting to localhost:5500');
  } else {
    console.log('âœ… [ENV] FRONTEND_URL resolved to:', FRONTEND_URL);
  }

  // â”€â”€ AI keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const _ck = (val, label) => {
    if (!val || val === 'missing') { console.error('âŒ [ENV] ' + label + ' is not set'); }
    else { console.log('âœ… [ENV] ' + label + ' = ' + val.slice(0, 10) + '...'); }
  };
  _ck(process.env.AIML_API_KEY, 'AIML_API_KEY');


  // AIML API â€” all AI generation routes
  const _aiml   = require('./providers/aimlProvider');
  const _router = require('./services/modelRouter');
  _aiml.diagnose();
  _router.logSummary();

  // â”€â”€ Stripe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk || sk === 'missing') {
    console.error('âŒ [ENV] STRIPE_SECRET_KEY is not set â€” payments will fail');
  } else {
    console.log('âœ… [ENV] STRIPE_SECRET_KEY =', sk.startsWith('sk_live') ? 'âœ… LIVE key' : 'âš ï¸  TEST key');
  }
  // Stripe Price IDs â€” set these in Render environment variables.
  // Create prices in Stripe Dashboard â†’ Products, then copy the price_... ID.
  // STRIPE_PRICE_STARTER      â†’ Starter plan       â‚¬9.95/month
  // STRIPE_PRICE_CREATOR      â†’ Creator plan        â‚¬29.95/month
  // STRIPE_PRICE_PROFESSIONAL â†’ Professional plan   â‚¬59.95/month
  // Agency is Contact Sales â€” no Stripe price ID required.
  const _price = (k) => console.log(' ', k, '=', process.env[k] || 'âŒ NOT SET');
  _price('STRIPE_PRICE_STARTER');
  _price('STRIPE_PRICE_CREATOR');
  _price('STRIPE_PRICE_PROFESSIONAL');

  // â”€â”€ SMTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('âš ï¸  [ENV] SMTP_USER / SMTP_PASS not fully set â€” verification emails will be skipped');
  } else {
    console.log('âœ… [ENV] SMTP configured for', process.env.SMTP_USER);
  }

  // â”€â”€ Google OAuth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.warn('âš ï¸  [ENV] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set â€” Google Ads OAuth disabled');
  } else {
    const _resolvedRedirect = process.env.GOOGLE_REDIRECT_URI
      || (process.env.RENDER ? 'https://oriven-backand-clean.onrender.com/auth/google/callback' : 'http://localhost:5500/auth/google/callback');
    console.log('âœ… [ENV] Google OAuth configured | redirect:', _resolvedRedirect,
      process.env.GOOGLE_REDIRECT_URI ? '(from env)' : process.env.RENDER ? '(Render default)' : '(localhost default)');
  }

  console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');
})();

const PRICE_IDS = {
  starter:      process.env.STRIPE_PRICE_STARTER,
  creator:      process.env.STRIPE_PRICE_CREATOR,
  professional: process.env.STRIPE_PRICE_PROFESSIONAL,
};

app.use(cors());

// â”€â”€ Static files â€” serve the frontend from the project root â”€â”€â”€â”€
// This makes Express the single origin for both HTML and API routes,
// so relative /api/... URLs from the browser resolve to this process.
// Must come before express.json() but after cors() so CORS headers
// are present on static responses too.
app.use(express.static(path.resolve(__dirname, '..', '..')));

// â”€â”€ Stripe webhook â€” must be registered BEFORE express.json() â”€â”€
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('\nâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€');
  console.log('[Webhook] â–¶ Route hit');

  // 1. Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('[Webhook] âœ… Signature verified');
  } catch (err) {
    console.error('[Webhook] âŒ Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Log event type
  console.log('[Webhook] Event type:', event.type);
  console.log('[Webhook] Event id:  ', event.id);

  // â”€â”€ Subscription deleted (cancellation applied) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    console.log('[Webhook] subscription.deleted â†’ customer:', customerId);
    if (customerId) {
      const { error } = await supabaseAdmin.from('profiles')
        .update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null })
        .eq('stripe_customer_id', customerId);
      if (error) console.error('[Webhook] subscription.deleted DB error:', error.message);
      else console.log('[Webhook] âœ… Plan reset to free for customer:', customerId);
    }
    return res.json({ received: true });
  }

  // â”€â”€ Subscription updated (paid-to-paid switch) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const customerId = sub.customer;
    const pendingPlan = sub.metadata && sub.metadata.pending_plan;
    if (pendingPlan && sub.status === 'active') {
      console.log('[Webhook] subscription.updated â†’ applying plan:', pendingPlan);
      const { error } = await supabaseAdmin.from('profiles')
        .update({ subscription_status: pendingPlan, pending_plan: null, pending_plan_date: null })
        .eq('stripe_customer_id', customerId);
      if (error) console.error('[Webhook] subscription.updated DB error:', error.message);
      else console.log('[Webhook] âœ… Plan updated to:', pendingPlan, 'for customer:', customerId);
    } else {
      console.log('[Webhook] subscription.updated â€” no pending_plan or not active, skipping');
    }
    return res.json({ received: true });
  }

  // -- Invoice paid (real billing-cycle boundary) -- resets credits_balance
  // to the plan's allowance and anchors credits_cycle_start/end to Stripe's
  // own period, which does not necessarily align to a calendar month.
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const periodStart = invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null;
    const periodEnd   = invoice.period_end   ? new Date(invoice.period_end   * 1000).toISOString() : null;
    console.log('[Webhook] invoice.payment_succeeded -> customer:', customerId);
    if (customerId) {
      try {
        const { data: profile } = await supabaseAdmin.from('profiles')
          .select('id, subscription_status').eq('stripe_customer_id', customerId).maybeSingle();
        if (profile) {
          const allowance = creditManager.PLAN_ALLOWANCES[profile.subscription_status];
          if (allowance != null) {
            await supabaseAdmin.from('profiles').update({
              credits_balance: allowance,
              credits_cycle_start: periodStart,
              credits_cycle_end: periodEnd,
              credits_last_reset_source: 'stripe',
            }).eq('id', profile.id);
            console.log(`[Webhook] Credits reset to ${allowance} for ${profile.id} (plan: ${profile.subscription_status})`);
          } else {
            console.log('[Webhook] No credit allowance for plan:', profile.subscription_status, '- skipping reset');
          }
        } else {
          console.warn('[Webhook] invoice.payment_succeeded - no profile found for customer:', customerId);
        }
      } catch (err) {
        console.error('[Webhook] invoice.payment_succeeded credit reset error:', err.message);
      }
    }
    return res.json({ received: true });
  }

  if (event.type !== 'checkout.session.completed') {
    console.log('[Webhook] â„¹ï¸  Ignoring event type:', event.type);
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
    console.error('[Webhook] âŒ userId missing from metadata â€” cannot update Supabase');
    return res.json({ received: true });
  }
  if (!plan) {
    console.error('[Webhook] âŒ plan missing from metadata â€” cannot update Supabase');
    return res.json({ received: true });
  }

  // 6. Guard: plan must be a known value
  console.log("[Checkout Debug] Using creator/professional plan mapping");
  const validPlans = ['starter', 'creator', 'professional'];
  if (!validPlans.includes(plan)) {
    console.error(`[Webhook] âŒ Unknown plan "${plan}" â€” expected one of: ${validPlans.join(', ')}`);
    return res.json({ received: true });
  }

  // 7. Guard: payment must be confirmed
  if (session.payment_status !== 'paid') {
    console.warn(`[Webhook] âš ï¸  payment_status is "${session.payment_status}", not "paid" â€” skipping update`);
    return res.json({ received: true });
  }

  // 8. Attempt Supabase update
  console.log(`[Webhook] ðŸ”„ UPDATE profiles SET subscription_status = '${plan}' WHERE id = '${userId}'`);

  const { data: updateData, error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({
      subscription_status: plan,
      stripe_subscription_id: session.subscription || null,
      stripe_customer_id: session.customer || null,
      // First-activation credit grant -- immediately corrected to Stripe's
      // real billing period by the invoice.payment_succeeded handler above,
      // which fires right after checkout completes.
      credits_balance: creditManager.PLAN_ALLOWANCES[plan] || 0,
      credits_cycle_start: new Date().toISOString(),
      credits_cycle_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      credits_last_reset_source: 'signup',
    })
    .eq('id', userId)
    .select('id, subscription_status');

  // Log raw update result â€” never assume success without checking
  console.log('[Webhook] Raw update response:');
  console.log('           data: ', JSON.stringify(updateData));
  console.log('           error:', JSON.stringify(updateError));

  if (updateError) {
    console.error('[Webhook] âŒ UPDATE failed');
    console.error('           code:   ', updateError.code);
    console.error('           message:', updateError.message);
    console.error('           details:', updateError.details);
    console.error('           hint:   ', updateError.hint);
    if (updateError.code === '42501') {
      console.error('[Webhook] âŒ RLS policy blocked the update â€” service_role key is probably wrong');
    }
  } else if (!updateData || updateData.length === 0) {
    console.warn('[Webhook] âš ï¸  UPDATE matched 0 rows');
    console.warn('           This means no profile row has id =', userId);
    console.warn('           Checking whether the row exists at all...');

    const { data: checkData, error: checkError } = await supabaseAdmin
      .from('profiles')
      .select('id, subscription_status')
      .eq('id', userId)
      .maybeSingle();

    if (checkError) {
      console.error('[Webhook] âŒ Existence check failed:', checkError.message);
    } else if (!checkData) {
      console.error('[Webhook] âŒ No profile row found for userId:', userId);
      console.error('           The user may not have a profiles row yet');
    } else {
      console.log('[Webhook] â„¹ï¸  Row exists but was not updated:', JSON.stringify(checkData));
      console.log('[Webhook]    This is likely an RLS permission problem');
    }
  } else {
    console.log('[Webhook] âœ… UPDATE succeeded â€” rows changed:', updateData.length);
    console.log('[Webhook]    Updated row:', JSON.stringify(updateData[0]));
  }

  // 9. Independent post-update verification SELECT â€” confirms what's in the DB right now
  console.log('[Webhook] ðŸ”Ž Verifying current DB value...');
  const { data: verifyData, error: verifyError } = await supabaseAdmin
    .from('profiles')
    .select('id, subscription_status')
    .eq('id', userId)
    .maybeSingle();

  if (verifyError) {
    console.error('[Webhook] âŒ Verification SELECT failed:', verifyError.message);
  } else if (!verifyData) {
    console.error('[Webhook] âŒ Verification: no row found in profiles for userId:', userId);
  } else {
    const actual = verifyData.subscription_status;
    if (actual === plan) {
      console.log(`[Webhook] âœ… CONFIRMED â€” DB shows subscription_status = "${actual}"`);
    } else {
      console.error(`[Webhook] âŒ MISMATCH â€” expected "${plan}" but DB shows "${actual}"`);
      console.error('[Webhook]    The update did not persist â€” check service_role key and RLS policies');
    }
  }

  console.log('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n');
  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V8 â€” Creative Engine (Epic 1). Not a rewrite of the working generator
// routes below â€” a thin, shared coordination layer: one Business Brain
// context wrapper (reuses _gatherBusinessContext, defined further down in
// this file), one registry of creative "kinds" for the generic
// variations/improve/library routes, one fire-and-forget asset-recording
// helper. Every existing generator route stays exactly as it was, plus
// these small additions.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function _creativeContext(userId) {
  return userId ? _gatherBusinessContext(userId).catch(() => null) : null;
}

const CREATIVE_KINDS = {
  headline:    { label: 'Headline' },
  cta:         { label: 'CTA' },
  hook:        { label: 'Hook' },
  description: { label: 'Description' },
  image_idea:  { label: 'Image idea' },
  video_angle: { label: 'Video angle' },
  emotional:   { label: 'Emotional variant' },
  premium:     { label: 'Premium variant' },
  luxury:      { label: 'Luxury variant' },
  urgency:     { label: 'Urgency variant' }
};

// Fire-and-forget, same non-blocking style as services/eventLog.js â€” a
// storage hiccup must never break a generation response.
async function _recordCreativeAsset(userId, row) {
  if (!userId) return;
  try {
    await supabaseAdmin.from('creative_assets').insert(Object.assign({ user_id: userId }, row));
  } catch (err) {
    console.warn('[CreativeEngine] asset record failed:', err.message);
  }
}

// â”€â”€ Web generator â€” registered immediately after json middleware â”€â”€
app.post('/api/generate-web', requireSubIfAuthed, async (req, res) => {
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
    signup:    'Sign up / free trial â€” every CTA drives toward account creation or trial',
    purchase:  'Purchase â€” product-first, overcome buying hesitation, clear price and value',
    contact:   'Contact / enquiry â€” build trust first, make reaching out feel low-friction',
    download:  'Download â€” surface the benefit immediately, single-click CTA',
    book_call: 'Book a call â€” social proof heavy, calendar CTA prominent',
    awareness: 'Brand awareness â€” storytelling over selling, memorability over conversion',
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

  console.log('[Web] Anthropic â†’ generating brand-aligned landing page');

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const systemPrompt = `You are a senior web designer and frontend engineer who builds pixel-perfect, brand-aligned landing pages.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — reflect it in the copy instead of generic placeholder text):\n${_bizCtx.text}` : ''}

Generate a complete, production-ready HTML landing page that STRICTLY follows the brand identity provided in the brief.

BRAND IDENTITY RULES â€” NON-NEGOTIABLE:
- Page background MUST be exactly the "Background color" value from the brief
- All body text MUST use exactly the "Text color" value from the brief
- Primary buttons, hero sections, and main CTAs MUST use the "Primary color"
- Secondary blocks, alternate sections, and supporting elements MUST use the "Secondary color"
- Borders, dividers, highlights, and accent details MUST use the "Accent color"
TECHNICAL REQUIREMENTS:
- Output ONLY a complete HTML document starting with <!DOCTYPE html>
- All CSS inside a <style> tag in <head> â€” no external stylesheets, no CDN links
- Define CSS custom properties at :root for all brand colors and use them throughout
- Use system fonts (system-ui, -apple-system, Georgia, serif) â€” no web font CDNs
- No icons, no emojis, no SVG illustrations
- All copy must be specific to the product/brand in the brief â€” no lorem ipsum
- Include: a nav bar, all sections listed in the brief, and a footer
- Footer must include small text: "Generated by ORIVEN"
- Fully responsive â€” mobile and desktop
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

    console.log(`[Web] page ready â€” ${html.length} chars`);
    _recordCreativeAsset(req.user && req.user.id, { kind: 'landing_page', title: brand_name || product || 'Landing page', content: { html }, source_route: '/api/generate-web' });
    res.json({ html });
  } catch (err) {
    console.error('[Web] Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to generate website' });
  }
});

// â”€â”€ Auth helper â€” verify Supabase JWT and return user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Subscription enforcement middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Two tiers:
//
// requireSubscription     â€” strict: auth token required AND subscription required.
//                           Use for account-management routes (plan change, invite).
//
// requireSubIfAuthed      â€” lenient: no-auth requests pass through (guest demo);
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
  const route = req.path || req.url || '?';
  const auth = req.headers.authorization || '';
  console.log(`[middleware] requireSubIfAuthed — ${req.method} ${route} | auth header: ${auth ? 'present (' + auth.slice(0,15) + '...)' : 'MISSING'}`);
  if (!auth) {
    console.log('[middleware] No auth — guest pass-through');
    return next();
  }
  const user = await getUserFromToken(req);
  if (!user) {
    console.log('[middleware] Auth header present but getUserFromToken returned null — pass-through');
    return next();
  }
  console.log('[middleware] User resolved:', user.id, user.email || '(no email)');
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('profiles').select('subscription_status').eq('id', user.id).maybeSingle();
    if (dbErr) console.warn('[middleware] Supabase profiles query error:', dbErr.message);
    const status = (data && data.subscription_status) || 'none';
    console.log('[middleware] subscription_status:', status, '| paid:', PAID_PLANS.includes(status));
    if (!PAID_PLANS.includes(status)) {
      console.log('[middleware] 403 — subscription required for', user.id);
      return res.status(403).json({ error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    }
    req.user = user;
    console.log('[middleware] ✓ Authorized — proceeding to route');
    next();
  } catch (err) {
    console.warn('[middleware] Subscription check threw — fail open:', err.message);
    next();
  }
}

// â”€â”€ Shared SMTP transporter factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// requireSubOrOnboardingGen -- used ONLY on /api/ai/create-ad, nowhere else.
// Identical to requireSubIfAuthed, with exactly one addition: a user who
// hasn't finished onboarding yet AND hasn't already used their one free
// generation gets waved through for a single real generation instead of
// a 403. The onboarding tour's own Publish step (client-side, unchanged)
// is what actually shows the paywall next -- this middleware only stops
// the tour from dying one step too early. Marks free_campaign_used=true
// server-side on successful generation (see the route handler) so the
// exception can never be reused -- not a standing bypass, one-shot only.
async function requireSubOrOnboardingGen(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth) { console.log('[middleware] requireSubOrOnboardingGen - no auth, guest pass-through'); return next(); }
  const user = await getUserFromToken(req);
  if (!user) return next();
  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('profiles').select('subscription_status, onboarding_completed, free_campaign_used').eq('id', user.id).maybeSingle();
    if (dbErr) console.warn('[middleware] requireSubOrOnboardingGen query error:', dbErr.message);
    const status = (data && data.subscription_status) || 'none';
    if (PAID_PLANS.includes(status)) { req.user = user; return next(); }

    const onboardingDone = data ? data.onboarding_completed === true : false;
    const freeGenUsed = data ? data.free_campaign_used === true : false;
    if (!onboardingDone && !freeGenUsed) {
      console.log('[middleware] Onboarding free-generation exception granted for', user.id);
      req.user = user;
      req._onboardingFreeGen = true;
      return next();
    }

    console.log('[middleware] 403 - subscription required for', user.id, '| onboardingDone:', onboardingDone, '| freeGenUsed:', freeGenUsed);
    return res.status(403).json({ error: 'Active subscription required', code: 'SUBSCRIPTION_REQUIRED' });
  } catch (err) {
    console.warn('[middleware] requireSubOrOnboardingGen threw - fail open:', err.message);
    next();
  }
}

// Called once a generation actually succeeds for a user who was let through
// via the onboarding exception above -- burns the one-time allowance
// server-side so it can't be triggered again by retrying, refreshing, or
// never finishing onboarding. Fire-and-forget, matches the DB-write style
// already used elsewhere in this file.
function _consumeOnboardingFreeGen(req) {
  if (!req._onboardingFreeGen || !req.user) return;
  // upsert, not update -- a brand-new signup's profiles row can lag behind
  // the very first authenticated request (confirmed directly against
  // prod: immediately after /api/signup returns, the row can still be
  // unreadable). .update() on a not-yet-existent row silently matches zero
  // rows and "succeeds" while writing nothing, which would let the
  // exception be used more than once. Same fix already applied to the
  // preferences route for the same underlying timing issue.
  supabaseAdmin.from('profiles').upsert({ id: req.user.id, free_campaign_used: true }, { onConflict: 'id' })
    .then((r) => {
      if (r && r.error) console.warn('[middleware] Could not persist free_campaign_used:', r.error.message);
      else console.log('[middleware] free_campaign_used=true persisted for', req.user.id, '(onboarding exception consumed)');
    })
    .catch((e) => console.warn('[middleware] _consumeOnboardingFreeGen threw:', e.message));
}
function _smtpTransporter() {
  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls:    { ciphers: 'SSLv3' }
  });
}

// â”€â”€ Verification email HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


// â”€â”€ Shared helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ Strip markdown/quote fences from HTML output â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


// â”€â”€ Text â€” Anthropic only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used by: Text, Brand Assistant, Ideas, Video
// â”€â”€ Shared helper: format BrandCore context for AI prompts â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Generation helpers â€” all routes through AIML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Provider and model are determined entirely by modelRouter.js.

// Size â†” ratio conversion utilities
function _sizeToRatio(size) {
  const map = { '1024x1024': '1:1', '1024x1536': '9:16', '1536x1024': '16:9', '1792x1024': '16:9', '1024x1792': '9:16' };
  return map[size] || '1:1';
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

// Multi-turn chat — messages is a full [{role,content}, ...] array (system + history + latest user turn).
async function _aimlChat(messages, opts = {}) {
  const router = require('./services/modelRouter');
  const route  = router.routeTask('chat');
  const aiml   = require('./providers/aimlProvider');
  return aiml.generateText(messages, null, { model: route.model, ...opts });
}

// â”€â”€ Image prompt builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Turns a brief into a focused image generation prompt via Anthropic,
// then the caller passes the result to _aimlImage for rendering.

async function _briefToImagePrompt(brief, contextHint, taskType) {
  const system = `You are a visual art director. Convert this brief into a single vivid image generation prompt of 150â€“300 characters. Describe what's seen â€” composition, color palette, mood, lighting. Reference brand colors by hex if provided. No text, logos, or UI elements. Output ONLY the prompt.`;
  const user   = (contextHint ? `Context: ${contextHint}\n\nBrief:\n` : 'Brief:\n') + brief.slice(0, 2000);
  return _aimlText(taskType || 'visuals-copy', system, user, { max_tokens: 300 });
}

app.post('/api/generate-text', requireSubIfAuthed, async (req, res) => {
  const { prompt, type, brandContext } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const brandSection = _buildBrandSection(brandContext);
  const hasBrand     = brandSection.length > 0;
  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const bizSection = _bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — use it instead of generic copy):\n${_bizCtx.text}` : '';

  console.log(`[Text/${type || 'default'}] Anthropic â†’ prompt received | brand: ${hasBrand ? brandContext.name : 'none'}`);

  let systemPrompt;

  if (type === 'assistant') {
    systemPrompt = `You are a smart, helpful AI assistant for brand owners and marketers. You have deep knowledge of marketing, branding, strategy, copywriting, campaigns, content, and creative direction.${hasBrand ? `\n\nYou have access to the user's brand context below. Use it when it's relevant to their question â€” but don't reference it in every response. When someone says "hi" or makes small talk, just respond naturally and briefly.\n\nBRAND CONTEXT (draw on this when relevant):\n${brandSection}` : ''}${bizSection}

Be conversational and natural. Match the energy of the message â€” brief for casual, thorough for strategic questions. Think like a knowledgeable colleague, not a branded bot. Never start with hollow affirmations like "Great!" or "Absolutely!". Be direct.`;

  } else if (type === 'text' || type === 'video' || type === 'ideas') {
    systemPrompt = `You are a senior brand copywriter and content strategist.
Generate structured, professional content based on the brief provided.
Output must be specific, intentional, and ready to use â€” no preamble, no meta-commentary, no filler.
Never respond conversationally. Never say "Sure!" or "Great!" or explain what you're about to do.
Just produce the requested content, formatted cleanly and directly.${hasBrand ? `\n\nBRAND CONTEXT â€” every output must reflect this brand identity exactly:\n${brandSection}` : ''}${bizSection}`;

  } else {
    systemPrompt = `You are a senior brand copywriter. Generate professional brand content based on the brief.
Be specific and direct. No preamble or filler.${hasBrand ? `\n\nBRAND CONTEXT:\n${brandSection}` : ''}${bizSection}`;
  }

  try {
    const result = await _aimlText('text-copy', systemPrompt, prompt);
    console.log(`[Text/${type || 'default'}] AIML â†’ response ready`);
    _recordCreativeAsset(req.user && req.user.id, { kind: type || 'text', title: prompt.slice(0, 80), content: { text: result }, source_route: '/api/generate-text' });
    res.json({ result });
  } catch (err) {
    console.error(`[Text/${type || 'default'}] AIML error:`, err.message);
    res.status(500).json({ error: 'Failed to generate text. Please try again.' });
  }
});

// â”€â”€ Email Designer â€” Anthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used by: Email Designer generator
// Receives: { prompt }  Returns: { html }
app.post('/api/generate-email', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const system = `You are an expert email marketing designer and copywriter. Generate a complete, production-ready HTML email.

CRITICAL: Output ONLY raw HTML starting with <!DOCTYPE html>. No markdown. No code fences. No explanation. No """ or \`\`\` wrappers. The very first character must be <.

TECHNICAL REQUIREMENTS:
- Table-based layout for maximum email client compatibility (Gmail, Outlook, Apple Mail)
- Inline every CSS style â€” attribute style="" on every element (no <style> blocks)
- Max-width 600px, centered with auto margins
- Include realistic, compelling sections: header with brand name/logo text, main content body, CTA button, footer with unsubscribe link

DESIGN REQUIREMENTS:
- Apply brand colours from BrandCore as inline hex values throughout
- Use web-safe fonts (Arial, Georgia, Helvetica)
- Every section must have visible content â€” no blank areas
- CTA button must be a styled table cell with solid background colour, not a plain link
- Write all copy based on the brief â€” zero placeholder text${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — reflect it instead of generic placeholder copy):\n${_bizCtx.text}` : ''}`;

  try {
    const html = extractHtml(await _aimlText('email', system, prompt, { max_tokens: 4096 }));
    _recordCreativeAsset(req.user && req.user.id, { kind: 'email', title: prompt.slice(0, 80), content: { html }, source_route: '/api/generate-email' });
    res.json({ html });
  } catch (err) {
    console.error('[Email] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate email. Please try again.' });
  }
});

// â”€â”€ Presentation Generator â€” Anthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used by: Presentation Generator
// Receives: { prompt }  Returns: { slides: [{slide, title, content, notes}] }
app.post('/api/generate-deck', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const system = `You are a world-class presentation designer and strategist. Generate a complete slide deck with rich visual structure.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — reflect it in the deck's content):\n${_bizCtx.text}` : ''}

CRITICAL: Respond with ONLY a valid JSON object. No markdown. No code fences. No explanation. Start directly with {

OUTPUT SCHEMA â€” every slide must use this structure:
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
      "notes": "Speaker notes â€” what to say while this slide is shown"
    }
  ]
}

LAYOUT TYPES â€” assign the best layout for each slide:
- "title" â€” Opening slide. Large title + subtitle. ALWAYS use for slide 1.
- "content" â€” Standard slide. Headline + bullet points (3â€“5 max). Most slides use this.
- "stats" â€” Data slide. Use "metrics" array (2â€“4 items, each with value + label). Use for any slide with numbers.
- "feature" â€” Showcase slide. Use "bullets" as feature names (3â€“6 items in a grid). Use for feature/benefit lists.
- "quote" â€” Impact statement. Use "content" for the quote, "attribution" for the source.
- "closing" â€” Final slide. Title + body + CTA. ALWAYS use for the last slide.

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
    _recordCreativeAsset(req.user && req.user.id, { kind: 'deck', title: prompt.slice(0, 80), content: { slides: parsed.slides || [] }, source_route: '/api/generate-deck' });
    res.json({ slides: parsed.slides || [] });
  } catch (err) {
    console.error('[Deck] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate deck. Please try again.' });
  }
});

// â”€â”€ Poster Generator â€” Anthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used by: Poster Generator
// Receives: { prompt }  Returns: { html }
app.post('/api/generate-poster', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const system = `You are a world-class graphic designer. Generate a bold, complete HTML/CSS poster rendered in a browser.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — reflect it in the poster's copy):\n${_bizCtx.text}` : ''}

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
    <!-- SECTION 2: Hero visual area (CSS gradients, geometric shapes â€” NO <img> tags) -->
    <!-- SECTION 3: Headline (DOMINANT element â€” largest text on the poster) -->
    <!-- SECTION 4: Supporting copy and body text -->
    <!-- SECTION 5: CTA section (button or URL in brand color) -->
    <!-- SECTION 6: Footer with brand details -->
  </div>
</body>
</html>

DESIGN REQUIREMENTS:
- Apply brand colours from BrandCore as the primary palette throughout
- Headline must be LARGE (80px+) and DOMINANT â€” the first thing the eye sees
- Use CSS gradients, shapes, borders, and pseudo-elements for all visual interest (no <img>)
- High contrast â€” dark background with bright brand-coloured accents, or vice versa
- Every section must have VISIBLE CONTENT â€” zero blank areas
- Bold typographic hierarchy: headline > subheading > body > CTA
- Include all copy from the brief verbatim â€” no placeholder text

POSTER MUST INCLUDE ALL OF THESE SECTIONS:
1. Brand header (brand name or logo text, brand colour)
2. Hero/visual area (abstract CSS shapes, gradient backdrop, geometric composition)
3. Main headline (the largest, most dominant text)
4. Supporting body text
5. CTA area (styled button or highlighted URL)
6. Footer (tagline or brand detail)`;

  try {
    const html = extractHtml(await _aimlText('poster', system, prompt, { max_tokens: 4096 }));
    _recordCreativeAsset(req.user && req.user.id, { kind: 'poster', title: prompt.slice(0, 80), content: { html }, source_route: '/api/generate-poster' });
    res.json({ html });
  } catch (err) {
    console.error('[Poster] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate poster. Please try again.' });
  }
});

app.post('/api/generate-infographic', requireSubIfAuthed, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const system = `You are a world-class infographic designer. Generate a bold, complete HTML/CSS infographic rendered in a browser.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — reflect it in the infographic's content):\n${_bizCtx.text}` : ''}

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
    <!-- SECTION 3: Main data visualisation (charts, bars, steps, timeline, icons â€” all CSS only) -->
    <!-- SECTION 4: Key statistics or callout facts -->
    <!-- SECTION 5: CTA footer with brand name -->
  </div>
</body>
</html>

DESIGN REQUIREMENTS:
- Apply brand colours from BrandCore as the primary palette throughout
- Title must be prominent (56px+) at the top of the infographic
- Use CSS-only visualisations: bar charts, progress bars, icon shapes, numbered circles, connecting lines â€” NO <img> tags
- Data must be visually encoded â€” numbers should be LARGE and immediately readable
- High visual hierarchy: title > section headers > data points > supporting text
- All copy from the brief included verbatim â€” no placeholder text
- Sections clearly separated with whitespace, dividers, or background contrast

INFOGRAPHIC MUST INCLUDE ALL OF THESE:
1. Brand header (brand name, brand colour, infographic title)
2. Main data section (visually rich â€” charts, steps, icons, stats, all CSS)
3. At least one prominent callout stat or highlight box
4. CTA footer (brand-coloured, action-oriented)`;

  try {
    const html = extractHtml(await _aimlText('infographic', system, prompt, { max_tokens: 4096 }));
    _recordCreativeAsset(req.user && req.user.id, { kind: 'infographic', title: prompt.slice(0, 80), content: { html }, source_route: '/api/generate-infographic' });
    res.json({ html });
  } catch (err) {
    console.error('[Infographic] AIML error:', err.message);
    res.status(500).json({ error: 'Failed to generate infographic. Please try again.' });
  }
});

// â”€â”€ Image â€” OpenAI DALL-E only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used by: Image (guided flow)
// Receives: { prompt, size, imageType, imageFormat, refImageData? }
// If refImageData is provided, Anthropic vision extracts style cues
// which are appended to the DALL-E prompt as a style guide.
app.post('/api/generate-image', requireSubIfAuthed, async (req, res) => {
  const { prompt, size, imageType, imageFormat, refImageData, uploadType } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const resolvedSize = size || '1024x1024';
  console.log(`[Image] type=${imageType || '?'} format=${imageFormat || '?'} uploadType=${uploadType || 'none'} â†’ DALL-E size: ${resolvedSize}`);

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
          visionPrompt = 'Describe this product in detail for a DALL-E image generation prompt: exact shape, color, material, finish, proportions, and any distinguishing features. Be specific and literal â€” this description will be used to faithfully recreate the product in a scene. 60â€“80 words max.';
          promptLabel  = 'PRODUCT TO FEATURE';
        } else if (uploadType === 'logo') {
          visionSystem = 'You are a brand identity analyst. Analyze this logo for its design language.';
          visionPrompt = 'Analyze this brand logo and extract its visual design language: color palette, geometric forms, negative space usage, visual weight, and the overall aesthetic feeling it conveys. Do NOT describe the logo itself â€” describe the design principles that could inform a photograph or scene. 50â€“70 words max.';
          promptLabel  = 'BRAND VISUAL LANGUAGE FROM LOGO';
        } else {
          // reference (default)
          visionSystem = 'You are a visual art director. Analyze reference images for style extraction.';
          visionPrompt = 'Extract the key visual style cues from this reference image for use in a DALL-E generation prompt. Focus on: color palette and temperature, lighting character and direction, composition approach, texture and material feel, depth of field, overall mood and aesthetic. Specific observations only. 60â€“80 words max.';
          promptLabel  = 'REFERENCE IMAGE STYLE';
        }

        console.log(`[Image] Running ${uploadType || 'reference'} vision analysisâ€¦`);
        const imageDataUrl = `data:${mediaType};base64,${b64data}`;
        const analysis = (await _aimlVision('vision', visionSystem, visionPrompt, imageDataUrl, { max_tokens: 160 })).trim();
        finalPrompt = finalPrompt + '\n\n' + promptLabel + ': ' + analysis;
        console.log(`[Image] Vision analysis appended (${uploadType || 'reference'}).`);
      }
    } catch (err) {
      console.warn('[Image] Vision analysis failed (non-fatal):', err.message);
    }
  }

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  if (_bizCtx) finalPrompt = finalPrompt + '\n\nBRAND CONTEXT (reflect this business\'s real identity, not generic stock imagery): ' + _bizCtx.text;

  // Hard safety clamp before DALL-E â€” API limit is 4000 chars
  const DALLE_MAX = 3900;
  console.log(`[Image] Prompt length before DALL-E: ${finalPrompt.length}`);
  if (finalPrompt.length > DALLE_MAX) {
    finalPrompt = finalPrompt.slice(0, DALLE_MAX);
    console.warn(`[Image] Prompt clamped to ${DALLE_MAX} chars â€” check prompt builder for verbosity.`);
  }
  console.log(`[Image] Final prompt length: ${finalPrompt.length}`);

  try {
    const imageUrl = await _aimlImage('visuals', finalPrompt, { aspect_ratio: _sizeToRatio(resolvedSize) });
    console.log('[Image] AIML â†’ image ready');
    _recordCreativeAsset(req.user && req.user.id, { kind: imageType || 'image', title: prompt.slice(0, 80), content: { url: imageUrl }, source_route: '/api/generate-image' });
    res.json({ imageUrl });
  } catch (err) {
    console.error('[Image] AIML error:', err.message);
    res.status(500).json({ error: 'Could not generate that image right now. Please try again.' });
  }
});

// â”€â”€ Ads â€” Anthropic (copy) + Anthropicâ†’DALL-E (visual) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used by: Ads
// Receives: { prompt, size, adFormat }
// Steps 1 and 2 (copy + visual prompt) run in parallel via Promise.all
// to minimise total latency before DALL-E is called.
app.post('/api/generate-ad', requireSubIfAuthed, async (req, res) => {
  const { prompt, size, adFormat } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const resolvedSize = size || '1024x1024';
  console.log(`[Ads] format=${adFormat || '?'} â†’ DALL-E size: ${resolvedSize}`);
  console.log('[Ads] Step 1+2 â€” Anthropic (copy + visual prompt) in parallel...');

  const _bizCtx = await _creativeContext(req.user && req.user.id);
  const copySystem = `You are a senior creative advertising director.
Generate ONE complete, platform-specific ad concept based on the brief provided.
Every element must reflect the brand identity in the brief â€” not be generic.
Use the brand tone, colours, audience, and positioning provided. Every word earns its place.
Reply ONLY with valid JSON (no markdown fences, no extra text):
{"title":"...","headline":"...","body":"...","cta":"..."}
- title: ad concept name (max 6 words, brand-specific, not generic)
- headline: punchy, platform-optimised (max 10 words), brand tone and voice specific
- body: benefit-led copy in brand voice (2-3 sentences, no filler, no generic phrases)
- cta: action-driven, brand-appropriate (max 4 words)${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — use it instead of generic copy):\n${_bizCtx.text}` : ''}`;

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
    console.log('[Ads] Step 1+2 â€” copy and visual prompt ready');
  } catch (err) {
    console.error('[Ads] Anthropic error:', err.message);
    return res.status(500).json({ error: 'Failed to generate ad copy' });
  }

  console.log(`[Ads] Step 3 â€” AIML image â†’ ratio: ${_sizeToRatio(resolvedSize)}`);
  let imageUrl = null;
  try {
    imageUrl = await _aimlImage('visuals', dallePrompt, { aspect_ratio: _sizeToRatio(resolvedSize) });
    console.log('[Ads] Step 3 â€” AIML â†’ image ready');
  } catch (err) {
    console.warn('[Ads] Step 3 â€” AIML image failed (non-fatal):', err.message);
  }

  _recordCreativeAsset(req.user && req.user.id, { kind: 'ad', title: adCopy.title || prompt.slice(0, 80), content: { headline: adCopy.headline, body: adCopy.body, cta: adCopy.cta, imageUrl }, source_route: '/api/generate-ad' });
  res.json({
    title:    adCopy.title    || '',
    headline: adCopy.headline || '',
    body:     adCopy.body     || '',
    cta:      adCopy.cta      || '',
    imageUrl,
  });
});

// â”€â”€ Campaign â€” N adset-style variations, each with image + copy â”€
// Used by: Campaign builder
// Receives: { prompt, size }
// Step 1: Anthropic generates N variation objects (title/headline/body/cta/imagePrompt)
// Step 2: All N DALL-E images generated in parallel
// Returns: { variations: [{title,headline,body,cta,imageUrl},...] }
app.post('/api/generate-campaign', requireSubIfAuthed, async (req, res) => {
  const { prompt, size } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const resolvedSize = size || '1024x1024';
  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'campaign_generation');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[Campaign] Credit reservation error:', err.message);
    }
  }

  // â”€â”€ Step 1: Generate all variation copy + image prompts via Anthropic â”€â”€
  console.log('[Campaign] Step 1 â€” Anthropic â†’ generating campaign variations...');
  const _bizCtx = await _creativeContext(req.user && req.user.id);
  let variations;
  try {
    const system = `You are a strategic brand marketing expert and senior creative director.
Generate a complete set of campaign adset-style variation concepts based on the brief.
Each variation must use a genuinely different creative angle â€” not repetitions of the same idea.
The brand identity in the brief must be unmistakable in every variation.
Reply ONLY with a valid JSON array â€” no markdown fences, no extra text, nothing else.
[{"title":"...","headline":"...","body":"...","cta":"...","imagePrompt":"..."},...]
Rules:
- title: variation concept name, max 5 words, unique per variation
- headline: platform-optimised, max 10 words, brand-voice specific
- body: benefit-led copy in brand voice, 2-3 sentences, no generic filler
- cta: direct action CTA, max 4 words
- imagePrompt: 100-180 character DALL-E 3 visual description for this variation.
  CRITICAL: must be 100% text-free. Must reference brand colours from the brief if provided.
  Describes subject, composition, mood, and colour palette. No text/letters/logos/UI in image.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — use it instead of generic copy):\n${_bizCtx.text}` : ''}`;

    const raw     = await _aimlText('campaigns-copy', system, prompt);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      variations = JSON.parse(cleaned);
      if (!Array.isArray(variations) || !variations.length) throw new Error('Empty or non-array');
    } catch (parseErr) {
      console.error('[Campaign] JSON parse failed. Raw output:', raw.slice(0, 300));
      if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { success: false, error: 'parse failed', route: req.path }).catch(() => {});
      return res.status(500).json({ error: 'Failed to parse campaign variations output' });
    }
    console.log(`[Campaign] Step 1 â€” ${variations.length} variations ready`);
  } catch (err) {
    console.error('[Campaign] AIML error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    return res.status(500).json({ error: 'Failed to generate campaign variations' });
  }

  // â”€â”€ Step 2: Generate all images in parallel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log(`[Campaign] Step 2 â€” generating ${variations.length} images in parallel (size: ${resolvedSize})...`);
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

  console.log(`[Campaign] Done â€” ${variationsWithImages.length} variations with images`);
  variationsWithImages.forEach(v => _recordCreativeAsset(req.user && req.user.id, { kind: 'ad', title: v.title || prompt.slice(0, 80), content: v, source_route: '/api/generate-campaign' }));
  if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
  res.json({ variations: variationsWithImages });
});

// â”€â”€ Video â€” placeholder (not implemented) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The frontend handles this locally; no route needed.

// â”€â”€ BrandCore â€” AI Generate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/generate-brandcore', requireSubIfAuthed, async (req, res) => {
  const {
    brandName, description, industry, targetAudience,
    brandType, visualStyle, colorDir, brandFeeling,
    // legacy fields kept for backward compatibility
    type, colorMood, brandStyle, personality
  } = req.body;

  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'brand_voice');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[BrandCore] Credit reservation error:', err.message);
    }
  }

  const effectiveIndustry    = industry    || type         || '';
  const effectiveVisualStyle = visualStyle || brandStyle   || '';
  const effectiveColorDir    = colorDir    || colorMood    || '';
  const effectivePersonality = personality || brandType    || '';

  console.log('[BrandCore] Generating complete brand identity for:', brandName);

  const system = `You are ORIVEN BrandCore AI â€” a world-class brand strategist, creative director, design systems architect, and visual identity specialist.

Your task is to generate a COMPLETE, real brand identity system from a user brief. Every field must be specific, intentional, and commercially believable.

STRICT RULES:
- Never produce generic, placeholder, or clichÃ© output
- Every color must be a purposeful hex code justified by the brand's emotional register, industry, and audience
- Fonts must be real, widely available typefaces with genuine strategic reasoning
- Personality must be exactly 4 distinct, powerful single-word keywords (not phrases)
- Tone of Voice must be exactly one clear sentence describing how the brand speaks
- Positioning must be exactly one sentence: what the brand is, who it serves, and what makes it distinct
- Tagline must be punchy, memorable, and â‰¤ 8 words
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
  "tagline": "string â€” â‰¤8 words, punchy, brand-defining",
  "colorSystem": {
    "primary":   { "hex": "#XXXXXX", "name": "Primary",   "reason": "string â€” why this color for this brand" },
    "secondary": { "hex": "#XXXXXX", "name": "Secondary", "reason": "string â€” why this color for this brand" },
    "accent":    { "hex": "#XXXXXX", "name": "Accent",    "reason": "string â€” why this color for this brand" },
    "text":      { "hex": "#XXXXXX", "name": "Text",      "reason": "string â€” readability and contrast rationale" },
    "support1":  { "hex": "#XXXXXX", "name": "Support 1", "reason": "string â€” usage context" },
    "support2":  { "hex": "#XXXXXX", "name": "Support 2", "reason": "string â€” usage context" }
  },
  "typography": {
    "heading": { "family": "string", "reason": "string â€” why this font matches the brand personality" },
    "body":    { "family": "string", "reason": "string â€” why this font supports readability and brand feel" }
  },
  "brandStrategy": {
    "positioning":    "string â€” exactly one sentence",
    "targetAudience": "string â€” specific psychographic and demographic description",
    "personality":    ["keyword1", "keyword2", "keyword3", "keyword4"],
    "toneOfVoice":   "string â€” exactly one sentence describing how the brand speaks"
  },
  "brandCore": {
    "brandPromise": "string â€” one sharp sentence the customer can hold the brand to",
    "mission":      "string â€” why the brand exists beyond profit",
    "vision":       "string â€” what success looks like in 5 years",
    "values":       ["string", "string", "string"]
  },
  "visualDirection": "string â€” vivid, specific description of the complete visual language and aesthetic direction",
  "logoConcept": {
    "description":  "string â€” strategic rationale: what the logo communicates and why",
    "style":       "string â€” wordmark / lettermark / icon / combination mark and why",
    "imagePrompt": "string â€” specific DALL-E prompt, visual only, no text, no letterforms"
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

Generate the complete BrandCore JSON now. Every field must be specific to this brand â€” no generic placeholders.`;

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
      if (reservation) creditManager.finalizeCreditLog(reservation, 'brand_voice', { success: false, error: 'parse failed', route: req.path }).catch(() => {});
      return res.status(500).json({ error: 'Failed to parse brand identity. Please try again.' });
    }

    console.log('[BrandCore] Generated for:', brandName, '| tagline:', bc.tagline);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'brand_voice', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    res.json(bc);
  } catch (err) {
    console.error('[BrandCore] Generation error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'brand_voice', { success: false, error: err.message, route: req.path }).catch(() => {});
    res.status(500).json({ error: 'Brand generation failed. Please try again.' });
  }
});

// â”€â”€ Brand Check â€” OpenAI Quality Analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/brand-check', requireSubIfAuthed, async (req, res) => {
  const {
    brandName, tagline, colors, fonts, brandPromise, description,
    targetAudience, styleDirection, colorMood, mission, vision,
    personality, toneOfVoice, values, positioning, logoConcept,
  } = req.body;
  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'brand_voice');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[BrandCheck] Credit reservation error:', err.message);
    }
  }

  console.log('[BrandCheck] AIML â†’ analysing brand:', brandName);
  try {
    const system = `You are a world-class brand strategist with 20 years of experience advising high-growth companies, DTC brands, and funded startups.

Your role: Perform an intelligent, quality-driven brand audit. This is NOT a completeness check.
A brand with every field filled in can still score poorly if the positioning is weak, the personality is generic, or the visual direction is inconsistent.

Evaluate quality across ten dimensions:
1. Consistency â€” do all elements reinforce each other?
2. Differentiation â€” does this brand stand out or blend in?
3. Clarity â€” is the positioning instantly understandable?
4. Positioning Strength â€” is it specific, ownable, and meaningful?
5. Audience Alignment â€” does the identity match who it's speaking to?
6. Visual Coherence â€” do colors, typography, and style direction work as a system?
7. Brand Personality Strength â€” is it distinctive or generic?
8. Tone of Voice Alignment â€” does the tone match the personality and audience?
9. Typography Suitability â€” does the font choice reinforce the brand feeling?
10. Color Harmony â€” does the palette feel intentional and emotionally right?

Score calibration:
- 30â€“50: Weak positioning, generic personality, poor alignment
- 51â€“65: Some elements working but lacks coherence or differentiation
- 66â€“79: Solid foundation with clear opportunities to sharpen
- 80â€“89: Strong, coherent identity with minor gaps
- 90â€“100: Exceptional clarity, differentiation, and system coherence

Return ONLY valid JSON â€” no markdown, no extra text â€” matching this exact structure:
{
  "score": number,
  "professionalLevel": "string",
  "summary": "string",
  "strengths": ["string"],
  "opportunities": ["string"],
  "recommendations": ["string"]
}

Rules:
- score: integer 0â€“100 based entirely on quality, not completeness. Be honest â€” inflation destroys trust.
- professionalLevel: one of "developing", "emerging", "established", "advanced", "premium"
- summary: 2â€“3 sentences. The most important strategic truth about this brand. Direct, warm, insightful â€” write as a trusted advisor to a founder, not a report generator.
- strengths: 3â€“5 items. Specific and concrete. Reference actual brand elements. No vague praise.
- opportunities: 3â€“5 items. Where recognition is being left on the table. Frame as strategic guidance. Be specific about what to improve and why it matters for audience connection or market differentiation.
- recommendations: 3â€“5 items. Concrete, prioritized actions the brand owner should take next. Most impactful first. Each must be immediately actionable.
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

    const userMsg = `Perform a comprehensive brand audit for the following brand identity. Evaluate quality rigorously â€” not just whether fields are filled in. Return your full strategic analysis as JSON.\n\n${lines.join('\n')}`;

    const raw = await _aimlText('brand-core', system, userMsg, { max_tokens: 1200 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[BrandCheck] JSON parse failed');
      if (reservation) creditManager.finalizeCreditLog(reservation, 'brand_voice', { success: false, error: 'parse failed', route: req.path }).catch(() => {});
      return res.status(500).json({ error: 'Failed to parse brand check output' });
    }

    console.log('[BrandCheck] AIML â†’ analysis ready for:', brandName, '| Score:', report.score);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'brand_voice', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    res.json(report);
  } catch (err) {
    console.error('[BrandCheck] AIML error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'brand_voice', { success: false, error: err.message, route: req.path }).catch(() => {});
    res.status(500).json({ error: 'Failed to run brand check' });
  }
});

// â”€â”€ Competitor Intelligence v2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
Keep every label short â€” 2â€“6 words max. Only the "insight" field may be longer (3â€“4 sentences).

Return ONLY valid JSON with zero markdown, matching this exact structure:

{
  "competitor": {
    "name": "Brand Name",
    "industry": "Short industry label",
    "positioning": "3â€“5 word positioning statement",
    "tone": "Single word",
    "audience": "2â€“4 word description",
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
    "competitorOwns": "2â€“5 word phrase",
    "userOwns": "2â€“5 word phrase",
    "overlap": ["word1", "word2", "word3"]
  },
  "differentiation": {
    "theyOwn": "2â€“5 word phrase",
    "youOwn": "2â€“5 word phrase",
    "opportunity": "2â€“5 word phrase",
    "risk": "2â€“5 word phrase"
  },
  "insight": "3â€“4 sentence strategic insight. Direct, specific, and actionable.",
  "verdict": {
    "strength": "2â€“4 word phrase",
    "weakness": "2â€“4 word phrase",
    "advantage": "2â€“4 word phrase",
    "position": "2â€“5 word phrase"
  }
}

Rules:
- userBrand fields must reflect the provided Brand Core data. If no data: use strategic defaults.
- Be specific to the actual brand â€” no generic filler.
- All values are scannable at a glance.`;

  const userMsg = `Competitor URL: ${url}\n\n${bcLines.length ? `User's Brand Core:\n${bcLines.join('\n')}` : 'No brand core provided â€” use strategic defaults for the user brand.'}`;

  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'competitor_analysis');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[CompetitorIntel] Credit reservation error:', err.message);
    }
  }

  try {
    const raw = await _aimlText('competitor-intel', system, userMsg, { max_tokens: 1800 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[CompetitorIntel] JSON parse failed:', cleaned.slice(0, 200));
      if (reservation) creditManager.finalizeCreditLog(reservation, 'competitor_analysis', { success: false, error: 'parse failed', route: req.path }).catch(() => {});
      return res.status(500).json({ error: 'Failed to parse competitor analysis' });
    }

    console.log('[CompetitorIntel] Analysis complete for:', url);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'competitor_analysis', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    res.json(report);
  } catch (err) {
    console.error('[CompetitorIntel] AIML error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'competitor_analysis', { success: false, error: err.message, route: req.path }).catch(() => {});
    res.status(500).json({ error: 'Failed to run competitor intelligence analysis' });
  }
});

// â”€â”€ Stripe checkout session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/create-checkout-session', async (req, res) => {
  const { plan, userId, userEmail, source } = req.body;

  console.log(`[Checkout] â–¶ Request received â€” plan: ${plan}, userId: ${userId}, email: ${userEmail || '(none)'}`);

  if (!plan || !userId) {
    console.error('[Checkout] âŒ Missing required fields â€” plan:', plan, 'userId:', userId);
    return res.status(400).json({ error: 'plan and userId are required' });
  }

  const validPlans = ['starter', 'creator', 'professional'];
  if (!validPlans.includes(plan)) {
    console.error(`[Checkout] âŒ Unrecognised plan name: "${plan}" â€” expected one of: ${validPlans.join(', ')}`);
    return res.status(400).json({ error: `Unrecognised plan: ${plan}` });
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    console.error(`[Checkout] âŒ No price ID configured for plan "${plan}"`);
    console.error('[Checkout]    STRIPE_PRICE_' + plan.toUpperCase(), '= (NOT SET in environment)');
    console.error('[Checkout]    Fix: add this variable in the Render dashboard and redeploy');
    return res.status(400).json({ error: `No price configured for plan: ${plan}. Contact support.` });
  }

  const frontendUrl = FRONTEND_URL;
  // All checkout cancels return to /app â€” hard paywall will re-appear for unpaid users.
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

    console.log(`[Checkout] âœ… Session created`);
    console.log(`[Checkout]    Session ID:   ${session.id}`);
    console.log(`[Checkout]    userId:       ${userId}`);
    console.log(`[Checkout]    plan:         ${plan}`);
    console.log(`[Checkout]    priceId:      ${priceId}`);
    console.log(`[Checkout]    success_url:  ${frontendUrl}/app?success=true`);
    console.log(`[Checkout]    cancel_url:   ${frontendUrl}${cancelPath}`);
    res.json({ url: session.url });
  } catch (err) {
    // Log every available field on Stripe errors for easy debugging
    console.error('[Checkout] âŒ Stripe error creating session');
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

// â”€â”€ GET /api/get-subscription â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ POST /api/schedule-plan-change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Upgrading from free to paid â€” tell client to use checkout
  if (currentPlan === 'free' && plan !== 'free') {
    return res.json({ requiresCheckout: true });
  }

  // Cancelling to free â€” schedule cancel_at_period_end on Stripe, fallback to immediate DB update
  if (plan === 'free') {
    if (!subId) {
      // No Stripe subscription on record â€” just update DB immediately
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
      // Stripe failed (invalid/missing sub) â€” downgrade in DB immediately
      console.error('[SchedulePlan] Stripe cancel failed, falling back to DB downgrade:', err.message);
      await supabaseAdmin.from('profiles')
        .update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null, stripe_subscription_id: null })
        .eq('id', user.id);
      return res.json({ ok: true, subscription_status: 'free', pending_plan: null, pending_plan_date: null });
    }
  }

  // Switching between paid plans â€” update Stripe subscription, fallback to DB-only change
  const newPriceId = PRICE_IDS[plan];
  if (!newPriceId) return res.status(400).json({ error: 'Price not configured for plan: ' + plan });

  if (!subId) {
    // No Stripe subscription â€” apply plan change directly in DB (edge case: manual override)
    await supabaseAdmin.from('profiles')
      .update({ subscription_status: plan, pending_plan: null, pending_plan_date: null })
      .eq('id', user.id);
    console.log('[SchedulePlan] No sub ID â€” applied plan directly in DB:', plan);
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
    // Stripe failed â€” apply plan change directly in DB so the user isn't stuck
    console.error('[SchedulePlan] Stripe update failed, falling back to DB plan change:', err.message);
    await supabaseAdmin.from('profiles')
      .update({ subscription_status: plan, pending_plan: null, pending_plan_date: null })
      .eq('id', user.id);
    return res.json({ ok: true, subscription_status: plan });
  }
});

// â”€â”€ POST /api/cancel-plan-change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ GET /api/get-usage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ POST /api/increment-usage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Body: { count?: number }  â€” credits consumed (default 1, capped at 20)
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

// -- GET /api/credits/status ------------------------------------
// Real, backend-authoritative credit balance -- the single source of truth
// consumed by usage.js (sidebar badge) and settings.js (Subscription panel).
app.get('/api/credits/status', requireSubscription, async (req, res) => {
  try {
    const status = await creditManager.getCreditStatus(req.user.id);
    res.json(status);
  } catch (err) {
    console.error('[CreditsStatus] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch credit status' });
  }
});

// -- PATCH /api/profile/timezone ---------------------------------
// Fire-and-forget from the client whenever the browser's IANA timezone
// differs from what's stored -- feeds the once-per-local-day daily briefing.
// Body: { timezone: "Europe/Berlin" }
app.patch('/api/profile/timezone', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const tz = req.body && req.body.timezone;
  if (!tz || typeof tz !== 'string' || tz.length > 100) {
    return res.status(400).json({ error: 'A valid IANA timezone string is required' });
  }
  try {
    await supabaseAdmin.from('profiles').upsert({ id: user.id, timezone: tz }, { onConflict: 'id' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Timezone] Error:', err.message);
    res.status(500).json({ error: 'Failed to save timezone' });
  }
});

// -- Priority Support chat (Professional plan only) --------------
// GET returns the caller's own flat message thread; POST appends a user
// message and emails a notification (email is notification-only, not the
// reply transport -- replies land back in-app via /api/support/admin-reply).
app.get('/api/support/messages', requireSubscription, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('support_messages').select('id, sender, body, created_at')
      .eq('user_id', req.user.id).order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (err) {
    console.error('[Support] GET messages error:', err.message);
    res.status(500).json({ error: 'Failed to load support messages' });
  }
});

app.post('/api/support/messages', requireSubscription, async (req, res) => {
  const body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  if (body.length > 4000) return res.status(400).json({ error: 'Message is too long' });
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('subscription_status, email').eq('id', req.user.id).maybeSingle();
    if (!profile || profile.subscription_status !== 'professional') {
      return res.status(403).json({ error: 'Priority Support is a Professional plan feature', code: 'PLAN_REQUIRED' });
    }
    const { error: insertErr } = await supabaseAdmin.from('support_messages')
      .insert({ user_id: req.user.id, sender: 'user', body });
    if (insertErr) throw insertErr;

    // Email is notification-only -- best-effort, never blocks the response.
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      _smtpTransporter().sendMail({
        from:    process.env.SMTP_FROM || `ORIVEN <${process.env.SMTP_USER}>`,
        to:      'studio.oriven@outlook.com',
        subject: `[Priority Support] New message from ${profile.email || req.user.id}`,
        text:    `${profile.email || req.user.id} (Professional plan) sent a Priority Support message:\n\n${body}`,
      }).catch((e) => console.warn('[Support] Notification email failed:', e.message));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Support] POST message error:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Minimal admin-reply path -- the seed of a future admin dashboard, not the
// dashboard itself. Gated by a static env allowlist (reuses existing auth,
// no new admin-auth system) since Oriven support is currently a one-person
// operation; callable directly (curl/Postman) until a real UI exists.
app.post('/api/support/admin-reply', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!adminIds.includes(user.id)) return res.status(403).json({ error: 'Not authorized' });
  const targetUserId = req.body && req.body.userId;
  const body = (req.body && req.body.body || '').trim();
  if (!targetUserId || !body) return res.status(400).json({ error: 'userId and body are required' });
  try {
    const { error } = await supabaseAdmin.from('support_messages')
      .insert({ user_id: targetUserId, sender: 'admin', body });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[Support] Admin reply error:', err.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// â”€â”€ POST /api/signup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // Create user â€” email_confirm:true means Supabase won't block signInWithPassword
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

  // Upsert profile row â€” using upsert (not insert) so a Supabase auth trigger that
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

  // Send verification email (best-effort â€” signup succeeds even if email fails)
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
        text:    `Hi ${firstName},\n\nVerify your email:\n${verifyUrl}\n\nThis link is valid for 14 days.\n\nâ€” ORIVEN`
      });
      console.log('[Signup] Verification email sent to', email);
    } catch (emailErr) {
      console.error('[Signup] Verification email failed (non-fatal):', emailErr.message);
    }
  } else {
    console.warn('[Signup] SMTP not configured â€” skipping verification email');
  }

  console.log('[Signup] âœ… User created:', user.id, email);
  res.json({ ok: true, userId: user.id });
});

// â”€â”€ POST /api/verify-email â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// No auth required â€” the token itself is the credential.
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

  console.log('[VerifyEmail] âœ… Email verified for user:', data.id);
  res.json({ ok: true });
});

// â”€â”€ POST /api/resend-verification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Requires auth. Generates a fresh token and resends the email.
app.post('/api/resend-verification', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return res.status(503).json({ error: 'Email service not configured â€” set SMTP_USER and SMTP_PASS' });
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
      text:    `Hi ${firstName},\n\nVerify your email:\n${verifyUrl}\n\nThis link is valid for 14 days.\n\nâ€” ORIVEN`
    });
    console.log('[ResendVerify] âœ… Sent to', toEmail);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ResendVerify] Failed:', err.message);
    res.status(500).json({ error: 'Could not send that email right now. Please try again shortly.' });
  }
});

// â”€â”€ POST /api/send-invite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Sends a team invite email via Outlook SMTP.
// Body: { name, email, role, message, workspaceName }
// -- GET /api/team/members -----------------------------------------
// Lists the caller's own team (pending + accepted seats only -- revoked
// seats don't count against the limit and aren't shown).
app.get('/api/team/members', requireSubscription, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('team_members')
      .select('id, invitee_name, invitee_email, role, status, created_at')
      .eq('owner_user_id', req.user.id)
      .in('status', ['pending', 'accepted'])
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ members: data || [] });
  } catch (err) {
    console.error('[Team] GET members error:', err.message);
    res.status(500).json({ error: 'Could not load team members' });
  }
});

// -- DELETE /api/team/members/:id -----------------------------------
app.delete('/api/team/members/:id', requireSubscription, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('team_members')
      .update({ status: 'revoked' })
      .eq('id', req.params.id)
      .eq('owner_user_id', req.user.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Team member not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Team] DELETE member error:', err.message);
    res.status(500).json({ error: 'Could not remove that team member' });
  }
});

app.post('/api/send-invite', requireSubscription, async (req, res) => {
  const { name, email, role, message, workspaceName } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  // Seat limit -- the single source of truth for plan seat counts is
  // creditManager.PLAN_TEAM_SEATS (starter:1, creator:1, professional:10),
  // the same config the credit system itself uses. The UI shows the same
  // numbers from plans.js's ORIVEN_PLANS[plan].teamMembers, kept in sync
  // manually with this table -- this is the real, server-side enforcement
  // that actually blocks a 2nd Starter/Creator seat or an 11th Professional one.
  try {
    const { data: profile } = await supabaseAdmin.from('profiles').select('subscription_status').eq('id', req.user.id).maybeSingle();
    const plan = (profile && profile.subscription_status) || 'free';
    const seatLimit = creditManager.PLAN_TEAM_SEATS[plan] || 0;
    const { count, error: countErr } = await supabaseAdmin.from('team_members')
      .select('id', { count: 'exact', head: true })
      .eq('owner_user_id', req.user.id)
      .in('status', ['pending', 'accepted']);
    if (countErr) throw countErr;
    // +1 accounts for the account owner, who is always seat 1 -- e.g.
    // Professional's "up to 10 team members" means 10 total including the owner.
    if ((count || 0) + 1 >= seatLimit) {
      return res.status(403).json({ error: `Your ${plan} plan allows up to ${seatLimit} team member${seatLimit === 1 ? '' : 's'} (including you). Upgrade to invite more.`, code: 'TEAM_SEAT_LIMIT' });
    }
  } catch (err) {
    console.error('[Invite] Seat limit check error:', err.message);
    return res.status(500).json({ error: 'Could not verify your team seat limit right now.' });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    console.error('[Invite] âŒ SMTP credentials not configured â€” set SMTP_USER and SMTP_PASS in .env');
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
      text:    `Hi ${recipientName},\n\nYou've been invited to join "${senderWorkspace}" on ORIVEN as a ${roleLabel}.\n\nVisit https://orivenai.com/app to accept.\n\nâ€” The ORIVEN Team`
    });

    const { data: memberRow, error: insertErr } = await supabaseAdmin.from('team_members').insert({
      owner_user_id: req.user.id, invitee_email: email, invitee_name: name || null, role: roleLabel, status: 'pending',
    }).select('id, invitee_name, invitee_email, role, status, created_at').maybeSingle();
    if (insertErr) console.error('[Invite] Email sent but DB insert failed (non-fatal, seat count may under-report):', insertErr.message);

    console.log(`[Invite] âœ… Invite sent to ${email} (role: ${roleLabel}, workspace: ${senderWorkspace})`);
    res.json({ ok: true, member: memberRow || null });
  } catch (err) {
    console.error('[Invite] âŒ Failed to send invite email:', err.message);
    res.status(500).json({ error: 'Could not send that invite right now. Please try again.' });
  }
});

// â”€â”€ AI Logo Generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Receives: { brandName, description, logoStyle, styleDirection, colorPalette }
// Returns: { imageUrl, prompt }
app.post('/api/generate-logo', requireSubIfAuthed, async (req, res) => {
  let { brandName, description, logoStyle, styleDirection, colorPalette } = req.body;

  // Epic 2 â€” never ask twice: fall back to the Business Brain before failing.
  if ((!brandName || !description || !colorPalette) && req.user) {
    const brandCore = await _getBrandCore(req.user.id).catch(() => null);
    const { data: profile } = await supabaseAdmin.from('business_profile').select('company_name,description').eq('user_id', req.user.id).maybeSingle();
    brandName    = brandName    || (brandCore && brandCore.name) || (profile && profile.company_name);
    description  = description  || (brandCore && brandCore.description) || (profile && profile.description);
    colorPalette = colorPalette || (brandCore && brandCore.colors);
  }
  if (!brandName) return res.status(400).json({ error: 'brandName is required' });

  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'image_generation');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[LogoGen] Credit reservation error:', err.message);
    }
  }

  console.log(`[LogoGen] Generating AI logo for: ${brandName}`);

  // Use Anthropic to craft an optimised DALL-E logo prompt
  const system = `You are a logo design expert and art director.
Your job is to write a precise DALL-E 3 prompt that will generate a professional brand logo concept.

Rules:
- Output is 120â€“250 characters â€” a single, vivid visual description
- Describe a logo SYMBOL or MARK â€” geometric shapes, abstract forms, icons, emblems â€” never letters or text
- Describe the specific visual form: shape, geometry, composition, colour treatment
- Reference the style direction and logo type requested
- End with: ", isolated on white background, vector-style clean design, professional brand identity mark"
- CRITICAL: Do NOT include ANY readable text, letters, words, numbers, or typographic elements of any kind
- Do NOT include the brand name, initials, taglines, or ANY characters that form words
- DALL-E cannot reliably render text â€” the output must be a pure visual symbol with zero written elements
- Do NOT say "Generate" or "Create" â€” just describe what is seen in the image
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
    console.log(`[LogoGen] âœ… Logo generated for: ${brandName}`);
    _recordCreativeAsset(req.user && req.user.id, { kind: 'logo', title: brandName, content: { url: imageUrl, prompt: imagePrompt }, source_route: '/api/generate-logo' });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'image_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    res.json({ imageUrl, prompt: imagePrompt });
  } catch (err) {
    console.error('[LogoGen] Error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'image_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    res.status(500).json({ error: 'Could not generate that logo right now. Please try again.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// UGC â€” AI VIDEO GENERATION (AIML / Kling)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Static creator presets â€” displayed in the UGC avatar picker.
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

// â”€â”€ GET /api/ugc-avatars â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/ugc-avatars', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ avatars: UGC_PRESET_AVATARS });
});

// â”€â”€ GET /api/ugc-voices â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/ugc-voices', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ voices: UGC_PRESET_VOICES });
});

console.log("UGC ROUTE REGISTERED");

// â”€â”€ POST /api/generate-ugc â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  console.log('[UGC] Received â†’ adFeeling:', adFeeling, '| adGoal:', adGoal, '| format:', format, '| aspect:', aspectRatio, '| scriptMode:', customScript ? 'custom' : 'ai');

  // â”€â”€ Cinematic brief registry â€” each style is a full creative direction â”€â”€
  const CREATOR_BRIEFS = {
    startup_founder: {
      context:   'A bold startup founder speaking directly from their workspace â€” authentic, disruptive, has been in the trenches and knows the audience\'s exact pain point.',
      hookStyle: 'Lead with the problem the audience already knows. One line. Then flip it hard.',
      language:  'Founder energy: "we built this", "shipped it last week", "changed the way I work completely"',
      ctaStyle:  'Direct and urgent: "try it now", "link in bio", "ship faster starting today"',
    },
    podcast_creator: {
      context:   'A trusted podcast host mid-recommendation â€” relaxed, genuinely enthusiastic, talking like they\'re in the middle of a real conversation with a close friend.',
      hookStyle: 'Start mid-story or mid-thought. Like you jumped into a conversation already in progress.',
      language:  'Warm and authentic: "honestly", "I\'ve been using this for months now", "you need to hear about this"',
      ctaStyle:  'Soft confidence: "worth checking out", "grab the link below", "you\'ll thank me later"',
    },
    fitness_creator: {
      context:   'A results-obsessed fitness creator in their element â€” pumped, direct, every single word carries physical energy and drive.',
      hookStyle: 'Open with a transformation or a challenge. Make them feel the intensity in the first sentence.',
      language:  'Active and relentless: "gains", "no excuses", "I don\'t stop until", "results speak for themselves"',
      ctaStyle:  'No hesitation: "get it now", "stop waiting", "your move"',
    },
    luxury_influencer: {
      context:   'A luxury lifestyle creator speaking from a premium environment â€” measured, deliberate, every word is intentional and earns its place.',
      hookStyle: 'Paint the aspirational scene first. Let the audience want the life before they hear anything about the product.',
      language:  'Elevated and sparse: "exceptional", "the kind of quality that stays with you", "not for everyone â€” and that\'s the point"',
      ctaStyle:  'Restrained and exclusive: "discover it", "if you know, you know", "for those who notice the difference"',
    },
    tech_reviewer: {
      context:   'An authoritative tech reviewer who has tested everything, cuts through the noise, and only recommends what genuinely works.',
      hookStyle: 'Lead with your boldest claim immediately, then back it up with specifics. Credibility through detail.',
      language:  'Informed and precise: "tested this for 30 days straight", "here\'s what actually surprised me", "the feature that changes everything"',
      ctaStyle:  'Confident endorsement: "worth every penny", "link in the description", "upgraded and never looked back"',
    },
    street_creator: {
      context:   'A spontaneous street creator filming on-the-go â€” raw, unfiltered energy, just discovered something and physically cannot wait to share it.',
      hookStyle: 'React first. "Okay waitâ€”" or "I need to stop and talk about this right now" â€” pull them into the urgency.',
      language:  'Raw and viral: "no cap", "lowkey obsessed", "fr fr", "I can\'t believe this actually works"',
      ctaStyle:  'Impulsive and urgent: "grab it fr", "link in bio right now", "you\'re welcome in advance"',
    },
    vacation_creator: {
      context:   'A travel creator on location â€” relaxed, fully in their element, makes the audience want the experience before they even know what the product is.',
      hookStyle: 'Pull them into the scene. Set where you are and how it feels before revealing anything.',
      language:  'Lifestyle and discovery: "couldn\'t leave without it", "this changed how I travel", "the vibe here is completely different"',
      ctaStyle:  'Aspirational close: "take me back", "get yours before they\'re gone", "you genuinely deserve this"',
    },
    office_creator: {
      context:   'A sharp professional in a clean modern workspace â€” focused, outcome-driven, respects the audience\'s time and treats them as intelligent adults.',
      hookStyle: 'Name the professional pain point in the first sentence. Time is the asset â€” get to the solution fast.',
      language:  'Direct and measurable: "saves me two hours every day", "our entire team switched", "the ROI showed up immediately"',
      ctaStyle:  'Measured and clear: "try it free", "book the demo", "your workflow will thank you"',
    },
  };

  let reservation;
  try {
    reservation = await creditManager.reserveCredits(user, 'video_generation');
  } catch (err) {
    if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
    console.warn('[UGC] Credit reservation error:', err.message);
  }

  // â”€â”€ Step 1: Script â€” use provided or generate with AI â”€â”€â”€â”€â”€â”€â”€â”€
  let script;
  if (customScript && customScript.trim()) {
    script = customScript.trim();
    console.log('[UGC] Using custom script (', script.length, 'chars )');
  } else {
    try {
      // Ad feeling â†’ directorial instruction (energy, pacing, sentence structure)
      const feelingInstruction = {
        viral:       'Make this spread. Rapid-fire energy, punchy hooks designed to be shared. Short sentences. Bold, declarative statements.',
        cinematic:   'Write like a film director narrating a moment â€” evocative, visual language. Every sentence paints a picture. Slow and deliberate. Emotionally charged.',
        emotional:   'Lead with heart. Personal story, raw honesty, vulnerability that earns real connection. Make them feel something before you ask them to do anything.',
        aggressive:  'No warmup. Direct, hard-hitting, zero fluff. Bold claims, urgency in every line. This is a closer â€” make them feel like they\'re missing out right now.',
        luxury:      'Nothing is rushed. Sparse, aspirational language where every word earns its place. The silence between sentences matters. Elevated throughout.',
        startup:     'Scrappy and exciting. Disruptive framing, founder-level conviction, the energy of someone who genuinely believes they\'re changing something.',
        friendly:    'Warm, genuine, completely likeable. Feels exactly like a trusted friend giving an honest recommendation with zero agenda.',
        high_energy: 'Maximum energy from the first word. Fast pace, exclamation, nonstop forward momentum. There is no gear below fifth.',
      }[adFeeling] || 'Write in a genuine, natural first-person voice with authentic energy.';

      // Ad goal â†’ hook angle + CTA direction
      const goalInstruction = {
        sales:     'GOAL: Drive immediate purchase. Build desire fast, remove hesitation, close with urgency. CTA should push "buy now", "get it", "grab yours".',
        awareness: 'GOAL: Build brand recall and desire. Plant the seed â€” intrigue over hard sell. CTA should invite discovery: "check it out", "learn more", "look it up".',
        downloads: 'GOAL: Drive app installs. Highlight how fast and easy it is to get started. CTA should push "download it", "get the app", "it\'s free to start".',
        clicks:    'GOAL: Pull to a link or page. Create enough curiosity that clicking feels inevitable. CTA should be "link in bio", "tap the link", "click below".',
        launch:    'GOAL: Announce a new launch. Create FOMO and excitement for something that just dropped. CTA should signal scarcity or newness: "just launched", "early access", "be first".',
      }[adGoal] || '';

      // Build brand context block â€” prefer new BrandCore fields, fall back to legacy fields
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

      const _bizCtx = await _creativeContext(user.id);
      const system = `You are an expert UGC ad scriptwriter and creative director for TikTok, Instagram Reels, and YouTube Shorts.
${brandLines.length ? '\nBRAND CONTEXT â€” write as if you live inside this brand:\n' + brandLines.map(l => '- ' + l).join('\n') : ''}
${_bizCtx ? '\nBUSINESS KNOWLEDGE (real, stored data about this business):\n' + _bizCtx.text + '\n' : ''}
AD FEELING â€” apply this to every sentence (HIGHEST PRIORITY): ${feelingInstruction}
${goalInstruction ? '\nAD GOAL â€” shape your hook angle and CTA around this: ' + goalInstruction : ''}
Script rules:
- Open with a strong attention-grabbing hook that stops the scroll in the first 3 seconds
- Speak in a genuine first-person voice as an authentic creator living in this brand's world
- Weave in the brand's vocabulary and tone naturally â€” not as a checklist, as character
- End with a clear, natural call-to-action aligned with the goal above
- First person only â€” no "you should" constructions at the start
- No stage directions, brackets, parenthetical actions, or scene descriptions
- Output ONLY the spoken script â€” nothing else, no titles, no labels
- Target 8â€“12 sentences for a 30â€“45 second read`;

      const userMsg = [
        'Write a UGC ad script.',
        adContext ? `Additional context: ${adContext}` : '',
        `Ad feeling: ${adFeeling || 'viral'}`,
        adGoal    ? `Ad goal: ${adGoal}` : '',
        '',
        'Output ONLY the spoken script.',
      ].filter(Boolean).join('\n');

      script = (await _aimlText('ugc-script', system, userMsg, { max_tokens: 1024 })).trim();
      if (!script) {
        if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: 'empty script', route: req.path }).catch(() => {});
        return res.status(500).json({ error: 'AIML returned an empty script' });
      }
      console.log('[UGC] Script generated (', script.length, 'chars ) | feeling:', adFeeling, '| goal:', adGoal || 'none');
    } catch (err) {
      console.error('[UGC] Script generation error:', err.message);
      if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
      return res.status(500).json({ error: 'Could not write that script right now. Please try again.' });
    }
  }

  // â”€â”€ Step 2: Generate video via AIML (Kling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    _recordCreativeAsset(user.id, { kind: 'ugc', title: (adContext || script).slice(0, 80), content: { script, generationId }, source_route: '/api/generate-ugc' });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { provider: 'aiml', model: 'kling', success: true, route: req.path }).catch(() => {});
    return res.json({ ok: true, videoId: generationId, status: 'processing' });
  } catch (err) {
    console.error('[UGC] AIML video submission error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    return res.status(500).json({ error: 'Could not submit that video right now. Please try again.' });
  }
});

// â”€â”€ POST /api/generate-ugc-script â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Standalone script-only endpoint (used by test page / direct integrations).
// Aligned with the simplified UGC flow â€” no product/niche/audience required.
app.post('/api/generate-ugc-script', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { creatorStyle, adFeeling, brandName, brandDesc } = req.body || {};

  const CREATOR_BRIEFS = {
    startup_founder:   { context: 'A bold startup founder speaking directly from their workspace â€” authentic, disruptive, knows the audience\'s pain point firsthand.', hookStyle: 'Lead with the problem the audience already knows. One line. Then flip it.', language: 'Founder energy: "we built this", "shipped it", "changed the way I work"', ctaStyle: 'Direct and urgent: "try it now", "link in bio", "ship faster today"' },
    podcast_creator:   { context: 'A trusted podcast host mid-recommendation â€” relaxed, genuine, talking like they\'re in conversation with a close friend.', hookStyle: 'Start mid-story or mid-thought. Like jumping into a conversation already in progress.', language: 'Warm: "honestly", "I\'ve been using this for months", "you need to hear this"', ctaStyle: 'Soft confidence: "worth checking out", "grab the link", "you\'ll thank me"' },
    fitness_creator:   { context: 'A results-obsessed fitness creator in their element â€” pumped, direct, every word carries physical energy.', hookStyle: 'Open with a transformation claim or challenge. Make them feel the intensity.', language: 'Active: "gains", "no excuses", "results don\'t lie"', ctaStyle: 'No hesitation: "get it now", "stop waiting", "your move"' },
    luxury_influencer: { context: 'A luxury lifestyle creator in a premium environment â€” measured, deliberate, every word is intentional.', hookStyle: 'Paint the aspirational scene first. Let the audience want the life before the product.', language: 'Elevated: "exceptional", "the kind of quality that stays with you", "not for everyone"', ctaStyle: 'Restrained: "discover it", "if you know, you know", "for those who notice"' },
    tech_reviewer:     { context: 'An authoritative tech reviewer who only recommends what genuinely works. Credibility through specificity.', hookStyle: 'Lead with the boldest claim immediately, then back it up with detail.', language: 'Precise: "tested for 30 days", "here\'s what surprised me", "the feature that matters"', ctaStyle: 'Confident: "worth every penny", "link in description", "never looked back"' },
    street_creator:    { context: 'A spontaneous street creator filming on-the-go â€” raw, just discovered something and can\'t wait to share it.', hookStyle: 'React first. "Okay waitâ€”" or "I need to talk about this right now".', language: 'Raw: "no cap", "lowkey obsessed", "fr fr", "can\'t believe this works"', ctaStyle: 'Urgent: "grab it fr", "link in bio now", "you\'re welcome"' },
    vacation_creator:  { context: 'A travel creator on location â€” relaxed, makes the audience want the experience before they know the product.', hookStyle: 'Set the scene first. Pull them into where you are and how it feels.', language: 'Lifestyle: "couldn\'t leave without it", "changed how I travel", "the vibe is different"', ctaStyle: 'Aspirational: "get yours", "you deserve this", "take me back"' },
    office_creator:    { context: 'A sharp professional in a clean workspace â€” focused, outcome-driven, respects the audience\'s time.', hookStyle: 'Name the pain point in the first sentence. Get to the solution fast.', language: 'Measurable: "saves me two hours daily", "whole team switched", "ROI showed up immediately"', ctaStyle: 'Clear: "try it free", "book the demo", "your workflow will thank you"' },
  };

  const feelingInstruction = {
    viral:       'Make this spread. Rapid-fire energy, punchy hooks designed to be shared. Short sentences, bold statements.',
    cinematic:   'Write like a film director â€” evocative, visual language. Every sentence paints a picture. Slow, deliberate, emotionally charged.',
    emotional:   'Lead with heart. Raw honesty and vulnerability that earns real connection.',
    aggressive:  'No warmup. Direct, hard-hitting, urgency in every line. Make them feel like they\'re missing out right now.',
    luxury:      'Nothing is rushed. Sparse, aspirational language where every word earns its place.',
    startup:     'Scrappy and exciting. Disruptive framing, founder conviction, energy of someone changing something.',
    friendly:    'Warm, genuine, completely likeable â€” a trusted friend giving an honest recommendation.',
    high_energy: 'Maximum energy from the first word. Fast pace, nonstop forward momentum. No lower gear.',
  }[adFeeling] || 'Write in a genuine, natural first-person voice.';

  const brief = CREATOR_BRIEFS[creatorStyle] || {};
  const _bizCtx = await _creativeContext(user.id);

  const system = `You are an expert UGC ad scriptwriter and creative director for TikTok, Instagram Reels, and YouTube Shorts.

CREATOR PROFILE: ${brief.context || 'An authentic creator speaking directly to camera.'}
HOOK STYLE: ${brief.hookStyle || 'Open with a strong attention-grabbing hook.'}
LANGUAGE GUIDE: ${brief.language || 'Conversational, first-person, authentic.'}
CTA STYLE: ${brief.ctaStyle || 'End with a clear, natural call-to-action.'}
${_bizCtx ? '\nBUSINESS KNOWLEDGE (real, stored data about this business):\n' + _bizCtx.text + '\n' : ''}
AD FEELING (HIGHEST PRIORITY): ${feelingInstruction}

Rules: first-person only, no stage directions, no brackets, output ONLY the spoken script, 8â€“12 sentences.`;

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
    _recordCreativeAsset(user.id, { kind: 'script', title: (brandName || creatorStyle || 'UGC script').slice(0, 80), content: { text: script }, source_route: '/api/generate-ugc-script' });
    return res.json({ ok: true, script });
  } catch (err) {
    console.error('[UGC] Script generation error:', err.message);
    return res.status(500).json({ error: 'Could not generate that script right now. Please try again.' });
  }
});

// â”€â”€ POST /api/generate-ugc-video â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    return res.status(500).json({ error: 'Could not start that video generation right now. Please try again.' });
  }
});

// â”€â”€ GET /api/ugc-video-status/:videoId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


// â”€â”€ POST /api/video-ads/generate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Three modes: 'ai' (Anthropic builds prompt) | 'script' (user prompt) | 'image' (image-to-video)
// Provider: AIML API via aimlProvider (AIML_API_KEY).
// API key is read from env only â€” never hardcoded or sent to frontend.
app.post('/api/video-ads/generate', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { mode, brand, product, audience, goal, style, script, imageUrl, imageUrl2, prompt, length, brandCore, customPrompt } = req.body || {};

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Video Ads is not configured â€” set AIML_API_KEY in environment variables.' });
  }

  let reservation;
  try {
    reservation = await creditManager.reserveCredits(user, 'video_generation');
  } catch (err) {
    if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
    console.warn('[VideoAds] Credit reservation error:', err.message);
  }

  const _rawDuration = Number(String(length || '5').replace(/[^0-9]/g, '')) || 5;
  const normDuration = _rawDuration <= 7 ? 5 : 10;
  const t1 = Math.round(normDuration * 0.33);
  const t2  = Math.round(normDuration * 0.72);

  // â”€â”€ Image-to-video mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      console.log('[VideoAds/image] Generation started:', result.generationId, 'â€” user:', user.id);
      _recordCreativeAsset(user.id, { kind: 'video', title: 'Image-to-video', content: { generationId: result.generationId }, source_route: '/api/video-ads/generate' });
      if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
      return res.json({ generationId: result.generationId, status: 'queued' });
    } catch (err) {
      console.error('[VideoAds/image] error:', err.message);
      if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
      return res.status(500).json({ error: err.message });
    }
  }

  // â”€â”€ Script mode â€” user provides the creative brief directly â”€â”€
  if (mode === 'script') {
    if (!script || !script.trim()) return res.status(400).json({ error: 'A script or creative brief is required.' });
    console.log('[VideoAds/script] prompt:', script.trim().slice(0, 120));
    try {
      const result = await aiml.generateVideo(script.trim(), { duration: normDuration, aspect_ratio: '16:9' });
      console.log('[VideoAds/script] Generation started:', result.generationId, 'â€” user:', user.id);
      _recordCreativeAsset(user.id, { kind: 'video', title: script.trim().slice(0, 80), content: { generationId: result.generationId, script: script.trim() }, source_route: '/api/video-ads/generate' });
      if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
      return res.json({ generationId: result.generationId, status: 'queued' });
    } catch (err) {
      console.error('[VideoAds/script] error:', err.message);
      if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
      return res.status(500).json({ error: err.message });
    }
  }

  // â”€â”€ AI mode (default) â€” Anthropic builds a scene-based Kling prompt â”€â”€
  let _product = product;
  if ((!_product || !_product.trim())) {
    const { data: prods } = await supabaseAdmin.from('business_products').select('name').eq('user_id', user.id).limit(1);
    if (prods && prods[0]) _product = prods[0].name;
  }
  if (!_product || !_product.trim()) return res.status(400).json({ error: 'Product or promotion description is required.' });
  const _bizCtx = await _creativeContext(user.id);

  let vidPrompt;
  if (customPrompt && customPrompt.trim()) {
    vidPrompt = customPrompt.trim();
    console.log('[VideoAds/ai] 1. Custom prompt from preview:', vidPrompt.slice(0, 120));
  } else {
    try {
      const systemPrompt = `You are a video director writing prompts for Kling AI video generation.

Write a concrete scene-by-scene visual description â€” 50 to 80 words total.

Use this exact format:
Scene 1 [0sâ€“${t1}s]: <camera movement> + <subject> + <action>
Scene 2 [${t1}sâ€“${t2}s]: <camera movement> + <subject> + <action>
Scene 3 [${t2}sâ€“${normDuration}s]: <product or brand name clearly visible> + <closing shot>

Rules:
- Camera: "slow push in", "static overhead", "tracking left", "quick cut to close-up"
- Lighting: "soft backlight", "warm golden rim", "cool studio fill", "neon edge light"
- Name the real product, surface, material, and any people
- End on the product or brand name clearly readable on screen
- No "represents", "powerful", "evokes", "dynamic" â€” only what the camera sees
- Output ONLY the prompt. No preamble, no quotes.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business):\n${_bizCtx.text}` : ''}`;

      const userContext = [
        `Promoting: ${_product.trim()}`,
        brand    ? `Brand: ${brand}`       : '',
        style    ? `Visual style: ${style}` : '',
        goal     ? `Goal: ${goal}`          : '',
        audience ? `Audience: ${audience}`  : '',
        `Duration: ${normDuration} seconds`,
      ].filter(Boolean).join('\n');

      console.log('[VideoAds/ai] 1. User brief:', JSON.stringify({ product: _product.trim(), brand, style, goal, duration: normDuration }));
      vidPrompt = (await _aimlText('video-ads-copy', systemPrompt, userContext)).trim();
      console.log('[VideoAds/ai] 2. Generated prompt:', vidPrompt);
    } catch (err) {
      console.warn('[VideoAds/ai] Anthropic build failed, using fallback:', err.message);
      vidPrompt = `Scene 1 [0sâ€“${t1}s]: Static close-up shot of ${_product.trim()} on a clean surface, soft studio lighting. Scene 2 [${t1}sâ€“${t2}s]: Slow push-in revealing product detail, warm rim light. Scene 3 [${t2}sâ€“${normDuration}s]: Product centred, ${brand || 'brand'} name fades in below.`;
    }
  }

  console.log(`[VideoAds/ai] 3. Final Kling prompt: ${vidPrompt}`);
  try {
    const result = await aiml.generateVideo(vidPrompt, { duration: normDuration, aspect_ratio: '16:9' });
    console.log('[VideoAds/ai] Generation started:', result.generationId, 'â€” user:', user.id);
    _recordCreativeAsset(user.id, { kind: 'video', title: _product.trim().slice(0, 80), content: { generationId: result.generationId, prompt: vidPrompt }, source_route: '/api/video-ads/generate' });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    return res.json({ generationId: result.generationId, status: 'queued' });
  } catch (err) {
    console.error('[VideoAds/ai] error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// â”€â”€ GET /api/video-ads/status/:generationId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Polls AIML API for video generation status.
app.get('/api/video-ads/status/:generationId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Video Ads is not configured â€” set AIML_API_KEY in environment variables.' });
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

// â”€â”€ POST /api/motion-graphics/generate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Generates branded motion graphic videos via AIML API (kling-video).
// Anthropic writes a cinematic video prompt with Brand Core injection.
// Returns { generationId, status: 'queued' } â€” client polls /status/:id.
app.post('/api/motion-graphics/generate', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { style, duration, notes, brandCore, logoUrl, customPrompt } = req.body || {};

  let reservation;
  try {
    reservation = await creditManager.reserveCredits(user, 'video_generation');
  } catch (err) {
    if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
    console.warn('[MotionGraphics] Credit reservation error:', err.message);
  }

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Motion Graphics is not available â€” set AIML_API_KEY in environment variables.' });
  }

  // Style â†’ animation-specific visual instructions for Kling
  const styleMap = {
    logo:       { label: 'Logo Reveal',        motion: 'The brand logo animates onto screen â€” it must visibly appear, scale up or slide in, and hold centre-frame.' },
    kinetic:    { label: 'Kinetic Typography', motion: 'Text elements fly, snap, and animate across the frame â€” words must appear, move, and land with precision.' },
    social:     { label: 'Social Motion Post', motion: 'Bold graphic elements animate in from off-screen, stop sharply, and hold for impact.' },
    intro:      { label: 'Brand Intro',        motion: 'A dramatic reveal sequence: elements build from black, converge, and settle into a final branded frame.' },
    transition: { label: 'Transition Video',   motion: 'Shapes sweep across frame left-to-right, wiping from one colour field to another.' },
    custom:     { label: 'Motion Graphic',     motion: 'Branded graphic elements animate with intentional movement and visual rhythm.' },
  };
  const styleInfo    = styleMap[style] || styleMap.custom;
  const normDuration = parseInt(duration || '5', 10) <= 7 ? 5 : 10;

  // Extract only the visual elements from Brand Core (colours + name â€” no brand strategy in video prompts)
  const bc    = brandCore || await _getBrandCore(user.id).catch(() => null) || {};
  const _bizCtx = await _creativeContext(user.id);
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

Write a short, concrete scene-by-scene description â€” 40 to 60 words total.

Use this exact format:
[0sâ€“${t1}s]: <what literally appears and how it moves>
[${t1}sâ€“${t2}s]: <what happens next â€” specific motion>
[${t2}sâ€“${normDuration}s]: <final frame â€” what is visible>

Strict rules:
- Describe EXACTLY what the viewer sees â€” no metaphors, no moods
- ${styleInfo.motion}
- Specify direction: "slides in from left", "fades up", "scales from 0 to full", "rotates in"
- Name colours when relevant
- No "powerful", "dynamic", "evokes", "cinematic" â€” only visual facts
- Output ONLY the prompt. No preamble, no quotes.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business):\n${_bizCtx.text}` : ''}`;

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
      videoPrompt = `[0sâ€“${t1}s]: ${bcName || 'Brand'} logo fades in from black, centred on screen. [${t1}sâ€“${t2}s]: Logo scales up smoothly${bcClrs ? ', ' + bcClrs + ' glow' : ''}. [${t2}sâ€“${normDuration}s]: Logo holds full-frame on solid background.`;
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
    _recordCreativeAsset(user.id, { kind: 'video', title: styleInfo.label, content: { generationId: result.generationId, prompt: videoPrompt }, source_route: '/api/motion-graphics/generate' });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    return res.json({ generationId: result.generationId, status: 'queued' });
  } catch (err) {
    console.error('[MotionGraphics] Generation error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'video_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    return res.status(500).json({ error: err.message || 'Motion graphic generation failed.' });
  }
});

// â”€â”€ GET /api/motion-graphics/status/:generationId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Polls AIML API for motion graphic video generation status.
app.get('/api/motion-graphics/status/:generationId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const aiml = require('./providers/aimlProvider');
  if (!aiml.isConfigured()) {
    return res.status(503).json({ error: 'Motion Graphics is not configured â€” set AIML_API_KEY in environment variables.' });
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

// â”€â”€ POST /api/product-shoots/generate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Professional product photography via gpt-image-1 (same stack as Visuals/Logos).
// Anthropic builds the photography prompt from product + style + goal.
app.post('/api/product-shoots/generate', requireSubIfAuthed, async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  let { product, style, goal, notes, customPrompt } = req.body || {};
  if (!product || !product.trim()) {
    const { data: prods } = await supabaseAdmin.from('business_products').select('name,description').eq('user_id', user.id).limit(1);
    if (prods && prods[0]) product = prods[0].description ? `${prods[0].name} — ${prods[0].description}` : prods[0].name;
  }
  if (!product || !product.trim()) return res.status(400).json({ error: 'Product description is required.' });

  let reservation;
  try {
    reservation = await creditManager.reserveCredits(user, 'image_generation');
  } catch (err) {
    if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
    console.warn('[ProductShoots] Credit reservation error:', err.message);
  }

  const _bizCtx = await _creativeContext(user.id);

  // Derive aspect ratio from goal (ecommerce/social â†’ square; advertising/website â†’ wide)
  const ratioFromGoal = { ecommerce: '1:1', social: '1:1', advertising: '16:9', website: '16:9' };
  const aimlRatio = ratioFromGoal[goal] || '1:1';

  const styleLabels = {
    studio:       'clean professional studio photography, pure background, controlled key lighting',
    lifestyle:    'lifestyle photography in a natural aspirational setting, soft ambient light',
    minimal:      'minimal white photography, bright even lighting, airy and ecommerce-ready',
    dark_premium: 'dark premium photography, dramatic directional light, deep moody shadows',
  };
  const goalLabels = {
    ecommerce:   'product listing â€” sharp focus, clean composition, product fills the frame',
    social:      'social media â€” creative composition, lifestyle feel, thumb-stopping',
    advertising: 'advertising â€” brand-aligned, persuasive, high production value',
    website:     'website hero â€” editorial, full-bleed composition, premium presentation',
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
The image must look like a real photograph â€” not a render, illustration, or CGI.
Include: lighting setup, camera angle, depth of field, surface, and background.
Keep the product as the clear hero of the frame.
Output ONLY the prompt. 2â€“3 sentences. No quotes, no preamble.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business):\n${_bizCtx.text}` : ''}`;

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
    _recordCreativeAsset(user.id, { kind: 'image', platform: null, product_name: product.trim().slice(0, 80), title: product.trim().slice(0, 80), content: { url }, source_route: '/api/product-shoots/generate' });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'image_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    return res.json({ images: [url], ratio: aimlRatio, prompt: dallEPrompt });
  } catch (err) {
    console.error('[ProductShoots] Error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'image_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    return res.status(500).json({ error: err.message || 'Image generation failed.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V8 â€” Creative Variations (Epic 6) + One-Click Improve (Epic 9). Two
// generic routes instead of ten/fourteen hardcoded ones â€” a `kind`/`action`
// parameter selects the style, same "one reusable pipeline" principle as
// the rest of the Creative Engine.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.post('/api/creative/variations', requireSubIfAuthed, async (req, res) => {
  try {
    const { kind, seed, count } = req.body || {};
    if (!CREATIVE_KINDS[kind]) return res.status(400).json({ error: `kind must be one of: ${Object.keys(CREATIVE_KINDS).join(', ')}` });
    if (!seed || !String(seed).trim()) return res.status(400).json({ error: 'seed is required' });
    const n = Math.min(20, Math.max(1, parseInt(count, 10) || 10));

    let reservation;
    if (req.user) {
      try {
        reservation = await creditManager.reserveCredits(req.user, 'campaign_improvement');
      } catch (err) {
        if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
        console.warn('[creative/variations] Credit reservation error:', err.message);
      }
    }

    const _bizCtx = await _creativeContext(req.user && req.user.id);
    const system = `You are a senior creative copywriter. Generate ${n} distinct ${CREATIVE_KINDS[kind].label} variations based on the seed provided. Each must be genuinely different â€” a different angle, not a rephrasing. Reply ONLY with a valid JSON array of ${n} strings, no markdown, no extra text.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business â€” use it instead of generic copy):\n${_bizCtx.text}` : ''}`;
    const raw = await _aimlText('creative-variations', system, `${CREATIVE_KINDS[kind].label} seed: ${seed}`, { max_tokens: 1200 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let variations = [];
    try {
      variations = JSON.parse(cleaned);
      if (!Array.isArray(variations)) throw new Error('not array');
    } catch (_) {
      variations = cleaned.split('\n').map(l => l.replace(/^[\d.\-\*\s]+/, '').trim()).filter(Boolean).slice(0, n);
    }

    _recordCreativeAsset(req.user && req.user.id, { kind, title: String(seed).slice(0, 80), content: { variations }, source_route: '/api/creative/variations' });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_improvement', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    res.json({ kind, variations });
  } catch (err) {
    console.error('[creative/variations]', err.message);
    res.status(500).json({ error: 'Could not generate variations right now.' });
  }
});

const CREATIVE_IMPROVE_ACTIONS = {
  rewrite:         'Rewrite this completely with a fresh angle, keeping the same core message.',
  improve:         'Improve the clarity, impact, and persuasiveness of this text without changing its core meaning.',
  shorten:         'Shorten this significantly while keeping the core message and impact.',
  expand:          'Expand this with more detail and persuasive depth, staying on message.',
  premium:         'Rewrite this in a premium, elevated tone.',
  luxury:          'Rewrite this in a luxury, aspirational tone.',
  funny:           'Rewrite this with genuine humor and wit.',
  professional:    'Rewrite this in a professional, polished tone.',
  minimal:         'Rewrite this as minimally and cleanly as possible â€” strip anything not essential.',
  high_ctr:        'Rewrite this to maximise click-through rate â€” a sharper hook, stronger curiosity or urgency.',
  high_roas:       'Rewrite this to maximise conversion intent â€” clearer value, stronger call to action.',
  high_engagement: 'Rewrite this to maximise engagement â€” more conversational, more shareable.',
  translate:       'Translate this into the target language, preserving tone and intent.',
  localize:        'Localize this for the target language and culture â€” adapt idioms and references, not just words.'
};

// V8 Phase 2 (Epic 6) â€” friendly labels for the version an /improve call
// creates when it's linked to an existing asset via assetId.
const CREATIVE_VERSION_LABELS = {
  rewrite: 'Rewritten', improve: 'Improved', shorten: 'Shortened', expand: 'Expanded',
  premium: 'Premium', luxury: 'Luxury', funny: 'Funny', professional: 'Professional',
  minimal: 'Minimal', high_ctr: 'High CTR', high_roas: 'High ROAS', high_engagement: 'High Engagement',
  translate: 'Translated', localize: 'Localized'
};

app.post('/api/creative/improve', requireSubIfAuthed, async (req, res) => {
  try {
    const { text, action, targetLanguage, assetId } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
    const instruction = CREATIVE_IMPROVE_ACTIONS[action];
    if (!instruction) return res.status(400).json({ error: `action must be one of: ${Object.keys(CREATIVE_IMPROVE_ACTIONS).join(', ')}` });
    if ((action === 'translate' || action === 'localize') && !targetLanguage) return res.status(400).json({ error: 'targetLanguage is required for translate/localize' });

    let reservation;
    if (req.user) {
      try {
        reservation = await creditManager.reserveCredits(req.user, 'campaign_improvement');
      } catch (err) {
        if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
        console.warn('[creative/improve] Credit reservation error:', err.message);
      }
    }

    const _bizCtx = await _creativeContext(req.user && req.user.id);
    const system = `You are a senior copy editor. ${instruction}${(action === 'translate' || action === 'localize') ? ` Target language: ${targetLanguage}.` : ''} Reply ONLY with the resulting text â€” no preamble, no quotes, no explanation.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE (keep this brand's real identity consistent):\n${_bizCtx.text}` : ''}`;
    const result = (await _aimlText('creative-improve', system, String(text), { max_tokens: 1000 })).trim();
    if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_improvement', { provider: 'aiml', success: true, route: req.path }).catch(() => {});

    // Epic 6 â€” Version History. If this improve call is linked to a real
    // asset, create a new version row in that asset's family instead of a
    // standalone "improved_text" record.
    let versionId = null;
    if (assetId && req.user) {
      try {
        const { data: parent } = await supabaseAdmin.from('creative_assets').select('*').eq('id', assetId).eq('user_id', req.user.id).maybeSingle();
        if (parent) {
          const versionLabel = CREATIVE_VERSION_LABELS[action] || action;
          const newContent = Object.assign({}, parent.content, { text: result });
          const { data: versionRow, error: vErr } = await supabaseAdmin.from('creative_assets').insert({
            user_id: req.user.id, kind: parent.kind, platform: parent.platform,
            campaign_name: parent.campaign_name, product_name: parent.product_name,
            title: parent.title, content: newContent, source_route: '/api/creative/improve',
            parent_asset_id: assetId, version_label: versionLabel, is_current: true, status: 'draft'
          }).select().maybeSingle();
          if (vErr) throw vErr;
          if (versionRow) {
            await supabaseAdmin.from('creative_assets').update({ is_current: false }).eq('id', assetId);
            versionId = versionRow.id;
          }
        }
      } catch (linkErr) {
        console.warn('[creative/improve] versioning failed (non-fatal):', linkErr.message);
      }
    }
    if (!versionId) {
      _recordCreativeAsset(req.user && req.user.id, { kind: 'improved_text', title: String(text).slice(0, 80), content: { original: text, action, result }, source_route: '/api/creative/improve' });
    }

    res.json({ result, action, versionId });
  } catch (err) {
    console.error('[creative/improve]', err.message);
    res.status(500).json({ error: 'Could not improve that right now.' });
  }
});

// â”€â”€ Ad Creative Builder (Epic 5) â”€â”€ one product brief in, three
// platform-adapted ad packages out. Calls _generateAdPackage (defined
// further down, next to /api/ai/create-ad which it also powers) once per
// platform in parallel â€” same Promise.allSettled pattern already used by
// /api/generate-campaign for parallel image generation. Google/Meta/TikTok
// only â€” Performance Max, Pinterest, and LinkedIn have no platform
// integration in this codebase to build on yet.
app.post('/api/creative/campaign-suite', requireSubIfAuthed, async (req, res) => {
  try {
    const { product, goal, brandCore, productImages } = req.body || {};
    if (!product) return res.status(400).json({ error: 'product is required' });

    const platforms = ['google', 'meta', 'tiktok'];
    const results = await Promise.allSettled(
      platforms.map(platform => _generateAdPackage({ user: req.user, product, goal, platform, brandCore, productImages }))
    );

    const packages = {};
    const errors = {};
    platforms.forEach((platform, i) => {
      if (results[i].status === 'fulfilled') packages[platform] = results[i].value;
      else errors[platform] = results[i].reason && results[i].reason.message;
    });

    if (!Object.keys(packages).length) return res.status(500).json({ ok: false, error: 'Generation failed on every platform.', errors });
    res.json({ ok: true, packages, errors: Object.keys(errors).length ? errors : undefined });
  } catch (err) {
    console.error('[creative/campaign-suite]', err.message);
    res.status(500).json({ ok: false, error: 'Could not generate the campaign suite right now.' });
  }
});

// â”€â”€ Asset Library (Epic 10, extended V8 Phase 2 Epics 8/9) â”€â”€ the first
// real persistent storage for generated creative in this codebase. Every
// generator route writes here via _recordCreativeAsset (fire-and-forget).
app.get('/api/creative/assets', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { kind, platform, product_name, campaign_name, since, favorite, status, archived, sort } = req.query || {};
    let q = supabaseAdmin.from('creative_assets').select('*').eq('user_id', user.id);
    if (kind)         q = q.eq('kind', kind);
    if (platform)     q = q.eq('platform', platform);
    if (product_name)  q = q.eq('product_name', product_name);
    if (campaign_name) q = q.eq('campaign_name', campaign_name);
    if (since)        q = q.gte('created_at', since);
    if (favorite === 'true') q = q.eq('favorite', true);
    if (status)       q = q.eq('status', status);
    // Archived assets are hidden by default (Epic 9) unless explicitly requested.
    if (archived === 'true') q = q.eq('archived', true);
    else if (archived !== 'all') q = q.eq('archived', false);
    q = q.order('created_at', { ascending: false }).limit(200);
    const { data, error } = await q;
    if (error) throw error;
    let assets = data || [];
    // Epic 8 "Performance" filter â€” honestly scoped to the creative SCORE
    // (predicted quality), since no per-asset measured ad performance is
    // linked anywhere in this codebase; real performance lives on the ad
    // platforms, keyed by campaign, not by individual generated creative.
    if (sort === 'score') {
      assets = assets.slice().sort((a, b) => ((b.scores && b.scores.confidence) || 0) - ((a.scores && a.scores.confidence) || 0));
    }
    res.json({ assets });
  } catch (err) {
    console.error('[creative/assets GET]', err.message);
    res.status(500).json({ error: 'Could not load your creative assets.' });
  }
});

app.delete('/api/creative/assets/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { error } = await supabaseAdmin.from('creative_assets').delete().eq('id', req.params.id).eq('user_id', user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[creative/assets DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete that asset.' });
  }
});

// Epic 9 â€” one generic partial-update route for favorite/archived/status/notes
// instead of four separate endpoints.
const CREATIVE_ASSET_STATUSES = ['draft', 'needs_improvement', 'ready', 'approved', 'published', 'rejected'];
app.patch('/api/creative/assets/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { favorite, archived, status, notes } = req.body || {};
    if (status !== undefined && !CREATIVE_ASSET_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${CREATIVE_ASSET_STATUSES.join(', ')}` });
    }
    const row = {};
    if (favorite !== undefined) row.favorite = !!favorite;
    if (archived !== undefined) row.archived = !!archived;
    if (status !== undefined)   row.status = status;
    if (notes !== undefined)    row.notes = notes;
    if (!Object.keys(row).length) return res.status(400).json({ error: 'Nothing to update.' });
    const { data, error } = await supabaseAdmin.from('creative_assets').update(row).eq('id', req.params.id).eq('user_id', user.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Asset not found.' });
    res.json({ asset: data });
  } catch (err) {
    console.error('[creative/assets PATCH]', err.message);
    res.status(500).json({ error: 'Could not update that asset.' });
  }
});

// Epic 9 â€” Duplicate. Copies content into a fresh, unlinked row (new
// version family, status reset) rather than mutating the original.
app.post('/api/creative/assets/:id/duplicate', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: src, error: srcErr } = await supabaseAdmin.from('creative_assets').select('*').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (srcErr) throw srcErr;
    if (!src) return res.status(404).json({ error: 'Asset not found.' });
    const { data, error } = await supabaseAdmin.from('creative_assets').insert({
      user_id: user.id, kind: src.kind, platform: src.platform,
      campaign_name: src.campaign_name, product_name: src.product_name,
      title: (src.title || 'Untitled') + ' (copy)', content: src.content,
      source_route: '/api/creative/assets/:id/duplicate', status: 'draft'
    }).select().maybeSingle();
    if (error) throw error;
    res.json({ asset: data });
  } catch (err) {
    console.error('[creative/assets duplicate]', err.message);
    res.status(500).json({ error: 'Could not duplicate that asset.' });
  }
});

// Epic 6 â€” Version History. Walks the family in both directions (parent
// chain + children) rather than needing a recursive SQL CTE, since chains
// are short in practice (a handful of improve steps).
async function _getVersionChain(userId, assetId) {
  const { data: seed } = await supabaseAdmin.from('creative_assets').select('*').eq('id', assetId).eq('user_id', userId).maybeSingle();
  if (!seed) return [];
  const byId = { [seed.id]: seed };

  // Walk up to the root via parent_asset_id.
  let cur = seed;
  let hops = 0;
  while (cur.parent_asset_id && hops < 20) {
    const { data: parent } = await supabaseAdmin.from('creative_assets').select('*').eq('id', cur.parent_asset_id).eq('user_id', userId).maybeSingle();
    if (!parent || byId[parent.id]) break;
    byId[parent.id] = parent;
    cur = parent;
    hops++;
  }

  // Pull every descendant of the root (one query, since parent_asset_id is
  // indexed and version families are small).
  const rootId = cur.id;
  const { data: descendants } = await supabaseAdmin.from('creative_assets').select('*').eq('user_id', userId).eq('parent_asset_id', rootId);
  (descendants || []).forEach(d => { byId[d.id] = d; });
  // One more hop for grandchildren (typical max depth for this feature).
  const secondLevelIds = (descendants || []).map(d => d.id);
  if (secondLevelIds.length) {
    const { data: grandchildren } = await supabaseAdmin.from('creative_assets').select('*').eq('user_id', userId).in('parent_asset_id', secondLevelIds);
    (grandchildren || []).forEach(d => { byId[d.id] = d; });
  }

  return Object.values(byId).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

app.get('/api/creative/assets/:id/versions', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const versions = await _getVersionChain(user.id, req.params.id);
    res.json({ versions });
  } catch (err) {
    console.error('[creative/assets versions]', err.message);
    res.status(500).json({ error: 'Could not load version history.' });
  }
});

// Epic 6 â€” Restore. Flips is_current within the family without duplicating
// content, so "restoring" an old version makes it the active one again.
app.post('/api/creative/assets/:id/restore', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const chain = await _getVersionChain(user.id, req.params.id);
    if (!chain.length) return res.status(404).json({ error: 'Asset not found.' });
    const target = chain.find(v => v.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Asset not found.' });
    await Promise.all(chain.map(v =>
      supabaseAdmin.from('creative_assets').update({ is_current: v.id === req.params.id }).eq('id', v.id).eq('user_id', user.id)
    ));
    res.json({ asset: Object.assign({}, target, { is_current: true }) });
  } catch (err) {
    console.error('[creative/assets restore]', err.message);
    res.status(500).json({ error: 'Could not restore that version.' });
  }
});

// Epic 9 â€” Comments. User-attributed even for a single-user account today,
// so the same table works unmodified once real team support exists.
app.get('/api/creative/assets/:id/comments', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    // Ownership check first -- without this, any authenticated user could
    // read comments on ANY other user's asset by guessing/incrementing id.
    const { data: asset } = await supabaseAdmin.from('creative_assets').select('id').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    const { data, error } = await supabaseAdmin.from('creative_asset_comments').select('*').eq('asset_id', req.params.id).order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ comments: data || [] });
  } catch (err) {
    console.error('[creative/assets comments GET]', err.message);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

app.post('/api/creative/assets/:id/comments', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
    const { data: asset } = await supabaseAdmin.from('creative_assets').select('id').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    const { data, error } = await supabaseAdmin.from('creative_asset_comments').insert({ asset_id: req.params.id, user_id: user.id, content: String(content).trim() }).select().maybeSingle();
    if (error) throw error;
    res.json({ comment: data });
  } catch (err) {
    console.error('[creative/assets comments POST]', err.message);
    res.status(500).json({ error: 'Could not save that comment.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V8 Phase 2 â€” Creative Scoring (Epic 3) + Creative Director (Epic 4).
// "Never fake confidence" applies here the same way it does everywhere
// else in this app: sub-scores that CAN be calculated from real text are
// calculated (readability, platform fit, brand consistency, evidence
// confidence); sub-scores that genuinely require judgment (CTR, attention,
// brand fit, emotion, conversion potential) are AI-estimated and labelled
// as predictions, never presented as measured fact â€” exactly the same
// honesty split _generateAdPackage's performancePrediction block already
// uses for ads, generalised here to any creative kind.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function _extractTextFromContent(content) {
  const parts = [];
  (function walk(v) {
    if (v == null) return;
    if (typeof v === 'string') { if (v.length < 2000) parts.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(k => { if (k !== 'url' && k !== 'html') walk(v[k]); }); }
  })(content);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function _countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  const matches = word.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;
  if (word.endsWith('e') && count > 1) count--;
  return Math.max(1, count);
}

function _computeReadability(text) {
  if (!text || text.trim().length < 10) return { value: null, why: 'Not enough text to analyse.' };
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.split(/\s+/).filter(Boolean);
  const syllables = words.reduce((s, w) => s + _countSyllables(w), 0);
  const sCount = Math.max(1, sentences.length), wCount = Math.max(1, words.length);
  const flesch = 206.835 - 1.015 * (wCount / sCount) - 84.6 * (syllables / wCount);
  const value = Math.round(Math.max(0, Math.min(100, flesch)));
  return { value, why: `${wCount} words, ${sCount} sentence(s), averaging ${(wCount / sCount).toFixed(1)} words per sentence.` };
}

const CREATIVE_PLATFORM_TEXT_LIMITS = { google: 90, meta: 125, tiktok: 150, email: 600, pinterest: 100, linkedin: 150 };
function _computePlatformFit(text, platform, kind) {
  if (!platform || !CREATIVE_PLATFORM_TEXT_LIMITS[platform] || !text) return null;
  const limit = CREATIVE_PLATFORM_TEXT_LIMITS[platform];
  const len = text.length;
  const ratio = len / limit;
  const value = Math.round(Math.max(0, Math.min(100, 100 - Math.max(0, ratio - 1) * 100)));
  return { value, why: `${len} characters vs a typical ${limit}-character norm for ${platform}.` };
}

function _computeConsistency(text, bizCtx, brandCore) {
  const brandText = [brandCore && brandCore.toneOfVoice, brandCore && brandCore.usp, bizCtx && bizCtx.text].filter(Boolean).join(' ');
  if (!text || text.trim().length < 5 || !brandText.trim()) return { value: null, why: 'Not enough stored brand context to compare against yet.' };
  const norm = s => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
  const a = norm(text), b = norm(brandText);
  if (!a.size || !b.size) return { value: null, why: 'Not enough text to compare.' };
  let overlap = 0;
  a.forEach(w => { if (b.has(w)) overlap++; });
  const value = Math.round(Math.min(100, (overlap / Math.min(a.size, 10)) * 100));
  return { value, why: `${overlap} shared meaningful word(s) with your stored brand voice/USP.` };
}

// Epic 4 â€” Creative Director. Not a separate agent: notes are derived from
// the same scores just computed, plus real accumulated business_learnings
// (V7's Learning Engine) â€” "this resembles/differs from a real winner",
// not an invented opinion.
async function _buildDirectorNotes({ user, scores, platform }) {
  const notes = [];
  if (scores.consistency && scores.consistency.value != null && scores.consistency.value < 50) {
    notes.push({ severity: 'medium', title: 'Brand voice may be off', detail: 'This creative doesn\'t closely match your stored brand tone and USP.', message: 'Help me rewrite this to better match my brand voice.' });
  }
  if (scores.platformFit && scores.platformFit.value != null && scores.platformFit.value < 60) {
    notes.push({ severity: 'low', title: `May not fit ${platform || 'this platform'} well`, detail: scores.platformFit.why, message: `Help me adapt this to fit ${platform || 'the platform'} better.` });
  }
  if (scores.readability && scores.readability.value != null && scores.readability.value < 40) {
    notes.push({ severity: 'low', title: 'May be hard to read quickly', detail: 'Sentence and word complexity are high for a scroll-stopping creative.', message: 'Help me simplify this so it reads faster.' });
  }
  if (user) {
    try {
      const learnings = await _fetchActiveLearnings(user.id, { limit: 20 });
      learnings.filter(l => ['winning_headline', 'winning_cta', 'winning_messaging', 'creative_pattern'].includes(l.category)).slice(0, 2).forEach(l => {
        notes.push({ severity: 'low', title: 'Based on what has worked before', detail: `${l.pattern} (${l.confidence}% confidence).`, message: `Based on "${l.pattern}", help me apply that here.` });
      });
    } catch (_) { /* non-fatal */ }
  }
  return notes.slice(0, 5);
}

app.post('/api/creative/score', requireSubIfAuthed, async (req, res) => {
  try {
    const { assetId, kind, content, platform } = req.body || {};
    let asset = null, resolvedKind = kind, resolvedContent = content, resolvedPlatform = platform;

    if (assetId) {
      if (!req.user) return res.status(401).json({ error: 'Sign in required to score a saved asset.' });
      const { data } = await supabaseAdmin.from('creative_assets').select('*').eq('id', assetId).eq('user_id', req.user.id).maybeSingle();
      if (!data) return res.status(404).json({ error: 'Asset not found.' });
      asset = data;
      resolvedKind = data.kind; resolvedContent = data.content; resolvedPlatform = data.platform;
    }
    if (!resolvedContent) return res.status(400).json({ error: 'assetId or content is required' });

    const text = _extractTextFromContent(resolvedContent);
    const _bizCtx = await _creativeContext(req.user && req.user.id);
    const brandCore = req.user ? await _getBrandCore(req.user.id).catch(() => null) : null;

    const readability = _computeReadability(text);
    const platformFit = _computePlatformFit(text, resolvedPlatform, resolvedKind);
    const consistency = _computeConsistency(text, _bizCtx, brandCore);
    const confidence = { value: _bizCtx ? Math.min(100, _bizCtx.sources.length * 12) : 15, why: _bizCtx ? `Based on ${_bizCtx.sources.length} real Business Brain source(s).` : 'Generated with no stored business context to ground it in.' };

    let ai = {};
    if (text.trim().length >= 5) {
      let reservation;
      if (req.user) {
        try {
          reservation = await creditManager.reserveCredits(req.user, 'campaign_improvement');
        } catch (err) {
          if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
          console.warn('[creative/score] Credit reservation error:', err.message);
        }
      }
      const system = `You are a senior creative director scoring an ad/creative for QUALITY POTENTIAL â€” these are predictions, not measurements, since no campaign has run yet. Score 0-100 for each: ctrPrediction (likely click-through appeal), attention (scroll-stopping power), brandFit (how well it matches the described brand), emotion (emotional resonance), conversionPotential (likelihood to drive action). Reply ONLY with valid JSON: {"ctrPrediction":N,"ctrWhy":"...","attention":N,"attentionWhy":"...","brandFit":N,"brandFitWhy":"...","emotion":N,"emotionWhy":"...","conversionPotential":N,"conversionWhy":"..."}. Be honest and varied â€” do not default every score to 70-80.${_bizCtx ? `\n\nBUSINESS KNOWLEDGE:\n${_bizCtx.text}` : ''}`;
      try {
        const raw = await _aimlText('creative-score', system, text.slice(0, 3000), { max_tokens: 500 });
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        ai = JSON.parse(cleaned);
        if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_improvement', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
      } catch (aiErr) {
        console.warn('[creative/score] AI scoring failed (non-fatal):', aiErr.message);
        if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_improvement', { success: false, error: aiErr.message, route: req.path }).catch(() => {});
      }
    }

    const scores = {
      readability,
      platformFit,
      consistency,
      confidence,
      ctrPrediction:       { value: ai.ctrPrediction ?? null, why: ai.ctrWhy || '' },
      attention:           { value: ai.attention ?? null, why: ai.attentionWhy || '' },
      brandFit:            { value: ai.brandFit ?? null, why: ai.brandFitWhy || '' },
      emotion:             { value: ai.emotion ?? null, why: ai.emotionWhy || '' },
      conversionPotential: { value: ai.conversionPotential ?? null, why: ai.conversionWhy || '' }
    };

    const directorNotes = await _buildDirectorNotes({ user: req.user, scores, platform: resolvedPlatform });

    if (asset) await supabaseAdmin.from('creative_assets').update({ scores }).eq('id', asset.id);

    res.json({ scores, directorNotes });
  } catch (err) {
    console.error('[creative/score]', err.message);
    res.status(500).json({ error: 'Could not score that creative right now.' });
  }
});

// â”€â”€ Global Creative Search (Epic 7) â€” fans out across every existing
// knowledge/creative table with one Promise.all; no new search index, no
// duplicated per-table logic beyond the small per-table mapper below.
app.get('/api/creative/search', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const q = String((req.query && req.query.q) || '').trim();
    if (!q || q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;

    const [assets, products, audiences, competitors, memory, learnings] = await Promise.all([
      supabaseAdmin.from('creative_assets').select('id,kind,title').eq('user_id', user.id).ilike('title', like).limit(10),
      supabaseAdmin.from('business_products').select('id,name').eq('user_id', user.id).ilike('name', like).limit(10),
      supabaseAdmin.from('business_audiences').select('id,name').eq('user_id', user.id).ilike('name', like).limit(10),
      supabaseAdmin.from('business_competitors').select('id,company').eq('user_id', user.id).ilike('company', like).limit(10),
      supabaseAdmin.from('business_memory').select('id,content').eq('user_id', user.id).ilike('content', like).limit(10),
      supabaseAdmin.from('business_learnings').select('id,pattern').eq('user_id', user.id).eq('status', 'active').ilike('pattern', like).limit(10)
    ]);

    const results = []
      .concat((assets.data || []).map(a => ({ type: 'creative', id: a.id, title: a.title || a.kind, snippet: a.kind })))
      .concat((products.data || []).map(p => ({ type: 'product', id: p.id, title: p.name, snippet: 'Product' })))
      .concat((audiences.data || []).map(a => ({ type: 'audience', id: a.id, title: a.name, snippet: 'Audience' })))
      .concat((competitors.data || []).map(c => ({ type: 'competitor', id: c.id, title: c.company, snippet: 'Competitor' })))
      .concat((memory.data || []).map(m => ({ type: 'memory', id: m.id, title: m.content.slice(0, 60), snippet: 'Business Brain memory' })))
      .concat((learnings.data || []).map(l => ({ type: 'learning', id: l.id, title: l.pattern.slice(0, 60), snippet: 'Business learning' })));

    res.json({ results });
  } catch (err) {
    console.error('[creative/search]', err.message);
    res.status(500).json({ error: 'Search failed right now.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V9 â€” Autopilot (Epics 7, 6, 8, 12, 14). All routes below reuse existing
// engines (Tool Router, Creative Engine, forecasting, Learning Engine) â€”
// see _generateRecommendation/_evaluateAutomationRules above for the write
// side, wired into the existing 4-hour monitoring cron.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Epic 13 â€” Learning Loop. Approving a recommendation strengthens any
// related business_learnings row; rejecting weakens it. Soft-linked by
// campaign name, same convention every prior phase has used.
async function _nudgeRelatedLearning(userId, rec, delta) {
  try {
    if (!rec.campaign_name) return;
    const { data: learnings } = await supabaseAdmin.from('business_learnings').select('id,confidence').eq('user_id', userId).eq('status', 'active').ilike('entity_name', `%${rec.campaign_name}%`);
    for (const l of (learnings || [])) {
      const newConf = Math.max(8, Math.min(96, l.confidence + delta));
      await supabaseAdmin.from('business_learnings').update({ confidence: newConf, updated_at: new Date().toISOString() }).eq('id', l.id);
    }
  } catch (err) {
    console.warn('[Autopilot] learning nudge failed:', err.message);
  }
}

const AUTOPILOT_GENERATIVE_TOOLS = ['generate_headlines', 'generate_ctas', 'generate_email', 'generate_landing_page', 'refresh_campaign_creative'];

app.get('/api/autopilot/recommendations', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { status, type, platform } = req.query || {};
    let q = supabaseAdmin.from('autopilot_recommendations').select('*').eq('user_id', user.id);
    q = q.eq('status', status || 'suggested');
    if (type) q = q.eq('type', type);
    if (platform) q = q.eq('platform', platform);
    q = q.order('created_at', { ascending: false }).limit(100);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ recommendations: data || [] });
  } catch (err) {
    console.error('[autopilot/recommendations GET]', err.message);
    res.status(500).json({ error: 'Could not load recommendations.' });
  }
});

app.patch('/api/autopilot/recommendations/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { tool_params } = req.body || {};
    if (tool_params === undefined) return res.status(400).json({ error: 'tool_params is required' });
    const { data, error } = await supabaseAdmin.from('autopilot_recommendations').update({ tool_params }).eq('id', req.params.id).eq('user_id', user.id).eq('status', 'suggested').select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Recommendation not found or already resolved.' });
    res.json({ recommendation: data });
  } catch (err) {
    console.error('[autopilot/recommendations PATCH]', err.message);
    res.status(500).json({ error: 'Could not update that recommendation.' });
  }
});

app.post('/api/autopilot/recommendations/:id/approve', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: rec } = await supabaseAdmin.from('autopilot_recommendations').select('*').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });
    if (rec.status !== 'suggested') return res.status(400).json({ error: `Already ${rec.status}.` });

    let execResult = { ok: true, message: 'Marked as approved (no automatic action attached).' };
    if (rec.tool_name) {
      const ctx = { user, authHeader: req.headers.authorization || '' };
      execResult = await toolRouter.executeDirect(rec.tool_name, rec.tool_params || {}, ctx);
    }
    const newStatus = execResult.ok ? 'executed' : 'failed';
    await supabaseAdmin.from('autopilot_recommendations').update({ status: newStatus, resolved_at: new Date().toISOString() }).eq('id', rec.id);
    await _nudgeRelatedLearning(user.id, rec, 5);

    // "Approve & Remember" â€” only for the same purely generative action
    // types Epic 6 allows a rule to suggest without touching a live
    // campaign; this makes the next identical situation one click instead
    // of a fresh explanation, without ever auto-executing unattended.
    if (req.body && req.body.remember && rec.tool_name && AUTOPILOT_GENERATIVE_TOOLS.includes(rec.tool_name) && rec.evidence && rec.evidence.metric) {
      await supabaseAdmin.from('automation_rules').insert({
        user_id: user.id, name: `Auto: ${rec.problem}`.slice(0, 120),
        trigger_metric: rec.evidence.metric, trigger_operator: rec.evidence.operator || '<', trigger_value: rec.evidence.value,
        platform: rec.platform, action_type: rec.tool_name, action_params: rec.tool_params, enabled: true
      });
    }

    // Epic 9 â€” resume a workflow that paused at "request_approval" waiting
    // exactly for this recommendation.
    if (rec.evidence && rec.evidence.workflowId) {
      const { data: wf } = await supabaseAdmin.from('autopilot_workflows').select('*').eq('id', rec.evidence.workflowId).eq('user_id', user.id).maybeSingle();
      if (wf && wf.status === 'awaiting_approval') {
        wf.steps[wf.current_step].status = 'done';
        wf.current_step++;
        wf.status = 'running';
        await _advanceWorkflow(wf, req.headers.authorization || '').catch(err => console.warn('[Autopilot] workflow resume failed:', err.message));
      }
    }

    res.json({ ok: execResult.ok, status: newStatus, message: execResult.message || execResult.error });
  } catch (err) {
    console.error('[autopilot/recommendations approve]', err.message);
    res.status(500).json({ error: 'Could not approve that recommendation.' });
  }
});

app.post('/api/autopilot/recommendations/:id/reject', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: rec } = await supabaseAdmin.from('autopilot_recommendations').select('*').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!rec) return res.status(404).json({ error: 'Recommendation not found.' });
    if (rec.status !== 'suggested') return res.status(400).json({ error: `Already ${rec.status}.` });
    await supabaseAdmin.from('autopilot_recommendations').update({ status: 'rejected', resolved_at: new Date().toISOString() }).eq('id', rec.id);
    await _nudgeRelatedLearning(user.id, rec, -10);
    res.json({ ok: true, status: 'rejected' });
  } catch (err) {
    console.error('[autopilot/recommendations reject]', err.message);
    res.status(500).json({ error: 'Could not reject that recommendation.' });
  }
});

// Epic 6 â€” Automation Rules CRUD.
app.get('/api/autopilot/rules', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('automation_rules').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ rules: data || [] });
  } catch (err) {
    console.error('[autopilot/rules GET]', err.message);
    res.status(500).json({ error: 'Could not load your automation rules.' });
  }
});

// Autopilot Complete Redesign â€” constrained to the exact sets
// _evaluateAutomationRules actually understands, so a malformed rule can
// never be silently created and then silently never fire. Widened from
// the original {ctr,cpa,roas} / 5 actions / google+meta to the real,
// currently-fetched metric set and the real, currently-callable actions â€”
// see _ruleMetricValue() and _execRuleAction() below for what each one
// actually does. Frequency and a per-campaign "approval status" are
// deliberately NOT included: neither is fetched anywhere in this codebase
// today (confirmed by grep), so exposing them in the rule builder would
// let a user build a condition that can never evaluate to anything real.
const AUTOPILOT_RULE_METRICS = ['roas', 'ctr', 'cpc', 'cpa', 'conversions', 'spend', 'clicks', 'impressions', 'budget', 'status'];
const AUTOPILOT_RULE_OPERATOR_VALUES = ['<', '>', '==', '>=', '<='];
const AUTOPILOT_RULE_ACTION_TYPES = ['increase_budget', 'decrease_budget', 'pause_campaign', 'resume_campaign', 'generate_creative', 'generate_recommendations', 'notify', 'request_approval', 'create_report', 'create_briefing', 'run_optimisation'];
const AUTOPILOT_RULE_PLATFORMS = ['google', 'meta', 'tiktok'];
// Budget changes have no TikTok endpoint today (no PATCH /api/tiktok/campaign/:id
// exists) â€” real gap, not an oversight; enforced both here and in the
// frontend's action dropdown so a TikTok rule can never be saved with an
// action that would silently never execute.
const AUTOPILOT_BUDGET_UNSUPPORTED_PLATFORMS = ['tiktok'];
const AUTOPILOT_RULE_MODES = ['suggest_only', 'require_approval', 'fully_automatic'];

// Shared validation for both create and update. `full` = every field is
// required (create); otherwise only whatever's present is checked (update).
function _validateAutopilotRuleFields(b, full) {
  if (full && (!b.name || !b.trigger_metric || !b.trigger_operator || b.trigger_value == null || !b.action_type)) {
    return 'name, trigger_metric, trigger_operator, trigger_value, and action_type are required';
  }
  if (b.trigger_metric !== undefined && !AUTOPILOT_RULE_METRICS.includes(b.trigger_metric)) return `trigger_metric must be one of: ${AUTOPILOT_RULE_METRICS.join(', ')}`;
  if (b.trigger_operator !== undefined && !AUTOPILOT_RULE_OPERATOR_VALUES.includes(b.trigger_operator)) return `trigger_operator must be one of: ${AUTOPILOT_RULE_OPERATOR_VALUES.join(', ')}`;
  if (b.action_type !== undefined && !AUTOPILOT_RULE_ACTION_TYPES.includes(b.action_type)) return `action_type must be one of: ${AUTOPILOT_RULE_ACTION_TYPES.join(', ')}`;
  if (b.platform !== undefined && b.platform !== null && !AUTOPILOT_RULE_PLATFORMS.includes(b.platform)) return `platform must be one of: ${AUTOPILOT_RULE_PLATFORMS.join(', ')}`;
  if (b.trigger_value !== undefined && (typeof b.trigger_value !== 'number' || !isFinite(b.trigger_value))) return 'trigger_value must be a number';
  const isBudgetAction = b.action_type === 'increase_budget' || b.action_type === 'decrease_budget';
  if (isBudgetAction && b.platform && AUTOPILOT_BUDGET_UNSUPPORTED_PLATFORMS.includes(b.platform)) {
    return `Budget changes aren't available on ${b.platform} yet — no budget-change endpoint exists for that platform.`;
  }
  if (b.action_params !== undefined && b.action_params !== null) {
    const ap = b.action_params;
    if (typeof ap !== 'object' || Array.isArray(ap)) return 'action_params must be an object';
    if (isBudgetAction && ap.percent !== undefined) {
      if (typeof ap.percent !== 'number' || !isFinite(ap.percent) || ap.percent <= 0 || ap.percent > 100) {
        return 'Budget change percent must be a number greater than 0 and at most 100.';
      }
    }
    if (ap.mode !== undefined && ap.mode !== null && !AUTOPILOT_RULE_MODES.includes(ap.mode)) {
      return `action_params.mode must be one of: ${AUTOPILOT_RULE_MODES.join(', ')}`;
    }
  }
  return null;
}

app.post('/api/autopilot/rules', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { name, trigger_metric, trigger_operator, trigger_value, platform, action_type, action_params } = req.body || {};
    const validationErr = _validateAutopilotRuleFields(req.body || {}, true);
    if (validationErr) return res.status(400).json({ error: validationErr });

    const { data, error } = await supabaseAdmin.from('automation_rules').insert({
      user_id: user.id, name: String(name).slice(0, 120), trigger_metric, trigger_operator, trigger_value, platform: platform || null,
      action_type, action_params: action_params || null, enabled: true
    }).select().maybeSingle();
    if (error) throw error;
    res.json({ rule: data });
  } catch (err) {
    console.error('[autopilot/rules POST]', err.message);
    res.status(500).json({ error: 'Could not save that rule.' });
  }
});

app.patch('/api/autopilot/rules/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const b = req.body || {};
    const validationErr = _validateAutopilotRuleFields(b, false);
    if (validationErr) return res.status(400).json({ error: validationErr });

    const allowed = ['name', 'trigger_metric', 'trigger_operator', 'trigger_value', 'platform', 'action_type', 'action_params', 'enabled'];
    const row = {};
    allowed.forEach(f => { if (b[f] !== undefined) row[f] = b[f]; });
    const { data, error } = await supabaseAdmin.from('automation_rules').update(row).eq('id', req.params.id).eq('user_id', user.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ rule: data });
  } catch (err) {
    console.error('[autopilot/rules PATCH]', err.message);
    res.status(500).json({ error: 'Could not update that rule.' });
  }
});

app.delete('/api/autopilot/rules/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { error } = await supabaseAdmin.from('automation_rules').delete().eq('id', req.params.id).eq('user_id', user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[autopilot/rules DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete that rule.' });
  }
});

// "Every automation should be testable" â€” evaluates the rule's condition
// against real, freshly-fetched campaign data right now, and reports
// whether it would trigger and against which campaign(s). Read-only: never
// executes the action, never updates last_triggered_at.
app.post('/api/autopilot/rules/:id/test', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: rule } = await supabaseAdmin.from('automation_rules').select('*').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!rule) return res.status(404).json({ error: 'Rule not found.' });
    if (!rule.platform) return res.status(400).json({ error: 'Testing requires a rule scoped to one platform.' });

    let pool = [];
    if (rule.platform === 'google') {
      pool = (await _analyzeGoogleAccount(user, 'LAST_7_DAYS')).campaigns || [];
    } else if (rule.platform === 'meta') {
      pool = (await _analyzeMetaAccount(user, 'LAST_7_DAYS')).campaigns || [];
    } else if (rule.platform === 'tiktok') {
      if (rule.trigger_metric !== 'status' && rule.trigger_metric !== 'budget') {
        return res.status(400).json({ error: "TikTok campaigns don't have performance metrics available yet — only Status and Budget conditions can be tested for TikTok." });
      }
      const { accessToken, advertiserId } = await _getTikTokAccess(user);
      const data = await _tiktokFetch('/campaign/get/', accessToken, {
        advertiser_id: advertiserId, fields: JSON.stringify(['campaign_id', 'campaign_name', 'status', 'operation_status', 'budget']), page_size: '100'
      });
      pool = ((data && data.list) || []).map(c => ({ id: String(c.campaign_id), name: c.campaign_name || 'Unnamed', status: c.operation_status || c.status || '', daily_budget: c.budget || null }));
    }

    const ap = rule.action_params || {};
    const scopedCampaignId = ap.campaign_id && ap.campaign_id !== 'all' ? ap.campaign_id : null;
    if (scopedCampaignId) pool = pool.filter(c => String(c.id) === String(scopedCampaignId));

    const op = AUTOPILOT_RULE_OPERATORS[rule.trigger_operator];
    const compareVal = rule.trigger_metric === 'status' ? rule.trigger_value : Number(rule.trigger_value);
    const matches = pool.filter(c => {
      const actual = _ruleMetricValue(c, rule.trigger_metric);
      return actual != null && op(actual, compareVal);
    }).map(c => ({ id: c.id, name: c.name, actual: _ruleMetricValue(c, rule.trigger_metric) }));

    res.json({ wouldTrigger: matches.length > 0, matchingCampaigns: matches, checkedCampaigns: pool.length });
  } catch (err) {
    console.error('[autopilot/rules/:id/test]', err.message);
    res.status(500).json({ error: err.message || 'Could not test that rule right now.' });
  }
});

// Epic 8 â€” Smart Task Manager. Tasks are generated during the monitoring
// pass (see _generateAutopilotTasks, called from _runIntelligenceMonitoring
// below) from sources that already exist â€” this is read/update only.
app.get('/api/autopilot/tasks', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const status = req.query && req.query.status;
    let q = supabaseAdmin.from('autopilot_tasks').select('*').eq('user_id', user.id);
    q = q.eq('status', status || 'pending');
    q = q.order('priority', { ascending: false }).order('deadline', { ascending: true }).limit(100);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ tasks: data || [] });
  } catch (err) {
    console.error('[autopilot/tasks GET]', err.message);
    res.status(500).json({ error: 'Could not load your tasks.' });
  }
});

app.patch('/api/autopilot/tasks/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { status } = req.body || {};
    if (!['pending', 'in_progress', 'done', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const { data, error } = await supabaseAdmin.from('autopilot_tasks').update({ status }).eq('id', req.params.id).eq('user_id', user.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Task not found.' });
    res.json({ task: data });
  } catch (err) {
    console.error('[autopilot/tasks PATCH]', err.message);
    res.status(500).json({ error: 'Could not update that task.' });
  }
});

// Epic 12 â€” Autopilot History. Same fan-out pattern as /api/creative/search.
app.get('/api/autopilot/history', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { q, status, type, since } = req.query || {};
    const sinceDate = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let evQ = supabaseAdmin.from('intelligence_events').select('*').eq('user_id', user.id).gte('created_at', sinceDate);
    let recQ = supabaseAdmin.from('autopilot_recommendations').select('*').eq('user_id', user.id).gte('created_at', sinceDate);
    let taskQ = supabaseAdmin.from('autopilot_tasks').select('*').eq('user_id', user.id).gte('created_at', sinceDate);
    let wfQ = supabaseAdmin.from('autopilot_workflows').select('*').eq('user_id', user.id).gte('created_at', sinceDate);
    if (type) { evQ = evQ.eq('type', type); recQ = recQ.eq('type', type); }
    if (status) { recQ = recQ.eq('status', status); taskQ = taskQ.eq('status', status); wfQ = wfQ.eq('status', status); }
    if (q) { evQ = evQ.ilike('title', `%${q}%`); recQ = recQ.ilike('problem', `%${q}%`); taskQ = taskQ.ilike('title', `%${q}%`); wfQ = wfQ.ilike('name', `%${q}%`); }

    const [events, recs, tasks, workflows] = await Promise.all([evQ, recQ, taskQ, wfQ]);

    const items = []
      .concat((events.data || []).map(e => ({ kind: 'event', id: e.id, title: e.title, status: e.dismissed ? 'dismissed' : 'detected', created_at: e.created_at })))
      .concat((recs.data || []).map(r => ({ kind: 'recommendation', id: r.id, title: r.problem, status: r.status, created_at: r.created_at })))
      .concat((tasks.data || []).map(t => ({ kind: 'task', id: t.id, title: t.title, status: t.status, created_at: t.created_at })))
      .concat((workflows.data || []).map(w => ({ kind: 'workflow', id: w.id, title: w.name, status: w.status, created_at: w.created_at })))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ items: items.slice(0, 200) });
  } catch (err) {
    console.error('[autopilot/history]', err.message);
    res.status(500).json({ error: 'Could not load Autopilot history.' });
  }
});

// Epic 14 â€” Predictive Autopilot. Reuses _computeForecast/_linearTrend
// (V6 Final) â€” same deterministic mechanism /api/intelligence/forecast
// already uses, just composed per-platform for the Autopilot Center.
app.get('/api/autopilot/predictions', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const horizon = Math.min(30, Math.max(7, parseInt(req.query.horizon, 10) || 7));
    const predictions = {};

    for (const platform of ['google', 'meta']) {
      try {
        let series;
        if (platform === 'google') {
          const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(req.user);
          series = await _gadsFetchDailySeries(accessToken, customerId, loginCustomerId, days);
        } else {
          const { accessToken, accountId } = await _getMetaAccess(req.user);
          series = await _metaFetchDailySeries(accessToken, accountId, days);
        }
        if (series && series.length >= 3) {
          predictions[platform] = _computeForecast(series, horizon);
        }
      } catch (err) {
        console.warn(`[Autopilot] predictions | ${platform} unavailable:`, err.message);
      }
    }

    res.json({ predictions, horizon, note: 'Seasonal demand prediction is deferred until enough real months of Business Learnings history accumulate â€” not fabricated from a single snapshot.' });
  } catch (err) {
    console.error('[autopilot/predictions]', err.message);
    res.status(500).json({ error: 'Could not generate predictions right now.' });
  }
});

// Epic 9 â€” Automated Workflows. A generic step-sequence engine over
// existing generators/tools â€” one template built this pass
// (winning_campaign_refresh), but the engine itself is just an ordered
// list of loopback calls, so more templates are additive later, not a
// rebuild. Each step calls an EXISTING route over loopback HTTP with the
// real user's auth header â€” the same "User -> Tool Router -> Existing
// Backend API" principle every tool in campaignTools.js already follows â€”
// which is also why a workflow only ever advances from a real
// authenticated request, never a background cron tick with no token to
// hold. Reaching "request_approval" always pauses for a real Approve
// click, consistent with the Golden Rule.
const AUTOPILOT_WORKFLOW_TEMPLATES = {
  winning_campaign_refresh: [
    { step: 'generate_variations', label: 'Generate headline variations' },
    { step: 'generate_images', label: 'Generate new images' },
    { step: 'generate_landing_page', label: 'Generate landing page' },
    { step: 'generate_email', label: 'Generate email' },
    { step: 'prepare_publish_package', label: 'Prepare publish package' },
    { step: 'request_approval', label: 'Request approval' },
    { step: 'publish', label: 'Publish' }
  ]
};

async function _advanceWorkflow(workflow, authHeader) {
  const _wfPort = parseInt(process.env.PORT || '5500', 10);
  const _wfBase = `http://localhost:${_wfPort}`;
  async function callRoute(path, body) {
    const r = await fetch(_wfBase + path, { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!r.ok) throw new Error((data && data.error) || `Request to ${path} failed`);
    return data;
  }

  while (workflow.current_step < workflow.steps.length) {
    const step = workflow.steps[workflow.current_step];
    try {
      if (step.step === 'request_approval') {
        const rec = await _generateRecommendation({
          userId: workflow.user_id, type: 'workflow_publish', campaignName: workflow.name,
          problem: `Workflow "${workflow.name}" is ready to publish â€” review before it goes live.`,
          confidence: 70, evidence: { workflowId: workflow.id },
          riskLevel: 'medium', toolName: null, toolParams: null
        });
        step.status = 'awaiting_approval';
        step.result = { recommendationId: rec && rec.id };
        workflow.status = 'awaiting_approval';
        break;
      } else if (step.step === 'generate_variations') {
        step.result = await callRoute('/api/creative/variations', { kind: 'headline', seed: workflow.name, count: 5 });
      } else if (step.step === 'generate_images') {
        step.result = await callRoute('/api/generate-image', { prompt: workflow.name, imageType: 'hero' });
      } else if (step.step === 'generate_landing_page') {
        step.result = await callRoute('/api/generate-web', { prompt: workflow.name });
      } else if (step.step === 'generate_email') {
        step.result = await callRoute('/api/generate-email', { prompt: workflow.name });
      } else if (step.step === 'prepare_publish_package') {
        step.result = { note: 'Publish package assembled from the steps above.', steps: workflow.steps.slice(0, workflow.current_step).map(s => s.step) };
      } else if (step.step === 'publish') {
        step.result = { note: 'Use the generated campaign package\'s own publish flow to go live â€” Autopilot prepares, it never auto-publishes.' };
      }
      step.status = 'done';
      workflow.current_step++;
    } catch (err) {
      step.status = 'failed'; step.error = err.message;
      workflow.status = 'failed';
      break;
    }
  }

  if (workflow.current_step >= workflow.steps.length && workflow.status === 'running') {
    workflow.status = 'completed';
    await _upsertLearning(workflow.user_id, {
      entity_type: 'campaign', entity_name: workflow.name, category: 'automation_success',
      pattern: `Workflow "${workflow.name}" completed successfully via Autopilot.`,
      confidence: 60, evidence: { steps: workflow.steps.length }
    });
  }

  await supabaseAdmin.from('autopilot_workflows').update({
    steps: workflow.steps, current_step: workflow.current_step, status: workflow.status, updated_at: new Date().toISOString()
  }).eq('id', workflow.id);
  return workflow;
}

app.post('/api/autopilot/workflows', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { name, template } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const templateSteps = AUTOPILOT_WORKFLOW_TEMPLATES[template || 'winning_campaign_refresh'];
    if (!templateSteps) return res.status(400).json({ error: `Unknown template. Available: ${Object.keys(AUTOPILOT_WORKFLOW_TEMPLATES).join(', ')}` });
    const steps = templateSteps.map(s => Object.assign({ status: 'pending', result: null }, s));
    const { data, error } = await supabaseAdmin.from('autopilot_workflows').insert({
      user_id: user.id, name, template: template || 'winning_campaign_refresh', steps, current_step: 0, status: 'running'
    }).select().maybeSingle();
    if (error) throw error;
    res.json({ workflow: data });
  } catch (err) {
    console.error('[autopilot/workflows POST]', err.message);
    res.status(500).json({ error: 'Could not start that workflow.' });
  }
});

app.get('/api/autopilot/workflows', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('autopilot_workflows').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ workflows: data || [] });
  } catch (err) {
    console.error('[autopilot/workflows GET]', err.message);
    res.status(500).json({ error: 'Could not load your workflows.' });
  }
});

app.post('/api/autopilot/workflows/:id/advance', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data: wf } = await supabaseAdmin.from('autopilot_workflows').select('*').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!wf) return res.status(404).json({ error: 'Workflow not found.' });
    if (wf.status !== 'running') return res.status(400).json({ error: `Workflow is ${wf.status}, not running.` });
    const updated = await _advanceWorkflow(wf, req.headers.authorization || '');
    res.json({ workflow: updated });
  } catch (err) {
    console.error('[autopilot/workflows advance]', err.message);
    res.status(500).json({ error: 'Could not advance that workflow.' });
  }
});

// â”€â”€ POST /api/daily-brief â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

Today is ${today}. Generate a concise morning brief for this brand â€” a strategic starting point for the day.

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
- Be specific to this brand â€” no generic advice
- If limited context: focus on brand-building fundamentals appropriate to their stage
- The focus line should feel like a clear directive, not a question`;

  const userMsg = ctxLines.length
    ? `Brand context:\n${ctxLines.join('\n')}`
    : 'No brand context provided â€” generate a brief for an early-stage brand getting started.';

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

// â”€â”€ POST /api/website-monitor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  const userMsg = `Website URL: ${url.trim()}\n\n${bcLines.length ? `Brand Core:\n${bcLines.join('\n')}` : 'No brand core â€” assess against best practices.'}`;

  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'website_analysis');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[WebsiteMonitor] Credit reservation error:', err.message);
    }
  }

  try {
    const raw = await _aimlText('website-monitor', system, userMsg, { max_tokens: 1200 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let report;
    try {
      report = JSON.parse(cleaned);
    } catch {
      console.error('[WebsiteMonitor] JSON parse failed:', cleaned.slice(0, 200));
      if (reservation) creditManager.finalizeCreditLog(reservation, 'website_analysis', { success: false, error: 'parse failed', route: req.path }).catch(() => {});
      return res.status(500).json({ error: 'Failed to parse website report' });
    }
    console.log('[WebsiteMonitor] Analysis complete for:', url);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'website_analysis', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    res.json(report);
  } catch (err) {
    console.error('[WebsiteMonitor] AIML error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'website_analysis', { success: false, error: err.message, route: req.path }).catch(() => {});
    res.status(500).json({ error: 'Failed to monitor website' });
  }
});

// â”€â”€ POST /api/market-research â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    "name": "Market / industry name (3â€“5 words)",
    "size": "Market scale description (e.g. '$12B global market')",
    "growth": "Growth trajectory (e.g. 'Growing 18% YoY')",
    "maturity": "emerging | growing | mature | declining"
  },
  "trends": [
    { "title": "Short trend name (3â€“5 words)", "desc": "2â€“3 sentence explanation of the trend and its relevance", "impact": "high | medium | low" },
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
    "dynamics": "3â€“4 sentence summary of the competitive landscape",
    "whitespace": "Key underserved gap or opportunity area (1 sentence)"
  },
  "summary": "3â€“4 sentence strategic summary of the market and the brand's position within it"
}

Rules:
- Be specific to the actual industry â€” no generic boilerplate
- All trend, segment, and competitive data should be actionable
- Tailor segments and whitespace to the brand's specific positioning`;

  const userMsg = bcLines.length
    ? `Brand Core:\n${bcLines.join('\n')}`
    : 'No brand core provided â€” analyze a general D2C brand in a competitive consumer market.';

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

// â”€â”€ POST /api/opportunities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      "title": "Short opportunity title (4â€“7 words)",
      "category": "content | product | market | partnership | positioning | community",
      "desc": "2â€“3 sentences describing the opportunity and why it exists now",
      "why": "1 sentence: why this specific brand is positioned to capture it",
      "effort": "low | medium | high",
      "impact": "low | medium | high",
      "action": "Specific, actionable first step (1 sentence starting with a verb)"
    }
  ],
  "summary": "2â€“3 sentence strategic overview of the opportunity landscape for this brand"
}

Rules:
- All 5 opportunities must be distinct categories
- Be specific to this brand â€” no generic 'improve your social media' suggestions
- Rank opportunities from highest impact to lowest in the array
- Every 'action' must be a concrete, executable next step`;

  const userMsg = ctxLines.length
    ? `Context:\n${ctxLines.join('\n')}`
    : 'No context provided â€” identify opportunities for an early-stage consumer brand in a competitive market.';

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

// â”€â”€ Campaign Generation Engine â€” full 11-step AI campaign package â”€â”€
// Receives: { product, goal, platforms, mode }
// mode='concepts' â†’ 3 concept cards (used by create wizard)
// mode='full'     â†’ complete agency-grade campaign package
/* Build brand context block — injected into system prompt when Brand Brain is active.
   Hoisted to module scope (was nested inside /api/ai/create-ad) so
   _generateAdPackage below can reuse it too. */
function _buildCampaignBrandSection(bc) {
  if (!bc || !bc.name) return '';
  const lines = [
    `\n\nBRAND BRAIN CONTEXT (CRITICAL — this is the user's real brand, use it throughout the campaign):`,
    `Brand Name: ${bc.name}`,
  ];
  if (bc.website)     lines.push(`Website: ${bc.website}`);
  if (bc.description) lines.push(`Company Description: ${bc.description}`);
  if (bc.story)       lines.push(`Brand Story: ${bc.story}`);
  if (bc.audience)    lines.push(`Target Audience: ${bc.audience}`);
  if (bc.usp)         lines.push(`Unique Selling Proposition: ${bc.usp}`);
  if (bc.toneOfVoice) lines.push(`Tone of Voice: ${bc.toneOfVoice}`);
  if (bc.competitors) lines.push(`Competitors: ${bc.competitors}`);
  if (bc.colors)      lines.push(`Brand Colours: ${bc.colors}`);
  lines.push(`\nIMPORTANT RULES:`);
  lines.push(`- Use "${bc.name}" as the brand name throughout all copy`);
  if (bc.toneOfVoice) lines.push(`- Match tone exactly: ${bc.toneOfVoice}`);
  if (bc.usp) lines.push(`- Lead with the USP in every hook and headline`);
  if (bc.audience) lines.push(`- Audience targeting must reflect: ${bc.audience}`);
  lines.push(`- The campaignName must include the brand name`);
  return lines.join('\n');
}

// V8 Epic 5 — extracted from /api/ai/create-ad's 'full' mode so the new
// /api/creative/campaign-suite route (below) can call it once per platform
// in parallel, without duplicating this prompt-building logic. Same
// schemas, same rules, same behavior as the original inline version.
async function _generateAdPackage({ user, product, goal, platform, brandCore, productImages }) {
  goal = campaignGoals.normalizeGoal(goal);
  const goalSection = `\n\n${campaignGoals.GOAL_CREATIVE_DIRECTION[goal]}`;
  const brandSection = _buildCampaignBrandSection(brandCore);
  const _bizCtx = user ? await _gatherBusinessContext(user.id).catch(() => null) : null;
  const businessSection = _bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — use it instead of generic copy; if competitor info is present, use it only for positioning, never copy competitor content):\n${_bizCtx.text}` : '';
  const productImageNote = (Array.isArray(productImages) && productImages.length)
    ? `\n\nPRODUCT ASSETS: The user has uploaded ${productImages.length} product image(s). Describe visual concepts that showcase the actual product photography — not stock imagery. Reference realistic product shots in imagePrompts.`
    : '';

  const CONCEPTS_SCHEMA = `”concepts”: [
    {"angle":"Performance","name":"...","color":"#3ecf8e","targetAudience":"...","hook":"...","marketingAngle":"...","offer":"...","cta":"...","adCopy":{"headline":"...","primaryText":"...","description":"...","benefits":["...","..."],"emotionalTriggers":["...","..."]}},
    {"angle":"Problem / Solution","name":"...","color":"#FBBC04","targetAudience":"...","hook":"...","marketingAngle":"...","offer":"...","cta":"...","adCopy":{"headline":"...","primaryText":"...","description":"...","benefits":["...","..."],"emotionalTriggers":["...","..."]}},
    {"angle":"Transformation","name":"...","color":"#63b3ff","targetAudience":"...","hook":"...","marketingAngle":"...","offer":"...","cta":"...","adCopy":{"headline":"...","primaryText":"...","description":"...","benefits":["...","..."],"emotionalTriggers":["...","..."]}}
  ]`;

  const VISUAL_SCHEMA = `"visualConcepts": [
    {"conceptRef":"Performance","visualConcept":"...","composition":"...","lighting":"...","subject":"...","emotion":"...","imagePrompts":["cinematic prompt 1","cinematic prompt 2"]},
    {"conceptRef":"Problem / Solution","visualConcept":"...","composition":"...","lighting":"...","subject":"...","emotion":"...","imagePrompts":["...","..."]},
    {"conceptRef":"Transformation","visualConcept":"...","composition":"...","lighting":"...","subject":"...","emotion":"...","imagePrompts":["...","..."]}
  ]`;

  const STRATEGY_SCHEMA = `"strategy": {
    "businessType":"...","targetAudience":"...","positioning":"...","usps":["...","...","..."],
    "painPoints":["...","..."],"objections":["...","..."],"goal":"${goal||'Sales'}",
    "budgetRecommendation":"...","angle":"...","offer":"..."
  }`;

  let platformSchema, platformRules;
  if (platform === 'meta') {
    platformSchema = `"metaAds": {
    "primaryText":"...","headline":"...","description":"...","cta":"Shop Now",
    "targetAudience":"...","placements":["Facebook Feed","Instagram Feed","Stories"],
    "campaignObjective":"${goal||'Conversions'}",
    "carouselIdeas":["...","...","..."],"imageConcepts":["...","...","..."],
    "retargetingVariation":"...","lookalikeVariation":"..."
  }`;
    platformRules = `- primaryText: 125 characters max, hook in first line
- headline: 40 characters max
- description: 30 characters max
- Write for mobile-first, thumb-stopping creative`;
  } else if (platform === 'tiktok') {
    platformSchema = `"tiktokAds": {
    "hook":"...","opening3Seconds":"...","script":"...","creatorStyleConcept":"...",
    "ugcConcept":"...","cta":"...","targetAudience":"...","campaignObjective":"${goal||'Traffic'}",
    "trendingStyleSuggestions":["...","...","..."]
  }`;
    platformRules = `- hook: 1-2 sentences, first 3 seconds of video, scroll-stopping
- script: full word-for-word video script with [0:00], [0:05] etc timestamps, 30-60 seconds
- creatorStyleConcept: describe a specific TikTok creator style to emulate
- trendingStyleSuggestions: current TikTok trend formats that fit this product`;
  } else {
    // google (default)
    platformSchema = `"googleAds": {
    "headlines":["h1","h2","h3","h4","h5","h6","h7","h8","h9","h10","h11","h12","h13","h14","h15"],
    "descriptions":["d1","d2","d3","d4"],
    "keywords":["kw1","kw2","kw3","kw4","kw5","kw6","kw7","kw8","kw9","kw10"],
    "negativeKeywords":["nk1","nk2","nk3","nk4","nk5"],
    "searchIntent":"...","biddingStrategy":"...",
    "callouts":["c1","c2","c3","c4","c5","c6"],
    "structuredSnippets":["s1","s2","s3","s4"],
    "sitelinks":["sl1","sl2","sl3","sl4"]
  }`;
    platformRules = `- headlines: max 30 characters each, exactly 15, no punctuation at end
- descriptions: max 90 characters each, exactly 4, include CTA
- keywords: mix of broad, phrase and exact intent keywords
- negativeKeywords: 5 negative keywords to exclude irrelevant traffic
- sitelinks: 4 page names that make sense for this product`;
  }

  const system = `You are Oriven AI — a senior marketing strategist, creative director, and platform specialist.
Generate a focused ${platform === 'meta' ? 'Meta Ads' : platform === 'tiktok' ? 'TikTok Ads' : 'Google Ads'} campaign package.
Reply ONLY with valid JSON — no markdown fences, no extra text.

Required JSON structure:
{
  "campaignName": "...",
  "platform": "${platform}",
  ${STRATEGY_SCHEMA},
  ${CONCEPTS_SCHEMA},
  ${platformSchema},
  ${VISUAL_SCHEMA},
  "performancePrediction": {
    "ctr": "2.4%", "creativeStrength": 85, "offerStrength": 80,
    "audienceMatch": 88, "conversionPotential": "High", "explanation": "..."
  }
}

Platform rules:
${platformRules}
- All copy must be specific to the actual product — no generic placeholders
- Performance scores are integers 0-100
- conversionPotential: "High", "Medium", or "Low"${goalSection}${brandSection}${businessSection}${productImageNote}`;

  const userMsg = brandCore && brandCore.name
    ? `Brand: ${brandCore.name}\nProduct/Service: ${product}\nGoal: ${goal}\nPlatform: ${platform}`
    : `Product/Service: ${product}\nGoal: ${goal}\nPlatform: ${platform}`;

  const raw = await _aimlText('ads-copy', system, userMsg, { max_tokens: 8000 });
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let pkg;
  try {
    pkg = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`JSON parse failed: ${parseErr.message} | raw length: ${raw.length} | tail: ${raw.slice(-120)}`);
  }
  pkg.platform = platform; // ensure frontend renderer knows which platform
  // Force the real, user-selected goal onto the package — the AI is only
  // ever shown it as an example value inside the JSON schema, so relying
  // on the model to faithfully echo it back would make the publish
  // pipeline's objective/pixel logic dependent on AI output instead of
  // the actual user choice. Every campaign must permanently know its own
  // goal (per spec) — this line is what makes that a guarantee, not a hope.
  if (!pkg.strategy) pkg.strategy = {};
  pkg.strategy.goal = goal;
  _recordCreativeAsset(user && user.id, { kind: 'ad', platform, product_name: String(product).slice(0, 80), title: pkg.campaignName || product, content: pkg, source_route: '/api/ai/create-ad' });
  return pkg;
}

app.post('/api/ai/create-ad', requireSubOrOnboardingGen, async (req, res) => {
  console.log('[create-ad] ← route handler entered');
  console.log('[create-ad] req.body keys:', Object.keys(req.body || {}));
  const { product, goal, platforms, mode, brandCore, productImages } = req.body;
  console.log('[create-ad] product:', (product || '').slice(0, 60), '| mode:', mode, '| platform:', req.body.platform, '| platforms:', platforms);
  if (!product) {
    console.log('[create-ad] 400 — product missing');
    return res.status(400).json({ error: 'product is required' });
  }

  const brandSection = _buildCampaignBrandSection(brandCore);
  const _bizCtx = req.user ? await _gatherBusinessContext(req.user.id).catch(() => null) : null;
  const businessSection = _bizCtx ? `\n\nBUSINESS KNOWLEDGE (real, stored data about this business — use it instead of generic copy; if competitor info is present, use it only for positioning, never copy competitor content):\n${_bizCtx.text}` : '';
  const productImageNote = (Array.isArray(productImages) && productImages.length)
    ? `\n\nPRODUCT ASSETS: The user has uploaded ${productImages.length} product image(s). Describe visual concepts that showcase the actual product photography â€” not stock imagery. Reference realistic product shots in imagePrompts.`
    : '';

  /* Prefer single-platform selection (V2 flow) */
  const platform = req.body.platform || (Array.isArray(platforms) && platforms[0]) || 'google';
  const platList = Array.isArray(platforms) && platforms.length
    ? platforms.join(', ')
    : 'Google Ads, Meta Ads, TikTok Ads';
  console.log('[create-ad] resolved platform:', platform, '| mode:', mode, '| brandCore:', brandCore ? brandCore.name : 'none', '| productImages:', productImages ? productImages.length : 0);

  // No charge for the one-time onboarding free generation (req._onboardingFreeGen,
  // granted by requireSubOrOnboardingGen above) -- that's a free trial shot for
  // a not-yet-paying user, not a paid-plan credit spend.
  let reservation;
  if (req.user && !req._onboardingFreeGen) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'campaign_generation');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[create-ad] Credit reservation error:', err.message);
    }
  }

  if (mode === 'concepts') {
    console.log('[create-ad] → mode=concepts branch');
    const system = `You are Oriven AI â€” a senior marketing strategist and creative director.
Generate exactly 5 campaign concepts for the product/service described.
Reply ONLY with valid JSON array (no markdown, no extra text):
[{"angle":"Performance","color":"#3ecf8e","audience":"...","hook":"...","headline":"...","text":"...","cta":"...","creative":"...","visual":"...","platforms":"${platList}"},
 {"angle":"Transformation","color":"#63b3ff",...},
 {"angle":"Problem / Solution","color":"#FBBC04",...},
 {"angle":"Social Proof","color":"#a855f7",...},
 {"angle":"Urgency","color":"#ff6b7a",...}]
- angle: exact string as shown
- hook: scroll-stopping 6-10 word hook
- headline: punchy ad headline (max 10 words)
- text: compelling primary ad copy (2-3 sentences)
- cta: action CTA (max 4 words)
- creative: brief creative direction (1 sentence)
- visual: visual description (1 sentence)${brandSection ? '\n\n' + brandSection.trim() : ''}${businessSection}`;

    const conceptsUserMsg = brandCore && brandCore.name
      ? `Brand: ${brandCore.name}\nProduct/Service: ${product}\nGoal: ${goal || 'Sales'}\nPlatforms: ${platList}`
      : `Product/Service: ${product}\nGoal: ${goal || 'Sales'}\nPlatforms: ${platList}`;
    try {
      const raw = await _aimlText('ads-copy', system, conceptsUserMsg, { max_tokens: 1800 });
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const concepts = JSON.parse(cleaned);
      _consumeOnboardingFreeGen(req);
      if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
      return res.json({ ok: true, data: { concepts } });
    } catch (err) {
      // Full detail server-side only — the client never sees provider/billing internals.
      console.error('[create-ad concepts] provider error:', err.message);
      if (err.stack) console.error(err.stack);
      if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
      return res.status(500).json({ ok: false, error: "We're unable to generate your campaign right now. Please try again later.", code: 'GENERATION_FAILED' });
    }
  }

  // mode === 'full' — focused per-platform campaign package. Delegates to
  // _generateAdPackage (extracted above for V8 Epic 5) — identical prompt
  // logic, now shared with /api/creative/campaign-suite.
  console.log('[create-ad] → mode=full branch — delegating to _generateAdPackage for platform:', platform);
  try {
    const pkg = await _generateAdPackage({ user: req.user, product, goal, platform, brandCore, productImages });
    console.log(`[create-ad] Package ready — keys: ${Object.keys(pkg).join(', ')} | visualConcepts: ${(pkg.visualConcepts||[]).length}`);
    _consumeOnboardingFreeGen(req);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    return res.json({ ok: true, data: pkg });
  } catch (err) {
    // Full detail server-side only — the client never sees provider/billing internals.
    console.error('[create-ad full] provider error:', err.message);
    if (err.stack) console.error(err.stack);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'campaign_generation', { success: false, error: err.message, route: req.path }).catch(() => {});
    return res.status(500).json({ ok: false, error: "We're unable to generate your campaign right now. Please try again later.", code: 'GENERATION_FAILED' });
  }
});

// ── Oriven AI Chat ─────────────────────────────────────────────
// Used by: the "Oriven AI" panel in Ads Manager (orvAiSend, app.html)
// Receives: { message, context: { page, googleAccount, metaAccount }, brandCore, history }
// Returns: { reply }
app.post('/api/ai/chat', requireSubIfAuthed, async (req, res) => {
  const { message, context, brandCore, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const ctx = context || {};
  let googleAccount = ctx.googleAccount || null;
  let metaAccount   = ctx.metaAccount   || null;
  let tiktokAccount = ctx.tiktokAccount || null;

  // Prefer authoritative connected-account names from the DB when the caller is authenticated.
  if (req.user) {
    try {
      const { data: rows } = await supabaseAdmin
        .from('integrations')
        .select('provider, active_ad_account')
        .eq('user_id', req.user.id)
        .in('provider', ['google_ads', 'meta_ads', 'tiktok_ads']);
      (rows || []).forEach(row => {
        const acct = row.active_ad_account;
        const name = acct && (acct.account_name || acct.account_id);
        if (!name) return;
        if (row.provider === 'google_ads') googleAccount = name;
        if (row.provider === 'meta_ads')   metaAccount   = name;
        if (row.provider === 'tiktok_ads') tiktokAccount = name;
      });
    } catch (err) {
      console.warn('[ai/chat] integrations lookup failed, falling back to client context:', err.message);
    }
  }

  const brandSection = _buildBrandSection(brandCore);
  const hasBrand = brandSection.length > 0;

  // V7 Phase 1 — Context Engine V2. Backend-persisted business knowledge
  // (profile, products, audiences, brand_cores, remembered facts) pulled in
  // automatically so the user never has to re-state it â€” independent of
  // whatever the frontend happened to pass in `brandCore` this request.
  const businessContext = req.user ? await _gatherBusinessContext(req.user.id) : null;
  const businessSection = businessContext ? `\n\nBUSINESS KNOWLEDGE (what Oriven already knows about this company — never ask for this again, use it naturally by name rather than just having it available):\n${businessContext.text}` : '';

  const accountLines = [];
  if (googleAccount) accountLines.push(`Google Ads: ${googleAccount}`);
  if (metaAccount)   accountLines.push(`Meta Ads: ${metaAccount}`);
  if (tiktokAccount) accountLines.push(`TikTok Ads: ${tiktokAccount}`);
  const accountsSection = accountLines.length
    ? `\n\nCONNECTED AD ACCOUNTS:\n${accountLines.map(l => '  - ' + l).join('\n')}`
    : '\n\nCONNECTED AD ACCOUNTS: none connected yet.';

  const pageSection = ctx.page ? `\n\nThe user is currently on the "${ctx.page}" screen of Ads Manager.` : '';

  // Oriven 1.0 (Epic 1) â€” gate on campaignName, not campaignId: the sentence
  // below only ever uses campaignName/platform, and a freshly generated
  // (not-yet-published) campaign package genuinely has no platform-assigned
  // id yet but still deserves to be "the current campaign" in context.
  const currentCampaign = ctx.currentCampaign && ctx.currentCampaign.campaignName ? ctx.currentCampaign : null;
  // Goal-aware framing (campaignGoals.GOAL_KPIS): only available when the
  // frontend actually knows the campaign's goal today (freshly generated/
  // reviewed packages, via _renderAiReview) -- live ads-manager campaigns
  // opened from admOpenCampPanel don't carry Oriven's stored goal yet, so
  // this only fires when a real goal is present, never a guessed one.
  const campaignGoalForChat = currentCampaign && campaignGoals.GOALS.includes(currentCampaign.goal) ? currentCampaign.goal : null;
  const campaignSection = currentCampaign
    ? `\n\nThe user currently has the campaign "${currentCampaign.campaignName}" (${currentCampaign.platform}) open. If they say "this campaign" or "it" without naming one, assume they mean this campaign.`
      + (campaignGoalForChat ? ` This campaign's goal is ${campaignGoalForChat} — when discussing its performance, prioritize these KPIs: ${campaignGoals.GOAL_KPIS[campaignGoalForChat].join(', ')}. Don't treat unrelated metrics as equally important.` : '')
    : '';

  // Oriven 1.0 (Epic 2/3) â€” Global Context Engine: the score/grade/strengths
  // /weaknesses shown on the Campaign Review screen the user is looking at
  // right now, so "explain my score" never has to ask what score.
  const review = ctx.review && typeof ctx.review.score === 'number' ? ctx.review : null;
  // Oriven 1.0 (V3, Epic 3) â€” name the strongest/weakest sub-score by name so
  // the model can make the kind of concrete comparison a real strategist
  // would ("your audience score is much lower than your copy score"),
  // computed from categories already present on the review, never invented.
  let categorySection = '';
  if (review && Array.isArray(review.categories) && review.categories.length >= 2) {
    const cats = review.categories.filter(c => c && c.name && typeof c.score === 'number');
    if (cats.length >= 2) {
      const best = cats.reduce((a, b) => (b.score > a.score ? b : a));
      const worst = cats.reduce((a, b) => (b.score < a.score ? b : a));
      if (best.name !== worst.name) {
        categorySection = ` Category breakdown: ${best.name} scores highest at ${best.score}, ${worst.name} scores lowest at ${worst.score} — call out this gap when it's relevant instead of just repeating the overall score.`;
      }
    }
  }
  const reviewSection = review
    ? `\n\nThe campaign review the user is currently looking at scored ${review.score}/100 (Grade ${review.grade || '?'}).${(review.strengths && review.strengths.length) ? ` Strengths: ${review.strengths.join('; ')}.` : ''}${(review.weaknesses && review.weaknesses.length) ? ` Weaknesses: ${review.weaknesses.join('; ')}.` : ''}${categorySection} If asked to "explain the score" or similar, use these real numbers rather than asking what the score is.`
    : '';

  const toolsSection = `\n\nTOOLS AVAILABLE — call one when the user is clearly asking for an action to be taken (not when they're just asking a question or making conversation):\n${toolRouter.getCatalogPrompt()}\n\nTo use a tool, reply with ONLY a JSON object on its own, nothing else: {"tool": "<tool_name>", "params": {...}}. No markdown fences, no extra text before or after. If a required param is missing or ambiguous, don't guess — ask the user a short clarifying question in plain text instead of calling the tool. For anything that isn't an action request, just reply normally in plain conversational text. Tool names like "create_campaign_package" are internal — never write them out in a conversational reply; describe the action in plain English instead (e.g. "generate a campaign package", not "use create_campaign_package").`;

  const systemPrompt = `You are Oriven, an AI marketing co-pilot built into Ads Manager. You help the user plan, create, and optimise their Google, Meta, and TikTok ad campaigns.${hasBrand ? `\n\nBRAND CONTEXT (draw on this when relevant):\n${brandSection}` : ''}${businessSection}${accountsSection}${pageSection}${campaignSection}${reviewSection}${toolsSection}

Be conversational and natural. Match the energy of the message — brief for casual small talk, thorough for strategic or campaign questions. Think like a knowledgeable colleague, not a branded bot. Never start with hollow affirmations like "Great!" or "Absolutely!". Be direct. Never mention that you are powered by any specific AI provider or model — you are simply Oriven.${businessContext ? ' When it is relevant, reference specific business knowledge by name (a real product, audience, or competitor) instead of speaking in generalities — it shows the user Oriven actually remembers their business. If competitor information is present, use it only for strategic positioning advice, never to copy or replicate a competitor\'s messaging or content.' : ''}

You are a senior marketing strategist, not a generic chatbot — assume responsibility, guide rather than react, and never ask for information already given above in this prompt. For analytical questions (score explanations, performance reviews, "why" questions), structure the answer as: the situation, the reason behind it, a concrete recommendation, and the result to expect — without labeling these parts or turning it into a rigid template for short/casual replies. If a claim would need evidence you don't have (sample size, historical performance, real conversion data), say so plainly instead of stating it with false confidence.`;

  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(history)) {
    history.slice(-20).forEach(turn => {
      if (turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content) {
        messages.push({ role: turn.role, content: String(turn.content).slice(0, 4000) });
      }
    });
  }
  messages.push({ role: 'user', content: message });

  const toolCtx = { user: req.user, authHeader: req.headers.authorization || '', currentCampaign, brandCore };

  // Charged once per user message, not per internal tool-loop AI call below
  // (up to MAX_TOOL_STEPS _aimlChat calls can fire for a single message) --
  // credits price the user action, not the provider call count.
  let reservation;
  if (req.user) {
    try {
      reservation = await creditManager.reserveCredits(req.user, 'ai_chat');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[ai/chat] Credit reservation error:', err.message);
    }
  }

  try {
    const MAX_TOOL_STEPS = 5;
    let reply = null;
    let pendingAction = null;

    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const raw = await _aimlChat(messages, { max_tokens: 1200 });
      const intent = _parseToolIntent(raw);

      if (!intent) { reply = raw; break; }

      const tool = toolRouter.getTool(intent.tool);
      if (!tool) { reply = raw; break; } // AI named an unknown tool — fall back to the raw text rather than erroring

      if (tool.requiresConfirmation && !req.user) {
        reply = "You'll need to be signed in with a connected ad account for me to do that.";
        break;
      }

      const result = await toolRouter.resolveTool(intent.tool, intent.params || {}, toolCtx);

      if (!result.ok) { reply = result.error; break; }
      if (result.clarification) { reply = result.clarification; break; }
      if (result.unsupported) { reply = result.unsupported; break; }
      if (result.pendingAction) { pendingAction = result.pendingAction; break; }

      if (result.executed) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `[Tool result for ${intent.tool}]: ${result.message}\n\nUse this to answer, or call another tool if you still need more information. Reply in plain conversational text once you have the final answer — do not show the user raw tool output.` });
        continue;
      }

      reply = "I wasn't able to complete that — could you rephrase?";
      break;
    }

    if (reservation) creditManager.finalizeCreditLog(reservation, 'ai_chat', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    if (pendingAction) return res.json({ pendingAction });
    res.json({ reply: reply || "I wasn't able to complete that — could you rephrase?", usedContext: businessContext ? businessContext.sources : undefined });
  } catch (err) {
    console.error('[ai/chat] error:', err.message);
    if (reservation) creditManager.finalizeCreditLog(reservation, 'ai_chat', { success: false, error: err.message, route: req.path }).catch(() => {});
    res.status(500).json({ error: 'Failed to generate a response. Please try again.' });
  }
});

function _parseToolIntent(raw) {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!cleaned.startsWith('{')) return null;
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.tool === 'string') return obj;
  } catch (_) { /* not a tool intent — plain reply */ }
  return null;
}

// ── Oriven AI — execute a confirmed action ─────────────────────
// Used by: action-card "Apply" button (orvAiApplyAction, app.html)
// Receives: { actionId }   Returns: { message } | { error }
app.post('/api/ai/execute', requireSubIfAuthed, async (req, res) => {
  const { actionId } = req.body || {};
  if (!actionId) return res.status(400).json({ error: 'actionId is required' });
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });

  const toolCtx = { user: req.user, authHeader: req.headers.authorization || '' };
  const result = await toolRouter.executeAction(actionId, req.user, toolCtx);
  if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
  res.json({ message: result.message });
});

// -- Campaign Publishing -- Google Ads -------------------------------------
// POST /api/publish/google
// Creates a paused Google Ads campaign with ad groups, keywords, and RSAs.
// Receives: { pkg } where pkg is the full campaign package from /api/ai/create-ad
app.post('/api/publish/google', requireSubscription, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { pkg } = req.body || {};
    if (!pkg) return res.status(400).json({ ok: false, error: 'Campaign package required' });

    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);

    console.log('[Google Publish]');
    console.log('  user     :', user.id);
    console.log('  customer :', customerId);

    const g = pkg.googleAds || {};
    const s = pkg.strategy  || {};
    const campaignName = pkg.campaignName || s.goal || 'Oriven Campaign';
    const goal = campaignGoals.normalizeGoal(s.goal);
    const googleGoalConfig = campaignGoals.GOOGLE_GOAL_CONFIG[goal];
    console.log('[publish/google] goal:', goal, '| bidding:', googleGoalConfig.biddingField);

    async function _gadsMutate(resource, operations) {
      const url = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/' + resource + ':mutate';
      const headers = {
        'Authorization':   'Bearer ' + accessToken,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
        'Content-Type':    'application/json',
      };
      if (loginCustomerId && loginCustomerId !== customerId) headers['login-customer-id'] = loginCustomerId;
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ operations }) });
      const d = await r.json();
      if (!r.ok) throw Object.assign(new Error(JSON.stringify(d.error || d)), { status: r.status });
      return d;
    }

    // 1. Campaign budget
    const budgetRes = await _gadsMutate('campaignBudgets', [{
      create: { name: campaignName + ' Budget', amountMicros: (function(){
        var budgetRec = s.budgetRecommendation;
        var amt = (typeof budgetRec === 'object' && budgetRec ? (budgetRec.amount || budgetRec.daily || 10) : (Number(budgetRec) || 10));
        return String(Math.round(amt * 1e6));
      })(), deliveryMethod: 'STANDARD' }
    }]);
    const budgetResourceName = budgetRes.results[0].resourceName;

    // 2. Campaign (PAUSED - user activates after review)
    // Bidding strategy is goal-aware (campaignGoals.GOOGLE_GOAL_CONFIG) --
    // Sales/Leads maximize conversions, Traffic maximizes clicks (the prior
    // unconditional default), Awareness targets impression share. Channel
    // type stays SEARCH for all four goals: this pipeline only ever builds
    // search ad groups/keywords/RSAs, so Awareness is differentiated by
    // bidding + broader goal-aware keywords/copy rather than a Display
    // channel switch this pipeline has no creative path for.
    const campaignRes = await _gadsMutate('campaigns', [{
      create: {
        name: campaignName,
        advertisingChannelType: 'SEARCH',
        status: 'PAUSED',
        campaignBudget: budgetResourceName,
        [googleGoalConfig.biddingField]: googleGoalConfig.biddingValue,
      }
    }]);
    const campaignResourceName = campaignRes.results[0].resourceName;
    const campaignId = campaignResourceName.split('/').pop();

    // 3. Ad group
    const adGroupRes = await _gadsMutate('adGroups', [{
      create: {
        name: (g.adGroups && g.adGroups[0] && g.adGroups[0].name) || (campaignName + ' Ad Group'),
        campaign: campaignResourceName,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
      }
    }]);
    const adGroupResourceName = adGroupRes.results[0].resourceName;

    // 4. Keywords (first 20)
    const keywords = (g.keywords || []).slice(0, 20);
    if (keywords.length) {
      await _gadsMutate('adGroupCriteria', keywords.map(kw => ({
        create: { adGroup: adGroupResourceName, text: kw, matchType: 'BROAD', status: 'ENABLED' }
      })));
    }

    // 5. Responsive Search Ad
    const headlines     = (g.headlines    || []).slice(0, 15).map(h => ({ text: String(h).slice(0, 30) }));
    const descriptions  = (g.descriptions || []).slice(0,  4).map(d => ({ text: String(d).slice(0, 90) }));
    if (headlines.length >= 3 && descriptions.length >= 2) {
      await _gadsMutate('adGroupAds', [{
        create: {
          adGroup: adGroupResourceName,
          status: 'ENABLED',
          ad: {
            responsiveSearchAd: { headlines, descriptions },
            finalUrls: [(function(){
              var u = (s.landingPageUrl || g.finalUrl || pkg.websiteUrl || s.websiteUrl || '').trim();
              if (!u) { console.warn('[publish/google] No finalUrl in package — using placeholder'); u = 'https://example.com'; }
              return u;
            })()],
          }
        }
      }]);
    }

    console.log('[publish/google] Campaign created:', campaignId, 'for user', user.id);
    return res.json({ ok: true, campaignId, campaignResourceName, platform: 'google', status: 'paused' });
  } catch (err) {
    console.error('[publish/google] error:', err.message);
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Failed to publish to Google Ads' });
  }
});

// -- Campaign Publishing -- Meta Ads ----------------------------------------
// POST /api/publish/meta
// Creates a paused Meta Ads campaign with ad set.
// Receives: { pkg } where pkg is the full campaign package from /api/ai/create-ad
app.post('/api/publish/meta', requireSubscription, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { pkg } = req.body || {};
    if (!pkg) return res.status(400).json({ ok: false, error: 'Campaign package required' });

    const { accessToken, accountId } = await _getMetaAccess(user);

    const s = pkg.strategy || {};
    const campaignName = pkg.campaignName || s.goal || 'Oriven Campaign';
    const META_API = 'https://graph.facebook.com/v20.0';

    async function _metaPost(endpoint, body) {
      const url = META_API + endpoint;
      const { access_token: _t, ...loggable } = { ...body, access_token: accessToken };
      console.log('[publish/meta] POST', url);
      console.log('[publish/meta] payload:', JSON.stringify(loggable, null, 2));

      const r = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...body, access_token: accessToken }),
      });
      const d = await r.json();

      if (!r.ok || d.error) {
        const e = d.error || {};
        console.error('[publish/meta] Graph API error ——————————');
        console.error('  endpoint        :', endpoint);
        console.error('  HTTP status     :', r.status);
        console.error('  message         :', e.message          || '—');
        console.error('  code            :', e.code             || '—');
        console.error('  error_subcode   :', e.error_subcode    || '—');
        console.error('  error_user_title:', e.error_user_title || '—');
        console.error('  error_user_msg  :', e.error_user_msg   || '—');
        console.error('  fbtrace_id      :', e.fbtrace_id       || '—');
        console.error('  full body       :', JSON.stringify(d));
        throw Object.assign(
          new Error(e.message || ('Meta API HTTP ' + r.status)),
          { status: r.status, metaCode: e.code, metaSubcode: e.error_subcode, fbtrace: e.fbtrace_id }
        );
      }
      return d;
    }

    // Goal-aware ad-set config, from the single shared source of truth
    // (campaignGoals.META_GOAL_CONFIG) also used by AI generation and the
    // other two platforms' publish routes -- see that module for why
    // Sales/Leads need a pixel and Traffic/Awareness never do.
    const goal = campaignGoals.normalizeGoal(s.goal);
    const adSetConfig = campaignGoals.META_GOAL_CONFIG[goal];
    const objective = adSetConfig.objective;
    console.log('[publish/meta] goal:', goal, '| objective:', objective, '| optimization_goal:', adSetConfig.optimization_goal, '| needsPixel:', adSetConfig.needsPixel);

    // accountId from _getMetaAccess is already normalised to exactly one 'act_' prefix.
    console.log('[publish/meta] account:', accountId);

    // 1. Campaign
    const campaign = await _metaPost('/' + accountId + '/campaigns', {
      name: campaignName, objective, status: 'PAUSED', special_ad_categories: [],
      budget_optimization_type: 'ADSET',
      is_adset_budget_sharing_enabled: false,
    });

    // 2. Ad set — only look up / require a pixel when this goal's
    // optimization goal actually needs one (see campaignGoals.META_GOAL_CONFIG).
    let pixelId = null;
    if (adSetConfig.needsPixel) {
      const pixelData = await _metaFetch('/' + accountId + '/adspixels', accessToken, { fields: 'id,name', limit: '10' });
      console.log('[publish/meta] pixel lookup accountId:', accountId);
      console.log('[publish/meta] pixel lookup raw response:', JSON.stringify(pixelData, null, 2));
      pixelId = (pixelData.data && pixelData.data[0]) ? pixelData.data[0].id : null;
      if (!pixelId) {
        throw Object.assign(new Error(`This campaign's "${s.goal || objective}" objective tracks conversions on your website, which requires a Meta Pixel. Add one in Meta Events Manager, or publish with a Traffic or Awareness objective instead — those don't need a pixel.`), { status: 400 });
      }
      console.log('[publish/meta] pixel_id:', pixelId);
    }

    const adSetPayload = {
      name: campaignName + ' Ad Set',
      campaign_id: campaign.id,
      status: 'PAUSED',
      daily_budget: 1000,
      billing_event: adSetConfig.billing_event,
      optimization_goal: adSetConfig.optimization_goal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      is_adset_budget_sharing_enabled: false,
      targeting: { age_min: 18, age_max: 65, geo_locations: { countries: ['US'] } },
    };
    if (adSetConfig.needsPixel) {
      adSetPayload.promoted_object = { pixel_id: pixelId, custom_event_type: adSetConfig.customEventType };
    }
    console.log('[META ADSET PAYLOAD]', JSON.stringify(adSetPayload, null, 2));
    const adSet = await _metaPost('/' + accountId + '/adsets', adSetPayload);

    console.log('[publish/meta] created campaign:', campaign.id, 'adset:', adSet.id);
    return res.json({ ok: true, campaignId: campaign.id, adSetId: adSet.id, platform: 'meta', status: 'paused' });
  } catch (err) {
    console.error('[publish/meta] fatal:', err.message, '| code:', err.metaCode || '—', '| subcode:', err.metaSubcode || '—');
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Failed to publish to Meta Ads' });
  }
});

// -- Campaign Publishing -- TikTok Ads ----------------------------------------
// POST /api/publish/tiktok
app.post('/api/publish/tiktok', requireSubscription, async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { pkg } = req.body || {};
    if (!pkg) return res.status(400).json({ ok: false, error: 'Campaign package required' });

    const { accessToken, advertiserId } = await _getTikTokAccess(user);

    const s   = pkg.strategy  || {};
    const tik = pkg.tiktokAds || {};
    const campaignName = pkg.campaignName || s.goal || 'Oriven TikTok Campaign';

    // Objective resolution: the campaign's own goal (one of Oriven's 4
    // universal goals, campaignGoals.TIKTOK_GOAL_CONFIG) is the primary
    // source of truth. tik.objective is a legacy freeform field (older
    // packages / future finer-grained overrides, e.g. 'video_views' or
    // 'app_install', which aren't part of the 4-goal system) and is only
    // consulted when it names something the goal mapping can't express.
    const LEGACY_OBJECTIVE_MAP = {
      awareness:       'REACH',
      traffic:         'TRAFFIC',
      app_install:     'APP_INSTALL',
      video_views:     'VIDEO_VIEWS',
      lead_generation: 'LEAD_GENERATION',
      conversions:     'CONVERSIONS',
      engagement:      'ENGAGEMENT',
      product_sales:   'PRODUCT_SALES'
    };
    const goal = campaignGoals.normalizeGoal(s.goal);
    const rawLegacyObjective = tik.objective ? String(tik.objective).toLowerCase().replace(/\s+/g, '_') : null;
    const objective = (rawLegacyObjective && LEGACY_OBJECTIVE_MAP[rawLegacyObjective])
      || campaignGoals.TIKTOK_GOAL_CONFIG[goal].objective_type;
    console.log('[publish/tiktok] goal:', goal, '| resolved objective_type:', objective, rawLegacyObjective ? '(from legacy tik.objective)' : '(from goal mapping)');

    const rawBudget = tik.budget || s.dailyBudget || s.budget || 30;
    const budget = Math.max(10, parseFloat(String(rawBudget).replace(/[^0-9.]/g, '')) || 30);

    console.log('[publish/tiktok] advertiser:', advertiserId);
    console.log('[publish/tiktok] name:', campaignName, '| objective:', objective, '| budget:', budget);

    const campaignData = await _tiktokPost('/campaign/create/', accessToken, {
      advertiser_id:      advertiserId,
      campaign_name:      campaignName,
      objective_type:     objective,
      budget_mode:        'BUDGET_MODE_DAY',
      budget:             budget,
      operation_status:   'DISABLE',
      special_industries: []
    });

    const campaignId = campaignData && campaignData.campaign_id;
    if (!campaignId) throw new Error('TikTok did not return a campaign_id');

    console.log('[publish/tiktok] Created campaign:', campaignId);
    return res.json({ ok: true, campaignId: String(campaignId), platform: 'tiktok', status: 'paused' });
  } catch (err) {
    console.error('[publish/tiktok] fatal:', err.message, '| tiktok_code:', err.tikTokCode || '--');
    return res.status(err.status || 500).json({ ok: false, error: err.message || 'Failed to publish TikTok campaign', tiktok_code: err.tikTokCode || null });
  }
});

// â”€â”€ Public routes â€” all served by index.html (router handles view) â”€â”€
app.get('/signup',     function(req, res) { res.sendFile(path.resolve(__dirname, '..', '..', 'index.html')); });
app.get('/login',      function(req, res) { res.sendFile(path.resolve(__dirname, '..', '..', 'index.html')); });
app.get('/plan',       function(req, res) { res.redirect(302, '/app'); });
app.get('/onboarding', function(req, res) { res.redirect(302, '/app?tour=1'); });

// â”€â”€ /app â†’ ORIVEN application â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/app', function(req, res) {
  res.sendFile(path.resolve(__dirname, '..', '..', 'app.html'));
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// GOOGLE ADS OAUTH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
    console.warn('[Google Ads] GOOGLE_ADS_DEVELOPER_TOKEN not set â€” skipping account fetch');
    return { accounts: [], error: 'GOOGLE_ADS_DEVELOPER_TOKEN not configured' };
  }

  const GADS_TIMEOUT_MS = 10000; // 10 s â€” well inside Render's 30 s limit
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

  // Step 1 â€” list all customer resource names the token can access
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

  // Step 2 â€” fetch name, currency, manager flag, status for each direct customer (up to 20)
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

    // For manager accounts â€” fetch direct (level=1) non-manager sub-clients
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

// State store: random hex â†’ { userId, expires }. Expires after 10 min.
const _googleOAuthStates = new Map();
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of _googleOAuthStates.entries()) {
    if (v.expires < now) _googleOAuthStates.delete(k);
  }
}, 5 * 60 * 1000);

// GET /api/google/auth-url â€” authenticated, returns the Google OAuth URL
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

// GET /auth/google/callback â€” OAuth callback from Google
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  // Mirror the GOOGLE_REDIRECT_URI detection logic: explicit env var wins,
  // then fall back to Render (production) vs localhost (local dev).
  const frontendBase = FRONTEND_URL;

  if (error) {
    console.error('[Google OAuth] Denied or error:', error);
    return res.redirect(frontendBase + '/app?google_error=' + encodeURIComponent(error));
  }
  if (!code || !state) {
    return res.redirect(frontendBase + '/app?google_error=missing_params');
  }

  const stateData = _googleOAuthStates.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    _googleOAuthStates.delete(state);
    return res.redirect(frontendBase + '/app?google_error=invalid_state');
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
      return res.redirect(frontendBase + '/app?google_error=token_exchange');
    }
  } catch (err) {
    console.error('[Google OAuth] Token exchange network error:', err.message);
    return res.redirect(frontendBase + '/app?google_error=network');
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
    return res.redirect(frontendBase + '/app?google_error=db');
  }

  console.log('[Google OAuth] âœ… Connected | user:', userId, '| email:', googleEmail, '| accounts:', gadsAccounts.length);
  return res.redirect(frontendBase + '/app?google_connected=1');
});

// GET /api/google/status â€” return connection status for the authenticated user
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

// GET /api/google/accounts â€” re-fetch accessible Google Ads accounts and store them
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
      if (!integration.refresh_token) return res.status(401).json({ error: 'Token expired â€” reconnect Google Ads' });
      console.log('[Accounts] token expired, refreshingâ€¦');
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
          return res.status(401).json({ error: 'Token refresh failed â€” reconnect Google Ads' });
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

    console.log('[Accounts] calling _fetchGoogleAdsAccountsâ€¦');
    const { accounts, error: gadsErr } = await _fetchGoogleAdsAccounts(accessToken);
    console.log('[Accounts] result â€” accounts:', accounts.length, '| error:', gadsErr);

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

// POST /api/google/disconnect â€” revoke and delete integration
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

// POST /api/google/active-account â€” set the active Google Ads account for a user
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

// GET /auth/google â€” server-side redirect to Google OAuth consent screen.
// Accepts ?token= (Supabase JWT) so the frontend can build a plain link or
// window.location redirect without a separate fetch call.
// Example: window.location.href = '/auth/google?token=' + supabaseSession.access_token
app.get('/auth/google', async (req, res) => {
  const frontendBase = FRONTEND_URL;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn('[Google OAuth] /auth/google hit but credentials not configured');
    return res.redirect(frontendBase + '/app?google_error=not_configured');
  }

  const token = (req.query.token || '').toString().trim();
  if (!token) {
    console.warn('[Google OAuth] /auth/google hit with no token');
    return res.redirect(frontendBase + '/app?google_error=missing_token');
  }

  let userId;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) {
      console.warn('[Google OAuth] /auth/google invalid token:', error && error.message);
      return res.redirect(frontendBase + '/app?google_error=invalid_token');
    }
    userId = data.user.id;
  } catch (err) {
    console.error('[Google OAuth] /auth/google token validation threw:', err.message);
    return res.redirect(frontendBase + '/app?google_error=auth_error');
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

  console.log('[Google OAuth] Redirecting user', userId, 'â†’ Google consent screen');
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// GET /api/google-ads/accounts â€” spec-exact endpoint
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
        return res.status(401).json({ error: 'Token expired â€” reconnect Google Ads' });
      }
      console.log('[google-ads/accounts] Token expired â€” refreshingâ€¦');
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
        return res.status(401).json({ error: 'Token refresh failed â€” reconnect Google Ads' });
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

// GET /api/google-ads/campaigns â€” spec-exact endpoint
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TIKTOK ADS INTEGRATION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Required Supabase columns on the `integrations` table
// (run once in the SQL editor before using this integration):
//   ALTER TABLE integrations
//     ADD COLUMN IF NOT EXISTS tiktok_display_name TEXT,
//     ADD COLUMN IF NOT EXISTS tiktok_ads_accounts JSONB DEFAULT '[]';

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

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

// ── Helper: authenticated GET to TikTok Business API ────────────────────
async function _tiktokFetch(path, accessToken, queryParams) {
  const params = new URLSearchParams(queryParams || {});
  const url = TIKTOK_API + path + (params.toString() ? '?' + params.toString() : '');
  let res, data;
  try {
    res  = await fetch(url, { headers: { 'Access-Token': accessToken, 'Accept': 'application/json' } });
    data = await res.json();
  } catch (netErr) {
    const e = new Error('TikTok API network error: ' + netErr.message);
    e.status = 503;
    throw e;
  }
  console.log('[TikTokAPI GET]', path, '| code:', data.code, '| message:', data.message);
  if (data.code !== 0) {
    const msg = data.message || ('TikTok API error code ' + data.code);
    console.error('[TikTokAPI GET]', path, '→', msg, '| code:', data.code, '| full:', JSON.stringify(data));
    const e = new Error(msg);
    e.tikTokCode = data.code;
    e.status = (data.code === 40001 || data.code === 40105 || data.code === 40106) ? 401
             : (data.code === 40002 || data.code === 40007) ? 403
             : 503;
    throw e;
  }
  return data.data;
}

// ── Helper: authenticated POST to TikTok Business API ────────────────────
async function _tiktokPost(path, accessToken, body) {
  const url = TIKTOK_API + path;
  console.log('[TikTok POST]', url);
  console.log('[TikTok POST] body:', JSON.stringify(body, null, 2));
  let res, data;
  try {
    res  = await fetch(url, {
      method:  'POST',
      headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    data = await res.json();
  } catch (netErr) {
    const e = new Error('TikTok API network error: ' + netErr.message);
    e.status = 503;
    throw e;
  }
  console.log('[TikTok POST] response code:', data.code, '| message:', data.message);
  if (data.code !== 0) {
    const msg = data.message || ('TikTok API error code ' + data.code);
    console.error('[TikTokAPIPost]', path, '→', msg, '| code:', data.code);
    console.error('[TikTokAPIPost] full body:', JSON.stringify(data));
    const e = new Error(msg);
    e.tikTokCode = data.code;
    e.status = (data.code === 40001 || data.code === 40105 || data.code === 40106) ? 401
             : (data.code === 40002 || data.code === 40007) ? 403
             : 503;
    throw e;
  }
  return data.data;
}

// ── Helper: resolve valid token + active advertiser for a user ────────────────
async function _getTikTokAccess(user) {
  const { data: intg, error } = await supabaseAdmin
    .from('integrations')
    .select('access_token, token_expiry, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'tiktok_ads')
    .maybeSingle();
  if (error || !intg) {
    const e = new Error('TikTok Ads not connected'); e.status = 400; throw e;
  }
  if (intg.token_expiry && new Date(intg.token_expiry) < new Date()) {
    const e = new Error('TikTok access token expired — reconnect TikTok Ads in Integrations'); e.status = 401; throw e;
  }
  const active = intg.active_ad_account;
  if (!active || !active.account_id) {
    const e = new Error('No active TikTok Ads account selected — go to Integrations and choose an account.'); e.status = 400; throw e;
  }
  return {
    accessToken:  intg.access_token,
    advertiserId: String(active.account_id),
    accountName:  active.account_name || active.account_id
  };
}

// ── Helper: fetch advertiser list from TikTok ────────────────────────────
async function _fetchTikTokAdvertisers(accessToken) {
  const url = TIKTOK_API + '/oauth2/advertiser/get/?' + new URLSearchParams({
    access_token: accessToken,
    app_id:       TIKTOK_APP_ID,
    secret:       TIKTOK_APP_SECRET
  }).toString();
  let res, data;
  try {
    res  = await fetch(url, { headers: { Accept: 'application/json' } });
    data = await res.json();
  } catch (netErr) {
    const e = new Error('TikTok API network error: ' + netErr.message);
    e.status = 503;
    throw e;
  }
  if (data.code !== 0) {
    const msg = data.message || ('TikTok API error code ' + data.code);
    console.error('[TikTok Advertisers]', msg, '| code:', data.code);
    const e = new Error(msg); e.tikTokCode = data.code; e.status = 503; throw e;
  }
  return ((data.data && data.data.list) || []).map(function(a) {
    return {
      account_id:   String(a.advertiser_id),
      account_name: a.advertiser_name || '',
      currency:     a.currency        || '',
      timezone:     a.timezone        || ''
    };
  });
}

// GET /api/tiktok/auth-url â€” returns TikTok OAuth authorization URL

// ── Google Ads Campaign Management Routes ────────────────────────────────────

// GET /api/google/campaigns – campaign list for Ads Manager
app.get('/api/google/campaigns', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, customerId, loginCustomerId, activeAccount } = await _getGadsAccess(user);
    console.log('[Google Campaigns] Fetching | user:', user.id, '| customer:', customerId);
    const results = await _gadsQuery(accessToken, customerId, [
      'SELECT',
      '  campaign.id,',
      '  campaign.name,',
      '  campaign.status,',
      '  campaign.advertising_channel_type,',
      '  campaign.start_date,',
      '  campaign.resource_name,',
      '  campaign_budget.amount_micros,',
      '  campaign_budget.resource_name',
      'FROM campaign',
      "WHERE campaign.status != 'REMOVED'",
      'ORDER BY campaign.id DESC',
      'LIMIT 100'
    ].join(' '), loginCustomerId);
    const campaigns = results.map(function(r) {
      const c  = r.campaign       || {};
      const cb = r.campaignBudget || {};
      return {
        campaign_id:       String(c.id || ''),
        campaign_name:     c.name || 'Unnamed',
        campaign_resource: c.resourceName || '',
        status:            c.status || 'UNKNOWN',
        channel_type:      c.advertisingChannelType || '',
        start_date:        c.startDate || null,
        budget_micros:     Number(cb.amountMicros || 0),
        budget_resource:   cb.resourceName || ''
      };
    });
    console.log('[Google Campaigns] Returned', campaigns.length, 'campaigns | customer:', customerId);
    res.json({ campaigns, customer_id: customerId, currency: (activeAccount && activeAccount.currency) || 'USD' });
  } catch (err) {
    console.error('[Google Campaigns] error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/google/campaign/:id – single campaign
app.get('/api/google/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const campaignId = String(req.params.id).replace(/[^0-9]/g, '');
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign ID' });
    const { accessToken, customerId, loginCustomerId, activeAccount } = await _getGadsAccess(user);
    console.log('[Google Campaign Fetch]', campaignId, '| user:', user.id, '| customer:', customerId);
    const q = [
      'SELECT campaign.id, campaign.name, campaign.status,',
      '  campaign.advertising_channel_type, campaign.start_date,',
      '  campaign.resource_name, campaign_budget.amount_micros,',
      '  campaign_budget.resource_name',
      'FROM campaign',
      'WHERE campaign.id = ' + campaignId,
      'LIMIT 1'
    ].join(' ');
    const results = await _gadsQuery(accessToken, customerId, q, loginCustomerId);
    if (!results.length) return res.status(404).json({ error: 'Campaign not found' });
    const r  = results[0];
    const c  = r.campaign       || {};
    const cb = r.campaignBudget || {};
    res.json({ campaign: {
      campaign_id:       String(c.id || ''),
      campaign_name:     c.name || 'Unnamed',
      campaign_resource: c.resourceName || '',
      status:            c.status || 'UNKNOWN',
      channel_type:      c.advertisingChannelType || '',
      start_date:        c.startDate || null,
      budget_micros:     Number(cb.amountMicros || 0),
      budget_resource:   cb.resourceName || '',
      currency:          (activeAccount && activeAccount.currency) || 'USD'
    }});
  } catch (err) {
    console.error('[Google Campaign Fetch] FAILED', req.params.id, ':', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/google/campaign/:id – update name and/or budget
app.patch('/api/google/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const campaignId = String(req.params.id).replace(/[^0-9]/g, '');
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign ID' });
    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    const { name, daily_budget } = req.body || {};
    if (!name && daily_budget === undefined) return res.status(400).json({ error: 'Nothing to update' });
    const campaignResource = 'customers/' + customerId + '/campaigns/' + campaignId;
    console.log('[Google Campaign Edit] campaign:', campaignId, '| user:', user.id, '| customer:', customerId,
      '| name:', name || '(unchanged)', '| budget:', daily_budget !== undefined ? daily_budget : '(unchanged)');
    if (name && String(name).trim()) {
      await _gadsMutate(accessToken, customerId, 'campaigns', [{
        updateMask: 'name',
        update: { resourceName: campaignResource, name: String(name).trim() }
      }], loginCustomerId);
    }
    if (daily_budget !== undefined) {
      const bQ = 'SELECT campaign_budget.resource_name FROM campaign WHERE campaign.id = ' + campaignId + ' LIMIT 1';
      const bR = await _gadsQuery(accessToken, customerId, bQ, loginCustomerId);
      if (!bR.length) return res.status(404).json({ error: 'Campaign not found' });
      const budgetResource = (bR[0].campaignBudget || {}).resourceName;
      if (!budgetResource) return res.status(400).json({ error: 'Campaign has no detached budget' });
      await _gadsMutate(accessToken, customerId, 'campaignBudgets', [{
        updateMask: 'amountMicros',
        update: { resourceName: budgetResource, amountMicros: String(Math.round(Number(daily_budget) * 1e6)) }
      }], loginCustomerId);
    }
    console.log('[Google Campaign Edit] OK');
    res.json({ ok: true });
  } catch (err) {
    console.error('[Google Campaign Edit] FAILED', req.params.id, '| gadsErr:', (err.gadsErrorCodes || []).join(','), '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/google/campaign/:id/pause
app.post('/api/google/campaign/:id/pause', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const campaignId = String(req.params.id).replace(/[^0-9]/g, '');
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign ID' });
    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    console.log('[Google Campaign Pause] campaign:', campaignId, '| user:', user.id, '| customer:', customerId);
    await _gadsMutate(accessToken, customerId, 'campaigns', [{
      updateMask: 'status',
      update: { resourceName: 'customers/' + customerId + '/campaigns/' + campaignId, status: 'PAUSED' }
    }], loginCustomerId);
    console.log('[Google Campaign Pause] OK');
    res.json({ ok: true, status: 'PAUSED' });
  } catch (err) {
    console.error('[Google Campaign Pause] FAILED', req.params.id, '| gadsErr:', (err.gadsErrorCodes || []).join(','), '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/google/campaign/:id/resume
//
// TEMPORARY DIAGNOSTIC BUILD -- logging only, no behavior/logic change.
// The actual Google Ads request (URL, method, headers, body) and the
// error contract returned to the frontend (err.status / err.message)
// are identical to the previous implementation via _gadsMutate. This
// version additionally captures and prints the complete, untruncated
// Google Ads API response plus supporting context so the real root
// cause of the Resume permissions error can be identified. Remove/
// simplify once root-caused.
app.post('/api/google/campaign/:id/resume', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const campaignId = String(req.params.id).replace(/[^0-9]/g, '');
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign ID' });
    const { accessToken, customerId, loginCustomerId, activeAccount } = await _getGadsAccess(user);

    // ── DIAGNOSTIC CONTEXT ──────────────────────────────────────────────
    let _diagGoogleEmail = null;
    try {
      const { data: intgRow } = await supabaseAdmin
        .from('integrations')
        .select('google_email')
        .eq('user_id', user.id)
        .eq('provider', 'google_ads')
        .maybeSingle();
      _diagGoogleEmail = intgRow && intgRow.google_email;
    } catch (_) {}

    console.log('════════════════════════════════════════════════════════');
    console.log('[Resume DIAG] campaign_id         :', campaignId);
    console.log('[Resume DIAG] oriven user_id       :', user.id);
    console.log('[Resume DIAG] OAuth google_email   :', _diagGoogleEmail || '(unknown)');
    console.log('[Resume DIAG] customer_id (target) :', customerId);
    console.log('[Resume DIAG] login_customer_id    :', loginCustomerId,
      loginCustomerId === customerId ? '(same as target -- header omitted, non-MCC)' : '(different -- real MCC, header sent)');
    console.log('[Resume DIAG] active_ad_account    :', JSON.stringify(activeAccount));

    // Diagnostic only: does this campaign actually exist under the target
    // customer right now? A miss here would mean the campaign belongs to
    // a different customer than the one currently active/selected (e.g.
    // publish happened under a different account than resume is using).
    try {
      const camRows = await _gadsQuery(accessToken, customerId,
        'SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name FROM campaign WHERE campaign.id = ' + campaignId,
        loginCustomerId);
      console.log('[Resume DIAG] campaign lookup under', customerId, ':', JSON.stringify(camRows));
      if (!camRows.length) {
        console.warn('[Resume DIAG] ⚠ campaign', campaignId, 'NOT found under customer', customerId,
          '-- likely belongs to a different customer account than the one currently active.');
      }
    } catch (lookupErr) {
      console.warn('[Resume DIAG] campaign lookup failed (non-fatal):', lookupErr.message,
        '| raw:', (lookupErr.gadsRawBody || '').slice(0, 3000));
    }

    // Diagnostic only: what access role does this OAuth account have on
    // the target customer -- STANDARD or ADMIN (or not listed at all)?
    try {
      const accessRows = await _gadsQuery(accessToken, customerId,
        'SELECT customer_user_access.email_address, customer_user_access.access_role FROM customer_user_access',
        loginCustomerId);
      console.log('[Resume DIAG] customer_user_access:', JSON.stringify(accessRows));
      const mine = accessRows.find(function(r) {
        return r.customerUserAccess && _diagGoogleEmail && r.customerUserAccess.emailAddress === _diagGoogleEmail;
      });
      console.log('[Resume DIAG] this account\'s access_role:', mine ? mine.customerUserAccess.accessRole : '(not found in access list)');
    } catch (accessErr) {
      console.warn('[Resume DIAG] customer_user_access lookup failed (non-fatal):', accessErr.message,
        '| raw:', (accessErr.gadsRawBody || '').slice(0, 3000));
    }

    const operations = [{
      updateMask: 'status',
      update: { resourceName: 'customers/' + customerId + '/campaigns/' + campaignId, status: 'ENABLED' }
    }];
    console.log('[Resume DIAG] mutate operation     :', JSON.stringify(operations));

    // ── ACTUAL REQUEST -- identical URL/method/headers/body to _gadsMutate,
    // inlined here only so the full raw response can be captured for this
    // diagnostic pass without touching the shared helper used elsewhere. ──
    const mutateUrl = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/campaigns:mutate';
    const mutateHeaders = {
      'Authorization':   'Bearer ' + accessToken,
      'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
      'Content-Type':    'application/json',
    };
    if (loginCustomerId && loginCustomerId !== customerId) mutateHeaders['login-customer-id'] = loginCustomerId;
    console.log('[Resume DIAG] request URL          :', mutateUrl);
    console.log('[Resume DIAG] request headers       :', JSON.stringify(Object.assign({}, mutateHeaders, { Authorization: 'Bearer ***redacted***' })));

    console.log('[Google Campaign Resume] campaign:', campaignId, '| user:', user.id, '| customer:', customerId);

    const ctrl = new AbortController();
    const tid  = setTimeout(function() { ctrl.abort(); }, 20000);
    let gRes, gText;
    try {
      gRes  = await fetch(mutateUrl, { method: 'POST', headers: mutateHeaders, body: JSON.stringify({ operations }), signal: ctrl.signal });
      gText = await gRes.text();
    } finally {
      clearTimeout(tid);
    }

    const respHeaders = {};
    gRes.headers.forEach(function(v, k) { respHeaders[k] = v; });
    console.log('[Resume DIAG] response HTTP status :', gRes.status);
    console.log('[Resume DIAG] response headers      :', JSON.stringify(respHeaders));
    console.log('[Resume DIAG] response body (FULL, untruncated):');
    console.log(gText);

    let gData;
    try { gData = JSON.parse(gText); } catch (_) { gData = {}; }

    if (!gRes.ok) {
      const gErrObj  = gData.error || {};
      const detail0  = (gErrObj.details && gErrObj.details[0]) || {};
      const gadsErrs = Array.isArray(detail0.errors) ? detail0.errors : [];

      console.error('════════════════════════════════════════════════════════');
      console.error('[Resume DIAG] ✗✗✗ GOOGLE ADS REJECTED THE RESUME REQUEST ✗✗✗');
      console.error('[Resume DIAG] Google error.code    :', gErrObj.code);
      console.error('[Resume DIAG] Google error.status   :', gErrObj.status);
      console.error('[Resume DIAG] Google error.message  :', gErrObj.message);
      gadsErrs.forEach(function(e, i) {
        console.error('[Resume DIAG]   errors[' + i + '].errorCode :', JSON.stringify(e.errorCode));
        console.error('[Resume DIAG]   errors[' + i + '].message   :', e.message);
        console.error('[Resume DIAG]   errors[' + i + '].trigger   :', JSON.stringify(e.trigger));
        console.error('[Resume DIAG]   errors[' + i + '].location  :', JSON.stringify(e.location));
      });
      console.error('[Resume DIAG] request-id (if any)  :', respHeaders['request-id'] || respHeaders['x-request-id'] || '(none present in response headers)');
      console.error('════════════════════════════════════════════════════════');

      const errCodes = [];
      gadsErrs.forEach(function(e) {
        if (e.errorCode) errCodes.push(JSON.stringify(e.errorCode));
        if (e.message)   errCodes.push('msg:' + e.message);
      });
      const msg = gErrObj.message || ('Google Ads API HTTP ' + gRes.status);
      const err = new Error(msg);
      err.status = gRes.status;
      err.gadsStatus = gErrObj;
      err.gadsErrorCodes = errCodes;
      err.gadsRawBody = gText;
      throw err;
    }

    console.log('[Google Campaign Resume] OK');
    res.json({ ok: true, status: 'ENABLED' });
  } catch (err) {
    console.error('[Google Campaign Resume] FAILED', req.params.id, '| gadsErr:', (err.gadsErrorCodes || []).join(','), '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/google/campaign/:id – remove campaign from Google Ads
app.delete('/api/google/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const campaignId = String(req.params.id).replace(/[^0-9]/g, '');
    if (!campaignId) return res.status(400).json({ error: 'Invalid campaign ID' });
    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    console.log('[Google Campaign Delete] campaign:', campaignId, '| user:', user.id, '| customer:', customerId);
    await _gadsMutate(accessToken, customerId, 'campaigns', [{
      remove: 'customers/' + customerId + '/campaigns/' + campaignId
    }], loginCustomerId);
    console.log('[Google Campaign Delete] OK — campaign removed');
    res.json({ ok: true, removed: true });
  } catch (err) {
    console.error('[Google Campaign Delete] FAILED', req.params.id, '| gadsErr:', (err.gadsErrorCodes || []).join(','), '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /auth/tiktok -- server-side redirect to TikTok OAuth consent screen
// Frontend usage: window.location.href = '/auth/tiktok?token=' + session.access_token
app.get('/auth/tiktok', async (req, res) => {
  const frontendBase = FRONTEND_URL;

  if (!TIKTOK_APP_ID || !TIKTOK_APP_SECRET) {
    console.warn('[TikTok OAuth] /auth/tiktok hit but credentials not configured');
    return res.redirect(frontendBase + '/app?tiktok_error=not_configured');
  }

  const token = (req.query.token || '').toString().trim();
  if (!token) return res.redirect(frontendBase + '/app?tiktok_error=missing_token');

  let userId;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.redirect(frontendBase + '/app?tiktok_error=invalid_token');
    }
    userId = data.user.id;
  } catch (err) {
    console.error('[TikTok OAuth] Token validation error:', err.message);
    return res.redirect(frontendBase + '/app?tiktok_error=auth_error');
  }

  const state = crypto.randomBytes(16).toString('hex');
  _tiktokOAuthStates.set(state, { userId, expires: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    app_id:       TIKTOK_APP_ID,
    state,
    redirect_uri: TIKTOK_REDIRECT_URI
  });

  const authUrl = 'https://business-api.tiktok.com/portal/auth?' + params.toString();
  console.log('[TikTok OAuth /auth/tiktok] redirect_uri sent to TikTok:', TIKTOK_REDIRECT_URI);
  console.log('[TikTok OAuth /auth/tiktok] full OAuth URL:', authUrl);
  console.log('[TikTok OAuth] Redirecting user', userId, '→ TikTok Login');
  res.redirect(authUrl);
});

// GET /api/tiktok/auth-url -- returns TikTok OAuth URL as JSON (for frontend-driven flows)
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
  const authUrl = 'https://business-api.tiktok.com/portal/auth?' + params.toString();
  console.log('[TikTok auth-url] redirect_uri sent to TikTok:', TIKTOK_REDIRECT_URI);
  console.log('[TikTok auth-url] full OAuth URL:', authUrl);
  res.json({ url: authUrl });
});

// GET /auth/tiktok/callback â€” OAuth callback from TikTok
app.get('/auth/tiktok/callback', async (req, res) => {
  const { auth_code, state, error } = req.query;
  const frontendBase = FRONTEND_URL;
  console.log('[TikTok Callback Step 1] Received | auth_code:', auth_code ? auth_code.slice(0,8)+'...' : 'MISSING', '| state:', state ? state.slice(0,8)+'...' : 'MISSING', '| error:', error || 'none');

  if (error) {
    console.error('[TikTok OAuth] Error from provider:', error);
    return res.redirect(frontendBase + '/app?tiktok_error=' + encodeURIComponent(error));
  }
  if (!auth_code || !state) {
    return res.redirect(frontendBase + '/app?tiktok_error=missing_params');
  }

  const stateData = _tiktokOAuthStates.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    _tiktokOAuthStates.delete(state);
    return res.redirect(frontendBase + '/app?tiktok_error=invalid_state');
  }
  _tiktokOAuthStates.delete(state);
  const userId = stateData.userId;

  // Step 1: Exchange auth_code for access_token
  let accessToken, refreshToken, tokenExpiry, advertiserIds = [];
  try {
    const tokenRes = await fetch(TIKTOK_API + '/oauth2/access_token/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ app_id: TIKTOK_APP_ID, secret: TIKTOK_APP_SECRET, auth_code })
    });
    const tokenData = await tokenRes.json();
    console.log('[TikTok Callback Step 2] Token exchange response | code:', tokenData.code, '| message:', tokenData.message, '| full data keys:', tokenData.data ? Object.keys(tokenData.data).join(',') : 'null');
    console.log('[TikTok OAuth] Token exchange code:', tokenData.code, '| message:', tokenData.message);
    if (tokenData.code !== 0 || !tokenData.data || !tokenData.data.access_token) {
      console.error('[TikTok OAuth] Token exchange failed:', tokenData.message, '| code:', tokenData.code);
      return res.redirect(frontendBase + '/app?tiktok_error=token_exchange');
    }
    accessToken   = tokenData.data.access_token;
    refreshToken  = tokenData.data.refresh_token  || null;
    advertiserIds = tokenData.data.advertiser_ids  || [];
    // token_expiry_ts is a Unix timestamp in seconds
    tokenExpiry   = tokenData.data.token_expiry_ts
      ? new Date(tokenData.data.token_expiry_ts * 1000).toISOString()
      : new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(); // 23h fallback
    console.log('[TikTok OAuth] Access token obtained | expires:', tokenExpiry, '| advertisers:', advertiserIds.length);
  } catch (err) {
    console.error('[TikTok OAuth] Token exchange network error:', err.message);
    return res.redirect(frontendBase + '/app?tiktok_error=network');
  }

  // Step 2: Fetch advertiser details (names, currencies, timezones)
  let adAccounts = [];
  try {
    adAccounts = await _fetchTikTokAdvertisers(accessToken);
    console.log('[TikTok Callback Step 3] Fetched advertisers:', adAccounts.length, '| ids from token:', advertiserIds.join(','));
    console.log('[TikTok OAuth] Fetched', adAccounts.length, 'advertiser(s)');
    // Filter to only the IDs the user actually authorized
    if (advertiserIds.length > 0) {
      const idSet = new Set(advertiserIds.map(String));
      adAccounts = adAccounts.filter(function(a) { return idSet.has(String(a.account_id)); });
    }
  } catch (err) {
    console.warn('[TikTok OAuth] Could not fetch advertiser details:', err.message);
    // Fall back to ID-only entries
    adAccounts = advertiserIds.map(function(id) {
      return { account_id: String(id), account_name: 'Advertiser ' + id, currency: '', timezone: '' };
    });
  }

  // Step 3: Pick display name from first advertiser
  const displayName = adAccounts.length > 0
    ? adAccounts[0].account_name
    : (advertiserIds[0] ? String(advertiserIds[0]) : null);

  // Step 4: Upsert into Supabase
  console.log('[TikTok Callback Step 4] Upserting to Supabase | user:', userId, '| displayName:', displayName, '| accounts:', adAccounts.length, '| tokenExpiry:', tokenExpiry);
  const { data: upsertData, error: dbError } = await supabaseAdmin
    .from('integrations')
    .upsert({
      user_id:             userId,
      provider:            'tiktok_ads',
      tiktok_display_name: displayName,
      access_token:        accessToken,
      refresh_token:       refreshToken,
      token_expiry:        tokenExpiry,
      connected_at:        new Date().toISOString(),
      tiktok_ads_accounts: adAccounts
    }, { onConflict: 'user_id,provider' })
    .select('user_id, provider, tiktok_display_name, token_expiry, tiktok_ads_accounts');

  console.log('[TikTok Callback Step 4] Upsert result | error:', dbError ? dbError.message : 'none', '| returned rows:', upsertData ? upsertData.length : 0);

  if (dbError) {
    console.error('[TikTok Callback Step 4] DB upsert FAILED:', JSON.stringify(dbError));
    return res.redirect(frontendBase + '/app?tiktok_error=db');
  }

  // Step 5: Read-back verification
  const { data: readBack, error: readErr } = await supabaseAdmin
    .from('integrations')
    .select('user_id, provider, tiktok_display_name, connected_at, token_expiry, tiktok_ads_accounts, active_ad_account')
    .eq('user_id', userId)
    .eq('provider', 'tiktok_ads')
    .maybeSingle();
  console.log('[TikTok Callback Step 5] DB read-back | error:', readErr ? readErr.message : 'none');
  console.log('[TikTok Callback Step 5] DB read-back | data:', JSON.stringify(readBack));

  console.log('[TikTok Callback] Success | user:', userId, '| name:', displayName, '| accounts:', adAccounts.length);
  return res.redirect(frontendBase + '/app?tiktok_connected=1');
});

// GET /api/tiktok/status â€” return TikTok connection status for the authenticated user
app.get('/api/tiktok/status', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  console.log('[TikTok Status] Querying integrations for user:', user.id);
  const { data, error } = await supabaseAdmin
    .from('integrations')
    .select('tiktok_display_name, connected_at, token_expiry, tiktok_ads_accounts, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'tiktok_ads')
    .maybeSingle();

  console.log('[TikTok Status] Query result | error:', error ? error.message : 'none', '| data:', data ? JSON.stringify(data) : 'null');
  if (error) { console.error('[TikTok Status] DB error:', JSON.stringify(error)); return res.status(500).json({ error: 'Database error', detail: error.message }); }
  if (!data)  { console.log('[TikTok Status] No row found — not connected'); return res.json({ connected: false }); }

  const tokenExpired = data.token_expiry && new Date(data.token_expiry) < new Date();
  res.json({
    connected:           !tokenExpired,
    status:              tokenExpired ? 'expired' : 'connected',
    tiktok_display_name: data.tiktok_display_name  || null,
    connected_at:        data.connected_at          || null,
    token_expiry:        data.token_expiry           || null,
    tiktok_ads_accounts: data.tiktok_ads_accounts   || [],
    active_ad_account:   data.active_ad_account      || null
  });
});

// GET /api/tiktok/accounts â€” re-fetch accessible TikTok Ads accounts
app.get('/api/tiktok/accounts', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { data: intg, error: fetchErr } = await supabaseAdmin
      .from('integrations')
      .select('access_token, token_expiry')
      .eq('user_id', user.id)
      .eq('provider', 'tiktok_ads')
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: 'Database error' });
    if (!intg)    return res.status(404).json({ error: 'TikTok Ads not connected' });
    if (intg.token_expiry && new Date(intg.token_expiry) < new Date()) {
      return res.status(401).json({ error: 'TikTok token expired — reconnect TikTok Ads' });
    }

    const accounts = await _fetchTikTokAdvertisers(intg.access_token);

    await supabaseAdmin.from('integrations')
      .update({ tiktok_ads_accounts: accounts })
      .eq('user_id', user.id)
      .eq('provider', 'tiktok_ads');

    res.json({ accounts });
  } catch (err) {
    console.error('[tiktok/accounts]', err.message);
    res.status(err.status || 500).json({ error: err.message, tiktok_code: err.tikTokCode || null });
  }
});

// POST /api/tiktok/disconnect â€” delete TikTok integration row
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

// POST /api/tiktok/active-account â€” set active TikTok Ads account for a user
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

// GET /api/tiktok/campaigns -- campaign list with status and budget
app.get('/api/tiktok/campaigns', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, advertiserId } = await _getTikTokAccess(user);

    const data = await _tiktokFetch('/campaign/get/', accessToken, {
      advertiser_id: advertiserId,
      fields:        JSON.stringify(['campaign_id','campaign_name','status','operation_status','objective_type','budget','budget_mode','create_time']),
      page_size:     '100'
    });

    const campaigns = ((data && data.list) || []).map(function(c) {
      return {
        campaign_id:   String(c.campaign_id),
        campaign_name: c.campaign_name   || 'Unnamed',
        status:        c.operation_status || c.status || 'UNKNOWN',
        objective:     c.objective_type  || '',
        budget:        c.budget          || 0,
        budget_mode:   c.budget_mode     || '',
        created_time:  c.create_time ? new Date(c.create_time * 1000).toISOString() : null
      };
    });

    console.log('[tiktok/campaigns] Returned', campaigns.length, 'campaigns | advertiser:', advertiserId);
    res.json({ campaigns, advertiser_id: advertiserId });
  } catch (err) {
    console.error('[tiktok/campaigns]', err.message);
    res.status(err.status || 500).json({ error: err.message, tiktok_code: err.tikTokCode || null });
  }
});

// POST /api/tiktok/campaign/:id/pause
app.post('/api/tiktok/campaign/:id/pause', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, advertiserId } = await _getTikTokAccess(user);
    const campaignId = req.params.id;
    console.log('[TikTok Campaign Pause] campaign:', campaignId, '| advertiser:', advertiserId);
    await _tiktokPost('/campaign/status/update/', accessToken, {
      advertiser_id:    advertiserId,
      campaign_ids:     [campaignId],
      operation_status: 'DISABLE'
    });
    console.log('[TikTok Campaign Pause] OK');
    res.json({ ok: true, status: 'DISABLE' });
  } catch (err) {
    console.error('[TikTok Campaign Pause] FAILED', req.params.id, '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/tiktok/campaign/:id/resume
app.post('/api/tiktok/campaign/:id/resume', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, advertiserId } = await _getTikTokAccess(user);
    const campaignId = req.params.id;
    console.log('[TikTok Campaign Resume] campaign:', campaignId, '| advertiser:', advertiserId);
    await _tiktokPost('/campaign/status/update/', accessToken, {
      advertiser_id:    advertiserId,
      campaign_ids:     [campaignId],
      operation_status: 'ENABLE'
    });
    console.log('[TikTok Campaign Resume] OK');
    res.json({ ok: true, status: 'ENABLE' });
  } catch (err) {
    console.error('[TikTok Campaign Resume] FAILED', req.params.id, '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/tiktok/campaign/:id
app.delete('/api/tiktok/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, advertiserId } = await _getTikTokAccess(user);
    const campaignId = req.params.id;
    console.log('[TikTok Campaign Delete] campaign:', campaignId, '| advertiser:', advertiserId);
    await _tiktokPost('/campaign/delete/', accessToken, {
      advertiser_id: advertiserId,
      campaign_ids:  [campaignId]
    });
    console.log('[TikTok Campaign Delete] OK');
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[TikTok Campaign Delete] FAILED', req.params.id, '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// META ADS INTEGRATION
// Uses Facebook Marketing API v21.0
//
// Required Supabase columns on the `integrations` table
// (run once in the SQL editor before using this integration):
//   ALTER TABLE integrations
//     ADD COLUMN IF NOT EXISTS meta_user_name    TEXT,
//     ADD COLUMN IF NOT EXISTS meta_user_id      TEXT,
//     ADD COLUMN IF NOT EXISTS meta_ads_accounts JSONB DEFAULT '[]';
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const META_APP_ID     = process.env.META_APP_ID     || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_REDIRECT_URI = process.env.META_REDIRECT_URI
  || (process.env.RENDER
    ? 'https://oriven-backand-clean.onrender.com/auth/meta/callback'
    : 'http://localhost:5500/auth/meta/callback');
const META_SCOPES  = 'ads_read,ads_management,business_management';
const META_API_VER = 'v21.0';
const META_GRAPH   = 'https://graph.facebook.com/' + META_API_VER;

// CSRF state store â€” same 10-minute expiry pattern as Google / TikTok
const _metaOAuthStates = new Map();
setInterval(function() {
  const now = Date.now();
  for (const [k, v] of _metaOAuthStates.entries()) {
    if (v.expires < now) _metaOAuthStates.delete(k);
  }
}, 5 * 60 * 1000);

// â”€â”€ Helper: authenticated Meta Graph API call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Throws on any API error (including 200 + error body from Facebook).
// Error code 190/102 â†’ maps to HTTP 401 (expired/invalid token).
// Error code 200     â†’ maps to HTTP 403 (missing permission).
async function _metaFetch(path, accessToken, queryParams) {
  const params = new URLSearchParams({ access_token: accessToken });
  if (queryParams) {
    Object.entries(queryParams).forEach(function([k, v]) { params.set(k, v); });
  }
  const url = META_GRAPH + path + '?' + params.toString();

  let res, data;
  try {
    res  = await fetch(url, { headers: { Accept: 'application/json' } });
    data = await res.json();
  } catch (netErr) {
    const e = new Error('Meta API network error: ' + netErr.message);
    e.status = 503;
    throw e;
  }

  if (data.error) {
    const msg  = data.error.message || ('Meta API error code ' + data.error.code);
    const code = data.error.code;
    console.error('[MetaAPI]', path, 'â†’', msg, '| code:', code, '| type:', data.error.type);
    const e    = new Error(msg);
    e.metaCode = code;
    e.metaType = data.error.type;
    e.status   = (code === 190 || code === 102) ? 401
               : (code === 200 || code === 10)  ? 403
               : (code === 4   || code === 17)  ? 429
               : 503;
    throw e;
  }
  return data;
}

// â”€â”€ Helper: resolve valid token + active account for a user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Throws with .status set so routes can return it directly.

// ── Helper: POST to Meta Graph API (module-level) ────────────────────
async function _metaApiPost(path, accessToken, params) {
  const body = new URLSearchParams({ access_token: accessToken });
  if (params) Object.entries(params).forEach(([k, v]) => body.set(k, String(v)));
  const url = META_GRAPH + path;
  let res, data;
  try {
    res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    data = await res.json();
  } catch (netErr) {
    const e = new Error('Meta API network error: ' + netErr.message);
    e.status = 503;
    throw e;
  }
  if (data.error) {
    const e   = data.error;
    const msg = e.message || ('Meta API error code ' + e.code);
    console.error('[MetaAPIPost] Error at', path);
    console.error('  message    :', e.message          || '—');
    console.error('  code       :', e.code             || '—');
    console.error('  subcode    :', e.error_subcode    || '—');
    console.error('  type       :', e.type             || '—');
    console.error('  user_title :', e.error_user_title || '—');
    console.error('  user_msg   :', e.error_user_msg   || '—');
    console.error('  fbtrace_id :', e.fbtrace_id       || '—');
    console.error('  full body  :', JSON.stringify(data));
    const err       = new Error(msg);
    err.metaCode    = e.code;
    err.metaSubcode = e.error_subcode;
    err.status      = res.status;
    throw err;
  }
  return data;
}

// ── Helper: DELETE via Meta Graph API ────────────────────────────────────────
async function _metaApiDelete(path, accessToken) {
  const url = META_GRAPH + path + '?access_token=' + encodeURIComponent(accessToken);
  let res, data;
  try {
    res  = await fetch(url, { method: 'DELETE' });
    data = await res.json();
  } catch (netErr) {
    const e = new Error('Meta API network error: ' + netErr.message);
    e.status = 503;
    throw e;
  }
  if (data.error) {
    const e   = data.error;
    const msg = e.message || ('Meta API error code ' + e.code);
    console.error('[MetaAPIDelete] Error at', path);
    console.error('  message    :', e.message          || '—');
    console.error('  code       :', e.code             || '—');
    console.error('  subcode    :', e.error_subcode    || '—');
    console.error('  fbtrace_id :', e.fbtrace_id       || '—');
    console.error('  full body  :', JSON.stringify(data));
    const err       = new Error(msg);
    err.metaCode    = e.code;
    err.metaSubcode = e.error_subcode;
    err.status      = res.status;
    throw err;
  }
  return data;
}

async function _getMetaAccess(user) {
  const { data: intg, error } = await supabaseAdmin
    .from('integrations')
    .select('access_token, token_expiry, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'meta_ads')
    .maybeSingle();

  if (error || !intg) {
    const e = new Error('Meta Ads not connected'); e.status = 400; throw e;
  }
  if (intg.token_expiry && new Date(intg.token_expiry) < new Date()) {
    const e = new Error('Meta access token expired â€” reconnect Meta Ads in Integrations'); e.status = 401; throw e;
  }

  const active = intg.active_ad_account;
  if (!active || !active.account_id) {
    const e = new Error('No active Meta Ads account selected â€” go to Integrations and choose an account.'); e.status = 400; throw e;
  }

  // Normalise: strip any leading 'act_' then re-add exactly once.
  const rawId     = String(active.account_id);
  const bareId    = rawId.startsWith('act_') ? rawId.slice(4) : rawId;
  const accountId = 'act_' + bareId;
  console.log('[MetaAccess] stored:', rawId, '→ normalised:', accountId);

  return { accessToken: intg.access_token, accountId, accountName: active.account_name || accountId };
}

// â”€â”€ Helper: fetch all accessible Meta ad accounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _fetchMetaAdAccounts(accessToken) {
  const data = await _metaFetch('/me/adaccounts', accessToken, {
    fields: 'id,name,currency,account_status,timezone_name',
    limit:  '50'
  });
  return (data.data || []).map(function(a) {
    return {
      account_id:   a.id,           // 'act_123456'
      account_name: a.name          || '',
      currency:     a.currency      || '',
      status:       a.account_status,  // 1=ACTIVE, 2=DISABLED
      timezone:     a.timezone_name || ''
    };
  });
}

// â”€â”€ Helper: map Oriven date range to Meta date_preset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _metaDatePreset(range) {
  return { LAST_7_DAYS: 'last_7d', LAST_14_DAYS: 'last_14d', LAST_30_DAYS: 'last_30d', LAST_90_DAYS: 'last_90d' }[range] || 'last_30d';
}

// â”€â”€ Shared date-range resolution for the Campaigns Overview endpoints â”€â”€â”€â”€â”€
// Google Ads' GAQL `segments.date DURING X` clause only accepts a fixed
// literal enum (TODAY, YESTERDAY, LAST_7_DAYS, LAST_30_DAYS, THIS_MONTH,
// LAST_MONTH â€” notably NOT LAST_90_DAYS, which the old 4-option range
// selector silently sent anyway; see git history). Everything outside that
// enum has to be an explicit `BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'` clause.
// Meta's Graph API takes either a named date_preset or an explicit
// time_range({since,until}) field expansion. This resolves one requested
// range key into whatever each platform's API actually needs.
const ORV_DATE_RANGE_KEYS = ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'THIS_MONTH', 'LAST_MONTH', 'LAST_12_MONTHS', 'LIFETIME', 'CUSTOM'];
const _GAQL_NATIVE_DURING  = { TODAY: 'TODAY', YESTERDAY: 'YESTERDAY', LAST_7_DAYS: 'LAST_7_DAYS', LAST_30_DAYS: 'LAST_30_DAYS', THIS_MONTH: 'THIS_MONTH', LAST_MONTH: 'LAST_MONTH' };
const _META_NATIVE_PRESET  = { TODAY: 'today', YESTERDAY: 'yesterday', LAST_7_DAYS: 'last_7d', LAST_30_DAYS: 'last_30d', LAST_90_DAYS: 'last_90d', THIS_MONTH: 'this_month', LAST_MONTH: 'last_month', LIFETIME: 'maximum' };

function _orvFmtDate(d) { return d.toISOString().slice(0, 10); }

function resolveDateRange(rawKey, customSince, customUntil) {
  const key = ORV_DATE_RANGE_KEYS.includes(rawKey) ? rawKey : 'LAST_30_DAYS';
  const today = new Date();
  const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return _orvFmtDate(d); };

  let since = null, until = null;
  if (key === 'LAST_90_DAYS')        { since = daysAgo(89);  until = _orvFmtDate(today); }
  else if (key === 'LAST_12_MONTHS') { since = daysAgo(365); until = _orvFmtDate(today); }
  else if (key === 'LIFETIME')       { since = '2005-01-01'; until = _orvFmtDate(today); }
  else if (key === 'CUSTOM') {
    since = /^\d{4}-\d{2}-\d{2}$/.test(customSince || '') ? customSince : daysAgo(29);
    until = /^\d{4}-\d{2}-\d{2}$/.test(customUntil || '') ? customUntil : _orvFmtDate(today);
  }

  const gaqlDuring = _GAQL_NATIVE_DURING[key];
  const gaqlWhere  = gaqlDuring ? ('DURING ' + gaqlDuring) : ("BETWEEN '" + since + "' AND '" + until + "'");

  const metaPreset = key !== 'CUSTOM' ? _META_NATIVE_PRESET[key] : null;
  const metaFieldFragment = metaPreset
    ? ('date_preset(' + metaPreset + ')')
    : ('time_range(' + JSON.stringify({ since, until }) + ')');

  return { key, since, until, gaqlWhere, metaPreset, metaFieldFragment };
}

// â”€â”€ Helper: sum conversion actions from Meta insights.actions array â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _metaConversions(actions) {
  const convTypes = new Set([
    'offsite_conversion.fb_pixel_purchase',
    'offsite_conversion.fb_pixel_lead',
    'purchase',
    'lead',
    'complete_registration'
  ]);
  return (actions || [])
    .filter(function(a) { return convTypes.has(a.action_type); })
    .reduce(function(sum, a) { return sum + Number(a.value || 0); }, 0);
}

// GET /api/meta/auth-url -- returns Meta OAuth URL as JSON (matches Google/TikTok pattern)
// Frontend calls: apiFetch('/api/meta/auth-url').then(r => window.location.href = r.data.url)
app.get('/api/meta/auth-url', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (!META_APP_ID || !META_APP_SECRET) {
    return res.status(503).json({ error: 'Meta OAuth not configured on server' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  _metaOAuthStates.set(state, { userId: user.id, expires: Date.now() + 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id:     META_APP_ID,
    redirect_uri:  META_REDIRECT_URI,
    scope:         META_SCOPES,
    state,
    response_type: 'code'
  });
  res.json({ url: 'https://www.facebook.com/' + META_API_VER + '/dialog/oauth?' + params.toString() });
});

// GET /auth/meta â€” server-side redirect to Facebook Login
// Accepts ?token= (Supabase JWT) â€” avoids a separate API call from the frontend.
// Frontend usage: window.location.href = '/auth/meta?token=' + session.access_token
app.get('/auth/meta', async (req, res) => {
  const frontendBase = FRONTEND_URL;

  if (!META_APP_ID || !META_APP_SECRET) {
    console.warn('[Meta OAuth] /auth/meta hit but credentials not configured');
    return res.redirect(frontendBase + '/app?meta_error=not_configured');
  }

  const token = (req.query.token || '').toString().trim();
  if (!token) return res.redirect(frontendBase + '/app?meta_error=missing_token');

  let userId;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.redirect(frontendBase + '/app?meta_error=invalid_token');
    }
    userId = data.user.id;
  } catch (err) {
    console.error('[Meta OAuth] Token validation error:', err.message);
    return res.redirect(frontendBase + '/app?meta_error=auth_error');
  }

  const state = crypto.randomBytes(16).toString('hex');
  _metaOAuthStates.set(state, { userId, expires: Date.now() + 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id:     META_APP_ID,
    redirect_uri:  META_REDIRECT_URI,
    scope:         META_SCOPES,
    state,
    response_type: 'code'
  });

  console.log('[Meta OAuth] Redirecting user', userId, 'â†’ Facebook Login');
  res.redirect('https://www.facebook.com/' + META_API_VER + '/dialog/oauth?' + params.toString());
});

// GET /auth/meta/callback â€” OAuth callback from Facebook
app.get('/auth/meta/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const frontendBase = FRONTEND_URL;

  if (error) {
    console.error('[Meta OAuth] Error from Facebook:', error, error_description);
    return res.redirect(frontendBase + '/app?meta_error=' + encodeURIComponent(error));
  }
  if (!code || !state) {
    return res.redirect(frontendBase + '/app?meta_error=missing_params');
  }

  const stateData = _metaOAuthStates.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    _metaOAuthStates.delete(state);
    return res.redirect(frontendBase + '/app?meta_error=invalid_state');
  }
  _metaOAuthStates.delete(state);
  const userId = stateData.userId;

  // â”€â”€ Step 1: Exchange code for short-lived user access token â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let shortToken;
  try {
    const tokenRes = await fetch(META_GRAPH + '/oauth/access_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri:  META_REDIRECT_URI
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      console.error('[Meta OAuth] Code exchange error:', tokenData.error);
      return res.redirect(frontendBase + '/app?meta_error=token_exchange');
    }
    shortToken = tokenData.access_token;
    console.log('[Meta OAuth] Short-lived token obtained');
  } catch (err) {
    console.error('[Meta OAuth] Token exchange network error:', err.message);
    return res.redirect(frontendBase + '/app?meta_error=network');
  }

  // â”€â”€ Step 2: Exchange for long-lived token (valid ~60 days) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let accessToken = shortToken;
  let tokenExpiry = new Date(Date.now() + 58 * 24 * 60 * 60 * 1000).toISOString(); // safe 58-day default
  try {
    const extRes = await fetch(META_GRAPH + '/oauth/access_token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:        'fb_exchange_token',
        client_id:         META_APP_ID,
        client_secret:     META_APP_SECRET,
        fb_exchange_token: shortToken
      }).toString()
    });
    const extData = await extRes.json();
    if (!extData.error && extData.access_token) {
      accessToken  = extData.access_token;
      tokenExpiry  = extData.expires_in
        ? new Date(Date.now() + Number(extData.expires_in) * 1000).toISOString()
        : tokenExpiry;
      console.log('[Meta OAuth] Long-lived token obtained | expires:', tokenExpiry);
    } else {
      console.warn('[Meta OAuth] Could not extend token (using short-lived):', extData.error && extData.error.message);
    }
  } catch (err) {
    console.warn('[Meta OAuth] Token extension network error (using short-lived):', err.message);
  }

  // â”€â”€ Step 3: Fetch Facebook user info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let metaUserName = null;
  let metaUserId   = null;
  try {
    const me = await _metaFetch('/me', accessToken, { fields: 'id,name' });
    metaUserName = me.name || null;
    metaUserId   = me.id   || null;
  } catch (err) {
    console.warn('[Meta OAuth] Could not fetch /me:', err.message);
  }

  // â”€â”€ Step 4: Fetch accessible ad accounts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let adAccounts = [];
  try {
    adAccounts = await _fetchMetaAdAccounts(accessToken);
    console.log('[Meta OAuth] Fetched', adAccounts.length, 'ad account(s)');
  } catch (err) {
    console.warn('[Meta OAuth] Could not fetch ad accounts:', err.message);
  }

  // â”€â”€ Step 5: Upsert into Supabase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { error: dbError } = await supabaseAdmin
    .from('integrations')
    .upsert({
      user_id:           userId,
      provider:          'meta_ads',
      meta_user_name:    metaUserName,
      meta_user_id:      metaUserId,
      access_token:      accessToken,
      refresh_token:     null,           // Meta long-lived tokens don't use refresh tokens
      token_expiry:      tokenExpiry,
      connected_at:      new Date().toISOString(),
      meta_ads_accounts: adAccounts
    }, { onConflict: 'user_id,provider' });

  if (dbError) {
    console.error('[Meta OAuth] DB upsert error:', dbError.message);
    return res.redirect(frontendBase + '/app?meta_error=db');
  }

  console.log('[Meta OAuth] âœ… Connected | user:', userId, '| name:', metaUserName, '| accounts:', adAccounts.length);
  return res.redirect(frontendBase + '/app?meta_connected=1');
});

// GET /api/meta/status â€” connection status for the authenticated user
app.get('/api/meta/status', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { data, error } = await supabaseAdmin
    .from('integrations')
    .select('meta_user_name, meta_user_id, connected_at, token_expiry, meta_ads_accounts, active_ad_account')
    .eq('user_id', user.id)
    .eq('provider', 'meta_ads')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Database error' });
  if (!data)  return res.json({ connected: false });

  const tokenExpired = data.token_expiry && new Date(data.token_expiry) < new Date();
  res.json({
    connected:         !tokenExpired,
    status:            tokenExpired ? 'expired' : 'connected',
    meta_user_name:    data.meta_user_name    || null,
    meta_user_id:      data.meta_user_id      || null,
    connected_at:      data.connected_at       || null,
    token_expiry:      data.token_expiry        || null,
    meta_ads_accounts: data.meta_ads_accounts  || [],
    active_ad_account: data.active_ad_account   || null
  });
});

// GET /api/meta/accounts â€” re-fetch accessible ad accounts from Facebook
app.get('/api/meta/accounts', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { data: intg, error: fetchErr } = await supabaseAdmin
      .from('integrations')
      .select('access_token, token_expiry')
      .eq('user_id', user.id)
      .eq('provider', 'meta_ads')
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ error: 'Database error' });
    if (!intg)    return res.status(404).json({ error: 'Meta Ads not connected' });
    if (intg.token_expiry && new Date(intg.token_expiry) < new Date()) {
      return res.status(401).json({ error: 'Meta token expired â€” reconnect Meta Ads' });
    }

    const accounts = await _fetchMetaAdAccounts(intg.access_token);

    await supabaseAdmin.from('integrations')
      .update({ meta_ads_accounts: accounts })
      .eq('user_id', user.id)
      .eq('provider', 'meta_ads');

    res.json({ accounts });
  } catch (err) {
    console.error('[meta/accounts]', err.message);
    res.status(err.status || 500).json({ error: err.message, meta_code: err.metaCode || null });
  }
});

// POST /api/meta/disconnect â€” revoke permissions and delete integration row
app.post('/api/meta/disconnect', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  // Best-effort permission revocation via Facebook
  try {
    const { data } = await supabaseAdmin
      .from('integrations')
      .select('access_token, meta_user_id')
      .eq('user_id', user.id)
      .eq('provider', 'meta_ads')
      .maybeSingle();
    if (data && data.meta_user_id && data.access_token) {
      await fetch(META_GRAPH + '/' + data.meta_user_id + '/permissions', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ access_token: data.access_token }).toString()
      });
    }
  } catch (_) {}

  const { error } = await supabaseAdmin
    .from('integrations')
    .delete()
    .eq('user_id', user.id)
    .eq('provider', 'meta_ads');

  if (error) return res.status(500).json({ error: 'Database error' });

  console.log('[Meta disconnect] Removed | user:', user.id);
  res.json({ ok: true });
});

// POST /api/meta/active-account â€” set the active Meta Ads account for a user
app.post('/api/meta/active-account', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { account_id, account_name, currency } = req.body || {};
    if (!account_id) return res.status(400).json({ error: 'account_id is required' });

    const active_ad_account = {
      platform:     'meta_ads',
      account_id:   String(account_id),
      account_name: String(account_name || ''),
      currency:     currency || null
    };

    const { error } = await supabaseAdmin
      .from('integrations')
      .update({ active_ad_account })
      .eq('user_id', user.id)
      .eq('provider', 'meta_ads');

    if (error) {
      console.error('[Meta ActiveAccount] DB error:', error.message);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log('[Meta ActiveAccount] Set | user:', user.id, '| account:', account_id, account_name);
    res.json({ ok: true, active_ad_account });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET /api/meta/campaigns â€” campaign list with Marketing API performance data
// ?date_range= LAST_7_DAYS | LAST_14_DAYS | LAST_30_DAYS | LAST_90_DAYS
app.get('/api/meta/campaigns', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, accountId } = await _getMetaAccess(user);

    const dr    = resolveDateRange(req.query.date_range, req.query.date_since, req.query.date_until);
    const range = dr.key;

    const campData = await _metaFetch('/' + accountId + '/campaigns', accessToken, {
      fields:           'id,name,status,objective,daily_budget,lifetime_budget,created_time,insights.' + dr.metaFieldFragment + '{spend,impressions,clicks,ctr,actions}',
      limit:            '100',
      effective_status: '["ACTIVE","PAUSED","ARCHIVED"]'
    });

    const campaigns = (campData.data || []).map(function(c) {
      const ins  = (c.insights && c.insights.data && c.insights.data[0]) || {};
      const spend       = parseFloat(ins.spend || 0);
      const impressions = parseInt(ins.impressions || 0, 10);
      const clicks      = parseInt(ins.clicks || 0, 10);
      const ctr         = parseFloat(ins.ctr || 0);
      const conversions = _metaConversions(ins.actions);
      return {
        campaign_id:   c.id,
        campaign_name: c.name      || 'Unnamed',
        status:        c.status    || 'UNKNOWN',
        objective:     c.objective || '',
        spend:         parseFloat(spend.toFixed(2)),
        impressions,
        clicks,
        ctr:           parseFloat(ctr.toFixed(4)),
        conversions:   parseFloat(conversions.toFixed(2)),
        daily_budget:   c.daily_budget   ? parseInt(c.daily_budget,   10) : null,
        lifetime_budget: c.lifetime_budget ? parseInt(c.lifetime_budget, 10) : null,
        created_time:   c.created_time  || null
      };
    });

    // V6 Phase 2 â€” Campaign Priority (calculated, not AI-assigned) â€” same
    // classifier used by _analyzeMetaAccount, so the table and AI agree.
    const _avgCtr = _avg(campaigns.map(c => ({ ctr: c.ctr })), 'ctr');
    campaigns.forEach(c => { c.priority = _campaignPriority(c, _avgCtr, 0); });

    console.log('[meta/campaigns] Returned', campaigns.length, 'campaigns |', range);
    res.json({ campaigns, account_id: accountId, date_range: range });
  } catch (err) {
    console.error('[meta/campaigns]', err.message);
    res.status(err.status || 500).json({ error: err.message, meta_code: err.metaCode || null });
  }
});

// ── Meta Ads account analysis — live data + AI narrative ────────
// Mirrors _analyzeGoogleAccount's shape/contract exactly so callers
// (POST /api/meta/analyze, GET /api/intelligence/home) can treat Google
// and Meta analysis interchangeably.
async function _analyzeMetaAccount(user, range, customSince, customUntil) {
  const dr = resolveDateRange(range, customSince, customUntil);
  range = dr.key;
  const { accessToken, accountId, accountName } = await _getMetaAccess(user);

  const [campData, adData] = await Promise.all([
    _metaFetch('/' + accountId + '/campaigns', accessToken, {
      fields:           'id,name,status,objective,daily_budget,lifetime_budget,created_time,insights.' + dr.metaFieldFragment + '{spend,impressions,clicks,ctr,actions}',
      limit:            '100',
      effective_status: '["ACTIVE","PAUSED","ARCHIVED"]'
    }),
    _metaFetch('/' + accountId + '/ads', accessToken, {
      fields:  'id,name,status,adset_id,campaign_id,creative{id,title,body,call_to_action_type},insights.' + dr.metaFieldFragment + '{spend,impressions,clicks,ctr,actions}',
      limit:   '50',
      effective_status: '["ACTIVE","PAUSED"]'
    }).catch(() => ({ data: [] }))
  ]);

  const f = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : '0');

  let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalConv = 0;
  const campaigns = (campData.data || []).map(c => {
    const ins = (c.insights && c.insights.data && c.insights.data[0]) || {};
    const sp = parseFloat(ins.spend || 0);
    const im = parseInt(ins.impressions || 0, 10);
    const cl = parseInt(ins.clicks || 0, 10);
    const cv = _metaConversions(ins.actions);
    totalSpend += sp; totalImpr += im; totalClicks += cl; totalConv += cv;
    return {
      id: c.id || '', name: c.name || '', status: c.status || '', objective: c.objective || '',
      spend: sp, impressions: im, clicks: cl, ctr: im > 0 ? (cl / im) * 100 : 0,
      conversions: cv, cpa: cv > 0 ? sp / cv : 0,
      daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null
    };
  });

  // V6 Phase 2 â€” Creative Intelligence, built from ad-level data already fetched above.
  const creatives = (adData.data || []).map(a => {
    const ins = (a.insights && a.insights.data && a.insights.data[0]) || {};
    const cre = a.creative || {};
    const sp = parseFloat(ins.spend || 0);
    const im = parseInt(ins.impressions || 0, 10);
    const cl = parseInt(ins.clicks || 0, 10);
    const cv = _metaConversions(ins.actions);
    return { name: cre.title || a.name || 'Untitled ad', campaign: a.campaign_id || '', status: a.status || '', spend: sp, impressions: im, clicks: cl, ctr: im > 0 ? (cl / im) * 100 : 0, conversions: cv };
  });
  const avgCreativeCtr = _avg(creatives, 'ctr');
  creatives.forEach(cr => {
    cr.performance = cr.impressions < 100 ? 'insufficient_data'
      : cr.ctr > avgCreativeCtr * 1.3 ? 'top'
      : cr.ctr < avgCreativeCtr * 0.6 ? 'underperforming'
      : 'average';
  });
  const adLines = creatives.slice().sort((a, b) => b.spend - a.spend).slice(0, 20).map(cr =>
    `"${cr.name}" | ${cr.status} | â‚¬${f(cr.spend)} spend | ${cr.impressions} impr | CTR: ${f(cr.ctr)}% | Conv: ${f(cr.conversions)}`
  );

  const campSummary = campaigns.map(c =>
    `${c.name} | ${c.status} | ${c.objective} | â‚¬${f(c.spend)} | ${c.impressions} impr | ${c.clicks} clicks | CTR: ${f(c.ctr)}% | Conv: ${f(c.conversions)} | CPA: â‚¬${c.cpa > 0 ? f(c.cpa) : 'N/A'}${c.daily_budget ? ' | Daily budget: â‚¬' + f(c.daily_budget) : ''}`
  ).join('\n');

  const system = `You are a senior Meta Ads (Facebook/Instagram) performance analyst. Analyze this account data and return ONLY valid JSON â€” no markdown, no code fences, no explanation. Start your response with {.

Return exactly this structure:
{
  "score": <integer 0-100>,
  "findings": [
    {
      "type": "wasted_spend|low_ctr|conversion_issue|scaling_opportunity|creative_fatigue|budget|audience",
      "severity": "high|medium|low",
      "title": "Short specific title (max 8 words)",
      "detail": "Specific insight with real numbers and campaign/ad names from the data",
      "action": "Concrete action the advertiser should take right now",
      "campaign": "exact campaign name this finding is about, or 'Account-wide'",
      "whyNow": "one sentence on why this matters right now, not later",
      "platformReason": "one sentence on why this is specific to Meta Ads",
      "ifIgnored": "one sentence on the likely cost of not acting"
    }
  ],
  "recommendations": [
    {
      "type": "budget|creative|audience|bid|copy|structure",
      "campaign": "exact campaign name or 'Account-wide'",
      "title": "Short recommendation title",
      "detail": "Specific action with numbers",
      "priority": "high|medium|low",
      "whyNow": "one sentence on why this matters right now, not later",
      "platformReason": "one sentence on why this is specific to Meta Ads",
      "ifIgnored": "one sentence on the likely cost of not acting"
    }
  ],
  "strengths": ["specific one-liner with real metric or campaign name"],
  "weaknesses": ["specific one-liner with real metric or campaign name"],
  "opportunities": ["specific one-liner with real metric or campaign name"],
  "creativeNotes": [
    { "name": "exact ad name from the ADS / CREATIVE PERFORMANCE data below", "note": "one-sentence recommendation for this specific creative" }
  ]
}

Score guide: 70+ good, 45-69 average, below 45 poor. Weight: CTR quality 25%, conversion rate 35%, spend efficiency 25%, creative variety/freshness 15%.
Rules: max 6 findings, max 6 recommendations, 3 strengths, 3 weaknesses, 3 opportunities, max 5 creativeNotes (only for creatives genuinely worth flagging). Reference real names and numbers. Do NOT include a confidence field anywhere — confidence is calculated separately from real data, never state or imply a certainty level yourself. If minimal data, say so explicitly in whyNow/ifIgnored rather than overstating certainty.`;

  // V7 Phase 1 â€” light Context Engine V2 touch, same as Google's analyze fn.
  const _bizCtx = await _gatherBusinessContext(user.id).catch(() => null);

  const userMsg = `Account: ${accountName} (ID: ${accountId}) | Period: ${range}${_bizCtx ? `\n\nBUSINESS CONTEXT (if competitor info is present, use it only for strategic positioning — never to copy or replicate competitor messaging):\n${_bizCtx.text}` : ''}

TOTALS â€” Spend: â‚¬${f(totalSpend)} | Impressions: ${totalImpr} | Clicks: ${totalClicks} | CTR: ${totalImpr > 0 ? f((totalClicks/totalImpr)*100) : '0.00'}% | Conversions: ${f(totalConv)} | CPA: â‚¬${totalConv > 0 ? f(totalSpend/totalConv) : 'N/A'}

CAMPAIGNS (by spend):
${campSummary || 'No campaign spend in this period'}

ADS / CREATIVE PERFORMANCE:
${adLines.length > 0 ? adLines.join('\n') : 'No ad-level data'}`;

  const raw = await _aimlText('text-copy', system, userMsg, { max_tokens: 2200 });

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
  } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      console.error('[Meta/analyze] unparseable AI response:', raw.slice(0, 300));
      const parseErr = new Error('AI response could not be parsed â€” try again');
      parseErr.status = 500;
      throw parseErr;
    }
    parsed = JSON.parse(m[0]);
  }

  // V6 Phase 2 â€” Campaign Priority (calculated, not AI-assigned)
  const avgCtr  = _avg(campaigns, 'ctr');
  const avgRoas = 0; // Meta totals don't include conversion value here, so ROAS-based tiers don't apply
  const campaignsWithPriority = campaigns.map(c => Object.assign({}, c, { priority: _campaignPriority(Object.assign({ roas: 0 }, c), avgCtr, avgRoas) }));

  // V6 Phase 2 â€” Confidence Engine (calculated, not AI-guessed)
  const days = _rangeDays(range);
  const accountTotals = { clicks: totalClicks, conversions: totalConv };
  const findings        = _attachConfidence(parsed.findings, campaignsWithPriority, accountTotals, days);
  const recommendations = _attachConfidence(parsed.recommendations, campaignsWithPriority, accountTotals, days);

  (parsed.creativeNotes || []).forEach(note => {
    const match = creatives.find(cr => cr.name && note.name && cr.name.toLowerCase() === String(note.name).toLowerCase());
    if (match) match.recommendation = note.note;
  });

  console.log('[Meta/analyze] score:', parsed.score, '| findings:', findings.length, '| recs:', recommendations.length, '| creatives:', creatives.length);
  return {
    score: parsed.score || 0,
    findings, recommendations,
    strengths:       parsed.strengths       || [],
    weaknesses:      parsed.weaknesses      || [],
    opportunities:   parsed.opportunities   || [],
    campaigns: campaignsWithPriority,
    creatives,
    account:   { id: accountId, name: accountName },
    date_range: range,
    totals: {
      spend: totalSpend, impressions: totalImpr, clicks: totalClicks,
      ctr: totalImpr > 0 ? (totalClicks / totalImpr) * 100 : 0,
      conversions: totalConv,
      cpa: totalConv > 0 ? totalSpend / totalConv : 0
    }
  };
}

app.post('/api/meta/analyze', async (req, res) => {
  let reservation;
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    reservation = await creditManager.reserveCredits(user, 'ai_analysis');
    // Explicit "Analyze with AI" click -- always bypasses the shared cache.
    const dr = resolveDateRange(req.body && req.body.date_range, req.body && req.body.date_since, req.body && req.body.date_until);
    const result = await getOrRefreshAnalysis(user, 'meta', dr.key, { forceRefresh: true });
    await creditManager.finalizeCreditLog(reservation, 'ai_analysis', { provider: 'aiml', success: true, route: req.path });
    res.json(result);
  } catch (err) {
    if (reservation) creditManager.finalizeCreditLog(reservation, 'ai_analysis', { success: false, error: err.message, route: req.path }).catch(() => {});
    if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
    console.error('[Meta/analyze]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', meta_code: err.metaCode || null });
  }
});

// GET /api/meta/campaign/:id – single campaign with full fields
app.get('/api/meta/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, accountId } = await _getMetaAccess(user);
    console.log('[Meta Campaign Fetch] campaign:', req.params.id, '| user:', user.id, '| account:', accountId);
    const data = await _metaFetch('/' + req.params.id, accessToken, {
      fields: 'id,name,status,objective,daily_budget,lifetime_budget,created_time'
    });
    res.json({ campaign: data });
  } catch (err) {
    console.error('[Meta Campaign Fetch] FAILED campaign:', req.params.id, '|', err.message, '| metaCode:', err.metaCode || '—', '| metaSubcode:', err.metaSubcode || '—');
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/meta/campaign/:id – update name and/or daily_budget
app.patch('/api/meta/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, accountId } = await _getMetaAccess(user);
    const { name, daily_budget } = req.body || {};
    const params = {};
    if (name !== undefined && String(name).trim()) params.name = String(name).trim();
    if (daily_budget !== undefined) params.daily_budget = String(Math.round(Number(daily_budget)));
    if (!Object.keys(params).length) return res.status(400).json({ error: 'Nothing to update' });
    console.log('[Meta Campaign Edit]');
    console.log('  campaign :', req.params.id);
    console.log('  user     :', user.id);
    console.log('  account  :', accountId);
    console.log('  fields   :', JSON.stringify(params));
    await _metaApiPost('/' + req.params.id, accessToken, params);
    console.log('[Meta Campaign Edit] OK');
    res.json({ ok: true });
  } catch (err) {
    console.error('[Meta Campaign Edit] FAILED campaign:', req.params.id, '| code:', err.metaCode || '—', '| subcode:', err.metaSubcode || '—', '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/meta/campaign/:id/pause
app.post('/api/meta/campaign/:id/pause', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, accountId } = await _getMetaAccess(user);
    console.log('[Meta Campaign Pause]');
    console.log('  campaign :', req.params.id);
    console.log('  user     :', user.id);
    console.log('  account  :', accountId);
    await _metaApiPost('/' + req.params.id, accessToken, { status: 'PAUSED' });
    console.log('[Meta Campaign Pause] OK');
    res.json({ ok: true, status: 'PAUSED' });
  } catch (err) {
    console.error('[Meta Campaign Pause] FAILED campaign:', req.params.id, '| code:', err.metaCode || '—', '| subcode:', err.metaSubcode || '—', '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/meta/campaign/:id/resume
app.post('/api/meta/campaign/:id/resume', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, accountId } = await _getMetaAccess(user);
    console.log('[Meta Campaign Resume]');
    console.log('  campaign :', req.params.id);
    console.log('  user     :', user.id);
    console.log('  account  :', accountId);
    await _metaApiPost('/' + req.params.id, accessToken, { status: 'ACTIVE' });
    console.log('[Meta Campaign Resume] OK');
    res.json({ ok: true, status: 'ACTIVE' });
  } catch (err) {
    console.error('[Meta Campaign Resume] FAILED campaign:', req.params.id, '| code:', err.metaCode || '—', '| subcode:', err.metaSubcode || '—', '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/meta/campaign/:id – archive (or true-delete) a campaign
app.delete('/api/meta/campaign/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { accessToken, accountId } = await _getMetaAccess(user);
    console.log('[Meta Campaign Delete]');
    console.log('  campaign :', req.params.id);
    console.log('  user     :', user.id);
    console.log('  account  :', accountId);

    let deleted = false, archived = false;
    try {
      await _metaApiDelete('/' + req.params.id, accessToken);
      deleted = true;
      console.log('[Meta Campaign Delete] True delete succeeded');
    } catch (delErr) {
      console.log('[Meta Campaign Delete] True delete failed (code:', delErr.metaCode, ') — falling back to ARCHIVED');
      await _metaApiPost('/' + req.params.id, accessToken, { status: 'ARCHIVED' });
      archived = true;
      console.log('[Meta Campaign Delete] Archived campaign');
    }
    res.json({ ok: true, deleted, archived });
  } catch (err) {
    console.error('[Meta Campaign Delete] FAILED campaign:', req.params.id, '| code:', err.metaCode || '—', '| subcode:', err.metaSubcode || '—', '|', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/meta/adsets â€” ad set list with performance metrics
app.get('/api/meta/adsets', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, accountId } = await _getMetaAccess(user);

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range      = VALID_RANGES.includes(req.query.date_range) ? req.query.date_range : 'LAST_30_DAYS';
    const datePreset = _metaDatePreset(range);

    const data = await _metaFetch('/' + accountId + '/adsets', accessToken, {
      fields:           'id,name,status,campaign_id,daily_budget,optimization_goal,billing_event,insights.date_preset(' + datePreset + '){spend,impressions,clicks,ctr,actions}',
      limit:            '100',
      effective_status: '["ACTIVE","PAUSED","ARCHIVED"]'
    });

    const adsets = (data.data || []).map(function(s) {
      const ins  = (s.insights && s.insights.data && s.insights.data[0]) || {};
      return {
        adset_id:          s.id,
        adset_name:        s.name || 'Unnamed',
        status:            s.status || 'UNKNOWN',
        campaign_id:       s.campaign_id || '',
        daily_budget:      s.daily_budget ? parseFloat(s.daily_budget) / 100 : null,
        optimization_goal: s.optimization_goal || '',
        billing_event:     s.billing_event || '',
        spend:             parseFloat(parseFloat(ins.spend || 0).toFixed(2)),
        impressions:       parseInt(ins.impressions || 0, 10),
        clicks:            parseInt(ins.clicks || 0, 10),
        ctr:               parseFloat(parseFloat(ins.ctr || 0).toFixed(4)),
        conversions:       parseFloat(_metaConversions(ins.actions).toFixed(2))
      };
    });

    console.log('[meta/adsets] Returned', adsets.length, 'ad sets |', range);
    res.json({ adsets, account_id: accountId, date_range: range });
  } catch (err) {
    console.error('[meta/adsets]', err.message);
    res.status(err.status || 500).json({ error: err.message, meta_code: err.metaCode || null });
  }
});

// GET /api/meta/ads â€” individual ads with creative preview fields and performance
// Creative fields returned for ad preview panel:
//   headline, primary_text, call_to_action, image_url, video_thumbnail, destination_url
app.get('/api/meta/ads', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, accountId } = await _getMetaAccess(user);

    const VALID_RANGES = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS'];
    const range      = VALID_RANGES.includes(req.query.date_range) ? req.query.date_range : 'LAST_30_DAYS';
    const datePreset = _metaDatePreset(range);

    const data = await _metaFetch('/' + accountId + '/ads', accessToken, {
      fields: [
        'id',
        'name',
        'status',
        'adset_id',
        'campaign_id',
        'creative{id,title,body,call_to_action_type,image_url,thumbnail_url,link_url,object_url}',
        'insights.date_preset(' + datePreset + '){spend,impressions,clicks,ctr,actions}'
      ].join(','),
      limit:            '100',
      effective_status: '["ACTIVE","PAUSED","ARCHIVED"]'
    });

    const ads = (data.data || []).map(function(a) {
      const ins  = (a.insights && a.insights.data && a.insights.data[0]) || {};
      const cre  = a.creative || {};
      return {
        ad_id:           a.id,
        ad_name:         a.name    || 'Unnamed',
        status:          a.status  || 'UNKNOWN',
        adset_id:        a.adset_id    || '',
        campaign_id:     a.campaign_id || '',
        // Creative / ad preview fields
        headline:        cre.title                || '',
        primary_text:    cre.body                 || '',
        description:     '',
        call_to_action:  cre.call_to_action_type  || '',
        image_url:       cre.image_url            || '',
        video_thumbnail: cre.thumbnail_url        || '',
        destination_url: cre.link_url || cre.object_url || '',
        // Performance
        spend:           parseFloat(parseFloat(ins.spend || 0).toFixed(2)),
        impressions:     parseInt(ins.impressions || 0, 10),
        clicks:          parseInt(ins.clicks || 0, 10),
        ctr:             parseFloat(parseFloat(ins.ctr || 0).toFixed(4)),
        conversions:     parseFloat(_metaConversions(ins.actions).toFixed(2))
      };
    });

    console.log('[meta/ads] Returned', ads.length, 'ads |', range);
    res.json({ ads, account_id: accountId, date_range: range });
  } catch (err) {
    console.error('[meta/ads]', err.message);
    res.status(err.status || 500).json({ error: err.message, meta_code: err.metaCode || null });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ADS DASHBOARD â€” campaign data, AI analysis, recommendations
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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
      const e = new Error('Token expired â€” reconnect Google Ads'); e.status = 401; throw e;
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
      const e = new Error('Token refresh failed â€” reconnect Google Ads'); e.status = 401; throw e;
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
    const e = new Error('No active Google Ads account selected â€” go to Integrations and choose an account.'); e.status = 400; throw e;
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

  // Same rule as _gadsMutate: only send login-customer-id for a genuine
  // MCC relationship (loginCustomerId !== customerId) -- a redundant,
  // self-referential value is a known Google Ads API permission-rejection
  // trigger on direct (non-MCC) accounts.
  const url     = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/googleAds:search';
  const headers = {
    'Authorization':     'Bearer ' + accessToken,
    'developer-token':   GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type':      'application/json',
  };
  if (loginCustomerId && loginCustomerId !== customerId) headers['login-customer-id'] = loginCustomerId;

  const requestBody = JSON.stringify({ query });
  console.log('[GAQL] â–¶ POST', url);
  console.log('[GAQL]   customer_id (URL)   :', customerId);
  console.log('[GAQL]   login-customer-id    :', headers['login-customer-id'] || '(omitted -- direct, non-MCC access)');
  console.log('[GAQL]   query               :', query.trim().replace(/\s+/g, ' '));
  console.log('[GAQL]   request body        :', requestBody);

  try {
    const res  = await fetch(url, { method: 'POST', headers, body: requestBody, signal: ctrl.signal })
      .finally(() => clearTimeout(tid));
    const text = await res.text();

    console.log('[GAQL] â—€ HTTP', res.status, url);

    if (!res.ok) {
      // Parse and log the full Google Ads error payload â€” no truncation
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

      console.error('[GAQL] âœ— FULL ERROR BODY:', text);
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
    console.log('[GAQL] âœ“ results:', (data.results || []).length);
    return data.results || [];
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Google Ads API timed out (>20 s)');
    throw err;
  }
}

// â”€â”€ GET /api/ads/overview â€” account KPIs + campaign list â”€â”€â”€â”€â”€â”€â”€â”€â”€

// ── Module-level Google Ads mutate helper ────────────────────────────────────
async function _gadsMutate(accessToken, customerId, resource, operations, loginCustomerId) {
  if (!GOOGLE_ADS_DEVELOPER_TOKEN) throw Object.assign(new Error('Google Ads developer token not configured'), { status: 500 });
  const url = 'https://googleads.googleapis.com/v24/customers/' + customerId + '/' + resource + ':mutate';
  const headers = {
    'Authorization':     'Bearer ' + accessToken,
    'developer-token':   GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type':      'application/json',
  };
  // Only send login-customer-id when it genuinely differs from the target
  // customer (a real MCC/manager relationship) -- sending it as a
  // redundant, self-referential value on a direct (non-MCC) account is
  // what was causing Resume/Pause to fail with a Google permissions
  // rejection while Create (which already omits it in this situation)
  // succeeded. Matches the working pattern from /api/publish/google.
  if (loginCustomerId && loginCustomerId !== customerId) headers['login-customer-id'] = loginCustomerId;
  console.log('[GAdsMutate] POST', resource, '| customer:', customerId, '| login:', headers['login-customer-id'] || '(omitted -- direct, non-MCC access)');
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 20000);
  let r, text;
  try {
    r    = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ operations }), signal: ctrl.signal });
    text = await r.text();
  } catch (fetchErr) {
    clearTimeout(tid);
    if (fetchErr.name === 'AbortError') throw new Error('Google Ads mutate timed out (>20 s) on ' + resource);
    throw fetchErr;
  }
  clearTimeout(tid);
  let d;
  try { d = JSON.parse(text); } catch(_) { d = {}; }
  if (!r.ok) {
    const gErr = (d.error && d.error.details && d.error.details[0]) || {};
    const errCodes = [];
    if (Array.isArray(gErr.errors)) {
      gErr.errors.forEach(function(e) {
        if (e.errorCode) errCodes.push(JSON.stringify(e.errorCode));
        if (e.message)   errCodes.push('msg:' + e.message);
      });
    }
    const msg = (d.error && d.error.message) || ('Google Ads API HTTP ' + r.status);
    console.error('[GAdsMutate] FAILED', resource);
    console.error('  message    :', msg);
    console.error('  HTTP status:', r.status);
    console.error('  errorCodes :', errCodes.join(' | ') || '—');
    console.error('  full body  :', text.slice(0, 2000));
    const err = new Error(msg);
    err.status = r.status;
    err.gadsStatus = d.error;
    err.gadsErrorCodes = errCodes;
    throw err;
  }
  console.log('[GAdsMutate] OK', resource, JSON.stringify((d.results || []).map(function(r){ return r.resourceName; })));
  return d;
}

app.get('/api/ads/overview', async (req, res) => {
  let _diagCustomerId = null, _diagLoginId = null, _diagActive = null, _diagQuery = null;
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, accountName, loginCustomerId, activeAccount } = await _getGadsAccess(user);
    _diagCustomerId = customerId;
    _diagLoginId    = loginCustomerId;
    _diagActive     = activeAccount;

    const dr    = resolveDateRange(req.query.date_range, req.query.date_since, req.query.date_until);
    const range = dr.key;

    _diagQuery = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.conversions, metrics.cost_per_conversion, metrics.conversions_value FROM campaign WHERE segments.date ${dr.gaqlWhere} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 100`;

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
      WHERE segments.date ${dr.gaqlWhere}
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

    // V6 Phase 2 â€” Campaign Priority (calculated, not AI-assigned) â€” same
    // classifier used by _analyzeGoogleAccount, so the Analytics table and
    // the AI analysis always agree on what's critical/scaling/etc.
    const _avgCtr  = _avg(campaigns, 'ctr');
    const _avgRoas = _avg(campaigns, 'roas');
    campaigns.forEach(c => { c.priority = _campaignPriority(c, _avgCtr, _avgRoas); });

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

// â”€â”€ GET /api/ads/campaigns â€” dedicated campaigns list endpoint â”€â”€â”€â”€
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

// â”€â”€ GET /api/ads/campaign/:id â€” ads + keywords for one campaign â”€â”€
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

// â”€â”€ GET /api/ads/campaign/:id/assets â€” resolve image asset URLs â”€â”€
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

// â”€â”€ POST /api/ads/analyze â€” self-contained AI analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fetches fresh data directly from Google Ads API. Accepts only
// { date_range } from the request body â€” no client data passthrough.
// ── Google Ads account analysis — live data + AI narrative ──────
// Used by: POST /api/ads/analyze (below) and GET /api/intelligence/home
// (V6 Home Dashboard). Extracted so both callers share one implementation.
async function _analyzeGoogleAccount(user, range, customSince, customUntil) {
    const dr = resolveDateRange(range, customSince, customUntil);
    range = dr.key;
    const { accessToken, customerId, accountName, loginCustomerId } = await _getGadsAccess(user);

    // Fetch all data in parallel from Google Ads API
    const [campResults, kwResults, stResults, adResults] = await Promise.all([

      // Campaigns â€” performance totals
      _gadsQuery(accessToken, customerId, `
        SELECT
          campaign.id, campaign.name, campaign.status,
          campaign.advertising_channel_type,
          metrics.cost_micros, metrics.impressions, metrics.clicks,
          metrics.ctr, metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date ${dr.gaqlWhere}
          AND campaign.status != 'REMOVED'
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId),

      // Keywords â€” top spenders for quality analysis
      _gadsQuery(accessToken, customerId, `
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.impressions,
          metrics.ctr, metrics.conversions
        FROM keyword_view
        WHERE segments.date ${dr.gaqlWhere}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId).catch(() => []),

      // Search terms â€” detect irrelevant queries and wasted spend
      _gadsQuery(accessToken, customerId, `
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          campaign.name,
          ad_group.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions,
          metrics.impressions
        FROM search_term_view
        WHERE segments.date ${dr.gaqlWhere}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `, loginCustomerId).catch(() => []),

      // Ads â€” detect low-performing creatives
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
        WHERE segments.date ${dr.gaqlWhere}
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
      return { id: c.id || '', name: c.name || '', status: c.status || '', type: c.advertisingChannelType || '',
        spend: sp, impressions: im, clicks: cl, ctr: im > 0 ? (cl / im) * 100 : 0,
        conversions: cv, cpa: cv > 0 ? sp / cv : 0, roas: sp > 0 ? vl / sp : 0 };
    });

    // Keywords summary â€” top 15 by spend
    const kwLines = kwResults.slice(0, 15).map(r => {
      const agc = r.adGroupCriterion || {}, kw = agc.keyword || {}, m = r.metrics || {};
      const sp = Number(m.costMicros || 0) / 1e6;
      const im = Number(m.impressions || 0), cl = Number(m.clicks || 0);
      const cv = Number(m.conversions || 0);
      return `[${kw.matchType || '?'}] "${kw.text}" | ${r.campaign?.name || ''} | â‚¬${f(sp)} spend | CTR: ${im > 0 ? f((cl/im)*100) : '0.00'}% | Conv: ${f(cv)}`;
    });

    // Search terms with spend but zero conversions (wasted spend candidates)
    const wastedLines = stResults.filter(r => {
      const m = r.metrics || {};
      return Number(m.costMicros || 0) > 500000 && Number(m.conversions || 0) === 0; // >â‚¬0.50
    }).slice(0, 10).map(r => {
      const st = r.searchTermView || {}, m = r.metrics || {};
      return `"${st.searchTerm}" | ${r.campaign?.name || ''} | â‚¬${f(Number(m.costMicros || 0)/1e6)} | ${m.clicks || 0} clicks | 0 conv`;
    });

    // Campaigns with high spend and zero conversions (budget efficiency)
    const zeroCampLines = campaigns.filter(c => c.spend > 5 && c.conversions === 0).map(c =>
      `${c.name} | â‚¬${f(c.spend)} spend | ${c.clicks} clicks | 0 conversions`
    );

    const campSummary = campaigns.map(c =>
      `${c.name} | ${c.status} | â‚¬${f(c.spend)} | ${c.impressions} impr | ${c.clicks} clicks | CTR: ${f(c.ctr)}% | Conv: ${f(c.conversions)} | CPA: â‚¬${c.cpa > 0 ? f(c.cpa) : 'N/A'} | ROAS: ${f(c.roas)}x`
    ).join('\n');

    // V6 Phase 2 â€” Creative Intelligence. adResults was already being fetched
    // and thrown away every call; this is the first thing that uses it.
    const creatives = adResults.map(r => {
      const aga = r.adGroupAd || {};
      const ad  = aga.ad || {};
      const rsa = ad.responsiveSearchAd || {};
      const eta = ad.expandedTextAd || {};
      const headline = (rsa.headlines && rsa.headlines[0] && rsa.headlines[0].text) || eta.headlinePart1 || (r.adGroup && r.adGroup.name) || 'Untitled ad';
      const m  = r.metrics || {};
      const im = Number(m.impressions || 0), cl = Number(m.clicks || 0), cv = Number(m.conversions || 0), sp = Number(m.costMicros || 0) / 1e6;
      return { name: headline, campaign: (r.campaign && r.campaign.name) || '', status: aga.status || '', spend: sp, impressions: im, clicks: cl, ctr: im > 0 ? (cl / im) * 100 : 0, conversions: cv };
    });
    const avgCreativeCtr = _avg(creatives, 'ctr');
    creatives.forEach(cr => {
      cr.performance = cr.impressions < 100 ? 'insufficient_data'
        : cr.ctr > avgCreativeCtr * 1.3 ? 'top'
        : cr.ctr < avgCreativeCtr * 0.6 ? 'underperforming'
        : 'average';
    });
    const adLines = creatives.slice().sort((a, b) => b.spend - a.spend).slice(0, 20).map(cr =>
      `"${cr.name}" | ${cr.campaign} | â‚¬${f(cr.spend)} spend | ${cr.impressions} impr | CTR: ${f(cr.ctr)}% | Conv: ${f(cr.conversions)}`
    );

    const system = `You are a senior Google Ads performance analyst. Analyze this account data and return ONLY valid JSON â€” no markdown, no code fences, no explanation. Start your response with {.

Return exactly this structure:
{
  "score": <integer 0-100>,
  "findings": [
    {
      "type": "wasted_spend|low_ctr|conversion_issue|scaling_opportunity|keyword_opportunity|budget|landing_page",
      "severity": "high|medium|low",
      "title": "Short specific title (max 8 words)",
      "detail": "Specific insight with real numbers and campaign/keyword names from the data",
      "action": "Concrete action the advertiser should take right now",
      "campaign": "exact campaign name this finding is about, or 'Account-wide'",
      "whyNow": "one sentence on why this matters right now, not later",
      "platformReason": "one sentence on why this is specific to Google Ads",
      "ifIgnored": "one sentence on the likely cost of not acting"
    }
  ],
  "recommendations": [
    {
      "type": "budget|keyword|negative|bid|copy|structure",
      "campaign": "exact campaign name or 'Account-wide'",
      "title": "Short recommendation title",
      "detail": "Specific action with numbers",
      "priority": "high|medium|low",
      "whyNow": "one sentence on why this matters right now, not later",
      "platformReason": "one sentence on why this is specific to Google Ads",
      "ifIgnored": "one sentence on the likely cost of not acting"
    }
  ],
  "strengths": ["specific one-liner with real metric or campaign name"],
  "weaknesses": ["specific one-liner with real metric or campaign name"],
  "opportunities": ["specific one-liner with real metric or campaign name"],
  "creativeNotes": [
    { "name": "exact headline or ad name from the AD PERFORMANCE data below", "note": "one-sentence recommendation for this specific creative" }
  ]
}

Score guide: 70+ good, 45-69 average, below 45 poor. Weight: CTR quality 25%, conversion rate 35%, ROAS 25%, spend efficiency 15%.
Rules: max 6 findings, max 6 recommendations, 3 strengths, 3 weaknesses, 3 opportunities, max 5 creativeNotes (only for creatives genuinely worth flagging — a top performer or a clear underperformer). Reference real names and numbers. Do NOT include a confidence field anywhere — confidence is calculated separately from real data, never state or imply a certainty level yourself. If minimal data, say so explicitly in whyNow/ifIgnored rather than overstating certainty.`;

    // V7 Phase 1 â€” light Context Engine V2 touch: real product/audience
    // names so recommendations can reference the actual business, not a
    // full context dump into an already-large prompt.
    const _bizCtx = await _gatherBusinessContext(user.id).catch(() => null);

    const userMsg = `Account: ${accountName} (ID: ${customerId}) | Period: ${range}${_bizCtx ? `\n\nBUSINESS CONTEXT (if competitor info is present, use it only for strategic positioning — never to copy or replicate competitor messaging):\n${_bizCtx.text}` : ''}

TOTALS â€” Spend: â‚¬${f(totalSpend)} | Impressions: ${totalImpr} | Clicks: ${totalClicks} | CTR: ${totalImpr > 0 ? f((totalClicks/totalImpr)*100) : '0.00'}% | Conversions: ${f(totalConv)} | CPA: â‚¬${totalConv > 0 ? f(totalSpend/totalConv) : 'N/A'} | ROAS: ${totalSpend > 0 ? f(totalConvVal/totalSpend) : '0.00'}x | Revenue: â‚¬${f(totalConvVal)}

CAMPAIGNS (by spend):
${campSummary || 'No campaign spend in this period'}

TOP KEYWORDS BY SPEND:
${kwLines.length > 0 ? kwLines.join('\n') : 'No keyword data'}

SEARCH TERMS WITH SPEND BUT ZERO CONVERSIONS (potential wasted spend):
${wastedLines.length > 0 ? wastedLines.join('\n') : 'None identified'}

HIGH-SPEND CAMPAIGNS WITH ZERO CONVERSIONS:
${zeroCampLines.length > 0 ? zeroCampLines.join('\n') : 'None â€” all campaigns with spend have conversions'}

AD PERFORMANCE (top by spend â€” use these exact names in creativeNotes):
${adLines.length > 0 ? adLines.join('\n') : 'No ad-level data'}`;

    const raw = await _aimlText('text-copy', system, userMsg, { max_tokens: 2400 });

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
    } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        console.error('[Ads/analyze] unparseable AI response:', raw.slice(0, 300));
        const parseErr = new Error('AI response could not be parsed â€” try again');
        parseErr.status = 500;
        throw parseErr;
      }
      parsed = JSON.parse(m[0]);
    }

    // V6 Phase 2 â€” Campaign Priority (calculated, not AI-assigned)
    const avgCtr  = _avg(campaigns, 'ctr');
    const avgRoas = _avg(campaigns, 'roas');
    const campaignsWithPriority = campaigns.map(c => Object.assign({}, c, { priority: _campaignPriority(c, avgCtr, avgRoas) }));

    // V6 Phase 2 â€” Confidence Engine (calculated, not AI-guessed)
    const days = _rangeDays(range);
    const accountTotals = { clicks: totalClicks, conversions: totalConv };
    const findings        = _attachConfidence(parsed.findings, campaignsWithPriority, accountTotals, days);
    const recommendations = _attachConfidence(parsed.recommendations, campaignsWithPriority, accountTotals, days);

    // Merge the AI's qualitative creative notes onto the deterministic creatives array
    (parsed.creativeNotes || []).forEach(note => {
      const match = creatives.find(cr => cr.name && note.name && cr.name.toLowerCase() === String(note.name).toLowerCase());
      if (match) match.recommendation = note.note;
    });

    console.log('[Ads/analyze] score:', parsed.score, '| findings:', findings.length, '| recs:', recommendations.length, '| creatives:', creatives.length);
    return {
      score:           parsed.score || 0,
      findings, recommendations,
      strengths:       parsed.strengths       || [],
      weaknesses:      parsed.weaknesses      || [],
      opportunities:   parsed.opportunities   || [],
      campaigns: campaignsWithPriority,
      creatives,
      account:   { id: customerId, name: accountName },
      date_range: range,
      totals: {
        spend: totalSpend, impressions: totalImpr, clicks: totalClicks,
        ctr: totalImpr > 0 ? (totalClicks / totalImpr) * 100 : 0,
        conversions: totalConv,
        cpa: totalConv > 0 ? totalSpend / totalConv : 0,
        roas: totalSpend > 0 ? totalConvVal / totalSpend : 0,
        conversions_value: totalConvVal
      }
    };
}

app.post('/api/ads/analyze', async (req, res) => {
  let reservation;
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    reservation = await creditManager.reserveCredits(user, 'ai_analysis');
    // Explicit "Analyze with AI" click -- always bypasses the shared cache.
    const dr = resolveDateRange(req.body && req.body.date_range, req.body && req.body.date_since, req.body && req.body.date_until);
    const result = await getOrRefreshAnalysis(user, 'google', dr.key, { forceRefresh: true });
    await creditManager.finalizeCreditLog(reservation, 'ai_analysis', { provider: 'aiml', success: true, route: req.path });
    res.json(result);
  } catch (err) {
    if (reservation) creditManager.finalizeCreditLog(reservation, 'ai_analysis', { success: false, error: err.message, route: req.path }).catch(() => {});
    if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
    console.error('[Ads/analyze]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', gads_status: err.gadsStatus || null, gads_codes: err.gadsErrorCodes || null });
  }
});

// â”€â”€ POST /api/ads/recommend â€” self-contained AI copy + keyword recs
// Fetches fresh campaign and keyword data directly from Google Ads.
// Accepts only { date_range } from the request body.
app.post('/api/ads/recommend', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const { accessToken, customerId, accountName, loginCustomerId } = await _getGadsAccess(user);

    const dr    = resolveDateRange(req.body && req.body.date_range, req.body && req.body.date_since, req.body && req.body.date_until);
    const range = dr.key;

    const [campResults, kwResults, stResults] = await Promise.all([

      _gadsQuery(accessToken, customerId, `
        SELECT
          campaign.id, campaign.name, campaign.status,
          campaign.advertising_channel_type,
          metrics.cost_micros, metrics.impressions, metrics.clicks,
          metrics.ctr, metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date ${dr.gaqlWhere}
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
        WHERE segments.date ${dr.gaqlWhere}
          AND metrics.impressions > 0
        ORDER BY metrics.cost_micros DESC
        LIMIT 30
      `, loginCustomerId).catch(() => []),

      // Search terms with spend but no conversions â†’ negative keyword candidates
      _gadsQuery(accessToken, customerId, `
        SELECT
          search_term_view.search_term,
          campaign.name,
          metrics.cost_micros, metrics.clicks, metrics.conversions
        FROM search_term_view
        WHERE segments.date ${dr.gaqlWhere}
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
      return `${c.name} | ${c.status || ''} | ${c.advertisingChannelType || ''} | Spend: â‚¬${f(sp)} | CTR: ${im > 0 ? f((cl/im)*100) : '0.00'}% | Conv: ${f(cv)} | CPA: â‚¬${cv > 0 ? f(sp/cv) : 'N/A'} | ROAS: ${sp > 0 ? f(vl/sp) : '0.00'}x`;
    }).join('\n');

    const kwSummary = kwResults.slice(0, 20).map(r => {
      const agc = r.adGroupCriterion || {}, kw = agc.keyword || {}, m = r.metrics || {};
      const sp = Number(m.costMicros || 0) / 1e6;
      const im = Number(m.impressions || 0), cl = Number(m.clicks || 0);
      return `[${kw.matchType || '?'}] "${kw.text}" | ${r.campaign?.name || ''} | â‚¬${f(sp)} | CTR: ${im > 0 ? f((cl/im)*100) : '0.00'}% | Conv: ${f(Number(m.conversions || 0))}`;
    }).join('\n');

    // Search terms with spend but no conversions = negative keyword candidates
    const negCandidates = stResults.filter(r => Number(r.metrics?.conversions || 0) === 0).slice(0, 15).map(r => {
      const st = r.searchTermView || {}, m = r.metrics || {};
      return `"${st.searchTerm}" | ${r.campaign?.name || ''} | â‚¬${f(Number(m.costMicros || 0)/1e6)} | ${m.clicks || 0} clicks | 0 conv`;
    }).join('\n');

    const system = `You are an expert Google Ads copywriter and performance strategist. Return ONLY valid JSON â€” no markdown, no code fences, no explanation. Start your response with {.

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
- 15 headlines (benefit-focused, â‰¤30 chars each, varied angles)
- 10 descriptions (include a CTA, â‰¤90 chars each, specific to this business)
- 10 keyword suggestions based on gaps in existing keyword coverage
- 10 negative keywords (use the search term data provided to identify irrelevant queries)
- One budget recommendation per campaign with actual numbers`;

    const userMsg = `Account: ${accountName} | Period: ${range}

TOTALS â€” Spend: â‚¬${f(totalSpend)} | CTR: ${totalImpr > 0 ? f((totalClicks/totalImpr)*100) : '0.00'}% | Conv: ${f(totalConv)} | CPA: â‚¬${totalConv > 0 ? f(totalSpend/totalConv) : 'N/A'} | ROAS: ${totalSpend > 0 ? f(totalConvVal/totalSpend) : '0.00'}x

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
      if (!m) { console.error('[Ads/recommend] unparseable AI response:', raw.slice(0, 300)); return res.status(500).json({ error: 'AI response could not be parsed â€” try again' }); }
      parsed = JSON.parse(m[0]);
    }

    console.log('[Ads/recommend] headlines:', parsed.headlines?.length, '| negatives:', parsed.negative_keywords?.length);
    res.json(parsed);
  } catch (err) {
    console.error('[Ads/recommend]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error', gads_status: err.gadsStatus || null, gads_codes: err.gadsErrorCodes || null });
  }
});

// ── V6 Home Intelligence Dashboard ───────────────────────────────
// Period-over-period comparison: Google Ads and Meta both retain their own
// historical performance data, so "CTR increased 13%" is answerable by
// querying two explicit date windows live and diffing them — no local
// metrics-history storage needed.

function _periodWindows(days) {
  const fmt = d => d.toISOString().slice(0, 10);
  const now = new Date();
  const currentEnd = new Date(now);
  const currentStart = new Date(now); currentStart.setDate(currentStart.getDate() - (days - 1));
  const prevEnd = new Date(currentStart); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (days - 1));
  return {
    current:  { since: fmt(currentStart), until: fmt(currentEnd) },
    previous: { since: fmt(prevStart),    until: fmt(prevEnd) }
  };
}

async function _gadsFetchTotals(accessToken, customerId, loginCustomerId, sinceISO, untilISO, campaignId) {
  const campFilter = /^\d+$/.test(String(campaignId || '')) ? ` AND campaign.id = ${Number(campaignId)}` : '';
  const results = await _gadsQuery(accessToken, customerId, `
    SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${sinceISO}' AND '${untilISO}'
      AND campaign.status != 'REMOVED'${campFilter}
  `, loginCustomerId);
  let spend = 0, impr = 0, clicks = 0, conv = 0, convVal = 0;
  results.forEach(r => {
    const m = r.metrics || {};
    spend   += Number(m.costMicros || 0) / 1e6;
    impr    += Number(m.impressions || 0);
    clicks  += Number(m.clicks || 0);
    conv    += Number(m.conversions || 0);
    convVal += Number(m.conversionsValue || 0);
  });
  return {
    spend, impressions: impr, clicks,
    ctr: impr > 0 ? (clicks / impr) * 100 : 0,
    conversions: conv,
    cpa: conv > 0 ? spend / conv : 0,
    roas: spend > 0 ? convVal / spend : 0
  };
}

async function _metaFetchTotals(accessToken, accountId, sinceISO, untilISO, campaignId) {
  const target = /^\d+$/.test(String(campaignId || '')) ? String(campaignId) : accountId;
  const data = await _metaFetch('/' + target + '/insights', accessToken, {
    time_range: JSON.stringify({ since: sinceISO, until: untilISO }),
    fields: 'spend,impressions,clicks,ctr,actions'
  });
  const row = (data.data && data.data[0]) || {};
  const spend = parseFloat(row.spend || 0);
  const impr  = parseInt(row.impressions || 0, 10);
  const clicks = parseInt(row.clicks || 0, 10);
  const conv = _metaConversions(row.actions);
  return {
    spend, impressions: impr, clicks,
    ctr: impr > 0 ? (clicks / impr) * 100 : 0,
    conversions: conv,
    cpa: conv > 0 ? spend / conv : 0
  };
}

// V6 Final Phase â€” Predictive Intelligence. Daily-granularity history for a
// deterministic trend forecast (same real-data-only ethos as the Confidence
// Engine): the AI is only ever asked to narrate numbers already computed
// here, never to produce the numbers itself.
async function _gadsFetchDailySeries(accessToken, customerId, loginCustomerId, days, campaignId) {
  const fmt = d => d.toISOString().slice(0, 10);
  const until = new Date();
  const since = new Date(); since.setDate(since.getDate() - (days - 1));
  const campFilter = /^\d+$/.test(String(campaignId || '')) ? ` AND campaign.id = ${Number(campaignId)}` : '';
  const results = await _gadsQuery(accessToken, customerId, `
    SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${fmt(since)}' AND '${fmt(until)}'
      AND campaign.status != 'REMOVED'${campFilter}
  `, loginCustomerId);
  const byDate = {};
  results.forEach(r => {
    const d = r.segments && r.segments.date;
    if (!d) return;
    const m = r.metrics || {};
    if (!byDate[d]) byDate[d] = { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0, conversions_value: 0 };
    byDate[d].spend             += Number(m.costMicros || 0) / 1e6;
    byDate[d].impressions       += Number(m.impressions || 0);
    byDate[d].clicks            += Number(m.clicks || 0);
    byDate[d].conversions       += Number(m.conversions || 0);
    byDate[d].conversions_value += Number(m.conversionsValue || 0);
  });
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function _metaFetchDailySeries(accessToken, accountId, days, campaignId) {
  const fmt = d => d.toISOString().slice(0, 10);
  const until = new Date();
  const since = new Date(); since.setDate(since.getDate() - (days - 1));
  const target = /^\d+$/.test(String(campaignId || '')) ? String(campaignId) : accountId;
  const data = await _metaFetch('/' + target + '/insights', accessToken, {
    time_range: JSON.stringify({ since: fmt(since), until: fmt(until) }),
    time_increment: '1',
    fields: 'spend,impressions,clicks,actions'
  });
  return (data.data || []).map(row => ({
    date: row.date_start,
    spend: parseFloat(row.spend || 0),
    impressions: parseInt(row.impressions || 0, 10),
    clicks: parseInt(row.clicks || 0, 10),
    conversions: _metaConversions(row.actions)
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function _linearTrend(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  values.forEach((y, x) => { sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; });
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Deterministic linear-trend forecast, extrapolated forward from real
// observed daily history. Rates (CTR/ROAS) are projected as trend-adjusted
// ratios, not summed. Confidence is reduced further for longer horizons â€”
// a 30-day forecast is inherently less certain than a 7-day one.
function _computeForecast(series, horizonDays) {
  const n = series.length;
  const projectSum = values => {
    const { slope, intercept } = _linearTrend(values);
    let total = 0;
    for (let i = 0; i < horizonDays; i++) total += Math.max(0, intercept + slope * (n + i));
    return total;
  };

  const spendSeries       = series.map(d => d.spend || 0);
  const clicksSeries      = series.map(d => d.clicks || 0);
  const imprSeries        = series.map(d => d.impressions || 0);
  const convSeries        = series.map(d => d.conversions || 0);
  const hasRevenue        = series.some(d => d.conversions_value != null);
  const revenueSeries     = hasRevenue ? series.map(d => d.conversions_value || 0) : null;

  const forecastSpend        = projectSum(spendSeries);
  const forecastClicks       = projectSum(clicksSeries);
  const forecastImpressions  = projectSum(imprSeries);
  const forecastConversions  = projectSum(convSeries);
  const forecastRevenue      = hasRevenue ? projectSum(revenueSeries) : null;

  const totalClicks = clicksSeries.reduce((a, b) => a + b, 0);
  const totalConv   = convSeries.reduce((a, b) => a + b, 0);
  const baseConfidence = _calcConfidence({ clicks: totalClicks, conversions: totalConv, days: n });
  const confidence = Math.round(baseConfidence * (horizonDays <= 7 ? 1 : 0.75));

  return {
    horizonDays,
    spend: forecastSpend,
    impressions: Math.round(forecastImpressions),
    clicks: Math.round(forecastClicks),
    conversions: Math.round(forecastConversions * 10) / 10,
    ctr: forecastImpressions > 0 ? (forecastClicks / forecastImpressions) * 100 : 0,
    revenue: forecastRevenue,
    roas: (forecastRevenue != null && forecastSpend > 0) ? forecastRevenue / forecastSpend : null,
    confidence,
    confidenceBasis: `${n} days of history, ${Math.round(totalClicks)} clicks, ${Math.round(totalConv)} conversions observed`
  };
}

app.get('/api/intelligence/forecast', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const platform = req.query.platform === 'meta' ? 'meta' : 'google';
    const horizon = parseInt(req.query.horizon, 10) === 30 ? 30 : 7;
    const historyDays = 30; // observe a stable window regardless of horizon

    let series;
    if (platform === 'google') {
      const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(req.user);
      series = await _gadsFetchDailySeries(accessToken, customerId, loginCustomerId, historyDays);
    } else {
      const { accessToken, accountId } = await _getMetaAccess(req.user);
      series = await _metaFetchDailySeries(accessToken, accountId, historyDays);
    }

    if (series.length < 3) {
      return res.json({ available: false, reason: 'Not enough historical data yet to forecast reliably.' });
    }

    const forecast = _computeForecast(series, horizon);

    let reasoning = `Based on the trend over the last ${series.length} days of real performance data.`;
    let keyAssumptions = ['Recent performance trends continue at a similar rate.'];
    try {
      const system = `You are Oriven, writing a one-sentence "reasoning" and up to 3 "keyAssumptions" for an ALREADY-COMPUTED forecast. Do not change or invent any numbers â€” only explain the ones given. Return ONLY valid JSON, no markdown, no code fences: {"reasoning": "one sentence", "keyAssumptions": ["short assumption", "..."]}`;
      const userMsg = `Platform: ${platform === 'google' ? 'Google Ads' : 'Meta Ads'}\nHorizon: ${horizon} days\nForecast: spend â‚¬${forecast.spend.toFixed(2)}, clicks ${forecast.clicks}, conversions ${forecast.conversions}, CTR ${forecast.ctr.toFixed(2)}%${forecast.roas != null ? ', ROAS ' + forecast.roas.toFixed(2) + 'x' : ''}\nBased on: ${forecast.confidenceBasis}\nConfidence: ${forecast.confidence}%`;
      const raw = await _aimlText('forecast', system, userMsg, { max_tokens: 300 });
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.reasoning) reasoning = parsed.reasoning;
      if (parsed.keyAssumptions) keyAssumptions = parsed.keyAssumptions;
    } catch (err) {
      console.warn('[intelligence/forecast] narrative synthesis failed, using fallback text:', err.message);
    }

    res.json(Object.assign({ available: true, platform, reasoning, keyAssumptions }, forecast));
  } catch (err) {
    console.error('[intelligence/forecast]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not compute a forecast right now.' });
  }
});

// Pure diff â€” no API calls. Only computes deltas for metrics present in `current`,
// so Google's (with roas) and Meta's (without) totals both work unmodified.
function _computeDelta(current, previous) {
  const out = {};
  Object.keys(current).forEach(k => {
    const cur = current[k] || 0;
    const prev = (previous && previous[k]) || 0;
    let deltaPct = null, trend = 'flat';
    if (prev > 0) {
      deltaPct = ((cur - prev) / prev) * 100;
      trend = deltaPct > 1 ? 'up' : deltaPct < -1 ? 'down' : 'flat';
    } else if (cur > 0) {
      trend = 'up';
    }
    out[k] = { value: cur, prevValue: prev, deltaPct, trend };
  });
  return out;
}

function _rangeDays(range, customSince, customUntil) {
  const STATIC_DAYS = { LAST_7_DAYS: 7, LAST_14_DAYS: 14, LAST_30_DAYS: 30, LAST_90_DAYS: 90, TODAY: 1, YESTERDAY: 1, LAST_12_MONTHS: 365, LIFETIME: 1825 };
  if (STATIC_DAYS[range] != null) return STATIC_DAYS[range];
  const now = new Date();
  if (range === 'THIS_MONTH') return now.getDate();
  if (range === 'LAST_MONTH') return new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  if (range === 'CUSTOM' && /^\d{4}-\d{2}-\d{2}$/.test(customSince || '') && /^\d{4}-\d{2}-\d{2}$/.test(customUntil || '')) {
    return Math.max(1, Math.round((new Date(customUntil) - new Date(customSince)) / 86400000) + 1);
  }
  return 30;
}

// V6 Phase 2 â€” Confidence Engine. Confidence is a function of REAL observed
// sample size (clicks, conversions, days) â€” never the model's own guess.
// Log-scaled so early data moves the needle fast and extra volume has
// diminishing returns; capped 8-96 so nothing ever reads as 0% or 100% sure.
function _calcConfidence({ clicks, conversions, days }) {
  const score = Math.min(40, Math.log10((clicks || 0) + 1) * 22)
              + Math.min(40, Math.log10((conversions || 0) + 1) * 28)
              + Math.min(20, ((days || 1) / 14) * 20);
  return Math.round(Math.max(8, Math.min(96, score)));
}

// Matches a finding/recommendation's `campaign` field against the real
// campaigns array already computed for this call; falls back to account
// totals for "Account-wide" items. Overwrites whatever confidence the AI
// guessed, and attaches confidenceBasis so the UI can show its working.
function _attachConfidence(items, campaigns, accountTotals, days) {
  return (items || []).map(item => {
    const camp = (campaigns || []).find(c => c.name && item.campaign && c.name.toLowerCase() === String(item.campaign).toLowerCase());
    const sample = camp
      ? { clicks: camp.clicks, conversions: camp.conversions, days }
      : { clicks: accountTotals.clicks, conversions: accountTotals.conversions, days };
    item.confidence = _calcConfidence(sample);
    item.confidenceBasis = `${days} days, ${Math.round(sample.clicks)} clicks, ${Math.round(sample.conversions)} conversions`;
    return item;
  });
}

// V6 Phase 2 â€” Campaign Priority System. Deterministic, calculated against
// the account's own average â€” not AI-assigned â€” so it's explainable and
// consistent every time the same numbers come in.
function _campaignPriority(c, avgCtr, avgRoas) {
  if (c.spend > 5 && c.conversions === 0) return { level: 'critical', reason: 'Spending with zero conversions' };
  if (avgCtr && c.ctr < avgCtr * 0.5 && c.impressions > 500) return { level: 'needs_attention', reason: 'CTR well below account average' };
  if (avgRoas && c.roas > avgRoas * 1.6 && c.conversions >= 5) return { level: 'excellent', reason: 'Top-performing campaign by ROAS' };
  if (avgRoas && c.roas > avgRoas * 1.3 && c.conversions >= 3) return { level: 'scaling', reason: 'ROAS significantly above account average' };
  return { level: 'healthy', reason: 'Performing within normal range' };
}

function _avg(arr, key) {
  const vals = (arr || []).map(x => x[key]).filter(v => typeof v === 'number' && v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// V6 Phase 2 â€” Cross-Platform Budget Intelligence. Composes on top of the
// Confidence Engine and Campaign Priority System instead of computing its
// own numbers from scratch â€” every recommendation traces back to real,
// already-computed deltas and priorities.
function _crossPlatformRecommendations(platforms) {
  const recs = [];
  const g = platforms.google, m = platforms.meta;
  if (!g || g.error || !m || m.error) return recs;

  const gCpa = g.delta.cpa && g.delta.cpa.value;
  const mCpa = m.delta.cpa && m.delta.cpa.value;
  if (gCpa > 0 && mCpa > 0) {
    const gapPct = Math.abs(gCpa - mCpa) / Math.max(gCpa, mCpa) * 100;
    if (gapPct > 20) {
      const winner = gCpa < mCpa ? 'google' : 'meta';
      const loser  = winner === 'google' ? 'meta' : 'google';
      const winnerLabel = winner === 'google' ? 'Google Ads' : 'Meta Ads';
      const loserLabel  = loser  === 'google' ? 'Google Ads' : 'Meta Ads';
      const winnerCpa  = winner === 'google' ? gCpa : mCpa;
      const loserCpa   = loser  === 'google' ? gCpa : mCpa;
      const loserSpend = platforms[loser].delta.spend.value;
      const moveAmount = Math.round(loserSpend * 0.2);
      const extraConversions = winnerCpa > 0 ? moveAmount / winnerCpa : 0;
      recs.push({
        type: 'move_budget',
        title: `Move budget from ${loserLabel} to ${winnerLabel}`,
        reasoning: `${winnerLabel}'s cost per conversion (â‚¬${winnerCpa.toFixed(2)}) is ${gapPct.toFixed(0)}% lower than ${loserLabel}'s (â‚¬${loserCpa.toFixed(2)}) over the last 7 days.`,
        expectedImprovement: `~${extraConversions.toFixed(1)} more conversions/week at the same total spend`,
        confidence: _calcConfidence({ clicks: platforms[winner].delta.clicks.value, conversions: platforms[winner].delta.conversions.value, days: 7 }),
        message: `Move about â‚¬${moveAmount}/week of budget from ${loserLabel} to ${winnerLabel} â€” ${winnerLabel} is converting more efficiently right now.`
      });
    }
  }

  ['google', 'meta'].forEach(key => {
    const pd = platforms[key];
    if (!pd || pd.error || !pd.campaigns) return;
    const label = key === 'google' ? 'Google Ads' : 'Meta Ads';
    pd.campaigns.filter(c => c.priority && (c.priority.level === 'scaling' || c.priority.level === 'excellent')).slice(0, 1).forEach(c => {
      recs.push({
        type: 'scale_winner',
        title: `Scale "${c.name}" on ${label}`,
        reasoning: c.priority.reason + (c.roas ? ` ROAS ${c.roas.toFixed(2)}x.` : ''),
        expectedImprovement: 'More conversions at similar efficiency if scaled gradually',
        confidence: _calcConfidence({ clicks: c.clicks, conversions: c.conversions, days: 7 }),
        message: `Increase the budget for "${c.name}" on ${label} â€” it's one of the top-performing campaigns right now.`
      });
    });
    pd.campaigns.filter(c => c.priority && c.priority.level === 'critical').slice(0, 1).forEach(c => {
      recs.push({
        type: 'reduce_loser',
        title: `Reduce or pause "${c.name}" on ${label}`,
        reasoning: c.priority.reason,
        expectedImprovement: `Save ~â‚¬${c.spend.toFixed(2)}/week in wasted spend`,
        confidence: _calcConfidence({ clicks: c.clicks, conversions: c.conversions, days: 7 }),
        message: `Pause "${c.name}" on ${label} â€” it's spending without converting.`
      });
    });
  });

  return recs;
}

// GET /api/intelligence/kpi-trend â€” real period-over-period delta for one
// platform's KPI row (Analytics page). Thin wrapper over the same fetch +
// diff machinery /api/intelligence/home already uses, generalized to any
// supported date_range instead of a fixed 7-day window.
app.get('/api/intelligence/kpi-trend', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const platform = req.query.platform === 'meta' ? 'meta' : 'google';
    const range = req.query.date_range;
    const days = _rangeDays(range, req.query.date_since, req.query.date_until);
    const windows = _periodWindows(days);

    const campaignId = req.query.campaignId || null;
    let delta;
    if (platform === 'google') {
      const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(req.user);
      const [current, previous] = await Promise.all([
        _gadsFetchTotals(accessToken, customerId, loginCustomerId, windows.current.since, windows.current.until, campaignId),
        _gadsFetchTotals(accessToken, customerId, loginCustomerId, windows.previous.since, windows.previous.until, campaignId)
      ]);
      delta = _computeDelta(current, previous);
    } else {
      const { accessToken, accountId } = await _getMetaAccess(req.user);
      const [current, previous] = await Promise.all([
        _metaFetchTotals(accessToken, accountId, windows.current.since, windows.current.until, campaignId),
        _metaFetchTotals(accessToken, accountId, windows.previous.since, windows.previous.until, campaignId)
      ]);
      delta = _computeDelta(current, previous);
    }
    res.json({ delta, days });
  } catch (err) {
    console.error('[intelligence/kpi-trend]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not compute trend' });
  }
});

// GET /api/intelligence/kpi-series â€” real day-by-day spend/conversions/ROAS/CTR
// for the Campaigns Overview charts. Reuses the exact daily-fetch helpers the
// Predictive Autopilot forecast already relies on (_gadsFetchDailySeries /
// _metaFetchDailySeries) rather than a new fetch path â€” same real-data-only
// ethos as the rest of the Confidence/Forecast engine, just exposed directly
// instead of only ever feeding a forecast.
app.get('/api/intelligence/kpi-series', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const platform = req.query.platform === 'meta' ? 'meta' : 'google';
    const days = Math.min(400, Math.max(1, _rangeDays(req.query.date_range, req.query.date_since, req.query.date_until)));
    const campaignId = req.query.campaignId || null;

    let series;
    if (platform === 'google') {
      const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(req.user);
      series = await _gadsFetchDailySeries(accessToken, customerId, loginCustomerId, days, campaignId);
    } else {
      const { accessToken, accountId } = await _getMetaAccess(req.user);
      series = await _metaFetchDailySeries(accessToken, accountId, days, campaignId);
    }
    res.json({ series: series || [], days });
  } catch (err) {
    console.error('[intelligence/kpi-series]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not load KPI series' });
  }
});

// ── V6 Final Phase â€” Intelligence Event Log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// One table (`intelligence_events`), one write helper (shared with
// services/toolRouter.js via services/eventLog.js), one read endpoint,
// used by three different frontend presentations (Live Feed, Notifications,
// Intelligence Timeline) so there's exactly one source of truth for
// "things Oriven detected or did" rather than three parallel systems.
const _eventLog = require('./services/eventLog');
const _logIntelligenceEvent = _eventLog.logEvent;

app.get('/api/intelligence/events', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query = supabaseAdmin.from('intelligence_events')
      .select('*')
      .eq('user_id', req.user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);

    if (req.query.severity) query = query.eq('severity', req.query.severity);
    if (req.query.type) query = query.eq('type', req.query.type);
    if (req.query.dismissed === 'false') query = query.eq('dismissed', false);
    if (req.query.dismissed === 'true') query = query.eq('dismissed', true);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (err) {
    console.error('[intelligence/events]', err.message);
    res.status(500).json({ error: 'Could not load your activity feed right now.' });
  }
});

app.patch('/api/intelligence/events/:id/dismiss', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('intelligence_events')
      .update({ dismissed: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[intelligence/events/dismiss]', err.message);
    res.status(500).json({ error: 'Could not dismiss that.' });
  }
});

// GET /api/intelligence/home â€” single data source for the V6 Home Dashboard.
// Combines: connected-platform detection, period-over-period deltas (real
// trend data, not fabricated), and the existing _analyzeGoogleAccount /
// _analyzeMetaAccount score+findings â€” then asks the AI to synthesize (not
// invent) a short narrative briefing on top of those real numbers.
// V6 Final Phase â€” shared platform-intelligence loader. Extracted out of
// /api/intelligence/home so /api/intelligence/briefing, /opportunities, and
// /executive reuse the exact same Google+Meta loading logic instead of each
// re-deriving it (Epic 9: "no duplicate logic").
function _rangeForDays(days) {
  return days <= 7 ? 'LAST_7_DAYS' : days <= 14 ? 'LAST_14_DAYS' : days <= 30 ? 'LAST_30_DAYS' : 'LAST_90_DAYS';
}

async function _gatherPlatformIntelligence(user, days) {
  const { data: rows } = await supabaseAdmin
    .from('integrations').select('provider').eq('user_id', user.id).in('provider', ['google_ads', 'meta_ads']);
  const providers = new Set((rows || []).map(r => r.provider));
  const hasGoogle = providers.has('google_ads');
  const hasMeta   = providers.has('meta_ads');
  const platforms = {};
  if (!hasGoogle && !hasMeta) return { hasGoogle, hasMeta, platforms };

  const windows = _periodWindows(days);
  const range = _rangeForDays(days);
  const tasks = [];
  if (hasGoogle) {
    tasks.push((async () => {
      try {
        const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
        const [current, previous, analysis] = await Promise.all([
          _gadsFetchTotals(accessToken, customerId, loginCustomerId, windows.current.since, windows.current.until),
          _gadsFetchTotals(accessToken, customerId, loginCustomerId, windows.previous.since, windows.previous.until),
          getOrRefreshAnalysis(user, 'google', range)
        ]);
        platforms.google = { delta: _computeDelta(current, previous), score: analysis.score, findings: analysis.findings, recommendations: analysis.recommendations, campaigns: analysis.campaigns, creatives: analysis.creatives };
      } catch (err) {
        console.warn('[intelligence] Google load failed:', err.message);
        platforms.google = { error: true };
      }
    })());
  }
  if (hasMeta) {
    tasks.push((async () => {
      try {
        const { accessToken, accountId } = await _getMetaAccess(user);
        const [current, previous, analysis] = await Promise.all([
          _metaFetchTotals(accessToken, accountId, windows.current.since, windows.current.until),
          _metaFetchTotals(accessToken, accountId, windows.previous.since, windows.previous.until),
          getOrRefreshAnalysis(user, 'meta', range)
        ]);
        platforms.meta = { delta: _computeDelta(current, previous), score: analysis.score, findings: analysis.findings, recommendations: analysis.recommendations, campaigns: analysis.campaigns, creatives: analysis.creatives };
      } catch (err) {
        console.warn('[intelligence] Meta load failed:', err.message);
        platforms.meta = { error: true };
      }
    })());
  }
  await Promise.all(tasks);
  return { hasGoogle, hasMeta, platforms };
}

function _computeHealthScore(platforms) {
  const scores = Object.values(platforms).filter(p => p && !p.error).map(p => p.score);
  const healthScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const healthLabel = healthScore === null ? null : healthScore >= 70 ? 'Excellent' : healthScore >= 45 ? 'Good' : 'Needs attention';
  return { healthScore, healthLabel };
}

app.get('/api/intelligence/home', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.json({ connected: false });

    const { hasGoogle, hasMeta, platforms } = await _gatherPlatformIntelligence(req.user, 7);
    if (!hasGoogle && !hasMeta) return res.json({ connected: false });

    // Deterministic (non-AI) platform comparison â€” only when both are live.
    // Full side-by-side on every metric that's honestly available for both
    // platforms; ROAS is Google-only since Meta's fetched totals here don't
    // include conversion value â€” shown as null for Meta, never fabricated.
    let comparison = null;
    if (platforms.google && !platforms.google.error && platforms.meta && !platforms.meta.error) {
      const gd = platforms.google.delta, md = platforms.meta.delta;
      const cpc = d => d.clicks.value > 0 ? d.spend.value / d.clicks.value : 0;
      const cpm = d => d.impressions.value > 0 ? (d.spend.value / d.impressions.value) * 1000 : 0;
      comparison = {
        table: {
          spend:       { google: gd.spend.value,       meta: md.spend.value },
          ctr:         { google: gd.ctr.value,          meta: md.ctr.value },
          cpc:         { google: cpc(gd),                meta: cpc(md) },
          cpm:         { google: cpm(gd),                meta: cpm(md) },
          cpa:         { google: gd.cpa.value,          meta: md.cpa.value },
          conversions: { google: gd.conversions.value,  meta: md.conversions.value },
          roas:        { google: gd.roas ? gd.roas.value : null, meta: null }
        },
        betterCtr: gd.ctr.value >= md.ctr.value ? 'google' : 'meta',
        betterCpa: (gd.cpa.value || Infinity) <= (md.cpa.value || Infinity) ? 'google' : 'meta',
        recommendations: _crossPlatformRecommendations(platforms)
      };
    }

    const { healthScore, healthLabel } = _computeHealthScore(platforms);

    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const platformSummaryLines = [];
    [['google', 'Google Ads'], ['meta', 'Meta Ads']].forEach(([key, label]) => {
      const pd = platforms[key];
      if (!pd || pd.error) return;
      const d = pd.delta;
      platformSummaryLines.push(`${label}: spend â‚¬${d.spend.value.toFixed(2)} (${d.spend.trend}), CTR ${d.ctr.value.toFixed(2)}% (${d.ctr.trend}${d.ctr.deltaPct !== null ? ', ' + d.ctr.deltaPct.toFixed(1) + '%' : ''}), conversions ${d.conversions.value.toFixed(1)} (${d.conversions.trend}), health score ${pd.score}/100`);
      (pd.findings || []).slice(0, 2).forEach(f => platformSummaryLines.push(`  - ${label} finding: ${f.title} â€” ${f.detail}`));
    });

    let narrative = { summaryItems: [], recommendedActions: [] };
    if (platformSummaryLines.length) {
      try {
        const system = `You are Oriven, synthesizing a marketing performance briefing from REAL data already computed below. Do not invent numbers or findings â€” only reference what's given. Return ONLY valid JSON, no markdown, no code fences. Start with {.
Structure:
{
  "summaryItems": [ { "type": "success|warning|opportunity", "text": "short specific sentence, e.g. 'Google CTR increased 12%'" } ],
  "recommendedActions": [ { "title": "short imperative, e.g. 'Increase Meta budget'", "why": "one sentence reason grounded in the data", "message": "the exact plain-language instruction to send to Oriven Chat to carry this out" } ]
}
Rules: max 5 summaryItems, max 4 recommendedActions, prioritize the highest-impact items, be specific with real numbers and platform names, never fabricate a number that isn't in the data below.`;
        const userMsg = `Time of day: ${timeGreeting}\n\nPLATFORM DATA:\n${platformSummaryLines.join('\n')}`;
        const raw = await _aimlText('home-briefing', system, userMsg, { max_tokens: 900 });
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(cleaned);
        narrative.summaryItems = parsed.summaryItems || [];
        narrative.recommendedActions = parsed.recommendedActions || [];
      } catch (err) {
        console.warn('[intelligence/home] narrative synthesis failed, falling back to raw findings:', err.message);
      }
    }

    res.json({
      connected: true,
      greeting: timeGreeting,
      healthScore, healthLabel,
      summaryItems: narrative.summaryItems,
      recommendedActions: narrative.recommendedActions,
      comparison,
      platforms
    });
  } catch (err) {
    console.error('[intelligence/home]', err.message);
    res.status(500).json({ error: 'Could not load your briefing right now. Please try again.' });
  }
});

// V6 Final Phase â€” Daily / Weekly / Monthly Briefings. Reuses the exact
// home-briefing narrative pattern above with a longer/framed lookback and a
// richer executive-style structure â€” not a new generator.
app.get('/api/intelligence/briefing', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.json({ connected: false });
    const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';
    const days = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;

    const { hasGoogle, hasMeta, platforms } = await _gatherPlatformIntelligence(req.user, days);
    if (!hasGoogle && !hasMeta) return res.json({ connected: false });

    const { healthScore, healthLabel } = _computeHealthScore(platforms);
    const crossPlatform = (platforms.google && !platforms.google.error && platforms.meta && !platforms.meta.error)
      ? _crossPlatformRecommendations(platforms) : [];

    const lines = [];
    [['google', 'Google Ads'], ['meta', 'Meta Ads']].forEach(([key, label]) => {
      const pd = platforms[key];
      if (!pd || pd.error) return;
      const d = pd.delta;
      lines.push(`${label}: spend â‚¬${d.spend.value.toFixed(2)} (${d.spend.trend}), CTR ${d.ctr.value.toFixed(2)}% (${d.ctr.trend}), conversions ${d.conversions.value.toFixed(1)} (${d.conversions.trend}), score ${pd.score}/100`);
      (pd.findings || []).slice(0, 3).forEach(f => lines.push(`  - finding (${f.severity}): ${f.title} â€” ${f.detail}`));
      (pd.recommendations || []).slice(0, 2).forEach(r => lines.push(`  - recommendation: ${r.title} â€” ${r.detail}`));
    });

    let brief = { wins: [], losses: [], recommendations: [], nextActions: [] };
    try {
      const system = `You are Oriven, writing a ${period} executive marketing brief from REAL data already computed below â€” a marketing director's report, not a dashboard dump. Do not invent numbers. Return ONLY valid JSON, no markdown: { "headline": "one sentence", "wins": ["..."], "losses": ["..."], "recommendations": ["..."], "nextActions": ["..."] }. Max 4 items per list.`;
      const userMsg = `Period: ${period}\n\n${lines.join('\n') || 'No platform data available.'}`;
      const raw = await _aimlText('home-briefing', system, userMsg, { max_tokens: 900 });
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);
      brief = { headline: parsed.headline || '', wins: parsed.wins || [], losses: parsed.losses || [], recommendations: parsed.recommendations || [], nextActions: parsed.nextActions || [] };
    } catch (err) {
      console.warn('[intelligence/briefing] narrative failed:', err.message);
    }

    res.json({ connected: true, period, healthScore, healthLabel, ...brief, platformComparison: crossPlatform, platforms });
  } catch (err) {
    console.error('[intelligence/briefing]', err.message);
    res.status(500).json({ error: 'Could not generate your briefing right now.' });
  }
});

// V6 Final Phase â€” Opportunity Engine. Not a new analysis system: pools the
// `recommendations` that _analyzeGoogleAccount / _analyzeMetaAccount already
// compute, ranks by confidence Ã— priority, account-wide instead of per-platform.
app.get('/api/intelligence/opportunities', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.json({ connected: false });
    const { hasGoogle, hasMeta, platforms } = await _gatherPlatformIntelligence(req.user, 7);
    if (!hasGoogle && !hasMeta) return res.json({ connected: false });

    const priorityWeight = { high: 3, medium: 2, low: 1 };
    const pooled = [];
    [['google', 'Google Ads'], ['meta', 'Meta Ads']].forEach(([key, label]) => {
      const pd = platforms[key];
      if (!pd || pd.error) return;
      (pd.recommendations || []).forEach(r => {
        pooled.push(Object.assign({ platform: key, platformLabel: label }, r,
          { rank: (r.confidence || 0) * (priorityWeight[r.priority] || 1) }));
      });
    });
    if (platforms.google && !platforms.google.error && platforms.meta && !platforms.meta.error) {
      _crossPlatformRecommendations(platforms).forEach(r => {
        pooled.push(Object.assign({ platform: 'cross', platformLabel: 'Cross-Platform' }, r,
          { rank: (r.confidence || 0) * 2.5 }));
      });
    }
    pooled.sort((a, b) => b.rank - a.rank);

    res.json({ connected: true, opportunities: pooled.slice(0, 12) });
  } catch (err) {
    console.error('[intelligence/opportunities]', err.message);
    res.status(500).json({ error: 'Could not load opportunities right now.' });
  }
});

// V6 Final Phase â€” Executive Mode. One request bundling the pieces already
// built above (health, opportunities, warnings, 7-day forecast) so the
// frontend can render "understand everything in 30 seconds" from one call.
app.get('/api/intelligence/executive', requireSubIfAuthed, async (req, res) => {
  try {
    if (!req.user) return res.json({ connected: false });
    const { hasGoogle, hasMeta, platforms } = await _gatherPlatformIntelligence(req.user, 7);
    if (!hasGoogle && !hasMeta) return res.json({ connected: false });

    const { healthScore, healthLabel } = _computeHealthScore(platforms);

    const priorityWeight = { high: 3, medium: 2, low: 1 };
    const pooled = [];
    const warnings = [];
    [['google', 'Google Ads'], ['meta', 'Meta Ads']].forEach(([key, label]) => {
      const pd = platforms[key];
      if (!pd || pd.error) return;
      (pd.recommendations || []).forEach(r => pooled.push(Object.assign({ platform: key, platformLabel: label }, r, { rank: (r.confidence || 0) * (priorityWeight[r.priority] || 1) })));
      (pd.findings || []).filter(f => f.severity === 'high').forEach(f => warnings.push(Object.assign({ platform: key, platformLabel: label }, f)));
    });
    pooled.sort((a, b) => b.rank - a.rank);

    const forecasts = {};
    const forecastTasks = [];
    if (hasGoogle) forecastTasks.push((async () => {
      try {
        const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(req.user);
        const series = await _gadsFetchDailySeries(accessToken, customerId, loginCustomerId, 30);
        if (series.length >= 3) forecasts.google = _computeForecast(series, 7);
      } catch (err) { console.warn('[intelligence/executive] Google forecast failed:', err.message); }
    })());
    if (hasMeta) forecastTasks.push((async () => {
      try {
        const { accessToken, accountId } = await _getMetaAccess(req.user);
        const series = await _metaFetchDailySeries(accessToken, accountId, 30);
        if (series.length >= 3) forecasts.meta = _computeForecast(series, 7);
      } catch (err) { console.warn('[intelligence/executive] Meta forecast failed:', err.message); }
    })());
    await Promise.all(forecastTasks);

    res.json({
      connected: true,
      healthScore, healthLabel,
      topOpportunities: pooled.slice(0, 3),
      warnings: warnings.slice(0, 5),
      forecasts,
      recommendedActions: pooled.slice(0, 3)
    });
  } catch (err) {
    console.error('[intelligence/executive]', err.message);
    res.status(500).json({ error: 'Could not load your executive summary right now.' });
  }
});

// ════════════════════════════════════════════════════════════════
// V7 Phase 1 â€” Business Brain
// Structured business knowledge (profile, products, audiences,
// competitors, memory) + a real backend read of brand_cores + a real
// website fetch â€” all wired into Context Engine V2 so nothing needs
// to be explained twice. No new analysis engine: reuses _aimlText,
// the existing brand_cores table, and the Tool Router's confirmation
// flow exactly as they already work.
// ════════════════════════════════════════════════════════════════

// â”€â”€ Backend brand read â”€â”€ mirrors auth.js's client-side loader (server.js
// has never read brand_cores before â€” it was written only from the
// browser). This is what lets server-side callers (chat, analyze, cron)
// see brand identity without the frontend having to pass it every time.
async function _getBrandCore(userId) {
  try {
    const { data } = await supabaseAdmin.from('brand_cores').select('brand_data').eq('user_id', userId).maybeSingle();
    return (data && data.brand_data) || null;
  } catch (err) {
    console.warn('[BusinessBrain] brand_cores read failed:', err.message);
    return null;
  }
}

// â”€â”€ Business Profile (one row per user) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/business/profile', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('business_profile').select('*').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    res.json({ profile: data || null });
  } catch (err) {
    console.error('[business/profile GET]', err.message);
    res.status(500).json({ error: 'Could not load your business profile.' });
  }
});

app.put('/api/business/profile', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const b = req.body || {};
    const row = {
      user_id: user.id,
      company_name: b.company_name || null, website: b.website || null, industry: b.industry || null,
      country: b.country || null, languages: Array.isArray(b.languages) ? b.languages : null,
      description: b.description || null, mission: b.mission || null, vision: b.vision || null,
      primary_goals: b.primary_goals || null, business_stage: b.business_stage || null,
      // Business Experience Redesign (Oriven 1.0) — Brand Voice chips.
      // `brand_voice` is a new column with no migration path available from
      // this environment; attempted opportunistically and dropped on error
      // so the rest of the profile still saves on databases that don't have
      // it yet (needs: ALTER TABLE business_profile ADD COLUMN brand_voice text[];).
      brand_voice: Array.isArray(b.brand_voice) ? b.brand_voice : null,
      updated_at: new Date().toISOString()
    };
    let { data, error } = await supabaseAdmin.from('business_profile').upsert(row, { onConflict: 'user_id' }).select().maybeSingle();
    if (error && /brand_voice/.test(error.message || '')) {
      delete row.brand_voice;
      ({ data, error } = await supabaseAdmin.from('business_profile').upsert(row, { onConflict: 'user_id' }).select().maybeSingle());
    }
    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    console.error('[business/profile PUT]', err.message);
    res.status(500).json({ error: 'Could not save your business profile.' });
  }
});

// â”€â”€ Settings Completion (Oriven 1.0) â”€â”€ user preferences (accent, theme,
// language, notification toggles, workspace name) as one JSONB blob on
// `profiles`, mirroring the existing localStorage shape 1:1 (settings.js
// SETTINGS_DEFAULTS) so the client can merge DB + local cache without a
// translation layer. `preferences` is a new column with no migration path
// available from this environment; every query degrades gracefully if it
// doesn't exist yet (needs: ALTER TABLE profiles ADD COLUMN preferences jsonb;) â”€â”€
app.get('/api/user/preferences', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('profiles').select('preferences').eq('id', user.id).maybeSingle();
    if (error && /preferences/.test(error.message || '')) {
      return res.json({ preferences: null, columnMissing: true });
    }
    if (error) throw error;
    res.json({ preferences: (data && data.preferences) || null });
  } catch (err) {
    console.error('[user/preferences GET]', err.message);
    res.status(500).json({ error: 'Could not load your preferences.' });
  }
});

app.put('/api/user/preferences', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const patch = req.body || {};
    // Merge onto whatever's already stored so a partial save (e.g. just
    // { accent: 'blue' }) never clobbers the rest of the user's preferences.
    // Supabase's query builder isn't a real Promise (no .catch()), so any
    // failure here — including the "preferences" column not existing yet —
    // has to be handled with a real try/catch around the await.
    let existing = null;
    try {
      const { data: existingData, error: existingErr } = await supabaseAdmin.from('profiles').select('preferences').eq('id', user.id).maybeSingle();
      if (!existingErr) existing = existingData;
    } catch (_) { /* treat as no existing preferences */ }
    const merged = Object.assign({}, (existing && existing.preferences) || {}, patch);
    // upsert (not update) — a user without a profiles row yet (edge case around
    // signup timing) would otherwise have this silently match zero rows and
    // report success while persisting nothing. Same pattern as /api/signup.
    const { data, error } = await supabaseAdmin.from('profiles').upsert({ id: user.id, preferences: merged }, { onConflict: 'id' }).select('preferences').maybeSingle();
    if (error && /preferences/.test(error.message || '')) {
      return res.json({ preferences: merged, columnMissing: true });
    }
    if (error) throw error;
    res.json({ preferences: (data && data.preferences) || merged });
  } catch (err) {
    console.error('[user/preferences PUT]', err.message);
    res.status(500).json({ error: 'Could not save your preferences.' });
  }
});

// â”€â”€ Generic CRUD for products / audiences / competitors â”€â”€ one
// implementation shared by all three instead of three near-identical
// route sets (Epic 15 / "no duplicate logic").
function _businessCrud(table, allowedFields) {
  return {
    async list(userId) {
      const { data, error } = await supabaseAdmin.from(table).select('*').eq('user_id', userId).order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async create(userId, body) {
      const row = { user_id: userId };
      allowedFields.forEach(f => { if (body[f] !== undefined) row[f] = body[f]; });
      const { data, error } = await supabaseAdmin.from(table).insert(row).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    async update(userId, id, body) {
      const row = {};
      allowedFields.forEach(f => { if (body[f] !== undefined) row[f] = body[f]; });
      row.updated_at = new Date().toISOString();
      const { data, error } = await supabaseAdmin.from(table).update(row).eq('id', id).eq('user_id', userId).select().maybeSingle();
      if (error) throw error;
      return data;
    },
    async remove(userId, id) {
      const { error } = await supabaseAdmin.from(table).delete().eq('id', id).eq('user_id', userId);
      if (error) throw error;
    }
  };
}

const _productsCrud    = _businessCrud('business_products',    ['name','category','description','benefits','features','price','target_audience','problem_solved','usp','landing_page','image_url','video_url','status']);
const _audiencesCrud   = _businessCrud('business_audiences',   ['name','age_range','location','language','pain_points','goals','objections','buying_triggers','budget','preferred_platforms','interests','behaviour']);
const _competitorsCrud = _businessCrud('business_competitors', ['company','website','strengths','weaknesses','pricing','positioning','visual_style','messaging','products']);

function _registerBusinessCrudRoutes(path, crud, label) {
  app.get('/api/business/' + path, async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      res.json({ items: await crud.list(user.id) });
    } catch (err) { console.error(`[business/${path} GET]`, err.message); res.status(500).json({ error: `Could not load your ${label}.` }); }
  });
  app.post('/api/business/' + path, async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      res.json({ item: await crud.create(user.id, req.body || {}) });
    } catch (err) { console.error(`[business/${path} POST]`, err.message); res.status(500).json({ error: 'Could not save that.' }); }
  });
  app.put('/api/business/' + path + '/:id', async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      const item = await crud.update(user.id, req.params.id, req.body || {});
      if (!item) return res.status(404).json({ error: 'Not found' });
      res.json({ item });
    } catch (err) { console.error(`[business/${path} PUT]`, err.message); res.status(500).json({ error: 'Could not save that.' }); }
  });
  app.delete('/api/business/' + path + '/:id', async (req, res) => {
    try {
      const user = await getUserFromToken(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      await crud.remove(user.id, req.params.id);
      res.json({ ok: true });
    } catch (err) { console.error(`[business/${path} DELETE]`, err.message); res.status(500).json({ error: 'Could not delete that.' }); }
  });
}
_registerBusinessCrudRoutes('products',    _productsCrud,    'products');
_registerBusinessCrudRoutes('audiences',   _audiencesCrud,   'audiences');
_registerBusinessCrudRoutes('competitors', _competitorsCrud, 'competitors');

// â”€â”€ Business Memory (Epic 6 "winning X" + Epic 9 "remember this") â”€â”€
// Append-mostly log, not full CRUD â€” list/create/delete cover the
// spec's "remember automatically, allow editing, allow deleting"
// (editing a remembered fact is delete + re-remember, kept simple
// deliberately rather than adding an update path for a log table).
app.get('/api/business/memory', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('business_memory').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ memory: data || [] });
  } catch (err) {
    console.error('[business/memory GET]', err.message);
    res.status(500).json({ error: 'Could not load your memory.' });
  }
});

app.post('/api/business/memory', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const b = req.body || {};
    if (!b.content) return res.status(400).json({ error: 'content is required' });
    const row = { user_id: user.id, type: b.type || 'fact', content: b.content, source: b.source || 'manual', related_campaign: b.related_campaign || null };
    const { data, error } = await supabaseAdmin.from('business_memory').insert(row).select().maybeSingle();
    if (error) throw error;
    res.json({ memory: data });
  } catch (err) {
    console.error('[business/memory POST]', err.message);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

app.delete('/api/business/memory/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { error } = await supabaseAdmin.from('business_memory').delete().eq('id', req.params.id).eq('user_id', user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[business/memory DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete that.' });
  }
});

// â”€â”€ Website Understanding (Epic 7) â€” a REAL fetch, not URL-only AI
// speculation like /api/website-monitor does today. No new dependency:
// plain fetch + regex-based text extraction.
async function _fetchWebsiteText(url) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 10000);
  let html;
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrivenBot/1.0)' } });
    html = await r.text();
  } finally {
    clearTimeout(tid);
  }

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch  = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const navLinks   = Array.from(html.matchAll(/<a[^>]+href=["'][^"']+["'][^>]*>([^<]{2,40})<\/a>/gi)).slice(0, 30).map(m => m[1].trim()).filter(Boolean);

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  return { title: titleMatch ? titleMatch[1].trim() : '', description: descMatch ? descMatch[1].trim() : '', navLinks, text };
}

// Meaningfully different = the AI's fresh read of the site disagrees with what's
// stored, not just whitespace/punctuation noise — good enough for "ask before
// overwriting" without needing a fuzzy-diff library.
function _websiteChanged(prev, next) {
  if (!prev) return false; // nothing stored yet — first analysis, nothing to ask about
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return ['products', 'services', 'ctas', 'positioning', 'tone'].some(f => norm(prev[f]) !== norm(next[f]));
}

app.post('/api/business/website/refresh', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    let url = (req.body && req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const { data: existing } = await supabaseAdmin.from('business_website_knowledge').select('*').eq('user_id', user.id).maybeSingle();

    let reservation;
    try {
      reservation = await creditManager.reserveCredits(user, 'website_analysis');
    } catch (err) {
      if (err instanceof creditManager.InsufficientCreditsError) return res.status(402).json({ error: 'Out of credits', code: 'CREDITS_EXHAUSTED', balance: err.balance });
      console.warn('[business/website/refresh] Credit reservation error:', err.message);
    }

    const page = await _fetchWebsiteText(url);

    const system = `You are a business analyst. Analyze this REAL website content (already fetched, not guessed) and return ONLY valid JSON, no markdown, no code fences: { "products": "short summary of products/services offered", "services": "short summary", "ctas": "main calls to action seen on the page", "positioning": "how the brand positions itself", "tone": "the tone/voice of the copy" }`;
    const userMsg = `URL: ${url}\nTitle: ${page.title}\nMeta description: ${page.description}\nNav/link labels: ${page.navLinks.join(', ')}\n\nPage text (excerpt):\n${page.text}`;
    const raw = await _aimlText('website-intel', system, userMsg, { max_tokens: 700 });
    if (reservation) creditManager.finalizeCreditLog(reservation, 'website_analysis', { provider: 'aiml', success: true, route: req.path }).catch(() => {});
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed = {};
    try { parsed = JSON.parse(cleaned); } catch (_) { console.warn('[business/website/refresh] AI response unparseable, storing fetch-only result'); }

    const row = {
      user_id: user.id, url,
      products: parsed.products || null, services: parsed.services || null,
      ctas: parsed.ctas || null, positioning: parsed.positioning || null, tone: parsed.tone || null,
      analyzed_at: new Date().toISOString()
    };

    if (existing && existing.url === url && _websiteChanged(existing, row)) {
      await supabaseAdmin.from('intelligence_events').insert({
        user_id: user.id, platform: null, type: 'website_change',
        title: 'Your website content has changed',
        detail: 'Oriven noticed changes on your website since it last analyzed it — review before updating your Business Brain.',
        message: 'We noticed changes on your website — update your Business Brain with the new content?'
      });
      return res.json({ changed: true, previous: existing, proposed: row });
    }

    const { data, error } = await supabaseAdmin.from('business_website_knowledge').upsert(row, { onConflict: 'user_id' }).select().maybeSingle();
    if (error) throw error;
    res.json({ website: data, changed: false });
  } catch (err) {
    console.error('[business/website/refresh]', err.message);
    res.status(500).json({ error: 'Could not analyze that website right now.' });
  }
});

app.post('/api/business/website/confirm-update', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const proposed = req.body && req.body.proposed;
    if (!proposed || !proposed.url) return res.status(400).json({ error: 'proposed is required' });

    const row = {
      user_id: user.id, url: proposed.url,
      products: proposed.products || null, services: proposed.services || null,
      ctas: proposed.ctas || null, positioning: proposed.positioning || null, tone: proposed.tone || null,
      analyzed_at: new Date().toISOString()
    };
    const { data, error } = await supabaseAdmin.from('business_website_knowledge').upsert(row, { onConflict: 'user_id' }).select().maybeSingle();
    if (error) throw error;
    res.json({ website: data });
  } catch (err) {
    console.error('[business/website/confirm-update]', err.message);
    res.status(500).json({ error: 'Could not update your Business Brain.' });
  }
});

app.get('/api/business/website', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { data, error } = await supabaseAdmin.from('business_website_knowledge').select('*').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    res.json({ website: data || null });
  } catch (err) {
    console.error('[business/website GET]', err.message);
    res.status(500).json({ error: 'Could not load your website knowledge.' });
  }
});

// â”€â”€ Context Engine V2 (Epic 11/12) â”€â”€ the actual "never repeat
// yourself" mechanism. One compact text block, pulled into every AI
// call that has a user â€” same style as _buildBrandSection (server.js:624).
async function _gatherBusinessContext(userId) {
  try {
    const [profileRes, productsRes, audiencesRes, competitorsRes, brandCore, websiteRes, memoryRes, learningsRes] = await Promise.all([
      supabaseAdmin.from('business_profile').select('*').eq('user_id', userId).maybeSingle(),
      supabaseAdmin.from('business_products').select('name,category,usp,target_audience').eq('user_id', userId).order('created_at', { ascending: false }).limit(8),
      supabaseAdmin.from('business_audiences').select('name,pain_points,goals').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('business_competitors').select('company,positioning').eq('user_id', userId).order('created_at', { ascending: false }).limit(3),
      _getBrandCore(userId),
      supabaseAdmin.from('business_website_knowledge').select('products,services,positioning,tone').eq('user_id', userId).maybeSingle(),
      supabaseAdmin.from('business_memory').select('content,type').eq('user_id', userId).order('created_at', { ascending: false }).limit(5),
      supabaseAdmin.from('business_learnings').select('pattern,confidence').eq('user_id', userId).eq('status', 'active').order('confidence', { ascending: false }).limit(5)
    ]);

    const profile     = profileRes.data;
    const products     = productsRes.data || [];
    const audiences    = audiencesRes.data || [];
    const competitors  = competitorsRes.data || [];
    const website      = websiteRes.data;
    const memory       = memoryRes.data || [];
    const learnings    = learningsRes.data || [];

    const lines = [];
    const sources = [];
    if (profile) {
      if (profile.company_name) { lines.push(`Company: ${profile.company_name}${profile.industry ? ' (' + profile.industry + ')' : ''}`); sources.push('Business profile'); }
      if (profile.description)  lines.push(`About: ${profile.description}`);
      if (profile.business_stage) lines.push(`Stage: ${profile.business_stage}`);
      if (profile.primary_goals) lines.push(`Goals: ${profile.primary_goals}`);
    }
    if (brandCore) {
      let usedBrand = false;
      if (brandCore.toneOfVoice) { lines.push(`Brand tone of voice: ${brandCore.toneOfVoice}`); usedBrand = true; }
      if (brandCore.usp)         { lines.push(`Brand USP: ${brandCore.usp}`); usedBrand = true; }
      if (brandCore.wordsAvoid)  { lines.push(`Words to avoid: ${Array.isArray(brandCore.wordsAvoid) ? brandCore.wordsAvoid.join(', ') : brandCore.wordsAvoid}`); usedBrand = true; }
      if (usedBrand) sources.push('Brand voice');
    }
    if (products.length)  { lines.push(`Products: ${products.map(p => p.name + (p.usp ? ' (' + p.usp + ')' : '')).join('; ')}`); products.forEach(p => sources.push(`Product: ${p.name}`)); }
    if (audiences.length) { lines.push(`Target audiences: ${audiences.map(a => a.name).join(', ')}`); audiences.forEach(a => sources.push(`Audience: ${a.name}`)); }
    if (competitors.length) { lines.push(`Known competitors: ${competitors.map(c => c.company + (c.positioning ? ' (' + c.positioning + ')' : '')).join('; ')}`); competitors.forEach(c => sources.push(`Competitor: ${c.company}`)); }
    if (website && (website.products || website.services || website.positioning || website.tone)) {
      lines.push(`Website analysis: ${[website.products, website.services, website.positioning, website.tone].filter(Boolean).join(' | ')}`);
      sources.push('Website knowledge');
    }
    if (memory.length) { lines.push(`Remembered: ${memory.map(m => m.content).join('; ')}`); sources.push(`${memory.length} remembered fact${memory.length === 1 ? '' : 's'}`); }
    if (learnings.length) { lines.push(`What Oriven has learned from real performance: ${learnings.map(l => `${l.pattern} (${l.confidence}% confidence)`).join('; ')}`); sources.push(`${learnings.length} learned pattern${learnings.length === 1 ? '' : 's'}`); }

    return lines.length ? { text: lines.join('\n'), sources } : null;
  } catch (err) {
    console.warn('[BusinessBrain] context gather failed:', err.message);
    return null;
  }
}

// â”€â”€ Business Health (Epic 13) â€” deterministic completeness scoring,
// same spirit as V6's Marketing Health, no AI involved.
function _fieldFillRatio(obj, fields) {
  if (!obj) return 0;
  const filled = fields.filter(f => obj[f] !== null && obj[f] !== undefined && String(obj[f]).trim() !== '').length;
  return Math.round((filled / fields.length) * 100);
}

async function _computeBusinessHealth(userId) {
  const [profileRes, productsRes, audiencesRes, competitorsRes, brandCore, websiteRes, learningsRes] = await Promise.all([
    supabaseAdmin.from('business_profile').select('*').eq('user_id', userId).maybeSingle(),
    supabaseAdmin.from('business_products').select('id').eq('user_id', userId),
    supabaseAdmin.from('business_audiences').select('id').eq('user_id', userId),
    supabaseAdmin.from('business_competitors').select('id').eq('user_id', userId),
    _getBrandCore(userId),
    supabaseAdmin.from('business_website_knowledge').select('user_id').eq('user_id', userId).maybeSingle(),
    supabaseAdmin.from('business_learnings').select('entity_type,entity_name,category,pattern,confidence').eq('user_id', userId).eq('status', 'active').gte('confidence', 70)
  ]);

  const profileScore    = _fieldFillRatio(profileRes.data, ['company_name','website','industry','country','description','mission','vision','primary_goals','business_stage']);
  const productsScore   = Math.min(100, (productsRes.data || []).length * 25);
  const audienceScore   = Math.min(100, (audiencesRes.data || []).length * 34);
  const competitorScore = Math.min(100, (competitorsRes.data || []).length * 34);
  const brandScore      = _fieldFillRatio(brandCore, ['name','toneOfVoice','usp','audience','story','colors']);
  const websiteScore    = websiteRes.data ? 100 : 0;
  const overall = Math.round((profileScore + productsScore + audienceScore + competitorScore + brandScore + websiteScore) / 6);

  // V7 Phase 2 (Epic 7/11) â€” deterministic, template-based recommendations
  // straight off the category scores above. No AI judgment calls here: these
  // are "you have 0 of X saved" facts, not opinions.
  const recommendations = [];
  if (profileScore < 60) recommendations.push({ severity: profileScore < 30 ? 'high' : 'medium', title: 'Complete your business profile', detail: 'Fill in the missing fields on the Business tab so Oriven understands your company.', tab: 'business', message: 'Help me fill out my business profile — ask me what you need to know.' });
  if (productsScore < 50) recommendations.push({ severity: productsScore === 0 ? 'high' : 'medium', title: 'Add another product', detail: 'The more products Oriven knows, the less it has to ask when generating campaigns.', tab: 'products', message: 'Help me add a product to my Business Brain — ask me about it.' });
  if (audienceScore < 50) recommendations.push({ severity: audienceScore === 0 ? 'high' : 'medium', title: 'Add a target audience', detail: 'Saved audiences let Oriven target the right people automatically.', tab: 'audiences', message: 'Help me define a target audience for my business — ask me about it.' });
  if (competitorScore < 50) recommendations.push({ severity: 'low', title: 'Add a competitor', detail: 'Competitor context sharpens positioning advice — Oriven never copies it, only compares against it.', tab: 'competitors', message: 'Help me think through who my real competitors are.' });
  if (brandScore < 60) recommendations.push({ severity: 'medium', title: 'Finish your brand voice', detail: 'Tone of voice, USP, and words to avoid keep every generated ad on-brand.', tab: 'business', message: 'Help me define my brand voice — ask me about tone, USP, and words to avoid.' });
  if (websiteScore === 0) recommendations.push({ severity: 'high', title: 'Connect your website', detail: 'Add your website URL so Oriven can learn your real products, offers, and tone directly from it.', tab: 'website', message: 'How do I connect my website to my Business Brain?' });

  // V7 Final Phase (Epic 12) â€” Self Improvement. Once a real, high-confidence
  // learning exists, surface it as a concrete next step â€” same card shape,
  // no new UI. Only messaging/positioning-relevant categories apply here
  // (performance learnings like "winning campaign" are informational, not
  // an action for the user to take).
  const ACTIONABLE_LEARNING_CATEGORIES = { winning_messaging: 'USP', creative_pattern: 'ad copy', winning_cta: 'CTA', winning_headline: 'headlines', winning_landing_page: 'landing page' };
  (learningsRes.data || []).filter(l => ACTIONABLE_LEARNING_CATEGORIES[l.category]).slice(0, 2).forEach(l => {
    recommendations.push({
      severity: 'low',
      title: `Consider updating your ${ACTIONABLE_LEARNING_CATEGORIES[l.category]}`,
      detail: `${l.pattern} (${l.confidence}% confidence).`,
      message: `Based on what you've learned — "${l.pattern}" — help me update my ${ACTIONABLE_LEARNING_CATEGORIES[l.category]} to match.`
    });
  });

  return {
    overall,
    categories: {
      businessProfile: profileScore, products: productsScore, audienceKnowledge: audienceScore,
      competitorKnowledge: competitorScore, brandCompleteness: brandScore, websiteUnderstanding: websiteScore
    },
    recommendations
  };
}

app.get('/api/business/health', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    res.json(await _computeBusinessHealth(user.id));
  } catch (err) {
    console.error('[business/health]', err.message);
    res.status(500).json({ error: 'Could not compute your business health right now.' });
  }
});

// â”€â”€ Knowledge Validation (Epic 8) â€” deterministic staleness check plus a
// capped, parallel HEAD-request pass against saved landing pages. Opt-in
// (own route, not folded into /health) since the HEAD requests add real
// network latency this isn't worth paying on every page load.
async function _headOk(url) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrivenBot/1.0)' } });
    return r.ok || (r.status >= 300 && r.status < 400);
  } catch (_) {
    return false;
  } finally {
    clearTimeout(tid);
  }
}

async function _validateBusinessKnowledge(userId) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const [productsRes, competitorsRes] = await Promise.all([
    supabaseAdmin.from('business_products').select('id,name,landing_page,updated_at,created_at').eq('user_id', userId),
    supabaseAdmin.from('business_competitors').select('id,company,updated_at,created_at').eq('user_id', userId)
  ]);
  const products = productsRes.data || [];
  const competitors = competitorsRes.data || [];
  const findings = [];

  products.forEach(p => {
    const last = p.updated_at || p.created_at;
    if (last && last < ninetyDaysAgo) findings.push({ severity: 'low', type: 'stale', title: `"${p.name}" hasn't been reviewed in 90+ days`, detail: 'Check it still reflects your current offer.', tab: 'products', message: `Help me review whether "${p.name}" still reflects our current offer.` });
  });
  competitors.forEach(c => {
    const last = c.updated_at || c.created_at;
    if (last && last < ninetyDaysAgo) findings.push({ severity: 'low', type: 'stale', title: `"${c.company}" hasn't been reviewed in 90+ days`, detail: 'Competitor positioning may have changed since this was saved.', tab: 'competitors', message: `Help me review whether "${c.company}" is still a relevant competitor.` });
  });

  const withLinks = products.filter(p => p.landing_page).slice(0, 5);
  const linkChecks = await Promise.all(withLinks.map(async p => ({ p, ok: await _headOk(p.landing_page) })));
  linkChecks.forEach(({ p, ok }) => {
    if (!ok) findings.push({ severity: 'medium', type: 'broken_link', title: `Landing page for "${p.name}" may be broken`, detail: p.landing_page, tab: 'products', message: `The landing page for "${p.name}" (${p.landing_page}) may be broken — remind me to check it.` });
  });

  return { findings, checkedLinks: withLinks.length };
}

app.get('/api/business/validate', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    res.json(await _validateBusinessKnowledge(user.id));
  } catch (err) {
    console.error('[business/validate]', err.message);
    res.status(500).json({ error: 'Could not validate your business knowledge right now.' });
  }
});

// â”€â”€ Business Insights (Epic 9/10) â€” narrative insights connecting stored
// business knowledge to REAL platform performance. Both inputs already
// exist (_gatherBusinessContext, _gatherPlatformIntelligence from V6) â€”
// this route only combines and narrates them, no new data-fetching.
// Knowledge Relationships (Epic 10) are soft/heuristic here: simple
// name-matching between real campaign names and stored products, not a
// schema relationship â€” marketing data lives on the ad platforms, not in
// our DB, so a literal foreign key isn't expressible.
app.get('/api/business/insights', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const [bizCtx, platformIntel, productsRes] = await Promise.all([
      _gatherBusinessContext(user.id),
      _gatherPlatformIntelligence(user, 7),
      supabaseAdmin.from('business_products').select('name').eq('user_id', user.id)
    ]);

    if (!bizCtx) return res.json({ insights: [], relationships: [], note: 'Add some business knowledge first — products, audiences, or a website — for Oriven to draw insights from.' });

    const productNames = (productsRes.data || []).map(p => p.name).filter(Boolean);
    const relationships = [];
    ['google', 'meta'].forEach(platform => {
      const p = platformIntel.platforms[platform];
      if (!p || p.error || !Array.isArray(p.campaigns)) return;
      p.campaigns.forEach(c => {
        const match = productNames.find(name => c.name && name && c.name.toLowerCase().includes(name.toLowerCase()));
        if (match) relationships.push({ campaign: c.name, product: match, platform });
      });
    });

    const perfLines = [];
    ['google', 'meta'].forEach(platform => {
      const p = platformIntel.platforms[platform];
      if (!p || p.error) return;
      perfLines.push(`${platform === 'google' ? 'Google Ads' : 'Meta Ads'} (7 days): score ${p.score}, ${(p.campaigns || []).length} campaigns, delta: ${JSON.stringify(p.delta || {})}`);
    });

    if (!perfLines.length) {
      return res.json({ insights: [], relationships, note: 'Connect Google or Meta Ads for Oriven to connect your business knowledge to real performance.' });
    }

    const system = `You are a marketing analyst. Given a business's stored knowledge and its REAL recent ad performance (already fetched, not guessed), produce up to 4 short narrative insights connecting the two — e.g. which product/audience seems to be working on which platform. Reply ONLY with valid JSON, no markdown: { "insights": [{"title":"...","detail":"..."}] }. Ground every claim in the real data given; never invent numbers.`;
    const userMsg = `BUSINESS KNOWLEDGE:\n${bizCtx.text}\n\nRECENT PERFORMANCE:\n${perfLines.join('\n')}${relationships.length ? `\n\nLIKELY CAMPAIGN-PRODUCT LINKS (name-matched, not certain): ${relationships.map(r => `"${r.campaign}" ~ "${r.product}"`).join(', ')}` : ''}`;
    const raw = await _aimlText('business-insights', system, userMsg, { max_tokens: 700 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed = { insights: [] };
    try { parsed = JSON.parse(cleaned); } catch (_) { console.warn('[business/insights] AI response unparseable'); }

    res.json({ insights: parsed.insights || [], relationships });
  } catch (err) {
    console.error('[business/insights]', err.message);
    res.status(500).json({ error: 'Could not generate business insights right now.' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V7 Final Phase â€” Business Learning Engine. One table (business_learnings)
// holds every pattern Oriven discovers from real performance â€” who/what it's
// about, the human-readable pattern, and a confidence score from the SAME
// _calcConfidence formula used everywhere else (never AI-guessed). Writes
// happen automatically from _runLearningEngine (below, called from the
// existing 4-hour monitoring cron) â€” unlike business_memory, these are
// Oriven's own derived analysis of real numbers, not user-stated facts, so
// they don't need a confirmation card; they're just always visible and
// removable (DELETE route below).
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// One reusable read path â€” every route below (insights, dashboard, timeline,
// graph) filters/sorts this instead of re-deriving its own query.
async function _fetchActiveLearnings(userId, opts) {
  opts = opts || {};
  let q = supabaseAdmin.from('business_learnings').select('*').eq('user_id', userId).eq('status', 'active');
  if (opts.entity_type) q = q.eq('entity_type', opts.entity_type);
  if (opts.entity_name) q = q.eq('entity_name', opts.entity_name);
  q = q.order('confidence', { ascending: false }).limit(opts.limit || 200);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

function _groupLearningsByMonth(learnings) {
  const byMonth = {};
  learnings.forEach(l => {
    const month = String(l.created_at || '').slice(0, 7); // YYYY-MM
    if (!month) return;
    (byMonth[month] = byMonth[month] || []).push(l);
  });
  return Object.keys(byMonth).sort().reverse().map(month => ({ month, learnings: byMonth[month] }));
}

async function _upsertLearning(userId, row) {
  const payload = Object.assign({ user_id: userId, status: 'active', source: 'auto' }, row);
  const { error } = await supabaseAdmin.from('business_learnings').upsert(payload, { onConflict: 'user_id,entity_type,entity_name,category' });
  if (error) console.warn('[LearningEngine] upsert failed:', error.message);
}

app.get('/api/business/learnings', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { entity_type, entity_name, status } = req.query || {};
    let q = supabaseAdmin.from('business_learnings').select('*').eq('user_id', user.id).eq('status', status === 'archived' ? 'archived' : 'active');
    if (entity_type) q = q.eq('entity_type', entity_type);
    if (entity_name) q = q.eq('entity_name', entity_name);
    q = q.order('confidence', { ascending: false }).limit(100);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ learnings: data || [] });
  } catch (err) {
    console.error('[business/learnings GET]', err.message);
    res.status(500).json({ error: 'Could not load your learnings.' });
  }
});

app.delete('/api/business/learnings/:id', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const { error } = await supabaseAdmin.from('business_learnings').delete().eq('id', req.params.id).eq('user_id', user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[business/learnings DELETE]', err.message);
    res.status(500).json({ error: 'Could not remove that learning.' });
  }
});

// â”€â”€ Learning Timeline (Epic 8) â”€â”€ "what Oriven learned, by month" â”€ a
// straight grouping of what the learning engine already writes.
app.get('/api/business/timeline', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const learnings = await _fetchActiveLearnings(user.id, { limit: 500 });
    learnings.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ timeline: _groupLearningsByMonth(learnings) });
  } catch (err) {
    console.error('[business/timeline]', err.message);
    res.status(500).json({ error: 'Could not load your learning timeline.' });
  }
});

// â”€â”€ Knowledge Graph (Epic 7) â”€â”€ heuristic name-matching, same soft-linking
// approach as /api/business/insights' relationships block â€” not a schema
// relationship or graph database, since marketing data lives on the ad
// platforms, not this DB.
app.get('/api/business/graph', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const [productsRes, audiencesRes, competitorsRes, learnings] = await Promise.all([
      supabaseAdmin.from('business_products').select('id,name').eq('user_id', user.id),
      supabaseAdmin.from('business_audiences').select('id,name').eq('user_id', user.id),
      supabaseAdmin.from('business_competitors').select('id,company').eq('user_id', user.id),
      _fetchActiveLearnings(user.id, { limit: 300 })
    ]);

    const products = productsRes.data || [];
    const audiences = audiencesRes.data || [];
    const competitors = competitorsRes.data || [];

    const nodes = [];
    products.forEach(p => nodes.push({ id: 'product:' + p.id, type: 'product', label: p.name }));
    audiences.forEach(a => nodes.push({ id: 'audience:' + a.id, type: 'audience', label: a.name }));
    competitors.forEach(c => nodes.push({ id: 'competitor:' + c.id, type: 'competitor', label: c.company }));

    const edges = [];
    learnings.filter(l => l.entity_type === 'campaign' || l.entity_type === 'creative').forEach(l => {
      const name = (l.entity_name || '').toLowerCase();
      const matchedProduct = products.find(p => p.name && name.includes(p.name.toLowerCase()));
      const matchedAudience = audiences.find(a => a.name && name.includes(a.name.toLowerCase()));
      if (matchedProduct) edges.push({ from: 'product:' + matchedProduct.id, to: 'learning:' + l.id, label: l.category, confidence: l.confidence });
      if (matchedAudience) edges.push({ from: 'audience:' + matchedAudience.id, to: 'learning:' + l.id, label: l.category, confidence: l.confidence });
      if (matchedProduct && matchedAudience) edges.push({ from: 'product:' + matchedProduct.id, to: 'audience:' + matchedAudience.id, label: 'co-occurs in "' + l.entity_name + '"', confidence: l.confidence });
      if (matchedProduct || matchedAudience) nodes.push({ id: 'learning:' + l.id, type: 'learning', label: l.pattern });
    });

    res.json({ nodes, edges });
  } catch (err) {
    console.error('[business/graph]', err.message);
    res.status(500).json({ error: 'Could not build your knowledge graph.' });
  }
});

// â”€â”€ AI Reflection (Epic 9) â”€â”€ generated on demand, never stored â€” same
// pattern as daily-brief/business-insights: real computed data in, AI only
// narrates it.
app.get('/api/business/reflection', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const VALID_PERIODS = ['weekly', 'monthly', 'quarterly', 'daily_morning', 'daily_midday', 'daily_evening'];
    const period = VALID_PERIODS.includes(req.query.period) ? req.query.period : 'weekly';
    // V9 (Epic 10) â€” daily periods reuse the exact same mechanism as
    // weekly/monthly/quarterly, just a 1-day window and different framing.
    const days = { weekly: 7, monthly: 30, quarterly: 90, daily_morning: 1, daily_midday: 1, daily_evening: 1 }[period];
    const periodFraming = {
      daily_morning: 'a morning brief â€” set priorities for the day ahead',
      daily_midday: 'a midday update â€” what has changed since this morning',
      daily_evening: 'an evening summary â€” what happened today and what to carry into tomorrow'
    }[period] || `a ${period} reflection`;

    const [learnings, platformIntel] = await Promise.all([
      _fetchActiveLearnings(user.id, { limit: 30 }),
      _gatherPlatformIntelligence(user, days)
    ]);

    if (!learnings.length) return res.json({ reflection: null, note: 'Not enough learning history yet â€” check back once Oriven has observed some campaign performance.' });

    const learningLines = learnings.map(l => `${l.entity_type} "${l.entity_name}": ${l.pattern} (${l.confidence}% confidence, based on ${JSON.stringify(l.evidence || {})})`).join('\n');
    const perfLines = ['google', 'meta'].map(platform => {
      const p = platformIntel.platforms[platform];
      if (!p || p.error) return null;
      return `${platform === 'google' ? 'Google Ads' : 'Meta Ads'} (${days} day(s)): score ${p.score}, delta: ${JSON.stringify(p.delta || {})}`;
    }).filter(Boolean).join('\n');

    const system = `You are a marketing strategist writing ${periodFraming} for a business you advise. Given real accumulated learnings and real recent performance (already computed, not guessed), write a short reflection: what was learned, what's still true, and one concrete recommendation for next period. Reply ONLY with valid JSON, no markdown: { "learned": ["...","..."], "recommendation": "..." }. Ground every statement in the data given; never invent numbers or claims not supported by it.`;
    const userMsg = `PERIOD: ${period}\n\nACCUMULATED LEARNINGS:\n${learningLines}${perfLines ? `\n\nRECENT PERFORMANCE:\n${perfLines}` : ''}`;
    const raw = await _aimlText('business-reflection', system, userMsg, { max_tokens: 700 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed = { learned: [], recommendation: '' };
    try { parsed = JSON.parse(cleaned); } catch (_) { console.warn('[business/reflection] AI response unparseable'); }

    res.json({ reflection: parsed, period });
  } catch (err) {
    console.error('[business/reflection]', err.message);
    res.status(500).json({ error: 'Could not generate a reflection right now.' });
  }
});

// â”€â”€ Business Learning Stats + Dashboard (Epic 13) â”€â”€ composes
// _computeBusinessHealth (Phase 2) rather than re-deriving completeness.
async function _computeLearningStats(userId) {
  const [activeRes, recentRes] = await Promise.all([
    supabaseAdmin.from('business_learnings').select('confidence,entity_type,entity_name').eq('user_id', userId).eq('status', 'active'),
    supabaseAdmin.from('business_learnings').select('id').eq('user_id', userId).eq('status', 'active').gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
  ]);
  const active = activeRes.data || [];
  const productsLearned = new Set(active.filter(l => l.entity_type === 'product').map(l => l.entity_name)).size;
  const avgConfidence = active.length ? Math.round(active.reduce((s, l) => s + (l.confidence || 0), 0) / active.length) : 0;
  return {
    activeLearnings: active.length,
    productsLearned,
    avgConfidence,
    learnedLast30Days: (recentRes.data || []).length
  };
}

app.get('/api/business/dashboard', async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const [health, learningStats, pool] = await Promise.all([
      _computeBusinessHealth(user.id),
      _computeLearningStats(user.id),
      _fetchActiveLearnings(user.id, { limit: 100 })
    ]);
    const byRecency = pool.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const timeline = _groupLearningsByMonth(byRecency).slice(0, 3);

    res.json({ health, learning: learningStats, recentLearnings: byRecency.slice(0, 5), timeline });
  } catch (err) {
    console.error('[business/dashboard]', err.message);
    res.status(500).json({ error: 'Could not load your Business Brain dashboard.' });
  }
});

// GET /api/google/diag â€” non-destructive diagnostic: token state + dev token presence
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

// GET /api/debug/routes â€” list all registered Express routes
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

// â”€â”€ Fallback â€” after all routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// /api/* and /auth/* are backend-only paths â€” return JSON 404 so callers
// get parseable JSON instead of an HTML error page.
// All other paths redirect to /app (new UI served by this backend on Render,
// or served directly from disk in local dev).
app.use(function(req, res) {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    console.warn('[404]', req.method, req.url);
    return res.status(404).json({ error: 'Route not found: ' + req.method + ' ' + req.url });
  }

  // On Render: unknown paths redirect to the app.
  // In local dev: serve the file from the repo root if it exists.
  if (process.env.RENDER) {
    return res.redirect(302, FRONTEND_URL + '/app');
  }

  // Local dev fallback â€” serve the requested file; 404 cleanly if missing.
  var filePath = path.resolve(__dirname, '..', '..', req.path === '/' ? 'index.html' : req.path.replace(/^\//, ''));
  res.sendFile(filePath, function(err) {
    if (err) {
      res.status(404).send('Not found');
    }
  });
});

// â”€â”€ Global error handler â€” catches unhandled errors in routes â”€â”€â”€
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

// â”€â”€ Daily cron: delete unverified accounts older than 14 days â”€â”€â”€
// Runs at 02:00 UTC every day. Safe to re-run â€” only targets accounts
// where email_verified = false AND created_at < 14 days ago.
cron.schedule('0 2 * * *', async () => {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[Cron] Cleanup run â€” cutoff: ${cutoff}`);
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

// -- Nightly credit-cycle safety net -- invoice.payment_succeeded (the
// webhook handler above) is the primary reset mechanism; this catches any
// user whose reset was missed (failed webhook delivery, etc.). Advances
// credits_cycle_end by the plan's period length added to the OLD
// credits_cycle_end (not to now()), so a delayed cron run doesn't drift the
// billing anchor day forward.
cron.schedule('0 3 * * *', async () => {
  try {
    const { data: overdue, error } = await supabaseAdmin.from('profiles')
      .select('id, subscription_status, credits_cycle_end')
      .in('subscription_status', ['starter', 'creator', 'professional'])
      .lt('credits_cycle_end', new Date().toISOString());
    if (error) { console.error('[CreditReset] Query error:', error.message); return; }
    if (!overdue || !overdue.length) { console.log('[CreditReset] No overdue credit cycles'); return; }
    console.log(`[CreditReset] Resetting ${overdue.length} overdue credit cycle(s)`);
    for (const row of overdue) {
      const allowance = creditManager.PLAN_ALLOWANCES[row.subscription_status];
      if (allowance == null) continue;
      const oldEnd = row.credits_cycle_end ? new Date(row.credits_cycle_end) : new Date();
      const nextEnd = new Date(oldEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
      await supabaseAdmin.from('profiles').update({
        credits_balance: allowance,
        credits_cycle_start: oldEnd.toISOString(),
        credits_cycle_end: nextEnd.toISOString(),
        credits_last_reset_source: 'fallback_cron',
      }).eq('id', row.id);
    }
  } catch (err) {
    console.error('[CreditReset] Unexpected error:', err.message);
  }
}, { timezone: 'UTC' });

// ── V6 Final Phase â€” Continuous Monitoring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Runs _analyzeGoogleAccount / _analyzeMetaAccount for every connected user
// every 4 hours â€” the SAME analysis functions the on-demand routes use, no
// new analysis logic. Only inserts a finding/recommendation into the event
// log if it wasn't already logged for that user+platform in the last 24h,
// which is what makes this "detect changes" instead of spamming the same
// condition six times a day.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V7 Final Phase â€” Business Learning Engine (Epic 1). Called once per
// platform, per monitoring cycle, from _monitorPlatform below â€” reuses the
// exact same `analysis` object (real campaigns/creatives, already scored by
// _campaignPriority and the CTR-percentile classifier), no separate data
// pull. Writes to business_learnings are silent/automatic: these are
// Oriven's own derived observations from real numbers, not user-stated
// facts, so unlike business_memory they don't go through a confirmation
// card â€” just always visible on the Business Brain and removable.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const PLATFORM_LABEL = { google: 'Google Ads', meta: 'Meta Ads' };

// Epic 4 â€” Creative DNA, honestly scoped to real text. Google's creative
// `.name` is the actual headline text (server.js, pulled from
// responsiveSearchAd headlines) so lexical patterns are genuinely
// calculated, not guessed; Meta's `.name` is an internal ad title rather
// than displayed copy, so this only runs for Google.
function _detectHeadlinePatterns(creatives) {
  const withData = (creatives || []).filter(c => c.impressions >= 100 && c.name);
  const short = withData.filter(c => c.name.trim().split(/\s+/).length <= 5);
  const long  = withData.filter(c => c.name.trim().split(/\s+/).length > 5);
  if (short.length < 3 || long.length < 3) return [];
  const shortCtr = _avg(short, 'ctr'), longCtr = _avg(long, 'ctr');
  if (!shortCtr || !longCtr) return [];
  const gap = (shortCtr - longCtr) / Math.max(shortCtr, longCtr);
  if (Math.abs(gap) < 0.2) return [];
  const winner = gap > 0 ? short : long;
  const label = gap > 0 ? 'Shorter headlines (5 words or fewer)' : 'Longer, more descriptive headlines';
  const clicks = winner.reduce((s, c) => s + c.clicks, 0);
  const conversions = winner.reduce((s, c) => s + c.conversions, 0);
  return [{
    entity_type: 'headline', entity_name: gap > 0 ? 'short_headlines' : 'long_headlines', category: 'creative_pattern',
    pattern: `${label} outperform the alternative by ${Math.round(Math.abs(gap) * 100)}% CTR across your Google ads`,
    confidence: _calcConfidence({ clicks, conversions, days: 7 }),
    evidence: { campaigns: winner.length, clicks, conversions, days: 7 }
  }];
}

// Simple, deterministic keyword classification of REAL headline text â€” not
// AI guessing a style from nothing.
function _classifyMessaging(text) {
  const t = (text || '').toLowerCase();
  const discountWords = ['% off', 'sale', 'discount', 'free', 'save', 'deal', 'cheap', 'clearance'];
  const premiumWords  = ['premium', 'exclusive', 'luxury', 'elevate', 'finest', 'crafted', 'bespoke'];
  const hasDiscount = discountWords.some(w => t.includes(w));
  const hasPremium  = premiumWords.some(w => t.includes(w));
  if (hasDiscount && !hasPremium) return 'discount';
  if (hasPremium && !hasDiscount) return 'premium';
  return null;
}

async function _runLearningEngine(user, platform, analysis) {
  try {
    const [productsRes, audiencesRes, brandCore] = await Promise.all([
      supabaseAdmin.from('business_products').select('name').eq('user_id', user.id),
      supabaseAdmin.from('business_audiences').select('name').eq('user_id', user.id),
      _getBrandCore(user.id)
    ]);
    const products = (productsRes.data || []).filter(p => p.name);
    const audiences = (audiencesRes.data || []).filter(a => a.name);
    const platformLabel = PLATFORM_LABEL[platform] || platform;

    // Winning campaigns â†’ products â†’ audiences (Epic 1, 2, 3)
    for (const c of (analysis.campaigns || [])) {
      if (!c.priority || (c.priority.level !== 'excellent' && c.priority.level !== 'scaling') || !c.name) continue;
      const confidence = _calcConfidence({ clicks: c.clicks, conversions: c.conversions, days: 7 });
      const evidence = { campaigns: 1, clicks: c.clicks, conversions: c.conversions, days: 7 };
      await _upsertLearning(user.id, {
        entity_type: 'campaign', entity_name: c.name, platform, category: 'winning_campaign',
        pattern: `"${c.name}" is a ${c.priority.level === 'excellent' ? 'top' : 'scaling'} performer on ${platformLabel} â€” ${c.priority.reason}`,
        confidence, evidence
      });

      const nameLc = c.name.toLowerCase();
      const matchedProduct = products.find(p => nameLc.includes(p.name.toLowerCase()));
      if (matchedProduct) {
        await _upsertLearning(user.id, {
          entity_type: 'product', entity_name: matchedProduct.name, platform, category: 'winning_product',
          pattern: `"${matchedProduct.name}" performs well in campaigns like "${c.name}" on ${platformLabel}`,
          confidence, evidence
        });
      }
      const matchedAudience = audiences.find(a => nameLc.includes(a.name.toLowerCase()));
      if (matchedAudience) {
        await _upsertLearning(user.id, {
          entity_type: 'audience', entity_name: matchedAudience.name, platform, category: 'winning_audience',
          pattern: `"${matchedAudience.name}" responds well to campaigns like "${c.name}" on ${platformLabel}`,
          confidence, evidence
        });
      }
    }

    // Winning creatives (Epic 1)
    const topCreatives = (analysis.creatives || []).filter(c => c.performance === 'top' && c.name);
    for (const cr of topCreatives) {
      await _upsertLearning(user.id, {
        entity_type: 'creative', entity_name: cr.name, platform, category: 'winning_creative',
        pattern: `"${cr.name}" is well above the account's average CTR on ${platformLabel}`,
        confidence: _calcConfidence({ clicks: cr.clicks, conversions: cr.conversions, days: 7 }),
        evidence: { campaigns: 1, clicks: cr.clicks, conversions: cr.conversions, days: 7 }
      });
    }

    // Creative DNA + messaging + Brand Evolution drift check (Epic 4, 5) â€”
    // Google only, since only Google's creative name is real ad copy.
    if (platform === 'google') {
      for (const pattern of _detectHeadlinePatterns(analysis.creatives)) {
        await _upsertLearning(user.id, Object.assign({ platform }, pattern));
      }

      for (const cr of topCreatives) {
        const style = _classifyMessaging(cr.name);
        if (!style) continue;
        const confidence = _calcConfidence({ clicks: cr.clicks, conversions: cr.conversions, days: 7 });
        await _upsertLearning(user.id, {
          entity_type: 'messaging', entity_name: style, platform, category: 'winning_messaging',
          pattern: `"${style}" messaging is winning in your top-performing ads (e.g. "${cr.name}")`,
          confidence, evidence: { campaigns: 1, clicks: cr.clicks, conversions: cr.conversions, days: 7 }
        });

        const tone = ((brandCore && brandCore.toneOfVoice) || '').toLowerCase();
        const contradicts = (style === 'premium' && /budget|casual|affordable|value/.test(tone))
          || (style === 'discount' && /premium|luxury|upscale|exclusive/.test(tone));
        if (contradicts) {
          const title = 'Your winning messaging may not match your saved brand voice';
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recentEvt } = await supabaseAdmin.from('intelligence_events')
            .select('id').eq('user_id', user.id).eq('title', title).gte('created_at', since);
          if (!recentEvt || !recentEvt.length) {
            await supabaseAdmin.from('intelligence_events').insert({
              user_id: user.id, platform, type: 'brand_drift', title,
              detail: `Your top-performing ads lean "${style}", but your saved brand tone of voice reads differently. Worth reviewing?`,
              severity: 'low',
              message: `My winning ads lean "${style}" messaging but my saved brand voice says something different â€” help me review it.`
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[LearningEngine] ${platform} | user ${user.id} | failed:`, err.message);
  }
}

// Epic 2/3 "best platform" â€” genuinely needs both platforms' data in hand at
// once, so this runs from _runIntelligenceMonitoring after both per-platform
// passes complete, reusing their already-fetched analyses (no extra API
// calls).
async function _runCrossPlatformLearning(user, analyses) {
  try {
    const { google, meta } = analyses;
    if (!google || !meta) return;
    const { data: productsData } = await supabaseAdmin.from('business_products').select('name').eq('user_id', user.id);
    for (const p of (productsData || []).filter(p => p.name)) {
      const nameLc = p.name.toLowerCase();
      const gCamps = (google.campaigns || []).filter(c => c.name && c.name.toLowerCase().includes(nameLc) && c.conversions >= 3);
      const mCamps = (meta.campaigns   || []).filter(c => c.name && c.name.toLowerCase().includes(nameLc) && c.conversions >= 3);
      if (!gCamps.length || !mCamps.length) continue;
      const gRoas = _avg(gCamps, 'roas'), mRoas = _avg(mCamps, 'roas');
      if (!gRoas || !mRoas) continue;
      const gap = Math.abs(gRoas - mRoas) / Math.max(gRoas, mRoas);
      if (gap < 0.15) continue;
      const winner = gRoas > mRoas ? 'google' : 'meta';
      const winnerCamps = winner === 'google' ? gCamps : mCamps;
      const clicks = winnerCamps.reduce((s, c) => s + c.clicks, 0);
      const conversions = winnerCamps.reduce((s, c) => s + c.conversions, 0);
      await _upsertLearning(user.id, {
        entity_type: 'product', entity_name: p.name, platform: winner, category: 'best_platform',
        pattern: `${PLATFORM_LABEL[winner]} outperforms ${PLATFORM_LABEL[winner === 'google' ? 'meta' : 'google']} for "${p.name}" by ROAS`,
        confidence: _calcConfidence({ clicks, conversions, days: 7 }),
        evidence: { campaigns: winnerCamps.length, clicks, conversions, days: 7 }
      });
    }
  } catch (err) {
    console.warn(`[LearningEngine] cross-platform | user ${user.id} | failed:`, err.message);
  }
}

// Epic 10 â€” Knowledge Quality. Dedup is free (upsert on a unique key); this
// is the other half: anything the engine hasn't re-confirmed in 90+ days
// gets archived (not deleted â€” still visible, still removable by the user).
async function _archiveStaleLearnings() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.from('business_learnings').update({ status: 'archived' }).eq('status', 'active').lt('updated_at', cutoff);
  if (error) console.warn('[LearningEngine] archive pass failed:', error.message);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// V9 â€” Autopilot: Recommendation Engine (Epic 4). Every number here
// (confidence, evidence) is already computed elsewhere (_calcConfidence,
// the same confidence_basis pattern _monitorPlatform already builds) â€”
// this only assembles the structured shape and asks the AI to narrate the
// reasoning, never invent the numbers.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function _generateRecommendation({ userId, sourceEventId, platform, campaignName, type, problem, confidence, evidence, riskLevel, toolName, toolParams }) {
  try {
    // Dedup: don't re-suggest the same unresolved issue every monitoring
    // cycle â€” one open recommendation per user+campaign+type at a time.
    const { data: existing } = await supabaseAdmin.from('autopilot_recommendations')
      .select('id').eq('user_id', userId).eq('type', type).eq('campaign_name', campaignName || null).eq('status', 'suggested').limit(1);
    if (existing && existing.length) return null;

    const system = `You are a senior marketing strategist explaining a detected issue to a business owner. Given the real, already-computed problem and evidence below, write: businessReason (why this matters to the business, 1 sentence), marketingReason (why this matters from a marketing/platform perspective, 1 sentence), estimatedImprovement (a qualitative, honest estimate, e.g. "could reduce wasted spend" â€” never invent a specific percentage unless it already appears in the evidence given), estimatedRoi (qualitative, same rule), suggestedAction (1 short, plain-English sentence). Reply ONLY with valid JSON: {"businessReason":"...","marketingReason":"...","estimatedImprovement":"...","estimatedRoi":"...","suggestedAction":"..."}.`;
    const userMsg = `Problem: ${problem}\nConfidence: ${confidence}%\nEvidence: ${evidence ? JSON.stringify(evidence) : 'n/a'}\nPlatform: ${platform || 'n/a'}\nCampaign: ${campaignName || 'n/a'}\nType: ${type}`;
    const raw = await _aimlText('autopilot-recommendation', system, userMsg, { max_tokens: 400 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let ai = {};
    try { ai = JSON.parse(cleaned); } catch (_) { console.warn('[Autopilot] recommendation narration unparseable'); }

    const row = {
      user_id: userId, source_event_id: sourceEventId || null, platform: platform || null, campaign_name: campaignName || null,
      type, problem, impact: ai.businessReason || null, confidence, evidence: evidence || null,
      business_reason: ai.businessReason || null, marketing_reason: ai.marketingReason || null,
      estimated_improvement: ai.estimatedImprovement || null, estimated_roi: ai.estimatedRoi || null,
      suggested_action: ai.suggestedAction || problem,
      risk: riskLevel || 'low', tool_name: toolName || null, tool_params: toolParams || null, status: 'suggested'
    };
    const { data, error } = await supabaseAdmin.from('autopilot_recommendations').insert(row).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[Autopilot] _generateRecommendation failed:', err.message);
    return null;
  }
}

// â”€â”€ Autopilot Complete Redesign â”€â”€ real rule evaluation + execution â”€â”€
// Evaluated inside the same per-campaign pass _campaignPriority already
// runs over â€” no second monitoring loop. Each rule's own action_params.mode
// (default 'require_approval', the original behavior) decides what
// happens on trigger:
//   'suggest_only' / 'require_approval' â†’ creates a `suggested`
//     recommendation a human approves from the Autopilot Center (the
//     original, already-tested execution path).
//   'fully_automatic' â†’ actually executes immediately, no click needed â€”
//     but only for actions that don't need a live user JWT beyond what
//     _getGadsAccess/_getMetaAccess/_getTikTokAccess already provide from
//     a stored refresh token (status/budget changes, and DB-only actions
//     like notify/report/briefing/recommendations). "Generate creative"
//     still queues an approvable recommendation even in fully_automatic
//     mode â€” real unattended generation would need the same kind of
//     internal-HTTP+JWT chain that status/budget changes needed dedicated
//     helpers to avoid, and extending that is out of scope here.
const AUTOPILOT_RULE_OPERATORS = { '<': (a, b) => a < b, '>': (a, b) => a > b, '==': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };

function _ruleMetricValue(c, metric) {
  if (metric === 'cpc') return c.clicks > 0 ? c.spend / c.clicks : 0;
  if (metric === 'status') {
    const s = String(c.status || '').toUpperCase();
    return (s.indexOf('PAUS') !== -1 || s === 'DISABLE') ? 'paused' : 'active';
  }
  if (metric === 'budget') return c.daily_budget != null ? c.daily_budget : (c.budget != null ? c.budget : null);
  return c[metric] != null ? c[metric] : 0;
}

// Intentionally separate from the PATCH/pause/resume HTTP routes above
// (already live and tested against real ad accounts) rather than
// refactored to share code with them â€” a bug in a shared helper would put
// BOTH the human-driven routes and this unattended executor at risk
// together; these are small enough (one mutation call each) that a little
// duplication is the safer trade for code that moves real ad spend.
async function _execSetCampaignStatus(user, platform, campaignId, pause) {
  if (platform === 'google') {
    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    await _gadsMutate(accessToken, customerId, 'campaigns', [{
      updateMask: 'status',
      update: { resourceName: 'customers/' + customerId + '/campaigns/' + campaignId, status: pause ? 'PAUSED' : 'ENABLED' }
    }], loginCustomerId);
    return pause ? 'PAUSED' : 'ENABLED';
  }
  if (platform === 'meta') {
    const { accessToken } = await _getMetaAccess(user);
    await _metaApiPost('/' + campaignId, accessToken, { status: pause ? 'PAUSED' : 'ACTIVE' });
    return pause ? 'PAUSED' : 'ACTIVE';
  }
  if (platform === 'tiktok') {
    const { accessToken, advertiserId } = await _getTikTokAccess(user);
    await _tiktokPost('/campaign/status/update/', accessToken, { advertiser_id: advertiserId, campaign_ids: [campaignId], operation_status: pause ? 'DISABLE' : 'ENABLE' });
    return pause ? 'DISABLE' : 'ENABLE';
  }
  throw new Error('Unsupported platform: ' + platform);
}

async function _execFetchGoogleBudget(customerId, loginCustomerId, accessToken, campaignId) {
  const bQ = 'SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ' + campaignId + ' LIMIT 1';
  const bR = await _gadsQuery(accessToken, customerId, bQ, loginCustomerId);
  if (!bR.length) throw new Error('Campaign not found');
  const cb = bR[0].campaignBudget || {};
  if (!cb.resourceName) throw new Error('Campaign has no detached budget');
  return { resourceName: cb.resourceName, amount: Number(cb.amountMicros || 0) / 1e6 };
}

async function _execSetCampaignBudget(user, platform, campaignId, newDailyBudget) {
  if (platform === 'google') {
    const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
    const { resourceName } = await _execFetchGoogleBudget(customerId, loginCustomerId, accessToken, campaignId);
    await _gadsMutate(accessToken, customerId, 'campaignBudgets', [{
      updateMask: 'amountMicros',
      update: { resourceName, amountMicros: String(Math.round(Number(newDailyBudget) * 1e6)) }
    }], loginCustomerId);
    return;
  }
  if (platform === 'meta') {
    const { accessToken } = await _getMetaAccess(user);
    await _metaApiPost('/' + campaignId, accessToken, { daily_budget: String(Math.round(Number(newDailyBudget) * 100)) }); // Meta daily_budget is in cents
    return;
  }
  throw new Error('Budget changes are not supported on ' + platform + ' yet.');
}

async function _execRuleAction(user, platform, rule, campaign, mode) {
  const ap = rule.action_params || {};
  const problem = `Automation rule "${rule.name}" triggered: ${rule.trigger_metric} ${rule.trigger_operator} ${rule.trigger_value} for "${campaign.name}".`;
  const confidence = _calcConfidence({ clicks: campaign.clicks, conversions: campaign.conversions, days: 7 });
  const evidence = { metric: rule.trigger_metric, operator: rule.trigger_operator, value: rule.trigger_value, actual: _ruleMetricValue(campaign, rule.trigger_metric) };

  // "Notify me" is always a plain event-log write, in every mode â€” there's
  // no live mutation to gate, so there's nothing "unattended-unsafe" about it.
  if (rule.action_type === 'notify') {
    await supabaseAdmin.from('intelligence_events').insert({
      user_id: user.id, platform, campaign_name: campaign.name, type: 'campaign_action',
      title: `Automation "${rule.name}" fired for "${campaign.name}"`, detail: problem, severity: 'medium', confidence, message: problem
    });
    return;
  }

  if (rule.action_type === 'request_approval' || mode !== 'fully_automatic') {
    // suggest_only / require_approval (the safe default), and
    // request_approval regardless of mode â€” the original, already-tested
    // path: create a recommendation, a human approves it from the
    // Autopilot Center, POST /api/autopilot/recommendations/:id/approve
    // does the real execution from there.
    const toolMap = {
      pause_campaign:  { name: 'pause_campaign',  params: { campaignName: campaign.name, platform } },
      resume_campaign: { name: 'resume_campaign', params: { campaignName: campaign.name, platform } },
      generate_creative: { name: 'generate_headlines', params: { seed: campaign.name, count: 5 } }
    };
    const mapped = toolMap[rule.action_type] || { name: null, params: null }; // increase/decrease_budget, generate_recommendations, create_report, create_briefing, run_optimisation: recommendation-only today
    await _generateRecommendation({
      userId: user.id, platform, campaignName: campaign.name, type: rule.action_type, problem, confidence, evidence,
      riskLevel: mapped.name ? 'low' : 'medium', toolName: mapped.name, toolParams: mapped.params
    });
    return;
  }

  // mode === 'fully_automatic' from here â€” genuinely executes, no click.
  try {
    if (rule.action_type === 'pause_campaign') {
      await _execSetCampaignStatus(user, platform, campaign.id, true);
    } else if (rule.action_type === 'resume_campaign') {
      await _execSetCampaignStatus(user, platform, campaign.id, false);
    } else if (rule.action_type === 'increase_budget' || rule.action_type === 'decrease_budget') {
      const percent = (typeof ap.percent === 'number' && ap.percent > 0) ? ap.percent : 15;
      let current = campaign.daily_budget;
      if (current == null && platform === 'google') {
        const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
        current = (await _execFetchGoogleBudget(customerId, loginCustomerId, accessToken, campaign.id)).amount;
      }
      if (current == null) throw new Error('Could not determine current budget');
      const next = rule.action_type === 'increase_budget' ? current * (1 + percent / 100) : current * (1 - percent / 100);
      await _execSetCampaignBudget(user, platform, campaign.id, Math.max(1, next));
    } else if (rule.action_type === 'generate_recommendations' || rule.action_type === 'run_optimisation') {
      await _generateRecommendation({
        userId: user.id, platform, campaignName: campaign.name, type: rule.action_type, problem, confidence, evidence,
        riskLevel: 'low', toolName: null, toolParams: null
      });
      return; // _generateRecommendation already logs its own row; skip the extra "executed" event below
    } else if (rule.action_type === 'create_report' || rule.action_type === 'create_briefing') {
      await supabaseAdmin.from('intelligence_events').insert({
        user_id: user.id, platform, campaign_name: campaign.name, type: 'daily_brief',
        title: `${rule.action_type === 'create_briefing' ? 'Briefing' : 'Report'} created by automation "${rule.name}"`,
        detail: problem, severity: 'low', confidence, message: problem
      });
      return;
    } else if (rule.action_type === 'generate_creative') {
      await _generateRecommendation({
        userId: user.id, platform, campaignName: campaign.name, type: rule.action_type, problem, confidence, evidence,
        riskLevel: 'low', toolName: 'generate_headlines', toolParams: { seed: campaign.name, count: 5 }
      });
      return;
    }
    await supabaseAdmin.from('intelligence_events').insert({
      user_id: user.id, platform, campaign_name: campaign.name, type: 'campaign_action',
      title: `Automation "${rule.name}" executed automatically`,
      detail: problem, severity: 'low', confidence, message: `${rule.action_type.replace(/_/g, ' ')} on "${campaign.name}"`
    });
  } catch (err) {
    console.warn(`[Autopilot] fully_automatic execution failed for rule ${rule.id}:`, err.message);
    await supabaseAdmin.from('intelligence_events').insert({
      user_id: user.id, platform, campaign_name: campaign.name, type: 'campaign_action',
      title: `Automation "${rule.name}" failed to execute`,
      detail: err.message, severity: 'high', message: `Automatic execution failed: ${err.message}`
    });
  }
}

async function _evaluateAutomationRules(user, platform, campaigns) {
  try {
    const { data: rules } = await supabaseAdmin.from('automation_rules').select('*').eq('user_id', user.id).eq('enabled', true);
    if (!rules || !rules.length) return;
    const today = new Date().toISOString().slice(0, 10);

    for (const rule of rules) {
      if (rule.platform && rule.platform !== platform) continue;
      if (!AUTOPILOT_RULE_METRICS.includes(rule.trigger_metric)) continue;
      if (rule.last_triggered_at && rule.last_triggered_at.slice(0, 10) === today) continue; // at most once/day per rule
      const op = AUTOPILOT_RULE_OPERATORS[rule.trigger_operator];
      if (!op) continue;

      const ap = rule.action_params || {};
      const scopedCampaignId = ap.campaign_id && ap.campaign_id !== 'all' ? ap.campaign_id : null;
      const pool = scopedCampaignId ? (campaigns || []).filter(c => String(c.id) === String(scopedCampaignId)) : (campaigns || []);

      const compareVal = rule.trigger_metric === 'status' ? rule.trigger_value : Number(rule.trigger_value);
      const matches = pool.filter(c => {
        const actual = _ruleMetricValue(c, rule.trigger_metric);
        return actual != null && op(actual, compareVal);
      });
      if (!matches.length) continue;

      // At most once/day/rule, so only the first qualifying campaign is
      // acted on per tick even if several matched â€” prevents one noisy
      // metric from firing a dozen actions in a single pass.
      const match = matches[0];
      const mode = AUTOPILOT_RULE_MODES.includes(ap.mode) ? ap.mode : 'require_approval';

      await _execRuleAction(user, platform, rule, match, mode);
      await supabaseAdmin.from('automation_rules').update({ last_triggered_at: new Date().toISOString() }).eq('id', rule.id);
    }
  } catch (err) {
    console.warn(`[Autopilot] rule evaluation failed for user ${user.id}:`, err.message);
  }
}

// -- Shared analysis cache -- collapses the cron's _monitorPlatform, the
// on-demand /api/intelligence/home + /briefing + /opportunities (all via
// _gatherPlatformIntelligence), and the explicit "Analyze with AI" buttons
// onto ONE cached result per (user, platform, range), instead of each path
// independently re-running the expensive _analyzeGoogleAccount/
// _analyzeMetaAccount AI call. Freshness = a fingerprint of the REAL
// campaign totals for that window (cheap totals query) plus a 4h TTL that
// mirrors the cron's own refresh cadence (a rolling "LAST_7_DAYS" window
// can shift a day even with identical totals, so the TTL catches that).
const _ANALYSIS_RANGE_DAYS = { LAST_7_DAYS: 7, LAST_30_DAYS: 30, LAST_90_DAYS: 90, LAST_12_MONTHS: 365 };
const _ANALYSIS_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

async function getOrRefreshAnalysis(user, platform, range, opts) {
  opts = opts || {};
  const forceRefresh = !!opts.forceRefresh;
  const rangeKey = range || 'LAST_7_DAYS';
  const days = _ANALYSIS_RANGE_DAYS[rangeKey] || 7;
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceISO = since.toISOString().slice(0, 10);
  const untilISO = until.toISOString().slice(0, 10);

  let fingerprint = null;
  try {
    let totals;
    if (platform === 'google') {
      const { accessToken, customerId, loginCustomerId } = await _getGadsAccess(user);
      totals = await _gadsFetchTotals(accessToken, customerId, loginCustomerId, sinceISO, untilISO);
    } else {
      const { accessToken, accountId } = await _getMetaAccess(user);
      totals = await _metaFetchTotals(accessToken, accountId, sinceISO, untilISO);
    }
    fingerprint = crypto.createHash('sha256').update(JSON.stringify(totals)).digest('hex');
  } catch (err) {
    console.warn(`[analysisCache] Could not fetch totals for fingerprint (${platform}, ${user.id}):`, err.message);
  }

  if (!forceRefresh && fingerprint) {
    try {
      const { data: cached } = await supabaseAdmin.from('platform_analysis_cache')
        .select('*').eq('user_id', user.id).eq('platform', platform).eq('date_range', rangeKey).maybeSingle();
      const cacheAgeOk = cached && (Date.now() - new Date(cached.created_at).getTime() < _ANALYSIS_CACHE_TTL_MS);
      if (cached && cached.input_fingerprint === fingerprint && cacheAgeOk) {
        return cached.analysis;
      }
    } catch (err) {
      console.warn(`[analysisCache] Cache read failed (${platform}, ${user.id}):`, err.message);
    }
  }

  const analysis = platform === 'google'
    ? await _analyzeGoogleAccount(user, rangeKey)
    : await _analyzeMetaAccount(user, rangeKey);

  if (fingerprint) {
    supabaseAdmin.from('platform_analysis_cache').upsert({
      user_id: user.id, platform, date_range: rangeKey, input_fingerprint: fingerprint,
      analysis, created_at: new Date().toISOString(),
    }, { onConflict: 'user_id,platform,date_range' }).then((r) => {
      if (r && r.error) console.warn(`[analysisCache] Cache write failed (${platform}, ${user.id}):`, r.error.message);
    });
  }
  return analysis;
}

async function _monitorPlatform(user, platform, opts) {
  opts = opts || {};
  try {
    const analysis = await getOrRefreshAnalysis(user, platform, 'LAST_7_DAYS');

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabaseAdmin.from('intelligence_events')
      .select('title').eq('user_id', user.id).eq('platform', platform).gte('created_at', since);
    const seen = new Set((recent || []).map(r => r.title));

    const rows = [];
    (analysis.findings || []).slice(0, 4).forEach(f => {
      if (seen.has(f.title)) return;
      rows.push({ user_id: user.id, platform, campaign_name: f.campaign || null, type: 'finding',
        title: f.title, detail: f.detail, severity: f.severity || null,
        confidence: f.confidence != null ? f.confidence : null, confidence_basis: f.confidenceBasis || null,
        message: f.action || f.title });
    });
    (analysis.recommendations || []).slice(0, 2).forEach(r => {
      if (seen.has(r.title)) return;
      rows.push({ user_id: user.id, platform, campaign_name: r.campaign || null, type: 'recommendation',
        title: r.title, detail: r.detail, severity: r.priority || null,
        confidence: r.confidence != null ? r.confidence : null, confidence_basis: r.confidenceBasis || null,
        message: r.detail ? r.title + ' â€” ' + r.detail : r.title });
    });
    (analysis.creatives || []).filter(c => c.performance === 'underperforming').slice(0, 1).forEach(c => {
      const title = `Creative fatigue: "${c.name}"`;
      if (seen.has(title)) return;
      rows.push({ user_id: user.id, platform, type: 'creative_fatigue', title,
        detail: `"${c.name}" is underperforming the account's average CTR.`, severity: 'medium',
        confidence: _calcConfidence({ clicks: c.clicks, conversions: c.conversions, days: 7 }),
        confidence_basis: `7 days, ${c.clicks} clicks, ${c.conversions} conversions`,
        message: `Review the creative "${c.name}" on ${platform === 'google' ? 'Google Ads' : 'Meta Ads'} â€” it may need refreshing.` });
    });

    // V7 Phase 2 â€” Memory Evolution (Epic 5/13). A winner surfaces once as an
    // "opportunity" event; clicking it opens chat and asks Oriven to remember
    // it, which routes through the existing remember_business_fact tool and
    // its confirmation card â€” no new save-without-asking path.
    (analysis.campaigns || []).filter(c => c.priority && (c.priority.level === 'excellent' || c.priority.level === 'scaling')).slice(0, 1).forEach(c => {
      const title = `Winning campaign: "${c.name}"`;
      if (seen.has(title)) return;
      rows.push({ user_id: user.id, platform, campaign_name: c.name, type: 'opportunity', title,
        detail: c.priority.reason, severity: 'low',
        message: `Remember "${c.name}" as a winning campaign on ${platform === 'google' ? 'Google Ads' : 'Meta Ads'}?` });
    });
    (analysis.creatives || []).filter(c => c.performance === 'top').slice(0, 1).forEach(c => {
      const title = `Winning creative: "${c.name}"`;
      if (seen.has(title)) return;
      rows.push({ user_id: user.id, platform, type: 'opportunity', title,
        detail: `"${c.name}" is well above the account's average CTR.`, severity: 'low',
        message: `Remember "${c.name}" as a winning creative on ${platform === 'google' ? 'Google Ads' : 'Meta Ads'}?` });
    });

    if (rows.length) {
      await supabaseAdmin.from('intelligence_events').insert(rows);
      console.log(`[Monitoring] ${platform} | user ${user.id} | logged ${rows.length} event(s)`);
    }

    // Autopilot-specific: recommendation generation + rule evaluation only
    // run for Creator/Professional users who have >=1 enabled automation
    // rule -- with no rules, Autopilot does nothing (per the credit-economy
    // sprint's background-cost rules). Intelligence findings above (events,
    // score, winning-campaign surfacing) stay unconditional for everyone --
    // Intelligence itself is a Starter-tier-included feature, this gate is
    // scoped to Autopilot's own extra AI calls only.
    if (opts.autopilotEligible) {
      // V9 (Epic 2/3) â€” "budget waste" and "audience saturation" reuse the
      // exact same _campaignPriority classifications _monitorPlatform already
      // computes (critical = spend with zero conversions; needs_attention =
      // CTR well below account average on real impression volume), now also
      // surfaced as structured, approvable recommendations rather than only
      // a passive finding.
      const wasteCampaign = (analysis.campaigns || []).find(c => c.priority && c.priority.level === 'critical');
      if (wasteCampaign) {
        await _generateRecommendation({
          userId: user.id, platform, campaignName: wasteCampaign.name, type: 'budget_waste',
          problem: `"${wasteCampaign.name}" has spent without producing conversions.`,
          confidence: _calcConfidence({ clicks: wasteCampaign.clicks, conversions: wasteCampaign.conversions, days: 7 }),
          evidence: { spend: wasteCampaign.spend, conversions: wasteCampaign.conversions, clicks: wasteCampaign.clicks, days: 7 },
          riskLevel: 'medium', toolName: 'change_budget', toolParams: { campaignName: wasteCampaign.name, platform, action: 'decrease' }
        });
      }
      const saturatedCampaign = (analysis.campaigns || []).find(c => c.priority && c.priority.level === 'needs_attention');
      if (saturatedCampaign) {
        await _generateRecommendation({
          userId: user.id, platform, campaignName: saturatedCampaign.name, type: 'audience_saturation',
          problem: `"${saturatedCampaign.name}"'s CTR is well below the account average despite real impression volume â€” a sign the audience may be seeing the same creative too often.`,
          confidence: _calcConfidence({ clicks: saturatedCampaign.clicks, conversions: saturatedCampaign.conversions, days: 7 }),
          evidence: { ctr: saturatedCampaign.ctr, impressions: saturatedCampaign.impressions, days: 7 },
          riskLevel: 'low', toolName: 'generate_headlines', toolParams: { seed: saturatedCampaign.name, count: 5 }
        });
      }
      await _evaluateAutomationRules(user, platform, analysis.campaigns);
    }
    await _runLearningEngine(user, platform, analysis);
    return analysis;
  } catch (err) {
    console.warn(`[Monitoring] ${platform} | user ${user.id} | failed:`, err.message);
    return null;
  }
}

// Epic 8 â€” Smart Task Manager. Generated during the same monitoring pass
// from three sources that already exist: stale/broken Business Brain
// knowledge (_validateBusinessKnowledge, V7 Phase 2), Business Health
// recommendations (_computeBusinessHealth, V7 Phase 2/3), and open
// high-confidence Autopilot recommendations â€” not a new detection engine.
const AUTOPILOT_TASK_TIME_MINUTES = { review_campaign: 10, review_product: 5, refresh_website: 5, update_competitor: 5, prepare_report: 15 };
const AUTOPILOT_TASK_DEADLINE_DAYS = { high: 1, medium: 3, low: 7 };
async function _generateAutopilotTasks(user) {
  try {
    const [validation, health, openRecs] = await Promise.all([
      _validateBusinessKnowledge(user.id).catch(() => ({ findings: [] })),
      _computeBusinessHealth(user.id).catch(() => ({ recommendations: [] })),
      supabaseAdmin.from('autopilot_recommendations').select('id,problem,confidence').eq('user_id', user.id).eq('status', 'suggested').gte('confidence', 60).limit(5)
    ]);

    const candidates = [];
    (validation.findings || []).forEach(f => {
      candidates.push({ title: f.title, task_type: f.tab === 'competitors' ? 'update_competitor' : 'review_product', priority: f.severity === 'medium' ? 'medium' : 'low', source_recommendation_id: null, business_impact: f.detail || null });
    });
    (health.recommendations || []).slice(0, 3).forEach(r => {
      candidates.push({ title: r.title, task_type: r.tab === 'website' ? 'refresh_website' : 'review_product', priority: r.severity === 'high' ? 'high' : 'medium', source_recommendation_id: null, business_impact: r.detail || null });
    });
    (openRecs.data || []).forEach(r => {
      candidates.push({ title: `Review: ${r.problem}`.slice(0, 200), task_type: 'review_campaign', priority: r.confidence >= 80 ? 'high' : 'medium', source_recommendation_id: r.id, business_impact: r.problem });
    });

    for (const c of candidates) {
      const { data: existing } = await supabaseAdmin.from('autopilot_tasks').select('id').eq('user_id', user.id).eq('title', c.title).eq('status', 'pending').limit(1);
      if (existing && existing.length) continue;
      const deadlineDays = AUTOPILOT_TASK_DEADLINE_DAYS[c.priority] || 7;
      await supabaseAdmin.from('autopilot_tasks').insert({
        user_id: user.id, title: c.title, task_type: c.task_type, priority: c.priority,
        deadline: new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000).toISOString(),
        business_impact: c.business_impact, estimated_minutes: AUTOPILOT_TASK_TIME_MINUTES[c.task_type] || 10,
        source_recommendation_id: c.source_recommendation_id
      });
    }
  } catch (err) {
    console.warn(`[Autopilot] task generation failed for user ${user.id}:`, err.message);
  }
}

async function _runIntelligenceMonitoring() {
  const { data: rows, error } = await supabaseAdmin.from('integrations')
    .select('user_id, provider').in('provider', ['google_ads', 'meta_ads']);
  if (error) { console.error('[Monitoring] Could not list connected users:', error.message); return; }

  const byUser = {};
  (rows || []).forEach(r => { (byUser[r.user_id] = byUser[r.user_id] || new Set()).add(r.provider); });

  const userIds = Object.keys(byUser);
  console.log(`[Monitoring] Run starting â€” ${userIds.length} connected user(s)`);
  for (const userId of userIds) {
    const user = { id: userId };
    const providers = byUser[userId];

    // Autopilot only runs its own extra AI calls (recommendations, rule
    // eval, task generation) for Creator/Professional users who have >=1
    // enabled automation rule -- with no rules, Autopilot does nothing.
    // Starter users, and paid users with zero rules, still get full
    // Intelligence findings from _monitorPlatform below -- only the
    // Autopilot-specific sub-steps are skipped.
    let autopilotEligible = false;
    try {
      const { data: profile } = await supabaseAdmin.from('profiles')
        .select('subscription_status').eq('id', userId).maybeSingle();
      const plan = profile && profile.subscription_status;
      if (plan === 'creator' || plan === 'professional') {
        const { count } = await supabaseAdmin.from('automation_rules')
          .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('enabled', true);
        autopilotEligible = (count || 0) > 0;
      }
    } catch (err) {
      console.warn(`[Monitoring] Autopilot eligibility check failed for ${userId}:`, err.message);
    }

    const analyses = {};
    if (providers.has('google_ads')) analyses.google = await _monitorPlatform(user, 'google', { autopilotEligible });
    if (providers.has('meta_ads'))   analyses.meta   = await _monitorPlatform(user, 'meta', { autopilotEligible });
    if (analyses.google && analyses.meta) await _runCrossPlatformLearning(user, analyses);
    if (autopilotEligible) await _generateAutopilotTasks(user);
  }
  await _archiveStaleLearnings();
  console.log('[Monitoring] Run complete');
}

// Every 4 hours â€” frequent enough to feel continuous, light enough to keep
// live-API usage reasonable across all connected users.
cron.schedule('0 */4 * * *', () => {
  _runIntelligenceMonitoring().catch(err => console.error('[Monitoring] Fatal:', err.message));
}, { timezone: 'UTC' });

// -- Daily briefing -- ONE briefing per user's own local calendar day, not
// three fixed-UTC-time briefings (the old daily_morning/midday/evening
// cadence was wrong for every non-UTC user anyway). First visit of the
// user's local day generates and caches it; every later visit that day
// reuses the cache; the next local day regenerates. Also called on-demand
// from /api/intelligence/home (see below) so a visit always gets today's
// briefing without waiting on the pre-warm cron.
function _localDateInTZ(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (err) {
    return new Date().toISOString().slice(0, 10); // invalid/unknown tz -> UTC fallback
  }
}

async function getOrGenerateDailyBriefing(user, browserTimezone) {
  const tz = user.timezone || browserTimezone || 'UTC';
  const localDate = _localDateInTZ(tz);

  const { data: cached } = await supabaseAdmin.from('daily_briefing_cache')
    .select('content').eq('user_id', user.id).eq('local_date', localDate).maybeSingle();
  if (cached) return cached.content;

  const learnings = await _fetchActiveLearnings(user.id, { limit: 30 });
  if (!learnings.length) return null;
  const learningLines = learnings.slice(0, 10).map(l => `${l.entity_type} "${l.entity_name}": ${l.pattern} (${l.confidence}%)`).join('\n');
  const system = `You are a marketing strategist writing a one-paragraph daily brief. Ground every statement in the real data given; never invent numbers.`;
  const raw = await _aimlText('autopilot-brief', system, `LEARNINGS:\n${learningLines}`, { max_tokens: 250 });
  const content = { text: raw.trim().slice(0, 500), generatedAt: new Date().toISOString() };

  await supabaseAdmin.from('daily_briefing_cache').upsert({
    user_id: user.id, local_date: localDate, timezone_used: tz, content,
  }, { onConflict: 'user_id,local_date' });

  await supabaseAdmin.from('intelligence_events').insert({
    user_id: user.id, type: 'daily_brief', title: 'Daily brief ready',
    detail: content.text, severity: 'low', message: content.text.slice(0, 200)
  });

  return content;
}

// Pre-warms the cache for users whose local midnight has just passed, so
// the first visitor of their day isn't waiting on a live AI call --
// naturally no-ops (via the cache check above) for anyone already
// generated for their current local date. Frequent (30min) but cheap: a
// DB-only pass except for the handful of users actually crossing midnight.
cron.schedule('*/30 * * * *', async () => {
  try {
    const { data: rows } = await supabaseAdmin.from('integrations').select('user_id').in('provider', ['google_ads', 'meta_ads']);
    const userIds = [...new Set((rows || []).map(r => r.user_id))];
    for (const userId of userIds) {
      try {
        const { data: profile } = await supabaseAdmin.from('profiles').select('timezone').eq('id', userId).maybeSingle();
        await getOrGenerateDailyBriefing({ id: userId, timezone: profile && profile.timezone });
      } catch (err) {
        console.warn(`[DailyBrief] pre-warm failed for ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[DailyBrief] pre-warm cron fatal:', err.message);
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
  const _metaRoutes = [
    'GET /api/meta/auth-url',
    'GET /auth/meta',
    'GET /auth/meta/callback',
    'GET /api/meta/status',
    'GET /api/meta/accounts',
    'POST /api/meta/disconnect',
    'POST /api/meta/active-account',
    'GET /api/meta/campaigns',
    'GET /api/meta/adsets',
    'GET /api/meta/ads'
  ];
  const _tiktokRoutes = [
    'GET /auth/tiktok',
    'GET /auth/tiktok/callback',
    'GET /api/tiktok/status',
    'GET /api/tiktok/accounts',
    'POST /api/tiktok/disconnect',
    'POST /api/tiktok/active-account',
    'GET /api/tiktok/campaigns',
    'POST /api/tiktok/campaign/:id/pause',
    'POST /api/tiktok/campaign/:id/resume',
    'DELETE /api/tiktok/campaign/:id',
    'POST /api/publish/tiktok'
  ];
  _googleRoutes.concat(_metaRoutes).concat(_tiktokRoutes).forEach(function(sig) {
    const [method, path] = sig.split(' ');
    const found = _checkStack.some(function(l) {
      return l.route && l.route.path === path && l.route.methods[method.toLowerCase()];
    });
    console.log('[Startup] Route', sig, found ? 'âœ… registered' : 'âŒ NOT FOUND');
  });
  console.log('[Startup] META_APP_ID loaded:', !!META_APP_ID);
  console.log('[Startup] META_APP_SECRET loaded:', !!META_APP_SECRET);
  console.log('[Startup] TIKTOK_APP_ID loaded:', !!TIKTOK_APP_ID);
  console.log('[Startup] TIKTOK_APP_SECRET loaded:', !!TIKTOK_APP_SECRET);

  // Live Supabase admin connectivity test â€” runs every server start
  console.log('[Startup] Testing Supabase admin client...');
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, subscription_status')
      .limit(1);

    if (error) {
      console.error('[Startup] âŒ Supabase admin query FAILED:', error.message, '| code:', error.code);
      if (error.code === '42501') {
        console.error('[Startup]    RLS blocked the query â€” SUPABASE_SERVICE_ROLE_KEY is wrong');
        console.error('[Startup]    Fix: get the service_role key from Supabase Dashboard â†’ Settings â†’ API');
      }
    } else {
      console.log('[Startup] âœ… Supabase admin client can read profiles table');
      if (data && data.length > 0) {
        console.log('[Startup]    Sample row:', JSON.stringify(data[0]));
      } else {
        console.log('[Startup]    profiles table is empty (no rows yet)');
      }
    }
  } catch (e) {
    console.error('[Startup] âŒ Supabase admin test threw an exception:', e.message);
  }
});

