-- ============================================================================
-- Durable campaigns table — PREPARED, NOT YET APPLIED (Task 3 Part 2)
--
-- Run this once, by hand, via the Supabase Dashboard → SQL Editor (no
-- migration tooling in this repo — same convention as every other file in
-- this folder). This environment has SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
-- only (verified again this pass) — no DATABASE_URL, no Management API
-- token, no psql, no Supabase CLI — so there is no mechanism here that can
-- execute DDL against the real project. A human must run this file.
--
-- STATUS (Part 2 update): the backend routes and frontend wiring THAT WILL
-- USE this table have now been built (server.js `/api/campaigns/*`, the
-- Launch publish success handlers, the localStorage migration path). All of
-- that code is correct and ready, but every one of those code paths will
-- fail closed (real PGRST205, handled the same honest way the existing
-- autopilot_recommendations routes already handle it) until this migration
-- is actually run. This is the same "ship the code, run the SQL by hand
-- when ready" pattern already proven in this codebase (automation_rules
-- worked exactly this way between its own migration being written and run).
--
-- ROOT CAUSE THIS ADDRESSES (confirmed via a Task 3 audit, not assumed):
-- OrivenAI has NO durable server-side representation of a campaign anywhere.
-- docs/DATABASE.md already documented this as a deliberate historical
-- decision ("marketing data lives on the ad platforms, not in this
-- database"), and a live audit of the current codebase confirms it is still
-- true: zero `supabaseAdmin.from('campaign...')`-style calls exist in
-- server.js. Every campaign — AI-generated drafts, campaigns published
-- through Launch (including the real external platform IDs Meta/Google/
-- TikTok/Pinterest return), and manually-added existing campaigns — lives
-- ONLY in browser localStorage (key `oriven_campaigns_<uid>`, written by
-- `window._orvStoreCampaign` in app.html). This means: a user switching
-- devices or browsers loses every campaign record OrivenAI knows about,
-- even though the real ad platform still has the real campaign. The
-- Campaigns page's own analytics view is NOT affected by this gap — it
-- already fetches live campaign lists/metrics directly from each platform's
-- API on every load (confirmed via the same audit), so this table is about
-- OrivenAI's own workflow memory (drafts, "what did I generate", "what did
-- I manually track"), not about replacing the platform as the source of
-- truth for live campaign state — consistent with this project's own
-- stated principle (see ARCHITECTURE.md / SETUP_ENGINE.md: "the ad
-- platform remains authoritative for platform-owned live state").
--
-- DESIGN NOTES
-- - `source` distinguishes how OrivenAI came to know about this campaign:
--   'oriven_generated' (created via Create, not yet published),
--   'platform_imported' (fetched from a connected account — no import
--   sync route exists yet, this value is reserved for when one does),
--   'manual' (the existing "Add existing campaign" flow).
-- - `external_campaign_id`/`external_ad_set_ids`/`external_ad_ids` hold the
--   REAL platform-returned identifiers once a campaign is published or
--   manually recorded — never invented, matching the existing
--   /api/publish/:platform routes' own real response shape
--   (created.campaignId / created.adSetIds / created.adIds, confirmed
--   present in the Meta/Google/TikTok/Pinterest publish handlers).
-- - `package` is a single jsonb column holding the full campaign object as
--   it already exists in the frontend's localStorage array today (prompt,
--   goal, structure, creative variants, manual-entry sub-object, etc.) —
--   deliberately NOT force-decomposed into dozens of narrow columns for
--   this first pass, since the real shape is large, still evolving with
--   Create/Launch, and a lossy re-normalization risks silently dropping
--   fields a future UI change depends on. First-class columns below are
--   only the fields that need to be indexed/queried/deduplicated on
--   (status, platform, source, budget, external IDs) — everything else
--   stays inside `package`, readable as-is by a future backend route.
-- - UNIQUE (user_id, platform, external_account_id, external_campaign_id):
--   Part 2 correction — the original draft of this migration keyed
--   uniqueness on (user_id, platform, external_campaign_id) alone, WITHOUT
--   external_account_id. Platform campaign IDs are commonly scoped to a
--   single advertiser/ad account, not globally unique across a platform —
--   a user with two connected Google Ads accounts could plausibly see
--   campaign id "12345" under both. The original constraint could have
--   silently merged two unrelated campaigns from different accounts that
--   happen to share a numeric ID. Fixed before any code was wired against
--   it. Postgres treats NULLs as distinct in a UNIQUE constraint, so any
--   number of drafts (no external_campaign_id yet) can still coexist per
--   user/platform/account — only rows that share BOTH a real account id and
--   a real campaign id are prevented from duplicating.
-- - client_ref_id (Part 2 addition): the campaign's own client-generated id
--   from the existing localStorage record (the same `id` field
--   window._orvStoreCampaign already assigns every campaign, draft or
--   published). This is the idempotency key the localStorage→server
--   migration route upserts on — necessary because drafts/manual entries
--   have no external_campaign_id at all, so the platform-uniqueness
--   constraint above cannot deduplicate them; without a client-side key,
--   re-running the migration would insert a fresh duplicate row for every
--   draft on every run.
-- - No FK from `platform`/`external_account_id` to `integrations` — same
--   "soft reference, not a hard FK" philosophy DATABASE.md already
--   documents for campaign-adjacent cross-references elsewhere in this
--   schema (an integration can be disconnected/reconnected independently
--   of campaign history).
--
-- Safe to re-run: every statement is guarded (IF NOT EXISTS / idempotent
-- REVOKE-GRANT / DROP POLICY IF EXISTS before CREATE POLICY).
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES profiles(id) NOT NULL,
  client_ref_id          text,              -- the localStorage record's own id — idempotency key for the migration route (see design notes)
  source                 text NOT NULL,     -- 'oriven_generated' | 'platform_imported' | 'manual'
  platform               text,              -- 'google' | 'meta' | 'tiktok' | 'pinterest' | null (manual/unsupported provider)
  external_account_id    text,              -- the connected ad account this campaign belongs to, if any
  external_campaign_id   text,              -- the platform's own campaign id, once launched/imported/recorded
  external_ad_set_ids    jsonb,             -- array of platform ad set / ad group ids
  external_ad_ids        jsonb,             -- array of platform ad ids
  name                   text NOT NULL,
  objective              text,              -- normalized OrivenAI goal (Sales/Leads/Traffic/Awareness) or platform-native objective
  status                 text NOT NULL DEFAULT 'draft',  -- draft | ready | published | paused | active | archived | failed
  budget_amount          numeric,
  budget_currency        text,
  package                jsonb,             -- the full campaign object (creative, structure, manual-entry details, etc.) — see design notes
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  synced_at              timestamptz,       -- last time this row's platform-owned fields were refreshed from the provider (null until a sync route exists)
  UNIQUE (user_id, platform, external_account_id, external_campaign_id),
  UNIQUE (user_id, client_ref_id)
);
CREATE INDEX IF NOT EXISTS campaigns_user_idx ON campaigns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns(user_id, status);
CREATE INDEX IF NOT EXISTS campaigns_source_idx ON campaigns(user_id, source);
CREATE INDEX IF NOT EXISTS campaigns_platform_idx ON campaigns(user_id, platform);

