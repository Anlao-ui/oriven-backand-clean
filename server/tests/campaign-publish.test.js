// ════════════════════════════════════════════════════════════════
// Publishing integration tests — routes/publishRoutes.js mounted on a test
// Express app with fake account access and MOCKED platform APIs (Meta
// Graph, Google Ads REST, TikTok Business, Pinterest v5). Nothing leaves
// this process; no real ad account is touched.
//
// Covers per platform: the requests actually sent (hierarchy, targeting,
// budgets, tracking, identities, image uploads/crops), PAUSED everywhere,
// 422 blocks for invalid campaigns (no platform call made), rollback of
// partially created objects on an API error, and duplicate-publish (409).
// RUN: node tests/campaign-publish.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
// Point the event log at a mocked host — never a real Supabase project.
process.env.SUPABASE_URL = 'https://supabase.mock';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const express = require('express');
const sharp = require('sharp');
const S = require('../services/campaignSpec');

let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 600))); };
const PORT = 5641, BASE = 'http://127.0.0.1:' + PORT;
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
    if (path === '/file/video/ad/upload/') return [{ video_id: 'vid1' }];
    if (path === '/file/image/ad/upload/') return { image_id: 'img1' };
    if (path === '/campaign/create/') return { campaign_id: 'tc1' };
    if (path === '/adgroup/create/') return { adgroup_id: 'tag' + (++seq) };
    if (path === '/ad/create/') return { ad_ids: ['tad' + (++seq)] };
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

    console.log('\nA. Review endpoint');
    reset();
    let r = await call('/api/campaigns/spec', { pkg: basePkg('meta'), platform: 'meta' });
    check('spec endpoint: complete spec, issues, live account facts (pixels, currency, Instagram)', r.status === 200 && r.body.spec.targeting.countries[0] === 'NL' && r.body.options.currency === 'EUR' && r.body.options.pixels.length === 1 && r.body.options.instagramUsername === 'linnen' && r.body.canPublish === false, r.body && { issues: r.body.issues, options: r.body.options });
    check('no access token or secret in the response', !JSON.stringify(r.body).includes('MTOKEN'));
    r = await call('/api/campaigns/spec', { pkg: basePkg('meta'), platform: 'meta', choices: true, changes: { countries: ['Belgium'], budget: 22, ageMin: 50, ageMax: 30 } });
    check('review edits: valid changes applied and returned as a package, invalid ones refused with a reason', r.status === 200 && r.body.pkg.spec.overrides.countries[0] === 'BE' && r.body.pkg.metaAds.budget === 22 && r.body.spec.targeting.countries[0] === 'BE' && r.body.applied.length === 2 && r.body.rejected.length === 1 && /18 and 65/.test(r.body.rejected[0].reason), r.body && { applied: r.body.applied, rejected: r.body.rejected });
    check('review edits are not stored server-side (only returned)', !DB.business_profile[0].country || DB.business_profile[0].country === 'Nederland');
    check('option lists returned on request (countries, languages, Meta categories)', r.body.choices && r.body.choices.countries.length > 30 && r.body.choices.metaSpecialCategories.includes('HOUSING') && r.body.choices.tiktokMinDaily === 20);

    console.log('\nB. Meta');
    reset();
    r = await call('/api/publish/meta', { pkg: basePkg('meta'), campId: 'm1' });
    check('invalid campaign (budget/special categories unconfirmed) → 422 with issues, nothing created', r.status === 422 && r.body.code === 'CAMPAIGN_INVALID' && r.body.issues.some((i) => i.code === 'budget_unconfirmed') && posts(/./).length === 0, r.body);
    reset();
    const metaPkg = ready(basePkg('meta', { metaStructure: { adSets: 2, adsPerAdSet: 2 } }), 'meta', { budget: 25, specialAdCategories: [], languages: ['nl'] });
    r = await call('/api/publish/meta', { pkg: metaPkg, campId: 'm1' });
    check('valid campaign published', r.status === 200 && r.body.ok && r.body.status === 'paused' && r.body.adSets.length === 2 && r.body.ads.length === 4, r.body);
    const camp = posts(/\/campaigns$/)[0].body, adsets = posts(/\/adsets$/).map((c) => c.body), creatives = posts(/\/adcreatives$/).map((c) => c.body), ads = posts(/\/ads$/).map((c) => c.body);
    check('API version v25.0 everywhere', calls.filter((c) => c.host === 'graph.mock' && c.method === 'POST').every((c) => c.path.startsWith('/v25.0/')));
    check('images uploaded to Meta (adimages, bytes) before use — 2 distinct images', posts(/\/adimages$/).length === 2 && posts(/\/adimages$/).every((c) => typeof c.body.bytes === 'string' && c.body.bytes.length > 100));
    check('campaign PAUSED, objective, special categories, no invalid parameter', camp.status === 'PAUSED' && camp.objective === 'OUTCOME_SALES' && Array.isArray(camp.special_ad_categories) && !('budget_optimization_type' in camp));
    check('ad sets: NL, Dutch locale key, pixel+PURCHASE, DSA, 25.00 EUR (2500), PAUSED', adsets.length === 2 && adsets.every((a) => a.targeting.geo_locations.countries[0] === 'NL' && a.targeting.locales[0] === 14 && a.promoted_object.pixel_id === 'px1' && a.dsa_beneficiary === 'Linnen & Co' && a.daily_budget === 2500 && a.status === 'PAUSED'), adsets[0]);
    check('creatives: image_hash, Instagram identity, UTM tags; ads PAUSED', creatives.length === 4 && creatives.every((c) => /^hash/.test(c.object_story_spec.link_data.image_hash) && c.object_story_spec.instagram_user_id === 'ig1' && /utm_source=facebook/.test(c.url_tags)) && ads.every((a) => a.status === 'PAUSED'));
    check('no access token in a logged event', !JSON.stringify(events).includes('MTOKEN'));
    reset();
    failOn.match = (c) => c.host === 'graph.mock' && /\/ads$/.test(c.path); failOn.times = 1; // first ad creation fails
    r = await call('/api/publish/meta', { pkg: metaPkg, campId: 'm2' });
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path.split('/').pop());
    check('API error mid-way → error returned and everything created is deleted (rollback)', r.status === 400 && /Mock rejection/.test(r.body.error) && deletes.length >= 3, { status: r.status, deletes });
    reset();
    const held = deps.acquirePublishLock('u1', 'meta', 'm3'); // a publish of m3 is in flight
    r = await call('/api/publish/meta', { pkg: metaPkg, campId: 'm3' });
    check('duplicate publish while one is in flight → 409, nothing created', r.status === 409 && r.body.code === 'PUBLISH_IN_PROGRESS' && posts(/./).length === 0, r.body);
    deps.releasePublishLock(held);
    r = await call('/api/publish/meta', { pkg: metaPkg, campId: 'm3' });
    check('lock released after a publish → the next publish proceeds', r.status === 200 && !locks.size, r.status);
    reset();
    facts.pixels = [{ id: 'px1' }, { id: 'px2' }];
    r = await call('/api/publish/meta', { pkg: ready(basePkg('meta'), 'meta', { budget: 25, specialAdCategories: [] }), campId: 'm4' });
    check('two pixels and no choice → 422 pixel_choose (never silently selected)', r.status === 422 && r.body.issues.some((i) => i.code === 'pixel_choose') && posts(/./).length === 0);
    facts.pixels = [{ id: 'px1', name: 'Shop' }];
    reset();
    DB.business_profile[0].country = null;
    r = await call('/api/publish/meta', { pkg: ready(basePkg('meta'), 'meta', { budget: 25, specialAdCategories: [] }), campId: 'm5' });
    check('no country anywhere → 422 country_missing, nothing sent (no US default)', r.status === 422 && r.body.issues.some((i) => i.code === 'country_missing') && posts(/./).length === 0);
    DB.business_profile[0].country = 'Nederland';

    console.log('\nC. Google Ads');
    const gBase = { strategy: { goal: 'Leads', budgetRecommendation: { amount: 30 } }, googleAds: { campaignType: 'SEARCH', headlines: ['Linen shirts for summer', 'Free returns in NL', 'Made in Europe'], descriptions: ['Shop breathable linen shirts with free returns.', 'Order today, delivered tomorrow.'], keywords: ['linen shirt', 'linnen overhemd'], negativeKeywords: ['free', 'diy'], callouts: ['Free returns', 'Ships in 24h'], structuredSnippetHeader: 'Styles', structuredSnippets: ['Casual', 'Formal', 'Relaxed'], sitelinks: ['Men'] } };
    reset();
    r = await call('/api/publish/google', { pkg: ready(basePkg('google', gBase), 'google', { languages: ['nl'], sitelink: { text: 'Men', url: 'https://linnenco.nl/men' } }), campId: 'g1' });
    const gm = (res) => calls.filter((c) => c.host === 'googleads.googleapis.com' && c.method === 'POST' && c.path.endsWith(res + ':mutate')).flatMap((c) => c.body.operations);
    const gCamp = gm('campaigns')[0].create, gCrit = gm('campaignCriteria').map((o) => o.create);
    check('Search published, campaign PAUSED with network settings + UTM suffix', r.status === 200 && r.body.campaignType === 'SEARCH' && gCamp.status === 'PAUSED' && gCamp.networkSettings.targetGoogleSearch && /utm_source=google/.test(gCamp.finalUrlSuffix), r.body);
    check('location NL + Dutch + 2 negative keywords as campaign criteria', gCrit.some((c) => c.location && c.location.geoTargetConstant === 'geoTargetConstants/NL') && gCrit.some((c) => c.language && c.language.languageConstant === 'languageConstants/nl') && gCrit.filter((c) => c.negative).length === 2);
    check('callouts, snippet and sitelink assets linked to the campaign', gm('assets').length === 4 && gm('campaignAssets').map((o) => o.create.fieldType).sort().join(',') === 'CALLOUT,CALLOUT,SITELINK,STRUCTURED_SNIPPET');
    check('ad group, keywords, responsive search ad with the destination', gm('adGroups').length === 1 && gm('adGroupCriteria').length === 2 && gm('adGroupAds')[0].create.ad.finalUrls[0] === 'https://linnenco.nl');
    reset();
    const pmPkg = basePkg('google', { strategy: { goal: 'Sales', budgetRecommendation: { amount: 30 } }, googleAds: Object.assign({}, gBase.googleAds, { campaignType: 'PERFORMANCE_MAX', pmaxLandscapeImageUrl: 'https://cdn.example.invalid/land.png', longHeadline: 'Breathable European linen for summer' }) });
    r = await call('/api/publish/google', { pkg: pmPkg, campId: 'g2' });
    const batch = calls.find((c) => c.path.endsWith('googleAds:mutate')).body.mutateOperations;
    const ops = (k) => batch.filter((o) => o[k]).map((o) => o[k].create);
    check('Performance Max published (one atomic batch)', r.status === 200 && r.body.campaignType === 'PERFORMANCE_MAX', r.body);
    check('campaign PAUSED, brand guidelines on, location criterion', ops('campaignOperation')[0].status === 'PAUSED' && ops('campaignOperation')[0].brandGuidelinesEnabled === true && ops('campaignCriterionOperation').some((c) => c.location));
    check('business name + logo linked at CAMPAIGN level, not in the asset group', ops('campaignAssetOperation').map((x) => x.fieldType).sort().join(',') === 'BUSINESS_NAME,LOGO' && !ops('assetGroupAssetOperation').some((x) => x.fieldType === 'BUSINESS_NAME' || x.fieldType === 'LOGO'));
    const imgAssets = ops('assetOperation').filter((a) => a.imageAsset);
    const dims = await Promise.all(imgAssets.map(async (a) => { const m = await sharp(Buffer.from(a.imageAsset.data, 'base64')).metadata(); return { name: a.name, w: m.width, h: m.height }; }));
    const land = dims.find((x) => /Landscape/.test(x.name)), logo = dims.find((x) => /Logo/.test(x.name)), sq = dims.find((x) => /Square/.test(x.name));
    check('landscape image cropped to 1.91:1 (±1%), square 1:1, logo padded to 1:1', land && Math.abs(land.w / land.h - 1.91) / 1.91 <= 0.01 && land.w >= 600 && sq.w === sq.h && logo.w === logo.h, dims);
    check('asset group: ≥3 headlines, long headline, descriptions, both marketing images', ['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE'].every((t) => ops('assetGroupAssetOperation').some((x) => x.fieldType === t)) && ops('assetGroupAssetOperation').filter((x) => x.fieldType === 'HEADLINE').length >= 3);
    reset();
    const dgPkg = basePkg('google', { strategy: { goal: 'Traffic', budgetRecommendation: { amount: 20 } }, googleAds: Object.assign({}, gBase.googleAds, { campaignType: 'DEMAND_GEN' }) });
    r = await call('/api/publish/google', { pkg: dgPkg, campId: 'g3' });
    const dgAd = gm('adGroupAds')[0] && gm('adGroupAds')[0].create.ad.demandGenMultiAssetAd;
    check('Demand Gen published with logo images + square image in the square slot, ad-group location criterion', r.status === 200 && dgAd && dgAd.logoImages.length === 1 && dgAd.squareMarketingImages.length === 1 && !dgAd.marketingImages && gm('adGroupCriteria').some((o) => o.create.location), r.body);
    reset();
    failOn.match = (c) => c.host === 'googleads.googleapis.com' && /adGroupAds:mutate$/.test(c.path); failOn.times = 1;
    r = await call('/api/publish/google', { pkg: basePkg('google', gBase), campId: 'g4' });
    const removed = gm('campaigns').filter((o) => o.remove).length + gm('campaignBudgets').filter((o) => o.remove).length;
    check('Google API error → campaign and new budget removed (rollback)', r.status === 400 && removed === 2, { status: r.status, removed });
    reset();
    facts.conversionActions = 0;
    r = await call('/api/publish/google', { pkg: basePkg('google', gBase), campId: 'g5' });
    check('no conversion tracking for a Leads campaign → 422, nothing created', r.status === 422 && r.body.issues.some((i) => i.code === 'google_conversions_none') && gm('campaigns').length === 0);
    facts.conversionActions = 2;

    console.log('\nD. TikTok');
    const tkPkg = basePkg('tiktok', { strategy: { goal: 'Traffic' }, tiktokAds: { hook: 'Linen season', script: '[0:00] Hook', cta: 'Shop now', budget: 25 } });
    reset();
    r = await call('/api/publish/tiktok', { pkg: tkPkg, campId: 't1' });
    check('image-only → 422 (TikTok feed ads are videos), nothing created', r.status === 422 && r.body.issues.some((i) => i.code === 'tiktok_video') && tiktokCalls.length === 0);
    reset();
    const tkVideo = Object.assign({}, tkPkg, { videoAssets: [{ videoUrl: 'https://cdn.example.invalid/v.mp4' }] });
    r = await call('/api/publish/tiktok', { pkg: tkVideo, campId: 't2' });
    const tc = tiktokCalls.find((c) => c.path === '/campaign/create/').body, tg = tiktokCalls.find((c) => c.path === '/adgroup/create/').body, ta = tiktokCalls.find((c) => c.path === '/ad/create/').body.creatives[0];
    check('published: campaign unlimited budget + DISABLE; ad group 25/day, Netherlands location id, TikTok placement', r.status === 200 && tc.budget_mode === 'BUDGET_MODE_INFINITE' && tc.operation_status === 'DISABLE' && tg.budget === 25 && JSON.stringify(tg.location_ids) === '["2750405"]' && tg.placements[0] === 'PLACEMENT_TIKTOK' && tg.operation_status === 'DISABLE', r.body);
    check('video uploaded, SINGLE_VIDEO ad with cover image and UTM landing page', tiktokCalls.some((c) => c.path === '/file/video/ad/upload/') && ta.ad_format === 'SINGLE_VIDEO' && ta.video_id === 'vid1' && ta.image_ids[0] === 'img1' && /utm_source=tiktok/.test(ta.landing_page_url));
    reset();
    r = await call('/api/publish/tiktok', { pkg: Object.assign({}, tkVideo, { tiktokAds: Object.assign({}, tkVideo.tiktokAds, { budget: 15 }) }), campId: 't3' });
    check('budget 15 → 422 (TikTok minimum), nothing created', r.status === 422 && r.body.issues.some((i) => i.code === 'tiktok_budget_min') && tiktokCalls.length === 0);
    reset();
    failOn.match = (c) => c.host === 'tiktok' && c.path === '/ad/create/'; failOn.times = 1;
    r = await call('/api/publish/tiktok', { pkg: tkVideo, campId: 't4' });
    check('TikTok error → ad group and campaign deleted (rollback)', r.status >= 400 && tiktokCalls.some((c) => c.path === '/adgroup/status/update/' && c.body.operation_status === 'DELETE') && tiktokCalls.some((c) => c.path === '/campaign/status/update/'));

    console.log('\nE. Pinterest');
    const pinPkg = basePkg('pinterest', { pinterestAds: { title: 'Linen for summer', description: 'Breathable linen shirts', altText: 'A linen shirt', cta: 'Shop now', budget: 15 } });
    reset();
    r = await call('/api/publish/pinterest', { pkg: pinPkg, campId: 'p1' });
    const pAg = pinCalls.find((c) => c.method === 'POST' && /ad_groups$/.test(c.path)).body;
    check('published: campaign PAUSED, LOCATION array, SALES conversion tag metadata', r.status === 200 && pinCalls.find((c) => /campaigns$/.test(c.path) && c.method === 'POST').body.status === 'PAUSED' && JSON.stringify(pAg.targeting_spec.LOCATION) === '["NL"]' && pAg.optimization_goal_metadata.conversion_tag_v3_goal_metadata.conversion_tag_id === 'tag1', r.body);
    check('pins created from the images with UTM link; ads PAUSED', pinCalls.filter((c) => c.method === 'PIN').length === 2 && pinCalls.filter((c) => c.method === 'PIN').every((c) => /utm_source=pinterest/.test(c.body.link)) && pinCalls.filter((c) => c.method === 'POST' && /\/ads$/.test(c.path)).every((c) => c.body.status === 'PAUSED'));
    reset();
    facts.tags = [];
    r = await call('/api/publish/pinterest', { pkg: pinPkg, campId: 'p2' });
    check('Sales without a Pinterest Tag → 422, nothing created', r.status === 422 && r.body.issues.some((i) => i.code === 'tag_none') && !pinCalls.some((c) => c.method === 'POST'));
    facts.tags = [{ id: 'tag1', name: 'Tag' }];
    reset();
    failOn.match = (c) => c.host === 'pinterest' && c.method === 'POST' && /\/ads$/.test(c.path); failOn.times = 1;
    r = await call('/api/publish/pinterest', { pkg: pinPkg, campId: 'p3' });
    check('Pinterest error → ad groups/campaign archived and pins deleted (rollback)', r.status === 400 && pinCalls.some((c) => c.method === 'ARCHIVE' && c.path === 'campaigns') && pinCalls.some((c) => c.method === 'DELETE'));

    console.log('\nF. Oriven Chat tool');
    require('../tools/adEditTools');
    const toolRouter = require('../services/toolRouter');
    let t = await toolRouter.resolveTool('edit_campaign_settings', { changes: { countries: ['Germany'], budget: 30, placement: 'instagram_only' } }, { user: { id: 'u1' }, currentCampaign: { pkg: Object.assign(basePkg('meta'), { platform: 'meta' }) } });
    check('Chat edit applied and re-validated with live facts', t.ok && t.executed && t.execResult.spec.targeting.countries[0] === 'DE' && t.execResult.pkg.metaAds.budget === 30 && Array.isArray(t.execResult.issues) && /Countries: Germany/.test(t.message), t);
    check('Chat result names what is still needed before publishing', /Still needed before publishing/.test(t.message) && t.execResult.issues.some((i) => i.code === 'special_categories_unconfirmed'));
    t = await toolRouter.resolveTool('edit_campaign_settings', { changes: { countries: ['Atlantis'] } }, { user: { id: 'u1' }, currentCampaign: { pkg: Object.assign(basePkg('meta'), { platform: 'meta' }) } });
    check('Chat: unknown country → asks instead of guessing', t.ok && !!t.clarification && /couldn’t recognise/.test(t.clarification));
  } catch (e) {
    console.log('CRASH', e && e.stack || e); fail++;
  }
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  server.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
});
