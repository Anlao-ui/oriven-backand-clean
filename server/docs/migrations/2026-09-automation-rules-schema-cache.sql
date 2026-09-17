-- ============================================================================
-- Autopilot persistence fix — automation_rules
--
-- Run this once, by hand, via the Supabase Dashboard → SQL Editor (no
-- migration tooling in this repo — same convention as every other file in
-- this folder: 2026-08-credit-economy.sql, 2026-08-intelligence-usage.sql).
--
-- ROOT CAUSE (confirmed this session with real evidence, not assumed):
-- automation_rules (and its 3 siblings — autopilot_tasks, autopilot_workflows,
-- autopilot_recommendations) return PGRST205 "Could not find the table ...
-- in the schema cache" on every real query. Fetched PostgREST's own OpenAPI
-- root (GET /rest/v1/) and confirmed it exposes only 23 paths total — real
-- tables like intelligence_events, profiles, credit_transactions are all
-- present; NONE of the 4 automation_rules/autopilot_* tables appear at all.
-- This rules out "stale cache" (a stale cache still lists a table, just
-- serves errors for it) — PostgREST has never seen these tables, meaning
-- they do not exist in this project's public schema. This is scenario A
-- (genuinely missing) from the brief, not D (stale cache) — confirmed by
-- evidence, not assumed.
--
-- This session's tooling (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY only —
-- no direct Postgres connection string, no Management API token, no
-- Supabase CLI installed, no exec_sql-style RPC exposed) cannot execute
-- DDL against this project — PostgREST intentionally never exposes a
-- generic "run arbitrary SQL" endpoint. That's why this file exists for
-- you to run directly rather than being applied automatically.
--
-- Column set matches EXACTLY what server.js's real, already-shipped routes
-- read/write today (POST/PATCH/DELETE /api/autopilot/rules,
-- _evaluateAutomationRules, _execRuleAction) — nothing speculative added.
-- updated_at was considered and deliberately left out: grepped server.js,
-- confirmed no code anywhere reads or writes it.
--
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / idempotent
-- REVOKE-GRANT / DROP POLICY IF EXISTS before CREATE POLICY).
-- ============================================================================

CREATE TABLE IF NOT EXISTS automation_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES profiles(id) NOT NULL,
  name              text NOT NULL,
  trigger_metric    text NOT NULL,   -- one of AUTOPILOT_RULE_METRICS (server.js): roas/ctr/cpc/cpa/conversions/spend/clicks/impressions/budget/status
  trigger_operator  text NOT NULL,   -- one of '<' '>' '==' '>=' '<='
  trigger_value     numeric NOT NULL,
  platform          text,            -- 'google' | 'meta' | 'tiktok' | null (any)
  action_type       text NOT NULL,   -- one of AUTOPILOT_RULE_ACTION_TYPES (server.js)
  action_params     jsonb,           -- { campaign_id, campaign_name, mode, percent }
  enabled           boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,     -- set only when a real match fires an action attempt (never "last evaluated")
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_rules_user_idx ON automation_rules(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_rules_enabled_idx ON automation_rules(user_id, enabled) WHERE enabled;

-- ── RLS — real per-user isolation, not just app-layer filtering ───────────
-- Every existing route already uses supabaseAdmin (service_role), which
-- bypasses RLS entirely — so these policies change nothing about how the
-- app behaves today. They exist as a real defense-in-depth boundary in
-- case this table is ever queried with an authenticated (non-service-role)
-- client, matching the brief's explicit requirement: a user can read/
-- create/update/delete their OWN rules only, never another user's.
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_rules_select_own ON automation_rules;
CREATE POLICY automation_rules_select_own ON automation_rules
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS automation_rules_insert_own ON automation_rules;
CREATE POLICY automation_rules_insert_own ON automation_rules
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS automation_rules_update_own ON automation_rules;
CREATE POLICY automation_rules_update_own ON automation_rules
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS automation_rules_delete_own ON automation_rules;
CREATE POLICY automation_rules_delete_own ON automation_rules
  FOR DELETE USING (auth.uid() = user_id);

-- service_role bypasses RLS by default in Supabase (it is not subject to
-- policies at all), so this GRANT is what lets the backend's supabaseAdmin
-- client keep working exactly as it does today. anon/authenticated are
-- granted table-level access too (required for RLS policies to even be
-- evaluated for them — a REVOKE ALL would block them before RLS gets a
-- chance to run) but the policies above are what actually restrict rows.
GRANT ALL ON automation_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_rules TO authenticated;
REVOKE ALL ON automation_rules FROM anon;

-- ── After running the block above, verify from this repo with: ────────────
--   cd server && node -e "require('dotenv').config({path:'../.env'});
--     const {createClient}=require('@supabase/supabase-js');
--     const sb=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
--     sb.from('automation_rules').select('*').limit(1).then(r=>console.log(r.error||'OK, table reachable'));"
--
-- PostgREST on Supabase's hosted platform auto-reloads its schema cache
-- within a few seconds of any DDL run through the Dashboard SQL editor —
-- no manual NOTIFY needed there (that's only required for a raw/local
-- Postgres instance managed outside Supabase's platform tooling). If the
-- verification query above still 404s a few seconds after running this,
-- the schema cache may need a manual nudge: Dashboard → Settings → API →
-- "Reload schema cache" button (or, from SQL: NOTIFY pgrst, 'reload schema';).
--
-- ── The other three tables (autopilot_tasks, autopilot_workflows,
-- autopilot_recommendations) return the identical PGRST205 and are NOT
-- created here — this pass is scoped to the one table that blocks the
-- Create Automation flow (automation_rules). They can get the same
-- treatment (derive their real column set from server.js, then this same
-- CREATE TABLE + RLS pattern) in a follow-up pass if/when their own
-- features (recommendations approval, workflows, tasks) need to work
-- end-to-end too.
-- ============================================================================
