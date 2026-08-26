-- ============================================================================
-- Oriven refund_credits migration
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change, e.g.
-- 2026-08-credit-economy.sql, 2026-08-intelligence-usage.sql).
-- Safe to re-run: CREATE OR REPLACE keeps this rerunnable; the REVOKE/GRANT
-- statements below are idempotent too.
--
-- WHY THIS IS NEEDED: creditManager.js's reserveCredits() charges credits
-- via spend_credits() BEFORE the AI provider call runs. If that call then
-- fails because the provider (AIML) is genuinely unavailable -- rate-limited
-- (429) or down (5xx) -- after server.js's own retries are exhausted, the
-- generation never happened but the credits were already spent. Until this
-- migration is applied, creditManager.refundCredits() (added alongside this
-- file) will fail with "Could not find the function public.refund_credits"
-- -- caught and logged, not fatal, but the user's credits stay unrefunded
-- until this is run. Same failure shape as increment_intelligence_usage's
-- missing migration before it (see 2026-08-intelligence-usage.sql).
-- ============================================================================

-- ── refund_credits — atomic, symmetric reversal of spend_credits ──────────
-- Row-locked conditional UPDATE, same concurrency-safety property as
-- spend_credits: under concurrent calls, Postgres serializes on the row
-- lock, so two concurrent refunds (or a refund racing a spend) can never
-- interleave into a lost update. Deliberately does NOT cap the resulting
-- balance against any upper bound -- a user's true balance should always
-- reflect exactly what they were charged minus what's been genuinely
-- refunded, never clamped or reset.
CREATE OR REPLACE FUNCTION refund_credits(p_user_id uuid, p_amount integer)
RETURNS TABLE(ok boolean, balance integer) LANGUAGE plpgsql AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'refund_credits: p_amount must be greater than 0 (got %)', p_amount;
  END IF;

  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'refund_credits: caller may only refund their own credits';
  END IF;

  UPDATE profiles SET credits_balance = credits_balance + p_amount
    WHERE id = p_user_id;
  IF FOUND THEN
    RETURN QUERY SELECT true, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  ELSE
    RETURN QUERY SELECT false, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  END IF;
END; $$;

-- Same hardening as spend_credits — Supabase auto-exposes every public-
-- schema function to PostgREST with EXECUTE granted to PUBLIC by default;
-- without this, any signed-in user could call refund_credits(<someone
-- else's uuid>, amount) directly over the REST API and top up an arbitrary
-- account. The backend only ever calls this through the service-role
-- client, never the anon/user-scoped one, so this is a pure hardening step
-- with no behavior change for the real call path.
REVOKE ALL ON FUNCTION refund_credits(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION refund_credits(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION refund_credits(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION refund_credits(uuid, integer) TO service_role;
