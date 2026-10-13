// ════════════════════════════════════════════════════════════════
// AI routes require a signed-in user; guests never reach the provider.
//
// Runs the REAL server.js and the REAL providers/aimlProvider.js; only the
// provider's HTTP endpoint is faked (AIML_BASE_OVERRIDE → an in-process
// handler) and Supabase, Stripe, email and cron are in-memory mocks —
// nothing leaves this process and no real data is touched.
//
// Covers: every route behind requireSubIfAuthed / requireSubOrFree /
// requireSubOrOnboardingGen → 401 without (or with an invalid) session and
// zero provider calls; Free daily generation and Free-allowed routes still
// work; Free → 403 on paid-only routes; paid charge + refund unchanged;
// plan lookup failures fail closed; the provider-hook backstop.
//
// RUN: node tests/ai-auth.test.js   (from server/)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5613;
const BASE = `http://127.0.0.1:${PORT}`;
const AIML = 'http://aiml.mock.invalid';
const SECRET_KEY = 'aiml-test-key-0123456789-should-never-be-logged';

for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|AI_DAILY|AI_USER|PAID_|EMAIL|RESEND/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: SECRET_KEY, AIML_BASE_OVERRIDE: AIML, FRONTEND_URL: 'http://localhost:8899',
});

// ── Network: this server + the fake provider only ──
const realFetch = globalThis.fetch;
const blocked = [];
const prov = { handler: null, calls: [] };
globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url || url);
  if (new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}/`).test(u)) return realFetch(url, opts);
  if (u.startsWith(AIML)) {
    let body = null; try { body = JSON.parse(opts && opts.body); } catch (_) {}
    prov.calls.push({ path: u.slice(AIML.length), model: body && body.model, auth: opts && opts.headers && opts.headers.Authorization });
    return prov.handler({ path: u.slice(AIML.length), body });
  }
  blocked.push(u);
  throw new Error('network blocked in test: ' + u);
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const PKG_JSON = JSON.stringify({ googleAds: { headlines: ['A', 'B', 'C'], descriptions: ['d'] }, strategy: { angle: 'x' }, visualConcepts: [] });
const ok = () => json(200, { choices: [{ message: { content: PKG_JSON } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });

// ── Stateful in-memory Supabase ──
const TABLES = {};
const UNIQUE = {
  credit_actions: [
    { cols: ['id'] },
    { cols: ['user_id', 'idempotency_key'] },
    { cols: ['user_id', 'lane'], where: (r) => r.status === 'in_progress' },
  ],
};
const db = { missing: new Set(), rpcCalls: [] };
function rows(t) { return (TABLES[t] = TABLES[t] || []); }
function violates(t, cand, ignore) {
  for (const u of UNIQUE[t] || []) {
    if (u.where && !u.where(cand)) continue;
    if (rows(t).some((r) => r !== ignore && (!u.where || u.where(r)) && u.cols.every((c) => r[c] === cand[c]))) return true;
  }
  return false;
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
  lt(c, v) { this.f.push((r) => r[c] < v); return this; }
  lte(c, v) { this.f.push((r) => r[c] <= v); return this; }
  gt(c, v) { this.f.push((r) => r[c] > v); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  is(c, v) { this.f.push((r) => (r[c] == null) === (v == null)); return this; }
  order() { return this; } range() { return this; } not() { return this; } or() { return this; } ilike() { return this; } contains() { return this; } filter() { return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this._single = 'maybe'; return this.run(); }
  single() { this._single = 'one'; return this.run(); }
  then(a, b) { return this.run().then(a, b); }
  async run() {
    await null;
    if (db.missing.has(this.t)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${this.t}' in the schema cache` } };
    const all = rows(this.t);
    const match = () => all.filter((r) => this.f.every((fn) => fn(r)));
    if (this.op === 'insert' || this.op === 'upsert') {
      const items = (Array.isArray(this.p) ? this.p : [this.p]).map((x) => Object.assign({ created_at: new Date().toISOString() }, x));
      for (const it of items) if (this.op === 'insert' && violates(this.t, it)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      // upsert merges into an existing row with the same id, as Postgres ON CONFLICT (id) does
      items.forEach((it) => { const ex = this.op === 'upsert' && it.id != null && all.find((r) => r.id === it.id); if (ex) Object.assign(ex, this.p && !Array.isArray(this.p) ? this.p : it); else all.push(it); });
      return { data: this.wantRows ? items.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'update') {
      const m = match();
      for (const r of m) { const next = Object.assign({}, r, this.p); if (violates(this.t, next, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } }; }
      m.forEach((r) => Object.assign(r, this.p));
      return { data: this.wantRows ? m.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
    let m = match().map((x) => ({ ...x }));
    if (this.lim != null) m = m.slice(0, this.lim);
    if (this._single) return { data: m[0] || null, error: null };
    return { data: m, error: null };
  }
}
const TOKENS = {};
const supabaseMock = {
  from: (t) => new Q(t),
  rpc: async (name, args) => {
    db.rpcCalls.push({ name, args });
    const p = rows('profiles').find((r) => r.id === (args && args.p_user_id));
    if (name === 'spend_credits') {
      if (!p) return { data: [{ ok: false, balance: null }], error: null };
      if (p.credits_balance >= args.p_amount) { p.credits_balance -= args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; }
      return { data: [{ ok: false, balance: p.credits_balance }], error: null };
    }
    if (name === 'refund_credits') {
      if (!p) return { data: [{ ok: false, balance: null }], error: null };
      p.credits_balance += args.p_amount;
      return { data: [{ ok: true, balance: p.credits_balance }], error: null };
    }
    return { data: null, error: null };
  },
  auth: {
    getUser: async (t) => TOKENS[t] ? { data: { user: TOKENS[t] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } },
    admin: new Proxy({}, { get: () => async () => { throw new Error('admin auth disabled in test'); } }),
  },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'storage disabled in test' } }), getPublicUrl: () => ({ data: {} }) }) },
};


