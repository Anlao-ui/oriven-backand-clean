-- ═══════════════════════════════════════════════════════════════════
-- Function privileges (2026-11) — SECURITY FIX
--
-- Problem (production, verified 2026-11-04): Supabase grants EXECUTE on every
-- new function to anon and authenticated by default (besides PUBLIC). Three
-- functions are callable by browsers through /rest/v1/rpc:
--   increment_autopilot_usage(p_user_id, p_limit, p_cycle_end)  SECURITY DEFINER
--     → anyone could raise ANY account's automation counter (and reset its
--       cycle date) with the owner's rights: other customers' automations
--       blocked by an exhausted quota.
--   increment_campaigns_generated(p_user_id)
--     → anyone could change any account's campaign counter (as invoker RLS
--       limits it to the caller's own row, still a direct write).
--   rls_auto_enable()                                           SECURITY DEFINER
--     → an event-trigger helper (enables RLS on new tables). Not meant to be
--       called by anyone; an event trigger does not need EXECUTE for the
--       roles whose DDL fires it.
--
-- Callers (checked 2026-11-04): only the backend, with the service role
-- (services/creditManager.js: increment_campaigns_generated,
-- increment_autopilot_usage, increment_intelligence_usage). The frontend
-- calls no RPC at all. No trigger uses these functions as trigger function
-- except rls_auto_enable (event trigger).
--
-- Fix (least privilege, nothing the backend uses is lost):
--   • EXECUTE revoked from PUBLIC, anon, authenticated on every credit/usage
--     function and rls_auto_enable; granted to service_role (except
--     rls_auto_enable, which nobody calls).
--   • increment_autopilot_usage runs as SECURITY INVOKER: the backend's
--     service role already has the table rights it needs, so owner rights
--     are unnecessary.
--   • SECURITY DEFINER functions that stay definer get a fixed search_path.
--   • New functions created later by this role are not executable by
--     browsers unless granted explicitly.
-- Function bodies are not changed. Statements on a function that does not
-- exist are skipped; a statement this role may not run (a function owned by
-- another role, e.g. supabase_admin) is reported as a NOTICE and skipped, so
-- check the verification script afterwards (block 10).
-- Safe to run more than once. One transaction.
-- Rollback: 2026-11-function-privileges-rollback.sql
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  f record;
  backend_fns text[] := ARRAY['increment_autopilot_usage', 'increment_campaigns_generated', 'increment_intelligence_usage',
                              'spend_credits', 'refund_credits', 'ensure_free_daily_cycle', 'analytics_site_summary',
                              'fulfill_purchase', 'grant_due_credit_instalments', 'expire_access', 'revoke_purchase',
                              '_end_access', '_legacy_protected', 'refresh_legacy_entitlements', 'update_legacy_entitlement',
                              'delete_account_data'];
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname, p.prosecdef, p.proconfig
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
              AND (p.proname = ANY (backend_fns) OR p.proname = 'rls_auto_enable')
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
      IF f.proname <> 'rls_auto_enable' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
      END IF;
      IF f.proname = 'increment_autopilot_usage' AND f.prosecdef THEN
        EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER', f.sig);
      ELSIF f.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(f.proconfig, '{}')) c WHERE c LIKE 'search_path=%') THEN
        EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'function privileges: could not change % (owned by another role) — check verification block 10', f.sig;
    END;
  END LOOP;
END $$;

-- Functions created later by this role: no EXECUTE for browsers by default.
-- Postgres grants EXECUTE to PUBLIC on every new function; a per-schema
-- default can only ADD to that, so PUBLIC is revoked globally (for functions
-- this role creates later; existing functions are not affected) and
-- Supabase's per-schema grant to anon/authenticated is revoked in public.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
