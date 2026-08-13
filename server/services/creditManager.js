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

// ── Autopilot monthly execution allowance — separate from AI Credits.
// Intelligence never had its own cap (it's metered per-operation via
// FEATURE_COSTS.ai_analysis, 5cr, already enforced) so it needs no entry
// here. Autopilot is different: one rule firing a `suggest_only`/
// `require_approval` action calls _generateRecommendation (a real AI call,
// charge:false — background AI is never billed per the existing credit
// architecture), so an unlimited rule count could otherwise generate
// unbounded real AI cost with zero credit-balance signal to the user.
// Starter has no Autopilot at all (existing autopilotEligible gate).
// Creator: capped, not unlimited -- ~200/mo is roughly 6-7 active rules
// firing at the existing "at most once/day/rule" ceiling (server.js
// _evaluateAutomationRules), which comfortably covers real usage while
// keeping Creator's worst-case background AI cost a small fraction of the
// plan's price. Professional: Infinity -- no separate monthly cap, per
// the plan's "Unlimited" positioning (the underlying per-operation credit
// economy still applies wherever a route already charges credits).
const PLAN_AUTOPILOT_LIMITS = { starter: 0, creator: 200, professional: Infinity };

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
// Provisions (or re-provisions) a user's credit cycle for a plan. This is
// the ONE place credits_balance/credits_cycle_start/credits_cycle_end get
// written from -- called from every place subscription_status can become
// or remain a paid plan: the Stripe webhooks (checkout completed, invoice
// paid, subscription updated) AND the DB-only fallback paths in
// /api/schedule-plan-change that change subscription_status without a
// real Stripe event to anchor to (server.js). That second category was
// the actual root cause of a plan showing "creator" with credits_balance:0,
// credits_cycle_end:null -- subscription_status was written directly with
// no code path that ever provisioned a cycle for it.
//
// Idempotent by construction: skips the write if credits_cycle_end already
// equals the target cycle end, so a duplicate delivery of the same Stripe
// webhook event (Stripe's documented at-least-once delivery) or a second
// call for the same billing period never grants credits twice.
async function provisionCreditsForCycle(userId, plan, cycleStartISO, cycleEndISO, source) {
  _assertInitialized();
  const allowance = PLAN_ALLOWANCES[plan];
  if (allowance == null) return { provisioned: false, reason: 'no allowance for plan ' + plan };

  const { data: profile, error: readErr } = await supabaseAdmin
    .from('profiles').select('credits_cycle_end').eq('id', userId).maybeSingle();
  if (readErr) throw readErr;

  if (profile && profile.credits_cycle_end && cycleEndISO &&
      new Date(profile.credits_cycle_end).getTime() === new Date(cycleEndISO).getTime()) {
    return { provisioned: false, reason: 'already provisioned for this cycle' };
  }

  const { error } = await supabaseAdmin.from('profiles').update({
    credits_balance: allowance,
    credits_cycle_start: cycleStartISO,
    credits_cycle_end: cycleEndISO,
    credits_last_reset_source: source,
  }).eq('id', userId);
  if (error) throw error;
  console.log(`[creditManager] Provisioned ${allowance} credits for user ${userId} (plan: ${plan}, source: ${source})`);
  return { provisioned: true, allowance };
}

