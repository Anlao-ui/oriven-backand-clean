// ════════════════════════════════════════════════════════════════
// Research pipeline — POST /api/research/query end to end, saved reports,
// and the Research → Create handoff, against a FAKE provider.
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
  SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: SECRET_KEY, AIML_BASE_OVERRIDE: AIML, FRONTEND_URL: 'http://localhost:8899', RESEARCH_SEARCH_TIMEOUT_MS: '800', RESEARCH_SYNTH_TIMEOUT_MS: '1500',
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
async function call(method, p, tok, body) {
  const r = await realFetch(BASE + p, { method, headers: Object.assign({ 'X-Idempotency-Key': 'k-' + Math.random().toString(36).slice(2) }, tok ? { Authorization: 'Bearer ' + tok } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake AIML: perplexity/sonar = search; anything else = synthesis ──
const AI = { search: 'ok', synth: 'full', calls: [], delayMs: 0 };
const SEARCH_OK = {
  choices: [{ message: { content: 'Main Dutch linen brands include Linnen Huis (linnenhuis.nl) and Vlas & Co (vlasco.nl). Both emphasise European flax and free returns.' }, finish_reason: 'stop' }],
  search_results: [
    { title: 'Linnen Huis — Linnen overhemden', url: 'https://www.linnenhuis.nl/?utm_source=x', date: '2026-09-01' },
    { title: 'Vlas & Co — Duurzaam linnen', url: 'https://vlasco.nl/' },
    { title: 'Linen market trends 2026', url: 'https://news.example.org/linen-2026' },
  ],
  citations: ['https://vlasco.nl/'],
  usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 },
};
function report(extra) {
  return Object.assign({
    summary: 'Dutch linen shirts compete on European flax and comfort; few brands address fit for broad shoulders.',
    market: { name: 'Linen shirts — Netherlands', characteristics: ['Seasonal demand peaks in spring', 'Sustainability claims are common'], sourceIds: ['ws3'] },
    competitors: [
      { id: 'c1', name: 'Linnen Huis', website: 'linnenhuis.nl', positioning: 'Classic linen basics with free returns', offers: 'Free returns', priceRange: 'mid-range', products: ['Shirts'], advertisingPatterns: ['Seasonal sale'], sourceIds: ['ws1'] },
      { id: 'c2', name: 'Vlas & Co', positioning: 'Sustainable Dutch flax', priceRange: 'premium', sourceIds: ['ws2', 'ws99'] },
      { id: 'c3', name: 'Generic Brand', positioning: 'Low-cost linen', sourceIds: [] },
    ],
    customerSignals: [{ id: 's1', type: 'painPoint', text: 'Linen wrinkles quickly', sourceIds: [] }, { id: 's2', type: 'need', text: 'Stay cool in summer', sourceIds: ['w1'] }],
    advertisingPatterns: [{ id: 'p1', pattern: 'Lifestyle summer imagery', description: 'Beach and terrace scenes', sourceIds: ['ws1'] }],
    trends: [{ id: 't1', trend: 'Sustainable fabrics', relevance: 'Buyers ask where flax is grown', sourceIds: ['ws3'] }],
    audiences: [{ id: 'a1', segment: 'Urban professionals 25–45', why: 'Need office-ready summer shirts', relatedSignalIds: ['s2', 'zz'] }],
    angles: [{ id: 'g1', angle: 'Wrinkle-relaxed look', message: 'Linen that looks better lived-in', why: 'Turns the main complaint into style', relatedSignalIds: ['s1'], relatedCompetitorIds: ['c1'] }],
    creativeConcepts: [{ id: 'k1', concept: 'Morning-to-evening wear test', format: 'video', hook: 'Worn for 12 hours', angleId: 'g1' }],
    opportunities: [{ id: 'o1', opportunity: 'Own the wrinkle conversation', evidence: 'Competitors avoid it', relatedCompetitorIds: ['c1', 'c9'], relatedSignalIds: ['s1'] }],
    risks: [{ id: 'r1', risk: 'Greenwashing claims', mitigation: 'Only state certified facts' }],
    nextSteps: ['Test angle g1 on Meta with two creatives'],
    assumptions: [], dataGaps: ['Competitor ad examples could not be retrieved — check the Meta Ad Library'],
    confidence: 'moderate',
  }, extra || {});
}
function synthResponse() {
  const full = JSON.stringify(report());
  if (AI.synth === 'full') return { choices: [{ message: { content: full }, finish_reason: 'stop' }], usage: { prompt_tokens: 5200, completion_tokens: 2100 } };
  if (AI.synth === 'prose') return { choices: [{ message: { content: 'Here is your research:\n```json\n' + full + '\n```\nHope this helps!' }, finish_reason: 'stop' }] };
  if (AI.synth === 'truncated') { const cut = full.slice(0, full.indexOf('"risks"') + 30); return { choices: [{ message: { content: cut }, finish_reason: 'length' }] }; }
  if (AI.synth === 'garbage') return { choices: [{ message: { content: 'I cannot help with that.' }, finish_reason: 'stop' }] };
  if (AI.synth === 'empty') return { choices: [{ message: { content: JSON.stringify({ summary: 'Too vague to research.', competitors: [] }) }, finish_reason: 'stop' }] };
  return null;
}
async function fakeAiml({ path: p, body }) {
  if (p !== '/v1/chat/completions') return ok();
  if (body.model === 'perplexity/sonar' && AI.searchDelay) await sleep(AI.searchDelay);
  if (body.model !== 'perplexity/sonar' && AI.synthDelay) await sleep(AI.synthDelay);
  AI.calls.push({ model: body.model, max_tokens: body.max_tokens, system: body.messages && body.messages[0] && body.messages[0].content, user: body.messages && body.messages[1] && body.messages[1].content });
  if (AI.delayMs) await sleep(AI.delayMs);
  if (body.model === 'perplexity/sonar') {
    if (AI.search === 'down') return json(503, { error: { message: 'search unavailable' } });
    if (AI.search === 'empty') return json(200, { choices: [{ message: { content: 'nothing' } }], search_results: [], citations: [] });
    return json(200, SEARCH_OK);
  }
  if (AI.synth === 'down') return json(503, { error: { message: 'upstream unavailable' } });
  if (AI.synth === 'reject') return json(400, { error: { message: 'bad request' } });
  return json(200, synthResponse());
}

const prof = (id) => rows('profiles').find((p) => p.id === id);
async function ask(tok, body, key) {
  const r = await realFetch(BASE + '/api/research/query', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Idempotency-Key': key || ('k-' + Math.random().toString(36).slice(2)) }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: JSON.stringify(body) });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const COST = 25;

(async () => {
  const quiet = { log: console.log };
  const noop = () => {}; console.log = noop; console.warn = noop; console.error = noop; console.info = noop;
  require(path.join(SERVER_DIR, 'server.js'));
  const fetcher = require(path.join(SERVER_DIR, 'services/urlContextFetcher.js'));
  const RR = require(path.join(SERVER_DIR, 'services/researchReport.js'));
  // Website fetches are faked (no DNS/network in tests).
  const SITES = { 'https://linnenco.nl': { ok: true, url: 'https://linnenco.nl', domain: 'linnenco.nl', title: 'Linnen & Co — linen shirts', description: 'Linen shirts made in Europe', text: 'Linnen & Co sells breathable linen shirts. Free shipping in NL.' } };
  let siteCalls = [];
  fetcher.fetchUrlContext = async (u) => { siteCalls.push(u); return SITES[u] || { ok: false, url: u, reason: 'Could not reach that page.', code: 'unreachable' }; };
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
  for (const [t, id] of [['tok_ann', 'ann'], ['tok_ben', 'ben'], ['tok_fre', 'fre'], ['tok_low', 'low']]) TOKENS[t] = { id, email: id + '@example.invalid', created_at: '2026-01-01T00:00:00Z' };

  say('\nA. Pure helpers');
  check('search query adds industry and country, never an assumed country', RR.composeSearchQuery('Who are my competitors?', { industry: 'Apparel', countryName: 'Netherlands' }) === 'Who are my competitors? (Apparel, Netherlands)' && RR.composeSearchQuery('Who are my competitors?', {}) === 'Who are my competitors?');
  const p1 = RR.parseModelJson('Sure!\n```json\n{"summary":"x","competitors":[]}\n```');
  check('parser: prose and fences around the JSON are tolerated', p1 && p1.result.summary === 'x' && !p1.repaired);
  const cut = RR.parseModelJson('{"summary":"x","competitors":[{"id":"c1","name":"A"},{"id":"c2","name":"B","positioning":"half');
  check('parser: cut-off output keeps complete items and fields, drops the cut-off text', cut && cut.repaired && cut.result.competitors.length === 2 && cut.result.competitors[1].name === 'B' && !('positioning' in cut.result.competitors[1]), cut);
  check('parser: non-JSON → null', RR.parseModelJson('I cannot help') === null);
  const sysNoGeo = RR.buildSystemPrompt({});
  check('prompt without a country forbids assuming the US', /Do NOT assume the United States/.test(sysNoGeo));
  check('prompt forbids invented metrics and ad-performance claims', /Never invent numbers/.test(sysNoGeo) && /Never say an ad or approach "performs"/.test(sysNoGeo));

  say('\nB. Full research with live sources (Netherlands business)');
  let b0 = prof('ann').credits_balance;
  AI.calls.length = 0; siteCalls = [];
  let r = await ask('tok_ann', { question: 'Who are my main competitors and what do they advertise?' });
  const R1 = r.body;
  check('200 with a structured report', r.status === 200 && R1.summary && R1.competitors.length === 3 && R1.angles.length === 1 && R1.creativeConcepts.length === 1 && R1.risks.length === 1 && R1.nextSteps.length === 1, r.status);
  check('exactly 2 AI calls: one web search (sonar) + one synthesis', AI.calls.length === 2 && AI.calls[0].model === 'perplexity/sonar' && AI.calls[1].model !== 'perplexity/sonar', AI.calls.map((c) => c.model));
  check('search query carries industry + country (Netherlands), not the US', /\(Apparel, Netherlands\)/.test(AI.calls[0].user) && /in Netherlands/.test(AI.calls[0].system), AI.calls[0]);
  check('synthesis output is bounded (max_tokens 4000)', AI.calls[1].max_tokens === 4000);
  check('own website fetched once (no AI cost) and used as evidence w1', siteCalls.length === 1 && siteCalls[0] === 'https://linnenco.nl' && R1.ownWebsite.ok && R1.urlSources[0].provenance === 'own_website' && /OWN WEBSITE/.test(AI.calls[1].system));
  check('web sources are real search results, tracking params stripped', R1.webSources.length === 3 && R1.webSources[0].url === 'https://www.linnenhuis.nl' && R1.retrieval.ok && R1.retrieval.sourceCount === 3);
  const c2 = R1.competitors.find((c) => c.id === 'c2'), c3 = R1.competitors.find((c) => c.id === 'c3');
  check('VERIFIED only with a really retrieved source; invented source id ws99 dropped', R1.competitors[0].basis === 'verified' && c2.basis === 'verified' && JSON.stringify(c2.sourceIds) === '["ws2"]' && c3.basis === 'inference');
  check('own-website evidence counts as verified (signal s2 → w1)', R1.customerSignals.find((s) => s.id === 's2').basis === 'verified' && R1.customerSignals.find((s) => s.id === 's1').basis === 'inference');
  check('strategy sections are labelled recommendation', [].concat(R1.angles, R1.audiences, R1.creativeConcepts, R1.opportunities, R1.risks).every((x) => x.basis === 'recommendation'));
  check('dangling links removed (audience zz, opportunity c9)', JSON.stringify(R1.audiences[0].relatedSignalIds) === '["s2"]' && JSON.stringify(R1.opportunities[0].relatedCompetitorIds) === '["c1"]');
  check('competitor website normalised to https', R1.competitors[0].website === 'https://linnenhuis.nl');
  check('counts summarise verified / inference / recommendations', R1.counts.verified >= 4 && R1.counts.inference >= 2 && R1.counts.recommendations >= 5, R1.counts);
  check('market country reported; disclaimer says web-grounded; data gaps passed through', R1.market_country === 'Netherlands' && R1.sourceType === 'web_grounded' && R1.dataGaps.length === 1);
  check('25 credits charged once', prof('ann').credits_balance === b0 - COST, b0 - prof('ann').credits_balance);
  check('report saved to the account before answering', !!R1.reportId && rows('creative_assets').some((x) => x.id === R1.reportId && x.kind === 'research' && x.user_id === 'ann'));
  check('no API key in the response', !JSON.stringify(R1).includes('aiml-test-key'));

  say('\nC. Saved research: list, reopen, other users, library');
  let x = await call('GET', '/api/research/reports', 'tok_ann');
  check('list shows the saved report with question + summary', x.status === 200 && x.body.reports.length === 1 && x.body.reports[0].question.startsWith('Who are my main competitors') && x.body.reports[0].sourceCount === 4, x.body);
  x = await call('GET', '/api/research/reports/' + R1.reportId, 'tok_ann');
  check('reopen returns the full report', x.status === 200 && x.body.report.competitors.length === 3 && x.body.report.reportId === R1.reportId && !!x.body.report.savedAt);
  x = await call('GET', '/api/research/reports/' + R1.reportId, 'tok_ben');
  check('another account: 404', x.status === 404);
  x = await call('GET', '/api/research/reports', 'tok_ben');
  check('another account sees no reports', x.status === 200 && x.body.reports.length === 0);
  x = await call('GET', '/api/research/reports', null);
  check('no session → 401', x.status === 401);
  x = await call('GET', '/api/creative/assets', 'tok_ann');
  check('creative library does not list research reports', x.status === 200 && !(x.body.assets || []).some((a) => a.kind === 'research'), x.body);
  x = await call('DELETE', '/api/research/reports/' + R1.reportId, 'tok_ann');
  const arch = rows('creative_assets').find((a) => a.id === R1.reportId);
  check('remove = archive (row kept, hidden from the list)', x.status === 200 && arch && arch.archived === true && (await call('GET', '/api/research/reports', 'tok_ann')).body.reports.length === 0);
  arch.archived = false;

  say('\nD. No country, no website, search down');
  AI.search = 'down'; AI.calls.length = 0; siteCalls = [];
  b0 = prof('ben').credits_balance;
  r = await ask('tok_ben', { question: 'Which advertising angles should I test?' });
  check('search unavailable → still a report, honestly marked unverified', r.status === 200 && r.body.retrieval.ok === false && r.body.webSources.length === 0 && r.body.sourceType === 'ai_synthesis', r.body.retrieval);
  check('nothing marked verified without sources', [].concat(r.body.competitors, r.body.customerSignals, r.body.trends).every((i) => i.basis === 'inference'));
  check('no country → prompt forbids assuming one, no website fetched', /Do NOT assume the United States/.test(AI.calls[AI.calls.length - 1].system) && siteCalls.length === 0 && r.body.market_country === null && r.body.ownWebsite === null);
  check('charged once', prof('ben').credits_balance === b0 - COST);
  AI.search = 'ok';

  say('\nE. Bad provider output, failures, refunds');
  AI.synth = 'prose';
  r = await ask('tok_ann', { question: 'What messaging is common in my market?' });
  check('JSON wrapped in prose/fences → parsed fine', r.status === 200 && r.body.competitors.length === 3 && !r.body.partial);
  AI.synth = 'truncated';
  b0 = prof('ann').credits_balance;
  r = await ask('tok_ann', { question: 'Full market overview please' });
  check('output cut off at the token limit → partial report (not a failure), charged', r.status === 200 && r.body.partial === true && r.body.competitors.length === 3 && prof('ann').credits_balance === b0 - COST, { status: r.status, partial: r.body.partial });
  AI.synth = 'garbage';
  b0 = prof('ann').credits_balance;
  r = await ask('tok_ann', { question: 'Who are my competitors?' });
  await sleep(50);
  check('non-JSON answer → 502 RESEARCH_INVALID, refunded', r.status === 502 && r.body.code === 'RESEARCH_INVALID' && r.body.creditsRefunded === true && prof('ann').credits_balance === b0, r.body);
  AI.synth = 'empty';
  r = await ask('tok_ann', { question: 'asdf' });
  await sleep(50);
  check('nothing usable → no-results answer, refunded, not saved', r.status === 200 && r.body.creditsRefunded === true && prof('ann').credits_balance === b0 && !r.body.reportId, { status: r.status, refunded: r.body.creditsRefunded });
  AI.synth = 'down';
  r = await ask('tok_ann', { question: 'Who are my competitors?' });
  await sleep(50);
  check('provider unavailable → 503 PROVIDER_UNAVAILABLE, refunded', r.status === 503 && r.body.code === 'PROVIDER_UNAVAILABLE' && prof('ann').credits_balance === b0, r.body);
  AI.synth = 'reject';
  r = await ask('tok_ann', { question: 'Who are my competitors?' });
  await sleep(50);
  check('provider rejects → 502, refunded', r.status === 502 && prof('ann').credits_balance === b0, r.body);
  AI.synth = 'full';

  say('\nF. Timeouts (search and synthesis limits)');
  const prov2 = require(path.join(SERVER_DIR, 'providers/aimlProvider.js'));
  check('per-call timeout supported by the provider client', /timeoutMs/.test(prov2.generateText.toString()));
  AI.searchDelay = 1200; let tb = prof('ann').credits_balance;
  r = await ask('tok_ann', { question: 'Search too slow' });
  check('slow web search → stopped at its limit, research continues unverified', r.status === 200 && r.body.retrieval.ok === false && /timed out/i.test(r.body.retrieval.reason || '') && prof('ann').credits_balance === tb - COST, r.body.retrieval);
  AI.searchDelay = 0; AI.synthDelay = 2000; tb = prof('ann').credits_balance;
  r = await ask('tok_ann', { question: 'Synthesis too slow' });
  await sleep(50);
  check('slow synthesis → 504 RESEARCH_TIMEOUT, refunded (never left hanging)', r.status === 504 && r.body.code === 'RESEARCH_TIMEOUT' && prof('ann').credits_balance === tb, r.body);
  AI.synthDelay = 0;
  await sleep(600);

  say('\nG. Access, credits, duplicates');
  r = await ask(null, { question: 'x' });
  check('no session → 401', r.status === 401);
  r = await ask('tok_fre', { question: 'x' });
  check('Free plan → 403 PLAN_REQUIRED, no AI call', r.status === 403 && r.body.code === 'PLAN_REQUIRED');
  AI.calls.length = 0;
  r = await ask('tok_low', { question: 'Who are my competitors?' });
  check('not enough credits → 402 before any AI call', r.status === 402 && AI.calls.length === 0);
  r = await ask('tok_ann', { question: '' });
  check('empty question → 400', r.status === 400);
  r = await ask('tok_ann', { question: 'x'.repeat(501) });
  check('over-long question → 400', r.status === 400);
  b0 = prof('ann').credits_balance; AI.calls.length = 0;
  const r1 = await ask('tok_ann', { question: 'Same question twice' }, 'dup-key-research-1');
  const r2 = await ask('tok_ann', { question: 'Same question twice' }, 'dup-key-research-1');
  check('same idempotency key twice → one research, one charge', r1.status === 200 && r2.status === 409 && prof('ann').credits_balance === b0 - COST && AI.calls.length === 2, { s2: r2.status, calls: AI.calls.length });
  AI.delayMs = 300; b0 = prof('ann').credits_balance;
  const [d1, d2] = await Promise.all([ask('tok_ann', { question: 'Parallel one' }), ask('tok_ann', { question: 'Parallel two' })]);
  AI.delayMs = 0;
  check('two researches at once → one runs, the other refused uncharged', [d1.status, d2.status].sort().join(',') === '200,409' && prof('ann').credits_balance === b0 - COST, [d1.status, d2.status]);

  say('\nH. Research → Create');
  const pk = await realFetch(BASE + '/api/ai/create-ad', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_ann', 'X-Idempotency-Key': 'ca-1' },
    body: JSON.stringify({ product: 'Linen shirts', goal: 'Sales', platforms: ['meta'], researchContext: { question: R1.question, findings: [{ group: 'Angle', text: 'Wrinkle-relaxed look — Linen that looks better lived-in' }, { group: 'Audience', text: 'Urban professionals 25–45' }] } }) });
  const createCall = AI.calls.filter((c) => c.model !== 'perplexity/sonar').pop();
  check('research angle + audience reach the campaign generation prompt as research context', pk.status < 500 && createCall && /Wrinkle-relaxed look/.test((createCall.system || '') + (createCall.user || '')) && /Urban professionals/.test((createCall.system || '') + (createCall.user || '')), { status: pk.status });
  check('no unexpected outbound requests', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.info('CRASH', e && e.stack || e); process.exit(2); });
