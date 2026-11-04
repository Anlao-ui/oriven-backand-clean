-- ════════════════════════════════════════════════════════════════
-- Onboarding sessions: the guided questionnaire, the website analysis, the
-- chosen assistant and the personalized marketing plan prepared before the
-- paywall (services/onboardingFlow.js, POST/GET/PUT /api/onboarding/*).
--
-- One row per account (user_id is the key). Answers and results are JSON;
-- the plan is stored here and only ever SERVED by the API, which returns
-- its content only while the account has paid access (services/pricing.js
-- hasAccess, checked on every request).
--
-- Access: RLS is on and there is NO policy for anon or authenticated, and
-- their table privileges are revoked: a signed-in browser cannot read its
-- own locked plan through Supabase directly. Only the service role (the
-- backend) reads and writes this table.
--
-- Safe to run more than once. Rollback: see the bottom of this file.
-- Nothing here touches credits, purchases or subscription status.
-- One transaction. Order: after 2026-10-access-purchases.sql (purchase_id).
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress', 'analyzing', 'plan_ready', 'completed')),
  step               text NOT NULL DEFAULT 'welcome',
  answers            jsonb NOT NULL DEFAULT '{}'::jsonb,
  website_analysis   jsonb,
  website_attempts   integer NOT NULL DEFAULT 0 CHECK (website_attempts >= 0),
  assistant          text CHECK (assistant IN ('scout', 'vector', 'nova', 'momentum', 'metric', 'flux')),
  analysis           jsonb,          -- the structured input the plan was generated from
  plan               jsonb,          -- the generated marketing plan (served only with paid access)
  plan_status        text NOT NULL DEFAULT 'none'
                       CHECK (plan_status IN ('none', 'generating', 'ready', 'failed')),
  plan_attempts      integer NOT NULL DEFAULT 0 CHECK (plan_attempts >= 0 AND plan_attempts <= 10),
  plan_started_at    timestamptz,
  plan_ready_at      timestamptz,
  plan_error         text,
  unlocked_at        timestamptz,    -- first time the plan was served with paid access
  purchase_id        uuid REFERENCES purchases(id) ON DELETE SET NULL,
  progress           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ticked Progress steps: { planAt, done: { <stepId>: time } }
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Added with the Progress page: safe to re-run on a table created earlier.
ALTER TABLE onboarding_sessions ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS onboarding_sessions_generating_idx
  ON onboarding_sessions (plan_started_at) WHERE plan_status = 'generating';

ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON onboarding_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_sessions TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (keeps nothing; run only if the feature is withdrawn) ──
--   DROP TABLE IF EXISTS onboarding_sessions;
--   NOTIFY pgrst, 'reload schema';
-- The table holds only onboarding answers and generated plans; dropping it
-- does not affect accounts, profiles, credits, purchases or subscriptions.
-- The backend treats a missing table as "new onboarding unavailable" and the
-- app falls back to the existing welcome tour.
