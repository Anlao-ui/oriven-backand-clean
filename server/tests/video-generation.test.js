// ════════════════════════════════════════════════════════════════
// Create Video Ad generation — end to end with a FAKE provider.
//
// Runs the REAL server.js, providers/aimlProvider.js, paidActions,
// creditManager and videoJobs. Only the AIML endpoint (AIML_BASE_OVERRIDE),
// the provider's video CDN and Supabase storage are faked; Supabase data,
// Stripe, email and cron are in-memory mocks. No real generation, no cost.
//
// Covers: current Kling model ids and request schema (text- and image-to-
// video), submission + credit charge, polling (queued / generating /
// completed / completed-without-link / error), durable storage of the
// finished video (and its fallbacks), plain error messages, refunds on
// failure exactly once, idempotency and the one-at-a-time lane, 402 before
// any provider call, abandoned-job refunds, sign-in.
//
// RUN: node tests/video-generation.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5616;
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
  const side = typeof sideFetch === 'function' ? sideFetch(u, opts) : null;
  if (side) return side;
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

// ── Fake provider + storage + video CDN ──
const VIDEO_BYTES = Buffer.alloc(4096, 7);
const CDN = { downloads: 0, hugeLength: false, fail: false };
const STORE = { enabled: true, files: {}, uploads: 0 };
const JOBS = {};
let seq = 0;
const PROV = { submitFail: null, failTimes: 1, delay: 0, posts: [] };
async function provider({ path: p, body }) {
  if (p === '/v2/video/generations') {
    PROV.posts.push(body);
    if (PROV.delay) await sleep(PROV.delay);
    if (PROV.submitFail) { const f = PROV.submitFail; if (--PROV.failTimes <= 0) { PROV.submitFail = null; PROV.failTimes = 1; } return json(f.status, f.body); }
    const id = 'gen_' + (++seq) + '_abcdef';
    JOBS[id] = { status: 'queued', url: null };
    return json(200, { id, status: 'queued' });
  }
  if (p.indexOf('/v2/video/generations?') === 0) {
    const id = new URLSearchParams(p.split('?')[1]).get('generation_id');
    const j = JOBS[id];
    if (!j) return json(404, { error: { name: 'NotFound', message: 'generation not found' } });
    return json(200, { id, status: j.status, video: j.url ? { url: j.url } : null, error: j.status === 'error' ? { name: 'GenerationError', message: j.reason || 'Kling render failed: internal error 5021' } : null });
  }
  return ok();
}
function sideFetch(u, opts) {
  if (u.startsWith('https://cdn.example.invalid/')) {
    CDN.downloads++;
    if (CDN.fail) return new Response('nope', { status: 403 });
    return new Response(VIDEO_BYTES, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(CDN.hugeLength ? 40 * 1024 * 1024 : VIDEO_BYTES.length) } });
  }
  if (u.startsWith('https://storage.mock.invalid/')) {
    const key = u.slice('https://storage.mock.invalid/'.length);
    return new Response(null, { status: STORE.files[key] ? 200 : 404 });
  }
  return null;
}
supabaseMock.storage = { from: () => ({
  upload: async (p, buf, o) => { if (!STORE.enabled) return { error: { message: 'storage disabled' } }; STORE.uploads++; STORE.files[p] = { size: buf.length, type: o && o.contentType, upsert: !!(o && o.upsert) }; return { error: null }; },
  getPublicUrl: (p) => ({ data: { publicUrl: 'https://storage.mock.invalid/' + p } }),
}) };

const CURRENT_KLING = ['klingai/v2.5-turbo/pro/text-to-video', 'klingai/v2.5-turbo/pro/image-to-video']; // verified in GET https://api.aimlapi.com/models (2026-10-15)
const RETIRED = ['kling-video/v1.6/pro/text-to-video', 'kling-video/v1/standard/text-to-video'];
let paidActions, videoJobs, aiml, router;
const prof = (id) => rows('profiles').find((p) => p.id === id);
const COST = 200;
async function post(tok, body, key) {
  const r = await realFetch(BASE + '/api/generate-ugc-video', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'X-Idempotency-Key': key || ('k-' + Math.random().toString(36).slice(2)) }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: JSON.stringify(body) });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, body: j };
}
const status = (id, tok) => call('GET', '/api/ugc-video-status/' + id, tok || 'tok_alice');

