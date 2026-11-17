// ════════════════════════════════════════════════════════════════
// GET /api/analytics/series — daily figures per platform over an exact
// window (Campaign Overview tiles, Platform Comparison). The REAL server.js
// with Supabase and the platform APIs mocked (tests/helpers/mockServer.js):
// Meta, TikTok, Pinterest and Snapchat answered here, every other host blocked.
// No network, no real accounts.
// RUN: node tests/analytics-series.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5671, env: { SNAPCHAT_CLIENT_ID: 'snap-client-id', SNAPCHAT_CLIENT_SECRET: 'snap-secret-value' } });
const { check, log, done } = reporter();
const R = require(path.join(H.SERVER_DIR, 'routes', 'analyticsSeries'));
const U = { id: '00000000-0000-4000-8000-0000000a5e71', email: 'series@example.invalid' };
const TOK = 'tok_series';
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
const today = new Date().toISOString().slice(0, 10);
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const seen = [];

H.net.handler = async (url) => {
  const u = new URL(url); seen.push(u.host + u.pathname + '?' + u.search.slice(1));
  if (u.host === 'graph.facebook.com') {
    const tr = JSON.parse(u.searchParams.get('time_range') || '{}');
    if (!/\/insights$/.test(u.pathname)) return json({ data: [] });
    return json({ data: [
      { date_start: tr.since, spend: '10.50', impressions: '1000', clicks: '40', actions: [{ action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'purchase', value: '84.00' }] },
      { date_start: addDays(tr.since, 2), spend: '5', impressions: '500', clicks: '10', actions: [], action_values: [] },
    ] });
  }
  if (u.host === 'business-api.tiktok.com') {
    const s = u.searchParams.get('start_date');
    return json({ code: 0, data: { list: [{ dimensions: { stat_time_day: s + ' 00:00:00' }, metrics: { spend: '7.25', impressions: '900', clicks: '30', conversion: '3' } }] } });
  }
  if (u.host === 'api.pinterest.com') {
    if (/\/campaigns$/.test(u.pathname)) return json({ items: [{ id: 'pc1' }, { id: 'pc2' }] });
    const s = u.searchParams.get('start_date');
    return json([{ DATE: s, SPEND_IN_DOLLAR: 3, TOTAL_IMPRESSION: 300, TOTAL_CLICKTHROUGH: 9, TOTAL_CONVERSIONS: 1 }, { DATE: s, SPEND_IN_DOLLAR: 1, TOTAL_IMPRESSION: 100, TOTAL_CLICKTHROUGH: 1, TOTAL_CONVERSIONS: 0 }].map((r) => ({ date: r.DATE, metrics: r })));
  }
  if (u.host === 'adsapi.snapchat.com') {
    if (/\/adaccounts\/[^/]+\/campaigns$/.test(u.pathname)) return json({ request_status: 'SUCCESS', campaigns: [{ campaign: { id: 'sc1', status: 'ACTIVE' } }, { campaign: { id: 'sc2', status: 'DELETED' } }] });
    if (/\/campaigns\/sc1\/stats$/.test(u.pathname)) {
      const start = String(u.searchParams.get('start_time') || '').slice(0, 10);
      return json({ request_status: 'SUCCESS', timeseries_stats: [{ timeseries_stat: { timeseries: [{ start_time: start + 'T00:00:00.000-00:00', stats: { spend: 4200000, impressions: 800, swipes: 25 } }] } }] });
    }
  }
  return null;
};

