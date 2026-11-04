-- ════════════════════════════════════════════════════════════════
-- READ-ONLY verification of the pending migrations (rev. 2026-11-04)
--
-- HOW TO RUN (Supabase SQL editor)
--   The editor shows only the LAST result of a run. Run ONE block at a
--   time: select the lines of a block (from its "-- ── n." heading to its
--   semicolon) and press Run. Every block is a single SELECT and is
--   read-only on its own; none depends on another.
--   Optional: to run the whole file at once, keep the BEGIN TRANSACTION
--   READ ONLY / ROLLBACK lines — Postgres then refuses any write — but only
--   the last block's result is displayed.
--
-- WHAT IT DOES NOT DO
--   No INSERT/UPDATE/DELETE/DDL. No application function is called: the
--   functions used are Postgres catalog/privilege functions
--   (has_*_privilege, to_regclass, pg_get_*, aclexplode, …), which only
--   read the catalog. Missing tables, columns, functions or roles produce
--   no row (or present = false), never an error: every check goes through
--   catalog OIDs rather than names.
--
-- PERSONAL DATA
--   Only block 16 lists individual accounts, and only by the first 8
--   characters of the account id; no names, emails, Stripe ids or payment
--   data are selected anywhere.
-- ════════════════════════════════════════════════════════════════

BEGIN TRANSACTION READ ONLY;   -- optional wrapper for a whole-file run


-- ── 1. Pending objects: present? ─────────────────────────────────
SELECT kind, object, present FROM (
  SELECT 'table' AS kind, t AS object, to_regclass('public.' || t) IS NOT NULL AS present
    FROM unnest(ARRAY['purchases','credit_grants','credit_ledger','legacy_entitlements','legacy_transition_snapshot','onboarding_sessions','team_members','stripe_webhook_events','credit_actions','credit_transactions']) AS t
  UNION ALL
  SELECT 'column', 'profiles.' || c,
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.profiles') AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
    FROM unnest(ARRAY['access_expires_at','access_plan','deleted_at','credits_balance','credits_cycle_end','subscription_status','stripe_subscription_id']) AS c
  UNION ALL
  SELECT 'column', 'integrations.' || c,
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.integrations') AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped)
    FROM unnest(ARRAY['google_ads_accounts_error']) AS c
  UNION ALL
  SELECT 'function', f,
         EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f)
    FROM unnest(ARRAY['fulfill_purchase','grant_due_credit_instalments','expire_access','revoke_purchase','_end_access','_legacy_protected','refresh_legacy_entitlements','update_legacy_entitlement','delete_account_data']) AS f
) x
ORDER BY kind, object;


-- ── 2. Expected indexes: present? (names from the migration files) ──
SELECT migration, index_name, to_regclass('public.' || index_name) IS NOT NULL AS present
  FROM (VALUES
    ('2026-10-stripe-webhook-events', 'stripe_webhook_events_status_idx'),
    ('2026-10-signup-verification',   'profiles_verification_token_hash_idx'),
    ('2026-10-analytics',             'profiles_created_at_idx'),
    ('2026-10-analytics',             'events_once_per_user_idx'),
    ('2026-08-credit-economy',        'credit_transactions_user_idx'),
    ('2026-10-credit-actions',        'credit_actions_user_key_uidx'),
    ('2026-10-credit-actions',        'credit_actions_user_lane_inflight_uidx'),
    ('2026-10-credit-actions',        'credit_actions_status_created_idx'),
    ('2026-10-credit-actions',        'credit_actions_async_job_idx'),
    ('2026-10-access-purchases',      'profiles_access_expires_idx'),
    ('2026-10-access-purchases',      'purchases_user_idx'),
    ('2026-10-access-purchases',      'purchases_pending_idx'),
    ('2026-10-access-purchases',      'credit_grants_due_idx'),
    ('2026-10-access-purchases',      'credit_grants_user_idx'),
    ('2026-10-access-purchases',      'credit_ledger_user_idx'),
    ('2026-10-onboarding-sessions',   'onboarding_sessions_generating_idx')
  ) AS v(migration, index_name)
 ORDER BY present, migration, index_name;   -- missing indexes first


