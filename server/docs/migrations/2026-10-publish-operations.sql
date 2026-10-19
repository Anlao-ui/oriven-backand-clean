-- ============================================================================
-- Publish operations ledger — PREPARED, NOT YET APPLIED
--
-- Run once, by hand, in the Supabase Dashboard → SQL Editor (same convention
-- as every file in this folder). Safe to re-run.
--
-- DEPLOYMENT ORDER: apply this BEFORE deploying the backend that contains
-- services/publishLedger.js. That code fails closed: without this table every
-- POST /api/publish/{platform} answers 503 PUBLISH_LEDGER_UNAVAILABLE and
-- sends nothing to any ad platform (publishing is unavailable, never unsafe).
--
-- WHY: publishing was protected only by an in-memory lock that lasts for one
-- request in one process. A proxy timeout (504), a server restart or a second
-- device could publish the same campaign twice. This table records each
-- campaign's publish operation durably:
--   publishing  → a request is sending objects to the platform
--   published   → the platform confirmed creation (external ids stored)
--   failed      → confirmed not created / rolled back (publishing again is safe)
--   unconfirmed → a request never finished; nothing is sent again until a
--                 status check or the user resolves it
-- One row per (user, platform, campaign): the UNIQUE constraint is the
-- atomic claim. Rows are written only by the backend (service role).
-- ============================================================================

CREATE TABLE IF NOT EXISTS publish_operations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform              text NOT NULL CHECK (platform IN ('meta', 'google', 'tiktok', 'pinterest')),
  client_ref_id         text NOT NULL,          -- the OrivenAI campaign id (localStorage / campaigns.client_ref_id)
  op_id                 text,                   -- the client's publish attempt id (stable across retries of one attempt)
  state                 text NOT NULL CHECK (state IN ('publishing', 'published', 'failed', 'unconfirmed')),
  campaign_name         text,                   -- the exact name sent to the platform (used by the status check)
  external_account_id   text,                   -- the ad account the server published to (from the user's own integration)
  external_campaign_id  text,
  external_ids          jsonb,                  -- { accountName, adSetIds, adIds, ... } as returned by the platform
  error                 text,
  rollback              jsonb,                  -- { complete: bool, leftovers: [...] } after a failed publish
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, client_ref_id)
);
CREATE INDEX IF NOT EXISTS publish_operations_user_idx ON publish_operations(user_id, updated_at DESC);

ALTER TABLE publish_operations ENABLE ROW LEVEL SECURITY;
-- No policies: browser clients (anon/authenticated) can't read or write it;
-- the backend uses the service role key.
REVOKE ALL ON publish_operations FROM anon, authenticated;

-- Rollback (if ever needed): DROP TABLE IF EXISTS publish_operations;
