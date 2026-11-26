// ════════════════════════════════════════════════════════════════
// GET /api/analytics/extras — the platform's own metrics for ONE platform
// over a window, as period totals (Performance Overview → "Platform metrics").
//
//   ?platform=google|meta|tiktok|pinterest|snapchat
//   &since=YYYY-MM-DD&until=YYYY-MM-DD   (same window rules as /api/analytics/series)
//   &campaignId=…                        optional: one campaign
//
// → { platform, since, until, fetchedAt, clamped?,
//     metrics: { key: number|null },   number = reported by the platform (0 is a real 0)
//     notReported: { key: reason } }   this platform/endpoint doesn't give it
//   or { …, metrics: {}, error: { code, message } } when the platform refused
//   the request — the core figures (/api/analytics/series) are a separate call
//   and are never affected by this one.
//
// Period totals, not daily sums: reach and frequency are de-duplicated by the
// platform over the window and can't be added up day by day.
// Read-only; the same access helpers as the other analytics routes.
//
// Field names: Meta Insights (reach, frequency, inline_link_clicks, actions /
// action_values incl. landing_page_view, video_view, post_engagement,
// video_thruplay_watched_actions, video_p100_watched_actions); Google Ads
// GAQL (metrics.interactions, metrics.engagements,
// metrics.view_through_conversions); TikTok reporting (reach, frequency,
// video_play_actions, video_watched_2s, video_views_p100, likes, comments,
// shares, follows, profile_visits); Pinterest ads analytics columns
// (TOTAL_IMPRESSION_USER, TOTAL_ENGAGEMENT, TOTAL_VIDEO_3SEC_VIEWS,
// TOTAL_VIDEO_P100_COMPLETE, TOTAL_CHECKOUT,
// TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR); Snap stats (video_views, quartile_1-3,
// view_completion, swipes). None of these has been read from a live account
// by OrivenAI yet — a refused field shows as "not available", never as 0.
// ════════════════════════════════════════════════════════════════
const series = require('./analyticsSeries');

// What each platform gives here (everything else is "not reported").
const PROVIDES = {
  meta: ['reach', 'frequency', 'linkClicks', 'landingPageViews', 'videoViews', 'thruPlays', 'videoCompletions', 'postEngagements', 'purchases', 'purchaseValue'],
  google: ['interactions', 'engagements', 'viewThroughConversions'],
  tiktok: ['reach', 'frequency', 'videoViews', 'videoViews2s', 'videoCompletions', 'likes', 'comments', 'shares', 'follows', 'profileVisits'],
  pinterest: ['reach', 'engagements', 'videoViews', 'videoCompletions', 'checkouts', 'checkoutValue'],
  snapchat: ['videoViews', 'videoQ25', 'videoQ50', 'videoQ75', 'videoCompletions', 'swipeUps'],
};
const ALL = Array.from(new Set([].concat.apply([], Object.values(PROVIDES))));
const META_PURCHASE = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }; // unknown stays unknown (Number(null) would be 0)
function sumActions(list, types) {
  if (!Array.isArray(list)) return 0; // Meta leaves out action types with no occurrences
  const set = new Set(types);
  return list.filter((a) => a && set.has(a.action_type)).reduce((s, a) => s + (num(a.value) || 0), 0);
}
// Shape the answer: every provided key a number (or null when the platform left it out), the rest "not reported".
function shape(platform, raw) {
  const metrics = {}, notReported = {};
  for (const k of ALL) {
    if (PROVIDES[platform].includes(k)) metrics[k] = raw[k] == null ? null : raw[k];
    else notReported[k] = 'not_reported_by_platform';
  }
  return { metrics, notReported };
}

