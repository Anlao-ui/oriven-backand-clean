// ════════════════════════════════════════════════════════════════
// Account deletion — runs the REAL docs/migrations/2026-11-account-deletion.sql
// (with the real migrations that create the tables it touches) against a
// real Postgres (PGlite) set up like Supabase. Tables that were created
// outside the migrations in production (business_*, brand_cores,
// integrations, intelligence_events) are recreated with the same
// user_id → profiles foreign key (NO ACTION, as found in production).
//
// Proves: a plain profile delete fails (the problem); delete_account_data
// removes every personal application row, anonymises analytics events,
// keeps purchases / grants / ledger / credit transactions / credit actions
// and the profile as an anonymised tombstone they still reference, cancels
// scheduled instalments, records the removed credits, ends a legacy
// entitlement, leaves other accounts untouched, is idempotent, browser roles
// cannot call it, and it works on a database where most tables don't exist.
//
// Needs @electric-sql/pglite:  npm install --no-save @electric-sql/pglite  (or PGLITE_PATH)
// RUN: node tests/account-deletion.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let PGlite;
try { PGlite = require(process.env.PGLITE_PATH || '@electric-sql/pglite').PGlite; } catch (_) {
  console.log('SKIPPED — @electric-sql/pglite not installed (npm install --no-save @electric-sql/pglite, or set PGLITE_PATH).');
  process.exit(0);
}
const MIG = path.resolve(__dirname, '..', 'docs', 'migrations');
const read = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 500))); };
const uid = () => crypto.randomUUID();

