// ════════════════════════════════════════════════════════════════
// Video generation ownership: the status endpoints only answer the
// account that started the job.
//
// Runs the REAL server.js, providers/aimlProvider.js and services/
// videoJobs.js; only the provider's HTTP endpoint is faked (AIML_BASE_
// OVERRIDE) and Supabase, Stripe, email and cron are in-memory mocks —
// nothing leaves this process and no real data is touched.
//
// Covers /api/ugc-video-status, /api/video-ads/status and
// /api/motion-graphics/status: missing and invalid sign-in (401),
// another user's job (404, provider never asked, nothing settled),
// unknown/malformed ids (same 404), the owner (200 + URL, charges settle
// as before), ownership after a restart (credit_actions, creative_assets).
//
// RUN: node tests/video-ownership.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..');
const PORT = 5614;
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

// Fake provider: video submissions get ids; status answers from JOBS.
const JOBS = {};
let seq = 0;
const statusCalls = () => prov.calls.filter((c) => c.path.indexOf('/v2/video/generations?') === 0);
function handler({ path: p }) {
  if (p === '/v2/video/generations' || p.indexOf('/v2/video/generations/') === 0 && !p.includes('?')) { const id = 'gen_' + (++seq) + '_abcdef'; JOBS[id] = { status: 'completed' }; return json(200, { id, status: 'queued' }); }
  if (p.indexOf('/v2/video/generations?') === 0) { const id = new URLSearchParams(p.split('?')[1]).get('generation_id'); const j = JOBS[id] || { status: 'completed' }; return json(200, { id, status: j.status, video: j.status === 'completed' ? { url: 'https://cdn.example.invalid/' + id + '.mp4' } : null, error: j.status === 'failed' ? 'render failed' : null }); }
  return ok();
}

const STATUS = { ugc: (id) => '/api/ugc-video-status/' + id, ads: (id) => '/api/video-ads/status/' + id, mg: (id) => '/api/motion-graphics/status/' + id };
let paidActions, spendGuard, videoJobs;
const prof = (id) => rows('profiles').find((p) => p.id === id);