(async () => {
  const quiet = { log: console.log };
  const noop = () => {}; console.log = noop; console.warn = noop; console.error = noop; console.info = noop;
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  videoJobs = require(path.join(SERVER_DIR, 'services/videoJobs.js'));
  aiml = require(path.join(SERVER_DIR, 'providers/aimlProvider.js'));
  router = require(path.join(SERVER_DIR, 'services/modelRouter.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);
  prov.handler = provider;
  rows('profiles').push(
    { id: 'alice', subscription_status: 'creator', credits_balance: 5000, onboarding_completed: true },
    { id: 'bob', subscription_status: 'creator', credits_balance: 5000, onboarding_completed: true },
    { id: 'poor', subscription_status: 'creator', credits_balance: 50, onboarding_completed: true },
  );
  TOKENS.tok_alice = { id: 'alice', email: 'alice@example.invalid', created_at: '2026-01-01T00:00:00Z' };
  TOKENS.tok_bob = { id: 'bob', email: 'bob@example.invalid', created_at: '2026-01-01T00:00:00Z' };
  TOKENS.tok_poor = { id: 'poor', email: 'poor@example.invalid', created_at: '2026-01-01T00:00:00Z' };

  say('\nA. Model and request format (current AIML schema)');
  check('router video model is a current Kling id, not a retired one', CURRENT_KLING.includes(router.MODELS.aiml.video) && !RETIRED.includes(router.MODELS.aiml.video), router.MODELS.aiml);
  check('image-to-video uses the matching image-to-video model', router.MODELS.aiml.videoFromImage === 'klingai/v2.5-turbo/pro/image-to-video');
  let b0 = prof('alice').credits_balance;
  let r = await post('tok_alice', { script: 'Morning coffee, done right. [0:03] Pour shot.' });
  const id1 = r.body && r.body.videoId;
  const sent = PROV.posts[PROV.posts.length - 1];
  check('Create video submits: 200 + job id', r.status === 200 && !!id1 && r.body.status === 'processing', r);
  check('payload: current model, integer duration 5, 9:16, prompt carries the script', sent.model === 'klingai/v2.5-turbo/pro/text-to-video' && sent.duration === 5 && typeof sent.duration === 'number' && sent.aspect_ratio === '9:16' && /Morning coffee/.test(sent.prompt), sent);
  check('payload has only schema fields', Object.keys(sent).every((k) => ['model', 'prompt', 'aspect_ratio', 'duration', 'negative_prompt'].includes(k)), Object.keys(sent));
  check('credits deducted once at submission (' + COST + ')', prof('alice').credits_balance === b0 - COST, { before: b0, after: prof('alice').credits_balance });
  check('API key never in the response', !JSON.stringify(r.body).includes('aiml-test-key'));
  r = await call('POST', '/api/video-ads/generate', 'tok_alice', { mode: 'script', script: 'Steam rising from a cup', length: 10 });
  let s2 = PROV.posts[PROV.posts.length - 1];
  check('Video Ads (script): duration 10 as an integer, 16:9', r.status === 200 && s2.duration === 10 && s2.aspect_ratio === '16:9' && s2.model === 'klingai/v2.5-turbo/pro/text-to-video', s2);
  r = await call('POST', '/api/video-ads/generate', 'tok_alice', { mode: 'image', imageUrl: 'https://img.example.invalid/a.png', imageUrl2: 'https://img.example.invalid/b.png', prompt: 'push in', length: 5 });
  s2 = PROV.posts[PROV.posts.length - 1];
  check('Video Ads (image): image-to-video model, image_url + tail_image_url, no aspect_ratio/image_end_url', r.status === 200 && s2.model === 'klingai/v2.5-turbo/pro/image-to-video' && s2.image_url && s2.tail_image_url === 'https://img.example.invalid/b.png' && !('aspect_ratio' in s2) && !('image_end_url' in s2) && s2.duration === 5, s2);

  say('\nB. Polling: queued → generating → completed');
  let x = await status(id1);
  check('queued → status queued, no URL, not settled', x.status === 200 && x.body.status === 'queued' && x.body.videoUrl === null && !x.body.creditsRefunded, x);
  JOBS[id1].status = 'generating';
  x = await status(id1);
  check('provider "generating" → processing', x.body.status === 'processing', x);
  JOBS[id1].status = 'completed';
  x = await status(id1);
  check('"completed" without a link stays processing (not a usable result, not settled)', x.body.status === 'processing' && !x.body.videoUrl, x);
  JOBS[id1].url = 'https://cdn.example.invalid/' + id1 + '.mp4';
  x = await status(id1);
  const stored = x.body.videoUrl;
  check('completed → video copied to storage, stable link returned', x.body.status === 'completed' && /^https:\/\/storage\.mock\.invalid\/generated\/alice\/video-gen_/.test(stored) && STORE.uploads === 1 && CDN.downloads === 1, { x, uploads: STORE.uploads });
  const file = STORE.files[stored.slice('https://storage.mock.invalid/'.length)];
  check('stored as video/mp4 with the full bytes', file && file.type === 'video/mp4' && file.size === VIDEO_BYTES.length, file);
  x = await status(id1);
  check('polling again returns the same link without downloading again', x.body.videoUrl === stored && CDN.downloads === 1 && STORE.uploads === 1, { url: x.body.videoUrl, downloads: CDN.downloads });
  check('success keeps the charge (no refund)', prof('alice').credits_balance === b0 - COST - COST - COST && !x.body.creditsRefunded, prof('alice').credits_balance);
  x = await status(id1, 'tok_bob');
  check('another account: 404, nothing revealed', x.status === 404 && !JSON.stringify(x.body).includes('cdn.example'), x);

  say('\nC. Failure, refunds and retries');
  b0 = prof('alice').credits_balance;
  r = await post('tok_alice', { script: 'A failing render' });
  const id2 = r.body.videoId;
  check('charged at submission', prof('alice').credits_balance === b0 - COST);
  JOBS[id2].status = 'error'; JOBS[id2].reason = 'Kling render failed: internal error 5021';
  x = await status(id2);
  await sleep(50);
  check('provider error → failed, plain message (no provider internals), credits returned', x.body.status === 'failed' && x.body.creditsRefunded === true && !/5021|Kling/.test(x.body.error) && /couldn’t be rendered/.test(x.body.error) && prof('alice').credits_balance === b0, { x, bal: prof('alice').credits_balance });
  x = await status(id2);
  check('polling the failed job again never refunds twice', prof('alice').credits_balance === b0 && !x.body.creditsRefunded, { bal: prof('alice').credits_balance, x: x.body });
  JOBS.gen_policy = { status: 'error', reason: 'content violates safety policy' };
  videoJobs.record('gen_policy', 'alice');
  x = await status('gen_policy');
  check('content-policy failure gets a specific message', /declined this content/.test(x.body.error), x.body);
  b0 = prof('alice').credits_balance;
  PROV.submitFail = { status: 404, body: { error: { message: 'Model kling-video/v1.6/pro/text-to-video not found' } } };
  r = await post('tok_alice', { script: 'Rejected request' });
  await sleep(50);
  check('provider rejects the request → plain error, nothing charged in the end', r.status === 502 && r.body.code === 'VIDEO_REJECTED' && !/kling|not found/i.test(r.body.error) && r.body.creditsRefunded === true && prof('alice').credits_balance === b0, { r, bal: prof('alice').credits_balance });
  PROV.submitFail = { status: 503, body: { error: { message: 'upstream unavailable' } } }; PROV.failTimes = 10; // every retry fails too
  r = await post('tok_alice', { script: 'Provider down' });
  await sleep(50);
  check('provider unavailable → 503 PROVIDER_UNAVAILABLE, credits returned', r.status === 503 && r.body.code === 'PROVIDER_UNAVAILABLE' && prof('alice').credits_balance === b0, { r, bal: prof('alice').credits_balance });
  PROV.submitFail = null; PROV.failTimes = 1;
  const postsBefore = PROV.posts.length;
  r = await post('tok_poor', { script: 'No credits' });
  check('not enough credits → 402 before the provider is called', r.status === 402 && r.body.code === 'CREDITS_EXHAUSTED' && PROV.posts.length === postsBefore && prof('poor').credits_balance === 50, r);

  say('\nD. Duplicate protection');
  b0 = prof('alice').credits_balance;
  const p0 = PROV.posts.length;
  r = await post('tok_alice', { script: 'Same request twice' }, 'same-key-1');
  const again = await post('tok_alice', { script: 'Same request twice' }, 'same-key-1');
  check('same idempotency key twice → one job, one charge, second refused', r.status === 200 && again.status === 409 && PROV.posts.length === p0 + 1 && prof('alice').credits_balance === b0 - COST, { again, posts: PROV.posts.length - p0 });
  b0 = prof('alice').credits_balance;
  PROV.delay = 300; // the provider takes a moment to accept, so the two requests overlap
  const [c1, c2] = await Promise.all([post('tok_alice', { script: 'Parallel A' }), post('tok_alice', { script: 'Parallel B' })]);
  PROV.delay = 0;
  const codes = [c1.status, c2.status].sort().join(',');
  const refused = [c1, c2].find((z) => z.status === 409);
  check('two different videos at the same moment: one starts, the other is refused uncharged (ACTION_IN_PROGRESS)', codes === '200,409' && refused.body.code === 'ACTION_IN_PROGRESS' && prof('alice').credits_balance === b0 - COST, { codes, bal: b0 - prof('alice').credits_balance });
  r = await post('tok_alice', { script: 'Parallel B' }, 'retry-after-409');
  check('sent again after the first finished submitting → accepted (Create submits one at a time)', r.status === 200, r);

  say('\nE. Storage fallbacks (the video is never lost)');
  STORE.enabled = false;
  r = await post('tok_alice', { script: 'No storage' }); let id3 = r.body.videoId;
  JOBS[id3] = { status: 'completed', url: 'https://cdn.example.invalid/' + id3 + '.mp4' };
  x = await status(id3);
  check('storage unavailable → provider link returned, job still completes', x.body.status === 'completed' && x.body.videoUrl === JOBS[id3].url, x.body);
  STORE.enabled = true; CDN.hugeLength = true; const up0 = STORE.uploads;
  r = await post('tok_alice', { script: 'Huge file' }); id3 = r.body.videoId;
  JOBS[id3] = { status: 'completed', url: 'https://cdn.example.invalid/' + id3 + '.mp4' };
  x = await status(id3);
  check('video over the 15 MB bucket limit → provider link, nothing uploaded', x.body.videoUrl === JOBS[id3].url && STORE.uploads === up0, { x: x.body, uploads: STORE.uploads - up0 });
  CDN.hugeLength = false;

  say('\nF. Abandoned jobs are refunded');
  b0 = prof('alice').credits_balance;
  r = await post('tok_alice', { script: 'Stuck forever' }); const id4 = r.body.videoId;
  JOBS[id4].status = 'generating';
  const row = rows('credit_actions').find((a) => a.async_job_id === id4);
  check('job recorded as awaiting its result', !!row && row.status === 'awaiting_async', row);
  row.created_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  await paidActions.sweep({ getVideoStatus: (j) => aiml.getVideoStatus(j) });
  check('still rendering after 2 h → left alone (charge kept)', row.status === 'awaiting_async' && prof('alice').credits_balance === b0 - COST, row.status);
  row.created_at = new Date(Date.now() - 7 * 3600e3).toISOString();
  await paidActions.sweep({ getVideoStatus: (j) => aiml.getVideoStatus(j) });
  await sleep(50);
  check('still rendering after 7 h → refunded once', row.status === 'refunded' && prof('alice').credits_balance === b0, { status: row.status, bal: prof('alice').credits_balance - b0 });
  await paidActions.sweep({ getVideoStatus: (j) => aiml.getVideoStatus(j) });
  check('sweep again → no second refund', prof('alice').credits_balance === b0);

  say('\nG. Sign-in');
  r = await post(null, { script: 'x' });
  check('no session → 401, nothing sent', r.status === 401, r);
  x = await call('GET', '/api/ugc-video-status/' + id1, null);
  check('status without session → 401', x.status === 401);
  check('no unexpected outbound requests', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.info('CRASH', e && e.stack || e); process.exit(2); });
