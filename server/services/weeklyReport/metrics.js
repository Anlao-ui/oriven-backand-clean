// ── Weekly report: metric aggregation (pure) ─────────────────────────
//
// Input: one normalized result per platform from collect.js:
//   { platform, status, account: { name, currency }, metrics: [..reported keys],
//     current:  { campaigns: [{ id, name, status, spend, impressions, clicks,
//                                conversions, conversionValue, reach }], reach },
//     previous: same shape | null }
// status: 'ok' | 'not_connected' | 'reconnect' | 'failed'
//
// Rules this module guarantees (the email and the AI only ever see its output):
//   - a metric a platform doesn't report is null ("unavailable"), never 0;
//   - a reported zero stays 0;
//   - money is never summed across currencies, and an account without a
//     verified currency contributes no money totals at all;
//   - conversions are never summed across platforms (each platform counts
//     them with its own attribution);
//   - reach is never summed across campaigns (people overlap) — only the
//     platform's own deduplicated account-level reach is used;
//   - ROAS only when the platform reports a conversion value above zero;
//   - week-over-week changes only when both weeks were retrieved and the
//     previous value is above zero.

const METRIC_KEYS = ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'];
const MAX_NAME = 120;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const validCurrency = (c) => (typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : null);

function _sum(campaigns, key, reported) {
  if (!reported) return null;
  let total = 0, any = false;
  for (const c of campaigns) { const v = num(c[key]); if (v != null) { total += v; any = true; } }
  return any ? total : 0;
}

function _totals(period, reported, currency) {
  if (!period) return null;
  const campaigns = Array.isArray(period.campaigns) ? period.campaigns : [];
  const has = (k) => reported.includes(k);
  const spend = currency ? _sum(campaigns, 'spend', has('spend')) : null;
  const impressions = _sum(campaigns, 'impressions', has('impressions'));
  const clicks = _sum(campaigns, 'clicks', has('clicks'));
  const conversions = _sum(campaigns, 'conversions', has('conversions'));
  const conversionValue = currency ? _sum(campaigns, 'conversionValue', has('conversionValue')) : null;
  return {
    spend: r2(spend),
    impressions, clicks,
    ctr: impressions > 0 && clicks != null ? r2((clicks / impressions) * 100) : null,
    cpc: spend != null && clicks > 0 ? r2(spend / clicks) : null,
    conversions: r2(conversions),
    roas: spend > 0 && conversionValue > 0 ? r2(conversionValue / spend) : null,
    reach: has('reach') ? num(period.reach) : null,
    campaignsWithDelivery: campaigns.filter((c) => (num(c.impressions) || 0) > 0 || (num(c.spend) || 0) > 0).length,
  };
}

function _changes(cur, prev) {
  const out = {};
  if (!cur || !prev) return out;
  for (const k of ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'roas', 'reach']) {
    if (cur[k] != null && prev[k] != null && prev[k] > 0) out[k] = r1(((cur[k] - prev[k]) / prev[k]) * 100);
  }
  return out;
}

function _campaignRow(c, currency) {
  const impressions = num(c.impressions), clicks = num(c.clicks), spend = currency ? num(c.spend) : null;
  return {
    name: String(c.name || 'Unnamed campaign').slice(0, MAX_NAME),
    spend: r2(spend), impressions, clicks,
    ctr: impressions > 0 && clicks != null ? r2((clicks / impressions) * 100) : null,
    conversions: r2(num(c.conversions)),
  };
}

function _highlights(period, totals, reported, currency) {
  const rows = (period && Array.isArray(period.campaigns) ? period.campaigns : [])
    .filter((c) => (num(c.impressions) || 0) > 0 || (num(c.spend) || 0) > 0)
    .map((c) => _campaignRow(c, currency));
  const byConv = reported.includes('conversions') && rows.some((c) => c.conversions > 0);
  const top = rows.slice()
    .sort((a, b) => (byConv ? (b.conversions || 0) - (a.conversions || 0) : (b.clicks || 0) - (a.clicks || 0)) || (b.impressions || 0) - (a.impressions || 0))
    .filter((c) => (byConv ? c.conversions > 0 : c.clicks > 0))
    .slice(0, 3);
  const attention = [];
  for (const c of rows) {
    if (c.spend > 0 && c.clicks === 0) attention.push(Object.assign({ reason: 'spend_no_clicks' }, c));
    else if (c.impressions >= 1000 && totals.ctr > 0 && c.ctr != null && c.ctr < totals.ctr * 0.5) attention.push(Object.assign({ reason: 'low_ctr' }, c));
  }
  attention.sort((a, b) => (b.spend || 0) - (a.spend || 0) || (b.impressions || 0) - (a.impressions || 0));
  return { top, attention: attention.slice(0, 3), rankedBy: byConv ? 'conversions' : 'clicks' };
}

