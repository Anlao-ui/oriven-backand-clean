// ════════════════════════════════════════════════════════════════
// Stripe Test Mode / Live Mode configuration and the checkout contract.
// Offline: a Stripe fake (tests/helpers/pgPayments.js) and a real Postgres
// (PGlite) with the real access-purchases migration — no network, no key.
//
// Proves: the mode follows the secret key; Test and Live Price IDs are
// separate environment settings and a missing one stays a refused
// placeholder; a price from the other mode, a recurring price, an
// exclusive-tax price or a wrong amount is refused before anything is
// created; checkout is a one-time payment with Stripe Tax, required billing
// address and VAT-ID collection; the five plans match the published table;
// no secret key and no fixed VAT rate in the frontend's customer copy.
//
// RUN: node tests/stripe-mode.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
let PGlite;
try { PGlite = require(process.env.PGLITE_PATH || '@electric-sql/pglite').PGlite; } catch (_) {
  console.log('SKIPPED — @electric-sql/pglite not installed (npm install --no-save @electric-sql/pglite, or set PGLITE_PATH).');
  process.exit(0);
}
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 400))); };
const fresh = (mod) => { delete require.cache[require.resolve(mod)]; return require(mod); };

(async () => {
  const saved = Object.assign({}, process.env);
  console.log('\n1. Mode and Price ID configuration');
  let pricing = require('../services/pricing');
  check('mode follows the key: sk_test_/rk_test_ → test, sk_live_/rk_live_ → live, anything else → unknown',
    pricing.stripeMode('sk_test_abc') === 'test' && pricing.stripeMode('rk_test_abc') === 'test' && pricing.stripeMode('sk_live_abc') === 'live' && pricing.stripeMode('rk_live_abc') === 'live' && pricing.stripeMode('') === 'unknown' && pricing.stripeMode('pk_test_x') === 'unknown');
  const env = { STRIPE_PRICE_FLEX_TEST: 'price_TESTFLEX00001', STRIPE_PRICE_MONTHLY_TEST: ' price_TESTMONTH0001 ', STRIPE_PRICE_FLEX_LIVE: 'price_LIVEFLEX00001' };
  const t = pricing.priceIdsForMode('test', env), l = pricing.priceIdsForMode('live', env);
  check('Test and Live Price IDs are separate settings (trimmed)', t.flex === 'price_TESTFLEX00001' && t.monthly === 'price_TESTMONTH0001' && l.flex === 'price_LIVEFLEX00001' && l.monthly !== t.monthly);
  check('a plan without a setting stays a placeholder, which is refused', /PASTE_/.test(t.annual) && pricing.priceIdProblem(t.annual) === 'still the placeholder' && pricing.priceIdProblem('prod_ABC12345') !== null && pricing.priceIdProblem('price_1AbCdEfGhIjK') === null);
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(24);
  ['FLEX', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'].forEach((p) => { process.env['STRIPE_PRICE_' + p + '_TEST'] = 'price_TEST' + p + '0001'; process.env['STRIPE_PRICE_' + p + '_LIVE'] = 'price_LIVE' + p + '0001'; });
  pricing = fresh('../services/pricing');
  check('with a test key the server uses the five Test Mode prices', pricing.STRIPE_MODE === 'test' && pricing.PLAN_ORDER.every((id) => /^price_TEST/.test(pricing.PLANS[id].stripePriceId)) && pricing.stripePriceStatus().every((x) => x.problem === null));
  process.env.STRIPE_SECRET_KEY = 'sk_live_' + 'x'.repeat(24);
  pricing = fresh('../services/pricing');
  check('with a live key it uses the five Live Mode prices', pricing.STRIPE_MODE === 'live' && pricing.PLAN_ORDER.every((id) => /^price_LIVE/.test(pricing.PLANS[id].stripePriceId)));
  let err = null; try { pricing.PLANS.flex.stripePriceId = 'PASTE_FLEX_PRICE_ID_HERE'; pricing.stripePriceIdFor('flex'); } catch (e) { err = e; }
  check('a misconfigured plan names the exact setting to fix', err && err.code === 'PRICE_NOT_CONFIGURED' && /STRIPE_PRICE_FLEX_LIVE/.test(err.message), err && err.message);

  console.log('\n2. The five plans (published table)');
  const want = { flex: [17, 0, 14, 1050], monthly: [29, 1, 0, 1750], quarterly: [78, 3, 0, 4800], semiannual: [143, 6, 0, 8850], annual: [245, 12, 0, 15000] };
  const got = Object.fromEntries(pricing.PLAN_ORDER.map((id) => { const p = pricing.PLANS[id]; return [id, [p.priceInclVat, p.months, p.days, p.credits]]; }));
  check('Flex €17/14 days/1,050 · Monthly €29/1 month/1,750 · Quarterly €78/3/4,800 · Semi-Annual €143/6/8,850 · Annual €245/12/15,000', JSON.stringify(got) === JSON.stringify(want), got);

  console.log('\n3. Price verification and checkout (Test Mode)');
  process.env.STRIPE_SECRET_KEY = 'sk_test_' + 'x'.repeat(24);
  pricing = fresh('../services/pricing');
  const purchases = fresh('../services/purchases');
  const { BASE, adapter, priceFor, installTestPrices, makeStripe } = require('./helpers/pgPayments');
  const prices = installTestPrices(pricing);
  Object.values(prices).forEach((p) => { p.livemode = false; });
  const { stripe, S } = makeStripe(prices);
  const pg = new PGlite();
  await pg.exec(BASE);
  await pg.exec(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'migrations', '2026-10-access-purchases.sql'), 'utf8'));
  const db = adapter(pg);
  const warn = console.warn; console.warn = () => {};
  purchases.init({ stripe, db });
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'buyer@example.invalid' };
  await pg.query(`INSERT INTO profiles (id, email) VALUES ($1, $2)`, [user.id, user.email]);
  const checkout = (planId) => purchases.createCheckout({ user, planId, successUrl: 'https://x/app?success=true', cancelUrl: 'https://x/app?canceled=true' });
  let r = await checkout('monthly');
  const p = S.created[S.created.length - 1].p;
  check('checkout = one-time payment (mode payment, no subscription), one line with the plan\'s price', p.mode === 'payment' && !p.subscription_data && p.line_items.length === 1 && p.line_items[0].price === pricing.PLANS.monthly.stripePriceId && r.url);
  check('Stripe Tax on, billing address required, VAT ID collection on', p.automatic_tax && p.automatic_tax.enabled === true && p.billing_address_collection === 'required' && p.tax_id_collection && p.tax_id_collection.enabled === true);
  check('no fixed VAT rate is sent to Stripe (Stripe Tax decides)', !JSON.stringify(p).includes('0.21') && !p.line_items[0].tax_rates && !p.line_items[0].price_data);
  const refuse = async (over) => {
    purchases._resetForTests();
    S.prices[pricing.PLANS.flex.stripePriceId] = priceFor(pricing, 'flex', Object.assign({ id: pricing.PLANS.flex.stripePriceId, livemode: false }, over));
    const before = S.created.length;
    let e = null; try { await checkout('flex'); } catch (x) { e = x; }
    return { code: e && e.code, created: S.created.length - before };
  };
  let x = await refuse({ livemode: true });
  check('a LIVE Mode price with a test key → refused before anything is created', x.code === 'PRICE_CONFIG_MISMATCH' && x.created === 0, x);
  x = await refuse({ type: 'recurring', recurring: { interval: 'month' } });
  check('a recurring (subscription) price → refused', x.code === 'PRICE_CONFIG_MISMATCH' && x.created === 0, x);
  x = await refuse({ tax_behavior: 'inclusive' });
  check('a price with VAT inside it (tax behaviour inclusive; VAT must be added on top) → refused', x.code === 'PRICE_CONFIG_MISMATCH' && x.created === 0, x);
  x = await refuse({ unit_amount: 1600 });
  check('a price with a different amount → refused', x.code === 'PRICE_CONFIG_MISMATCH' && x.created === 0, x);
  x = await refuse({});
  check('the correct Test Mode price → checkout opens', x.code === null && x.created === 1, x);
  console.warn = warn;
  await pg.close();

  console.log('\n4. Frontend: no secrets, no fixed VAT rate in customer copy');
  const FE = path.resolve(__dirname, '..', '..', '..', 'oriven-frontend');
  if (fs.existsSync(FE)) {
    const files = [];
    (function walk(d) { for (const f of fs.readdirSync(d)) { if (/^(node_modules|tests|\.git|assets)$/.test(f)) continue; const pth = path.join(d, f); const st = fs.statSync(pth); if (st.isDirectory()) walk(pth); else if (/\.(js|html)$/.test(f)) files.push(pth); } })(FE);
    const secrets = files.filter((f) => /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}|SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["']ey/.test(fs.readFileSync(f, 'utf8')));
    check(`no Stripe secret key, webhook secret or service-role key in ${files.length} frontend files`, secrets.length === 0, secrets);
    const vat = files.filter((f) => /\b21\s?%\s?(VAT|btw|MwSt|TVA|de IVA|IVA)\b|IVA de 21|TVA 21/.test(fs.readFileSync(f, 'utf8')));
    check('no fixed "21% VAT" in customer-facing frontend copy', vat.length === 0, vat.map((f) => path.relative(FE, f)));
  } else check('frontend repository not next to the backend — skipped', true);

  Object.keys(process.env).forEach((k) => { if (!(k in saved)) delete process.env[k]; }); Object.assign(process.env, saved);
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.log('CRASH', e && e.stack || e); setTimeout(() => process.exit(1), 100); });
