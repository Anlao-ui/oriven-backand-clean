-- ═══════════════════════════════════════════════════════════════════
-- integrations: browser lockdown, run AS THE TABLE OWNER (2026-11)
--
-- public.integrations holds every customer's ad-platform OAuth access and
-- refresh tokens. The browser never uses this table (frontend checked
-- 2026-11-04: it only touches profiles and brand_cores); the backend reads
-- and writes it as service_role.
--
-- Why a separate file: only a table's owner can remove privileges on it. A
-- REVOKE by any other role only warns ("no privileges could be revoked") and
-- changes nothing. Production verification (block 4) may show integrations
-- owned by supabase_admin, while the SQL Editor runs as postgres.
-- 2026-11-browser-write-lockdown.sql then refuses to run (pre-flight, nothing
-- applied) until this file has locked integrations.
--
-- WHO RUNS IT — the owner of public.integrations. Check (read-only):
--   SELECT pg_get_userbyid(relowner) AS owner, current_user,
--          pg_has_role(current_user, relowner, 'USAGE') AS can_manage
--     FROM pg_class WHERE oid = 'public.integrations'::regclass;
--   • can_manage = true  → NOT needed: the main lockdown handles integrations.
--     (Running it anyway is harmless.)
--   • owner = supabase_admin, can_manage = false → only Supabase can run SQL
--     as supabase_admin (the SQL Editor cannot). Send this exact file to
--     Supabase support and ask them to run it as supabase_admin, unchanged.
--   • any other owner → run it as that role (SET ROLE <owner>; if the SQL
--     Editor role is allowed to, otherwise that role's own connection).
-- If it is run by anyone else it aborts and names the owner.
--
-- What it does — and does not do:
--   1. anon, authenticated and PUBLIC lose every privilege on integrations,
--      table- and column-level: no reading tokens, no writes, no TRUNCATE,
--      no MAINTAIN (Postgres 17+).
--   2. Row-level security on (defence in depth: should a browser grant ever
--      come back, no policy lets a row through). service_role bypasses RLS;
--      no app code reads this table as another role.
--   3. service_role: ALL (the backend keeps its access).
--   4. Self-check: aborts, nothing applied, if anything stays open.
--   It does NOT change ownership, policies, columns or data.
--
-- Safe to run more than once. One transaction.
-- Order: any time before 2026-11-browser-write-lockdown.sql.
-- Rollback: 2026-11-integrations-owner-lockdown-rollback.sql (emergency only).
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE v_owner oid;
BEGIN
  SELECT relowner INTO v_owner FROM pg_class WHERE oid = to_regclass('public.integrations');
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'public.integrations does not exist — nothing to do';
  END IF;
  IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
    RAISE EXCEPTION USING
      MESSAGE = format('integrations lockdown must run as the table owner %s (current role: %s) — nothing applied',
                       pg_get_userbyid(v_owner), current_user),
      HINT = 'Owner supabase_admin: ask Supabase support to run this file as supabase_admin. Do not change ownership to get past this.';
  END IF;
END $$;

REVOKE ALL ON public.integrations FROM PUBLIC, anon, authenticated;

-- Column-level grants survive a table-level REVOKE: remove them too.
DO $$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.integrations'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON public.integrations FROM PUBLIC, anon, authenticated', v_cols);
END $$;

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.integrations TO service_role;

DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(problem, ', ' ORDER BY problem) INTO v_left FROM (
    SELECT r.rolname || ' ' || p.priv AS problem
      FROM (SELECT rolname, oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                        || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE '{}'::text[] END) AS p(priv)
     WHERE CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                THEN has_any_column_privilege(r.oid, 'public.integrations'::regclass, p.priv)
                ELSE has_table_privilege(r.oid, 'public.integrations'::regclass, p.priv) END
    UNION ALL
    SELECT 'service_role lacks ' || p.priv
      FROM (SELECT oid FROM pg_roles WHERE rolname = 'service_role') s
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(priv)
     WHERE NOT has_table_privilege(s.oid, 'public.integrations'::regclass, p.priv)
    UNION ALL
    SELECT 'row-level security off' WHERE NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.integrations'::regclass)
  ) x;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'integrations lockdown incomplete — nothing applied. Still open: %', v_left;
  END IF;
END $$;

COMMIT;

-- ── Verify (read-only): docs/verification/2026-11-pending-migrations-verify.sql
--   block 6, integrations: false everywhere for anon and authenticated, true for service_role.