function buildPlatform(res) {
  const base = { platform: res.platform, status: res.status, account: { name: res.account && res.account.name ? String(res.account.name).slice(0, MAX_NAME) : null, currency: null } };
  if (res.status !== 'ok') return base;
  const currency = validCurrency(res.account && res.account.currency);
  const reported = (Array.isArray(res.metrics) ? res.metrics : []).filter((k) => METRIC_KEYS.includes(k) || k === 'reach');
  const totals = _totals(res.current, reported, currency);
  const previousTotals = res.previous ? _totals(res.previous, reported, currency) : null;
  const hl = _highlights(res.current, totals, reported, currency);
  return Object.assign(base, {
    account: { name: base.account.name, currency },
    currencyMissing: !currency,
    reported,
    campaignsTotal: (res.current && Array.isArray(res.current.campaigns) ? res.current.campaigns.length : 0),
    totals, previousTotals,
    comparison: previousTotals ? 'available' : 'unavailable',
    changes: _changes(totals, previousTotals),
    top: hl.top, attention: hl.attention, rankedBy: hl.rankedBy,
    hasData: totals.campaignsWithDelivery > 0,
  });
}

// period: lastCompletedWeek() output; context: { businessName }
function buildReport(results, period, context) {
  const platforms = (results || []).map(buildPlatform);
  const withData = platforms.filter((p) => p.hasData);
  const spendBy = {};
  withData.forEach((p) => { if (p.account.currency && p.totals.spend != null) spendBy[p.account.currency] = r2((spendBy[p.account.currency] || 0) + p.totals.spend); });
  const sumOrNull = (k) => { const v = withData.map((p) => p.totals[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  return {
    version: 1,
    period: { start: period.start, end: period.end, previous: period.previous, timeZone: period.timeZone, defaultTimeZone: !!period.defaultTimeZone },
    businessName: context && context.businessName ? String(context.businessName).slice(0, MAX_NAME) : null,
    platforms,
    overview: {
      spendByCurrency: Object.keys(spendBy).sort().map((c) => ({ currency: c, amount: spendBy[c] })),
      impressions: sumOrNull('impressions'),
      clicks: sumOrNull('clicks'),
      campaignsWithDelivery: withData.reduce((a, p) => a + p.totals.campaignsWithDelivery, 0),
    },
    connected: platforms.filter((p) => p.status === 'ok').length,
    needsReconnect: platforms.filter((p) => p.status === 'reconnect').map((p) => p.platform),
    failed: platforms.filter((p) => p.status === 'failed').map((p) => p.platform),
    hasData: withData.length > 0,
  };
}

// Every number a reader of the report can legitimately see, for validating
// AI text (insights.js). Includes the derived percentages and counts.
function knownNumbers(report) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'number' && Number.isFinite(v)) out.add(Math.abs(v)); };
  (report.platforms || []).forEach((p) => {
    if (p.totals) Object.values(p.totals).forEach(add);
    if (p.previousTotals) Object.values(p.previousTotals).forEach(add);
    Object.values(p.changes || {}).forEach(add);
    (p.top || []).concat(p.attention || []).forEach((c) => ['spend', 'impressions', 'clicks', 'ctr', 'conversions'].forEach((k) => add(c[k])));
    add(p.campaignsTotal);
  });
  (report.overview.spendByCurrency || []).forEach((s) => add(s.amount));
  add(report.overview.impressions); add(report.overview.clicks); add(report.overview.campaignsWithDelivery);
  return out;
}

function campaignNames(report) {
  const out = new Set();
  (report.platforms || []).forEach((p) => (p.top || []).concat(p.attention || []).forEach((c) => out.add(c.name)));
  return out;
}

module.exports = { buildReport, buildPlatform, knownNumbers, campaignNames, METRIC_KEYS };