-- ── 3. Which version of the credit functions is live ─────────────
-- spend_credits:            'new' needs access (access-purchases), 'old' has the free top-up
-- ensure_free_daily_cycle:  'new' is a no-op (access-purchases), 'old' resets daily_free
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       CASE
         WHEN p.proname = 'spend_credits' AND p.prosrc LIKE '%access_expires_at%' THEN 'new (access-purchases)'
         WHEN p.proname = 'spend_credits' AND p.prosrc LIKE '%ensure_free_daily_cycle%' THEN 'old (free plan)'
         WHEN p.proname = 'ensure_free_daily_cycle' AND p.prosrc LIKE '%daily_free%' THEN 'old (free plan)'
         WHEN p.proname = 'ensure_free_daily_cycle' AND p.prosrc NOT LIKE '%UPDATE%' THEN 'new (no-op, access-purchases)'
         ELSE 'not classified (inspect manually)'
       END AS version
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('spend_credits', 'ensure_free_daily_cycle')
 ORDER BY 1, 2;


-- ── 4. Ownership of the relevant tables (to read blocks 6–9) ─────
-- Privilege listings in information_schema only show grants made by or to
-- the current role; the owner tells you whose grants these are.
SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
   AND c.relname IN ('profiles','purchases','credit_grants','credit_ledger','credit_transactions','credit_actions','stripe_webhook_events',
                     'onboarding_sessions','automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows',
                     'integrations','team_members','events','email_sends','free_first_ad_claims','publish_operations','weekly_reports','support_messages')
 ORDER BY owner, table_name;


-- ── 5. RLS on every table in public ──────────────────────────────
SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
 ORDER BY c.relrowsecurity, c.relname;   -- tables WITHOUT RLS first


-- ── 6. EFFECTIVE table privileges (has_table_privilege) ──────────
-- True means the role can do it (directly, via PUBLIC or via role membership),
-- whoever granted it. Row-level security still applies on top for anon/authenticated.
SELECT c.relname AS table_name, r.rolname AS role,
       has_table_privilege(r.oid, c.oid, 'SELECT')   AS can_select,
       has_table_privilege(r.oid, c.oid, 'INSERT')   AS can_insert,
       has_table_privilege(r.oid, c.oid, 'UPDATE')   AS can_update,
       has_table_privilege(r.oid, c.oid, 'DELETE')   AS can_delete,
       has_table_privilege(r.oid, c.oid, 'TRUNCATE') AS can_truncate
  FROM pg_class c
  CROSS JOIN pg_roles r
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
   AND c.relname IN ('profiles','automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows',
                     'purchases','credit_grants','credit_ledger','credit_transactions','credit_actions','stripe_webhook_events',
                     'onboarding_sessions','integrations')
   AND r.rolname IN ('anon', 'authenticated', 'service_role')
 ORDER BY c.relname, r.rolname;


