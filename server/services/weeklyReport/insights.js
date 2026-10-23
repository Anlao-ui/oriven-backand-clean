// ── Weekly report: AI insights (one call, validated) ─────────────────
//
// The AI receives ONLY the validated report from metrics.js (numbers,
// platform names, the top/attention campaign names) and must answer with a
// small JSON object. Its answer is then checked; anything that fails a check
// is dropped as a whole and the email goes out with the facts only:
//   - every number in the text must be one the report contains (or a plain
//     rounding of one);
//   - every quoted name must be a campaign name from the report;
//   - no guarantees or promised outcomes;
//   - no conversions / revenue / ROAS talk when the data has none.
// Cost controls: exactly one provider call per user and week (the runner
// stores the result, so retries never call again), a hard timeout, a small
// max_tokens, and no call at all when there is no data to explain.

const { knownNumbers, campaignNames } = require('./metrics');

const LANG_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese' };
const LIST_KEYS = ['wentWell', 'needsAttention', 'opportunities', 'actions'];
const MAX_ITEMS = 3, MAX_ITEM = 280, MAX_SUMMARY = 420;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TOKENS = 700;

const GUARANTEE = /guarantee|guaranteed|garantie|garantiert|garanti|garantizad|garantid|certainly will|will definitely|risk[- ]free|sure to|zeker weten/i;
const CONVERSION_TALK = /conver[st]|konver|purchase|revenue|omzet|umsatz|chiffre d.affaires|ingresos|receita|vendas?\b|ventes?\b|verk[aä]uf|aankopen?|achats?\b|compras?\b/i;
const ROAS_TALK = /\broas\b|return on ad spend|rendement op advertentie|rentabilit/i;

function _compact(report) {
  return {
    period: { start: report.period.start, end: report.period.end },
    business: report.businessName || null,
    platforms: report.platforms.filter((p) => p.status === 'ok').map((p) => ({
      platform: p.platform, currency: p.account.currency, campaigns: p.campaignsTotal,
      thisWeek: p.totals, previousWeek: p.previousTotals, changePercent: p.changes,
      bestCampaigns: p.top, campaignsNeedingAttention: p.attention.map((c) => Object.assign({}, c)),
      metricsNotReported: ['spend', 'impressions', 'clicks', 'conversions', 'roas', 'reach'].filter((k) => p.totals[k] == null),
    })),
    notConnectedOrFailed: report.platforms.filter((p) => p.status !== 'ok').map((p) => ({ platform: p.platform, status: p.status })),
  };
}

function prompt(report, lang) {
  const language = LANG_NAMES[lang] || LANG_NAMES.en;
  const system = `You write the short analysis section of a weekly advertising performance email for a small business.
Use ONLY the JSON data you are given. Rules:
- Never invent or estimate numbers. Only use numbers that appear in the data, written the same way (you may round).
- Write a campaign name only exactly as it appears in the data, inside double quotes.
- A null value or a metric listed in metricsNotReported means the platform did not report it. Never treat it as zero and never mention it as a result.
- Do not mention conversions, sales, revenue or ROAS for a platform unless the data has a non-null value for it.
- Never promise outcomes. Recommendations are things to check or test, never guaranteed wins. Never present a budget increase as a sure improvement.
- Do not compare against the previous week where previousWeek is null.
- Do not mention dates.
- Write in ${language}. Plain text, no markdown, no emojis.
Reply with ONLY this JSON object:
{"summary":"2-3 sentences on what changed this week","wentWell":["..."],"needsAttention":["..."],"opportunities":["..."],"actions":["practical next step"]}
Each list has 0-3 short items. Use an empty list when the data gives nothing to say.`;
  return { system, user: JSON.stringify(_compact(report)) };
}

function _parse(raw) {
  const s = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const m = s.startsWith('{') ? s : (s.match(/\{[\s\S]*\}/) || [null])[0];
  if (!m) return null;
  try { return JSON.parse(m); } catch (_) { return null; }
}