function readMeta(row) {
  const r = row || {};
  return {
    reach: num(r.reach), frequency: num(r.frequency), linkClicks: num(r.inline_link_clicks),
    landingPageViews: sumActions(r.actions, ['landing_page_view', 'omni_landing_page_view']),
    videoViews: sumActions(r.actions, ['video_view']),
    thruPlays: sumActions(r.video_thruplay_watched_actions, ['video_view']),
    videoCompletions: sumActions(r.video_p100_watched_actions, ['video_view']),
    postEngagements: sumActions(r.actions, ['post_engagement']),
    purchases: sumActions(r.actions, META_PURCHASE),
    purchaseValue: sumActions(r.action_values, META_PURCHASE),
  };
}
function readGoogle(rows) {
  const t = { interactions: 0, engagements: 0, viewThroughConversions: 0 };
  (rows || []).forEach((x) => { const m = x.metrics || {}; t.interactions += num(m.interactions) || 0; t.engagements += num(m.engagements) || 0; t.viewThroughConversions += num(m.viewThroughConversions) || 0; });
  return t;
}
function readTikTok(list) {
  const m = ((list || [])[0] || {}).metrics || {};
  const n = (k) => (m[k] == null ? null : num(m[k]));
  return { reach: n('reach'), frequency: n('frequency'), videoViews: n('video_play_actions'), videoViews2s: n('video_watched_2s'), videoCompletions: n('video_views_p100'),
    likes: n('likes'), comments: n('comments'), shares: n('shares'), follows: n('follows'), profileVisits: n('profile_visits') };
}
function readPinterest(data) {
  const rows = Array.isArray(data) ? data : (data && (data.items || [data])) || [];
  const t = {}; const keys = { reach: 'TOTAL_IMPRESSION_USER', engagements: 'TOTAL_ENGAGEMENT', videoViews: 'TOTAL_VIDEO_3SEC_VIEWS', videoCompletions: 'TOTAL_VIDEO_P100_COMPLETE', checkouts: 'TOTAL_CHECKOUT', checkoutValue: 'TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR' };
  for (const [k, col] of Object.entries(keys)) {
    let seen = false, s = 0;
    rows.forEach((row) => { const r = (row && row.metrics) || row || {}; if (r[col] != null) { seen = true; s += num(r[col]) || 0; } });
    t[k] = seen ? (k === 'checkoutValue' ? s / 1e6 : s) : null;
  }
  // Reach is de-duplicated per row: only meaningful for one row (the account, or one campaign).
  if (rows.length > 1) t.reach = null;
  return t;
}
const SNAP_FIELDS = 'video_views,quartile_1,quartile_2,quartile_3,view_completion,swipes';
function readSnap(j) {
  const t = { videoViews: 0, videoQ25: 0, videoQ50: 0, videoQ75: 0, videoCompletions: 0, swipeUps: 0 };
  let seen = false;
  for (const ts of (j && j.total_stats) || []) {
    const s = (ts && ts.total_stat && ts.total_stat.stats) || null; if (!s) continue; seen = true;
    t.videoViews += num(s.video_views) || 0; t.videoQ25 += num(s.quartile_1) || 0; t.videoQ50 += num(s.quartile_2) || 0; t.videoQ75 += num(s.quartile_3) || 0;
    t.videoCompletions += num(s.view_completion) || 0; t.swipeUps += num(s.swipes) || 0;
  }
  return seen ? t : {};
}