const _load = Module._load;
Module._load = function (req) {
  if (req === 'stripe') return function StripeMock() { return new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error('stripe disabled in test'); } }) }); };
  if (req === '@supabase/supabase-js') return { createClient: () => supabaseMock };
  if (req === 'dotenv') return { config: () => ({ parsed: {} }) };
  if (req === 'node-cron') return { schedule: () => ({ stop() {} }) };
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async () => { throw new Error('email disabled in test'); }, verify: async () => true }) };
  return _load.apply(this, arguments);
};


let pass = 0, fail = 0;
const out = console.log.bind(console);
function check(name, okv, info) { okv ? pass++ : fail++; out((okv ? '  PASS — ' : '  FAIL — ') + name + (okv || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); }
async function call(method, p, tok, body, headers) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => 'test-' + Math.random().toString(36).slice(2, 12);
const AD = { product: 'Organic coffee subscription', goal: 'Sales', platform: 'google', platforms: ['google'], mode: 'full' };
// One body that satisfies the validation of every generation route, so a
// route that let a guest through would actually reach the provider.
const RICH = Object.assign({}, AD, { prompt: 'a cup of coffee on a table', question: 'coffee market in Amsterdam', query: 'coffee market', message: 'hello', messages: [{ role: 'user', content: 'hello' }], text: 'hello', url: 'https://example.com', website: 'https://example.com', imageUrl: 'https://example.com/a.png', image: 'data:image/png;base64,iVBORw0KGgo=', images: ['data:image/png;base64,iVBORw0KGgo='], productImages: ['data:image/png;base64,iVBORw0KGgo='], description: 'An organic coffee subscription', topic: 'coffee', brief: 'coffee', keywords: ['coffee'], keyword: 'coffee', businessName: 'Bean Co', brandName: 'Bean Co', industry: 'food', campaignId: 'c1', content: 'hello', headline: 'Great coffee', audience: 'coffee lovers', name: 'x', type: 'image', format: 'square', duration: 5, style: 'clean', concept: { title: 'x', prompt: 'coffee' }, visualConcept: 'coffee cup', productName: 'Bean', brand: 'Bean Co', competitors: ['Acme'], niche: 'coffee', input: 'coffee', idea: 'coffee', script: 'hello', aspectRatio: '1:1', size: '1024x1024', command: 'create an ad' });

// Every route behind the three middlewares that used to let guests through.
const fs = require('fs');
const SRC = fs.readFileSync(path.join(SERVER_DIR, 'server.js'), 'utf8');
const GUARDED = [];
{ const re = /\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(requireSubIfAuthed|requireSubOrFree|requireSubOrOnboardingGen)\b/g; let m;
  while ((m = re.exec(SRC))) GUARDED.push([m[1].toUpperCase(), m[2].replace(/:([A-Za-z_]+)/g, 'x1'), m[3]]); }

const NOW = new Date().toISOString();
function reset() {
  for (const k of Object.keys(TABLES)) delete TABLES[k];
  db.rpcCalls.length = 0; db.missing.clear(); prov.calls.length = 0;
  rows('profiles').push(
    { id: 'paid', subscription_status: 'starter', credits_balance: 1000, free_campaign_used_at: null, onboarding_completed: true },
    { id: 'free', subscription_status: 'free', credits_balance: 20, free_campaign_used_at: null, onboarding_completed: true },
    { id: 'freeUsed', subscription_status: 'free', credits_balance: 0, free_campaign_used_at: NOW, onboarding_completed: true },
  );
  for (const id of ['paid', 'free', 'freeUsed']) TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: '2026-01-01T00:00:00Z' };
  paidActions._resetForTests(); spendGuard._resetForTests();
  prov.handler = ok;
}
const prof = (id) => rows('profiles').find((p) => p.id === id);
let paidActions, spendGuard, aiUsage, aiml;

