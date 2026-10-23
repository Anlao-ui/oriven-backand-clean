// ── Weekly report: platform data collection ──────────────────────────
//
// Reads one user's campaign metrics for a reporting week (and the week
// before it) from the ad platforms they have connected, using the same
// server-side access helpers and API calls the Campaigns module uses
// (server.js injects them; nothing here holds credentials). Tokens never
// leave this module — results carry only names, ids and numbers.
//
// Per platform the result is normalized for metrics.js:
//   status 'not_connected' — no integration row, or no ad account selected
//   status 'reconnect'     — the platform refused the stored credentials
//   status 'failed'        — the data could not be retrieved this time
//   status 'ok'            — data retrieved; `metrics` lists what it reports
// Each platform call has its own timeout, so one slow API can't hold up
// the others or the run.

const PROVIDERS = { google: 'google_ads', meta: 'meta_ads', tiktok: 'tiktok_ads', pinterest: 'pinterest_ads' };
const PLATFORM_TIMEOUT_MS = 25000;

const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

function _timeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('platform_timeout'), { status: 504 })), ms); })])
    .finally(() => clearTimeout(t));
}

function _statusFor(err) {
  const s = err && err.status;
  if (s === 401 || s === 403) return 'reconnect';
  if (s === 400) return 'not_connected'; // helpers use 400 for "not connected / no account selected"
  return 'failed';
}

// Meta reports the same conversion under several action types (e.g.
// 'purchase' and 'offsite_conversion.fb_pixel_purchase'); summing them
// double-counts. One value per conversion kind: the largest of its aliases.
const META_CONVERSION_KINDS = [
  ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
  ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped'],
  ['complete_registration', 'offsite_conversion.fb_pixel_complete_registration'],
];
function metaConversions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return META_CONVERSION_KINDS.reduce((sum, kind) => {
    const vals = list.filter((a) => kind.includes(a.action_type)).map((a) => Number(a.value) || 0);
    return sum + (vals.length ? Math.max(...vals) : 0);
  }, 0);
}
function metaPurchaseValue(actionValues) {
  const vals = (Array.isArray(actionValues) ? actionValues : []).filter((a) => META_CONVERSION_KINDS[0].includes(a.action_type)).map((a) => Number(a.value) || 0);
  return vals.length ? Math.max(...vals) : 0;
}

