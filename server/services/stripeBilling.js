// ── Stripe ⇄ OrivenAI billing reconciliation ─────────────────────
//
// One place that turns Stripe's subscription state into OrivenAI's plan
// state. Rules:
//
//  • Stripe is the authority. A plan is derived from the subscription's
//    CURRENT price (PLAN_BY_PRICE_ID) and status, never from a plan name the
//    browser asked for or from metadata alone.
//  • Ownership. A subscription is matched to a profile by
//    profiles.stripe_subscription_id. The only way a NEW subscription gets
//    linked is through metadata.userId that the server itself wrote at
//    Checkout (the authenticated user), and only if that profile isn't
//    already tied to a different Stripe customer and the customer isn't
//    tied to a different profile. Mismatches are refused and logged.
//  • Entitlement by status:
//      active / trialing        → plan = price plan
//      past_due                 → keep the current plan (Stripe is retrying
//                                 the payment); no new credits
//      incomplete               → nothing granted
//      unpaid / canceled /
//      incomplete_expired       → free
//  • Credits are only (re)provisioned after Stripe CONFIRMED a payment
//    (checkout.session.completed with payment_status paid/no_payment_required,
//    invoice.payment_succeeded), always for the subscription's real current
//    billing period. Every path computes the same period, so
//    creditManager.provisionCreditsForCycle (idempotent on plan + cycle end)
//    turns duplicates, retries and out-of-order events into no-ops.
//  • Event idempotency: each Stripe event id is processed once
//    (stripe_webhook_events, migration 2026-10-stripe-webhook-events.sql).

let _stripe = null, _db = null, _cm = null, _planByPrice = {};
function init({ stripe, db, creditManager, planByPriceId }) {
  _stripe = stripe; _db = db; _cm = creditManager; _planByPrice = planByPriceId || {};
}

const ACTIVE = ['active', 'trialing'];
const PAID = ['starter', 'creator', 'professional'];
const REVOKE = ['unpaid', 'canceled', 'incomplete_expired'];
// Statuses during which a user must not open a second subscription.
const LIVE = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];

function alert(event, fields) {
  console.warn('[Billing] ALERT ' + JSON.stringify(Object.assign({ ts: new Date().toISOString(), event }, fields || {})));
}

function priceIdOf(sub) {
  const it = sub && sub.items && sub.items.data && sub.items.data[0];
  return (it && it.price && it.price.id) || null;
}
function planOf(sub) {
  const p = priceIdOf(sub);
  return (p && _planByPrice[p]) || null;
}
// API 2025-02-24 exposes the period on the subscription; newer API versions
// moved it onto the subscription item — read either.
function periodOf(sub) {
  const it = sub && sub.items && sub.items.data && sub.items.data[0];
  const start = (sub && sub.current_period_start) || (it && it.current_period_start);
  const end = (sub && sub.current_period_end) || (it && it.current_period_end);
  return (start && end) ? { startISO: new Date(start * 1000).toISOString(), endISO: new Date(end * 1000).toISOString() } : null;
}
function subscriptionIdOfInvoice(inv) {
  if (!inv) return null;
  if (typeof inv.subscription === 'string') return inv.subscription;
  if (inv.subscription && inv.subscription.id) return inv.subscription.id;
  const p = inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription;
  return typeof p === 'string' ? p : (p && p.id) || null;
}

// ── Profile resolution (ownership) ────────────────────────────────
async function profileBySubscription(subId) {
  if (!subId) return null;
  const { data, error } = await _db.from('profiles')
    .select('id, subscription_status, stripe_customer_id, stripe_subscription_id, pending_plan')
    .eq('stripe_subscription_id', subId).maybeSingle();
  if (error) throw error;
  return data || null;
}

