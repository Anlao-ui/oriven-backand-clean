// ════════════════════════════════════════════════════════════════
// Publishing integration tests — routes/publishRoutes.js mounted on a test
// Express app with fake account access and MOCKED platform APIs (Meta
// Graph, Google Ads REST, TikTok Business, Pinterest v5). Nothing leaves
// this process; no real ad account is touched.
//
// Covers the manual-Create additions: Meta video ads (advideos upload,
// processing poll, thumbnail → image hash, video_data creative, error and
// timeout paths), Google Display and Demand Gen YouTube-video campaigns,
// TikTok Video Views, and explicit structures (several ad groups, several
// ads per group, each with its own copy and media) — PAUSED everywhere.
// RUN: node tests/campaign-publish-v2.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
// Point the event log at a mocked host — never a real Supabase project.
process.env.SUPABASE_URL = 'https://supabase.mock';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const express = require('express');
const sharp = require('sharp');
const S = require('../services/campaignSpec');
const PL = require('../services/publishLedger');
const ledgerStore = PL.memoryStore();

let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 600))); };
const PORT = 5644, BASE = 'http://127.0.0.1:' + PORT;
const realFetch = globalThis.fetch;

// ── Fake data stores ──
const DB = { business_profile: [], profiles: [] };
function table(t) {
  const q = { f: [], select() { return q; }, eq(c, v) { q.f.push((r) => r[c] === v); return q; }, maybeSingle() { return Promise.resolve({ data: (DB[t] || []).find((r) => q.f.every((fn) => fn(r))) || null, error: null }); } };
  return q;
}
const supabaseAdmin = { from: (t) => table(t) };

// ── Mock platform APIs ──
const calls = [];           // { host, method, path, body }
const failOn = { match: null, times: 0 };
let seq = 100;
let PNG_SQ, PNG_LAND, PNG_LOGO;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
// Image hosts in this suite (cdn.example.invalid) never resolve; the SSRF
// guard (services/safeFetch.js) resolves them to a public test address.
require("../services/safeFetch")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith(BASE)) return realFetch(url, opts);
  const method = (opts && opts.method) || 'GET';
  let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (_) { body = opts && opts.body; }
  const parsed = new URL(u);
  const rec = { host: parsed.host, method, path: parsed.pathname, query: parsed.search, body };
  if (parsed.host === 'supabase.mock') return json(201, []);
  if (parsed.host === 'cdn.example.invalid') { calls.push(rec); const buf = /land/.test(u) ? PNG_LAND : /logo/.test(u) ? PNG_LOGO : PNG_SQ; return new Response(buf, { status: 200, headers: { 'content-type': 'image/png' } }); }
  calls.push(rec);
  if (failOn.match && failOn.match(rec)) { failOn.times--; if (failOn.times <= 0) failOn.match = null; return json(400, { error: { message: 'Mock rejection', code: 100 } }); }
  if (parsed.host === 'graph.mock') {
    if (method === 'DELETE') return json(200, { success: true });
    if (/\/adimages$/.test(parsed.pathname)) return json(200, { images: { bytes: { hash: 'hash' + (++seq), url: 'x' } } });
    if (/\/advideos$/.test(parsed.pathname)) return json(200, { id: 'video' + (++seq) });
    return json(200, { id: String(++seq) });
  }
  if (parsed.host === 'googleads.googleapis.com') {
    if (/googleAds:mutate$/.test(parsed.pathname)) return json(200, { mutateOperationResponses: body.mutateOperations.map((op) => { const k = Object.keys(op)[0].replace('Operation', 'Result'); return { [k]: { resourceName: 'customers/123/' + k + '/' + (++seq) } }; }) });
    return json(200, { results: body.operations.map(() => ({ resourceName: 'customers/123/' + parsed.pathname.split('/').pop().replace(':mutate', '') + '/' + (++seq) })) });
  }
  if (parsed.host === 'business-api.mock') {
    if (/advertiser\/info/.test(parsed.pathname)) return json(200, { code: 0, data: { list: [{ currency: 'EUR' }] } });
  }
  throw new Error('unexpected request ' + u);
};

