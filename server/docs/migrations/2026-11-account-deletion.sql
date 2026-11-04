-- ═══════════════════════════════════════════════════════════════════
-- Account deletion (2026-11)
--
-- Problem: many tables reference profiles(id) with ON DELETE NO ACTION
-- (credit_transactions, campaigns, automation_*, autopilot_*, purchases, …),
-- so deleting a profile fails for any account that has such rows — and the
-- financial ones (purchases, credit ledger, credit transactions) must be
-- kept anyway (bookkeeping / tax retention).
--
-- Strategy (delete_account_data, called by POST /api/account/delete):
--   1. Personal application data is DELETED: business profile, brand,
--      products, audiences, competitors, learnings, memory, website
--      knowledge, campaigns, creative assets and comments, automations and
--      their jobs/runs/approvals/notifications, autopilot data, ad-platform
--      connections (OAuth tokens), caches, intelligence events, support
--      messages, weekly reports, onboarding answers and plan, publish log,
--      email send log, team seats.
--   2. Analytics events are kept but ANONYMISED (user_id removed).
--   3. Financial and audit records are KEPT, unchanged: purchases,
--      credit_grants, credit_ledger, credit_transactions, credit_actions,
--      legacy_transition_snapshot, stripe_webhook_events, free_first_ad_claims
--      (abuse prevention, no personal data), email_suppressions (an
--      unsubscribe must keep being honoured).
--   4. The profile row stays as an anonymised TOMBSTONE (it is what the kept
--      records reference): personal fields are cleared (nullable → NULL,
--      with a default → default, required text → ''); id, created_at, the
--      Stripe customer id (needed to match later refunds and disputes to the
--      kept purchases) and the deletion time remain. The backend has already
--      cancelled an active Stripe subscription before calling this.
--      Remaining credits are removed (one ledger row), access ends, scheduled
--      instalments are cancelled, a legacy entitlement is ended.
--   5. The auth user is then soft-deleted by the backend (Supabase
--      auth.admin.deleteUser(id, true)): sign-in impossible, no cascade into
--      the kept records.
-- Idempotent: running it again for a deleted account changes nothing.
-- Tables/columns that don't exist are skipped (works before/after the other
-- 2026-10/11 migrations). Service role only.
--
-- Order: after 2026-10-access-purchases.sql (uses its tables when present).
-- One transaction. Rollback: 2026-11-account-deletion-rollback.sql
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- Guard: the tombstone sets subscription_status = 'deleted'. If production
-- constrains that column (a CHECK or an enum) so that it is refused, every
-- deletion would fail — so abort now. Checked on an empty copy of the
-- table's definition (only the constraints on subscription_status); no
-- customer row is read or touched.
DO $$
DECLARE c text;
BEGIN
  CREATE TEMP TABLE _profiles_probe (LIKE public.profiles INCLUDING CONSTRAINTS);
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'pg_temp._profiles_probe'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) NOT ILIKE '%subscription_status%' LOOP
    EXECUTE format('ALTER TABLE pg_temp._profiles_probe DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = 'pg_temp._profiles_probe'::regclass AND attnum > 0 AND NOT attisdropped AND attnotnull LOOP
    EXECUTE format('ALTER TABLE pg_temp._profiles_probe ALTER COLUMN %I DROP NOT NULL', c);
  END LOOP;
  INSERT INTO pg_temp._profiles_probe (subscription_status) VALUES ('deleted');
  DROP TABLE pg_temp._profiles_probe;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'account deletion: profiles.subscription_status must accept ''deleted'' (%) — nothing applied', SQLERRM;
END $$;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE OR REPLACE FUNCTION delete_account_data(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_prof profiles%ROWTYPE;
  v_n integer; v_bal integer;
  v_out jsonb := '{}'::jsonb;
  t text; c text;
  -- Deleted, in dependency order (children before parents).
  v_delete text[][] := ARRAY[
    ARRAY['creative_asset_comments', 'user_id'], ARRAY['creative_assets', 'user_id'],
    ARRAY['automation_notifications', 'user_id'], ARRAY['automation_approvals', 'user_id'],
    ARRAY['automation_executions', 'user_id'], ARRAY['automation_jobs', 'user_id'],
    ARRAY['automation_settings', 'user_id'], ARRAY['automation_rules', 'user_id'],
    ARRAY['autopilot_tasks', 'user_id'], ARRAY['autopilot_workflows', 'user_id'], ARRAY['autopilot_recommendations', 'user_id'],
    ARRAY['publish_operations', 'user_id'], ARRAY['campaigns', 'user_id'],
    ARRAY['business_audiences', 'user_id'], ARRAY['business_competitors', 'user_id'], ARRAY['business_learnings', 'user_id'],
    ARRAY['business_memory', 'user_id'], ARRAY['business_products', 'user_id'], ARRAY['business_website_knowledge', 'user_id'],
    ARRAY['business_profile', 'user_id'], ARRAY['brand_cores', 'user_id'],
    ARRAY['integrations', 'user_id'], ARRAY['intelligence_events', 'user_id'],
    ARRAY['daily_briefing_cache', 'user_id'], ARRAY['platform_analysis_cache', 'user_id'],
    ARRAY['support_messages', 'user_id'], ARRAY['weekly_reports', 'user_id'],
    ARRAY['onboarding_sessions', 'user_id'], ARRAY['email_sends', 'user_id'],
    ARRAY['team_members', 'owner_user_id'], ARRAY['team_members', 'accepted_user_id']];
  i integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'delete_account_data: service role only'; END IF;
  SELECT * INTO v_prof FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'profile', 'none'); END IF;
  IF v_prof.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'already', true, 'deleted_at', v_prof.deleted_at); END IF;

  -- 1. personal application data
  FOR i IN 1 .. array_length(v_delete, 1) LOOP
    t := v_delete[i][1]; c := v_delete[i][2];
    -- to_regclass on both sides: a missing table must be skipped, never cast (that would raise)
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.' || t) AND attname = c AND attnum > 0 AND NOT attisdropped) THEN CONTINUE; END IF;
    EXECUTE format('DELETE FROM public.%I WHERE %I = $1', t, c) USING p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_out := v_out || jsonb_build_object(t, COALESCE((v_out ->> t)::integer, 0) + v_n); END IF;
  END LOOP;

  -- 2. analytics: kept, anonymised
  IF to_regclass('public.events') IS NOT NULL THEN
    UPDATE events SET user_id = NULL WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_out := v_out || jsonb_build_object('events_anonymised', v_n); END IF;
  END IF;

  -- 4. what the account still had: credits, scheduled instalments, legacy entitlement
  v_bal := COALESCE(v_prof.credits_balance, 0);
  IF to_regclass('public.credit_ledger') IS NOT NULL AND v_bal <> 0 THEN
    INSERT INTO credit_ledger (user_id, kind, delta, balance_after, note) VALUES (p_user_id, 'expire', -v_bal, 0, 'account deleted');
  END IF;
  IF to_regclass('public.credit_grants') IS NOT NULL THEN
    UPDATE credit_grants SET status = 'cancelled' WHERE user_id = p_user_id AND status = 'scheduled';
  END IF;
  IF to_regclass('public.legacy_entitlements') IS NOT NULL THEN
    UPDATE legacy_entitlements SET status = 'ended', ended_at = now(), updated_at = now(),
           reason = COALESCE(reason || '; ', '') || 'account deleted'
     WHERE user_id = p_user_id AND status <> 'ended';
  END IF;

  -- 4. the profile becomes an anonymised tombstone: every column is cleared
  --    except the ones the kept financial records need.
  --    The subscription id is NOT kept: the backend cancels the subscription
  --    first, and later subscription webhooks must never match the tombstone
  --    (legacy_entitlements keeps it for the audit trail).
  DECLARE
    keep text[] := ARRAY['id', 'created_at', 'stripe_customer_id', 'deleted_at'];
    sets text;
  BEGIN
    SELECT string_agg(
             CASE WHEN a.attname = 'subscription_status' THEN 'subscription_status = ''deleted'''
                  WHEN a.attname = 'credits_balance' THEN 'credits_balance = 0'
                  -- NULL, not now(): no access, and the expiry job (which only
                  -- looks at rows with an access period) never rewrites the tombstone
                  WHEN a.attname = 'access_expires_at' THEN 'access_expires_at = NULL'
                  WHEN NOT a.attnotnull THEN format('%I = NULL', a.attname)
                  WHEN a.atthasdef THEN format('%I = DEFAULT', a.attname)
                  -- required text without a default (e.g. an email): blanked, never kept
                  ELSE format('%I = ''''', a.attname)
             END, ', ')
      INTO sets
      FROM pg_attribute a
     WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated = '' AND a.attidentity = ''
       AND NOT (a.attname = ANY (keep))
       AND (NOT a.attnotnull OR a.atthasdef OR a.attname IN ('subscription_status', 'credits_balance', 'access_expires_at')
            OR a.atttypid IN ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)
            OR format_type(a.atttypid, NULL) = 'citext');
    EXECUTE format('UPDATE profiles SET %s, deleted_at = now() WHERE id = $1', sets) USING p_user_id;
  END;

  RETURN jsonb_build_object('ok', true, 'deleted', v_out, 'credits_removed', v_bal);
END; $$;

REVOKE ALL ON FUNCTION delete_account_data(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_account_data(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
