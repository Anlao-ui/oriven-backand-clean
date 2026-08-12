-- ============================================================================
-- Oriven Credit Economy migration
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change: profiles,
-- automation_rules, intelligence_events, etc. were all added this way).
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / CREATE OR
-- REPLACE / idempotent REVOKE-GRANT pairs).
-- ============================================================================

-- ── 1. profiles — credit balance, billing-cycle anchor, timezone ──────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS credits_balance           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits_cycle_start       timestamptz,
  ADD COLUMN IF NOT EXISTS credits_cycle_end         timestamptz,
  ADD COLUMN IF NOT EXISTS timezone                  text,
  ADD COLUMN IF NOT EXISTS credits_last_reset_source text;

-- ── 2. credit_transactions — append-only audit log, never the balance source ─
CREATE TABLE IF NOT EXISTS credit_transactions (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES profiles(id) NOT NULL,
  feature_key   text NOT NULL,
  route         text,
  credits_cost  integer NOT NULL,
  charged       boolean NOT NULL,
  provider      text,
  model         text,
  tokens_in     integer,
  tokens_out    integer,
  success       boolean NOT NULL,
  error_message text,
  request_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_transactions_user_idx ON credit_transactions(user_id, created_at DESC);

-- ── 3. platform_analysis_cache — collapses cron + on-demand analysis ──────
CREATE TABLE IF NOT EXISTS platform_analysis_cache (
  id                bigserial PRIMARY KEY,
  user_id           uuid REFERENCES profiles(id) NOT NULL,
  platform          text NOT NULL,
  date_range        text NOT NULL,
  input_fingerprint text NOT NULL,
  analysis          jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, date_range)
);

-- ── 4. daily_briefing_cache — once per user-local calendar day ────────────
CREATE TABLE IF NOT EXISTS daily_briefing_cache (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES profiles(id) NOT NULL,
  local_date    date NOT NULL,
  timezone_used text NOT NULL,
  content       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date)
);

-- ── 5. support_messages — Priority Support chat (flat per-user thread) ────
CREATE TABLE IF NOT EXISTS support_messages (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES profiles(id) NOT NULL,
  sender        text NOT NULL CHECK (sender IN ('user','admin')),
  body          text NOT NULL,
  read_by_user  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_user_idx ON support_messages(user_id, created_at);

-- ── 6. spend_credits — atomic, race-safe guarded decrement ────────────────
-- Row-locked conditional UPDATE: under concurrent calls, Postgres serializes
-- on the row lock, so it's impossible for two concurrent spends to both
-- succeed and drive the balance negative. Unchanged from the original.
--
-- Hardening added on pre-launch review (CREATE OR REPLACE keeps this
-- rerunnable; the REVOKE/GRANT statements below are idempotent too — safe
-- to apply repeatedly):
--   1. p_amount must be > 0 — rejects zero/negative amounts outright, so
--      the function can never be used to top up a balance or as a no-op
--      lock probe. A bad amount is a caller bug and should fail loudly
--      (creditManager.js already does `if (error) throw error;` on the
--      RPC response, so this surfaces as a real 500, not a silent no-op).
--   2. Execution restricted to service_role — Supabase auto-exposes every
--      public-schema function to PostgREST with EXECUTE granted to
--      PUBLIC (and therefore anon/authenticated) by default. Without an
--      explicit REVOKE, any signed-in user could call
--      spend_credits(<someone_else's uuid>, amount) directly over the
--      REST API and drain another user's balance — p_user_id is just a
--      plain argument with nothing stopping a caller from passing an
--      arbitrary uuid. The backend (creditManager.js) only ever calls
--      this through the service-role Supabase client, never the anon/
--      user-scoped client, so this is a pure hardening step with no
--      behavior change for the real call path.
--   3. Defense-in-depth self-check — even if grants are ever loosened
--      later, a non-service_role caller can still only spend their own
--      credits: p_user_id must equal auth.uid(). Under service_role,
--      auth.uid() is NULL (no end-user JWT context on that connection),
--      so this check is skipped entirely for the real, trusted call path
--      and only guards the hypothetical case where the function becomes
--      reachable by 'authenticated' again.
CREATE OR REPLACE FUNCTION spend_credits(p_user_id uuid, p_amount integer)
RETURNS TABLE(ok boolean, balance integer) LANGUAGE plpgsql AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'spend_credits: p_amount must be greater than 0 (got %)', p_amount;
  END IF;

  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'spend_credits: caller may only spend their own credits';
  END IF;

  UPDATE profiles SET credits_balance = credits_balance - p_amount
    WHERE id = p_user_id AND credits_balance >= p_amount;
  IF FOUND THEN
    RETURN QUERY SELECT true, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  ELSE
    RETURN QUERY SELECT false, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  END IF;
END; $$;

REVOKE ALL ON FUNCTION spend_credits(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION spend_credits(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION spend_credits(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION spend_credits(uuid, integer) TO service_role;
