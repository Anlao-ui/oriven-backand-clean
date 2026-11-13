// ════════════════════════════════════════════════════════════════
// Snapchat Ads integration — OAuth, tokens, accounts, campaigns,
// reporting, publishing, rollback, activation, automations, isolation.
//
// Runs the REAL server.js through tests/helpers/mockServer.js: Supabase is
// an in-memory mock and every outbound request is blocked except the fake
// Snapchat endpoints below (in-process functions). No real Snapchat
// account, no real campaign, no ad spend. Credentials are fake strings.
// RUN: node tests/snapchat-ads.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5652, env: { SNAPCHAT_CLIENT_ID: 'snap-client-id', SNAPCHAT_CLIENT_SECRET: 'snap-secret-value', ACTIVATION_STEP_TIMEOUT_MS: '600' } });
const { check, log, done } = reporter();
const sharp = require('sharp');
const SNAP = require('../services/snapchatAds');
const S = require('../services/campaignSpec');
const C = require('../services/createCompat');

const A = { id: '00000000-0000-4000-8000-0000000051a1', email: 'snap-a@example.invalid' };
const B = { id: '00000000-0000-4000-8000-0000000051b2', email: 'snap-b@example.invalid' };
const TA = 'tok_snap_a', TB = 'tok_snap_b';
const ACC1 = '11111111-1111-4111-8111-111111111111', ACC2 = '22222222-2222-4222-8222-222222222222', ORG = '99999999-9999-4999-8999-999999999999';
const OTHER_ACC = '33333333-3333-4333-8333-333333333333';
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
let n = 0;
const uuid = () => { n++; const h = n.toString(16).padStart(12, '0'); return 'aaaaaaaa-0000-4000-8000-' + h; };

