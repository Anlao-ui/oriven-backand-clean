// ════════════════════════════════════════════════════════════════
// Purchase/access function privileges — runs the REAL
// docs/migrations/2026-10-access-purchases.sql against a real Postgres
// (PGlite) set up like Supabase: roles anon / authenticated / service_role
// (BYPASSRLS), auth.role() / auth.uid() from the request's JWT claims, and
// Supabase's default privileges, which grant EXECUTE on every new function
// to anon and authenticated explicitly (not only through PUBLIC).
//
// Proves: before the fix, REVOKE ... FROM PUBLIC left the five functions
// callable by browsers; after it, anon and authenticated can execute none of
// fulfill_purchase, grant_due_credit_instalments, expire_access,
// revoke_purchase, _end_access (nor spend_credits / ensure_free_daily_cycle),
// nothing changes when they try, and service_role runs every entry point —
// including the internal _end_access calls (SECURITY INVOKER, so the caller
// needs EXECUTE on it) — also on a plain Postgres without Supabase's defaults.
//
// Needs @electric-sql/pglite (not a dependency of this app):
//   npm install --no-save @electric-sql/pglite   (or set PGLITE_PATH)
// RUN: node tests/purchase-function-privileges.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let PGlite;
try { PGlite = require(process.env.PGLITE_PATH || '@electric-sql/pglite').PGlite; } catch (_) {
  console.log('SKIPPED — @electric-sql/pglite not installed (npm install --no-save @electric-sql/pglite, or set PGLITE_PATH).');
  process.exit(0);
}
const MIGRATION = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'migrations', '2026-10-access-purchases.sql'), 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); };

const FIVE = {
  fulfill_purchase: 'fulfill_purchase(uuid, text, text, text, integer, integer, text)',
  grant_due_credit_instalments: 'grant_due_credit_instalments(integer)',
  expire_access: 'expire_access(integer)',
  revoke_purchase: 'revoke_purchase(uuid, text, text)',
  _end_access: '_end_access(uuid, text)',
};
const CREDIT = { spend_credits: 'spend_credits(uuid, integer, integer, integer)', ensure_free_daily_cycle: 'ensure_free_daily_cycle(uuid, integer, integer)' };

// The migration as it was before the fix: browser roles revoked only through
// PUBLIC, no EXECUTE for service_role on _end_access, no guard in _end_access.
const BEFORE_FIX = MIGRATION
  .replace(/ FROM PUBLIC, anon, authenticated;/g, ' FROM PUBLIC;')
  .replace(/GRANT EXECUTE ON FUNCTION _end_access\(uuid, text\) TO service_role;\n/, '')
  .replace(/  IF auth\.role\(\) <> 'service_role' THEN RAISE EXCEPTION '_end_access: service role only'; END IF;\n/, '');

