// ════════════════════════════════════════════════════════════════
// Create 2.0 — compatibility, credit safety and structured-brief tests
//
// A. services/createCompat.js — every platform × campaign type × goal ×
//    format against what the publish code really supports, options shown
//    in Create, credit estimates, advertising language, note conflicts, and
//    a drift check against the frontend copy (oriven-frontend/js/).
// B. services/campaignSpec.js — Launch uses the same rules.
// C/D. The REAL server.js with every external service mocked in memory
//    (same harness as paid-actions.test.js): unsupported combinations are
//    refused before any credit or AI call; the guided brief, ad language
//    and fact rules reach the model; image/video routes refuse creatives the
//    ad can't use. No network, no real users, no paid calls.
//
// RUN: node tests/create-compat.test.js   (from server/)
// ════════════════════════════════════════════════════════════════

const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5598;
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
  // The mocked image provider's CDN (generated images are downloaded once to be
  // stored; storage is disabled below, so the provider URL is kept).
  if (u === 'https://img.test/x.png') return Promise.resolve(new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }));
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
(function matrix() {
  say0('\nA. Compatibility matrix');
  // Independent expectation, written from what the PUBLISH code does
  // (routes/publishRoutes.js + services/campaignSpec.js), not from the module.
  const ALL = ['Sales', 'Leads', 'Traffic', 'Awareness'];
  const EXPECT = {
    'google/SEARCH': { goals: ALL, formats: ['text'] },
    'google/PERFORMANCE_MAX': { goals: ['Sales', 'Leads'], formats: ['image'] },
    'google/DEMAND_GEN': { goals: ALL, formats: ['image'] },
    'meta/STANDARD': { goals: ALL, formats: ['image'] },
    'tiktok/STANDARD': { goals: ['Traffic', 'Awareness'], formats: ['video'] },
    'pinterest/STANDARD': { goals: ALL, formats: ['image', 'video'] },
  };
  let total = 0, right = 0; const wrong = [];
  for (const key of Object.keys(EXPECT)) {
    const [platform, type] = key.split('/');
    for (const goal of ALL) for (const format of ['text', 'image', 'video']) {
      total++;
      const want = EXPECT[key].goals.includes(goal) && EXPECT[key].formats.includes(format);
      const got = C.check({ platform, campaignType: type, goal, format }).ok;
      if (got === want) right++; else wrong.push({ key, goal, format, want, got });
    }
  }
  check(`every platform × type × goal × format (${total} combinations) matches the publishable reality`, right === total, wrong);
  const unsupported = [
    ['TikTok + Sales', { platform: 'tiktok', goal: 'Sales', format: 'video' }, 'tiktok_goal'],
    ['TikTok + Leads', { platform: 'tiktok', goal: 'Leads', format: 'video' }, 'tiktok_goal'],
    ['TikTok + image', { platform: 'tiktok', goal: 'Traffic', format: 'image' }, 'format_unsupported'],
    ['Meta + video', { platform: 'meta', goal: 'Sales', format: 'video' }, 'format_unsupported'],
    ['Google Search + image', { platform: 'google', campaignType: 'SEARCH', goal: 'Sales', format: 'image' }, 'format_unsupported'],
    ['Google + video', { platform: 'google', campaignType: 'DEMAND_GEN', goal: 'Sales', format: 'video' }, 'format_unsupported'],
    ['Performance Max + Traffic', { platform: 'google', campaignType: 'PERFORMANCE_MAX', goal: 'Traffic', format: 'image' }, 'goal_type'],
    ['Meta Engagement objective', { platform: 'meta', goal: 'Traffic', format: 'image', objective: 'Engagement' }, 'objective_unsupported'],
    ['Meta App Promotion objective', { platform: 'meta', goal: 'Traffic', format: 'image', objective: 'App Promotion' }, 'objective_unsupported'],
    ['TikTok Video Views objective', { platform: 'tiktok', goal: 'Awareness', format: 'video', objective: 'Video Views' }, 'objective_unsupported'],
    ['Pinterest Video Completion on an image', { platform: 'pinterest', goal: 'Awareness', format: 'image', objective: 'Video Completion' }, 'objective_combination'],
    ['Pinterest Video Completion with Sales', { platform: 'pinterest', goal: 'Sales', format: 'video', objective: 'Video Completion' }, 'objective_combination'],
    ['unknown Google type (VIDEO)', { platform: 'google', campaignType: 'VIDEO', goal: 'Sales', format: 'video' }, 'type_unknown'],
  ];
  for (const [label, input, code] of unsupported) {
    const r = C.check(input);
    check(`refused: ${label} → ${code}, with a plain reason and an alternative`, !r.ok && r.issues.some((i) => i.code === code && i.message && i.message.length > 20 && typeof i.suggestion === 'string'), r.issues);
  }
  check('allowed: Pinterest Video Completion with video + Awareness', C.check({ platform: 'pinterest', goal: 'Awareness', format: 'video', objective: 'Video Completion' }).ok);
  check('legacy client (no explicit format) on Google Search: "images" read as a text ad, not refused', C.check({ platform: 'google', goal: 'Sales', format: 'image' }, { legacy: true }).format === 'text');
  check('legacy client: TikTok "images" is still refused (would not publish)', !C.check({ platform: 'tiktok', goal: 'Traffic', format: 'image' }, { legacy: true }).ok);

  const fo = (p, g) => C.formatOptions(p, g).filter((o) => o.available).map((o) => o.format + (o.campaignType ? ':' + o.campaignType : '')).join(',');
  check('format options: Google Sales → Text (Search) + Image (Performance Max)', fo('google', 'Sales') === 'text:SEARCH,image:PERFORMANCE_MAX', fo('google', 'Sales'));
  check('format options: Google Traffic → Text (Search) + Image (Demand Gen)', fo('google', 'Traffic') === 'text:SEARCH,image:DEMAND_GEN', fo('google', 'Traffic'));
  check('format options: Meta → Image only (video shown as unavailable with a reason)', fo('meta', 'Sales') === 'image:STANDARD' && C.formatOptions('meta', 'Sales').find((o) => o.format === 'video').reason);
  check('format options: TikTok → Video only', fo('tiktok', 'Traffic') === 'video:STANDARD');
  check('format options: Pinterest → Image + Video', fo('pinterest', 'Sales') === 'image:STANDARD,video:STANDARD');
  const go = C.goalOptions('tiktok');
  check('goal options: TikTok shows Sales/Leads disabled with a reason', go.filter((g) => !g.available).map((g) => g.goal).join() === 'Sales,Leads' && go.every((g) => g.available || g.reason));

  const COSTS = { campaign_generation: 25, image_generation: 75, video_generation: 200 };
  const est = (p, t, f, n) => C.estimateCredits(COSTS, C.assetsFor(p, t, f), n).total;
  check('credits: Google Search text ad = 25 (copy only, never images)', est('google', 'SEARCH', 'text', 1) === 25 && est('google', 'SEARCH', 'text', 4) === 25);
  check('credits: Meta image 1 ad = 100, 2×2 = 25 + 4×75 = 325', est('meta', 'STANDARD', 'image', 1) === 100 && est('meta', 'STANDARD', 'image', 4) === 325);
  check('credits: Performance Max = 25 + 3 asset images = 250 (structure does not apply)', est('google', 'PERFORMANCE_MAX', 'image', 4) === 250);
  check('credits: Demand Gen = 100 (one image)', est('google', 'DEMAND_GEN', 'image', 3) === 100);
  check('credits: TikTok video 1 ad = 225, 2 ads = 425 (one video per ad)', est('tiktok', 'STANDARD', 'video', 1) === 225 && est('tiktok', 'STANDARD', 'video', 2) === 425);
  check('credits: Pinterest video = 225 whatever the structure (one video reused)', est('pinterest', 'STANDARD', 'video', 4) === 225);

  check('language: from the business profile → confirmed', JSON.stringify(C.suggestLanguage({ languages: ['Dutch'] })) === JSON.stringify({ code: 'nl', source: 'profile', confirmed: true }));
  const fromCountry = C.suggestLanguage({ country: 'Netherlands' });
  check('language: from the profile country only → suggested, NOT confirmed', fromCountry.code === 'nl' && fromCountry.source === 'country' && fromCountry.confirmed === false);
  check('language: nothing known → English, marked as a default suggestion', JSON.stringify(C.suggestLanguage({})) === JSON.stringify({ code: 'en', source: 'default', confirmed: false }));
  check('language: interface language is not an input (signature takes only the profile)', C.suggestLanguage.length === 1);

  const nc = C.noteConflicts('Make it a TikTok video for TikTok, budget €50 per day, only show in Germany', { platform: 'meta' });
  check('notes that try to change platform, budget and targeting are spotted (never edited)', ['platform', 'budget', 'targeting'].every((k) => nc.some((x) => x.kind === k)), nc);
  check('normal creative notes raise nothing', C.noteConflicts('Highlight the free engraving and use a premium, minimalist style.', { platform: 'meta' }).length === 0);

  // Drift guard: the frontend copy must be byte-identical.
  const FRONT = path.resolve(SERVER_DIR, '..', '..', 'oriven-frontend', 'js', 'createCompat.js');
  if (fs.existsSync(FRONT)) {
    const a = fs.readFileSync(path.join(SERVER_DIR, 'services/createCompat.js'), 'utf8'), b = fs.readFileSync(FRONT, 'utf8');
    check('frontend js/createCompat.js is identical to the backend schema (no drift), version ' + C.VERSION, a === b);
  } else say0('  (frontend repo not next to the backend — drift check skipped)');
})();

