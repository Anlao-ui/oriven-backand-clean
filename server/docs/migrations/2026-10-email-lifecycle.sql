-- ═══════════════════════════════════════════════════════════════════
-- Lifecycle email (2026-10) — preparation only
--
-- Storage for consent, a send ledger and a suppression list
-- (services/email/lifecycle.js). Nothing is sent until EMAIL_MODE and
-- EMAIL_LIFECYCLE_ENABLED are set on Render after review.
--
-- Additive only. Consent columns start NULL for everyone: no historical
-- account is opted in to marketing email by this migration.
-- Safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Marketing consent (explicit opt-in; NULL/false = no marketing email)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS marketing_opt_in         boolean,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at      timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_consent_source text,        -- 'signup' | 'settings'
  ADD COLUMN IF NOT EXISTS marketing_opt_out_at     timestamptz;

-- 2. Send ledger — one row per (user, email). The unique key is what makes
--    a duplicate run, a second process or a retry unable to send twice.
--    No addresses, subjects or content are stored.
CREATE TABLE IF NOT EXISTS public.email_sends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  template     text NOT NULL,
  dedupe_key   text NOT NULL,
  category     text NOT NULL CHECK (category IN ('service', 'marketing')),
  status       text NOT NULL,          -- sending | sent | delivered | failed | skipped | bounced | complained | suppressed | failed_provider
  attempts     smallint NOT NULL DEFAULT 1,
  provider_id  text,                   -- Resend email id
  error        text,                   -- short code only
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS email_sends_status_idx   ON public.email_sends (status, attempts);
CREATE INDEX IF NOT EXISTS email_sends_provider_idx ON public.email_sends (provider_id);
ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;   -- service role only
REVOKE ALL ON TABLE public.email_sends FROM anon, authenticated;

-- 3. Suppression list — SHA-256 of the lower-cased address (hard bounces,
--    complaints, provider suppressions). Never mailed again.
CREATE TABLE IF NOT EXISTS public.email_suppressions (
  email_hash  text PRIMARY KEY,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;  -- service role only
REVOKE ALL ON TABLE public.email_suppressions FROM anon, authenticated;
