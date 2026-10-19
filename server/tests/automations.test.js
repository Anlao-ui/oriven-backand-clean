// ════════════════════════════════════════════════════════════════
// Automations — mocked end-to-end tests (no network, no real accounts,
// no AI, no real credits).
//
// The REAL server.js (routes, engine, scheduler, credit system, email
// sender) runs against an in-memory Supabase and stateful fake Google Ads,
// Meta, TikTok, Pinterest and Resend APIs that record every write. This is
// mock verification of OrivenAI's own logic — it is NOT live verification
// of any ad platform.
//
// RUN: node tests/automations.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5596;
const BASE = `http://127.0.0.1:${PORT}`;

// ── Clean environment: placeholders only ──
for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|AI_DAILY|AI_USER|PAID_/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: 'mock-not-a-key', FRONTEND_URL: 'http://localhost:8899', ORIVEN_TEST_HOOKS: '1', GOOGLE_ADS_DEVELOPER_TOKEN: 'mock-dev-token', EMAIL_MODE: 'live', RESEND_API_KEY: 'mock-resend', EMAIL_FROM: 'OrivenAI <test@example.invalid>', EMAIL_UNSUBSCRIBE_SECRET: 'mock-unsub-secret', PUBLIC_API_URL: 'http://127.0.0.1:5596',
});

