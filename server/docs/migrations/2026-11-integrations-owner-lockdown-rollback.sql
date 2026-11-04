-- ═══════════════════════════════════════════════════════════════════
-- ROLLBACK for 2026-11-integrations-owner-lockdown.sql — EMERGENCY ONLY
--
-- Run as the owner of public.integrations (the same role that ran the
-- lockdown). Restores Supabase's default browser grants (ALL for anon and
-- authenticated). Row-level security stays ON: with it, browsers still see
-- no rows unless a policy allows it, so OAuth tokens are not exposed again.
-- (Switching RLS off would expose every customer's tokens to anyone with
-- the public anon key — never do that.)
--
-- Roll back 2026-11-browser-write-lockdown.sql first if it is applied: it
-- expects integrations locked. No data is changed. One transaction.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE v_owner oid;
BEGIN
  SELECT relowner INTO v_owner FROM pg_class WHERE oid = to_regclass('public.integrations');
  IF v_owner IS NULL THEN RAISE EXCEPTION 'public.integrations does not exist'; END IF;
  IF NOT pg_has_role(current_user, v_owner, 'USAGE') THEN
    RAISE EXCEPTION 'run as the table owner % (current role: %) — nothing applied', pg_get_userbyid(v_owner), current_user;
  END IF;
END $$;

GRANT ALL ON public.integrations TO anon, authenticated;

COMMIT;
