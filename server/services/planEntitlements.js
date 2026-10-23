// ════════════════════════════════════════════════════════════════
// Plan entitlements — the single server-side answer to "may this plan use
// this capability?". Mirrors plans.js (frontend) ORIVEN_PLANS[*].entitlements.
//
// The workflow (Control Center, Create, Launch, Campaigns) is available on
// every plan; Research and Autopilot from Starter; Oriven Chat and the in-app
// notification center from Creator; Priority Support and the Weekly AI
// Performance Report on Professional.
//
// `notifications` is the in-app notification center only (the bell and its
// read/clear state). Operational automation emails are a separate feature
// that follows the `autopilot` entitlement (services/automations/notify.js).
//
// Access is separate from usage: an entitled plan still pays the normal
// credit cost for metered actions (creditManager.FEATURE_COSTS, unchanged).
// Plans are read from the authenticated user's profiles.subscription_status,
// never from the request.
// ════════════════════════════════════════════════════════════════

const PLAN_ENTITLEMENTS = {
  free:         { research: false, autopilot: false, orivenChat: false, notifications: false, prioritySupport: false, weeklyReport: false },
  starter:      { research: true,  autopilot: true,  orivenChat: false, notifications: false, prioritySupport: false, weeklyReport: false },
  creator:      { research: true,  autopilot: true,  orivenChat: true,  notifications: true,  prioritySupport: false, weeklyReport: false },
  professional: { research: true,  autopilot: true,  orivenChat: true,  notifications: true,  prioritySupport: true,  weeklyReport: true  },
};

const PLAN_ORDER = ['free', 'starter', 'creator', 'professional'];

function hasEntitlement(plan, key) {
  const e = PLAN_ENTITLEMENTS[plan];
  return !!(e && e[key]);
}

// Lowest plan that includes a capability (for honest upgrade messages).
function minPlanFor(key) {
  return PLAN_ORDER.find(p => hasEntitlement(p, key)) || null;
}

module.exports = { PLAN_ENTITLEMENTS, PLAN_ORDER, hasEntitlement, minPlanFor };