// ════════════════════════════════════════════════════════════════
// B. The Launch spec uses the same rules
// ════════════════════════════════════════════════════════════════
(function spec() {
  say0('\nB. Launch spec');
  const S = require(path.join(SERVER_DIR, 'services/campaignSpec.js'));
  check('spec SUPPORT is derived from the shared schema (TikTok goals, Google types, Meta video)', JSON.stringify(S.SUPPORT.tiktok.goals) === JSON.stringify(C.typeInfo('tiktok').goals) && JSON.stringify(S.SUPPORT.google.types) === JSON.stringify(C.typeKeys('google')) && S.SUPPORT.meta.video === false);
  const base = { campaignName: 'Wallets', strategy: { goal: 'Traffic', landingPageUrl: 'https://shop.example' }, concepts: [{ angle: 'A', adCopy: { headline: 'Hand made', primaryText: 'Leather wallets' } }], visualConcepts: [{ conceptRef: 'A', generatedImageUrl: 'https://img.example/a.png' }] };
  const ctx = { profile: { country: 'NL', company_name: 'Leather Co', logo_url: 'https://img.example/logo.png' }, options: { pixels: [{ id: 'p1' }], pageId: 'pg', conversionActions: 1, identityId: 'i1', conversionTags: [{ id: 't1' }] } };
  const codes = (pkg, p) => S.validate(S.buildSpec(pkg, p, ctx), ctx).map((i) => i.level + ':' + i.code);
  const metaEng = Object.assign({}, base, { metaAds: { primaryText: 'x', budget: 10, objective: 'Engagement' } });
  const sp = S.buildSpec(metaEng, 'meta', ctx);
  check('old Meta package with "Engagement": published with the Traffic objective, and the review warns', sp.campaign.objective === 'OUTCOME_TRAFFIC' && codes(metaEng, 'meta').includes('warning:objective_unsupported'));
  const pmaxTraffic = Object.assign({}, base, { googleAds: { campaignType: 'PERFORMANCE_MAX', headlines: ['a', 'b', 'c'], descriptions: ['short one', 'another'] }, strategy: Object.assign({}, base.strategy, { budgetRecommendation: { amount: 10 } }) });
  check('Performance Max + Traffic is blocked at Launch by the shared rule', codes(pmaxTraffic, 'google').includes('error:compat_goal_type'));
  const pinVcImage = Object.assign({}, base, { pinterestAds: { title: 'T', objective: 'Video Completion', budget: 5 } });
  check('Pinterest Video Completion on an image Pin is blocked at Launch', codes(pinVcImage, 'pinterest').includes('error:compat_objective_combination'));
  const metaOk = Object.assign({}, base, { metaAds: { primaryText: 'x', budget: 10 } });
  check('a normal Meta image campaign gets no compatibility errors', !codes(metaOk, 'meta').some((c) => /compat_/.test(c)));
  // "Use my own image" + 2 ad sets × 3 ads, exactly as Create hands it over.
  const OWN = 'https://storage.example.invalid/manual-campaign-creatives/u1/own.png';
  const metaOwn = Object.assign({}, base, { metaAds: { primaryText: 'x', budget: 10 }, metaStructure: { adSets: 2, adsPerAdSet: 3 }, visualConcepts: [{ conceptRef: 'A', generatedImageUrl: OWN }], inputs: { imageSource: 'own', format: 'image' } });
  const spOwn = S.buildSpec(metaOwn, 'meta', ctx);
  check('Launch spec: own image + 2 × 3 → 2 ad sets with 3 ads each, every ad uses the uploaded image', spOwn.adGroups.length === 2 && spOwn.adGroups.every((g) => g.ads.length === 3 && g.ads.every((a) => a.imageUrl === OWN)) && spOwn.creative.imageUrl === OWN, spOwn.adGroups.map((g) => g.ads.map((a) => a.imageUrl)));
  check('…and the review raises no image or compatibility error', !codes(metaOwn, 'meta').some((c) => /^error:(image_missing|compat_)/.test(c)), codes(metaOwn, 'meta'));
})();

