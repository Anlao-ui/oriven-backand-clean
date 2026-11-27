// ════════════════════════════════════════════════════════════════
// Campaign spec — manual Create capabilities (services/campaignSpec.js):
// several ad groups and ads with their own content, Meta video, Google
// Display and Demand Gen YouTube video, TikTok objectives, platform limits,
// and backward compatibility for packages without per-ad content.
// Pure unit tests: no network, no database.
// RUN: node tests/campaign-spec-v2.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const S = require('../services/campaignSpec');
let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 700))); };
const ctx = { profile: { company_name: 'Amber & Clay', logo_url: 'https://cdn.example.invalid/logo.png', country: 'Netherlands' },
  options: { pageId: '123', instagramUserId: '456', pixels: [{ id: 'px1' }], conversionActions: 2, conversionTags: [{ id: 't1' }], identityId: 'id1', identityType: 'CUSTOMIZED_USER', profileId: 'pr1', currency: 'EUR' } };
const IMG = (n) => 'https://cdn.example.invalid/img' + n + '.jpg';
const VID = (n) => 'https://cdn.example.invalid/vid' + n + '.mp4';
const errors = (spec) => S.validate(spec, ctx).filter((i) => i.level === 'error');
const codes = (spec) => S.validate(spec, ctx).map((i) => i.code);
const pkgOf = (platform, o, groups, extra) => Object.assign({
  campaignName: 'Autumn', creationMode: 'manual', strategy: { goal: 'Traffic', landingPageUrl: 'https://shop.example/a' },
  spec: { overrides: { countries: ['NL'], ageMin: 18, ageMax: 65, adGroups: groups, specialAdCategories: [] } },
  campaignStructure: { groups: groups.length, adsPerGroup: Math.max.apply(null, groups.map((g) => g.ads.length)) },
}, { [{ meta: 'metaAds', google: 'googleAds', tiktok: 'tiktokAds', pinterest: 'pinterestAds', snapchat: 'snapchatAds' }[platform]]: Object.assign({ budget: 30 }, o) }, extra || {}, platform === 'google' ? { strategy: Object.assign({ goal: 'Traffic', landingPageUrl: 'https://shop.example/a' }, (extra && extra.strategy) || {}, { budgetRecommendation: { amount: 30 } }) } : {});

console.log('\nA. Backward compatibility');
{
  const old = { campaignName: 'Old', strategy: { goal: 'Sales', landingPageUrl: 'https://shop.example' }, metaStructure: { adSets: 2, adsPerAdSet: 2 },
    concepts: [{ angle: 'a', adCopy: { headline: 'H1', primaryText: 'P1' } }, { angle: 'b', adCopy: { headline: 'H2', primaryText: 'P2' } }], metaAds: { budget: 20, imageUrl: IMG(1) },
    spec: { overrides: { countries: ['NL'], specialAdCategories: [], adGroups: [{ name: 'Named group' }] } } };
  const s = S.buildSpec(old, 'meta', ctx);
  check('A1. an existing package (no per-ad content) keeps its structure: 2 ad sets × 2 ads, copy cycled from the concepts, group names kept', !s.structure.explicit && s.adGroups.length === 2 && s.adGroups.every((g) => g.ads.length === 2) && s.adGroups[0].name === 'Named group' && s.adGroups[0].ads[1].headline === 'H2' && s.adGroups[0].ads[0].imageUrl === IMG(1));
  const oldTT = { campaignName: 'Old TT', strategy: { goal: 'Awareness', landingPageUrl: 'https://shop.example' }, tiktokAds: { budget: 30, objective: 'Video Views', videoUrl: VID(1) }, spec: { overrides: { countries: ['NL'] } } };
  const t = S.buildSpec(oldTT, 'tiktok', ctx);
  check('A2. an older TikTok package that carried "Video Views" publishes as before (goal objective REACH, with the warning) — unchanged', t.campaign.objective === 'REACH' && codes(t).includes('objective_unsupported'));
}

