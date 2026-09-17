-- ============================================================================
-- Oriven Onboarding Rebuild — primary_goal column
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change).
-- Safe to re-run: guarded with IF NOT EXISTS.
--
-- WHAT THIS ADDS:
--   profiles.primary_goal (text, nullable) — the product the user chose in
--   the new onboarding's Step 2 ("What do you want to achieve first?"): one
--   of 'create' | 'research' | 'launch' | 'campaigns' | 'autopilot' |
--   'business'. Stable IDs, not display labels — matches the same values
--   already used as data-orv-page on the sidebar nav buttons (app.html).
--
--   Validation of the six allowed values is enforced in server.js
--   (PUT /api/onboarding/goal), not a DB CHECK constraint — this matches
--   every other whitelist in this codebase (plan ids, rule operators,
--   action types), which are all validated in JS rather than SQL.
--
-- UNTIL THIS IS APPLIED: PUT /api/onboarding/goal degrades gracefully (same
-- "column doesn't exist yet" pattern as profiles.preferences below) — it
-- reports columnMissing:true instead of crashing, and onboarding still
-- completes, but the chosen goal will not actually persist or affect first-
-- run routing until this migration is applied.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS primary_goal text;
