// Shared harness for the signup / first-ad / email suites: boots the REAL
// server.js with Supabase (data + auth admin), Stripe, cron and SMTP replaced
// by in-memory mocks, and every outbound request blocked unless a test
// installs its own handler. No .env, no real users, no emails, no AI calls.
const Module = require('module');
const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const legacyAccess = require('./legacyAccess');

function boot({ port, env }) {
  for (const k of Object.keys(process.env)) if (/STRIPE|SUPABASE|AIML|OPENAI|ANTHROPIC|SMTP|GOOGLE|META|TIKTOK|PINTEREST|SNAPCHAT|RENDER|ENABLE_BACKGROUND|ONBOARDING|EMAIL|RESEND|FREE_FIRST_AD|SIGNUP_LIMIT|UNVERIFIED/.test(k)) delete process.env[k];
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
  // The SSRF guard resolves hosts before fetching; mock hosts never resolve,
  // so give every name a public test address (requests still hit the stub above).
  require(path.join(SERVER_DIR, 'services', 'safeFetch'))._setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

  // ── stateful Supabase ──
  const TABLES = {}, MISSING = {}, UNIQUE = { email_sends: [['user_id', 'dedupe_key']], email_suppressions: [['email_hash']], free_first_ad_claims: [['user_id']], weekly_reports: [['user_id', 'week_start', 'scope']], onboarding_sessions: [['user_id']], stripe_webhook_events: [['id']] };
  const rows = (t) => (TABLES[t] = TABLES[t] || []);
  // Behaves like production after the 2026-10 access migration (legacy
  // backfill + spend_credits needs current paid access): helpers/legacyAccess.js.
  const backfill = () => legacyAccess.backfill(TABLES.profiles);
  const hasAccess = legacyAccess.spendAllowed;
  const writes = [];
  const READ = { fail: null }; // tests set READ.fail = (table, cols) => bool to make a read fail like a dropped connection
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
      if (this.t === 'profiles') backfill();
      const all = rows(this.t);
      const sel = this.cols ? this.cols.split(',').map((s) => s.trim()) : [];
      const wk = this.p ? Object.keys(Array.isArray(this.p) ? this.p[0] : this.p) : [];
      const err = this._missing(sel.concat(wk)); if (err) return { data: null, error: err };
      if (this.op === 'select' && READ.fail && READ.fail(this.t, sel)) return { data: null, error: { message: 'connection reset (test)' } };
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
      if (this.op === 'update') { const m = match(); m.forEach((r) => { Object.assign(r, this.p); writes.push([this.t, 'update', this.p]); }); return { data: this.wantRows ? (this._single ? (m[0] ? { ...m[0] } : null) : m.map((x) => ({ ...x }))) : null, error: null }; } // .maybeSingle()/.single(): one row or null, like Supabase
      if (this.op === 'delete') { const m = match(); TABLES[this.t] = all.filter((r) => !m.includes(r)); return { data: null, error: null }; }
      let m = match().map((x) => ({ ...x })); if (this.lim != null) m = m.slice(0, this.lim);
      return { data: this._single ? (m[0] || null) : m, error: null };
    }
  }
  const TOKENS = {};
  const AUTH = { users: [], createFail: null, deleted: [] };
  const rpcCalls = [];
  const RPC = { fail: null }; // tests set RPC.fail = (name) => bool to simulate an RPC / database outage
  const supabaseMock = {
    from: (t) => new Q(t),
    rpc: async (name, args) => {
      rpcCalls.push(name);
      if (RPC.fail && RPC.fail(name, args)) return { data: null, error: { message: 'rpc unavailable (test)' } };
      backfill();
      const p = rows('profiles').find((r) => r.id === (args && args.p_user_id));
      // spend_credits: like the SQL, nothing is spent without current paid access.
      if (name === 'spend_credits' && p && !hasAccess(p)) return { data: [{ ok: false, balance: 0 }], error: null };
      if (name === 'spend_credits' && p) { if ((p.credits_balance || 0) >= args.p_amount) { p.credits_balance -= args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; } return { data: [{ ok: false, balance: p.credits_balance || 0 }], error: null }; }
      // delete_account_data (docs/migrations/2026-11-account-deletion.sql), reduced
      // to what it guarantees: personal data gone, the profile kept as an
      // anonymised tombstone (the Stripe customer id stays for the kept
      // purchases; the subscription id goes, so later subscription webhooks
      // never match it), no credits, no access; a repeat changes nothing.
      if (name === 'delete_account_data') {
        if (!p) return { data: { ok: true, profile: 'none' }, error: null };
        if (p.deleted_at) return { data: { ok: true, already: true }, error: null };
        const keep = { id: p.id, created_at: p.created_at, stripe_customer_id: p.stripe_customer_id };
        Object.keys(p).forEach((k) => { delete p[k]; });
        Object.assign(p, keep, { subscription_status: 'deleted', credits_balance: 0, access_expires_at: null, deleted_at: new Date().toISOString() });
        return { data: { ok: true, deleted: {} }, error: null };
      }
      if (name === 'refund_credits' && p) { p.credits_balance += args.p_amount; return { data: [{ ok: true, balance: p.credits_balance }], error: null }; }
      // fulfill_purchase (docs/migrations/2026-10-access-purchases.sql), reduced
      // to what it guarantees: one paid purchase → access + the first credit
      // grant, exactly once; a repeat answers already=true and changes nothing.
      if (name === 'fulfill_purchase') {
        const pu = rows('purchases').find((r) => r.id === args.p_purchase_id);
        if (!pu) return { data: { ok: false, reason: 'unknown_purchase' }, error: null };
        if (pu.status === 'paid') return { data: { ok: true, already: true, access_end: pu.access_end }, error: null };
        if (pu.status !== 'pending') return { data: { ok: false, reason: 'status_' + pu.status }, error: null };
        if (args.p_amount_total !== pu.price_incl_vat_cents) return { data: { ok: false, reason: 'amount_mismatch' }, error: null };
        const owner = rows('profiles').find((r) => r.id === pu.user_id);
        const end = new Date(Date.now() + ((pu.duration_days || 0) + (pu.duration_months || 0) * 30) * 864e5).toISOString();
        const grant = Math.floor(pu.credits_total / (pu.instalments || 1));
        Object.assign(pu, { status: 'paid', paid_at: new Date().toISOString(), stripe_checkout_session_id: args.p_session_id, stripe_payment_intent_id: args.p_payment_intent, access_end: end });
        if (owner) Object.assign(owner, { subscription_status: 'paid', access_plan: pu.plan_id, access_expires_at: end, credits_balance: (owner.credits_balance || 0) + grant });
        return { data: { ok: true, fulfilled: true, access_end: end, credits_granted: grant }, error: null };
      }
      return { data: null, error: null };
    },
    auth: {
      getUser: async (t) => TOKENS[t] ? { data: { user: TOKENS[t] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } },
      admin: {
        createUser: async ({ email, user_metadata }) => {
          if (AUTH.createFail) { const m = AUTH.createFail; AUTH.createFail = null; return { data: null, error: { message: m } }; }
          if (AUTH.users.some((u) => String(u.email || '').toLowerCase() === String(email || '').toLowerCase())) return { data: null, error: { message: 'A user with this email address has already been registered', code: 'email_exists', status: 422 } };
          const user = { id: '00000000-0000-4000-8000-' + String(AUTH.users.length + 1).padStart(12, '0'), email, user_metadata, created_at: new Date().toISOString() };
          AUTH.users.push(user); TOKENS['tok_' + user.id] = user;
          return { data: { user }, error: null };
        },
        // Like Supabase Auth: a soft delete keeps the row (deleted_at) but
        // replaces the email with a hash and ends sign-in; a hard delete
        // removes the row. Either way the address can register again.
        deleteUser: async (id, soft) => {
          if (AUTH.deleteFail) { const m = AUTH.deleteFail; AUTH.deleteFail = null; return { error: { message: m } }; }
          AUTH.deleted.push(id);
          const u = AUTH.users.find((x) => x.id === id);
          if (!u) return { error: { message: 'User not found', status: 404 } };
          if (soft) { (AUTH.softDeleted = AUTH.softDeleted || []).push(id); if (!AUTH.keepEmailOnSoftDelete) u.email = 'hashed-' + id; u.deleted_at = new Date().toISOString(); Object.keys(TOKENS).forEach((t) => { if (TOKENS[t] && TOKENS[t].id === id) delete TOKENS[t]; }); }
          else AUTH.users.splice(AUTH.users.indexOf(u), 1);
          return { error: null };
        },
        getUserById: async (id) => { const u = AUTH.users.find((x) => x.id === id); return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'User not found', status: 404 } }; },
        updateUserById: async (id, attrs) => {
          if (AUTH.updateFail) { const m = AUTH.updateFail; AUTH.updateFail = null; return { data: null, error: { message: m } }; }
          const u = AUTH.users.find((x) => x.id === id); if (!u) return { data: null, error: { message: 'User not found', status: 404 } };
          if (attrs.email) u.email = attrs.email; if (attrs.user_metadata) u.user_metadata = attrs.user_metadata;
          return { data: { user: u }, error: null };
        },
        listUsers: async () => ({ data: { users: AUTH.users }, error: null }),
      },
    },
  };
  const mail = [];
  // Stripe: every call fails ("unexpected stripe call …") unless a test
  // installs a handler, e.g. STRIPE['checkout.sessions.retrieve'] = async (id) => ({…}).
  const STRIPE = {};
  const stripeProxy = (pathArr) => new Proxy(function () {}, {
    get: (_, k) => (k === 'then' ? undefined : stripeProxy(pathArr.concat(String(k)))),
    apply: (_, __, args) => { const key = pathArr.join('.'); return STRIPE[key] ? STRIPE[key](...args) : Promise.reject(new Error('unexpected stripe call ' + key)); },
  });
  class StripeMock { constructor() { return stripeProxy([]); } }
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
  return { SERVER_DIR, TABLES, MISSING, rows, writes, READ, TOKENS, AUTH, rpcCalls, RPC, STRIPE, mail, cronJobs, net, call, start, realFetch, BASE };
}

function reporter() {
  const out = process.stdout.write.bind(process.stdout);
  let pass = 0, fail = 0;
  const log = (s) => out(s + '\n');
  const check = (name, ok, info) => { ok ? pass++ : fail++; log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); };
  // Exit on a later turn, not mid-callback: on Windows, process.exit() while a
  // fetch socket is still closing aborts Node (libuv UV_HANDLE_CLOSING
  // assertion), which turned passing runs into crashes.
  const done = () => { log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 50); };
  return { check, log, done };
}

module.exports = { boot, reporter };