console.log('\nB. Several ad groups and ads with their own content');
{
  const groups = [
    { name: 'Gift buyers', ageMin: 25, ageMax: 54, ads: [{ name: 'Gift A', headline: 'Gift H1', primaryText: 'Gift P1', imageUrl: IMG(1), cta: 'Shop now' }, { headline: 'Gift H2', primaryText: 'Gift P2', imageUrl: IMG(2) }] },
    { name: 'Candle lovers', ads: [{ headline: 'Love H1', primaryText: 'Love P1', imageUrl: IMG(3) }] },
  ];
  const s = S.buildSpec(pkgOf('meta', { imageUrl: IMG(1) }, groups), 'meta', ctx);
  check('B1. Meta: 2 ad sets with 2 and 1 ads, each ad its own copy, image and name; per-ad-set age range', s.structure.explicit && s.adGroups.length === 2 && s.adGroups[0].ads.length === 2 && s.adGroups[1].ads.length === 1 && s.adGroups[0].ads[0].name === 'Gift A' && s.adGroups[0].ads[1].headline === 'Gift H2' && s.adGroups[1].ads[0].imageUrl === IMG(3) && s.adGroups[0].ageMin === 25, s.adGroups);
  check('B2. no errors for the complete multi-group Meta campaign', errors(s).length === 0, errors(s));
  const ids = { imageHashes: { [IMG(1)]: 'h1', [IMG(2)]: 'h2', [IMG(3)]: 'h3' } };
  const cr = s.adGroups.flatMap((g) => g.ads.map((a) => S.payloads.meta.creative(s, a, ids)));
  check('B3. Meta payloads: one creative per ad with that ad’s image hash and copy', cr.length === 3 && cr[0].object_story_spec.link_data.image_hash === 'h1' && cr[1].object_story_spec.link_data.image_hash === 'h2' && cr[2].object_story_spec.link_data.message === 'Love P1');
  check('B4. Meta ad set payload carries the group’s own age range', S.payloads.meta.adSet(s, 0, {}, 'c1').targeting.age_min === 25 && S.payloads.meta.adSet(s, 1, {}, 'c1').targeting.age_min === 18);
  const noImg = S.buildSpec(pkgOf('meta', {}, [{ name: 'G', ads: [{ headline: 'H', primaryText: 'P' }] }]), 'meta', ctx);
  check('B5. an ad without an image is reported for that ad', errors(noImg).some((e) => e.code === 'image_missing' && /Ad 1 in G/.test(e.message)));
  const many = S.buildSpec(pkgOf('meta', { imageUrl: IMG(1) }, [{ name: 'Big', ads: Array.from({ length: 51 }, (_, i) => ({ headline: 'H' + i, primaryText: 'P', imageUrl: IMG(1) })) }]), 'meta', ctx);
  check('B6. Meta limit: 51 ads in one ad set → error with Meta’s 50-ad limit', errors(many).some((e) => e.code === 'structure_ads' && /50 ads/.test(e.message)));
  const tooMany = S.buildSpec(pkgOf('meta', { imageUrl: IMG(1) }, Array.from({ length: 21 }, (_, i) => ({ name: 'G' + i, ads: [{ headline: 'H', primaryText: 'P', imageUrl: IMG(1) }] }))), 'meta', ctx);
  check('B7. OrivenAI limit: 21 ad sets → error that says it is OrivenAI’s limit (separate requests)', errors(tooMany).some((e) => e.code === 'structure_groups' && /at most 20/.test(e.message)));
  const gs = S.buildSpec(pkgOf('google', { campaignType: 'SEARCH', headlines: ['A', 'B', 'C'], descriptions: ['D one', 'D two'] }, [
    { name: 'Soy', keywords: [{ text: 'soy candles', matchType: 'EXACT' }], ads: [{ headlines: ['Soy 1', 'Soy 2', 'Soy 3'], descriptions: ['Soy d1', 'Soy d2'] }, { headlines: ['Soy 4', 'Soy 5', 'Soy 6'], descriptions: ['Soy d3', 'Soy d4'] }] },
    { name: 'Gifts', keywords: ['candle gift'], ads: [{ headlines: ['Gift 1', 'Gift 2', 'Gift 3'], descriptions: ['Gift d1', 'Gift d2'] }] },
  ]), 'google', ctx);
  check('B8. Google Search: each ad group its own keywords; each RSA its own headlines and descriptions', gs.adGroups[0].keywords[0].text === 'soy candles' && gs.adGroups[0].keywords[0].matchType === 'EXACT' && gs.adGroups[1].keywords[0].matchType === 'PHRASE' && gs.adGroups[0].ads[1].headlines[0] === 'Soy 4' && gs.adGroups[1].ads[0].descriptions[1] === 'Gift d2', gs.adGroups);
  check('B9. Google Search payload: the RSA carries that ad’s own headlines', S.payloads.google.rsa(gs, gs.adGroups[0].ads[1], 'ag/1').ad.responsiveSearchAd.headlines[0].text === 'Soy 4' && errors(gs).length === 0, errors(gs));
  const g4 = S.buildSpec(pkgOf('google', { campaignType: 'SEARCH' }, [{ name: 'G', keywords: ['k'], ads: Array.from({ length: 4 }, () => ({ headlines: ['A', 'B', 'C'], descriptions: ['D1', 'D2'] })) }]), 'google', ctx);
  check('B10. Google limit: 4 responsive search ads in one ad group → error with Google’s 3-ad limit', errors(g4).some((e) => e.code === 'structure_ads' && /3 enabled/.test(e.message)));
}

