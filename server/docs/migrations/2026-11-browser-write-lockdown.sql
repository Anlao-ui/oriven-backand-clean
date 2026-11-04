-- ═══════════════════════════════════════════════════════════════════
-- Browser permission lockdown (2026-11) — SECURITY FIX
--
-- Problem (production, verified 2026-11-04): Supabase's default privileges
-- give the browser roles anon and authenticated ALL privileges on every table
-- in public. Row-level security narrows SELECT/INSERT/UPDATE/DELETE to the
-- policies, but:
--   • several 2026-09 migrations added write policies for authenticated on
--     automation_rules, campaigns and autopilot_recommendations / _tasks /
--     _workflows, so a signed-in user could write those rows without the
--     backend (e.g. an 'automatic' budget rule without consent, validation or
--     the 50-credit creation charge);
--   • RLS does NOT apply to TRUNCATE: any role with the TRUNCATE privilege
--     can empty a whole table — every customer's rows — in one statement;
--   • a table whose RLS is off is readable in full by every signed-in user
--     (anyone can sign up), and whether RLS is on everywhere in production
--     cannot be guaranteed from the repository;
--   • REFERENCES / TRIGGER / MAINTAIN are never needed by a browser.
--
-- What the app actually does from the browser (frontend, checked
-- 2026-11-05: every supabase-js .from()/.rpc()/.channel()/.storage call and
-- every /rest/v1 URL in js/ and *.html):
--   profiles     SELECT own row
--   brand_cores  SELECT / UPSERT / DELETE own row
--   nothing else — no RPC, no realtime, no storage. The backend uses only
--   the service role (no user-token clients), unaffected by these grants.
--
-- Fix — an allowlist, so nothing depends on per-table RLS being right:
--   1. anon (logged-out visitors): no privileges on any table, view,
--      materialized view or foreign table in public.
--   2. authenticated: no privileges at all, except SELECT on profiles and
--      brand_cores and INSERT/UPDATE/DELETE on brand_cores. Table- and
--      column-level grants both count; TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
--      nowhere.
--   3. profiles and brand_cores must have RLS on (brand_cores: switched on
--      with own-row policies if it was off; profiles: by
--      2026-10-profiles-lockdown.sql). A probe then reads both as
--      authenticated, so a policy that needs a now-revoked table aborts the
--      migration here instead of breaking the app.
--   4. The write policies of the five 2026-09 tables are dropped (their
--      select_own policy is kept; without the privilege it is unused).
--   5. Future tables/sequences created by the role running this file give
--      browsers nothing by default.
-- service_role keeps everything (explicit GRANT, verified at the end).
--
-- TABLE OWNERSHIP. Only an object's owner can remove privileges on it: a
-- REVOKE by any other role only WARNS ("no privileges could be revoked") and
-- changes nothing. Production may have public.integrations (OAuth tokens)
-- owned by supabase_admin, while this file runs as postgres. This file never
-- changes ownership and never skips an object:
--   • pre-flight: if an object it cannot change is still open (or lacks
--     service_role access), it aborts before changing anything, naming the
--     object, its owner and what is open. The owner must lock it first:
--     2026-11-integrations-owner-lockdown.sql.
--   • an object it cannot change that is already locked is left as it is;
--   • self-check: if anything is still open afterwards, it aborts.
-- Either way the whole file is applied, or nothing is.
--
-- No data is changed. Safe to run more than once, also in the same session.
-- One transaction.
-- Order: after 2026-10-profiles-lockdown.sql, 2026-10-access-purchases.sql,
-- 2026-10-onboarding-sessions.sql and 2026-11-account-deletion.sql (it also
-- covers their tables), after 2026-11-integrations-owner-lockdown.sql where
-- that is needed, and only once the new frontend is live
-- (DEPLOYMENT-2026-11.md).
-- Rollback: 2026-11-browser-write-lockdown-rollback.sql
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- Session-only helpers for the steps below (pg_temp; dropped at the end).
-- The only relations browsers may read.
CREATE OR REPLACE FUNCTION pg_temp.lockdown_browser_readable() RETURNS text[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT ARRAY['profiles', 'brand_cores']::text[]
$f$;

-- Every privilege a relation can carry (MAINTAIN exists from Postgres 17).
CREATE OR REPLACE FUNCTION pg_temp.lockdown_privileges() RETURNS text[] LANGUAGE sql STABLE AS $f$
  SELECT ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
         || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN']::text[] ELSE '{}'::text[] END
$f$;

-- One row per browser privilege this lockdown removes that is still there,
-- service_role privilege it keeps that is missing, or browser-readable table
-- without RLS. Empty = locked down.
-- can_manage: the running role owns the relation (or may act as its owner).
CREATE OR REPLACE FUNCTION pg_temp.lockdown_open()
RETURNS TABLE (table_name name, owner name, can_manage boolean, problem text) LANGUAGE sql STABLE AS $f$
  SELECT c.relname, pg_get_userbyid(c.relowner), pg_has_role(current_user, c.relowner, 'USAGE'), r.rolname || ' ' || p.priv
    FROM pg_class c
    CROSS JOIN (SELECT rolname, oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) r
    CROSS JOIN unnest(pg_temp.lockdown_privileges()) AS p(priv)
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     -- a column grant (e.g. SELECT on a token column) is as open as a table grant
     AND CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege(r.oid, c.oid, p.priv)
              ELSE has_table_privilege(r.oid, c.oid, p.priv) END
     AND NOT (r.rolname = 'authenticated' AND p.priv = 'SELECT' AND c.relname = ANY (pg_temp.lockdown_browser_readable()))
     AND NOT (r.rolname = 'authenticated' AND c.relname = 'brand_cores' AND p.priv IN ('INSERT', 'UPDATE', 'DELETE'))
  UNION ALL
  SELECT c.relname, pg_get_userbyid(c.relowner), pg_has_role(current_user, c.relowner, 'USAGE'), 'service_role lacks ' || p.priv
    FROM pg_class c
    CROSS JOIN (SELECT oid FROM pg_roles WHERE rolname = 'service_role') s
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(priv)
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND NOT has_table_privilege(s.oid, c.oid, p.priv)
  UNION ALL
  SELECT c.relname, pg_get_userbyid(c.relowner), pg_has_role(current_user, c.relowner, 'USAGE'), 'row-level security off (browser-readable)'
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     AND c.relname = ANY (pg_temp.lockdown_browser_readable()) AND NOT c.relrowsecurity
     AND c.relname <> 'brand_cores'   -- switched on below when this role owns it
$f$;

-- Pre-flight: stop before changing anything if an object needs a change this
-- role cannot make. RLS and policies (brand_cores and the five 2026-09
-- tables) can only be changed by the owner as well.
DO $$
DECLARE v_blocked text;
BEGIN
  SELECT string_agg(format('%s (owner %s: %s)', table_name, owner, problems), '; ' ORDER BY table_name)
    INTO v_blocked
    FROM (SELECT table_name, owner, string_agg(problem, ', ' ORDER BY problem) AS problems
            FROM (SELECT table_name, owner, problem FROM pg_temp.lockdown_open() WHERE NOT can_manage
                  UNION ALL
                  SELECT c.relname, pg_get_userbyid(c.relowner), 'row-level security / policies'
                    FROM pg_class c
                   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
                     AND c.relname IN ('brand_cores', 'automation_rules', 'campaigns', 'autopilot_recommendations', 'autopilot_tasks', 'autopilot_workflows')
                     AND NOT pg_has_role(current_user, c.relowner, 'USAGE')) x
           GROUP BY table_name, owner) y;
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('browser lockdown blocked — nothing applied. Role %s cannot change: %s', current_user, v_blocked),
      HINT = 'The owner must lock it first (integrations: 2026-11-integrations-owner-lockdown.sql, run as that owner). '
          || 'See DEPLOYMENT-2026-11.md §4.2. Do not change ownership to get past this.';
  END IF;
END $$;

DO $$
DECLARE
  t text;
  v_kind "char";
  v_cols text;
  v_pg17 boolean := current_setting('server_version_num')::int >= 170000;
BEGIN
  -- Objects this role cannot change were verified as already locked above.
  FOR t, v_kind IN SELECT c.relname, c.relkind FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND pg_has_role(current_user, c.relowner, 'USAGE') LOOP
    -- 1. logged-out visitors: nothing
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    -- 2. signed-in browsers: nothing, except reading profiles/brand_cores and writing brand_cores
    IF t = ANY (pg_temp.lockdown_browser_readable()) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated', t);
      IF v_pg17 THEN EXECUTE format('REVOKE MAINTAIN ON public.%I FROM authenticated', t); END IF;
      IF t <> 'brand_cores' THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
      END IF;
    ELSE
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
    -- the backend keeps full access to every table
    IF v_kind IN ('r', 'p') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END IF;
  END LOOP;

  -- Column-level grants survive a table-level REVOKE: remove them too.
  FOR t, v_cols IN
    SELECT c.relname, string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND pg_has_role(current_user, c.relowner, 'USAGE')
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attnum > 0 AND NOT x.attisdropped AND x.attacl IS NOT NULL)
     GROUP BY c.relname LOOP
    EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON public.%2$I FROM anon', v_cols, t);
    IF t = 'brand_cores' THEN
      EXECUTE format('REVOKE REFERENCES (%1$s) ON public.%2$I FROM authenticated', v_cols, t);
    ELSIF t = ANY (pg_temp.lockdown_browser_readable()) THEN
      EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON public.%2$I FROM authenticated', v_cols, t);
    ELSE
      EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON public.%2$I FROM authenticated', v_cols, t);
    END IF;
  END LOOP;

  -- 3. brand_cores: the one table browsers write. Make sure RLS limits it to the own row.
  IF to_regclass('public.brand_cores') IS NOT NULL THEN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.brand_cores'::regclass) THEN
      ALTER TABLE public.brand_cores ENABLE ROW LEVEL SECURITY;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brand_cores') THEN
      CREATE POLICY brand_cores_select_own ON public.brand_cores FOR SELECT TO authenticated USING (auth.uid() = user_id);
      CREATE POLICY brand_cores_insert_own ON public.brand_cores FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
      CREATE POLICY brand_cores_update_own ON public.brand_cores FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
      CREATE POLICY brand_cores_delete_own ON public.brand_cores FOR DELETE TO authenticated USING (auth.uid() = user_id);
    END IF;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.brand_cores TO authenticated;
  END IF;

  -- 4. Write policies of the 2026-09 tables: dropped. Their select_own policy
  --    is kept (unused without the privilege; the rollback relies on it).
  FOREACH t IN ARRAY ARRAY['automation_rules', 'campaigns', 'autopilot_recommendations', 'autopilot_tasks', 'autopilot_workflows'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_own', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_own', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (auth.uid() = user_id)', t || '_select_own', t);
  END LOOP;
END $$;

-- Self-check: abort the whole migration (nothing applied) if any browser
-- privilege is left, the backend lost access anywhere, or a browser-readable
-- table has RLS off.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(table_name || ' (' || problem || ', owner ' || owner || ')', '; ' ORDER BY table_name, problem)
    INTO v_left
    FROM (SELECT table_name, owner, problem FROM pg_temp.lockdown_open()
          UNION ALL
          SELECT c.relname, pg_get_userbyid(c.relowner), 'row-level security off (browser-readable)'
            FROM pg_class c WHERE c.oid = to_regclass('public.brand_cores') AND NOT c.relrowsecurity
          UNION ALL
          -- the frontend reads its own row: without a SELECT policy it would silently see nothing
          SELECT c.relname, pg_get_userbyid(c.relowner), 'no SELECT policy for signed-in users (the app could not read its own row)'
            FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname = ANY (pg_temp.lockdown_browser_readable())
             AND NOT EXISTS (SELECT 1 FROM pg_policies pp WHERE pp.schemaname = 'public' AND pp.tablename = c.relname
                                AND pp.cmd IN ('SELECT', 'ALL') AND pp.roles && ARRAY['public', 'authenticated']::name[])) x;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'browser lockdown incomplete — nothing applied. Still open: %', v_left;
  END IF;
END $$;

-- Probe: what the frontend reads still works as a signed-in browser. A
-- policy on profiles/brand_cores that reads a table browsers may no longer
-- read would fail here ("permission denied"), aborting the migration.
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'authenticated', 'MEMBER') THEN
    RAISE EXCEPTION 'browser lockdown: role % cannot act as authenticated to probe the frontend reads — run as postgres (nothing applied)', current_user;
  END IF;
  SET LOCAL ROLE authenticated;
  IF to_regclass('public.profiles') IS NOT NULL THEN PERFORM count(*) FROM public.profiles; END IF;
  IF to_regclass('public.brand_cores') IS NOT NULL THEN PERFORM count(*) FROM public.brand_cores; END IF;
  RESET ROLE;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'browser lockdown: a signed-in browser could no longer read profiles/brand_cores (%) — a policy on them uses another table; nothing applied', SQLERRM;
END $$;

-- 5. Objects created later by this role give browsers nothing by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

DROP FUNCTION pg_temp.lockdown_open();
DROP FUNCTION pg_temp.lockdown_privileges();
DROP FUNCTION pg_temp.lockdown_browser_readable();

COMMIT;

-- ── Verify (read-only): docs/verification/2026-11-pending-migrations-verify.sql
--   blocks 6–9 (expect: anon nothing; authenticated SELECT only on profiles
--   and brand_cores, plus INSERT/UPDATE/DELETE on brand_cores; no TRUNCATE
--   anywhere; integrations: false for anon and authenticated, true for
--   service_role).
