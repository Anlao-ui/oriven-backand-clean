// ════════════════════════════════════════════════════════════════════
// Activating a campaign OrivenAI published (Meta, TikTok, Pinterest).
//
// Publishing creates every object paused — the campaign, its ad sets / ad
// groups and its ads (services/campaignSpec.js). Enabling only the campaign
// leaves the ad sets and ads paused, so nothing delivers while the campaign
// looks "on". Activation therefore works on the objects OrivenAI created:
//
//   1. scope      — only children listed UNDER the campaign (the route has
//                   verified the campaign belongs to the user's connected ad
//                   account), and only the ids the publish recorded for that
//                   campaign (publish ledger, else the campaigns row). With no
//                   record, no child is touched: OrivenAI can't prove it
//                   created them. A record made in another ad account is
//                   refused.
//   2. first time — only on the first activation (the user's explicit
//                   "Activate" on a never-run campaign). Resuming after a pause
//                   only enables the campaign: children the advertiser paused
//                   on the platform stay paused.
//   3. order      — ads, then ad sets / ad groups, the campaign last. A failed
//                   step stops there: the campaign stays paused, so nothing
//                   spends half-configured.
//   4. verify     — afterwards the children are read back; what is still
//                   paused is reported by id. If they can't be read back the
//                   result is "not verified", never "delivering".
// Google is not handled here: its ad groups and ads are created ENABLED under
// a paused campaign, so enabling the campaign is enough.
// ════════════════════════════════════════════════════════════════════

const PAUSED = { meta: ['PAUSED'], tiktok: ['DISABLE'], pinterest: ['PAUSED'] };
const LABEL = { meta: 'Meta Ads', tiktok: 'TikTok Ads', pinterest: 'Pinterest Ads' };
const STEP_TIMEOUT_MS = Number(process.env.ACTIVATION_STEP_TIMEOUT_MS) || 20000;

const idList = (v) => (Array.isArray(v) ? v.map((x) => String(x && typeof x === 'object' ? x.id : x)).filter(Boolean) : null);
const digits = (v) => { const d = String(v == null ? '' : v).replace(/[^0-9]/g, ''); return d || String(v || ''); };
const isPausedFor = (platform) => (r) => r && (PAUSED[platform] || []).indexOf(String(r.status || '').toUpperCase()) !== -1;

class ActivationError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
}

// The ad set / ad ids the publish recorded for this campaign (and the ad
// account it was published to), or null. Never throws.
async function recordedChildren(db, userId, platform, campaignId) {
  if (!db || !userId || !campaignId) return null;
  const cid = String(campaignId);
  // activatedAt: set once the first activation switched everything on, so
  // every later activation (Launch or Automations) is a plain resume.
  try {
    const { data, error } = await db.from('publish_operations').select('id, external_ids, external_account_id, state')
      .eq('user_id', userId).eq('platform', platform).eq('external_campaign_id', cid).eq('state', 'published').limit(1);
    const row = !error && data && data[0];
    const ids = row && row.external_ids;
    if (ids && (Array.isArray(ids.adSetIds) || Array.isArray(ids.adIds))) {
      return { adSetIds: idList(ids.adSetIds) || [], adIds: idList(ids.adIds) || [], accountId: row.external_account_id || null, source: 'ledger', rowId: row.id, raw: ids, activatedAt: ids.activatedAt || null };
    }
  } catch (_) { /* table missing or unreachable: try the campaigns row */ }
  try {
    const { data, error } = await db.from('campaigns').select('id, source, external_ad_set_ids, external_ad_ids, external_account_id, package')
      .eq('user_id', userId).eq('external_campaign_id', cid).limit(1);
    const row = !error && data && data[0];
    // Only a campaign OrivenAI generated: imported / manual rows describe
    // objects someone else created.
    const ours = row && (!row.source || row.source === 'oriven_generated');
    if (ours && (Array.isArray(row.external_ad_set_ids) || Array.isArray(row.external_ad_ids))) {
      return { adSetIds: idList(row.external_ad_set_ids) || [], adIds: idList(row.external_ad_ids) || [], accountId: row.external_account_id || null, source: 'campaigns', rowId: row.id, raw: row.package || null, activatedAt: (row.package && row.package.activatedAt) || null };
    }
  } catch (_) {}
  return null;
}

