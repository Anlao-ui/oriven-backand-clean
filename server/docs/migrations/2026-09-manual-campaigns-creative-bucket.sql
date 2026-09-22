-- ============================================================================
-- Oriven manual-campaign-creatives storage bucket
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change).
-- Safe to re-run: every statement below is idempotent.
--
-- WHY THIS IS NEEDED: "Add existing campaign" (Campaigns hub, app.html) lets
-- a user manually add an advertisement they already run outside Oriven and
-- upload its real creative (image or short video). The campaign RECORD
-- itself needs no new table — it lives in the exact same client-side
-- localStorage array (`_campaigns[]`, oriven_campaigns_<uid>) every
-- OrivenAI-generated campaign already uses (see app.html's _loadCamps/
-- _saveCamps/_orvStoreCampaign — there is no server-side `campaigns` table
-- anywhere in this codebase; DATABASE.md confirms "marketing data lives on
-- the ad platforms, not in this database"). The ONE thing that genuinely
-- cannot live in localStorage safely is the uploaded creative FILE itself
-- (base64 in localStorage risks the browser's per-origin storage quota),
-- so it needs real Supabase Storage — this bucket is the only new piece of
-- backend infrastructure this feature requires.
--
-- Public-read, matching how every other creative URL already stored on a
-- campaign (AI-generated images via AIML, referenced by plain <img src>
-- URLs) is served today — no auth-gated fetch exists anywhere in this app
-- for creative media. Write access is NOT exposed to the browser: all
-- uploads go through POST /api/manual-campaigns/upload-creative
-- (server.js), which requires a real authenticated user and writes via the
-- service-role client only, under a path prefixed with that user's own id
-- and a random filename (never client-supplied, never guessable) — the
-- same "no RLS, manual server-side ownership scoping" pattern already used
-- for every other table in this database, applied here to Storage.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'manual-campaign-creatives',
  'manual-campaign-creatives',
  true,
  15728640, -- 15MB hard ceiling at the bucket level; the API route enforces
            -- its own tighter limits (8MB image / 12MB video) before this
            -- is ever reached, so this is a backstop, not the real gate.
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read (anyone with the URL can view the creative — same exposure
-- level as every existing AI-generated creative URL already rendered
-- directly in <img>/<video> tags across the app).
drop policy if exists "manual_campaign_creatives_public_read" on storage.objects;
create policy "manual_campaign_creatives_public_read"
  on storage.objects for select
  using (bucket_id = 'manual-campaign-creatives');

-- No insert/update/delete policy for anon/authenticated roles is created
-- here on purpose: every write goes through the backend's service-role
-- client (server.js), which bypasses RLS entirely, exactly like every
-- other write in this database. Leaving these unset means a direct
-- client-side upload attempt (bypassing the API route) is correctly
-- rejected — the only supported write path is the authenticated endpoint.
