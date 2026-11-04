// ════════════════════════════════════════════════════════════════
// Automations — plan limits (resource protection for a one-time charge).
//
// Proposed limits (reported in the release notes; existing automations
// above a limit keep running — only creating NEW ones is blocked):
//   active        automations that are on (rules + schedules)
//   pendingJobs   scheduled occurrences waiting to run
//   evalMinutes   how often an account's rules are checked (API usage)
// Shared, all plans:
//   emailsPerHour, maxRetries, maxScheduleItems, approvalHours,
//   missedGraceMinutes, maxCampaignsPerRule
// Every paying customer gets the same limits ('paid'); legacy subscribers get
// at least that (Professional keeps its higher contract limits). An account
// without access ('free') has no Automations.
// ════════════════════════════════════════════════════════════════
'use strict';

const PAID = { active: 25, pendingJobs: 250, evalMinutes: 60 };
const PLAN = {
  free:         { active: 0,  pendingJobs: 0,   evalMinutes: null },
  paid:         PAID,
  starter:      PAID,
  creator:      PAID,
  professional: { active: 50, pendingJobs: 500, evalMinutes: 60 },
};
const SHARED = {
  emailsPerHour: 6,        // more updates in an hour stay in-app only (rate_limited)
  maxRetries: 3,           // temporary platform errors on a scheduled action
  retryBackoffMinutes: [2, 10, 30],
  maxScheduleItems: 14,    // e.g. on + off for every day of the week
  approvalHours: 48,       // a pending approval expires after this
  missedGraceMinutes: 60,  // a scheduled action later than this is skipped, not run late
  maxCampaignsPerRule: 50,
  defaultCooldownHours: 24,
};

function forPlan(plan) { return Object.assign({}, PLAN[plan] || PLAN.free, SHARED); }

module.exports = { PLAN, SHARED, forPlan };
