// ════════════════════════════════════════════════════════════════
// Billing integrity — identity, ownership, Stripe-authoritative plan state,
// idempotent webhooks and credit grants.
//
// Runs the REAL server.js with Stripe replaced by a stateful in-memory mock
// (customers, subscriptions, schedules, Checkout, Billing Portal — webhook
// signatures use the real Stripe library's crypto), Supabase replaced by a
// stateful mock, and outbound network blocked. No .env, no real Stripe,
// no real users.
//
// RUN: node tests/billing-integrity.test.js   (from oriven-backand-clean/server)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const RealStripe = require(path.join(SERVER_DIR, 'node_modules/stripe'));
const PORT = 5596;
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_SECRET = 'whsec_mock_only';
const PRICE = { starter: 'price_starter', creator: 'price_creator', professional: 'price_pro' };
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const P1 = { start: NOW - 5 * DAY, end: NOW + 25 * DAY };      // current period
const P2 = { start: P1.end, end: P1.end + 30 * DAY };          // next period

for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_STARTER: PRICE.starter, STRIPE_PRICE_CREATOR: PRICE.creator, STRIPE_PRICE_PROFESSIONAL: PRICE.professional,
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: 'mock-not-a-key', FRONTEND_URL: 'http://localhost:8899',
});

const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = (url, opts) => {
  const u = String(url && url.url || url);
  if (!new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}/`).test(u)) { blocked.push(u); return Promise.reject(new Error('network blocked in test: ' + u)); }
  return realFetch(url, opts);
};

// ── Stateful Supabase mock ──
const TABLES = {};
const UNIQUE = { stripe_webhook_events: [{ cols: ['id'] }], credit_actions: [{ cols: ['id'] }, { cols: ['user_id', 'idempotency_key'] }] };
const rows = (t) => (TABLES[t] = TABLES[t] || []);
const rpcCalls = [];
function violates(t, cand, ignore) {
  return (UNIQUE[t] || []).some((u) => rows(t).some((r) => r !== ignore && u.cols.every((c) => r[c] === cand[c])));
}
function parseOr(expr) {
  // supports "a.eq.v,b.lt.v"
  const parts = expr.split(',').map((p) => { const [c, op, ...v] = p.split('.'); return { c, op, v: v.join('.') }; });
  return (r) => parts.some(({ c, op, v }) => (op === 'eq' ? String(r[c]) === v : op === 'lt' ? String(r[c]) < v : false));
}
class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.wantRows = false; this.lim = null; }
  select() { if (this.op !== 'select') this.wantRows = true; return this; }
  insert(p) { this.op = 'insert'; this.p = p; return this; }
  upsert(p) { this.op = 'upsert'; this.p = p; return this; }
  update(p) { this.op = 'update'; this.p = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
  in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
  lt(c, v) { this.f.push((r) => r[c] != null && r[c] < v); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  is(c, v) { this.f.push((r) => (r[c] == null) === (v == null)); return this; }
  or(expr) { this.f.push(parseOr(expr)); return this; }
  order() { return this; } range() { return this; } not() { return this; } ilike() { return this; } contains() { return this; } filter() { return this; } gt() { return this; } lte() { return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this._single = true; return this.run(); }
  single() { this._single = true; return this.run(); }
  then(a, b) { return this.run().then(a, b); }
  async run() {
    await null;
    const all = rows(this.t);
    const match = () => all.filter((r) => this.f.every((fn) => fn(r)));
    if (this.op === 'insert' || this.op === 'upsert') {
      const now = new Date().toISOString();
      const items = (Array.isArray(this.p) ? this.p : [this.p]).map((x) => Object.assign({ created_at: now, updated_at: now }, x));
      for (const it of items) if (this.op === 'insert' && violates(this.t, it)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      items.forEach((it) => all.push(it));
      return { data: this.wantRows ? items.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'update') { const m = match(); m.forEach((r) => Object.assign(r, this.p)); return { data: this.wantRows ? m.map((x) => ({ ...x })) : null, error: null }; }
    if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
    let m = match().map((x) => ({ ...x }));
    if (this.lim != null) m = m.slice(0, this.lim);
    return { data: this._single ? (m[0] || null) : m, error: null };
  }
}
const TOKENS = {};
const supabaseMock = {
  from: (t) => new Q(t),
  rpc: async (name, args) => {
    rpcCalls.push(name);
    const p = rows('profiles').find((r) => r.id === (args && args.p_user_id));
    if (name === 'spend_credits' && p) { if (p.credits_balance >= args.p_amount) { p.credits_balance -= args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; } return { data: [{ ok: false, balance: p.credits_balance }], error: null }; }
    if (name === 'refund_credits' && p) { p.credits_balance += args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; }
    return { data: null, error: null };
  },
  auth: { getUser: async (t) => TOKENS[t] ? { data: { user: TOKENS[t] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }, admin: new Proxy({}, { get: () => async () => { throw new Error('admin auth disabled in test'); } }) },
};

// ── Stateful Stripe mock ──
const S = { subs: {}, schedules: {}, calls: [], fail: {} };
function stripeErr(msg, extra) { return Object.assign(new Error(msg), { type: 'StripeInvalidRequestError' }, extra || {}); }
function mkSub(id, customer, plan, status, period, meta) {
  return { id, object: 'subscription', customer, status: status || 'active', cancel_at_period_end: false, cancel_at: null, schedule: null, metadata: meta || {},
    current_period_start: period.start, current_period_end: period.end, automatic_tax: { enabled: true },
    latest_invoice: { id: 'in_' + id, status: 'paid' },
    items: { data: [{ price: { id: PRICE[plan] }, current_period_start: period.start, current_period_end: period.end }] } };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
function maybeFail(op) { if (S.fail[op]) { const e = S.fail[op]; delete S.fail[op]; throw e; } }
class StripeMock {
  constructor(key) {
    if (/^sk_live/.test(key)) throw new Error('LIVE KEY USED IN TEST');
    this.webhooks = new RealStripe('sk_test_mock_only').webhooks;
    this.checkout = { sessions: { create: async (p) => { S.calls.push(['checkout.create', p]); maybeFail('checkout'); return { id: 'cs_' + S.calls.length, url: 'https://checkout.stripe.test/cs' }; } } };
    this.billingPortal = { sessions: { create: async (p) => { S.calls.push(['portal.create', p]); return { url: 'https://billing.stripe.test/' + p.customer }; } } };
    this.subscriptions = {
      retrieve: async (id) => { S.calls.push(['sub.retrieve', id]); maybeFail('retrieve'); if (!S.subs[id]) throw stripeErr('No such subscription', { statusCode: 404, code: 'resource_missing' }); return clone(S.subs[id]); },
      update: async (id, p) => { S.calls.push(['sub.update', id, p]); maybeFail('update'); Object.assign(S.subs[id], p); return clone(S.subs[id]); },
    };
    this.subscriptionSchedules = {
      create: async (p) => { S.calls.push(['sched.create', p]); maybeFail('sched.create'); const id = 'sub_sched_' + S.calls.length; S.schedules[id] = { id, subscription: p.from_subscription, status: 'active' }; S.subs[p.from_subscription].schedule = id; return { id }; },
      update: async (id, p) => { S.calls.push(['sched.update', id, p]); maybeFail('sched.update'); S.schedules[id].phases = p.phases; return { id }; },
      release: async (id) => { S.calls.push(['sched.release', id]); const s = S.schedules[id]; if (s) { s.status = 'released'; if (S.subs[s.subscription]) S.subs[s.subscription].schedule = null; } return { id }; },
    };
    return new Proxy(this, { get(t, p) { return p in t ? t[p] : new Proxy({}, { get: (_, m) => async () => { S.calls.push(['UNEXPECTED', p + '.' + String(m)]); throw new Error('unexpected stripe call ' + p + '.' + String(m)); } }); } });
  }
}

const _load = Module._load;
Module._load = function (req) {
  if (req === 'stripe') return StripeMock;
  if (req === '@supabase/supabase-js') return { createClient: () => supabaseMock };
  if (req === 'dotenv') return { config: () => ({ parsed: {} }) };
  if (req === 'node-cron') return { schedule: () => ({ stop() {} }) };
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async () => { throw new Error('email disabled in test'); }, verify: async () => true }) };
  return _load.apply(this, arguments);
};

// ── Helpers ──
const out = console.log.bind(console);
let pass = 0, fail = 0;
function check(name, ok, info) { ok ? pass++ : fail++; out((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 500))); }
async function call(method, p, tok, body, headers) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
let evtN = 0;
async function hook(type, obj, id) {
  const payload = JSON.stringify({ id: id || ('evt_' + (++evtN)), type, data: { object: obj } });
  const header = new RealStripe('sk_test_mock_only').webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return call('POST', '/api/stripe-webhook', null, payload, { 'stripe-signature': header, 'Content-Type': 'application/json' });
}
const prof = (id) => rows('profiles').find((p) => p.id === id);
const stripeCalls = (kind) => S.calls.filter((c) => c[0] === kind);
const iso = (ts) => new Date(ts * 1000).toISOString();
function P(id, plan, extra) {
  return Object.assign({ id, email: id + '@example.invalid', subscription_status: plan, stripe_customer_id: null, stripe_subscription_id: null, pending_plan: null, pending_plan_date: null,
    credits_balance: 0, credits_cycle_start: null, credits_cycle_end: null, credits_provisioned_plan: null }, extra || {});
}
function reset() {
  for (const k of Object.keys(TABLES)) delete TABLES[k];
  S.subs = {}; S.schedules = {}; S.calls.length = 0; S.fail = {}; rpcCalls.length = 0;
  // A: free user.  B: Starter on Stripe (period P1, 1000 credits).  M: manually granted Creator (no Stripe).
  rows('profiles').push(
    P('uA', 'free'),
    P('uB', 'starter', { stripe_customer_id: 'cus_B', stripe_subscription_id: 'sub_B', credits_balance: 1000, credits_cycle_start: iso(P1.start), credits_cycle_end: iso(P1.end), credits_provisioned_plan: 'starter' }),
    P('uM', 'creator', { credits_balance: 2500, credits_cycle_start: iso(P1.start), credits_cycle_end: iso(P1.end), credits_provisioned_plan: 'creator' }),
  );
  S.subs.sub_B = mkSub('sub_B', 'cus_B', 'starter', 'active', P1, {});
  for (const u of ['uA', 'uB', 'uM']) TOKENS['tok_' + u] = { id: u, email: u + '@example.invalid' };
  require(path.join(SERVER_DIR, 'services/stripeBilling.js'))._resetForTests();
}
function checkoutSession(userId, sub, extra) {
  return Object.assign({ id: 'cs_x', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', client_reference_id: userId, customer: sub.customer, subscription: sub.id, metadata: { userId, plan: 'starter' } }, extra || {});
}
const invoice = (sub, reason, extra) => Object.assign({ id: 'in_' + Math.random().toString(36).slice(2), object: 'invoice', customer: sub.customer, subscription: sub.id, billing_reason: reason, period_start: P1.start - 30 * DAY, period_end: P1.start }, extra || {});

(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  require(path.join(SERVER_DIR, 'server.js'));
  const stripeBilling = require(path.join(SERVER_DIR, 'services/stripeBilling.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }

  out('\nJ. Authentication');
  reset();
  for (const [m, p] of [['POST', '/api/create-checkout-session'], ['POST', '/api/schedule-plan-change'], ['POST', '/api/cancel-plan-change'], ['POST', '/api/create-portal-session'], ['GET', '/api/get-subscription']]) {
    const r = await call(m, p, null, m === 'POST' ? { plan: 'starter', userId: 'uB' } : null);
    const r2 = await call(m, p, 'tok_forged', m === 'POST' ? { plan: 'starter', userId: 'uB' } : null);
    check(`${m} ${p}: no token → 401, forged token → 401`, r.status === 401 && r2.status === 401, { r: r.status, r2: r2.status });
  }
  check('no Stripe call was made by unauthenticated requests', S.calls.length === 0, S.calls.map((c) => c[0]));
  let r = await call('POST', '/api/stripe-webhook', null, '{"id":"evt_x","type":"checkout.session.completed","data":{"object":{}}}', { 'stripe-signature': 't=1,v1=bad', 'Content-Type': 'application/json' });
  check('webhook with a bad signature → 400, nothing applied', r.status === 400 && prof('uA').subscription_status === 'free');

  out('\nA/B. Checkout identity');
  reset();
  r = await call('POST', '/api/create-checkout-session', 'tok_uA', { plan: 'starter', userId: 'uB', userEmail: 'uB@example.invalid' });
  check('A sends userId of B → 403 IDENTITY_MISMATCH, no Checkout created', r.status === 403 && r.body.code === 'IDENTITY_MISMATCH' && stripeCalls('checkout.create').length === 0, r);
  r = await call('POST', '/api/create-checkout-session', 'tok_uA', { plan: 'starter', userEmail: 'attacker@example.invalid' });
  let cp = (stripeCalls('checkout.create')[0] || [])[1] || {};
  check('A without body userId → session bound to A (client_reference_id, metadata, subscription metadata)', r.status === 200 && cp.client_reference_id === 'uA' && cp.metadata.userId === 'uA' && cp.subscription_data.metadata.userId === 'uA', cp);
  check('client-supplied email is ignored (verified account email used)', cp.customer_email === 'uA@example.invalid' && !JSON.stringify(cp).includes('attacker'), cp.customer_email);
  check('Stripe Tax settings unchanged on the session', cp.automatic_tax && cp.automatic_tax.enabled === true && cp.billing_address_collection === 'required' && cp.tax_id_collection.enabled === true && cp.line_items[0].price === PRICE.starter);
  S.calls.length = 0;
  r = await call('POST', '/api/create-checkout-session', 'tok_uB', { plan: 'creator' });
  check('B already has a live subscription → 409 ALREADY_SUBSCRIBED (no second subscription)', r.status === 409 && r.body.code === 'ALREADY_SUBSCRIBED' && stripeCalls('checkout.create').length === 0, r);
  S.subs.sub_B.status = 'canceled'; S.calls.length = 0;
  r = await call('POST', '/api/create-checkout-session', 'tok_uB', { plan: 'creator' });
  cp = (stripeCalls('checkout.create')[0] || [])[1] || {};
  check('returning customer (old sub canceled) → reuses THEIR Stripe customer, with customer_update for tax', r.status === 200 && cp.customer === 'cus_B' && cp.customer_update && cp.customer_update.address === 'auto' && !('customer_email' in cp), cp);

  out('\nH. Valid checkout → subscription flow');
  reset();
  S.subs.sub_A = mkSub('sub_A', 'cus_A', 'starter', 'active', P1, { userId: 'uA', plan: 'starter' });
  const evA = 'evt_checkout_A';
  r = await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_A), evA);
  check('paid checkout → A is Starter, linked to its own customer/subscription', r.status === 200 && prof('uA').subscription_status === 'starter' && prof('uA').stripe_customer_id === 'cus_A' && prof('uA').stripe_subscription_id === 'sub_A', prof('uA'));
  check('credits = 1000 for Stripe\'s real billing period', prof('uA').credits_balance === 1000 && prof('uA').credits_cycle_end === iso(P1.end), prof('uA'));
  prof('uA').credits_balance = 900; // user spends 100
  r = await hook('invoice.payment_succeeded', invoice(S.subs.sub_A, 'subscription_create'));
  check('first invoice (subscription_create) for the same period → no second grant', prof('uA').credits_balance === 900, prof('uA').credits_balance);
  r = await call('GET', '/api/get-subscription', 'tok_uA');
  check('get-subscription reports Starter, billed via Stripe, no Stripe ids exposed', r.body.subscription_status === 'starter' && r.body.billing === 'stripe' && !JSON.stringify(r.body).includes('sub_A') && !JSON.stringify(r.body).includes('cus_A'), r.body);

  out('\nF. Duplicate webhooks');
  r = await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_A), evA);
  check('same checkout event id redelivered → acknowledged as duplicate, credits untouched', r.status === 200 && r.body.duplicate === true && prof('uA').credits_balance === 900, r.body);
  r = await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_A));
  check('same checkout under a NEW event id → state-based idempotency, credits untouched', r.status === 200 && prof('uA').credits_balance === 900, prof('uA').credits_balance);
  const inv1 = invoice(S.subs.sub_A, 'subscription_cycle');
  await hook('invoice.payment_succeeded', inv1, 'evt_inv_dup');
  await hook('invoice.payment_succeeded', inv1, 'evt_inv_dup');
  await hook('invoice.payment_succeeded', inv1);
  check('invoice paid for the current period ×3 → still no extra grant', prof('uA').credits_balance === 900);
  check('stripe_webhook_events records processed events', rows('stripe_webhook_events').filter((e) => e.status === 'processed').length >= 3);

  out('\nE. Plan change: Stripe first, plan + credits only when Stripe establishes them');
  reset();
  r = await call('POST', '/api/schedule-plan-change', 'tok_uB', { plan: 'creator', subscriptionId: 'sub_OTHER', customerId: 'cus_OTHER', userId: 'uA' });
  const upd = stripeCalls('sched.update')[0];
  check('B schedules Starter → Creator: Stripe schedule on B\'s own subscription; body ids ignored', r.status === 200 && upd && S.schedules[upd[1]].subscription === 'sub_B' && upd[2].phases[1].items[0].price === PRICE.creator && !JSON.stringify(S.calls).includes('sub_OTHER'), r.body);
  check('…DB records only a pending change; plan and credits unchanged until period end', prof('uB').subscription_status === 'starter' && prof('uB').pending_plan === 'creator' && prof('uB').credits_balance === 1000, prof('uB'));
  // Period end: Stripe moves the subscription to the Creator price and invoices the new period.
  Object.assign(S.subs.sub_B, mkSub('sub_B', 'cus_B', 'creator', 'active', P2, {}));
  prof('uB').credits_balance = 150; // leftover Starter credits at period end
  r = await hook('customer.subscription.updated', clone(S.subs.sub_B));
  check('subscription.updated (Creator price active) → plan Creator, pending cleared, NO credits before payment', prof('uB').subscription_status === 'creator' && prof('uB').pending_plan === null && prof('uB').credits_balance === 150, prof('uB'));
  r = await call('GET', '/api/credits/status', 'tok_uB');
  check('credit status read does NOT self-grant Creator credits before the payment', prof('uB').credits_balance === 150, prof('uB').credits_balance);
  r = await hook('invoice.payment_succeeded', invoice(S.subs.sub_B, 'subscription_cycle'));
  check('invoice paid for the Creator period → 2500 credits for P2', prof('uB').credits_balance === 2500 && prof('uB').credits_cycle_end === iso(P2.end) && prof('uB').credits_provisioned_plan === 'creator', prof('uB'));
  prof('uB').credits_balance = 2400;
  await hook('customer.subscription.updated', clone(S.subs.sub_B));
  await hook('invoice.payment_succeeded', invoice(S.subs.sub_B, 'subscription_cycle'));
  check('re-delivered updated/invoice events → no second Creator grant', prof('uB').credits_balance === 2400, prof('uB').credits_balance);
  // Invoice before subscription.updated (out of order) also works:
  reset();
  Object.assign(S.subs.sub_B, mkSub('sub_B', 'cus_B', 'creator', 'active', P2, {}));
  await hook('invoice.payment_succeeded', invoice(S.subs.sub_B, 'subscription_cycle'));
  check('out-of-order: invoice paid first → plan Creator + 2500 credits from Stripe state', prof('uB').subscription_status === 'creator' && prof('uB').credits_balance === 2500);

  out('\nD. Stripe failures leave OrivenAI state unchanged');
  for (const [label, op] of [['schedule create', 'sched.create'], ['schedule update', 'sched.update'], ['subscription retrieve', 'retrieve']]) {
    reset();
    S.fail[op] = stripeErr('Stripe is down');
    r = await call('POST', '/api/schedule-plan-change', 'tok_uB', { plan: 'professional' });
    const p = prof('uB');
    check(`Stripe ${label} fails → 502, plan/pending/credits unchanged`, r.status === 502 && p.subscription_status === 'starter' && p.pending_plan === null && p.credits_balance === 1000 && p.credits_cycle_end === iso(P1.end), { status: r.status, p });
    if (op === 'sched.update') check('…and the schedule it had just created was released again', stripeCalls('sched.release').length === 1);
  }
  reset();
  S.fail.update = stripeErr('Stripe is down');
  r = await call('POST', '/api/schedule-plan-change', 'tok_uB', { plan: 'free' });
  check('cancel-to-free when Stripe fails → 502, still Starter, nothing pending', r.status === 502 && prof('uB').subscription_status === 'starter' && prof('uB').pending_plan === null);
  reset();
  r = await call('POST', '/api/schedule-plan-change', 'tok_uM', { plan: 'professional' });
  check('manually granted plan (no Stripe sub) asking for another paid plan → requiresCheckout; no DB change, no credits', r.status === 200 && r.body.requiresCheckout === true && prof('uM').subscription_status === 'creator' && prof('uM').credits_balance === 2500, r.body);

  out('\nC/I. Ownership of Stripe objects');
  reset();
  prof('uB').stripe_customer_id = 'cus_B';
  S.subs.sub_B.customer = 'cus_SOMEONE_ELSE';
  r = await call('POST', '/api/schedule-plan-change', 'tok_uB', { plan: 'creator' });
  check('profile\'s subscription belongs to another customer → 409 SUBSCRIPTION_MISMATCH, no schedule', r.status === 409 && r.body.code === 'SUBSCRIPTION_MISMATCH' && !stripeCalls('sched.create').length, r);
  r = await call('POST', '/api/cancel-plan-change', 'tok_uB', {});
  check('cancel-plan-change on a mismatched subscription → 409, Stripe untouched', r.status === 409 && !stripeCalls('sub.update').length, r);
  reset();
  r = await call('POST', '/api/create-portal-session', 'tok_uB', { customer: 'cus_A', customerId: 'cus_A', userId: 'uA' });
  const pp = (stripeCalls('portal.create')[0] || [])[1] || {};
  check('portal session is always for the caller\'s OWN customer (body ignored)', r.status === 200 && pp.customer === 'cus_B', pp);
  r = await call('POST', '/api/create-portal-session', 'tok_uA', { customer: 'cus_B' });
  check('user without a Stripe customer cannot get a portal (even naming another customer)', r.status === 404 && stripeCalls('portal.create').length === 1, r);
  // Webhook-level ownership
  reset();
  S.subs.sub_X = mkSub('sub_X', 'cus_B', 'professional', 'active', P1, { userId: 'uA' });
  await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_X));
  check('checkout for a customer already owned by another profile → refused (A stays free)', prof('uA').subscription_status === 'free' && prof('uA').stripe_customer_id === null);
  S.subs.sub_Y = mkSub('sub_Y', 'cus_Y', 'professional', 'active', P1, { userId: 'uA' });
  await hook('checkout.session.completed', checkoutSession('uB', S.subs.sub_Y));
  check('session user ≠ subscription metadata user → refused', prof('uB').subscription_status === 'starter' && prof('uB').stripe_subscription_id === 'sub_B' && prof('uA').subscription_status === 'free');
  await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_Y, { client_reference_id: 'uB' }));
  check('client_reference_id ≠ metadata user → refused', prof('uA').subscription_status === 'free' && prof('uB').stripe_subscription_id === 'sub_B');
  await hook('customer.subscription.deleted', mkSub('sub_OLD', 'cus_B', 'starter', 'canceled', P1, {}));
  check('deletion of a subscription that is NOT the linked one → B keeps Starter', prof('uB').subscription_status === 'starter');
  await hook('customer.subscription.updated', mkSub('sub_OLD', 'cus_B', 'professional', 'active', P1, {}));
  check('update for a non-linked subscription of the same customer → no plan change', prof('uB').subscription_status === 'starter');

  out('\nG. Failed / incomplete payments never grant');
  reset();
  S.subs.sub_A = mkSub('sub_A', 'cus_A', 'professional', 'incomplete', P1, { userId: 'uA' });
  await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_A, { payment_status: 'unpaid' }));
  check('checkout with payment_status unpaid → nothing granted', prof('uA').subscription_status === 'free' && prof('uA').credits_balance === 0);
  await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_A));
  check('subscription status incomplete → no plan, no credits', prof('uA').subscription_status === 'free' && prof('uA').credits_balance === 0, prof('uA'));
  reset();
  S.subs.sub_B.status = 'past_due';
  await hook('customer.subscription.updated', clone(S.subs.sub_B));
  await hook('invoice.payment_failed', { id: 'in_f', customer: 'cus_B', subscription: 'sub_B' });
  check('past_due → plan kept for the retry period, no new credits', prof('uB').subscription_status === 'starter' && prof('uB').credits_balance === 1000);
  prof('uB').credits_cycle_end = iso(NOW - DAY); prof('uB').credits_balance = 3;
  Object.assign(S.subs.sub_B, mkSub('sub_B', 'cus_B', 'starter', 'past_due', P2, {}));
  const rec = await stripeBilling.reconcileOverdue(prof('uB'));
  check('nightly reconcile for an overdue cycle while past_due → NO refill', prof('uB').credits_balance === 3 && rec.skipped === 'status_past_due', rec);
  S.subs.sub_B.status = 'active'; S.subs.sub_B.latest_invoice = { id: 'in_open', status: 'open' };
  const rec2 = await stripeBilling.reconcileOverdue(prof('uB'));
  check('nightly reconcile: active but latest invoice unpaid → NO refill', prof('uB').credits_balance === 3 && /latest_invoice/.test(rec2.skipped), rec2);
  S.subs.sub_B.latest_invoice = { id: 'in_ok', status: 'paid' };
  await stripeBilling.reconcileOverdue(prof('uB'));
  check('nightly reconcile: active and paid → refilled once for Stripe\'s period', prof('uB').credits_balance === 1000 && prof('uB').credits_cycle_end === iso(P2.end));
  S.subs.sub_B.status = 'unpaid';
  await hook('customer.subscription.updated', clone(S.subs.sub_B));
  check('unpaid (retries exhausted) → Free', prof('uB').subscription_status === 'free');
  reset();
  await hook('customer.subscription.deleted', clone(S.subs.sub_B));
  check('linked subscription deleted → Free', prof('uB').subscription_status === 'free');

  out('\nLegacy price');
  reset();
  Object.assign(S.subs.sub_B, mkSub('sub_B', 'cus_B', 'starter', 'active', P2, {}));
  S.subs.sub_B.items.data[0].price.id = 'price_legacy_starter_995';
  prof('uB').credits_balance = 40;
  await hook('invoice.payment_succeeded', invoice(S.subs.sub_B, 'subscription_cycle'));
  check('renewal on a legacy (unconfigured) price of the linked subscription → plan kept, renewal credits granted once', prof('uB').subscription_status === 'starter' && prof('uB').credits_balance === 1000 && prof('uB').credits_cycle_end === iso(P2.end), prof('uB'));
  S.subs.sub_Z = mkSub('sub_Z', 'cus_Z', 'starter', 'active', P1, { userId: 'uA' });
  S.subs.sub_Z.items.data[0].price.id = 'price_unknown';
  await hook('checkout.session.completed', checkoutSession('uA', S.subs.sub_Z));
  check('unknown price on a NEW subscription → no plan granted', prof('uA').subscription_status === 'free' && prof('uA').credits_balance === 0, prof('uA'));

  out('\nPreserved behaviour');
  const cm = require(path.join(SERVER_DIR, 'services/creditManager.js'));
  check('credit prices unchanged', JSON.stringify(cm.FEATURE_COSTS) === JSON.stringify({ ai_chat: 5, ai_analysis: 25, campaign_improvement: 10, audience_generation: 10, product_analysis: 10, competitor_analysis: 15, brand_voice: 20, campaign_generation: 25, website_analysis: 30, image_generation: 75, video_generation: 200, autopilot: 25 }));
  check('plan allowances unchanged', JSON.stringify(cm.PLAN_ALLOWANCES) === JSON.stringify({ free: 10, starter: 1000, creator: 2500, professional: 4000 }));
  check('no unexpected Stripe API calls', !S.calls.some((c) => c[0] === 'UNEXPECTED'), S.calls.filter((c) => c[0] === 'UNEXPECTED'));
  check('no outbound network requests', blocked.length === 0, blocked);

  out(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { out('CRASH', e); process.exit(2); });
