# Production migration & deployment — November 2026

Prepared 2026-11-04, final review 2026-11-05. **Nothing in this document has been run against production.**
Every SQL file is a single transaction (`BEGIN … COMMIT`): it applies completely or not at all, and every
file is safe to run again.

## 1. What is pending (verified read-only on 2026-11-04)

| File | What it does | Data changed? | Run as |
|------|--------------|---------------|--------|
| `2026-10-access-purchases.sql` | One-time purchases, access periods, credit instalments, expiry, refunds/disputes; **legacy transition** (entitlements + snapshot, aborts if any balance or plan changes); free top-up off; backend-only EXECUTE; aborts first if `profiles.subscription_status` cannot hold `'paid'`. | Yes — see §3 | `postgres` (SQL Editor) |
| `2026-10-onboarding-sessions.sql` | Guided-onboarding table (backend-only). | No | `postgres` |
| `2026-11-account-deletion.sql` | `profiles.deleted_at` + `delete_account_data()` (service role); aborts first if `subscription_status` cannot hold `'deleted'`. | No (until an account is deleted) | `postgres` |
| `2026-10-profiles-lockdown.sql` | Browsers lose all write access to `profiles` (table + column grants). | No | `postgres` |
| `2026-11-integrations-owner-lockdown.sql` | **Only if `integrations` is not manageable by `postgres`** (§4.2): browsers lose all access to `integrations` (OAuth tokens), RLS on, service role keeps ALL. No ownership change. | No | **the owner of `integrations`** |
| `2026-11-browser-write-lockdown.sql` | Allowlist: browsers may only read `profiles`/`brand_cores` and write their own `brand_cores`; anon nothing; no TRUNCATE/MAINTAIN anywhere; views covered; pre-flight + self-check + a probe of the frontend's reads; aborts on anything open. | No | `postgres` |
| `2026-11-function-privileges.sql` | No browser EXECUTE on credit/usage/purchase functions and `rls_auto_enable`; `increment_autopilot_usage` → SECURITY INVOKER; future functions not browser-executable. | No | `postgres` |

Already applied (structure verified): every other file in this folder, incl. `2026-10-stripe-webhook-events.sql`
and the creative bucket. `2026-08-team-seats.sql` is not applied and not needed.

## 2. Order and why

There is **no maintenance mode** in the app, so the order is chosen so that every intermediate state works:

| Step | What | Why here |
|------|------|----------|
| A (days ahead) | `2026-11-integrations-owner-lockdown.sql` — only if §4.2 says so | Needs Supabase support; removes only access the app never uses. |
| B | `2026-10-access-purchases.sql` | The **old** backend keeps working on it: legacy subscribers keep access (entitlement, 7 days ahead), free users can no longer spend (intended). The **new** backend cannot work without it (no `purchases`, no `access_expires_at`). |
| C | `2026-10-onboarding-sessions.sql` | Needs `purchases` (B). Unused by the old backend. |
| D | `2026-11-account-deletion.sql` | Uses B's tables. Unused by the old backend. |
| E | **Deploy the new backend**, then **the new frontend** | Backend first: the new frontend calls backend routes the old backend lacks (`/api/profile/ensure`, purchases). The old frontend still works with the new backend. |
| F | `2026-10-profiles-lockdown.sql` | Only after E: the old frontend creates profiles from the browser; the new backend creates them server-side. |
| G | `2026-11-browser-write-lockdown.sql` | Only after E (the new frontend writes only `brand_cores`) and F; covers every table from B–D; after A where needed. |
| H | `2026-11-function-privileges.sql` | Last: re-asserts EXECUTE on every function created by B and D. |
| I | Gap check (§5.6) | Someone may have bought a legacy subscription through the old checkout between B and E. |

Between B and E (keep it to minutes): free users cannot spend, and the old checkout still sells monthly
subscriptions — step I gives such a buyer an entitlement.

## 3. What changes for existing customers (B)

- `legacy_transition_snapshot`: every profile's plan, balance, cycle end and Stripe-subscription flag before the change.
- `legacy_entitlements`, one row per legacy subscriber (in production: 2):
  - **Creator** (Stripe subscription id present) → `needs_review`: access kept until Stripe confirms. The nightly
    safety net asks Stripe: paid → `active`; canceled/unpaid/deleted → `ended` (access ends ≤ 7 days later and the
    expiry job then removes the credits — as before the migration); unknown subscription → stays `needs_review`
    (never revoked on that alone); `past_due` → unchanged.
  - **Professional** (no Stripe subscription) → `manual`, `active`, **no end date**.
- Both get access at least 7 days ahead, refreshed every 10 minutes (`refresh_legacy_entitlements`). While an
  entitlement is active/needs review the expiry job never ends the account and never sets its credits to 0, and
  spending works even if the refresh job is late.
- **Free accounts** (33, of which 21 hold 230 credits): balances untouched; no free daily top-up; balances never
  expire (no access period) and are kept when the account buys a plan. They cannot be spent without a purchase.
