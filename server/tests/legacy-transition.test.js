// ════════════════════════════════════════════════════════════════
// Legacy customer transition — runs the REAL
// docs/migrations/2026-10-access-purchases.sql (and its rollback) against a
// real Postgres (PGlite) set up like Supabase, with the account mix found in
// production on 2026-11-04: one Creator with a Stripe subscription id whose
// credits_cycle_end has passed (800 credits), one Professional without a
// Stripe subscription (3,400 credits), 21 free accounts holding 230 credits
// and 12 free accounts without credits.
//
// Proves: the transition changes no balance and no plan; nobody's access is
// derived from credits_cycle_end; both legacy accounts get an explicit,
// auditable entitlement and keep access and credits even when the refresh
// job is late; only an explicit decision (Stripe confirmed the end / an
// admin end date) ends an entitlement; free balances are preserved and
// carried into a first purchase; no free top-up; a balance changed during
// the migration aborts it completely; re-runs and the rollback are safe.
//
// Needs @electric-sql/pglite (not a dependency of this app):
//   npm install --no-save @electric-sql/pglite   (or set PGLITE_PATH)
// RUN: node tests/legacy-transition.test.js   (from oriven-backend/server)
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
const MIGRATION = fs.readFileSync(path.join(MIG, '2026-10-access-purchases.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIG, '2026-10-access-purchases-rollback.sql'), 'utf8');
const FREE_PLAN = fs.readFileSync(path.join(MIG, '2026-08-free-plan.sql'), 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 500))); };
const uid = () => crypto.randomUUID();

const BASE = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, email text, subscription_status text DEFAULT 'free', created_at timestamptz DEFAULT now(),
    credits_balance integer NOT NULL DEFAULT 0, credits_cycle_start timestamptz, credits_cycle_end timestamptz,
    credits_provisioned_plan text, credits_last_reset_source text, stripe_customer_id text, stripe_subscription_id text);
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "select own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);`;