// ── Fake deps (the real ones live in server.js) ──
const access = {
  meta: { accessToken: 'MTOKEN', accountId: 'act_1', pageId: 'pg1' },
  google: { accessToken: 'GTOKEN', customerId: '123', loginCustomerId: null },
  tiktok: { accessToken: 'TTOKEN', advertiserId: 'adv1', identityId: 'idn1', identityType: 'CUSTOMIZED_USER', identityName: 'Linnen' },
  pinterest: { accessToken: 'PTOKEN', adAccountId: 'pa1' },
};
const facts = { pixels: [{ id: 'px1', name: 'Shop' }], ig: true, conversionActions: 2, tags: [{ id: 'tag1', name: 'Tag' }] };
const tiktokCalls = [], pinCalls = [], events = [];
const videoPolls = { n: 0, mode: 'ok' };
const tiktokCoverMock = { list: [{ video_id: 'vid1', video_cover_url: 'https://cdn.example.invalid/tiktok-cover.jpg' }] };
const locks = new Map();
const deps = {
  requireSubOrFreeStrict: (req, res, next) => next(),
  getUserFromToken: async (req) => ((req.headers.authorization || '') === 'Bearer tok' ? { id: 'u1' } : null),
  supabaseAdmin,
  getMetaAccess: async () => access.meta,
  metaFetch: async (path, token, q) => {
    calls.push({ host: 'graph.mock', method: 'GET', path, query: JSON.stringify(q || {}) });
    if (path === '/act_1') return { currency: 'EUR' };
    if (path === '/act_1/adspixels') return { data: facts.pixels };
    if (path === '/pg1') return facts.ig ? { instagram_business_account: { id: 'ig1', username: 'linnen' } } : {};
    if (path === '/search') return { data: [{ key: 14, name: 'Dutch' }, { key: 1001, name: 'English (All)' }] };
    if (/^\/video\d+$/.test(path)) { videoPolls.n++; return { status: { video_status: videoPolls.mode === 'error' ? 'error' : videoPolls.mode === 'stuck' ? 'processing' : videoPolls.n >= 2 ? 'ready' : 'processing', processing_phase: videoPolls.mode === 'error' ? { status: 'error', errors: [{ message: 'Unsupported codec' }] } : {} } }; }
    if (/^\/video\d+\/thumbnails$/.test(path)) return { data: [{ uri: 'https://cdn.example.invalid/thumb-other.png', is_preferred: false }, { uri: 'https://cdn.example.invalid/thumb.png', is_preferred: true }] };
    throw new Error('unexpected meta GET ' + path);
  },
  META_GRAPH: 'https://graph.mock/v25.0',
  getGadsAccess: async () => access.google,
  gadsQuery: async (t, c, q) => {
    calls.push({ host: 'googleads.googleapis.com', method: 'SEARCH', path: 'search', body: q });
    if (/FROM customer/.test(q)) return [{ customer: { currencyCode: 'EUR' } }];
    if (/FROM conversion_action/.test(q)) return Array.from({ length: facts.conversionActions }, () => ({}));
    if (/FROM geo_target_constant/.test(q)) return (q.match(/'([A-Z]{2})'/g) || []).map((m) => m.slice(1, 3)).filter((c) => ['NL', 'DE', 'BE'].includes(c)).map((c) => ({ geoTargetConstant: { resourceName: 'geoTargetConstants/' + c, countryCode: c } }));
    if (/FROM language_constant/.test(q)) return (q.match(/'([a-z]{2})'/g) || []).map((m) => m.slice(1, 3)).map((c) => ({ languageConstant: { resourceName: 'languageConstants/' + c, code: c } }));
    return [];
  },
  gadsResolveBudgetName: async (t, c, l, name, base) => ({ action: 'create', name: base }),
  extractGadsPolicyFindings: () => [],
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  getTikTokAccess: async () => access.tiktok,
  tiktokPost: async (path, token, body) => {
    tiktokCalls.push({ path, body });
    if (failOn.match && failOn.match({ host: 'tiktok', path, body })) { failOn.times--; if (failOn.times <= 0) failOn.match = null; throw Object.assign(new Error('Mock TikTok rejection'), { status: 503 }); }
    if (path === '/file/video/ad/upload/') return [{ video_id: 'vid-' + String(body.video_url).split('/').pop() }];
    if (path === '/file/image/ad/upload/') return { image_id: 'img1' };
    if (path === '/campaign/create/') return { campaign_id: 'tc1' };
    if (path === '/adgroup/create/') return { adgroup_id: 'tag' + (++seq) };
    if (path === '/ad/create/') return { ad_ids: ['tad' + (++seq)] };
    return {};
  },
  tiktokGet: async (path, token, q) => {
    tiktokCalls.push({ path, method: 'GET', body: q });
    if (path === '/file/video/ad/info/') return { list: tiktokCoverMock.list };
    return {};
  },
  TIKTOK_API: 'https://business-api.mock/open_api/v1.3',
  getPinterestAccess: async () => access.pinterest,
  pinterestApiRequest: async (token, method, path, body) => {
    pinCalls.push({ method, path, body });
    if (failOn.match && failOn.match({ host: 'pinterest', method, path, body })) { failOn.times--; if (failOn.times <= 0) failOn.match = null; throw Object.assign(new Error('Mock Pinterest rejection'), { status: 400 }); }
    if (method === 'GET' && path === '/ad_accounts/pa1') return { currency: 'EUR' };
    if (method === 'GET' && /conversion_tags$/.test(path)) return { items: facts.tags };
    if (method === 'POST') return { id: 'p' + (++seq) };
    return {};
  },
  pinterestGetOrCreateAdsBoard: async () => 'board1',
  pinterestCreateImagePin: async (t, board, url, meta) => { pinCalls.push({ method: 'PIN', path: url, body: meta }); return 'pin' + (++seq); },
  pinterestCreateVideoPin: async () => 'vpin1',
  pinterestArchiveEntities: async (t, acct, kind, ids) => { pinCalls.push({ method: 'ARCHIVE', path: kind, body: ids }); },
  acquirePublishLock: (u, p, c) => { const k = u + '|' + p + '|' + (c || ''); if (locks.has(k)) return null; locks.set(k, 1); return k; },
  releasePublishLock: (k) => locks.delete(k),
  logCampaignEvent: (u, o) => events.push(o),
  publishLedger: PL.createLedger({ store: ledgerStore }),
  metaVideoPollMs: 0, metaVideoPollTries: 5,
};

