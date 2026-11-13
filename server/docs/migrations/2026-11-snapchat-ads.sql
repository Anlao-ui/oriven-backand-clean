-- ════════════════════════════════════════════════════════════════════
-- Snapchat Ads — OPTIONAL migration (2026-11)
--
-- Snapchat connections are stored like every other ad platform: one row in
-- public.integrations per user, provider = 'snapchat_ads' (tokens in the
-- existing access_token / refresh_token / token_expiry columns, the chosen
-- ad account + Public Profile in the existing active_ad_account JSONB).
--
-- These two columns only keep the discovered ad-account list between
-- requests (same convention as pinterest_ads_accounts). The server works
-- without them: it drops them on write and re-reads the list from Snapchat.
--
-- Safe to run more than once. No data is changed. No RLS change: the
-- integrations table stays server-only (see 2026-11-integrations-owner-lockdown.sql).
-- Run in the Supabase SQL editor as the owner of public.integrations.
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS snapchat_ads_accounts JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS snapchat_ads_accounts_error TEXT;

-- Verify:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'integrations' AND column_name LIKE 'snapchat%';