// ── Fake Snapchat ────────────────────────────────────────────────────
let P;
function reset() {
  P = {
    valid: { 'snap-access-1': true }, tokenCalls: [], codeOk: 'good-code', refreshOk: true, refreshReturnsNew: true,
    camps: {}, squads: {}, ads: {}, creatives: {}, media: {}, uploads: [], puts: [], deletes: [], posts: [], gets: [],
    failAdCreate: false, failStats: false, statsAuth: [],
  };
}
reset();
let PNG;
H.net.handler = async (url, opts) => {
  const u = new URL(url);
  const method = (opts && opts.method) || 'GET';
  if (u.host === 'img.example') return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  if (u.host === 'accounts.snapchat.com' && u.pathname === '/login/oauth2/access_token') {
    const f = new URLSearchParams(String(opts.body || ''));
    P.tokenCalls.push(Object.fromEntries(f));
    if (f.get('client_id') !== 'snap-client-id' || f.get('client_secret') !== 'snap-secret-value') return json({ error: 'invalid_client' }, 401);
    if (f.get('grant_type') === 'authorization_code') {
      if (f.get('code') !== P.codeOk) return json({ error: 'invalid_grant' }, 400);
      P.valid['snap-access-1'] = true;
      return json({ access_token: 'snap-access-1', refresh_token: 'snap-refresh-1', expires_in: 3600, token_type: 'Bearer' });
    }
    if (f.get('grant_type') === 'refresh_token') {
      if (!P.refreshOk) return json({ error: 'invalid_grant' }, 400);
      const tok = 'snap-access-r' + P.tokenCalls.length;
      P.valid[tok] = true;
      return json(Object.assign({ access_token: tok, expires_in: 3600, token_type: 'Bearer' }, P.refreshReturnsNew ? { refresh_token: 'snap-refresh-2' } : {}));
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  if (u.host !== 'adsapi.snapchat.com') return null;
  const auth = String((opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '');
  const tok = auth.replace(/^Bearer /, '');
  if (!P.valid[tok]) return json({ request_status: 'ERROR', display_message: 'invalid token' }, 401);
  const p = u.pathname.replace(/^\/v1/, '');
  const ok = (key, one, list) => json({ request_status: 'SUCCESS', [key]: list.map((x) => ({ sub_request_status: 'SUCCESS', [one]: x })) });
  const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  let m;
  if (method === 'GET') P.gets.push(p);
  if (p === '/me/organizations') return ok('organizations', 'organization', [{ id: ORG, name: 'Amber Org', ad_accounts: [
    { id: ACC1, name: 'Amber & Clay Snap', currency: 'EUR', timezone: 'Europe/Amsterdam', status: 'ACTIVE', type: 'DIRECT' },
    { id: ACC2, name: 'Second Snap', currency: 'USD', timezone: 'America/Los_Angeles', status: 'ACTIVE', type: 'DIRECT' }] }]);
  if (p === '/me') return json({ me: { id: 'me1' } });
  if ((m = /^\/adaccounts\/([^/]+)$/.exec(p))) return ok('adaccounts', 'adaccount', [{ id: m[1], currency: 'EUR', timezone: 'Europe/Amsterdam' }]);
  if ((m = /^\/adaccounts\/([^/]+)\/campaigns$/.exec(p))) {
    if (method === 'GET') return ok('campaigns', 'campaign', Object.values(P.camps).filter((c) => c.ad_account_id === m[1]));
    if (method === 'POST') { P.posts.push(['campaign', body]); const c = Object.assign({ id: uuid(), created_at: new Date().toISOString() }, body.campaigns[0]); P.camps[c.id] = c; return ok('campaigns', 'campaign', [c]); }
    if (method === 'PUT') { P.puts.push(['campaign', body.campaigns[0]]); const c = body.campaigns[0]; P.camps[c.id] = Object.assign(P.camps[c.id] || {}, c); return ok('campaigns', 'campaign', [P.camps[c.id]]); }
  }
  if ((m = /^\/adaccounts\/([^/]+)\/adsquads$/.exec(p))) return ok('adsquads', 'adsquad', Object.values(P.squads).filter((s) => P.camps[s.campaign_id] && P.camps[s.campaign_id].ad_account_id === m[1]));
  if ((m = /^\/adaccounts\/([^/]+)\/stats$/.exec(p))) {
    P.statsAuth.push(u.searchParams.get('start_time'));
    if (P.failStats) return json({ request_status: 'ERROR', display_message: 'stats unavailable' }, 400);
    const list = Object.values(P.camps).filter((c) => c.ad_account_id === m[1]).map((c, i) => ({ id: c.id, type: 'CAMPAIGN', stats: { impressions: 1000 * (i + 1), swipes: 50 * (i + 1), spend: 12500000 * (i + 1) } }));
    return json({ request_status: 'SUCCESS', total_stats: [{ sub_request_status: 'SUCCESS', total_stat: { id: m[1], type: 'AD_ACCOUNT', breakdown_stats: { campaign: list } } }] });
  }
  if ((m = /^\/adaccounts\/([^/]+)\/media$/.exec(p)) && method === 'POST') { const md = Object.assign({ id: uuid(), media_status: 'PENDING_UPLOAD' }, body.media[0]); P.media[md.id] = md; return ok('media', 'media', [md]); }
  if ((m = /^\/media\/([^/]+)\/upload$/.exec(p)) && method === 'POST') {
    const file = opts.body && typeof opts.body.get === 'function' ? opts.body.get('file') : null;
    const buf = file ? Buffer.from(await file.arrayBuffer()) : null;
    let meta = null; try { meta = buf ? await sharp(buf).metadata() : null; } catch (_) {}
    P.uploads.push({ id: m[1], type: file && file.type, size: buf ? buf.length : 0, width: meta && meta.width, height: meta && meta.height });
    return json({ request_status: 'SUCCESS', result: { id: m[1], media_status: 'READY' } });
  }
  if ((m = /^\/adaccounts\/([^/]+)\/creatives$/.exec(p)) && method === 'POST') { P.posts.push(['creative', body]); const cr = Object.assign({ id: uuid() }, body.creatives[0]); P.creatives[cr.id] = cr; return ok('creatives', 'creative', [cr]); }
  if ((m = /^\/campaigns\/([^/]+)\/adsquads$/.exec(p))) {
    if (method === 'POST') { P.posts.push(['adsquad', body]); const s = Object.assign({ id: uuid() }, body.adsquads[0]); P.squads[s.id] = s; return ok('adsquads', 'adsquad', [s]); }
    if (method === 'PUT') { P.puts.push(['adsquad', body.adsquads[0]]); const s = body.adsquads[0]; P.squads[s.id] = Object.assign(P.squads[s.id] || {}, s); return ok('adsquads', 'adsquad', [P.squads[s.id]]); }
    return ok('adsquads', 'adsquad', Object.values(P.squads).filter((s) => s.campaign_id === m[1]));
  }
  if ((m = /^\/campaigns\/([^/]+)\/ads$/.exec(p))) return ok('ads', 'ad', Object.values(P.ads).filter((a) => P.squads[a.ad_squad_id] && P.squads[a.ad_squad_id].campaign_id === m[1]));
  if ((m = /^\/adsquads\/([^/]+)\/ads$/.exec(p))) {
    if (method === 'POST') {
      P.posts.push(['ad', body]);
      if (P.failAdCreate) return json({ request_status: 'ERROR', ads: [{ sub_request_status: 'ERROR', sub_request_error_reason: 'Error code: E1165, message: creative rejected (test)' }] });
      const a = Object.assign({ id: uuid(), review_status: 'PENDING' }, body.ads[0]); P.ads[a.id] = a; return ok('ads', 'ad', [a]);
    }
    if (method === 'PUT') { P.puts.push(['ad', body.ads[0]]); const a = body.ads[0]; P.ads[a.id] = Object.assign(P.ads[a.id] || {}, a); return ok('ads', 'ad', [P.ads[a.id]]); }
  }
  if ((m = /^\/(campaigns|adsquads|ads)\/([^/]+)$/.exec(p))) {
    const store = { campaigns: P.camps, adsquads: P.squads, ads: P.ads }[m[1]];
    const one = { campaigns: 'campaign', adsquads: 'adsquad', ads: 'ad' }[m[1]];
    if (method === 'DELETE') { P.deletes.push([m[1], m[2]]); delete store[m[2]]; return json({ request_status: 'SUCCESS' }); }
    if (!store[m[2]]) return json({ request_status: 'ERROR', display_message: 'not found' }, 404);
    return ok(m[1], one, [store[m[2]]]);
  }
  return json({ request_status: 'ERROR', display_message: 'unhandled in test: ' + method + ' ' + p }, 400);
};

const raw = (p, tok) => H.realFetch(H.BASE + p, { redirect: 'manual', headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
const integ = (uid) => H.rows('integrations').find((r) => r.user_id === uid && r.provider === 'snapchat_ads');
const future = () => new Date(Date.now() + 3600e3).toISOString();

(async () => {
  PNG = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const quiet = await H.start();
  H.TOKENS[TA] = A; H.TOKENS[TB] = B;
  H.rows('profiles').push({ id: A.id, email: A.email, subscription_status: 'creator' }, { id: B.id, email: B.email, subscription_status: 'creator' });

  log('\nA. Configuration');
  {
    const prod = SNAP.config({ RENDER: 'true', SNAPCHAT_CLIENT_ID: 'x', SNAPCHAT_CLIENT_SECRET: 'y' });
    check('A.1 production redirect URI defaults to the registered Render callback', prod.redirectUri === 'https://oriven-backand-clean.onrender.com/auth/snapchat/callback', prod.redirectUri);
    check('A.2 SNAPCHAT_REDIRECT_URI overrides it', SNAP.config({ RENDER: '1', SNAPCHAT_REDIRECT_URI: 'https://x.example/cb' }).redirectUri === 'https://x.example/cb');
    check('A.3 without client id + secret it is not configured', SNAP.config({}).configured === false);
    const saved = process.env.SNAPCHAT_CLIENT_SECRET; delete process.env.SNAPCHAT_CLIENT_SECRET;
    const r = await H.call('GET', '/api/snapchat/auth-url', TA);
    const red = await raw('/auth/snapchat?token=' + TA);
    process.env.SNAPCHAT_CLIENT_SECRET = saved;
    check('A.4 not configured → auth-url 503 NOT_CONFIGURED', r.status === 503 && r.body.code === 'NOT_CONFIGURED', r);
    check('A.5 not configured → /auth/snapchat returns to the app with an error', red.status === 302 && /snapchat_error=not_configured/.test(red.headers.get('location')), red.headers.get('location'));
  }

  log('\nB. OAuth start + state (CSRF)');
  let state;
  {
    const no = await H.call('GET', '/api/snapchat/auth-url');
    check('B.1 auth-url requires a signed-in user', no.status === 401);
    const r = await H.call('GET', '/api/snapchat/auth-url', TA);
    const url = new URL(r.body.url);
    state = url.searchParams.get('state');
    check('B.2 authorize URL is Snap’s, with code flow, client id, exact redirect and the marketing scope',
      url.origin + url.pathname === 'https://accounts.snapchat.com/login/oauth2/authorize' && url.searchParams.get('response_type') === 'code' && url.searchParams.get('client_id') === 'snap-client-id'
      && url.searchParams.get('redirect_uri') === 'http://localhost:5500/auth/snapchat/callback' && url.searchParams.get('scope') === 'snapchat-marketing-api' && /^[0-9a-f]{32}$/.test(state), r.body.url);
    check('B.3 the client secret is never in the URL', !/snap-secret-value/.test(r.body.url));
    const red = await raw('/auth/snapchat?token=' + TA);
    check('B.4 /auth/snapchat redirects to Snap’s consent screen', red.status === 302 && /^https:\/\/accounts\.snapchat\.com\/login\/oauth2\/authorize\?/.test(red.headers.get('location')));
    const bad = await raw('/auth/snapchat?token=nope');
    check('B.5 /auth/snapchat with an invalid session returns with an error', /snapchat_error=invalid_token/.test(bad.headers.get('location') || ''));
  }

  log('\nC. Callback');
  {
    const forged = await raw('/auth/snapchat/callback?code=good-code&state=deadbeefdeadbeefdeadbeefdeadbeef');
    check('C.1 unknown state is refused (CSRF)', /snapchat_error=invalid_state/.test(forged.headers.get('location')) && !integ(A.id));
    const denied = await raw('/auth/snapchat/callback?error=access_denied&state=' + state);
    check('C.2 user denied → back to the app with the reason', /snapchat_error=access_denied/.test(denied.headers.get('location')));
    const miss = await raw('/auth/snapchat/callback?state=' + state);
    check('C.3 missing code → missing_params', /snapchat_error=missing_params/.test(miss.headers.get('location')));
    // a fresh state (the ones above were consumed)
    state = new URL((await H.call('GET', '/api/snapchat/auth-url', TA)).body.url).searchParams.get('state');
    const badCode = await raw('/auth/snapchat/callback?code=wrong&state=' + state);
    check('C.4 a rejected code → token_exchange error, nothing stored', /snapchat_error=token_exchange/.test(badCode.headers.get('location')) && !integ(A.id));
    state = new URL((await H.call('GET', '/api/snapchat/auth-url', TA)).body.url).searchParams.get('state');
    P.tokenCalls.length = 0;
    const okr = await raw('/auth/snapchat/callback?code=good-code&state=' + state);
    const tc = P.tokenCalls[0] || {};
    check('C.5 code exchanged with grant_type, code, the same redirect URI and the secret (form body)', tc.grant_type === 'authorization_code' && tc.code === 'good-code' && tc.redirect_uri === 'http://localhost:5500/auth/snapchat/callback' && tc.client_secret === 'snap-secret-value', tc);
    const row = integ(A.id);
    check('C.6 connected → back to the app; tokens saved for the user the state belongs to', /snapchat_connected=1/.test(okr.headers.get('location')) && row && row.access_token === 'snap-access-1' && row.refresh_token === 'snap-refresh-1' && new Date(row.token_expiry) > new Date(), row);
    check('C.7 ad accounts discovered (organization + accounts)', row && row.snapchat_ads_accounts.length === 2 && row.snapchat_ads_accounts[0].organization_id === ORG && row.snapchat_ads_accounts[0].currency === 'EUR');
    check('C.8 with two ad accounts none is chosen automatically', row && row.active_ad_account == null);
    const replay = await raw('/auth/snapchat/callback?code=good-code&state=' + state);
    check('C.9 a state works once (replay refused)', /snapchat_error=invalid_state/.test(replay.headers.get('location')));
    check('C.10 user B has no Snapchat connection', !integ(B.id));
    const rows = H.rows('integrations').filter((r) => r.user_id === A.id && r.provider === 'snapchat_ads');
    check('C.11 one connection row per user (no duplicates)', rows.length === 1);
  }

  log('\nD. Status, accounts, selection, Public Profile');
  {
    const st = await H.call('GET', '/api/snapchat/status', TA);
    check('D.1 status: connected with the accounts, no account selected yet', st.status === 200 && st.body.connected && st.body.snapchat_ads_accounts.length === 2 && !st.body.active_ad_account, st.body);
    check('D.2 status never contains tokens or the secret', !/snap-access-1|snap-refresh-1|snap-secret-value/.test(JSON.stringify(st.body)));
    const stB = await H.call('GET', '/api/snapchat/status', TB);
    check('D.3 user B: not connected', stB.status === 200 && stB.body.connected === false);
    const acc = await H.call('GET', '/api/snapchat/accounts', TA);
    check('D.4 accounts re-discovered from Snapchat', acc.status === 200 && acc.body.accounts.length === 2 && !acc.body.error);
    const foreign = await H.call('POST', '/api/snapchat/active-account', TA, { account_id: OTHER_ACC });
    check('D.5 an ad account outside this login is refused (403)', foreign.status === 403 && foreign.body.code === 'ACCOUNT_NOT_ACCESSIBLE', foreign);
    const stolen = await H.call('POST', '/api/snapchat/active-account', TB, { account_id: ACC1 });
    check('D.6 user B can’t select user A’s ad account', stolen.status === 400 && stolen.body.code === 'NOT_CONNECTED', stolen);
    const pf0 = await H.call('POST', '/api/snapchat/public-profile', TA, { profile_id: '44444444-4444-4444-8444-444444444444' });
    check('D.7 Public Profile needs a selected ad account first', pf0.status === 400 && pf0.body.code === 'NO_ACTIVE_ACCOUNT');
    const sel = await H.call('POST', '/api/snapchat/active-account', TA, { account_id: ACC1 });
    check('D.8 own ad account selected with currency, timezone and organization', sel.status === 200 && sel.body.active_ad_account.account_id === ACC1 && sel.body.active_ad_account.currency === 'EUR' && sel.body.active_ad_account.timezone === 'Europe/Amsterdam' && sel.body.active_ad_account.organization_id === ORG, sel.body);
    const pfBad = await H.call('POST', '/api/snapchat/public-profile', TA, { profile_id: 'not-a-uuid' });
    check('D.9 an invalid Public Profile ID is refused with how to find it', pfBad.status === 400 && pfBad.body.code === 'PROFILE_ID_INVALID');
    const pf = await H.call('POST', '/api/snapchat/public-profile', TA, { profile_id: '44444444-4444-4444-8444-444444444444' });
    check('D.10 Public Profile ID stored on the selected account', pf.status === 200 && integ(A.id).active_ad_account.profile_id === '44444444-4444-4444-8444-444444444444');
  }

  log('\nE. Token lifecycle');
  {
    const row = integ(A.id);
    row.token_expiry = new Date(Date.now() - 1000).toISOString();
    P.tokenCalls.length = 0;
    const r = await H.call('GET', '/api/snapchat/campaigns', TA);
    const rc = P.tokenCalls[0] || {};
    check('E.1 expired access token refreshed before the call (grant_type=refresh_token)', r.status === 200 && rc.grant_type === 'refresh_token' && rc.refresh_token === 'snap-refresh-1', { status: r.status, rc });
    check('E.2 new access token, new expiry and the returned refresh token stored', /^snap-access-r/.test(row.access_token) && row.refresh_token === 'snap-refresh-2' && new Date(row.token_expiry) > new Date(Date.now() + 50 * 60e3), row);
    // refresh returning no refresh_token keeps the stored one
    row.token_expiry = new Date(Date.now() - 1000).toISOString(); P.refreshReturnsNew = false;
    await H.call('GET', '/api/snapchat/campaigns', TA);
    check('E.3 a refresh without a new refresh token keeps the stored one', row.refresh_token === 'snap-refresh-2');
    P.refreshReturnsNew = true;
    // revoked access token (still "valid" by expiry) → 401 → refresh → retry once
    delete P.valid[row.access_token]; P.tokenCalls.length = 0;
    const r2 = await H.call('GET', '/api/snapchat/campaigns', TA);
    check('E.4 a 401 from Snapchat triggers one refresh and the call is retried', r2.status === 200 && P.tokenCalls.length === 1, { status: r2.status, calls: P.tokenCalls.length });
    // refresh token no longer works (access removed)
    row.token_expiry = new Date(Date.now() - 1000).toISOString(); P.refreshOk = false;
    const r3 = await H.call('GET', '/api/snapchat/campaigns', TA);
    check('E.5 refresh refused → 401 RECONNECT_REQUIRED (clear message)', r3.status === 401 && r3.body.code === 'RECONNECT_REQUIRED' && /reconnect/i.test(r3.body.error), r3);
    check('E.6 the error never contains a token', !/snap-access|snap-refresh/.test(JSON.stringify(r3.body)));
    P.refreshOk = true; row.token_expiry = future();
    const s = String(require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8'));
    const block = s.slice(s.indexOf('SNAPCHAT ADS — OAuth'), s.indexOf('// ── Pinterest Ads — Launch publish integration'));
    check('E.7 no Snapchat log line prints a token, code or secret', !/console\.(log|warn|error)\([^\n]*(access_token|refresh_token|accessToken|refreshToken|client_secret|clientSecret|req\.query\.code)/.test(block));
  }

  log('\nF. Spec, validation, compatibility');
  {
    const ctx = { profile: { company_name: 'Amber & Clay', country: 'NL' }, options: { connected: true, currency: 'EUR', profileId: null } };
    const base = { campaignName: 'Candle season', strategy: { goal: 'Traffic', landingPageUrl: 'https://amberclay.example/shop' }, snapchatAds: { budget: 10, headline: 'Cosy candles', cta: 'Shop now' }, visualConcepts: [{ generatedImageUrl: 'https://img.example/a.png' }] };
    const v = (pkg, c) => S.validate(S.buildSpec(pkg, 'snapchat', c || ctx), c || ctx);
    const codes = (iss) => iss.filter((i) => i.level === 'error').map((i) => i.code);
    check('F.1 a valid Traffic image campaign has no errors', codes(v(base)).length === 0, codes(v(base)));
    check('F.2 Sales is refused with the reason (Snap Pixel)', codes(v(Object.assign({}, base, { strategy: { goal: 'Sales', landingPageUrl: base.strategy.landingPageUrl } }))).includes('snapchat_goal'));
    check('F.3 two countries are refused (one country per campaign)', codes(v(Object.assign({}, base, { spec: { overrides: { countries: ['NL', 'BE'] } } }))).includes('snapchat_one_country'));
    check('F.4 less than 5 per ad squad per day is refused', codes(v(Object.assign({}, base, { snapchatAds: { budget: 8 }, campaignStructure: { groups: 2, adsPerGroup: 1 } }))).includes('snapchat_budget_min'));
    check('F.5 an image is required', codes(v(Object.assign({}, base, { visualConcepts: [] }))).includes('image_missing'));
    check('F.6 no brand name and no Public Profile → error', codes(v(base, { profile: { country: 'NL' }, options: { currency: 'EUR' } })).includes('snapchat_brand'));
    check('F.7 a video still rendering blocks publishing', codes(v(Object.assign({}, base, { creativeFormat: 'video', videoJobs: [{ ref: 'j1' }] }))).includes('video_pending'));
    check('F.8 a minimum age above 35 is refused', codes(v(Object.assign({}, base, { spec: { overrides: { ageMin: 40 } } }))).includes('snapchat_age_min'));
    const sp = S.buildSpec(base, 'snapchat', ctx);
    const sq = S.payloads.snapchat.adSquad(sp, 0, 'c', 't').adsquads[0];
    check('F.9 ad squad: PAUSED, SWIPES, AUTO_BID, DAILY_BUDGET in micro, lowercase country, string ages, no max at 65', sq.status === 'PAUSED' && sq.optimization_goal === 'SWIPES' && sq.bid_strategy === 'AUTO_BID' && sq.delivery_constraint === 'DAILY_BUDGET' && sq.daily_budget_micro === 10000000 && sq.targeting.geos[0].country_code === 'nl' && sq.targeting.demographics[0].min_age === '18' && !('max_age' in sq.targeting.demographics[0]), sq);
    const cr = S.payloads.snapchat.creative(sp, sp.adGroups[0].ads[0], 'acc', 'm').creatives[0];
    check('F.10 creative: WEB_VIEW, headline ≤ 34, valid CTA, UTM-tagged URL', cr.type === 'WEB_VIEW' && cr.headline.length <= 34 && SNAP.WEB_VIEW_CTAS.includes(cr.call_to_action) && /utm_source=snapchat/.test(cr.web_view_properties.url), cr);
    check('F.11 createCompat: Snapchat offers Traffic/Awareness, image/video; not text', C.check({ platform: 'snapchat', goal: 'Traffic', format: 'video' }).ok && !C.check({ platform: 'snapchat', goal: 'Leads', format: 'image' }).ok && !C.check({ platform: 'snapchat', goal: 'Traffic', format: 'text' }).ok);
    check('F.12 the Create image notice explains the 9:16 framing', C.imageNotices([{ width: 1000, height: 1000 }], 'snapchat').some((x) => x.code === 'snap_frame') && !C.imageNotices([{ width: 1080, height: 1920 }], 'snapchat').length);
  }

  log('\nG. Campaigns, reporting, pause');
  let own;
  {
    own = uuid(); P.camps[own] = { id: own, name: 'Spring', ad_account_id: ACC1, status: 'ACTIVE', objective_v2_properties: { objective_v2_type: 'TRAFFIC' }, daily_budget_micro: 25000000 };
    const foreign = uuid(); P.camps[foreign] = { id: foreign, name: 'Not yours', ad_account_id: OTHER_ACC, status: 'ACTIVE' };
    const r = await H.call('GET', '/api/snapchat/campaigns', TA);
    check('G.1 campaigns of the selected ad account only, with status, objective and budget', r.status === 200 && r.body.campaigns.length === 1 && r.body.campaigns[0].campaign_id === own && r.body.campaigns[0].objective === 'TRAFFIC' && r.body.campaigns[0].daily_budget === 25, r.body);
    const ov = await H.call('GET', '/api/snapchat/overview?date_range=last_7_days', TA);
    check('G.2 overview: spend from micro-currency, swipes as clicks, conversions not invented', ov.status === 200 && ov.body.overview.spend === 12.5 && ov.body.overview.impressions === 1000 && ov.body.overview.clicks === 50 && ov.body.overview.conversions === null, ov.body);
    check('G.3 stats requested from the account’s midnight in its own timezone', /T00:00:00\.000\+0[12]:00$/.test(P.statsAuth[P.statsAuth.length - 1] || ''), P.statsAuth);
    P.failStats = true;
    const ov2 = await H.call('GET', '/api/snapchat/overview', TA);
    check('G.4 stats failing → campaigns still listed, overview null with a clear note (never zeros)', ov2.status === 200 && ov2.body.overview === null && ov2.body.campaigns.length === 1 && ov2.body.campaigns[0].metrics === null && ov2.body.statsError, ov2.body);
    P.failStats = false;
    const px = await H.call('POST', '/api/snapchat/campaign/' + foreign + '/pause', TA, {});
    check('G.5 pausing a campaign of another ad account is refused (404) and nothing is written', px.status === 404 && !P.puts.length, px);
    const pb = await H.call('POST', '/api/snapchat/campaign/' + own + '/pause', TB, {});
    check('G.6 user B can’t pause user A’s campaign', pb.status >= 400 && !P.puts.length, pb);
    const pz = await H.call('POST', '/api/snapchat/campaign/' + own + '/pause', TA, {});
    const put = P.puts[0] && P.puts[0][1];
    check('G.7 pause: full campaign object written back with only status changed', pz.status === 200 && put && put.status === 'PAUSED' && put.name === 'Spring' && put.daily_budget_micro === 25000000 && put.objective_v2_properties.objective_v2_type === 'TRAFFIC', put);
    check('G.8 invalid campaign id → 404 without a Snapchat call', (await H.call('POST', '/api/snapchat/campaign/123/pause', TA, {})).status === 404);
  }

  log('\nH. Publishing');
  const pkg = { campaignName: 'Autumn candles', strategy: { goal: 'Traffic', landingPageUrl: 'https://amberclay.example/autumn' }, snapchatAds: { budget: 12, headline: 'Hand-poured autumn candles', cta: 'Shop now' }, visualConcepts: [{ generatedImageUrl: 'https://img.example/autumn.png' }], campaignStructure: { groups: 2, adsPerGroup: 1 } };
  H.rows('business_profile').push({ user_id: A.id, company_name: 'Amber & Clay', country: 'NL' });
  {
    const spec = await H.call('POST', '/api/campaigns/spec', TA, { pkg, platform: 'snapchat' });
    check('H.1 Launch review: spec built and publishable', spec.status === 200 && spec.body.canPublish === true && spec.body.spec.platform === 'snapchat', spec.body.issues);
    P.posts.length = 0; P.uploads.length = 0;
    const r = await H.call('POST', '/api/publish/snapchat', TA, { pkg, campId: 'camp-snap-1' });
    check('H.2 published: campaign, 2 ad squads, 2 ads — status paused', r.status === 200 && r.body.ok && r.body.status === 'paused' && r.body.adSquads.length === 2 && r.body.ads.length === 2, r.body);
    const up = P.uploads[0] || {};
    check('H.3 image uploaded as a 1080×1920 JPEG Top Snap', P.uploads.length === 1 && up.width === 1080 && up.height === 1920 && up.type === 'image/jpeg', P.uploads);
    const camp = (P.posts.find((x) => x[0] === 'campaign') || [])[1].campaigns[0];
    check('H.4 campaign: PAUSED, TRAFFIC objective, in the selected ad account', camp.status === 'PAUSED' && camp.objective_v2_properties.objective_v2_type === 'TRAFFIC' && camp.ad_account_id === ACC1, camp);
    const sqs = P.posts.filter((x) => x[0] === 'adsquad').map((x) => x[1].adsquads[0]);
    check('H.5 ad squads split the 12/day budget: 6 each, PAUSED', sqs.length === 2 && sqs.every((s) => s.daily_budget_micro === 6000000 && s.status === 'PAUSED'), sqs);
    const crs = P.posts.filter((x) => x[0] === 'creative').map((x) => x[1].creatives[0]);
    check('H.6 creatives carry the brand name, Public Profile and the uploaded media', crs.length === 2 && crs.every((c) => c.brand_name === 'Amber & Clay' && c.profile_properties && c.profile_properties.profile_id === '44444444-4444-4444-8444-444444444444' && c.top_snap_media_id === up.id), crs);
    const ads = P.posts.filter((x) => x[0] === 'ad').map((x) => x[1].ads[0]);
    check('H.7 ads: REMOTE_WEBPAGE, PAUSED', ads.length === 2 && ads.every((a) => a.type === 'REMOTE_WEBPAGE' && a.status === 'PAUSED'));
    const op = H.rows('publish_operations').find((o) => o.platform === 'snapchat' && o.client_ref_id === 'camp-snap-1');
    check('H.8 publish recorded (ledger) with the ad squad and ad ids', op && op.state === 'published' && op.external_ids && op.external_ids.adSetIds.length === 2 && op.external_ids.adIds.length === 2, op);
    const again = await H.call('POST', '/api/publish/snapchat', TA, { pkg, campId: 'camp-snap-1' });
    check('H.9 the same campaign is never published twice', again.status === 409 && again.body.code === 'ALREADY_PUBLISHED');
    // failure → rollback
    P.failAdCreate = true; P.deletes.length = 0;
    const bad = await H.call('POST', '/api/publish/snapchat', TA, { pkg, campId: 'camp-snap-2' });
    const kinds = P.deletes.map((d) => d[0]);
    check('H.10 a refused ad → PUBLISH_FAILED with Snapchat’s reason', bad.status === 400 && bad.body.code === 'PUBLISH_FAILED' && /creative rejected/.test(bad.body.error), bad.body);
    check('H.11 rollback deletes what was created: ad squad(s) then the campaign', kinds.includes('adsquads') && kinds[kinds.length - 1] === 'campaigns' && bad.body.rollback.complete === true, P.deletes);
    P.failAdCreate = false;
    const invalid = await H.call('POST', '/api/publish/snapchat', TA, { pkg: Object.assign({}, pkg, { strategy: { goal: 'Leads', landingPageUrl: pkg.strategy.landingPageUrl } }), campId: 'camp-snap-3' });
    check('H.12 an invalid campaign is refused before anything is sent (422)', invalid.status === 422 && invalid.body.code === 'CAMPAIGN_INVALID');
    const noConn = await H.call('POST', '/api/publish/snapchat', TB, { pkg, campId: 'camp-snap-b' });
    check('H.13 user B (not connected) can’t publish', noConn.status === 400 && noConn.body.code === 'NOT_CONNECTED', noConn.body);
  }

  log('\nI. Activation (Launch → Activate)');
  {
    const op = H.rows('publish_operations').find((o) => o.platform === 'snapchat' && o.client_ref_id === 'camp-snap-1');
    const cid = op.external_campaign_id;
    P.puts.length = 0;
    const r = await H.call('POST', '/api/snapchat/campaign/' + cid + '/resume', TA, { campaignName: 'Autumn candles', firstActivation: true });
    const order = P.puts.map((p) => p[0]);
    check('I.1 first activation: ads, then ad squads, then the campaign — all ACTIVE', r.status === 200 && order.join(',') === 'ad,ad,adsquad,adsquad,campaign' && P.puts.every((p) => p[1].status === 'ACTIVE'), { status: r.status, order, body: r.body });
    check('I.2 activation report: verified, nothing left paused', r.body.activation && r.body.activation.verified === true && !r.body.activation.remainingPaused.ads.length && !r.body.activation.remainingPaused.adSets.length, r.body.activation);
    check('I.3 the full objects were written back (only status changed)', P.puts.filter((p) => p[0] === 'adsquad').every((p) => p[1].daily_budget_micro === 6000000 && p[1].targeting.geos[0].country_code === 'nl'));
  }

  log('\nJ. Automations adapter');
  {
    const plats = require('../services/automations/platforms');
    check('J.1 Snapchat is an automation platform with status + budget control', plats.PLATFORMS.includes('snapchat') && plats.CAPABILITIES.snapchat.status && plats.CAPABILITIES.snapchat.budget);
    const ad = plats.create({ _getSnapchatAccess: async (u) => { if (u.id !== A.id) throw Object.assign(new Error('Snapchat Ads not connected'), { status: 400 }); return { accessToken: integ(A.id).access_token, adAccountId: ACC1, currency: 'EUR', timezone: 'Europe/Amsterdam' }; }, _snapchat: () => SNAP }).snapchat;
    const list = await ad.listCampaigns(A, 7);
    const autumn = list.campaigns.find((c) => c.name === 'Autumn candles');
    check('J.2 campaigns listed with ad-squad budget (sum) and metrics', autumn && autumn.budget.scope === 'adgroup' && autumn.budget.amount === 12 && autumn.budget.editable && autumn.metrics && autumn.metrics.spend > 0, autumn);
    P.puts.length = 0;
    await ad.setBudget(A, autumn, { previous: 12, next: 18 });
    check('J.3 budget change scales each ad squad (6 → 9) in micro-currency', P.puts.length === 2 && P.puts.every((p) => p[0] === 'adsquad' && p[1].daily_budget_micro === 9000000), P.puts.map((p) => p[1].daily_budget_micro));
    let threw = null; try { await ad.setBudget(A, Object.assign({}, autumn, { budget: Object.assign({}, autumn.budget, { items: autumn.budget.items.map((i) => Object.assign({}, i, { amount: 9 })), amount: 18 }) }), { previous: 18, next: 6 }); } catch (e) { threw = e; }
    check('J.4 a change below 5 per ad squad is refused', threw && /at least 5/.test(threw.message));
    check('J.5 a non-UUID campaign id is not looked up', (await ad.getCampaign(A, '12345')) === null);
    const M = require('../services/automations/metrics');
    check('J.6 rules can’t use conversion metrics on Snapchat (not reported)', !M.PLATFORM_METRICS.snapchat.includes('conversions') && M.PLATFORM_METRICS.snapchat.includes('spend'));
  }

  log('\nK. Disconnect');
  {
    const r = await H.call('POST', '/api/snapchat/disconnect', TA, {});
    check('K.1 disconnect removes the stored tokens', r.status === 200 && !integ(A.id));
    const st = await H.call('GET', '/api/snapchat/status', TA);
    check('K.2 status afterwards: not connected', st.body.connected === false);
    const c = await H.call('GET', '/api/snapchat/campaigns', TA);
    check('K.3 campaign calls afterwards: NOT_CONNECTED', c.status === 400 && c.body.code === 'NOT_CONNECTED');
  }

  log('\nL. Without the optional migration (no snapchat_* columns)');
  {
    H.MISSING.integrations = new Set(['snapchat_ads_accounts', 'snapchat_ads_accounts_error']);
    const st0 = new URL((await H.call('GET', '/api/snapchat/auth-url', TA)).body.url).searchParams.get('state');
    const r = await raw('/auth/snapchat/callback?code=good-code&state=' + st0);
    const row = integ(A.id);
    check('L.1 connecting still works: tokens saved, optional columns dropped', /snapchat_connected=1/.test(r.headers.get('location')) && row && row.access_token && !('snapchat_ads_accounts' in row), row);
    const st = await H.call('GET', '/api/snapchat/status', TA);
    check('L.2 status reads the ad accounts live from Snapchat instead', st.status === 200 && Array.isArray(st.body.snapchat_ads_accounts) && st.body.snapchat_ads_accounts.length === 2, st.body);
    const sel = await H.call('POST', '/api/snapchat/active-account', TA, { account_id: ACC2 });
    check('L.3 selecting an ad account works without the columns', sel.status === 200 && integ(A.id).active_ad_account.account_id === ACC2, sel.body);
    delete H.MISSING.integrations;
  }

  if (quiet) [console.log, console.warn, console.error] = quiet;
  check('Z.1 nothing outside the fakes was contacted', !H.net.blocked.length, H.net.blocked);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