// Links a brand-new subscription to the user the server put in its metadata
// at Checkout. Returns the profile, or null when ownership can't be proven.
async function linkFromMetadata(sub, userIdHint) {
  const meta = (sub && sub.metadata) || {};
  const userId = meta.userId || userIdHint || null;
  if (!userId) return null;
  if (meta.userId && userIdHint && meta.userId !== userIdHint) {
    alert('ownership_mismatch_metadata', { sub: sub.id, metaUser: meta.userId, sessionUser: userIdHint });
    return null;
  }
  const { data: profile, error } = await _db.from('profiles')
    .select('id, subscription_status, stripe_customer_id, stripe_subscription_id, pending_plan')
    .eq('id', userId).maybeSingle();
  if (error) throw error;
  if (!profile) { alert('link_profile_missing', { sub: sub.id, userId }); return null; }
  // The Stripe customer must not already belong to someone else.
  const { data: owner, error: ownErr } = await _db.from('profiles').select('id')
    .eq('stripe_customer_id', sub.customer).neq('id', userId).limit(1);
  if (ownErr) throw ownErr;
  if (owner && owner.length) { alert('customer_owned_by_other_profile', { sub: sub.id, userId }); return null; }
  // A profile already tied to a different customer can't silently switch.
  if (profile.stripe_customer_id && profile.stripe_customer_id !== sub.customer) {
    alert('profile_has_other_customer', { sub: sub.id, userId });
    return null;
  }
  if (profile.stripe_subscription_id && profile.stripe_subscription_id !== sub.id) {
    // A second subscription for the same user: link the new, confirmed one,
    // but flag it — the old one may still be billing.
    alert('replacing_linked_subscription', { userId, previousSub: profile.stripe_subscription_id, newSub: sub.id });
  }
  const { error: upErr } = await _db.from('profiles')
    .update({ stripe_customer_id: sub.customer, stripe_subscription_id: sub.id }).eq('id', userId);
  if (upErr) throw upErr;
  return Object.assign({}, profile, { stripe_customer_id: sub.customer, stripe_subscription_id: sub.id });
}

// ── Reconciliation ────────────────────────────────────────────────
// Applies Stripe's subscription state to the owning profile.
// opts.paymentConfirmed: Stripe confirmed a payment for this period →
// credits may be provisioned for it.
async function applySubscription(sub, profile, opts) {
  opts = opts || {};
  const status = sub.status;
  const before = profile.subscription_status || 'free';
  let plan = planOf(sub);
  // A legacy price that is no longer configured (e.g. an older Starter price a
  // customer still pays): keep the plan this linked subscription already
  // grants rather than withholding a paid renewal's credits. Flagged so the
  // price can be added to the configuration.
  if (!plan && PAID.includes(before) && profile.stripe_subscription_id === sub.id && ACTIVE.includes(status)) {
    alert('unmapped_price_kept_current_plan', { sub: sub.id, price: priceIdOf(sub), plan: before });
    plan = before;
  }
  const out = { userId: profile.id, status, plan: before, changed: false, credits: null };

  if (REVOKE.includes(status)) {
    if (before !== 'free') {
      const { error } = await _db.from('profiles').update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null })
        .eq('id', profile.id).eq('stripe_subscription_id', sub.id);
      if (error) throw error;
      out.plan = 'free'; out.changed = true;
    }
    return out;
  }
  if (!ACTIVE.includes(status)) return out; // past_due keeps the current plan; incomplete grants nothing
  if (!plan) { alert('unmapped_price', { sub: sub.id, price: priceIdOf(sub) }); return out; }

  if (plan !== before) {
    const patch = { subscription_status: plan };
    if (profile.pending_plan && profile.pending_plan !== 'free') { patch.pending_plan = null; patch.pending_plan_date = null; }
    const { error } = await _db.from('profiles').update(patch).eq('id', profile.id).eq('stripe_subscription_id', sub.id);
    if (error) throw error;
    out.plan = plan; out.changed = true;
  }
  if (opts.paymentConfirmed) {
    const period = periodOf(sub);
    if (!period) { alert('no_period_for_credit_grant', { sub: sub.id }); return out; }
    out.credits = await _cm.provisionCreditsForCycle(profile.id, plan, period.startISO, period.endISO, opts.source || 'stripe', { previousPlan: before });
  }
  return out;
}

