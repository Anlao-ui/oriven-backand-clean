-- ═══════════════════════════════════════════════════════════════════
-- creative_assets + creative_asset_comments (2026-10) — MISSING TABLES
--
-- Problem: both tables are used by the backend (Asset Library, version
-- history, scoring, comments, saved-asset counts, video ownership) and are
-- described in docs/DATABASE.md, but were never created in production
-- (PostgREST: PGRST205 "Could not find the table"). Every generator's
-- _recordCreativeAsset insert has been failing silently, so nothing was
-- saved; GET /api/creative/assets and the comment routes answer 500.
--
-- Columns are exactly the ones server.js / creditManager.js read and write:
--   insert  (_recordCreativeAsset, improve, duplicate): user_id, kind,
--           platform, campaign_name, product_name, title, content,
--           source_route, parent_asset_id, version_label, is_current, status
--   update  (PATCH, restore, score): favorite, archived, status, notes,
--           is_current, scores
--   filter  user_id, kind, platform, product_name, campaign_name,
--           created_at, favorite, status, archived, parent_asset_id,
--           title (ilike), content->>generationId (video ownership)
--
-- Access: every read and write goes through the backend (service role,
-- which bypasses RLS). Browsers get READ of their own rows only — the same
-- shape as profiles after 2026-10-profiles-lockdown.sql — so a signed-in
-- user can't forge, alter or delete library rows through the Supabase API.
--
-- Creates two new tables only; changes no existing table or data. Safe to
-- run more than once.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.creative_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind             text NOT NULL,             -- 'ad' | 'image' | 'video' | 'logo' | 'email' | 'landing_page' | 'deck' | 'poster' | 'infographic' | 'text' | 'improved_text' | 'manual_image' | 'manual_video' | …
  platform         text,
  campaign_name    text,
  product_name     text,
  title            text,
  content          jsonb,                     -- the generated output (url / html / text / package / generationId …)
  source_route     text,
  parent_asset_id  uuid REFERENCES public.creative_assets(id) ON DELETE SET NULL,  -- version history (improve → new version)
  version_label    text,
  is_current       boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'needs_improvement', 'ready', 'approved', 'published', 'rejected')),
  favorite         boolean NOT NULL DEFAULT false,
  archived         boolean NOT NULL DEFAULT false,
  notes            text,
  scores           jsonb,                     -- /api/creative/score
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_assets_user_created_idx ON public.creative_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS creative_assets_parent_idx       ON public.creative_assets (parent_asset_id) WHERE parent_asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.creative_asset_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES public.creative_assets(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_asset_comments_asset_idx ON public.creative_asset_comments (asset_id, created_at);

-- ── RLS: own rows readable, no browser writes ────────────────────────
ALTER TABLE public.creative_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_asset_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creative_assets_select_own ON public.creative_assets;
CREATE POLICY creative_assets_select_own ON public.creative_assets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS creative_asset_comments_select_own ON public.creative_asset_comments;
CREATE POLICY creative_asset_comments_select_own ON public.creative_asset_comments
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON public.creative_assets, public.creative_asset_comments FROM anon, authenticated;
GRANT SELECT ON public.creative_assets, public.creative_asset_comments TO authenticated;
GRANT ALL ON public.creative_assets, public.creative_asset_comments TO service_role;

-- Make the new tables visible to the API immediately.
NOTIFY pgrst, 'reload schema';

-- ── Verify (read-only) ───────────────────────────────────────────────
-- SELECT count(*) FROM public.creative_assets;                     -- 0 on first run
-- SELECT relrowsecurity FROM pg_class WHERE relname IN ('creative_assets','creative_asset_comments');  -- both true
-- SELECT policyname, cmd FROM pg_policies WHERE tablename IN ('creative_assets','creative_asset_comments');
--
-- Rollback (only if nothing has been saved yet that should be kept):
-- DROP TABLE IF EXISTS public.creative_asset_comments; DROP TABLE IF EXISTS public.creative_assets;
