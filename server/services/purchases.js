// ════════════════════════════════════════════════════════════════
// One-time access purchases (Flex, Monthly, Quarterly, Semi-Annual, Annual).
//
//   checkout  createCheckout() checks the plan's configured Stripe Price
//             (services/pricing.js STRIPE_PRICE_IDS) with Stripe — one-time,
//             EUR, the exact plan price, tax behaviour exclusive, active — writes
//             a 'pending' purchase with the terms of services/pricing.js and
//             that price/product, then opens a Stripe Checkout session for
//             that Price in payment mode (no subscription, no automatic
//             renewal). Stripe Tax adds the VAT for the customer's country
//             on top of the plan price; businesses can add a VAT ID. A missing, placeholder or
//             different price refuses the checkout: nothing is created.
//   paid      only a CONFIRMED payment (checkout.session.completed with
//             payment_status 'paid', or async_payment_succeeded) fulfils the
//             purchase: the paid line item, plan price, tax and total are
//             checked with Stripe (_paidAmounts), then fulfill_purchase() in
//             Postgres checks plan price and currency again, it runs at most once, and it
//             grants access + the first credit instalment atomically. The
//             webhook, the checkout-return sync and a retried event can all
//             call it; only the first one does anything.
//   failed    async_payment_failed / checkout.session.expired: the purchase is
//             marked failed/expired; nothing is granted.
//   refund    a FULL refund revokes the purchase (revoke_purchase(): unused
//             access, its remaining credits and future instalments). A partial
//             refund is recorded and flagged for a person to decide.
//   dispute   a dispute revokes like a full refund; a won dispute is flagged
//             for manual reinstatement (never automatic).
// Every event is processed once (stripe_webhook_events, server.js).
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const pricing = require('./pricing');

let _stripe = null, _db = null;
function init({ stripe, db }) {
  _stripe = stripe; _db = db;
  // Say at startup which Stripe prices still need configuring.
  const bad = pricing.stripePriceStatus().filter((x) => x.problem);
  const mode = pricing.stripeMode();
  if (mode === 'unknown') console.warn('[Purchases] STRIPE_SECRET_KEY is not a test or live secret key — checkout cannot verify prices.');
  if (bad.length) console.warn('[Purchases] Stripe ' + mode + ' mode: prices not configured — checkout is refused for: ' + bad.map((x) => x.planId + ' (' + x.problem + ')').join(', ') + '. Set STRIPE_PRICE_<PLAN>_' + (mode === 'live' ? 'LIVE' : 'TEST') + ' (see .env.example).');
  // On the server: check every price with Stripe once after start (read
  // only) and log one line per plan, so the deploy log says whether all five
  // plans can be sold — and if not, exactly why.
  if ((process.env.RENDER || process.env.NODE_ENV === 'production') && mode !== 'unknown' && process.env.STRIPE_PRICE_STARTUP_CHECK !== 'false') {
    setTimeout(() => { checkStripePrices().then(_logPriceCheck, (err) => console.warn('[Purchases] Stripe price check failed:', err.code || err.message)); }, 3000).unref();
  }
}

function alert(event, fields) {
  console.warn('[Purchases] ALERT ' + JSON.stringify(Object.assign({ ts: new Date().toISOString(), event }, fields || {})));
}
class PurchaseError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 400; }
}
const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;

// Where Stripe sends the customer back. The app, never the API host:
// FRONTEND_URL when set (http only for localhost), otherwise the production
// site. RENDER_EXTERNAL_URL is the API's own address, so it is never used.
// {CHECKOUT_SESSION_ID} is left as is — Stripe fills it in. Coming back to
// success_url proves nothing: access opens only on a confirmed payment
// (webhook / sync-checkout → fulfill_purchase()).
const PRODUCTION_APP_ORIGIN = 'https://orivenai.com';
function checkoutReturnUrls(env) {
  const e = env || process.env;
  let base = String(e.FRONTEND_URL || '').trim().replace(/\/+$/, '');
  let ok = false;
  try {
    const u = new URL(base);
    ok = u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
  } catch (_) {}
  if (!ok) base = (e.NODE_ENV === 'production' || e.RENDER) ? PRODUCTION_APP_ORIGIN : 'http://localhost:5500';
  return {
    successUrl: base + '/app?success=true&session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: base + '/app?canceled=true',
  };
}

