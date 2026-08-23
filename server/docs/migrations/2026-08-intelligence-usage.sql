-- ============================================================================
-- Oriven Intelligence Usage migration
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change).
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / CREATE OR
-- REPLACE / idempotent REVOKE-GRANT pairs).
--
-- WHY THIS IS NEEDED: creditManager.js's checkAndIncrementIntelligenceUsage()
-- has always called supabase.rpc('increment_intelligence_usage', ...) — the
-- required columns/function were fully specified in a code comment there,
-- but (unlike spend_credits, migrated in 2026-08-credit-economy.sql) this
-- one was never actually applied to the database. Every "Analyze"/
-- "Re-analyze" call in AI Analysis (POST /api/meta/analyze,
-- POST /api/ads/analyze) hits this before the ai_analysis credit charge and
-- fails with PostgREST's "Could not find the function public.
-- increment_intelligence_usage(...) in the schema cache" — the credit
-- manager itself is correct and current; only this one function was
-- missing. increment_autopilot_usage (the sibling used by Autopilot's
-- separate execution-count cap) has the exact same gap and is NOT part of
-- this migration — Autopilot's caller currently fails open (logs a warning
-- and allows the execution) so it's silent rather than user-facing; it's
-- flagged separately, out of scope for this fix.
-- ============================================================================

-- ── 1. profiles — monthly Intelligence-analysis counter + cycle anchor ────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS intelligence_analyses_used   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intelligence_cycle_reset_at  timestamptz;

-- ── 2. increment_intelligence_usage — row-locked, resets on a stale cycle ──
-- Same shape as the code comment in creditManager.js this replaces, with
-- the same security hardening spend_credits already has (this function is
-- reachable via PostgREST/RPC like any public-schema function by default;
-- restricting it to service_role means only the backend's trusted
-- Supabase client — never a signed-in user's own token — can call it,
-- and a caller can only ever increment their own row regardless).
CREATE OR REPLACE FUNCTION increment_intelligence_usage(p_user_id uuid, p_limit integer, p_cycle_end timestamptz)
RETURNS TABLE(ok boolean, used integer) LANGUAGE plpgsql AS $$
DECLARE v_used integer; v_reset_at timestamptz;
BEGIN
  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'increment_intelligence_usage: caller may only increment their own usage';
  END IF;

  SELECT intelligence_analyses_used, intelligence_cycle_reset_at INTO v_used, v_reset_at
    FROM profiles WHERE id = p_user_id FOR UPDATE;

  IF v_reset_at IS NULL OR v_reset_at < now() THEN
    v_used := 0;
    UPDATE profiles SET intelligence_analyses_used = 0, intelligence_cycle_reset_at = p_cycle_end WHERE id = p_user_id;
  END IF;

  IF v_used < p_limit THEN
    UPDATE profiles SET intelligence_analyses_used = intelligence_analyses_used + 1 WHERE id = p_user_id;
    RETURN QUERY SELECT true, v_used + 1;
  ELSE
    RETURN QUERY SELECT false, v_used;
  END IF;
END; $$;

REVOKE ALL ON FUNCTION increment_intelligence_usage(uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_intelligence_usage(uuid, integer, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION increment_intelligence_usage(uuid, integer, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_intelligence_usage(uuid, integer, timestamptz) TO service_role;