// A placeholder 30-day cycle, used only when there's no real Stripe period
// to anchor to (the DB-only fallback paths, and the one-time repair
// below). Matches the exact convention checkout.session.completed already
// used for the same "corrected by the next real invoice" reasoning.
function _placeholderCycle() {
  const start = new Date();
  const end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

async function getCreditStatus(userId) {
  _assertInitialized();
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('credits_balance, credits_cycle_end, subscription_status')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  let plan = (data && data.subscription_status) || 'free';
  let allowance = PLAN_ALLOWANCES[plan] || 0;
  let balance = data ? data.credits_balance : 0;
  let resetDate = data ? data.credits_cycle_end : null;

  // One-time repair: a paid plan with no cycle_end at all means this
  // account's subscription_status was written by a code path that never
  // provisioned a credit cycle (the bug this function exists to fix).
  // This does NOT re-run on every load/status-check -- once provisioned,
  // credits_cycle_end is no longer null, so this branch is never reached
  // again for this account. Never fires for free/unpaid accounts (no
  // allowance to provision), and never touches an already-provisioned
  // balance regardless of its value (a real 0 after real spending is not
  // this condition -- only a genuinely never-provisioned NULL cycle is).
  if (data && !data.credits_cycle_end && allowance > 0) {
    try {
      const cyc = _placeholderCycle();
      const result = await provisionCreditsForCycle(userId, plan, cyc.startISO, cyc.endISO, 'repair');
      if (result.provisioned) {
        balance = result.allowance;
        resetDate = cyc.endISO;
      }
    } catch (err) {
      console.warn('[creditManager] One-time cycle repair failed for', userId, ':', err.message);
    }
  }

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

  // Autopilot usage — separate allowance from AI Credits (see
  // PLAN_AUTOPILOT_LIMITS above for why). Read-only here; the actual
  // increment happens in checkAndIncrementAutopilotUsage, called from the
  // automation engine itself (server.js _evaluateAutomationRules), not
  // from this status read.
  const autopilotLimit = PLAN_AUTOPILOT_LIMITS[plan];
  let autopilotUsed = 0;
  if (autopilotLimit > 0 && autopilotLimit !== Infinity) {
    try {
      const { data: apRow } = await supabaseAdmin
        .from('profiles')
        .select('autopilot_executions_used, autopilot_cycle_reset_at')
        .eq('id', userId)
        .maybeSingle();
      const cycleExpired = !apRow || !apRow.autopilot_cycle_reset_at || new Date(apRow.autopilot_cycle_reset_at) < new Date();
      autopilotUsed = cycleExpired ? 0 : (apRow.autopilot_executions_used || 0);
    } catch (err) {
      console.warn('[creditManager] Failed to read autopilot usage:', err.message);
    }
  }

  return {
    balance,
    monthlyAllowance: allowance,
    usedThisMonth: Math.max(0, allowance - balance),
    resetDate,
    plan,
    lifetimeUsed,
    // Canonical per-action costs -- the one source the frontend reads for
    // any "this will cost N credits" display, so a price change here never
    // needs a matching frontend edit.
    featureCosts: FEATURE_COSTS,
    autopilotUsage: {
      used: autopilotUsed,
      limit: autopilotLimit === Infinity ? null : autopilotLimit, // null = unlimited, matches resetDate's null-means-n/a convention
    },
  };
}

// Called from the automation engine (server.js _evaluateAutomationRules)
// immediately before a rule is actually allowed to fire. Mirrors
// reserveCredits' shape (throws on rejection) but tracks a separate
// counter -- Autopilot executions are not paid for with AI Credits today
// (background AI stays charge:false per the existing architecture), so
// without this check Creator's rule count would be the only ceiling on
// real AI cost, and there is none.
//
// Requires two columns on `profiles` this migration adds:
//   autopilot_executions_used   integer NOT NULL DEFAULT 0
//   autopilot_cycle_reset_at    timestamptz
// and this RPC (mirrors spend_credits' atomic row-lock pattern):
//
// CREATE OR REPLACE FUNCTION increment_autopilot_usage(p_user_id uuid, p_limit integer, p_cycle_end timestamptz)
// RETURNS TABLE(ok boolean, used integer) LANGUAGE plpgsql AS $$
// DECLARE v_used integer; v_reset_at timestamptz;
// BEGIN
//   SELECT autopilot_executions_used, autopilot_cycle_reset_at INTO v_used, v_reset_at
//     FROM profiles WHERE id = p_user_id FOR UPDATE;
//   IF v_reset_at IS NULL OR v_reset_at < now() THEN
//     v_used := 0;
//     UPDATE profiles SET autopilot_executions_used = 0, autopilot_cycle_reset_at = p_cycle_end WHERE id = p_user_id;
//   END IF;
//   IF v_used < p_limit THEN
//     UPDATE profiles SET autopilot_executions_used = autopilot_executions_used + 1 WHERE id = p_user_id;
//     RETURN QUERY SELECT true, v_used + 1;
//   ELSE
//     RETURN QUERY SELECT false, v_used;
//   END IF;
// END; $$;
class AutopilotLimitExceededError extends Error {
  constructor(limit) {
    super(`Autopilot monthly execution limit reached (${limit})`);
    this.name = 'AutopilotLimitExceededError';
    this.limit = limit;
  }
}

async function checkAndIncrementAutopilotUsage(userId, plan, cycleEndISO) {
  _assertInitialized();
  const limit = PLAN_AUTOPILOT_LIMITS[plan] || 0;
  if (limit === Infinity) return { ok: true, used: null, limit: null }; // Professional -- no separate cap
  if (limit <= 0) throw new AutopilotLimitExceededError(0); // Starter -- Autopilot not included at all

  const { data, error } = await supabaseAdmin.rpc('increment_autopilot_usage', {
    p_user_id: userId,
    p_limit: limit,
    p_cycle_end: cycleEndISO || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) throw new AutopilotLimitExceededError(limit);
  return { ok: true, used: row.used, limit };
}

module.exports = {
  init,
  FEATURE_COSTS,
  PLAN_ALLOWANCES,
  PLAN_TEAM_SEATS,
  PLAN_AUTOPILOT_LIMITS,
  InsufficientCreditsError,
  AutopilotLimitExceededError,
  reserveCredits,
  finalizeCreditLog,
  getCreditStatus,
  checkAndIncrementAutopilotUsage,
  provisionCreditsForCycle,
};
