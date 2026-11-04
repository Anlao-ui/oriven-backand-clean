-- ═══════════════════════════════════════════════════════════════════
-- ROLLBACK for 2026-11-function-privileges.sql
--
-- Restores the state found in production on 2026-11-04 for the three
-- functions that were open: EXECUTE for anon and authenticated on
-- increment_autopilot_usage, increment_campaigns_generated and
-- rls_auto_enable, and increment_autopilot_usage back to SECURITY DEFINER.
-- The credit/purchase functions keep service_role-only EXECUTE (that was
-- already their state before this migration). This REOPENS the issue the
-- migration fixed; use only if a legitimate caller was found that needs it.
-- One transaction.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.proname
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
              AND p.proname IN ('increment_autopilot_usage', 'increment_campaigns_generated', 'rls_auto_enable')
  LOOP
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', f.sig);
      IF f.proname = 'increment_autopilot_usage' THEN
        EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', f.sig);
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'function privileges rollback: could not change % (owned by another role)', f.sig;
    END;
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
