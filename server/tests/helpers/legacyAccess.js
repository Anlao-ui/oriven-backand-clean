// Shared by the in-memory Supabase mocks: makes a fixture behave like
// production after docs/migrations/2026-10-access-purchases.sql.
//
// backfill(profiles) mirrors the migration's legacy transition: a legacy
// paying profile (starter/creator/professional) whose fixture doesn't mention
// access_expires_at gets an entitlement that keeps access at least 7 days
// ahead (refresh_legacy_entitlements) — never derived from credits_cycle_end.
// A fixture that sets access_expires_at itself (null included) is untouched,
// so tests of expired or missing access stay exact.
//
// spendAllowed(profile) mirrors spend_credits: nothing is spent without a
// paying status AND access_expires_at in the future.
const LEGACY = ['starter', 'creator', 'professional'];
const PAYING = ['paid'].concat(LEGACY);

function backfill(profiles) {
  (profiles || []).forEach((r) => {
    if (!r || !LEGACY.includes(r.subscription_status) || 'access_expires_at' in r) return;
    r.access_expires_at = new Date(Date.now() + 7 * 864e5).toISOString();
    if (!('access_plan' in r)) r.access_plan = r.subscription_status;
  });
}

function spendAllowed(p) {
  return !!p && PAYING.includes(p.subscription_status) && !!p.access_expires_at && Date.parse(p.access_expires_at) > Date.now();
}

module.exports = { backfill, spendAllowed, PAYING, LEGACY };
