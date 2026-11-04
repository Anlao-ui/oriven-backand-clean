/* ════════════════════════════════════════════════════════════════
   DEVELOPMENT ONLY — onboarding preview mode of the local server.

     npm run dev:onboarding-preview          (from oriven-backend/server)
     → http://localhost:5500/                (Get Started → signup → app)
     → http://localhost:5500/__preview/reset (start again)

   `node server.js --onboarding-preview` hands the process to this module
   before server.js loads .env or any Supabase, Stripe, AI, email or cron
   code. It serves the same frontend folder the normal local server serves
   (FRONTEND_DIR or ../../oriven-frontend), with the same clean URLs
   (_redirects: / → home, /signup → index, /app → app.html, …), and
   simulates, in this process's memory only:
     • the backend API: signup, onboarding state/session, website reading
       (sample suggestions), strategy generation (a fixed SAMPLE strategy
       after ~5 s), plan unlock (only after the simulated payment), checkout
       (a local page instead of Stripe), payment confirmation (~3 s after
       paying, like Stripe's webhook) and empty answers for everything else;
     • Supabase in the browser: the pages get a local stand-in for the
       Supabase SDK instead of the real one.

   It cannot reach production services:
     1. it refuses to start on Render, with NODE_ENV=production, or when
        bound to anything but this machine;
     2. it never reads .env and removes Supabase/Stripe/AI/email/OAuth keys
        from its own environment at start, so the process holds no
        production credentials;
     3. every outbound connection from the process (fetch, http, https, net,
        tls) to anything other than this machine throws;
     4. every page it serves carries a Content-Security-Policy that lets the
        browser send requests only to this server (connect-src 'self'); any
        Supabase, Render, Stripe, analytics or AI address is refused by the
        browser itself.
   Files on disk are never changed; the two hardcoded backend addresses in
   js/supabase.js and js/site-analytics.js are pointed at this server as
   they are served. A yellow ONBOARDING PREVIEW banner is on every page.
   ════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');

// ── Guards ────────────────────────────────────────────────────────
function refuse(why) {
  console.error('[OnboardingPreview] Refusing to start: ' + why);
  process.exit(1);
}
const SECRET_ENV = /SUPABASE|STRIPE|AIML|OPENAI|ANTHROPIC|SMTP|RESEND|EMAIL|GOOGLE|META_|TIKTOK|PINTEREST|DATABASE_URL|PG[A-Z]*|SERVICE_ROLE|SECRET|TOKEN|API_KEY/i;
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|::1|\[::1\]|0:0:0:0:0:0:0:1)$/i;

function isolateProcess() {
  for (const k of Object.keys(process.env)) if (SECRET_ENV.test(k)) delete process.env[k];
  const deny = (target) => { const e = new Error('[OnboardingPreview] outbound connection blocked: ' + target); e.code = 'PREVIEW_ISOLATED'; return e; };
  const hostOf = (a) => {
    if (!a) return '';
    if (typeof a === 'string') { try { return new URL(a).hostname; } catch (_) { return a; } }
    if (a instanceof URL) return a.hostname;
    return a.hostname || a.host || '';
  };
  const guardReq = (mod) => {
    for (const fn of ['request', 'get']) {
      const orig = mod[fn];
      mod[fn] = function (a, b) { const h = String(hostOf(a) || hostOf(b) || 'localhost').replace(/:\d+$/, ''); if (!LOOPBACK.test(h)) throw deny(h); return orig.apply(this, arguments); };
    }
  };
  guardReq(http); guardReq(https);
  const origConnect = net.connect, origTls = tls.connect;
  const pickHost = (args) => { const o = args[0]; if (o && typeof o === 'object') return o.host || o.hostname || 'localhost'; if (typeof args[1] === 'string') return args[1]; return 'localhost'; };
  net.connect = net.createConnection = function () { const h = pickHost(arguments); if (!LOOPBACK.test(h)) throw deny(h); return origConnect.apply(this, arguments); };
  tls.connect = function () { const h = pickHost(arguments); if (!LOOPBACK.test(h)) throw deny(h); return origTls.apply(this, arguments); };
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) { const h = hostOf(typeof input === 'object' && input && input.url ? input.url : input); if (!LOOPBACK.test(h)) return Promise.reject(deny(h)); return origFetch.call(this, input, init); };
}

// ── Sample content ────────────────────────────────────────────────
const SAMPLE_PLAN = {
  summary: 'PREVIEW SAMPLE (not AI-generated): focus on two channels you can keep up, turn your offer into one clear message, and win repeat customers first.',
  overview: { text: 'This is a fixed sample used by the local preview to show how the strategy is presented. In the real product your chosen assistant writes it from your answers.' },
  audience: { text: 'Sample audience analysis.', segments: [{ name: 'Primary segment', needs: 'What they need from you' }, { name: 'Secondary segment', needs: 'What they need from you' }] },
  positioning: { statement: 'Sample positioning statement.', proof_points: ['Proof point one', 'Proof point two'] },
  objectives: [{ objective: 'Sample objective', measure: 'How it is measured' }],
  channels: [{ channel: 'Instagram', role: 'Discovery', why: 'Sample reason', effort: 'medium' }, { channel: 'Email', role: 'Repeat sales', why: 'Sample reason', effort: 'low' }],
  content: { pillars: [{ name: 'Pillar one', ideas: ['Idea', 'Idea'] }], cadence: 'Three posts a week' },
  campaigns: [{ name: 'Sample campaign', goal: 'Sample goal', idea: 'Sample idea' }],
  priorities: ['First priority', 'Second priority', 'Third priority'],
  roadmap: [{ phase: 'Days 1–30', focus: 'Foundations', actions: ['Action', 'Action'] }, { phase: 'Days 31–60', focus: 'Grow', actions: ['Action'] }, { phase: 'Days 61–90', focus: 'Repeat', actions: ['Action'] }],
};
const PLAN_DAYS = { flex: 14, monthly: 30, quarterly: 91, semiannual: 182, annual: 365 };

// ── State (memory only) ───────────────────────────────────────────
let M;
function reset() {
  M = { user: null, profile: null, readyAt: 0, checkout: null,
    session: { status: 'in_progress', step: 'welcome', answers: {}, assistant: null, website: null, websiteReadsLeft: 5, plan: { status: 'none', attemptsLeft: 3, error: null }, unlocked: false, missing: [] } };
}
function newUser(email, first, last) {
  const id = '00000000-0000-4000-8000-' + String(Date.now()).slice(-12).padStart(12, '0');
  M.user = { id, email: String(email || 'preview@example.invalid').toLowerCase(), created_at: new Date().toISOString(), user_metadata: { first_name: first || 'Preview', last_name: last || 'User' } };
  M.profile = { id, email: M.user.email, first_name: M.user.user_metadata.first_name, last_name: M.user.user_metadata.last_name, created_at: M.user.created_at,
    subscription_status: 'free', access_expires_at: null, access_plan: null, credits_balance: 0, onboarding_completed: false, primary_goal: null, preferences: {} };
}
function tick() {
  if (M.session.plan.status === 'generating' && Date.now() >= M.readyAt) Object.assign(M.session, { status: 'plan_ready', step: 'ready' }, { plan: Object.assign({}, M.session.plan, { status: 'ready' }) });
  if (M.checkout && M.checkout.paidAt && M.profile && Date.now() >= M.checkout.paidAt + 3000 && M.profile.subscription_status !== 'paid') { // the "webhook"
    Object.assign(M.profile, { subscription_status: 'paid', access_expires_at: new Date(Date.now() + PLAN_DAYS[M.checkout.plan] * 864e5).toISOString(), access_plan: M.checkout.plan });
  }
}
const hasAccess = () => !!M.profile && M.profile.subscription_status === 'paid' && Date.parse(M.profile.access_expires_at) > Date.now();

// ── Browser-side pieces ───────────────────────────────────────────
const FAKE_SDK = `/* ONBOARDING PREVIEW: a local stand-in for @supabase/supabase-js. No network beyond this server. */
(function () {
  var KEY = 'onx_preview_session', subs = [];
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function write(s) { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (_) {} }
  function emit(ev, s) { subs.forEach(function (cb) { try { cb(ev, s); } catch (_) {} }); }
  function sessionFor(u) { return { access_token: 'preview-token', refresh_token: 'preview', token_type: 'bearer', expires_at: Math.floor(Date.now() / 1000) + 86400, user: u }; }
  function Q(table) { this.t = table; this.mut = false; this.one = false; }
  ['select', 'eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'order', 'limit', 'range', 'match', 'not', 'or', 'filter', 'contains'].forEach(function (m) { Q.prototype[m] = function () { return this; }; });
  ['insert', 'update', 'upsert', 'delete'].forEach(function (m) { Q.prototype[m] = function () { this.mut = true; return this; }; });
  Q.prototype.single = Q.prototype.maybeSingle = function () { this.one = true; return this; };
  Q.prototype.then = function (a, b) {
    var self = this;
    var p = (self.t === 'profiles' && !self.mut)
      ? fetch('/__preview/profile').then(function (r) { return r.json(); }).then(function (j) { return { data: self.one ? j.profile : (j.profile ? [j.profile] : []), error: null }; })
      : Promise.resolve({ data: self.one ? null : (self.mut ? null : []), error: null });
    return p.then(a, b);
  };
  var auth = {
    getSession: function () { return Promise.resolve({ data: { session: read() }, error: null }); },
    getUser: function () { var s = read(); return Promise.resolve({ data: { user: s ? s.user : null }, error: null }); },
    refreshSession: function () { return Promise.resolve({ data: { session: read() }, error: null }); },
    signInWithPassword: function (c) {
      return fetch('/__preview/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c && c.email }) })
        .then(function (r) { return r.json(); }).then(function (j) { var s = sessionFor(j.user); write(s); emit('SIGNED_IN', s); return { data: { session: s, user: j.user }, error: null }; });
    },
    signUp: function (c) { return auth.signInWithPassword(c); },
    signOut: function () { write(null); emit('SIGNED_OUT', null); return Promise.resolve({ error: null }); },
    updateUser: function () { return Promise.resolve({ data: { user: (read() || {}).user || null }, error: null }); },
    resetPasswordForEmail: function () { return Promise.resolve({ data: {}, error: null }); },
    exchangeCodeForSession: function () { return Promise.resolve({ data: { session: read() }, error: null }); },
    onAuthStateChange: function (cb) { subs.push(cb); setTimeout(function () { try { cb('INITIAL_SESSION', read()); } catch (_) {} }, 0); return { data: { subscription: { unsubscribe: function () { subs = subs.filter(function (x) { return x !== cb; }); } } } }; },
  };
  function client() {
    return {
      auth: auth,
      from: function (t) { return new Q(t); },
      rpc: function () { return Promise.resolve({ data: null, error: null }); },
      storage: { from: function () { return { upload: function () { return Promise.resolve({ data: null, error: { message: 'Not available in the preview' } }); }, getPublicUrl: function () { return { data: { publicUrl: '' } }; }, remove: function () { return Promise.resolve({ data: null, error: null }); } }; } },
      channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; }, unsubscribe: function () {} }; return c; },
      removeChannel: function () {},
    };
  }
  window.supabase = { createClient: client };
})();`;
const BANNER_JS = `/* ONBOARDING PREVIEW banner */
(function () {
  function add() {
    if (document.getElementById('onxPreviewBar')) return;
    var bar = document.createElement('div');
    bar.id = 'onxPreviewBar';
    bar.setAttribute('role', 'note');
    bar.innerHTML = '<b>ONBOARDING PREVIEW</b><span>Simulated — nothing is saved, no real payment, no AI</span><a href="/__preview/reset">Restart onboarding</a>';
    document.body.appendChild(bar);
    var st = document.createElement('style');
    st.textContent = '#onxPreviewBar{position:fixed;left:0;right:0;top:0;height:26px;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:14px;background:#EAFD13;color:#0B0C0A;font:500 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;padding:0 10px;white-space:nowrap;overflow:hidden}'
      + '#onxPreviewBar b{font-weight:700}#onxPreviewBar a{color:#0B0C0A;font-weight:700;text-decoration:underline;text-underline-offset:2px}'
      + '@media (max-width:600px){#onxPreviewBar span{display:none}}'
      + 'html{scroll-padding-top:26px}body{margin-top:26px!important}#onx{top:26px!important}';
    document.head.appendChild(st);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();`;
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/gsap@3.12.5/ https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:", "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'", "worker-src 'self' blob:", "form-action 'self'", "base-uri 'self'",
].join('; ');
const BACKEND_LITERAL = /(["'])http:\/\/localhost:5500\1/g;

// ── App ───────────────────────────────────────────────────────────
function createApp(frontendDir) {
  const express = require('express');
  const ROOT = path.resolve(frontendDir);
  reset();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: 'text/plain', limit: '64kb' }));
  app.use((q, r, n) => { tick(); n(); });

  // Simulated backend API
  const api = express.Router();
  api.post('/signup', (q, r) => { const b = q.body || {}; newUser(b.email, b.firstName, b.lastName); r.json({ ok: true, userId: M.user.id }); });
  api.post('/profile/ensure', (q, r) => r.json({ ok: true, created: false }));
  api.get('/onboarding/state', (q, r) => {
    if (!M.profile) return r.status(401).json({ error: 'Authentication required' });
    const eligible = !M.profile.onboarding_completed;
    r.json({ eligible, reason: eligible ? 'new_account' : 'completed', newAccount: true, completed: !eligible, goal: null, plan: M.profile.subscription_status,
      freeFirstAd: { available: false, used: false }, stage: eligible ? 'welcome' : 'done', flow: eligible ? { enabled: true, session: M.session } : { enabled: false } });
  });
  api.get('/onboarding/session', (q, r) => r.json({ session: M.session }));
  api.put('/onboarding/session', (q, r) => {
    const b = q.body || {};
    if ((b.answers || b.assistant) && ['generating', 'ready'].includes(M.session.plan.status)) return r.status(409).json({ error: 'Your strategy has already been prepared from these answers.', code: 'ANSWERS_LOCKED' });
    if (b.step) M.session.step = b.step;
    if (b.answers) Object.keys(b.answers).forEach((k) => { if (k === 'suggested') M.session.answers.suggested = b.answers.suggested; else M.session.answers[k] = Object.assign({}, M.session.answers[k] || {}, b.answers[k]); });
    if (b.assistant) { M.session.assistant = b.assistant; if (M.profile) M.profile.preferences = Object.assign({}, M.profile.preferences, { assistant: b.assistant }); }
    r.json({ session: M.session });
  });
  api.post('/onboarding/website', (q, r) => {
    const url = String((q.body || {}).url || '').trim();
    M.session.websiteReadsLeft = Math.max(0, M.session.websiteReadsLeft - 1);
    M.session.website = { status: 'ok', url, domain: url.replace(/^https?:\/\//, '').split('/')[0], message: 'PREVIEW: sample suggestions — your website was not visited. Check each one; you decide what to keep.',
      suggestions: { audience: { value: 'Sample audience (preview)', quote: 'a sample sentence standing in for your homepage' }, offer: { value: 'Sample offer (preview)', quote: 'another sample sentence' }, differentiator: { value: 'Sample differentiator (preview)', quote: 'a third sample sentence' } } };
    setTimeout(() => r.json({ session: M.session }), 900);
  });
  api.post('/onboarding/plan', (q, r) => {
    if (M.session.plan.status === 'ready') return r.json({ session: M.session });
    if (M.session.plan.status !== 'generating') { M.session.plan = { status: 'generating', attemptsLeft: M.session.plan.attemptsLeft - 1, error: null }; M.session.step = 'analyzing'; M.readyAt = Date.now() + 5000; }
    r.status(202).json({ session: M.session });
  });
  api.get('/onboarding/plan', (q, r) => {
    if (M.session.plan.status !== 'ready') return r.json({ status: M.session.plan.status, locked: true });
    const meta = { status: 'ready', businessName: (M.session.answers.business || {}).name || null, assistant: M.session.assistant, generatedAt: new Date().toISOString() };
    if (!hasAccess()) return r.json(Object.assign(meta, { locked: true }));
    Object.assign(M.session, { unlocked: true, status: 'completed', step: 'done' }); M.profile.onboarding_completed = true;
    r.json(Object.assign(meta, { locked: false, unlockedAt: new Date().toISOString(), plan: SAMPLE_PLAN, sections: [] }));
  });
  api.post('/onboarding/complete', (q, r) => { if (M.profile) M.profile.onboarding_completed = true; r.json({ onboarding_completed: true }); });
  api.post('/create-checkout-session', (q, r) => {
    const plan = String((q.body || {}).plan || '');
    if (!PLAN_DAYS[plan]) return r.status(400).json({ error: 'Unknown plan' });
    M.checkout = { plan, id: 'cs_test_preview_' + Date.now(), paidAt: 0 };
    r.json({ url: '/__preview/checkout?plan=' + plan });
  });
  api.post('/billing/sync-checkout', (q, r) => r.json({ ok: true, status: M.profile && M.profile.subscription_status }));
  api.get(['/get-subscription', '/subscription'], (q, r) => r.json({ subscription_status: (M.profile && M.profile.subscription_status) || 'free', has_access: hasAccess(), access_expires_at: M.profile && M.profile.access_expires_at }));
  api.get('/credits/status', (q, r) => r.json({ balance: 0, plan: (M.profile && M.profile.subscription_status) || 'free' }));
  api.get('/user/preferences', (q, r) => r.json({ preferences: (M.profile && M.profile.preferences) || {} }));
  api.put('/user/preferences', (q, r) => { if (M.profile) M.profile.preferences = Object.assign({}, M.profile.preferences, q.body || {}); r.json({ preferences: (M.profile && M.profile.preferences) || {} }); });
  api.get('/business/profile', (q, r) => r.json({ profile: null }));
  api.post(['/events', '/t'], (q, r) => r.json({ ok: true })); // not stored
  api.use((q, r) => r.json({})); // everything else: an empty, successful answer
  app.use('/api', api);

  // Simulated Supabase + preview pages
  app.get('/__preview/profile', (q, r) => r.json({ profile: M.profile }));
  app.post('/__preview/signin', (q, r) => { if (!M.user) newUser(String((q.body || {}).email || '')); r.json({ user: M.user }); });
  app.get('/__preview/supabase.js', (q, r) => r.type('application/javascript').set('Cache-Control', 'no-store').send(FAKE_SDK));
  app.get('/__preview/banner.js', (q, r) => r.type('application/javascript').set('Cache-Control', 'no-store').send(BANNER_JS));
  app.get('/__preview/reset', (q, r) => {
    reset();
    r.set('Cache-Control', 'no-store').type('html').send('<!doctype html><meta charset="utf-8"><title>Restarting preview</title><script src="/__preview/reset.js"></script><p style="font:14px system-ui">Restarting the onboarding preview…</p>');
  });
  app.get('/__preview/reset.js', (q, r) => r.type('application/javascript').set('Cache-Control', 'no-store').send(
    "try{Object.keys(localStorage).forEach(function(k){if(/^(onx_preview|oriven|orv|sb-)/i.test(k))localStorage.removeItem(k);});sessionStorage.clear();}catch(_){}location.replace('/');"));
  app.get('/__preview/checkout', (q, r) => {
    const plan = String(q.query.plan || '').replace(/[^a-z]/g, '');
    r.set({ 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated checkout — preview</title><script src="/__preview/banner.js"></script></head>
<body style="font:16px system-ui,sans-serif;background:#0B0C0A;color:#ECEEE6;display:grid;place-items:center;min-height:calc(100vh - 26px);margin:0">
<main style="max-width:440px;padding:24px"><p style="color:#EAFD13;font:600 12px ui-monospace,monospace;letter-spacing:.08em">SIMULATED CHECKOUT — NOT STRIPE, NO PAYMENT</p>
<h1 style="font-size:28px;margin:8px 0">Plan: ${plan || 'unknown'}</h1>
<p style="color:#A6AA9F">In the real product this is Stripe’s checkout. Here, choose what happens. After paying, the confirmation arrives a few seconds later, like Stripe’s webhook.</p>
<p style="display:flex;gap:16px;align-items:center"><a href="/__preview/pay" style="background:#EAFD13;color:#0B0C0A;padding:12px 18px;border-radius:6px;font-weight:600;text-decoration:none">Pay (simulated)</a>
<a href="/app?canceled=true" style="color:#A6AA9F">Cancel and go back</a></p></main></body></html>`);
  });
  app.get('/__preview/pay', (q, r) => {
    if (M.checkout) M.checkout.paidAt = Date.now();
    r.redirect('/app?success=true&session_id=' + encodeURIComponent((M.checkout && M.checkout.id) || 'cs_test_preview'));
  });

  // Pages and assets, with production's clean URLs
  function rules() {
    const map = new Map();
    try {
      fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8').split(/\r?\n/).forEach((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length >= 3 && p[0][0] === '/' && /^200!?$/.test(p[2]) && !p[0].includes('*') && /\.html$/.test(p[1])) map.set(p[0], p[1]);
      });
    } catch (_) {}
    map.set('/app', '/app.html'); map.set('/signup', '/index.html'); map.set('/login', '/index.html');
    return map;
  }
  function resolvePage(urlPath) {
    const r = rules();
    const clean = urlPath.replace(/\/+$/, '') || '/';
    if (r.has(urlPath)) return r.get(urlPath);
    if (r.has(clean)) return r.get(clean);
    if (!path.extname(clean)) {
      if (fs.existsSync(path.join(ROOT, clean + '.html'))) return clean + '.html';
      if (fs.existsSync(path.join(ROOT, clean, 'index.html'))) return clean + '/index.html';
    }
    return /\.html$/.test(clean) ? clean : null;
  }
  const inside = (file) => { const f = path.resolve(ROOT, '.' + file); return f.startsWith(ROOT + path.sep) ? f : null; };
  function sendHtml(res, file) {
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace(/<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2[^"]*"><\/script>/g, '<script src="/__preview/supabase.js"></script>');
    html = html.replace(BACKEND_LITERAL, 'location.origin');
    html = html.replace(/<head([^>]*)>/i, (m) => m + '\n<script src="/__preview/banner.js"></script>');
    res.set({ 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(html);
  }
  app.use((q, r, next) => {
    if (q.method !== 'GET' && q.method !== 'HEAD') return next();
    const page = resolvePage(q.path);
    if (page) { const f = inside(page); if (f && fs.existsSync(f)) return sendHtml(r, f); }
    if (/\.js$/.test(q.path)) {
      const f = inside(q.path);
      if (f && fs.existsSync(f)) return r.type('application/javascript').set('Cache-Control', 'no-store').send(fs.readFileSync(f, 'utf8').replace(BACKEND_LITERAL, 'location.origin'));
    }
    next();
  });
  app.use(express.static(ROOT, { etag: false, maxAge: 0, index: false }));
  app.use((q, r) => {
    const f = path.join(ROOT, '404.html');
    if (fs.existsSync(f)) { r.status(404); return sendHtml(r, f); }
    r.status(404).type('text').send('Not found');
  });
  return app;
}

function start() {
  if (process.env.RENDER) refuse('this is a Render deployment.');
  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV is production.');
  const host = process.env.PREVIEW_HOST || '127.0.0.1';
  if (!LOOPBACK.test(host)) refuse('it only listens on this machine (got host ' + host + ').');
  const port = parseInt(process.env.PORT || '5500', 10);
  const frontendDir = process.env.FRONTEND_DIR || (function () {
    const sibling = path.resolve(__dirname, '..', '..', '..', 'oriven-frontend');
    return fs.existsSync(sibling) ? sibling : path.resolve(__dirname, '..', '..', '..');
  })();
  if (!fs.existsSync(path.join(frontendDir, 'app.html'))) refuse('no frontend found at ' + frontendDir + ' (set FRONTEND_DIR).');
  isolateProcess();
  // Never run next to the normal server: on Windows a loopback bind can
  // succeed while another process holds the same port on all interfaces,
  // and "localhost:5500" would then reach either server.
  const probe = (addr) => new Promise((resolve) => {
    const s = net.connect({ port, host: addr });
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
  Promise.all([probe('127.0.0.1'), probe('::1')]).then(([v4, v6]) => {
    if (v4 || v6) refuse('something is already running on port ' + port + ' (probably the normal server). Stop it first (Ctrl+C in its terminal), then run this again.');
    listen(port, host, frontendDir);
  });
}

function listen(port, host, frontendDir) {
  const app = createApp(frontendDir);
  const server = app.listen(port, host, () => {
    console.log('');
    console.log('══════════ OrivenAI — ONBOARDING PREVIEW MODE (development only) ══════════');
    console.log('  Simulated signup, onboarding, strategy and payment. Nothing is saved.');
    console.log('  No .env loaded; outbound connections blocked; pages may only call this server.');
    console.log('  Frontend:  ' + frontendDir);
    console.log('  Open:      http://localhost:' + port + '/');
    console.log('  Restart:   http://localhost:' + port + '/__preview/reset');
    console.log('  Back to the normal server: stop this (Ctrl+C) and run `npm start`.');
    console.log('══════════════════════════════════════════════════════════════════════════');
  });
  // Also answer on IPv6 loopback, so http://localhost works whichever address the browser picks.
  if (host === '127.0.0.1') { const v6 = http.createServer(app); v6.on('error', () => {}); v6.listen(port, '::1'); }
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') refuse('port ' + port + ' is in use — stop the normal server first (Ctrl+C in its terminal).'); throw e; });
}

module.exports = { start, createApp, _isolateProcess: isolateProcess };
