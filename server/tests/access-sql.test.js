// ════════════════════════════════════════════════════════════════
// docs/migrations/2026-10-access-purchases.sql, executed for real in an
// in-process Postgres (PGlite): purchases, instalments, expiry, refunds,
// disputes, renewals, spending and the rollback.
//
// PGlite is not a dependency of this project. The test SKIPS (exit 0) unless
// it can load '@electric-sql/pglite' (install it anywhere and point
// NODE_PATH at that node_modules folder). No network, no Supabase.
//
// RUN: NODE_PATH=/path/to/node_modules node tests/access-sql.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {
  console.log('SKIP — @electric-sql/pglite not found (set NODE_PATH to a node_modules folder that has it)');
  process.exit(0);
}

const MIG = path.join(__dirname, '..', 'docs', 'migrations');
const migration = fs.readFileSync(path.join(MIG, '2026-10-access-purchases.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(MIG, '2026-10-access-purchases-rollback.sql'), 'utf8');
const pricing = require('../services/pricing');

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 500) : '')); } }
const uid = () => crypto.randomUUID();

// The parts of the existing schema these functions touch, plus Supabase's auth helpers.
const BASE = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(current_setting('test.role', true), 'service_role') $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
CREATE TABLE profiles (
  id uuid PRIMARY KEY, subscription_status text DEFAULT 'free',
  credits_balance integer NOT NULL DEFAULT 0, credits_cycle_start timestamptz, credits_cycle_end timestamptz,
  credits_provisioned_plan text, credits_last_reset_source text, stripe_subscription_id text
);`;

async function fresh(seed) {
  const db = new PGlite();
  await db.exec(BASE);
  if (seed) await db.exec(seed);
  await db.exec(migration);
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params || [])).rows[0];
const all = async (db, sql, params) => (await db.query(sql, params || [])).rows;
async function profile(db, id) { return one(db, 'SELECT * FROM profiles WHERE id = $1', [id]); }
async function newUser(db, extra) {
  const id = uid();
  await db.query('INSERT INTO profiles (id, subscription_status, credits_balance) VALUES ($1, $2, $3)', [id, (extra && extra.status) || 'free', (extra && extra.balance) || 0]);
  return id;
}
async function newPurchase(db, userId, planId) {
  const p = pricing.planById(planId), id = uid();
  await db.query(`INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, duration_days, credits_total, instalments)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, userId, planId, pricing.priceInclVatCents(p), p.months, p.days, p.credits, p.instalments]);
  return id;
}
const fulfill = async (db, purchaseId, planId, over) => {
  const cents = pricing.priceInclVatCents(pricing.planById(planId));
  const o = Object.assign({ session: 'cs_test_' + purchaseId.slice(0, 8), pi: 'pi_' + purchaseId.slice(0, 8), amount: cents, tax: Math.round(cents - cents / 1.21), currency: 'eur' }, over || {});
  return (await one(db, 'SELECT fulfill_purchase($1, $2, $3, $4, $5, $6, $7) AS r', [purchaseId, o.session, o.pi, 'cus_x', o.amount, o.tax, o.currency])).r;
};
const spend = async (db, userId, amount) => one(db, 'SELECT * FROM spend_credits($1, $2)', [userId, amount]);
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

