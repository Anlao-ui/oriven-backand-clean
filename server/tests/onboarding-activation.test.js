// ════════════════════════════════════════════════════════════════
// Mandatory onboarding = account activation: signup → questions → one real
// plan generation → mandatory paywall → Stripe-confirmed payment → onboarding
// completed → app. Through the REAL server.js routes (onboarding gate,
// /api/onboarding/*, /api/create-checkout-session, /api/stripe-webhook,
// /api/billing/sync-checkout) with Supabase in memory, the AI provider and
// Stripe faked (tests/helpers/mockServer.js). No network, no real users, no
// payments, no AI calls.
//
// Scenarios: A new user to paywall · B leave at the paywall and come back
// (no regeneration) · C leave halfway and resume · D pay → webhook → done
// → app · E no payment → still blocked · F late webhook: return first,
// activation only after Stripe confirms · G bypass attempts (direct API,
// Stripe return URL alone, manipulated requests) · H existing customers keep
// their access · I double clicks, refreshes, duplicate webhooks · plus the
// complete-provider-response checks.
//
// RUN: node tests/onboarding-activation.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const AIML = 'http://aiml.mock.invalid';
const H = boot({ port: 5641, env: { AIML_BASE_OVERRIDE: AIML, CHECKOUT_RESYNC_MS: '0' } });
const { check, log, done } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEW = new Date().toISOString();
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const sess = (id) => H.rows('onboarding_sessions').find((r) => r.user_id === id);
const purchasesOf = (id) => H.rows('purchases').filter((p) => p.user_id === id);
function user(id, extra) {
  H.rows('profiles').push(Object.assign({ id, subscription_status: 'free', created_at: NEW, credits_balance: 0, onboarding_completed: false, access_expires_at: null, preferences: {} }, extra || {}));
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: (extra && extra.created_at) || NEW };
  return 'tok_' + id;
}

