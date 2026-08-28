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
//
// ── REQUIRED MIGRATION — credits_provisioned_plan ──────────────────
// New column this file's self-heal logic depends on (see getCreditStatus
// and provisionCreditsForCycle below). Records which plan the account's
// CURRENT credits_balance/cycle was actually granted for, independent of
// whatever profiles.subscription_status says right now -- this is what
// lets getCreditStatus() detect and correct a stale balance left over
// from an earlier plan-change bug, without ever re-resetting a correctly
// provisioned account on an ordinary page load.
//
//   ALTER TABLE profiles ADD COLUMN credits_provisioned_plan text;
//
//   -- Safe backfill: for every OTHER existing paid account, assume its
//   -- current balance already belongs to its current plan (a no-op for
//   -- anyone not exhibiting the bug -- this does NOT change their
//   -- balance, only labels it).
//   UPDATE profiles SET credits_provisioned_plan = subscription_status
//     WHERE subscription_status IN ('starter','creator','professional')
//       AND credits_provisioned_plan IS NULL;
//
//   -- Targeted repair for a SPECIFIC known-affected account (e.g. the
//   -- Professional account reported showing a stale ~3000 balance) --
//   -- run this AFTER the backfill above, substituting the real user id
//   -- or email, so it isn't silently marked "already correct" by the
//   -- blanket backfill:
//   UPDATE profiles
//     SET credits_balance = 12000,
//         credits_cycle_start = now(),
//         credits_cycle_end = now() + interval '30 days',
//         credits_provisioned_plan = 'professional',
//         credits_last_reset_source = 'repair'
//     WHERE id = '<affected-user-id>'; -- or WHERE email = '<affected-user-email>'
//
// Once the column exists, getCreditStatus() also self-heals this exact
// case automatically on next load for ANY account where
// credits_provisioned_plan != subscription_status -- the targeted UPDATE
// above is only needed if an immediate fix is wanted without waiting for
// the account owner's next request.
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
// image_generation/video_generation double as "Image Ad"/"Video Ad" in the
// pricing brief's terms — the app doesn't distinguish "ad image" from
// "logo image" at the cost-table level, so these two buckets are shared by
// every image/video generation route (logo, product shoots, UGC video,
// motion graphics, video ads, generic image/video).
const FEATURE_COSTS = {
  ai_chat:              5,   // "AI Chat" — 5 credits / message
  ai_analysis:          25,  // "Intelligence" — 25 credits / analysis
  campaign_improvement: 10,
  audience_generation:  10,   // registered — no dedicated AI endpoint yet, see server.js wiring notes
  product_analysis:     10,   // registered — no dedicated AI endpoint yet, see server.js wiring notes
  competitor_analysis:  15,
  brand_voice:          20,
  campaign_generation:  25,
  website_analysis:     30,
  image_generation:     75,   // "Image Ad" — 75 credits
  video_generation:    200,   // "Video Ad" — 200 credits
  autopilot:            25,   // "Autopilot" — 25 credits / execution (see _evaluateAutomationRules)
};

// ── Plan allowances / seats — the other half of the pricing brief's config.
// free: 10 credits, resetting every 24h (not a monthly cycle like the paid
// plans) — see ensure_free_daily_cycle in docs/migrations/2026-08-free-plan.sql
// and FREE_PLAN_CYCLE_DAYS below. Free is an in-app exploration/trial state
// (not a public pricing tier, see plans.js) meant to let a new user explore
// the product and accumulate enough credits for an occasional full
// generation, not to sustain daily full-campaign generation — campaign_
// generation (25cr) and image_generation (75cr) both individually exceed
// this 10-credit allowance, so it is deliberately NOT meant to cover a full
// generation on its own; it covers smaller metered actions (chat, copy
// rewrites, audience/competitor analysis) between generations, which build
// up toward one over a few days. The one-time onboarding-generation bypass
// (requireSubOrOnboardingGen, server.js) still separately covers the very
// first campaign, right after onboarding.
const PLAN_ALLOWANCES = { free: 10, starter: 1000, creator: 2500, professional: 4000 };
const FREE_PLAN_CYCLE_DAYS = 1;
const PLAN_TEAM_SEATS  = { starter: 1,   creator: 1,    professional: 10   };

