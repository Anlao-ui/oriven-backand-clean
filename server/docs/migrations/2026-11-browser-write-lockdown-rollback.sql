-- ═══════════════════════════════════════════════════════════════════
-- ROLLBACK for 2026-11-browser-write-lockdown.sql
--
-- Restores Supabase's default browser privileges (ALL for anon and
-- authenticated on the tables in public) and the 2026-09 write policies of
-- automation_rules, campaigns and autopilot_*. This REOPENS the security
-- issues the lockdown fixed (browser writes bypassing the backend, TRUNCATE
-- of whole tables). Use only if the lockdown broke something essential, and
-- re-apply the lockdown once that is fixed.
--
-- profiles is left alone (its write lockdown is 2026-10-profiles-lockdown.sql)
-- and so are the brand_cores policies (harmless, own-row only). No data is
-- changed. One transaction.
--
-- Tables this role does not own (e.g. integrations owned by supabase_admin,
-- locked by 2026-11-integrations-owner-lockdown.sql) are left locked and
-- listed in a NOTICE: only their owner can reopen them, with that file's own
-- rollback — and integrations (OAuth tokens) should stay locked.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE t text; v_skipped text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname <> 'profiles'
              AND pg_has_role(current_user, c.relowner, 'USAGE') LOOP
    EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
  END LOOP;
  SELECT string_agg(c.relname || ' (owner ' || pg_get_userbyid(c.relowner) || ')', ', ' ORDER BY c.relname) INTO v_skipped
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relname <> 'profiles'
     AND NOT pg_has_role(current_user, c.relowner, 'USAGE');
  IF v_skipped IS NOT NULL THEN
    RAISE NOTICE 'left locked (not owned by %): %', current_user, v_skipped;
  END IF;
  FOREACH t IN ARRAY ARRAY['automation_rules', 'campaigns', 'autopilot_recommendations', 'autopilot_tasks', 'autopilot_workflows'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (auth.uid() = user_id)', t || '_insert_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)', t || '_update_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (auth.uid() = user_id)', t || '_delete_own', t);
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

COMMIT;
