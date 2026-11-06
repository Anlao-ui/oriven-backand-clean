// ════════════════════════════════════════════════════════════════
// Entitlement: who may use the app, who gets the onboarding or the plans,
// and when paid access ends — services/entitlement.js through the REAL
// server.js (gate, GET /api/entitlement, GET /api/onboarding/state,
// webhook), Supabase and Stripe mocked (tests/helpers/mockServer.js).
// Calendar-month periods are also checked against real Postgres date
// arithmetic when PGlite is available (NODE_PATH).
//
// No network, no Stripe, no Supabase, no payments.
// RUN: node tests/entitlement.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5671, env: { CHECKOUT_RESYNC_MS: '0' } });
const { check, log, done } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const pricing = require(path.join(H.SERVER_DIR, 'services', 'pricing'));
const entitlement = require(path.join(H.SERVER_DIR, 'services', 'entitlement'));
const PG = require('./helpers/pgPayments');
const TEST_PRICES = PG.installTestPrices(pricing);

// ── accounts ──
let n = 0;
function account(kind, extra) {
  const id = 'en' + String(++n).padStart(4, '0') + '-0000-4000-8000-000000000000';
  const base = { id, created_at: iso(NOW), subscription_status: 'free', credits_balance: 0, onboarding_completed: false, access_expires_at: null, access_plan: null, preferences: {} };
  const k = {
    new: {},                                                                                           // signed up, never paid
    legacyFree: { created_at: '2025-03-01T10:00:00.000Z', onboarding_completed: null, credits_balance: 230 }, // free account from before the onboarding
    active: { subscription_status: 'paid', access_plan: 'monthly', access_expires_at: iso(NOW + 20 * DAY), credits_balance: 900, onboarding_completed: true },
    activeUnfinished: { subscription_status: 'paid', access_plan: 'annual', access_expires_at: iso(NOW + 300 * DAY), credits_balance: 1250 }, // paid, onboarding row not completed
    expired: { subscription_status: 'free', access_plan: 'quarterly', access_expires_at: iso(NOW - 2 * DAY), credits_balance: 0, onboarding_completed: true },  // after the expiry job
    expiredNotSwept: { subscription_status: 'paid', access_plan: 'flex', access_expires_at: iso(NOW - 60e3), credits_balance: 400, onboarding_completed: true }, // before the expiry job ran
  }[kind];
  H.rows('profiles').push(Object.assign(base, k, extra || {}));
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: base.created_at };
  return { id, tok: 'tok_' + id, prof: () => H.rows('profiles').find((p) => p.id === id) };
}
function session(userId, extra) {
  H.rows('onboarding_sessions').push(Object.assign({ user_id: userId, status: 'in_progress', step: 'paywall', answers: {}, assistant: 'vector', plan_status: 'none', created_at: iso(NOW), updated_at: iso(NOW) }, extra || {}));
}

// ── Stripe fake ──
H.STRIPE['prices.retrieve'] = async (id) => { if (!TEST_PRICES[id]) throw Object.assign(new Error('No such price'), { statusCode: 404 }); return Object.assign({}, TEST_PRICES[id]); };
H.STRIPE['tax.settings.retrieve'] = async () => ({ status: 'active', defaults: { tax_behavior: 'exclusive' } });
const CREATED = [];
H.STRIPE['checkout.sessions.create'] = async (params) => { const id = 'cs_test_' + String(CREATED.length + 1).padStart(10, '0'); CREATED.push({ id, params }); return { id, url: 'https://checkout.stripe.com/c/pay/' + id }; };
H.STRIPE['checkout.sessions.retrieve'] = async (id) => ({ id, status: 'open' });
H.STRIPE['checkout.sessions.expire'] = async (id) => ({ id });
H.STRIPE['checkout.sessions.listLineItems'] = async (id) => PG.lineItemsFor(CREATED.find((c) => c.id === id).params, TEST_PRICES);
H.STRIPE['webhooks.constructEvent'] = (body, sig) => { if (sig !== 'valid-signature') throw new Error('bad signature'); return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); };
const hook = (evt, type, s) => H.call('POST', '/api/stripe-webhook', null, JSON.stringify({ id: evt, type, data: { object: s } }), { 'stripe-signature': 'valid-signature' });