function durationLabel(plan) {
  if (plan.days) return plan.days + ' days';
  return plan.months === 1 ? '1 month' : plan.months + ' months';
}

// Expire this user's earlier open checkouts, so only the newest one can be
// paid (two tabs, a double click, coming back later).
async function _closeOpenCheckouts(userId) {
  const { data: open } = await _db.from('purchases').select('id, stripe_checkout_session_id').eq('user_id', userId).eq('status', 'pending');
  for (const p of open || []) {
    if (p.stripe_checkout_session_id) {
      try {
        const s = await _stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id);
        if (s.status === 'complete') continue; // paid, webhook on its way: leave it to fulfil
        if (s.status === 'open') await _stripe.checkout.sessions.expire(p.stripe_checkout_session_id);
      } catch (err) { if (!(err && (err.statusCode === 404 || err.code === 'resource_missing'))) throw err; }
    }
    await _db.from('purchases').update({ status: 'expired', failure_reason: 'replaced by a newer checkout', updated_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'pending');
  }
}

// The plan's Stripe Price, checked against the server's terms before any
// checkout opens: active, one-time (never recurring), EUR, exactly the
// plan's price (before VAT), and tax-EXCLUSIVE — Stripe Tax adds the VAT
// for the customer's country on top at checkout. Exclusive means the
// price's own tax behaviour is "exclusive", or it is unspecified and the
// account default (Stripe → Settings → Tax) is "exclusive". A verified
// price is remembered for 10 minutes.
// Returns { priceId, productId }.
const _verified = new Map(); // priceId -> { at, productId }
const PRICE_UNAVAILABLE = 'Payments for this plan aren’t available right now. Nothing was charged — please try again later or contact contact@orivenai.com.';

// The account's default tax behaviour ('inclusive' | 'exclusive' |
// 'inferred_by_currency' | null), read once per 10 minutes; null when it
// can't be read (then an unspecified price is refused).
let _taxDefault = null;
async function accountTaxDefault() {
  if (_taxDefault && Date.now() - _taxDefault.at < 10 * 60e3) return _taxDefault.value;
  let value = null, status = null, error = null;
  try {
    const s = await _stripe.tax.settings.retrieve();
    value = (s && s.defaults && s.defaults.tax_behavior) || null;
    status = (s && s.status) || null;
  } catch (err) { error = err.code || err.type || err.message; }
  _taxDefault = { at: Date.now(), value, status, error };
  return value;
}

// Pure: what's wrong with a Stripe Price for a plan ([] when it's right).
function priceProblems(price, { priceId, plan, mode, taxDefault }) {
  const cents = pricing.priceInclVatCents(plan);
  const problems = [];
  if (!price || price.id !== priceId) return ['different price returned'];
  if (price.active === false) problems.push('price is archived (inactive) — a new price was probably created; put its price_… id in the environment');
  if (price.type !== 'one_time' || price.recurring) problems.push('price is recurring, not one-time');
  if (String(price.currency || '').toLowerCase() !== pricing.CURRENCY) problems.push('currency ' + price.currency + ' instead of ' + pricing.CURRENCY);
  if (price.unit_amount !== cents) problems.push('amount ' + price.unit_amount + ' instead of ' + cents);
  // VAT is charged on top of the plan price: the price must be tax-
  // EXCLUSIVE — set on the price, or unspecified with the account default
  // (Stripe → Settings → Tax) "exclusive". An inclusive price would charge
  // the plan price with VAT inside it (a different amount than sold).
  const tb = price.tax_behavior || 'unspecified';
  if (tb === 'inclusive') problems.push('tax behaviour inclusive instead of exclusive (VAT must be added on top of the plan price)');
  else if (tb !== 'exclusive') {
    // ('inferred_by_currency' makes EUR prices inclusive, so only an
    // explicit "exclusive" default counts.)
    if (taxDefault !== 'exclusive') problems.push('tax behaviour unspecified and the account default is ' + (taxDefault || 'unknown') + ' — set the price (or Settings → Tax → default) to "Exclusive"');
  }
  // A Test Mode price must never be sold with a live key (or the reverse).
  if (typeof price.livemode === 'boolean' && mode !== 'unknown' && price.livemode !== (mode === 'live')) {
    problems.push((price.livemode ? 'Live' : 'Test') + ' Mode price used with a ' + mode + ' key');
  }
  return problems;
}

