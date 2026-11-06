// ════════════════════════════════════════════════════════════════
// One-time access purchases, end to end: the REAL services/purchases.js
// against the REAL docs/migrations/2026-10-access-purchases.sql running in an
// in-process Postgres (PGlite), through a small supabase-js-shaped adapter,
// with Stripe faked. Covers checkout, confirmed-payment fulfilment, duplicate
// and tampered events, async failures, expired checkouts, stacking, monthly
// instalments, expiry, refunds, disputes and the customer history.
//
// PGlite is not a dependency of this project. The test SKIPS (exit 0) unless
// it can load '@electric-sql/pglite' (install it anywhere and point
// NODE_PATH at that node_modules folder). No network, no Supabase, no Stripe.
//
// RUN: NODE_PATH=/path/to/node_modules node tests/purchases.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {
  console.log('SKIP — @electric-sql/pglite not found (set NODE_PATH to a node_modules folder that has it)');
  process.exit(0);
}

const purchases = require('../services/purchases');
const migration = fs.readFileSync(path.join(__dirname, '..', 'docs', 'migrations', '2026-10-access-purchases.sql'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 500) : '')); } }
const ALERTS = [];
const _warn = console.warn;
console.warn = (...a) => { const s = a.join(' '); if (s.startsWith('[Purchases] ALERT')) ALERTS.push(JSON.parse(s.slice('[Purchases] ALERT '.length))); else _warn(...a); };
console.log = ((orig) => (...a) => { if (String(a[0] || '').startsWith('[Purchases]')) return; orig(...a); })(console.log);

