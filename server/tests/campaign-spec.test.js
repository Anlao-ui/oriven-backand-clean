// ════════════════════════════════════════════════════════════════
// Campaign spec — derivation, smart defaults, validation, Chat edits and
// payload shapes for Meta, Google (Search / Performance Max / Demand Gen),
// TikTok and Pinterest. Pure unit tests: no network, no database.
// RUN: node tests/campaign-spec.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const S = require('../services/campaignSpec');

let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 500))); };
const codes = (issues, level) => issues.filter((i) => !level || i.level === level).map((i) => i.code);
const errs = (spec, ctx) => codes(S.validate(spec, ctx), 'error');

const basePkg = (platform, extra) => Object.assign({
  campaignName: 'Summer Linen Drop', platform,
  strategy: { goal: 'Sales', targetAudience: 'Women 25–45 who like linen', budgetRecommendation: '€20–30 per day' },
  visualConcepts: [{ conceptRef: 'a', generatedImageUrl: 'https://cdn.example.invalid/a.png' }, { conceptRef: 'b', generatedImageUrl: 'https://cdn.example.invalid/b.png' }],
  concepts: [{ angle: 'a', adCopy: { headline: 'Linen that breathes', primaryText: 'Stay cool all summer in pure linen.', description: 'Free returns' }, cta: 'Shop now' },
             { angle: 'b', adCopy: { headline: 'Made to last', primaryText: 'European linen, sewn to last for years.' }, cta: 'Learn more' }],
}, extra || {});
const profile = { company_name: 'Linnen & Co', website: 'linnenco.nl', country: 'Nederland', languages: null, logo_url: 'https://cdn.example.invalid/logo.png' };

console.log('\nA. Countries and languages — read, never guessed');
check('country names, codes and native names', JSON.stringify(S.parseCountries('Nederland')) === '["NL"]' && JSON.stringify(S.parseCountries('Germany and Austria')) === '["DE","AT"]' && JSON.stringify(S.parseCountries(['us', 'UK'])) === '["US","GB"]' && JSON.stringify(S.parseCountries('The Netherlands, België')) === '["NL","BE"]');
check('anything uncertain → null (asks): city, region, typo, empty', S.parseCountries('Amsterdam') === null && S.parseCountries('Benelux') === null && S.parseCountries('Germny') === null && S.parseCountries('') === null && S.parseCountries(null) === null);
check('languages', JSON.stringify(S.parseLanguages('English, Dutch')) === '["en","nl"]' && JSON.stringify(S.parseLanguages(['de'])) === '["de"]' && S.parseLanguages('Klingon') === null);
check('EU membership (DSA rule)', S.isEu('NL') && S.isEu('BG') && !S.isEu('US') && !S.isEu('CH') && !S.isEu('GB'));

console.log('\nB. Geographic rule: profile country, saved preference, or ask');
let spec = S.buildSpec(basePkg('meta'), 'meta', { profile });
check('business profile country "Nederland" → NL, source profile', JSON.stringify(spec.targeting.countries) === '["NL"]' && spec.sources.countries === 'profile');
spec = S.buildSpec(basePkg('meta'), 'meta', { profile: Object.assign({}, profile, { country: null }), preferences: { adCountries: ['BE'] } });
check('no profile country → saved advertising preference', JSON.stringify(spec.targeting.countries) === '["BE"]');
spec = S.buildSpec(basePkg('meta'), 'meta', { profile: Object.assign({}, profile, { country: 'Amsterdam area' }) });
check('unreadable country → none, source missing, publishing blocked (never the US)', spec.targeting.countries.length === 0 && spec.sources.countries === 'missing' && errs(spec, { options: {} }).includes('country_missing'));
for (const p of S.PLATFORMS) {
  const sp = S.buildSpec(basePkg(p), p, { profile: {} });
  if (sp.targeting.countries.length || !errs(sp, { options: {} }).includes('country_missing')) { check('no default country on ' + p, false, sp.targeting.countries); }
}
check('no platform ever defaults to a country', true);
const user = S.applyChanges(basePkg('meta'), 'meta', { countries: ['DE'] });
spec = S.buildSpec(user.pkg, 'meta', { profile });
check('the user’s choice wins over the profile', JSON.stringify(spec.targeting.countries) === '["DE"]' && spec.sources.countries === 'user');