module.exports = function analyticsExtrasRoutes(app, deps) {
  const D = deps;
  app.get('/api/analytics/extras', D.requireSubIfAuthed, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const platform = String(req.query.platform || '');
    if (!PROVIDES[platform]) return res.status(400).json({ error: 'Choose a platform.', code: 'BAD_PLATFORM' });
    const w = series._window(req.query);
    if (w.error) return res.status(400).json({ error: w.error, code: 'BAD_WINDOW' });
    const campaignId = req.query.campaignId ? String(req.query.campaignId) : null;
    if (campaignId && !/^[A-Za-z0-9_-]{1,64}$/.test(campaignId)) return res.status(400).json({ error: 'Unknown campaign.', code: 'BAD_ID' });
    let since = w.since; const until = w.until; let clamped = null;
    const base = () => ({ platform, since, until, fetchedAt: new Date().toISOString(), clamped });
    let access;
    try {
      access = platform === 'google' ? await D.getGadsAccess(req.user) : platform === 'meta' ? await D.getMetaAccess(req.user)
        : platform === 'tiktok' ? await D.getTikTokAccess(req.user) : platform === 'pinterest' ? await D.getPinterestAccess(req.user) : await D.getSnapchatAccess(req.user);
    } catch (err) {
      const status = err && [401, 403, 404, 409].includes(err.status) ? err.status : 502;
      return res.status(status).json({ error: err.message || 'Not connected.', code: err.code || 'NOT_CONNECTED' });
    }
    try {
      let raw = {};
      if (platform === 'meta') {
        const target = campaignId || access.accountId;
        const data = await D.metaFetch('/' + target + '/insights', access.accessToken, { time_range: JSON.stringify({ since, until }), fields: 'reach,frequency,inline_link_clicks,actions,action_values,video_thruplay_watched_actions,video_p100_watched_actions', limit: '5' });
        const row = data && data.data && data.data[0];
        raw = row ? readMeta(row) : readMeta({ reach: 0, frequency: null, inline_link_clicks: 0, actions: [], action_values: [] });
      } else if (platform === 'google') {
        const filter = campaignId && /^\d+$/.test(campaignId) ? ` AND campaign.id = ${Number(campaignId)}` : '';
        const rows = await D.gadsQuery(access.accessToken, access.customerId, `
          SELECT metrics.interactions, metrics.engagements, metrics.view_through_conversions
          FROM campaign
          WHERE segments.date BETWEEN '${since}' AND '${until}'
            AND campaign.status != 'REMOVED'${filter}`, access.loginCustomerId);
        raw = readGoogle(rows);
      } else if (platform === 'tiktok') {
        const params = { advertiser_id: access.advertiserId, report_type: 'BASIC', data_level: campaignId ? 'AUCTION_CAMPAIGN' : 'AUCTION_ADVERTISER',
          dimensions: JSON.stringify([campaignId ? 'campaign_id' : 'advertiser_id']), start_date: since, end_date: until, page_size: '10',
          metrics: JSON.stringify(['reach', 'frequency', 'video_play_actions', 'video_watched_2s', 'video_views_p100', 'likes', 'comments', 'shares', 'follows', 'profile_visits']) };
        if (campaignId) params.filtering = JSON.stringify([{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify([campaignId]) }]);
        const data = await D.tiktokFetch('/report/integrated/get/', access.accessToken, params);
        raw = readTikTok(data && data.list);
      } else if (platform === 'pinterest') {
        const floor = new Date(Date.parse(until + 'T00:00:00Z') - 89 * 86400000).toISOString().slice(0, 10);
        if (since < floor) { clamped = { since: floor, wanted: since }; since = floor; }
        const cols = 'TOTAL_IMPRESSION_USER,TOTAL_ENGAGEMENT,TOTAL_VIDEO_3SEC_VIEWS,TOTAL_VIDEO_P100_COMPLETE,TOTAL_CHECKOUT,TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR';
        const qs = new URLSearchParams({ start_date: since, end_date: until, columns: cols, granularity: 'TOTAL' });
        if (campaignId) qs.set('campaign_ids', campaignId);
        const path = '/ad_accounts/' + access.adAccountId + (campaignId ? '/campaigns/analytics?' : '/analytics?') + qs.toString();
        raw = readPinterest(await D.pinterestApiRequest(access.accessToken, 'GET', path));
      } else if (platform === 'snapchat') {
        const floor = new Date(Date.parse(until + 'T00:00:00Z') - 89 * 86400000).toISOString().slice(0, 10);
        if (since < floor) { clamped = { since: floor, wanted: since }; since = floor; }
        const tz = access.timezone || 'UTC';
        const q = new URLSearchParams({ granularity: 'TOTAL', fields: SNAP_FIELDS, start_time: D.SNAP.zonedMidnight(since, tz), end_time: D.SNAP.zonedMidnight(D.SNAP.addDays(until, 1), tz) });
        const path = (campaignId ? '/campaigns/' + encodeURIComponent(campaignId) : '/adaccounts/' + encodeURIComponent(access.adAccountId)) + '/stats?' + q.toString();
        raw = readSnap(await D.snapClient(access).call((t) => D.SNAP.request(t, 'GET', path)));
      }
      res.set('Cache-Control', 'private, max-age=300');
      res.json(Object.assign(base(), shape(platform, raw)));
    } catch (err) {
      console.warn('[analytics/extras]', platform, err && (err.code || err.message));
      res.json(Object.assign(base(), { metrics: {}, notReported: {}, error: { code: 'EXTRAS_UNAVAILABLE', message: 'The ad platform didn’t return these metrics right now. The main figures above are unaffected.' } }));
    }
  });
};
module.exports.PROVIDES = PROVIDES;
module.exports._read = { meta: readMeta, google: readGoogle, tiktok: readTikTok, pinterest: readPinterest, snapchat: readSnap, shape };