async function as(db, role, sql, params) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.role', '${role}', false);`);
  try { const r = await db.query(sql, params || []); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false);`); }
}
const svc = (db, sql, params) => as(db, 'service_role', sql, params);

// The production account mix (2026-11-04), with the free plan's functions in place.
async function productionLike() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(FREE_PLAN);
  const ids = { creator: uid(), pro: uid(), freeWith: [], freeEmpty: [] };
  await db.query(`INSERT INTO profiles (id, email, subscription_status, credits_balance, credits_cycle_end, stripe_subscription_id, stripe_customer_id) VALUES
    ($1, 'creator@example.invalid', 'creator', 800, now() - interval '3 days', 'sub_creator', 'cus_creator'),
    ($2, 'pro@example.invalid', 'professional', 3400, now() + interval '4 days', NULL, NULL)`, [ids.creator, ids.pro]);
  // 21 free accounts with 230 credits in total (20 × 11 + 10), 12 without
  for (let i = 0; i < 21; i++) { const id = uid(); ids.freeWith.push(id); await db.query(`INSERT INTO profiles (id, email, subscription_status, credits_balance, credits_cycle_end) VALUES ($1, $2, 'free', $3, now() - interval '2 days')`, [id, 'f' + i + '@example.invalid', i < 20 ? 11 : 10]); }
  for (let i = 0; i < 12; i++) { const id = uid(); ids.freeEmpty.push(id); await db.query(`INSERT INTO profiles (id, email, subscription_status, credits_balance) VALUES ($1, $2, 'free', 0)`, [id, 'e' + i + '@example.invalid']); }
  return { db, ids };
}
const balances = async (db) => (await db.query(`SELECT id, subscription_status, credits_balance FROM profiles ORDER BY id`)).rows;
const prof = async (db, id) => (await db.query(`SELECT *, access_expires_at > now() + interval '6 days 23 hours' AS ahead7 FROM profiles WHERE id = $1`, [id])).rows[0];
const ent = async (db, id) => (await db.query(`SELECT * FROM legacy_entitlements WHERE user_id = $1`, [id])).rows[0];

(async () => {
  // ═══ 1. The transition itself ═══
  console.log('\n1. Migration on the production account mix');
  let { db, ids } = await productionLike();
  const before = await balances(db);
  const totalBefore = before.reduce((n, r) => n + r.credits_balance, 0);
  check('fixture matches production: 35 accounts, 33 free, 21 free with 230 credits', before.length === 35 && before.filter((r) => r.subscription_status === 'free').length === 33 && before.filter((r) => r.subscription_status === 'free' && r.credits_balance > 0).reduce((n, r) => n + r.credits_balance, 0) === 230);
  await db.exec(MIGRATION);
  const after = await balances(db);
  check('no balance and no plan changed (every account, exactly)', JSON.stringify(after) === JSON.stringify(before) && after.reduce((n, r) => n + r.credits_balance, 0) === totalBefore);
  const snap = (await db.query(`SELECT classification, count(*)::int AS n, sum(credits_balance)::int AS c FROM legacy_transition_snapshot GROUP BY 1 ORDER BY 1`)).rows;
  check('snapshot of all 35 accounts: 1 legacy_stripe, 1 legacy_manual, 21 free_with_credits (230), 12 free_no_credits', JSON.stringify(snap) === JSON.stringify([
    { classification: 'free_no_credits', n: 12, c: 0 }, { classification: 'free_with_credits', n: 21, c: 230 }, { classification: 'legacy_manual', n: 1, c: 3400 }, { classification: 'legacy_stripe', n: 1, c: 800 }]), snap);
  let c = await prof(db, ids.creator), p = await prof(db, ids.pro);
  let ce = await ent(db, ids.creator), pe = await ent(db, ids.pro);
  check('Creator: Stripe subscription id alone proves nothing → entitlement needs_review, no end date', ce && ce.kind === 'stripe_subscription' && ce.status === 'needs_review' && ce.ends_at === null && ce.stripe_subscription_id === 'sub_creator', ce);
  check('Creator: access NOT derived from the passed cycle end (old rule: ends in ~0 days) — at least 7 days ahead', c.ahead7 === true && c.access_plan === 'creator', c);
  check('Professional (no Stripe subscription): explicit manual entitlement, active, no end date', pe && pe.kind === 'manual' && pe.status === 'active' && pe.ends_at === null, pe);
  check('Professional: access at least 7 days ahead (old rule would have been cycle end + 3)', p.ahead7 === true, p);
  check('free accounts: no access, no entitlement, balance untouched', (await db.query(`SELECT count(*)::int AS n FROM profiles WHERE subscription_status = 'free' AND access_expires_at IS NULL`)).rows[0].n === 33 && (await db.query(`SELECT count(*)::int AS n FROM legacy_entitlements`)).rows[0].n === 2);

  console.log('\n2. Legacy accounts keep access and credits, even when the refresh job is late');
  let r = await svc(db, `SELECT * FROM spend_credits($1, 50, 0, 1)`, [ids.creator]);
  check('Creator can spend (800 → 750)', r.ok && r.rows[0].ok === true && r.rows[0].balance === 750, r);
  r = await svc(db, `SELECT * FROM spend_credits($1, 100, 0, 1)`, [ids.pro]);
  check('Professional can spend (3,400 → 3,300)', r.ok && r.rows[0].ok === true && r.rows[0].balance === 3300, r);
  // The job stalled for a week: access_expires_at is in the past.
  await db.query(`UPDATE profiles SET access_expires_at = now() - interval '1 hour' WHERE id IN ($1, $2)`, [ids.creator, ids.pro]);
  r = await svc(db, `SELECT expire_access(500) AS n`);
  c = await prof(db, ids.creator); p = await prof(db, ids.pro);
  check('expire_access never ends a protected account: balances 750 / 3,300 kept, plans kept', r.ok && r.rows[0].n === 0 && c.credits_balance === 750 && p.credits_balance === 3300 && c.subscription_status === 'creator' && p.subscription_status === 'professional', { r, c: c.credits_balance, p: p.credits_balance });
  r = await svc(db, `SELECT * FROM spend_credits($1, 10, 0, 1)`, [ids.creator]);
  check('…and spending still works while access_expires_at lags (entitlement counts)', r.ok && r.rows[0].ok === true && r.rows[0].balance === 740, r);
  r = await svc(db, `SELECT refresh_legacy_entitlements() AS n`);
  c = await prof(db, ids.creator); p = await prof(db, ids.pro);
  check('refresh_legacy_entitlements moves both back to at least 7 days ahead', r.ok && r.rows[0].n === 2 && c.ahead7 && p.ahead7, r);
  r = await svc(db, `SELECT refresh_legacy_entitlements() AS n`);
  check('…and is a no-op when already ahead', r.ok && r.rows[0].n === 0, r);

  console.log('\n3. Free accounts: balance preserved, no top-up, carried into a purchase');
  const f0 = ids.freeWith[0];
  r = await svc(db, `SELECT * FROM ensure_free_daily_cycle($1, 20, 1)`, [f0]);
  check('free daily top-up is off (balance stays 11, no reset to 20)', r.ok && (await prof(db, f0)).credits_balance === 11, r);
  r = await svc(db, `SELECT * FROM spend_credits($1, 5, 20, 1)`, [f0]);
  check('free account cannot spend without paid access — and nothing is taken', r.ok && r.rows[0].ok === false && (await prof(db, f0)).credits_balance === 11, r);
  r = await svc(db, `SELECT expire_access(500) AS n`);
  check('the expiry job never touches free balances (no access period)', (await db.query(`SELECT sum(credits_balance)::int AS s FROM profiles WHERE subscription_status = 'free'`)).rows[0].s === 230);
  const pid = uid();
  await db.query(`INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, credits_total, instalments) VALUES ($1, $2, 'monthly', 2900, 1, 1750, 1)`, [pid, f0]);
  r = await svc(db, `SELECT fulfill_purchase($1, 'cs_t1', 'pi_t1', 'cus_t1', 2900, 503, 'eur') AS r`, [pid]);
  check('first purchase keeps the earned free credits: 11 + 1,750 = 1,761', r.ok && r.rows[0].r.ok === true && (await prof(db, f0)).credits_balance === 1761, r);

  console.log('\n4. Only an explicit decision ends an entitlement');
  r = await svc(db, `SELECT update_legacy_entitlement($1, 'active', NULL, 'verified with Stripe: active, payment confirmed') AS r`, [ids.creator]);
  ce = await ent(db, ids.creator);
  check('Stripe verification → active, reason kept with a timestamp', r.ok && ce.status === 'active' && /verified with Stripe/.test(ce.reason) && /transition:/.test(ce.reason), ce);
  r = await svc(db, `SELECT update_legacy_entitlement($1, 'active', NULL, '') AS r`, [ids.creator]);
  check('a change without a reason is refused', !r.ok && /reason is required/.test(r.error), r);
  // Stripe ends the subscription: the backend ends the entitlement; access ends now (as before the migration)
  r = await svc(db, `SELECT update_legacy_entitlement($1, 'ended', NULL, 'Stripe subscription sub_creator is canceled') AS r`, [ids.creator]);
  await db.query(`UPDATE profiles SET access_expires_at = now() - interval '1 minute' WHERE id = $1`, [ids.creator]);
  r = await svc(db, `SELECT expire_access(500) AS n`);
  c = await prof(db, ids.creator); p = await prof(db, ids.pro);
  const led = (await db.query(`SELECT kind, delta FROM credit_ledger WHERE user_id = $1`, [ids.creator])).rows;
  check('after Stripe confirmed the end: the expiry ends the Creator (credits expire, ledger row) — and only the Creator', r.ok && r.rows[0].n === 1 && c.credits_balance === 0 && c.subscription_status === 'free' && JSON.stringify(led) === JSON.stringify([{ kind: 'expire', delta: -740 }]) && p.credits_balance === 3300, { r, led, p: p.credits_balance });
  r = await svc(db, `SELECT update_legacy_entitlement($1, 'active', NULL, 'reopen') AS r`, [ids.creator]);
  check('an ended entitlement stays ended (no silent reopening)', r.ok && r.rows[0].r.already === true && (await ent(db, ids.creator)).status === 'ended', r);
  // Admin decides an end date for the manual Professional
  r = await svc(db, `SELECT update_legacy_entitlement($1, 'active', now() + interval '2 days', 'admin: manual Professional grant ends') AS r`, [ids.pro]);
  await db.query(`UPDATE profiles SET access_expires_at = now() + interval '1 hour' WHERE id = $1`, [ids.pro]);
  await svc(db, `SELECT refresh_legacy_entitlements()`);
  p = await prof(db, ids.pro);
  check('with a decided end date, refresh never extends access beyond it', Math.abs(new Date(p.access_expires_at) - (Date.now() + 2 * 864e5)) < 120e3, p.access_expires_at);
  await db.query(`UPDATE legacy_entitlements SET ends_at = now() - interval '1 minute' WHERE user_id = $1`, [ids.pro]);
  await db.query(`UPDATE profiles SET access_expires_at = now() - interval '1 minute' WHERE id = $1`, [ids.pro]);
  r = await svc(db, `SELECT refresh_legacy_entitlements() AS n`);
  pe = await ent(db, ids.pro);
  check('once the decided end date has passed, refresh ends the entitlement (recorded)', r.ok && pe.status === 'ended' && /end date reached/.test(pe.reason) && pe.ended_at, pe);
  r = await svc(db, `SELECT expire_access(500) AS n`);
  check('…and then the normal expiry applies', r.ok && r.rows[0].n === 1 && (await prof(db, ids.pro)).credits_balance === 0);

  console.log('\n5. Permissions of the new functions and tables');
  for (const fn of ['_legacy_protected(uuid)', 'refresh_legacy_entitlements()', 'update_legacy_entitlement(uuid, text, timestamptz, text)']) {
    const x = (await db.query(`SELECT has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') b, has_function_privilege('service_role', $1, 'EXECUTE') s`, [fn])).rows[0];
    check(`${fn}: browsers cannot execute, service_role can`, x.a === false && x.b === false && x.s === true, x);
  }
  for (const t of ['legacy_entitlements', 'legacy_transition_snapshot']) {
    const x = (await db.query(`SELECT has_table_privilege('anon', $1, 'SELECT') a, has_table_privilege('authenticated', $1, 'SELECT') b, has_table_privilege('authenticated', $1, 'TRUNCATE') t`, ['public.' + t])).rows[0];
    check(`${t}: no browser access at all (incl. TRUNCATE)`, x.a === false && x.b === false && x.t === false, x);
  }
  r = await as(db, 'authenticated', `SELECT update_legacy_entitlement($1, 'active', NULL, 'self-service')`, [ids.pro]);
  check('a signed-in user cannot change an entitlement', !r.ok && /permission denied/.test(r.error), r);

  console.log('\n6. Re-run and rollback');
  const entBefore = JSON.stringify((await db.query(`SELECT user_id, status, reason FROM legacy_entitlements ORDER BY user_id`)).rows);
  const snapBefore = JSON.stringify((await db.query(`SELECT * FROM legacy_transition_snapshot ORDER BY user_id`)).rows);
  let err = null; try { await db.exec(MIGRATION); } catch (e) { err = e.message; }
  check('re-running the migration: no error, entitlements and snapshot unchanged (ended stays ended)', !err && JSON.stringify((await db.query(`SELECT user_id, status, reason FROM legacy_entitlements ORDER BY user_id`)).rows) === entBefore && JSON.stringify((await db.query(`SELECT * FROM legacy_transition_snapshot ORDER BY user_id`)).rows) === snapBefore, err);
  const balBeforeRollback = JSON.stringify(await balances(db));
  err = null; try { await db.exec(ROLLBACK); } catch (e) { err = e.message; }
  const fns = (await db.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`)).rows.map((x) => x.proname);
  check('rollback: purchase and entitlement functions removed, previous spend_credits / ensure_free_daily_cycle back', !err && !fns.some((f) => ['fulfill_purchase', 'expire_access', 'revoke_purchase', 'grant_due_credit_instalments', '_end_access', '_legacy_protected', 'refresh_legacy_entitlements', 'update_legacy_entitlement'].includes(f)) && fns.includes('spend_credits') && fns.includes('ensure_free_daily_cycle'), { err, fns });
  const src = (await db.query(`SELECT prosrc FROM pg_proc WHERE proname = 'spend_credits'`)).rows[0].prosrc;
  check('rollback: spend_credits is the previous version (free top-up), service_role only', /ensure_free_daily_cycle/.test(src) && (await db.query(`SELECT has_function_privilege('authenticated', 'spend_credits(uuid,integer,integer,integer)', 'EXECUTE') x`)).rows[0].x === false && (await db.query(`SELECT has_function_privilege('service_role', 'spend_credits(uuid,integer,integer,integer)', 'EXECUTE') x`)).rows[0].x === true);
  check('rollback: no balance changed, records kept (purchases, entitlements, snapshot)', JSON.stringify(await balances(db)) === balBeforeRollback && (await db.query(`SELECT count(*)::int n FROM purchases`)).rows[0].n === 1 && (await db.query(`SELECT count(*)::int n FROM legacy_entitlements`)).rows[0].n === 2 && (await db.query(`SELECT count(*)::int n FROM legacy_transition_snapshot`)).rows[0].n === 35);
  await db.close();

  console.log('\n7. A balance changed during the migration aborts it completely');
  ({ db, ids } = await productionLike());
  // Something (a stray trigger) changes credits while access is set.
  await db.exec(`CREATE FUNCTION stray() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.access_expires_at IS DISTINCT FROM OLD.access_expires_at THEN NEW.credits_balance := 0; END IF; RETURN NEW; END $$;`);
  const b7 = await balances(db);
  await db.exec(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS access_expires_at timestamptz; CREATE TRIGGER stray BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION stray();`);
  err = null; try { await db.exec(MIGRATION); } catch (e) { err = e.message; }
  await db.exec('ROLLBACK').catch(() => {});
  check('the safety check aborts the migration with a clear message', /legacy transition: 2 profile\(s\) changed balance or plan/.test(err || ''), err);
  check('…and nothing was applied (no purchases table, no entitlements, balances intact)', (await db.query(`SELECT to_regclass('public.purchases') IS NULL AS x, to_regclass('public.legacy_entitlements') IS NULL AS y`)).rows[0].x === true && JSON.stringify(await balances(db)) === JSON.stringify(b7));
  await db.close();

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100); // let PGlite settle first (Windows libuv abort otherwise)
})().catch((e) => { console.log('CRASH', e && e.stack || e); setTimeout(() => process.exit(1), 100); });