async function verifiedStripePrice(plan) {
  let priceId;
  const mode = pricing.stripeMode();
  try { priceId = pricing.stripePriceIdFor(plan.id); }
  catch (err) {
    alert('stripe_price_not_configured', { plan: plan.id, problem: err.problem, mode, env: pricing.priceEnvNameFor(plan.id) || ('STRIPE_PRICE_' + (pricing.PRICE_ENV[plan.id] || '') + '_' + (mode === 'live' ? 'LIVE' : 'TEST') + ' (unset)') });
    throw new PurchaseError('PRICE_NOT_CONFIGURED', PRICE_UNAVAILABLE, 503);
  }
  const hit = _verified.get(priceId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return { priceId, productId: hit.productId };
  let price;
  try { price = await _stripe.prices.retrieve(priceId); }
  catch (err) {
    alert('stripe_price_unavailable', { plan: plan.id, price: priceId, mode, env: pricing.priceEnvNameFor(plan.id), error: err.code || err.type || err.message, status: err.statusCode || null });
    throw new PurchaseError('PRICE_NOT_CONFIGURED', PRICE_UNAVAILABLE, 503);
  }
  const tb = price && price.tax_behavior;
  const taxDefault = tb === 'inclusive' || tb === 'exclusive' ? null : await accountTaxDefault();
  const problems = priceProblems(price, { priceId, plan, mode, taxDefault });
  if (problems.length) {
    alert('stripe_price_mismatch', { plan: plan.id, price: priceId, env: pricing.priceEnvNameFor(plan.id), problems });
    throw new PurchaseError('PRICE_CONFIG_MISMATCH', PRICE_UNAVAILABLE, 503);
  }
  const productId = idOf(price.product);
  _verified.set(priceId, { at: Date.now(), productId });
  return { priceId, productId };
}

// Every plan's price, checked with Stripe now (read-only: prices.retrieve
// and tax.settings.retrieve). For the startup log, the admin check and
// scripts/check-stripe-prices.js. No secrets in the result.
async function checkStripePrices() {
  const mode = pricing.stripeMode();
  const plans = [];
  // Stripe Tax itself: checkout uses automatic_tax, which adds VAT only when
  // Stripe Tax is active and registered where the customer is taxed.
  _taxDefault = null;
  const taxDefault = await accountTaxDefault();
  const tax = { status: (_taxDefault && _taxDefault.status) || 'unreadable', defaultTaxBehavior: taxDefault || 'unspecified', error: (_taxDefault && _taxDefault.error) || null, activeRegistrations: null };
  try {
    const regs = await _stripe.tax.registrations.list({ status: 'active', limit: 100 });
    tax.activeRegistrations = ((regs && regs.data) || []).map((x) => x.country).filter(Boolean);
  } catch (err) { tax.registrationsError = err.code || err.type || err.message; }
  for (const id of pricing.PLAN_ORDER) {
    const plan = pricing.PLANS[id];
    const row = { plan: id, name: plan.name, env: pricing.priceEnvNameFor(id), priceId: null, expected: { amount: pricing.priceInclVatCents(plan), currency: pricing.CURRENCY, type: 'one_time', tax: 'exclusive' }, ok: false, problems: [] };
    try { row.priceId = pricing.stripePriceIdFor(id); }
    catch (err) {
      row.problems.push('not configured: ' + err.problem + ' (set ' + ('STRIPE_PRICE_' + pricing.PRICE_ENV[id] + '_' + (mode === 'live' ? 'LIVE' : 'TEST')) + ')');
      plans.push(row); continue;
    }
    let price = null;
    try { price = await _stripe.prices.retrieve(row.priceId); }
    catch (err) {
      row.problems.push('Stripe could not return this price: ' + (err.code || err.type || err.message) + (err.statusCode === 404 ? ' (it does not exist for this key — another account, or the other mode)' : err.statusCode === 403 ? ' (the key may not read prices)' : ''));
      plans.push(row); continue;
    }
    row.stripe = { active: price.active, type: price.type, recurring: !!price.recurring, currency: price.currency, amount: price.unit_amount, tax_behavior: price.tax_behavior || 'unspecified', livemode: price.livemode, product: idOf(price.product) };
    row.problems = priceProblems(price, { priceId: row.priceId, plan, mode, taxDefault });
    row.ok = row.problems.length === 0;
    plans.push(row);
  }
  return {
    mode, keyType: /^rk_/.test(String(process.env.STRIPE_SECRET_KEY || '')) ? 'restricted' : /^sk_/.test(String(process.env.STRIPE_SECRET_KEY || '')) ? 'secret' : 'missing/invalid',
    accountTaxDefault: tax.defaultTaxBehavior, stripeTax: tax,
    taxReady: tax.status === 'active' && Array.isArray(tax.activeRegistrations) && tax.activeRegistrations.length > 0,
    webhookSecretSet: !!process.env.STRIPE_WEBHOOK_SECRET, returnUrls: checkoutReturnUrls(),
    allOk: plans.every((p) => p.ok), plans,
  };
}
function _logPriceCheck(r) {
  const line = (p) => p.plan + ' ' + (p.ok ? 'OK' : 'REFUSED') + ' [' + (p.env || 'no env var') + ' = ' + (p.priceId || '-') + ']' + (p.ok ? '' : ': ' + p.problems.join('; '));
  const t = r.stripeTax || {};
  const head = '[Purchases] Stripe price check (' + r.mode + ' mode, ' + r.keyType + ' key, Stripe Tax ' + t.status + ' with registrations ' + (Array.isArray(t.activeRegistrations) ? (t.activeRegistrations.join(',') || 'NONE') : 'unreadable') + ', tax default ' + r.accountTaxDefault + ', webhook secret ' + (r.webhookSecretSet ? 'set' : 'MISSING') + '): ';
  if (!r.taxReady) console.warn('[Purchases] Stripe Tax is not ready (status ' + t.status + ', active registrations ' + (Array.isArray(t.activeRegistrations) ? t.activeRegistrations.length : 'unreadable') + '): checkout uses automatic_tax, so VAT is not added (or Checkout refuses) until Stripe Tax is active with a registration (e.g. NL).');
  (r.allOk ? console.log : console.warn)(head + (r.allOk ? 'all five plans can be sold. ' : 'checkout is refused for some plans. ') + r.plans.map(line).join(' | '));
}

async function createCheckout({ user, planId, successUrl, cancelUrl, source }) {
  const plan = pricing.planById(planId);
  if (!plan) throw new PurchaseError('UNKNOWN_PLAN', 'Choose one of the plans.', 400);
  // Before anything is written: the configured Stripe price must be right.
  const stripePrice = await verifiedStripePrice(plan);
  const { data: profile, error } = await _db.from('profiles')
    .select('subscription_status, stripe_customer_id, stripe_subscription_id, access_expires_at').eq('id', user.id).maybeSingle();
  if (error) throw error;
  // A legacy monthly subscription that still runs would renew by itself next
  // to the new access; it has to end first (Settings → cancel).
  if (profile && pricing.LEGACY_PLANS.includes(profile.subscription_status) && profile.stripe_subscription_id && pricing.hasAccess(profile)) {
    throw new PurchaseError('LEGACY_SUBSCRIPTION_ACTIVE', 'You still have a monthly subscription. Cancel it in Settings → Plan first; your access continues until its period ends.', 409);
  }
  await _closeOpenCheckouts(user.id);

  const id = crypto.randomUUID();
  const cents = pricing.priceInclVatCents(plan);
  const { error: insErr } = await _db.from('purchases').insert({
    id, user_id: user.id, plan_id: plan.id, status: 'pending', price_incl_vat_cents: cents, currency: pricing.CURRENCY,
    duration_months: plan.months, duration_days: plan.days, credits_total: plan.credits, instalments: plan.instalments,
    stripe_price_id: stripePrice.priceId, stripe_product_id: stripePrice.productId,
  });
  if (insErr) throw insErr;

  const meta = { userId: user.id, purchaseId: id, planId: plan.id, priceId: stripePrice.priceId };
  const params = {
    mode: 'payment',
    // The plan's own Stripe Price (verified above): Checkout shows its
    // product's name and description, and charges exactly its amount.
    line_items: [{ price: stripePrice.priceId, quantity: 1 }],
    automatic_tax: { enabled: true },
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    client_reference_id: user.id,
    metadata: meta,
    payment_intent_data: { metadata: meta, description: 'OrivenAI ' + plan.name + ' (' + durationLabel(plan) + ')' },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  if (profile && profile.stripe_customer_id) {
    params.customer = profile.stripe_customer_id;
    params.customer_update = { address: 'auto', name: 'auto' };
  } else {
    params.customer_email = user.email || undefined;
    params.customer_creation = 'always';
  }
  let session;
  try {
    session = await _stripe.checkout.sessions.create(params, { idempotencyKey: 'purchase-' + id });
  } catch (err) {
    await _db.from('purchases').update({ status: 'failed', failure_reason: 'checkout could not be created', updated_at: new Date().toISOString() }).eq('id', id);
    throw err;
  }
  await _db.from('purchases').update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() }).eq('id', id);
  // The browser goes exactly where Stripe says; without a Stripe https URL
  // there is nothing to open (never built by hand).
  if (!session || !/^https:\/\/[^/]+/.test(String(session.url || ''))) {
    alert('stripe_checkout_without_url', { purchase: id, session: session && session.id });
    throw new PurchaseError('CHECKOUT_UNAVAILABLE', 'Secure checkout couldn’t be opened. Nothing was charged — please try again.', 502);
  }
  console.log('[Purchases] checkout', JSON.stringify({ user: user.id, purchase: id, plan: plan.id, source: source || null }));
  return { url: session.url, purchaseId: id, plan: plan.id };
}