const BASE = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
CREATE TABLE profiles (
  id uuid PRIMARY KEY, email text, subscription_status text DEFAULT 'free',
  stripe_customer_id text, stripe_subscription_id text,
  credits_balance integer NOT NULL DEFAULT 0, credits_cycle_start timestamptz, credits_cycle_end timestamptz,
  credits_provisioned_plan text, credits_last_reset_source text
);`;

// ── supabase-js-shaped adapter over PGlite (only what purchases.js uses) ──
function adapter(pg) {
  const ident = (s) => '"' + String(s).replace(/"/g, '') + '"';
  class Q {
    constructor(t) { this.t = t; this.op = 'select'; this.where = []; this.args = []; this.cols = '*'; this.lim = null; this.ord = null; }
    select(c) { if (this.op === 'select') this.cols = c || '*'; else this.ret = true; return this; }
    insert(o) { this.op = 'insert'; this.p = o; return this; }
    update(o) { this.op = 'update'; this.p = o; return this; }
    _w(sql, v) { if (v !== undefined) { this.args.push(v); this.where.push(sql.replace('?', '$' + this.args.length)); } else this.where.push(sql); return this; }
    eq(c, v) { return this._w(ident(c) + ' = ?', v); }
    in(c, a) { this.args.push(a); this.where.push(ident(c) + ' = ANY($' + this.args.length + ')'); return this; }
    is(c, v) { return this._w(ident(c) + (v === null ? ' IS NULL' : ' IS ' + v)); }
    order(c, o) { this.ord = ident(c) + (o && o.ascending === false ? ' DESC' : ' ASC'); return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this.single = true; return this.run(); }
    then(a, b) { return this.run().then(a, b); }
    async run() {
      try {
        const W = this.where.length ? ' WHERE ' + this.where.join(' AND ') : '';
        if (this.op === 'insert') {
          const keys = Object.keys(this.p);
          const vals = keys.map((k, i) => '$' + (i + 1));
          await pg.query(`INSERT INTO ${ident(this.t)} (${keys.map(ident).join(', ')}) VALUES (${vals.join(', ')})`, keys.map((k) => this.p[k]));
          return { data: null, error: null };
        }
        if (this.op === 'update') {
          const keys = Object.keys(this.p); const base = this.args.length;
          const set = keys.map((k, i) => ident(k) + ' = $' + (base + i + 1)).join(', ');
          await pg.query(`UPDATE ${ident(this.t)} SET ${set}${W}`, this.args.concat(keys.map((k) => this.p[k])));
          return { data: null, error: null };
        }
        const cols = this.cols === '*' ? '*' : this.cols.split(',').map((c) => ident(c.trim())).join(', ');
        const r = await pg.query(`SELECT ${cols} FROM ${ident(this.t)}${W}${this.ord ? ' ORDER BY ' + this.ord : ''}${this.lim ? ' LIMIT ' + this.lim : ''}`, this.args);
        return { data: this.single ? (r.rows[0] || null) : r.rows, error: null };
      } catch (error) { return { data: null, error }; }
    }
  }
  return {
    from: (t) => new Q(t),
    rpc: async (fn, args) => {
      try {
        const keys = Object.keys(args || {});
        const r = await pg.query(`SELECT * FROM ${ident(fn)}(${keys.map((k, i) => ident(k) + ' => $' + (i + 1)).join(', ')})`, keys.map((k) => args[k]));
        const row = r.rows[0];
        if (row && Object.keys(row).length === 1 && fn in row) return { data: row[fn], error: null };
        return { data: r.rows, error: null };
      } catch (error) { return { data: null, error }; }
    },
  };
}

// ── Stripe fake (with the plans' test Prices: tests/helpers/pgPayments.js) ──
const pricing = require('../services/pricing');
const { installTestPrices, makeStripe } = require('./helpers/pgPayments');
const TEST_PRICES = installTestPrices(pricing);
const { stripe, S, paidSession } = makeStripe(TEST_PRICES);

const DAY = 864e5;
const one = async (pg, sql, params) => (await pg.query(sql, params || [])).rows[0];
const profile = (pg, id) => one(pg, 'SELECT * FROM profiles WHERE id = $1', [id]);
const purchase = (pg, id) => one(pg, 'SELECT * FROM purchases WHERE id = $1', [id]);
async function newUser(pg, status) {
  const id = crypto.randomUUID();
  await pg.query('INSERT INTO profiles (id, email, subscription_status) VALUES ($1, $2, $3)', [id, id.slice(0, 8) + '@example.invalid', status || 'free']);
  return { id, email: id.slice(0, 8) + '@example.invalid' };
}
async function buy(pg, user, planId) {
  const r = await purchases.createCheckout({ user, planId, successUrl: 'https://x/ok?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/no' });
  return { r, created: S.created[S.created.length - 1] };
}

(async () => {
  const pg = new PGlite();
  await pg.exec(BASE);
  await pg.exec(migration);
  purchases.init({ stripe, db: adapter(pg) });

  console.log('\nA. Checkout');
  const u = await newUser(pg);
  let { r, created } = await buy(pg, u, 'monthly');
  let pu = await purchase(pg, r.purchaseId);
  check('pending purchase with the terms of services/pricing.js', pu && pu.status === 'pending' && pu.plan_id === 'monthly' && pu.price_incl_vat_cents === 2900 && pu.credits_total === 1750 && pu.instalments === 1 && pu.duration_months === 1, pu);
  check('Stripe Checkout in payment mode (no subscription) with Monthly’s own verified Stripe Price (EUR, €29 before VAT, tax exclusive), Stripe Tax on', created.p.mode === 'payment' && !created.p.subscription_data && created.p.line_items[0].price === pricing.PLANS.monthly.stripePriceId && !created.p.line_items[0].price_data && TEST_PRICES[created.p.line_items[0].price].unit_amount === 2900 && TEST_PRICES[created.p.line_items[0].price].tax_behavior === 'exclusive' && created.p.automatic_tax.enabled === true);
  check('idempotency key per purchase; metadata names user, purchase and plan', created.opts.idempotencyKey === 'purchase-' + r.purchaseId && created.p.metadata.userId === u.id && created.p.metadata.purchaseId === r.purchaseId && created.p.metadata.planId === 'monthly');
  check('session id stored on the purchase', pu.stripe_checkout_session_id === created.id);
  const first = { r, created };
  ({ r, created } = await buy(pg, u, 'monthly'));
  check('a second checkout (two tabs) expires the first one at Stripe and in the database', S.expired.includes(first.created.id) && (await purchase(pg, first.r.purchaseId)).status === 'expired');
  // Race: the first checkout was paid just before it was replaced. Money was
  // taken, so the purchase is honoured (an expired session can't be paid at
  // Stripe; only this race can deliver it, and _closeOpenCheckouts leaves a
  // 'complete' session alone).
  const ur = await newUser(pg);
  const raceA = await buy(pg, ur, 'flex');
  S.sessions[raceA.created.id].status = 'complete';
  await buy(pg, ur, 'flex');
  check('a paid (complete) checkout is not expired by a newer checkout', !S.expired.includes(raceA.created.id) && (await purchase(pg, raceA.r.purchaseId)).status === 'pending');
  let out = await purchases.onCheckoutCompleted(paidSession(raceA.created));
  check('…and its payment is honoured: access + credits', out.fulfilled && (await profile(pg, ur.id)).credits_balance === 1050, out);
  let err = null; try { await purchases.createCheckout({ user: u, planId: 'starter' }); } catch (e) { err = e; }
  check('a retired plan id is refused before anything is written', err && err.code === 'UNKNOWN_PLAN');

  console.log('\nB. Confirmed payment → access + credits');
  out = await purchases.onCheckoutCompleted(paidSession(created, { payment_status: 'unpaid' }));
  check('session completed but unpaid (bank transfer pending) → nothing granted', out.skipped === 'payment_unpaid' && (await profile(pg, u.id)).credits_balance === 0);
  out = await purchases.onCheckoutCompleted(paidSession(created, { amount_total: 100 }));
  check('amount that doesn’t match the terms → refused + alert, nothing granted', !out.fulfilled && (await profile(pg, u.id)).credits_balance === 0 && ALERTS.some((a) => a.event === 'fulfillment_refused'), out);
  out = await purchases.onCheckoutCompleted(paidSession(created, { client_reference_id: crypto.randomUUID() }));
  check('client_reference_id ≠ metadata user → refused + alert', out.skipped === 'identity_mismatch' && ALERTS.some((a) => a.event === 'checkout_identity_mismatch'));
  const t0 = Date.now();
  out = await purchases.onCheckoutCompleted(paidSession(created));
  let p = await profile(pg, u.id);
  check('paid → fulfilled: status paid, access_plan monthly, 1,750 credits', out.fulfilled && p.subscription_status === 'paid' && p.access_plan === 'monthly' && p.credits_balance === 1750, { out, p });
  const end1 = new Date(p.access_expires_at).getTime();
  check('access runs one calendar month from now', Math.abs(end1 - pricing.accessEnd(pricing.PLANS.monthly, new Date(t0)).getTime()) < 60e3, p.access_expires_at);
  check('the Stripe customer is linked to the profile', p.stripe_customer_id === 'cus_' + u.id.slice(0, 6));
  check('services/pricing.js hasAccess agrees', pricing.hasAccess(p));
  out = await purchases.onCheckoutCompleted(paidSession(created));
  const out2 = await purchases.fulfillFromSession(paidSession(created));
  check('the same payment again (webhook retry + checkout-return sync) → no second grant', !out.fulfilled && !out2.fulfilled && (await profile(pg, u.id)).credits_balance === 1750, { out, out2 });

  console.log('\nC. Stacking and instalments');
  ({ r, created } = await buy(pg, u, 'quarterly'));
  await purchases.onCheckoutCompleted(paidSession(created));
  p = await profile(pg, u.id);
  const q = await purchase(pg, r.purchaseId);
  check('buying again before access ends → the new period starts when the current one ends', Math.abs(new Date(q.access_start).getTime() - end1) < 1000 && new Date(p.access_expires_at).getTime() === new Date(q.access_end).getTime(), { start: q.access_start, end1: new Date(end1).toISOString() });
  check('quarterly: first instalment (1,600) now, on top of the current balance', p.credits_balance === 1750 + 1600, p.credits_balance);
  const grants = (await pg.query('SELECT * FROM credit_grants WHERE purchase_id = $1 ORDER BY instalment', [r.purchaseId])).rows;
  check('three equal monthly instalments, all inside the access period', grants.length === 3 && grants.every((g) => g.credits === 1600) && grants.every((g) => new Date(g.grant_at) < new Date(q.access_end)), grants.map((g) => [g.instalment, g.status, g.grant_at]));
  await pg.query("UPDATE credit_grants SET grant_at = now() - interval '1 minute' WHERE purchase_id = $1 AND instalment = 1", [r.purchaseId]);
  let n = await purchases.grantDueInstalments();
  const n2 = await purchases.grantDueInstalments();
  check('a due instalment is granted once (the job can run twice)', n === 1 && n2 === 0 && (await profile(pg, u.id)).credits_balance === 1750 + 3200, { n, n2 });

  console.log('\nD. Refunds and disputes');
  // Full refund of the quarterly purchase: its unused access goes, its granted credits are taken back (up to the balance), its future instalment is cancelled.
  out = await purchases.onChargeRefunded({ payment_intent: 'pi_' + created.id.slice(-8), amount: 7800, amount_refunded: 7800 });
  p = await profile(pg, u.id);
  const qr = await purchase(pg, r.purchaseId);
  check('full refund → purchase refunded, its 3,200 granted credits removed, access back to the first purchase', qr.status === 'refunded' && p.credits_balance === 1750 && Math.abs(new Date(p.access_expires_at).getTime() - end1) < 1000, { status: qr.status, bal: p.credits_balance, exp: p.access_expires_at });
  check('…its remaining instalment is cancelled', (await one(pg, "SELECT count(*)::int AS n FROM credit_grants WHERE purchase_id = $1 AND status = 'scheduled'", [r.purchaseId])).n === 0);
  out = await purchases.onChargeRefunded({ payment_intent: 'pi_' + created.id.slice(-8), amount: 7800, amount_refunded: 7800 });
  check('the same refund again → no second removal', (await profile(pg, u.id)).credits_balance === 1750);

  const v = await newUser(pg);
  ({ r, created } = await buy(pg, v, 'annual'));
  await purchases.onCheckoutCompleted(paidSession(created));
  out = await purchases.onChargeRefunded({ payment_intent: 'pi_' + created.id.slice(-8), amount: 24500, amount_refunded: 5000 });
  p = await profile(pg, v.id);
  check('partial refund → recorded for review, access and credits unchanged', out.partialRefund && (await purchase(pg, r.purchaseId)).status === 'partially_refunded' && p.credits_balance === 1250 && pricing.hasAccess(p) && ALERTS.some((a) => a.event === 'partial_refund_review'), { out, bal: p.credits_balance });

  const w = await newUser(pg);
  ({ r, created } = await buy(pg, w, 'flex'));
  await purchases.onCheckoutCompleted(paidSession(created));
  await pg.query('SELECT * FROM spend_credits($1, $2)', [w.id, 200]);
  out = await purchases.onDisputeCreated({ payment_intent: 'pi_' + created.id.slice(-8), reason: 'fraudulent' });
  p = await profile(pg, w.id);
  check('dispute → purchase disputed, access ended, remaining credits removed', (await purchase(pg, r.purchaseId)).status === 'disputed' && !pricing.hasAccess(p) && p.credits_balance === 0, p);
  out = await purchases.onDisputeClosed({ payment_intent: 'pi_' + created.id.slice(-8), status: 'won' });
  p = await profile(pg, w.id);
  check('dispute won → flagged for manual reinstatement, nothing granted automatically', out.disputeWon && (await purchase(pg, r.purchaseId)).status === 'dispute_won' && !pricing.hasAccess(p) && ALERTS.some((a) => a.event === 'dispute_won_manual_reinstatement'));

  console.log('\nE. Async payment methods and abandoned checkouts');
  const x = await newUser(pg);
  ({ r, created } = await buy(pg, x, 'semiannual'));
  out = await purchases.onAsyncPaymentFailed(paidSession(created, { payment_status: 'unpaid' }));
  check('async payment failed → purchase failed, nothing granted', (await purchase(pg, r.purchaseId)).status === 'failed' && (await profile(pg, x.id)).subscription_status === 'free');
  ({ r, created } = await buy(pg, x, 'semiannual'));
  out = await purchases.onAsyncPaymentSucceeded(paidSession(created));
  check('async payment succeeded → fulfilled (8,850 / 6 = 1,475 now)', out.fulfilled && (await profile(pg, x.id)).credits_balance === 1475);
  const y = await newUser(pg);
  ({ r, created } = await buy(pg, y, 'flex'));
  out = await purchases.onCheckoutExpired(Object.assign(paidSession(created), { payment_status: 'unpaid', status: 'expired' }));
  check('checkout expired → purchase expired, nothing granted', (await purchase(pg, r.purchaseId)).status === 'expired' && (await profile(pg, y.id)).credits_balance === 0);

  console.log('\nF. Expiry');
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '1 minute' WHERE id = $1", [v.id]);
  n = await purchases.expireAccess();
  p = await profile(pg, v.id);
  check('access ended → expiry job ends it: no access, unused credits expire, future instalments cancelled', n >= 1 && p.credits_balance === 0 && !pricing.hasAccess(p) && (await one(pg, "SELECT count(*)::int AS n FROM credit_grants g JOIN purchases pu ON pu.id = g.purchase_id WHERE pu.user_id = $1 AND g.status = 'scheduled'", [v.id])).n === 0, p);
  const sp = await one(pg, 'SELECT * FROM spend_credits($1, $2)', [v.id, 1]);
  check('spending after expiry is refused', sp.ok === false);

  console.log('\nG. Customer history');
  const h = await purchases.historyFor(u.id);
  check('history lists the paid and the refunded purchase, newest first, with grants', h.purchases.length === 2 && h.purchases.map((x) => x.status).sort().join() === 'paid,refunded' && h.grants.length >= 1, h.purchases.map((x) => [x.plan_id, x.status]));
  check('history never includes pending, failed or expired checkouts', !h.purchases.some((x) => ['pending', 'failed', 'expired'].includes(x.status)));

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