function withTimeout(promise, step) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error(step + ' timed out'), { timeout: true })), STEP_TIMEOUT_MS); }),
  ]);
}

// One activation per user + campaign at a time (double click, two tabs).
const inFlight = new Set();

// adapter: {
//   listAdSets() → [{id,status}], listAds() → [{id,status}],
//   enableAds(ids) → { failed: [ids] }?, enableAdSets(ids) → { failed: [ids] }?,
//   enableCampaign()
// }  (each may throw; an enable may report per-item failures)
// Returns the activation report; throws ActivationError when the campaign was
// NOT switched on (it stays paused — nothing spends).
async function activate({ platform, userId, campaignId, accountId, firstActivation, recorded, adapter }) {
  if (!PAUSED[platform]) throw new ActivationError('UNSUPPORTED', 'Activation of child objects is not used for this platform.');
  const lockKey = userId + ':' + platform + ':' + campaignId;
  if (inFlight.has(lockKey)) throw new ActivationError('ACTIVATION_IN_PROGRESS', 'This campaign is already being activated.');
  inFlight.add(lockKey);
  const isPaused = isPausedFor(platform);
  const report = {
    platform, campaignId: String(campaignId), firstActivation: firstActivation === true, scope: recorded ? recorded.source : 'none',
    enabled: { adSets: [], ads: [] }, failed: { adSets: [], ads: [] }, missing: { adSets: [], ads: [] },
    remainingPaused: { adSets: [], ads: [] }, preservedPaused: { adSets: 0, ads: 0 },
    campaign: 'paused', verified: false,
  };
  try {
    // A record from another ad account: the ids aren't this account's objects.
    if (recorded && recorded.accountId && accountId && digits(recorded.accountId) !== digits(accountId)) {
      throw new ActivationError('WRONG_ACCOUNT', 'This campaign was published to another ad account than the one connected now.', { recordedAccountId: String(recorded.accountId) });
    }
    const list = async () => {
      const [sets, ads] = await Promise.all([withTimeout(adapter.listAdSets(), 'list ad sets'), withTimeout(adapter.listAds(), 'list ads')]);
      return { sets: Array.isArray(sets) ? sets : [], ads: Array.isArray(ads) ? ads : [] };
    };
    let targets = { adSets: [], ads: [] };
    if (report.firstActivation) {
      let before;
      try { before = await list(); } catch (e) { throw new ActivationError('ACTIVATION_INCOMPLETE', 'The campaign’s ad sets and ads couldn’t be read, so nothing was changed.', { step: 'read', cause: e, timeout: !!e.timeout }); }
      if (recorded) {
        const pick = (rows, ids, kind) => {
          const found = new Set(rows.map((r) => String(r.id)));
          report.missing[kind] = ids.filter((id) => !found.has(id));
          return rows.filter((r) => ids.indexOf(String(r.id)) !== -1 && isPaused(r)).map((r) => String(r.id));
        };
        targets = { adSets: pick(before.sets, recorded.adSetIds, 'adSets'), ads: pick(before.ads, recorded.adIds, 'ads') };
      }
      // Paused children OrivenAI didn't create (or can't prove it did) stay as they are.
      report.preservedPaused.adSets = before.sets.filter((r) => isPaused(r) && targets.adSets.indexOf(String(r.id)) === -1).length;
      report.preservedPaused.ads = before.ads.filter((r) => isPaused(r) && targets.ads.indexOf(String(r.id)) === -1).length;
      // Ads first, then ad sets: an ad set switched on with its ads still
      // paused delivers nothing; the campaign (last) is the real switch.
      for (const [kind, fn, step] of [['ads', adapter.enableAds, 'ads'], ['adSets', adapter.enableAdSets, 'adSets']]) {
        const ids = targets[kind];
        if (!ids.length) continue;
        let out;
        try { out = await withTimeout(fn(ids), 'enable ' + step); }
        catch (e) {
          // Partially applied sequential enables report what got through.
          const done = (e && Array.isArray(e.enabledIds)) ? e.enabledIds.map(String) : [];
          report.enabled[kind] = done;
          report.failed[kind] = ids.filter((id) => done.indexOf(id) === -1);
          throw new ActivationError('ACTIVATION_INCOMPLETE', 'Some of the campaign’s ' + (kind === 'ads' ? 'ads' : 'ad sets') + ' couldn’t be switched on, so the campaign was left paused.', { step, cause: e, timeout: !!(e && e.timeout) });
        }
        const failed = (out && Array.isArray(out.failed) ? out.failed.map(String) : []);
        report.enabled[kind] = ids.filter((id) => failed.indexOf(id) === -1);
        report.failed[kind] = failed;
        if (failed.length) throw new ActivationError('ACTIVATION_INCOMPLETE', 'Some of the campaign’s ' + (kind === 'ads' ? 'ads' : 'ad sets') + ' couldn’t be switched on, so the campaign was left paused.', { step });
      }
    }
    try { await withTimeout(adapter.enableCampaign(), 'enable campaign'); }
    catch (e) { throw new ActivationError('ACTIVATION_INCOMPLETE', 'The campaign couldn’t be switched on. It stays paused — nothing spends.', { step: 'campaign', cause: e, timeout: !!(e && e.timeout) }); }
    report.campaign = 'active';
    // Read back: what is (still) paused under the campaign.
    try {
      const after = await list();
      const scoped = (rows, ids) => rows.filter((r) => isPaused(r) && (!ids || ids.indexOf(String(r.id)) !== -1)).map((r) => String(r.id));
      if (report.firstActivation && recorded) {
        report.remainingPaused = { adSets: scoped(after.sets, recorded.adSetIds), ads: scoped(after.ads, recorded.adIds) };
      } else {
        // A resume, or nothing recorded: report every paused child (not touched).
        report.remainingPaused = { adSets: scoped(after.sets, null), ads: scoped(after.ads, null) };
      }
      report.activeAds = after.ads.filter((r) => !isPaused(r) && /^(ACTIVE|ENABLE)$/i.test(String(r.status || ''))).length;
      report.verified = true;
    } catch (_) { report.verified = false; }
    return report;
  } catch (e) {
    if (e instanceof ActivationError) { e.report = report; throw e; }
    throw e;
  } finally {
    inFlight.delete(lockKey);
  }
}