// ── Fulfilment ──────────────────────────────────────────────────
async function _purchaseOfSession(session) {
  const meta = session.metadata || {};
  if (!meta.purchaseId || !meta.userId) return { skipped: 'not_an_access_purchase' };
  if (session.client_reference_id && session.client_reference_id !== meta.userId) {
    alert('checkout_identity_mismatch', { session: session.id });
    return { skipped: 'identity_mismatch' };
  }
  const { data: purchase, error } = await _db.from('purchases').select('*').eq('id', meta.purchaseId).maybeSingle();
  if (error) throw error;
  if (!purchase) { alert('purchase_missing', { session: session.id, purchase: meta.purchaseId }); return { skipped: 'unknown_purchase' }; }
  if (purchase.user_id !== meta.userId) { alert('purchase_owner_mismatch', { session: session.id, purchase: purchase.id }); return { skipped: 'owner_mismatch' }; }
  if (purchase.stripe_checkout_session_id && purchase.stripe_checkout_session_id !== session.id) {
    alert('purchase_session_mismatch', { session: session.id, purchase: purchase.id });
    return { skipped: 'session_mismatch' };
  }
  if (purchase.stripe_price_id && meta.priceId && purchase.stripe_price_id !== meta.priceId) {
    alert('purchase_price_mismatch', { session: session.id, purchase: purchase.id });
    return { skipped: 'price_mismatch' };
  }
  return { purchase };
}

