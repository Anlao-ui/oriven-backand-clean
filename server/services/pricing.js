// ════════════════════════════════════════════════════════════════
// OrivenAI pricing: the ONE backend source for plans, prices, access
// periods, credit allowances, instalments and the credit cost of every
// paid action.
//
// Business model (2026-10-29): one product, the same functionality for every
// paying customer, five access periods bought once and renewed manually
// (no automatic renewal), and a credit allowance per period.
//
// How the numbers were derived (C:\files\oriven-plans\2026-10-30-pricing-v2.md,
// reproducible with 2026-10-30-pricing-model-v2.js):
//   • Revenue excl. VAT = price incl. 21% VAT / 1.21. 70% of it must remain
//     after direct AI-provider cost, so AI may cost at most 30% of it.
//   • Plan credits = 30% of revenue excl. VAT / €0.0040, the planning AI cost
//     of one credit (heavy usage). Typical usage costs about €0.0025 per
//     credit (≈81% margin); heavy €0.0040 (70%); worst reasonable €0.0050
//     (≈63%), which still leaves a positive contribution.
//   • Action credits = max(typical cost / €0.0025, high cost / €0.0050),
//     rounded up to 5. Costs are ESTIMATES at the conservative provider rate
//     (spendGuard.PRICES, 1.3754 × AIMLAPI's list price for tokens) and
//     $1 = €0.93; see the report for what is verified and what is not.
//   • Unused credits expire when access ends. Longer plans grant their
//     credits in monthly instalments (all within the access period), so a
//     refund or chargeback early in a long plan exposes at most one month
//     of credits.
//
// The frontend mirrors this file in oriven-frontend/js/pricing-config.js;
// tests/pricing.test.js fails when the two disagree.
// ════════════════════════════════════════════════════════════════

// Planning assumption ONLY (Dutch VAT): used to size the AI cost budget
// below. It is never used to charge: plan prices are BEFORE VAT
// (tax-exclusive Stripe Prices) and Stripe Tax adds the VAT that applies to
// each buyer at checkout (21 % in the Netherlands). The field name
// priceInclVat (and purchases.price_incl_vat_cents) predates that change:
// it holds the plan price the Stripe Price must have, before VAT.
const VAT_RATE = 0.21;
const CURRENCY = 'eur';
const AI_COST_SHARE = 0.30;     // AI may use at most 30% of revenue excl. VAT
const PLANNING_COST_PER_CREDIT_EUR = 0.0040;

// ── Stripe Price IDs ───────────────────────────────────────────────
// Test Mode and Live Mode have different prices. Which set is used follows
// the secret key: sk_test_/rk_test_ → test, sk_live_/rk_live_ → live. Set
// them in the environment (never in the frontend), one per plan and mode:
//   STRIPE_PRICE_FLEX_TEST … STRIPE_PRICE_ANNUAL_TEST   (Test Mode prices)
//   STRIPE_PRICE_FLEX_LIVE … STRIPE_PRICE_ANNUAL_LIVE   (Live Mode prices)
// (FLEX, MONTHLY, QUARTERLY, SEMIANNUAL, ANNUAL — see .env.example.)
// Each is a Price ID (price_…, Stripe → Product catalogue → the product →
// its price; NOT the product's prod_… id). Every price must be a ONE-TIME
// price in EUR with the amount below and tax behaviour "Exclusive", in the
// SAME mode as the key — checkout verifies that with Stripe before it opens
// and refuses (nothing created, nothing charged) when a price is missing, a
// placeholder, from the other mode or different.
const PRICE_ENV = { flex: 'FLEX', monthly: 'MONTHLY', quarterly: 'QUARTERLY', semiannual: 'SEMIANNUAL', annual: 'ANNUAL' };
const PRICE_PLACEHOLDER = { flex: 'PASTE_FLEX_PRICE_ID_HERE', monthly: 'PASTE_MONTHLY_PRICE_ID_HERE', quarterly: 'PASTE_QUARTERLY_PRICE_ID_HERE', semiannual: 'PASTE_SEMI_ANNUAL_PRICE_ID_HERE', annual: 'PASTE_ANNUAL_PRICE_ID_HERE' };
// 'test' | 'live' | 'unknown' — from the Stripe secret key's prefix.
function stripeMode(key) {
  const k = String(key === undefined ? process.env.STRIPE_SECRET_KEY || '' : key || '');
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return 'unknown';
}
// The configured Price IDs for a mode (placeholders where nothing is set).
function priceIdsForMode(mode, env) {
  const e = env || process.env; const suffix = mode === 'live' ? 'LIVE' : 'TEST';
  const out = {};
  Object.keys(PRICE_ENV).forEach((id) => {
    const names = ['STRIPE_PRICE_' + PRICE_ENV[id] + '_' + suffix].concat((PRICE_ENV_ALIASES[id] || []).map((a) => 'STRIPE_PRICE_' + a + '_' + suffix));
    let v = '';
    for (const n of names) { v = (e[n] || '').trim(); if (v) break; }
    out[id] = v || PRICE_PLACEHOLDER[id];
  });
  return out;
}
// Also accepted (read only when the main name is unset): the Semi-Annual
// price is often named with an underscore, STRIPE_PRICE_SEMI_ANNUAL_LIVE.
const PRICE_ENV_ALIASES = { semiannual: ['SEMI_ANNUAL'] };
// Which environment variable actually holds a plan's price in a mode (for
// diagnostics), or null when none is set.
function priceEnvNameFor(planId, mode, env) {
  const e = env || process.env; const suffix = (mode || stripeMode()) === 'live' ? 'LIVE' : 'TEST';
  if (!PRICE_ENV[planId]) return null;
  const names = [PRICE_ENV[planId]].concat(PRICE_ENV_ALIASES[planId] || []).map((a) => 'STRIPE_PRICE_' + a + '_' + suffix);
  return names.find((n) => (e[n] || '').trim()) || null;
}
const STRIPE_MODE = stripeMode();
const STRIPE_PRICE_IDS = priceIdsForMode(STRIPE_MODE);