// Records that the first activation finished, so later activations (from
// Launch or Automations) keep paused children the advertiser chose. Never throws.
async function markActivated(db, recorded, at) {
  if (!db || !recorded || !recorded.rowId) return false;
  try {
    if (recorded.source === 'ledger') {
      const { error } = await db.from('publish_operations').update({ external_ids: Object.assign({}, recorded.raw || {}, { activatedAt: at }), updated_at: at }).eq('id', recorded.rowId);
      return !error;
    }
    const { error } = await db.from('campaigns').update({ package: Object.assign({}, recorded.raw || {}, { activatedAt: at }), updated_at: at }).eq('id', recorded.rowId);
    return !error;
  } catch (_) { return false; }
}

// ── Provider operations (one definition for Launch and Automations) ──
// deps: the API helpers server.js already has (auth, HTTP, error mapping).
// Returns { accountId, adapter } after checking, read-only, that the
// campaign exists in the user's CONNECTED ad account; throws before any
// mutation otherwise.
async function providerOps(platform, deps, user, cid) {
  if (platform === 'meta') {
    const { accessToken, accountId } = await deps.getMetaAccess(user);
    await deps.verifyMetaObjectOwnership(accessToken, cid, accountId);
    await deps.verifyMetaAdAccountWritable(accessToken, accountId);
    const list = async (edge) => {
      const d = await deps.metaFetch('/' + cid + '/' + edge, accessToken, { fields: 'id,status', limit: '500' });
      return ((d && d.data) || []).map((r) => ({ id: String(r.id), status: r.status }));
    };
    // One object per request (Graph API); what went through is reported if a later one fails.
    const enableEach = async (ids) => {
      const done = [];
      for (const id of ids) {
        try { await deps.metaApiPost('/' + id, accessToken, { status: 'ACTIVE' }); done.push(id); }
        catch (e) { e.enabledIds = done; throw e; }
      }
      return { failed: [] };
    };
    return { accountId, adapter: { listAdSets: () => list('adsets'), listAds: () => list('ads'), enableAds: enableEach, enableAdSets: enableEach,
      enableCampaign: () => deps.metaApiPost('/' + cid, accessToken, { status: 'ACTIVE' }) } };
  }
  if (platform === 'tiktok') {
    const { accessToken, advertiserId } = await deps.getTikTokAccess(user);
    const found = await deps.tiktokFetch('/campaign/get/', accessToken, { advertiser_id: advertiserId, filtering: JSON.stringify({ campaign_ids: [cid] }), fields: JSON.stringify(['campaign_id', 'operation_status']) });
    if (!((found && found.list) || []).some((c) => String(c.campaign_id) === cid)) throw Object.assign(new Error('campaign not found'), { code: 'NOT_FOUND' });
    const list = async (path, idKey) => {
      const d = await deps.tiktokFetch(path, accessToken, { advertiser_id: advertiserId, filtering: JSON.stringify({ campaign_ids: [cid] }), fields: JSON.stringify([idKey, 'operation_status']), page_size: '1000' });
      return ((d && d.list) || []).map((r) => ({ id: String(r[idKey]), status: r.operation_status }));
    };
    // TikTok answers a batch status update all-or-nothing (code != 0 throws).
    const enable = (path, key) => (ids) => deps.tiktokPost(path, accessToken, { advertiser_id: advertiserId, [key]: ids, operation_status: 'ENABLE' }).then(() => ({ failed: [] }));
    return { accountId: advertiserId, adapter: { listAdSets: () => list('/adgroup/get/', 'adgroup_id'), listAds: () => list('/ad/get/', 'ad_id'),
      enableAds: enable('/ad/status/update/', 'ad_ids'), enableAdSets: enable('/adgroup/status/update/', 'adgroup_ids'),
      enableCampaign: () => deps.tiktokPost('/campaign/status/update/', accessToken, { advertiser_id: advertiserId, campaign_ids: [cid], operation_status: 'ENABLE' }) } };
  }
  if (platform === 'pinterest') {
    const { accessToken, adAccountId } = await deps.getPinterestAccess(user);
    const base = '/ad_accounts/' + adAccountId;
    const found = await deps.pinterestApiRequest(accessToken, 'GET', base + '/campaigns?campaign_ids=' + encodeURIComponent(cid));
    if (!((found && found.items) || []).some((c) => String(c.id) === cid)) throw Object.assign(new Error('campaign not found'), { code: 'NOT_FOUND' });
    const list = async (kind) => {
      const d = await deps.pinterestApiRequest(accessToken, 'GET', base + '/' + kind + '?campaign_ids=' + encodeURIComponent(cid) + '&page_size=250');
      return ((d && d.items) || []).map((r) => ({ id: String(r.id), status: r.status }));
    };
    // Bulk PATCH answers per item; an item with exceptions was not changed.
    const enable = (kind) => async (ids) => {
      const d = await deps.pinterestApiRequest(accessToken, 'PATCH', base + '/' + kind, ids.map((id) => ({ id: String(id), status: 'ACTIVE' })));
      const failed = [];
      ((d && d.items) || []).forEach((it, i) => { if (it && Array.isArray(it.exceptions) && it.exceptions.length) failed.push(String((it.data && it.data.id) || ids[i])); });
      return { failed };
    };
    return { accountId: adAccountId, adapter: { listAdSets: () => list('ad_groups'), listAds: () => list('ads'), enableAds: enable('ads'), enableAdSets: enable('ad_groups'),
      enableCampaign: async () => { const r = await enable('campaigns')([cid]); if (r.failed.length) throw new Error('Pinterest refused to switch the campaign on'); } } };
  }
  throw new ActivationError('UNSUPPORTED', 'Activation of child objects is not used for this platform.');
}

