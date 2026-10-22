-- ============================================================================
-- READ-ONLY schema verification — publish ledger + Automations tables
-- ----------------------------------------------------------------------------
-- Run in Supabase Dashboard → SQL Editor. Every statement is a SELECT on the
-- system catalogs: nothing is created, changed or deleted, and no row data
-- is read. Safe to run on production at any time.
--
-- Checks what the backend code requires (services/publishLedger.js,
-- services/campaignActivation.js, services/automations/*, routes/
-- automationRoutes.js) against docs/migrations/2026-10-publish-operations.sql
-- and docs/migrations/2026-10-automations.sql.
--
-- Query 1 returns one row per requirement with PASS / MISSING / DIFFERENT.
-- Every row should read PASS. Queries 2–5 show the raw catalog details.
-- The SQL Editor shows only the LAST statement's result: select query 1
-- (or one of the others) and run just that selection.
-- Checked locally: on an empty Postgres with the migrations applied, query 1
-- returns 158 rows, all PASS; deliberately breaking a unique key, a column,
-- RLS and a grant turns the matching rows to MISSING / DIFFERENT.
-- ============================================================================

-- ── 1. Requirement checklist ────────────────────────────────────────────────
WITH req_cols(tbl, col, typ, nullable) AS (VALUES
  -- publish_operations (publish ledger + first-activation marker in external_ids)
  ('publish_operations','id','uuid','NO'), ('publish_operations','user_id','uuid','NO'), ('publish_operations','platform','text','NO'),
  ('publish_operations','client_ref_id','text','NO'), ('publish_operations','op_id','text','YES'), ('publish_operations','state','text','NO'),
  ('publish_operations','campaign_name','text','YES'), ('publish_operations','external_account_id','text','YES'), ('publish_operations','external_campaign_id','text','YES'),
  ('publish_operations','external_ids','jsonb','YES'), ('publish_operations','error','text','YES'), ('publish_operations','rollback','jsonb','YES'),
  ('publish_operations','started_at','timestamp with time zone','NO'), ('publish_operations','finished_at','timestamp with time zone','YES'), ('publish_operations','updated_at','timestamp with time zone','NO'),
  -- automation_settings
  ('automation_settings','user_id','uuid','NO'), ('automation_settings','paused_all','boolean','NO'), ('automation_settings','paused_at','timestamp with time zone','YES'),
  ('automation_settings','notify_in_app','boolean','NO'), ('automation_settings','notify_email','boolean','NO'), ('automation_settings','email_events','jsonb','YES'),
  ('automation_settings','rules_eval_at','timestamp with time zone','YES'), ('automation_settings','eval_lease_until','timestamp with time zone','YES'), ('automation_settings','eval_lease_by','text','YES'),
  ('automation_settings','updated_at','timestamp with time zone','NO'),
  -- automation_jobs
  ('automation_jobs','id','uuid','NO'), ('automation_jobs','user_id','uuid','NO'), ('automation_jobs','automation_id','uuid','NO'), ('automation_jobs','item_key','text','NO'),
  ('automation_jobs','action','text','NO'), ('automation_jobs','platform','text','NO'), ('automation_jobs','campaign_id','text','NO'), ('automation_jobs','campaign_name','text','YES'),
  ('automation_jobs','run_at','timestamp with time zone','NO'), ('automation_jobs','local_time','text','NO'), ('automation_jobs','timezone','text','NO'), ('automation_jobs','status','text','NO'),
  ('automation_jobs','attempts','integer','NO'), ('automation_jobs','next_attempt_at','timestamp with time zone','YES'), ('automation_jobs','locked_by','text','YES'), ('automation_jobs','locked_at','timestamp with time zone','YES'),
  ('automation_jobs','idempotency_key','text','NO'), ('automation_jobs','result','jsonb','YES'), ('automation_jobs','error','text','YES'),
  ('automation_jobs','created_at','timestamp with time zone','NO'), ('automation_jobs','updated_at','timestamp with time zone','NO'),
  -- automation_executions
  ('automation_executions','id','uuid','NO'), ('automation_executions','user_id','uuid','NO'), ('automation_executions','automation_id','uuid','YES'), ('automation_executions','automation_name','text','YES'),
  ('automation_executions','source','text','NO'), ('automation_executions','job_id','uuid','YES'), ('automation_executions','approval_id','uuid','YES'), ('automation_executions','platform','text','YES'),
  ('automation_executions','account_id','text','YES'), ('automation_executions','campaign_id','text','YES'), ('automation_executions','campaign_name','text','YES'), ('automation_executions','mode','text','YES'),
  ('automation_executions','action','text','NO'), ('automation_executions','trigger','jsonb','YES'), ('automation_executions','previous_value','jsonb','YES'), ('automation_executions','new_value','jsonb','YES'),
  ('automation_executions','status','text','NO'), ('automation_executions','reason','text','YES'), ('automation_executions','error','text','YES'), ('automation_executions','idempotency_key','text','NO'),
  ('automation_executions','created_at','timestamp with time zone','NO'), ('automation_executions','finished_at','timestamp with time zone','YES'),
  -- automation_approvals
  ('automation_approvals','id','uuid','NO'), ('automation_approvals','user_id','uuid','NO'), ('automation_approvals','automation_id','uuid','YES'), ('automation_approvals','execution_id','uuid','YES'),
  ('automation_approvals','platform','text','NO'), ('automation_approvals','account_id','text','YES'), ('automation_approvals','campaign_id','text','NO'), ('automation_approvals','campaign_name','text','YES'),
  ('automation_approvals','action','text','NO'), ('automation_approvals','params','jsonb','YES'), ('automation_approvals','observed','jsonb','YES'), ('automation_approvals','status','text','NO'),
  ('automation_approvals','expires_at','timestamp with time zone','NO'), ('automation_approvals','decided_at','timestamp with time zone','YES'), ('automation_approvals','error','text','YES'),
  ('automation_approvals','created_at','timestamp with time zone','NO'),
  -- automation_notifications
  ('automation_notifications','id','uuid','NO'), ('automation_notifications','user_id','uuid','NO'), ('automation_notifications','automation_id','uuid','YES'), ('automation_notifications','execution_id','uuid','YES'),
  ('automation_notifications','kind','text','NO'), ('automation_notifications','title','text','NO'), ('automation_notifications','body','text','YES'), ('automation_notifications','severity','text','YES'),
  ('automation_notifications','dedupe_key','text','NO'), ('automation_notifications','email_status','text','NO'), ('automation_notifications','email_batch','text','YES'),
  ('automation_notifications','read_at','timestamp with time zone','YES'), ('automation_notifications','created_at','timestamp with time zone','NO'),
  -- automation_rules: columns added by 2026-10-automations.sql (+ trigger_* now nullable)
  ('automation_rules','kind','text','YES'), ('automation_rules','mode','text','YES'), ('automation_rules','scope','jsonb','YES'), ('automation_rules','data_window_days','integer','YES'),
  ('automation_rules','min_data','jsonb','YES'), ('automation_rules','trigger_text','text','YES'), ('automation_rules','schedule','jsonb','YES'), ('automation_rules','status','text','YES'),
  ('automation_rules','currency','text','YES'), ('automation_rules','charge','jsonb','YES'), ('automation_rules','updated_at','timestamp with time zone','YES'), ('automation_rules','deleted_at','timestamp with time zone','YES'),
  ('automation_rules','last_evaluated_at','timestamp with time zone','YES'), ('automation_rules','last_result','jsonb','YES'),
  ('automation_rules','trigger_metric','text','YES'), ('automation_rules','trigger_operator','text','YES'), ('automation_rules','trigger_value','numeric','YES')
),
col_check AS (
  SELECT 'column' AS kind, r.tbl || '.' || r.col AS item,
         CASE WHEN c.column_name IS NULL THEN 'MISSING'
              WHEN c.data_type <> r.typ OR c.is_nullable <> r.nullable THEN 'DIFFERENT (' || c.data_type || ', nullable ' || c.is_nullable || '; expected ' || r.typ || ', nullable ' || r.nullable || ')'
              ELSE 'PASS' END AS result
  FROM req_cols r
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.col
),
-- Unique keys the code relies on (23505 = "already done" for idempotency / claims).
req_unique(tbl, cols, why) AS (VALUES
  ('publish_operations', 'user_id,platform,client_ref_id', 'atomic publish claim (publishLedger.js)'),
  ('automation_jobs', 'idempotency_key', 'one job per occurrence (engine.js materialize)'),
  ('automation_executions', 'idempotency_key', 'durable execution idempotency (engine.js claimExecution)'),
  ('automation_notifications', 'user_id,dedupe_key', 'one notification per event (notify.js)'),
  ('automation_settings', 'user_id', 'one settings row per user (primary key)')
),
uniq AS (
  SELECT t.relname AS tbl, string_agg(a.attname, ',' ORDER BY k.ord) AS cols
  FROM pg_index i
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
  CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  WHERE i.indisunique AND i.indpred IS NULL
  GROUP BY t.relname, i.indexrelid
),
uniq_check AS (
  SELECT 'unique' AS kind, r.tbl || '(' || r.cols || ') — ' || r.why AS item,
         CASE WHEN EXISTS (SELECT 1 FROM uniq u WHERE u.tbl = r.tbl AND u.cols = r.cols) THEN 'PASS' ELSE 'MISSING' END AS result
  FROM req_unique r
),
-- CHECK constraints on publish_operations (the ledger states and platforms the code writes).
check_check AS (
  SELECT 'check' AS kind, 'publish_operations CHECK ' || x.what AS item,
         CASE WHEN EXISTS (
           SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'publish_operations' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ x.pattern
         ) THEN 'PASS' ELSE 'MISSING' END AS result
  FROM (VALUES
    ('state IN (publishing, published, failed, unconfirmed)', 'publishing.*published.*failed.*unconfirmed'),
    ('platform IN (meta, google, tiktok, pinterest)', 'meta.*google.*tiktok.*pinterest')
  ) AS x(what, pattern)
),
-- Indexes the queries use.
req_idx(tbl, idx) AS (VALUES
  ('publish_operations', 'publish_operations_user_idx'),
  ('automation_jobs', 'automation_jobs_due_idx'), ('automation_jobs', 'automation_jobs_user_idx'),
  ('automation_executions', 'automation_executions_user_idx'), ('automation_executions', 'automation_executions_campaign_idx'),
  ('automation_approvals', 'automation_approvals_user_idx'),
  ('automation_notifications', 'automation_notifications_user_idx'), ('automation_notifications', 'automation_notifications_batch_idx')
),
idx_check AS (
  SELECT 'index' AS kind, r.tbl || '.' || r.idx AS item,
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes x WHERE x.schemaname = 'public' AND x.tablename = r.tbl AND x.indexname = r.idx) THEN 'PASS' ELSE 'MISSING' END AS result
  FROM req_idx r
),
-- Row level security: on for all six; automation_* allow SELECT of own rows only;
-- publish_operations has no policies (service role only).
rls_check AS (
  SELECT 'rls' AS kind, t.tbl || ' row level security enabled' AS item,
         CASE WHEN c.relrowsecurity THEN 'PASS' WHEN c.oid IS NULL THEN 'MISSING (table)' ELSE 'MISSING' END AS result
  FROM (VALUES ('publish_operations'), ('automation_settings'), ('automation_jobs'), ('automation_executions'), ('automation_approvals'), ('automation_notifications')) AS t(tbl)
  LEFT JOIN pg_class c ON c.relname = t.tbl AND c.relnamespace = 'public'::regnamespace
),
policy_check AS (
  SELECT 'policy' AS kind, t.tbl || ' SELECT-own policy (' || t.tbl || '_select_own), and no write policies' AS item,
         CASE WHEN EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.policyname = t.tbl || '_select_own' AND p.cmd = 'SELECT' AND p.qual ~ 'auth\.uid\(\) = user_id')
                   AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
              THEN 'PASS' ELSE 'DIFFERENT — see query 4' END AS result
  FROM (VALUES ('automation_settings'), ('automation_jobs'), ('automation_executions'), ('automation_approvals'), ('automation_notifications')) AS t(tbl)
  UNION ALL
  SELECT 'policy', 'publish_operations has no policies (browser clients can’t read or write it)',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'publish_operations') THEN 'PASS' ELSE 'DIFFERENT — see query 4' END
),
grant_check AS (
  SELECT 'grant' AS kind, 'anon has no privileges on ' || t.tbl AS item,
         CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = t.tbl AND g.grantee = 'anon') THEN 'PASS' ELSE 'DIFFERENT — see query 5' END AS result
  FROM (VALUES ('publish_operations'), ('automation_settings'), ('automation_jobs'), ('automation_executions'), ('automation_approvals'), ('automation_notifications')) AS t(tbl)
  UNION ALL
  SELECT 'grant', 'authenticated has no privileges on publish_operations',
         CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = 'publish_operations' AND g.grantee = 'authenticated') THEN 'PASS' ELSE 'DIFFERENT — see query 5' END
),
defaults_check AS (
  SELECT 'default' AS kind, d.tbl || '.' || d.col || ' default ' || d.expect AS item,
         CASE WHEN c.column_default IS NULL THEN 'MISSING' WHEN c.column_default ~ d.pattern THEN 'PASS' ELSE 'DIFFERENT (' || c.column_default || ')' END AS result
  FROM (VALUES
    ('publish_operations', 'id', 'gen_random_uuid()', 'gen_random_uuid'), ('publish_operations', 'started_at', 'now()', 'now\(\)'), ('publish_operations', 'updated_at', 'now()', 'now\(\)'),
    ('automation_settings', 'paused_all', 'false', 'false'), ('automation_settings', 'notify_in_app', 'true', 'true'), ('automation_settings', 'notify_email', 'true', 'true'),
    ('automation_jobs', 'status', '''scheduled''', 'scheduled'), ('automation_jobs', 'attempts', '0', '^0'),
    ('automation_approvals', 'status', '''pending''', 'pending'), ('automation_notifications', 'email_status', '''none''', 'none')
  ) AS d(tbl, col, expect, pattern)
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = d.tbl AND c.column_name = d.col
)
SELECT kind, item, result FROM (
  SELECT kind, item, result FROM col_check
  UNION ALL SELECT * FROM uniq_check
  UNION ALL SELECT * FROM check_check
  UNION ALL SELECT * FROM idx_check
  UNION ALL SELECT * FROM rls_check
  UNION ALL SELECT * FROM policy_check
  UNION ALL SELECT * FROM grant_check
  UNION ALL SELECT * FROM defaults_check
) AS checks
ORDER BY (result = 'PASS'), kind, item;   -- anything not PASS is listed first

-- ── 2. Raw columns ──────────────────────────────────────────────────────────
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('publish_operations','automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications','automation_rules')
ORDER BY table_name, ordinal_position;

-- ── 3. Constraints and indexes ──────────────────────────────────────────────
SELECT t.relname AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
WHERE t.relnamespace = 'public'::regnamespace
  AND t.relname IN ('publish_operations','automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications')
ORDER BY t.relname, c.contype, c.conname;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('publish_operations','automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications')
ORDER BY tablename, indexname;

-- ── 4. RLS and policies ─────────────────────────────────────────────────────
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('publish_operations','automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications');

SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('publish_operations','automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications')
ORDER BY tablename, policyname;

-- ── 5. Table privileges for the browser roles ───────────────────────────────
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN ('publish_operations','automation_settings','automation_jobs','automation_executions','automation_approvals','automation_notifications')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;
