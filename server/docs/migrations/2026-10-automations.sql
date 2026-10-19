-- ============================================================================
-- Automations (replaces the user-facing "Autopilot") — durable scheduling,
-- execution ledger, approvals, settings and notifications.
--
-- Run once, by hand, in Supabase → SQL Editor (same convention as every file
-- in this folder). REQUIRES 2026-09-automation-rules-schema-cache.sql to have
-- been applied first (it creates automation_rules).
--
-- ADDITIVE ONLY: new tables, new nullable columns on automation_rules, and
-- relaxing three NOT NULL constraints that scheduled automations (which have
-- no metric condition) can't satisfy. No existing row is changed, no column
-- is dropped, no data is deleted. Existing rules keep working: rows without
-- the new columns are read with their old meaning (see services/automations/
-- engine.js normalizeRule) and are NOT charged the new 50-credit creation fee.
--
-- Everything here is written by the backend's service-role client (which
-- bypasses RLS); the RLS policies are defence in depth, allowing a user to
-- read only their own rows.
--
-- Safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS everywhere).
-- ============================================================================

-- ── 1. automation_rules: new optional columns ───────────────────────────────
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS kind              text;        -- 'rule' | 'schedule' (null = legacy rule)
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS mode              text;        -- 'notify' | 'approval' | 'automatic' (null = legacy action_params.mode)
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS scope             jsonb;       -- { type: 'campaigns'|'account', campaign_ids: [...], campaigns: [{id,name}] }
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS data_window_days  integer;     -- 1 | 3 | 7 | 14 | 30
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS min_data          jsonb;       -- { impressions, clicks, conversions, spend }
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS trigger_text      text;        -- status conditions ('active' | 'paused')
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS schedule          jsonb;       -- { timezone, items: [...], ends_at }
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS status            text;        -- 'active' | 'needs_review' | 'completed' (null = active)
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS currency          text;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS charge            jsonb;       -- { credits, request_id, at } — set only on paid creation
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS updated_at        timestamptz;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS deleted_at        timestamptz; -- soft delete: activity history keeps its automation
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS last_evaluated_at timestamptz;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS last_result       jsonb;       -- last evaluation summary (checked / matched / skipped reasons)
ALTER TABLE automation_rules ALTER COLUMN trigger_metric   DROP NOT NULL;
ALTER TABLE automation_rules ALTER COLUMN trigger_operator DROP NOT NULL;
ALTER TABLE automation_rules ALTER COLUMN trigger_value    DROP NOT NULL;

