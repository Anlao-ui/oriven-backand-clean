-- ═══════════════════════════════════════════════════════════════════
-- Signup: email verification storage (2026-10)
--
-- POST /api/signup wrote columns that never existed (phone, email_verified,
-- verification_token, verification_sent_at), so PostgREST rejected the whole
-- profile write and no verification token was ever stored. The backend now
-- writes only real columns (services/accounts.js) and stores a SHA-256 hash
-- of the token, never the token itself.
--
-- Additive only. No default and no backfill: existing rows get NULL, which
-- the app treats as "created before verification worked" — never as
-- unverified. The phone number stays in the auth user's metadata; no
-- profiles.phone column is added.
--
-- Signup works without this migration (profile is created, no verification
-- email is sent). Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_verified          boolean,
  ADD COLUMN IF NOT EXISTS verification_token_hash text,
  ADD COLUMN IF NOT EXISTS verification_sent_at    timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_verification_token_hash_idx
  ON public.profiles (verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

-- NOTE: the daily 'unverified-account-cleanup' job (server.js) deletes
-- accounts with email_verified = false older than 14 days. It is disabled
-- unless UNVERIFIED_ACCOUNT_CLEANUP=true is set on Render — a product
-- decision, not part of this migration.