// id → { name, description, priceInclVat (EUR), months | days, credits, instalments, stripePriceId }
// credits must divide evenly by instalments (each instalment is equal).
const PLANS = {
  flex:       { id: 'flex',       name: 'Flex',        priceInclVat: 17,  days: 14,  months: 0,  credits: 1050,  instalments: 1,
    description: 'Get full access to OrivenAI for 14 days. Explore AI-powered research, content creation, advertising and marketing automation.' },
  monthly:    { id: 'monthly',    name: 'Monthly',     priceInclVat: 29,  days: 0,   months: 1,  credits: 1750,  instalments: 1,
    description: 'Get full access to OrivenAI for one month. Plan, research, create and manage your marketing from one workspace.' },
  quarterly:  { id: 'quarterly',  name: 'Quarterly',   priceInclVat: 78,  days: 0,   months: 3,  credits: 4800,  instalments: 3,
    description: 'Get full access to OrivenAI for three months. Build and improve your marketing strategy with AI-powered research, content creation and campaign tools.' },
  semiannual: { id: 'semiannual', name: 'Semi-Annual', priceInclVat: 143, days: 0,   months: 6,  credits: 8850,  instalments: 6,
    description: 'Get full access to OrivenAI for six months. Manage and improve your marketing with AI-powered tools for research, content creation, campaigns and automation.' },
  annual:     { id: 'annual',     name: 'Annual',      priceInclVat: 245, days: 0,   months: 12, credits: 15000, instalments: 12,
    description: 'Get full access to OrivenAI for twelve months. Get a complete year of AI-powered marketing tools to research, plan, create and manage your campaigns.' },
};
Object.keys(PLANS).forEach((id) => { PLANS[id].stripePriceId = STRIPE_PRICE_IDS[id]; });

// A Stripe Price ID: "price_" and Stripe's id characters. Placeholders,
// product ids (prod_…) and anything else are refused.
const STRIPE_PRICE_ID_RE = /^price_[A-Za-z0-9]{8,64}$/;
class PricingConfigError extends Error {
  constructor(planId, problem) {
    super('Stripe price for plan "' + planId + '" is not configured correctly: ' + problem + ' (environment STRIPE_PRICE_' + (PRICE_ENV[planId] || String(planId).toUpperCase()) + '_' + (STRIPE_MODE === 'live' ? 'LIVE' : 'TEST') + ', see services/pricing.js).');
    this.code = 'PRICE_NOT_CONFIGURED'; this.planId = planId; this.problem = problem;
  }
}
// Pure: what's wrong with a configured Price ID, or null when it looks right.
function priceIdProblem(id) {
  if (!id || typeof id !== 'string' || !id.trim()) return 'missing';
  if (/PASTE_|_HERE$/i.test(id)) return 'still the placeholder';
  if (/^prod_/.test(id)) return 'a product id (prod_…) — use the price id (price_…)';
  if (!STRIPE_PRICE_ID_RE.test(id)) return 'not a Stripe price id (expected price_…)';
  return null;
}
// The plan's Stripe Price ID, or a PricingConfigError. Never falls back to
// another plan or price.
function stripePriceIdFor(planId) {
  const plan = PLANS[planId];
  if (!plan) throw new PricingConfigError(String(planId), 'unknown plan');
  const problem = priceIdProblem(plan.stripePriceId);
  if (problem) throw new PricingConfigError(planId, problem);
  return plan.stripePriceId;
}
// Every plan's configuration state (startup log, tests, admin checks).
function stripePriceStatus() {
  return PLAN_ORDER.map((id) => ({ planId: id, priceId: PLANS[id].stripePriceId, problem: priceIdProblem(PLANS[id].stripePriceId) }));
}
const PLAN_ORDER = ['flex', 'monthly', 'quarterly', 'semiannual', 'annual'];

