-- ═══════════════════════════════════════════════════════════════════
-- Onboarding & activation (2026-10)
--
-- Additive only. No existing row is changed: existing values of
-- onboarding_completed / primary_goal stay exactly as they are, and no
-- backfill runs. Welcome-screen eligibility is decided server-side from
-- profiles.created_at (services/onboarding.js, ONBOARDING_V2_SINCE), so
-- historical accounts are never shown the new onboarding.
--
-- The backend tolerates this migration not being applied yet: onboarding
-- still works, only the timestamps and activation events are not stored.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Onboarding milestones on the profile ───────────────────────────
--    onboarding_completed_at  when the welcome screen was answered/skipped
--    first_value_at           first successful Create or Research result
--    first_value_kind         'create' | 'research'
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_value_at          timestamptz,
  ADD COLUMN IF NOT EXISTS first_value_kind        text;

-- 2. Activation events ──────────────────────────────────────────────
-- js/tracking.js has always written to an `events` table that was never
-- created. Writes now go through POST /api/events (service role) only;
-- props holds short allowlisted tokens (goal, action, plan, ...), never
-- prompts, business details, tokens or payment data.
CREATE TABLE IF NOT EXISTS public.events (
  id          bigserial PRIMARY KEY,
  event_name  text NOT NULL,
  user_id     uuid,
  session_id  text,
  props       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_name_created_idx ON public.events (event_name, created_at);
CREATE INDEX IF NOT EXISTS events_user_idx         ON public.events (user_id, created_at);
CREATE INDEX IF NOT EXISTS events_session_idx      ON public.events (session_id);

-- No client policies and no privileges for browser roles: only the service
-- role (backend) reads or writes.
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.events FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.events_id_seq FROM anon, authenticated;

-- ── Funnel queries (reference) ─────────────────────────────────────
-- Signup → onboarding shown → goal selected → started → paywall → checkout:
--   SELECT event_name, count(DISTINCT user_id) FROM events
--    WHERE created_at >= now() - interval '30 days'
--      AND event_name IN ('created_account','onboarding_shown','onboarding_goal_selected',
--                         'create_started','research_started','paywall_shown',
--                         'checkout_started','checkout_completed')
--    GROUP BY 1;
-- Signup → first successful result:
--   SELECT first_value_kind, count(*), avg(first_value_at - created_at)
--     FROM profiles WHERE first_value_at IS NOT NULL GROUP BY 1;
