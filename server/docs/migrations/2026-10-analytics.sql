-- ═══════════════════════════════════════════════════════════════════
-- Analytics, attribution and conversion events (2026-10)
-- services/analytics.js · services/onboarding.js · services/stripeBilling.js
--
-- Additive only: new columns, one new table, indexes and a read-only
-- aggregate function. No existing row is changed or deleted. Safe to run
-- more than once. The backend works before this runs (every write tolerates
-- the missing columns/table), so it can be applied before or after deploy.
-- ═══════════════════════════════════════════════════════════════════

-- 1. First-touch attribution on the profile (written once, at signup, by the
--    backend; never overwritten) + when the email was verified.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_channel        text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_source         text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_medium         text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_campaign       text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_referrer_host  text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_landing_path   text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS acq_first_seen_at  timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email_verified_at  timestamptz;
CREATE INDEX IF NOT EXISTS profiles_created_at_idx ON public.profiles (created_at);

-- 2. One-time conversion events are unique per user, so a retry, a second
--    tab or a replayed webhook can never count a conversion twice.
--    (If this fails because of existing duplicates, remove the extra rows of
--    those event names first — there were none when this was written.)
CREATE UNIQUE INDEX IF NOT EXISTS events_once_per_user_idx ON public.events (user_id, event_name)
  WHERE user_id IS NOT NULL AND event_name IN (
    'signup_completed', 'email_verified', 'onboarding_completed', 'first_ad_started',
    'first_create_success', 'first_research_success', 'free_first_ad_succeeded', 'first_paid_subscription');
CREATE INDEX IF NOT EXISTS events_created_idx ON public.events (created_at);

-- 3. Cookieless site page views. No IP address, cookie, user id or full
--    referrer URL is stored: only the path, a coarse channel, UTM values,
--    the referrer host and a visitor hash that rotates every UTC day.
CREATE TABLE IF NOT EXISTS public.site_pageviews (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL DEFAULT 'pageview' CHECK (kind IN ('pageview', 'signup_started')),
  path          text NOT NULL CHECK (char_length(path) <= 200),
  entry         boolean NOT NULL DEFAULT false,
  channel       text NOT NULL DEFAULT 'direct' CHECK (char_length(channel) <= 40),
  source        text CHECK (char_length(source) <= 80),
  medium        text CHECK (char_length(medium) <= 60),
  campaign      text CHECK (char_length(campaign) <= 100),
  referrer_host text CHECK (char_length(referrer_host) <= 100),
  visitor_hash  text NOT NULL CHECK (char_length(visitor_hash) <= 32)
);
CREATE INDEX IF NOT EXISTS site_pageviews_created_idx ON public.site_pageviews (created_at);
ALTER TABLE public.site_pageviews ENABLE ROW LEVEL SECURITY;      -- service role only
REVOKE ALL ON TABLE public.site_pageviews FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.site_pageviews_id_seq FROM anon, authenticated;

-- 4. Aggregates for the owner dashboard, computed in the database (never
--    row-level data). Visitors = sum over days of distinct daily hashes
--    (a person visiting on two days counts twice — an estimate by design).
CREATE OR REPLACE FUNCTION public.analytics_site_summary(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH v AS (
    SELECT * FROM public.site_pageviews WHERE created_at >= p_from AND created_at <= p_to
  ), pv AS (SELECT * FROM v WHERE kind = 'pageview'),
  daily AS (
    SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           count(*) AS pageviews, count(DISTINCT visitor_hash) AS visitors
    FROM pv GROUP BY 1
  )
  SELECT jsonb_build_object(
    'pageviews',   (SELECT count(*) FROM pv),
    'visitors',    (SELECT coalesce(sum(visitors), 0) FROM daily),
    'entries',     (SELECT count(*) FROM pv WHERE entry),
    'signupStarts',(SELECT count(*) FROM v WHERE kind = 'signup_started'),
    'signupStartVisitors', (SELECT count(DISTINCT visitor_hash || to_char(created_at, 'YYYY-MM-DD')) FROM v WHERE kind = 'signup_started'),
    'daily',       (SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'pageviews', pageviews, 'visitors', visitors) ORDER BY day), '[]'::jsonb) FROM daily),
    'channels',    (SELECT coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'entries', n, 'visitors', u) ORDER BY n DESC), '[]'::jsonb)
                    FROM (SELECT channel, count(*) n, count(DISTINCT visitor_hash || to_char(created_at, 'YYYY-MM-DD')) u FROM pv WHERE entry GROUP BY channel) c),
    'landingPages',(SELECT coalesce(jsonb_agg(jsonb_build_object('path', path, 'entries', n) ORDER BY n DESC), '[]'::jsonb)
                    FROM (SELECT path, count(*) n FROM pv WHERE entry GROUP BY path ORDER BY n DESC LIMIT 15) l),
    'topPages',    (SELECT coalesce(jsonb_agg(jsonb_build_object('path', path, 'pageviews', n) ORDER BY n DESC), '[]'::jsonb)
                    FROM (SELECT path, count(*) n FROM pv GROUP BY path ORDER BY n DESC LIMIT 15) t),
    'referrers',   (SELECT coalesce(jsonb_agg(jsonb_build_object('host', referrer_host, 'entries', n) ORDER BY n DESC), '[]'::jsonb)
                    FROM (SELECT referrer_host, count(*) n FROM pv WHERE entry AND referrer_host IS NOT NULL GROUP BY referrer_host ORDER BY n DESC LIMIT 15) r),
    'campaigns',   (SELECT coalesce(jsonb_agg(jsonb_build_object('source', source, 'medium', medium, 'campaign', campaign, 'entries', n) ORDER BY n DESC), '[]'::jsonb)
                    FROM (SELECT source, medium, campaign, count(*) n FROM pv WHERE entry AND source IS NOT NULL GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 15) cmp)
  );
$$;
REVOKE ALL ON FUNCTION public.analytics_site_summary(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_site_summary(timestamptz, timestamptz) TO service_role;

-- 5. Retention: raw page views are kept for 13 months (the backend's nightly
--    job deletes older rows; aggregates you export before then are yours).
