// ════════════════════════════════════════════════════════════════
// Stripe Checkout session creation — POST /api/create-checkout-session in
// the REAL server.js (services/purchases.js createCheckout, pricing.js price
// resolution), Stripe and Supabase mocked (tests/helpers/mockServer.js).
//
//   · all five plans: the plan's verified Price, one-time payment mode, the
//     Stripe URL returned unchanged
//   · success/cancel URLs: the app (https://orivenai.com/app in production),
//     never the API host (RENDER_EXTERNAL_URL), {CHECKOUT_SESSION_ID} kept
//   · STRIPE_PRICE_SEMI_ANNUAL_<MODE> accepted for Semi-Annual
//   · refusals carry a clear message + code; nothing opens without a URL
//
// No network, no Stripe, no Supabase, no payments.
// RUN: node tests/checkout-session.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5662, env: { CHECKOUT_RESYNC_MS: '0' } });
const { check, log, done } = reporter();
const NEW = new Date().toISOString();
let uN = 0;
function user() {
  const id = 'ck' + String(++uN).padStart(4, '0') + '-0000-4000-8000-000000000000';
  H.rows('profiles').push({ id, subscription_status: 'free', created_at: NEW, credits_balance: 0, onboarding_completed: false, access_expires_at: null, preferences: {} });
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: NEW };
  return 'tok_' + id;
}
const pricing = require(path.join(H.SERVER_DIR, 'services', 'pricing'));
const purchases = require(path.join(H.SERVER_DIR, 'services', 'purchases'));
const TEST_PRICES = require('./helpers/pgPayments').installTestPrices(pricing);
H.STRIPE['prices.retrieve'] = async (id) => { if (!TEST_PRICES[id]) throw Object.assign(new Error('No such price'), { statusCode: 404 }); return Object.assign({}, TEST_PRICES[id]); };
const CREATED = [];
let sessionUrl = (id) => 'https://checkout.stripe.com/c/pay/' + id + '#fidkdWxOYHwnPyd1blpxYHZxWjA0';
H.STRIPE['checkout.sessions.create'] = async (params, opts) => { const id = 'cs_test_' + String(CREATED.length + 1).padStart(10, '0'); CREATED.push({ id, params, opts }); return { id, url: sessionUrl(id) }; };
H.STRIPE['checkout.sessions.retrieve'] = async (id) => ({ id, status: 'open' });
H.STRIPE['checkout.sessions.expire'] = async (id) => ({ id });