console.log('\nC. Spend is the user’s decision');
spec = S.buildSpec(basePkg('meta'), 'meta', { profile });
check('AI budget text is only a suggestion; publishing blocked until confirmed', spec.budget.amount === null && spec.budget.suggestion === 20 && errs(spec, { options: {} }).includes('budget_unconfirmed'));
const b = S.applyChanges(basePkg('meta'), 'meta', { budget: '€25' });
check('confirmed budget is stored where the budget dialog stores it', b.pkg.metaAds.budget === 25 && S.buildSpec(b.pkg, 'meta', { profile }).budget.amount === 25);
const gb = S.applyChanges(basePkg('google'), 'google', { budget: 40 });
check('Google budget stored as {amount} like the budget dialog', gb.pkg.strategy.budgetRecommendation.amount === 40);
check('TikTok budget must exceed 20', S.applyChanges(basePkg('tiktok'), 'tiktok', { budget: 20 }).rejected.length === 1 && S.applyChanges(basePkg('tiktok'), 'tiktok', { budget: 21 }).applied.length === 1);

console.log('\nD. Meta: complete, valid campaign');
const metaOpts = { pixels: [{ id: 'px1', name: 'Shop' }, { id: 'px2', name: 'Old' }], pageId: 'pg1', instagramChecked: true, instagramUserId: 'ig1', currency: 'EUR' };
let mp = basePkg('meta', { metaStructure: { adSets: 2, adsPerAdSet: 2 } });
spec = S.buildSpec(mp, 'meta', { profile, options: metaOpts });
let e = errs(spec, { options: metaOpts });
check('needs: budget, special category declaration, pixel choice (2 pixels → never auto-picked)', e.includes('budget_unconfirmed') && e.includes('special_categories_unconfirmed') && e.includes('pixel_choose') && !e.includes('country_missing'), e);
check('EU country → payer/beneficiary from business name', spec.compliance.euTargeted && spec.compliance.dsaBeneficiary === 'Linnen & Co');
check('one pixel on the account → selected automatically and shown as auto', S.buildSpec(mp, 'meta', { profile, options: Object.assign({}, metaOpts, { pixels: [{ id: 'px9' }] }) }).tracking.pixelId === 'px9');
check('no pixel → Sales blocked with an explanation', errs(S.buildSpec(mp, 'meta', { profile, options: Object.assign({}, metaOpts, { pixels: [] }) }), { options: Object.assign({}, metaOpts, { pixels: [] }) }).includes('pixel_none'));
mp = S.applyChanges(mp, 'meta', { budget: 25, specialAdCategories: [], languages: ['nl'] }).pkg;
mp.spec.overrides.pixelId = 'px1';
spec = S.buildSpec(mp, 'meta', { profile, options: metaOpts });
check('all required settings present → no errors', errs(spec, { options: metaOpts }).length === 0, errs(spec, { options: metaOpts }));
check('hierarchy: 2 ad sets × 2 ads', spec.adGroups.length === 2 && spec.adGroups.every((g) => g.ads.length === 2));
const mc = S.payloads.meta.campaign(spec);
check('campaign: objective, PAUSED, special_ad_categories, budget-sharing flag; no invalid budget_optimization_type', mc.objective === 'OUTCOME_SALES' && mc.status === 'PAUSED' && Array.isArray(mc.special_ad_categories) && mc.is_adset_budget_sharing_enabled === false && !('budget_optimization_type' in mc));
const ms = S.payloads.meta.adSet(spec, 0, { localeKeys: [14] }, 'c1');
check('ad set: countries, ages, Advantage+ audience flag, locales, optimisation, pixel+event, DSA, PAUSED', JSON.stringify(ms.targeting.geo_locations.countries) === '["NL"]' && ms.targeting.age_min === 18 && ms.targeting.age_max === 65 && ms.targeting.targeting_automation.advantage_audience === 1 && JSON.stringify(ms.targeting.locales) === '[14]' && ms.optimization_goal === 'OFFSITE_CONVERSIONS' && ms.billing_event === 'IMPRESSIONS' && ms.promoted_object.pixel_id === 'px1' && ms.promoted_object.custom_event_type === 'PURCHASE' && ms.dsa_beneficiary && ms.dsa_payor && ms.status === 'PAUSED' && ms.daily_budget === 2500 && ms.destination_type === 'WEBSITE' && !('is_adset_budget_sharing_enabled' in ms), ms);
const cr = S.payloads.meta.creative(spec, spec.adGroups[0].ads[0], { imageHashes: { 'https://cdn.example.invalid/a.png': 'h1' } });
check('creative: Page + Instagram identity, image_hash (not a provider URL), CTA, link, UTM url_tags', cr.object_story_spec.page_id === 'pg1' && cr.object_story_spec.instagram_user_id === 'ig1' && cr.object_story_spec.link_data.image_hash === 'h1' && !cr.object_story_spec.link_data.picture && cr.object_story_spec.link_data.call_to_action.type === 'SHOP_NOW' && cr.object_story_spec.link_data.link === 'https://linnenco.nl' && /utm_source=facebook&utm_medium=paid_social&utm_campaign=summer-linen-drop/.test(cr.url_tags));
check('ad: PAUSED', S.payloads.meta.ad(spec, spec.adGroups[0].ads[0], 's', 'c').status === 'PAUSED');
let r = S.applyChanges(mp, 'meta', { placement: 'instagram', ageMin: 25, ageMax: 45 });
spec = S.buildSpec(r.pkg, 'meta', { profile, options: metaOpts });
check('Chat: Instagram only + ages 25–45 → publisher_platforms instagram, Advantage+ audience off for a custom range', S.payloads.meta.adSet(spec, 0, {}, 'c').targeting.publisher_platforms[0] === 'instagram' && S.payloads.meta.adSet(spec, 0, {}, 'c').targeting.targeting_automation.advantage_audience === 0 && spec.targeting.ageMin === 25);
check('Instagram only without an Instagram account → blocked', errs(S.buildSpec(r.pkg, 'meta', { profile, options: Object.assign({}, metaOpts, { instagramUserId: null }) }), { options: Object.assign({}, metaOpts, { instagramUserId: null }) }).includes('instagram_missing'));
r = S.applyChanges(mp, 'meta', { specialAdCategories: ['credit'] });
spec = S.buildSpec(r.pkg, 'meta', { profile, options: metaOpts });
check('special category: CREDIT → FINANCIAL_PRODUCTS_SERVICES + special_ad_category_country', JSON.stringify(S.payloads.meta.campaign(spec).special_ad_categories) === '["FINANCIAL_PRODUCTS_SERVICES"]' && JSON.stringify(S.payloads.meta.campaign(spec).special_ad_category_country) === '["NL"]');
r = S.applyChanges(mp, 'meta', { goal: 'Traffic' });
spec = S.buildSpec(r.pkg, 'meta', { profile, options: metaOpts });
check('Chat: objective → Traffic brings LINK_CLICKS and drops the pixel requirement (dependent fields follow)', spec.campaign.objective === 'OUTCOME_TRAFFIC' && spec.optimization.goal === 'LINK_CLICKS' && !spec.tracking.needsConversion && !('promoted_object' in S.payloads.meta.adSet(spec, 0, {}, 'c')));
r = S.applyChanges(mp, 'meta', { addAdGroup: { name: '45+', ageMin: 45, ageMax: 65 } });
spec = S.buildSpec(r.pkg, 'meta', { profile, options: metaOpts });
check('Chat: add an ad set for a different audience', spec.adGroups.length === 3 && spec.adGroups[2].name === '45+' && S.payloads.meta.adSet(spec, 2, {}, 'c').targeting.age_min === 45);
check('Chat: unrelated settings preserved (pixel, budget, languages)', spec.tracking.pixelId === 'px1' && spec.budget.amount === 25 && JSON.stringify(spec.targeting.languages) === '["nl"]');
r = S.applyChanges(mp, 'meta', { countries: 'Amsterdam', goal: 'Engagement please' });
check('Chat: invalid values refused with reasons, nothing coerced', r.applied.length === 0 && r.rejected.length === 2);

