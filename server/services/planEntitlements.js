// ── Entitlements: one product, the same functionality for every paying customer ──
//
// Access is time-based (profiles.access_expires_at, services/pricing.js
// hasAccess); this map only answers "what does an account with access get".
// Every paying status gets everything currently available; 'free' (no
// access, never bought or expired) gets nothing that is paid. Plans differ
// only in price, period and credits (services/pricing.js).
//
// 'paid' = the access periods (Flex … Annual). starter/creator/professional
// = legacy monthly subscriptions, honoured until they end.

const ALL = { research: true, autopilot: true, orivenChat: true, notifications: true, prioritySupport: true, weeklyReport: true };
const NONE = { research: false, autopilot: false, orivenChat: false, notifications: false, prioritySupport: false, weeklyReport: false };

const PLAN_ENTITLEMENTS = {
  free: NONE,
  paid: ALL,
  starter: ALL,
  creator: ALL,
  professional: ALL,
};

const PLAN_ORDER = ['free', 'paid'];

function hasEntitlement(plan, key) {
  const e = PLAN_ENTITLEMENTS[plan];
  return !!(e && e[key]);
}

// The plan a customer needs for a capability ('paid' for every paid one).
function minPlanFor(key) {
  return PLAN_ORDER.find(p => hasEntitlement(p, key)) || null;
}

module.exports = { PLAN_ENTITLEMENTS, PLAN_ORDER, hasEntitlement, minPlanFor };
