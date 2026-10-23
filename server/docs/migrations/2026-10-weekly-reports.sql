-- ═══════════════════════════════════════════════════════════════════
-- Weekly AI Performance Report + Priority Support hardening (2026-10)
--
-- 1. weekly_reports — one row per (user, reporting week). The UNIQUE key is
--    what makes a second run, a second process or a retry unable to build
--    (and pay for AI insights) or send the same week's report twice. The
--    validated metrics and insights are stored so a retried send re-uses
--    them instead of calling the AI provider again.
-- 2. support_messages — row-level security on, browser roles revoked. The
--    app only reads/writes this table through the backend (service role);
--    the original migration (2026-08-credit-economy.sql) never enabled RLS.
-- 3. profiles.preferences — ensured (already used by /api/user/preferences;
--    holds language and the weekly-report email preference).
--
-- ORDER: apply BEFORE deploying the backend that serves the weekly report
-- (the job refuses to run while this table is missing, see
-- services/weeklyReport/runner.js). Additive only, changes no data.
-- Safe to run more than once.
--
-- ROLLBACK (only if the feature is withdrawn; deletes stored reports):
--   DROP TABLE IF EXISTS public.weekly_reports;
--   -- support_messages: RLS can stay on (the backend uses the service role).
--   -- To undo anyway: ALTER TABLE public.support_messages DISABLE ROW LEVEL SECURITY;
-- ═══════════════════════════════════════════════════════════════════

-- 1. Weekly reports ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.weekly_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start   date NOT NULL,                 -- Monday of the reported week (user's timezone)
  week_end     date NOT NULL,                 -- the Sunday after it
  timezone     text NOT NULL,                 -- IANA zone the week was computed in
  scope        text NOT NULL DEFAULT 'live' CHECK (scope IN ('live', 'test')),  -- EMAIL_MODE=test rows never block live ones
  status       text NOT NULL DEFAULT 'building'
               CHECK (status IN ('building', 'ready', 'sending', 'sent', 'skipped', 'failed', 'error')),
  attempts     smallint NOT NULL DEFAULT 0,
  lease_until  timestamptz,                   -- a worker holds the row until then
  report       jsonb,                         -- validated metrics (no tokens, no addresses)
  insights     jsonb,                         -- validated AI insights, or NULL
  ai_status    text,                          -- ok | failed | invalid | disabled | not_needed
  error        text,                          -- short code only
  provider_id  text,                          -- Resend email id
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  UNIQUE (user_id, week_start, scope),
  CHECK (week_end = week_start + 6)
);
CREATE INDEX IF NOT EXISTS weekly_reports_status_idx ON public.weekly_reports (status, updated_at);
ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;      -- service role only
REVOKE ALL ON TABLE public.weekly_reports FROM anon, authenticated;

-- 2. Priority Support hardening ----------------------------------------------
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;    -- service role only
REVOKE ALL ON TABLE public.support_messages FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS support_messages_created_idx ON public.support_messages (created_at DESC);

-- 3. Preferences column (no-op where it already exists) -----------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS preferences jsonb;

-- Verify (read-only):
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('weekly_reports', 'support_messages');
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'weekly_reports' ORDER BY ordinal_position;