function createCollector({ db, helpers, log }) {
  log = log || (() => {});
  const h = helpers || {};

  async function google(user, period) {
    const { accessToken, customerId, loginCustomerId, accountName, activeAccount } = await h.getGadsAccess(user);
    const q = (p) => h.gadsQuery(accessToken, customerId, `
      SELECT campaign.id, campaign.name, campaign.status,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${p.start}' AND '${p.end}' AND campaign.status != 'REMOVED'`, loginCustomerId);
    const rows = (res) => (res || []).map((r) => {
      const c = r.campaign || {}, m = r.metrics || {};
      return { id: String(c.id || ''), name: c.name, status: c.status, spend: num(m.costMicros) != null ? num(m.costMicros) / 1e6 : 0,
        impressions: num(m.impressions) || 0, clicks: num(m.clicks) || 0, conversions: num(m.conversions) || 0, conversionValue: num(m.conversionsValue) || 0 };
    });
    let currency = activeAccount && activeAccount.currency || null;
    if (!currency) {
      try { const cr = await h.gadsQuery(accessToken, customerId, 'SELECT customer.currency_code FROM customer LIMIT 1', loginCustomerId); currency = (cr[0] && cr[0].customer && cr[0].customer.currencyCode) || null; } catch (_) {}
    }
    const cur = await q(period);
    let prev = null; try { prev = { campaigns: rows(await q(period.previous)) }; } catch (_) {}
    return { account: { name: accountName, currency }, metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'], current: { campaigns: rows(cur) }, previous: prev };
  }

  async function meta(user, period) {
    const { accessToken, accountId, accountName } = await h.getMetaAccess(user);
    let currency = null;
    try { const a = await h.metaFetch('/' + accountId, accessToken, { fields: 'currency' }); currency = (a && a.currency) || null; } catch (_) {}
    const week = async (p) => {
      const tr = JSON.stringify({ since: p.start, until: p.end });
      const [camp, acct] = await Promise.all([
        h.metaFetch('/' + accountId + '/insights', accessToken, { level: 'campaign', time_range: tr, fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values', limit: '200' }),
        h.metaFetch('/' + accountId + '/insights', accessToken, { time_range: tr, fields: 'reach' }).catch(() => null),
      ]);
      const reachRow = acct && acct.data && acct.data[0];
      return {
        campaigns: ((camp && camp.data) || []).map((r) => ({ id: String(r.campaign_id || ''), name: r.campaign_name,
          spend: num(r.spend) || 0, impressions: num(r.impressions) || 0, clicks: num(r.clicks) || 0,
          conversions: metaConversions(r.actions), conversionValue: metaPurchaseValue(r.action_values) })),
        reach: reachRow ? num(reachRow.reach) : null,
      };
    };
    const cur = await week(period);
    let prev = null; try { prev = await week(period.previous); } catch (_) {}
    const metrics = ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'].concat(cur.reach != null ? ['reach'] : []);
    return { account: { name: accountName, currency }, metrics, current: cur, previous: prev };
  }

  async function tiktok(user, period, intg) {
    const { accessToken, advertiserId, accountName } = await h.getTikTokAccess(user);
    const list = await h.tiktokFetch('/campaign/get/', accessToken, { advertiser_id: advertiserId, fields: JSON.stringify(['campaign_id', 'campaign_name', 'operation_status']), page_size: '100' });
    const names = {}; ((list && list.list) || []).forEach((c) => { names[String(c.campaign_id)] = c.campaign_name; });
    const week = async (p) => {
      const [camp, acct] = await Promise.all([
        h.tiktokFetch('/report/integrated/get/', accessToken, { advertiser_id: advertiserId, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN',
          dimensions: JSON.stringify(['campaign_id']), metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']), start_date: p.start, end_date: p.end, page_size: '200' }),
        h.tiktokFetch('/report/integrated/get/', accessToken, { advertiser_id: advertiserId, report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER',
          dimensions: JSON.stringify(['advertiser_id']), metrics: JSON.stringify(['reach']), start_date: p.start, end_date: p.end }).catch(() => null),
      ]);
      const reachRow = acct && acct.list && acct.list[0] && acct.list[0].metrics;
      return {
        campaigns: ((camp && camp.list) || []).map((r) => { const id = String((r.dimensions || {}).campaign_id || ''), m = r.metrics || {};
          return { id, name: names[id] || 'Campaign ' + id, spend: num(m.spend) || 0, impressions: num(m.impressions) || 0, clicks: num(m.clicks) || 0, conversions: num(m.conversion) || 0 }; }),
        reach: reachRow ? num(reachRow.reach) : null,
      };
    };
    const cur = await week(period);
    let prev = null; try { prev = await week(period.previous); } catch (_) {}
    const active = (intg && intg.active_ad_account) || {};
    const metrics = ['spend', 'impressions', 'clicks', 'conversions'].concat(cur.reach != null ? ['reach'] : []);
    return { account: { name: accountName, currency: active.currency || null }, metrics, current: cur, previous: prev };
  }

  async function pinterest(user, period) {
    const { accessToken, adAccountId, accountName, activeAccount } = await h.getPinterestAccess(user);
    const list = await h.pinterestApiRequest(accessToken, 'GET', '/ad_accounts/' + adAccountId + '/campaigns?page_size=100');
    const camps = (list && list.items) || [];
    const names = {}; camps.forEach((c) => { names[String(c.id)] = c.name; });
    const week = async (p) => {
      if (!camps.length) return { campaigns: [] };
      const params = new URLSearchParams({ start_date: p.start, end_date: p.end, campaign_ids: camps.map((c) => String(c.id)).join(','),
        columns: 'CAMPAIGN_ID,SPEND_IN_DOLLAR,TOTAL_IMPRESSION,TOTAL_CLICKTHROUGH,TOTAL_CONVERSIONS', granularity: 'TOTAL' });
      const data = await h.pinterestApiRequest(accessToken, 'GET', '/ad_accounts/' + adAccountId + '/campaigns/analytics?' + params.toString());
      const rows = Array.isArray(data) ? data : ((data && data.items) || []);
      return { campaigns: rows.map((row) => { const r = row.metrics || row, id = String(r.CAMPAIGN_ID || row.campaign_id || '');
        return { id, name: names[id] || 'Campaign ' + id, spend: num(r.SPEND_IN_DOLLAR) || 0, impressions: num(r.TOTAL_IMPRESSION) || 0, clicks: num(r.TOTAL_CLICKTHROUGH) || 0, conversions: num(r.TOTAL_CONVERSIONS) || 0 }; }) };
    };
    const cur = await week(period);
    let prev = null; try { prev = await week(period.previous); } catch (_) {}
    return { account: { name: accountName, currency: (activeAccount && activeAccount.currency) || null }, metrics: ['spend', 'impressions', 'clicks', 'conversions'], current: cur, previous: prev };
  }

  const FETCH = { google, meta, tiktok, pinterest };

  // user: { id }. Returns one result per platform, in a fixed order.
  async function collect(user, period) {
    const { data: rows, error } = await db.from('integrations').select('provider, active_ad_account').eq('user_id', user.id).in('provider', Object.values(PROVIDERS));
    if (error) throw error;
    const byProvider = {}; (rows || []).forEach((r) => { byProvider[r.provider] = r; });
    return Promise.all(Object.keys(PROVIDERS).map(async (platform) => {
      const intg = byProvider[PROVIDERS[platform]];
      if (!intg) return { platform, status: 'not_connected' };
      try {
        const out = await _timeout(FETCH[platform](user, period, intg), PLATFORM_TIMEOUT_MS);
        return Object.assign({ platform, status: 'ok' }, out);
      } catch (err) {
        const status = _statusFor(err);
        log('[WeeklyReport] ' + platform + ' ' + status + ' (' + (err && err.status ? err.status : 'error') + ')'); // no tokens, no ids
        return { platform, status };
      }
    }));
  }

  return { collect };
}

module.exports = { createCollector, metaConversions, metaPurchaseValue, PROVIDERS };
