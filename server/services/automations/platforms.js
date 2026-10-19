// ════════════════════════════════════════════════════════════════
// Automations — platform adapters.
//
// One shape for every platform, built on the API helpers server.js already
// uses (passed in as deps, so nothing here re-implements auth or HTTP):
//
//   campaign = { id, name, status: 'active'|'paused'|'archived'|'other',
//                rawStatus, metrics: { spend, impressions, clicks,
//                conversions, conversionValue } | null,
//                budget: { scope, amount, currency, items, editable,
//                          reason, shared } }
//
//   budget.scope: 'campaign' (campaign daily budget)
//                 'adset'   (Meta ad sets — how OrivenAI Launch publishes)
//                 'adgroup' (TikTok / Pinterest ad groups)
//                 'shared'  (Google shared budget — not editable here)
//                 'lifetime' | 'none' (not editable by a daily-% rule)
//
// metrics is null when the platform's report failed (→ "no data", never 0);
// a campaign missing from a successful report had no delivery in the
// window, which IS a real zero.
//
// Capabilities are documented API behaviour; LIVE status for each platform
// is reported separately (see the final report) — none of these calls has
// been exercised against a live ad account from this codebase yet.
// ════════════════════════════════════════════════════════════════
'use strict';

const B = require('./budget');

const PLATFORMS = ['google', 'meta', 'tiktok', 'pinterest'];
const PROVIDER = { google: 'google_ads', meta: 'meta_ads', tiktok: 'tiktok_ads', pinterest: 'pinterest_ads' };
const LABEL = { google: 'Google Ads', meta: 'Meta Ads', tiktok: 'TikTok Ads', pinterest: 'Pinterest Ads' };

const CAPABILITIES = {
  google:    { status: true, budget: true, budgetScopes: ['campaign'], notes: ['Shared budgets are never changed by a rule (they affect other campaigns).'] },
  meta:      { status: true, budget: true, budgetScopes: ['campaign', 'adset'], notes: ['Ad-set budgets (how OrivenAI publishes) are scaled together; lifetime budgets are not changed.'] },
  tiktok:    { status: true, budget: true, budgetScopes: ['campaign', 'adgroup'], notes: ['Total (lifetime) budgets are not changed.'] },
  pinterest: { status: true, budget: true, budgetScopes: ['campaign', 'adgroup'], notes: ['Lifetime spend caps are not changed.'] },
};

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }
function windowDates(days, now) {
  now = now || Date.now();
  // Today is partial everywhere; the window ends yesterday (UTC dates).
  const until = now - 24 * 3600e3;
  return { since: ymd(until - (days - 1) * 24 * 3600e3), until: ymd(until) };
}
const n = (v) => (v == null || v === '' || !isFinite(Number(v)) ? 0 : Number(v));

