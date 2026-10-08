// Shared harness for the signup / first-ad / email suites: boots the REAL
// server.js with Supabase (data + auth admin), Stripe, cron and SMTP replaced
// by in-memory mocks, and every outbound request blocked unless a test
// installs its own handler. No .env, no real users, no emails, no AI calls.
const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..', '..');

function boot({ port, env }) {
  for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|RENDER|ENABLE_BACKGROUND|ONBOARDING|EMAIL|RESEND|FREE_FIRST_AD|SIGNUP_LIMIT|UNVERIFIED/.test(k)) delete process.env[k];
  Object.assign(process.env, {
    PORT: String(port), STRIPE_SECRET_KEY: 'sk_test_mock_only', STRIPE_WEBHOOK_SECRET: 'whsec_mock_only',
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'mock', AIML_API_KEY: 'mock-not-a-key', FRONTEND_URL: 'http://localhost:8899',
  }, env || {});

  const realFetch = globalThis.fetch;
  const net = { blocked: [], handler: null };
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url || url);
    if (new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${port}/`).test(u)) return realFetch(url, opts);
    if (net.handler) { const r = await net.handler(u, opts); if (r) return r; }
    net.blocked.push(u);
    throw new Error('network blocked in test: ' + u);
  };

  // ── stateful Supabase ──
  const TABLES = {}, MISSING = {}, UNIQUE = { email_sends: [['user_id', 'dedupe_key']], email_suppressions: [['email_hash']], free_first_ad_claims: [['user_id']] };
  const rows = (t) => (TABLES[t] = TABLES[t] || []);
  const writes = [];
  const parseOr = (expr) => {
    const parts = expr.split(',').map((p) => { const [c, op, ...v] = p.split('.'); return { c, op, v: v.join('.') }; });
    return (r) => parts.some(({ c, op, v }) => op === 'is' ? (v === 'null' ? r[c] == null : String(r[c]) === v) : op === 'eq' ? String(r[c]) === v : false);
  };
  class Q {
    constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.wantRows = false; this.cols = null; this.lim = null; }
    select(c) { if (this.op !== 'select') this.wantRows = true; else this.cols = c; return this; }
    insert(p) { this.op = 'insert'; this.p = p; return this; }
    upsert(p, o) { this.op = 'upsert'; this.p = p; this.oc = (o && o.onConflict) || 'id'; this.ignoreDup = !!(o && o.ignoreDuplicates); return this; }
    update(p) { this.op = 'update'; this.p = p; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
    in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
    gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
    lt(c, v) { this.f.push((r) => r[c] != null && r[c] < v); return this; }
    is(c, v) { this.f.push((r) => (r[c] == null) === (v == null)); return this; }
    or(e) { this.f.push(parseOr(e)); return this; }
    lte(c, v) { this.f.push((r) => r[c] != null && r[c] <= v); return this; }
    order() { return this; } range() { return this; } not() { return this; } gt() { return this; } ilike() { return this; } filter() { return this; } contains() { return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this._single = true; return this.run(); }
    single() { this._single = true; return this.run(); }
    then(a, b) { return this.run().then(a, b); }
    _missing(keys) {
      const m = MISSING[this.t];
      if (m === 'table') return { code: 'PGRST205', message: `Could not find the table 'public.${this.t}'` };
      if (!m || !m.size) return null;
      const bad = keys.find((k) => m.has(k));
      return bad ? { code: 'PGRST204', message: `Could not find the '${bad}' column of '${this.t}' in the schema cache` } : null;
    }
    async run() {
      await null;
      const all = rows(this.t);
      const sel = this.cols ? this.cols.split(',').map((s) => s.trim()) : [];
      const wk = this.p ? Object.keys(Array.isArray(this.p) ? this.p[0] : this.p) : [];
      const err = this._missing(sel.concat(wk)); if (err) return { data: null, error: err };
      const match = () => all.filter((r) => this.f.every((fn) => fn(r)));
      if (this.op === 'insert' || this.op === 'upsert') {
        const items = (Array.isArray(this.p) ? this.p : [this.p]).map((x) => ({ ...x }));
        const out = [];
        for (const it of items) {
          if (this.op === 'upsert') {
            const ex = all.find((r) => r[this.oc] === it[this.oc]);
            if (ex && this.ignoreDup) continue; // ON CONFLICT DO NOTHING
            if (ex) { Object.assign(ex, it); out.push(ex); writes.push([this.t, 'upsert', it]); continue; }
          }
          for (const u of UNIQUE[this.t] || []) if (all.some((r) => u.every((c) => r[c] === it[c]))) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          const row = Object.assign({ id: it.id || ('row_' + Math.random().toString(36).slice(2)), created_at: new Date().toISOString() }, it);
          all.push(row); out.push(row); writes.push([this.t, this.op, it]);
        }
        return { data: this.wantRows ? (this._single ? out[0] : out) : null, error: null };
      }
      if (this.op === 'update') { const m = match(); m.forEach((r) => { Object.assign(r, this.p); writes.push([this.t, 'update', this.p]); }); return { data: this.wantRows ? m.map((x) => ({ ...x })) : null, error: null }; }
      if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
      let m = match().map((x) => ({ ...x })); if (this.lim != null) m = m.slice(0, this.lim);
      return { data: this._single ? (m[0] || null) : m, error: null };
    }
  }
  const TOKENS = {};
  const AUTH = { users: [], createFail: null, deleted: [] };
  const rpcCalls = [];
  const supabaseMock = {
    from: (t) => new Q(t),
    rpc: async (name, args) => {
      rpcCalls.push(name);
      const p = rows('profiles').find((r) => r.id === (args && args.p_user_id));
      if (name === 'spend_credits' && p) { if ((p.credits_balance || 0) >= args.p_amount) { p.credits_balance -= args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; } return { data: [{ ok: false, balance: p.credits_balance || 0 }], error: null }; }
      if (name === 'refund_credits' && p) { p.credits_balance += args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; }
      return { data: null, error: null };
    },
    auth: {
      getUser: async (t) => TOKENS[t] ? { data: { user: TOKENS[t] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } },
      admin: {
        createUser: async ({ email, user_metadata }) => {
          if (AUTH.createFail) { const m = AUTH.createFail; AUTH.createFail = null; return { data: null, error: { message: m } }; }
          if (AUTH.users.some((u) => u.email === email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
          const user = { id: '00000000-0000-4000-8000-' + String(AUTH.users.length + 1).padStart(12, '0'), email, user_metadata, created_at: new Date().toISOString() };
          AUTH.users.push(user); TOKENS['tok_' + user.id] = user;
          return { data: { user }, error: null };
        },
        deleteUser: async (id) => { AUTH.deleted.push(id); return { error: null }; },
        listUsers: async () => ({ data: { users: AUTH.users }, error: null }),
      },
    },
  };
  const mail = [];
  class StripeMock { constructor() { return new Proxy({}, { get: (_, p) => new Proxy({}, { get: (__, m) => async () => { throw new Error('unexpected stripe call ' + String(p) + '.' + String(m)); } }) }); } }
  const cronJobs = [];
  const _load = Module._load;
  Module._load = function (req) {
    if (req === 'stripe') return StripeMock;
    if (req === '@supabase/supabase-js') return { createClient: () => supabaseMock };
    if (req === 'dotenv') return { config: () => ({ parsed: {} }) };
    if (req === 'node-cron') return { schedule: (expr, fn) => { cronJobs.push({ expr, fn }); return { stop() {} }; } };
    if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async (m) => { mail.push(m); return { messageId: 'm' + mail.length }; }, verify: async () => true }) };
    return _load.apply(this, arguments);
  };
  const BASE = `http://127.0.0.1:${port}`;
  async function call(method, p, tok, body, headers) {
    const r = await realFetch(BASE + p, { method, headers: Object.assign({}, tok ? { Authorization: 'Bearer ' + tok } : {}, body != null ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) {}
    return { status: r.status, body: j, headers: r.headers };
  }
  async function start() {
    const quiet = process.env.TEST_VERBOSE ? null : [console.log, console.warn, console.error];
    if (quiet) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
    require(path.join(SERVER_DIR, 'server.js'));
    for (let i = 0; i < 50; i++) { try { await realFetch(BASE + '/api/onboarding/state'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }
    return quiet;
  }
  return { SERVER_DIR, TABLES, MISSING, rows, writes, TOKENS, AUTH, rpcCalls, mail, cronJobs, net, call, start, realFetch, BASE };
}

function reporter() {
  const out = process.stdout.write.bind(process.stdout);
  let pass = 0, fail = 0;
  const log = (s) => out(s + '\n');
  const check = (name, ok, info) => { ok ? pass++ : fail++; log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); };
  const done = () => { log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0); };
  return { check, log, done };
}

module.exports = { boot, reporter };