// ── Block every outbound request except this test server ──
const realFetch = globalThis.fetch;
const blocked = [];
globalThis.fetch = (url, opts) => {
  const u = String(url && url.url || url);
  // The mocked image provider's CDN (generated images are downloaded once to be
  // stored; storage is disabled below, so the provider URL is kept).
  if (u === 'https://img.test/x.png') return Promise.resolve(new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }));
  if (/googleads\.googleapis\.com|graph\.facebook\.com|business-api\.tiktok\.com|api\.pinterest\.com|api\.resend\.com/.test(u)) return fakeApi(u, opts);
  if (!new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}/`).test(u)) { blocked.push(u); return Promise.reject(new Error('network blocked in test: ' + u)); }
  return realFetch(url, opts);
};

// ── Stateful in-memory Supabase ──
const TABLES = {};
const UNIQUE = {
  automation_executions: [{ cols: ['idempotency_key'] }],
  automation_jobs: [{ cols: ['idempotency_key'] }],
  automation_notifications: [{ cols: ['user_id', 'dedupe_key'] }],
  automation_settings: [{ cols: ['user_id'] }],
  email_sends: [{ cols: ['user_id', 'dedupe_key'] }],
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
  select(c, o) { if (o && o.count) this.countMode = true; if (this.op !== 'select') this.wantRows = true; return this; }
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
      const items = (Array.isArray(this.p) ? this.p : [this.p]).map((x) => Object.assign({ id: require('crypto').randomUUID(), created_at: new Date().toISOString() }, x));
      if (db.failInsert === this.t) return { data: null, error: { code: 'XX000', message: 'insert failed (test)' } };
      for (const it of items) if (this.op === 'insert' && violates(this.t, it)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      items.forEach((it) => all.push(it));
      if (this.wantRows && this._single) return { data: { ...items[0] }, error: null };
      return { data: this.wantRows ? items.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'update') {
      const m = match();
      for (const r of m) { const next = Object.assign({}, r, this.p); if (violates(this.t, next, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } }; }
      m.forEach((r) => Object.assign(r, this.p));
      if (this.wantRows && this._single) return { data: m[0] ? { ...m[0] } : null, error: null };
      return { data: this.wantRows ? m.map((x) => ({ ...x })) : null, error: null };
    }
    if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
    let m = match().map((x) => ({ ...x }));
    if (this.lim != null) m = m.slice(0, this.lim);
    if (this._single) return { data: m[0] || null, error: null };
    return { data: m, error: null, count: this.countMode ? m.length : null };
  }
}
const TOKENS = {};
const supabaseMock = {
  from: (t) => new Q(t),
  rpc: async (name, args) => {
    db.rpcCalls.push({ name, args });
    const p = rows('profiles').find((r) => r.id === (args && args.p_user_id));
    if (name === 'spend_credits' && db.rpcFail) return { data: null, error: { message: 'rpc unavailable (test)' } };
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
  // Only the creative-upload bucket ("Use my own image") stores in this
  // test; generated images keep their provider URL as before.
  storage: { from: (bucket) => bucket === 'manual-campaign-creatives'
    ? { upload: async (p) => { (db.uploads = db.uploads || []).push(p); return { error: null }; }, getPublicUrl: (p) => ({ data: { publicUrl: 'https://storage.example.invalid/' + bucket + '/' + p } }) }
    : { upload: async () => ({ error: { message: 'storage disabled in test' } }), getPublicUrl: () => ({ data: {} }) } },
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
  // A completed AIML job always carries its link (video.url is required in the schema).
  getVideoStatus: async (id) => ({ status: prov.videoStatus[id] || 'processing', videoUrl: prov.videoStatus[id] === 'completed' ? 'https://img.test/' + id + '.mp4' : null, failureReason: null }),
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

const fs = require('fs');
const C = require(path.join(SERVER_DIR, 'services/createCompat.js'));
const say0 = (...a) => console.info(...a);

// ════════════════════════════════════════════════════════════════
// A. The compatibility matrix (pure, no server)
// ════════════════════════════════════════════════════════════════

// ── Stateful fake ad-platform + email APIs (record every write) ──
const FAKE = {};
function fakeReset() {
  FAKE.writes = [];
  FAKE.fail = {};
  FAKE.emails = [];
  FAKE.google = { currency: 'EUR', campaigns: {} };
  FAKE.meta = { currency: 'EUR', campaigns: {}, adsets: {} };
  FAKE.tiktok = { currency: 'USD', campaigns: {}, adgroups: {} };
  FAKE.pinterest = { currency: 'USD', campaigns: {}, adgroups: {} };
}
const J = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } }));
function fakeApi(u, opts) {
  const url = new URL(u);
  const method = (opts && opts.method) || 'GET';
  const raw = opts && opts.body ? String(opts.body) : '';
  if (/api\.resend\.com/.test(u)) { const b = JSON.parse(raw); FAKE.emails.push(b); return J({ id: 'em_' + FAKE.emails.length }); }
  // Google Ads
  if (/googleads/.test(u)) {
    if (FAKE.fail.google) return J({ error: { status: 'UNAUTHENTICATED', message: FAKE.fail.google } }, 401);
    const g = FAKE.google;
    if (/googleAds:search/.test(url.pathname)) {
      const q = JSON.parse(raw).query;
      if (/FROM customer/.test(q)) return J({ results: [{ customer: { currencyCode: g.currency, timeZone: 'Europe/Amsterdam' } }] });
      const row = (c) => ({ campaign: { id: c.id, name: c.name, status: c.status }, campaignBudget: c.budget, metrics: c.metrics });
      const list = Object.values(g.campaigns).filter((c) => c.status !== 'REMOVED');
      if (/segments\.date/.test(q)) return J({ results: list.filter((c) => c.metrics).map(row) });
      const m = /campaign\.id = (\d+)/.exec(q);
      if (m) return J({ results: g.campaigns[m[1]] ? [row(g.campaigns[m[1]])] : [] });
      return J({ results: list.map(row) });
    }
    const m = /\/customers\/\d+\/(campaigns|campaignBudgets):mutate/.exec(url.pathname);
    if (m) {
      const ops = (JSON.parse(raw).operations || []);
      FAKE.writes.push({ platform: 'google', resource: m[1], ops });
      ops.forEach((op) => {
        const up = op.update || {};
        if (m[1] === 'campaigns') { const id = up.resourceName.split('/').pop(); if (g.campaigns[id]) g.campaigns[id].status = up.status; }
        else Object.values(g.campaigns).forEach((c) => { if (c.budget && c.budget.resourceName === up.resourceName) c.budget.amountMicros = up.amountMicros; });
      });
      return J({ results: ops.map(() => ({ resourceName: 'ok' })) });
    }
    return J({ results: [] });
  }
  // Meta
  if (/graph\.facebook/.test(u)) {
    if (FAKE.fail.metaOutage > 0) { FAKE.fail.metaOutage--; return Promise.reject(new Error('ECONNRESET')); }
    if (FAKE.fail.meta) return J({ error: { message: FAKE.fail.meta, code: 190, type: 'OAuthException' } });
    const mt = FAKE.meta;
    const p = url.pathname.replace(/^\/v[\d.]+/, '');
    if (method === 'POST') {
      const b = Object.fromEntries(new URLSearchParams(raw)); delete b.access_token;
      const id = p.slice(1);
      FAKE.writes.push({ platform: 'meta', id, body: b });
      const obj = mt.campaigns[id] || mt.adsets[id];
      if (!obj) return J({ error: { message: 'Object does not exist', code: 100 } });
      Object.assign(obj, b);
      return J({ success: true });
    }
    const camp = (c) => ({ id: c.id, name: c.name, status: c.status, daily_budget: c.daily_budget, lifetime_budget: c.lifetime_budget, account_id: '123' });
    if (p === '/act_123') return J({ currency: mt.currency, timezone_name: 'Europe/Amsterdam' });
    if (p === '/act_123/campaigns') return J({ data: Object.values(mt.campaigns).filter((c) => c.status !== 'DELETED').map(camp) });
    if (p === '/act_123/adsets') return J({ data: Object.values(mt.adsets) });
    if (p === '/act_123/insights') return J({ data: Object.values(mt.campaigns).filter((c) => c.ins).map((c) => Object.assign({ campaign_id: c.id }, c.ins)) });
    let m = /^\/(\d+)\/adsets$/.exec(p);
    if (m) return J({ data: Object.values(mt.adsets).filter((s) => s.campaign_id === m[1]) });
    m = /^\/(\d+)$/.exec(p);
    if (m) return mt.campaigns[m[1]] ? J(camp(mt.campaigns[m[1]])) : J({ error: { message: 'Unsupported get request', code: 100 } });
    return J({ data: [] });
  }
  // TikTok
  if (/tiktok/.test(u)) {
    if (FAKE.fail.tiktok) return J({ code: 40105, message: FAKE.fail.tiktok, data: {} });
    const t = FAKE.tiktok;
    const p = url.pathname.replace(/^\/open_api\/v1\.3/, '');
    if (method === 'POST') {
      const b = JSON.parse(raw);
      FAKE.writes.push({ platform: 'tiktok', path: p, body: b });
      if (p === '/campaign/status/update/') b.campaign_ids.forEach((id) => { if (t.campaigns[id]) t.campaigns[id].operation_status = b.operation_status; });
      if (p === '/campaign/update/' && t.campaigns[b.campaign_id]) t.campaigns[b.campaign_id].budget = b.budget;
      if (p === '/adgroup/budget/update/') b.budget.forEach((x) => { if (t.adgroups[x.adgroup_id]) t.adgroups[x.adgroup_id].budget = x.budget; });
      return J({ code: 0, message: 'OK', data: {} });
    }
    const filt = url.searchParams.get('filtering') ? JSON.parse(url.searchParams.get('filtering')) : null;
    const only = (list, key) => (filt && filt.campaign_ids ? list.filter((x) => filt.campaign_ids.includes(String(x[key]))) : list);
    if (p === '/advertiser/info/') return J({ code: 0, data: { list: [{ currency: t.currency, timezone: 'Etc/GMT' }] } });
    if (p === '/campaign/get/') return J({ code: 0, data: { list: only(Object.values(t.campaigns), 'campaign_id').map((c) => Object.assign({}, c, { m: undefined })), page_info: { total_page: 1 } } });
    if (p === '/adgroup/get/') return J({ code: 0, data: { list: only(Object.values(t.adgroups), 'campaign_id'), page_info: { total_page: 1 } } });
    if (p === '/report/integrated/get/') return J({ code: 0, data: { list: Object.values(t.campaigns).filter((c) => c.m).map((c) => ({ dimensions: { campaign_id: c.campaign_id }, metrics: c.m })), page_info: { total_page: 1 } } });
    return J({ code: 0, data: { list: [] } });
  }
  // Pinterest
  if (/pinterest/.test(u)) {
    if (FAKE.fail.pinterest) return J({ code: 2, message: FAKE.fail.pinterest }, 401);
    const pn = FAKE.pinterest;
    const p = url.pathname.replace(/^\/v5/, '');
    if (method === 'PATCH') {
      const items = JSON.parse(raw);
      FAKE.writes.push({ platform: 'pinterest', path: p, body: items });
      const store = /ad_groups$/.test(p) ? pn.adgroups : pn.campaigns;
      items.forEach((it) => { if (store[it.id]) Object.assign(store[it.id], it); });
      return J({ items: items.map((it) => ({ data: it, exceptions: [] })) });
    }
    if (p === '/ad_accounts/549') return J({ id: '549', currency: pn.currency });
    if (p === '/ad_accounts/549/campaigns') return J({ items: Object.values(pn.campaigns).map((c) => Object.assign({}, c, { m: undefined })), bookmark: null });
    if (p === '/ad_accounts/549/ad_groups') { const ids = url.searchParams.get('campaign_ids'); return J({ items: Object.values(pn.adgroups).filter((g) => !ids || ids.split(',').includes(g.campaign_id)), bookmark: null }); }
    if (p === '/ad_accounts/549/campaigns/analytics') { const ids = (url.searchParams.get('campaign_ids') || '').split(','); return J(Object.values(pn.campaigns).filter((c) => c.m && ids.includes(c.id)).map((c) => Object.assign({ CAMPAIGN_ID: c.id }, c.m))); }
    const m = /^\/ad_accounts\/549\/campaigns\/(\d+)$/.exec(p);
    if (m) return pn.campaigns[m[1]] ? J(Object.assign({}, pn.campaigns[m[1]], { m: undefined })) : J({ code: 404, message: 'not found' }, 404);
    return J({ items: [] });
  }
  return J({});
}
fakeReset();

const AM = require(path.join(SERVER_DIR, 'services/automations/metrics.js'));
const AB = require(path.join(SERVER_DIR, 'services/automations/budget.js'));
const AS = require(path.join(SERVER_DIR, 'services/automations/schedule.js'));
const AE = require(path.join(SERVER_DIR, 'services/automations/engine.js'));
const say = (...a) => console.info(...a);

// Time travel for cooldowns, cumulative limits, schedules and expiry.
const _realNow = Date.now;
let OFFSET = 0;
Date.now = () => _realNow() + OFFSET;
const DAY = 86400e3;

// ════════════════════════════════════════════════════════════════
// A. Pure rules (no server)
// ════════════════════════════════════════════════════════════════
(function pure() {
  say('\nA. Metrics, budget safety, schedules, conflicts (pure)');
  const zero = { status: 'active', metrics: { spend: 100, impressions: 20000, clicks: 400, conversions: 0, conversionValue: null } };
  check('zero conversions → CPA is NOT 0 (insufficient data / no ratio), never matches "CPA < 10"', AM.metricValue(zero, 'cpa', null, 'meta').ok === false && AM.metricValue(zero, 'cpa', { conversions: 0 }, 'meta').reason === 'undefined_ratio');
  check('Meta campaign without a conversion value → ROAS is NO DATA, never 0', AM.metricValue(Object.assign({}, zero, { metrics: Object.assign({}, zero.metrics, { conversions: 5 }) }), 'roas', null, 'meta').reason === 'no_data');
  check('ROAS from a real conversion value: 600 / 120 = 5', AM.metricValue({ metrics: { spend: 120, impressions: 1, clicks: 1, conversions: 10, conversionValue: 600 } }, 'roas', null, 'meta').value === 5);
  check('TikTok has no ROAS in OrivenAI’s report → unavailable', AM.metricValue(zero, 'roas', null, 'tiktok').reason === 'unavailable');
  check('CTR needs 1,000 impressions by default; 0 impressions → no ratio', AM.metricValue({ metrics: { spend: 1, impressions: 500, clicks: 10, conversions: 0 } }, 'ctr').reason === 'insufficient_data' && AM.metricValue({ metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0 } }, 'ctr', { impressions: 0 }).reason === 'undefined_ratio');
  check('missing metrics object → no data', AM.metricValue({ status: 'active', metrics: null }, 'spend').reason === 'no_data');
  check('budget increase without a maximum → refused (no_max_budget)', AB.computeChange({ direction: 'increase', pct: 20, current: 20, currency: 'EUR', limits: {} }).reason === 'no_max_budget');
  let cur = 20; const hist = []; const reasons = [];
  for (let d = 0; d < 6; d++) { const r = AB.computeChange({ direction: 'increase', pct: 20, current: cur, currency: 'EUR', limits: { max_budget: 1000, max_cumulative_pct: 50 }, history: hist, now: 1e12 + d * DAY }); reasons.push(r.ok ? r.next : r.reason); if (r.ok) { hist.push({ at: new Date(1e12 + d * DAY).toISOString(), previous: cur, next: r.next }); cur = r.next; } }
  check('repeated +20% stops at the cumulative +50% cap (20 → 24 → 28.80 → 30, then refused)', JSON.stringify(reasons) === JSON.stringify([24, 28.8, 30, 'cumulative_limit', 'cumulative_limit', 'cumulative_limit']), reasons);
  check('max budget caps an increase (95 → 100, not 114)', AB.computeChange({ direction: 'increase', pct: 20, current: 95, currency: 'EUR', limits: { max_budget: 100 } }).next === 100);
  check('max financial actions per day and minimum hours between changes', AB.computeChange({ direction: 'decrease', pct: 10, current: 50, currency: 'EUR', limits: { max_actions_per_day: 1 }, history: [{ at: new Date(1e12 - 3600e3).toISOString(), previous: 55, next: 50 }], now: 1e12 }).reason === 'daily_action_limit'
    && AB.computeChange({ direction: 'decrease', pct: 10, current: 50, currency: 'EUR', limits: { max_actions_per_day: 5, min_hours_between: 24 }, history: [{ at: new Date(1e12 - 3600e3).toISOString(), previous: 55, next: 50 }], now: 1e12 }).reason === 'too_soon');
  check('per-action % is capped by max_change_pct (asked 40%, limit 20%)', AB.computeChange({ direction: 'decrease', pct: 40, current: 100, currency: 'EUR', limits: { max_change_pct: 20 } }).next === 80);
  check('currency precision: JPY whole units, KWD three decimals, EUR cents', AB.round(1234.56, 'JPY') === 1235 && AB.toMinor(1500, 'JPY') === 1500 && AB.toMinor(1.2345, 'KWD') === 1235 && AB.toMinor(15.5, 'EUR') === 1550);
  check('decrease never goes below the minimum budget', AB.computeChange({ direction: 'decrease', pct: 20, current: 10, currency: 'EUR', limits: { min_budget: 9 } }).next === 9 && AB.computeChange({ direction: 'decrease', pct: 20, current: 9, currency: 'EUR', limits: { min_budget: 9 } }).reason === 'at_min_budget');
  const tz = 'Europe/Amsterdam';
  const gap = AS.zonedToUtc({ y: 2026, m: 3, d: 29, hh: 2, mm: 30 }, tz);
  check('DST spring-forward gap (02:30 doesn’t exist) → runs at 03:30 local, flagged', gap.adjusted === 'gap' && AS.zonedParts(gap.utc, tz).hh === 3 && AS.zonedParts(gap.utc, tz).mm === 30);
  const amb = AS.zonedToUtc({ y: 2026, m: 10, d: 25, hh: 2, mm: 30 }, tz);
  check('DST fall-back (02:30 happens twice) → first occurrence (00:30 UTC)', amb.adjusted === 'ambiguous' && new Date(amb.utc).toISOString() === '2026-10-25T00:30:00.000Z');
  const wk = { key: 'on', action: 'activate', type: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' };
  const fri = AS.nextOccurrence(wk, { timezone: tz, items: [wk] }, Date.UTC(2026, 9, 22, 12));
  const mon = AS.nextOccurrence(wk, { timezone: tz, items: [wk] }, fri.runAt);
  check('weekly 09:00 keeps local time across DST (Fri 07:00Z → Mon 08:00Z), skips the weekend', fri.localKey === '2026-10-23T09:00' && new Date(fri.runAt).toISOString() === '2026-10-23T07:00:00.000Z' && mon.localKey === '2026-10-26T09:00' && new Date(mon.runAt).toISOString() === '2026-10-26T08:00:00.000Z');
  check('schedule validation: past time, bad zone, same-slot clash, weekly "stop" refused', AS.validate({ timezone: tz, items: [{ action: 'pause', type: 'once', at: '2020-01-01T10:00' }] }).code === 'past' && AS.validate({ timezone: 'Mars/Base', items: [] }).code === 'timezone'
    && AS.validate({ timezone: tz, items: [{ key: 'a', action: 'activate', type: 'weekly', days: [1], time: '09:00' }, { key: 'b', action: 'pause', type: 'weekly', days: [1], time: '09:00' }] }).code === 'same_slot' && AS.validate({ timezone: tz, items: [{ action: 'stop', type: 'weekly', days: [1], time: '09:00' }] }).code === 'stop_weekly');
  check('ends_at stops a weekly schedule', AS.nextOccurrence(wk, { timezone: tz, items: [wk], ends_at: '2026-10-24T00:00' }, fri.runAt) === null);
  const leg = AE.normalizeRule({ id: 'l1', user_id: 'u', name: 'Old report', enabled: true, platform: 'meta', trigger_metric: 'spend', trigger_operator: '>', trigger_value: 0, action_type: 'create_report', action_params: { mode: 'fully_automatic' } });
  const legBudget = AE.normalizeRule({ id: 'l2', user_id: 'u', name: 'Old scale', enabled: true, platform: 'meta', trigger_metric: 'roas', trigger_operator: '>', trigger_value: 4, action_type: 'increase_budget', action_params: { mode: 'fully_automatic', percent: 15 } });
  const legNotify = AE.normalizeRule({ id: 'l3', user_id: 'u', name: 'Old alert', enabled: true, platform: 'google', trigger_metric: 'ctr', trigger_operator: '<', trigger_value: 1, action_type: 'pause_campaign', action_params: { mode: 'suggest_only' } });
  check('legacy rules: fake "report" → needs review; budget increase without a max → needs review; "suggest only" → notify', leg.status === 'needs_review' && leg.blocked === 'legacy_action' && legBudget.blocked === 'max_budget_required' && legNotify.mode === 'notify' && !legNotify.blocked);
})();

// ════════════════════════════════════════════════════════════════
// B. The real server
// ════════════════════════════════════════════════════════════════
(async () => {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  creditManager = require(path.join(SERVER_DIR, 'services/creditManager.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const E = () => global.__orivenTestHooks.automations.engine;
  const api = (m, p, body, tok, idem) => call(m, p, tok || 'tok1', body, { 'X-Idempotency-Key': idem || key() });

  function world(balance) {
    OFFSET = 0;
    reset(balance);
    process.env.AUTOMATIONS_KILL_SWITCH = '';
    // Email is on only in section I: the sender paces sends with Date.now(), which the time-travel tests move.
    process.env.EMAIL_MODE = 'off';
    Object.assign(rows('profiles')[0], { subscription_status: 'professional', email: 'u1@example.invalid' });
    rows('profiles').push({ id: 'u2', subscription_status: 'professional', credits_balance: 1000, email: 'u2@example.invalid' });
    TOKENS.tok2 = { id: 'u2', email: 'u2@example.invalid' };
    const fut = new Date(_realNow() + 300 * DAY).toISOString();
    rows('integrations').push(
      { user_id: 'u1', provider: 'google_ads', access_token: 'g', token_expiry: fut, active_ad_account: { account_id: '1112223333' } },
      { user_id: 'u1', provider: 'meta_ads', access_token: 'm', token_expiry: fut, active_ad_account: { account_id: '123' } },
      { user_id: 'u1', provider: 'tiktok_ads', access_token: 't', token_expiry: fut, active_ad_account: { account_id: '777' } },
      { user_id: 'u1', provider: 'pinterest_ads', access_token: 'p', token_expiry: fut, active_ad_account: { account_id: '549' } });
    fakeReset();
    const mt = FAKE.meta;
    mt.campaigns['111'] = { id: '111', name: 'Spring Sale', status: 'ACTIVE', ins: { spend: '150', impressions: '20000', clicks: '400', actions: [], action_values: [] } };
    mt.adsets.s1 = { id: 's1', name: 'Set A', campaign_id: '111', status: 'ACTIVE', daily_budget: '1000' };
    mt.adsets.s2 = { id: 's2', name: 'Set B', campaign_id: '111', status: 'ACTIVE', daily_budget: '1000' };
    mt.campaigns['222'] = { id: '222', name: 'Best Seller', status: 'ACTIVE', daily_budget: '3000', ins: { spend: '120', impressions: '15000', clicks: '300', actions: [{ action_type: 'purchase', value: '10' }], action_values: [{ action_type: 'purchase', value: '600' }] } };
    mt.campaigns['333'] = { id: '333', name: 'Old Promo', status: 'PAUSED', ins: { spend: '0', impressions: '0', clicks: '0', actions: [] } };
    mt.adsets.s3 = { id: 's3', name: 'Set C', campaign_id: '333', status: 'PAUSED', daily_budget: '500' };
    mt.campaigns['444'] = { id: '444', name: 'Archived One', status: 'ARCHIVED', daily_budget: '1000', ins: { spend: '999', impressions: '1', clicks: '1', actions: [] } };
    const g = FAKE.google;
    g.campaigns['9001'] = { id: '9001', name: 'Brand Search', status: 'ENABLED', budget: { resourceName: 'customers/1112223333/campaignBudgets/1', amountMicros: '20000000', explicitlyShared: false, period: 'DAILY', referenceCount: 1 }, metrics: { costMicros: '150000000', impressions: '5000', clicks: '250', conversions: 0, conversionsValue: 0 } };
    g.campaigns['9002'] = { id: '9002', name: 'Generic Search', status: 'ENABLED', budget: { resourceName: 'customers/1112223333/campaignBudgets/2', amountMicros: '50000000', explicitlyShared: true, period: 'DAILY', referenceCount: 3 }, metrics: { costMicros: '200000000', impressions: '9000', clicks: '500', conversions: 10, conversionsValue: 1000 } };
    const tt = FAKE.tiktok;
    tt.campaigns['7001'] = { campaign_id: '7001', campaign_name: 'TT Traffic', operation_status: 'ENABLE', secondary_status: 'CAMPAIGN_STATUS_ENABLE', budget: 0, budget_mode: 'BUDGET_MODE_INFINITE', m: { spend: '130', impressions: '50000', clicks: '900', conversion: '0' } };
    tt.adgroups.g1 = { adgroup_id: 'g1', adgroup_name: 'G1', campaign_id: '7001', budget: 50, budget_mode: 'BUDGET_MODE_DAY', operation_status: 'ENABLE' };
    tt.adgroups.g2 = { adgroup_id: 'g2', adgroup_name: 'G2', campaign_id: '7001', budget: 50, budget_mode: 'BUDGET_MODE_DAY', operation_status: 'ENABLE' };
    FAKE.pinterest.campaigns['8001'] = { id: '8001', name: 'Pin Sale', status: 'ACTIVE', daily_spend_cap: 25000000, m: { SPEND_IN_DOLLAR: 140, TOTAL_IMPRESSION: 30000, TOTAL_CLICKTHROUGH: 300, TOTAL_CONVERSIONS: 6, TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR: 420000000 } };
  }
  const R = (over) => Object.assign({ name: 'Pause big spenders', kind: 'rule', platform: 'meta', scope: { type: 'account' }, condition: { metric: 'spend', operator: '>', value: 100 }, window: 7, action: 'pause_campaign', mode: 'automatic', confirm_automatic: true }, over || {});
  const create = (body, tok, idem) => api('POST', '/api/automations', body, tok, idem);
  const W = (p) => FAKE.writes.filter((w) => w.platform === p);
  const execs = () => rows('automation_executions');
  const notes = () => rows('automation_notifications');
  const runRules = () => E().runRules({ force: true });

  say('\nB. Credits — 50 once per new automation');
  world();
  let r = await create(R({ condition: { metric: 'spend', operator: '>', value: 'lots' } }));
  check('invalid automation → 422 with a clear error, nothing charged', r.status === 422 && bal('u1') === 1000 && !rows('automation_rules').length, r.body);
  const idem = key();
  r = await create(R(), 'tok1', idem);
  check('valid automation → created, 50 credits charged once', r.status === 200 && r.body.charged === 50 && bal('u1') === 950 && rows('automation_rules').length === 1, { s: r.status, b: r.body, bal: bal('u1') });
  const r2 = await create(R(), 'tok1', idem);
  check('same request again (double click / retry, same key) → 409, no second charge, no second automation', r2.status === 409 && bal('u1') === 950 && rows('automation_rules').length === 1, r2.status);
  const id1 = r.body.automation.id;
  r = await api('PATCH', '/api/automations/' + id1, R({ name: 'Renamed', condition: { metric: 'spend', operator: '>', value: 120 } }));
  check('editing is free', r.status === 200 && bal('u1') === 950 && r.body.automation.name === 'Renamed', { s: r.status, b: r.body, bal: bal('u1') });
  await api('POST', '/api/automations/' + id1 + '/pause'); await api('POST', '/api/automations/' + id1 + '/resume');
  check('pausing and resuming are free', bal('u1') === 950 && rows('automation_rules')[0].enabled === true);
  await runRules(); OFFSET = 2 * DAY; await runRules();
  check('background checks and actions are free (two runs, campaigns changed, balance unchanged)', bal('u1') === 950 && W('meta').length >= 1, { bal: bal('u1'), writes: W('meta').length });
  OFFSET = 0;
  r = await api('DELETE', '/api/automations/' + id1);
  check('deleting keeps the charge (no refund) and keeps its history', r.status === 200 && bal('u1') === 950 && rows('automation_rules')[0].deleted_at && execs().length >= 1, { s: r.status, bal: bal('u1'), ex: execs().length, del: rows('automation_rules')[0].deleted_at });
  world(30);
  r = await create(R());
  check('not enough credits → 402, nothing created', r.status === 402 && r.body.code === 'CREDITS_EXHAUSTED' && !rows('automation_rules').length && bal('u1') === 30, r.body);
  world(); db.rpcFail = true;
  r = await create(R());
  db.rpcFail = false;
  check('credit check fails → 503 "nothing created or charged" (fail closed, never fail open)', r.status === 503 && r.body.code === 'CREDIT_CHECK_FAILED' && !rows('automation_rules').length && bal('u1') === 1000, r.body);
  world(); db.failInsert = 'automation_rules';
  r = await create(R());
  db.failInsert = null;
  check('saving fails after the charge → error and the 50 credits are refunded', r.status >= 500 && !rows('automation_rules').length && bal('u1') === 1000, { s: r.status, bal: bal('u1') });
  world();
  rows('automation_rules').push({ id: 'legacy-1', user_id: 'u1', name: 'Old rule', trigger_metric: 'spend', trigger_operator: '>', trigger_value: 100, platform: 'meta', action_type: 'notify', action_params: { mode: 'require_approval' }, enabled: true, created_at: new Date().toISOString() });
  r = await api('GET', '/api/automations');
  check('existing (legacy) automations are listed and keep working without any new charge', r.status === 200 && r.body.automations.length === 1 && r.body.automations[0].legacy === true && bal('u1') === 1000);
  await runRules();
  check('…the legacy notify rule runs for free (notification, no charge)', notes().length >= 1 && bal('u1') === 1000);
  r = await call('POST', '/api/autopilot/rules', 'tok1', { name: 'x' });
  check('old Autopilot create endpoint is retired (410) — no way around the charge/limits', r.status === 410 && r.body.code === 'MOVED_TO_AUTOMATIONS');
  check('credit price table: automation = 50 (no per-execution Autopilot charge left)', creditManager.FEATURE_COSTS.automation === 50 && creditManager.FEATURE_COSTS.autopilot === undefined);

  say('\nC. Rules — missing data, targeting, all matches, no duplicates');
  world();
  await create(R({ name: 'Scale cheap conversions', condition: { metric: 'cpa', operator: '<', value: 10 }, action: 'increase_budget', percent: 20, limits: { max_budget: 100 } }));
  await runRules();
  check('zero-conversion campaign is NOT treated as "CPA 0" → no budget raised', !W('meta').length && !execs().some((e) => e.action === 'increase_budget' && e.status === 'completed'), FAKE.writes);
  const lr = rows('automation_rules')[0].last_result;
  check('…the reason is recorded (insufficient/no data), visible on the automation', lr && lr.skipped && (lr.skipped.insufficient_data || lr.skipped.undefined_ratio), lr);
  world();
  await create(R({ name: 'Pause low ROAS', condition: { metric: 'roas', operator: '<', value: 1 } }));
  await runRules();
  check('Meta ROAS rule: a campaign without conversion value is NOT paused (old bug paused every campaign)', !W('meta').some((w) => w.id === '111'), W('meta'));
  world();
  await create(R({ name: 'Scale winners', condition: { metric: 'roas', operator: '>', value: 3 }, action: 'increase_budget', percent: 10, limits: { max_budget: 60 } }));
  await runRules();
  check('Meta ROAS from real purchase value (5.0) → campaign budget 30 → 33 (campaign-level CBO, 3300 minor)', W('meta').length === 1 && W('meta')[0].id === '222' && W('meta')[0].body.daily_budget === '3300', W('meta'));
  const bx = execs().find((e) => e.action === 'increase_budget');
  check('…activity records the previous and new budget', bx && bx.previous_value && bx.previous_value.amount === 30 && bx.new_value.amount === 33 && bx.status === 'completed', bx);
  world();
  await create(R());
  await runRules();
  const paused = W('meta').filter((w) => w.body.status === 'PAUSED').map((w) => w.id).sort();
  check('"spend > 100 → pause": EVERY matching active campaign is paused (111 and 222), not only the first', JSON.stringify(paused) === JSON.stringify(['111', '222']), W('meta'));
  check('…archived and already-paused campaigns are never touched', !W('meta').some((w) => w.id === '444' || w.id === '333'));
  await runRules();
  check('running again in the same window → no duplicate pause', W('meta').filter((w) => w.body.status === 'PAUSED').length === 2);
  world();
  await create(R({ scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await Promise.all([runRules(), runRules(), runRules()]);
  check('three overlapping runs (like several instances) → exactly one pause (durable idempotency key)', W('meta').filter((w) => w.id === '222').length === 1 && execs().filter((e) => e.status === 'completed').length === 1, W('meta'));
  check('scope "one campaign" never affects others', !W('meta').some((w) => w.id === '111'));
  world();
  r = await create(R({ scope: { type: 'campaigns', campaign_ids: ['999999'] } }));
  check('a campaign id that isn’t in the user’s account → refused at creation (ownership checked live)', r.status === 422 && r.body.code === 'campaign_not_found' && bal('u1') === 1000, r.body);
  r = await create(R({ scope: { type: 'campaigns', campaign_ids: ['444'] } }));
  check('archived campaign → refused', r.status === 422 && r.body.code === 'campaign_archived');

  say('\nD. Budget safety on real budget structures');
  world();
  r = await create(R({ name: 'Up', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'increase_budget', percent: 20, scope: { type: 'campaigns', campaign_ids: ['111'] } }));
  check('automatic budget increase without a maximum → refused at creation (no invented limit)', r.status === 422 && r.body.code === 'max_budget_required', r.body);
  r = await create(R({ name: 'Up', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'increase_budget', percent: 20, scope: { type: 'campaigns', campaign_ids: ['111'] }, limits: { max_budget: 200, max_cumulative_pct: 50 }, confirm_automatic: false }));
  check('automatic financial action without explicit consent → refused', r.status === 422 && r.body.code === 'confirm_automatic');
  r = await create(R({ name: 'Up', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'increase_budget', percent: 20, scope: { type: 'campaigns', campaign_ids: ['111'] }, limits: { max_budget: 200, max_cumulative_pct: 50 } }));
  await runRules();
  const sets = W('meta').filter((w) => w.id === 's1' || w.id === 's2');
  check('Meta ad-set budgets (how Launch publishes): both ad sets scaled 10 → 12 (1000 → 1200 minor), campaign budget untouched', sets.length === 2 && sets.every((w) => w.body.daily_budget === '1200') && !W('meta').some((w) => w.id === '111'), W('meta'));
  for (let d = 1; d <= 5; d++) { OFFSET = d * DAY + 3600e3; await runRules(); }
  const total = Number(FAKE.meta.adsets.s1.daily_budget) + Number(FAKE.meta.adsets.s2.daily_budget);
  check('six days of "+20%" → stops at the +50% cumulative cap (€20 → €30), never compounds past it', total === 3000, { total, writes: W('meta').map((w) => w.id + '=' + w.body.daily_budget) });
  world(); FAKE.meta.currency = 'JPY'; FAKE.meta.campaigns['222'].daily_budget = '3000';
  r = await create(R({ name: 'JPY down', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'decrease_budget', percent: 10, scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  check('JPY account: ¥3000 → ¥2700 written as 2700 (no ×100 for currencies without cents)', W('meta').some((w) => w.id === '222' && w.body.daily_budget === '2700'), W('meta'));
  world();
  await create(R({ platform: 'google', name: 'Google down', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'decrease_budget', percent: 10 }));
  await runRules();
  const gm = W('google').filter((w) => w.resource === 'campaignBudgets');
  check('Google dedicated budget changed (20 → 18 → amountMicros 18000000); SHARED budget left alone', gm.length === 1 && gm[0].ops[0].update.amountMicros === '18000000' && gm[0].ops[0].update.resourceName.endsWith('/1'), gm);
  check('…the shared-budget campaign is reported as skipped with the reason', rows('automation_rules')[0].last_result.skipped.shared_budget === 1, rows('automation_rules')[0].last_result);
  world();
  await create(R({ name: 'A up', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'increase_budget', percent: 10, scope: { type: 'campaigns', campaign_ids: ['222'] }, limits: { max_budget: 100 } }));
  await create(R({ name: 'B down', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'decrease_budget', percent: 10, scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  check('conflicting rules (raise + lower the same campaign) → neither applied, both recorded as skipped "conflict", user notified', !W('meta').length && execs().filter((e) => e.reason === 'conflict').length === 2 && notes().some((n) => n.kind === 'conflict'), execs().map((e) => e.reason));
  world();
  await create(R({ name: 'Pause', scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await create(R({ name: 'Raise', condition: { metric: 'spend', operator: '>', value: 100 }, action: 'increase_budget', percent: 10, scope: { type: 'campaigns', campaign_ids: ['222'] }, limits: { max_budget: 100 } }));
  await runRules();
  check('pause + raise on the same campaign → pause wins, the raise is skipped (superseded)', W('meta').length === 1 && W('meta')[0].body.status === 'PAUSED' && execs().some((e) => e.reason === 'superseded_by_pause'));

  say('\nE. Modes — notify only and require approval');
  world();
  await create(R({ name: 'Tell me', mode: 'notify', action: 'pause_campaign' }));
  await runRules(); await runRules();
  check('notify-only: no campaign change at all, one notification per campaign (deduplicated across runs)', !FAKE.writes.length && notes().filter((n) => n.kind === 'executed').length === 2, notes().map((n) => n.kind));
  check('…mirrored into the in-app notification bell', rows('intelligence_events').some((e) => /Automation "Tell me"/.test(e.title)));
  world();
  await create(R({ name: 'Ask first', mode: 'approval', scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  let ap = rows('automation_approvals')[0];
  check('approval mode: a pending approval, NO change before approval', ap && ap.status === 'pending' && ap.campaign_id === '222' && !FAKE.writes.length);
  r = await api('POST', '/api/automations/approvals/' + ap.id + '/approve', {}, 'tok2');
  check('another user can’t approve it (404), nothing changes', r.status === 404 && !FAKE.writes.length);
  r = await api('POST', '/api/automations/approvals/' + ap.id + '/approve');
  check('approve → the RIGHT campaign (222, from its stored id) is paused once', r.status === 200 && W('meta').length === 1 && W('meta')[0].id === '222' && W('meta')[0].body.status === 'PAUSED', { r: r.body, w: W('meta') });
  r = await api('POST', '/api/automations/approvals/' + ap.id + '/approve');
  check('approving again → 409, no second change', r.status === 409 && W('meta').length === 1);
  world();
  await create(R({ name: 'Ask first', mode: 'approval', scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  ap = rows('automation_approvals')[0];
  r = await api('POST', '/api/automations/approvals/' + ap.id + '/reject');
  const r3 = await api('POST', '/api/automations/approvals/' + ap.id + '/approve');
  check('rejected → never executes, even if approved afterwards', r.status === 200 && r3.status === 409 && !FAKE.writes.length);
  world();
  await create(R({ name: 'Ask first', mode: 'approval', scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  ap = rows('automation_approvals')[0];
  OFFSET = 49 * 3600e3;
  r = await api('POST', '/api/automations/approvals/' + ap.id + '/approve');
  check('expired approval (after 48 h) → 410, nothing changes', r.status === 410 && !FAKE.writes.length && rows('automation_approvals')[0].status === 'expired');
  OFFSET = 0;
  world();
  await create(R({ name: 'Ask first', mode: 'approval', scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  FAKE.meta.campaigns['222'].status = 'PAUSED'; // paused by hand in the meantime
  r = await api('POST', '/api/automations/approvals/' + rows('automation_approvals')[0].id + '/approve');
  check('approval revalidates live state: campaign already paused → skipped, not repeated', r.status === 200 && r.body.status === 'skipped' && r.body.reason === 'already_paused' && !FAKE.writes.length, r.body);
  world();
  await create(R({ name: 'Ask lower', mode: 'approval', action: 'decrease_budget', percent: 10, scope: { type: 'campaigns', campaign_ids: ['222'] } }));
  await runRules();
  FAKE.meta.campaigns['222'].daily_budget = '5000'; // budget changed by hand to 50
  r = await api('POST', '/api/automations/approvals/' + rows('automation_approvals')[0].id + '/approve');
  check('approved budget change is computed from the LIVE budget (50 → 45), not stale data', W('meta').length === 1 && W('meta')[0].body.daily_budget === '4500', W('meta'));
  world();
  await create(R({ name: 'Ask resume', mode: 'approval', action: 'resume_campaign', condition: { metric: 'status', operator: '==', value: 'paused' }, scope: { type: 'campaigns', campaign_ids: ['333'] } }));
  await runRules();
  r = await api('POST', '/api/automations/approvals/' + rows('automation_approvals')[0].id + '/approve');
  check('"Campaign status is paused" condition saves and works (was impossible before) → resume approved', W('meta').length === 1 && W('meta')[0].id === '333' && W('meta')[0].body.status === 'ACTIVE', W('meta'));

  say('\nF. Emergency controls and failures');
  world();
  await create(R());
  await api('POST', '/api/automations/pause-all');
  await runRules();
  check('PAUSE ALL → nothing runs', !FAKE.writes.length);
  await api('POST', '/api/automations/resume-all');
  await runRules();
  check('…resume all → runs again', W('meta').length === 2);
  world();
  await create(R());
  process.env.AUTOMATIONS_KILL_SWITCH = 'true';
  await runRules();
  const ks = await E().runDueJobs();
  check('server kill switch → no rule runs, no scheduled job runs', !FAKE.writes.length && ks.skipped === 'kill_switch');
  process.env.AUTOMATIONS_KILL_SWITCH = '';
  world();
  await create(R());
  FAKE.fail.meta = 'Error validating access token: Session has expired';
  await runRules();
  check('expired Meta token → no change, the rule shows "blocked", user told to reconnect (no silent failure)', !FAKE.writes.length && rows('automation_rules')[0].last_result.status === 'blocked' && notes().some((n) => n.kind === 'credentials_expired'), { lr: rows('automation_rules')[0].last_result, n: notes().map((n) => n.kind) });
  world();
  await create(R());
  TABLES.integrations = TABLES.integrations.filter((i) => i.provider !== 'meta_ads');
  await runRules();
  check('disconnected account → nothing runs, "isn’t connected" notification', !FAKE.writes.length && notes().some((n) => n.kind === 'disconnected'));

  say('\nG. TikTok and Pinterest');
  world();
  r = await create(R({ platform: 'tiktok', condition: { metric: 'roas', operator: '>', value: 2 } }));
  check('TikTok ROAS isn’t offered (not in OrivenAI’s TikTok report) → refused with a reason', r.status === 422 && r.body.code === 'metric_unavailable');
  await create(R({ platform: 'tiktok', name: 'TT pause' }));
  await runRules();
  check('TikTok rules ARE evaluated now: spend 130 > 100 → /campaign/status/update/ DISABLE for 7001', W('tiktok').some((w) => w.path === '/campaign/status/update/' && w.body.operation_status === 'DISABLE' && w.body.campaign_ids[0] === '7001'), W('tiktok'));
  world();
  await create(R({ platform: 'tiktok', name: 'TT up', action: 'increase_budget', percent: 10, limits: { max_budget: 500 } }));
  await runRules();
  const tb = W('tiktok').find((w) => w.path === '/adgroup/budget/update/');
  check('TikTok ad-group budgets (Launch’s structure) scaled together 50 → 55 each', tb && tb.body.budget.length === 2 && tb.body.budget.every((b) => b.budget === 55), W('tiktok'));
  world();
  await create(R({ platform: 'pinterest', name: 'Pin pause' }));
  await runRules();
  check('Pinterest: spend 140 > 100 → PATCH campaigns status PAUSED for 8001', W('pinterest').some((w) => /campaigns$/.test(w.path) && w.body[0].id === '8001' && w.body[0].status === 'PAUSED'), W('pinterest'));
  world();
  await create(R({ platform: 'pinterest', name: 'Pin ROAS', condition: { metric: 'roas', operator: '>', value: 2 }, action: 'decrease_budget', percent: 20 }));
  await runRules();
  check('Pinterest ROAS from checkout value (420/140 = 3) → daily_spend_cap 25 → 20 (20000000 micros)', W('pinterest').some((w) => w.body[0].daily_spend_cap === 20000000), W('pinterest'));

  say('\nH. Scheduler — durable, exact, no duplicates');
  world();
  const tz = 'Europe/Amsterdam';
  const at = new Date(_realNow() + 2 * DAY);
  const p2 = (n) => String(n).padStart(2, '0');
  const parts = AS.zonedParts(at.getTime(), tz);
  const local = `${parts.y}-${p2(parts.m)}-${p2(parts.d)}T10:00`;
  r = await create({ name: 'Pause Friday', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 'p', action: 'pause', type: 'once', at: local }] } });
  const job = rows('automation_jobs')[0];
  const expUtc = AS.zonedToUtc(AS.parseLocal(local), tz).utc;
  check('schedule created (50 credits) and its job stored with the exact UTC time of 10:00 Amsterdam', r.status === 200 && bal('u1') === 950 && job && new Date(job.run_at).getTime() === expUtc && job.local_time === local && job.timezone === tz, { s: r.status, job });
  await E().runDueJobs();
  check('before the time → nothing runs', !FAKE.writes.length && rows('automation_jobs')[0].status === 'scheduled');
  OFFSET = expUtc - _realNow() + 30e3;
  await Promise.all([E().runDueJobs(), E().runDueJobs()]);
  check('at the time (two scheduler instances at once) → paused exactly once', W('meta').filter((w) => w.id === '222').length === 1 && rows('automation_jobs')[0].status === 'completed', { w: W('meta'), j: rows('automation_jobs')[0].status });
  await E().runDueJobs();
  check('…and never again', W('meta').length === 1);
  check('a scheduled run costs nothing', bal('u1') === 950);
  OFFSET = 0;
  world();
  r = await create({ name: 'Late', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 'p', action: 'pause', type: 'once', at: local }] } });
  OFFSET = expUtc - _realNow() + 3 * 3600e3; // backend was down for 3 hours
  await E().runDueJobs();
  check('missed while the backend was down (3 h late) → NOT run late, recorded "missed", user notified', !FAKE.writes.length && rows('automation_jobs')[0].status === 'skipped' && notes().some((n) => n.kind === 'missed'), rows('automation_jobs')[0]);
  OFFSET = 0;
  world();
  await create({ name: 'Crash', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 'p', action: 'pause', type: 'once', at: local }] } });
  OFFSET = expUtc - _realNow() + 20 * 60e3;
  Object.assign(rows('automation_jobs')[0], { status: 'running', locked_by: 'dead-instance', locked_at: new Date(Date.now() - 15 * 60e3).toISOString() });
  await E().runDueJobs();
  check('instance crashed mid-job (restart) → the job is picked up again and completes once', W('meta').length === 1 && rows('automation_jobs')[0].status === 'completed');
  OFFSET = 0;
  world();
  await create({ name: 'Retry', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 'p', action: 'pause', type: 'once', at: local }] } });
  OFFSET = expUtc - _realNow() + 10e3;
  FAKE.fail.metaOutage = 1; // the next Meta request fails at the network level
  await E().runDueJobs();
  const j1 = Object.assign({}, rows('automation_jobs')[0]);
  check('temporary outage → not failed: back to "scheduled" with a retry time, nothing changed yet', j1.status === 'scheduled' && j1.next_attempt_at && !W('meta').length, j1);
  await E().runDueJobs();
  check('…not retried before the backoff', !W('meta').length);
  OFFSET += 3 * 60e3;
  await E().runDueJobs();
  check('…retried after the backoff → paused once, job completed, still no charge', W('meta').length === 1 && rows('automation_jobs')[0].status === 'completed' && bal('u1') === 950, rows('automation_jobs')[0]);
  OFFSET = 0;
  world();
  r = await create({ name: 'Business hours', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 'on', action: 'activate', type: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, { key: 'off', action: 'pause', type: 'weekly', days: [1, 2, 3, 4, 5], time: '18:00' }] } });
  const jobs0 = rows('automation_jobs').slice();
  check('recurring business hours → one upcoming job per item, at the right local times', r.status === 200 && jobs0.length === 2 && jobs0.some((j) => j.local_time.endsWith('T09:00')) && jobs0.some((j) => j.local_time.endsWith('T18:00')), jobs0.map((j) => j.local_time));
  const off = jobs0.find((j) => j.item_key === 'off');
  OFFSET = new Date(off.run_at).getTime() - _realNow() + 5e3;
  await E().runDueJobs();
  const nextOff = rows('automation_jobs').filter((j) => j.item_key === 'off' && j.status === 'scheduled');
  check('after 18:00 ran → paused, and the NEXT weekday 18:00 is planned', W('meta').some((w) => w.id === '222' && w.body.status === 'PAUSED') && nextOff.length === 1 && nextOff[0].local_time > off.local_time, nextOff.map((j) => j.local_time));
  r = await api('POST', '/api/automations/jobs/' + nextOff[0].id + '/cancel');
  check('cancelling one run → cancelled, the one after it is planned', r.status === 200 && rows('automation_jobs').find((j) => j.id === nextOff[0].id).status === 'cancelled' && rows('automation_jobs').filter((j) => j.item_key === 'off' && j.status === 'scheduled').length === 1);
  const sid = r && rows('automation_rules')[0].id;
  await api('POST', '/api/automations/' + sid + '/pause');
  check('pausing the schedule cancels every upcoming run', !rows('automation_jobs').some((j) => j.status === 'scheduled'));
  await api('POST', '/api/automations/' + sid + '/resume');
  check('resuming plans the next runs again', rows('automation_jobs').filter((j) => j.status === 'scheduled').length === 2);
  OFFSET = 0;
  world();
  await create({ name: 'Stop promo', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 's', action: 'stop', type: 'once', at: local }] } });
  OFFSET = expUtc - _realNow() + 10e3;
  await E().runDueJobs();
  check('"stop at a deadline" → campaign paused, schedule marked completed and switched off', W('meta').some((w) => w.id === '222' && w.body.status === 'PAUSED') && rows('automation_rules')[0].status === 'completed' && rows('automation_rules')[0].enabled === false);
  OFFSET = 0;
  world();
  FAKE.meta.campaigns['222'].status = 'PAUSED';
  await create({ name: 'Already', kind: 'schedule', platform: 'meta', scope: { type: 'campaigns', campaign_ids: ['222'] }, schedule: { timezone: tz, items: [{ key: 'p', action: 'pause', type: 'once', at: local }] } });
  OFFSET = expUtc - _realNow() + 10e3;
  await E().runDueJobs();
  check('already in the requested state → recorded as skipped, no API write', !FAKE.writes.length && execs().some((e) => e.status === 'skipped' && e.reason === 'already_paused'));
  OFFSET = 0;

  say('\nI. Notifications and email');
  world(); process.env.EMAIL_MODE = 'live';
  await create(R());
  await runRules();
  check('one grouped email for the run (2 campaigns paused), not one per event', FAKE.emails.length === 1 && /2 automation updates|2 updates/.test(FAKE.emails[0].subject + FAKE.emails[0].text), FAKE.emails.map((e) => e.subject));
  check('…sent to the account owner only', FAKE.emails[0].to[0] === 'u1@example.invalid');
  const es = rows('email_sends').find((e) => e.template === 'automation_update');
  check('…logged as "sent" (accepted by the provider) — never claimed "delivered"', es && es.status === 'sent' && notes().every((n) => n.email_status === 'sent'), { es, n: notes().map((n) => n.email_status) });
  world(); process.env.EMAIL_MODE = 'live';
  await api('PUT', '/api/automations/settings', { notifyEmail: false });
  await create(R());
  await runRules();
  check('email notifications off → in-app only, no email', !FAKE.emails.length && notes().length >= 2);
  world(); process.env.EMAIL_MODE = 'live';
  for (let i = 0; i < 6; i++) rows('email_sends').push({ id: 'x' + i, user_id: 'u1', template: 'automation_update', dedupe_key: 'automation:old' + i, category: 'service', status: 'sent', created_at: new Date().toISOString() });
  await create(R());
  await runRules();
  check('rate limit: 6 emails already this hour → no 7th email, updates stay in-app (rate_limited)', !FAKE.emails.length && notes().every((n) => n.email_status === 'rate_limited'));
  world();
  r = await call('GET', '/api/automations/email/off?u=u1&t=wrong', null);
  check('email "turn off" link with a bad token → refused', r.status === 400);

  say('\nJ. Activity, overview, isolation');
  world();
  r = await create(R({ name: 'Original name' }));
  await runRules();
  await api('PATCH', '/api/automations/' + r.body.automation.id, R({ name: 'New name' }));
  r = await api('GET', '/api/automations/activity');
  check('activity keeps its link after renaming (stable automation id), with campaign, action, old/new value and status', r.status === 200 && r.body.items.length === 2 && r.body.items.every((i) => i.automation_id === rows('automation_rules')[0].id && i.campaign_name && i.action === 'pause_campaign' && i.status === 'completed' && i.previous_value && i.new_value));
  r = await api('GET', '/api/automations/activity?status=failed');
  check('activity filter by status', r.status === 200 && r.body.items.length === 0);
  r = await api('GET', '/api/automations/overview');
  check('overview: real counts (1 active, 2 completed actions), connected accounts, last check time', r.status === 200 && r.body.counts.active === 1 && r.body.counts.completed7d === 2 && r.body.accounts.filter((a) => a.connected).length === 4 && r.body.lastCheckAt, r.body.counts);
  r = await api('GET', '/api/automations', null, 'tok2');
  check('another user sees none of these automations', r.status === 200 && r.body.automations.length === 0);
  r = await api('GET', '/api/automations/' + rows('automation_rules')[0].id, null, 'tok2');
  check('…and can’t open one by id (404)', r.status === 404);
  r = await api('PATCH', '/api/automations/' + rows('automation_rules')[0].id, R(), 'tok2');
  check('…or edit it (404)', r.status === 404);
  r = await call('GET', '/api/automations/overview', null);
  check('no session → 401', r.status === 401);
  rows('profiles')[0].subscription_status = 'free';
  r = await api('GET', '/api/automations');
  check('Free plan → 403 (Automations from Starter, unchanged entitlement)', r.status === 403);
  world();
  rows('profiles')[0].subscription_status = 'starter';
  for (let i = 0; i < 5; i++) await create(R({ name: 'N' + i, mode: 'notify' }));
  r = await create(R({ name: 'sixth', mode: 'notify' }));
  check('Starter: 5 active automations; the 6th is refused BEFORE charging', r.status === 403 && r.body.code === 'PLAN_LIMIT' && bal('u1') === 750, { s: r.status, bal: bal('u1') });
  const leak = JSON.stringify(rows('automation_executions')) + JSON.stringify(rows('automation_notifications'));
  check('no access tokens in activity or notifications', !/tok-meta|"m"|access_token/.test(leak));
  {
    const P = require(path.join(SERVER_DIR, 'services', 'automations', 'platforms.js'));
    const red = P.classifyError(new Error('bad https://graph.facebook.com/x?access_token=EAABsbCS1iHgBAKZCZBZCabcdefghijklmnop&f=1 Bearer ya29.a0AfH6SMBabcdefghijklmnopqrstuvwx'));
    check('platform error text is redacted before it is stored or shown', !/EAABsb|ya29.a0/.test(red.message) && /[redacted]/.test(red.message), red.message);
  }
  check('no AI provider calls anywhere in Automations', prov.calls.length === 0);
  check('no outbound network outside the fake APIs', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.info('CRASH', e); process.exit(2); });