// ── Webhook event idempotency ─────────────────────────────────────
// Returns 'process' | 'duplicate' | 'busy'. Without the table it degrades to
// 'process' (state-based idempotency above still prevents double grants).
let _eventsTable = 'unknown';
async function claimEvent(event) {
  if (_eventsTable === 'missing') return 'process';
  const { error } = await _db.from('stripe_webhook_events').insert({ id: event.id, type: event.type, status: 'processing' });
  if (!error) { _eventsTable = 'ok'; return 'process'; }
  if (error.code === '42P01' || error.code === 'PGRST205') {
    if (_eventsTable !== 'missing') console.warn('[Billing] stripe_webhook_events table not found — apply docs/migrations/2026-10-stripe-webhook-events.sql');
    _eventsTable = 'missing';
    return 'process';
  }
  if (error.code !== '23505') { console.warn('[Billing] event claim failed:', error.message); return 'process'; }
  const { data: row } = await _db.from('stripe_webhook_events').select('status, updated_at').eq('id', event.id).maybeSingle();
  if (row && row.status === 'processed') return 'duplicate';
  // A previous attempt failed, or one is stuck: take it over atomically.
  const staleCut = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: taken } = await _db.from('stripe_webhook_events')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', event.id).or(`status.eq.failed,updated_at.lt.${staleCut}`).select('id');
  return taken && taken.length ? 'process' : 'busy';
}
async function finishEvent(event, ok, errMsg) {
  if (_eventsTable === 'missing') return;
  await _db.from('stripe_webhook_events')
    .update({ status: ok ? 'processed' : 'failed', error: ok ? null : String(errMsg || '').slice(0, 300), updated_at: new Date().toISOString() })
    .eq('id', event.id).then(() => {}, () => {});
}

// ── Event handlers ────────────────────────────────────────────────
async function retrieveSub(id) { return _stripe.subscriptions.retrieve(id); }

async function onCheckoutCompleted(session) {
  if (session.mode && session.mode !== 'subscription') return { skipped: 'not_subscription' };
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return { skipped: 'payment_' + session.payment_status };
  const userId = session.metadata && session.metadata.userId;
  if (!userId || !session.subscription) return { skipped: 'missing_user_or_subscription' };
  // Sessions created since the identity fix carry client_reference_id = the
  // authenticated user; it must agree with the metadata.
  if (session.client_reference_id && session.client_reference_id !== userId) {
    alert('checkout_identity_mismatch', { session: session.id });
    return { skipped: 'identity_mismatch' };
  }
  const sub = await retrieveSub(typeof session.subscription === 'string' ? session.subscription : session.subscription.id);
  if (session.customer && sub.customer !== (typeof session.customer === 'string' ? session.customer : session.customer.id)) {
    alert('checkout_customer_mismatch', { session: session.id, sub: sub.id });
    return { skipped: 'customer_mismatch' };
  }
  let profile = await profileBySubscription(sub.id);
  if (!profile) profile = await linkFromMetadata(sub, userId);
  if (!profile) return { skipped: 'ownership_not_proven' };
  if (profile.id !== userId) { alert('checkout_sub_linked_to_other_user', { session: session.id, sub: sub.id }); return { skipped: 'linked_elsewhere' }; }
  return applySubscription(sub, profile, { paymentConfirmed: true, source: 'stripe_checkout' });
}

async function onSubscriptionUpdated(subEvt) {
  const profile = await profileBySubscription(subEvt.id);
  if (!profile) return { skipped: 'unlinked_subscription' }; // linked by checkout/invoice once paid
  if (profile.stripe_customer_id && profile.stripe_customer_id !== subEvt.customer) {
    alert('subscription_customer_mismatch', { sub: subEvt.id, userId: profile.id });
    return { skipped: 'customer_mismatch' };
  }
  // Keep the "cancellation scheduled" display state in sync (Settings or
  // Customer Portal). Only touches pending_plan when it means cancel-to-free.
  const cancelIso = scheduledCancelIso(subEvt);
  const q = _db.from('profiles');
  const { error: cErr } = cancelIso
    ? await q.update({ pending_plan: 'free', pending_plan_date: cancelIso }).eq('id', profile.id).eq('stripe_subscription_id', subEvt.id)
    : await q.update({ pending_plan: null, pending_plan_date: null }).eq('id', profile.id).eq('stripe_subscription_id', subEvt.id).eq('pending_plan', 'free');
  if (cErr) throw cErr;
  // Plan label follows Stripe; credits wait for a confirmed payment.
  return applySubscription(subEvt, Object.assign({}, profile, cancelIso ? { pending_plan: 'free' } : {}), { paymentConfirmed: false });
}