const app = express();
app.use(express.json({ limit: '10mb' }));
const routes = require('../routes/publishRoutes')(app, deps);
S.setContextLoader(routes.loadContext);

async function call(path, body) {
  const r = await realFetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const reset = () => { calls.length = 0; tiktokCalls.length = 0; pinCalls.length = 0; failOn.match = null; };
const posts = (re) => calls.filter((c) => c.method === 'POST' && re.test(c.path));

const basePkg = (platform, extra) => Object.assign({
  campaignName: 'Summer Linen Drop', platform,
  strategy: { goal: 'Sales', budgetRecommendation: '€20 per day' },
  visualConcepts: [{ conceptRef: 'a', generatedImageUrl: 'https://cdn.example.invalid/a.png' }, { conceptRef: 'b', generatedImageUrl: 'https://cdn.example.invalid/b.png' }],
  concepts: [{ angle: 'a', adCopy: { headline: 'Linen that breathes', primaryText: 'Stay cool all summer in pure linen.' }, cta: 'Shop now' }, { angle: 'b', adCopy: { headline: 'Made to last', primaryText: 'European linen that lasts.' }, cta: 'Learn more' }],
}, extra || {});
const ready = (pkg, platform, changes) => S.applyChanges(pkg, platform, changes).pkg;

const server = app.listen(PORT, async () => {
  try {
    PNG_SQ = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#c8b89a' } }).png().toBuffer();
    PNG_LAND = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#9ab8c8' } }).png().toBuffer();
    PNG_LOGO = await sharp({ create: { width: 500, height: 160, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
    DB.business_profile.push({ user_id: 'u1', company_name: 'Linnen & Co', website: 'linnenco.nl', country: 'Nederland', languages: null, logo_url: 'https://cdn.example.invalid/logo.png' });
    DB.profiles.push({ id: 'u1', preferences: {} });
    const IMG = (n) => 'https://cdn.example.invalid/img' + n + '.png', LAND = (n) => 'https://cdn.example.invalid/land' + n + '.png', VID = (n) => 'https://cdn.example.invalid/v' + n + '.mp4';
    const manual = (platform, goal, o, groups, extra) => Object.assign({ campaignName: 'Manual ' + platform, creationMode: 'manual', platform,
      strategy: Object.assign({ goal, landingPageUrl: 'https://linnenco.nl/shirts' }, platform === 'google' ? { budgetRecommendation: { amount: 30 } } : {}),
      spec: { overrides: { countries: ['NL'], ageMin: 18, ageMax: 65, specialAdCategories: [], adGroups: groups } },
      campaignStructure: { groups: groups.length, adsPerGroup: Math.max.apply(null, groups.map((g) => g.ads.length)) },
      [{ meta: 'metaAds', google: 'googleAds', tiktok: 'tiktokAds', pinterest: 'pinterestAds', snapchat: 'snapchatAds' }[platform]]: Object.assign(platform === 'google' ? {} : { budget: 30 }, o) }, extra || {});

    console.log('\nA. Meta video ads');
    reset(); videoPolls.n = 0; videoPolls.mode = 'ok';
    let r = await call('/api/publish/meta', { pkg: manual('meta', 'Traffic', { creativeType: 'video', videoUrl: VID(1) }, [{ name: 'Video set', ads: [{ headline: 'Watch one', primaryText: 'One', videoUrl: VID(1) }, { headline: 'Watch two', primaryText: 'Two', videoUrl: VID(2) }] }], { inputs: { format: 'video' } }), campId: 'mv1' });
    const vids = posts(/\/advideos$/), crs = posts(/\/adcreatives$/).map((c) => c.body);
    check('A1. published: 1 ad set, 2 ads, paused', r.status === 200 && r.body.ok && r.body.status === 'paused' && r.body.adSets.length === 1 && r.body.ads.length === 2, r.body);
    check('A2. each distinct video uploaded to the ad account (advideos, file_url) BEFORE the campaign is created', vids.length === 2 && vids.every((v) => /^https:\/\/cdn\.example\.invalid\/v\d\.mp4$/.test(v.body.file_url)) && calls.findIndex((c) => c.method === 'POST' && /\/advideos$/.test(c.path)) < calls.findIndex((c) => c.method === 'POST' && /\/campaigns$/.test(c.path)));
    check('A3. waits for Meta’s processing (status polled until ready) and uses Meta’s preferred thumbnail, uploaded as an image hash', videoPolls.n >= 2 && calls.some((c) => /thumbnails$/.test(c.path)) && calls.some((c) => c.host === 'cdn.example.invalid' && /thumb\.png$/.test(c.path)) && !calls.some((c) => /thumb-other/.test(c.path)) && posts(/\/adimages$/).length === 2);
    check('A4. creatives are video_data (video_id + thumbnail image_hash + message/title + CTA link), one per ad with its own video', crs.length === 2 && crs.every((c) => c.object_story_spec.video_data && /^video/.test(c.object_story_spec.video_data.video_id) && /^hash/.test(c.object_story_spec.video_data.image_hash) && c.object_story_spec.video_data.call_to_action.value.link && !c.object_story_spec.link_data) && crs[0].object_story_spec.video_data.video_id !== crs[1].object_story_spec.video_data.video_id && crs[1].object_story_spec.video_data.title === 'Watch two');
    reset(); videoPolls.n = 0; videoPolls.mode = 'error';
    r = await call('/api/publish/meta', { pkg: manual('meta', 'Traffic', { creativeType: 'video', videoUrl: VID(3) }, [{ name: 'V', ads: [{ headline: 'H', primaryText: 'P', videoUrl: VID(3) }] }], { inputs: { format: 'video' } }), campId: 'mv2' });
    check('A5. a video Meta can’t process → clear error with Meta’s reason, and no campaign, ad set or ad was created', r.status === 422 && /Unsupported codec/.test(r.body.error) && posts(/\/campaigns$/).length === 0 && posts(/\/adsets$/).length === 0, r.body);
    reset(); videoPolls.n = 0; videoPolls.mode = 'stuck';
    r = await call('/api/publish/meta', { pkg: manual('meta', 'Traffic', { creativeType: 'video', videoUrl: VID(4) }, [{ name: 'V', ads: [{ headline: 'H', primaryText: 'P', videoUrl: VID(4) }] }], { inputs: { format: 'video' } }), campId: 'mv3' });
    check('A5b. Meta still processing after the wait → 409 “try again in a few minutes”, rollback complete, nothing created', r.status === 409 && /still processing the video/.test(r.body.error) && r.body.rollback.complete && videoPolls.n === 5 && posts(/\/campaigns$/).length === 0, { status: r.status, body: r.body, polls: videoPolls.n });
    videoPolls.mode = 'ok';
    reset();
    r = await call('/api/publish/meta', { pkg: manual('meta', 'Traffic', { imageUrl: IMG(1) }, [
      { name: 'Set A', ageMin: 25, ageMax: 44, ads: [{ headline: 'A1', primaryText: 'a1', imageUrl: IMG(1) }, { headline: 'A2', primaryText: 'a2', imageUrl: IMG(2) }, { headline: 'A3', primaryText: 'a3', imageUrl: IMG(1) }] },
      { name: 'Set B', ads: [{ headline: 'B1', primaryText: 'b1', imageUrl: IMG(3) }] }]), campId: 'mi1' });
    const sets = posts(/\/adsets$/).map((c) => c.body), icr = posts(/\/adcreatives$/).map((c) => c.body);
    check('A6. Meta image ads, several ad sets: 2 ad sets (own names and ages), 4 ads, 3 distinct images uploaded once each', r.status === 200 && sets.length === 2 && sets[0].name === 'Set A' && sets[0].targeting.age_min === 25 && sets[1].targeting.age_min === 18 && icr.length === 4 && posts(/\/adimages$/).length === 3 && icr[3].object_story_spec.link_data.message === 'b1', { status: r.status, body: r.body && r.body.error });

    console.log('\nB. Google Display, YouTube video (Demand Gen), Search with several ad groups');
    reset();
    r = await call('/api/publish/google', { pkg: manual('google', 'Traffic', { campaignType: 'DISPLAY', headlines: ['Linen shirts'], longHeadline: 'Breathable linen shirts for summer', descriptions: ['Free returns in NL.'], imageUrl: IMG(1), pmaxLandscapeImageUrl: LAND(1) },
      [{ name: 'Display A', ads: [{ headlines: ['A'] }, { headlines: ['B'], imageUrl: IMG(2), landscapeImageUrl: LAND(2) }] }, { name: 'Display B', ads: [{ headlines: ['C'] }] }]), campId: 'gd1' });
    const gCalls = calls.filter((c) => c.host === 'googleads.googleapis.com' && c.method === 'POST');
    const agOps = gCalls.filter((c) => /adGroups:mutate$/.test(c.path)).flatMap((c) => c.body.operations), adOps = gCalls.filter((c) => /adGroupAds:mutate$/.test(c.path)).flatMap((c) => c.body.operations);
    const campOp = gCalls.filter((c) => /campaigns:mutate$/.test(c.path)).flatMap((c) => c.body.operations)[0];
    check('B1. Display: campaign DISPLAY with Maximize clicks, PAUSED; location criteria at campaign level', r.status === 200 && r.body.campaignType === 'DISPLAY' && campOp.create.advertisingChannelType === 'DISPLAY' && 'targetSpend' in campOp.create && campOp.create.status === 'PAUSED' && gCalls.some((c) => /campaignCriteria:mutate$/.test(c.path)), { s: r.status, b: r.body && r.body.error });
    check('B2. Display: 2 DISPLAY_STANDARD ad groups, 3 responsive display ads with headlines, long headline, square + landscape images and logo', agOps.length === 2 && agOps.every((o) => o.create.type === 'DISPLAY_STANDARD') && adOps.length === 3 && adOps.every((o) => o.create.ad.responsiveDisplayAd.longHeadline.text && o.create.ad.responsiveDisplayAd.squareMarketingImages[0].asset && o.create.ad.responsiveDisplayAd.marketingImages[0].asset && o.create.ad.responsiveDisplayAd.squareLogoImages[0].asset));
    check('B3. Display: images reused — 2 squares + 2 landscapes + 1 logo uploaded (not one per ad)', gCalls.filter((c) => /assets:mutate$/.test(c.path)).flatMap((c) => c.body.operations).length === 5);
    reset();
    r = await call('/api/publish/google', { pkg: manual('google', 'Traffic', { campaignType: 'DEMAND_GEN', format: 'video', youtubeVideo: 'https://youtu.be/dQw4w9WgXcQ', headlines: ['Linen'], longHeadlines: ['Breathable linen shirts, made in Europe'], descriptions: ['Free returns.'] },
      [{ name: 'Video A', ads: [{ headlines: ['One'] }, { headlines: ['Two'], youtubeVideo: 'abcdefghijk' }] }, { name: 'Video B', ads: [{ headlines: ['Three'] }] }]), campId: 'gv1' });
    const g2 = calls.filter((c) => c.host === 'googleads.googleapis.com' && c.method === 'POST');
    const assetOps = g2.filter((c) => /assets:mutate$/.test(c.path)).flatMap((c) => c.body.operations), vAds = g2.filter((c) => /adGroupAds:mutate$/.test(c.path)).flatMap((c) => c.body.operations);
    check('B4. YouTube video: Demand Gen campaign; logo + 2 YouTube assets (youtubeVideoId), each video once', r.status === 200 && r.body.format === 'youtube_video' && assetOps.length === 3 && assetOps.filter((o) => o.create.youtubeVideoAsset).map((o) => o.create.youtubeVideoAsset.youtubeVideoId).sort().join() === 'abcdefghijk,dQw4w9WgXcQ', { s: r.status, e: r.body && r.body.error });
    check('B5. YouTube video: 2 ad groups (each with its own location criteria), 3 demandGenVideoResponsiveAd ads with videos and logo', g2.filter((c) => /adGroupCriteria:mutate$/.test(c.path)).length === 2 && vAds.length === 3 && vAds.every((o) => o.create.ad.demandGenVideoResponsiveAd.videos[0].asset && o.create.ad.demandGenVideoResponsiveAd.logoImages[0].asset && o.create.ad.demandGenVideoResponsiveAd.businessName.text === 'Linnen & Co'));
    reset();
    r = await call('/api/publish/google', { pkg: manual('google', 'Leads', { campaignType: 'SEARCH', headlines: ['Linen shirts', 'Free returns', 'Made in EU'], descriptions: ['Shop linen shirts.', 'Order today.'] },
      [{ name: 'Shirts', keywords: [{ text: 'linen shirt', matchType: 'EXACT' }], ads: [{ headlines: ['Shirt 1', 'Shirt 2', 'Shirt 3'], descriptions: ['Shirt d1', 'Shirt d2'] }, { headlines: ['Shirt 4', 'Shirt 5', 'Shirt 6'], descriptions: ['Shirt d3', 'Shirt d4'] }] },
       { name: 'Trousers', keywords: ['linen trousers'], ads: [{ headlines: ['Trouser 1', 'Trouser 2', 'Trouser 3'], descriptions: ['T d1', 'T d2'] }] }]), campId: 'gs1' });
    const g3 = calls.filter((c) => c.host === 'googleads.googleapis.com' && c.method === 'POST');
    const kw = g3.filter((c) => /adGroupCriteria:mutate$/.test(c.path)).map((c) => c.body.operations.map((o) => o.create.keyword.text + ':' + o.create.keyword.matchType).join());
    const rsas = g3.filter((c) => /adGroupAds:mutate$/.test(c.path)).flatMap((c) => c.body.operations);
    check('B6. Search, several ad groups: own keywords per group, own headlines per RSA (regression of the Search route)', r.status === 200 && r.body.adGroups.length === 2 && kw.join('|') === 'linen shirt:EXACT|linen trousers:PHRASE' && rsas.length === 3 && rsas[1].create.ad.responsiveSearchAd.headlines[0].text === 'Shirt 4', { s: r.status, kw, e: r.body && r.body.error });

    console.log('\nC. TikTok');
    reset();
    r = await call('/api/publish/tiktok', { pkg: manual('tiktok', 'Awareness', { objective: 'VideoViews', videoUrl: VID(1) }, [{ name: 'TT', ads: [{ adText: 'First', videoUrl: VID(1) }, { adText: 'Second', videoUrl: VID(2) }] }, { name: 'TT 2', ads: [{ adText: 'Third', videoUrl: VID(1) }] }], { inputs: { format: 'video' } }), campId: 't1' });
    const tUp = tiktokCalls.filter((c) => c.path === '/file/video/ad/upload/'), tCamp = tiktokCalls.find((c) => c.path === '/campaign/create/'), tAg = tiktokCalls.filter((c) => c.path === '/adgroup/create/'), tAds = tiktokCalls.filter((c) => c.path === '/ad/create/');
    check('C1. Video Views: campaign VIDEO_VIEWS; ad groups VIDEO_VIEW / CPV; 2 ad groups, 3 ads', r.status === 200 && tCamp.body.objective_type === 'VIDEO_VIEWS' && tAg.length === 2 && tAg.every((a) => a.body.optimization_goal === 'VIDEO_VIEW' && a.body.billing_event === 'CPV') && tAds.length === 3, { s: r.status, e: r.body && r.body.error });
    check('C2. each distinct video uploaded once (2), each ad uses its own video', tUp.length === 2 && tAds[0].body.creatives[0].video_id === 'vid-v1.mp4' && tAds[1].body.creatives[0].video_id === 'vid-v2.mp4' && tAds[2].body.creatives[0].video_id === 'vid-v1.mp4');
    reset();
    r = await call('/api/publish/tiktok', { pkg: manual('tiktok', 'Traffic', { videoUrl: VID(1) }, [{ name: 'TT', ads: [{ adText: 'Go', videoUrl: VID(1) }] }], { inputs: { format: 'video' } }), campId: 't2' });
    check('C3. Traffic regression: TRAFFIC / CLICK / CPC', r.status === 200 && tiktokCalls.find((c) => c.path === '/campaign/create/').body.objective_type === 'TRAFFIC' && tiktokCalls.find((c) => c.path === '/adgroup/create/').body.billing_event === 'CPC');

    console.log('\nD. Pinterest, one Pin per ad');
    reset();
    r = await call('/api/publish/pinterest', { pkg: manual('pinterest', 'Awareness', { title: 'Linen', imageUrl: IMG(1) }, [{ name: 'Pins', ads: [{ title: 'Pin one', pinDescription: 'First pin', imageUrl: IMG(1) }, { title: 'Pin two', imageUrl: IMG(2) }] }]), campId: 'p1' });
    const pins = pinCalls.filter((c) => c.method === 'PIN');
    check('D1. each ad its own Pin (own title and image), each promoted by its own ad', r.status === 200 && pins.length === 2 && pins[0].body.title === 'Pin one' && pins[1].body.title === 'Pin two' && pins[1].path === IMG(2) && r.body.ads.length === 2 && r.body.ads[0].pinId !== r.body.ads[1].pinId, { s: r.status, e: r.body && r.body.error });

    console.log('\nE. Refused before anything is sent');
    reset();
    r = await call('/api/publish/meta', { pkg: manual('meta', 'Traffic', { imageUrl: IMG(1) }, [{ name: 'Big', ads: Array.from({ length: 51 }, (_, i) => ({ headline: 'H' + i, primaryText: 'P', imageUrl: IMG(1) })) }]), campId: 'm9' });
    check('E1. 51 ads in one Meta ad set → 422 with the limit, nothing sent', r.status === 422 && r.body.issues.some((i) => i.code === 'structure_ads') && posts(/./).length === 0);
    reset();
    r = await call('/api/publish/google', { pkg: manual('google', 'Traffic', { campaignType: 'DEMAND_GEN', format: 'video', youtubeVideo: 'nope', headlines: ['H'], longHeadlines: ['L'], descriptions: ['D'] }, [{ name: 'V', ads: [{ headlines: ['H'] }] }]), campId: 'g9' });
    check('E2. an invalid YouTube link → 422 youtube_invalid, nothing sent', r.status === 422 && r.body.issues.some((i) => i.code === 'youtube_invalid') && calls.filter((c) => c.method === 'POST').length === 0);
  } catch (e) {
    console.log('CRASH', e && e.stack || e); fail++;
  }
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  server.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
});
