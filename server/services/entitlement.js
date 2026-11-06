// ════════════════════════════════════════════════════════════════
// Entitlement — what an account may do right now, decided in one place.
//
// The facts live on the profile and are written only by the server
// (fulfill_purchase / revoke_purchase / _end_access in Postgres, legacy
// refresh): access_plan, access_expires_at, subscription_status. Plan
// durations come from services/pricing.js PLANS (copied onto each purchase
// at checkout; the database adds them as calendar months / days).
//
//   active    access_expires_at lies in the future (pricing.hasAccess) —
//             the paid application, never the onboarding or plan screen.
//   expired   it had paid access (access_expires_at is set) that ended or
//             was revoked: the plan selection, no paid functionality.
//   none      never had paid access:
//               · a new account (onboarding eligible) → the onboarding,
//                 which ends with the plan selection;
//               · an older free account (from before the onboarding) →
//                 the application with its existing limits (every paid
//                 action asks for a plan).
//
// route: 'app' | 'onboarding' | 'plans'. planRequired: the server gate
// (server.js) answers every other API route with 403 ONBOARDING_REQUIRED.
// ════════════════════════════════════════════════════════════════
const pricing = require('./pricing');

function hadPaidAccess(profile) {
  return !!(profile && profile.access_expires_at);
}

function entitlementOf(profile, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const p = profile || {};
  const active = pricing.hasAccess(p, now);
  const state = active ? 'active' : hadPaidAccess(p) ? 'expired' : 'none';
  const route = active ? 'app' : state === 'expired' ? 'plans' : (o.onboardingEligible ? 'onboarding' : 'app');
  const planId = pricing.planIdFrom(p.access_plan);
  return {
    active,
    state,
    route,
    planRequired: route !== 'app',
    plan: active ? (planId || p.subscription_status || null) : null,
    lastPlan: planId,
    expiresAt: p.access_expires_at || null,
  };
}

// ── A plan assigned by hand (trusted operator override) ───────────────
// An operator may give an account a plan directly in Supabase: access_plan =
// one of the five plans (id or name: "annual", "Annual", "Semi-Annual", …)
// and access_expires_at in the future. pricing.hasAccess grants it at once.
// The first time the server sees it, it records it the way a purchase is
// recorded — subscription_status 'paid', the canonical plan id — so the
// database's own checks (spend_credits, the expiry job) treat it exactly
// like a purchased plan. Only if the row is still as it was read (same end
// date); nothing else changes (no credits, no purchase record). Browsers
// can't write profiles, so only operators and the server can do this.
// Returns the profile as it now stands.
async function adoptManualPlan(db, userId, profile, now) {
  const p = profile || {};
  if (pricing.PAID_STATUSES.includes(p.subscription_status || '')) return profile;
  const id = pricing.planIdFrom(p.access_plan);
  if (!id || !pricing.hasAccess(p, now)) return profile;
  try {
    const { error } = await db.from('profiles').update({ subscription_status: 'paid', access_plan: id })
      .eq('id', userId).eq('access_expires_at', p.access_expires_at);
    if (error) throw error;
    console.log('[Entitlement] manually assigned plan recorded', JSON.stringify({ user: userId, plan: id, until: p.access_expires_at }));
    return Object.assign({}, p, { subscription_status: 'paid', access_plan: id });
  } catch (err) {
    // Access is granted anyway (hasAccess); recording is retried on the next check.
    console.warn('[Entitlement] could not record the manually assigned plan:', err.code || err.message);
    return profile;
  }
}

module.exports = { entitlementOf, hadPaidAccess, adoptManualPlan };