// The one activation entry point — Launch (routes) and Automations (engine).
// firstActivationHint: Launch's "never activated" (false = a resume). The
// server's record decides: with a record that was already activated, it is a
// resume whatever the caller says; without any record no child is touched.
async function run({ platform, user, campaignId, firstActivationHint, db, deps, now }) {
  const cid = String(campaignId == null ? '' : campaignId).replace(/[^0-9]/g, '');
  if (!cid) throw Object.assign(new Error('Invalid campaign ID'), { code: 'NOT_FOUND' });
  const ops = await providerOps(platform, deps, user, cid);
  const recorded = await recordedChildren(db, user.id, platform, cid);
  const first = !!recorded && !recorded.activatedAt && firstActivationHint !== false;
  const report = await activate({ platform, userId: user.id, campaignId: cid, accountId: ops.accountId, firstActivation: first, recorded, adapter: ops.adapter });
  const r = report.remainingPaused;
  report.accountId = ops.accountId;
  if (first && report.campaign === 'active' && report.verified && !r.adSets.length && !r.ads.length) {
    report.markedActivated = await markActivated(db, recorded, new Date(now || Date.now()).toISOString());
  }
  report.state = !report.verified ? 'unverified' : (r.adSets.length + r.ads.length) ? 'partial' : 'active';
  return report;
}