(async () => {
  const quiet = await H.start();
  const { call } = H;
  const GATED = '/api/campaigns'; // an ordinary data route behind the plan gate

  // ── A. The rule (pure) ─────────────────────────────────────────
  log('\nA. services/entitlement.js');
  const E = (p, el) => entitlement.entitlementOf(p, { onboardingEligible: el, now: NOW });
  const a1 = E({ subscription_status: 'paid', access_plan: 'annual', access_expires_at: iso(NOW + DAY) }, true);
  check('A1. access in the future → active, route app (even if onboarding-eligible), plan annual', a1.active && a1.state === 'active' && a1.route === 'app' && a1.plan === 'annual' && !a1.planRequired, a1);
  const a2 = E({ subscription_status: 'paid', access_plan: 'annual', access_expires_at: iso(NOW - 1) }, false);
  check('A2. a "paid" label with an end date in the past → expired, route plans (the old plan name grants nothing)', !a2.active && a2.state === 'expired' && a2.route === 'plans' && a2.plan === null && a2.lastPlan === 'annual', a2);
  check('A3. access ending exactly now counts as ended', E({ subscription_status: 'paid', access_plan: 'flex', access_expires_at: iso(NOW) }).state === 'expired');
  check('A4. never paid + new account → onboarding', E({ subscription_status: 'free' }, true).route === 'onboarding');
  check('A5. never paid + older free account → app with its existing limits (no paid onboarding)', E({ subscription_status: 'free', credits_balance: 230 }, false).route === 'app' && !E({ subscription_status: 'free' }, false).active);
  check('A6. a legacy subscription label without an end date grants nothing', !E({ subscription_status: 'professional' }, false).active);
  check('A7. a legacy subscriber kept current (end date ahead) is active', E({ subscription_status: 'creator', access_expires_at: iso(NOW + 7 * DAY) }, false).active);

  // ── B. Durations: one source, calendar months ──────────────────
  log('\nB. Plan durations');
  const D = { flex: [14, 0], monthly: [0, 1], quarterly: [0, 3], semiannual: [0, 6], annual: [0, 12] };
  check('B1. services/pricing.js: Flex 14 days, Monthly 1, Quarterly 3, Semi-Annual 6, Annual 12 calendar months', Object.keys(D).every((id) => pricing.PLANS[id].days === D[id][0] && pricing.PLANS[id].months === D[id][1]), Object.keys(D).map((id) => [id, pricing.PLANS[id].days, pricing.PLANS[id].months]));
  const AE = (id, s) => pricing.accessEnd(pricing.PLANS[id], new Date(s)).toISOString();
  const cal = [
    ['flex', '2027-03-20T09:00:00.000Z', '2027-04-03T09:00:00.000Z', 'Flex: 20 Mar + 14 days = 3 Apr'],
    ['monthly', '2027-01-31T09:00:00.000Z', '2027-02-28T09:00:00.000Z', 'Monthly: 31 Jan + 1 month = 28 Feb (not 2 Mar)'],
    ['monthly', '2028-01-31T09:00:00.000Z', '2028-02-29T09:00:00.000Z', 'Monthly in a leap year: 31 Jan + 1 month = 29 Feb'],
    ['monthly', '2027-02-15T09:00:00.000Z', '2027-03-15T09:00:00.000Z', 'Monthly: 15 Feb + 1 month = 15 Mar (28 days, not 30)'],
    ['quarterly', '2027-11-30T09:00:00.000Z', '2028-02-29T09:00:00.000Z', 'Quarterly: 30 Nov + 3 months = 29 Feb 2028'],
    ['semiannual', '2027-08-31T09:00:00.000Z', '2028-02-29T09:00:00.000Z', 'Semi-Annual: 31 Aug + 6 months = 29 Feb 2028'],
    ['annual', '2028-02-29T09:00:00.000Z', '2029-02-28T09:00:00.000Z', 'Annual: 29 Feb 2028 + 12 months = 28 Feb 2029'],
    ['annual', '2027-05-10T09:00:00.000Z', '2028-05-10T09:00:00.000Z', 'Annual: 10 May 2027 + 12 months = 10 May 2028 (366 days)'],
  ];
  for (const [id, s, want, label] of cal) check('B. ' + label, AE(id, s) === want, AE(id, s));
  let PGlite = null; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {}
  if (PGlite) {
    const pg = new PGlite(); await pg.query("SET TimeZone = 'UTC'");
    let same = true; const diffs = [];
    for (const [id, s] of cal) {
      const p = pricing.PLANS[id];
      const r = await pg.query('SELECT ($1::timestamptz + make_interval(months => $2, days => $3)) AS e', [s, p.months, p.days]);
      const dbEnd = new Date(r.rows[0].e).toISOString();
      if (dbEnd !== AE(id, s)) { same = false; diffs.push([id, s, dbEnd, AE(id, s)]); }
    }
    check('B9. Postgres (fulfill_purchase: start + make_interval(months, days)) gives exactly the same end dates', same, diffs);
    await pg.close();
  } else log('  (B9 skipped: PGlite not on NODE_PATH)');

  // ── C. GET /api/entitlement and the plan gate ──────────────────
  log('\nC. Server decision and enforcement');
  const U = { new: account('new'), legacyFree: account('legacyFree'), active: account('active'), activeUnfinished: account('activeUnfinished'), expired: account('expired'), expiredNotSwept: account('expiredNotSwept') };
  session(U.new.id, { step: 'business' });
  session(U.activeUnfinished.id);
  session(U.expired.id, { status: 'completed', plan_status: 'ready' });
  const ent = async (u) => (await call('GET', '/api/entitlement', u.tok)).body;
  const want = { new: ['none', 'onboarding'], legacyFree: ['none', 'app'], active: ['active', 'app'], activeUnfinished: ['active', 'app'], expired: ['expired', 'plans'], expiredNotSwept: ['expired', 'plans'] };
  for (const k of Object.keys(want)) {
    const e = await ent(U[k]);
    check('C.' + k + ' → state ' + want[k][0] + ', route ' + want[k][1], e.state === want[k][0] && e.route === want[k][1], e);
  }
  check('C.unauth GET /api/entitlement without a session → 401', (await call('GET', '/api/entitlement', null)).status === 401);
  for (const k of ['new', 'expired', 'expiredNotSwept']) {
    const r = await call('GET', GATED, U[k].tok);
    check('C.gate ' + k + ': data routes → 403 ONBOARDING_REQUIRED (' + (k === 'new' ? 'NO_PLAN' : 'ACCESS_EXPIRED') + ')', r.status === 403 && r.body.code === 'ONBOARDING_REQUIRED' && r.body.reason === (k === 'new' ? 'NO_PLAN' : 'ACCESS_EXPIRED'), r.body);
  }
  for (const k of ['active', 'activeUnfinished', 'legacyFree']) {
    const r = await call('GET', GATED, U[k].tok);
    check('C.gate ' + k + ': not stopped by the plan gate', !(r.status === 403 && r.body && r.body.code === 'ONBOARDING_REQUIRED'), r.status);
  }
  let r = await call('POST', '/api/ai/chat', U.legacyFree.tok, { message: 'hi' });
  check('C.paid an older free account still can\'t use paid features: AI chat → 403 SUBSCRIPTION_REQUIRED', r.status === 403 && r.body.code === 'SUBSCRIPTION_REQUIRED', r.body);
  r = await call('POST', '/api/ai/chat', U.expiredNotSwept.tok, { message: 'hi' });
  check('C.paid expired (status label still "paid", expiry job not run yet) → refused by the server', r.status === 403, r.body);
  for (const p of ['/api/get-subscription', '/api/pricing', '/api/user/preferences']) {
    r = await call('GET', p, U.expired.tok);
    check('C.open ' + p + ' stays reachable for an expired account (plan selection, settings)', r.status !== 403 || r.body.code !== 'ONBOARDING_REQUIRED', r.status);
  }

  // ── D. Expiry while signed in (no lingering access) ────────────
  log('\nD. Expiry takes effect at once');
  const soon = account('active', { access_expires_at: iso(Date.now() + 1500) });
  r = await call('GET', GATED, soon.tok);
  check('D1. 1.5 s before the end: allowed', !(r.status === 403 && r.body.code === 'ONBOARDING_REQUIRED'), r.status);
  await sleep(1700);
  r = await call('GET', GATED, soon.tok);
  check('D2. right after the end (same session, cached decision): 403 ACCESS_EXPIRED — the cache never outlives the access', r.status === 403 && r.body.reason === 'ACCESS_EXPIRED', r.body);
  check('D3. …and GET /api/entitlement says expired → plans', (await ent(soon)).route === 'plans');

  // ── E. Where the frontend sends each account ───────────────────
  log('\nE. GET /api/onboarding/state (the routing the app uses before showing anything)');
  const st = async (u) => (await call('GET', '/api/onboarding/state', u.tok)).body;
  let s = await st(U.active);
  check('E1. active customer → app: no onboarding, no plans', s.access.route === 'app' && !s.flow.enabled && !s.eligible, s);
  s = await st(U.activeUnfinished);
  check('E2. paid but onboarding left unfinished (tab closed on Stripe) → still straight to the app, never back to the plans', s.access.route === 'app' && !s.flow.enabled && s.eligible === false, s);
  s = await st(U.new);
  check('E3. new account without a plan → the guided onboarding (not a renewal)', s.access.route === 'onboarding' && s.flow.enabled && !s.flow.renewal, s);
  s = await st(U.expired);
  check('E4. expired → the plans straight away (renewal), answers kept', s.access.route === 'plans' && s.flow.enabled && s.flow.renewal === true && !!s.flow.session, s);
  s = await st(U.legacyFree);
  check('E5. older free account → app (existing limits), no paid onboarding', s.access.route === 'app' && !s.flow.enabled, s);

  // ── F. Payment activates; duplicates don't extend ──────────────
  log('\nF. Activation by the verified webhook only');
  for (const id of pricing.PLAN_ORDER) {
    const u = account('expired', { access_plan: null });
    const k = CREATED.length;
    await call('POST', '/api/create-checkout-session', u.tok, { plan: id });
    const c = CREATED[k];
    const unpaid = PG.paidSessionFor(c.id, c.params, TEST_PRICES, { payment_status: 'unpaid' });
    await hook('evt_u_' + id, 'checkout.session.completed', unpaid);
    await hook('evt_f_' + id, 'checkout.session.async_payment_failed', unpaid);
    check('F.' + id + ' unpaid / failed payment → still expired, no access', (await ent(u)).state === 'expired' && u.prof().subscription_status !== 'paid');
    const paid = PG.paidSessionFor(c.id, c.params, TEST_PRICES);
    const k2 = CREATED.length;
    await call('POST', '/api/create-checkout-session', u.tok, { plan: id }); // the failed one is closed; a new checkout
    const c2 = CREATED[k2]; const paid2 = PG.paidSessionFor(c2.id, c2.params, TEST_PRICES);
    const t0 = Date.now();
    r = await hook('evt_p_' + id, 'checkout.session.completed', paid2);
    const e1 = await ent(u); const end1 = u.prof().access_expires_at;
    check('F.' + id + ' paid webhook → active ' + id + ', expiry recorded, route app, gate open', r.status === 200 && e1.active && e1.plan === id && !!end1 && new Date(end1).getTime() > t0 && e1.route === 'app' && (await call('GET', GATED, u.tok)).status !== 403, { e1, end1 });
    await hook('evt_p_' + id, 'checkout.session.completed', paid2);
    await hook('evt_p2_' + id, 'checkout.session.completed', paid2);
    await hook('evt_a_' + id, 'checkout.session.async_payment_succeeded', paid2);
    H.STRIPE['checkout.sessions.retrieve'] = async () => paid2;
    await call('POST', '/api/billing/sync-checkout', u.tok, { session_id: c2.id });
    H.STRIPE['checkout.sessions.retrieve'] = async (sid) => ({ id: sid, status: 'open' });
    check('F.' + id + ' repeated / extra events and the return-page sync never extend the access again', u.prof().access_expires_at === end1 && H.rows('purchases').filter((p) => p.user_id === u.id && p.status === 'paid').length === 1, { before: end1, after: u.prof().access_expires_at });
    void paid;
  }
  const fake = account('expired');
  r = await call('POST', '/api/stripe-webhook', null, JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: { id: 'cs_test_forged000001', mode: 'payment', payment_status: 'paid', metadata: { userId: fake.id } } } }), { 'stripe-signature': 'forged' });
  check('F.forged an unsigned "paid" webhook → 400, nothing activated', r.status === 400 && (await ent(fake)).state === 'expired');

  // ── G. The browser can't grant itself access ───────────────────
  log('\nG. No self-service entitlement');
  const m = account('expired');
  const before = JSON.stringify(m.prof());
  await call('PUT', '/api/user/preferences', m.tok, { subscription_status: 'paid', access_expires_at: iso(NOW + 365 * DAY), access_plan: 'annual', credits_balance: 99999, preferences: { theme: 'dark' } });
  await call('POST', '/api/profile/ensure', m.tok, { subscription_status: 'paid', access_expires_at: iso(NOW + 365 * DAY) });
  await call('POST', '/api/onboarding/complete', m.tok, { goal: 'create' });
  const after = m.prof();
  check('G1. preferences / profile-ensure / onboarding-complete with plan fields in the body → plan, expiry and credits unchanged', after.subscription_status === 'free' && after.access_plan === 'quarterly' && after.access_expires_at === JSON.parse(before).access_expires_at && after.credits_balance === 0, after);
  check('G2. …still expired → plans', (await ent(m)).route === 'plans');
  r = await call('GET', GATED, m.tok, null, { 'X-Subscription-Status': 'paid' });
  check('G3. headers or query flags don\'t matter: still 403', r.status === 403);
  r = await call('GET', '/api/success?session_id=cs_test_x', m.tok);
  check('G4. the success URL itself grants nothing (only the verified payment does)', (await ent(m)).state === 'expired');

  // ── M. Plans assigned by hand in Supabase (operator override) ──
  log('\nM. Manually assigned plans (no Stripe purchase)');
  const profileUpdates = () => H.writes.filter((w) => w[0] === 'profiles' && w[1] === 'update').length;
  const MAN = [['annual', 'annual', 365], ['Annual', 'annual', 300], ['Semi-Annual', 'semiannual', 180], ['semi_annual', 'semiannual', 170], ['QUARTERLY', 'quarterly', 90], ['Monthly', 'monthly', 30], ['flex', 'flex', 14]];
  for (const [typed, id, days] of MAN) {
    // As an operator would set it in Supabase: only access_plan + a future end date; status untouched ('free').
    const u = account('new', { access_plan: typed, access_expires_at: iso(NOW + days * DAY), onboarding_completed: false, credits_balance: 0 });
    session(u.id, { step: 'business' }); // even mid-onboarding
    const e = await ent(u);
    const g = await call('GET', GATED, u.tok);
    const s2 = await st(u);
    const pr = u.prof();
    check('M.' + typed + ' access_plan "' + typed + '" + end date in ' + days + ' days, no purchase → active ' + id + ', straight to the app (no onboarding, no payment)',
      e.active && e.state === 'active' && e.plan === id && e.route === 'app' && !(g.status === 403 && g.body.code === 'ONBOARDING_REQUIRED') && s2.access.route === 'app' && !s2.flow.enabled, { e, g: g.status, s2: s2.access });
    check('M.' + typed + ' recorded once like a purchase: status paid, canonical plan "' + id + '", same end date; credits untouched, no purchase record',
      pr.subscription_status === 'paid' && pr.access_plan === id && pr.access_expires_at === iso(NOW + days * DAY) && pr.credits_balance === 0 && !H.rows('purchases').some((x) => x.user_id === u.id), pr);
  }
  {
    const u = account('active', { subscription_status: 'free', access_plan: 'annual', access_expires_at: iso(NOW + 200 * DAY) });
    // the AI provider is answered here (never reached)
    H.net.handler = async (url) => (/aimlapi.com/.test(url) ? new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }) : null);
    r = await call('POST', '/api/ai/chat', u.tok, { message: 'hi' });
    H.net.handler = null;
    check('M.paid paid features accept the assigned plan (no 403 SUBSCRIPTION_REQUIRED / ONBOARDING_REQUIRED)', !(r.status === 403), r.status);
  }
  {
    const u = account('new', { access_plan: 'annual', access_expires_at: iso(NOW - DAY), onboarding_completed: true });
    const e = await ent(u); const g = await call('GET', GATED, u.tok);
    check('M.expired an assigned Annual whose end date has passed → expired, the plans; nothing recorded', e.state === 'expired' && e.route === 'plans' && g.status === 403 && g.body.reason === 'ACCESS_EXPIRED' && u.prof().subscription_status === 'free', { e, g: g.body });
  }
  {
    const u = account('new', { access_plan: 'annual', access_expires_at: null });
    const e = await ent(u);
    check('M.nodate an assigned plan without an end date grants nothing (new account → onboarding)', !e.active && e.route === 'onboarding' && u.prof().subscription_status === 'free', e);
    const v = account('new', { access_plan: 'lifetime', access_expires_at: iso(NOW + 365 * DAY) });
    const e2 = await ent(v);
    check('M.unknown an unknown plan name ("lifetime") grants nothing', !e2.active && v.prof().subscription_status === 'free', e2);
    const w = account('new');
    const e3 = await ent(w);
    check('M.none no plan at all → the payment onboarding, as before', e3.route === 'onboarding' && !e3.active, e3);
  }
  {
    const u = account('expired');
    await call('PUT', '/api/user/preferences', u.tok, { access_plan: 'annual', access_expires_at: iso(NOW + 365 * DAY), subscription_status: 'paid', preferences: { theme: 'dark' } });
    await call('POST', '/api/profile/ensure', u.tok, { access_plan: 'annual', access_expires_at: iso(NOW + 365 * DAY) });
    await call('PUT', '/api/onboarding/session', u.tok, { access_plan: 'annual', access_expires_at: iso(NOW + 365 * DAY), step: 'paywall' });
    const pr = u.prof();
    check('M.self an account can\'t assign itself a plan through the API (preferences / profile / onboarding with plan fields) → still expired',
      pr.access_plan === 'quarterly' && new Date(pr.access_expires_at).getTime() < Date.now() && (await ent(u)).state === 'expired', pr);
  }
  {
    // Existing customers: a purchased plan is not rewritten by the override logic.
    const before = JSON.stringify(U.active.prof()); const w0 = profileUpdates();
    await ent(U.active); await call('GET', GATED, U.active.tok);
    check('M.existing a customer with a purchased plan: same entitlement, profile not written by this logic', JSON.stringify(U.active.prof()) === before && profileUpdates() === w0 && (await ent(U.active)).active);
    const lf = JSON.stringify(U.legacyFree.prof());
    await ent(U.legacyFree);
    check('M.legacy an older free account: unchanged (app with its limits, not active)', JSON.stringify(U.legacyFree.prof()) === lf && (await ent(U.legacyFree)).route === 'app' && !(await ent(U.legacyFree)).active);
  }

  check('Z. no outbound network', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