// ── AI provider fake ──
const PLAN = {
  summary: 'Grow repeat candle sales in Utrecht with email and one social channel you can keep up every week.',
  overview: { text: 'Bloom & Wick sells hand-poured soy candles in Utrecht and online; this plan starts with the buyers you already reach.' },
  audience: { text: 'Gift shoppers and interior lovers aged 25–45 who care about natural products.', segments: [{ name: 'Gift shoppers', needs: 'A personal present' }] },
  positioning: { statement: 'Hand-poured, natural candles from your own Utrecht studio.', proof_points: ['Poured by hand'] },
  objectives: [{ objective: 'Grow repeat orders', measure: 'Repeat orders per month' }],
  channels: [{ channel: 'Instagram', role: 'Discovery', why: 'Visual product', effort: 'medium' }, { channel: 'Email', role: 'Repeat sales', why: 'Owned audience', effort: 'low' }],
  content: { pillars: [{ name: 'Studio', ideas: ['How a candle is poured'] }], cadence: 'Three posts a week' },
  campaigns: [{ name: 'Saturday workshops', goal: 'Bookings', idea: 'Invite past buyers first' }],
  priorities: ['Start an email list', 'Post three times a week'],
  roadmap: [{ phase: 'Days 1–30', focus: 'Foundations', actions: ['Set up email'] }, { phase: 'Days 31–60', focus: 'Grow', actions: ['Workshop campaign'] }, { phase: 'Days 61–90', focus: 'Repeat', actions: ['Loyalty offer'] }],
};
const AI = { mode: 'ok', calls: 0 };
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// The plan answers with the roadmap phases the prompt asks for (the
// purchased period), two actions each.
function planFor(sys) {
  const m = String(sys || '').match(/"roadmap":\[(.*)\]\}\s*\nRoadmap:/);
  const names = m ? Array.from(m[1].matchAll(/"phase":"([^"]+)"/g)).map((x) => x[1]) : [];
  return Object.assign({}, PLAN, { roadmap: names.map((n) => ({ phase: n, focus: 'Focus', tasks: require('./helpers/planFixture').tasks(n) })) });
}
H.net.handler = async (u, opts) => {
  if (!u.startsWith(AIML)) return null;
  AI.calls++;
  let body = {}; try { body = JSON.parse(opts.body); } catch (_) {}
  const PLAN_NOW = planFor(body.messages && body.messages[0] && body.messages[0].content);
  AI.lastSystem = (body.messages && body.messages[0] && body.messages[0].content) || '';
  if (AI.mode === 'truncated') return jres(200, { model: 'claude-haiku-4-5', choices: [{ message: { content: JSON.stringify(PLAN_NOW).slice(0, 400) }, finish_reason: 'length' }], usage: { completion_tokens: 4000 } });
  if (AI.mode === 'cutoff-valid') return jres(200, { model: 'claude-haiku-4-5', choices: [{ message: { content: JSON.stringify(PLAN_NOW) }, finish_reason: 'length' }], usage: { completion_tokens: 4000 } });
  if (AI.mode === 'thin') return jres(200, { model: 'claude-haiku-4-5', choices: [{ message: { content: JSON.stringify(Object.assign({}, PLAN_NOW, { priorities: [], campaigns: [] })) }, finish_reason: 'stop' }] });
  if (AI.mode === 'empty') return jres(200, { model: 'claude-haiku-4-5', choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  return jres(200, { model: 'claude-haiku-4-5', choices: [{ message: { content: JSON.stringify(PLAN_NOW) }, finish_reason: 'stop' }], usage: { prompt_tokens: 2400, completion_tokens: 1700 } });
};

// ── Stripe fake ──
// Test Price IDs for the five plans (this process only) and the matching
// Stripe prices checkout verifies (tests/helpers/pgPayments.js).
const TEST_PRICES = require('./helpers/pgPayments').installTestPrices(require(require('path').join(H.SERVER_DIR, 'services', 'pricing')));
H.STRIPE['prices.retrieve'] = async (id) => { if (!TEST_PRICES[id]) throw Object.assign(new Error('No such price'), { statusCode: 404 }); return Object.assign({}, TEST_PRICES[id]); };
const SESS = {};
let csN = 0;
H.STRIPE['checkout.sessions.create'] = async (params) => { const id = 'cs_test_' + String(++csN).padStart(12, '0'); SESS[id] = { id, params, paid: false, status: 'open' }; return { id, url: 'https://checkout.stripe.test/' + id }; };
H.STRIPE['checkout.sessions.retrieve'] = async (id) => { const s = SESS[id]; if (!s) throw Object.assign(new Error('No such session'), { statusCode: 404 }); return sessionObj(s); };
H.STRIPE['checkout.sessions.expire'] = async (id) => { SESS[id].status = 'expired'; return { id }; };
// The paid line item (plan price before VAT, 21 % VAT on top): checked before access opens.
H.STRIPE['checkout.sessions.listLineItems'] = async (id) => { const s = SESS[id]; if (!s) throw Object.assign(new Error('No such session'), { statusCode: 404 }); return require('./helpers/pgPayments').lineItemsFor(s.params, TEST_PRICES); };
H.STRIPE['webhooks.constructEvent'] = (body, sig) => { if (sig !== 'valid-signature') throw new Error('bad signature'); return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); };
// The session as Stripe reports it: plan price + 21 % VAT on top (exclusive prices).
function sessionObj(s) {
  return require('./helpers/pgPayments').paidSessionFor(s.id, s.params, TEST_PRICES, { status: s.paid ? 'complete' : s.status, payment_status: s.paid ? 'paid' : 'unpaid' });
}
const lastSession = () => SESS['cs_test_' + String(csN).padStart(12, '0')];
const webhook = (eventId, s) => H.call('POST', '/api/stripe-webhook', null, JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: sessionObj(s) } }), { 'stripe-signature': 'valid-signature' });

