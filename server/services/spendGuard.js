// ── Spend guard: a cheap safety net against runaway provider spend ──
//
// Not a billing system. It keeps rough, in-process counters of what the
// AI provider is costing today and refuses NEW provider calls when a
// hard threshold is crossed, so one bug, loop or session can't quietly
// drain the AIMLAPI balance. A refused call throws AiSpendLimitError
// before any request is sent; paid routes then refund through the normal
// paid-action settlement (services/paidActions.js).
//
//   AI_DAILY_COST_ALERT_USD   (default 10)  log an ALERT once per UTC day
//   AI_DAILY_COST_CAP_USD     (default 30)  refuse all new provider calls
//   AI_USER_DAILY_CALL_CAP    (default 200) refuse one user's calls
//   AI_USER_BURST_CALLS       (default 25)  ALERT when one user makes this
//                                            many calls in 5 minutes
//
// Costs are ESTIMATES from the list prices below (provider-reported tokens
// when available). Counters are per Node process and reset on restart —
// on Render's single instance that is "per deploy/day". They complement,
// not replace, the AIMLAPI dashboard.

const PRICES = {
  // USD per 1M tokens (input, output) — Anthropic list prices; AIMLAPI
  // resells at its own rate, so real cost is somewhat higher.
  'claude-opus-4-8': { in: 5, out: 25 },
  'perplexity/sonar': { in: 1, out: 1, perCall: 0.005 },
  'Qwen3-Coder-480B-A35B-Instruct': { in: 0.5, out: 2 },
  // Flat per-call estimates where tokens aren't reported.
  'openai/gpt-image-2.5-sunburst': { perCall: 0.05 },
  'kling-video/v1.6/pro/text-to-video': { perCall: 0.5 },
};
// When a text call reports no usage, assume this many tokens.
const FALLBACK_TOKENS = { in: 4000, out: 2000 };

function _num(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const limits = () => ({
  alertUsd: _num('AI_DAILY_COST_ALERT_USD', 10),
  capUsd: _num('AI_DAILY_COST_CAP_USD', 30),
  userDailyCalls: _num('AI_USER_DAILY_CALL_CAP', 200),
  userBurstCalls: _num('AI_USER_BURST_CALLS', 25),
});

let _day = '';
let _state = null;
function _today() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== _day) { _day = d; _state = { costUsd: 0, calls: 0, alerted: false, users: new Map() }; }
  return _state;
}
function _user(s, userId) {
  const k = userId || 'anonymous';
  let u = s.users.get(k);
  if (!u) { u = { calls: 0, costUsd: 0, recent: [], burstAlertAt: 0 }; s.users.set(k, u); }
  return u;
}

function estimateCost(model, usage) {
  const p = PRICES[model];
  if (!p) return 0;
  let usd = p.perCall || 0;
  if (p.in != null || p.out != null) {
    const tin = usage && usage.promptTokens != null ? usage.promptTokens : FALLBACK_TOKENS.in;
    const tout = usage && usage.completionTokens != null ? usage.completionTokens : FALLBACK_TOKENS.out;
    usd += (tin * (p.in || 0) + tout * (p.out || 0)) / 1e6;
  }
  return usd;
}

class AiSpendLimitError extends Error {
  constructor(reason) {
    super('OrivenAI\'s generation service is temporarily unavailable. Please try again later.');
    this.name = 'AiSpendLimitError';
    this.code = 'AI_SPEND_LIMIT';
    this.reason = reason;
    this.status = 503;
    this.retryable = false;
  }
}

function _alert(fields) {
  console.warn('[AIUsage] ALERT ' + JSON.stringify(Object.assign({ ts: new Date().toISOString() }, fields)));
}

// Called before every provider request that can cost money.
function preflight(userId) {
  const s = _today(), L = limits();
  if (s.costUsd >= L.capUsd) {
    _alert({ event: 'daily_cost_cap_reached', estCostUsd: +s.costUsd.toFixed(2), capUsd: L.capUsd });
    throw new AiSpendLimitError('daily_cost_cap');
  }
  if (userId) {
    const u = _user(s, userId);
    if (u.calls >= L.userDailyCalls) {
      _alert({ event: 'user_daily_call_cap_reached', userId: String(userId).slice(0, 64), calls: u.calls, cap: L.userDailyCalls });
      throw new AiSpendLimitError('user_daily_call_cap');
    }
  }
}

// Called after every provider call (success or failure).
function recordCall({ userId, model, usage, success }) {
  const s = _today(), L = limits();
  const cost = success ? estimateCost(model, usage) : 0;
  s.calls += 1; s.costUsd += cost;
  const u = _user(s, userId);
  u.calls += 1; u.costUsd += cost;
  const now = Date.now();
  u.recent.push(now);
  while (u.recent.length && now - u.recent[0] > 5 * 60 * 1000) u.recent.shift();
  if (u.recent.length >= L.userBurstCalls && now - u.burstAlertAt > 10 * 60 * 1000) {
    u.burstAlertAt = now;
    _alert({ event: 'abnormal_user_call_volume', userId: userId ? String(userId).slice(0, 64) : null, callsLast5Min: u.recent.length });
  }
  if (!s.alerted && s.costUsd >= L.alertUsd) {
    s.alerted = true;
    _alert({ event: 'daily_cost_alert', estCostUsd: +s.costUsd.toFixed(2), alertUsd: L.alertUsd, capUsd: L.capUsd });
  }
  return cost;
}

let _accountAlertAt = 0;
// Provider says OrivenAI's own account can't serve requests (balance,
// quota, key). Logged loudly at most every 10 minutes.
function providerAccountProblem(detail) {
  const now = Date.now();
  if (now - _accountAlertAt < 10 * 60 * 1000) return;
  _accountAlertAt = now;
  _alert({ event: 'provider_account_error', detail: String(detail || '').slice(0, 160), action: 'Check the AIMLAPI balance/plan/key' });
}

function snapshot() {
  const s = _today();
  return { day: _day, estCostUsd: +s.costUsd.toFixed(4), calls: s.calls, users: s.users.size, limits: limits() };
}
function _resetForTests() { _day = ''; _state = null; _accountAlertAt = 0; }

module.exports = { PRICES, estimateCost, preflight, recordCall, providerAccountProblem, snapshot, AiSpendLimitError, _resetForTests };