// What the customer actually paid for, checked against the purchase before
// anything is granted. VAT is charged ON TOP of the plan price (tax
// behaviour exclusive; Stripe Tax works out the rate for the customer's
// country — 21 % in the Netherlands, another EU rate, or 0 % for reverse
// charge / outside the EU, or whatever rate applies where the customer is
// taxed). The rate itself is Stripe Tax's decision and is not capped here;
// what is checked is that Stripe's figures add up:
//   · exactly one line item: the purchase's Stripe Price, quantity 1, whose
//     amount before tax (amount_subtotal) is the plan price;
//   · no discount; currency EUR;
//   · the session's tax is a whole, non-negative amount and equals the tax
//     Stripe reports on that line item;
//   · total = plan price + tax  (or = plan price for a tax-inclusive price,
//     i.e. a checkout opened before prices became tax-exclusive).
// The line items come from Stripe (listLineItems); if Stripe can't be
// asked, this throws and the webhook answers 500 so Stripe retries later.
// Returns { base, tax, total } or { problem }.
async function _paidAmounts(session, purchase) {
  const base = purchase.price_incl_vat_cents; // the plan price in cents (column name predates tax-exclusive prices)
  const total = session.amount_total;
  const tax = (session.total_details && session.total_details.amount_tax) || 0;
  const discount = (session.total_details && session.total_details.amount_discount) || 0;
  const li = await _stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
  const items = (li && li.data) || [];
  const item = items[0] || {};
  const itemPrice = idOf(item.price);
  const problems = [];
  if (String(session.currency || '').toLowerCase() !== purchase.currency) problems.push('currency ' + session.currency);
  if (items.length !== 1) problems.push(items.length + ' line items');
  if (purchase.stripe_price_id && itemPrice !== purchase.stripe_price_id) problems.push('price ' + itemPrice + ' instead of ' + purchase.stripe_price_id);
  if (item.quantity !== 1) problems.push('quantity ' + item.quantity);
  if (item.amount_subtotal !== base) problems.push('plan price ' + item.amount_subtotal + ' instead of ' + base);
  if (session.amount_subtotal != null && session.amount_subtotal !== base) problems.push('subtotal ' + session.amount_subtotal + ' instead of ' + base);
  if (discount) problems.push('discount ' + discount);
  if (!Number.isInteger(tax) || tax < 0) problems.push('tax ' + tax + ' is not a valid amount');
  else if (typeof item.amount_tax === 'number' && item.amount_tax !== tax) problems.push('tax ' + tax + ' on the session but ' + item.amount_tax + ' on the line item');
  if (!(total === base + tax || total === base)) problems.push('total ' + total + ' is not price ' + base + ' + tax ' + tax);
  return problems.length ? { problem: problems.join('; ') } : { base, tax, total };
}