- Safety check: if any balance or plan changes during the migration, it aborts and nothing is applied.
- Ending an entitlement is only possible with `update_legacy_entitlement(user, status, ends_at, reason)` (backend,
  or an admin in the SQL Editor; reason mandatory, appended with a timestamp).
- **Deleting an account** of a legacy Stripe subscriber cancels the Stripe subscription first; if Stripe cannot
  confirm, nothing is deleted.

## 4. Before the window

1. **Backups**: Supabase backup / PITR confirmed; export `profiles`, `credit_transactions`, `credit_actions`;
   save the output of `docs/verification/2026-11-pending-migrations-verify.sql` blocks 3, 5, 6–12 (current
   functions, grants, policies, constraints — the basis for an exact rollback).
2. **Ownership — `integrations` in particular** (verification block 4 showed it may be owned by `supabase_admin`).
   Only an object's owner can remove privileges on it; a REVOKE by any other role merely warns and changes nothing.
   The SQL Editor runs as `postgres`, which is not `supabase_admin` and cannot act as it — so `postgres` can
   neither lock this table nor `ALTER TABLE … OWNER TO postgres` it. Until it is locked, `anon`/`authenticated`
   keep Supabase's default grants on it.

   Check in the SQL Editor (read-only):
   ```sql
   SELECT c.relname AS table_name, c.relkind, pg_get_userbyid(c.relowner) AS owner, current_user AS editor_role,
          pg_has_role(current_user, c.relowner, 'USAGE') AS can_manage, c.relrowsecurity AS rls_enabled
     FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT pg_has_role(current_user, c.relowner, 'USAGE');
   ```
   - **No rows** → skip step A; step G handles every table, `integrations` included.
   - **`integrations`, owner `supabase_admin`** → `2026-11-integrations-owner-lockdown.sql` must be executed by
     the database role **`supabase_admin`**. Only Supabase can do that: open a support ticket (Dashboard → Support,
     project ref) with the file attached, asking them to *run it unchanged as `supabase_admin`*. It revokes all
     `PUBLIC`/`anon`/`authenticated` privileges on `public.integrations` (table and column level), enables RLS,
     grants ALL to `service_role` and verifies itself; it changes no ownership, policy or data. Afterwards
     verification block 6 must show `false` for anon/authenticated and `true` for service_role on `integrations`.
   - **`integrations`, another owner** → run the same file as that role.
   - **Any other object listed** → it needs the same treatment by its owner; step G's pre-flight error lists
     exactly what is open on it. Do not proceed until it is resolved.

   Step G does not skip such an object: its pre-flight aborts before changing anything while it is still open, and
   accepts it unchanged once its owner has locked it. **Do not change ownership just to get past this** — that is
   a separate decision (§7.6). `rls_auto_enable` may also be owned by Supabase; step H then reports a NOTICE —
   check block 10 afterwards.
3. **Read-only facts the repository cannot show** (SQL Editor; each must return the expected result):
   ```sql
   -- a) step G probes the frontend's reads as `authenticated`: expect true
   SELECT pg_has_role('authenticated', 'MEMBER') AS editor_can_act_as_authenticated;

   -- b) tables with a user column that account deletion neither deletes nor deliberately keeps: expect no rows
   SELECT DISTINCT c.relname AS table_name, a.attname AS column_name
     FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      AND (a.attname ~ '(^|_)user_id$'
           OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f' AND a.attnum = ANY (k.conkey)
                         AND k.confrelid IN ('public.profiles'::regclass, 'auth.users'::regclass)))
      AND c.relname NOT IN ('profiles',
           -- deleted by delete_account_data
           'creative_asset_comments','creative_assets','automation_notifications','automation_approvals','automation_executions',
           'automation_jobs','automation_settings','automation_rules','autopilot_tasks','autopilot_workflows','autopilot_recommendations',
           'publish_operations','campaigns','business_audiences','business_competitors','business_learnings','business_memory',
           'business_products','business_website_knowledge','business_profile','brand_cores','integrations','intelligence_events',
           'daily_briefing_cache','platform_analysis_cache','support_messages','weekly_reports','onboarding_sessions','email_sends','team_members',
           -- anonymised / kept on purpose (bookkeeping, abuse prevention, unsubscribe)
           'events','purchases','credit_grants','credit_ledger','credit_transactions','credit_actions','legacy_entitlements',
           'legacy_transition_snapshot','stripe_webhook_events','free_first_ad_claims','email_suppressions','site_pageviews');

   -- c) required non-text profile columns without a default (a deleted profile would keep them): expect no rows
   SELECT attname, format_type(atttypid, atttypmod)
     FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attnum > 0 AND NOT attisdropped
      AND attnotnull AND NOT atthasdef AND attgenerated = '' AND attidentity = ''
      AND attname NOT IN ('id', 'created_at', 'stripe_customer_id', 'deleted_at', 'subscription_status', 'credits_balance', 'access_expires_at')
      AND format_type(atttypid, NULL) NOT IN ('text', 'character varying', 'character', 'citext');
   ```
   A row in (b) is personal data the deletion would leave behind: add that table to the delete list in
   `2026-11-account-deletion.sql` (children before parents) before the window. A row in (c): tell the developer.