-- ── 2. Per-user settings (persisted; replaces the old localStorage-only ones)
CREATE TABLE IF NOT EXISTS automation_settings (
  user_id          uuid PRIMARY KEY REFERENCES profiles(id),
  paused_all       boolean NOT NULL DEFAULT false,   -- "Pause all automations"
  paused_at        timestamptz,
  notify_in_app    boolean NOT NULL DEFAULT true,
  notify_email     boolean NOT NULL DEFAULT true,
  email_events     jsonb,                            -- null = defaults (engine.js EMAIL_EVENTS)
  rules_eval_at    timestamptz,                      -- last completed rule evaluation for this user
  eval_lease_until timestamptz,                      -- evaluation lease (one instance at a time)
  eval_lease_by    text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Scheduled jobs (one row per occurrence; atomic claim via conditional
--       UPDATE ... WHERE status = 'scheduled', so two backend instances can
--       never run the same job) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automation_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id),
  automation_id    uuid NOT NULL REFERENCES automation_rules(id),
  item_key         text NOT NULL,
  action           text NOT NULL,                    -- activate | pause | resume | stop
  platform         text NOT NULL,
  campaign_id      text NOT NULL,
  campaign_name    text,
  run_at           timestamptz NOT NULL,             -- UTC
  local_time       text NOT NULL,                    -- 'YYYY-MM-DDTHH:MM' in the automation's time zone
  timezone         text NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled', -- scheduled | running | completed | failed | skipped | cancelled
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  locked_by        text,
  locked_at        timestamptz,
  idempotency_key  text NOT NULL UNIQUE,             -- sched:<automation>:<item>:<local_time>:<campaign>
  result           jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_jobs_due_idx ON automation_jobs(status, run_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS automation_jobs_user_idx ON automation_jobs(user_id, run_at);

-- ── 4. Execution ledger = the Activity log (durable idempotency) ────────────
CREATE TABLE IF NOT EXISTS automation_executions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id),
  automation_id    uuid REFERENCES automation_rules(id),
  automation_name  text,                             -- snapshot at execution time
  source           text NOT NULL,                    -- rule | schedule | approval
  job_id           uuid,
  approval_id      uuid,
  platform         text,
  account_id       text,
  campaign_id      text,
  campaign_name    text,
  mode             text,                             -- notify | approval | automatic | scheduled
  action           text NOT NULL,
  trigger          jsonb,                            -- { metric, operator, threshold, observed, window_days }
  previous_value   jsonb,
  new_value        jsonb,
  status           text NOT NULL,                    -- scheduled | pending_approval | running | completed | failed | skipped | cancelled
  reason           text,
  error            text,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS automation_executions_user_idx ON automation_executions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_executions_campaign_idx ON automation_executions(user_id, platform, campaign_id, action, created_at DESC);

-- ── 5. Approvals ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automation_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id),
  automation_id    uuid REFERENCES automation_rules(id),
  execution_id     uuid,
  platform         text NOT NULL,
  account_id       text,
  campaign_id      text NOT NULL,
  campaign_name    text,
  action           text NOT NULL,                    -- pause | resume | increase_budget | decrease_budget
  params           jsonb,                            -- { percent } — the amount is recomputed from the live budget on approval
  observed         jsonb,
  status           text NOT NULL DEFAULT 'pending',  -- pending | executing | completed | failed | rejected | expired
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_approvals_user_idx ON automation_approvals(user_id, status, created_at DESC);

-- ── 6. Notifications (in-app list + email delivery state) ───────────────────
CREATE TABLE IF NOT EXISTS automation_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id),
  automation_id    uuid,
  execution_id     uuid,
  kind             text NOT NULL,                    -- executed | failed | approval | paused | resumed | budget_changed | scheduled_completed | disconnected | credentials_expired | skipped
  title            text NOT NULL,
  body             text,
  severity         text,
  dedupe_key       text NOT NULL,
  email_status     text NOT NULL DEFAULT 'none',     -- none | queued | sent | failed | rate_limited | skipped (delivery is tracked in email_sends via the provider webhook)
  email_batch      text,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS automation_notifications_user_idx ON automation_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_notifications_batch_idx ON automation_notifications(email_batch) WHERE email_batch IS NOT NULL;

-- ── 7. RLS: read own rows only (writes are service-role only) ───────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select_own', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (auth.uid() = user_id)', t || '_select_own', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
  END LOOP;
END $$;

-- ── 8. credit_actions lane for the 50-credit creation charge ────────────────
-- Nothing to add: services/paidActions.js stores any lane name as text.

-- ============================================================================
-- ROLLBACK (only if you must undo this migration; it deletes the new tables'
-- data — activity history, schedules, approvals and notifications):
--   DROP TABLE IF EXISTS automation_notifications, automation_approvals,
--     automation_executions, automation_jobs, automation_settings;
--   -- The added automation_rules columns are nullable and unused by older
--   -- code; leaving them is harmless. To remove them:
--   -- ALTER TABLE automation_rules DROP COLUMN kind, DROP COLUMN mode, ... ;
--   -- Re-adding NOT NULL on trigger_metric/operator/value fails if any
--   -- scheduled automation exists — delete those rows first.
-- Deploy the previous backend before rolling back the schema.
-- ============================================================================
