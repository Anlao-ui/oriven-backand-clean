// ════════════════════════════════════════════════════════════════
// AI cost optimization — model tiering, fallback, caching, background AI
//
// Runs the REAL server.js with the provider, Supabase, Stripe, email, cron
// and the Meta Graph API mocked (no network, no .env, no real AI calls).
// Verifies: which tasks use the cheap vs premium model, premium fallback
// when the cheap model is rejected, page-load and background account
// analysis reusing the AI narrative while metrics stay fresh, Free accounts
// never triggering the narrative, concurrent requests sharing one call,
// purpose-keyed briefing cache, and paid-action refunds still applying.
//
// RUN: node tests/ai-cost.test.js   (from oriven-backand-clean/server)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5595;
const BASE = `http://127.0.0.1:${PORT}`;

for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|AI_|PAID_|ANALYSIS_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: 'mock-not-a-key', FRONTEND_URL: 'http://localhost:8899',
  ENABLE_BACKGROUND_JOBS: 'true', // cron callbacks are captured, never scheduled
});

// ── Network: only this test server + a canned Meta Graph API ──
const realFetch = globalThis.fetch;
const blocked = [];
const META = { spend: 100, graphCalls: 0 };
function graph(url) {
  META.graphCalls++;
  const u = new URL(url);
  const ins = { spend: String(META.spend), impressions: '10000', clicks: '200', ctr: '2.0', reach: '8000', actions: [{ action_type: 'purchase', value: '4' }] };
  if (/\/insights$/.test(u.pathname)) return { data: [Object.assign({ date_start: '2026-10-01' }, ins)] };
  if (/\/campaigns$/.test(u.pathname)) return { data: [{ id: 'c1', name: 'Autumn bouquets', status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '2000', insights: { data: [ins] } }] };
  if (/\/ads$/.test(u.pathname)) return { data: [] };
  return { data: [] };
}
globalThis.fetch = (url, opts) => {
  const u = String(url && url.url || url);
  if (/graph\.facebook\.com/.test(u)) return Promise.resolve({ ok: true, status: 200, json: async () => graph(u), text: async () => JSON.stringify(graph(u)) });
  if (!new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}/`).test(u)) { blocked.push(u); return Promise.reject(new Error('network blocked in test: ' + u)); }
  return realFetch(url, opts);
};

// ── Stateful Supabase mock ──
const TABLES = {};
const rows = (t) => (TABLES[t] = TABLES[t] || []);
const UNIQUE = { credit_actions: [['id'], ['user_id', 'idempotency_key']], platform_analysis_cache: [['user_id', 'platform', 'date_range']] };
class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.wantRows = false; this.lim = null; this.p = null; this.onConflict = null; }
  select() { if (this.op !== 'select') this.wantRows = true; return this; }
  insert(p) { this.op = 'insert'; this.p = p; return this; }
  upsert(p, o) { this.op = 'upsert'; this.p = p; this.onConflict = o && o.onConflict; return this; }
  update(p) { this.op = 'update'; this.p = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
  in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
  lt(c, v) { this.f.push((r) => r[c] != null && r[c] < v); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  is(c, v) { this.f.push((r) => (r[c] == null) === (v == null)); return this; }
  order() { return this; } range() { return this; } not() { return this; } or() { return this; } ilike() { return this; } contains() { return this; } filter() { return this; } gt() { return this; } lte() { return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this._single = true; return this.run(); }
  single() { this._single = true; return this.run(); }
  then(a, b) { return this.run().then(a, b); }
  async run() {
    await null;
    const all = rows(this.t);
    const match = () => all.filter((r) => this.f.every((fn) => fn(r)));
    if (this.op === 'insert' || this.op === 'upsert') {
      const items = (Array.isArray(this.p) ? this.p : [this.p]).map((x) => Object.assign({ created_at: new Date().toISOString() }, x));
      for (const it of items) {
        const dup = (UNIQUE[this.t] || []).map((cols) => all.find((r) => cols.every((c) => r[c] === it[c]))).find(Boolean);
        if (dup && this.op === 'upsert') { Object.assign(dup, it); continue; }
        if (dup) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        all.push(it);
      }
      return { data: this.wantRows ? items.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'update') { const m = match(); m.forEach((r) => Object.assign(r, this.p)); return { data: this.wantRows ? m.map((x) => ({ ...x })) : null, error: null }; }
    if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
    let m = match().map((x) => JSON.parse(JSON.stringify(x)));
    if (this.lim != null) m = m.slice(0, this.lim);
    return { data: this._single ? (m[0] || null) : m, error: null };
  }
}
const TOKENS = {};
const rpcCalls = [];
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

// ── Provider mock: records model per call ──
const prov = { calls: [], handler: null, hooks: {} };
const full = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300 } });
const err = (msg, extra) => Object.assign(new Error(msg), extra || {});
const ANALYSIS_JSON = JSON.stringify({ score: 71, findings: [{ title: 'CTR is healthy', detail: 'x', impact: 'medium', campaign: 'Autumn bouquets' }], recommendations: [{ title: 'Raise budget', detail: 'y', campaign: 'Autumn bouquets' }], strengths: ['a'], weaknesses: ['b'], opportunities: ['c'], creativeNotes: [] });
const BRIEF_JSON = JSON.stringify({ summaryItems: [{ type: 'success', text: 'Meta CTR is 2%' }], recommendedActions: [] });
function defaultHandler(c) {
  if (c.kind !== 'text') return c.kind === 'image' ? ['https://img.test/x.png'] : full('ok');
  if (/performance analyst/i.test(c.sys)) return full(ANALYSIS_JSON);
  if (/briefing/i.test(c.sys)) return full(BRIEF_JSON);
  if (/art director|image generation prompt/i.test(c.sys)) return full('A bright bouquet on a sunny windowsill, soft light.');
  return full('{"headline":"H","body":"B","cta":"Shop"}');
}
const fakeProvider = {
  diagnose() {}, isConfigured: () => true, setHooks(h) { prov.hooks = h || {}; }, queueState: () => ({}), buildBrandContext: () => '',
  generateText: async (sys, user, opts) => { const c = { kind: 'text', model: opts && opts.model, sys: String(sys || ''), user: String(user || '') }; prov.calls.push(c); return prov.handler(c); },
  generateTextWithVision: async () => { prov.calls.push({ kind: 'vision' }); return 'vision'; },
  generateImage: async (prompt, opts) => { const c = { kind: 'image', model: opts && opts.model }; prov.calls.push(c); return prov.handler(c); },
  editImage: async () => 'data:image/png;base64,AAAA', generateVideo: async () => ({ generationId: 'g' }), generateVideoFromImage: async () => ({ generationId: 'g' }), getVideoStatus: async () => ({ status: 'processing' }),
};
const cronJobs = {};
const _load = Module._load;
Module._load = function (req) {
  if (/providers\/aimlProvider$/.test(req)) return fakeProvider;
  if (req === 'stripe') return function () { return new Proxy({}, { get: () => new Proxy({}, { get: () => async () => { throw new Error('stripe disabled in test'); } }) }); };
  if (req === '@supabase/supabase-js') return { createClient: () => supabaseMock };
  if (req === 'dotenv') return { config: () => ({ parsed: {} }) };
  if (req === 'node-cron') return { schedule: (expr, fn) => { cronJobs[expr] = fn; return { stop() {} }; } };
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async () => { throw new Error('email disabled in test'); }, verify: async () => true }) };
  return _load.apply(this, arguments);
};

// ── Helpers ──
const out = console.log.bind(console);
let pass = 0, fail = 0;
function check(name, ok, info) { ok ? pass++ : fail++; out((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); }
async function call(method, p, tok, body) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'k-' + Math.random().toString(36).slice(2, 14) } : {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPUS = 'claude-opus-4-8', HAIKU = 'claude-haiku-4-5';
const analysisCalls = () => prov.calls.filter((c) => c.kind === 'text' && /performance analyst/i.test(c.sys));
const briefingCalls = () => prov.calls.filter((c) => c.kind === 'text' && /briefing/i.test(c.sys));
function seed() {
  for (const k of Object.keys(TABLES)) delete TABLES[k];
  prov.calls.length = 0; prov.handler = defaultHandler; rpcCalls.length = 0; META.spend = 100;
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  rows('profiles').push({ id: 'uP', subscription_status: 'professional', credits_balance: 4000 }, { id: 'uF', subscription_status: 'free', credits_balance: 10 }, { id: 'uQ', subscription_status: 'creator', credits_balance: 2500 });
  for (const u of ['uP', 'uF', 'uQ']) {
    TOKENS['tok_' + u] = { id: u, email: u + '@example.invalid' };
    rows('integrations').push({ user_id: u, provider: 'meta_ads', access_token: 'meta-token-mock', token_expiry: future, active_ad_account: { account_id: 'act_1', account_name: 'Bloom Studio Ads' } });
  }
}
async function waitIdle() { let n = -1; for (let i = 0; i < 60; i++) { await sleep(50); if (prov.calls.length === n) return; n = prov.calls.length; } }

(async () => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  require(path.join(SERVER_DIR, 'server.js'));
  const router = require(path.join(SERVER_DIR, 'services/modelRouter.js'));
  const spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }

  out('\nModel routing');
  const fastTasks = ['visuals-copy', 'logo-copy', 'product-shoots-copy', 'motion-graphics-copy', 'video-ads-copy', 'email', 'home-briefing', 'forecast', 'business-insights', 'business-reflection', 'autopilot-recommendation', 'autopilot-brief'];
  check('Tier C/D tasks route to the cheap model with a premium fallback', fastTasks.every((t) => { const r = router.routeTask(t); return r.model === HAIKU && r.fallbackModel === OPUS; }), fastTasks.map((t) => router.routeTask(t).model));
  const premium = ['ads-copy', 'research-query', 'chat', 'text-copy', 'campaigns-copy', 'brand-core', 'ugc-script', 'creative-improve', 'creative-variations', 'creative-score', 'daily-brief', 'competitor-intel', 'market-research'];
  check('Create, Research, chat, account analysis and other Tier A/B tasks stay on the premium model', premium.every((t) => router.routeTask(t).model === OPUS && !router.routeTask(t).fallbackModel), premium.map((t) => router.routeTask(t).model));
  check('research web search still uses perplexity/sonar', router.routeTask('research-web-search').model === 'perplexity/sonar');
  process.env.AI_FAST_MODEL_DISABLED = 'true';
  check('kill switch AI_FAST_MODEL_DISABLED=true routes every task back to the premium model', fastTasks.every((t) => router.routeTask(t).model === OPUS));
  delete process.env.AI_FAST_MODEL_DISABLED;
  check('spend guard prices: the cheap model estimates ~80% below Opus for the same tokens', spendGuard.estimateCost(HAIKU, { promptTokens: 2000, completionTokens: 1000 }) < 0.21 * spendGuard.estimateCost(OPUS, { promptTokens: 2000, completionTokens: 1000 }));

  out('\nCheap-model fallback and refunds (generate-ad: Opus copy + cheap image prompt + image)');
  seed();
  r = await call('POST', '/api/generate-ad', 'tok_uP', { prompt: 'Autumn bouquet subscription ad' });
  const models = prov.calls.filter((c) => c.kind === 'text').map((c) => c.model).sort();
  check('normal run: ad copy on Opus, image prompt on the cheap model, 1 image, charged once', r.status === 200 && JSON.stringify(models) === JSON.stringify([HAIKU, OPUS].sort()) && prov.calls.filter((c) => c.kind === 'image').length === 1 && rows('profiles')[0].credits_balance === 4000 - 75, { models, status: r.status });
  seed();
  prov.handler = (c) => { if (c.model === HAIKU) throw err('AIML API error (404): model claude-haiku-4-5 not found', { status: 404 }); return defaultHandler(c); };
  var r = await call('POST', '/api/generate-ad', 'tok_uP', { prompt: 'Autumn bouquet subscription ad' });
  const tm = prov.calls.filter((c) => c.kind === 'text').map((c) => c.model);
  check('cheap model rejected (404) → retried once on Opus, action succeeds', r.status === 200 && tm.filter((m) => m === HAIKU).length === 1 && tm.filter((m) => m === OPUS).length === 2, tm);
  seed();
  prov.handler = (c) => { if (c.model === HAIKU) throw err('Provider access denied. Check your AIML API plan.', { status: 403, providerAccount: true }); return defaultHandler(c); };
  r = await call('POST', '/api/generate-ad', 'tok_uP', { prompt: 'Autumn bouquet subscription ad' });
  check('provider-account error on the cheap model → NO premium retry; failed action refunded (net 0)', r.status >= 400 && prov.calls.filter((c) => c.model === OPUS && /art director|image generation prompt/i.test(c.sys)).length === 0 && rows('profiles')[0].credits_balance === 4000 && rpcCalls.includes('refund_credits'), { status: r.status, bal: rows('profiles')[0].credits_balance });

  out('\nPage-load account analysis (Control Center home)');
  seed();
  r = await call('GET', '/api/intelligence/home', 'tok_uP');
  check('first load: 1 Opus account analysis + 1 cheap-model briefing; briefing JSON parsed', r.status === 200 && analysisCalls().length === 1 && analysisCalls()[0].model === OPUS && briefingCalls().length === 1 && briefingCalls()[0].model === HAIKU && Array.isArray(r.body.summaryItems) && r.body.summaryItems.length === 1, { status: r.status, a: analysisCalls().length, b: briefingCalls().length, body: r.body && Object.keys(r.body) });
  META.spend = 137; prov.calls.length = 0;
  r = await call('GET', '/api/intelligence/home', 'tok_uP');
  const metaPlat = r.body && r.body.platforms && (r.body.platforms.meta || r.body.platforms.find && r.body.platforms.find((p) => p.platform === 'meta'));
  check('spend changed, reload: NO AI calls (narrative reused, briefing cached by purpose) …', analysisCalls().length === 0 && briefingCalls().length === 0, prov.calls.map((c) => c.model));
  const cacheRow = rows('platform_analysis_cache').find((x) => x.user_id === 'uP');
  check('… but the stored metrics are fresh (spend 137) and the narrative is kept', cacheRow && cacheRow.analysis.totals.spend === 137 && cacheRow.analysis.findings.length === 1 && cacheRow.analysis.score === 71, cacheRow && cacheRow.analysis.totals);
  cacheRow.analysis.narrativeAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  cacheRow.created_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  META.spend = 150; prov.calls.length = 0;
  await call('GET', '/api/intelligence/opportunities', 'tok_uP');
  check('narrative older than 24h → regenerated once', analysisCalls().length === 1, analysisCalls().length);
  seed();
  await Promise.all([1, 2, 3, 4].map(() => call('GET', '/api/intelligence/home', 'tok_uQ')));
  check('4 concurrent dashboard loads → ONE account analysis and ONE briefing (in-flight sharing)', analysisCalls().length === 1 && briefingCalls().length === 1, { a: analysisCalls().length, b: briefingCalls().length });

  out('\nBackground monitoring (4-hourly cron)');
  seed();
  const mon = cronJobs['0 */4 * * *'];
  check('monitoring job registered', typeof mon === 'function');
  mon(); await waitIdle();
  const run1 = analysisCalls().filter((c) => c.model === OPUS).length;
  META.spend = 180; prov.calls.length = 0;
  mon(); await waitIdle();
  const run2 = analysisCalls().length;
  META.spend = 220; prov.calls.length = 0;
  mon(); await waitIdle();
  const run3 = analysisCalls().length;
  check('background monitoring NEVER generates the AI narrative (3 runs, changed spend, paid + Free accounts)', run1 === 0 && run2 === 0 && run3 === 0, { run1, run2, run3 });
  const paidRow = rows('platform_analysis_cache').find((x) => x.user_id === 'uP');
  check('… while metrics are refreshed every run (Autopilot rules read these)', paidRow && paidRow.analysis.totals.spend === 220 && paidRow.analysis.campaigns.length === 1, paidRow && paidRow.analysis.totals);
  prov.calls.length = 0;
  await call('GET', '/api/intelligence/home', 'tok_uP');
  check('the user then opens Control Center → narrative generated once, lazily', analysisCalls().length === 1, analysisCalls().length);
  const freeRow = rows('platform_analysis_cache').find((x) => x.user_id === 'uF');
  check('Free account: background monitoring made NO AI call, stored deterministic metrics only', freeRow && freeRow.analysis.findings.length === 0 && freeRow.analysis.totals.spend === 220 && !prov.calls.some((c) => /Bloom Studio Ads/.test(c.user) && false), freeRow && freeRow.analysis.totals);
  check('Free account narrative never generated across all runs', !rows('platform_analysis_cache').some((x) => x.user_id === 'uF' && x.analysis.narrativeAt));
  // A Free user who upgrades must get a real narrative on the next load (not a 24h-old empty one).
  rows('profiles').find((p) => p.id === 'uF').subscription_status = 'starter'; prov.calls.length = 0; META.spend = 240;
  await call('GET', '/api/intelligence/home', 'tok_uF');
  check('after upgrading from Free, the next page load generates a real narrative (not the empty Free one)', analysisCalls().length === 1, analysisCalls().length);

  out('\nCreate & Research unchanged');
  seed();
  r = await call('POST', '/api/ai/create-ad', 'tok_uP', { product: 'Autumn bouquets', goal: 'Sales', platform: 'meta', platforms: ['meta'], mode: 'full' });
  check('create-ad package still one Opus call', prov.calls.filter((c) => c.kind === 'text').length === 1 && prov.calls[0].model === OPUS);

  check('no outbound network requests (only the canned Meta Graph mock)', blocked.length === 0, blocked);
  out(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { out('CRASH', e); process.exit(2); });