(async () => {
  const quiet = { log: console.log };
  const noop = () => {}; console.log = noop; console.warn = noop; console.error = noop; console.info = noop;
  require(path.join(SERVER_DIR, 'server.js'));
  paidActions = require(path.join(SERVER_DIR, 'services/paidActions.js'));
  spendGuard = require(path.join(SERVER_DIR, 'services/spendGuard.js'));
  videoJobs = require(path.join(SERVER_DIR, 'services/videoJobs.js'));
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/get-subscription'); break; } catch (_) { await sleep(100); } }
  const say = (...a) => quiet.log(...a);
  prov.handler = handler;
  rows('profiles').push(
    { id: 'alice', subscription_status: 'creator', credits_balance: 5000, onboarding_completed: true },
    { id: 'bob', subscription_status: 'creator', credits_balance: 5000, onboarding_completed: true },
  );
  TOKENS.tok_alice = { id: 'alice', email: 'alice@example.invalid', created_at: '2026-01-01T00:00:00Z' };
  TOKENS.tok_bob = { id: 'bob', email: 'bob@example.invalid', created_at: '2026-01-01T00:00:00Z' };

  say('\nA. Alice starts one video on each route (real routes, fake provider)');
  const ids = {};
  let r = await call('POST', '/api/generate-ugc-video', 'tok_alice', { script: 'Morning coffee, done right.' }); ids.ugc = r.body && r.body.videoId;
  check('UGC video started', r.status === 200 && !!ids.ugc, r);
  r = await call('POST', '/api/video-ads/generate', 'tok_alice', { mode: 'script', script: 'A cup of coffee steaming on a table', length: 5 }); ids.ads = r.body && r.body.generationId;
  check('Video Ad started', r.status === 200 && !!ids.ads, r);
  r = await call('POST', '/api/motion-graphics/generate', 'tok_alice', { style: 'kinetic', duration: 5 }); ids.mg = r.body && r.body.generationId;
  check('Motion Graphic started', r.status === 200 && !!ids.mg, r);
  await sleep(150);
  const aliceAfterStart = prof('alice').credits_balance;

  say('\nB. No sign-in / invalid sign-in: 401, provider never asked');
  prov.calls.length = 0;
  for (const k of Object.keys(STATUS)) {
    const a = await call('GET', STATUS[k](ids[k]), null), b = await call('GET', STATUS[k](ids[k]), 'not-a-session');
    check(`${k}: no token → 401, invalid token → 401, no status or URL in the body`, a.status === 401 && b.status === 401 && !/cdn\.example|completed/.test(JSON.stringify([a.body, b.body])), [a, b]);
  }
  check('…zero provider status calls', statusCalls().length === 0, prov.calls);

  say('\nC. Bob asks for Alice’s videos: 404, nothing about them returned or touched');
  prov.calls.length = 0;
  const bobBodies = [];
  for (const k of Object.keys(STATUS)) {
    JOBS[ids[k]].status = 'failed'; // even a failed job: Bob must not trigger its refund
    const x = await call('GET', STATUS[k](ids[k]), 'tok_bob'); bobBodies.push(x);
    check(`${k}: 404 NOT_FOUND`, x.status === 404 && x.body && x.body.code === 'NOT_FOUND', x);
    JOBS[ids[k]].status = 'completed';
  }
  check('Bob’s responses contain no status, URL or failure reason of Alice’s jobs', bobBodies.every((x) => !('status' in x.body) && !('videoUrl' in x.body) && !('failureReason' in x.body) && !/cdn\.example|gen_/.test(JSON.stringify(x.body))), bobBodies);
  check('…the provider was never asked about Alice’s jobs', statusCalls().length === 0, prov.calls);
  check('…and nothing was settled or refunded (Alice’s balance and actions unchanged)', prof('alice').credits_balance === aliceAfterStart && rows('credit_actions').filter((a) => a.user_id === 'alice').every((a) => a.status === 'awaiting_async'), rows('credit_actions').map((a) => [a.user_id, a.status]));

  say('\nD. Unknown and malformed ids: the same 404 (no probing)');
  const unk = await call('GET', STATUS.ads('gen_999_unknown'), 'tok_bob');
  const bad = await call('GET', STATUS.ugc('x'.repeat(300)), 'tok_alice');
  const odd = await call('GET', STATUS.mg(encodeURIComponent('../../etc')), 'tok_alice');
  check('unknown id → 404 with exactly the body Bob got for Alice’s job', unk.status === 404 && JSON.stringify(unk.body) === JSON.stringify(bobBodies[1].body), [unk, bobBodies[1]]);
  check('over-long id → 404; path-like id → 404; provider not asked', bad.status === 404 && odd.status === 404 && statusCalls().length === 0, [bad.status, odd.status]);

  say('\nE. Alice (the owner) gets her videos as before');
  prov.calls.length = 0;
  for (const k of Object.keys(STATUS)) {
    const x = await call('GET', STATUS[k](ids[k]), 'tok_alice');
    check(`${k}: 200 completed with the video URL`, x.status === 200 && x.body.status === 'completed' && x.body.videoUrl === 'https://cdn.example.invalid/' + ids[k] + '.mp4', x);
  }
  check('…three provider status calls (one per poll)', statusCalls().length === 3, statusCalls().length);
  await sleep(100);
  check('…and completing settles her charges as succeeded (credit logic unchanged)', rows('credit_actions').filter((a) => a.user_id === 'alice' && a.async_job_id).every((a) => a.status === 'succeeded'), rows('credit_actions').map((a) => [a.user_id, a.status, a.async_job_id]));

  say('\nF. After a restart (in-memory record gone): ownership comes from the database');
  r = await call('POST', '/api/video-ads/generate', 'tok_alice', { mode: 'script', script: 'Latte art close-up', length: 5 }); const later = r.body.generationId;
  r = await call('POST', '/api/generate-ugc-video', 'tok_alice', { script: 'Cold brew on a summer day.' }); const laterUgc = r.body.videoId;
  await sleep(150);
  videoJobs._resetForTests();
  const before = prof('alice').credits_balance;
  JOBS[laterUgc].status = 'failed';
  let x = await call('GET', STATUS.ugc(laterUgc), 'tok_bob');
  check('Bob still 404 (database says Alice)', x.status === 404, x);
  x = await call('GET', STATUS.ugc(laterUgc), 'tok_alice');
  await sleep(100);
  check('Alice: UGC job found via credit_actions; failed render refunded to her as before', x.status === 200 && x.body.status === 'failed' && x.body.creditsRefunded === true && prof('alice').credits_balance > before, { x, before, after: prof('alice').credits_balance });
  // Video Ads also saves the job in the asset library: still works with no credit_actions match.
  for (const a of rows('credit_actions')) if (a.async_job_id === later) a.async_job_id = null;
  x = await call('GET', STATUS.ads(later), 'tok_alice');
  check('Alice: Video Ad found via her creative_assets record', x.status === 200 && x.body.status === 'completed', x);
  x = await call('GET', STATUS.ads(later), 'tok_bob');
  check('Bob: same job still 404', x.status === 404, x);

  say('\nG. Unit: the ownership record');
  videoJobs._resetForTests();
  videoJobs.record('job_1', 'alice');
  check('owner true, other user false, unknown false, bad ids false', (await videoJobs.isOwner('job_1', 'alice')) === true && (await videoJobs.isOwner('job_1', 'bob')) === false && (await videoJobs.isOwner('job_2', 'alice')) === false && (await videoJobs.isOwner('', 'alice')) === false && (await videoJobs.isOwner('a/b', 'alice')) === false && (await videoJobs.isOwner('job_1', null)) === false);
  check('no other outbound requests', blocked.length === 0, blocked);

  say(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch((e) => { console.info('CRASH', e && e.stack || e); process.exit(2); });