4. **Stripe** (dashboard, Live Mode): five one-time EUR prices, tax behaviour *Inclusive*; Stripe Tax on with the
   required registrations; webhook endpoint with the events listed in `.env.example`. The same in Test Mode for
   staging.
5. **Environment** (backend host): `STRIPE_PRICE_<PLAN>_LIVE` for the five plans (see `.env.example`) set **before**
   step E; production uses the live key. The backend logs which mode and which prices are missing; checkout refuses
   a missing, recurring, non-inclusive or wrong-mode price.
6. **Staging rehearsal** (strongly recommended): a Supabase branch or a separate project restored from a backup;
   run A–I, deploy the new backend with the test key, buy each plan in Test Mode, refund one, dispute one, let one
   expire, delete one account (also one with a test-mode subscription).
7. **Decisions** in §7 taken.

## 5. In the window (low-traffic time; ~15 minutes)

1. Step A done (if needed) and confirmed (block 6).
2. SQL Editor, one file per run: B → C → D. Each must end with COMMIT; on an error nothing of that file is
   applied — stop, the old backend keeps running unchanged.
3. Step E: deploy the backend (the reviewed, committed local changes), wait until healthy, then the frontend.
4. SQL Editor: F → G → H. If G stops with `browser lockdown blocked`, step A has not been done for the object it
   names; if it stops with `incomplete` or the probe message, nothing was applied — read the message.
5. Verification script: block 1 (all present), 3 (`new`), 6/7 (browsers: SELECT only on profiles/brand_cores,
   write only brand_cores, all `LOCKED`), 10 (no browser-executable function), and
   `SELECT user_id, kind, status, ends_at FROM legacy_entitlements;` (2 rows),
   `SELECT classification, count(*), sum(credits_balance) FROM legacy_transition_snapshot GROUP BY 1;`
   (compare with the counts in §3).
6. Gap check (step I) — expect no rows:
   ```sql
   SELECT p.id, p.subscription_status FROM profiles p
    WHERE p.subscription_status IN ('starter', 'creator', 'professional')
      AND NOT EXISTS (SELECT 1 FROM legacy_entitlements e WHERE e.user_id = p.id);
   ```
   Rows → re-run `2026-10-access-purchases.sql` (safe: it only adds the missing entitlements and snapshot rows).
7. Smoke test: sign in as each legacy account (credits visible, an AI action works); a free account sees the
   paywall and its balance is unchanged; sign up a new test account (profile created, onboarding starts); the
   backend logs `[Access]` without errors.

## 6. Recovery and rollback

- A failed file applies nothing; fix the cause and run it again.
- Backend deploy fails after B–D: redeploy the previous backend; it works on the new schema (legacy access kept,
  free users cannot spend). Before rolling the schema back too, run step I.
- Rollbacks, reverse order: `2026-11-function-privileges-rollback.sql` → `2026-11-browser-write-lockdown-rollback.sql`
  → `2026-11-account-deletion-rollback.sql` → `2026-10-access-purchases-rollback.sql`, then the previous backend.
  `2026-10-profiles-lockdown.sql` has no rollback file (re-grant only if the old frontend must return:
  `GRANT INSERT, UPDATE ON public.profiles TO authenticated;`). `2026-10-onboarding-sessions.sql` has its rollback
  in its last lines (drops only that table).
- Rollbacks change no balance and keep all records (purchases, ledger, entitlements, snapshot). Rolling back the
  access migration restores the free daily top-up, which resets free balances at their next cycle (the
  pre-migration behaviour); the snapshot keeps every balance as it was.
- The lockdown rollback reopens browser access (emergency only); it leaves objects it does not own (e.g.
  `integrations`) locked and lists them in a NOTICE. `2026-11-integrations-owner-lockdown-rollback.sql` (owner only,
  keeps RLS on) exists but should not be needed — the app never accesses `integrations` from the browser.

## 7. Decisions needed

1. **Professional (manual) account**: keep open-ended or set an end date (`update_legacy_entitlement`).
2. **Legacy Stripe `past_due`**: currently keeps access indefinitely (as before). Set a limit?
3. **Free balances**: preserved and usable after a purchase (default). Should they be spendable without a purchase?
4. **Retention on account deletion**: purchases, ledger, credit transactions/actions, the Stripe customer id and the
   legacy entitlement (with its Stripe subscription id) are kept (bookkeeping); analytics anonymised; unsubscribe
   list kept. The Stripe customer object itself (name, email, invoices) stays in Stripe. Confirm the retention period
   with your accountant and whether Stripe customers should be anonymised after it.
5. **Manual legacy refill**: the nightly job sets a manual legacy account's balance to the plan allowance every 30
   days (existing behaviour; can lower a higher balance). Keep?
6. **`integrations` ownership** (only if owned by `supabase_admin`): step A secures it without changing ownership.
   Future migrations that alter this table will also need Supabase to run them. You can additionally ask Supabase
   support for `ALTER TABLE public.integrations OWNER TO postgres;` — a deliberate choice, not required for security.
