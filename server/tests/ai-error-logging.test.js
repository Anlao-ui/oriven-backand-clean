// ════════════════════════════════════════════════════════════════
// AI provider failures are recorded with a category and HTTP status.
//
// Runs the REAL server.js and the REAL providers/aimlProvider.js; only the
// provider's HTTP endpoint is faked (AIML_BASE_OVERRIDE → an in-process
// handler), so every failure travels the real path: classifyError → error
// hook → aiUsage.noteProviderError → paid action → credit_actions.error,
// plus the [AIUsage] log lines. Supabase, Stripe, email and cron are
// in-memory mocks; nothing leaves this process.
//
// RUN: node tests/ai-error-logging.test.js   (from server/)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5611;
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
// Same CHECK constraint as production (migration 2026-10-creative-assets.sql).
const CHECKS = { creative_assets: (r) => r.status == null || ['draft', 'needs_improvement', 'ready', 'approved', 'published', 'rejected'].includes(r.status) };
const checkFails = (t, r) => !!(CHECKS[t] && !CHECKS[t](r));
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
      for (const it of items) if (checkFails(this.t, it)) return { data: null, error: { code: '23514', message: 'new row for relation "' + this.t + '" violates check constraint "' + this.t + '_status_check"' } };
      for (const it of items) if (this.op === 'insert' && violates(this.t, it)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      items.forEach((it) => all.push(it));
      return { data: this.wantRows ? items.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'update') {
      const m = match();
      for (const r of m) { if (checkFails(this.t, Object.assign({}, r, this.p))) return { data: null, error: { code: '23514', message: 'violates check constraint "' + this.t + '_status_check"' } }; }
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
const RS = { question: 'coffee subscription market in Amsterdam' };
const logs = [];
let paidActions, spendGuard;

function reset() {
  for (const k of Object.keys(TABLES)) delete TABLES[k];
  db.rpcCalls.length = 0; db.missing.clear(); prov.calls.length = 0; logs.length = 0;
  rows('profiles').push({ id: 'u1', subscription_status: 'starter', credits_balance: 1000, free_campaign_used_at: null });
  TOKENS.tok1 = { id: 'u1', email: 'person@example.invalid' };
  paidActions._resetForTests(); spendGuard._resetForTests();
  delete process.env.AI_DAILY_COST_CAP_USD;
}
const lastAction = () => rows('credit_actions').slice(-1)[0] || {};
const bal = () => rows('profiles').find((p) => p.id === 'u1').credits_balance;
const providerLogs = () => logs.filter((l) => l.includes('"ai_provider_error"')).map((l) => JSON.parse(l.replace(/^\[AIUsage\] /, '')));
const failedCallLogs = () => logs.filter((l) => l.includes('"ai_call"') && l.includes('"success":false')).map((l) => JSON.parse(l.replace(/^\[AIUsage\] /, '')));

(async () => {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a) => { const s = a.map(String).join(' '); if (s.startsWith('[AIUsage]')) logs.push(s); logs.all = (logs.all || []).concat(s); };
  console.log = capture; console.warn = capture; console.error = capture;
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);

  say('\nA. Create (/api/ai/create-ad): each provider failure is recorded with its category and status');
  const CASES = [
    // [label, provider response, expected HTTP to the client, expected stored error]
    ['402 payment required', () => json(402, { error: { message: 'Insufficient balance. Top up your account.' } }), 503, 'http_503:account_payment_required:402'],
    ['401 key rejected', () => json(401, { error: { message: 'Invalid API key' } }), 503, 'http_503:account_key_rejected:401'],
    ['403 forbidden', () => json(403, { error: { message: 'Access denied for this model on your plan' } }), 503, 'http_503:account_forbidden:403'],
    ['400 "insufficient balance"', () => json(400, { error: { message: 'Insufficient balance for this request' } }), 503, 'http_503:account_balance_or_quota:400'],
    ['500 provider error', () => json(500, { error: { message: 'Internal error' } }), 500, 'http_500:provider_server_error:500'],
    ['404 unknown model', () => json(404, { error: { message: 'Model not found' } }), 500, 'http_500:provider_rejected_request:404'],
  ];
  for (const [label, resp, wantHttp, wantErr] of CASES) {
    reset(); prov.handler = resp;
    const r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
    await sleep(50);
    const a = lastAction();
    check(`${label}: client gets ${wantHttp}, credit_actions.error = "${wantErr}", credits back`, r.status === wantHttp && a.error === wantErr && bal() === 1000, { status: r.status, error: a.error, status_row: a.status, bal: bal() });
  }

  reset();
  prov.handler = () => json(429, { error: { message: 'Too many requests' } });
  let r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  await sleep(50);
  check('429 rate limited (after the provider retry): 503, stored "http_503:rate_limited:429"', r.status === 503 && lastAction().error === 'http_503:rate_limited:429', { status: r.status, error: lastAction().error, calls: prov.calls.length });

  reset();
  prov.handler = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  await sleep(50);
  check('provider unreachable: 503, stored "http_503:network"', r.status === 503 && lastAction().error === 'http_503:network', { status: r.status, error: lastAction().error });

  reset();
  process.env.AI_DAILY_COST_CAP_USD = '0.0000001';
  spendGuard.recordCall({ userId: 'u1', model: 'claude-opus-4-8', usage: { promptTokens: 1000, completionTokens: 1000 }, success: true });
  prov.handler = ok;
  r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  await sleep(50);
  check('daily spend cap: 503, nothing sent to the provider, stored "http_503:spend_limit:daily_cost_cap"', r.status === 503 && prov.calls.length === 0 && lastAction().error === 'http_503:spend_limit:daily_cost_cap', { status: r.status, error: lastAction().error, calls: prov.calls.length });
  delete process.env.AI_DAILY_COST_CAP_USD;

  reset(); prov.handler = ok;
  r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  await sleep(50);
  check('success: 200, action succeeded, no error stored', r.status === 200 && lastAction().status === 'succeeded' && !lastAction().error, lastAction());

  say('\nB. Other AI features use the same path');
  reset(); prov.handler = () => json(402, { error: { message: 'Insufficient balance' } });
  r = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
  // Research 2.0 runs as a job (202); wait for it to end before checking.
  for (let i = 0; i < 100 && r.status === 202; i++) { const g = await call('GET', '/api/research/reports/' + r.body.reportId, 'tok1'); if (g.body && g.body.summary && g.body.summary.status !== 'running') break; await sleep(30); }
  await sleep(50);
  check('Research: failure stored with "account_payment_required:402", credits refunded', (r.status === 202 || r.status >= 500) && /:account_payment_required:402$/.test(lastAction().error || '') && bal() === 1000, { status: r.status, error: lastAction().error, bal: bal() });
  reset(); prov.handler = () => json(401, { error: { message: 'Invalid API key' } });
  r = await call('POST', '/api/ai/create-ad', 'tok1', Object.assign({}, AD, { mode: 'concepts' }), { 'X-Idempotency-Key': key() });
  await sleep(50);
  check('Create (concept mode): failure stored with "account_key_rejected:401"', r.status === 503 && lastAction().error === 'http_503:account_key_rejected:401', { status: r.status, error: lastAction().error });

  say('\nC. Logs: category and status, never the key, the provider message or the person');
  reset(); prov.handler = () => json(402, { error: { message: 'Insufficient balance. Top up your account.' } });
  await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  await sleep(50);
  const pl = providerLogs(), fl = failedCallLogs();
  check('one "ai_provider_error" log line with errorCategory + providerStatus', pl.length === 1 && pl[0].errorCategory === 'account_payment_required' && pl[0].providerStatus === 402 && pl[0].path === '/v1/chat/completions', pl);
  check('the failed "ai_call" usage line carries the same category and status', fl.length >= 1 && fl[0].errorCategory === 'account_payment_required' && fl[0].providerStatus === 402, fl);
  const aiLines = logs.join('\n');
  check('[AIUsage] lines never contain the API key, the provider message or the email', !aiLines.includes(SECRET_KEY) && !/Insufficient balance/.test(aiLines) && !aiLines.includes('person@example.invalid'), aiLines.slice(0, 300));
  const stored = JSON.stringify(TABLES);
  check('nothing stored in the database contains the API key', !stored.includes(SECRET_KEY));
  // (credit_transactions.error_message has always kept the provider's own
  // error text for paid users — unchanged; the new record is category only.)
  check('credit_actions.error holds only the category and status — no provider message', rows('credit_actions').every((a) => !a.error || /^[a-z0-9_:]+$/i.test(a.error)), rows('credit_actions').map((a) => a.error));
  check('the key never appears in any log line at all', !(logs.all || []).some((l) => l.includes(SECRET_KEY)));
  check('the provider really received the key (sanity: the real provider module ran)', prov.calls.length > 0 && prov.calls.every((c) => c.auth === 'Bearer ' + SECRET_KEY));
  check('no other outbound requests', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.info('CRASH', e && e.stack || e); process.exit(2); });