-- ── 7. Lockdown status: expected vs actual ───────────────────────
-- 'OPEN' = browsers can still write the table → that lockdown is not (fully) applied.
SELECT c.relname AS table_name,
       CASE WHEN c.relname = 'profiles' THEN '2026-10-profiles-lockdown' ELSE '2026-11-browser-write-lockdown' END AS migration,
       r.rolname AS role,
       has_table_privilege(r.oid, c.oid, 'INSERT') OR has_table_privilege(r.oid, c.oid, 'UPDATE') OR has_table_privilege(r.oid, c.oid, 'DELETE') AS can_write_table,
       EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                  AND (has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE') OR has_column_privilege(r.oid, c.oid, a.attnum, 'INSERT'))) AS can_write_any_column,
       CASE WHEN has_table_privilege(r.oid, c.oid, 'INSERT') OR has_table_privilege(r.oid, c.oid, 'UPDATE') OR has_table_privilege(r.oid, c.oid, 'DELETE')
                 OR EXISTS (SELECT 1 FROM pg_attribute a
                             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                               AND (has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE') OR has_column_privilege(r.oid, c.oid, a.attnum, 'INSERT')))
            THEN 'OPEN' ELSE 'LOCKED' END AS status
  FROM pg_class c
  CROSS JOIN pg_roles r
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
   AND c.relname IN ('profiles','automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows')
   AND r.rolname IN ('anon', 'authenticated')
 ORDER BY status DESC, c.relname, r.rolname;   -- OPEN first


-- ── 8. profiles: EFFECTIVE column write privileges per role ──────
-- Counts columns the role can INSERT/UPDATE (table-level or column-level
-- grants both count). After the profiles lockdown: 0 for anon and authenticated.
SELECT r.rolname AS role,
       count(*) FILTER (WHERE has_column_privilege(r.oid, a.attrelid, a.attnum, 'UPDATE')) AS updatable_columns,
       count(*) FILTER (WHERE has_column_privilege(r.oid, a.attrelid, a.attnum, 'INSERT')) AS insertable_columns,
       count(*) AS total_columns,
       string_agg(a.attname, ', ' ORDER BY a.attnum) FILTER (WHERE has_column_privilege(r.oid, a.attrelid, a.attnum, 'UPDATE')) AS updatable_column_names
  FROM pg_attribute a
  CROSS JOIN pg_roles r
 WHERE a.attrelid = to_regclass('public.profiles') AND a.attnum > 0 AND NOT a.attisdropped
   AND r.rolname IN ('anon', 'authenticated', 'service_role')
 GROUP BY r.rolname
 ORDER BY r.rolname;


-- ── 9. Explicit grants (who granted what) on the lockdown tables ──
-- Table-level ACL entries and per-column ACL entries, with the grantor.
-- grantee 'PUBLIC' means every role.
SELECT 'table' AS level, c.relname AS table_name, NULL::name AS column_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
       pg_get_userbyid(acl.grantor) AS grantor, acl.privilege_type
  FROM pg_class c, LATERAL aclexplode(c.relacl) acl
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('profiles','automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows')
   AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('anon', 'authenticated'))
UNION ALL
SELECT 'column', c.relname, a.attname,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,
       pg_get_userbyid(acl.grantor), acl.privilege_type
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL,
  LATERAL aclexplode(a.attacl) acl
 WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'profiles'
   AND (acl.grantee = 0 OR pg_get_userbyid(acl.grantee) IN ('anon', 'authenticated'))
 ORDER BY 1 DESC, 2, 3, 4, 6;


-- ── 10. Function EXECUTE privileges ──────────────────────────────
-- Every function in public that is sensitive by name OR that anon /
-- authenticated can execute. PUBLIC grants are included (Postgres grants
-- EXECUTE to PUBLIC by default unless revoked). 'security_definer' = runs
-- with the owner's rights: such a function executable by anon/authenticated
-- needs its own checks inside.
SELECT p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
       CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable' ELSE 'immutable' END AS volatility,
       has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'anon'), p.oid, 'EXECUTE')          AS anon_can_execute,
       has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'authenticated'), p.oid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'service_role'), p.oid, 'EXECUTE')  AS service_role_can_execute
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.prokind = 'f'
   AND (p.proname ~ '^(spend_credits|refund_credits|ensure_free_daily_cycle|fulfill_purchase|grant_due_credit_instalments|expire_access|revoke_purchase|_end_access|_legacy_protected|refresh_legacy_entitlements|update_legacy_entitlement|delete_account_data|analytics_site_summary|rls_auto_enable)$'
        OR p.proname LIKE 'increment%'
        OR has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'anon'), p.oid, 'EXECUTE')
        OR has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'authenticated'), p.oid, 'EXECUTE'))
 ORDER BY (has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'anon'), p.oid, 'EXECUTE')
           OR has_function_privilege((SELECT oid FROM pg_roles WHERE rolname = 'authenticated'), p.oid, 'EXECUTE')) DESC,
          p.proname;


-- ── 11. Row-level security policies on the affected tables ───────
SELECT tablename, policyname, cmd, roles, permissive, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('profiles','automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows',
                     'purchases','credit_grants','credit_ledger','credit_transactions','credit_actions','stripe_webhook_events',
                     'onboarding_sessions','integrations')
 ORDER BY tablename, cmd, policyname;


-- ── 12. Constraints: primary keys, unique, foreign keys, CHECKs ──
SELECT c.relname AS table_name, con.conname,
       CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' WHEN 'f' THEN 'FOREIGN KEY' WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' ELSE con.contype::text END AS kind,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname IN ('profiles','purchases','credit_grants','credit_ledger','credit_transactions','credit_actions','stripe_webhook_events','onboarding_sessions')
 ORDER BY c.relname, kind, con.conname;