(async () => {
  // ── Legacy subscribers keep access through the migration ──
  const legacyId = uid(), freeId = uid();
  const db = await fresh(`INSERT INTO profiles (id, subscription_status, credits_balance, credits_cycle_end) VALUES
    ('${legacyId}', 'creator', 1200, now() + interval '10 days'),
    ('${freeId}', 'free', 7, now() + interval '1 day');`);
  const lp = await profile(db, legacyId), fp = await profile(db, freeId);
  // Access is no longer derived from credits_cycle_end: an explicit entitlement keeps it (refreshed 7 days ahead).
  const le = (await db.query('SELECT kind, status FROM legacy_entitlements WHERE user_id = $1', [legacyId])).rows[0];
  check('legacy subscriber: explicit entitlement keeps access (≥ 7 days ahead, not cycle end + 3); balance untouched', lp.access_expires_at && days(new Date(), lp.access_expires_at) === 7 && lp.credits_balance === 1200 && lp.access_plan === 'creator' && le && le.kind === 'manual' && le.status === 'active', { lp, le });
  check('free account: no access, balance kept in the data (not deleted)', fp.access_expires_at === null && fp.credits_balance === 7, fp);
  check('legacy subscriber can still spend', (await spend(db, legacyId, 25)).ok === true);
  const fs1 = await spend(db, freeId, 5);
  check('free account can no longer spend (no daily top-up, no access)', fs1.ok === false && fs1.balance === 0 && (await profile(db, freeId)).credits_balance === 7, fs1);
  const efc = await one(db, 'SELECT * FROM ensure_free_daily_cycle($1, 10, 1)', [freeId]);
  check('ensure_free_daily_cycle is a no-op', efc.reset === false && (await profile(db, freeId)).credits_balance === 7, efc);
  // A legacy subscriber who cancelled into 'free' before their date: the
  // status decides, not the leftover date.
  await db.query("UPDATE profiles SET subscription_status = 'free', access_expires_at = now() + interval '5 days' WHERE id = $1", [freeId]);
  const fs2 = await spend(db, freeId, 5);
  check('status free with a future access date still can’t spend', fs2.ok === false && (await profile(db, freeId)).credits_balance === 7, fs2);

  // ── Monthly purchase ──
  const u1 = await newUser(db);
  const m1 = await newPurchase(db, u1, 'monthly');
  const r1 = await fulfill(db, m1, 'monthly');
  const p1 = await profile(db, u1);
  check('Monthly: paid → access for one calendar month, 1,750 credits, status paid', r1.ok && r1.fulfilled && p1.credits_balance === 1750 && p1.subscription_status === 'paid' && p1.access_plan === 'monthly' && days(new Date(), p1.access_expires_at) >= 28 && days(new Date(), p1.access_expires_at) <= 31, { r1, p1 });
  const led1 = await all(db, 'SELECT * FROM credit_ledger WHERE user_id = $1', [u1]);
  check('ledger records the grant (kind, delta, balance after, purchase)', led1.length === 1 && led1[0].kind === 'grant' && led1[0].delta === 1750 && led1[0].balance_after === 1750 && led1[0].purchase_id === m1, led1);
  const r1b = await fulfill(db, m1, 'monthly');
  check('the same payment again (webhook retry / return sync) grants nothing', r1b.already === true && (await profile(db, u1)).credits_balance === 1750 && (await all(db, 'SELECT 1 FROM credit_ledger WHERE user_id = $1', [u1])).length === 1, r1b);

  // ── Refused payments ──
  const u2 = await newUser(db);
  const m2 = await newPurchase(db, u2, 'monthly');
  const r2 = await fulfill(db, m2, 'monthly', { amount: 100 });
  const r2c = await fulfill(db, m2, 'monthly', { currency: 'usd' });
  check('a payment with the wrong amount or currency grants nothing', r2.ok === false && r2.reason === 'amount_mismatch' && r2c.reason === 'currency_mismatch' && (await profile(db, u2)).access_expires_at === null && (await one(db, 'SELECT status FROM purchases WHERE id = $1', [m2])).status === 'pending', [r2, r2c]);

  // ── Concurrency: the balance can't be overspent ──
  await db.query('UPDATE profiles SET credits_balance = 50 WHERE id = $1', [u1]);
  const [s1, s2] = await Promise.all([spend(db, u1, 40), spend(db, u1, 40)]);
  check('two simultaneous 40-credit spends on 50 credits: exactly one succeeds', [s1.ok, s2.ok].filter(Boolean).length === 1 && (await profile(db, u1)).credits_balance === 10, [s1, s2]);

  // ── Annual: monthly instalments ──
  const u3 = await newUser(db);
  const a1 = await newPurchase(db, u3, 'annual');
  await fulfill(db, a1, 'annual');
  const g3 = await all(db, 'SELECT * FROM credit_grants WHERE purchase_id = $1 ORDER BY instalment', [a1]);
  const p3 = await profile(db, u3);
  check('Annual: 12 instalments of 1,250; the first now, the rest monthly inside the year', g3.length === 12 && g3.every((g) => g.credits === 1250) && g3[0].status === 'granted' && g3.slice(1).every((g) => g.status === 'scheduled' && new Date(g.grant_at) < new Date(p3.access_expires_at)) && p3.credits_balance === 1250 && days(new Date(), p3.access_expires_at) >= 364, { n: g3.length, bal: p3.credits_balance });
  check('Annual instalments are about one month apart', days(g3[1].grant_at, g3[2].grant_at) >= 28 && days(g3[1].grant_at, g3[2].grant_at) <= 31, [g3[1].grant_at, g3[2].grant_at]);
  check('nothing is granted before it is due', (await one(db, 'SELECT grant_due_credit_instalments(100) AS n')).n === 0 && (await profile(db, u3)).credits_balance === 1250);
  await db.query("UPDATE credit_grants SET grant_at = now() - interval '1 second' WHERE purchase_id = $1 AND instalment = 1", [a1]);
  const n3 = (await one(db, 'SELECT grant_due_credit_instalments(100) AS n')).n;
  const n3b = (await one(db, 'SELECT grant_due_credit_instalments(100) AS n')).n;
  check('a due instalment is granted exactly once (repeat runs add nothing)', n3 === 1 && n3b === 0 && (await profile(db, u3)).credits_balance === 2500 && (await all(db, "SELECT 1 FROM credit_ledger WHERE user_id = $1 AND kind = 'grant'", [u3])).length === 2, { n3, n3b });

  // ── Manual renewal before expiry extends, never overlaps ──
  const m1b = await newPurchase(db, u1, 'monthly');
  const before = (await profile(db, u1)).access_expires_at;
  const rr = await fulfill(db, m1b, 'monthly');
  const after = await profile(db, u1);
  check('renewal before expiry: the new period starts when the current one ends; credits added now', new Date(rr.access_start).getTime() === new Date(before).getTime() && days(before, after.access_expires_at) >= 28 && after.credits_balance === 10 + 1750, { before, rr, bal: after.credits_balance });

  // ── Refund of the renewal: access and credits go back ──
  const rv = (await one(db, "SELECT revoke_purchase($1, 'refunded', 'test') AS r", [m1b])).r;
  const afterRefund = await profile(db, u1);
  check('full refund of a stacked renewal: its unused period and its credits are removed, the first month stays', rv.revoked && new Date(afterRefund.access_expires_at).getTime() === new Date(before).getTime() && afterRefund.credits_balance === 10 && afterRefund.subscription_status === 'paid', { rv, afterRefund });
  const rv2 = (await one(db, "SELECT revoke_purchase($1, 'disputed', 'test') AS r", [m1b])).r;
  check('revoking again (refund then dispute event) changes nothing', rv2.already === true && (await profile(db, u1)).credits_balance === 10, rv2);

  // ── Refund of the only purchase ends access ──
  const u4 = await newUser(db);
  const m4 = await newPurchase(db, u4, 'quarterly');
  await fulfill(db, m4, 'quarterly');
  await spend(db, u4, 600);
  const rv4 = (await one(db, "SELECT revoke_purchase($1, 'disputed', 'chargeback') AS r", [m4])).r;
  const p4 = await profile(db, u4);
  const g4 = await all(db, 'SELECT status FROM credit_grants WHERE purchase_id = $1 ORDER BY instalment', [m4]);
  check('dispute on the only purchase: access ends now, remaining credits removed, future instalments cancelled', rv4.revoked && p4.credits_balance === 0 && p4.subscription_status === 'free' && new Date(p4.access_expires_at) <= new Date() && g4.slice(1).every((g) => g.status === 'cancelled') && (await one(db, 'SELECT status FROM purchases WHERE id = $1', [m4])).status === 'disputed', { rv4, p4, g4 });
  check('a cancelled instalment is never granted later', (await one(db, "UPDATE credit_grants SET grant_at = now() WHERE purchase_id = $1 RETURNING 1", [m4])) && (await one(db, 'SELECT grant_due_credit_instalments(100) AS n')).n === 0 && (await profile(db, u4)).credits_balance === 0);

  // ── Expiry ──
  const u5 = await newUser(db);
  const s5 = await newPurchase(db, u5, 'semiannual');
  await fulfill(db, s5, 'semiannual');
  await db.query("UPDATE profiles SET access_expires_at = now() - interval '1 second' WHERE id = $1", [u5]);
  const spendExpired = await spend(db, u5, 25);
  check('expired access: spending refused even before the expiry job runs', spendExpired.ok === false && spendExpired.balance === 0, spendExpired);
  const ex = (await one(db, 'SELECT expire_access(100) AS n')).n;
  const p5 = await profile(db, u5);
  check('expiry job: credits expire with access, status free, remaining instalments cancelled, ledger entry', ex >= 1 && p5.credits_balance === 0 && p5.subscription_status === 'free' && (await all(db, "SELECT 1 FROM credit_grants WHERE purchase_id = $1 AND status = 'scheduled'", [s5])).length === 0 && (await one(db, "SELECT delta FROM credit_ledger WHERE user_id = $1 AND kind = 'expire'", [u5])).delta === -1475, p5);
  check('expiry job is idempotent', (await one(db, 'SELECT expire_access(100) AS n')).n === 0);

  // ── Buying after expiry doesn't revive expired credits ──
  const u6 = await newUser(db);
  const f6 = await newPurchase(db, u6, 'flex');
  await fulfill(db, f6, 'flex');
  await db.query("UPDATE profiles SET access_expires_at = now() - interval '1 hour' WHERE id = $1", [u6]); // expiry job hasn't run
  const f6b = await newPurchase(db, u6, 'flex');
  const r6 = await fulfill(db, f6b, 'flex');
  const p6 = await profile(db, u6);
  check('Flex bought after an unswept expiry: old credits expire first, 14 new days from now, 1,050 credits', p6.credits_balance === 1050 && days(r6.access_start, r6.access_end) === 14 && Math.abs(new Date(r6.access_start) - Date.now()) < 60000, { p6, r6 });

  // ── Flex bought again while a Flex period is active: queued, never overlapping ──
  // Product decision 2026-11-12: Flex is not limited to one purchase per
  // account and never renews automatically. Buying again during an active
  // period is the documented manual extension: the new 14 days start when the
  // current period ends. One access window on the profile, no second entitlement.
  const activeEnd = (await profile(db, u6)).access_expires_at;
  const f6c = await newPurchase(db, u6, 'flex');
  const r6c = await fulfill(db, f6c, 'flex');
  const p6c = await profile(db, u6);
  // The first Flex (f6) was expired artificially on the profile above, so only the periods in force are compared.
  const rows6 = await all(db, "SELECT id, access_start, access_end FROM purchases WHERE id = ANY($1::uuid[]) ORDER BY access_start", [[f6b, f6c]]);
  check('Flex during an active Flex period: queued after the current end (+14 days), one access date on the profile, plan still flex', new Date(r6c.access_start).getTime() === new Date(activeEnd).getTime() && days(activeEnd, p6c.access_expires_at) === 14 && p6c.access_plan === 'flex' && p6c.subscription_status === 'paid', { activeEnd, r6c, p6c });
  check('paid Flex periods never overlap (each starts at or after the previous end)', rows6.every((r, i) => i === 0 || new Date(r.access_start) >= new Date(rows6[i - 1].access_end)), rows6);
  check('the same Flex payment delivered twice grants nothing more', (await fulfill(db, f6c, 'flex')).already === true && (await profile(db, u6)).credits_balance === p6c.credits_balance);
  const rv6 = (await one(db, "SELECT revoke_purchase($1, 'refunded', 'test') AS r", [f6c])).r;
  check('refund of the queued Flex: back to the earlier end, its credits removed', rv6.revoked && new Date((await profile(db, u6)).access_expires_at).getTime() === new Date(activeEnd).getTime() && (await profile(db, u6)).credits_balance === 1050, { rv6, p: await profile(db, u6) });
  // After the whole period has expired (and been swept), Flex can be bought again.
  await db.query("UPDATE profiles SET access_expires_at = now() - interval '1 minute' WHERE id = $1", [u6]);
  await one(db, 'SELECT expire_access(100) AS n');
  const f6d = await newPurchase(db, u6, 'flex');
  const r6d = await fulfill(db, f6d, 'flex');
  const p6d = await profile(db, u6);
  check('Flex after a swept expiry: bought again, 14 days from now, fresh 1,050 credits', r6d.ok && r6d.fulfilled && p6d.subscription_status === 'paid' && p6d.credits_balance === 1050 && days(r6d.access_start, r6d.access_end) === 14 && Math.abs(new Date(r6d.access_start) - Date.now()) < 60000, { r6d, p6d });

  // ── Only the service role may call the functions ──
  await db.exec("SELECT set_config('test.role', 'authenticated', false)");
  let refused = false;
  try { await fulfill(db, await newPurchase(db, u6, 'monthly'), 'monthly'); } catch (_) { refused = true; }
  await db.exec("SELECT set_config('test.role', 'service_role', false)");
  check('fulfill_purchase refuses a non-service caller', refused);

  // ── Rollback ──
  await db.exec(rollback);
  const fns = (await all(db, "SELECT proname FROM pg_proc WHERE proname IN ('fulfill_purchase','grant_due_credit_instalments','expire_access','revoke_purchase')")).map((r) => r.proname);
  const purchasesKept = (await one(db, 'SELECT count(*)::int AS n FROM purchases')).n;
  const u7 = await newUser(db);
  const topup = await one(db, 'SELECT * FROM ensure_free_daily_cycle($1, 10, 1)', [u7]);
  check('rollback: new functions removed, purchase records kept, previous free top-up restored', fns.length === 0 && purchasesKept > 0 && topup.reset === true && (await profile(db, u7)).credits_balance === 10, { fns, purchasesKept, topup });

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
