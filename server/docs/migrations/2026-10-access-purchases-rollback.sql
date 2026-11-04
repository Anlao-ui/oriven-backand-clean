-- ════════════════════════════════════════════════════════════════
-- ROLLBACK for 2026-10-access-purchases.sql
--
-- Restores the previous spend_credits() and ensure_free_daily_cycle() (the
-- free daily top-up, exactly as in 2026-08-free-plan.sql) and removes the
-- new purchase/instalment/expiry functions. Purchase, grant and ledger
-- RECORDS are kept (they are the payment history) and so are the new
-- profiles columns; nothing a customer paid for is deleted. After a
-- rollback, also deploy the previous backend (it ignores these tables).
--
-- Also removed: the legacy-entitlement functions (_legacy_protected,
-- refresh_legacy_entitlements, update_legacy_entitlement). The tables
-- legacy_entitlements and legacy_transition_snapshot are KEPT (audit trail).
--
-- Credits: this file changes no balance. Be aware that the restored free
-- daily top-up resets a free account's balance to the daily allowance at its
-- next cycle — the pre-migration behaviour. legacy_transition_snapshot holds
-- every balance as it was before the migration.
--
-- Privileges: the restored functions get EXECUTE for service_role only
-- (PUBLIC, anon and authenticated revoked), as before the migration.
-- One transaction: applies completely or not at all.
-- ════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS refresh_legacy_entitlements();
DROP FUNCTION IF EXISTS update_legacy_entitlement(uuid, text, timestamptz, text);
DROP FUNCTION IF EXISTS fulfill_purchase(uuid, text, text, text, integer, integer, text);
DROP FUNCTION IF EXISTS grant_due_credit_instalments(integer);
DROP FUNCTION IF EXISTS expire_access(integer);
DROP FUNCTION IF EXISTS revoke_purchase(uuid, text, text);
DROP FUNCTION IF EXISTS _end_access(uuid, text);
-- after the restored spend_credits below no longer calls it

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
DROP FUNCTION IF EXISTS _legacy_protected(uuid);

COMMIT;

NOTIFY pgrst, 'reload schema';
