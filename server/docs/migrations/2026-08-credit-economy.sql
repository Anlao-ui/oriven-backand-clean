-- ============================================================================
-- Oriven Credit Economy migration
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change: profiles,
-- automation_rules, intelligence_events, etc. were all added this way).
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / CREATE OR REPLACE).
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
-- succeed and drive the balance negative.
CREATE OR REPLACE FUNCTION spend_credits(p_user_id uuid, p_amount integer)
RETURNS TABLE(ok boolean, balance integer) LANGUAGE plpgsql AS $$
BEGIN
  UPDATE profiles SET credits_balance = credits_balance - p_amount
    WHERE id = p_user_id AND credits_balance >= p_amount;
  IF FOUND THEN
    RETURN QUERY SELECT true, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  ELSE
    RETURN QUERY SELECT false, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  END IF;
END; $$;
