-- ============================================================================
-- Autopilot persistence fix — autopilot_recommendations, autopilot_tasks,
-- autopilot_workflows
--
-- Run this once, by hand, via the Supabase Dashboard → SQL Editor (no
-- migration tooling in this repo — same convention as every other file in
-- this folder, including 2026-09-automation-rules-schema-cache.sql, which
-- this file is the explicitly-flagged follow-up to — see that file's own
-- closing comment: "the other three tables ... can get the same treatment
-- ... in a follow-up pass".
--
-- ROOT CAUSE (confirmed via a live, read-only probe against the actual
-- configured Supabase project as part of a Task 3 audit): PostgREST returns
-- PGRST205 "Could not find the table public.autopilot_recommendations /
-- autopilot_tasks / autopilot_workflows in the schema cache" for all three.
-- automation_rules was already fixed (its own migration, above) and is
-- confirmed reachable. These three were NOT created by that pass and remain
-- genuinely missing tables, not a stale cache — same evidence class as the
-- automation_rules root-cause analysis (PostgREST has never seen them).
--
-- IMPACT while these tables don't exist: the entire Autopilot recommendation
-- flow is silently broken in production. `_generateRecommendation` (server.js)
-- swallows its own insert failure in a try/catch and returns null — so the
-- monitoring cron *runs*, detects real issues, but never actually creates a
-- recommendation a user can see or approve. `GET /api/autopilot/recommendations`,
-- `PATCH .../:id`, `.../approve`, `.../reject`, `GET/PATCH /api/autopilot/tasks`,
-- `GET/POST /api/autopilot/workflows`, and `GET /api/autopilot/history` all
-- either 500 with DB_UNAVAILABLE or silently return empty results.
--
-- Column sets below match EXACTLY what server.js's real, already-shipped
-- routes read/write today — nothing speculative added. Verified against:
--   autopilot_recommendations: the INSERT in _generateRecommendation
--     (server.js, builds `row = {user_id, source_event_id, platform,
--     campaign_name, type, problem, impact, confidence, evidence,
--     business_reason, marketing_reason, estimated_improvement,
--     estimated_roi, suggested_action, risk, tool_name, tool_params,
--     status}`), plus the approve/reject routes' `.update({status,
--     resolved_at})` and the PATCH route's `.update({tool_params})`.
--   autopilot_tasks: the INSERT in the Smart Task Manager's task-generation
--     pass (server.js, `{user_id, title, task_type, priority, deadline,
--     business_impact, estimated_minutes, source_recommendation_id}`),
--     plus the PATCH route's `.update({status})` (status one of
--     'pending'/'in_progress'/'done'/'dismissed', server-validated).
--   autopilot_workflows: the INSERT in `POST /api/autopilot/workflows`
--     (server.js, `{user_id, name, template, steps, current_step, status}`)
--     and `_advanceWorkflow`'s `.update({steps, current_step, status,
--     updated_at})`.
--
-- source_event_id (on autopilot_recommendations) is left as a plain uuid
-- with NO foreign-key constraint to intelligence_events — deliberately,
-- matching this codebase's own documented design philosophy (DATABASE.md,
-- "Redundancy review": "campaign/product/audience 'links' ... are soft
-- name-matches, not foreign keys"). source_recommendation_id (on
-- autopilot_tasks) DOES get a real FK, since both tables are created in
-- this same migration and the reference is exact-id, not a soft name-match.
--
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / idempotent
-- REVOKE-GRANT / DROP POLICY IF EXISTS before CREATE POLICY).
-- ============================================================================

CREATE TABLE IF NOT EXISTS autopilot_recommendations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES profiles(id) NOT NULL,
  source_event_id        uuid,             -- soft reference to intelligence_events.id (no FK — see header)
  platform               text,             -- 'google' | 'meta' | 'tiktok' | 'pinterest' | null
  campaign_name          text,
  type                   text NOT NULL,    -- e.g. 'budget_waste', 'audience_saturation', 'creative_fatigue', rule-triggered types
  problem                text NOT NULL,
  impact                 text,
  confidence             numeric,
  evidence               jsonb,            -- {metric, operator, value, workflowId, ...} — read back by approve/reject/dedup logic
  business_reason        text,
  marketing_reason       text,
  estimated_improvement  text,
  estimated_roi          text,
  suggested_action       text,
  risk                   text NOT NULL DEFAULT 'low',
  tool_name              text,             -- Tool Router tool name, executed via toolRouter.executeDirect on approval
  tool_params             jsonb,
  status                 text NOT NULL DEFAULT 'suggested',  -- suggested | rejected | executed | failed (no 'approved' state — see server.js)
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_recommendations_user_idx ON autopilot_recommendations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autopilot_recommendations_status_idx ON autopilot_recommendations(user_id, status);
-- Supports the dedup check in _generateRecommendation: one open
-- recommendation per (user_id, type, campaign_name) while status='suggested'.
CREATE INDEX IF NOT EXISTS autopilot_recommendations_dedup_idx ON autopilot_recommendations(user_id, type, campaign_name, status);

CREATE TABLE IF NOT EXISTS autopilot_tasks (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid REFERENCES profiles(id) NOT NULL,
  title                     text NOT NULL,
  task_type                 text NOT NULL,   -- e.g. 'update_competitor', 'review_product', 'refresh_website', 'review_campaign'
  priority                  text NOT NULL,   -- 'low' | 'medium' | 'high'
  deadline                  timestamptz,
  business_impact           text,
  estimated_minutes         integer,
  source_recommendation_id  uuid REFERENCES autopilot_recommendations(id) ON DELETE SET NULL,
  status                    text NOT NULL DEFAULT 'pending',  -- pending | in_progress | done | dismissed
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_tasks_user_idx ON autopilot_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autopilot_tasks_status_idx ON autopilot_tasks(user_id, status);
-- Supports the dedup check before inserting a new task (same title, still pending).
CREATE INDEX IF NOT EXISTS autopilot_tasks_dedup_idx ON autopilot_tasks(user_id, title, status);

CREATE TABLE IF NOT EXISTS autopilot_workflows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES profiles(id) NOT NULL,
  name          text NOT NULL,
  template      text,
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered [{step, label, status, result}]
  current_step  integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'running',      -- running | awaiting_approval | completed | failed (see _advanceWorkflow)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);
CREATE INDEX IF NOT EXISTS autopilot_workflows_user_idx ON autopilot_workflows(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autopilot_workflows_status_idx ON autopilot_workflows(user_id, status);

-- ── RLS — real per-user isolation, not just app-layer filtering ───────────
-- Every existing route already uses supabaseAdmin (service_role), which
-- bypasses RLS entirely — so these policies change nothing about how the
-- app behaves today. Same reasoning and shape as automation_rules' own
-- policies (above/sibling migration): a real defense-in-depth boundary.
ALTER TABLE autopilot_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopilot_workflows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autopilot_recommendations_select_own ON autopilot_recommendations;
CREATE POLICY autopilot_recommendations_select_own ON autopilot_recommendations
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_recommendations_insert_own ON autopilot_recommendations;
CREATE POLICY autopilot_recommendations_insert_own ON autopilot_recommendations
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_recommendations_update_own ON autopilot_recommendations;
CREATE POLICY autopilot_recommendations_update_own ON autopilot_recommendations
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_recommendations_delete_own ON autopilot_recommendations;
CREATE POLICY autopilot_recommendations_delete_own ON autopilot_recommendations
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS autopilot_tasks_select_own ON autopilot_tasks;
CREATE POLICY autopilot_tasks_select_own ON autopilot_tasks
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_tasks_insert_own ON autopilot_tasks;
CREATE POLICY autopilot_tasks_insert_own ON autopilot_tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_tasks_update_own ON autopilot_tasks;
CREATE POLICY autopilot_tasks_update_own ON autopilot_tasks
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_tasks_delete_own ON autopilot_tasks;
CREATE POLICY autopilot_tasks_delete_own ON autopilot_tasks
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS autopilot_workflows_select_own ON autopilot_workflows;
CREATE POLICY autopilot_workflows_select_own ON autopilot_workflows
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_workflows_insert_own ON autopilot_workflows;
CREATE POLICY autopilot_workflows_insert_own ON autopilot_workflows
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_workflows_update_own ON autopilot_workflows;
CREATE POLICY autopilot_workflows_update_own ON autopilot_workflows
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS autopilot_workflows_delete_own ON autopilot_workflows;
CREATE POLICY autopilot_workflows_delete_own ON autopilot_workflows
  FOR DELETE USING (auth.uid() = user_id);

-- service_role bypasses RLS by default in Supabase, so this GRANT is what
-- lets the backend's supabaseAdmin client keep working exactly as it does
-- today (once the tables exist). anon/authenticated are granted table-level
-- access too (required for RLS policies to even be evaluated for them) but
-- the policies above are what actually restrict rows.
GRANT ALL ON autopilot_recommendations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON autopilot_recommendations TO authenticated;
REVOKE ALL ON autopilot_recommendations FROM anon;

GRANT ALL ON autopilot_tasks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON autopilot_tasks TO authenticated;
REVOKE ALL ON autopilot_tasks FROM anon;

GRANT ALL ON autopilot_workflows TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON autopilot_workflows TO authenticated;
REVOKE ALL ON autopilot_workflows FROM anon;

-- ── After running the block above, verify from this repo with: ────────────
--   cd server && node -e "require('dotenv').config({path:'../.env'});
--     const {createClient}=require('@supabase/supabase-js');
--     const sb=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
--     Promise.all(['autopilot_recommendations','autopilot_tasks','autopilot_workflows']
--       .map(t => sb.from(t).select('id').limit(1).then(r => console.log(t, '=>', r.error ? r.error.message : 'OK reachable'))));"
--
-- PostgREST on Supabase's hosted platform auto-reloads its schema cache
-- within a few seconds of any DDL run through the Dashboard SQL editor. If
-- the verification query above still errors a few seconds after running
-- this, nudge it manually: Dashboard → Settings → API → "Reload schema
-- cache" (or, from SQL: NOTIFY pgrst, 'reload schema';).
-- ============================================================================