console.log('\nE. Google Search');
const gpkg = basePkg('google', {
  strategy: { goal: 'Leads', budgetRecommendation: { amount: 30 } },
  googleAds: { campaignType: 'SEARCH', headlines: ['Linen shirts for summer', 'Free returns in NL', 'Made in Europe', 'This headline is far too long to be used by Google'], descriptions: ['Shop breathable linen shirts with free returns.', 'Order today, delivered tomorrow.'],
    keywords: ['linen shirt', 'linnen overhemd', 'linen shirt men'], negativeKeywords: ['free', 'diy'], callouts: ['Free returns', 'Ships in 24h', 'A callout that is much too long for Google'], structuredSnippetHeader: 'Styles', structuredSnippets: ['Casual', 'Formal', 'Relaxed'], sitelinks: ['Men', 'Women'] },
  campaignStructure: { groups: 2, adsPerGroup: 1 },
});
const gOpts = { conversionActions: 2, currency: 'EUR' };
spec = S.buildSpec(gpkg, 'google', { profile, options: gOpts });
let gi = S.validate(spec, { options: gOpts });
check('Search valid; long headline/callout warned, sitelinks without URL explained', codes(gi, 'error').length === 0 && codes(gi, 'warning').includes('headline_long') && codes(gi, 'warning').includes('callout_long') && codes(gi, 'info').includes('sitelink_urls'), gi);
const gc = S.payloads.google.campaign(spec, 'budgets/1');
check('campaign: SEARCH, PAUSED, network settings, EU political declaration, bidding, final URL suffix', gc.advertisingChannelType === 'SEARCH' && gc.status === 'PAUSED' && gc.networkSettings.targetGoogleSearch === true && gc.networkSettings.targetContentNetwork === false && gc.containsEuPoliticalAdvertising === 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' && 'maximizeConversions' in gc && /utm_source=google&utm_medium=cpc/.test(gc.finalUrlSuffix));
const crit = S.payloads.google.targetingCriteria(spec, { geoTargetConstants: ['geoTargetConstants/2528'], languageConstants: ['languageConstants/1010'] }, 'campaign', 'c/1');
check('location + language criteria', crit.some((c) => c.location && c.location.geoTargetConstant === 'geoTargetConstants/2528') && crit.some((c) => c.language));
check('negative keywords sent (were generated and discarded before)', S.payloads.google.negativeKeywords(spec, 'c/1').length === 2 && S.payloads.google.negativeKeywords(spec, 'c/1')[0].negative === true);
let sa = S.payloads.google.searchAssets(spec);
check('callouts (≤25) and structured snippet sent; sitelinks without URL not sent', sa.filter((x) => x.fieldType === 'CALLOUT').length === 2 && sa.some((x) => x.fieldType === 'STRUCTURED_SNIPPET' && x.asset.structuredSnippetAsset.header === 'Styles') && !sa.some((x) => x.fieldType === 'SITELINK'));
const withSl = S.applyChanges(gpkg, 'google', { sitelink: { text: 'Men', url: 'https://linnenco.nl/men' } });
sa = S.payloads.google.searchAssets(S.buildSpec(withSl.pkg, 'google', { profile, options: gOpts }));
check('Chat: sitelink with URL → sent', sa.some((x) => x.fieldType === 'SITELINK' && x.asset.sitelinkAsset.linkText === 'Men' && x.asset.finalUrls[0] === 'https://linnenco.nl/men'));
check('2 ad groups with keywords split, RSA headlines ≤30 only', spec.adGroups.length === 2 && spec.adGroups.every((g) => g.keywords.length) && S.payloads.google.rsa(spec, spec.adGroups[0].ads[0], 'ag').ad.responsiveSearchAd.headlines.every((h) => h.text.length <= 30));
check('no conversion action → Leads blocked', codes(S.validate(S.buildSpec(gpkg, 'google', { profile, options: { conversionActions: 0 } }), { options: { conversionActions: 0 } }), 'error').includes('google_conversions_none'));
check('Chat: headline over 30 chars refused', S.applyChanges(gpkg, 'google', { headlines: ['x'.repeat(31)] }).rejected.length === 1);

console.log('\nF. Google Performance Max + Demand Gen');
const ppkg = Object.assign({}, gpkg, { strategy: { goal: 'Sales', budgetRecommendation: { amount: 30 } }, googleAds: Object.assign({}, gpkg.googleAds, { campaignType: 'PERFORMANCE_MAX', pmaxLandscapeImageUrl: 'https://cdn.example.invalid/land.png', longHeadline: 'Breathable European linen for warm summer days' }) });
spec = S.buildSpec(ppkg, 'google', { profile, options: gOpts });
check('PMax valid with logo, business name, both images, short description', codes(S.validate(spec, { options: gOpts }), 'error').length === 0, codes(S.validate(spec, { options: gOpts }), 'error'));
check('PMax campaign has brand guidelines enabled (business name + logo at campaign level)', S.payloads.google.campaign(spec, 'b').brandGuidelinesEnabled === true);
const pt = S.payloads.google.pmaxText(spec);
check('PMax text: ≥3 headlines ≤30, long headline ≤90, first description ≤60, business name ≤25', pt.headlines.length >= 3 && pt.headlines.every((h) => h.length <= 30) && pt.longHeadline.length <= 90 && pt.descriptions[0].length <= 60 && pt.businessName.length <= 25);
check('PMax without logo or landscape image → blocked', codes(S.validate(S.buildSpec(Object.assign({}, ppkg, { googleAds: Object.assign({}, ppkg.googleAds, { pmaxLandscapeImageUrl: null }) }), 'google', { profile: Object.assign({}, profile, { logo_url: null }), options: gOpts }), { options: gOpts }), 'error').filter((c) => c === 'logo_missing' || c === 'landscape_missing').length === 2);
const dpkg = Object.assign({}, ppkg, { googleAds: Object.assign({}, ppkg.googleAds, { campaignType: 'DEMAND_GEN', pmaxLandscapeImageUrl: null }) });
spec = S.buildSpec(dpkg, 'google', { profile, options: gOpts });
const dg = S.payloads.google.demandGenAd(spec, { logoAsset: 'a/logo', squareAsset: 'a/sq', landscapeAsset: null }, 'ag/1');
check('Demand Gen: logo images + square image in square slot; no landscape slot without a landscape image', dg.ad.demandGenMultiAssetAd.logoImages[0].asset === 'a/logo' && dg.ad.demandGenMultiAssetAd.squareMarketingImages[0].asset === 'a/sq' && !dg.ad.demandGenMultiAssetAd.marketingImages && dg.ad.demandGenMultiAssetAd.headlines.every((h) => h.text.length <= 40));
check('Demand Gen location/language are ad-group criteria', S.payloads.google.targetingCriteria(spec, { geoTargetConstants: ['g/1'] }, 'adGroup', 'ag/1')[0].adGroup === 'ag/1');
check('unsupported Google type (Shopping) → blocked, not swapped', codes(S.validate(S.buildSpec(Object.assign({}, gpkg, { googleAds: { campaignType: 'SHOPPING' } }), 'google', { profile, options: gOpts }), { options: gOpts }), 'error').includes('google_type'));

console.log('\nG. TikTok');
const tOpts = { identityId: 'id1', identityType: 'CUSTOMIZED_USER', currency: 'EUR' };
let tpkg = basePkg('tiktok', { strategy: { goal: 'Traffic' }, tiktokAds: { hook: 'Linen season', script: '[0:00] Hook. [0:05] Show the shirt.', cta: 'Shop now', budget: 25 } });
spec = S.buildSpec(tpkg, 'tiktok', { profile, options: tOpts });
check('image-only TikTok campaign → blocked (feed ads are videos)', errs(spec, { options: tOpts }).includes('tiktok_video'));
tpkg.videoAssets = [{ videoUrl: 'https://cdn.example.invalid/v.mp4' }];
spec = S.buildSpec(tpkg, 'tiktok', { profile, options: tOpts });
check('video + Traffic + budget 25 → valid', errs(spec, { options: tOpts }).length === 0, errs(spec, { options: tOpts }));
check('script timestamps removed from ad text, ≤100 chars', !/\[0:/.test(spec.adGroups[0].ads[0].adText) && spec.adGroups[0].ads[0].adText.length <= 100);
const tc = S.payloads.tiktok.campaign(spec, 'adv');
const ta = S.payloads.tiktok.adGroup(spec, 0, { locationIds: ['2750405'] }, 'adv', 'c1', '2026-10-14 10:00:00');
check('campaign budget unlimited, ad group budget 25/day, disabled', tc.budget_mode === 'BUDGET_MODE_INFINITE' && !('budget' in tc) && tc.operation_status === 'DISABLE' && ta.budget === 25 && ta.budget_mode === 'BUDGET_MODE_DAY' && ta.operation_status === 'DISABLE');
check('ad group: location_ids, TikTok placement, promotion type, optimisation, bid type, identity', JSON.stringify(ta.location_ids) === '["2750405"]' && JSON.stringify(ta.placements) === '["PLACEMENT_TIKTOK"]' && ta.promotion_type === 'WEBSITE' && ta.optimization_goal === 'CLICK' && ta.bid_type === 'BID_TYPE_NO_BID' && ta.identity_id === 'id1');
const tad = S.payloads.tiktok.ad(spec, spec.adGroups[0].ads[0], { videoId: 'v1', coverImageId: 'i1' }, 'adv', 'ag1').creatives[0];
check('ad: SINGLE_VIDEO with cover image, CTA, landing page with UTM', tad.ad_format === 'SINGLE_VIDEO' && tad.video_id === 'v1' && tad.image_ids[0] === 'i1' && /utm_source=tiktok/.test(tad.landing_page_url) && tad.operation_status === 'DISABLE');
check('Sales/Leads on TikTok → blocked with the reason (not swapped to another objective)', errs(S.buildSpec(Object.assign({}, tpkg, { strategy: { goal: 'Sales' } }), 'tiktok', { profile, options: tOpts }), { options: tOpts }).includes('tiktok_goal') && S.applyChanges(tpkg, 'tiktok', { goal: 'Leads' }).rejected.length === 1);
check('ages 25–44 → TikTok age buckets', JSON.stringify(S.payloads.tiktok.adGroup(S.buildSpec(S.applyChanges(tpkg, 'tiktok', { ageMin: 25, ageMax: 44 }).pkg, 'tiktok', { profile, options: tOpts }), 0, { locationIds: ['1'] }, 'a', 'c', 's').age_groups) === '["AGE_25_34","AGE_35_44"]');

console.log('\nH. Pinterest');
const pOpts = { conversionTags: [{ id: 't1', name: 'Shop tag' }], currency: 'EUR' };
let pp = basePkg('pinterest', { pinterestAds: { title: 'Linen for summer', description: 'Breathable linen shirts', altText: 'A linen shirt on a hanger', cta: 'Shop now', budget: 15 } });
spec = S.buildSpec(pp, 'pinterest', { profile, options: pOpts });
check('Sales + one tag → tag auto-selected, valid', spec.tracking.conversionTagId === 't1' && errs(spec, { options: pOpts }).length === 0, errs(spec, { options: pOpts }));
const pag = S.payloads.pinterest.adGroup(spec, 0, 'c1');
check('targeting_spec LOCATION is an array of country codes (was an invalid object)', Array.isArray(pag.targeting_spec.LOCATION) && pag.targeting_spec.LOCATION[0] === 'NL' && !pag.targeting_spec.LOCATION.country_codes);
check('SALES: conversion tag + CHECKOUT in optimization_goal_metadata, impression billing', pag.optimization_goal_metadata.conversion_tag_v3_goal_metadata.conversion_tag_id === 't1' && pag.optimization_goal_metadata.conversion_tag_v3_goal_metadata.conversion_event === 'CHECKOUT' && pag.billable_event === 'IMPRESSION' && pag.status === 'PAUSED');
check('Sales without any Pinterest Tag → blocked', errs(S.buildSpec(pp, 'pinterest', { profile, options: { conversionTags: [] } }), { options: { conversionTags: [] } }).includes('tag_none'));
const aw = S.buildSpec(S.applyChanges(pp, 'pinterest', { goal: 'Awareness' }).pkg, 'pinterest', { profile, options: pOpts });
check('Awareness: no conversion metadata', !('optimization_goal_metadata' in S.payloads.pinterest.adGroup(aw, 0, 'c')) && S.payloads.pinterest.campaign(aw).objective_type === 'AWARENESS' && S.payloads.pinterest.campaign(aw).status === 'PAUSED');
check('ad: destination with UTM, PAUSED', /utm_source=pinterest/.test(S.payloads.pinterest.ad(spec, spec.adGroups[0].ads[0], 'ag', 'pin').destination_url) && S.payloads.pinterest.ad(spec, spec.adGroups[0].ads[0], 'ag', 'pin').status === 'PAUSED');

console.log('\nI. Every platform: paused, destination required, summary matches the payload');
for (const p of S.PLATFORMS) {
  const sp = S.buildSpec(Object.assign(basePkg(p), { strategy: { goal: 'Traffic' } }), p, { profile: { country: 'NL' } });
  check(p + ': status PAUSED and destination required', sp.status === 'PAUSED' && errs(sp, { options: {} }).includes('url_missing'));
}
spec = S.buildSpec(mp, 'meta', { profile, options: metaOpts });
const sum = S.summary(spec);
check('summary = what is sent (countries, budget, ad sets, ads)', JSON.stringify(sum.countries) === JSON.stringify(S.payloads.meta.adSet(spec, 0, {}, 'c').targeting.geo_locations.countries) && sum.budget * 100 === S.payloads.meta.adSet(spec, 0, {}, 'c').daily_budget && sum.adGroups === 2 && sum.ads === 4);
check('backwards compatible: an old package without pkg.spec still builds', !!S.buildSpec({ campaignName: 'Old', metaAds: { headline: 'x', primaryText: 'y' } }, 'meta', {}));

console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