-- ── RLS — real per-user isolation, not just app-layer filtering ───────────
-- Same reasoning/shape as automation_rules and autopilot_* (sibling
-- migrations): every future route should use supabaseAdmin (service_role,
-- bypasses RLS), so these policies are a defense-in-depth boundary, not a
-- behavior change — but every future route MUST still explicitly filter by
-- user_id, exactly like every other table in this schema (no RLS-based
-- enforcement exists anywhere in this codebase's actual query layer).
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaigns_select_own ON campaigns;
CREATE POLICY campaigns_select_own ON campaigns
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS campaigns_insert_own ON campaigns;
CREATE POLICY campaigns_insert_own ON campaigns
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS campaigns_update_own ON campaigns;
CREATE POLICY campaigns_update_own ON campaigns
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS campaigns_delete_own ON campaigns;
CREATE POLICY campaigns_delete_own ON campaigns
  FOR DELETE USING (auth.uid() = user_id);

GRANT ALL ON campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns TO authenticated;
REVOKE ALL ON campaigns FROM anon;

-- ── After running the block above, verify from this repo with: ────────────
--   cd server && node -e "require('dotenv').config({path:'../.env'});
--     const {createClient}=require('@supabase/supabase-js');
--     const sb=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
--     sb.from('campaigns').select('id').limit(1).then(r=>console.log(r.error||'OK, table reachable'));"
--
-- ── Part 2 status: code is built, waiting on this migration ───────────────
-- server.js now has /api/campaigns/* (list/get/draft/manual/update/archive),
-- /api/campaigns/sync/:platform (import/sync for all 4 platforms), and
-- /api/campaigns/migrate-local (the localStorage migration endpoint).
-- app.html's Launch publish success handlers now also call the durable
-- persist endpoint (dual-write alongside the existing localStorage write —
-- localStorage is not removed by this pass; see the migration route's own
-- comments for why). Until this SQL is run, every one of those routes
-- returns a clear DB_UNAVAILABLE error (same honest pattern the existing
-- autopilot_recommendations routes already use) rather than silently
-- failing or fabricating success.
-- ============================================================================