const _DONE = ['paid', 'refunded', 'partially_refunded', 'disputed', 'dispute_won'];
async function fulfillFromSession(session) {
  if (session.mode !== 'payment') return { skipped: 'not_payment_mode' };
  if (session.payment_status !== 'paid') return { skipped: 'payment_' + session.payment_status }; // async methods: wait for async_payment_succeeded
  const found = await _purchaseOfSession(session);
  if (!found.purchase) return found;
  const p = found.purchase;
  // A repeat (webhook retry, second event, the return page's sync) of a
  // purchase that is already paid: fulfill_purchase() answers "already".
  let amounts = null;
  if (!_DONE.includes(p.status)) {
    amounts = await _paidAmounts(session, p);
    if (amounts.problem) {
      alert('fulfillment_refused', { purchase: p.id, session: session.id, reason: 'amount_mismatch', problem: amounts.problem, total: session.amount_total, currency: session.currency });
      return { userId: p.user_id, purchaseId: p.id, skipped: 'amount_mismatch' };
    }
  }
  // fulfill_purchase() checks the amount against the purchase's plan price,
  // so it is given the verified price before tax; the tax is passed on and
  // the real total is recorded right after.
  const { data, error } = await _db.rpc('fulfill_purchase', {
    p_purchase_id: p.id,
    p_session_id: session.id,
    p_payment_intent: idOf(session.payment_intent),
    p_customer: idOf(session.customer),
    p_amount_total: amounts ? amounts.base : session.amount_total,
    p_amount_tax: amounts ? amounts.tax : ((session.total_details && session.total_details.amount_tax) || 0),
    p_currency: session.currency,
  });
  if (error) throw error;
  const r = data || {};
  if (!r.ok) { alert('fulfillment_refused', { purchase: p.id, reason: r.reason, amount: session.amount_total, currency: session.currency }); return { userId: p.user_id, purchaseId: p.id, skipped: r.reason }; }
  if (r.fulfilled && amounts) {
    const { error: upErr } = await _db.from('purchases').update({ amount_total_cents: amounts.total, amount_tax_cents: amounts.tax, updated_at: new Date().toISOString() }).eq('id', p.id);
    if (upErr) alert('purchase_total_not_recorded', { purchase: p.id, total: amounts.total, tax: amounts.tax, error: upErr.message });
  }
  // The customer becomes linked to the profile on the first purchase.
  const cust = idOf(session.customer);
  if (cust) await _db.from('profiles').update({ stripe_customer_id: cust }).eq('id', p.user_id).is('stripe_customer_id', null);
  return { userId: p.user_id, purchaseId: p.id, plan: p.plan_id, fulfilled: !!r.fulfilled, already: !!r.already, accessEnd: r.access_end || null, creditsGranted: r.credits_granted || 0 };
}