// ── Intelligence monthly analysis allowance — separate cap layered on top
// of the existing FEATURE_COSTS.ai_analysis (25cr) credit charge, not a
// replacement for it. Applies specifically to the explicit "Analyze with
// AI" action (server.js POST /api/meta/analyze, /api/ads/analyze) — the
// only two routes that actually charge ai_analysis credits; the read-only
// /api/intelligence/* dashboard routes (home/briefing/opportunities/etc.)
// are a different, already-unmetered concept (Live Feed/summary views) and
// are not affected by this cap.
// free: 1 analysis/MONTH — deliberately its own, independent cycle, not
// tied to the daily AI-credit cycle (a daily Intelligence allowance would
// be far more generous than Free's exploration positioning intends). The
// profiles table already tracks Intelligence's reset boundary in its own
// column (intelligence_cycle_reset_at, entirely separate from credits_
// cycle_end), so no schema change was needed to make this monthly while
// credits stay daily — see checkAndIncrementIntelligenceUsage below, which
// hands the RPC a rolling ~30-day boundary for the 'free' plan specifically
// instead of reusing ensure_free_daily_cycle's daily cycle_end. Reuses the
// exact same increment_intelligence_usage RPC as the paid plans — no
// second counter.
const PLAN_INTELLIGENCE_LIMITS = { free: 1, starter: 40, creator: 100, professional: Infinity };

// ── Autopilot monthly execution allowance — separate from, and in addition
// to, AI Credits. Autopilot executions now DO consume AI Credits
// (FEATURE_COSTS.autopilot, reserved in server.js _evaluateAutomationRules
// right before a rule is allowed to fire) — this cap is a second, harder
// ceiling on top of the credit economy, not a replacement for it, because
// an unlimited rule count could otherwise burn through a user's whole
// credit balance via unattended background firings with no per-click
// confirmation. Starter has no Autopilot at all (existing autopilotEligible
// gate). Creator: capped, not unlimited -- 10/mo, revised down from an
// earlier 200/mo per explicit product decision to keep Creator's plan-card
// number small and legible (10 executions is plenty for the "1-2 active
// rules" realistic Creator usage pattern, still comfortably inside the "at
// most once/day/rule" ceiling in server.js _evaluateAutomationRules).
// Professional: Infinity -- no separate monthly execution-count cap, per
// the plan's "Unlimited" positioning, but Professional's shared credit
// balance still gates real spend (FEATURE_COSTS.autopilot still applies).
// free: 0 -- Autopilot is not included at all, same as Starter. Written
// explicitly (rather than relying on the `|| 0` fallback in
// checkAndIncrementAutopilotUsage/requireAutopilotAccess) so it's documented
// alongside every other plan's real number, not implied by an absence.
const PLAN_AUTOPILOT_LIMITS = { free: 0, starter: 0, creator: 10, professional: Infinity };

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

  // p_free_allowance/p_free_cycle_days are only ever acted on by the RPC
  // when this user's own subscription_status is 'free' (see
  // ensure_free_daily_cycle) -- passed on every call, harmless no-op for
  // paid plans, so PLAN_ALLOWANCES.free stays the single source of truth
  // instead of duplicating "20" as a SQL-side default nobody updates.
  const { data, error } = await supabaseAdmin.rpc('spend_credits', {
    p_user_id: user.id,
    p_amount: cost,
    p_free_allowance: PLAN_ALLOWANCES.free,
    p_free_cycle_days: FREE_PLAN_CYCLE_DAYS,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) {
    throw new InsufficientCreditsError(cost, row && row.balance);
  }
  return { requestId, cost, charged: true, userId: user.id };
}

