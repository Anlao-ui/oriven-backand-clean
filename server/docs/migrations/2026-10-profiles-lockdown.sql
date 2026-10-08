-- ═══════════════════════════════════════════════════════════════════
-- profiles lockdown (2026-10) — SECURITY FIX
--
-- Problem: RLS on public.profiles only checks auth.uid() = id, and the
-- `authenticated` role has table-wide UPDATE. A signed-in user could change
-- ANY column of their own row through the Supabase API — credits_balance,
-- subscription_status, stripe_customer_id, credits_cycle_end, pending_plan,
-- free_campaign_used_at, onboarding state, and so on.
--
-- Fix: browsers keep READ access to their own row (RLS, unchanged) and lose
-- ALL write access. Every write the app needs now goes through the backend
-- (service role, unaffected by these grants):
--   onboarding completion   → POST /api/onboarding/complete
--   missing profile row     → POST /api/profile/ensure (insert-only)
--   free_campaign_used      → written by the backend on a successful build
--   preferences             → PUT /api/user/preferences (already backend)
-- The frontend in this release no longer writes profiles at all.
--
-- ORDER: apply AFTER the new backend is live (it creates profiles at signup
-- and serves /api/profile/ensure). The current production backend does NOT
-- create profiles at signup — the browser does — so applying this before the
-- backend deploy would leave new sign-ups without a profile row.
--
-- Changes no data. Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Keep row-level security on.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 2. No table-wide write privileges for browser roles. SELECT is kept
--    (RLS still limits it to the user's own row).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.profiles FROM anon, authenticated;

-- 3. Also remove any column-level write grants (a table-level REVOKE does not
--    remove grants made per column).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
  LOOP
    EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON public.profiles FROM anon, authenticated', c);
  END LOOP;
END $$;

-- The existing "update own profile" policy is left in place; without the
-- UPDATE privilege it can no longer be used. It can be dropped later once
-- you've confirmed nothing needs it:
--   DROP POLICY "<policy name>" ON public.profiles;
