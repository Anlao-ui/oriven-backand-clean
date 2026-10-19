// ════════════════════════════════════════════════════════════════
// Research 2.0 — the research job end to end (types, searches, page reading,
// evidence check, async job + credits, library, Research → Create), against
// a FAKE provider.
//
// Runs the REAL server.js, researchReport, researchToolProvider, paidActions,
// creditManager. Faked: the AIML endpoint (perplexity/sonar search and the
// synthesis model), website fetches (urlContextFetcher.fetchUrlContext) and
// Supabase (in memory). No paid calls, no real data.
//
// RUN: node tests/research-pipeline.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5618;
const BASE = `http://127.0.0.1:${PORT}`;
const AIML = 'http://aiml.mock.invalid';
const SECRET_KEY = 'aiml-test-key-0123456789-should-never-be-logged';

for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|AI_DAILY|AI_USER|PAID_|EMAIL|RESEND/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT: String(PORT), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: SECRET_KEY, AIML_BASE_OVERRIDE: AIML, FRONTEND_URL: 'http://localhost:8899', RESEARCH_SEARCH_TIMEOUT_MS: '800', RESEARCH_SYNTH_TIMEOUT_MS: '1500', RESEARCH_PAGE_TIMEOUT_MS: '300', RESEARCH_FETCH_PHASE_MS: '700', RESEARCH_JOB_DEADLINE_MS: '5000',
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
    // Honour AbortController like real fetch, so provider time limits are testable.
    return new Promise((resolve, reject) => {
      const sig = opts && opts.signal;
      if (sig) sig.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      Promise.resolve(prov.handler({ path: u.slice(AIML.length), body })).then(resolve, reject);
    });
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
  // eq also understands a json path, e.g. 'content->>generationId'
  eq(c, v) { const m = /^(\w+)->>(\w+)$/.exec(c); this.f.push(m ? (r) => r[m[1]] != null && String(r[m[1]][m[2]]) === String(v) : (r) => r[c] === v); return this; }
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
      // upsert merges into an existing row with the same id, as Postgres ON CONFLICT (id) does
      items.forEach((it) => { const ex = this.op === 'upsert' && it.id != null && all.find((r) => r.id === it.id); if (ex) Object.assign(ex, this.p && !Array.isArray(this.p) ? this.p : it); else all.push(it); });
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
async function call(method, p, tok, body) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({ 'X-Idempotency-Key': 'k-' + Math.random().toString(36).slice(2) }, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake AIML: perplexity/sonar = search; anything else = synthesis ──
const AI = { search: 'ok', synth: 'full', calls: [], synthDelay: 0, searchDelay: 0, synthHold: null };
// Each search query gets its own results; one URL repeats across queries,
// one is a social page (never fetched), one a PDF (never fetched).
function searchResults(q) {
  const base = [
    { title: 'Linnen Huis — Linnen overhemden', url: 'https://www.linnenhuis.nl/?utm_source=x', date: '2026-09-01' },
    { title: 'Vlas & Co — Duurzaam linnen', url: 'https://vlasco.nl/' },
  ];
  if (/trend|developments|gaps|complaints/i.test(q)) base.push({ title: 'Linen market trends 2026', url: 'https://news.example.org/linen-2026', date: '2026-08-12' }, { title: 'Linen on Instagram', url: 'https://www.instagram.com/linen' });
  if (/positioning|messaging|reviews|why customers|complaints/i.test(q)) base.push({ title: 'Linen buyers guide (PDF)', url: 'https://guide.example.org/linen.pdf' }, { title: 'Linen shirt reviews', url: 'https://reviews.example.org/linen' });
  return base;
}
function searchResponse(q) {
  return { choices: [{ message: { content: 'Linnen Huis and Vlas & Co are the main Dutch linen brands. Both emphasise European flax.' }, finish_reason: 'stop' }], search_results: searchResults(q), citations: [], usage: { prompt_tokens: 120, completion_tokens: 180 } };
}
// Page texts the fake fetcher returns (the evidence the quotes are checked against).
const PAGES = {
  'https://www.linnenhuis.nl': 'Linnen Huis makes classic linen shirts. Every order comes with free returns within 30 days and shirts start at 59 euro. We use European flax only.',
  'https://vlasco.nl': 'Vlas & Co is a sustainable Dutch flax label. Our premium shirts are woven in Belgium from certified European flax.',
  'https://news.example.org/linen-2026': 'Demand for sustainable fabrics keeps growing as buyers increasingly ask where the flax for their clothing was grown.',
  'https://reviews.example.org/linen': 'Most reviewers love how cool the shirts feel in summer, but many say the linen wrinkles quickly after an hour of wear.',
  'https://linnenco.nl': 'Linnen & Co sells breathable linen shirts with free shipping in the Netherlands.',
};
// Fixture evidence names a DOMAIN; the fake model resolves it to the id the
// prompt gave that domain (as a real model reads ids from the prompt).
const EV = (source, quote) => ({ source, quote });
const DOM = { ws1: 'linnenhuis.nl', ws2: 'vlasco.nl', ws3: 'news.example.org', ws5: 'reviews.example.org' };
function resolveIds(obj, sys) {
  const map = {}; String(sys || '').replace(/\[(ws\d+|w1|u\d+)\] [^\n]*?\(([a-z0-9.-]+)[,)]/g, (m, id, d) => { if (!map[d]) map[d] = id; return m; });
  return JSON.parse(JSON.stringify(obj), (k, v) => (k === 'source' && DOM[v] ? (map[DOM[v]] || 'missing-' + v) : v));
}
function synthJson(type) {
  const common = { title: 'Linen shirt competitors in the Netherlands', summary: 'Dutch linen brands compete on European flax and returns; wrinkling is the main complaint and nobody addresses it.',
    keyConclusions: [
      { text: 'Free returns are standard among competitors', why: 'Returns alone will not differentiate', evidence: [EV('ws1', 'Every order comes with free returns within 30 days')] },
      { text: 'Wrinkling is the most common complaint', why: 'An angle no competitor uses', evidence: [EV('ws5', 'many say the linen wrinkles quickly after an hour')] },
      { text: 'Sustainability is a shared claim', why: 'Hard to own alone', evidence: [EV('ws2', 'sustainable and certified flax is what they sell')] },
    ], limitations: ['No public ad examples could be retrieved'], assumptions: [], confidence: 'moderate' };
  const competitors = [
    { id: 'c1', name: 'Linnen Huis', website: 'linnenhuis.nl', offering: 'Classic linen shirts', positioning: 'Classic basics with free returns', valueProposition: 'Easy returns', pricing: 'From 59 euro', messaging: 'Comfort and ease', adPatterns: ['Seasonal sale'], differentiation: 'Address wrinkling', evidence: [EV('ws1', 'shirts start at 59 euro. We use European flax only')] },
    { id: 'c2', name: 'Vlas & Co', positioning: 'Sustainable Dutch flax', pricing: 'premium', evidence: [EV('ws2', 'their premium shirts are hand woven in Belgium'), EV('ws99', 'made up quote from a made up source')] },
    { id: 'c3', name: 'Generic Brand', positioning: 'Low-cost linen', evidence: [] },
    { id: 'c4', name: 'Short Quote Brand', positioning: 'x', evidence: [EV('ws1', 'free returns')] },
  ];
  const signals = [{ id: 's1', type: 'painPoint', text: 'Linen wrinkles quickly', evidence: [EV('ws5', 'many say the linen wrinkles quickly after an hour of wear')] }, { id: 's2', type: 'need', text: 'Stay cool in summer', evidence: [EV('ws5', 'reviewers adore how cool these shirts are')] }];
  const by = {
    market: { marketOverview: { name: 'Linen shirts — Netherlands', description: 'A seasonal, sustainability-led category', characteristics: [{ text: 'Sustainability claims are common', evidence: [EV('ws3', 'buyers increasingly ask where the flax for their clothing was grown')] }] },
      trends: [{ id: 't1', trend: 'Sustainable fabrics', why: 'Buyers ask about origin', evidence: [EV('ws3', 'Demand for sustainable fabrics keeps growing')] }], challenges: [{ id: 'h1', text: 'Seasonal demand', evidence: [] }],
      competitors, signals, opportunities: [{ id: 'o1', title: 'Own the wrinkle conversation', why: 'Main complaint, unaddressed', audience: 'Office workers', angle: 'Lived-in look', test: 'Wrinkle angle vs comfort angle', relatedCompetitorIds: ['c1', 'c9'], relatedSignalIds: ['s1'], evidence: [EV('ws5', 'many say the linen wrinkles quickly after an hour of wear')] }],
      implications: [{ id: 'm1', text: 'Lead with comfort in summer campaigns' }], segments: [{ id: 'a1', name: 'should be dropped for market type' }] },
    competitor: { competitors, adPatterns: [{ id: 'p1', pattern: 'Seasonal sale', description: 'Spring sale banners', evidence: [] }], opportunities: [{ id: 'o1', title: 'Wrinkle-resistant positioning', why: 'Gap', relatedCompetitorIds: ['c1'], evidence: [] }], angles: [{ id: 'g1', angle: 'Lived-in look', message: 'Linen that looks better worn' }] },
    audience: { signals, segments: [{ id: 'a1', name: 'Urban professionals 25–45', description: 'Office-ready summer shirts', needs: 'Look neat all day', why: 'Feel the wrinkle pain most', relatedSignalIds: ['s1', 'zz'] }], angles: [{ id: 'g1', angle: 'All-day neat', message: 'Still sharp at 5pm', relatedSignalIds: ['s1'] }], competitors },
    opportunity: { opportunities: [{ id: 'o1', title: 'Own the wrinkle conversation', why: 'Main complaint, unaddressed', audience: 'Office workers', angle: 'Lived-in look', test: 'Wrinkle angle vs comfort angle', limitation: 'Based on reviews from one site', relatedCompetitorIds: ['c1'], relatedSignalIds: ['s1'], evidence: [EV('ws5', 'many say the linen wrinkles quickly after an hour of wear')] }],
      signals, competitors, angles: [{ id: 'g1', angle: 'Lived-in look', message: 'Linen that looks better worn' }], tests: [{ id: 'x1', hypothesis: 'Wrinkle honesty beats comfort', variantA: 'Wrinkle angle', variantB: 'Comfort angle', measure: 'Cost per click' }], risks: [{ id: 'r1', risk: 'Greenwashing', mitigation: 'Only certified claims' }] },
  };
  return Object.assign({}, common, by[type] || by.market);
}
function synthResponse(type, sys) {
  const full = JSON.stringify(resolveIds(synthJson(type), sys));
  if (AI.synth === 'full') return { choices: [{ message: { content: full }, finish_reason: 'stop' }], usage: { prompt_tokens: 5200, completion_tokens: 2100 } };
  if (AI.synth === 'prose') return { choices: [{ message: { content: 'Here is your research:\n```json\n' + full + '\n```\nHope this helps!' }, finish_reason: 'stop' }] };
  if (AI.synth === 'truncated') { const cut = full.slice(0, full.indexOf('"limitations"') + 5); return { choices: [{ message: { content: cut }, finish_reason: 'length' }] }; }
  if (AI.synth === 'garbage') return { choices: [{ message: { content: 'I cannot help with that.' }, finish_reason: 'stop' }] };
  if (AI.synth === 'empty') return { choices: [{ message: { content: JSON.stringify({ summary: 'Too vague.', competitors: [] }) }, finish_reason: 'stop' }] };
  return null;
}
function typeFromPrompt(sys) { const m = /Research type: (MARKET|COMPETITOR|AUDIENCE|OPPORTUNITY) RESEARCH/.exec(sys || ''); return m ? m[1].toLowerCase() : 'market'; }
async function fakeAiml({ path: p, body }) {
  if (p !== '/v1/chat/completions') return ok();
  const sys = body.messages && body.messages[0] && body.messages[0].content, user = body.messages && body.messages[1] && body.messages[1].content;
  AI.calls.push({ model: body.model, max_tokens: body.max_tokens, system: sys, user });
  if (body.model === 'perplexity/sonar') {
    if (AI.searchDelay) await sleep(AI.searchDelay);
    if (AI.search === 'down') return json(503, { error: { message: 'search unavailable' } });
    if (AI.search === 'empty') return json(200, { choices: [{ message: { content: 'nothing' } }], search_results: [], citations: [] });
    return json(200, searchResponse(user || ''));
  }
  if (/MARKET RESEARCH FINDINGS|AD BRIEF|campaign/i.test(sys || '') && !/Research type:/.test(sys || '')) return ok();
  if (AI.synthHold) await AI.synthHold;
  if (AI.synthDelay) await sleep(AI.synthDelay);
  if (AI.synth === 'down') return json(503, { error: { message: 'upstream unavailable' } });
  if (AI.synth === 'reject') return json(400, { error: { message: 'bad request' } });
  return json(200, synthResponse(typeFromPrompt(sys), sys));
}

const prof = (id) => rows('profiles').find((p) => p.id === id);
async function ask(tok, body, key) {
  const r = await realFetch(BASE + '/api/research/query', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Idempotency-Key': key || ('k-' + Math.random().toString(36).slice(2)) }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: JSON.stringify(body) });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
// Polls the library until the job leaves 'running'.
async function waitDone(tok, id, ms) {
  const until = Date.now() + (ms || 6000);
  while (Date.now() < until) {
    const r = await call('GET', '/api/research/reports/' + id, tok);
    if (r.status !== 200) return r;
    if (r.body.summary && r.body.summary.status !== 'running') return r;
    await sleep(40);
  }
  return { status: 0, body: null };
}
async function run(tok, body, key) {
  const s = await ask(tok, body, key);
  if (s.status !== 202) return { start: s };
  const done = await waitDone(tok, s.body.reportId);
  await sleep(30); // settlement runs right after the final write
  return { start: s, done, report: done.body && done.body.report, summary: done.body && done.body.summary };
}
const COST = 25;

(async () => {
  const quiet = { log: console.log };
  const noop = () => {}; console.log = noop; console.warn = noop; console.info = noop;
  const errLines = []; console.error = (...a) => { errLines.push(a.map(String).join(' ')); };
  require(path.join(SERVER_DIR, 'server.js'));
  const fetcher = require(path.join(SERVER_DIR, 'services/urlContextFetcher.js'));
  const RR = require(path.join(SERVER_DIR, 'services/researchReport.js'));
  let siteCalls = []; const SLOW = new Set();
  fetcher.fetchUrlContext = async (u, opts) => {
    siteCalls.push({ u, opts });
    const key = String(u).replace(/\/+$/, '');
    if (SLOW.has(key)) await sleep(2000);
    if (PAGES[key]) { let domain = ''; try { domain = new URL(key).hostname.replace(/^www\./, ''); } catch (_) {} return { ok: true, url: key, domain, title: domain, description: null, text: PAGES[key] }; }
    return { ok: false, url: u, reason: 'Could not reach that page.', code: 'unreachable' };
  };
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);
  prov.handler = fakeAiml;
  rows('profiles').push(
    { id: 'ann', subscription_status: 'creator', credits_balance: 1000, onboarding_completed: true },
    { id: 'ben', subscription_status: 'creator', credits_balance: 1000, onboarding_completed: true },
    { id: 'fre', subscription_status: 'free', credits_balance: 1000, onboarding_completed: true },
    { id: 'low', subscription_status: 'creator', credits_balance: 10, onboarding_completed: true },
  );
  rows('business_profile').push({ user_id: 'ann', company_name: 'Linnen & Co', industry: 'Apparel', country: 'Nederland', website: 'linnenco.nl' });
  rows('business_profile').push({ user_id: 'ben', company_name: 'Ben Bikes', industry: 'Bicycles', country: null, website: null });
  rows('business_competitors').push({ user_id: 'ann', company: 'Linnen Huis' }, { user_id: 'ann', company: 'Vlas & Co' });
  for (const [t, id] of [['tok_ann', 'ann'], ['tok_ben', 'ben'], ['tok_fre', 'fre'], ['tok_low', 'low']]) TOKENS[t] = { id, email: id + '@example.invalid', created_at: '2026-01-01T00:00:00Z' };

  say('\nA. Research types — distinct searches, prompts and schemas');
  const ctx = { industry: 'Apparel', countryName: 'Netherlands', competitors: ['Linnen Huis', 'Vlas & Co'] };
  const Q = {}; RR.TYPE_KEYS.forEach((t) => { Q[t] = RR.searchQueries(t, 'Linen shirts for men', ctx); });
  check('four types', JSON.stringify(RR.TYPE_KEYS) === '["market","competitor","audience","opportunity"]');
  check('each type: 2–3 deduplicated queries', RR.TYPE_KEYS.every((t) => Q[t].length >= 2 && Q[t].length <= 3 && new Set(Q[t]).size === Q[t].length), Q);
  check('query sets differ per type', new Set(RR.TYPE_KEYS.map((t) => Q[t].join('|'))).size === 4, Q);
  check('competitor queries use known competitors; country added, never assumed', /Linnen Huis vs Vlas & Co/.test(Q.competitor.join(' ')) && Q.market[0].endsWith('Netherlands') && !/United States/.test(RR.searchQueries('market', 'x y z', {}).join(' ')));
  check('search instructions differ per type', new Set(RR.TYPE_KEYS.map((t) => RR.searchInstructions(t, {}))).size === 4);
  const P = {}; RR.TYPE_KEYS.forEach((t) => { P[t] = RR.buildSystemPrompt({ type: t, sources: [] }); });
  check('prompt schema is type-specific', /"valueProposition"/.test(P.competitor) && !/"segments"/.test(P.competitor) && /"segments"/.test(P.audience) && !/"marketOverview"/.test(P.audience) && /"tests"/.test(P.opportunity) && /"marketOverview"/.test(P.market) && !/"tests"/.test(P.market));
  check('prompt: no invented numbers, no ad-performance claims, word-for-word quotes', /Never invent numbers/.test(P.market) && /"performs", "works"/.test(P.market) && /WORD FOR WORD/.test(P.market));
  check('prompt without a country forbids assuming one', /Do NOT assume any country/.test(P.market));

  say('\nB. Source selection, passages, evidence check (pure)');
  const sel = RR.selectSources([{ ok: true, sources: [{ url: 'https://a.example/x', domain: 'a.example', title: 'A' }, { url: 'https://www.instagram.com/p', domain: 'instagram.com', title: 'IG' }] }, { ok: true, sources: [{ url: 'https://a.example/x#top', domain: 'a.example', title: 'A again' }, { url: 'https://b.example/r.pdf', domain: 'b.example', title: 'PDF' }, { url: 'https://c.example/', domain: 'c.example', title: 'C' }] }, { ok: false }], { excludeDomains: ['c.example'] });
  check('duplicate URLs merged across searches', sel.sources.length === 4 && sel.sources.filter((s) => s.domain === 'a.example').length === 1);
  check('only http(s) results are kept (no javascript:/data: links)', RR.selectSources([{ ok: true, sources: [{ url: 'javascript:alert(1)', domain: 'x' }, { url: 'data:text/html,x', domain: 'y' }, { url: 'https://ok.example/a', domain: 'ok.example' }] }]).sources.map((s) => s.url).join() === 'https://ok.example/a');
  check('social pages, PDFs and the own domain are not fetched; repeated source ranks first', sel.toFetch[0] === 'ws1' && sel.toFetch.length === 1, sel);
  const pas = RR.extractPassages('Intro about the company. ' + 'Filler sentence about nothing at all. '.repeat(40) + 'Linen shirts wrinkle quickly according to buyers. More filler here.', 'linen shirts wrinkle');
  check('relevant passages extracted, bounded', pas.length >= 1 && pas.some((p) => /wrinkle quickly/.test(p)) && pas.join('').length <= 1500, pas);
  const known = new Map([['ws1', { canon: RR.canon(PAGES['https://www.linnenhuis.nl']) }], ['ws2', { canon: null }]]);
  check('exact quote found in fetched text → source_checked', RR.checkEvidence([EV('ws1', 'Every order comes with “free returns” within 30 days')], known).basis === 'source_checked');
  check('paraphrased quote → source_cited (not checked)', RR.checkEvidence([EV('ws1', 'every purchase can be returned for free for a month')], known).basis === 'source_cited');
  check('citation of a search result that was not read → source_cited', RR.checkEvidence([EV('ws2', 'Our premium shirts are woven in Belgium')], known).basis === 'source_cited');
  check('too-short quote (keyword overlap) is not enough', RR.checkEvidence([EV('ws1', 'free returns')], known).basis === 'source_cited');
  check('invented source id ignored → analysis', RR.checkEvidence([EV('ws99', 'Every order comes with free returns within 30 days')], known).basis === 'analysis');
  check('ideas stay ideas even with evidence', RR.checkEvidence([EV('ws1', 'Every order comes with free returns within 30 days')], known, true).basis === 'idea');
  check('question validation: empty / too short / too long', !RR.validateQuestion('').ok && RR.validateQuestion('abc').code === 'QUESTION_TOO_SHORT' && RR.validateQuestion('x'.repeat(501)).code === 'QUESTION_TOO_LONG' && RR.validateQuestion('  Linen shirt market  ').question === 'Linen shirt market');
  const p1 = RR.parseModelJson('Sure!\n```json\n{"summary":"x"}\n```');
  const cut = RR.parseModelJson('{"summary":"x","competitors":[{"id":"c1","name":"A"},{"id":"c2","name":"B","positioning":"half');
  check('parser: fences tolerated; truncation keeps complete items', p1 && p1.result.summary === 'x' && cut && cut.repaired && cut.result.competitors.length === 2);

  say('\nC. Full competitor research (async job, Netherlands business)');
  let b0 = prof('ann').credits_balance; AI.calls.length = 0; siteCalls = [];
  let R = await run('tok_ann', { question: 'Who are my main competitors and how do they advertise?', type: 'competitor' });
  check('202 with a stable report id, then ready', R.start.status === 202 && /^[0-9a-f-]{36}$/.test(R.start.body.reportId) && R.summary && R.summary.status === 'ready', { s: R.start.status, b: R.start.body });
  const searches = AI.calls.filter((c) => c.model === 'perplexity/sonar'), synth = AI.calls.filter((c) => c.model !== 'perplexity/sonar');
  check('3 targeted searches + exactly 1 synthesis call', searches.length === 3 && synth.length === 1, AI.calls.map((c) => c.model));
  check('searches use the competitor instruction and the known competitors', searches.every((c) => /main competitors \(name and website\)/.test(c.system)) && searches.some((c) => /Linnen Huis vs Vlas & Co/.test(c.user)));
  check('synthesis bounded to 3000 output tokens', synth[0].max_tokens === 3000);
  const fetchedUrls = siteCalls.map((s) => String(s.u).replace(/\/+$/, ''));
  check('pages fetched with the safe fetcher (≤5 + own website), no social/PDF', fetchedUrls.length <= 6 && fetchedUrls.includes('https://www.linnenhuis.nl') && fetchedUrls.includes('https://linnenco.nl') && !fetchedUrls.some((u) => /instagram|\.pdf/.test(u)) && siteCalls.every((s) => s.opts && s.opts.maxText === 20000), fetchedUrls);
  check('synthesis prompt contains real page excerpts, not only titles', /SOURCE EXCERPTS/.test(synth[0].system) && /free returns within 30 days/.test(synth[0].system) && /Research type: COMPETITOR RESEARCH/.test(synth[0].system));
  const rep = R.report;
  check('report is version 2, typed, titled', rep.reportVersion === 2 && rep.type === 'competitor' && rep.title === 'Linen shirt competitors in the Netherlands');
  check('only competitor-type sections are kept', rep.competitors && rep.adPatterns && rep.opportunities && rep.angles && !rep.marketOverview && !rep.segments && !rep.trends);
  const cc = (id) => rep.competitors.find((c) => c.id === id);
  check('competitor with an exact quote is source_checked and keeps the quote', cc('c1').basis === 'source_checked' && cc('c1').quotes[0].quote === 'shirts start at 59 euro. We use European flax only' && cc('c1').quotes[0].sourceId === 'ws1');
  check('quote from an unread/other text → source_cited; invented source dropped', cc('c2').basis === 'source_cited' && JSON.stringify(cc('c2').sourceIds) === '["ws2"]');
  check('competitor without evidence → analysis; short keyword quote → source_cited', cc('c3').basis === 'analysis' && cc('c4').basis === 'source_cited');
  check('competitor fields kept (offering, value proposition, pricing, messaging, differentiation)', cc('c1').offering && cc('c1').valueProposition && cc('c1').pricing === 'From 59 euro' && cc('c1').messaging && cc('c1').differentiation && cc('c1').website === 'https://linnenhuis.nl');
  const kc = rep.keyConclusions;
  check('key conclusions checked individually', kc.length === 3 && kc[0].basis === 'source_checked' && kc[1].basis === 'source_checked' && kc[2].basis === 'source_cited', kc.map((k) => k.basis));
  check('ideas labelled idea (angles, opportunities)', rep.angles.every((g) => g.basis === 'idea') && rep.opportunities.every((o) => o.basis === 'idea'));
  check('sources list: fetched flag, read count, cited-by', rep.sources.some((s) => s.fetched && s.citedBy.includes('competitors')) && rep.sources.some((s) => !s.fetched) && rep.retrieval.read >= 3 && rep.retrieval.searches === 3, rep.retrieval);
  check('counts per evidence label', rep.counts.source_checked >= 3 && rep.counts.source_cited >= 2 && rep.counts.idea >= 2, rep.counts);
  check('25 credits charged once, kept on success', prof('ann').credits_balance === b0 - COST, b0 - prof('ann').credits_balance);
  const row = rows('creative_assets').find((x) => x.id === R.start.body.reportId);
  check('saved server-side: status ready, title = report title, type stored', row && row.status === 'ready' && row.title === 'Linen shirt competitors in the Netherlands' && row.content.type === 'competitor' && row.user_id === 'ann');
  check('no API key in the report', !JSON.stringify(rep).includes('aiml-test-key'));

  say('\nD. Other types produce their own report structures');
  for (const [t, keys, absent] of [['market', ['marketOverview', 'trends', 'competitors', 'implications'], 'segments'], ['audience', ['signals', 'segments', 'angles'], 'competitors'], ['opportunity', ['opportunities', 'tests', 'risks', 'signals'], 'marketOverview']]) {
    AI.calls.length = 0;
    const x = await run('tok_ann', { question: 'Linen shirts for men in summer', type: t });
    const ok2 = x.report && x.report.type === t && keys.every((k) => x.report[k]) && !x.report[absent];
    check(t + ': own sections, ' + absent + ' left out; own prompt', ok2 && AI.calls.some((c) => new RegExp('Research type: ' + t.toUpperCase()).test(c.system || '')), x.report && Object.keys(x.report));
    if (t === 'audience') check('audience: observed signals checked, hypotheses are ideas, dangling links removed', x.report.signals[0].basis === 'source_checked' && x.report.signals[1].basis === 'source_cited' && x.report.segments[0].basis === 'idea' && JSON.stringify(x.report.segments[0].relatedSignalIds) === '["s1"]');
    if (t === 'opportunity') check('opportunity: idea with separate supporting evidence + test', x.report.opportunities[0].basis === 'idea' && x.report.opportunities[0].supportBasis === 'source_checked' && x.report.opportunities[0].test && x.report.tests[0].variantA);
  }

  say('\nE. Library: list, open, rename, delete, ownership, old reports');
  rows('creative_assets').push({ id: '11111111-2222-3333-4444-555555555555', user_id: 'ann', kind: 'research', title: 'Old v1 research', status: 'ready', archived: false, created_at: '2026-05-01T10:00:00.000Z',
    content: { question: 'Old question', summary: 'Old summary', competitors: [{ id: 'c1', name: 'X', basis: 'verified', sourceIds: ['ws1'] }], webSources: [{ id: 'ws1', url: 'https://x.example' }], urlSources: [] } });
  let x = await call('GET', '/api/research/reports', 'tok_ann');
  const lst = x.body.reports || [];
  check('library lists v2 + old reports with type, status, source count', x.status === 200 && lst.length >= 5 && lst.some((r) => r.type === 'competitor' && r.status === 'ready' && r.sourceCount >= 3 && r.reportVersion === 2) && lst.some((r) => r.reportVersion === 1 && r.title === 'Old v1 research' && r.sourceCount === 1), lst);
  x = await call('GET', '/api/research/reports/11111111-2222-3333-4444-555555555555', 'tok_ann');
  check('old report still opens unchanged', x.status === 200 && x.body.report.competitors[0].basis === 'verified' && x.body.report.reportId);
  const id = R.start.body.reportId;
  x = await call('PATCH', '/api/research/reports/' + id, 'tok_ann', { title: '  My   competitor scan  ' });
  check('rename (trimmed)', x.status === 200 && rows('creative_assets').find((a) => a.id === id).title === 'My competitor scan');
  x = await call('PATCH', '/api/research/reports/' + id, 'tok_ann', { title: '' });
  const x2 = await call('PATCH', '/api/research/reports/' + id, 'tok_ann', { title: 'x'.repeat(121) });
  check('rename validation', x.status === 400 && x2.status === 400);
  x = await call('PATCH', '/api/research/reports/' + id, 'tok_ben', { title: 'stolen' });
  const x3 = await call('GET', '/api/research/reports/' + id, 'tok_ben');
  const x4 = await call('DELETE', '/api/research/reports/' + id, 'tok_ben');
  check('other users can’t open, rename or delete it', x.status === 404 && x3.status === 404 && x4.status === 404 && rows('creative_assets').find((a) => a.id === id).title === 'My competitor scan' && !rows('creative_assets').find((a) => a.id === id).archived);
  x = await call('GET', '/api/research/reports', null);
  check('no session → 401', x.status === 401);
  x = await call('DELETE', '/api/research/reports/' + id, 'tok_ann');
  check('delete = archive (kept, hidden)', x.status === 200 && rows('creative_assets').find((a) => a.id === id).archived === true && !(await call('GET', '/api/research/reports', 'tok_ann')).body.reports.some((r) => r.id === id) && (await call('GET', '/api/research/reports/' + id, 'tok_ann')).status === 404);
  x = await call('GET', '/api/creative/assets', 'tok_ann');
  check('creative library never lists research', x.status === 200 && !(x.body.assets || []).some((a) => a.kind === 'research'));
  x = await call('GET', '/api/creative/assets?status=draft', 'tok_ann');
  const x5 = await call('GET', '/api/creative/assets?status=rejected', 'tok_ann');
  check('“draft”/“rejected” asset filters never return research jobs', x.status === 200 && x5.status === 200 && ![].concat(x.body.assets || [], x5.body.assets || []).some((a) => a.kind === 'research'));
  // Generic creative-asset routes must not touch a research report (even its owner's).
  const oldId = '11111111-2222-3333-4444-555555555555';
  const oldRow = rows('creative_assets').find((a) => a.id === oldId);
  await call('PATCH', '/api/creative/assets/' + oldId, 'tok_ann', { status: 'draft', title: 'hijack', archived: true });
  await call('POST', '/api/creative/assets/' + oldId + '/duplicate', 'tok_ann', {});
  await call('POST', '/api/creative/assets/' + oldId + '/restore', 'tok_ann', {});
  await call('DELETE', '/api/creative/assets/' + oldId, 'tok_ann');
  check('generic asset PATCH / duplicate / restore / DELETE leave research reports untouched', oldRow && rows('creative_assets').includes(oldRow) && oldRow.status === 'ready' && oldRow.title === 'Old v1 research' && !oldRow.archived && rows('creative_assets').filter((a) => a.kind === 'research' && a.title === 'Old v1 research').length === 1, oldRow);

  say('\nF. Long questions and recovery by id');
  const longQ = 'How do Dutch linen brands advertise to men who want office-ready summer shirts, ' + 'and which messages about comfort, sustainability and fit do they use? '.repeat(4);
  R = await run('tok_ann', { question: longQ.slice(0, 495), type: 'market' });
  check('a 495-character question runs (no hidden text appended)', R.start.status === 202 && R.report && R.report.question === longQ.slice(0, 495).trim());
  check('recovery uses the report id, not the (shortened) title', R.done.status === 200 && R.summary.id === R.start.body.reportId);
  x = await ask('tok_ann', { question: 'x'.repeat(501), type: 'market' });
  check('over 500 characters → 400 QUESTION_TOO_LONG', x.status === 400 && x.body.code === 'QUESTION_TOO_LONG');
  x = await ask('tok_ann', { question: 'Linen shirt market', type: 'astrology' });
  check('unknown type → 400', x.status === 400 && x.body.code === 'TYPE_INVALID');
  x = await ask('tok_ann', { question: 'Linen shirt market', type: 'market', urls: ['ftp://nope.example/x'] });
  check('unsafe attached URL → 400 before charging', x.status === 400 && x.body.code === 'URL_INVALID');

  say('\nG. No country, no website, search down');
  AI.search = 'down'; AI.calls.length = 0; siteCalls = [];
  b0 = prof('ben').credits_balance;
  R = await run('tok_ben', { question: 'Which advertising angles should I test?', type: 'opportunity' });
  check('search down → still a report, nothing source-checked or cited', R.report && R.report.retrieval.searchesOk === 0 && R.report.sources.length === 0 && [].concat(R.report.signals || [], R.report.competitors || [], R.report.keyConclusions || []).every((i) => i.basis === 'analysis'), R.report && R.report.retrieval);
  check('no country → prompt forbids assuming one; no website fetched', /Do NOT assume any country/.test(AI.calls[AI.calls.length - 1].system) && siteCalls.length === 0 && R.report.market_country === null);
  check('charged once', prof('ben').credits_balance === b0 - COST);
  AI.search = 'ok';
  R = await run('tok_ann', { question: 'Linen shirts without my site', type: 'market', includeWebsite: false });
  check('“include my website” off → own site not fetched', R.report && !R.report.sources.some((s) => s.provenance === 'own_website'));

  say('\nH. Failures refund; partial is honest');
  const refundCase = async (mode, code) => {
    AI.synth = mode; const bb = prof('ann').credits_balance;
    const y = await run('tok_ann', { question: 'Who are my competitors here?', type: 'competitor' });
    const r2 = rows('creative_assets').find((a) => a.id === y.start.body.reportId);
    AI.synth = 'full';
    return y.summary && y.summary.status === 'failed' && r2.content.error.code === code && prof('ann').credits_balance === bb && !/upstream|bad request|503/.test(y.summary.error || '');
  };
  check('non-JSON → failed RESEARCH_INVALID, refunded, friendly message', await refundCase('garbage', 'RESEARCH_INVALID'));
  check('nothing usable → failed RESEARCH_EMPTY, refunded', await refundCase('empty', 'RESEARCH_EMPTY'));
  check('provider down → failed PROVIDER_UNAVAILABLE, refunded', await refundCase('down', 'PROVIDER_UNAVAILABLE'));
  check('provider rejects → failed, refunded', await refundCase('reject', 'RESEARCH_FAILED'));
  AI.synth = 'prose';
  R = await run('tok_ann', { question: 'What messaging is common?', type: 'competitor' });
  check('JSON wrapped in prose → parsed', R.report && R.report.competitors.length === 4 && !R.report.partial);
  AI.synth = 'truncated'; b0 = prof('ann').credits_balance;
  R = await run('tok_ann', { question: 'Full market overview please', type: 'competitor' });
  check('cut-off output → partial report flagged, charged', R.report && R.report.partial === true && prof('ann').credits_balance === b0 - COST);
  AI.synth = 'full';
  AI.synthDelay = 2000; b0 = prof('ann').credits_balance;
  R = await run('tok_ann', { question: 'Synthesis too slow', type: 'market' });
  check('slow synthesis → RESEARCH_TIMEOUT, refunded', R.summary && R.summary.status === 'failed' && rows('creative_assets').find((a) => a.id === R.start.body.reportId).content.error.code === 'RESEARCH_TIMEOUT' && prof('ann').credits_balance === b0);
  AI.synthDelay = 0; await sleep(600);
  SLOW.add('https://www.linnenhuis.nl'); siteCalls = [];
  R = await run('tok_ann', { question: 'Slow page test linen', type: 'competitor' });
  SLOW.clear();
  const slowSrc = R.report && R.report.sources.find((s) => s.domain === 'linnenhuis.nl');
  check('a page that takes too long is recorded as not read (claims about it not checked)', R.report && slowSrc && !slowSrc.fetched && /too long/.test(slowSrc.fetchError || '') && R.report.competitors.find((c) => c.id === 'c1').basis === 'source_cited', slowSrc);

  say('\nI. Progress stages, interrupted jobs, duplicates, access');
  let release; AI.synthHold = new Promise((r) => { release = r; });
  const s1 = await ask('tok_ann', { question: 'Stage tracking question', type: 'audience' });
  await sleep(120);
  const mid = await call('GET', '/api/research/reports/' + s1.body.reportId, 'tok_ann');
  check('while running: no report yet, real stage reported', mid.status === 200 && mid.body.report === null && mid.body.summary.status === 'running' && mid.body.summary.stage === 'analysing', mid.body);
  const listMid = await call('GET', '/api/research/reports', 'tok_ann');
  check('running research shows in the library', listMid.body.reports.some((r) => r.id === s1.body.reportId && r.status === 'running'));
  b0 = prof('ann').credits_balance;
  const s2 = await ask('tok_ann', { question: 'A second research at the same time', type: 'market' });
  check('second research while one runs → 409 RESEARCH_RUNNING with its id, not charged', s2.status === 409 && s2.body.code === 'RESEARCH_RUNNING' && s2.body.reportId === s1.body.reportId && prof('ann').credits_balance === b0);
  const del = await call('DELETE', '/api/research/reports/' + s1.body.reportId, 'tok_ann');
  check('a running research can’t be deleted', del.status === 409);
  AI.synthHold = null; release();
  await waitDone('tok_ann', s1.body.reportId); await sleep(30);
  const key = 'dup-key-research-1';
  const d1 = await ask('tok_ann', { question: 'Same question twice please', type: 'market' }, key);
  const d2 = await ask('tok_ann', { question: 'Same question twice please', type: 'market' }, key);
  await waitDone('tok_ann', d1.body.reportId); await sleep(30);
  check('same idempotency key twice → one research', d1.status === 202 && d2.status === 409);
  // A job orphaned by a restart: row 'running', paid action awaiting.
  b0 = prof('ann').credits_balance;
  let rel2; AI.synthHold = new Promise((r) => { rel2 = r; });
  const o = await ask('tok_ann', { question: 'This job will be orphaned', type: 'market' });
  await sleep(120);
  const orow = rows('creative_assets').find((a) => a.id === o.body.reportId);
  orow.created_at = new Date(Date.now() - 7 * 60 * 1000).toISOString();
  const after = await call('GET', '/api/research/reports', 'tok_ann');
  await sleep(50);
  check('stale running job → failed RESEARCH_INTERRUPTED and refunded on the next library read', after.body.reports.find((r) => r.id === o.body.reportId).status === 'failed' && orow.content.error.code === 'RESEARCH_INTERRUPTED' && prof('ann').credits_balance === b0, { bal: prof('ann').credits_balance - b0 });
  AI.synthHold = null; rel2(); await sleep(200);
  check('the late job can’t overwrite the failed row or double-settle', orow.status === 'rejected' && prof('ann').credits_balance === b0);
  let y = await ask(null, { question: 'Linen shirt market', type: 'market' });
  check('no session → 401', y.status === 401);
  y = await ask('tok_fre', { question: 'Linen shirt market', type: 'market' });
  check('Free plan → 403, no AI call', y.status === 403);
  AI.calls.length = 0;
  y = await ask('tok_low', { question: 'Linen shirt market', type: 'market' });
  check('not enough credits → 402 before any AI call, no report row', y.status === 402 && AI.calls.length === 0);
  db.missing.add('creative_assets'); b0 = prof('ann').credits_balance;
  y = await ask('tok_ann', { question: 'Linen shirt market storage down', type: 'market' });
  db.missing.delete('creative_assets'); await sleep(30);
  check('report row can’t be created → 500, refunded at once', y.status === 500 && y.body.code === 'RESEARCH_START_FAILED' && prof('ann').credits_balance === b0, y.body);

  say('\nK. Regression: report row status must satisfy the creative_assets CHECK constraint');
  // The bug: the job wrote status 'running' / 'failed'; production only allows
  // draft | needs_improvement | ready | approved | published | rejected.
  const rej = await supabaseMock.from('creative_assets').insert({ id: 'cccccccc-0000-0000-0000-000000000001', user_id: 'ann', kind: 'research', status: 'running', archived: false });
  check('the mock enforces the production constraint (old value "running" → 23514, the original failure)', rej.error && rej.error.code === '23514');
  for (const t of ['market', 'competitor', 'audience', 'opportunity']) {
    const bb = prof('ann').credits_balance;
    let rel3; AI.synthHold = new Promise((r) => { rel3 = r; });
    const st = await ask('tok_ann', { question: 'Linen shirts start check for ' + t, type: t });
    await sleep(80);
    const row = rows('creative_assets').find((a) => a.id === (st.body && st.body.reportId));
    const mid = row ? await call('GET', '/api/research/reports/' + row.id, 'tok_ann') : null;
    check(t + ': starts (202 + report id), row stored as an allowed status, API reports running', st.status === 202 && row && row.status === 'draft' && mid && mid.body.summary.status === 'running' && prof('ann').credits_balance === bb - COST, { s: st.status, b: st.body, row: row && row.status });
    AI.synthHold = null; rel3();
    const done = await waitDone('tok_ann', st.body.reportId); await sleep(30);
    check(t + ': finishes ready, charged exactly once', done.body.summary.status === 'ready' && row.status === 'ready' && prof('ann').credits_balance === bb - COST);
  }
  AI.synth = 'down'; let bb = prof('ann').credits_balance;
  let y2 = await run('tok_ann', { question: 'A job that fails on the provider', type: 'market' });
  AI.synth = 'full';
  const frow = rows('creative_assets').find((a) => a.id === y2.start.body.reportId);
  check('a failed job is stored as an allowed status (rejected), reported as failed, refunded', frow.status === 'rejected' && y2.summary.status === 'failed' && prof('ann').credits_balance === bb);
  const lib = await call('GET', '/api/research/reports', 'tok_ann');
  check('library maps stored statuses to ready / running / failed only', lib.status === 200 && lib.body.reports.every((r) => ['ready', 'running', 'failed'].includes(r.status)) && lib.body.reports.some((r) => r.status === 'failed'));
  check('reports saved before the fix (status ready) still open', (await call('GET', '/api/research/reports/11111111-2222-3333-4444-555555555555', 'tok_ann')).status === 200);
  // Insert still failing for another reason → no charge, safe message, request id, structured log without secrets
  bb = prof('ann').credits_balance; errLines.length = 0;
  const realCheck = CHECKS.creative_assets; CHECKS.creative_assets = () => false; // the constraint rejects the row (the production failure mode)
  y2 = await ask('tok_ann', { question: 'Report row insert fails here', type: 'market' });
  CHECKS.creative_assets = realCheck; await sleep(30);
  const logLine = errLines.find((l) => /\[Research\] start failed/.test(l)) || '';
  check('report row can’t be created → 500 RESEARCH_START_FAILED with a request id, refunded', y2.status === 500 && y2.body.code === 'RESEARCH_START_FAILED' && /^[0-9a-f-]{8,}/.test(y2.body.requestId || '') && prof('ann').credits_balance === bb, y2.body);
  check('…logged once with request id, stage, code and the DB error code — no key, no question text', /"stage":"report_insert"/.test(logLine) && /"code":"RESEARCH_START_FAILED"/.test(logLine) && logLine.includes(y2.body.requestId) && /"dbCode":"23514"/.test(logLine) && !logLine.includes(SECRET_KEY) && !/Report row insert fails here/.test(logLine), logLine);
  check('…the browser gets no raw database error', !/23514|constraint|relation/.test(JSON.stringify(y2.body)));
  // Credit reservation failure → 500 CREDIT_CHECK_FAILED, nothing charged, no report row
  bb = prof('ann').credits_balance; const before = rows('creative_assets').length; db.rpcFail = true;
  y2 = await ask('tok_ann', { question: 'Credit reservation fails here', type: 'market' });
  db.rpcFail = false;
  check('credit reservation fails → 500 CREDIT_CHECK_FAILED, no charge, no report row, request id', y2.status === 500 && y2.body.code === 'CREDIT_CHECK_FAILED' && prof('ann').credits_balance === bb && rows('creative_assets').length === before && !!y2.body.requestId, y2.body);
  // A crash inside the background job → failed + refunded
  const realFetchCtx = fetcher.fetchUrlContext; fetcher.fetchUrlContext = async () => { throw new Error('unexpected crash'); };
  bb = prof('ann').credits_balance;
  y2 = await run('tok_ann', { question: 'Background job crashes while reading', type: 'competitor' });
  fetcher.fetchUrlContext = realFetchCtx;
  check('background step failure never leaves a stuck job: finished and charged once, or failed and refunded', y2.summary && ((y2.summary.status === 'ready' && prof('ann').credits_balance === bb - COST) || (y2.summary.status === 'failed' && prof('ann').credits_balance === bb)), y2.summary);
  // Duplicate submit with the same key → one job, one charge
  bb = prof('ann').credits_balance;
  const k1 = await ask('tok_ann', { question: 'Duplicate start key check', type: 'audience' }, 'dup-start-1');
  const k2 = await ask('tok_ann', { question: 'Duplicate start key check', type: 'audience' }, 'dup-start-1');
  await waitDone('tok_ann', k1.body.reportId); await sleep(30);
  check('duplicate submit (same key) → one research, charged once', k1.status === 202 && k2.status === 409 && prof('ann').credits_balance === bb - COST);

  say('\nJ. Research → Create');
  const pk = await realFetch(BASE + '/api/ai/create-ad', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ann', 'X-Idempotency-Key': 'ca-1' },
    body: JSON.stringify({ product: 'Linen shirts', goal: 'Sales', platforms: ['meta'], researchContext: { question: 'Linen competitors', researchType: 'competitor', reportId: 'abc', findings: [
      { group: 'Competitor', text: 'Linnen Huis — free returns within 30 days', basis: 'source_checked', sources: [{ domain: 'linnenhuis.nl', url: 'https://linnenhuis.nl' }] },
      { group: 'Angle', text: 'Wrinkle-relaxed look — Linen that looks better lived-in', basis: 'idea' }] } }) });
  AI.calls.length = AI.calls.length; // keep
  const createCall = AI.calls.filter((c) => c.model !== 'perplexity/sonar' && /MARKET RESEARCH FINDINGS/.test(c.system || '')).pop();
  const txt = createCall ? createCall.system + (createCall.user || '') : '';
  check('selected insights reach the generation prompt with type, evidence label and source domains', pk.status < 500 && /competitor research/.test(txt) && /\[source-checked fact\]: Linnen Huis/.test(txt) && /sources: linnenhuis\.nl/.test(txt) && /\[idea to test\]: Wrinkle-relaxed/.test(txt), { status: pk.status });
  check('no unexpected outbound requests', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.info('CRASH', e && e.stack || e); process.exit(2); });
