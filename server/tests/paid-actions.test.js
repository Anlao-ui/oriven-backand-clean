// ════════════════════════════════════════════════════════════════
// Paid actions — financial invariants (P0 credit/AI-cost fixes)
//
// Runs the REAL server.js with everything external replaced by in-memory
// mocks: Supabase (stateful: balances, spend/refund RPCs, credit_actions
// with its unique indexes), the AI provider (programmable, counts calls),
// Stripe, email, cron, dotenv. Outbound network is blocked; no .env is
// read; no real user, credit, provider or Stripe call can happen.
//
// RUN: node tests/paid-actions.test.js   (from oriven-backand-clean/server)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5597;
const BASE = `http://127.0.0.1:${PORT}`;

// ── Clean environment: placeholders only ──
for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|AI_DAILY|AI_USER|PAID_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: 'mock-not-a-key', FRONTEND_URL: 'http://localhost:8899',
});

// ── Block every outbound request except this test server ──
const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = (url, opts) => {
  const u = String(url && url.url || url);
  if (!new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}/`).test(u)) { blocked.push(u); return Promise.reject(new Error('network blocked in test: ' + u)); }
  return realFetch(url, opts);
};

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
      items.forEach((it) => all.push(it));
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

// ── Programmable fake AI provider ──
const prov = { calls: [], hooks: {}, handler: null, videoStatus: {} };
function full(content, usage) { return { choices: [{ message: { content } }], usage: usage || { prompt_tokens: 1500, completion_tokens: 900, total_tokens: 2400 } }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function provCall(kind, info) {
  if (prov.hooks.before) prov.hooks.before({ method: 'POST', path: kind === 'video' ? '/v2/video/generations' : '/v1/chat/completions' });
  prov.calls.push(Object.assign({ kind }, info));
  return prov.handler(Object.assign({ kind }, info));
}
const fakeProvider = {
  diagnose() {}, isConfigured: () => true, setHooks(h) { prov.hooks = h || {}; }, queueState: () => ({}),
  buildBrandContext: () => '',
  generateText: (sys, user, opts) => provCall('text', { model: opts && opts.model, sys: Array.isArray(sys) ? JSON.stringify(sys) : String(sys || ''), user: String(user || ''), opts }),
  generateTextWithVision: (sys, user, img, opts) => provCall('vision', { model: opts && opts.model, sys, user }),
  generateImage: (prompt, opts) => provCall('image', { model: opts && opts.model, prompt }),
  editImage: (b, m, prompt) => provCall('edit', { prompt }),
  generateVideo: (prompt, opts) => provCall('video', { prompt }),
  generateVideoFromImage: (url, prompt) => provCall('video', { prompt }),
  getVideoStatus: async (id) => ({ status: prov.videoStatus[id] || 'processing', videoUrl: null, failureReason: null }),
};
const RESEARCH_JSON = JSON.stringify({ summary: 'A focused market.', market: { name: 'Coffee subscriptions', characteristics: ['recurring'] }, competitors: [{ id: 'c1', name: 'Brand A', positioning: 'premium' }], customerSignals: [{ id: 's1', type: 'need', text: 'convenience' }], advertisingPatterns: [], trends: [], opportunities: [{ id: 'o1', opportunity: 'Bundles', evidence: 'Common pattern.' }], confidence: 'moderate' });
const PKG_JSON = JSON.stringify({ googleAds: { headlines: ['A', 'B', 'C'], descriptions: ['d'] }, strategy: { angle: 'x' }, visualConcepts: [] });
function defaultHandler(c) {
  if (c.kind === 'text' && c.model === 'perplexity/sonar') return { choices: [{ message: { content: 'grounded answer' } }], search_results: [], citations: [] };
  if (c.kind === 'text' && /research analyst/.test(c.sys)) return full(RESEARCH_JSON);
  if (c.kind === 'text') return full(PKG_JSON);
  if (c.kind === 'image') return ['https://img.test/x.png'];
  if (c.kind === 'video') return { generationId: 'gen-' + prov.calls.length };
  return full('ok');
}
const err = (msg, extra) => Object.assign(new Error(msg), extra || {});

const _load = Module._load;
Module._load = function (req) {
  if (/providers\/aimlProvider$/.test(req)) return fakeProvider;
  if (req === 'stripe') return function StripeMock() { return new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error('stripe disabled in test'); } }) }); };
  if (req === '@supabase/supabase-js') return { createClient: () => supabaseMock };
  if (req === 'dotenv') return { config: () => ({ parsed: {} }) };
  if (req === 'node-cron') return { schedule: () => ({ stop() {} }) };
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async () => { throw new Error('email disabled in test'); }, verify: async () => true }) };
  return _load.apply(this, arguments);
};

// ── Helpers ──
let pass = 0, fail = 0;
const out = console.log.bind(console);
const results = [];
function check(name, ok, info) {
  ok ? pass++ : fail++;
  results.push({ name, ok });
  out((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400)));
}
async function call(method, p, tok, body, headers) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const bal = (id) => rows('profiles').find((p) => p.id === id).credits_balance;
const refundRpcs = () => db.rpcCalls.filter((c) => c.name === 'refund_credits').length;
const spendRpcs = () => db.rpcCalls.filter((c) => c.name === 'spend_credits').length;
const textCalls = (model) => prov.calls.filter((c) => c.kind === 'text' && (!model || c.model === model)).length;
const OPUS = 'claude-opus-4-8';
let paidActions, spendGuard, toolRouter, creditManager;

function reset(balance) {
  for (const k of Object.keys(TABLES)) delete TABLES[k];
  db.rpcCalls.length = 0; db.missing.clear();
  prov.calls.length = 0; prov.handler = defaultHandler; prov.videoStatus = {};
  rows('profiles').push({ id: 'u1', subscription_status: 'starter', credits_balance: balance == null ? 1000 : balance, free_campaign_used_at: null });
  TOKENS.tok1 = { id: 'u1', email: 'u1@example.invalid' };
  paidActions._resetForTests(); spendGuard._resetForTests();
  delete process.env.AI_DAILY_COST_CAP_USD;
}
const key = () => 'test-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
const RS = { question: 'coffee subscription market in Amsterdam' };
const AD = { product: 'Organic coffee subscription', goal: 'Sales', platform: 'google', platforms: ['google'], mode: 'full' };

(async () => {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  toolRouter = require(path.join(SERVER_DIR, 'services/toolRouter.js'));
  creditManager = require(path.join(SERVER_DIR, 'services/creditManager.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);

  // ── Research ─────────────────────────────────────────────────
  say('\nResearch');
  reset();
  let r = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
  check('success: exactly one charge of 25', r.status === 200 && bal('u1') === 975 && spendRpcs() === 1 && refundRpcs() === 0, { status: r.status, bal: bal('u1') });
  check('success: 1 Opus synthesis + 1 web search, nothing else', textCalls(OPUS) === 1 && textCalls('perplexity/sonar') === 1 && prov.calls.length === 2, prov.calls.map((c) => c.model));
  check('success: ledger row carries the action id', rows('credit_transactions').some((t) => t.feature_key === 'ai_analysis' && t.request_id && t.charged), rows('credit_transactions'));

  const failureCases = [
    ['provider out of balance (403 account error)', () => { throw err('Provider access denied. Check your AIML API plan.', { status: 403, providerAccount: true }); }],
    ['invalid JSON from the model', () => full('I cannot produce that as JSON, sorry.')],
    ['provider timeout', () => { throw err('AIML API timed out after 180s', { timeout: true }); }],
    ['provider 500', () => { throw err('AIML API is temporarily unavailable.', { status: 500 }); }],
    ['empty market map (nothing usable)', () => full(JSON.stringify({ summary: 'Too vague.', competitors: [], customerSignals: [], advertisingPatterns: [], trends: [], opportunities: [] }))],
  ];
  for (const [label, synth] of failureCases) {
    reset();
    prov.handler = (c) => (c.model === OPUS ? synth(c) : defaultHandler(c));
    r = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
    check(`failure (${label}): net 0 credits, refunded exactly once, response says so`,
      (label.startsWith('empty') ? r.status === 200 : r.status >= 400) && bal('u1') === 1000 && spendRpcs() === 1 && refundRpcs() === 1 && r.body.creditsRefunded === true &&
      rows('credit_transactions').filter((t) => t.feature_key === 'ai_analysis_refund').length === 1, { status: r.status, bal: bal('u1'), refunds: refundRpcs(), body: r.body });
  }

  reset(10);
  r = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
  check('insufficient credits: 402, zero provider calls, balance untouched', r.status === 402 && prov.calls.length === 0 && bal('u1') === 10, { status: r.status, calls: prov.calls.length });

  reset();
  const k1 = key();
  const r1 = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': k1 });
  const r2 = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': k1 });
  check('same action key sent twice: second refused (409 DUPLICATE_ACTION), one charge, one provider workflow',
    r1.status === 200 && r2.status === 409 && r2.body.code === 'DUPLICATE_ACTION' && bal('u1') === 975 && textCalls(OPUS) === 1, { r2: r2.body, bal: bal('u1'), opus: textCalls(OPUS) });
  const r3 = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
  check('Retry with a NEW key is a new intentional action (charged once more)', r3.status === 200 && bal('u1') === 950 && textCalls(OPUS) === 2);

  // ── Create Ad: the 31-request burst ─────────────────────────
  say('\nCreate Ad');
  for (const mode of ['db', 'memory-only (credit_actions not migrated)']) {
    reset();
    if (mode !== 'db') db.missing.add('credit_actions');
    prov.handler = async (c) => { await sleep(250); return defaultHandler(c); };
    const burst = await Promise.all(Array.from({ length: 31 }, () => call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() })));
    const ok = burst.filter((x) => x.status === 200).length, busy = burst.filter((x) => x.status === 409 && x.body.code === 'ACTION_IN_PROGRESS').length;
    check(`[${mode}] 31 near-simultaneous create-ad requests → 1 runs, 30 refused, 1 provider call, 25 credits`,
      ok === 1 && busy === 30 && textCalls(OPUS) === 1 && bal('u1') === 975 && spendRpcs() === 1, { ok, busy, opus: textCalls(OPUS), bal: bal('u1') });
    const after = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
    check(`[${mode}] lane is released after completion (next intentional build runs)`, after.status === 200 && bal('u1') === 950);
    if (mode === 'db') check('[db] credit_actions rows: 2 succeeded, none left in progress', rows('credit_actions').filter((x) => x.status === 'succeeded').length === 2 && !rows('credit_actions').some((x) => x.status === 'in_progress'), rows('credit_actions').map((x) => x.status));
  }

  reset();
  prov.handler = async (c) => { await sleep(200); return defaultHandler(c); };
  const sameKey = key();
  const dup = await Promise.all([1, 2, 3].map(() => call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': sameKey })));
  check('same key fired 3× concurrently: one workflow, one charge', dup.filter((x) => x.status === 200).length === 1 && textCalls(OPUS) === 1 && bal('u1') === 975, dup.map((x) => x.status));

  reset();
  prov.handler = (c) => full('I don\'t have enough detail to build this campaign as JSON.');
  r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  check('model answered prose instead of JSON (the 6 Oct case): net 0 credits', r.status === 500 && bal('u1') === 1000 && refundRpcs() === 1 && r.body.creditsRefunded === true, { status: r.status, bal: bal('u1') });
  reset();
  prov.handler = () => { throw err('Provider access denied. Check your AIML API plan.', { status: 403, providerAccount: true }); };
  r = await call('POST', '/api/ai/create-ad', 'tok1', AD, { 'X-Idempotency-Key': key() });
  check('provider account error (the 2 Oct case): 503 PROVIDER_UNAVAILABLE, net 0 credits', r.status === 503 && r.body.code === 'PROVIDER_UNAVAILABLE' && bal('u1') === 1000 && refundRpcs() === 1, { status: r.status, body: r.body, bal: bal('u1') });

  // ── Image ────────────────────────────────────────────────────
  say('\nImage');
  reset();
  prov.handler = async (c) => { await sleep(250); return defaultHandler(c); };
  const imgs = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/generate-image', 'tok1', { prompt: 'a cup of coffee', size: '1:1' }, { 'X-Idempotency-Key': key() })));
  const imgOk = imgs.filter((x) => x.status === 200).length;
  check('8 parallel images: 6 run (per-user image capacity), 2 refused, only successful ones charged', imgOk === 6 && imgs.filter((x) => x.status === 409).length === 2 && bal('u1') === 1000 - 6 * 75 && prov.calls.filter((c) => c.kind === 'image').length === 6, { imgOk, bal: bal('u1') });
  reset();
  prov.handler = (c) => { if (c.kind === 'image') throw err('image backend error', { status: 500 }); return c.kind === 'text' ? full('{"headline":"H","body":"B","cta":"Buy"}') : defaultHandler(c); };
  r = await call('POST', '/api/generate-ad', 'tok1', { prompt: 'coffee ad' }, { 'X-Idempotency-Key': key() });
  check('generate-ad: copy ok but image failed → the 75-credit image charge is refunded', bal('u1') === 1000 && refundRpcs() === 1, { status: r.status, bal: bal('u1') });

  // ── Video (async) ────────────────────────────────────────────
  say('\nVideo');
  reset();
  prov.handler = (c) => { if (c.kind === 'video') throw err('submit failed', { status: 500 }); return defaultHandler(c); };
  r = await call('POST', '/api/generate-ugc-video', 'tok1', { script: 'A short energetic ad.' }, { 'X-Idempotency-Key': key() });
  check('video submit fails: net 0 credits', r.status >= 400 && bal('u1') === 1000 && refundRpcs() === 1, { status: r.status, bal: bal('u1') });
  reset();
  r = await call('POST', '/api/generate-ugc-video', 'tok1', { script: 'A short energetic ad.' }, { 'X-Idempotency-Key': key() });
  const vid = r.body.videoId;
  check('video submitted: 200 credits held while rendering', r.status === 200 && bal('u1') === 800 && rows('credit_actions').some((x) => x.status === 'awaiting_async'), { status: r.status, bal: bal('u1') });
  prov.videoStatus[vid] = 'failed';
  const s1 = await call('GET', '/api/ugc-video-status/' + vid, 'tok1');
  const s2 = await call('GET', '/api/ugc-video-status/' + vid, 'tok1');
  check('video job failed: refunded on first status poll, NOT again on the second', bal('u1') === 1000 && refundRpcs() === 1 && s1.body.creditsRefunded === true && s2.body.creditsRefunded === false, { bal: bal('u1'), refunds: refundRpcs() });
  reset();
  r = await call('POST', '/api/generate-ugc-video', 'tok1', { script: 'A short energetic ad.' }, { 'X-Idempotency-Key': key() });
  prov.videoStatus[r.body.videoId] = 'completed';
  await call('GET', '/api/ugc-video-status/' + r.body.videoId, 'tok1');
  check('video job completed: charge kept, action succeeded', bal('u1') === 800 && refundRpcs() === 0 && rows('credit_actions').some((x) => x.status === 'succeeded'));
  reset();
  prov.handler = async (c) => { await sleep(200); return defaultHandler(c); };
  const vids = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/api/generate-ugc-video', 'tok1', { script: 'ad' }, { 'X-Idempotency-Key': key() })));
  check('4 concurrent video submits: 1 job, 1 charge', vids.filter((x) => x.status === 200).length === 1 && prov.calls.filter((c) => c.kind === 'video').length === 1 && bal('u1') === 800);

  // ── Chat / research follow-up ────────────────────────────────
  say('\nChat');
  reset();
  prov.handler = () => { throw err('AIML API is temporarily unavailable.', { status: 502 }); };
  r = await call('POST', '/api/ai/chat', 'tok1', { message: 'hi' }, { 'X-Idempotency-Key': key() });
  check('chat provider failure: net 0 credits', r.status >= 400 && bal('u1') === 1000 && refundRpcs() === 1, { status: r.status, bal: bal('u1') });
  reset();
  prov.handler = () => full('{"tool": "test_noop", "params": {}}');
  const researchCtx = Object.assign({ question: 'coffee' }, JSON.parse(RESEARCH_JSON));
  r = await call('POST', '/api/ai/chat', 'tok1', { message: 'which competitor is cheapest?', mode: 'research-followup', context: { page: 'research', research: researchCtx } }, { 'X-Idempotency-Key': key() });
  const sys = (prov.calls[0] && prov.calls[0].sys) || '';
  check('research follow-up: exactly ONE model call, no tool catalog in the prompt', textCalls(OPUS) === 1 && !/TOOLS AVAILABLE/.test(sys), { calls: textCalls(OPUS) });
  reset();
  toolRouter.register({ name: 'test_noop', description: 'test only', params: '{}', requiresConfirmation: false, resolve: () => ({}), execute: async () => ({ ok: true }), formatSummary: () => 'noop', formatResult: () => 'done' });
  prov.handler = () => full('{"tool": "test_noop", "params": {}}');
  r = await call('POST', '/api/ai/chat', 'tok1', { message: 'do the thing' }, { 'X-Idempotency-Key': key() });
  check('assistant tool loop is capped: at most 5 model calls for one message', textCalls(OPUS) === 5, { calls: textCalls(OPUS) });
  check('…and a loop that never produced an answer is refunded', bal('u1') === 1000 && refundRpcs() === 1, { bal: bal('u1') });

  // ── Cross-cutting ────────────────────────────────────────────
  say('\nCross-cutting');
  reset();
  rows('credit_actions').push({ id: 'stale-1', user_id: 'u1', lane: 'research', idempotency_key: 'old', status: 'in_progress', charged: true, credits_cost: 25, feature_key: 'ai_analysis', created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  rows('profiles')[0].credits_balance = 975; // the crashed request had charged 25
  r = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
  check('lane held by a crashed request (11 min old): expired + its 25 credits refunded once, new research runs', r.status === 200 && bal('u1') === 975 && refundRpcs() === 1 && rows('credit_actions').find((x) => x.id === 'stale-1').status === 'refunded', { bal: bal('u1'), status: r.status });

  reset();
  const resv = await creditManager.reserveCredits({ id: 'u1' }, 'ai_analysis');
  const a = await creditManager.refundCredits(resv), b = await creditManager.refundCredits(resv);
  check('refundCredits is idempotent per charge (second call is a no-op)', a === true && b === false && bal('u1') === 1000 && refundRpcs() === 1);

  reset();
  process.env.AI_DAILY_COST_CAP_USD = '0.0000001';
  spendGuard.recordCall({ userId: 'u1', model: OPUS, usage: { promptTokens: 1000, completionTokens: 1000 }, success: true });
  prov.calls.length = 0;
  r = await call('POST', '/api/research/query', 'tok1', RS, { 'X-Idempotency-Key': key() });
  check('daily spend cap reached: no provider call is made and the charge is refunded', prov.calls.length === 0 && bal('u1') === 1000 && r.status >= 500, { calls: prov.calls.length, bal: bal('u1'), status: r.status });
  delete process.env.AI_DAILY_COST_CAP_USD;

  const COSTS = { ai_chat: 5, ai_analysis: 25, campaign_improvement: 10, audience_generation: 10, product_analysis: 10, competitor_analysis: 15, brand_voice: 20, campaign_generation: 25, website_analysis: 30, image_generation: 75, video_generation: 200, autopilot: 25 };
  check('credit prices unchanged', JSON.stringify(creditManager.FEATURE_COSTS) === JSON.stringify(COSTS), creditManager.FEATURE_COSTS);
  check('plan allowances unchanged (Free 10/day, 1,000 / 2,500 / 4,000)', JSON.stringify(creditManager.PLAN_ALLOWANCES) === JSON.stringify({ free: 10, starter: 1000, creator: 2500, professional: 4000 }));
  check('no outbound network requests were attempted', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.info('CRASH', e); process.exit(2); });