// Error answer for pause/resume. A provider's expired login is not an OrivenAI
// session problem; activation failures carry the report (what changed, what
// stays paused) and say plainly that nothing spends.
function actionError(err, platformLabel, userMessage) {
  const s = err && err.status;
  const raw = String((err && err.message) || '');
  if (err instanceof ActivationError) {
    const status = err.code === 'ACTIVATION_IN_PROGRESS' || err.code === 'WRONG_ACCOUNT' ? 409 : 502;
    const why = err.cause ? actionError(err.cause, platformLabel).body : null;
    return { status, body: { ok: false, code: err.code, error: err.message + (err.code === 'ACTIVATION_INCOMPLETE' ? ' Nothing is spending.' : ''), params: { platform: platformLabel }, step: err.step || null, timeout: !!err.timeout, providerCode: why ? why.code : null, activation: err.report || null } };
  }
  if (s === 401 || /expired|reconnect/i.test(raw)) return { status: 409, body: { ok: false, code: 'RECONNECT_REQUIRED', error: platformLabel + ' needs to be reconnected. Reconnect it in Connections, then try again. Nothing was changed.', params: { platform: platformLabel } } };
  if (s === 400 && /not connected|no active/i.test(raw)) return { status: 400, body: { ok: false, code: 'NOT_CONNECTED', error: 'Connect ' + platformLabel + ' and select its ad account first. Nothing was changed.', variant: 'action', params: { platform: platformLabel } } };
  if (err && (err.code === 'NOT_FOUND' || err.metaCategory === 'OBJECT_NOT_FOUND' || err.metaCategory === 'OBJECT_NOT_ACCESSIBLE' || err.metaCategory === 'OWNERSHIP_MISMATCH' || /not owned|does not belong|another ad account/i.test(raw))) {
    return { status: 404, body: { ok: false, code: 'CAMPAIGN_NOT_FOUND', error: 'This campaign wasn’t found in the ' + platformLabel + ' ad account that is connected now. Nothing was changed.', params: { platform: platformLabel } } };
  }
  if (s === 403) return { status: 403, body: { ok: false, code: 'PROVIDER_PERMISSION', error: userMessage || (platformLabel + ' didn’t allow this change for the connected account.'), variant: userMessage ? 'provider' : undefined, params: { platform: platformLabel, detail: userMessage || '' } } };
  const status = s && s >= 400 && s < 600 ? s : 502;
  return { status, body: { ok: false, code: 'PROVIDER_ERROR', error: userMessage || raw || (platformLabel + ' didn’t accept the change.'), variant: userMessage || raw ? 'provider' : undefined, params: { platform: platformLabel, detail: userMessage || raw || '' } } };
}

module.exports = { recordedChildren, activate, run, providerOps, markActivated, actionError, ActivationError, PAUSED, LABEL, _inFlight: inFlight };