(async () => {
  const quiet = await H.start();
  const { call } = H;

  // ── A. All five plans ──────────────────────────────────────────
  log('\nA. Session per plan');
  for (const id of pricing.PLAN_ORDER) {
    const tok = user();
    const n = CREATED.length;
    const r = await call('POST', '/api/create-checkout-session', tok, { plan: id, source: 'onboarding' });
    const c = CREATED[n];
    const plan = pricing.PLANS[id];
    check('A.' + id + ' 200 with exactly the Stripe Session URL; mode payment, the plan\'s verified Price ×1, no renewal; idempotency key per purchase',
      r.status === 200 && c && r.body.url === sessionUrl(c.id) && Object.keys(r.body).join() === 'url' &&
      c.params.mode === 'payment' && c.params.line_items.length === 1 && c.params.line_items[0].price === plan.stripePriceId && TEST_PRICES[plan.stripePriceId].unit_amount === pricing.priceInclVatCents(plan) &&
      c.params.metadata.planId === id && /^purchase-/.test(c.opts.idempotencyKey), { status: r.status, body: r.body, params: c && c.params });
    check('A.' + id + ' return URLs: success → the app with {CHECKOUT_SESSION_ID} untouched, cancel → the app',
      c && c.params.success_url === 'http://localhost:8899/app?success=true&session_id={CHECKOUT_SESSION_ID}' && c.params.cancel_url === 'http://localhost:8899/app?canceled=true', c && [c.params.success_url, c.params.cancel_url]);
    const pu = H.rows('purchases').find((p) => p.stripe_checkout_session_id === (c && c.id));
    check('A.' + id + ' a pending purchase only — nothing granted before Stripe confirms the payment', pu && pu.status === 'pending' && pu.plan_id === id, pu);
  }

  // ── B. Return URLs in production ───────────────────────────────
  log('\nB. Return URLs');
  const env0 = { FRONTEND_URL: process.env.FRONTEND_URL, RENDER: process.env.RENDER, RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL, NODE_ENV: process.env.NODE_ENV };
  const U = (e) => purchases.checkoutReturnUrls(e);
  const prod = U({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://oriven-backand-clean.onrender.com' });
  check('B1. on Render without FRONTEND_URL: https://orivenai.com/app (never the API host)', prod.successUrl === 'https://orivenai.com/app?success=true&session_id={CHECKOUT_SESSION_ID}' && prod.cancelUrl === 'https://orivenai.com/app?canceled=true', prod);
  const set = U({ FRONTEND_URL: 'https://orivenai.com/', RENDER: 'true' });
  check('B2. FRONTEND_URL=https://orivenai.com/ (trailing slash) → https://orivenai.com/app…', set.successUrl === 'https://orivenai.com/app?success=true&session_id={CHECKOUT_SESSION_ID}', set);
  const bad = U({ FRONTEND_URL: 'http://orivenai.com', NODE_ENV: 'production' });
  check('B3. a non-https FRONTEND_URL in production is not used → https://orivenai.com', bad.successUrl.startsWith('https://orivenai.com/app?'), bad);
  check('B4. local development: http://localhost:5500', U({}).successUrl.startsWith('http://localhost:5500/app?'), U({}));
  Object.assign(process.env, { RENDER: 'true', RENDER_EXTERNAL_URL: 'https://oriven-backand-clean.onrender.com' }); delete process.env.FRONTEND_URL;
  let n = CREATED.length;
  let r = await call('POST', '/api/create-checkout-session', user(), { plan: 'annual' });
  check('B5. the route itself (Render, FRONTEND_URL unset): success_url https://orivenai.com/app?success=true&session_id={CHECKOUT_SESSION_ID}',
    r.status === 200 && CREATED[n] && CREATED[n].params.success_url === 'https://orivenai.com/app?success=true&session_id={CHECKOUT_SESSION_ID}' && CREATED[n].params.cancel_url === 'https://orivenai.com/app?canceled=true', CREATED[n] && CREATED[n].params.success_url);
  for (const k of Object.keys(env0)) { if (env0[k] === undefined) delete process.env[k]; else process.env[k] = env0[k]; }

  // ── C. Refusals ────────────────────────────────────────────────
  log('\nC. Refusals');
  r = await call('POST', '/api/create-checkout-session', null, { plan: 'annual' });
  check('C1. signed out → 401 AUTH_REQUIRED, nothing created', r.status === 401 && r.body.code === 'AUTH_REQUIRED');
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'lifetime' });
  check('C2. unknown plan → 400 UNKNOWN_PLAN', r.status === 400 && r.body.code === 'UNKNOWN_PLAN');
  const keep = pricing.PLANS.quarterly.stripePriceId;
  pricing.PLANS.quarterly.stripePriceId = 'PASTE_QUARTERLY_PRICE_ID_HERE'; purchases._resetForTests();
  n = CREATED.length;
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'quarterly' });
  check('C3. price not configured → 503 PRICE_NOT_CONFIGURED with a clear message; no Stripe session', r.status === 503 && r.body.code === 'PRICE_NOT_CONFIGURED' && /Nothing was charged/.test(r.body.error) && CREATED.length === n, r.body);
  pricing.PLANS.quarterly.stripePriceId = keep;
  sessionUrl = () => null;
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'monthly' });
  check('C4. Stripe answers without a URL → 502 CHECKOUT_UNAVAILABLE (the browser gets nothing to open)', r.status === 502 && r.body.code === 'CHECKOUT_UNAVAILABLE' && !r.body.url, r.body);
  sessionUrl = (id) => 'https://checkout.stripe.com/c/pay/' + id;
  H.STRIPE['checkout.sessions.create'] = async () => { throw Object.assign(new Error('boom'), { type: 'StripeAPIError' }); };
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'monthly' });
  check('C5. Stripe error → 500 CHECKOUT_FAILED, "Nothing was charged"', r.status === 500 && r.body.code === 'CHECKOUT_FAILED' && /Nothing was charged/.test(r.body.error), r.body);
  H.STRIPE['checkout.sessions.create'] = async (params, opts) => { const id = 'cs_test_' + String(CREATED.length + 1).padStart(10, '0'); CREATED.push({ id, params, opts }); return { id, url: sessionUrl(id) }; };
  const T = user(); let codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call('POST', '/api/create-checkout-session', T, { plan: 'flex' })).status);
  const last = await call('POST', '/api/create-checkout-session', T, { plan: 'flex' });
  check('C6. more than 6 attempts a minute → 429 CHECKOUT_RATE_LIMITED', codes.slice(0, 6).every((s) => s === 200) && last.status === 429 && last.body.code === 'CHECKOUT_RATE_LIMITED', { codes, last: last.body });
  const tid = T.slice(4);
  const pend = H.rows('purchases').filter((p) => p.user_id === tid && p.status === 'pending');
  check('C7. repeated checkouts leave one open purchase (earlier ones expired)', pend.length === 1, pend.length);

  // ── D. Semi-Annual price variable name ─────────────────────────
  log('\nD. Price environment variables');
  const ids = pricing.priceIdsForMode('live', { STRIPE_PRICE_FLEX_LIVE: 'price_flexAAAA1111', STRIPE_PRICE_MONTHLY_LIVE: 'price_monthAAAA111', STRIPE_PRICE_QUARTERLY_LIVE: 'price_quartAAAA111', STRIPE_PRICE_SEMI_ANNUAL_LIVE: 'price_semiAAAA1111', STRIPE_PRICE_ANNUAL_LIVE: 'price_annualAAAA11' });
  check('D1. the five Render names (…_SEMI_ANNUAL_LIVE included) resolve every plan', ids.flex === 'price_flexAAAA1111' && ids.monthly === 'price_monthAAAA111' && ids.quarterly === 'price_quartAAAA111' && ids.semiannual === 'price_semiAAAA1111' && ids.annual === 'price_annualAAAA11', ids);
  const both = pricing.priceIdsForMode('live', { STRIPE_PRICE_SEMIANNUAL_LIVE: 'price_mainAAAA1111', STRIPE_PRICE_SEMI_ANNUAL_LIVE: 'price_aliasAAAA111' });
  check('D2. STRIPE_PRICE_SEMIANNUAL_LIVE still wins when both are set', both.semiannual === 'price_mainAAAA1111', both);
  const tst = pricing.priceIdsForMode('test', { STRIPE_PRICE_SEMI_ANNUAL_TEST: 'price_semiTTTT1111' });
  check('D3. Test Mode alias (…_SEMI_ANNUAL_TEST) too; nothing set stays the placeholder (refused)', tst.semiannual === 'price_semiTTTT1111' && /PASTE_/.test(tst.annual), tst);
  check('D4. diagnostics name the variable that holds the price', pricing.priceEnvNameFor('semiannual', 'live', { STRIPE_PRICE_SEMI_ANNUAL_LIVE: 'x' }) === 'STRIPE_PRICE_SEMI_ANNUAL_LIVE' && pricing.priceEnvNameFor('annual', 'live', {}) === null);
  // A fresh process with a live-format (fake) key: what the server reads at startup.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, STRIPE_SECRET_KEY: 'sk_live_' + 'x'.repeat(24), STRIPE_PRICE_SEMI_ANNUAL_LIVE: 'price_semiLLLL1111' };
  const out = spawnSync(process.execPath, ['-e', "const p=require('./services/pricing');process.stdout.write(JSON.stringify({m:p.STRIPE_MODE,id:p.stripePriceIdFor('semiannual')}))"], { cwd: H.SERVER_DIR, env, encoding: 'utf8' });
  let got = null; try { got = JSON.parse(out.stdout); } catch (_) {}
  check('D5. at startup with a live key, Semi-Annual uses STRIPE_PRICE_SEMI_ANNUAL_LIVE', got && got.m === 'live' && got.id === 'price_semiLLLL1111', out.stdout || out.stderr);

  // ── E. The price rules (pure) ─────────────────────────────────
  log('\nE. Which Stripe Prices are accepted (VAT on top: tax-exclusive)');
  const plan = pricing.PLANS.annual;
  const good = { id: 'price_annualXX11', object: 'price', active: true, type: 'one_time', recurring: null, currency: 'eur', unit_amount: 24500, tax_behavior: 'exclusive', livemode: true, product: 'prod_x' };
  const P = (over, taxDefault, mode) => purchases.priceProblems(Object.assign({}, good, over), { priceId: good.id, plan, mode: mode || 'live', taxDefault });
  const cases = [
    ['E1. one-time, EUR, €245.00 before VAT, tax EXCLUSIVE, live price + live key → accepted', P({}), true],
    ['E2. tax unspecified + account default "exclusive" → accepted', P({ tax_behavior: 'unspecified' }, 'exclusive'), true],
    ['E3. tax INCLUSIVE (VAT inside the price) → refused', P({ tax_behavior: 'inclusive' }, 'exclusive'), false],
    ['E4. tax unspecified + account default "inclusive" → refused', P({ tax_behavior: 'unspecified' }, 'inclusive'), false],
    ['E5. tax unspecified + default "inferred_by_currency" (EUR = inclusive) → refused', P({ tax_behavior: null }, 'inferred_by_currency'), false],
    ['E6. tax unspecified + default unreadable → refused', P({ tax_behavior: 'unspecified' }, null), false],
    ['E7. recurring price → still refused', P({ type: 'recurring', recurring: { interval: 'month' } }), false],
    ['E8. archived price → refused', P({ active: false }), false],
    ['E9. another base amount (€296.45 entered as the price, or 245 cents) → refused', P({ unit_amount: 29645 }).length > 0 && P({ unit_amount: 245 }).length > 0 ? [] : ['x'], true],
    ['E10. USD → refused', P({ currency: 'usd' }), false],
    ['E11. test-mode price with a live key → refused', P({ livemode: false }), false],
  ];
  for (const [name, problems, accepted] of cases) check(name, (problems.length === 0) === accepted, problems);

  // ── F. Tax default through the real checkout route ─────────────
  log('\nF. Checkout with prices whose tax behaviour is unspecified');
  const saved = {};
  for (const id of Object.keys(TEST_PRICES)) { saved[id] = TEST_PRICES[id].tax_behavior; TEST_PRICES[id].tax_behavior = 'unspecified'; }
  let taxReads = 0;
  H.STRIPE['tax.settings.retrieve'] = async () => { taxReads++; return { object: 'tax.settings', status: 'active', defaults: { tax_behavior: 'exclusive', tax_code: null } }; };
  purchases._resetForTests();
  for (const id of pricing.PLAN_ORDER) {
    r = await call('POST', '/api/create-checkout-session', user(), { plan: id });
    check('F.' + id + ' price "unspecified" + account default exclusive → checkout opens', r.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(r.body.url), r.body);
  }
  check('F.tax the account default is read once and cached', taxReads === 1, taxReads);
  H.STRIPE['tax.settings.retrieve'] = async () => ({ object: 'tax.settings', status: 'active', defaults: { tax_behavior: 'inclusive' } });
  purchases._resetForTests(); n = CREATED.length;
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'flex' });
  check('F.incl account default inclusive → 503 PRICE_CONFIG_MISMATCH, no session', r.status === 503 && r.body.code === 'PRICE_CONFIG_MISMATCH' && CREATED.length === n, r.body);
  for (const id of Object.keys(TEST_PRICES)) TEST_PRICES[id].tax_behavior = saved[id];
  H.STRIPE['tax.settings.retrieve'] = async () => ({ object: 'tax.settings', status: 'active', defaults: { tax_behavior: 'exclusive' } });
  const keepRetrieve = H.STRIPE['prices.retrieve'];
  H.STRIPE['prices.retrieve'] = async () => { throw Object.assign(new Error('No such price'), { statusCode: 404, code: 'resource_missing' }); };
  purchases._resetForTests();
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'monthly' });
  check('F.404 a price id Stripe doesn\'t know (other account / other mode) → 503 PRICE_NOT_CONFIGURED', r.status === 503 && r.body.code === 'PRICE_NOT_CONFIGURED', r.body);
  H.STRIPE['prices.retrieve'] = keepRetrieve; purchases._resetForTests();
  n = CREATED.length;
  r = await call('POST', '/api/create-checkout-session', user(), { plan: 'annual' });
  check('F.consumer a VAT number is offered but never required (consumers pay without one): tax_id_collection has no "required"', r.status === 200 && CREATED[n].params.tax_id_collection.enabled === true && !CREATED[n].params.tax_id_collection.required, CREATED[n] && CREATED[n].params.tax_id_collection);
  check('F.tax checkout asks Stripe Tax to add VAT (automatic_tax on, billing address required, optional VAT ID), one line: the plan\'s price ×1',
    r.status === 200 && CREATED[n].params.automatic_tax.enabled === true && CREATED[n].params.billing_address_collection === 'required' && CREATED[n].params.tax_id_collection.enabled === true && CREATED[n].params.line_items.length === 1 && CREATED[n].params.line_items[0].quantity === 1, CREATED[n] && CREATED[n].params);

  // ── G. The per-plan report (startup log, admin check, script) ──
  log('\nG. Price report');
  let rep = await purchases.checkStripePrices();
  check('G1. all five plans OK, with expected amounts 1700/2900/7800/14300/24500 and no secrets', rep.allOk && rep.plans.map((p) => p.expected.amount).join() === '1700,2900,7800,14300,24500' && !JSON.stringify(rep).includes('sk_test_mock_only'), rep.plans.map((p) => [p.plan, p.problems]));
  const recurringId = pricing.PLANS.semiannual.stripePriceId;
  TEST_PRICES[recurringId] = Object.assign({}, TEST_PRICES[recurringId], { type: 'recurring', recurring: { interval: 'month' }, active: false });
  rep = await purchases.checkStripePrices();
  const semi = rep.plans.find((p) => p.plan === 'semiannual');
  check('G2. an old recurring/archived price is named per plan (the others stay OK)', !rep.allOk && !semi.ok && semi.problems.some((x) => /recurring/.test(x)) && semi.problems.some((x) => /archived/.test(x)) && rep.plans.filter((p) => p.ok).length === 4, semi);
  TEST_PRICES[recurringId] = Object.assign({}, TEST_PRICES[recurringId], { type: 'one_time', recurring: null, active: true });
  r = await call('GET', '/api/admin/stripe-prices', user());
  check('G3. GET /api/admin/stripe-prices is refused for non-admins (403)', r.status === 403, r.status);
  r = await call('GET', '/api/admin/stripe-prices', null);
  check('G4. …and for signed-out requests (401)', r.status === 401, r.status);

  // ── H. Payment → webhook → plan + credits, per plan ────────────
  log('\nH. After payment: plan price + VAT, webhook, idempotent credits');
  const PG = require('./helpers/pgPayments');
  const LINES = {}; // session id → line items override
  H.STRIPE['checkout.sessions.listLineItems'] = async (id) => { if (LINES[id] instanceof Error) throw LINES[id]; if (LINES[id]) return LINES[id]; const c = CREATED.find((x) => x.id === id); if (!c) throw Object.assign(new Error('No such session'), { statusCode: 404 }); return PG.lineItemsFor(c.params, TEST_PRICES); };
  const paidSession = (c, over, rate) => PG.paidSessionFor(c.id, c.params, TEST_PRICES, over, rate);
  const hook = (evt, type, s) => call('POST', '/api/stripe-webhook', null, JSON.stringify({ id: evt, type, data: { object: s } }), { 'stripe-signature': 'valid-signature' });
  H.STRIPE['webhooks.constructEvent'] = (body, sig) => { if (sig !== 'valid-signature') throw new Error('bad signature'); return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); };
  const TOTALS = { flex: [1700, 357, 2057], monthly: [2900, 609, 3509], quarterly: [7800, 1638, 9438], semiannual: [14300, 3003, 17303], annual: [24500, 5145, 29645] };
  let evN = 0;
  async function bought(id) { const tok = user(); const k = CREATED.length; await call('POST', '/api/create-checkout-session', tok, { plan: id }); return { tok, uid: tok.slice(4), c: CREATED[k] }; }
  const prof = (uid) => H.rows('profiles').find((x) => x.id === uid);
  const purch = (c) => H.rows('purchases').find((x) => x.stripe_checkout_session_id === c.id);
  for (const id of pricing.PLAN_ORDER) {
    const p = pricing.PLANS[id]; const [base, vat, total] = TOTALS[id];
    const { tok, uid, c } = await bought(id);
    const s = paidSession(c);
    check('H.' + id + ' Stripe charges €' + (base / 100).toFixed(2) + ' + 21 % VAT €' + (vat / 100).toFixed(2) + ' = €' + (total / 100).toFixed(2), s.amount_subtotal === base && s.total_details.amount_tax === vat && s.amount_total === total, s);
    await hook('evt_' + (++evN), 'checkout.session.completed', Object.assign({}, s, { payment_status: 'unpaid' }));
    check('H.' + id + ' an unpaid completed session (e.g. bank transfer pending) grants nothing', prof(uid).credits_balance === 0 && prof(uid).subscription_status === 'free', prof(uid));
    const e = 'evt_' + (++evN);
    const r1 = await hook(e, 'checkout.session.completed', s);
    const pr = prof(uid); const pu = purch(c);
    const first = p.credits / p.instalments;
    check('H.' + id + ' paid webhook → plan "' + id + '", access, ' + first + ' credits (' + p.credits + ' total' + (p.instalments > 1 ? ', ' + p.instalments + ' monthly instalments' : '') + ') — the higher total incl. VAT is accepted',
      r1.status === 200 && pr.subscription_status === 'paid' && pr.access_plan === id && pr.credits_balance === first && !!pr.access_expires_at, { status: r1.status, pr });
    check('H.' + id + ' the purchase records plan price ' + base + ', VAT ' + vat + ', total paid ' + total, pu && pu.price_incl_vat_cents === base && pu.amount_tax_cents === vat && pu.amount_total_cents === total, pu);
    await hook(e, 'checkout.session.completed', s);                               // Stripe retries the same event
    await hook('evt_' + (++evN), 'checkout.session.async_payment_succeeded', s);  // another event for the same payment
    H.STRIPE['checkout.sessions.retrieve'] = async () => s;
    const sync = await call('POST', '/api/billing/sync-checkout', tok, { session_id: c.id }); // the success page's own confirmation
    H.STRIPE['checkout.sessions.retrieve'] = async (sid) => ({ id: sid, status: 'open' });
    const paidRows = H.rows('purchases').filter((x) => x.user_id === uid && x.status === 'paid');
    check('H.' + id + ' repeated event + async event + return-page sync → still exactly ' + first + ' credits, one paid purchase', prof(uid).credits_balance === first && paidRows.length === 1 && sync.status === 200, { bal: prof(uid).credits_balance, paid: paidRows.length, sync: sync.body });
    const forged = await call('POST', '/api/stripe-webhook', null, JSON.stringify({ id: 'evt_forged' + evN, type: 'checkout.session.completed', data: { object: s } }), { 'stripe-signature': 'forged' });
    check('H.' + id + ' a webhook without a valid signature is rejected', forged.status === 400 && prof(uid).credits_balance === first, forged.status);
  }

  log('\nI. Other VAT outcomes and invalid payments');
  {
    const { uid, c } = await bought('monthly');
    LINES[c.id] = PG.lineItemsFor(c.params, TEST_PRICES, 0);
    await hook('evt_' + (++evN), 'checkout.session.completed', paidSession(c, {}, 0));
    check('I1. reverse charge / outside the EU: €29.00 + €0 VAT → accepted, 1,750 credits', prof(uid).credits_balance === 1750 && purch(c).amount_total_cents === 2900 && purch(c).amount_tax_cents === 0, purch(c));
  }
  {
    const { uid, c } = await bought('annual');
    LINES[c.id] = PG.lineItemsFor(c.params, TEST_PRICES, 0.19);
    await hook('evt_' + (++evN), 'checkout.session.completed', paidSession(c, {}, 0.19));
    check('I2. another EU rate (Germany 19 %): €245.00 + €46.55 → accepted, 1,250 credits', prof(uid).credits_balance === 1250 && purch(c).amount_total_cents === 29155, purch(c));
  }
  const refusedCase = async (label, plan, mk) => {
    const { uid, c } = await bought(plan);
    const s = mk(c);
    const res = await hook('evt_' + (++evN), 'checkout.session.completed', s);
    check(label, res.status === 200 && prof(uid).credits_balance === 0 && prof(uid).subscription_status === 'free' && purch(c).status === 'pending', { status: res.status, pu: purch(c), pr: prof(uid) });
  };
  await refusedCase('I3. total ≠ plan price + VAT (€17.00 + €3.57, but €21.57 charged) → no credits', 'flex', (c) => paidSession(c, { amount_total: 2157 }));
  await refusedCase('I4. a different plan price in the paid line item (€15.00 instead of €17.00) → no credits', 'flex', (c) => { LINES[c.id] = { data: [{ price: { id: c.params.line_items[0].price }, quantity: 1, amount_subtotal: 1500, amount_tax: 315, amount_total: 1815, currency: 'eur' }] }; return paidSession(c, { amount_subtotal: 1500, amount_total: 1815, total_details: { amount_tax: 315, amount_discount: 0 } }); });
  await refusedCase('I5. another Stripe Price in the paid line item → no credits', 'monthly', (c) => { LINES[c.id] = { data: [{ price: { id: pricing.PLANS.flex.stripePriceId }, quantity: 1, amount_subtotal: 2900, amount_tax: 609, amount_total: 3509, currency: 'eur' }] }; return paidSession(c); });
  await refusedCase('I6. quantity 2 → no credits', 'monthly', (c) => { LINES[c.id] = { data: [{ price: { id: c.params.line_items[0].price }, quantity: 2, amount_subtotal: 2900, amount_tax: 609, amount_total: 3509, currency: 'eur' }] }; return paidSession(c); });
  {
    const { uid, c } = await bought('quarterly');
    LINES[c.id] = PG.lineItemsFor(c.params, TEST_PRICES, 0.255);
    await hook('evt_' + (++evN), 'checkout.session.completed', paidSession(c, {}, 0.255));
    check('I7. any rate Stripe Tax applies is accepted when Stripe\'s figures add up (25.5 %, as in Finland: €78.00 + €19.89) — no hard-coded maximum', prof(uid).credits_balance === 1600 && purch(c).amount_total_cents === 9789 && purch(c).amount_tax_cents === 1989, purch(c));
  }
  await refusedCase('I7b. tax on the session differs from the tax Stripe reports on the line item → no credits', 'monthly', (c) => paidSession(c, { amount_total: 2900 + 900, total_details: { amount_tax: 900, amount_discount: 0 } }));
  await refusedCase('I8. a discount on the session → no credits', 'monthly', (c) => paidSession(c, { amount_total: 2509, total_details: { amount_tax: 609, amount_discount: 1000 } }));
  await refusedCase('I9. paid in another currency (USD) → no credits', 'monthly', (c) => paidSession(c, { currency: 'usd' }));
  {
    const { uid, c } = await bought('quarterly');
    LINES[c.id] = Object.assign(new Error('Stripe unavailable'), { type: 'StripeConnectionError' });
    const s = paidSession(c);
    const res = await hook('evt_retry1', 'checkout.session.completed', s);
    check('I10. Stripe unreachable while checking the line items → webhook 500 (Stripe retries), nothing granted', res.status >= 500 && prof(uid).credits_balance === 0, { status: res.status });
    delete LINES[c.id];
    const res2 = await hook('evt_retry1', 'checkout.session.completed', s);
    check('I11. …Stripe\'s retry of that same event then grants 1,600 credits once', res2.status === 200 && prof(uid).credits_balance === 1600, { status: res2.status, bal: prof(uid).credits_balance });
  }

  check('Z. no outbound network', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
