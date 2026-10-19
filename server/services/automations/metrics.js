// ════════════════════════════════════════════════════════════════
// Automations — metric values with explicit "no data".
//
// The old Autopilot evaluator read a missing metric as 0, so a campaign
// with no conversions had "CPA 0" (it matched "CPA < 10" and got its
// budget raised) and Meta campaigns, which carry no ROAS field, matched
// every "ROAS < x" rule. Here a metric is either a real number computed
// from real data, or a reason why it can't be used:
//   no_data           — the platform returned nothing for this campaign
//   insufficient_data — below the rule's minimum data (impressions, clicks,
//                       conversions or spend)
//   unavailable       — the platform/report doesn't provide this metric
//   undefined_ratio   — a ratio whose denominator is 0 (CPA with 0
//                       conversions, CTR with 0 impressions, CPC with 0
//                       clicks, ROAS with 0 spend)
// A rule never fires on anything but { ok: true }.
// ════════════════════════════════════════════════════════════════
'use strict';

// Plain-language descriptions are in the frontend (six languages); these are
// the evaluation definitions.
const METRICS = {
  spend:       { kind: 'money', label: 'Spend' },
  impressions: { kind: 'count', label: 'Impressions' },
  clicks:      { kind: 'count', label: 'Clicks' },
  conversions: { kind: 'count', label: 'Conversions' },
  ctr:         { kind: 'percent', label: 'CTR' },
  cpc:         { kind: 'money', label: 'CPC' },
  cpa:         { kind: 'money', label: 'CPA' },
  roas:        { kind: 'ratio', label: 'ROAS' },
  status:      { kind: 'status', label: 'Campaign status' },
};

// What each platform's reporting (as integrated in OrivenAI) provides.
// ROAS needs a conversion VALUE: Google (conversions_value), Meta
// (action_values for purchases) and Pinterest (checkout value) report one;
// the TikTok report OrivenAI reads has no value column, so no ROAS there.
const PLATFORM_METRICS = {
  google:    ['spend', 'impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'cpa', 'roas', 'status'],
  meta:      ['spend', 'impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'cpa', 'roas', 'status'],
  tiktok:    ['spend', 'impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'cpa', 'status'],
  pinterest: ['spend', 'impressions', 'clicks', 'conversions', 'ctr', 'cpc', 'cpa', 'roas', 'status'],
};

const OPERATORS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '==': (a, b) => a === b };
const DATA_WINDOWS = [1, 3, 7, 14, 30];

// Defaults applied when a rule doesn't set its own minimum. Ratio metrics
// are meaningless on a handful of events, so they need real volume first.
const DEFAULT_MIN_DATA = {
  ctr: { impressions: 1000 },
  cpc: { clicks: 20 },
  cpa: { conversions: 3 },
  roas: { spend: 50, conversions: 3 },
};

const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));

function availableFor(platform, metric) { return (PLATFORM_METRICS[platform] || []).includes(metric); }

// campaign.metrics: { spend, impressions, clicks, conversions, conversionValue }
// (each a number or null when the platform returned nothing).
function metricValue(campaign, metric, minData, platform) {
  if (!METRICS[metric]) return { ok: false, reason: 'unavailable' };
  if (platform && !availableFor(platform, metric)) return { ok: false, reason: 'unavailable' };
  if (metric === 'status') {
    const s = campaign && campaign.status;
    return s === 'active' || s === 'paused' ? { ok: true, value: s } : { ok: false, reason: 'no_data' };
  }
  const m = (campaign && campaign.metrics) || {};
  const spend = num(m.spend), impressions = num(m.impressions), clicks = num(m.clicks), conversions = num(m.conversions), value = num(m.conversionValue);
  const need = Object.assign({}, DEFAULT_MIN_DATA[metric] || {}, minData || {});
  const have = { spend, impressions, clicks, conversions };
  for (const k of Object.keys(need)) {
    if (!(need[k] > 0)) continue;
    if (have[k] == null) return { ok: false, reason: 'no_data' };
    if (have[k] < need[k]) return { ok: false, reason: 'insufficient_data', detail: { field: k, have: have[k], need: need[k] } };
  }
  switch (metric) {
    case 'spend': return spend == null ? { ok: false, reason: 'no_data' } : { ok: true, value: spend };
    case 'impressions': return impressions == null ? { ok: false, reason: 'no_data' } : { ok: true, value: impressions };
    case 'clicks': return clicks == null ? { ok: false, reason: 'no_data' } : { ok: true, value: clicks };
    case 'conversions': return conversions == null ? { ok: false, reason: 'no_data' } : { ok: true, value: conversions };
    case 'ctr':
      if (impressions == null || clicks == null) return { ok: false, reason: 'no_data' };
      if (impressions === 0) return { ok: false, reason: 'undefined_ratio' };
      return { ok: true, value: (clicks / impressions) * 100 };
    case 'cpc':
      if (spend == null || clicks == null) return { ok: false, reason: 'no_data' };
      if (clicks === 0) return { ok: false, reason: 'undefined_ratio' };
      return { ok: true, value: spend / clicks };
    case 'cpa':
      if (spend == null || conversions == null) return { ok: false, reason: 'no_data' };
      if (conversions === 0) return { ok: false, reason: 'undefined_ratio' }; // never "CPA 0"
      return { ok: true, value: spend / conversions };
    case 'roas':
      if (value == null) return { ok: false, reason: 'no_data' }; // no conversion value reported → no ROAS
      if (spend == null) return { ok: false, reason: 'no_data' };
      if (spend === 0) return { ok: false, reason: 'undefined_ratio' };
      return { ok: true, value: value / spend };
    default: return { ok: false, reason: 'unavailable' };
  }
}

// Compare with a small epsilon for money/ratio equality.
function compare(actual, operator, threshold) {
  const op = OPERATORS[operator];
  if (!op) return false;
  if (typeof actual === 'string') return operator === '==' && actual === threshold;
  if (operator === '==') return Math.abs(actual - threshold) < 1e-9;
  return op(actual, threshold);
}

module.exports = { METRICS, PLATFORM_METRICS, OPERATORS, DATA_WINDOWS, DEFAULT_MIN_DATA, availableFor, metricValue, compare };
