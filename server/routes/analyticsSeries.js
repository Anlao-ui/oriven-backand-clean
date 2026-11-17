// ════════════════════════════════════════════════════════════════
// GET /api/analytics/series — daily performance for ONE platform over an
// exact window, for Campaign Overview's metric tiles and Platform
// Comparison (all five platforms the same way).
//
//   ?platform=google|meta|tiktok|pinterest|snapchat
//   &since=YYYY-MM-DD&until=YYYY-MM-DD   (inclusive; at most 400 days, ≤ today)
//   &campaignId=…   one campaign (all five platforms)
//   &adId=…         one ad (Google and Meta; others answer 422 AD_SERIES_UNSUPPORTED)
//
// → { platform, since, until, series: [{ date, spend, impressions, clicks,
//     conversions, conversionValue }], conversionValue: 'reported'|'not_reported',
//     clamped?: { since } }
// conversionValue is null per day when the platform doesn't report a value
// (TikTok, Pinterest, Snapchat here): ROAS is then not computed, never 0.
// Read-only; the same access helpers as the platform overview routes.
// ════════════════════════════════════════════════════════════════
const DAY = 86400000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(s + 'T00:00:00Z') + n * DAY));

function window_(q, now) {
  const today = ymd(now || new Date());
  let until = YMD.test(q.until || '') ? q.until : today;
  if (until > today) until = today;
  let since = YMD.test(q.since || '') ? q.since : addDays(until, -29);
  if (since > until) return { error: 'since is after until' };
  const days = Math.round((Date.parse(until) - Date.parse(since)) / DAY) + 1;
  if (days > 400) since = addDays(until, -399);
  return { since, until };
}
// Fill every day of the window, so charts and period comparisons line up.
function fill(series, since, until, valueReported) {
  const by = {};
  (series || []).forEach((r) => { if (r && r.date) by[String(r.date).slice(0, 10)] = r; });
  const out = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    const r = by[d] || {};
    out.push({ date: d, spend: +r.spend || 0, impressions: +r.impressions || 0, clicks: +r.clicks || 0, conversions: +r.conversions || 0,
      conversionValue: valueReported ? (+r.conversionValue || 0) : null });
  }
  return out;
}