// Error → { kind: 'auth'|'not_connected'|'rate_limited'|'transient'|'platform', message }
// Error text is stored in the activity log and shown to the user, so anything
// that looks like a credential is removed first (defence in depth: the
// platform helpers already pass only the provider's message, never the URL).
function redact(s) {
  return String(s)
    .replace(/(access_token|refresh_token|client_secret|developer[-_]token|api[-_]?key|token)(["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(EAA[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9._-]{20,}|pina_[A-Za-z0-9]{20,})/g, '[redacted]');
}
function classifyError(err) {
  const msg = redact((err && err.message) || err || 'error').slice(0, 500);
  const st = err && err.status;
  if (/not connected|No active .* account/i.test(msg)) return { kind: 'not_connected', message: msg };
  if (st === 401 || (err && err.metaCode === 190) || /expired|reconnect|invalid.*token|OAuthException/i.test(msg)) return { kind: 'auth', message: msg };
  if (st === 429 || (err && [4, 17, 32, 613, 80004].includes(err.metaCode)) || (err && err.tikTokCode === 40100) || /rate limit|too many/i.test(msg)) return { kind: 'rate_limited', message: msg };
  if (st === 403) return { kind: 'permission', message: msg };
  if (st === 503 || st === 502 || st === 504 || /network|timed out|ECONN/i.test(msg)) return { kind: 'transient', message: msg };
  return { kind: 'platform', message: msg };
}

function create(d) {
  // ── Google Ads ──────────────────────────────────────────────────
  const google = {
    async account(user) {
      const a = await d._getGadsAccess(user);
      let currency = null, timezone = null;
      const rows = await d._gadsQuery(a.accessToken, a.customerId, 'SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1', a.loginCustomerId);
      if (rows && rows[0] && rows[0].customer) { currency = rows[0].customer.currencyCode || null; timezone = rows[0].customer.timeZone || null; }
      return { access: a, accountId: String(a.customerId), currency, timezone };
    },
    _campaign(r, currency) {
      const c = r.campaign || {}, b = r.campaignBudget || {};
      const st = c.status === 'ENABLED' ? 'active' : c.status === 'PAUSED' ? 'paused' : c.status === 'REMOVED' ? 'archived' : 'other';
      const shared = b.explicitlyShared === true || b.explicitlyShared === 'true';
      const budget = { scope: 'campaign', amount: b.amountMicros != null ? Number(b.amountMicros) / 1e6 : null, currency, items: [], editable: true, resourceName: b.resourceName || null };
      if (!b.resourceName) { budget.scope = 'none'; budget.editable = false; budget.reason = 'no_budget'; }
      else if (shared) { budget.scope = 'shared'; budget.editable = false; budget.reason = 'shared_budget'; budget.shared = { referenceCount: Number(b.referenceCount || 0) }; }
      else if (b.period && b.period !== 'DAILY') { budget.scope = 'lifetime'; budget.editable = false; budget.reason = 'not_daily'; }
      return { id: String(c.id), name: c.name || '', status: st, rawStatus: c.status || '', metrics: null, budget };
    },
    async listCampaigns(user, days) {
      const acc = await google.account(user);
      const { accessToken, customerId, loginCustomerId } = acc.access;
      const base = await d._gadsQuery(accessToken, customerId,
        "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period, campaign_budget.reference_count FROM campaign WHERE campaign.status != 'REMOVED'", loginCustomerId);
      const list = (base || []).map((r) => google._campaign(r, acc.currency));
      if (days) {
        const w = windowDates(days);
        try {
          const rows = await d._gadsQuery(accessToken, customerId,
            `SELECT campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${w.since}' AND '${w.until}' AND campaign.status != 'REMOVED'`, loginCustomerId);
          const by = {};
          (rows || []).forEach((r) => { by[String(r.campaign && r.campaign.id)] = r.metrics || {}; });
          list.forEach((c) => {
            const m = by[c.id];
            // Absent from a successful date-filtered report = no delivery = real zeros.
            c.metrics = m ? { spend: n(m.costMicros) / 1e6, impressions: n(m.impressions), clicks: n(m.clicks), conversions: n(m.conversions), conversionValue: n(m.conversionsValue) }
              : { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
          });
        } catch (err) { list.forEach((c) => { c.metrics = null; c.metricsError = classifyError(err).kind; }); }
      }
      return { account: { id: acc.accountId, currency: acc.currency, timezone: acc.timezone }, campaigns: list };
    },
    async getCampaign(user, id) {
      if (!/^\d+$/.test(String(id))) return null;
      const acc = await google.account(user);
      const { accessToken, customerId, loginCustomerId } = acc.access;
      const rows = await d._gadsQuery(accessToken, customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${String(id)}`, loginCustomerId);
      if (!rows || !rows[0]) return null;
      return Object.assign(google._campaign(rows[0], acc.currency), { accountId: acc.accountId });
    },
    async setStatus(user, id, status) {
      const { access } = await google.account(user);
      await d._gadsMutate(access.accessToken, access.customerId, 'campaigns', [{ updateMask: 'status', update: { resourceName: 'customers/' + access.customerId + '/campaigns/' + id, status: status === 'active' ? 'ENABLED' : 'PAUSED' } }], access.loginCustomerId);
    },
    async setBudget(user, campaign, change) {
      if (campaign.budget.scope !== 'campaign' || !campaign.budget.resourceName) throw Object.assign(new Error('This budget can’t be changed by an automation.'), { kind: 'platform' });
      const { access } = await google.account(user);
      await d._gadsMutate(access.accessToken, access.customerId, 'campaignBudgets', [{ updateMask: 'amountMicros', update: { resourceName: campaign.budget.resourceName, amountMicros: String(Math.round(change.next * 1e6)) } }], access.loginCustomerId);
      return [{ id: campaign.budget.resourceName, previous: change.previous, next: change.next }];
    },
  };

  // ── Meta Ads ────────────────────────────────────────────────────
  const PURCHASE = new Set(['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase']);
  const metaStatus = (s) => s === 'ACTIVE' ? 'active' : s === 'PAUSED' ? 'paused' : (s === 'ARCHIVED' || s === 'DELETED') ? 'archived' : 'other';
  async function metaAll(path, token, params) {
    const out = [];
    let after = null;
    for (let page = 0; page < 10; page++) {
      const q = Object.assign({}, params, after ? { after } : {});
      const data = await d._metaFetch(path, token, q);
      (data.data || []).forEach((x) => out.push(x));
      after = data.paging && data.paging.cursors && data.paging.next ? data.paging.cursors.after : null;
      if (!after) break;
    }
    return out;
  }
  const meta = {
    async account(user) {
      const a = await d._getMetaAccess(user);
      const info = await d._metaFetch('/' + a.accountId, a.accessToken, { fields: 'currency,timezone_name' });
      return { access: a, accountId: a.accountId, currency: (info && info.currency) || null, timezone: (info && info.timezone_name) || null };
    },
    _budget(c, adsets, currency) {
      if (c.daily_budget) return { scope: 'campaign', amount: B.fromMinor(c.daily_budget, currency), currency, items: [], editable: true };
      if (c.lifetime_budget && Number(c.lifetime_budget) > 0) return { scope: 'lifetime', amount: B.fromMinor(c.lifetime_budget, currency), currency, items: [], editable: false, reason: 'lifetime_budget' };
      const own = adsets.filter((s) => String(s.campaign_id) === String(c.id) && metaStatus(s.status) !== 'archived');
      if (!own.length) return { scope: 'none', amount: null, currency, items: [], editable: false, reason: 'no_budget' };
      if (own.some((s) => !s.daily_budget)) return { scope: 'adset', amount: null, currency, items: [], editable: false, reason: 'lifetime_budget' };
      const items = own.map((s) => ({ id: String(s.id), name: s.name || '', amount: B.fromMinor(s.daily_budget, currency) }));
      return { scope: 'adset', amount: B.round(items.reduce((t, i) => t + i.amount, 0), currency), currency, items, editable: true };
    },
    async listCampaigns(user, days) {
      const acc = await meta.account(user);
      const t = acc.access.accessToken, act = acc.accountId;
      const [camps, adsets] = await Promise.all([
        metaAll('/' + act + '/campaigns', t, { fields: 'id,name,status,daily_budget,lifetime_budget', effective_status: '["ACTIVE","PAUSED","CAMPAIGN_PAUSED","ADSET_PAUSED","IN_PROCESS","WITH_ISSUES","PENDING_REVIEW"]', limit: '200' }),
        metaAll('/' + act + '/adsets', t, { fields: 'id,name,campaign_id,status,daily_budget,lifetime_budget', limit: '500' }),
      ]);
      const list = camps.map((c) => ({ id: String(c.id), name: c.name || '', status: metaStatus(c.status), rawStatus: c.status || '', metrics: null, budget: meta._budget(c, adsets, acc.currency) }));
      if (days) {
        const w = windowDates(days);
        try {
          const rows = await metaAll('/' + act + '/insights', t, { level: 'campaign', fields: 'campaign_id,spend,impressions,clicks,actions,action_values', time_range: JSON.stringify({ since: w.since, until: w.until }), limit: '500' });
          const by = {};
          rows.forEach((r) => { by[String(r.campaign_id)] = r; });
          list.forEach((c) => {
            const r = by[c.id];
            if (!r) { c.metrics = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: null }; return; }
            const vals = (r.action_values || []).filter((a) => PURCHASE.has(a.action_type));
            c.metrics = { spend: n(r.spend), impressions: n(r.impressions), clicks: n(r.clicks), conversions: d._metaConversions(r.actions), conversionValue: vals.length ? vals.reduce((s, a) => s + n(a.value), 0) : null };
          });
        } catch (err) { list.forEach((c) => { c.metrics = null; c.metricsError = classifyError(err).kind; }); }
      }
      return { account: { id: act, currency: acc.currency, timezone: acc.timezone }, campaigns: list };
    },
    async getCampaign(user, id) {
      if (!/^\d+$/.test(String(id))) return null;
      const acc = await meta.account(user);
      const t = acc.access.accessToken;
      const c = await d._metaFetch('/' + id, t, { fields: 'id,name,status,daily_budget,lifetime_budget,account_id' });
      if (!c || !c.id) return null;
      // Ownership: the campaign must belong to the user's active ad account.
      if (c.account_id && 'act_' + String(c.account_id).replace(/^act_/, '') !== acc.accountId) return null;
      const adsets = await metaAll('/' + id + '/adsets', t, { fields: 'id,name,campaign_id,status,daily_budget,lifetime_budget', limit: '200' });
      return { id: String(c.id), name: c.name || '', status: metaStatus(c.status), rawStatus: c.status || '', metrics: null, budget: meta._budget(c, adsets, acc.currency), accountId: acc.accountId };
    },
    async setStatus(user, id, status) {
      const { access } = await meta.account(user);
      await d._metaApiPost('/' + id, access.accessToken, { status: status === 'active' ? 'ACTIVE' : 'PAUSED' });
    },
    async setBudget(user, campaign, change) {
      const { access } = await meta.account(user);
      const cur = campaign.budget.currency;
      if (campaign.budget.scope === 'campaign') {
        await d._metaApiPost('/' + campaign.id, access.accessToken, { daily_budget: String(B.toMinor(change.next, cur)) });
        return [{ id: campaign.id, previous: change.previous, next: change.next }];
      }
      if (campaign.budget.scope !== 'adset') throw Object.assign(new Error('This budget can’t be changed by an automation.'), { kind: 'platform' });
      const items = B.scaleItems(campaign.budget.items, change.previous, change.next, cur);
      const done = [];
      try {
        for (const it of items) { await d._metaApiPost('/' + it.id, access.accessToken, { daily_budget: String(B.toMinor(it.next, cur)) }); done.push(it); }
      } catch (err) {
        // Put back the ad sets already changed, so the campaign isn't left half-updated.
        for (const it of done) { try { await d._metaApiPost('/' + it.id, access.accessToken, { daily_budget: String(B.toMinor(it.previous, cur)) }); } catch (_) { err.rollbackFailed = true; } }
        err.partial = { changed: done.length, total: items.length, rolledBack: !err.rollbackFailed };
        throw err;
      }
      return items;
    },
  };

  // ── TikTok Ads ──────────────────────────────────────────────────
  const tiktokStatus = (c) => (/DELETE/.test(String(c.secondary_status || '')) ? 'archived' : c.operation_status === 'ENABLE' ? 'active' : c.operation_status === 'DISABLE' ? 'paused' : 'other');
  async function ttAll(path, token, params, key) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const data = await d._tiktokFetch(path, token, Object.assign({}, params, { page: String(page), page_size: params.page_size || '100' }));
      ((data && data.list) || []).forEach((x) => out.push(x));
      const total = data && data.page_info && data.page_info.total_page;
      if (!total || page >= total) break;
    }
    return out;
  }
  const tiktok = {
    async account(user) {
      const a = await d._getTikTokAccess(user);
      let currency = null, timezone = null;
      try {
        const info = await d._tiktokFetch('/advertiser/info/', a.accessToken, { advertiser_ids: JSON.stringify([a.advertiserId]), fields: JSON.stringify(['currency', 'timezone']) });
        const row = ((info && (info.list || info)) || [])[0] || {};
        currency = row.currency || null; timezone = row.timezone || null;
      } catch (_) { /* currency stays unknown → budget changes are refused */ }
      return { access: a, accountId: a.advertiserId, currency, timezone };
    },
    _budget(c, adgroups, currency) {
      if (c.budget_mode === 'BUDGET_MODE_DAY' && n(c.budget) > 0) return { scope: 'campaign', amount: n(c.budget), currency, items: [], editable: !!currency, reason: currency ? undefined : 'unknown_currency' };
      if (c.budget_mode === 'BUDGET_MODE_TOTAL') return { scope: 'lifetime', amount: n(c.budget), currency, items: [], editable: false, reason: 'lifetime_budget' };
      const own = adgroups.filter((g) => String(g.campaign_id) === String(c.campaign_id) && !/DELETE/.test(String(g.secondary_status || '')));
      if (!own.length) return { scope: 'none', amount: null, currency, items: [], editable: false, reason: 'no_budget' };
      if (own.some((g) => g.budget_mode !== 'BUDGET_MODE_DAY')) return { scope: 'adgroup', amount: null, currency, items: [], editable: false, reason: 'lifetime_budget' };
      const items = own.map((g) => ({ id: String(g.adgroup_id), name: g.adgroup_name || '', amount: n(g.budget) }));
      return { scope: 'adgroup', amount: B.round(items.reduce((t, i) => t + i.amount, 0), currency), currency, items, editable: !!currency, reason: currency ? undefined : 'unknown_currency' };
    },
    async listCampaigns(user, days) {
      const acc = await tiktok.account(user);
      const t = acc.access.accessToken, adv = acc.accountId;
      const camps = await ttAll('/campaign/get/', t, { advertiser_id: adv, fields: JSON.stringify(['campaign_id', 'campaign_name', 'operation_status', 'secondary_status', 'budget', 'budget_mode']) });
      const groups = await ttAll('/adgroup/get/', t, { advertiser_id: adv, fields: JSON.stringify(['adgroup_id', 'adgroup_name', 'campaign_id', 'budget', 'budget_mode', 'operation_status', 'secondary_status']) });
      const list = camps.map((c) => ({ id: String(c.campaign_id), name: c.campaign_name || '', status: tiktokStatus(c), rawStatus: c.operation_status || '', metrics: null, budget: tiktok._budget(c, groups, acc.currency) }));
      if (days) {
        const w = windowDates(days);
        try {
          const rows = await ttAll('/report/integrated/get/', t, { advertiser_id: adv, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: JSON.stringify(['campaign_id']), metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']), start_date: w.since, end_date: w.until, page_size: '1000' });
          const by = {};
          rows.forEach((r) => { by[String((r.dimensions || {}).campaign_id)] = r.metrics || {}; });
          list.forEach((c) => {
            const m = by[c.id];
            c.metrics = m ? { spend: n(m.spend), impressions: n(m.impressions), clicks: n(m.clicks), conversions: n(m.conversion), conversionValue: null } : { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: null };
          });
        } catch (err) { list.forEach((c) => { c.metrics = null; c.metricsError = classifyError(err).kind; }); }
      }
      return { account: { id: adv, currency: acc.currency, timezone: acc.timezone }, campaigns: list };
    },
    async getCampaign(user, id) {
      if (!/^\d+$/.test(String(id))) return null;
      const acc = await tiktok.account(user);
      const t = acc.access.accessToken, adv = acc.accountId;
      const camps = await ttAll('/campaign/get/', t, { advertiser_id: adv, filtering: JSON.stringify({ campaign_ids: [String(id)] }), fields: JSON.stringify(['campaign_id', 'campaign_name', 'operation_status', 'secondary_status', 'budget', 'budget_mode']) });
      const c = camps.find((x) => String(x.campaign_id) === String(id));
      if (!c) return null; // not in the user's advertiser → not theirs
      const groups = await ttAll('/adgroup/get/', t, { advertiser_id: adv, filtering: JSON.stringify({ campaign_ids: [String(id)] }), fields: JSON.stringify(['adgroup_id', 'adgroup_name', 'campaign_id', 'budget', 'budget_mode', 'operation_status', 'secondary_status']) });
      return { id: String(c.campaign_id), name: c.campaign_name || '', status: tiktokStatus(c), rawStatus: c.operation_status || '', metrics: null, budget: tiktok._budget(c, groups, acc.currency), accountId: adv };
    },
    async setStatus(user, id, status) {
      const { access } = await tiktok.account(user);
      await d._tiktokPost('/campaign/status/update/', access.accessToken, { advertiser_id: access.advertiserId, campaign_ids: [String(id)], operation_status: status === 'active' ? 'ENABLE' : 'DISABLE' });
    },
    async setBudget(user, campaign, change) {
      const { access } = await tiktok.account(user);
      if (campaign.budget.scope === 'campaign') {
        await d._tiktokPost('/campaign/update/', access.accessToken, { advertiser_id: access.advertiserId, campaign_id: campaign.id, budget: change.next });
        return [{ id: campaign.id, previous: change.previous, next: change.next }];
      }
      if (campaign.budget.scope !== 'adgroup') throw Object.assign(new Error('This budget can’t be changed by an automation.'), { kind: 'platform' });
      const items = B.scaleItems(campaign.budget.items, change.previous, change.next, campaign.budget.currency);
      // One request for all ad groups (documented /adgroup/budget/update/).
      await d._tiktokPost('/adgroup/budget/update/', access.accessToken, { advertiser_id: access.advertiserId, budget: items.map((i) => ({ adgroup_id: i.id, budget: i.next })) });
      return items;
    },
  };

  // ── Pinterest Ads ───────────────────────────────────────────────
  const pinStatus = (s) => s === 'ACTIVE' ? 'active' : s === 'PAUSED' ? 'paused' : s === 'ARCHIVED' ? 'archived' : 'other';
  async function pinAll(token, path) {
    const out = [];
    let bookmark = null;
    for (let page = 0; page < 10; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await d._pinterestApiRequest(token, 'GET', path + sep + 'page_size=100' + (bookmark ? '&bookmark=' + encodeURIComponent(bookmark) : ''));
      (data.items || []).forEach((x) => out.push(x));
      bookmark = data.bookmark || null;
      if (!bookmark) break;
    }
    return out;
  }
  function pinCheck(resp) {
    const bad = ((resp && resp.items) || []).find((i) => i && i.exceptions && i.exceptions.length);
    if (bad) { const e = new Error(bad.exceptions[0].message || 'Pinterest rejected the change'); e.status = 400; throw e; }
  }
  const pinterest = {
    async account(user) {
      const a = await d._getPinterestAccess(user);
      let currency = null;
      try { const info = await d._pinterestApiRequest(a.accessToken, 'GET', '/ad_accounts/' + a.adAccountId); currency = (info && info.currency) || null; } catch (_) {}
      return { access: a, accountId: String(a.adAccountId), currency, timezone: null };
    },
    _budget(c, groups, currency) {
      if (n(c.daily_spend_cap) > 0) return { scope: 'campaign', amount: n(c.daily_spend_cap) / 1e6, currency, items: [], editable: !!currency, reason: currency ? undefined : 'unknown_currency' };
      if (n(c.lifetime_spend_cap) > 0) return { scope: 'lifetime', amount: n(c.lifetime_spend_cap) / 1e6, currency, items: [], editable: false, reason: 'lifetime_budget' };
      const own = groups.filter((g) => String(g.campaign_id) === String(c.id) && g.status !== 'ARCHIVED');
      if (!own.length) return { scope: 'none', amount: null, currency, items: [], editable: false, reason: 'no_budget' };
      if (own.some((g) => g.budget_type !== 'DAILY' || !(n(g.budget_in_micro_currency) > 0))) return { scope: 'adgroup', amount: null, currency, items: [], editable: false, reason: 'lifetime_budget' };
      const items = own.map((g) => ({ id: String(g.id), name: g.name || '', amount: n(g.budget_in_micro_currency) / 1e6 }));
      return { scope: 'adgroup', amount: B.round(items.reduce((t, i) => t + i.amount, 0), currency), currency, items, editable: !!currency, reason: currency ? undefined : 'unknown_currency' };
    },
    async listCampaigns(user, days) {
      const acc = await pinterest.account(user);
      const t = acc.access.accessToken, ad = acc.accountId;
      const camps = await pinAll(t, '/ad_accounts/' + ad + '/campaigns');
      const groups = await pinAll(t, '/ad_accounts/' + ad + '/ad_groups');
      const list = camps.filter((c) => pinStatus(c.status) !== 'archived').map((c) => ({ id: String(c.id), name: c.name || '', status: pinStatus(c.status), rawStatus: c.status || '', metrics: null, budget: pinterest._budget(c, groups, acc.currency) }));
      if (days && list.length) {
        const w = windowDates(days);
        try {
          const by = {};
          for (let i = 0; i < list.length; i += 200) {
            const ids = list.slice(i, i + 200).map((c) => c.id).join(',');
            const qs = new URLSearchParams({ start_date: w.since, end_date: w.until, campaign_ids: ids, granularity: 'TOTAL', columns: 'CAMPAIGN_ID,SPEND_IN_DOLLAR,TOTAL_IMPRESSION,TOTAL_CLICKTHROUGH,TOTAL_CONVERSIONS,TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR' });
            const data = await d._pinterestApiRequest(t, 'GET', '/ad_accounts/' + ad + '/campaigns/analytics?' + qs.toString());
            const rows = Array.isArray(data) ? data : (data.items || []);
            rows.forEach((row) => { const r = row.metrics || row; if (r.CAMPAIGN_ID != null) by[String(r.CAMPAIGN_ID)] = r; });
          }
          list.forEach((c) => {
            const r = by[c.id];
            c.metrics = r ? { spend: n(r.SPEND_IN_DOLLAR), impressions: n(r.TOTAL_IMPRESSION), clicks: n(r.TOTAL_CLICKTHROUGH), conversions: n(r.TOTAL_CONVERSIONS), conversionValue: r.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR != null ? n(r.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR) / 1e6 : null }
              : { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: null };
          });
        } catch (err) { list.forEach((c) => { c.metrics = null; c.metricsError = classifyError(err).kind; }); }
      }
      return { account: { id: ad, currency: acc.currency, timezone: null }, campaigns: list };
    },
    async getCampaign(user, id) {
      if (!/^\d+$/.test(String(id))) return null;
      const acc = await pinterest.account(user);
      const t = acc.access.accessToken, ad = acc.accountId;
      let c;
      try { c = await d._pinterestApiRequest(t, 'GET', '/ad_accounts/' + ad + '/campaigns/' + encodeURIComponent(id)); } catch (err) { if (err.status === 404) return null; throw err; }
      if (!c || !c.id) return null;
      const groups = await pinAll(t, '/ad_accounts/' + ad + '/ad_groups?campaign_ids=' + encodeURIComponent(id));
      return { id: String(c.id), name: c.name || '', status: pinStatus(c.status), rawStatus: c.status || '', metrics: null, budget: pinterest._budget(c, groups, acc.currency), accountId: ad };
    },
    async setStatus(user, id, status) {
      const { access } = await pinterest.account(user);
      pinCheck(await d._pinterestApiRequest(access.accessToken, 'PATCH', '/ad_accounts/' + access.adAccountId + '/campaigns', [{ id: String(id), status: status === 'active' ? 'ACTIVE' : 'PAUSED' }]));
    },
    async setBudget(user, campaign, change) {
      const { access } = await pinterest.account(user);
      if (campaign.budget.scope === 'campaign') {
        pinCheck(await d._pinterestApiRequest(access.accessToken, 'PATCH', '/ad_accounts/' + access.adAccountId + '/campaigns', [{ id: campaign.id, daily_spend_cap: Math.round(change.next * 1e6) }]));
        return [{ id: campaign.id, previous: change.previous, next: change.next }];
      }
      if (campaign.budget.scope !== 'adgroup') throw Object.assign(new Error('This budget can’t be changed by an automation.'), { kind: 'platform' });
      const items = B.scaleItems(campaign.budget.items, change.previous, change.next, campaign.budget.currency);
      pinCheck(await d._pinterestApiRequest(access.accessToken, 'PATCH', '/ad_accounts/' + access.adAccountId + '/ad_groups', items.map((i) => ({ id: i.id, budget_in_micro_currency: Math.round(i.next * 1e6) }))));
      return items;
    },
  };

  return { google, meta, tiktok, pinterest };
}

module.exports = { PLATFORMS, PROVIDER, LABEL, CAPABILITIES, create, classifyError, windowDates };
