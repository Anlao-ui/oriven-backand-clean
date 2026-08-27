-- ============================================================================
-- Oriven Free Plan migration
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change).
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / CREATE OR
-- REPLACE / idempotent REVOKE-GRANT pairs).
--
-- PREREQUISITE: apply docs/migrations/2026-08-intelligence-usage.sql FIRST
-- if you haven't already — confirmed via `select proname from pg_proc where
-- proname='increment_intelligence_usage'` that it is NOT currently live.
-- Without it, Intelligence analysis (POST /api/meta/analyze,
-- POST /api/ads/analyze) fails for every plan, not just Free — this Free
-- Plan migration builds PLAN_INTELLIGENCE_LIMITS.free=1 on top of that same
-- RPC, so it needs to actually exist first.
--
-- WHAT THIS ADDS:
--   1. profiles.free_campaign_used_at — anchors the existing one-time
--      onboarding-generation bypass (requireSubOrOnboardingGen, server.js)
--      to a rolling 24h window instead of "once, ever". The existing
--      boolean free_campaign_used is untouched (still set on first use, for
--      any other reader that depends on its original "has this account ever
--      generated anything" meaning).
--   2. ensure_free_daily_cycle() — the atomic, row-locked check that resets
--      a Free-plan profile's credits_balance/credits_cycle_start/
--      credits_cycle_end back to a fresh 20-credit/1-day allowance once the
--      previous cycle has expired. Callable directly (used by
--      getCreditStatus() so a returning user sees the fresh balance without
--      needing to spend anything first) and internally by spend_credits
--      below (so every ordinary credit-consuming action self-heals the
--      cycle too). No-ops instantly for any non-'free' plan or an
--      unexpired cycle — this cannot re-grant credits to a paid plan or
--      reset a Free user's balance mid-day.
--   3. spend_credits() — CREATE OR REPLACE, same (p_user_id, p_amount)
--      signature paid-plan callers already use untouched, plus two new
--      OPTIONAL parameters (p_free_allowance, p_free_cycle_days) so
--      creditManager.js stays the single source of truth for the 20/1
--      numbers rather than duplicating them as SQL defaults nobody updates.
--      Existing behavior for starter/creator/professional is byte-for-byte
--      identical to docs/migrations/2026-08-credit-economy.sql's version;
--      the only addition is one PERFORM call at the top, gated so it's a
--      no-op unless the row is actually a Free-plan profile with an expired
--      cycle.
-- ============================================================================

-- ── 1. profiles — daily-generation-bypass anchor ──────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS free_campaign_used_at timestamptz;

-- ── 2. ensure_free_daily_cycle — atomic Free-plan daily credit reset ──────
-- SELECT ... FOR UPDATE locks the profile row for the rest of this
-- transaction. Under concurrent calls for the same user, Postgres
-- serializes on that lock: the first caller to acquire it (after the cycle
-- has genuinely expired) performs the reset and commits; every other
-- concurrent caller then acquires the lock afterward, sees the now-fresh
-- (non-expired) credits_cycle_end, and takes no action. This is what makes
-- "a burst of simultaneous requests" incapable of granting more than one
-- daily allocation — the guarantee lives in the database transaction, not
-- in any read-then-write sequence in Node.
CREATE OR REPLACE FUNCTION ensure_free_daily_cycle(
  p_user_id uuid,
  p_allowance integer DEFAULT 20,
  p_cycle_days integer DEFAULT 1
)
RETURNS TABLE(balance integer, cycle_end timestamptz, reset boolean)
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_balance integer;
  v_cycle_end timestamptz;
BEGIN
  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'ensure_free_daily_cycle: caller may only touch their own cycle';
  END IF;

  SELECT subscription_status, credits_balance, credits_cycle_end
    INTO v_status, v_balance, v_cycle_end
    FROM profiles WHERE id = p_user_id FOR UPDATE;

  IF v_status = 'free' AND (v_cycle_end IS NULL OR v_cycle_end < now()) THEN
    v_cycle_end := now() + (p_cycle_days || ' days')::interval;
    UPDATE profiles SET
      credits_balance            = p_allowance,
      credits_cycle_start        = now(),
      credits_cycle_end          = v_cycle_end,
      credits_provisioned_plan   = 'free',
      credits_last_reset_source  = 'daily_free'
    WHERE id = p_user_id;
    RETURN QUERY SELECT p_allowance, v_cycle_end, true;
  ELSE
    RETURN QUERY SELECT v_balance, v_cycle_end, false;
  END IF;
END; $$;

REVOKE ALL ON FUNCTION ensure_free_daily_cycle(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ensure_free_daily_cycle(uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION ensure_free_daily_cycle(uuid, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION ensure_free_daily_cycle(uuid, integer, integer) TO service_role;

-- ── 3. spend_credits — additive parameters, one new signature ─────────────
-- Identical to docs/migrations/2026-08-credit-economy.sql's version except
-- for the two new optional parameters and the single PERFORM line below.
-- Existing callers (creditManager.js reserveCredits, which now passes the
-- two new params explicitly) and any other paid-plan call path are
-- unaffected: ensure_free_daily_cycle only ever touches a row whose
-- subscription_status is literally 'free'.
--
-- IMPORTANT: adding parameters changes the function's signature, so
-- `CREATE OR REPLACE` alone would leave the OLD 2-arg spend_credits(uuid,
-- integer) sitting alongside the new 4-arg one as a separate overload
-- (Postgres resolves overloads by full signature, not just name) — any
-- future caller that invoked the 2-arg form would silently skip the
-- free-cycle-reset logic. The explicit DROP below guarantees exactly one
-- spend_credits function exists after this migration runs.
DROP FUNCTION IF EXISTS spend_credits(uuid, integer);
CREATE OR REPLACE FUNCTION spend_credits(
  p_user_id uuid,
  p_amount integer,
  p_free_allowance integer DEFAULT 20,
  p_free_cycle_days integer DEFAULT 1
)
RETURNS TABLE(ok boolean, balance integer) LANGUAGE plpgsql AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'spend_credits: p_amount must be greater than 0 (got %)', p_amount;
  END IF;

  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'spend_credits: caller may only spend their own credits';
  END IF;

  PERFORM ensure_free_daily_cycle(p_user_id, p_free_allowance, p_free_cycle_days);

  UPDATE profiles SET credits_balance = credits_balance - p_amount
    WHERE id = p_user_id AND credits_balance >= p_amount;
  IF FOUND THEN
    RETURN QUERY SELECT true, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  ELSE
    RETURN QUERY SELECT false, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  END IF;
END; $$;

REVOKE ALL ON FUNCTION spend_credits(uuid, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION spend_credits(uuid, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION spend_credits(uuid, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION spend_credits(uuid, integer, integer, integer) TO service_role;

-- NOTE: Postgres treats a change in parameter count/defaults as a distinct
-- overload resolution, not a silent signature replacement -- if PostgREST's
-- schema cache still resolves calls to the OLD 2-arg spend_credits(uuid,
-- integer) after this runs, ask it to reload: NOTIFY pgrst, 'reload schema';
-- (safe to run unconditionally, idempotent, this is Supabase's documented
-- way to force PostgREST to pick up a function signature change immediately
-- instead of waiting for its own cache TTL).
NOTIFY pgrst, 'reload schema';
