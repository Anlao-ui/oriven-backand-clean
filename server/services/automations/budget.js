// ════════════════════════════════════════════════════════════════
// Automations — budget safety.
//
// Every automatic or approved budget change goes through computeChange():
//   • an increase needs a user-configured maximum budget (never invented
//     here — without one, automatic increases are refused);
//   • per-action % cap, cumulative % cap over a period (no compounding past
//     it), max financial actions per campaign per day, min hours between
//     changes — all checked against the durable execution history;
//   • amounts are rounded to the currency's real precision (JPY has no
//     minor unit, KWD has three) — never "× 100 for every currency".
// ════════════════════════════════════════════════════════════════
'use strict';

// ISO 4217 minor-unit exponents that differ from 2.
const EXPONENT = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
function exponent(currency) { const c = String(currency || '').toUpperCase(); return Object.prototype.hasOwnProperty.call(EXPONENT, c) ? EXPONENT[c] : 2; }
function round(amount, currency) { const f = Math.pow(10, exponent(currency)); return Math.round(Number(amount) * f) / f; }
// Major units ↔ the platform's smallest unit (Meta "offset" amounts).
function toMinor(amount, currency) { return Math.round(Number(amount) * Math.pow(10, exponent(currency))); }
function fromMinor(minor, currency) { return Number(minor) / Math.pow(10, exponent(currency)); }

const LIMIT_DEFAULTS = { max_change_pct: 20, max_cumulative_pct: 50, cumulative_days: 7, max_actions_per_day: 2, min_hours_between: 24 };
const LIMIT_BOUNDS = { max_change_pct: [1, 50], max_cumulative_pct: [1, 300], cumulative_days: [1, 30], max_actions_per_day: [1, 5], min_hours_between: [1, 168] };

// Validates and fills the limits a budget rule stores (action_params.limits).
// Returns { ok, limits } or { ok:false, error }.
function normalizeLimits(raw, direction) {
  const l = Object.assign({}, LIMIT_DEFAULTS, raw || {});
  for (const k of Object.keys(LIMIT_BOUNDS)) {
    const v = Number(l[k]);
    const [lo, hi] = LIMIT_BOUNDS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) return { ok: false, error: `${k} must be between ${lo} and ${hi}` };
    l[k] = v;
  }
  if (l.max_budget != null && l.max_budget !== '') {
    const m = Number(l.max_budget);
    if (!Number.isFinite(m) || m <= 0) return { ok: false, error: 'max_budget must be a positive amount' };
    l.max_budget = m;
  } else l.max_budget = null;
  if (l.min_budget != null && l.min_budget !== '') {
    const m = Number(l.min_budget);
    if (!Number.isFinite(m) || m < 0) return { ok: false, error: 'min_budget must be zero or more' };
    l.min_budget = m;
  } else l.min_budget = null;
  if (direction === 'increase' && !(l.max_budget > 0)) return { ok: false, error: 'max_budget_required', code: 'max_budget_required' };
  if (l.max_budget != null && l.min_budget != null && l.min_budget >= l.max_budget) return { ok: false, error: 'min_budget must be below max_budget' };
  return { ok: true, limits: l };
}

// history: completed budget changes for THIS campaign (any automation),
// newest last: [{ at: ISO, previous: number, next: number }].
function computeChange({ direction, pct, current, currency, limits, history, now }) {
  now = now || Date.now();
  history = (history || []).filter((h) => h && h.at).sort((a, b) => new Date(a.at) - new Date(b.at));
  const L = Object.assign({}, LIMIT_DEFAULTS, limits || {});
  if (!(Number(current) > 0)) return { ok: false, reason: 'no_current_budget' };
  if (!(Number(pct) > 0)) return { ok: false, reason: 'invalid_percent' };
  const dayAgo = now - 24 * 3600e3;
  const recent = history.filter((h) => new Date(h.at).getTime() >= dayAgo);
  if (recent.length >= L.max_actions_per_day) return { ok: false, reason: 'daily_action_limit', detail: { limit: L.max_actions_per_day } };
  const last = history[history.length - 1];
  if (last && now - new Date(last.at).getTime() < L.min_hours_between * 3600e3) return { ok: false, reason: 'too_soon', detail: { hours: L.min_hours_between } };
  const p = Math.min(Number(pct), L.max_change_pct) / 100;
  let next;
  if (direction === 'increase') {
    if (!(L.max_budget > 0)) return { ok: false, reason: 'no_max_budget' };
    if (current >= L.max_budget) return { ok: false, reason: 'at_max_budget', detail: { max: L.max_budget } };
    next = Math.min(current * (1 + p), L.max_budget);
    // Cumulative cap: measured from the budget before the first increase
    // inside the period, so repeated firings can't compound past it.
    const since = now - L.cumulative_days * 24 * 3600e3;
    const inPeriod = history.filter((h) => new Date(h.at).getTime() >= since && h.next > h.previous);
    const baseline = inPeriod.length ? inPeriod[0].previous : current;
    const cap = baseline * (1 + L.max_cumulative_pct / 100);
    if (next > cap) next = cap;
    if (next <= current) return { ok: false, reason: 'cumulative_limit', detail: { pct: L.max_cumulative_pct, days: L.cumulative_days } };
  } else if (direction === 'decrease') {
    const floor = L.min_budget != null ? L.min_budget : 0;
    next = Math.max(current * (1 - p), floor);
    if (next >= current) return { ok: false, reason: 'at_min_budget', detail: { min: floor } };
  } else return { ok: false, reason: 'invalid_direction' };
  next = round(next, currency);
  const unit = 1 / Math.pow(10, exponent(currency));
  if (Math.abs(next - current) < unit) return { ok: false, reason: 'change_too_small' };
  if (next <= 0) return { ok: false, reason: 'at_min_budget' };
  return { ok: true, previous: round(current, currency), next, pctApplied: Math.round((next / current - 1) * 10000) / 100 };
}

// Spread a campaign-total change over several budget holders (Meta ad sets,
// TikTok ad groups) proportionally, each rounded to the currency.
function scaleItems(items, previousTotal, nextTotal, currency) {
  const f = nextTotal / previousTotal;
  return items.map((it) => ({ id: it.id, previous: it.amount, next: round(it.amount * f, currency) }));
}

module.exports = { EXPONENT, exponent, round, toMinor, fromMinor, LIMIT_DEFAULTS, LIMIT_BOUNDS, normalizeLimits, computeChange, scaleItems };