// Credit cost of every paid action (server-enforced; creditManager.FEATURE_COSTS).
const FEATURE_COSTS = {
  ai_chat:              30,  // assistant message: the first model call
  ai_chat_step:         30,  // each further model call in the same message (tool use), max 2
  research_report:      90,  // Research: 3 web searches + one long synthesis
  ai_analysis:          45,  // "Analyze with AI" on Meta/ads data
  campaign_generation:  65,  // campaign/concepts/ad copy generation
  campaign_improvement: 25,  // copy, email, deck, poster, infographic, variations, improve, score, recommendations
  audience_generation:  25,  // registered, no dedicated endpoint
  product_analysis:     25,  // registered, no dedicated endpoint
  competitor_analysis:  30,  // competitor intelligence, market research, opportunities
  brand_voice:          35,  // brand core, brand check
  website_analysis:     35,  // website monitor, business website refresh
  web_generation:       20,  // landing page HTML (Qwen coder)
  image_generation:     55,  // one image (ad image, product shoot, logo)
  video_generation:    180,  // one 5-second video
  video_generation_10s: 350, // one 10-second video
  automation:           20,  // new automation (rule or schedule); no AI cost — usage control only
};

// Assistant (chat) limits that bound the cost of one message.
const CHAT_LIMITS = { maxModelCalls: 3, historyTurns: 10, historyTurnChars: 2000, maxTokens: 1000 };

// Statuses that mean "this account bought access". 'paid' = the period plans;
// starter/creator/professional = legacy monthly subscriptions, honoured until
// they end (no new legacy subscriptions can be bought).
const PAID_STATUSES = ['paid', 'starter', 'creator', 'professional'];
const LEGACY_PLANS = ['starter', 'creator', 'professional'];
// Legacy allowances per paid invoice (their existing contract).
const LEGACY_ALLOWANCES = { starter: 1000, creator: 2500, professional: 4000 };
const LEGACY_GRACE_DAYS = 3; // legacy access runs to the paid period end + this, so a late renewal doesn't cut off a customer

const round2 = (n) => Math.round(n * 100) / 100;
function planById(id) { return Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null; }
function priceInclVatCents(plan) { return Math.round(plan.priceInclVat * 100); }
function priceExVat(plan) { return round2(plan.priceInclVat / (1 + VAT_RATE)); }
function vatAmount(plan) { return round2(plan.priceInclVat - plan.priceInclVat / (1 + VAT_RATE)); }
function aiBudget(plan) { return round2(plan.priceInclVat / (1 + VAT_RATE) * AI_COST_SHARE); }
function creditsPerInstalment(plan) { return plan.credits / plan.instalments; }
// Access end for a period starting at `start` (Date): calendar months, or days.
function accessEnd(plan, start) {
  const d = new Date(start.getTime());
  if (plan.months) {
    const day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + plan.months);
    if (d.getUTCDate() < day) d.setUTCDate(0); // 31 Jan + 1 month = 28/29 Feb, like Postgres
  }
  if (plan.days) d.setUTCDate(d.getUTCDate() + plan.days);
  return d;
}
// Whether a profile row currently has paid access (time-based, never the
// status label alone).
function hasAccess(profile, now) {
  if (!profile || !PAID_STATUSES.includes(profile.subscription_status || '')) return false;
  if (!profile.access_expires_at) return false;
  return new Date(profile.access_expires_at).getTime() > (now || Date.now());
}
// Customer-facing labels: "€29" and "1 month" / "14 days".
function priceLabel(plan) { return '€' + (Number.isInteger(plan.priceInclVat) ? plan.priceInclVat : plan.priceInclVat.toFixed(2)); }
function periodLabel(plan) {
  if (plan.days) return plan.days + ' days';
  return plan.months === 1 ? '1 month' : plan.months + ' months';
}
// Public, display-ready plan list (also served by GET /api/pricing).
function publicPlans() {
  return PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    return {
      id, name: p.name, description: p.description, priceInclVat: p.priceInclVat, priceExVat: priceExVat(p), vatRate: VAT_RATE, currency: CURRENCY,
      months: p.months, days: p.days, credits: p.credits, instalments: p.instalments, creditsPerInstalment: creditsPerInstalment(p),
    };
  });
}

module.exports = {
  VAT_RATE, CURRENCY, AI_COST_SHARE, PLANNING_COST_PER_CREDIT_EUR,
  PLANS, PLAN_ORDER, FEATURE_COSTS, CHAT_LIMITS,
  PAID_STATUSES, LEGACY_PLANS, LEGACY_ALLOWANCES, LEGACY_GRACE_DAYS,
  STRIPE_PRICE_IDS, STRIPE_PRICE_ID_RE, STRIPE_MODE, PRICE_ENV, PRICE_ENV_ALIASES, priceEnvNameFor, stripeMode, priceIdsForMode, PricingConfigError, priceIdProblem, stripePriceIdFor, stripePriceStatus,
  planById, priceInclVatCents, priceExVat, vatAmount, aiBudget, creditsPerInstalment, accessEnd, hasAccess, publicPlans, priceLabel, periodLabel,
};
