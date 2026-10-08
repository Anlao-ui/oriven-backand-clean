// ════════════════════════════════════════════════════════════════
// Onboarding — welcome eligibility, completion, first value, activation
// events, and the guarantee that none of it touches credits or plans.
//
// Runs the REAL server.js with Supabase replaced by a stateful in-memory
// mock and all outbound network blocked. No .env, no Stripe, no AI calls,
// no real users.
//
// RUN: node tests/onboarding.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5597;
const BASE = `http://127.0.0.1:${PORT}`;
const SINCE = '2026-10-08T00:00:00Z';

for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|ONBOARDING/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: 'mock-not-a-key', FRONTEND_URL: 'http://localhost:8899',
});

const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = (url, opts) => {
  const u = String(url && url.url || url);
  if (!new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}/`).test(u)) { blocked.push(u); return Promise.reject(new Error('network blocked in test: ' + u)); }
  return realFetch(url, opts);
};

// ── Stateful Supabase mock (columns can be "missing" to simulate an
// unapplied migration) ──
const TABLES = {};
const MISSING = { profiles: new Set(), events: false };
const rows = (t) => (TABLES[t] = TABLES[t] || []);
const writes = [];
class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.wantRows = false; this.cols = null; }
  select(c) { if (this.op !== 'select') this.wantRows = true; else this.cols = c; return this; }
  insert(p) { this.op = 'insert'; this.p = p; return this; }
  upsert(p) { this.op = 'upsert'; this.p = p; return this; }
  update(p) { this.op = 'update'; this.p = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
  in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  lt(c, v) { this.f.push((r) => r[c] != null && r[c] < v); return this; }
  is(c, v) { this.f.push((r) => (r[c] == null) === (v == null)); return this; }
  order() { return this; } range() { return this; } limit() { return this; } not() { return this; } or() { return this; } gt() { return this; } lte() { return this; } ilike() { return this; } filter() { return this; } contains() { return this; }
  maybeSingle() { this._single = true; return this.run(); }
  single() { this._single = true; return this.run(); }
  then(a, b) { return this.run().then(a, b); }
  _missing(keys) {
    if (this.t === 'events' && MISSING.events) return { code: 'PGRST205', message: "Could not find the table 'public.events' in the schema cache" };
    const set = MISSING[this.t];
    if (!set || !set.size) return null;
    const bad = keys.find((k) => set.has(k));
    return bad ? { code: '42703', message: `column ${this.t}.${bad} does not exist` } : null;
  }
  async run() {
    await null;
    const all = rows(this.t);
    const selKeys = this.cols ? this.cols.split(',').map((s) => s.trim()) : [];
    const writeKeys = this.p ? Object.keys(Array.isArray(this.p) ? this.p[0] : this.p) : [];
    const err = this._missing(selKeys.concat(writeKeys));
    if (err) return { data: null, error: err };
    const match = () => all.filter((r) => this.f.every((fn) => fn(r)));
    if (this.op === 'insert' || this.op === 'upsert') {
      const items = (Array.isArray(this.p) ? this.p : [this.p]).map((x) => Object.assign({ created_at: new Date().toISOString() }, x));
      items.forEach((it) => { all.push(it); writes.push([this.t, 'insert', it]); });
      return { data: this.wantRows ? items : null, error: null };
    }
    if (this.op === 'update') { const m = match(); m.forEach((r) => { Object.assign(r, this.p); writes.push([this.t, 'update', this.p]); }); return { data: this.wantRows ? m.map((x) => ({ ...x })) : null, error: null }; }
    if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
    const m = match().map((x) => ({ ...x }));
    return { data: this._single ? (m[0] || null) : m, error: null };
  }
}
const TOKENS = {};
const rpcCalls = [];
const supabaseMock = {
  from: (t) => new Q(t),
  rpc: async (name) => { rpcCalls.push(name); return { data: null, error: null }; },
  auth: { getUser: async (t) => TOKENS[t] ? { data: { user: TOKENS[t] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }, admin: new Proxy({}, { get: () => async () => { throw new Error('admin auth disabled in test'); } }) },
};
class StripeMock {
  constructor() { return new Proxy({}, { get: (_, p) => new Proxy({}, { get: (__, m) => async () => { throw new Error('unexpected stripe call ' + String(p) + '.' + String(m)); } }) }); }
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

const out = console.log.bind(console);
let pass = 0, fail = 0;
function check(name, ok, info) { ok ? pass++ : fail++; out((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); }
async function call(method, p, tok, body) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body == null ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const prof = (id) => rows('profiles').find((p) => p.id === id);
const OLD = '2026-05-14T10:00:00Z', NEW = '2026-10-09T09:00:00Z';
function P(id, plan, created, extra) {
  return Object.assign({ id, subscription_status: plan, created_at: created, onboarding_completed: false, primary_goal: null,
    credits_balance: plan === 'free' ? 10 : 1000, stripe_subscription_id: plan === 'free' ? null : 'sub_' + id, first_value_at: null, first_value_kind: null }, extra || {});
}
function reset() {
  for (const k of Object.keys(TABLES)) delete TABLES[k];
  MISSING.profiles = new Set(); MISSING.events = false; writes.length = 0; rpcCalls.length = 0;
  rows('profiles').push(
    // existing accounts (before the rollout)
    P('oldFreeIncomplete', 'free', OLD),                                        // old plan-step flow never finished
    P('oldFreeDone', 'free', OLD, { onboarding_completed: true }),
    P('oldStarter', 'starter', OLD, { onboarding_completed: true, primary_goal: 'research' }),
    P('oldCreatorIncomplete', 'creator', OLD),
    P('oldPro', 'professional', OLD, { onboarding_completed: true }),
    // new accounts
    P('newFree', 'free', NEW),
    P('newPaid', 'starter', NEW),
    P('newDone', 'free', NEW, { onboarding_completed: true, primary_goal: 'create' }),
    P('newSkip', 'free', NEW),
  );
  for (const p of rows('profiles')) TOKENS['tok_' + p.id] = { id: p.id, email: p.id + '@example.invalid' };
}
const snapshotMoney = () => JSON.stringify(rows('profiles').map((p) => [p.id, p.credits_balance, p.subscription_status, p.stripe_subscription_id]));

(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  require(path.join(SERVER_DIR, 'server.js'));
  const ob = require(path.join(SERVER_DIR, 'services/onboarding.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/onboarding/state'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }

  out('\nA. Eligibility (pure rules)');
  check('default rollout date is ' + SINCE, ob.since().toISOString() === new Date(SINCE).toISOString(), ob.since());
  check('no profile → not eligible', ob.eligibility(null).eligible === false);
  check('existing account, onboarding_completed=false → NOT eligible', ob.eligibility({ created_at: OLD, onboarding_completed: false }).eligible === false);
  check('existing account, onboarding_completed=null → NOT eligible', ob.eligibility({ created_at: OLD, onboarding_completed: null }).eligible === false);
  check('missing created_at → NOT eligible (never guess "new")', ob.eligibility({ onboarding_completed: false }).eligible === false);
  check('new account, not completed → eligible', ob.eligibility({ created_at: NEW, onboarding_completed: false }).eligible === true);
  check('new account, onboarding_completed=null → eligible', ob.eligibility({ created_at: NEW, onboarding_completed: null }).eligible === true);
  check('new account, completed → not eligible', ob.eligibility({ created_at: NEW, onboarding_completed: true }).eligible === false);
  process.env.ONBOARDING_V2_SINCE = '2026-11-01T00:00:00Z';
  check('ONBOARDING_V2_SINCE overrides the rollout date', ob.eligibility({ created_at: NEW, onboarding_completed: false }).eligible === false);
  process.env.ONBOARDING_V2_SINCE = 'not-a-date';
  check('invalid ONBOARDING_V2_SINCE falls back to the default', ob.since().toISOString() === new Date(SINCE).toISOString());
  delete process.env.ONBOARDING_V2_SINCE;

  out('\nB. GET /api/onboarding/state');
  reset();
  let r = await call('GET', '/api/onboarding/state', null);
  check('no token → 401', r.status === 401);
  r = await call('GET', '/api/onboarding/state', 'tok_forged');
  check('forged token → 401', r.status === 401);
  const expect = { oldFreeIncomplete: false, oldFreeDone: false, oldStarter: false, oldCreatorIncomplete: false, oldPro: false, newFree: true, newPaid: true, newDone: false, newSkip: true };
  for (const [id, want] of Object.entries(expect)) {
    r = await call('GET', '/api/onboarding/state', 'tok_' + id);
    check(`${id}: eligible=${want}`, r.status === 200 && r.body.eligible === want, r.body);
  }
  r = await call('GET', '/api/onboarding/state', 'tok_newFree');
  check('state reports newAccount, plan, goal, firstValueAt', r.body.newAccount === true && r.body.plan === 'free' && r.body.goal === null && r.body.firstValueAt === null, r.body);
  r = await call('GET', '/api/onboarding/state', 'tok_newFree');
  check('repeated state reads (refresh/login/other device) stay eligible and write nothing', r.body.eligible === true && writes.length === 0, writes);

  out('\nC. POST /api/onboarding/complete');
  reset();
  let before = snapshotMoney();
  r = await call('POST', '/api/onboarding/complete', null, { goal: 'create' });
  check('no token → 401', r.status === 401);
  r = await call('POST', '/api/onboarding/complete', 'tok_newFree', { goal: 'launch' });
  check('unknown welcome goal → 400, nothing written', r.status === 400 && prof('newFree').onboarding_completed === false, r);
  r = await call('POST', '/api/onboarding/complete', 'tok_newFree', { goal: 'create' });
  check('choose Create → completed, primary_goal=create', r.status === 200 && prof('newFree').onboarding_completed === true && prof('newFree').primary_goal === 'create', prof('newFree'));
  check('completion timestamp stored', !!prof('newFree').onboarding_completed_at);
  r = await call('GET', '/api/onboarding/state', 'tok_newFree');
  check('after choosing: not eligible any more (any device)', r.body.eligible === false && r.body.reason === 'completed', r.body);
  r = await call('POST', '/api/onboarding/complete', 'tok_newPaid', { goal: 'explore' });
  check('choose Explore → stored as Control Center goal (business)', prof('newPaid').primary_goal === 'business' && prof('newPaid').onboarding_completed === true, prof('newPaid'));
  r = await call('POST', '/api/onboarding/complete', 'tok_newSkip', { skipped: true });
  check('skip → completed without a goal', prof('newSkip').onboarding_completed === true && prof('newSkip').primary_goal === null, prof('newSkip'));
  r = await call('POST', '/api/onboarding/complete', 'tok_newFree', { goal: 'create' });
  r = await call('POST', '/api/onboarding/complete', 'tok_newFree', { goal: 'create' });
  check('double submit is idempotent', r.status === 200 && prof('newFree').primary_goal === 'create');
  r = await call('POST', '/api/onboarding/complete', 'tok_oldFreeIncomplete');
  check('no body (older clients) still completes', r.status === 200 && prof('oldFreeIncomplete').onboarding_completed === true);
  check('completion never changes credits, plan or subscription', snapshotMoney() === before);
  check('completion never calls a credit RPC', rpcCalls.length === 0, rpcCalls);
  check('a user can only touch their own row (body userId ignored)', (await call('POST', '/api/onboarding/complete', 'tok_newDone', { goal: 'research', userId: 'oldPro' })).status === 200 && prof('oldPro').primary_goal === null && prof('newDone').primary_goal === 'research');

  out('\nD. Migration not applied yet');
  reset();
  MISSING.profiles = new Set(['onboarding_completed_at', 'first_value_at', 'first_value_kind']);
  r = await call('GET', '/api/onboarding/state', 'tok_newFree');
  check('state still works without the new columns', r.status === 200 && r.body.eligible === true && r.body.firstValueAt === null, r);
  r = await call('POST', '/api/onboarding/complete', 'tok_newFree', { goal: 'research' });
  check('complete still works without onboarding_completed_at', r.status === 200 && prof('newFree').onboarding_completed === true && prof('newFree').primary_goal === 'research', r);
  check('recordFirstValue is a quiet no-op without the columns', (await ob.recordFirstValue('newFree', 'create')) === false && !prof('newFree').first_value_at);
  MISSING.events = true;
  r = await call('POST', '/api/events', 'tok_newFree', { event: 'onboarding_shown' });
  check('events endpoint answers 204 even without the events table', r.status === 204, r);

  out('\nE. First value');
  reset();
  check('first Create success → recorded', (await ob.recordFirstValue('newFree', 'create')) === true && prof('newFree').first_value_kind === 'create');
  const firstAt = prof('newFree').first_value_at;
  check('second success → not recorded again (kept the first)', (await ob.recordFirstValue('newFree', 'research')) === false && prof('newFree').first_value_at === firstAt && prof('newFree').first_value_kind === 'create');
  check('one first_create_success event', rows('events').filter((e) => e.event_name === 'first_create_success' && e.user_id === 'newFree').length === 1);
  const par = await Promise.all([ob.recordFirstValue('newPaid', 'research'), ob.recordFirstValue('newPaid', 'research')]);
  check('parallel successes record once', par.filter(Boolean).length === 1 && rows('events').filter((e) => e.user_id === 'newPaid').length === 1, par);
  check('unknown kind ignored', (await ob.recordFirstValue('newDone', 'launch')) === false && !prof('newDone').first_value_at);
  r = await call('GET', '/api/onboarding/state', 'tok_newFree');
  check('state exposes firstValueAt/kind', r.body.firstValueAt === firstAt && r.body.firstValueKind === 'create', r.body);
  check('first value never touches credits', rows('profiles').every((p) => p.credits_balance === (p.subscription_status === 'free' ? 10 : 1000)));

  out('\nF. POST /api/events');
  reset();
  r = await call('POST', '/api/events', null, { event: 'visited_site', sessionId: 'sess_abcdefgh' });
  check('anonymous page visit accepted', r.status === 204 && rows('events').length === 1 && rows('events')[0].user_id === null);
  r = await call('POST', '/api/events', null, { event: 'paywall_shown' });
  check('anonymous non-visit event → 401', r.status === 401);
  r = await call('POST', '/api/events', 'tok_newFree', { event: 'grant_credits' });
  check('unknown event → 400, nothing stored', r.status === 400 && rows('events').length === 1);
  r = await call('POST', '/api/events', 'tok_newFree', { event: 'first_create_success' });
  check('server-only event cannot be sent by a client', r.status === 400);
  r = await call('POST', '/api/events', 'tok_newFree', { event: 'paywall_shown', sessionId: 'sess_abcdefgh', props: { action: 'research', plan: 'starter', required: 25, balance: 10, prompt: 'Sell my secret product to dentists', email: 'a@b.c', goal: 'Buy now!! <script>' } });
  const ev = rows('events')[rows('events').length - 1];
  check('event stored with the verified user id', r.status === 204 && ev.user_id === 'newFree' && ev.event_name === 'paywall_shown');
  check('props keep only allowlisted short tokens', JSON.stringify(ev.props) === JSON.stringify({ action: 'research', plan: 'starter', required: 25, balance: 10 }), ev.props);
  check('free text / prompts / emails are never stored', !JSON.stringify(rows('events')).match(/secret|dentists|a@b\.c|script/));
  r = await call('POST', '/api/events', 'tok_newFree', { event: 'onboarding_shown', props: 'not-an-object' });
  check('non-object props → stored without props', r.status === 204 && rows('events')[rows('events').length - 1].props === null);
  r = await call('POST', '/api/events', 'tok_newFree', { event: 'session_linked', sessionId: 'sess_abcdefgh' });
  check('session link attaches the anonymous visit to the user', r.status === 204 && rows('events')[0].user_id === 'newFree', rows('events')[0]);
  r = await call('POST', '/api/events', null, { event: 'session_linked', sessionId: 'sess_abcdefgh' });
  check('session link requires sign-in', r.status === 401);
  let limited = 0;
  for (let i = 0; i < 70; i++) { const x = await call('POST', '/api/events', 'tok_oldPro', { event: 'create_started' }); if (x.status === 429) limited++; }
  check('per-user rate limit (60/min)', limited === 10, limited);
  let anon429 = 0;
  for (let i = 0; i < 620; i++) {
    const x = await realFetch(BASE + '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.' + Math.floor(i / 250) + '.' + (i % 250) }, body: JSON.stringify({ event: 'visited_site' }) });
    if (x.status === 429) anon429++;
  }
  check('spoofed forwarded addresses still hit the global anonymous cap (600/min)', anon429 >= 19, anon429);
  check('events never change credits or plans', rows('profiles').every((p) => p.credits_balance === (p.subscription_status === 'free' ? 10 : 1000)) && rpcCalls.length === 0);

  out('\nG. Legacy goal route');
  reset();
  r = await call('PUT', '/api/onboarding/goal', 'tok_newFree', { goal: 'autopilot' });
  check('older goal values still accepted', r.status === 200 && prof('newFree').primary_goal === 'autopilot' && prof('newFree').onboarding_completed === false);
  r = await call('PUT', '/api/onboarding/goal', 'tok_newFree', { goal: 'explore' });
  check('legacy route rejects values it never accepted', r.status === 400);

  out('\nH. Isolation');
  check('no outbound network attempted', blocked.length === 0, blocked);

  out(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { out('CRASH', e && e.stack || e); process.exit(1); });