const clean = (t, max) => String(t == null ? '' : t).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function _normalize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = { summary: clean(obj.summary, MAX_SUMMARY) };
  for (const k of LIST_KEYS) out[k] = (Array.isArray(obj[k]) ? obj[k] : []).map((x) => clean(x, MAX_ITEM)).filter(Boolean).slice(0, MAX_ITEMS);
  if (!out.summary && LIST_KEYS.every((k) => !out[k].length)) return null;
  return out;
}

// Candidate values of a number as written ("1.234,5" / "1,234.5" / "12,5").
function _readings(token) {
  const t = token.replace(/[^\d.,]/g, '');
  const set = new Set();
  const push = (s) => { const v = Number(s); if (Number.isFinite(v)) set.add(v); };
  push(t.replace(/,/g, ''));                       // comma = thousands
  push(t.replace(/\./g, '').replace(',', '.'));    // dot = thousands, comma = decimal
  push(t.replace(/,/g, '.'));                       // lone comma = decimal
  return Array.from(set);
}

function _matches(value, known) {
  for (const k of known) {
    if (Math.abs(value - k) <= Math.max(0.011, Math.abs(k) * 0.005)) return true;
    if (value === Math.round(k) || value === Math.round(k * 10) / 10) return true;
  }
  return false;
}

function validate(insights, report) {
  const known = knownNumbers(report);
  const okPlatforms = report.platforms.filter((p) => p.status === 'ok' && p.hasData);
  known.add(okPlatforms.length); known.add(report.platforms.filter((p) => p.status === 'ok').length);
  const names = campaignNames(report);
  const convAvailable = okPlatforms.some((p) => p.totals.conversions != null && p.totals.conversions > 0);
  const roasAvailable = okPlatforms.some((p) => p.totals.roas != null);
  const texts = [insights.summary].concat(...LIST_KEYS.map((k) => insights[k]));
  for (const text of texts) {
    if (!text) continue;
    if (GUARANTEE.test(text)) return { ok: false, reason: 'guarantee' };
    if (!convAvailable && CONVERSION_TALK.test(text)) return { ok: false, reason: 'conversions_without_data' };
    if (!roasAvailable && ROAS_TALK.test(text)) return { ok: false, reason: 'roas_without_data' };
    for (const q of text.match(/["“”„«»]([^"“”„«»]{2,160})["“”„«»]/g) || []) {
      const name = q.slice(1, -1).trim();
      if (!names.has(name)) return { ok: false, reason: 'unknown_campaign' };
    }
    for (const tok of text.match(/\d[\d.,]*/g) || []) {
      if (!_readings(tok).some((v) => _matches(v, known))) return { ok: false, reason: 'unknown_number' };
    }
  }
  return { ok: true };
}

function _withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('ai_timeout'), { code: 'AI_TIMEOUT' })), ms); })])
    .finally(() => clearTimeout(t));
}

// aiCall(system, user, { max_tokens }) → Promise<string>
// Returns { status: 'ok'|'failed'|'invalid'|'not_needed', insights|null, reason? }
async function generate({ report, lang, aiCall, timeoutMs }) {
  if (!report || !report.hasData) return { status: 'not_needed', insights: null };
  if (typeof aiCall !== 'function') return { status: 'disabled', insights: null };
  const { system, user } = prompt(report, lang);
  let raw;
  try { raw = await _withTimeout(Promise.resolve().then(() => aiCall(system, user, { max_tokens: MAX_TOKENS })), timeoutMs || DEFAULT_TIMEOUT_MS); }
  catch (err) { return { status: 'failed', insights: null, reason: err && err.code === 'AI_TIMEOUT' ? 'timeout' : 'provider_error' }; }
  const insights = _normalize(_parse(raw));
  if (!insights) return { status: 'failed', insights: null, reason: 'unparseable' };
  const v = validate(insights, report);
  if (!v.ok) return { status: 'invalid', insights: null, reason: v.reason };
  return { status: 'ok', insights };
}

module.exports = { generate, validate, prompt, MAX_TOKENS, DEFAULT_TIMEOUT_MS, LANG_NAMES };