async function onSubscriptionDeleted(subEvt) {
  const profile = await profileBySubscription(subEvt.id);
  if (!profile) return { skipped: 'unlinked_subscription' }; // e.g. an old, already-replaced subscription
  const { error } = await _db.from('profiles').update({ subscription_status: 'free', pending_plan: null, pending_plan_date: null })
    .eq('id', profile.id).eq('stripe_subscription_id', subEvt.id);
  if (error) throw error;
  return { userId: profile.id, plan: 'free', changed: profile.subscription_status !== 'free' };
}

const GRANTING_REASONS = ['subscription_create', 'subscription_cycle', 'subscription_update'];
async function onInvoicePaid(inv) {
  const subId = subscriptionIdOfInvoice(inv);
  if (!subId) return { skipped: 'not_a_subscription_invoice' };
  if (inv.billing_reason && !GRANTING_REASONS.includes(inv.billing_reason)) return { skipped: 'reason_' + inv.billing_reason };
  // Always re-read the subscription: the invoice's own period_start/end look
  // back one period for renewals, which previously made each renewal store
  // an already-ended cycle (and the nightly safety net then granted again).
  const sub = await retrieveSub(subId);
  if (sub.customer !== inv.customer) { alert('invoice_customer_mismatch', { sub: subId }); return { skipped: 'customer_mismatch' }; }
  let profile = await profileBySubscription(sub.id);
  if (!profile) profile = await linkFromMetadata(sub, null); // invoice can arrive before checkout.session.completed
  if (!profile) return { skipped: 'ownership_not_proven' };
  return applySubscription(sub, profile, { paymentConfirmed: true, source: 'stripe_invoice' });
}

function scheduledCancelIso(sub) {
  if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) return null;
  if (sub.cancel_at_period_end) { const p = periodOf(sub); return p ? p.endISO : null; }
  if (sub.cancel_at) return new Date(sub.cancel_at * 1000).toISOString();
  return null;
}

// Nightly reconciliation for a Stripe-billed profile whose stored credit
// cycle has ended: only refill when Stripe says the subscription is active
// and has moved into a later, paid period. Never refills past_due/unpaid.
async function reconcileOverdue(profile) {
  const sub = await _stripe.subscriptions.retrieve(profile.stripe_subscription_id, { expand: ['latest_invoice'] });
  if (profile.stripe_customer_id && sub.customer !== profile.stripe_customer_id) {
    alert('reconcile_customer_mismatch', { userId: profile.id });
    return { skipped: 'customer_mismatch' };
  }
  if (!ACTIVE.includes(sub.status)) {
    if (REVOKE.includes(sub.status)) return applySubscription(sub, profile, { paymentConfirmed: false });
    return { skipped: 'status_' + sub.status }; // past_due/incomplete: wait for the payment
  }
  const latest = sub.latest_invoice;
  const latestStatus = latest && typeof latest === 'object' ? latest.status : null;
  if (latestStatus && latestStatus !== 'paid') return { skipped: 'latest_invoice_' + latestStatus };
  return applySubscription(sub, profile, { paymentConfirmed: true, source: 'stripe_reconcile' });
}

module.exports = {
  init, ACTIVE, LIVE, REVOKE, planOf, periodOf, priceIdOf, scheduledCancelIso,
  profileBySubscription, applySubscription, claimEvent, finishEvent,
  onCheckoutCompleted, onSubscriptionUpdated, onSubscriptionDeleted, onInvoicePaid, reconcileOverdue,
  _resetForTests: () => { _eventsTable = 'unknown'; },
};