module.exports = function analyticsSeriesRoutes(app, deps) {
  const D = deps;
  app.get('/api/analytics/series', D.requireSubIfAuthed, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const platform = String(req.query.platform || '');
    if (!['google', 'meta', 'tiktok', 'pinterest', 'snapchat'].includes(platform)) return res.status(400).json({ error: 'Choose a platform.', code: 'BAD_PLATFORM' });
    const w = window_(req.query);
    if (w.error) return res.status(400).json({ error: w.error, code: 'BAD_WINDOW' });
    const campaignId = req.query.campaignId ? String(req.query.campaignId) : null;
    const adId = req.query.adId ? String(req.query.adId) : null;
    if (campaignId && !/^[A-Za-z0-9_-]{1,64}$/.test(campaignId)) return res.status(400).json({ error: 'Unknown campaign.', code: 'BAD_ID' });
    if (adId && !/^[A-Za-z0-9_-]{1,64}$/.test(adId)) return res.status(400).json({ error: 'Unknown ad.', code: 'BAD_ID' });
    if (adId && !['google', 'meta'].includes(platform)) return res.status(422).json({ error: 'Daily figures per ad are available for Google Ads and Meta Ads.', code: 'AD_SERIES_UNSUPPORTED' });
    let since = w.since; const until = w.until; let clamped = null;
    try {
      let series = [], valueReported = false;
      if (platform === 'google') {
        const { accessToken, customerId, loginCustomerId } = await D.getGadsAccess(req.user);
        const filter = adId && /^\d+$/.test(adId) ? ` AND ad_group_ad.ad.id = ${Number(adId)}` : campaignId && /^\d+$/.test(campaignId) ? ` AND campaign.id = ${Number(campaignId)}` : '';
        const from = adId ? 'ad_group_ad' : 'campaign';
        const rows = await D.gadsQuery(accessToken, customerId, `
          SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
          FROM ${from}
          WHERE segments.date BETWEEN '${since}' AND '${until}'
            AND campaign.status != 'REMOVED'${filter}`, loginCustomerId);
        const by = {};
        (rows || []).forEach((r) => {
          const d = r.segments && r.segments.date; if (!d) return; const m = r.metrics || {};
          const b = by[d] = by[d] || { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
          b.spend += Number(m.costMicros || 0) / 1e6; b.impressions += Number(m.impressions || 0); b.clicks += Number(m.clicks || 0);
          b.conversions += Number(m.conversions || 0); b.conversionValue += Number(m.conversionsValue || 0);
        });
        series = Object.values(by); valueReported = true;
      } else if (platform === 'meta') {
        const { accessToken, accountId } = await D.getMetaAccess(req.user);
        const target = adId || campaignId || accountId;
        const data = await D.metaFetch('/' + target + '/insights', accessToken, { time_range: JSON.stringify({ since, until }), time_increment: '1', fields: 'spend,impressions,clicks,actions,action_values', limit: '500' });
        series = (data && data.data || []).map((r) => ({ date: r.date_start, spend: parseFloat(r.spend || 0), impressions: parseInt(r.impressions || 0, 10), clicks: parseInt(r.clicks || 0, 10),
          conversions: D.metaConversions(r.actions), conversionValue: D.metaPurchaseValue(r.action_values) }));
        valueReported = true;
      } else if (platform === 'tiktok') {
        const { accessToken, advertiserId } = await D.getTikTokAccess(req.user);
        const params = { advertiser_id: advertiserId, report_type: 'BASIC', dimensions: JSON.stringify(['stat_time_day']), metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']),
          data_level: campaignId ? 'AUCTION_CAMPAIGN' : 'AUCTION_ADVERTISER', start_date: since, end_date: until, page_size: '1000' };
        if (campaignId) params.filtering = JSON.stringify([{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify([campaignId]) }]);
        // TikTok reports at most 30 days per request: read the window in pieces.
        for (let s = since; s <= until; s = addDays(s, 30)) {
          const e = addDays(s, 29) < until ? addDays(s, 29) : until;
          const data = await D.tiktokFetch('/report/integrated/get/', accessToken, Object.assign({}, params, { start_date: s, end_date: e }));
          ((data && data.list) || []).forEach((row) => {
            const d = String((row.dimensions || {}).stat_time_day || '').slice(0, 10); const m = row.metrics || {};
            if (d) series.push({ date: d, spend: parseFloat(m.spend || 0), impressions: parseInt(m.impressions || 0, 10), clicks: parseInt(m.clicks || 0, 10), conversions: parseFloat(m.conversion || 0) });
          });
        }
      } else if (platform === 'pinterest') {
        const { accessToken, adAccountId } = await D.getPinterestAccess(req.user);
        // Pinterest analytics: at most 90 days back.
        const min = addDays(until, -89);
        if (since < min) { clamped = { since: min, wanted: since }; since = min; }
        let ids = campaignId ? [campaignId] : null;
        if (!ids) { const c = await D.pinterestApiRequest(accessToken, 'GET', '/ad_accounts/' + adAccountId + '/campaigns?page_size=100'); ids = (c.items || []).map((x) => String(x.id)); }
        if (ids.length) {
          const qs = new URLSearchParams({ start_date: since, end_date: until, campaign_ids: ids.join(','), columns: 'SPEND_IN_DOLLAR,TOTAL_IMPRESSION,TOTAL_CLICKTHROUGH,TOTAL_CONVERSIONS', granularity: 'DAY' });
          const data = await D.pinterestApiRequest(accessToken, 'GET', '/ad_accounts/' + adAccountId + '/campaigns/analytics?' + qs.toString());
          const by = {};
          (Array.isArray(data) ? data : (data.items || [])).forEach((row) => {
            const d = row.date || (row.metrics && row.metrics.DATE); if (!d) return; const r = row.metrics || row;
            const b = by[d] = by[d] || { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
            b.spend += Number(r.SPEND_IN_DOLLAR || 0); b.impressions += Number(r.TOTAL_IMPRESSION || 0); b.clicks += Number(r.TOTAL_CLICKTHROUGH || 0); b.conversions += Number(r.TOTAL_CONVERSIONS || 0);
          });
          series = Object.values(by);
        }
      } else if (platform === 'snapchat') {
        const a = await D.getSnapchatAccess(req.user);
        const min = addDays(until, -89);
        if (since < min) { clamped = { since: min, wanted: since }; since = min; }
        const account = { id: a.adAccountId, timezone: a.timezone };
        const client = D.snapClient(a);
        let ids = campaignId ? [campaignId] : null;
        if (!ids) ids = (await client.call((t) => D.SNAP.listAll(t, '/adaccounts/' + encodeURIComponent(a.adAccountId) + '/campaigns', 'campaigns', 'campaign'))).filter((c) => c.status !== 'DELETED').map((c) => String(c.id));
        if (ids.length) series = await client.call((t) => D.SNAP.dailySeries(t, account, since, until, ids));
      }
      res.set('Cache-Control', 'private, max-age=300');
      res.json({ platform, since, until, series: fill(series, since, until, valueReported), conversionValue: valueReported ? 'reported' : 'not_reported', clamped });
    } catch (err) {
      const status = err && (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 409) ? err.status : 502;
      console.warn('[analytics/series]', platform, err && (err.code || err.message));
      res.status(status).json({ error: status === 502 ? 'The ad platform didn’t return figures right now. Try again in a moment.' : (err.message || 'Not connected.'), code: err.code || (status === 502 ? 'PLATFORM_UNAVAILABLE' : 'NOT_CONNECTED') });
    }
  });
};
module.exports._window = window_;
module.exports._fill = fill;