// ════════════════════════════════════════════════════════════════
// C. The real server: refuse before charging, structured brief, language
// ════════════════════════════════════════════════════════════════
(async () => {
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  creditManager = require(path.join(SERVER_DIR, 'services/creditManager.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);
  const H = { 'X-Idempotency-Key': '' };
  const post = (p, body) => call('POST', p, 'tok1', body, { 'X-Idempotency-Key': key() });

  say('\nC. /api/ai/create-ad — validated before any credit or AI call');
  const BAD = [
    ['TikTok + Sales', { platform: 'tiktok', goal: 'Sales', format: 'video' }],
    ['TikTok + image', { platform: 'tiktok', goal: 'Traffic', format: 'image' }],
    ['TikTok + image (old client: creativeMode only)', { platform: 'tiktok', goal: 'Traffic', creativeMode: 'images' }],
    ['Meta + video', { platform: 'meta', goal: 'Sales', format: 'video' }],
    ['Meta + video (old client)', { platform: 'meta', goal: 'Sales', creativeMode: 'videos' }],
    ['Google Search + image (new client)', { platform: 'google', campaignType: 'SEARCH', goal: 'Sales', format: 'image' }],
    ['Performance Max + Awareness', { platform: 'google', campaignType: 'PERFORMANCE_MAX', goal: 'Awareness', format: 'image' }],
    ['Meta App Promotion objective', { platform: 'meta', goal: 'Traffic', format: 'image', platformObjective: 'App Promotion' }],
    ['TikTok Video Views objective', { platform: 'tiktok', goal: 'Awareness', format: 'video', platformObjective: 'Video Views' }],
  ];
  for (const [label, extra] of BAD) {
    reset();
    const r = await post('/api/ai/create-ad', Object.assign({ product: 'Leather wallet', mode: 'full' }, extra));
    check(`${label}: 422 UNSUPPORTED_COMBINATION, 0 AI calls, 0 credits charged, explanation + alternative`,
      r.status === 422 && r.body.code === 'UNSUPPORTED_COMBINATION' && prov.calls.length === 0 && spendRpcs() === 0 && bal('u1') === 1000 && r.body.error && r.body.suggestion, { status: r.status, body: r.body, calls: prov.calls.length, bal: bal('u1') });
  }
  reset(0);
  let r = await post('/api/ai/create-ad', { product: 'Leather wallet', mode: 'full', platform: 'tiktok', goal: 'Sales', format: 'video' });
  check('unsupported combination is answered before the balance check (422 even at 0 credits, not 402)', r.status === 422, r.status);

  reset();
  r = await post('/api/ai/create-ad', { product: 'Organic coffee subscription', goal: 'Sales', platform: 'google', platforms: ['google'], mode: 'full', creativeMode: 'images' });
  check('old Create (Google, creativeMode images, no format) still works: 200, one charge of 25', r.status === 200 && bal('u1') === 975 && spendRpcs() === 1, { status: r.status, bal: bal('u1') });

  reset();
  let sysPrompt = '';
  prov.handler = (c) => { if (c.kind === 'text') { sysPrompt = c.sys; } return defaultHandler(c); };
  const brief = { productName: 'Leren portemonnee', description: 'Handgemaakte leren portemonnees uit ons atelier in Amsterdam, met gratis naamgravure.', website: 'leathershop.example/wallets', offer: '', audience: 'Mannen 25-45 die van cadeaus houden', language: 'nl', languageSource: 'profile', tone: 'Premium', styles: ['Minimalist', 'Premium look'], notes: 'Highlight the free engraving. Also run this on TikTok with a €50/day budget.' };
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', brief });
  const pkg = r.body && r.body.data;
  check('guided brief (no free-text product) is accepted: 200, one charge of 25', r.status === 200 && bal('u1') === 975 && spendRpcs() === 1, { status: r.status, bal: bal('u1') });
  check('AD LANGUAGE: the model is told to write all copy in Dutch', /AD LANGUAGE: Write ALL customer-facing ad copy in Dutch/.test(sysPrompt));
  check('AD BRIEF carries the structured fields, priority stated', /AD BRIEF \(structured settings/.test(sysPrompt) && /Product or service: Leren portemonnee/.test(sysPrompt) && /Who the ad is for: Mannen 25-45/.test(sysPrompt) && /Tone of voice: Premium/.test(sysPrompt) && /Creative direction: Minimalist, Premium look/.test(sysPrompt));
  check('no price and no offer given → the model is told not to mention any price or promotion', /Product price: none given — do not mention any price/.test(sysPrompt) && /Special offer: none given — do not mention any discount, sale or promotion/.test(sysPrompt));
  check('FACTS rule: no invented discounts, free shipping, guarantees, reviews or performance claims', /FACTS — NON-NEGOTIABLE/.test(sysPrompt) && /free shipping/.test(sysPrompt) && /guarantees/.test(sysPrompt) && /testimonials/.test(sysPrompt) && /performance claims/.test(sysPrompt));
  check('old callout examples that invited invented claims are gone', !/"Free shipping", "24\/7 support"/.test(sysPrompt));
  check('notes are lower-priority DATA that can never change platform, budget or targeting', /ADDITIONAL NOTES FROM THE USER \(lower-priority/.test(sysPrompt) && /NEVER change the platform, campaign type, objective, ad format, budget, countries\/targeting, ad language/.test(sysPrompt) && /Highlight the free engraving/.test(sysPrompt));
  check('the platform was NOT switched by the note ("run this on TikTok")', pkg && pkg.platform === 'meta');
  check('pkg.inputs records format, language (+ source) and the brief', pkg && pkg.inputs && pkg.inputs.format === 'image' && pkg.inputs.language === 'nl' && pkg.inputs.languageSource === 'profile' && pkg.inputs.brief.productName === 'Leren portemonnee' && pkg.inputs.compatVersion === C.VERSION, pkg && pkg.inputs);
  check('the website from Create becomes the landing page (normalised to https://), so Launch doesn’t ask again', pkg && pkg.strategy && pkg.strategy.landingPageUrl === 'https://leathershop.example/wallets', pkg && pkg.strategy);

  reset();
  sysPrompt = '';
  prov.handler = (c) => { if (c.kind === 'text') sysPrompt = c.sys; return defaultHandler(c); };
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'pinterest', goal: 'Awareness', format: 'video', brief: { productName: 'Linen dress', description: 'Summer linen dress', offer: '€59', language: 'en' } });
  check('Pinterest video: pkg.pinterestAds.creativeType = video (Launch publishes a video Pin)', r.status === 200 && r.body.data.pinterestAds && r.body.data.pinterestAds.creativeType === 'video');
  check('an older draft’s combined "price or offer" text is passed as the ONLY offer the model may use', /Special offer \(confirmed by the user — the ONLY offer\/promotion you may mention\): €59/.test(sysPrompt));

  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'google', campaignType: 'SEARCH', goal: 'Leads', format: 'text', brief: { productName: 'Bookkeeping', description: 'Bookkeeping for freelancers' } });
  check('Google Search text ad: 200, 25 credits, campaign type Search on the package', r.status === 200 && bal('u1') === 975 && r.body.data.googleAds && r.body.data.googleAds.campaignType === 'SEARCH' && r.body.data.creativeFormat === 'text', { status: r.status, bal: bal('u1') });

  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image' });
  check('no product and no brief → 400, nothing charged', r.status === 400 && spendRpcs() === 0 && prov.calls.length === 0);

  reset(10);
  r = await post('/api/ai/create-ad', { product: 'Wallet', mode: 'full', platform: 'meta', goal: 'Sales', format: 'image' });
  check('valid combination but not enough credits → 402, 0 AI calls, balance untouched', r.status === 402 && prov.calls.length === 0 && bal('u1') === 10, { status: r.status });

  reset();
  prov.handler = () => { throw err('AIML API timed out after 180s', { timeout: true }); };
  r = await post('/api/ai/create-ad', { product: 'Wallet', mode: 'full', platform: 'meta', goal: 'Sales', format: 'image' });
  check('AI timeout → 503, the 25 credits are refunded (net 0)', r.status === 503 && bal('u1') === 1000 && refundRpcs() === 1, { status: r.status, bal: bal('u1') });

  reset();
  prov.handler = async (c) => { await sleep(200); return defaultHandler(c); };
  const same = key();
  const dup = await Promise.all([1, 2].map(() => call('POST', '/api/ai/create-ad', 'tok1', { product: 'Wallet', mode: 'full', platform: 'meta', goal: 'Sales', format: 'image' }, { 'X-Idempotency-Key': same })));
  check('retry with the same action key (double click) → one generation, one charge', dup.filter((x) => x.status === 200).length === 1 && bal('u1') === 975 && textCalls() === 1, dup.map((x) => x.status));
  reset();
  prov.handler = async (c) => { await sleep(200); return defaultHandler(c); };
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => post('/api/ai/create-ad', { product: 'Wallet', mode: 'full', platform: 'meta', goal: 'Sales', format: 'image' })));
  check('5 concurrent creates (different keys) → 1 runs, 4 refused, 1 charge', burst.filter((x) => x.status === 200).length === 1 && bal('u1') === 975 && spendRpcs() === 1, burst.map((x) => x.status));

  say('\nD. Image / video routes refuse creatives the ad cannot use');
  reset();
  r = await post('/api/generate-image', { prompt: 'wallet', size: '1:1', adContext: { platform: 'google', campaignType: 'SEARCH' } });
  check('image for a Google Search ad → 422 IMAGE_NOT_NEEDED, 0 credits, 0 image calls', r.status === 422 && r.body.code === 'IMAGE_NOT_NEEDED' && spendRpcs() === 0 && prov.calls.length === 0, { status: r.status, body: r.body });
  reset();
  r = await post('/api/generate-image', { prompt: 'wallet', size: '1:1', adContext: { platform: 'meta' } });
  check('image for a Meta ad → generated, 75 credits', r.status === 200 && bal('u1') === 925, { status: r.status, bal: bal('u1') });
  reset();
  r = await post('/api/generate-image', { prompt: 'wallet', size: '1200x628', adContext: { platform: 'google', campaignType: 'PERFORMANCE_MAX' } });
  check('image for a Performance Max asset → generated, 75 credits', r.status === 200 && bal('u1') === 925);
  reset();
  r = await post('/api/generate-image', { prompt: 'wallet', size: '1:1' });
  check('image without adContext (other features, old clients) → unchanged behaviour', r.status === 200 && bal('u1') === 925);
  reset();
  r = await post('/api/generate-ugc-video', { script: 'A short ad', adContext: { platform: 'meta' } });
  check('video for a Meta ad → 422 VIDEO_NOT_SUPPORTED, 0 credits, 0 video calls', r.status === 422 && r.body.code === 'VIDEO_NOT_SUPPORTED' && spendRpcs() === 0 && prov.calls.length === 0, { status: r.status, body: r.body });
  reset();
  r = await post('/api/generate-ugc-video', { script: 'A short ad', adContext: { platform: 'google' } });
  check('video for a Google ad → 422, 0 credits', r.status === 422 && spendRpcs() === 0);
  reset();
  r = await post('/api/generate-ugc-video', { script: 'A short ad', adContext: { platform: 'tiktok' } });
  check('video for a TikTok ad → submitted, 200 credits held', r.status === 200 && bal('u1') === 800);

  say('\nE. Price, ad quantity, own images and the credit estimate');
  const sharp = require('sharp');
  const png = async (w, h) => 'data:image/png;base64,' + (await sharp({ create: { width: w, height: h, channels: 3, background: '#887766' } }).png().toBuffer()).toString('base64');
  const gif = 'data:image/gif;base64,' + (await sharp({ create: { width: 800, height: 800, channels: 3, background: '#887766' } }).gif().toBuffer()).toString('base64');
  const B = (extra) => Object.assign({ productName: 'Wallet', description: 'Leather wallet', language: 'en' }, extra);

  reset(); sysPrompt = '';
  prov.handler = (c) => { if (c.kind === 'text') sysPrompt = c.sys; return defaultHandler(c); };
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', brief: B({ price: 29.99, currency: 'EUR', offer: 'Free shipping this weekend' }) });
  check('price 29.99 EUR: the model gets the exact price and the separate special offer', r.status === 200 && /Product price \(confirmed by the user — the ONLY price you may mention[^)]*\): 29\.99 EUR/.test(sysPrompt) && /Special offer \(confirmed[^)]*\): Free shipping this weekend/.test(sysPrompt));
  check('pkg.inputs.brief keeps price and currency for Launch / reopening', r.body.data.inputs.brief.price === 29.99 && r.body.data.inputs.brief.currency === 'EUR', r.body.data.inputs.brief);
  reset(); sysPrompt = '';
  prov.handler = (c) => { if (c.kind === 'text') sysPrompt = c.sys; return defaultHandler(c); };
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', brief: B({ price: '0', currency: 'USD' }) });
  check('price 0 is a real price ("free"), not "no price"', r.status === 200 && /0 USD \(the product is free\)/.test(sysPrompt));
  reset(); sysPrompt = '';
  prov.handler = (c) => { if (c.kind === 'text') sysPrompt = c.sys; return defaultHandler(c); };
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', brief: B({ price: '', currency: 'EUR' }) });
  check('empty price → no price (never treated as 0)', r.status === 200 && /Product price: none given/.test(sysPrompt) && r.body.data.inputs.brief.price === null);
  for (const [label, price, cur] of [['negative price', '-5', 'EUR'], ['letters in the price', '12abc', 'EUR'], ['three decimals', '1.999', 'EUR'], ['price without a currency', '10', null], ['decimals for JPY', '10.5', 'JPY']]) {
    reset();
    r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', brief: B({ price, currency: cur }) });
    check(`${label} → 422 PRICE_INVALID, 0 AI calls, 0 credits`, r.status === 422 && r.body.code === 'PRICE_INVALID' && prov.calls.length === 0 && spendRpcs() === 0, { status: r.status, body: r.body });
  }

  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', metaStructure: { adSets: 2, adsPerAdSet: 3 }, brief: B() });
  let inp = r.body && r.body.data && r.body.data.inputs;
  check('Meta 2 ad sets × 3 ads: 200, package keeps the structure Launch publishes (metaStructure 2×3)', r.status === 200 && r.body.data.metaStructure.adSets === 2 && r.body.data.metaStructure.adsPerAdSet === 3, r.body.data && r.body.data.metaStructure);
  check('…pkg.inputs.structure = ad sets, 6 ads; server estimate = 25 + 6 × 75 = 475 (same rule as Review)', inp && inp.structure.unit === 'adSet' && inp.structure.ads === 6 && inp.creditEstimate.total === 475 && inp.creditEstimate.images === 6 && inp.imageSource === 'ai', inp);
  check('…only the 25-credit ad text is charged here (images are charged by their own route)', bal('u1') === 975 && spendRpcs() === 1);
  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'meta', goal: 'Sales', format: 'image', metaStructure: { adSets: 2, adsPerAdSet: 3 }, brief: B({ imageSource: 'own' }) });
  inp = r.body && r.body.data && r.body.data.inputs;
  check('Meta 2×3 with "Use my own image": estimate 25 (6 own image slots, 0 image credits), imageSource own', r.status === 200 && inp.imageSource === 'own' && inp.creditEstimate.total === 25 && inp.creditEstimate.images === 0 && inp.creditEstimate.ownImageSlots === 6, inp && inp.creditEstimate);
  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'google', campaignType: 'SEARCH', goal: 'Sales', format: 'text', campaignStructure: { groups: 2, adsPerGroup: 2 }, brief: B() });
  check('Google Search 2×2: estimate 25 (text only), structure ad groups, 4 ads', r.status === 200 && r.body.data.inputs.creditEstimate.total === 25 && r.body.data.inputs.structure.ads === 4 && r.body.data.inputs.structure.unit === 'adGroup' && r.body.data.inputs.imageSource === null, r.body.data && r.body.data.inputs);
  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'tiktok', goal: 'Traffic', format: 'video', campaignStructure: { groups: 1, adsPerGroup: 2 }, brief: B() });
  check('TikTok 1×2 video: estimate 25 + 2 × 200 = 425', r.status === 200 && r.body.data.inputs.creditEstimate.total === 425, r.body.data && r.body.data.inputs);
  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'pinterest', goal: 'Awareness', format: 'video', campaignStructure: { groups: 2, adsPerGroup: 2 }, brief: B() });
  check('Pinterest 2×2 video: one shared video → estimate 25 + 200 = 225', r.status === 200 && r.body.data.inputs.creditEstimate.total === 225, r.body.data && r.body.data.inputs);
  reset();
  r = await post('/api/ai/create-ad', { mode: 'full', platform: 'google', campaignType: 'PERFORMANCE_MAX', goal: 'Sales', format: 'image', brief: B() });
  check('Performance Max: 1 asset group, estimate 25 + 3 × 75 = 250', r.status === 200 && r.body.data.inputs.structure.unit === 'assetGroup' && r.body.data.inputs.structure.ads === 1 && r.body.data.inputs.creditEstimate.total === 250, r.body.data && r.body.data.inputs);
  for (const [label, body, code] of [
    ['6 ad sets (limit 5)', { platform: 'meta', goal: 'Sales', format: 'image', metaStructure: { adSets: 6, adsPerAdSet: 1 } }, 'structure_range'],
    ['0 ads per ad group', { platform: 'tiktok', goal: 'Traffic', format: 'video', campaignStructure: { groups: 1, adsPerGroup: 0 } }, 'structure_range'],
    ['2.5 ad groups', { platform: 'pinterest', goal: 'Sales', format: 'image', campaignStructure: { groups: 2.5, adsPerGroup: 1 } }, 'structure_range'],
    ['Performance Max with 2 ad groups', { platform: 'google', campaignType: 'PERFORMANCE_MAX', goal: 'Sales', format: 'image', campaignStructure: { groups: 2, adsPerGroup: 1 } }, 'structure_fixed'],
    ['unknown image source', { platform: 'meta', goal: 'Sales', format: 'image', brief: B({ imageSource: 'stock' }) }, 'image_source'],
  ]) {
    reset();
    r = await post('/api/ai/create-ad', Object.assign({ mode: 'full', brief: B() }, body));
    const codes = (r.body && r.body.issues || []).map((i) => i.code);
    check(`${label} → refused before any AI call or charge`, (r.status === 422 && (code ? codes.indexOf(code) !== -1 : true)) && prov.calls.length === 0 && spendRpcs() === 0, { status: r.status, codes });
  }

  reset(); db.uploads = [];
  r = await post('/api/manual-campaigns/upload-creative', { dataUrl: await png(1200, 628), purpose: 'ad_image' });
  check('own image 1200×628 PNG → stored under the user’s folder, real size returned, no AI call, no credits', r.status === 200 && /\/manual-campaign-creatives\/u1\//.test(r.body.url) && r.body.width === 1200 && r.body.height === 628 && r.body.type === 'image/png' && prov.calls.length === 0 && spendRpcs() === 0, { status: r.status, body: r.body });
  check('…recorded as the user’s creative asset (associated with the user)', rows('creative_assets').some((a) => a.user_id === 'u1' && a.content && a.content.url === r.body.url));
  reset();
  r = await post('/api/manual-campaigns/upload-creative', { dataUrl: await png(500, 300), purpose: 'ad_image' });
  check('own image 500×300 → 400 image_small (checked on the real pixels), nothing stored', r.status === 400 && r.body.code === 'image_small' && !rows('creative_assets').length, r.body);
  reset();
  r = await post('/api/manual-campaigns/upload-creative', { dataUrl: gif, purpose: 'ad_image' });
  check('own ad image as GIF → 400 image_type', r.status === 400 && r.body.code === 'image_type', r.body);
  reset();
  r = await post('/api/manual-campaigns/upload-creative', { dataUrl: 'data:image/png;base64,' + Buffer.from('not an image').toString('base64'), purpose: 'ad_image' });
  check('a file that only claims to be PNG → 400 (rejected after reading it)', r.status === 400, r.body);
  reset();
  r = await call('POST', '/api/manual-campaigns/upload-creative', null, { dataUrl: await png(1200, 628), purpose: 'ad_image' });
  check('upload without signing in → 401', r.status === 401);
  reset();
  r = await post('/api/manual-campaigns/upload-creative', { dataUrl: gif });
  check('the existing "Add existing campaign" upload (no purpose) still accepts GIF, unchanged', r.status === 200 && !!r.body.url, r.body);

  const COSTS = { ai_chat: 5, ai_analysis: 25, campaign_improvement: 10, audience_generation: 10, product_analysis: 10, competitor_analysis: 15, brand_voice: 20, campaign_generation: 25, website_analysis: 30, image_generation: 75, video_generation: 200, automation: 50 };
  check('credit prices: unchanged except Automations = 50 credits once per new automation (was 25 per execution)', JSON.stringify(creditManager.FEATURE_COSTS) === JSON.stringify(COSTS), creditManager.FEATURE_COSTS);
  check('no outbound network requests were attempted', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.info('CRASH', e); process.exit(2); });