(async () => {
  const quiet = { log: console.log };
  const noop = () => {}; console.log = noop; console.warn = noop; console.error = noop; console.info = noop;
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  aiUsage = require(path.join(SERVER_DIR, 'services/aiUsage.js'));
  aiml = require(path.join(SERVER_DIR, 'providers/aimlProvider.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);

  say(`\nA. Without sign-in: all ${GUARDED.length} AI/paid routes answer 401 and never reach the provider`);
  check('the route list was found (sanity)', GUARDED.length >= 40 && GUARDED.some(([, p]) => p === '/api/ai/create-ad') && GUARDED.some(([, p]) => p === '/api/generate-ugc-video'), GUARDED.length);
  for (const [label, tok, code] of [['no token', null, 'AUTH_REQUIRED'], ['invalid token', 'not-a-real-session', 'AUTH_INVALID']]) {
    reset();
    const wrong = [];
    for (const [m, p] of GUARDED) {
      const r = await call(m, p, tok, m === 'GET' ? null : RICH, { 'X-Idempotency-Key': key() });
      if (r.status !== 401 || !r.body || r.body.code !== code) wrong.push(`${m} ${p} → ${r.status} ${r.body && r.body.code}`);
    }
    await sleep(100);
    check(`${label}: every route 401 ${code}`, wrong.length === 0, wrong.slice(0, 8));
    check(`${label}: zero provider calls, no credits touched, no paid actions opened`, prov.calls.length === 0 && db.rpcCalls.length === 0 && rows('credit_actions').length === 0, { calls: prov.calls.length, rpc: db.rpcCalls.map((x) => x.name) });
  }
  reset();
  for (const [m, p] of [['POST', '/api/ai/create-ad'], ['POST', '/api/generate-image'], ['POST', '/api/generate-ugc-video'], ['POST', '/api/video-ads/generate'], ['POST', '/api/research/query']]) {
    const r = await call(m, p, null, RICH);
    check(`${p}: 401 without sign-in`, r.status === 401, r);
  }
  check('…and still no provider call', prov.calls.length === 0, prov.calls.length);

  say('\nB. Free accounts keep what they had');
  reset();
  let r = await call('POST', '/api/ai/create-ad', 'tok_free', AD, { 'X-Idempotency-Key': key() });
  await sleep(100);
  check('Free user, daily free generation available: Create works (200), reaches the provider, no credits charged', r.status === 200 && prov.calls.length > 0 && prof('free').credits_balance === 20, { status: r.status, calls: prov.calls.length, bal: prof('free').credits_balance });
  check('…and the daily free generation is used up server-side', !!prof('free').free_campaign_used_at, prof('free'));
  prov.calls.length = 0;
  r = await call('POST', '/api/ai/create-ad', 'tok_free', AD, { 'X-Idempotency-Key': key() });
  check('the same Free user again within 24h: 403 SUBSCRIPTION_REQUIRED, no provider call', r.status === 403 && r.body.code === 'SUBSCRIPTION_REQUIRED' && prov.calls.length === 0, { status: r.status, body: r.body, calls: prov.calls.length });
  reset();
  r = await call('POST', '/api/ai/create-ad', 'tok_freeUsed', AD, { 'X-Idempotency-Key': key() });
  check('Free user who already used today’s generation: 403, no provider call', r.status === 403 && prov.calls.length === 0, { status: r.status, calls: prov.calls.length });
  for (const p of ['/api/generate-text', '/api/generate-ad', '/api/ai/chat', '/api/video-ads/generate']) {
    reset();
    r = await call('POST', p, 'tok_free', RICH, { 'X-Idempotency-Key': key() });
    check(`Free user on paid-only ${p}: 403 as before, no provider call`, r.status === 403 && prov.calls.length === 0, { status: r.status, calls: prov.calls.length });
  }
  reset();
  r = await call('POST', '/api/generate-ugc-video', 'tok_freeUsed', RICH, { 'X-Idempotency-Key': key() });
  check('Free user on a Free-allowed route (UGC video) is still let through to its credit check (not 401/403)', r.status !== 401 && r.status !== 403, { status: r.status, body: r.body });

  say('\nC. Paid accounts: charge and refund unchanged');
  reset();
  r = await call('POST', '/api/ai/create-ad', 'tok_paid', AD, { 'X-Idempotency-Key': key() });
  await sleep(100);
  const charged = 1000 - prof('paid').credits_balance;
  check('Starter user: Create works (200), credits charged, action succeeded', r.status === 200 && charged > 0 && (rows('credit_actions').slice(-1)[0] || {}).status === 'succeeded', { status: r.status, charged, action: rows('credit_actions').slice(-1)[0] });
  reset(); prov.handler = () => json(500, { error: { message: 'Internal error' } });
  r = await call('POST', '/api/ai/create-ad', 'tok_paid', AD, { 'X-Idempotency-Key': key() });
  await sleep(100);
  check('Starter user, provider fails: error to the client, credits refunded in full', r.status >= 500 && prof('paid').credits_balance === 1000 && db.rpcCalls.some((x) => x.name === 'refund_credits'), { status: r.status, bal: prof('paid').credits_balance });

  say('\nD. Failing closed');
  reset();
  const origFrom = supabaseMock.from;
  supabaseMock.from = (t) => { if (t === 'profiles') throw new Error('db down'); return origFrom(t); };
  const fc = [];
  for (const p of ['/api/ai/create-ad', '/api/generate-text', '/api/generate-image']) { const x = await call('POST', p, 'tok_paid', RICH, { 'X-Idempotency-Key': key() }); fc.push(p + ' ' + x.status + ' ' + (x.body && x.body.code)); }
  supabaseMock.from = origFrom;
  check('plan lookup throws: 503 AUTH_CHECK_FAILED on all three middlewares (was: passed on as a guest)', fc.every((s) => / 503 AUTH_CHECK_FAILED$/.test(s)), fc);
  check('…and no provider call', prov.calls.length === 0, prov.calls.length);

  say('\nE. Backstop in the provider hook (a future route without the middleware)');
  reset();
  let err = null;
  await new Promise((resolve) => aiUsage.middleware({ method: 'POST', originalUrl: '/api/some-new-route' }, {}, async () => { try { await aiml.generateText('system', 'hello'); } catch (e) { err = e; } resolve(); }));
  check('web request without a signed-in user: refused with AI_AUTH_REQUIRED before anything is sent', err && err.code === 'AI_AUTH_REQUIRED' && prov.calls.length === 0, { err: err && err.code, calls: prov.calls.length });
  err = null;
  await new Promise((resolve) => aiUsage.middleware({ method: 'POST', originalUrl: '/api/some-new-route' }, {}, async () => { aiUsage.setUser('paid'); try { await aiml.generateText('system', 'hello'); } catch (e) { err = e; } resolve(); }));
  check('the same request with a signed-in user: allowed', !err && prov.calls.length === 1, { err: err && err.message, calls: prov.calls.length });
  err = null; prov.calls.length = 0;
  await aiUsage.withContext({ operation: 'cron:test' }, async () => { try { await aiml.generateText('system', 'hello'); } catch (e) { err = e; } });
  check('scheduled job (Autopilot etc.): allowed', !err && prov.calls.length === 1, { err: err && err.message, calls: prov.calls.length });
  check('no other outbound requests', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.info('CRASH', e && e.stack || e); process.exit(2); });
