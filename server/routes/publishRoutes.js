// ════════════════════════════════════════════════════════════════
// Campaign spec + publishing routes (Meta, Google Ads, TikTok, Pinterest).
//
//   POST /api/campaigns/spec        build + validate the complete campaign
//   POST /api/publish/meta|google|tiktok|pinterest
//
// Every publish:
//   1. builds the spec from the package + business profile + the user's
//      choices (services/campaignSpec.js) with LIVE account facts,
//   2. validates it — any error blocks the publish (422, with the issues),
//   3. prepares assets (uploads images to the platform, exact crops),
//   4. sends exactly the payloads campaignSpec.payloads builds,
//   5. creates everything PAUSED, rolls back on failure, and keeps the
//      per-campaign publish lock against double clicks.
//
// Helpers that already exist in server.js (platform access/token refresh,
// API wrappers, publish lock, event log) are passed in — nothing is
// re-implemented twice.
// ════════════════════════════════════════════════════════════════
const S = require('../services/campaignSpec');
const img = require('../services/adImages');

module.exports = function registerPublishRoutes(app, d) {
  const OPTIONS_TTL_MS = 5 * 60 * 1000;
  const _optCache = new Map(); // userId|platform -> { at, options, access }

  // ── Context: business profile, saved preferences, account facts ──
  async function loadContext(user, platform, live) {
    const db = d.supabaseAdmin;
    const [{ data: profile }, { data: prof }] = await Promise.all([
      db.from('business_profile').select('company_name, website, country, languages, logo_url').eq('user_id', user.id).maybeSingle().then((r) => r, () => ({ data: null })),
      db.from('profiles').select('preferences').eq('id', user.id).maybeSingle().then((r) => r, () => ({ data: null })),
    ]);
    const key = user.id + '|' + platform;
    let cached = _optCache.get(key);
    if (live || !cached || Date.now() - cached.at > OPTIONS_TTL_MS) {
      cached = { at: Date.now(), ...(await loadOptions(user, platform)) };
      _optCache.set(key, cached);
    }
    const preferences = (prof && prof.preferences && typeof prof.preferences === 'object') ? prof.preferences : {};
    return { profile: profile || {}, preferences, options: cached.options, access: cached.access };
  }

  async function loadOptions(user, platform) {
    const options = { connected: false };
    let access = null;
    try {
      if (platform === 'meta') {
        access = await d.getMetaAccess(user);
        options.connected = true;
        options.pageId = access.pageId || null;
        try { const a = await d.metaFetch('/' + access.accountId, access.accessToken, { fields: 'currency' }); options.currency = a.currency || null; } catch (_) {}
        try { const px = await d.metaFetch('/' + access.accountId + '/adspixels', access.accessToken, { fields: 'id,name', limit: '25' }); options.pixels = (px.data || []).map((p) => ({ id: String(p.id), name: p.name || String(p.id) })); } catch (_) {}
        if (access.pageId) {
          try {
            const pg = await d.metaFetch('/' + access.pageId, access.accessToken, { fields: 'instagram_business_account{id,username}' });
            options.instagramChecked = true;
            if (pg.instagram_business_account) { options.instagramUserId = String(pg.instagram_business_account.id); options.instagramUsername = pg.instagram_business_account.username || null; }
          } catch (_) {}
        }
      } else if (platform === 'google') {
        access = await d.getGadsAccess(user);
        options.connected = true;
        try { const rows = await d.gadsQuery(access.accessToken, access.customerId, 'SELECT customer.currency_code FROM customer LIMIT 1', access.loginCustomerId); options.currency = (rows[0] && rows[0].customer && rows[0].customer.currencyCode) || null; } catch (_) {}
        try { const rows = await d.gadsQuery(access.accessToken, access.customerId, "SELECT conversion_action.id FROM conversion_action WHERE conversion_action.status = 'ENABLED'", access.loginCustomerId); options.conversionActions = rows.length; } catch (_) {}
      } else if (platform === 'tiktok') {
        access = await d.getTikTokAccess(user);
        options.connected = true;
        options.identityId = access.identityId || null; options.identityType = access.identityType || null; options.identityName = access.identityName || null;
        try {
          const url = d.TIKTOK_API + '/advertiser/info/?advertiser_ids=' + encodeURIComponent(JSON.stringify([String(access.advertiserId)])) + '&fields=' + encodeURIComponent(JSON.stringify(['currency']));
          const r = await fetch(url, { headers: { 'Access-Token': access.accessToken } });
          const j = await r.json();
          const row = j && j.code === 0 && j.data && Array.isArray(j.data.list) ? j.data.list[0] : null;
          options.currency = (row && row.currency) || null;
        } catch (_) {}
      } else if (platform === 'pinterest') {
        access = await d.getPinterestAccess(user);
        options.connected = true;
        try { const a = await d.pinterestApiRequest(access.accessToken, 'GET', '/ad_accounts/' + access.adAccountId); options.currency = (a && a.currency) || null; } catch (_) {}
        try {
          const t = await d.pinterestApiRequest(access.accessToken, 'GET', '/ad_accounts/' + access.adAccountId + '/conversion_tags');
          const list = Array.isArray(t) ? t : (t && t.items) || [];
          options.conversionTags = list.map((x) => ({ id: String(x.id), name: x.name || String(x.id) }));
        } catch (_) {}
      }
    } catch (err) {
      options.connected = false;
      options.connectionError = err && err.message ? String(err.message).slice(0, 200) : 'Not connected';
    }
    return { options, access };
  }

  function publicOptions(o) {
    const out = {};
    for (const k of ['connected', 'currency', 'pixels', 'conversionTags', 'instagramUsername', 'pageId', 'identityName', 'conversionActions', 'connectionError']) if (o[k] != null) out[k] = o[k];
    return out;
  }

  function withStructure(pkg, body) {
    const p = JSON.parse(JSON.stringify(pkg || {}));
    const st = body && body.structure;
    if (st && !p.metaStructure && !p.campaignStructure) p.metaStructure = { adSets: st.adSets, adsPerAdSet: st.adsPerAdSet };
    return p;
  }

  // Fixed option lists for the review editors (no account data).
  const CHOICES = {
    countries: S.COUNTRIES.map((c) => ({ iso: c.iso, name: c.name, pinterest: c.pin })),
    languages: Object.entries(S.LANGUAGES).map(([code, l]) => ({ code, name: l.name })),
    goals: S.GOALS,
    metaSpecialCategories: S.META_SPECIAL_CATEGORIES,
    metaConversionEvents: S.META_CONVERSION_EVENTS,
    metaPlacements: S.META_PLACEMENTS,
    pinterestConversionEvents: S.PINTEREST_CONVERSION_EVENTS,
    googleSnippetHeaders: S.GOOGLE_SNIPPET_HEADERS,
    tiktokGoals: S.SUPPORT.tiktok.goals,
    tiktokMinDaily: S.TIKTOK_MIN_ADGROUP_DAILY,
  };

  // ── POST /api/campaigns/spec ─────────────────────────────────────
  app.post('/api/campaigns/spec', async (req, res) => {
    const user = await d.getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    const { pkg, platform } = req.body || {};
    if (!pkg || !S.PLATFORMS.includes(platform)) return res.status(400).json({ error: 'A campaign and platform are required.' });
    try {
      const ctx = await loadContext(user, platform, !!(req.body && req.body.refresh));
      // Optional edits from the review screen go through the same rules as
      // Oriven Chat (applyChanges); the updated package is returned for the
      // client to save. Nothing is stored here.
      let work = pkg, applied, rejected;
      const changes = req.body && req.body.changes;
      if (changes && typeof changes === 'object') ({ pkg: work, applied, rejected } = S.applyChanges(pkg, platform, changes));
      const spec = S.buildSpec(withStructure(work, req.body), platform, ctx);
      const issues = S.validate(spec, ctx);
      const out = { ok: true, spec, issues, canPublish: !S.hasErrors(issues), summary: S.summary(spec), options: publicOptions(ctx.options) };
      if (changes) Object.assign(out, { pkg: work, applied, rejected });
      if (req.body && req.body.choices) out.choices = CHOICES;
      res.json(out);
    } catch (err) {
      console.error('[campaigns/spec]', err.message);
      res.status(500).json({ error: 'Could not check this campaign right now.' });
    }
  });

  // Shared publish prelude: lock, live context, spec, validation.
  async function prepare(req, res, platform) {
    const user = await d.getUserFromToken(req);
    if (!user) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return null; }
    const { pkg, campId } = req.body || {};
    if (!pkg) { res.status(400).json({ ok: false, error: 'Campaign package required' }); return null; }
    const lockKey = d.acquirePublishLock(user.id, platform, campId);
    if (!lockKey) { res.status(409).json({ ok: false, error: 'This campaign is already being published — please wait for it to finish.', code: 'PUBLISH_IN_PROGRESS' }); return null; }
    try {
      const ctx = await loadContext(user, platform, true);
      if (!ctx.options.connected || !ctx.access) {
        d.releasePublishLock(lockKey);
        res.status(400).json({ ok: false, error: ctx.options.connectionError || ('Connect your ' + platform + ' ad account first.'), code: 'NOT_CONNECTED' });
        return null;
      }
      const spec = S.buildSpec(withStructure(pkg, req.body), platform, ctx);
      const issues = S.validate(spec, ctx);
      if (S.hasErrors(issues)) {
        d.releasePublishLock(lockKey);
        const errors = issues.filter((i) => i.level === 'error');
        res.status(422).json({ ok: false, code: 'CAMPAIGN_INVALID', error: errors[0].message, issues });
        return null;
      }
      return { user, ctx, spec, issues, lockKey, access: ctx.access };
    } catch (err) {
      d.releasePublishLock(lockKey);
      throw err;
    }
  }

  function fail(res, platform, user, err) {
    console.error('[publish/' + platform + '] failed:', err.message);
    d.logCampaignEvent(user || null, { platform, title: platformLabel(platform) + ' publish failed', detail: err.message, severity: 'high' });
    return res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({ ok: false, error: err.message || ('Failed to publish to ' + platformLabel(platform)) });
  }
  const platformLabel = (p) => ({ meta: 'Meta Ads', google: 'Google Ads', tiktok: 'TikTok Ads', pinterest: 'Pinterest Ads' }[p]);

  // ════════════════════════════════════════════════════════════════
  // META — Marketing API (version from META_GRAPH, v25.0)
  // ════════════════════════════════════════════════════════════════
  app.post('/api/publish/meta', d.requireSubOrFreeStrict, async (req, res) => {
    let prep = null;
    const created = { campaignId: null, adSetIds: [], creativeIds: [], adIds: [] };
    try {
      prep = await prepare(req, res, 'meta');
      if (!prep) return;
      const { spec, access, user } = prep;
      const act = '/' + access.accountId;

      async function post(path, body) {
        const r = await fetch(d.META_GRAPH + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, body, { access_token: access.accessToken })) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) {
          const e = j.error || {};
          console.error('[publish/meta] Graph API error', JSON.stringify({ path: path.replace(/act_\d+/, 'act_…'), status: r.status, code: e.code, subcode: e.error_subcode, title: e.error_user_title, msg: e.error_user_msg || e.message, trace: e.fbtrace_id }));
          throw Object.assign(new Error(e.error_user_msg || e.message || ('Meta API HTTP ' + r.status)), { status: r.status >= 500 ? 502 : 400 });
        }
        return j;
      }

      // Images → Meta's own storage (image_hash), so ads never depend on a
      // provider URL that may expire.
      const imageHashes = {};
      const urls = Array.from(new Set(spec.adGroups.flatMap((g) => g.ads.map((a) => a.imageUrl)).concat([spec.creative.imageUrl]).filter(Boolean)));
      for (const u of urls) {
        const bytes = await img.fetchImage(u);
        const up = await post(act + '/adimages', { bytes: bytes.toString('base64') });
        const first = up && up.images ? Object.values(up.images)[0] : null;
        if (!first || !first.hash) throw new Error('Meta did not return an image hash for the uploaded image.');
        imageHashes[u] = first.hash;
      }

      // Languages → Meta locale keys (targeting search), only if the user chose languages.
      let localeKeys = [];
      for (const code of spec.targeting.languages) {
        const name = S.LANGUAGES[code].name;
        const r = await d.metaFetch('/search', access.accessToken, { type: 'adlocale', q: name });
        const list = r.data || [];
        const pick = list.find((x) => x.name === name + ' (All)') || list.find((x) => x.name === name) || list.find((x) => String(x.name).startsWith(name));
        if (!pick) throw Object.assign(new Error('Meta has no language option for ' + name + '. Remove the language or choose another.'), { status: 422 });
        localeKeys.push(pick.key);
      }
      const ids = { imageHashes, localeKeys };

      const campaign = await post(act + '/campaigns', S.payloads.meta.campaign(spec));
      created.campaignId = campaign.id;
      const adSetsOut = [], creativesOut = [], adsOut = [];
      for (let i = 0; i < spec.adGroups.length; i++) {
        const adSet = await post(act + '/adsets', S.payloads.meta.adSet(spec, i, ids, campaign.id));
        created.adSetIds.push(adSet.id);
        adSetsOut.push({ id: adSet.id, name: spec.adGroups[i].name });
        for (const ad of spec.adGroups[i].ads) {
          const cr = await post(act + '/adcreatives', S.payloads.meta.creative(spec, ad, ids));
          created.creativeIds.push(cr.id);
          creativesOut.push({ id: cr.id, adSetId: adSet.id });
          const a = await post(act + '/ads', S.payloads.meta.ad(spec, ad, adSet.id, cr.id));
          created.adIds.push(a.id);
          adsOut.push({ id: a.id, adSetId: adSet.id, creativeId: cr.id });
        }
      }
      d.logCampaignEvent(user, { platform: 'meta', campaignName: spec.campaign.name, title: `Published "${spec.campaign.name}" to Meta Ads`, detail: `${adSetsOut.length} ad set(s), ${adsOut.length} ad(s) created, paused, ready for review.`, severity: 'low' });
      return res.json({ ok: true, platform: 'meta', status: 'paused', campaignId: campaign.id, adSetId: adSetsOut[0] ? adSetsOut[0].id : null, adSets: adSetsOut, creatives: creativesOut, ads: adsOut, summary: S.summary(spec) });
    } catch (err) {
      if (prep && prep.access) {
        const delAll = async (list) => { for (const id of list.slice().reverse()) { try { await fetch(d.META_GRAPH + '/' + id + '?access_token=' + encodeURIComponent(prep.access.accessToken), { method: 'DELETE' }); } catch (_) {} } };
        await delAll(created.adIds); await delAll(created.creativeIds); await delAll(created.adSetIds);
        if (created.campaignId) await delAll([created.campaignId]);
      }
      return fail(res, 'meta', prep && prep.user, err);
    } finally {
      if (prep) d.releasePublishLock(prep.lockKey);
    }
  });

  // ════════════════════════════════════════════════════════════════
  // GOOGLE ADS — REST v24 (Search, Performance Max, Demand Gen)
  // ════════════════════════════════════════════════════════════════
  app.post('/api/publish/google', d.requireSubOrFreeStrict, async (req, res) => {
    let prep = null, gads = null;
    let createdCampaign = null, createdBudget = null;
    try {
      prep = await prepare(req, res, 'google');
      if (!prep) return;
      const { spec, access, user } = prep;
      const cid = access.customerId;
      gads = googleClient(access, spec.campaignType);

      // Location + language resource names, looked up in Google's own constants.
      const geo = spec.targeting.countries.length
        ? await d.gadsQuery(access.accessToken, cid, "SELECT geo_target_constant.resource_name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.country_code IN (" + spec.targeting.countries.map((c) => "'" + c + "'").join(',') + ") AND geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'", access.loginCustomerId)
        : [];
      const geoRns = spec.targeting.countries.map((c) => { const r = geo.find((x) => x.geoTargetConstant && x.geoTargetConstant.countryCode === c); return r ? r.geoTargetConstant.resourceName : null; });
      if (geoRns.some((x) => !x)) throw Object.assign(new Error('Google Ads has no country target for ' + spec.targeting.countries.filter((_, i) => !geoRns[i]).map(S.countryName).join(', ') + '.'), { status: 422 });
      let langRns = [];
      if (spec.targeting.languages.length) {
        const codes = spec.targeting.languages.map((l) => S.GOOGLE_LANG_CODE[l] || l);
        const rows = await d.gadsQuery(access.accessToken, cid, 'SELECT language_constant.resource_name, language_constant.code FROM language_constant WHERE language_constant.code IN (' + codes.map((c) => "'" + c + "'").join(',') + ')', access.loginCustomerId);
        langRns = codes.map((c) => { const r = rows.find((x) => x.languageConstant && x.languageConstant.code === c); return r ? r.languageConstant.resourceName : null; });
        if (langRns.some((x) => !x)) throw Object.assign(new Error('Google Ads has no language target for one of the chosen languages.'), { status: 422 });
      }
      const ids = { geoTargetConstants: geoRns, languageConstants: langRns };

      const budgetDecision = await d.gadsResolveBudgetName(access.accessToken, cid, access.loginCustomerId, spec.campaign.name, spec.campaign.name + ' Budget', spec.campaign.biddingField);

      if (spec.campaignType === 'PERFORMANCE_MAX') {
        const pt = S.payloads.google.pmaxText(spec);
        const square = await img.square(await img.fetchImage(spec.assets.squareImageUrl), 1200);
        const landscape = await img.cropToRatio(await img.fetchImage(spec.assets.landscapeImageUrl), S.G.LANDSCAPE_RATIO, 1200);
        const logo = await img.squareLogo(await img.fetchImage(spec.assets.logoUrl), 1200);
        if (!img.withinRatio(landscape.info, S.G.LANDSCAPE_RATIO) || landscape.info.width < 600) throw Object.assign(new Error('The landscape image is too small for Performance Max (at least 600×314).'), { status: 422 });
        const rn = { budget: budgetDecision.action === 'reuse' ? budgetDecision.resourceName : 'customers/' + cid + '/campaignBudgets/-1', campaign: 'customers/' + cid + '/campaigns/-2', assetGroup: 'customers/' + cid + '/assetGroups/-3' };
        let tmp = -4;
        const ops = [];
        if (budgetDecision.action !== 'reuse') ops.push({ campaignBudgetOperation: { create: Object.assign({ resourceName: rn.budget }, S.payloads.google.budget(spec, budgetDecision.name)) } });
        ops.push({ campaignOperation: { create: Object.assign({ resourceName: rn.campaign }, S.payloads.google.campaign(spec, rn.budget)) } });
        for (const c of S.payloads.google.targetingCriteria(spec, ids, 'campaign', rn.campaign)) ops.push({ campaignCriterionOperation: { create: c } });
        ops.push({ assetGroupOperation: { create: { resourceName: rn.assetGroup, name: spec.adGroups[0].name, campaign: rn.campaign, finalUrls: [spec.tracking.destinationUrl], status: 'ENABLED' } } });
        const addText = (text, fieldType, level) => { const a = 'customers/' + cid + '/assets/' + (tmp--); ops.push({ assetOperation: { create: { resourceName: a, textAsset: { text } } } }); ops.push(level === 'campaign' ? { campaignAssetOperation: { create: { campaign: rn.campaign, asset: a, fieldType } } } : { assetGroupAssetOperation: { create: { assetGroup: rn.assetGroup, asset: a, fieldType } } }); };
        const addImage = (buf, name, fieldType, level) => { const a = 'customers/' + cid + '/assets/' + (tmp--); ops.push({ assetOperation: { create: { resourceName: a, name, imageAsset: { data: buf.toString('base64') } } } }); ops.push(level === 'campaign' ? { campaignAssetOperation: { create: { campaign: rn.campaign, asset: a, fieldType } } } : { assetGroupAssetOperation: { create: { assetGroup: rn.assetGroup, asset: a, fieldType } } }); };
        pt.headlines.forEach((h) => addText(h, 'HEADLINE'));
        addText(pt.longHeadline, 'LONG_HEADLINE');
        pt.descriptions.forEach((x) => addText(x, 'DESCRIPTION'));
        addImage(landscape.buffer, spec.campaign.name + ' Landscape', 'MARKETING_IMAGE');
        addImage(square.buffer, spec.campaign.name + ' Square', 'SQUARE_MARKETING_IMAGE');
        // Brand guidelines (on by default for new PMax campaigns since v21):
        // business name and logo are campaign assets.
        addText(pt.businessName, 'BUSINESS_NAME', 'campaign');
        addImage(logo.buffer, spec.campaign.name + ' Logo', 'LOGO', 'campaign');
        const out = await gads.batch(ops);
        const results = out.mutateOperationResponses || [];
        const campRes = results.find((r) => r.campaignResult);
        const campaignRn = campRes ? campRes.campaignResult.resourceName : null;
        d.logCampaignEvent(user, { platform: 'google', campaignName: spec.campaign.name, title: `Published "${spec.campaign.name}" to Google Ads (Performance Max)`, detail: 'Campaign created, paused, ready for review.', severity: 'low' });
        return res.json({ ok: true, platform: 'google', campaignType: 'PERFORMANCE_MAX', status: 'paused', campaignId: campaignRn ? campaignRn.split('/').pop() : null, campaignResourceName: campaignRn, summary: S.summary(spec) });
      }

      // Budget (Search + Demand Gen)
      let budgetRn;
      if (budgetDecision.action === 'reuse') budgetRn = budgetDecision.resourceName;
      else { const b = await gads.mutate('campaignBudgets', [{ create: S.payloads.google.budget(spec, budgetDecision.name) }]); budgetRn = b.results[0].resourceName; createdBudget = budgetRn; }
      const c = await gads.mutate('campaigns', [{ create: S.payloads.google.campaign(spec, budgetRn) }]);
      const campaignRn = c.results[0].resourceName;
      createdCampaign = campaignRn;

      if (spec.campaignType === 'DEMAND_GEN') {
        const ag = await gads.mutate('adGroups', [{ create: { name: spec.adGroups[0].name, campaign: campaignRn, status: 'ENABLED' } }]);
        const agRn = ag.results[0].resourceName;
        const crit = S.payloads.google.targetingCriteria(spec, ids, 'adGroup', agRn);
        if (crit.length) await gads.mutate('adGroupCriteria', crit.map((x) => ({ create: x })));
        const square = await img.square(await img.fetchImage(spec.assets.squareImageUrl), 1200);
        const logo = await img.squareLogo(await img.fetchImage(spec.assets.logoUrl), 1200);
        const assetOps = [{ create: { name: spec.campaign.name + ' Square', type: 'IMAGE', imageAsset: { data: square.buffer.toString('base64') } } }, { create: { name: spec.campaign.name + ' Logo', type: 'IMAGE', imageAsset: { data: logo.buffer.toString('base64') } } }];
        let landscape = null;
        if (spec.assets.landscapeImageUrl) { landscape = await img.cropToRatio(await img.fetchImage(spec.assets.landscapeImageUrl), S.G.LANDSCAPE_RATIO, 1200); assetOps.push({ create: { name: spec.campaign.name + ' Landscape', type: 'IMAGE', imageAsset: { data: landscape.buffer.toString('base64') } } }); }
        const assets = await gads.mutate('assets', assetOps);
        const aIds = { squareAsset: assets.results[0].resourceName, logoAsset: assets.results[1].resourceName, landscapeAsset: landscape ? assets.results[2].resourceName : null };
        await gads.mutate('adGroupAds', [{ create: S.payloads.google.demandGenAd(spec, aIds, agRn) }]);
        d.logCampaignEvent(user, { platform: 'google', campaignName: spec.campaign.name, title: `Published "${spec.campaign.name}" to Google Ads (Demand Gen)`, detail: 'Campaign created, paused, ready for review.', severity: 'low' });
        return res.json({ ok: true, platform: 'google', campaignType: 'DEMAND_GEN', status: 'paused', campaignId: campaignRn.split('/').pop(), campaignResourceName: campaignRn, summary: S.summary(spec) });
      }

      // SEARCH
      const crit = S.payloads.google.targetingCriteria(spec, ids, 'campaign', campaignRn).concat(S.payloads.google.negativeKeywords(spec, campaignRn));
      if (crit.length) await gads.mutate('campaignCriteria', crit.map((x) => ({ create: x })));
      const extra = S.payloads.google.searchAssets(spec);
      if (extra.length) {
        const made = await gads.mutate('assets', extra.map((x) => ({ create: x.asset })));
        await gads.mutate('campaignAssets', made.results.map((r, i) => ({ create: { campaign: campaignRn, asset: r.resourceName, fieldType: extra[i].fieldType } })));
      }
      const groupsOut = [];
      for (let i = 0; i < spec.adGroups.length; i++) {
        const grp = spec.adGroups[i];
        const ag = await gads.mutate('adGroups', [{ create: { name: grp.name, campaign: campaignRn, status: 'ENABLED', type: 'SEARCH_STANDARD' } }]);
        const agRn = ag.results[0].resourceName;
        if (grp.keywords.length) await gads.mutate('adGroupCriteria', grp.keywords.map((k) => ({ create: { adGroup: agRn, status: 'ENABLED', keyword: { text: k.text, matchType: k.matchType } } })));
        await gads.mutate('adGroupAds', grp.ads.map((ad) => ({ create: S.payloads.google.rsa(spec, ad, agRn) })));
        groupsOut.push({ resourceName: agRn, name: grp.name, keywords: grp.keywords.length, ads: grp.ads.length });
      }
      d.logCampaignEvent(user, { platform: 'google', campaignName: spec.campaign.name, title: `Published "${spec.campaign.name}" to Google Ads (Search)`, detail: `${groupsOut.length} ad group(s) created, paused, ready for review.`, severity: 'low' });
      return res.json({ ok: true, platform: 'google', campaignType: 'SEARCH', status: 'paused', campaignId: campaignRn.split('/').pop(), campaignResourceName: campaignRn, adGroups: groupsOut, summary: S.summary(spec) });
    } catch (err) {
      if (gads) {
        if (createdCampaign) { try { await gads.mutate('campaigns', [{ remove: createdCampaign }]); } catch (e) { console.error('[publish/google] rollback campaign failed:', e.message); } }
        if (createdBudget) { try { await gads.mutate('campaignBudgets', [{ remove: createdBudget }]); } catch (e) { console.error('[publish/google] rollback budget failed:', e.message); } }
      }
      return fail(res, 'google', prep && prep.user, err);
    } finally {
      if (prep) d.releasePublishLock(prep.lockKey);
    }
  });

  function googleClient(access, campaignType) {
    const base = 'https://googleads.googleapis.com/v24/customers/' + access.customerId;
    const headers = { Authorization: 'Bearer ' + access.accessToken, 'developer-token': d.GOOGLE_ADS_DEVELOPER_TOKEN || '', 'Content-Type': 'application/json' };
    if (access.loginCustomerId && access.loginCustomerId !== access.customerId) headers['login-customer-id'] = access.loginCustomerId;
    function errMsg(j) {
      const g = (j && j.error && Array.isArray(j.error.details) && j.error.details[0]) || {};
      const codes = (g.errors || []).map((e) => (e.errorCode ? JSON.stringify(e.errorCode) : '') + (e.message ? ' ' + e.message : '')).filter(Boolean);
      return ((j && j.error && j.error.message) || 'Google Ads API error') + (codes.length ? ' [' + codes.join('; ') + ']' : '');
    }
    async function call(url, body, label) {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error('[publish/google] API error | resource:', label, '| campaignType:', campaignType, '| error:', JSON.stringify(j.error || j).slice(0, 2000));
        if (d.extractGadsPolicyFindings) { const f = d.extractGadsPolicyFindings(j, label); if (f.some((x) => x.isPolicyFinding)) console.error('[publish/google] POLICY_FINDING', JSON.stringify(f.filter((x) => x.isPolicyFinding))); }
        throw Object.assign(new Error(errMsg(j)), { status: r.status >= 500 ? 502 : 400 });
      }
      return j;
    }
    return {
      mutate: (resource, operations) => call(base + '/' + resource + ':mutate', { operations }, resource),
      batch: (mutateOperations) => call(base + '/googleAds:mutate', { mutateOperations }, 'batch mutate'),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // TIKTOK — Business API v1.3 (video ads, Traffic / Awareness)
  // ════════════════════════════════════════════════════════════════
  app.post('/api/publish/tiktok', d.requireSubOrFreeStrict, async (req, res) => {
    let prep = null;
    const created = { campaignId: null, adGroupIds: [], adIds: [] };
    try {
      prep = await prepare(req, res, 'tiktok');
      if (!prep) return;
      const { spec, access, user } = prep;
      const adv = access.advertiserId;
      const tk = (path, body) => d.tiktokPost(path, access.accessToken, body);
      const httpUrl = (u, what) => { if (!/^https?:\/\//i.test(String(u || ''))) throw Object.assign(new Error('The ' + what + ' must be stored online before publishing to TikTok. Generate or upload it again.'), { status: 422 }); return u; };

      const vid = await tk('/file/video/ad/upload/', { advertiser_id: adv, upload_type: 'UPLOAD_BY_URL', video_url: httpUrl(spec.creative.videoUrl, 'video') });
      const videoId = (Array.isArray(vid) ? vid[0] : vid) && (Array.isArray(vid) ? vid[0] : vid).video_id;
      if (!videoId) throw new Error('TikTok did not return a video_id for the uploaded video.');
      const cover = await tk('/file/image/ad/upload/', { advertiser_id: adv, upload_type: 'UPLOAD_BY_URL', image_url: httpUrl(spec.creative.coverImageUrl, 'cover image') });
      const coverImageId = (Array.isArray(cover) ? cover[0] : cover) && (Array.isArray(cover) ? cover[0] : cover).image_id;
      if (!coverImageId) throw new Error('TikTok did not return an image_id for the cover image.');
      const locationIds = spec.targeting.countries.map((c) => String(S.COUNTRY_BY_ISO[c].geo));
      const ids = { videoId, coverImageId, locationIds };

      const camp = await tk('/campaign/create/', S.payloads.tiktok.campaign(spec, adv));
      const campaignId = camp && camp.campaign_id;
      if (!campaignId) throw new Error('TikTok did not return a campaign_id');
      created.campaignId = campaignId;
      const start = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace('T', ' ');
      const groupsOut = [], adsOut = [];
      for (let i = 0; i < spec.adGroups.length; i++) {
        const ag = await tk('/adgroup/create/', S.payloads.tiktok.adGroup(spec, i, ids, adv, campaignId, start));
        const agId = ag && ag.adgroup_id;
        if (!agId) throw new Error('TikTok did not return an adgroup_id');
        created.adGroupIds.push(agId);
        groupsOut.push({ id: agId, name: spec.adGroups[i].name });
        for (const ad of spec.adGroups[i].ads) {
          const a = await tk('/ad/create/', S.payloads.tiktok.ad(spec, ad, ids, adv, agId));
          const adId = a && a.ad_ids && a.ad_ids[0];
          if (!adId) throw new Error('TikTok did not return an ad_id');
          created.adIds.push(adId);
          adsOut.push({ id: adId, adGroupId: agId });
        }
      }
      d.logCampaignEvent(user, { platform: 'tiktok', campaignName: spec.campaign.name, title: `Published "${spec.campaign.name}" to TikTok Ads`, detail: `Campaign created, paused, ready for review (${groupsOut.length} ad group(s), ${adsOut.length} ad(s)).`, severity: 'low' });
      return res.json({ ok: true, platform: 'tiktok', status: 'paused', campaignId: String(campaignId), adGroups: groupsOut, ads: adsOut, summary: S.summary(spec) });
    } catch (err) {
      if (prep && prep.access) {
        const a = prep.access;
        const st = (path, body) => d.tiktokPost(path, a.accessToken, body).catch((e) => console.error('[publish/tiktok] rollback failed', path, e.message));
        if (created.adIds.length) await st('/ad/status/update/', { advertiser_id: a.advertiserId, ad_ids: created.adIds, operation_status: 'DELETE' });
        if (created.adGroupIds.length) await st('/adgroup/status/update/', { advertiser_id: a.advertiserId, adgroup_ids: created.adGroupIds, operation_status: 'DELETE' });
        if (created.campaignId) await st('/campaign/status/update/', { advertiser_id: a.advertiserId, campaign_ids: [created.campaignId], operation_status: 'DELETE' });
      }
      return fail(res, 'tiktok', prep && prep.user, err);
    } finally {
      if (prep) d.releasePublishLock(prep.lockKey);
    }
  });

  // ════════════════════════════════════════════════════════════════
  // PINTEREST — API v5
  // ════════════════════════════════════════════════════════════════
  app.post('/api/publish/pinterest', d.requireSubOrFreeStrict, async (req, res) => {
    let prep = null;
    const created = { pinIds: [], campaignId: null, adGroupIds: [], adIds: [] };
    try {
      prep = await prepare(req, res, 'pinterest');
      if (!prep) return;
      const { spec, access, user } = prep;
      const acct = '/ad_accounts/' + access.adAccountId;
      const pr = (method, path, body) => d.pinterestApiRequest(access.accessToken, method, path, body);

      const camp = await pr('POST', acct + '/campaigns', S.payloads.pinterest.campaign(spec));
      if (!camp || !camp.id) throw new Error('Pinterest did not return a campaign id');
      created.campaignId = camp.id;
      const boardId = await d.pinterestGetOrCreateAdsBoard(access.accessToken);
      const pinMeta = { title: spec.pin.title, description: spec.pin.description, altText: spec.pin.altText, link: S.withParams(spec.tracking.destinationUrl, spec.tracking.urlParams) };
      const pinIds = [];
      if (spec.creative.format === 'VIDEO') {
        const id = await d.pinterestCreateVideoPin(access.accessToken, boardId, spec.creative.videoUrl, pinMeta);
        created.pinIds.push(id); pinIds.push(id);
      } else {
        for (const u of spec.creative.images) {
          if (!/^https?:\/\//i.test(u)) throw Object.assign(new Error('The image must be stored online before publishing to Pinterest. Generate or upload it again.'), { status: 422 });
          const id = await d.pinterestCreateImagePin(access.accessToken, boardId, u, pinMeta);
          created.pinIds.push(id); pinIds.push(id);
        }
      }
      if (!pinIds.length) throw new Error('Pinterest publish did not produce any Pin');
      const groupsOut = [], adsOut = [];
      let n = 0;
      for (let i = 0; i < spec.adGroups.length; i++) {
        const ag = await pr('POST', acct + '/ad_groups', S.payloads.pinterest.adGroup(spec, i, camp.id));
        if (!ag || !ag.id) throw new Error('Pinterest did not return an ad group id');
        created.adGroupIds.push(ag.id);
        groupsOut.push({ id: ag.id, name: spec.adGroups[i].name });
        for (const ad of spec.adGroups[i].ads) {
          const pinId = pinIds[n++ % pinIds.length];
          const a = await pr('POST', acct + '/ads', S.payloads.pinterest.ad(spec, ad, ag.id, pinId));
          if (!a || !a.id) throw new Error('Pinterest did not return an ad id');
          created.adIds.push(a.id);
          adsOut.push({ id: a.id, adGroupId: ag.id, pinId });
        }
      }
      d.logCampaignEvent(user, { platform: 'pinterest', campaignName: spec.campaign.name, title: `Published "${spec.campaign.name}" to Pinterest Ads`, detail: `Campaign created, paused, ready for review (${groupsOut.length} ad group(s), ${adsOut.length} ad(s)).`, severity: 'low' });
      return res.json({ ok: true, platform: 'pinterest', status: 'paused', campaignId: String(camp.id), adGroups: groupsOut, ads: adsOut, pinIds: pinIds.map(String), summary: S.summary(spec) });
    } catch (err) {
      if (prep && prep.access) {
        const a = prep.access;
        try { await d.pinterestArchiveEntities(a.accessToken, a.adAccountId, 'ads', created.adIds); } catch (_) {}
        try { await d.pinterestArchiveEntities(a.accessToken, a.adAccountId, 'ad_groups', created.adGroupIds); } catch (_) {}
        if (created.campaignId) { try { await d.pinterestArchiveEntities(a.accessToken, a.adAccountId, 'campaigns', [created.campaignId]); } catch (_) {} }
        for (const id of created.pinIds) { try { await d.pinterestApiRequest(a.accessToken, 'DELETE', '/pins/' + id); } catch (_) {} }
      }
      return fail(res, 'pinterest', prep && prep.user, err);
    } finally {
      if (prep) d.releasePublishLock(prep.lockKey);
    }
  });

  return { loadContext, loadOptions };
};