console.log('\nC. Meta video ads');
{
  const vp = pkgOf('meta', { creativeType: 'video', videoUrl: VID(1) }, [{ name: 'Video set', ads: [{ headline: 'Watch', primaryText: 'Ninety seconds of calm', videoUrl: VID(1), description: 'Free delivery' }, { headline: 'Watch 2', primaryText: 'Two', videoUrl: VID(2) }] }], { inputs: { format: 'video' } });
  const s = S.buildSpec(vp, 'meta', ctx);
  check('C1. Meta video: creative format VIDEO, each ad its own video', s.creative.format === 'VIDEO' && s.adGroups[0].ads[1].videoUrl === VID(2));
  check('C2. a complete Meta video campaign has no errors (and says how Meta video is handled)', errors(s).length === 0 && codes(s).includes('meta_video_spec'), errors(s));
  const ids = { videoIds: { [VID(1)]: 'v1', [VID(2)]: 'v2' }, thumbHashes: { [VID(1)]: 't1', [VID(2)]: 't2' }, imageHashes: {} };
  const c1 = S.payloads.meta.creative(s, s.adGroups[0].ads[0], ids), c2 = S.payloads.meta.creative(s, s.adGroups[0].ads[1], ids);
  check('C3. video creative: object_story_spec.video_data with video_id, thumbnail image_hash, message, title, link_description and CTA with the link — no link_data', c1.object_story_spec.video_data.video_id === 'v1' && c1.object_story_spec.video_data.image_hash === 't1' && c1.object_story_spec.video_data.message === 'Ninety seconds of calm' && c1.object_story_spec.video_data.title === 'Watch' && c1.object_story_spec.video_data.link_description === 'Free delivery' && c1.object_story_spec.video_data.call_to_action.value.link === 'https://shop.example/a' && !c1.object_story_spec.link_data && c2.object_story_spec.video_data.video_id === 'v2' && c1.object_story_spec.page_id === '123' && c1.object_story_spec.instagram_user_id === '456');
  const missing = S.buildSpec(pkgOf('meta', { creativeType: 'video' }, [{ name: 'V', ads: [{ headline: 'H', primaryText: 'P' }] }], { inputs: { format: 'video' } }), 'meta', ctx);
  check('C4. a video ad without a video → error for that ad', errors(missing).some((e) => e.code === 'video_missing'));
  const offline = S.buildSpec(pkgOf('meta', { creativeType: 'video' }, [{ name: 'V', ads: [{ headline: 'H', primaryText: 'P', videoUrl: 'blob:local' }] }], { inputs: { format: 'video' } }), 'meta', ctx);
  check('C5. a video that isn’t stored online → error', errors(offline).some((e) => e.code === 'video_not_online'));
  const img = S.buildSpec(pkgOf('meta', { imageUrl: IMG(1) }, [{ name: 'I', ads: [{ headline: 'H', primaryText: 'P', imageUrl: IMG(1) }] }]), 'meta', ctx);
  check('C6. Meta image ads unchanged: link_data with image_hash', img.creative.format === 'IMAGE' && S.payloads.meta.creative(img, img.adGroups[0].ads[0], { imageHashes: { [IMG(1)]: 'h' } }).object_story_spec.link_data.image_hash === 'h');
}