async function makeDb({ supabaseDefaults }) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ${supabaseDefaults ? `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;` : ''}
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, email text, subscription_status text DEFAULT 'free',
      credits_balance integer NOT NULL DEFAULT 0, credits_cycle_start timestamptz, credits_cycle_end timestamptz, stripe_subscription_id text);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "select own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
    ${supabaseDefaults ? '' : 'GRANT ALL ON public.profiles TO service_role;'}
  `);
  return db;
}
// Runs SQL as a role with that role's JWT claims, like PostgREST does.
async function as(db, role, sub, sql, params) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.role', '${role}', false), set_config('request.jwt.claim.sub', '${sub || ''}', false);`);
  try { const r = await db.query(sql, params || []); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false), set_config('request.jwt.claim.sub', '', false);`); }
}
const canExec = async (db, role, sig) => (await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, sig])).rows[0].x;
const snapshot = async (db) => JSON.stringify((await db.query(`SELECT
  (SELECT json_agg(p ORDER BY id) FROM (SELECT id, subscription_status, credits_balance, access_expires_at, access_plan FROM profiles) p) AS profiles,
  (SELECT json_agg(x ORDER BY id) FROM (SELECT id, status, access_start, access_end FROM purchases) x) AS purchases,
  (SELECT json_agg(g ORDER BY id) FROM (SELECT id, status, grant_at FROM credit_grants) g) AS grants,
  (SELECT count(*) FROM credit_ledger) AS ledger`)).rows[0]);
const uid = () => crypto.randomUUID();
const newPurchase = (db, user, plan, months, credits, instalments) => db.query(
  `INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, credits_total, instalments) VALUES ($1, $2, $3, 1700, $4, $5, $6) RETURNING id`,
  [uid(), user, plan, months, credits, instalments]).then((r) => r.rows[0].id);
const fulfil = (db, pid) => as(db, 'service_role', '', `SELECT fulfill_purchase($1, $2, $3, 'cus_test', 1700, 295, 'eur') AS r`, [pid, 'cs_test_' + pid, 'pi_test_' + pid]); // session and payment ids are UNIQUE per purchase

(async () => {
  // ═══ A. Supabase-like database ═══
  console.log('\nA. Before the fix (REVOKE ... FROM PUBLIC only), Supabase default privileges');
  let db = await makeDb({ supabaseDefaults: true });
  await db.exec(BEFORE_FIX);
  check('VULNERABLE before: anon can execute fulfill_purchase', await canExec(db, 'anon', FIVE.fulfill_purchase) === true);
  check('VULNERABLE before: authenticated can execute _end_access (which has no guard of its own)', await canExec(db, 'authenticated', FIVE._end_access) === true);
  await db.close();

  console.log('\nB. After the fix — browser roles');
  db = await makeDb({ supabaseDefaults: true });
  await db.exec(MIGRATION);
  check('migration applies to a Supabase-like database', true);
  for (const [name, sig] of Object.entries(FIVE)) {
    check(`anon cannot execute ${name}`, await canExec(db, 'anon', sig) === false);
    check(`authenticated cannot execute ${name}`, await canExec(db, 'authenticated', sig) === false);
  }
  for (const [name, sig] of Object.entries(CREDIT)) check(`anon and authenticated cannot execute ${name}`, await canExec(db, 'anon', sig) === false && await canExec(db, 'authenticated', sig) === false);
  for (const name of ['fulfill_purchase', 'grant_due_credit_instalments', 'expire_access', 'revoke_purchase']) check(`service_role can execute ${name}`, await canExec(db, 'service_role', FIVE[name]) === true);
  check('service_role can execute _end_access (needed: the entry points call it as SECURITY INVOKER)', await canExec(db, 'service_role', FIVE._end_access) === true);
  const defs = (await db.query(`SELECT proname, prosecdef FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [Object.keys(FIVE)])).rows;
  check('all five are SECURITY INVOKER (no definer rights to escalate through)', defs.length === 5 && defs.every((d) => d.prosecdef === false), defs);

  // Accounts for the attempts and the flows
  const U = { expired: uid(), lapsed: uid(), refund: uid(), annual: uid(), victim: uid(), attacker: uid() };
  await db.query(`INSERT INTO profiles (id, subscription_status, credits_balance, access_expires_at, access_plan) VALUES
    ($1, 'paid', 40, now() - interval '2 days', 'monthly'),
    ($2, 'paid', 30, now() - interval '1 hour', 'monthly'),
    ($3, 'free', 0, NULL, NULL),
    ($4, 'free', 0, NULL, NULL),
    ($5, 'paid', 500, now() + interval '20 days', 'monthly'),
    ($6, 'paid', 10, now() + interval '20 days', 'monthly')`, [U.expired, U.lapsed, U.refund, U.annual, U.victim, U.attacker]);
  const victimPurchase = await newPurchase(db, U.victim, 'monthly', 1, 500, 1);

  console.log('\nC. Browsers trying to call the functions directly (as PostgREST would)');
  const before = await snapshot(db);
  const attempts = [
    ['fulfill_purchase', `SELECT fulfill_purchase('${victimPurchase}', 's', 'p', 'c', 1700, 0, 'eur')`],
    ['grant_due_credit_instalments', `SELECT grant_due_credit_instalments(500)`],
    ['expire_access', `SELECT expire_access(500)`],
    ['revoke_purchase', `SELECT revoke_purchase('${victimPurchase}', 'refunded', 'x')`],
    ['_end_access', `SELECT _end_access('${U.victim}', 'x')`],
    ['spend_credits', `SELECT * FROM spend_credits('${U.attacker}', 1, 0, 1)`],
  ];
  for (const role of ['anon', 'authenticated']) {
    for (const [name, sql] of attempts) {
      const r = await as(db, role, role === 'authenticated' ? U.attacker : '', sql);
      check(`${role} → ${name}: permission denied`, !r.ok && /permission denied for function/.test(r.error), r);
    }
  }
  const r0 = await as(db, 'authenticated', U.victim, `SELECT _end_access('${U.victim}', 'x')`);
  check('a signed-in user cannot end their own access either', !r0.ok && /permission denied for function/.test(r0.error), r0);
  check('after every attempt: no credit, access, status, purchase, grant or ledger change', (await snapshot(db)) === before);

  console.log('\nD. service_role: every entry point works, including the internal _end_access calls');
  // fulfill_purchase on an account whose access already ended → _end_access first, then the grant
  let pid = await newPurchase(db, U.expired, 'monthly', 1, 300, 1);
  let r = await fulfil(db, pid);
  let led = (await db.query(`SELECT kind, delta FROM credit_ledger WHERE user_id = $1 ORDER BY id`, [U.expired])).rows;
  let p = (await db.query(`SELECT credits_balance, subscription_status, access_expires_at > now() AS active FROM profiles WHERE id = $1`, [U.expired])).rows[0];
  check('fulfill_purchase (service_role) on expired access: old 40 credits expired via _end_access, 300 granted, access active', r.ok && r.rows[0].r.ok === true && JSON.stringify(led) === JSON.stringify([{ kind: 'expire', delta: -40 }, { kind: 'grant', delta: 300 }]) && p.credits_balance === 300 && p.active && p.subscription_status === 'paid', { r, led, p });
  // expire_access → _end_access
  r = await as(db, 'service_role', '', `SELECT expire_access(500) AS n`);
  p = (await db.query(`SELECT credits_balance, subscription_status FROM profiles WHERE id = $1`, [U.lapsed])).rows[0];
  check('expire_access (service_role): lapsed account ended via _end_access → 0 credits, free, ledger row', r.ok && r.rows[0].n === 1 && p.credits_balance === 0 && p.subscription_status === 'free' && (await db.query(`SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND kind = 'expire'`, [U.lapsed])).rows[0].n === 1, { r, p });
  // revoke_purchase of the only purchase → _end_access
  pid = await newPurchase(db, U.refund, 'monthly', 1, 300, 1);
  await fulfil(db, pid);
  r = await as(db, 'service_role', '', `SELECT revoke_purchase($1, 'refunded', 'test') AS r`, [pid]);
  p = (await db.query(`SELECT credits_balance, subscription_status, access_expires_at <= now() AS ended FROM profiles WHERE id = $1`, [U.refund])).rows[0];
  check('revoke_purchase (service_role): full refund removes the credits and ends access via _end_access', r.ok && r.rows[0].r.ok === true && p.credits_balance === 0 && p.subscription_status === 'free' && p.ended === true, { r, p });
  // grant_due_credit_instalments
  pid = await newPurchase(db, U.annual, 'annual', 12, 1200, 12);
  await fulfil(db, pid);
  await db.query(`UPDATE credit_grants SET grant_at = now() - interval '1 minute' WHERE purchase_id = $1 AND instalment = 1`, [pid]);
  r = await as(db, 'service_role', '', `SELECT grant_due_credit_instalments(500) AS n`);
  p = (await db.query(`SELECT credits_balance FROM profiles WHERE id = $1`, [U.annual])).rows[0];
  check('grant_due_credit_instalments (service_role): due instalment granted (100 + 100)', r.ok && r.rows[0].n === 1 && p.credits_balance === 200, { r, p });
  // _end_access refuses a caller without the service role even where EXECUTE exists (its owner)
  await db.exec(`SELECT set_config('request.jwt.claim.role', 'authenticated', false)`);
  let own; try { await db.query(`SELECT _end_access($1, 'x')`, [U.victim]); own = 'ran'; } catch (e) { own = e.message; }
  await db.exec(`SELECT set_config('request.jwt.claim.role', '', false)`);
  check('_end_access has its own guard: refuses a non-service caller even with EXECUTE', /_end_access: service role only/.test(own), own);
  check('the victim account was never touched', (await db.query(`SELECT credits_balance, subscription_status FROM profiles WHERE id = $1`, [U.victim])).rows[0].credits_balance === 500);
  await db.close();

  // ═══ E. Plain Postgres (no Supabase default grants) ═══
  console.log('\nE. Plain Postgres without default function grants: the explicit GRANTs alone are enough');
  db = await makeDb({ supabaseDefaults: false });
  await db.exec(BEFORE_FIX);
  await db.exec(`GRANT ALL ON purchases, credit_grants, credit_ledger TO service_role; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
  const lapsedOld = uid();
  await db.query(`INSERT INTO profiles (id, subscription_status, credits_balance, access_expires_at) VALUES ($1, 'paid', 30, now() - interval '1 hour')`, [lapsedOld]);
  r = await as(db, 'service_role', '', `SELECT expire_access(500) AS n`);
  check('before the fix: expire_access fails for service_role — no EXECUTE on the internal _end_access', !r.ok && /permission denied for function _end_access/.test(r.error), r);
  await db.close();
  db = await makeDb({ supabaseDefaults: false });
  await db.exec(MIGRATION);
  await db.exec(`GRANT ALL ON purchases, credit_grants, credit_ledger TO service_role; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
  await db.query(`INSERT INTO profiles (id, subscription_status, credits_balance, access_expires_at) VALUES ($1, 'paid', 30, now() - interval '1 hour')`, [lapsedOld]);
  r = await as(db, 'service_role', '', `SELECT expire_access(500) AS n`);
  check('after the fix: expire_access works for service_role through the explicit GRANT on _end_access', r.ok && r.rows[0].n === 1, r);
  for (const [name, sig] of Object.entries(FIVE)) check(`plain Postgres: anon/authenticated cannot execute ${name}`, await canExec(db, 'anon', sig) === false && await canExec(db, 'authenticated', sig) === false);
  // Re-running the migration keeps the same privileges (CREATE OR REPLACE keeps ACLs; REVOKE/GRANT are idempotent)
  await db.exec(MIGRATION);
  check('re-running the migration: same privileges', await canExec(db, 'authenticated', FIVE._end_access) === false && await canExec(db, 'service_role', FIVE._end_access) === true && await canExec(db, 'service_role', FIVE.fulfill_purchase) === true);
  await db.close();

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100); // let PGlite settle first (Windows libuv abort otherwise)
})().catch((e) => { console.log('CRASH', e && e.stack || e); setTimeout(() => process.exit(1), 100); });
