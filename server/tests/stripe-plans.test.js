// ════════════════════════════════════════════════════════════════
// The five plans × Stripe, end to end in one in-process Postgres (PGlite):
// the REAL services/pricing.js (Price IDs + validation), services/purchases.js
// (checkout, verified Stripe price, fulfilment, instalments, history),
// docs/migrations/2026-10-access-purchases.sql (fulfill_purchase, credit
// grants, ledger, expiry) and the plan written after payment
// (services/onboardingFlow.js + 2026-10-onboarding-sessions.sql).
// Stripe and the AI model are faked (tests/helpers/pgPayments.js).
// No network, no Supabase, no Stripe, no real customer.
//
// PGlite is not a dependency of this project: the test SKIPS (exit 0) unless
// it can load '@electric-sql/pglite' (point NODE_PATH at a node_modules
// folder that has it).
//
// RUN: NODE_PATH=/path/to/node_modules node tests/stripe-plans.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {
  console.log('SKIP — @electric-sql/pglite not found (set NODE_PATH to a node_modules folder that has it)');
  process.exit(0);
}
const MIG = path.join(__dirname, '..', 'docs', 'migrations');
const pricing = require('../services/pricing');
const purchases = require('../services/purchases');
const flow = require('../services/onboardingFlow');
// Model calls one Marketing Plan takes for a period (long periods are written in chunks).
const planCalls = (id) => Math.ceil(flow.HORIZONS[id].phases.length / flow.HORIZONS[id].chunk);
const onboarding = require('../services/onboarding');
const { BASE, adapter, priceFor, installTestPrices, makeStripe } = require('./helpers/pgPayments');
const FE = path.resolve(__dirname, '..', '..', '..', 'oriven-frontend', 'js', 'plans.js');
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 600) : '')); } }
const _log = console.log, _warn = console.warn;
console.log = (...a) => { if (/^\[(Purchases|OnboardingFlow)\]/.test(String(a[0] || ''))) return; _log(...a); };
console.warn = (...a) => { if (/^\[(Purchases|OnboardingFlow)\]/.test(String(a[0] || ''))) return; _warn(...a); };

const PLACEHOLDERS = Object.assign({}, pricing.STRIPE_PRICE_IDS); // as shipped, before the test configures prices
const PRICES = installTestPrices(pricing);
const { stripe, S, paidSession } = makeStripe(PRICES);
const EXPECT = {
  flex:       { name: 'Flex',        cents: 1700,  days: 14, months: 0,  credits: 1050,  per: 1050, inst: 1,  phases: 2,  label: '14 days' },
  monthly:    { name: 'Monthly',     cents: 2900,  days: 0,  months: 1,  credits: 1750,  per: 1750, inst: 1,  phases: 4,  label: '1 month' },
  quarterly:  { name: 'Quarterly',   cents: 7800,  days: 0,  months: 3,  credits: 4800,  per: 1600, inst: 3,  phases: 6,  label: '3 months' },
  semiannual: { name: 'Semi-Annual', cents: 14300, days: 0,  months: 6,  credits: 8850,  per: 1475, inst: 6,  phases: 6,  label: '6 months' },
  annual:     { name: 'Annual',      cents: 24500, days: 0,  months: 12, credits: 15000, per: 1250, inst: 12, phases: 12, label: '12 months' },
};
let aiCalls = 0;
const PLAN = { summary: 'Grow repeat candle sales in Utrecht with email and one social channel you can keep up.',
  overview: { text: 'Bloom & Wick sells hand-poured candles in Utrecht and online; the plan focuses on repeat buyers first.' },
  audience: { text: 'Local gift shoppers and interior lovers who value natural products.', segments: [{ name: 'Gift shoppers', needs: 'A personal present' }] },
  positioning: { statement: 'Hand-poured, natural candles from a local studio.', proof_points: ['Poured by hand'] },
  objectives: [{ objective: 'Grow repeat orders', measure: 'Repeat orders per month' }], channels: [{ channel: 'Email', role: 'Repeat sales', why: 'Owned audience', effort: 'low' }],
  content: { pillars: [{ name: 'Studio', ideas: ['How a candle is poured'] }], cadence: 'Weekly' }, campaigns: [{ name: 'Workshop launch', goal: 'Bookings', idea: 'Invite past buyers' }],
  priorities: ['Start an email list', 'Plan the first workshop'] };
