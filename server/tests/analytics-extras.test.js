// ════════════════════════════════════════════════════════════════
// GET /api/analytics/extras — platform metrics as period totals
// (Performance Overview → Platform metrics). The REAL server.js with
// Supabase and the platform APIs mocked (tests/helpers/mockServer.js).
// No network, no real accounts.
// RUN: node tests/analytics-extras.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5673, env: { SNAPCHAT_CLIENT_ID: 'snap-client-id', SNAPCHAT_CLIENT_SECRET: 'snap-secret-value' } });
const { check, log, done } = reporter();
const X = require(path.join(H.SERVER_DIR, 'routes', 'analyticsExtras'));
const U = { id: '00000000-0000-4000-8000-0000000e7a01', email: 'extras@example.invalid' };
const TOK = 'tok_extras';
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
const today = new Date().toISOString().slice(0, 10);
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const seen = [];
let metaMode = 'ok', pinMode = 'ok';

H.net.handler = async (url) => {
  const u = new URL(url); seen.push(decodeURIComponent(u.host + u.pathname + '?' + u.search.slice(1)));
  if (u.host === 'graph.facebook.com') {
    if (!/\/insights$/.test(u.pathname)) return json({ data: [] });
    if (metaMode === 'refuse') return json({ error: { message: '(#100) Tried accessing nonexisting field', code: 100 } }, 400);
    if (metaMode === 'empty') return json({ data: [] });
    return json({ data: [{ reach: '5400', frequency: '1.85', inline_link_clicks: '320',
      actions: [{ action_type: 'landing_page_view', value: '210' }, { action_type: 'video_view', value: '900' }, { action_type: 'post_engagement', value: '1500' }, { action_type: 'purchase', value: '4' }],
      action_values: [{ action_type: 'purchase', value: '199.50' }],
      video_thruplay_watched_actions: [{ action_type: 'video_view', value: '300' }] }] });
  }
  if (u.host === 'business-api.tiktok.com') {
    return json({ code: 0, data: { list: [{ dimensions: { advertiser_id: '7001' }, metrics: { reach: '4000', frequency: '1.6', video_play_actions: '2500', video_watched_2s: '1800', video_views_p100: '400', likes: '120', comments: '8', shares: '15', follows: '6', profile_visits: '44' } }] } });
  }
  if (u.host === 'api.pinterest.com') {
    if (pinMode === 'refuse') return json({ code: 1, message: 'Invalid column' }, 400);
    return json([{ TOTAL_IMPRESSION_USER: 900, TOTAL_ENGAGEMENT: 77, TOTAL_VIDEO_3SEC_VIEWS: 0, TOTAL_CHECKOUT: 3, TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR: 120500000 }]);
  }
  if (u.host === 'adsapi.snapchat.com') {
    if (/\/stats$/.test(u.pathname)) return json({ request_status: 'SUCCESS', total_stats: [{ total_stat: { stats: { video_views: 1000, quartile_1: 700, quartile_2: 500, quartile_3: 350, view_completion: 200, swipes: 45 } } }] });
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
  t.push({ user_id: U.id, provider: 'snapchat_ads', access_token: 'snap-mock', refresh_token: 'snap-r', token_expiry: future, active_ad_account: { account_id: '11111111-1111-4111-8111-111111111111', account_name: 'Shop Snap', timezone: 'Europe/Amsterdam' } });
  const get = (qs) => H.call('GET', '/api/analytics/extras?' + qs, TOK);
  const since = addDays(today, -6);

  log('\nA. Pure readers');
  const s = X._read.shape('tiktok', { reach: 10 });
  check('A1. a metric the platform doesn’t give is "not reported", never 0', s.notReported.purchaseValue === 'not_reported_by_platform' && !('purchaseValue' in s.metrics) && s.metrics.reach === 10 && s.metrics.likes === null);
  const p = X._read.pinterest([{ TOTAL_IMPRESSION_USER: 5 }, { TOTAL_IMPRESSION_USER: 6 }]);
  check('A2. Pinterest reach over several rows is not added up (de-duplicated per row) → unknown', p.reach === null);
  const mz = X._read.meta({ reach: '0', actions: [] });
  check('A3. Meta: no action of a type → a real 0 (Meta leaves zero actions out), not unknown', mz.videoViews === 0 && mz.purchases === 0 && mz.reach === 0);

  log('\nB. Requests');
  let r = await H.call('GET', '/api/analytics/extras?platform=meta', null);
  check('B1. no session → 401', r.status === 401);
  r = await get('platform=linkedin');
  check('B2. unknown platform → 400', r.status === 400 && r.body.code === 'BAD_PLATFORM');
  r = await get('platform=meta&campaignId=' + encodeURIComponent('1;DROP'));
  check('B3. odd campaign id → 400', r.status === 400 && r.body.code === 'BAD_ID');

  log('\nC. Platforms');
  r = await get('platform=meta&since=' + since + '&until=' + today);
  check('C1. Meta: reach, frequency, link clicks, landing page views, video, engagement, purchases and value — period totals', r.status === 200 && r.body.metrics.reach === 5400 && r.body.metrics.frequency === 1.85 && r.body.metrics.linkClicks === 320 && r.body.metrics.landingPageViews === 210 && r.body.metrics.videoViews === 900 && r.body.metrics.thruPlays === 300 && r.body.metrics.videoCompletions === 0 && r.body.metrics.postEngagements === 1500 && r.body.metrics.purchases === 4 && r.body.metrics.purchaseValue === 199.5 && !!r.body.fetchedAt, r.body);
  check('C2. Meta asks once for the whole window (no daily increment), so reach is de-duplicated by Meta', seen.some((x) => /act_111\/insights/.test(x) && /reach,frequency/.test(x) && !/time_increment/.test(x)));
  check('C3. Google-only metrics are marked not reported for Meta', r.body.notReported.interactions === 'not_reported_by_platform');
  r = await get('platform=tiktok&since=' + since + '&until=' + today);
  check('C4. TikTok: reach, frequency, video plays/2s/100%, likes, comments, shares, follows, profile visits', r.status === 200 && r.body.metrics.reach === 4000 && r.body.metrics.videoViews2s === 1800 && r.body.metrics.videoCompletions === 400 && r.body.metrics.profileVisits === 44, r.body);
  check('C5. TikTok asks at advertiser level without a day dimension', seen.some((x) => /report\/integrated\/get/.test(x) && /AUCTION_ADVERTISER/.test(x) && /advertiser_id/.test(x) && !/stat_time_day/.test(x)));
  r = await get('platform=pinterest&since=' + addDays(today, -120) + '&until=' + today);
  check('C6. Pinterest: reach, engagements, checkouts and value (micro-dollars → currency); window clamped to 90 days and said so', r.status === 200 && r.body.metrics.reach === 900 && r.body.metrics.engagements === 77 && r.body.metrics.videoViews === 0 && r.body.metrics.videoCompletions === null && r.body.metrics.checkoutValue === 120.5 && r.body.clamped && r.body.since === addDays(today, -89), r.body);
  r = await get('platform=snapchat&since=' + since + '&until=' + today);
  check('C7. Snapchat: video views, quartiles, completions and swipe-ups (account total)', r.status === 200 && r.body.metrics.videoViews === 1000 && r.body.metrics.videoQ50 === 500 && r.body.metrics.videoCompletions === 200 && r.body.metrics.swipeUps === 45, r.body);

  log('\nD. Refusals and empty answers');
  metaMode = 'refuse';
  r = await get('platform=meta&since=' + since + '&until=' + today + '&campaignId=99');
  check('D1. the platform refuses a field → 200 with an honest error and no numbers (core figures are a separate call)', r.status === 200 && r.body.error && r.body.error.code === 'EXTRAS_UNAVAILABLE' && Object.keys(r.body.metrics).length === 0, r.body);
  metaMode = 'empty';
  r = await get('platform=meta&since=' + since + '&until=' + today + '&campaignId=98');
  check('D2. no delivery in the window → zeros for counts, frequency unknown', r.status === 200 && r.body.metrics.reach === 0 && r.body.metrics.frequency === null && r.body.metrics.purchases === 0, r.body);
  pinMode = 'refuse';
  r = await get('platform=pinterest&since=' + since + '&until=' + today + '&campaignId=pc9');
  check('D3. Pinterest refusal → honest error, no numbers', r.status === 200 && !!r.body.error && Object.keys(r.body.metrics).length === 0);
  H.rows('integrations').splice(0, H.rows('integrations').length);
  r = await get('platform=meta');
  check('D4. not connected → an error answer, no figures', r.status >= 400 && !r.body.metrics, r.body);

  check('Z. no outbound network outside the mocked platform APIs', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