async function _markPending(session, status, reason) {
  const found = await _purchaseOfSession(session);
  if (!found.purchase) return found;
  await _db.from('purchases').update({ status, failure_reason: reason, updated_at: new Date().toISOString() }).eq('id', found.purchase.id).eq('status', 'pending');
  return { userId: found.purchase.user_id, purchaseId: found.purchase.id, plan: found.purchase.plan_id, [status]: true };
}
const onCheckoutCompleted = (session) => fulfillFromSession(session);
const onAsyncPaymentSucceeded = (session) => fulfillFromSession(session);
const onAsyncPaymentFailed = (session) => (session.mode === 'payment' ? _markPending(session, 'failed', 'payment failed') : { skipped: 'not_payment_mode' });
const onCheckoutExpired = (session) => (session.mode === 'payment' ? _markPending(session, 'expired', 'checkout expired') : { skipped: 'not_payment_mode' });

// ── Refunds and disputes ────────────────────────────────────────
async function _purchaseByPaymentIntent(pi) {
  if (!pi) return null;
  const { data, error } = await _db.from('purchases').select('*').eq('stripe_payment_intent_id', pi).maybeSingle();
  if (error) throw error;
  return data || null;
}
async function _revoke(purchase, status, note) {
  const { data, error } = await _db.rpc('revoke_purchase', { p_purchase_id: purchase.id, p_status: status, p_note: note || null });
  if (error) throw error;
  return Object.assign({ userId: purchase.user_id, purchaseId: purchase.id, plan: purchase.plan_id }, data || {});
}
async function onChargeRefunded(charge) {
  const purchase = await _purchaseByPaymentIntent(idOf(charge.payment_intent));
  if (!purchase) return { skipped: 'not_an_access_purchase' };
  if (charge.amount_refunded >= charge.amount) return _revoke(purchase, 'refunded', 'Stripe refund');
  // Partial refund: recorded, access and credits unchanged, a person decides.
  await _db.from('purchases').update({ status: 'partially_refunded', updated_at: new Date().toISOString() }).eq('id', purchase.id).eq('status', 'paid');
  alert('partial_refund_review', { purchase: purchase.id, refunded: charge.amount_refunded, amount: charge.amount });
  return { userId: purchase.user_id, purchaseId: purchase.id, partialRefund: true };
}
async function onDisputeCreated(dispute) {
  const purchase = await _purchaseByPaymentIntent(idOf(dispute.payment_intent));
  if (!purchase) return { skipped: 'not_an_access_purchase' };
  alert('dispute_opened', { purchase: purchase.id, reason: dispute.reason || null });
  return _revoke(purchase, 'disputed', 'dispute: ' + (dispute.reason || 'unspecified'));
}
async function onDisputeClosed(dispute) {
  const purchase = await _purchaseByPaymentIntent(idOf(dispute.payment_intent));
  if (!purchase) return { skipped: 'not_an_access_purchase' };
  if (dispute.status === 'won') {
    await _db.from('purchases').update({ status: 'dispute_won', updated_at: new Date().toISOString() }).eq('id', purchase.id).eq('status', 'disputed');
    alert('dispute_won_manual_reinstatement', { purchase: purchase.id, user: purchase.user_id });
    return { userId: purchase.user_id, purchaseId: purchase.id, disputeWon: true };
  }
  return { userId: purchase.user_id, purchaseId: purchase.id, disputeClosed: dispute.status || null };
}

