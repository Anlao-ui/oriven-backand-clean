// ════════════════════════════════════════════════════════════════
// One-time access purchases (Flex, Monthly, Quarterly, Semi-Annual, Annual).
//
//   checkout  createCheckout() checks the plan's configured Stripe Price
//             (services/pricing.js STRIPE_PRICE_IDS) with Stripe — one-time,
//             EUR, the exact amount, tax behaviour inclusive, active — writes
//             a 'pending' purchase with the terms of services/pricing.js and
//             that price/product, then opens a Stripe Checkout session for
//             that Price in payment mode (no subscription, no automatic
//             renewal). Stripe Tax works out the VAT inside the price;
//             businesses can add a VAT ID. A missing, placeholder or
//             different price refuses the checkout: nothing is created.
//   paid      only a CONFIRMED payment (checkout.session.completed with
//             payment_status 'paid', or async_payment_succeeded) fulfils the
//             purchase, through fulfill_purchase() in Postgres: amount and
//             currency must match the terms, it runs at most once, and it
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
}

function alert(event, fields) {
  console.warn('[Purchases] ALERT ' + JSON.stringify(Object.assign({ ts: new Date().toISOString(), event }, fields || {})));
}
class PurchaseError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 400; }
}
const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;

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
// plan's amount, tax behaviour inclusive (so Stripe Tax keeps the shown
// price as the total instead of adding VAT on top). A verified price is
// remembered for 10 minutes. Returns { priceId, productId }.
const _verified = new Map(); // priceId -> { at, productId }
const PRICE_UNAVAILABLE = 'Payments for this plan aren’t available right now. Nothing was charged — please try again later or contact contact@orivenai.com.';
async function verifiedStripePrice(plan) {
  let priceId;
  try { priceId = pricing.stripePriceIdFor(plan.id); }
  catch (err) {
    alert('stripe_price_not_configured', { plan: plan.id, problem: err.problem });
    throw new PurchaseError('PRICE_NOT_CONFIGURED', PRICE_UNAVAILABLE, 503);
  }
  const hit = _verified.get(priceId);
  if (hit && Date.now() - hit.at < 10 * 60e3) return { priceId, productId: hit.productId };
  let price;
  try { price = await _stripe.prices.retrieve(priceId); }
  catch (err) {
    alert('stripe_price_unavailable', { plan: plan.id, price: priceId, error: err.code || err.message });
    throw new PurchaseError('PRICE_NOT_CONFIGURED', PRICE_UNAVAILABLE, 503);
  }
  const cents = pricing.priceInclVatCents(plan);
  const problems = [];
  if (!price || price.id !== priceId) problems.push('different price returned');
  else {
    if (price.active === false) problems.push('price is archived');
    if (price.type !== 'one_time' || price.recurring) problems.push('price is recurring, not one-time');
    if (String(price.currency || '').toLowerCase() !== pricing.CURRENCY) problems.push('currency ' + price.currency + ' instead of ' + pricing.CURRENCY);
    if (price.unit_amount !== cents) problems.push('amount ' + price.unit_amount + ' instead of ' + cents);
    if (price.tax_behavior !== 'inclusive') problems.push('tax behaviour ' + (price.tax_behavior || 'unspecified') + ' instead of inclusive');
    // A Test Mode price must never be sold with a live key (or the reverse).
    const mode = pricing.stripeMode();
    if (typeof price.livemode === 'boolean' && mode !== 'unknown' && price.livemode !== (mode === 'live')) {
      problems.push((price.livemode ? 'Live' : 'Test') + ' Mode price used with a ' + mode + ' key');
    }
  }
  if (problems.length) {
    alert('stripe_price_mismatch', { plan: plan.id, price: priceId, problems });
    throw new PurchaseError('PRICE_CONFIG_MISMATCH', PRICE_UNAVAILABLE, 503);
  }
  const productId = idOf(price.product);
  _verified.set(priceId, { at: Date.now(), productId });
  return { priceId, productId };
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

async function fulfillFromSession(session) {
  if (session.mode !== 'payment') return { skipped: 'not_payment_mode' };
  if (session.payment_status !== 'paid') return { skipped: 'payment_' + session.payment_status }; // async methods: wait for async_payment_succeeded
  const found = await _purchaseOfSession(session);
  if (!found.purchase) return found;
  const p = found.purchase;
  const { data, error } = await _db.rpc('fulfill_purchase', {
    p_purchase_id: p.id,
    p_session_id: session.id,
    p_payment_intent: idOf(session.payment_intent),
    p_customer: idOf(session.customer),
    p_amount_total: session.amount_total,
    p_amount_tax: (session.total_details && session.total_details.amount_tax) || 0,
    p_currency: session.currency,
  });
  if (error) throw error;
  const r = data || {};
  if (!r.ok) { alert('fulfillment_refused', { purchase: p.id, reason: r.reason, amount: session.amount_total, currency: session.currency }); return { userId: p.user_id, purchaseId: p.id, skipped: r.reason }; }
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
  init, PurchaseError, createCheckout, fulfillFromSession, verifiedStripePrice,
  _resetForTests() { _verified.clear(); },
  onCheckoutCompleted, onAsyncPaymentSucceeded, onAsyncPaymentFailed, onCheckoutExpired,
  onChargeRefunded, onDisputeCreated, onDisputeClosed,
  grantDueInstalments, refreshLegacyEntitlements, expireAccess, historyFor,
};