(async () => {
  const quiet = await H.start();
  H.TOKENS[TOK] = U;
  H.rows('profiles').push({ id: U.id, email: U.email, subscription_status: 'paid', access_plan: 'monthly', access_expires_at: new Date(Date.now() + 9 * 864e5).toISOString() });
  const future = new Date(Date.now() + 864e5).toISOString();
  const t = H.rows('integrations');
  t.push({ user_id: U.id, provider: 'meta_ads', access_token: 'meta-mock', token_expiry: future, active_ad_account: { account_id: '111', account_name: 'Shop Meta', currency: 'EUR' } });
  t.push({ user_id: U.id, provider: 'tiktok_ads', access_token: 'tt-mock', refresh_token: 'tt-r', token_expiry: future, active_ad_account: { account_id: '7001', account_name: 'Shop TikTok' } });
  t.push({ user_id: U.id, provider: 'pinterest_ads', access_token: 'pin-mock', refresh_token: 'pin-r', token_expiry: future, active_ad_account: { account_id: 'pa1', account_name: 'Shop Pins' } });
  t.push({ user_id: U.id, provider: 'snapchat_ads', access_token: 'snap-mock', refresh_token: 'snap-r', token_expiry: future, active_ad_account: { account_id: '11111111-1111-4111-8111-111111111111', account_name: 'Shop Snap', currency: 'EUR', timezone: 'Europe/Amsterdam' } });
  const get = (qs) => H.call('GET', '/api/analytics/series?' + qs, TOK);

  log('\nA. Window rules (pure)');
  check('A1. default: the last 30 days up to today', JSON.stringify(R._window({}, new Date(today + 'T12:00:00Z'))) === JSON.stringify({ since: addDays(today, -29), until: today }));
  check('A2. a future until is cut to today; > 400 days is cut to 400', R._window({ since: '2020-01-01', until: '2999-01-01' }).until === today && R._window({ since: '2020-01-01', until: today }).since === addDays(today, -399));
  check('A3. since after until → error', !!R._window({ since: '2026-02-02', until: '2026-02-01' }).error);
  const f = R._fill([{ date: '2026-01-02', spend: 3, impressions: 9, clicks: 1, conversions: 0 }], '2026-01-01', '2026-01-03', false);
  check('A4. every day of the window is filled; no value → conversionValue null (ROAS not computed)', f.length === 3 && f[0].spend === 0 && f[1].spend === 3 && f[2].clicks === 0 && f.every((d) => d.conversionValue === null));

  log('\nB. Requests');
  let r = await H.call('GET', '/api/analytics/series?platform=meta', null);
  check('B1. no session → 401', r.status === 401);
  r = await get('platform=linkedin');
  check('B2. unknown platform → 400', r.status === 400 && r.body.code === 'BAD_PLATFORM');
  r = await get('platform=tiktok&adId=123');
  check('B3. per-ad series on TikTok → 422 AD_SERIES_UNSUPPORTED (Google and Meta only)', r.status === 422 && r.body.code === 'AD_SERIES_UNSUPPORTED');
  r = await get('platform=meta&campaignId=' + encodeURIComponent('1;DROP'));
  check('B4. an id with odd characters → 400', r.status === 400 && r.body.code === 'BAD_ID');

  log('\nC. Platforms');
  const since = addDays(today, -6);
  r = await get('platform=meta&since=' + since + '&until=' + today);
  const m = r.body;
  check('C1. Meta: 7 filled days, spend/clicks/conversions and purchase value from insights', r.status === 200 && m.series.length === 7 && m.series[0].spend === 10.5 && m.series[0].conversions === 2 && m.series[0].conversionValue === 84 && m.series[1].spend === 0 && m.conversionValue === 'reported', m);
  check('C2. Meta reads the account’s insights with one exact time_range, daily', seen.some((x) => /graph\.facebook\.com\/[^/]+\/act_111\/insights\?/.test(x) && /time_increment=1/.test(x) && x.indexOf(encodeURIComponent('"since":"' + since + '"')) !== -1));
  r = await get('platform=meta&adId=6001&since=' + since + '&until=' + today);
  check('C3. Meta per ad: insights of that ad', r.status === 200 && seen.some((x) => /\/6001\/insights\?/.test(x)));
  r = await get('platform=tiktok&since=' + addDays(today, -44) + '&until=' + today);
  const ttCalls = seen.filter((x) => /business-api\.tiktok\.com\/open_api\/v1\.3\/report\/integrated\/get\//.test(x));
  check('C4. TikTok: daily report by stat_time_day, read in pieces of ≤ 30 days (45 days → 2 requests)', r.status === 200 && r.body.series.length === 45 && ttCalls.length === 2 && ttCalls.every((x) => /stat_time_day/.test(decodeURIComponent(x))) && r.body.series[0].spend === 7.25 && r.body.series[0].conversions === 3 && r.body.conversionValue === 'not_reported', { n: ttCalls.length, first: r.body.series && r.body.series[0] });
  r = await get('platform=tiktok&campaignId=3001&since=' + since + '&until=' + today);
  check('C5. TikTok per campaign: campaign level filtered on that campaign', r.status === 200 && seen.some((x) => /AUCTION_CAMPAIGN/.test(decodeURIComponent(x)) && /campaign_ids/.test(decodeURIComponent(x)) && /3001/.test(decodeURIComponent(x))));
  r = await get('platform=pinterest&since=' + addDays(today, -120) + '&until=' + today);
  check('C6. Pinterest: summed over the campaigns per day; a window past 90 days is clamped and reported', r.status === 200 && r.body.clamped && r.body.since === addDays(today, -89) && r.body.series.length === 90 && r.body.series[0].spend === 4 && r.body.series[0].impressions === 400, { clamped: r.body.clamped, first: r.body.series && r.body.series[0] });
  r = await get('platform=snapchat&since=' + since + '&until=' + today);
  check('C7. Snapchat: daily stats of the non-deleted campaigns (micro-currency → €), swipes as clicks', r.status === 200 && r.body.series.length === 7 && r.body.series.some((d) => d.spend === 4.2 && d.clicks === 25 && d.impressions === 800) && !seen.some((x) => /campaigns\/sc2\/stats/.test(x)), r.body.series && r.body.series.filter((d) => d.spend));

  log('\nD. Not connected');
  H.rows('integrations').splice(0, H.rows('integrations').length);
  r = await get('platform=meta');
  check('D1. a platform that isn’t connected → an error answer (no crash, no figures)', r.status >= 400 && r.status < 600 && !r.body.series, r);

  check('Z. no outbound network outside the mocked platform APIs', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