const aiText = async (task, system) => {
  aiCalls++;
  const m = String(system || '').match(/"roadmap":\[(.*)\]\}\s*\nRoadmap:/);
  const names = m ? Array.from(m[1].matchAll(/"phase":"([^"]+)"/g)).map((x) => x[1]) : [];
  return JSON.stringify(Object.assign({}, PLAN, { roadmap: names.map((n) => ({ phase: n, focus: 'Focus', tasks: require('./helpers/planFixture').tasks(n) })) }));
};
const ANSWERS = { business: { name: 'Bloom & Wick', industry: 'Retail', offer: 'Candles', area: 'Utrecht' }, audience: { type: 'b2c', ideal: 'x', location: 'local', problem: 'x' },
  offer: { main: 'x', different: 'x', price: 'mid' }, goals: { primary: 'sales', success: 'x' }, marketing: { channels: ['none'], challenge: 'time', paidAds: 'no' }, budget: { budget: 'none', time: 'lt2', team: 'me' } };
const one = async (pg, sql, p) => (await pg.query(sql, p || [])).rows[0];
const all = async (pg, sql, p) => (await pg.query(sql, p || [])).rows;
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

(async () => {
  const pg = new PGlite();
  await pg.exec(BASE);
  await pg.exec(fs.readFileSync(path.join(MIG, '2026-10-access-purchases.sql'), 'utf8'));
  await pg.exec(fs.readFileSync(path.join(MIG, '2026-10-onboarding-sessions.sql'), 'utf8'));
  const db = adapter(pg);
  purchases.init({ stripe, db });
  onboarding.init({ db });
  flow.init({ db, aiText, fetchUrl: async () => ({ ok: false }), validateUrl: () => true, onComplete: async (userId) => { await onboarding.complete(userId, null); } });
  const profile = (id) => one(pg, 'SELECT * FROM profiles WHERE id = $1', [id]);
  const sess = (id) => one(pg, 'SELECT * FROM onboarding_sessions WHERE user_id = $1', [id]);
  const purchaseRows = (id) => all(pg, 'SELECT * FROM purchases WHERE user_id = $1 ORDER BY created_at', [id]);
  const grants = (pid) => all(pg, 'SELECT * FROM credit_grants WHERE purchase_id = $1 ORDER BY instalment', [pid]);
  const access = async (id) => { const p = await profile(id); return { subscription_status: p.subscription_status, access_expires_at: p.access_expires_at, access_plan: p.access_plan }; };
  const waitPlan = async (id) => { for (let i = 0; i < 300; i++) { const r = await sess(id); if (!r || r.plan_status !== 'generating') return; await new Promise((ok) => setTimeout(ok, 10)); } };
  async function newUser(opts) {
    const id = crypto.randomUUID(), email = id.slice(0, 8) + '@example.invalid';
    await pg.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await pg.query('INSERT INTO profiles (id, email, created_at) VALUES ($1, $2, now())', [id, email]);
    if (!(opts && opts.noOnboarding)) await flow.saveProgress(id, { answers: ANSWERS, assistant: 'vector', step: 'paywall' });
    return { id, email };
  }
  const checkout = (user, planId) => purchases.createCheckout({ user, planId, successUrl: 'https://x/app?success=true&session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/app?canceled=true' });
  const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const fe = fs.existsSync(FE) ? require(FE) : null;

  // ── 1. Price ID configuration ──────────────────────────────────
  console.log('\n1. Stripe Price ID configuration');
  check('1.1 as shipped, all five Price IDs are the named placeholders — and each is refused', JSON.stringify(PLACEHOLDERS) === JSON.stringify({ flex: 'PASTE_FLEX_PRICE_ID_HERE', monthly: 'PASTE_MONTHLY_PRICE_ID_HERE', quarterly: 'PASTE_QUARTERLY_PRICE_ID_HERE', semiannual: 'PASTE_SEMI_ANNUAL_PRICE_ID_HERE', annual: 'PASTE_ANNUAL_PRICE_ID_HERE' }) && Object.values(PLACEHOLDERS).every((v) => pricing.priceIdProblem(v) === 'still the placeholder'), PLACEHOLDERS);
  check('1.2 validation: missing, product id (prod_…), malformed refused; a real-looking price_… accepted', pricing.priceIdProblem('') === 'missing' && pricing.priceIdProblem(null) === 'missing' && /product id/.test(pricing.priceIdProblem('prod_ABCDEFGH123')) && /not a Stripe price id/.test(pricing.priceIdProblem('price_bad id!')) && /not a Stripe price id/.test(pricing.priceIdProblem('pr_123')) && pricing.priceIdProblem('price_1UX3zW066sCcz3jQT5rFGuC7') === null);
  const u0 = await newUser();
  for (const [label, val] of [['placeholder', 'PASTE_FLEX_PRICE_ID_HERE'], ['missing', ''], ['malformed', 'price_??'], ['product id', 'prod_TESTFLEX0001']]) {
    pricing.PLANS.flex.stripePriceId = val; purchases._resetForTests();
    const created0 = S.created.length, reads0 = S.priceReads;
    const e = await refuse(() => checkout(u0, 'flex'));
    check('1.3 ' + label + ' Price ID → checkout refused (503 PRICE_NOT_CONFIGURED, clear message), no purchase row, Stripe never called', e && e.code === 'PRICE_NOT_CONFIGURED' && e.status === 503 && /Nothing was charged/.test(e.message) && (await purchaseRows(u0.id)).length === 0 && S.created.length === created0 && S.priceReads === reads0, e && { code: e.code, status: e.status });
  }
  pricing.PLANS.flex.stripePriceId = PRICES[Object.keys(PRICES)[0]].id;
  check('1.4 an unknown plan id is refused; there is no fallback to another plan', (await refuse(() => checkout(u0, 'lifetime'))).code === 'UNKNOWN_PLAN' && (await purchaseRows(u0.id)).length === 0);

  // ── 2. The Stripe price must match the server's terms ──────────
  console.log('\n2. Stripe price verified before checkout');
  const realFlex = PRICES[pricing.PLANS.flex.stripePriceId];
  for (const [label, over] of [['recurring (a subscription price)', { type: 'recurring', recurring: { interval: 'month' } }], ['a different amount (€15)', { unit_amount: 1500 }], ['tax behaviour inclusive (VAT inside the price instead of on top)', { tax_behavior: 'inclusive' }], ['tax behaviour unspecified (account default not exclusive / unreadable)', { tax_behavior: 'unspecified' }], ['currency USD', { currency: 'usd' }], ['archived', { active: false }]]) {
    S.prices[realFlex.id] = Object.assign({}, realFlex, over); purchases._resetForTests();
    const created0 = S.created.length;
    const e = await refuse(() => checkout(u0, 'flex'));
    check('2.1 Stripe price ' + label + ' → refused (503 PRICE_CONFIG_MISMATCH), nothing created, nothing charged', e && e.code === 'PRICE_CONFIG_MISMATCH' && (await purchaseRows(u0.id)).length === 0 && S.created.length === created0, e && e.code);
  }
  delete S.prices[realFlex.id]; purchases._resetForTests();
  check('2.2 a Price ID Stripe doesn’t know → refused, nothing created', (await refuse(() => checkout(u0, 'flex'))).code === 'PRICE_NOT_CONFIGURED' && (await purchaseRows(u0.id)).length === 0);
  S.prices[realFlex.id] = realFlex; purchases._resetForTests();

  // ── 3. All five plans, end to end ──────────────────────────────
  console.log('\n3. Every plan: checkout → Stripe → access, credits, purchase record, plan');
  const users = {};
  for (const id of pricing.PLAN_ORDER) {
    const X = EXPECT[id], plan = pricing.PLANS[id], priceId = plan.stripePriceId;
    const u = users[id] = await newUser();
    const before = await profile(u.id);
    const r = await checkout(u, id);
    const c = S.created[S.created.length - 1], p = c.p;
    const row = (await purchaseRows(u.id))[0];
    check(`3.${id}.a checkout opens for ${X.name}'s own Stripe Price (${priceId}), one-time payment mode, Stripe Tax on — no inline price, no subscription`,
      r.plan === id && p.mode === 'payment' && p.line_items.length === 1 && p.line_items[0].price === priceId && p.line_items[0].quantity === 1 && !p.line_items[0].price_data && !p.subscription_data && p.automatic_tax.enabled === true && p.metadata.planId === id && p.metadata.priceId === priceId && p.client_reference_id === u.id, p);
    check(`3.${id}.b pending purchase with the server's terms: €${X.cents / 100}, EUR, ${X.label}, ${X.credits} credits in ${X.inst} instalment(s), Stripe price + product`,
      row.status === 'pending' && row.plan_id === id && row.price_incl_vat_cents === X.cents && row.currency === 'eur' && row.duration_days === X.days && row.duration_months === X.months && row.credits_total === X.credits && row.instalments === X.inst && row.stripe_price_id === priceId && row.stripe_product_id === 'prod_TEST' + id.toUpperCase() && row.stripe_checkout_session_id === c.id, row);
    const unpaid = await purchases.fulfillFromSession(paidSession(c, { payment_status: 'unpaid', status: 'open' }));
    check(`3.${id}.c browser back from Stripe before payment is confirmed: nothing granted`, /^payment_unpaid/.test(unpaid.skipped) && (await profile(u.id)).subscription_status !== 'paid' && (await profile(u.id)).credits_balance === before.credits_balance);
    const sessionPaid = paidSession(c);
    const out = await purchases.onCheckoutCompleted(sessionPaid); // the verified webhook
    const after = await profile(u.id), paid = (await purchaseRows(u.id))[0], g = await grants(paid.id);
    check(`3.${id}.d payment confirmed: purchase paid with session, payment intent, customer, plan price ${X.cents} + VAT ${sessionPaid.total_details.amount_tax} = total ${sessionPaid.amount_total}, EUR, access start/end, paid time`,
      out.fulfilled && paid.status === 'paid' && paid.stripe_checkout_session_id === c.id && paid.stripe_payment_intent_id === sessionPaid.payment_intent && paid.stripe_customer_id === sessionPaid.customer && sessionPaid.amount_total === X.cents + sessionPaid.total_details.amount_tax && paid.amount_total_cents === sessionPaid.amount_total && paid.amount_tax_cents === sessionPaid.total_details.amount_tax && paid.price_incl_vat_cents === X.cents && !!paid.access_start && !!paid.access_end && !!paid.paid_at, paid);
    const expectedEnd = pricing.accessEnd(plan, new Date(paid.access_start));
    check(`3.${id}.e profile: plan "${id}", status paid, access until start + ${X.label} (matches the purchase)`,
      after.subscription_status === 'paid' && after.access_plan === id && Math.abs(new Date(after.access_expires_at) - expectedEnd) < 1000 && new Date(after.access_expires_at).getTime() === new Date(paid.access_end).getTime() && (X.days ? days(paid.access_start, paid.access_end) === 14 : true), { start: paid.access_start, end: paid.access_end, expectedEnd });
    check(`3.${id}.f credits: ${X.per} now (instalment 1/${X.inst}); ${X.inst - 1} more scheduled monthly within the access period; one ledger entry`,
      after.credits_balance === before.credits_balance + X.per && g.length === X.inst && g[0].status === 'granted' && g[0].credits === X.per && g.slice(1).every((x, i) => x.status === 'scheduled' && x.credits === X.per && new Date(x.grant_at) < new Date(paid.access_end) && Math.abs(days(paid.access_start, x.grant_at) - 30.4 * (i + 1)) <= 3) && (await all(pg, 'SELECT * FROM credit_ledger WHERE purchase_id = $1', [paid.id])).length === 1, { bal: after.credits_balance, grants: g.map((x) => [x.instalment, x.status, x.credits]) });
    for (let i = 0; i < 3; i++) await purchases.onCheckoutCompleted(sessionPaid);
    const resync = await purchases.fulfillFromSession(sessionPaid);
    check(`3.${id}.g duplicate webhooks + the browser's sync: no second purchase, no extra credits or grants`,
      resync.already === true && (await purchaseRows(u.id)).filter((x) => x.status === 'paid').length === 1 && (await profile(u.id)).credits_balance === after.credits_balance && (await grants(paid.id)).length === X.inst);
    const h = await purchases.historyFor(u.id);
    check(`3.${id}.h account history: ${X.per} credits allocated, ${X.credits - X.per} still scheduled, Stripe price recorded`, h.purchases.length === 1 && h.purchases[0].credits_granted === X.per && h.purchases[0].credits_scheduled === X.credits - X.per && h.purchases[0].stripe_price_id === priceId, h.purchases[0]);
    if (fe) check(`3.${id}.i the app shows "${X.name} · until …" for this account (frontend plan name for access_plan "${id}")`, fe.orvPeriodPlan(after.access_plan).name === X.name && fe.orvEffectiveStatus(after) === 'paid');
    const ai0 = aiCalls;
    await flow.getPlan(u.id, await access(u.id)); await waitPlan(u.id);
    const gp = await flow.getPlan(u.id, await access(u.id));
    check(`3.${id}.j the marketing plan is written once after payment, for ${X.label} (${X.phases} phases)`, gp.status === 'ready' && gp.plan.horizon.period === id && gp.plan.roadmap.length === X.phases && aiCalls === ai0 + planCalls(id), { status: gp.status, phases: gp.plan && gp.plan.roadmap.length, calls: aiCalls - ai0 });
    await flow.getPlan(u.id, await access(u.id)); await flow.getPlan(u.id, await access(u.id));
    check(`3.${id}.k later visits and refreshes don't write it again`, aiCalls === ai0 + planCalls(id));
  }
  check('3.z no plan was generated before its payment (one plan per paid plan — Semi-Annual and Annual are written in chunks — none for checkouts alone)', aiCalls === pricing.PLAN_ORDER.reduce((n, id) => n + planCalls(id), 0), aiCalls);

  // ── 4. Monthly instalments ─────────────────────────────────────
  console.log('\n4. Monthly credit instalments');
  const q = users.quarterly, qp = (await purchaseRows(q.id))[0];
  const bal0 = (await profile(q.id)).credits_balance;
  check('4.1 nothing is granted early: the instalment job before a due date grants nothing', (await purchases.grantDueInstalments()) === 0 && (await profile(q.id)).credits_balance === bal0);
  await pg.query("UPDATE credit_grants SET grant_at = now() - interval '1 minute' WHERE purchase_id = $1 AND instalment = 1", [qp.id]);
  await purchases.grantDueInstalments();
  const g1 = await grants(qp.id);
  check('4.2 month 2 arrives: exactly +1,600 (instalment 2/3), instalment 3 still scheduled', (await profile(q.id)).credits_balance === bal0 + 1600 && g1[1].status === 'granted' && g1[2].status === 'scheduled');
  await purchases.grantDueInstalments(); await purchases.grantDueInstalments();
  check('4.3 running the job again never grants the same instalment twice', (await profile(q.id)).credits_balance === bal0 + 1600);
  const ledger = await all(pg, "SELECT * FROM credit_ledger WHERE purchase_id = $1 AND kind = 'grant'", [qp.id]);
  check('4.4 each grant is in the ledger, linked to its purchase', ledger.length === 2);

  // ── 5. Failures and wrong confirmations ────────────────────────
  console.log('\n5. Failed, cancelled and mismatched payments');
  const f = await newUser();
  await checkout(f, 'monthly'); const fc = S.created[S.created.length - 1];
  await purchases.onAsyncPaymentFailed(paidSession(fc, { payment_status: 'unpaid' }));
  check('5.1 failed payment: purchase failed, no access, no credits, no plan', (await purchaseRows(f.id))[0].status === 'failed' && (await profile(f.id)).subscription_status !== 'paid' && (await profile(f.id)).credits_balance === 0 && (await sess(f.id)).plan_status === 'none');
  await checkout(f, 'monthly'); const fc2 = S.created[S.created.length - 1];
  await purchases.onCheckoutExpired(paidSession(fc2, { payment_status: 'unpaid', status: 'expired' }));
  check('5.2 cancelled / abandoned checkout: purchase expired, nothing granted', (await purchaseRows(f.id))[1].status === 'expired' && (await profile(f.id)).credits_balance === 0);
  await checkout(f, 'flex'); const fc3 = S.created[S.created.length - 1];
  const vatOnTop = await purchases.onCheckoutCompleted(paidSession(fc3, { amount_total: 2157 }));
  check('5.3 a paid total that is not plan price + VAT (Flex €17.00 + €3.57 VAT, but €21.57 paid) is refused: no access, no credits', !vatOnTop.fulfilled && vatOnTop.skipped === 'amount_mismatch' && (await profile(f.id)).credits_balance === 0 && (await purchaseRows(f.id))[2].status === 'pending');
  const swapped = await purchases.onCheckoutCompleted(paidSession(fc3, { metadata: Object.assign({}, fc3.p.metadata, { priceId: pricing.PLANS.annual.stripePriceId }) }));
  check('5.4 a session claiming another plan’s price for this purchase is refused', swapped.skipped === 'price_mismatch' && (await profile(f.id)).credits_balance === 0);
  const other = await purchases.onCheckoutCompleted(paidSession(fc3, { client_reference_id: users.flex.id }));
  check('5.5 a session naming another account grants nothing to anyone', !other.fulfilled && (await profile(users.flex.id)).credits_balance === 1050);
  const late = await purchases.onCheckoutCompleted(paidSession(fc3));
  check('5.6 the real confirmation still works afterwards (Flex: 1,050 credits, 14 days)', late.fulfilled && (await profile(f.id)).credits_balance === 1050 && (await profile(f.id)).access_plan === 'flex');

  // ── 6. Existing and expired customers ─────────────────────────
  console.log('\n6. Renewal, expiry, accounts from before');
  const m = users.monthly, mEnd = (await profile(m.id)).access_expires_at, mBal = (await profile(m.id)).credits_balance;
  await checkout(m, 'quarterly'); const rc = S.created[S.created.length - 1];
  await purchases.onCheckoutCompleted(paidSession(rc));
  const mp = (await purchaseRows(m.id)).filter((x) => x.status === 'paid')[1];
  check('6.1 an active customer renewing early: the new period starts when the current one ends (no lost days); existing credits kept, +1,600', new Date(mp.access_start).getTime() === new Date(mEnd).getTime() && (await profile(m.id)).credits_balance === mBal + 1600 && (await profile(m.id)).access_plan === 'quarterly');
  const x = await newUser({ noOnboarding: true });
  await pg.query("UPDATE profiles SET subscription_status = 'paid', access_plan = 'monthly', access_expires_at = now() - interval '2 days', credits_balance = 300 WHERE id = $1", [x.id]);
  await checkout(x, 'flex'); const xc = S.created[S.created.length - 1];
  await purchases.onCheckoutCompleted(paidSession(xc));
  const xp = await profile(x.id), xr = (await purchaseRows(x.id))[0];
  check('6.2 an expired customer buying again: old unused credits expire first (not carried over), access starts now', xp.credits_balance === 1050 && days(new Date(), xr.access_start) === 0 && xp.access_plan === 'flex');
  const legacy = await newUser({ noOnboarding: true });
  await pg.query("UPDATE profiles SET subscription_status = 'paid', access_plan = 'annual', access_expires_at = now() + interval '200 days', credits_balance = 900 WHERE id = $1", [legacy.id]);
  const lp = await flow.getPlan(legacy.id, await access(legacy.id));
  check('6.3 a paying account from before the onboarding: offered the missing-plan recovery, no purchase needed, nothing generated, credits untouched', lp.recovery === true && !lp.plan && (await purchaseRows(legacy.id)).length === 0 && (await profile(legacy.id)).credits_balance === 900 && aiCalls === pricing.PLAN_ORDER.reduce((n, id) => n + planCalls(id), 0));
  const durErr = await refuse(() => pg.query("INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, duration_days, credits_total, instalments) VALUES ($1, $2, 'monthly', 2900, 0, 0, 1750, 1)", [crypto.randomUUID(), x.id]));
  check('6.4 a purchase without an access duration can’t exist (database check); checkout always takes the duration from the server', !!durErr && /check/i.test(durErr.message));
  check('6.5 the browser can’t set price, credits or duration: createCheckout takes only the plan id', (await purchaseRows(u0.id)).length === 0 && purchases.createCheckout.length === 1);

  console.log('\nZ. Totals');
  check('Z.1 test prices only (price_TEST…); no live price id used', Object.values(S.prices).every((p) => /^price_TEST/.test(p.id)));
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
