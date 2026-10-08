-- ═══════════════════════════════════════════════════════════════════
-- Free first ad (2026-10) — REQUIRES PRODUCT APPROVAL before use
--
-- Tracks the one free ad image a new Free account gets for its first ad
-- (services/firstAd.js). The feature stays off until FREE_FIRST_AD_ENABLED
-- is set to true on Render; this migration alone changes nothing.
--
-- Its own table, NOT columns on profiles: only the backend (service role)
-- can read or write it, so no signed-in user can reset their own claim
-- through the Supabase API.
--
--   claimed_at  when the free image was claimed (NULL = released after a
--               failed attempt, so the account may try once more)
--   attempts    claims made (max 2) — a failed image releases the claim,
--               but the attempt still counts
--
-- Additive only. Existing accounts are never eligible (eligibility also
-- requires an account created on/after the onboarding rollout).
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.free_first_ad_claims (
  user_id     uuid PRIMARY KEY,
  claimed_at  timestamptz,
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Backend only: RLS on with no policies, and no privileges for browser roles.
ALTER TABLE public.free_first_ad_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.free_first_ad_claims FROM anon, authenticated;