const ANSWERS = {
  business: { name: 'Bloom & Wick', industry: 'Retail & e-commerce', offer: 'Hand-poured soy candles', area: 'Utrecht' },
  audience: { type: 'b2c', ideal: 'Gift shoppers', location: 'regional', problem: 'Finding a personal gift' },
  offer: { main: 'Soy candles', different: 'Poured by hand', price: 'premium' },
  goals: { primary: 'sales', success: '50 orders a month' },
  marketing: { channels: ['instagram'], challenge: 'time', paidAds: 'no' },
  budget: { budget: '250_500', time: '2_5', team: 'me' },
};
async function waitPlan(id, ms) { for (let i = 0; i < (ms || 6000) / 50 && sess(id) && sess(id).plan_status === 'generating'; i++) await sleep(50); }
// The questions and the assistant, then straight to the plans: nothing is
// generated before payment.
async function toPaywall(tok) {
  await H.call('PUT', '/api/onboarding/session', tok, { answers: ANSWERS, assistant: 'vector', step: 'paywall' });
}

(async () => {
  const quiet = await H.start();
  const { call } = H;

  // ── A. New user: signup → questions → plan → paywall ───────────
  log('\nA. New user');
  let r = await call('POST', '/api/signup', null, { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', password: 'secret123' });
  const ann = H.AUTH.users.find((u) => u.email === 'ann@example.com');
  const A = 'tok_' + ann.id;
  check('A.1 signup creates the account (existing signup route)', r.status === 200 && !!ann && !!prof(ann.id));
  r = await call('GET', '/api/onboarding/state', A);
  check('A.2 the new account is in the mandatory onboarding', r.body.eligible === true && r.body.flow && r.body.flow.enabled === true, r.body);
  await call('PUT', '/api/onboarding/session', A, { step: 'business', answers: { business: { name: 'Bloom & Wick' } } });
  check('A.3 answers are linked to this account as they are typed', sess(ann.id) && sess(ann.id).answers.business.name === 'Bloom & Wick');
  const ai0 = AI.calls;
  await call('PUT', '/api/onboarding/session', A, { answers: ANSWERS, assistant: 'vector', step: 'paywall' });
  r = await call('POST', '/api/onboarding/plan', A, {});
  check('A.4 after the assistant the customer goes to the plans; a plan can’t be generated before payment (402, no AI call)', r.status === 402 && r.body.code === 'ACCESS_REQUIRED' && AI.calls === ai0);
  r = await call('GET', '/api/onboarding/session', A);
  check('A.5 the answers are saved, the step is the plans, no plan exists yet', r.body.session.step === 'paywall' && r.body.session.plan.status === 'none' && r.body.session.missing.length === 0 && !sess(ann.id).plan);
  check('A.6 the plan never reaches the browser before payment (session and plan responses)', !/Grow repeat candle sales/.test(JSON.stringify(r.body)) && !/Grow repeat candle sales/.test(JSON.stringify((await call('GET', '/api/onboarding/plan', A)).body)));

  // ── E / G. No payment: blocked everywhere that matters ──────────
  log('\nE/G. Without payment');
  const blocked = [];
  for (const [m, p] of [['GET', '/api/business/profile'], ['GET', '/api/campaigns'], ['GET', '/api/credits/status'], ['POST', '/api/ai/chat'], ['POST', '/api/generate-image'], ['GET', '/api/notifications'], ['PUT', '/api/business/profile']]) {
    const x = await call(m, p, A, m === 'GET' ? null : { message: 'hi', prompt: 'x' }, { 'X-Idempotency-Key': 'k' + Math.random() });
    blocked.push([p, x.status, x.body && x.body.code]);
  }
  check('G.1 every app route (Control Center data, chat, create, notifications, writes) → 403 ONBOARDING_REQUIRED', blocked.every((b) => b[1] === 403 && b[2] === 'ONBOARDING_REQUIRED'), blocked);
  r = await call('GET', '/api/onboarding/session', A);
  const open = [(await call('GET', '/api/get-subscription', A)).status, r.status, (await call('GET', '/api/email/preferences', A)).status];
  check('G.2 what the onboarding and the payment need still works (session, subscription status, email preferences)', open.every((s) => s === 200), open);
  r = await call('GET', '/api/campaigns?paid=1&unlocked=true', A, null, { 'X-Paid': 'true', 'X-Onboarding-Complete': 'true' });
  check('G.3 manipulated query strings and headers change nothing', r.status === 403 && r.body.code === 'ONBOARDING_REQUIRED');
  r = await call('PUT', '/api/user/preferences', A, { onboarding_completed: true, subscription_status: 'paid' });
  check('G.4 writing "completed"/"paid" through preferences changes nothing', (await call('GET', '/api/campaigns', A)).status === 403 && prof(ann.id).onboarding_completed !== true && prof(ann.id).subscription_status === 'free');
  r = await call('POST', '/api/onboarding/complete', A, {});
  check('G.5 the old "complete onboarding" route can’t be used to skip the paywall', (await call('GET', '/api/campaigns', A)).status === 403 || prof(ann.id).onboarding_completed !== true, { complete: r.status, completed: prof(ann.id).onboarding_completed });

  // ── B. Leave at the paywall, come back ──────────────────────────
  log('\nB. Close the browser at the paywall, sign in again');
  const aiB = AI.calls;
  r = await call('GET', '/api/onboarding/state', A);
  const again = await call('POST', '/api/onboarding/plan', A, {});
  check('B.1 next day: state reopens the onboarding at the plans with the saved answers', r.body.flow.enabled === true && r.body.flow.session.step === 'paywall' && r.body.flow.session.answers.business.name === 'Bloom & Wick');
  check('B.2 no generation before payment (refreshing, signing in again or pressing Continue)', again.status === 402 && AI.calls === aiB);

  // ── C. Leave halfway, resume ────────────────────────────────────
  log('\nC. Leave halfway, resume');
  const C = user('obC');
  await call('PUT', '/api/onboarding/session', C, { step: 'offer-different', answers: { business: ANSWERS.business, audience: ANSWERS.audience, offer: { main: 'Soy candles' } } });
  r = await call('GET', '/api/onboarding/state', C);
  check('C.1 signing in again resumes at the saved screen with the saved answers', r.body.flow.session.step === 'offer-different' && r.body.flow.session.answers.offer.main === 'Soy candles' && r.body.flow.session.plan.status === 'none');

  // ── F. Stripe return before the webhook ─────────────────────────
  log('\nF. Return from Stripe before the webhook');
  r = await call('POST', '/api/create-checkout-session', A, { plan: 'monthly', source: 'app' });
  check('F.1 "Choose Monthly" uses the existing checkout (one pending purchase)', r.status === 200 && /checkout\.stripe\.test/.test(r.body.url) && purchasesOf(ann.id).filter((p) => p.status === 'pending').length === 1, r.body);
  const sA = lastSession();
  r = await call('GET', '/api/onboarding/plan', A);
  check('F.2 back from Stripe, payment not completed: locked, "payment in progress" reported, nothing granted', r.body.locked === true && r.body.checkoutPending === true && !(prof(ann.id).credits_balance > 0) && !r.body.plan, { body: r.body });
  r = await call('POST', '/api/billing/sync-checkout', A, { session_id: sA.id });
  check('F.3 the Stripe return (?success=true&session_id) alone grants nothing while Stripe says unpaid', r.status === 200 && (r.body.skipped || '').indexOf('payment_unpaid') === 0 && (await call('GET', '/api/campaigns', A)).status === 403, r.body);
  sA.paid = true; // the customer paid; the webhook hasn't arrived
  r = await call('GET', '/api/onboarding/plan', A);
  check('F.4 the server re-checks the open checkout with Stripe itself: paid → access, unlocked, onboarding completed', r.body.locked === false && prof(ann.id).subscription_status === 'paid' && prof(ann.id).onboarding_completed === true && sess(ann.id).purchase_id === purchasesOf(ann.id)[0].id, { locked: r.body.locked, status: prof(ann.id).subscription_status });
  await waitPlan(ann.id);
  r = await call('GET', '/api/onboarding/plan', A);
  check('F.4b …then the plan is generated once, for the purchased period (Monthly: "the next 1 month", 4 weekly phases), with provider metadata', r.body.status === 'ready' && r.body.plan && r.body.plan.horizon.period === 'monthly' && r.body.plan.roadmap.length === 4 && /covering the next 1 month/.test(AI.lastSystem) && sess(ann.id).plan.meta.finish_reason === 'stop' && AI.calls === aiB + 1, { status: r.body.status, calls: AI.calls - aiB });
  const credA = prof(ann.id).credits_balance;
  check('F.5 the plan’s credits are granted (monthly: 1,750)', credA === 1750, credA);
  r = await call('GET', '/api/campaigns', A);
  check('F.6 the app is reachable at once (gate cleared for this account)', r.status === 200);
  r = await call('GET', '/api/onboarding/state', A);
  check('F.7 state: onboarding completed → the frontend goes straight to /app', r.body.eligible === false && r.body.completed === true && r.body.flow.enabled === false);

  // ── I. Duplicates ───────────────────────────────────────────────
  log('\nI. Duplicate webhooks, syncs, refreshes');
  const w1 = await webhook('evt_A1', sA), w2 = await webhook('evt_A1', sA), w3 = await webhook('evt_A2', sA);
  await call('POST', '/api/billing/sync-checkout', A, { session_id: sA.id });
  await Promise.all([1, 2, 3, 4].map(() => call('GET', '/api/onboarding/plan', A)));
  check('I.1 late + duplicate webhooks, another sync, parallel reads: one paid purchase, credits once, one generation in total', w1.status === 200 && w2.body.duplicate === true && w3.status === 200 && purchasesOf(ann.id).filter((p) => p.status === 'paid').length === 1 && prof(ann.id).credits_balance === credA && AI.calls === aiB + 1, { w2: w2.body, bal: prof(ann.id).credits_balance, calls: AI.calls - aiB });
  const D2 = user('obDup');
  await toPaywall(D2);
  await Promise.all([1, 2, 3].map(() => call('POST', '/api/create-checkout-session', D2, { plan: 'flex' })));
  check('I.2 three checkout clicks at once: at most one open checkout remains', purchasesOf('obDup').filter((p) => p.status === 'pending').length <= 1, purchasesOf('obDup').map((p) => p.status));

  // ── D. Pay, the webhook confirms, done ──────────────────────────
  log('\nD. Payment confirmed by the webhook');
  const D = user('obD');
  await toPaywall(D);
  await call('POST', '/api/create-checkout-session', D, { plan: 'quarterly' });
  const sD = lastSession();
  sD.paid = true;
  r = await call('POST', '/api/stripe-webhook', null, JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: sessionObj(sD) } }), { 'stripe-signature': 'forged' });
  check('D.1 a forged webhook (bad signature) is refused, nothing granted', r.status === 400 && prof('obD').subscription_status === 'free');
  r = await webhook('evt_D1', sD);
  check('D.2 the signed webhook: purchase paid, access + first instalment of credits (1,600), onboarding completed without the browser', r.status === 200 && prof('obD').subscription_status === 'paid' && prof('obD').credits_balance === 1600 && prof('obD').onboarding_completed === true && sess('obD').status === 'completed' && !!sess('obD').unlocked_at, { status: prof('obD').subscription_status, bal: prof('obD').credits_balance, done: prof('obD').onboarding_completed });
  await waitPlan('obD');
  check('D.2b the webhook also starts the plan without the browser, for the purchased Quarterly period (6 phases)', sess('obD').plan_status === 'ready' && sess('obD').plan.horizon.period === 'quarterly' && sess('obD').plan.roadmap.length === 6);
  r = await call('GET', '/api/onboarding/plan', D);
  check('D.3 the plan is available after payment (Control Center → Marketing Plan reads it)', r.body.locked === false && r.body.plan && r.body.plan.summary === PLAN.summary);
  r = await call('GET', '/api/onboarding/progress', D);
  check('D.3b …and Progress lists its steps (6 phases × 3 in-app tasks)', r.body.locked === false && r.body.total === 18 && r.body.phases.length === 6);
  check('D.4 no second plan, no second payment needed: state says completed, gate open', (await call('GET', '/api/onboarding/state', D)).body.flow.enabled === false && (await call('GET', '/api/campaigns', D)).status === 200);

  // ── H. Existing customers ───────────────────────────────────────
  log('\nH. Existing customers');
  user('obPaidOld', { created_at: '2026-01-01T00:00:00Z', subscription_status: 'paid', access_expires_at: new Date(Date.now() + 20 * 864e5).toISOString(), onboarding_completed: true, credits_balance: 900 });
  user('obPaidNew', { subscription_status: 'paid', access_expires_at: new Date(Date.now() + 20 * 864e5).toISOString(), credits_balance: 900 });
  user('obFreeOld', { created_at: '2026-01-01T00:00:00Z' });
  user('obLegacy', { created_at: '2026-01-01T00:00:00Z', subscription_status: 'starter', credits_cycle_end: new Date(Date.now() + 10 * 864e5).toISOString() });
  const hs = [];
  for (const id of ['obPaidOld', 'obPaidNew', 'obFreeOld', 'obLegacy']) {
    const st = await call('GET', '/api/onboarding/state', 'tok_' + id), c = await call('GET', '/api/campaigns', 'tok_' + id);
    hs.push([id, st.body.flow.enabled, c.status]);
  }
  check('H.1 paying customers (old and new) and existing free accounts: no onboarding forced, app routes answer as before', hs.every((h) => h[1] === false && h[2] === 200), hs);

  // ── Complete-response checks ────────────────────────────────────
  log('\nComplete provider response');
  for (const [mode, code, label] of [['truncated', 'incomplete_output', 'cut off at the token limit (finish_reason "length")'], ['cutoff-valid', 'incomplete_output', 'parseable but cut off'], ['thin', 'invalid_output', 'too thin to be useful'], ['empty', 'invalid_output', 'empty content']]) {
    const id = 'obAI_' + mode, T = user(id);
    AI.mode = mode;
    await call('PUT', '/api/onboarding/session', T, { answers: ANSWERS, assistant: 'nova' });
    Object.assign(prof(id), { subscription_status: 'paid', access_expires_at: new Date(Date.now() + 20 * 864e5).toISOString(), access_plan: 'monthly' });
    await call('GET', '/api/onboarding/plan', T);
    await waitPlan(id);
    const s = (await call('GET', '/api/onboarding/plan', T)).body;
    check('R.' + mode + ' response ' + label + ' → "failed" (' + code + '), never "ready", nothing stored, retry offered', s.status === 'failed' && sess(id).plan_error === code && !sess(id).plan && !s.plan && s.attemptsLeft === 2, { status: s.status, err: sess(id).plan_error });
  }
  AI.mode = 'ok';
  const X = user('obX');
  await call('PUT', '/api/onboarding/session', X, { answers: ANSWERS, assistant: 'nova' });
  H.rows('onboarding_sessions').find((x) => x.user_id === 'obX').plan_attempts = 3;
  H.rows('onboarding_sessions').find((x) => x.user_id === 'obX').plan_status = 'failed';
  await call('POST', '/api/create-checkout-session', X, { plan: 'flex' });
  const sX = lastSession(); sX.paid = true;
  await webhook('evt_X1', sX);
  r = await call('GET', '/api/onboarding/state', X);
  check('R.never-stuck every attempt failed, customer pays anyway → onboarding completes, the app opens (no plan to show)', prof('obX').onboarding_completed === true && r.body.flow.enabled === false && (await call('GET', '/api/campaigns', X)).status === 200);

  check('Z. no unexpected outbound network calls', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { console.error(e); process.exit(1); });