console.log('\nD. Google Display');
{
  const dp = pkgOf('google', { campaignType: 'DISPLAY', headlines: ['Soy candles'], longHeadline: 'Hand-poured soy candles for slow evenings', descriptions: ['Sixty hours of light.'], imageUrl: IMG(1), pmaxLandscapeImageUrl: IMG(2) },
    [{ name: 'Display 1', ads: [{ headlines: ['A', 'B'], longHeadline: 'Long A', descriptions: ['Desc A'], imageUrl: IMG(3), landscapeImageUrl: IMG(4) }, {}].map((a) => a) }].map((g) => Object.assign(g, { ads: g.ads.map((a) => (Object.keys(a).length ? a : { headlines: ['C'] })) })));
  const s = S.buildSpec(dp, 'google', ctx);
  check('D1. Display: campaign type DISPLAY, Traffic → Maximize clicks (targetSpend), each ad its own texts and images (or the campaign’s)', s.campaignType === 'DISPLAY' && s.campaign.biddingField === 'targetSpend' && s.adGroups[0].ads[0].squareImageUrl === IMG(3) && s.adGroups[0].ads[1].squareImageUrl === IMG(1) && s.adGroups[0].ads[1].landscapeImageUrl === IMG(2) && s.adGroups[0].ads[1].longHeadline === 'Hand-poured soy candles for slow evenings', s.adGroups);
  check('D2. a complete Display campaign has no errors', errors(s).length === 0, errors(s));
  const ag = S.payloads.google.displayAdGroup(s, 0, 'customers/1/campaigns/2');
  const ad = S.payloads.google.responsiveDisplayAd(s, s.adGroups[0].ads[0], { square: 'as/1', landscape: 'as/2', logo: 'as/3' }, 'ag/1');
  const rda = ad.ad.responsiveDisplayAd;
  check('D3. payloads: DISPLAY_STANDARD ad group; responsiveDisplayAd with headlines, longHeadline, descriptions, businessName, marketing + square images and logo, finalUrls', ag.type === 'DISPLAY_STANDARD' && rda.headlines.length === 2 && rda.longHeadline.text === 'Long A' && rda.descriptions[0].text === 'Desc A' && rda.businessName === 'Amber & Clay' && rda.marketingImages[0].asset === 'as/2' && rda.squareMarketingImages[0].asset === 'as/1' && rda.squareLogoImages[0].asset === 'as/3' && ad.ad.finalUrls[0] === 'https://shop.example/a' && ad.status === 'ENABLED', ad);
  const bad = S.buildSpec(pkgOf('google', { campaignType: 'DISPLAY', headlines: ['x'.repeat(31)], descriptions: ['d'], imageUrl: IMG(1) }, [{ name: 'D', ads: [{ headlines: ['x'.repeat(31)] }] }]), 'google', ctx);
  const bc = errors(bad).map((e) => e.code);
  check('D4. Display validation: headline over 30, no long headline, no landscape image → each reported', bc.includes('display_headline_long') && bc.includes('display_long_headline') && bc.includes('display_landscape'), bc);
  const aw = S.buildSpec(Object.assign(dp, { strategy: { goal: 'Awareness', landingPageUrl: 'https://shop.example/a' } }), 'google', ctx);
  check('D5. Awareness isn’t offered for Display (explained), Sales uses Maximize conversions', errors(aw).some((e) => /compat_goal|goal/.test(e.code)) && S.buildSpec(Object.assign(dp, { strategy: { goal: 'Sales', landingPageUrl: 'https://shop.example/a' } }), 'google', ctx).campaign.biddingField === 'maximizeConversions');
  check('D6. Display is in the publishable Google types (shared schema)', S.SUPPORT.google.types.includes('DISPLAY'));
}

