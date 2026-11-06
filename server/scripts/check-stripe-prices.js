#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// Can each plan be sold? Checks the five configured Stripe Prices with
// Stripe exactly as checkout does — READ ONLY (prices.retrieve and
// tax.settings.retrieve). Creates, changes and charges nothing.
//
// Run where the server's environment is (Render → Shell, from
// oriven-backend/server), or locally with an .env:
//   node scripts/check-stripe-prices.js          (human-readable)
//   node scripts/check-stripe-prices.js --json
// Prints price ids and what Stripe reports — never the secret key.
// Exit code 0 when all five plans can be sold, 1 otherwise.
// ════════════════════════════════════════════════════════════════
try { require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') }); } catch (_) {}
const Stripe = require('stripe');
const purchases = require('../services/purchases');

(async () => {
  if (!process.env.STRIPE_SECRET_KEY) { console.error('STRIPE_SECRET_KEY is not set in this environment.'); process.exit(2); }
  const quiet = console.warn; console.warn = () => {}; // init's own startup notes
  purchases.init({ stripe: new Stripe(process.env.STRIPE_SECRET_KEY), db: null });
  console.warn = quiet;
  const r = await purchases.checkStripePrices();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.allOk ? 0 : 1); }
  console.log('Stripe mode: ' + r.mode + ' (' + r.keyType + ' key) · account tax default: ' + r.accountTaxDefault + ' · webhook secret: ' + (r.webhookSecretSet ? 'set' : 'MISSING'));
  const t = r.stripeTax || {};
  console.log('Stripe Tax: ' + t.status + ' · active registrations: ' + (Array.isArray(t.activeRegistrations) ? (t.activeRegistrations.join(', ') || 'NONE') : 'unreadable (' + (t.registrationsError || '?') + ')') + (r.taxReady ? '' : '  ← VAT is only added when Stripe Tax is active with a registration (e.g. NL)'));
  console.log('Return URLs: ' + r.returnUrls.successUrl + '  |  ' + r.returnUrls.cancelUrl + '\n');
  for (const p of r.plans) {
    console.log((p.ok ? '✓ ' : '✗ ') + p.name.padEnd(12) + (p.env || '(no variable set)').padEnd(34) + (p.priceId || '-'));
    if (p.stripe) console.log('    Stripe: ' + [p.stripe.active ? 'active' : 'ARCHIVED', p.stripe.type + (p.stripe.recurring ? ' (recurring)' : ''), p.stripe.amount + ' ' + p.stripe.currency, 'tax ' + p.stripe.tax_behavior, p.stripe.livemode ? 'live' : 'test'].join(', ') + '   expected: ' + p.expected.amount + ' ' + p.expected.currency + ' before VAT, one_time, tax exclusive');
    p.problems.forEach((x) => console.log('    → ' + x));
  }
  console.log('\n' + (r.allOk ? 'All five plans can be sold.' : 'Checkout is refused for the plans marked ✗ — fix what is listed (in Stripe or the environment), then restart the service.'));
  process.exit(r.allOk ? 0 : 1);
})().catch((e) => { console.error('Check failed: ' + (e.code || e.message)); process.exit(2); });
