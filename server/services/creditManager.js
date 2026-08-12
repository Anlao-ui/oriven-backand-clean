// ════════════════════════════════════════════════════════════════
// Oriven Credit Manager
//
// Single source of truth for AI feature costs, plan allowances, and
// credit deduction/logging. Every AI route calls reserveCredits()
// BEFORE the (expensive) provider call and finalizeCreditLog() AFTER
// it completes (success or failure) — two explicit calls, not one
// wrapping middleware, because token usage for the log is only known
// once the provider response comes back, while the balance check must
// happen before the call runs.
//
// featureKey is NOT the same axis as modelRouter's taskType — a task
// type like 'text-copy' is reused by both a 1-credit chat helper and a
// 5-credit account-analysis call, so cost is always priced off the
// caller-supplied featureKey, never inferred from the AI task type.
// ════════════════════════════════════════════════════════════════

const crypto = require('crypto');

// No client of its own -- server.js is the one place SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY get read, after dotenv has loaded them. That
// existing supabaseAdmin instance is handed in via init() (called once,
// right after server.js creates it) so the whole app shares exactly one
// Supabase connection instead of a second one racing dotenv at import time.
let supabaseAdmin = null;
function init(sharedSupabaseAdmin) {
  supabaseAdmin = sharedSupabaseAdmin;
}

// ── Feature costs — "suggested values" from the pricing brief, reflecting
// user value delivered, not raw token cost. Change a price here, nowhere else.
const FEATURE_COSTS = {
  ai_chat:              1,
  ai_analysis:           5,
  campaign_improvement: 10,
  audience_generation:  10,   // registered — no dedicated AI endpoint yet, see server.js wiring notes
  product_analysis:     10,   // registered — no dedicated AI endpoint yet, see server.js wiring notes
  competitor_analysis:  15,
  brand_voice:          20,
  campaign_generation:  25,
  website_analysis:     30,
  image_generation:     40,
  video_generation:    120,
};

// ── Plan allowances / seats — the other half of the pricing brief's config.
const PLAN_ALLOWANCES = { starter: 500, creator: 3000, professional: 12000 };
const PLAN_TEAM_SEATS  = { starter: 1,   creator: 1,    professional: 10   };

class InsufficientCreditsError extends Error {
  constructor(cost, balance) {
    super(`Insufficient credits: need ${cost}, have ${balance == null ? '?' : balance}`);
    this.name = 'InsufficientCreditsError';
    this.cost = cost;
    this.balance = balance;
  }
}

function _assertFeatureKey(featureKey) {
  if (!(featureKey in FEATURE_COSTS)) {
    throw new Error(`[creditManager] Unknown featureKey "${featureKey}"`);
  }
}

function _assertInitialized() {
  if (!supabaseAdmin) {
    throw new Error('[creditManager] init(supabaseAdmin) was not called before use -- server.js must call creditManager.init(supabaseAdmin) once, after its own Supabase client is created.');
  }
}

// Called BEFORE the AI call. charge:true (default) atomically checks+deducts
// via the spend_credits RPC and throws InsufficientCreditsError if the
// balance is too low. charge:false (background/cron calls) never touches
// the balance — it still returns a reservation so finalizeCreditLog can
// log the attempt with charged:false for cost observability.
async function reserveCredits(user, featureKey, opts) {
  opts = opts || {};
  const charge = opts.charge !== false;
  _assertInitialized();
  _assertFeatureKey(featureKey);
  const cost = FEATURE_COSTS[featureKey];
  const requestId = crypto.randomUUID();

  if (!charge) {
    return { requestId, cost, charged: false, userId: user && user.id };
  }
  if (!user || !user.id) {
    throw new Error('[creditManager] reserveCredits requires an authenticated user when charge=true');
  }

  const { data, error } = await supabaseAdmin.rpc('spend_credits', {
    p_user_id: user.id,
    p_amount: cost,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) {
    throw new InsufficientCreditsError(cost, row && row.balance);
  }
  return { requestId, cost, charged: true, userId: user.id };
}

// Called AFTER the AI call (success or failure), via try/finally. Always
// writes one row to credit_transactions regardless of charge outcome.
async function finalizeCreditLog(reservation, featureKey, info) {
  info = info || {};
  if (!reservation) return;
  _assertInitialized();
  const { error } = await supabaseAdmin.from('credit_transactions').insert({
    user_id:       reservation.userId,
    feature_key:   featureKey,
    route:         info.route || null,
    credits_cost:  reservation.cost,
    charged:       !!reservation.charged,
    provider:      info.provider || null,
    model:         info.model || null,
    tokens_in:     info.tokensIn == null ? null : info.tokensIn,
    tokens_out:    info.tokensOut == null ? null : info.tokensOut,
    success:       !!info.success,
    error_message: info.error || null,
    request_id:    reservation.requestId,
  });
  if (error) console.warn('[creditManager] Failed to log transaction:', error.message);
}

// Reads the real, backend-authoritative credit status for a user — backs
// GET /api/credits/status, consumed by usage.js and settings.js.
async function getCreditStatus(userId) {
  _assertInitialized();
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('credits_balance, credits_cycle_end, subscription_status')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  const plan = (data && data.subscription_status) || 'free';
  const allowance = PLAN_ALLOWANCES[plan] || 0;
  const balance = data ? data.credits_balance : 0;

  // Lifetime usage — credit_transactions is the only authoritative source
  // (append-only ledger, never derived from a UI counter). Summing
  // credits_cost across every charged:true row is the real total ever
  // spent, independent of the current billing cycle or balance resets.
  // A query failure here must not break the rest of the status payload —
  // the caller gets `lifetimeUsed: null` and the frontend shows a loading/
  // unavailable state rather than a fabricated number (Part 11).
  let lifetimeUsed = null;
  try {
    const { data: lifetimeRows, error: lifetimeErr } = await supabaseAdmin
      .from('credit_transactions')
      .select('credits_cost')
      .eq('user_id', userId)
      .eq('charged', true);
    if (lifetimeErr) throw lifetimeErr;
    lifetimeUsed = (lifetimeRows || []).reduce((sum, row) => sum + (row.credits_cost || 0), 0);
  } catch (err) {
    console.warn('[creditManager] Failed to compute lifetime usage:', err.message);
  }

  return {
    balance,
    monthlyAllowance: allowance,
    usedThisMonth: Math.max(0, allowance - balance),
    resetDate: data ? data.credits_cycle_end : null,
    plan,
    lifetimeUsed,
  };
}

module.exports = {
  init,
  FEATURE_COSTS,
  PLAN_ALLOWANCES,
  PLAN_TEAM_SEATS,
  InsufficientCreditsError,
  reserveCredits,
  finalizeCreditLog,
  getCreditStatus,
};