console.log('\nE. Google YouTube video ads (Demand Gen)');
{
  const vp = pkgOf('google', { campaignType: 'DEMAND_GEN', format: 'video', youtubeVideo: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', headlines: ['Soy candles'], longHeadlines: ['Hand-poured soy candles that burn sixty hours'], descriptions: ['Free delivery in NL.'] },
    [{ name: 'Video 1', ads: [{}, { youtubeVideo: 'https://youtu.be/abcdefghijk', headlines: ['Second'] }].map((a) => (Object.keys(a).length ? a : { headlines: ['First'] })) }]);
  const s = S.buildSpec(vp, 'google', ctx);
  check('E1. YouTube links → video ids (watch URL and youtu.be), per ad', s.creative.format === 'YOUTUBE_VIDEO' && s.adGroups[0].ads[0].youtubeVideoId === 'dQw4w9WgXcQ' && s.adGroups[0].ads[1].youtubeVideoId === 'abcdefghijk');
  check('E2. a complete YouTube video campaign has no errors and explains the Demand Gen route', errors(s).length === 0 && codes(s).includes('google_video_route'), errors(s));
  const ad = S.payloads.google.demandGenVideoAd(s, s.adGroups[0].ads[0], { logoAsset: 'as/logo', videos: { dQw4w9WgXcQ: 'as/yt1' } }, 'ag/1');
  const v = ad.ad.demandGenVideoResponsiveAd;
  check('E3. payload: demandGenVideoResponsiveAd with headlines, longHeadlines, descriptions, videos (YouTube asset), logoImages and businessName', v.headlines[0].text === 'First' && v.longHeadlines[0].text === 'Hand-poured soy candles that burn sixty hours' && v.descriptions[0].text === 'Free delivery in NL.' && v.videos[0].asset === 'as/yt1' && v.logoImages[0].asset === 'as/logo' && v.businessName.text === 'Amber & Clay', v);
  const ya = S.payloads.google.youtubeAsset(s, 'dQw4w9WgXcQ');
  check('E4. the YouTube asset: type YOUTUBE_VIDEO with youtubeVideoAsset.youtubeVideoId', ya.type === 'YOUTUBE_VIDEO' && ya.youtubeVideoAsset.youtubeVideoId === 'dQw4w9WgXcQ');
  const bad = S.buildSpec(pkgOf('google', { campaignType: 'DEMAND_GEN', format: 'video', youtubeVideo: 'not a video', headlines: ['H'], longHeadlines: ['L'], descriptions: ['D'] }, [{ name: 'V', ads: [{ headlines: ['H'] }] }]), 'google', ctx);
  check('E5. something that isn’t a YouTube link → youtube_invalid', errors(bad).some((e) => e.code === 'youtube_invalid'));
  const noLogo = S.validate(S.buildSpec(vp, 'google', { profile: { company_name: 'X' }, options: ctx.options }), { options: ctx.options });
  check('E6. no logo in the business profile → error (logo required for Demand Gen video)', noLogo.some((e) => e.code === 'logo_missing'));
  check('E7. Google Demand Gen image ads unchanged (no YouTube fields)', (S.buildSpec(pkgOf('google', { campaignType: 'DEMAND_GEN', headlines: ['H'], descriptions: ['D'], imageUrl: IMG(1) }, [{ name: 'G', ads: [{}].map(() => ({ headlines: ['H'] })) }]), 'google', ctx).creative || {}).format !== 'YOUTUBE_VIDEO');
}

console.log('\nF. TikTok objectives and per-ad videos');
{
  const base = (goal, o) => Object.assign(pkgOf('tiktok', Object.assign({ videoUrl: VID(1) }, o), [{ name: 'TT', ads: [{ adText: 'First', videoUrl: VID(1) }, { adText: 'Second', videoUrl: VID(2) }] }], { inputs: { format: 'video' } }), { strategy: { goal, landingPageUrl: 'https://shop.example/a' } });
  const tr = S.buildSpec(base('Traffic'), 'tiktok', ctx), aw = S.buildSpec(base('Awareness'), 'tiktok', ctx), vv = S.buildSpec(base('Awareness', { objective: 'VideoViews' }), 'tiktok', ctx);
  const agp = (s) => S.payloads.tiktok.adGroup(s, 0, { locationIds: ['1'] }, 'adv', 'c1', 'now');
  check('F1. Traffic: TRAFFIC / CLICK / CPC', tr.campaign.objective === 'TRAFFIC' && agp(tr).optimization_goal === 'CLICK' && agp(tr).billing_event === 'CPC' && errors(tr).length === 0, errors(tr));
  check('F2. Awareness: REACH / REACH / CPM', aw.campaign.objective === 'REACH' && agp(aw).optimization_goal === 'REACH' && agp(aw).billing_event === 'CPM' && errors(aw).length === 0);
  check('F3. Video Views (manual Create): VIDEO_VIEWS campaign, VIDEO_VIEW / CPV ad group, no errors', vv.campaign.objective === 'VIDEO_VIEWS' && S.payloads.tiktok.campaign(vv, 'adv').objective_type === 'VIDEO_VIEWS' && agp(vv).optimization_goal === 'VIDEO_VIEW' && agp(vv).billing_event === 'CPV' && errors(vv).length === 0 && codes(vv).includes('tiktok_video_views'), errors(vv));
  check('F4. Sales and Leads stay blocked on TikTok with a reason (pixel event / instant forms not supported)', errors(S.buildSpec(base('Sales'), 'tiktok', ctx)).some((e) => e.code === 'tiktok_goal') && errors(S.buildSpec(base('Leads'), 'tiktok', ctx)).some((e) => e.code === 'tiktok_goal'));
  const ids = { videoIds: { [VID(1)]: 'v1', [VID(2)]: 'v2' }, coverIds: { [VID(1)]: 'c1', [VID(2)]: 'c2' }, videoId: 'v1', coverImageId: 'c1' };
  const a2 = S.payloads.tiktok.ad(tr, tr.adGroups[0].ads[1], ids, 'adv', 'ag').creatives[0];
  check('F5. each TikTok ad its own video, cover and ad text', a2.video_id === 'v2' && a2.image_ids[0] === 'c2' && a2.ad_text === 'Second');
  const noVid = S.buildSpec(Object.assign(base('Traffic'), { spec: { overrides: { countries: ['NL'], adGroups: [{ name: 'TT', ads: [{ adText: 'x', videoUrl: VID(1) }, { adText: 'y', videoUrl: 'local-file' }] }] } } }), 'tiktok', ctx);
  check('F6. an ad whose video isn’t online → error for that ad', errors(noVid).some((e) => e.code === 'video_missing' && /Ad 2/.test(e.message)));
}

console.log('\nG. Pinterest and Snapchat per-ad content');
{
  const pp = pkgOf('pinterest', { title: 'Campaign title', imageUrl: IMG(1) }, [{ name: 'Pins', ads: [{ title: 'Pin one', pinDescription: 'Desc one', imageUrl: IMG(1) }, { title: 'Pin two', imageUrl: IMG(2), altText: 'A candle' }] }], { strategy: { goal: 'Awareness', landingPageUrl: 'https://shop.example/a' } });
  const s = S.buildSpec(pp, 'pinterest', ctx);
  check('G1. Pinterest: each ad its own Pin (title, description, alt text)', s.adGroups[0].ads[0].pin.title === 'Pin one' && s.adGroups[0].ads[0].pin.description === 'Desc one' && s.adGroups[0].ads[1].pin.altText === 'A candle' && errors(s).length === 0, errors(s));
  const sp = pkgOf('snapchat', { brandName: 'Amber & Clay', creativeType: 'video', videoUrl: VID(1) }, [{ name: 'Squad', ads: [{ headline: 'One', videoUrl: VID(1) }, { headline: 'Two' }] }], { inputs: { format: 'video' } });
  const sn = S.buildSpec(sp, 'snapchat', ctx);
  check('G2. Snapchat: per-ad videos, falling back to the campaign video', sn.creative.format === 'VIDEO' && sn.adGroups[0].ads[1].snapHeadline === 'Two' && errors(sn).length === 0, errors(sn));
}

console.log('\n' + (pass + fail) + ' checks run, ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