// Called when a charged operation ultimately fails after the provider
// stays unavailable through _request()'s own retries (see aimlProvider.js)
// -- gives the reserved credits back via the symmetric refund_credits RPC
// (see docs/migrations/2026-08-refund-credits.sql) rather than silently
// keeping them for work that never happened. A no-op (returns false,
// throws nothing extra) for a reservation that was never actually
// charged (charge:false background calls, or one that already failed to
// reserve) -- callers should still wrap this in try/catch since the RPC
// itself can throw (e.g. not yet migrated -- same defensive pattern as
// every other RPC call in this file).
async function refundCredits(reservation) {
  if (!reservation || !reservation.charged || !reservation.userId) return false;
  _assertInitialized();
  const { data, error } = await supabaseAdmin.rpc('refund_credits', {
    p_user_id: reservation.userId,
    p_amount: reservation.cost,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return !!(row && row.ok);
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
// opts.previousPlan: the plan on record BEFORE this call's caller changed
// subscription_status (callers that change plan must capture it first and
// pass it here). Root-caused bug this parameter fixes: Stripe does not
// reset current_period_end on a plain `items.update` price swap (e.g.
// Creator -> Professional), so a genuine mid-cycle upgrade can carry the
// exact same cycleEndISO as the account's last (Creator) provision. The
// cycle_end-only idempotency check below would then treat the upgrade as
// "already provisioned for this cycle" and silently skip granting the new
// plan's allowance, leaving Professional accounts stuck showing whatever
// balance Creator had left (observed: showing 3000-ish instead of 12000).
// A plan change is never a duplicate of a prior grant regardless of
// whether the billing period boundary happens to coincide.
async function provisionCreditsForCycle(userId, plan, cycleStartISO, cycleEndISO, source, opts) {
  opts = opts || {};
  _assertInitialized();
  const allowance = PLAN_ALLOWANCES[plan];
  if (allowance == null) return { provisioned: false, reason: 'no allowance for plan ' + plan };

  const { data: profile, error: readErr } = await supabaseAdmin
    .from('profiles').select('credits_cycle_end, credits_provisioned_plan').eq('id', userId).maybeSingle();
  if (readErr) throw readErr;

  // planUnchanged checks BOTH the caller-supplied opts.previousPlan (set by
  // callers that know they're mid-transition, e.g. the subscription.updated
  // webhook) AND the stored credits_provisioned_plan -- the plan this
  // account's CURRENT balance was actually granted for, independent of
  // whatever subscription_status says right now. The second check is what
  // makes this self-healing: if subscription_status was ever changed by a
  // path that didn't call this function (a bug, a manual DB edit, or a race
  // before this column existed), credits_provisioned_plan stays stale and
  // this comparison alone is enough to trigger a correct reprovision the
  // next time anything calls this function for the account -- no separate
  // "is credits_cycle_end null" heuristic needed, which is what let a
  // Professional account with a real (non-null) cycle_end keep showing a
  // stale Creator-era balance indefinitely.
  const priorPlan = (profile && profile.credits_provisioned_plan) || opts.previousPlan || null;
  const planUnchanged = !priorPlan || priorPlan === plan;
  if (profile && profile.credits_cycle_end && cycleEndISO && planUnchanged &&
      new Date(profile.credits_cycle_end).getTime() === new Date(cycleEndISO).getTime()) {
    return { provisioned: false, reason: 'already provisioned for this cycle' };
  }

  const { error } = await supabaseAdmin.from('profiles').update({
    credits_balance: allowance,
    credits_cycle_start: cycleStartISO,
    credits_cycle_end: cycleEndISO,
    credits_last_reset_source: source,
    credits_provisioned_plan: plan,
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
    .select('credits_balance, credits_cycle_end, subscription_status, credits_provisioned_plan, campaigns_generated')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  let plan = (data && data.subscription_status) || 'free';
  let allowance = PLAN_ALLOWANCES[plan] || 0;
  let balance = data ? data.credits_balance : 0;
  let resetDate = data ? data.credits_cycle_end : null;

  // Free plan: reset atomically in Postgres (ensure_free_daily_cycle, see
  // docs/migrations/2026-08-free-plan.sql), not the paid-plan self-heal
  // block below -- that block calls provisionCreditsForCycle, a non-atomic
  // Node read-then-write with a 30-day placeholder cycle, wrong on both
  // counts for a plan that resets daily and must stay concurrency-safe.
  // Calling this here (not just inside spend_credits) means a returning
  // Free user sees their fresh 20 credits the moment the dashboard loads,
  // not only after their next spend. Falls through to the same
  // lifetimeUsed/savedAssets computation every other plan gets below --
  // Free users get the same real status payload, just a different balance
  // source.
  if (plan === 'free') {
    try {
      const { data: freshRows, error: freshErr } = await supabaseAdmin.rpc('ensure_free_daily_cycle', {
        p_user_id: userId,
        p_allowance: PLAN_ALLOWANCES.free,
        p_cycle_days: FREE_PLAN_CYCLE_DAYS,
      });
      if (freshErr) throw freshErr;
      const freshRow = Array.isArray(freshRows) ? freshRows[0] : freshRows;
      if (freshRow) {
        balance = freshRow.balance;
        resetDate = freshRow.cycle_end;
      }
    } catch (err) {
      console.warn('[creditManager] ensure_free_daily_cycle failed for', userId, ':', err.message);
    }
  }

  // Self-heal: reprovision when either (a) there's no cycle_end at all
  // (subscription_status was written by a path that never provisioned a
  // cycle), or (b) credits_provisioned_plan doesn't match the CURRENT
  // subscription_status (the balance on record was granted for a
  // different plan than the account is on now -- e.g. a Professional
  // account still sitting on a stale Creator-era balance/cycle because an
  // earlier bug or manual DB edit changed subscription_status without
  // ever calling provisionCreditsForCycle). Both branches are self-
  // limiting: once provisioned, credits_provisioned_plan matches
  // subscription_status and cycle_end is non-null, so neither condition
  // fires again until a real plan/cycle change happens -- this does NOT
  // reset credits on every Settings open or page load. Scoped to
  // plan !== 'free' -- Free's own reset lives entirely in
  // ensure_free_daily_cycle above, not this Node-side repair path.
  const neverProvisioned = data && !data.credits_cycle_end;
  const provisionedForWrongPlan = data && data.credits_cycle_end && data.credits_provisioned_plan && data.credits_provisioned_plan !== plan;
  if (plan !== 'free' && (neverProvisioned || provisionedForWrongPlan) && allowance > 0) {
    try {
      const cyc = _placeholderCycle();
      const result = await provisionCreditsForCycle(userId, plan, cyc.startISO, cyc.endISO, 'repair', { previousPlan: data.credits_provisioned_plan });
      if (result.provisioned) {
        balance = result.allowance;
        resetDate = cyc.endISO;
      }
    } catch (err) {
      console.warn('[creditManager] Credit cycle repair failed for', userId, ':', err.message);
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

  // Campaigns Generated -- profiles.campaigns_generated, incremented
  // exactly once per successful /api/generate-campaign call (see
  // incrementCampaignsGenerated below), never per creative_assets row
  // (a single generation writes one creative_assets row PER VARIATION,
  // which would overcount "campaigns" if used directly as the counter).
  const campaignsGenerated = (data && data.campaigns_generated) || 0;

  // Saved Assets -- creative_assets is the one real, already-existing
  // asset library (also used by the Studio/Asset Library page via
  // GET /api/creative/assets) -- a count query here, not that route's
  // 200-row page, so the number stays accurate past 200 assets.
  let savedAssets = 0;
  try {
    const { count: assetCount, error: assetErr } = await supabaseAdmin
      .from('creative_assets')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('archived', false);
    if (assetErr) throw assetErr;
    savedAssets = assetCount || 0;
  } catch (err) {
    console.warn('[creditManager] Failed to count saved assets:', err.message);
  }

  return {
    balance,
    monthlyAllowance: allowance,
    usedThisMonth: Math.max(0, allowance - balance),
    resetDate,
    plan,
    lifetimeUsed,
    campaignsGenerated,
    savedAssets,
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

// Called once from the single canonical success point of a real campaign
// generation (server.js POST /api/generate-campaign, after variations +
// images are produced) -- never on generation-screen open, cancel, or
// failure, since those paths return/throw before this is reached. Uses an
// atomic RPC (mirrors spend_credits/increment_autopilot_usage's row-lock
// pattern) so concurrent generations from the same user can't race and
// undercount.
//
// REQUIRED MIGRATION:
//
//   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS campaigns_generated integer NOT NULL DEFAULT 0;
//
//   CREATE OR REPLACE FUNCTION increment_campaigns_generated(p_user_id uuid)
//   RETURNS integer LANGUAGE plpgsql AS $$
//   DECLARE v_count integer;
//   BEGIN
//     UPDATE profiles SET campaigns_generated = campaigns_generated + 1
//       WHERE id = p_user_id
//       RETURNING campaigns_generated INTO v_count;
//     RETURN v_count;
//   END; $$;
async function incrementCampaignsGenerated(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabaseAdmin.rpc('increment_campaigns_generated', { p_user_id: userId });
    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('[creditManager] Failed to increment campaigns_generated for', userId, ':', err.message);
    return null;
  }
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

// Called from the two real "Analyze with AI" routes (server.js
// POST /api/meta/analyze, POST /api/ads/analyze), immediately before
// reserveCredits('ai_analysis') runs -- mirrors checkAndIncrementAutopilotUsage's
// shape and its check-before-call, count-regardless-of-downstream-outcome
// policy (same reasoning as reserveCredits: the request is what's being
// rate-limited, not the parse result). Server-authoritative -- the client
// cannot bypass this by manipulating frontend JS, since it's enforced here
// before any AI provider call is made.
//
// Requires two columns on `profiles` and this RPC, both defined in
// docs/migrations/2026-08-intelligence-usage.sql -- this comment used to
// carry the raw SQL inline (matching autopilot_executions_used/
// autopilot_cycle_reset_at's own convention), but that copy was never
// actually applied to the database (confirmed: PostgREST returns "Could
// not find the function public.increment_intelligence_usage(...) in the
// schema cache" on every call). Apply that migration file by hand via the
// Supabase SQL editor -- see its header for the hardened version (adds an
// auth.role()/auth.uid() guard matching spend_credits' own security
// posture, which this inline comment predated).
class IntelligenceLimitExceededError extends Error {
  constructor(limit) {
    super(`Intelligence monthly analysis limit reached (${limit})`);
    this.name = 'IntelligenceLimitExceededError';
    this.limit = limit;
  }
}

async function checkAndIncrementIntelligenceUsage(userId, plan, cycleEndISO) {
  _assertInitialized();
  // Any plan without a defined cap here is not this function's concern and
  // is left to the existing credit-balance check (reserveCredits) to gate
  // exactly as it already did before this cap existed.
  if (!(plan in PLAN_INTELLIGENCE_LIMITS)) return { ok: true, used: null, limit: null };
  const limit = PLAN_INTELLIGENCE_LIMITS[plan];
  if (limit === Infinity) return { ok: true, used: null, limit: null }; // Professional -- unlimited
  if (!limit || limit <= 0) throw new IntelligenceLimitExceededError(0);

  // Free's Intelligence cap is monthly -- deliberately independent of the
  // daily AI-credit cycle, so it must NOT reuse ensure_free_daily_cycle's
  // daily cycle_end here. increment_intelligence_usage only actually
  // consumes p_cycle_end when profiles.intelligence_cycle_reset_at is null
  // or already expired (i.e. exactly when it's about to reset the counter);
  // an unexpired cycle just increments and ignores this value. So a fresh
  // ~30-day boundary computed on every call is enough to give the RPC the
  // right "next reset" date whenever a reset actually happens, without any
  // extra read -- paid plans are untouched, they keep using the
  // billing-cycle cycleEndISO the caller already passed in.
  let effectiveCycleEnd = cycleEndISO;
  if (plan === 'free') {
    effectiveCycleEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const { data, error } = await supabaseAdmin.rpc('increment_intelligence_usage', {
    p_user_id: userId,
    p_limit: limit,
    p_cycle_end: effectiveCycleEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) throw new IntelligenceLimitExceededError(limit);
  return { ok: true, used: row.used, limit };
}

module.exports = {
  init,
  FEATURE_COSTS,
  PLAN_ALLOWANCES,
  FREE_PLAN_CYCLE_DAYS,
  PLAN_TEAM_SEATS,
  PLAN_AUTOPILOT_LIMITS,
  PLAN_INTELLIGENCE_LIMITS,
  InsufficientCreditsError,
  AutopilotLimitExceededError,
  IntelligenceLimitExceededError,
  reserveCredits,
  refundCredits,
  finalizeCreditLog,
  getCreditStatus,
  checkAndIncrementAutopilotUsage,
  checkAndIncrementIntelligenceUsage,
  provisionCreditsForCycle,
  incrementCampaignsGenerated,
};