// ── Scheduled jobs ──────────────────────────────────────────────
async function grantDueInstalments() {
  const { data, error } = await _db.rpc('grant_due_credit_instalments', { p_limit: 500 });
  if (error) throw error;
  return data || 0;
}
// Legacy subscribers' entitlements keep their access ahead (and end the ones
// whose decided end date passed). Runs before expireAccess. Not migrated
// yet: nothing to do.
async function refreshLegacyEntitlements() {
  const { data, error } = await _db.rpc('refresh_legacy_entitlements');
  if (error) {
    if (/refresh_legacy_entitlements|PGRST202|42883/.test((error.code || '') + ' ' + (error.message || ''))) return 0;
    throw error;
  }
  return data || 0;
}
async function expireAccess() {
  const { data, error } = await _db.rpc('expire_access', { p_limit: 500 });
  if (error) throw error;
  return data || 0;
}

// ── Customer history ────────────────────────────────────────────
async function historyFor(userId) {
  const [p, g] = await Promise.all([
    _db.from('purchases').select('id, plan_id, status, stripe_price_id, price_incl_vat_cents, amount_total_cents, amount_tax_cents, currency, credits_total, instalments, access_start, access_end, created_at, paid_at, refunded_at')
      .eq('user_id', userId).in('status', ['paid', 'refunded', 'partially_refunded', 'disputed', 'dispute_won']).order('created_at', { ascending: false }).limit(24),
    _db.from('credit_grants').select('purchase_id, instalment, credits, grant_at, status').eq('user_id', userId).order('grant_at', { ascending: true }).limit(200),
  ]);
  if (p.error) throw p.error;
  const grants = (g && !g.error && g.data) || [];
  const purchases = (p.data || []).map((x) => {
    const mine = grants.filter((y) => y.purchase_id === x.id);
    const sum = (st) => mine.filter((y) => y.status === st).reduce((n, y) => n + (y.credits || 0), 0);
    return Object.assign({}, x, { credits_granted: sum('granted'), credits_scheduled: sum('scheduled') });
  });
  return { purchases, grants };
}

module.exports = {
  init, PurchaseError, createCheckout, checkoutReturnUrls, fulfillFromSession, verifiedStripePrice, priceProblems, checkStripePrices,
  _resetForTests() { _verified.clear(); _taxDefault = null; },
  onCheckoutCompleted, onAsyncPaymentSucceeded, onAsyncPaymentFailed, onCheckoutExpired,
  onChargeRefunded, onDisputeCreated, onDisputeClosed,
  grantDueInstalments, refreshLegacyEntitlements, expireAccess, historyFor,
};