const BASE = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, first_name text, last_name text, email text, created_at timestamptz DEFAULT now(),
    subscription_status text DEFAULT 'free', onboarding_completed boolean, updated_at timestamptz, free_campaign_used boolean,
    usage_data jsonb, preferences jsonb, credits_balance integer DEFAULT 0, credits_cycle_start timestamptz, credits_cycle_end timestamptz,
    timezone text, credits_last_reset_source text, autopilot_executions_used integer NOT NULL DEFAULT 0, autopilot_cycle_reset_at timestamptz,
    credits_provisioned_plan text, campaigns_generated integer NOT NULL DEFAULT 0, stripe_customer_id text, stripe_subscription_id text,
    pending_plan text, pending_plan_date timestamptz);
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;`;
// Production tables that were not created by a migration file: same foreign key behaviour (NO ACTION).
const NON_MIGRATION = ['business_profile', 'business_products', 'business_audiences', 'business_competitors', 'business_learnings', 'business_memory', 'business_website_knowledge', 'brand_cores', 'integrations', 'intelligence_events']
  .map((t) => `CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.profiles(id), data jsonb);`).join('\n');
const MIGRATIONS = ['2026-08-credit-economy.sql', '2026-09-automation-rules-schema-cache.sql', '2026-09-autopilot-recommendations-tasks-workflows.sql',
  '2026-09-campaigns-durable-persistence.sql', '2026-10-onboarding-activation.sql', '2026-10-email-lifecycle.sql', '2026-10-free-first-ad.sql',
  '2026-10-credit-actions.sql', '2026-10-stripe-webhook-events.sql', '2026-10-automations.sql', '2026-10-creative-assets.sql',
  '2026-10-publish-operations.sql', '2026-10-weekly-reports.sql', '2026-10-access-purchases.sql', '2026-10-onboarding-sessions.sql',
  '2026-11-account-deletion.sql'];

async function as(db, role, sql, params) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.role', '${role}', false);`);
  try { const r = await db.query(sql, params || []); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false);`); }
}

// Every kind of row an active customer has.
async function seedCustomer(db, id, tag) {
  const q = (sql, p) => db.query(sql, p);
  await q(`INSERT INTO auth.users (id) VALUES ($1)`, [id]);
  await q(`INSERT INTO profiles (id, first_name, last_name, email, subscription_status, credits_balance, stripe_customer_id, preferences, timezone)
           VALUES ($1, $2, 'Doe', $3, 'paid', 900, $4, '{"lang":"nl"}', 'Europe/Amsterdam')`, [id, 'Name' + tag, tag + '@example.invalid', 'cus_' + tag]);
  for (const t of ['business_profile', 'business_products', 'business_audiences', 'business_competitors', 'business_learnings', 'business_memory', 'business_website_knowledge', 'brand_cores', 'integrations', 'intelligence_events'])
    await q(`INSERT INTO ${t} (user_id, data) VALUES ($1, '{"x":1}')`, [id]);
  await q(`INSERT INTO credit_transactions (user_id, feature_key, credits_cost, charged, success, request_id) VALUES ($1, 'ai_chat', 30, true, true, $2)`, [id, uid()]);
  await q(`INSERT INTO daily_briefing_cache (user_id, local_date, timezone_used, content) VALUES ($1, current_date, 'UTC', '{}')`, [id]);
  await q(`INSERT INTO support_messages (user_id, sender, body) VALUES ($1, 'user', 'help')`, [id]);
  const camp = uid();
  await q(`INSERT INTO campaigns (id, user_id, source, name) VALUES ($1, $2, 'manual', 'Spring')`, [camp, id]);
  const rule = uid();
  await q(`INSERT INTO automation_rules (id, user_id, name, action_type, mode, kind) VALUES ($1, $2, 'r', 'pause_campaign', 'approval', 'rule')`, [rule, id]);
  await q(`INSERT INTO automation_executions (id, user_id, automation_id, source, action, status, idempotency_key) VALUES ($1, $2, $3, 'rule', 'pause_campaign', 'completed', $4)`, [uid(), id, rule, 'ex-' + tag]);
  await q(`INSERT INTO creative_assets (id, user_id, kind) VALUES ($1, $2, 'image')`, [uid(), id]);
  await q(`INSERT INTO events (event_name, user_id) VALUES ('signup', $1), ('first_value', $1)`, [id]);
  await q(`INSERT INTO email_sends (user_id, template, dedupe_key, category, status) VALUES ($1, 'welcome', $2, 'service', 'sent')`, [id, 'w-' + tag]);
  await q(`INSERT INTO onboarding_sessions (user_id) VALUES ($1)`, [id]);
  await q(`INSERT INTO credit_actions (id, user_id, lane, idempotency_key, status) VALUES ($1, $2, 'image', $3, 'succeeded')`, [uid(), id, 'k-' + tag]);
  const pid = uid();
  await q(`INSERT INTO purchases (id, user_id, plan_id, status, price_incl_vat_cents, duration_months, credits_total, instalments, access_start, access_end, paid_at)
           VALUES ($1, $2, 'quarterly', 'paid', 7800, 3, 4800, 3, now(), now() + interval '3 months', now())`, [pid, id]);
  await q(`INSERT INTO credit_grants (purchase_id, user_id, instalment, credits, grant_at, status, granted_at) VALUES
           ($1, $2, 0, 1600, now(), 'granted', now()), ($1, $2, 1, 1600, now() + interval '1 month', 'scheduled', NULL)`, [pid, id]);
  await q(`INSERT INTO credit_ledger (user_id, kind, delta, balance_after, purchase_id) VALUES ($1, 'grant', 1600, 1600, $2)`, [id, pid]);
  return { pid, camp };
}
const countFor = async (db, t, id, col) => (await db.query(`SELECT count(*)::int n FROM ${t} WHERE ${col || 'user_id'} = $1`, [id])).rows[0].n;

(async () => {
  const db = new PGlite();
  await db.exec(BASE + NON_MIGRATION);
  for (const f of MIGRATIONS) { try { await db.exec(read(f)); } catch (e) { check('fixture: migration ' + f, false, e.message); throw e; } }
  check('fixture: the real migrations apply (account-deletion last)', true);
  const A = uid(), B = uid();
  const a = await seedCustomer(db, A, 'a');
  await seedCustomer(db, B, 'b');

  console.log('\n1. The problem');
  let err = null; try { await db.query('BEGIN'); await db.query(`DELETE FROM profiles WHERE id = $1`, [A]); } catch (e) { err = e.message; } await db.query('ROLLBACK');
  check('a plain profile delete fails on NO ACTION foreign keys (why deletion broke)', /violates foreign key constraint/.test(err || ''), err);

  console.log('\n2. delete_account_data');
  let r = await as(db, 'anon', `SELECT delete_account_data($1)`, [A]);
  const r1 = await as(db, 'authenticated', `SELECT delete_account_data($1)`, [A]);
  check('browser roles cannot call it (not even for themselves)', !r.ok && !r1.ok && /permission denied/.test(r.error + r1.error), { r, r1 });
  r = await as(db, 'service_role', `SELECT delete_account_data($1) AS r`, [A]);
  check('service role: runs, reports what it removed and the credits removed (900)', r.ok && r.rows[0].r.ok === true && r.rows[0].r.credits_removed === 900, r);
  const gone = ['business_profile', 'business_products', 'business_audiences', 'business_competitors', 'business_learnings', 'business_memory', 'business_website_knowledge',
    'brand_cores', 'integrations', 'intelligence_events', 'campaigns', 'automation_rules', 'automation_executions', 'creative_assets', 'onboarding_sessions', 'email_sends', 'support_messages', 'daily_briefing_cache'];
  const left = []; for (const t of gone) if (await countFor(db, t, A)) left.push(t);
  check('all personal application data removed (business, brand, ad-platform tokens, campaigns, automations, creatives, onboarding, emails, support)', left.length === 0, left);
  check('analytics events kept but anonymised', (await countFor(db, 'events', A)) === 0 && (await db.query(`SELECT count(*)::int n FROM events WHERE user_id IS NULL`)).rows[0].n === 2);
  const kept = {
    purchases: await countFor(db, 'purchases', A), credit_grants: await countFor(db, 'credit_grants', A), credit_transactions: await countFor(db, 'credit_transactions', A),
    credit_actions: await countFor(db, 'credit_actions', A), credit_ledger: await countFor(db, 'credit_ledger', A),
  };
  check('financial records kept: purchase, 2 grants, credit transaction, credit action, ledger (grant + removal)', kept.purchases === 1 && kept.credit_grants === 2 && kept.credit_transactions === 1 && kept.credit_actions === 1 && kept.credit_ledger === 2, kept);
  const grants = (await db.query(`SELECT instalment, status FROM credit_grants WHERE user_id = $1 ORDER BY instalment`, [A])).rows;
  check('the scheduled instalment is cancelled, the granted one stays as history', JSON.stringify(grants) === JSON.stringify([{ instalment: 0, status: 'granted' }, { instalment: 1, status: 'cancelled' }]), grants);
  const led = (await db.query(`SELECT kind, delta, note FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [A])).rows[0];
  check('the removed credits are recorded in the ledger', led.kind === 'expire' && led.delta === -900 && led.note === 'account deleted', led);
  const p = (await db.query(`SELECT * FROM profiles WHERE id = $1`, [A])).rows[0];
  check('profile = anonymised tombstone: no name, email, preferences, timezone', p && p.first_name === null && p.last_name === null && p.email === null && p.preferences === null && p.timezone === null, p);
  check('…keeps id, created_at and the Stripe customer id (for refunds/disputes on the kept purchase), marked deleted, no credits, no access', p.id === A && p.created_at && p.stripe_customer_id === 'cus_a' && p.subscription_status === 'deleted' && p.credits_balance === 0 && p.deleted_at && p.access_expires_at === null, p);
  r = await as(db, 'service_role', `SELECT expire_access() AS n`);
  const p2 = (await db.query(`SELECT subscription_status, deleted_at FROM profiles WHERE id = $1`, [A])).rows[0];
  check('the expiry job leaves the deleted profile alone (still marked deleted, no extra ledger row)', r.ok && p2.subscription_status === 'deleted' && (await db.query(`SELECT count(*)::int n FROM credit_ledger WHERE user_id = $1 AND note = 'access ended'`, [A])).rows[0].n === 0, { r, p2 });
  check('the kept purchase still references an existing profile (no orphan)', (await db.query(`SELECT count(*)::int n FROM purchases pu JOIN profiles pr ON pr.id = pu.user_id WHERE pu.id = $1`, [a.pid])).rows[0].n === 1);
  r = await as(db, 'service_role', `SELECT * FROM spend_credits($1, 1, 0, 1)`, [A]);
  check('a deleted account cannot spend', r.ok && r.rows[0].ok === false, r);
  const bLeft = []; for (const t of gone.concat(['purchases', 'credit_ledger'])) if (!(await countFor(db, t, B))) bLeft.push(t);
  check('the other customer is untouched', bLeft.length === 0 && (await db.query(`SELECT email FROM profiles WHERE id = $1`, [B])).rows[0].email === 'b@example.invalid', bLeft);

  console.log('\n3. Idempotent, legacy entitlement, missing tables, rollback');
  r = await as(db, 'service_role', `SELECT delete_account_data($1) AS r`, [A]);
  check('running it again changes nothing (already deleted)', r.ok && r.rows[0].r.already === true && (await countFor(db, 'credit_ledger', A)) === 2, r);
  const L = uid();
  await db.query(`INSERT INTO profiles (id, email, subscription_status, credits_balance) VALUES ($1, 'l@example.invalid', 'professional', 3400)`, [L]);
  await db.query(`INSERT INTO legacy_entitlements (user_id, kind, plan, status) VALUES ($1, 'manual', 'professional', 'active')`, [L]);
  r = await as(db, 'service_role', `SELECT delete_account_data($1) AS r`, [L]);
  const le = (await db.query(`SELECT status, reason FROM legacy_entitlements WHERE user_id = $1`, [L])).rows[0];
  check('a legacy entitlement ends with the account (recorded)', r.ok && le.status === 'ended' && /account deleted/.test(le.reason), le);
  r = await as(db, 'service_role', `SELECT delete_account_data($1) AS r`, [uid()]);
  check('an unknown account: no error, nothing to do', r.ok && r.rows[0].r.profile === 'none', r);
  await db.close();

  const mini = new PGlite();
  await mini.exec(BASE);
  let e2 = null; try { await mini.exec(read('2026-11-account-deletion.sql')); } catch (e) { e2 = e.message; }
  const M = uid();
  await mini.query(`INSERT INTO profiles (id, email, credits_balance) VALUES ($1, 'm@example.invalid', 5)`, [M]);
  r = await as(mini, 'service_role', `SELECT delete_account_data($1) AS r`, [M]);
  check('works on a database where none of the other tables exist (skips them)', !e2 && r.ok && r.rows[0].r.ok === true && (await mini.query(`SELECT email FROM profiles WHERE id = $1`, [M])).rows[0].email === null, { e2, r });
  e2 = null; try { await mini.exec(read('2026-11-account-deletion-rollback.sql')); } catch (e) { e2 = e.message; }
  check('rollback: function removed, deleted_at marker kept', !e2 && (await mini.query(`SELECT to_regprocedure('delete_account_data(uuid)') IS NULL x`)).rows[0].x === true && (await mini.query(`SELECT deleted_at IS NOT NULL x FROM profiles WHERE id = $1`, [M])).rows[0].x === true, e2);
  await mini.close();

  // Production's profiles may differ from the repository: a required text
  // column without a default (e.g. a NOT NULL email) must be blanked, not kept;
  // the Stripe subscription id goes, the customer id stays.
  const strict = new PGlite();
  await strict.exec(BASE + `ALTER TABLE public.profiles ADD COLUMN phone text NOT NULL DEFAULT 'x'; ALTER TABLE public.profiles ALTER COLUMN phone DROP DEFAULT;
                            ALTER TABLE public.profiles ADD COLUMN display_handle varchar(40) NOT NULL DEFAULT 'h'; ALTER TABLE public.profiles ALTER COLUMN display_handle DROP DEFAULT;`);
  e2 = null; try { await strict.exec(read('2026-11-account-deletion.sql')); } catch (e) { e2 = e.message; }
  const S = uid();
  await strict.query(`INSERT INTO profiles (id, email, phone, display_handle, stripe_customer_id, stripe_subscription_id) VALUES ($1, 's@example.invalid', '+31600000000', 'sam_d', 'cus_S', 'sub_S')`, [S]);
  r = await as(strict, 'service_role', `SELECT delete_account_data($1) AS r`, [S]);
  const sp = (await strict.query(`SELECT * FROM profiles WHERE id = $1`, [S])).rows[0];
  check('required text columns without a default are blanked (no phone number or handle kept)', !e2 && r.ok && sp.phone === '' && sp.display_handle === '' && sp.email === null, { e2, r, sp });
  check('the tombstone keeps the Stripe customer id (kept purchases) but not the subscription id (no webhook matches it)', sp.stripe_customer_id === 'cus_S' && sp.stripe_subscription_id === null, sp);
  await strict.close();

  // Guards: a production CHECK on subscription_status that would refuse the
  // values these migrations write aborts the migration before anything changes.
  const guarded = new PGlite();
  await guarded.exec(BASE + `ALTER TABLE public.profiles ADD CONSTRAINT profiles_plan_check CHECK (subscription_status IN ('free', 'starter', 'creator', 'professional'));
                             ALTER TABLE public.profiles ADD CONSTRAINT profiles_email_check CHECK (email IS NOT NULL);`);
  e2 = null; try { await guarded.exec(read('2026-11-account-deletion.sql')); } catch (e) { e2 = e.message; }
  await guarded.exec('ROLLBACK').catch(() => {});
  check('account deletion: a CHECK that refuses \'deleted\' → aborts with a clear message, nothing applied', /must accept 'deleted'/.test(e2 || '') && (await guarded.query(`SELECT to_regprocedure('delete_account_data(uuid)') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'deleted_at') x`)).rows[0].x === true, e2);
  e2 = null; try { await guarded.exec(read('2026-10-access-purchases.sql')); } catch (e) { e2 = e.message; }
  await guarded.exec('ROLLBACK').catch(() => {});
  check('access purchases: a CHECK that refuses \'paid\' → aborts before anything changes', /must accept 'paid' and 'free'/.test(e2 || '') && (await guarded.query(`SELECT to_regclass('public.purchases') IS NULL x`)).rows[0].x === true, e2);
  await guarded.exec(`ALTER TABLE public.profiles DROP CONSTRAINT profiles_plan_check;
                      ALTER TABLE public.profiles ADD CONSTRAINT profiles_plan_check CHECK (subscription_status IN ('free', 'starter', 'creator', 'professional', 'paid', 'deleted'));`);
  e2 = null; try { await guarded.exec(read('2026-11-account-deletion.sql')); } catch (e) { e2 = e.message; }
  check('…a widened CHECK (and an unrelated CHECK on another column) passes the guard; re-running in the same session works', !e2 && !(await guarded.exec(read('2026-11-account-deletion.sql')).then(() => null, (x) => x.message)), e2);
  await guarded.close();

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.log('CRASH', e && e.stack || e); setTimeout(() => process.exit(1), 100); });