-- ── 13. Indexes on the same tables (full definitions) ────────────
SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN ('profiles','purchases','credit_grants','credit_ledger','credit_transactions','credit_actions','stripe_webhook_events','onboarding_sessions')
 ORDER BY tablename, indexname;


-- ── 14. Foreign keys pointing at profiles (account deletion) ─────
-- 'blocks delete' = deleting a profile that has such rows fails.
SELECT con.conrelid::regclass AS from_table, con.conname,
       CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT'
                            WHEN 'a' THEN 'NO ACTION (blocks delete)' WHEN 'r' THEN 'RESTRICT (blocks delete)' ELSE con.confdeltype::text END AS on_delete
  FROM pg_constraint con
 WHERE con.contype = 'f' AND con.confrelid = to_regclass('public.profiles')
 ORDER BY 3, 1;


-- ── 15. Row counts (no row data) ─────────────────────────────────
-- Estimates from the planner statistics (-1 = table never analysed);
-- reads the catalog only, never the tables. Exact customer counts: 16 and 17.
SELECT c.relname AS table_name, c.reltuples::bigint AS estimated_rows
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
   AND c.relname IN ('profiles','credit_transactions','credit_actions','stripe_webhook_events','purchases','credit_grants','credit_ledger','onboarding_sessions','campaigns','automation_rules')
 ORDER BY c.relname;


-- ── 16. PREVIEW: customers the access-purchases migration changes ──
-- The migration's final UPDATE touches exactly these rows (legacy plans
-- whose access_expires_at is still NULL — see block 1: if
-- profiles.access_expires_at already exists, the migration has run and
-- rows that already have a date are left alone).
-- new_access_expires_at = what it would assign; hours_remaining < 0 means
-- no access right after the migration; once expired, the expiry job sets
-- the balance to 0 and the status to free.
-- Identification: first 8 characters of the account id only.
SELECT left(id::text, 8)                                   AS account_ref,
       subscription_status                                 AS current_status,
       credits_balance                                     AS current_credits,
       credits_cycle_end                                   AS current_cycle_end,
       (stripe_subscription_id IS NOT NULL)                AS has_stripe_subscription,
       COALESCE(credits_cycle_end, now() + interval '30 days') + interval '3 days' AS new_access_expires_at,
       round((extract(epoch FROM (COALESCE(credits_cycle_end, now() + interval '30 days') + interval '3 days' - now())) / 3600.0)::numeric, 1) AS hours_remaining,
       CASE
         WHEN COALESCE(credits_cycle_end, now() + interval '30 days') + interval '3 days' <= now() THEN 'NO ACCESS at migration'
         WHEN COALESCE(credits_cycle_end, now() + interval '30 days') + interval '3 days' <= now() + interval '72 hours' THEN 'access ends within 72 h'
         WHEN COALESCE(credits_cycle_end, now() + interval '30 days') + interval '3 days' <= now() + interval '14 days' THEN 'access ends within 14 days'
         ELSE 'ok'
       END                                                 AS assessment,
       (stripe_subscription_id IS NULL)                    AS nothing_will_renew_it
  FROM profiles
 WHERE subscription_status IN ('starter', 'creator', 'professional')
 ORDER BY hours_remaining NULLS FIRST;


-- ── 17. Accounts without paid access after the migration (counts only) ──
SELECT COALESCE(subscription_status, '(null)') AS subscription_status,
       count(*)                                   AS accounts,
       count(*) FILTER (WHERE credits_balance > 0) AS accounts_with_credits,
       COALESCE(sum(credits_balance), 0)           AS credits_total
  FROM profiles
 WHERE subscription_status IS NULL OR subscription_status NOT IN ('starter', 'creator', 'professional', 'paid')
 GROUP BY 1
 ORDER BY 1;


-- ── 18. Supplementary: information_schema grant listing ──────────
-- Only shows grants made BY or TO the role running this query; compare
-- with blocks 6–9 (which are authoritative).
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
   AND table_name IN ('profiles','automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows')
 GROUP BY table_name, grantee
 ORDER BY table_name, grantee;


ROLLBACK;   -- ends the optional wrapper; nothing was changed
