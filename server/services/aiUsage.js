// ── AI usage: prompt hygiene, size guardrail, privacy-safe telemetry ──
//
// One place every server-side AI text call passes through (server.js
// _aimlText / _aimlChat / _aimlVision / _aimlImage, and
// researchToolProvider.search). It does three things:
//
//  1. sanitizeText / sanitizeMessages — inline binary data (data: URIs,
//     raw base64 runs, blob: references) never reaches a text prompt.
//     A stored logo/upload is often a multi-hundred-KB base64 data URI;
//     pasted into a prompt it costs ~30k+ tokens per call and carries no
//     meaning for a text model. Replaced with a short placeholder.
//  2. guardPromptSize — after sanitizing, a prompt above
//     AI_MAX_PROMPT_CHARS (default 200,000 chars ≈ 50k tokens) is refused
//     before any provider call. Prompts above AI_WARN_PROMPT_CHARS
//     (default 60,000) are allowed but logged.
//  3. record — one [AIUsage] log line per provider call with metadata
//     only: provider, model, task, route/operation, token counts the
//     provider actually reported, success, timestamp, user id. Never the
//     prompt, the output, any key, or any binary data.
//
// Request/cron context (route, user id, running token totals) is carried
// with AsyncLocalStorage so callers don't need to thread it through.
// Token totals are read by creditManager.finalizeCreditLog to fill the
// existing credit_transactions.model/tokens_in/tokens_out columns — those
// columns are informational; credits are still charged per feature from
// FEATURE_COSTS, never from tokens.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const DEFAULT_MAX_PROMPT_CHARS = 200000;
const DEFAULT_WARN_PROMPT_CHARS = 60000;

function _intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function maxPromptChars() { return _intEnv('AI_MAX_PROMPT_CHARS', DEFAULT_MAX_PROMPT_CHARS); }
function warnPromptChars() { return _intEnv('AI_WARN_PROMPT_CHARS', DEFAULT_WARN_PROMPT_CHARS); }

// ── Context ──────────────────────────────────────────────────────
function _newCtx(fields) {
  return Object.assign({ route: null, operation: null, userId: null, calls: 0, model: null, provider: null, tokensIn: null, tokensOut: null }, fields || {});
}
// Express middleware: one context per request.
function middleware(req, _res, next) {
  const route = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
  als.run(_newCtx({ route }), next);
}
// For cron/background work: run fn inside its own context.
function withContext(fields, fn) {
  return als.run(_newCtx(fields), fn);
}
function current() { return als.getStore() || null; }
function setUser(userId) {
  const c = current();
  if (c && userId && !c.userId) c.userId = String(userId);
}
// Background jobs loop over users inside one context; this switches the
// attributed user for the calls that follow (only inside a job context).
function setJobUser(userId) {
  const c = current();
  if (c && c.operation) c.userId = userId ? String(userId) : null;
}
// Running totals for the current request — model of the last call and
// summed tokens. tokensIn/tokensOut stay null unless a provider reported them.
function totals() {
  const c = current();
  if (!c || !c.calls) return null;
  return { model: c.model, provider: c.provider, tokensIn: c.tokensIn, tokensOut: c.tokensOut, calls: c.calls };
}

// ── 1. Sanitizer ─────────────────────────────────────────────────
const INLINE_PLACEHOLDER = '[inline data omitted]';
// data:<mime>[;params];base64,<payload> (payload may be wrapped)
const DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]+)*;base64,[A-Za-z0-9+/=\r\n]+/gi;
// Any other data:...;base64 form the strict one above didn't catch
const DATA_URI_LOOSE_RE = /data:[^\s"'<>(),]{0,100};base64,[A-Za-z0-9+/=\r\n]*/gi;
// blob: object URLs are browser-only references, meaningless server-side
const BLOB_RE = /blob:(?:https?|null)[^\s"'<>)]*/gi;
// Long bare base64 runs (no data: prefix). 2,000+ unbroken base64
// characters is never natural text, a URL, or a hex colour.
const LONG_B64_RE = /[A-Za-z0-9+/]{2000,}={0,2}/g;

function sanitizeText(s) {
  if (typeof s !== 'string' || s.length < 5) return { text: s, removed: 0 };
  let removed = 0;
  const count = (m) => { removed += m.length; return INLINE_PLACEHOLDER; };
  let out = s;
  if (out.indexOf('data:') !== -1) out = out.replace(DATA_URI_RE, count).replace(DATA_URI_LOOSE_RE, count);
  if (out.indexOf('blob:') !== -1) out = out.replace(BLOB_RE, (m) => { removed += m.length; return '[file reference omitted]'; });
  if (out.length >= 2000) out = out.replace(LONG_B64_RE, count);
  return { text: out, removed };
}

// messages: [{role, content}] where content is a string or an array of
// parts. Only text is sanitized; image parts are left alone (a vision
// call sends its image intentionally — see _aimlVision).
function sanitizeMessages(messages) {
  let removed = 0;
  const out = (Array.isArray(messages) ? messages : []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content === 'string') {
      const r = sanitizeText(m.content); removed += r.removed;
      return r.removed ? Object.assign({}, m, { content: r.text }) : m;
    }
    if (Array.isArray(m.content)) {
      let changed = false;
      const parts = m.content.map((p) => {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          const r = sanitizeText(p.text);
          if (r.removed) { removed += r.removed; changed = true; return Object.assign({}, p, { text: r.text }); }
        }
        return p;
      });
      return changed ? Object.assign({}, m, { content: parts }) : m;
    }
    return m;
  });
  return { messages: out, removed };
}

function promptChars(messagesOrStrings) {
  let n = 0;
  (Array.isArray(messagesOrStrings) ? messagesOrStrings : [messagesOrStrings]).forEach((m) => {
    if (typeof m === 'string') n += m.length;
    else if (m && typeof m.content === 'string') n += m.content.length;
    else if (m && Array.isArray(m.content)) m.content.forEach((p) => { if (p && typeof p.text === 'string') n += p.text.length; });
  });
  return n;
}

// ── Safe log line ────────────────────────────────────────────────
// Only these fields are ever written. Values are coerced to plain
// numbers/short strings so nothing else can ride along.
function _safe(fields) {
  const c = current() || {};
  const str = (v, max) => (v == null ? null : String(v).slice(0, max || 120));
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    ts: new Date().toISOString(),
    event: str(fields.event, 40),
    provider: str(fields.provider || 'aimlapi', 40),
    model: str(fields.model, 120),
    task: str(fields.task, 80),
    route: str(c.route, 160),
    operation: str(c.operation, 80),
    userId: str(c.userId, 64),
    promptChars: num(fields.promptChars),
    approxPromptTokens: num(fields.promptChars) == null ? null : Math.ceil(fields.promptChars / 4),
    removedInlineChars: num(fields.removedInlineChars),
    promptTokens: num(fields.promptTokens),
    completionTokens: num(fields.completionTokens),
    totalTokens: num(fields.totalTokens),
    tokensReported: fields.tokensReported === true,
    success: fields.success == null ? null : !!fields.success,
    reason: str(fields.reason, 80),
  };
}
function _log(level, fields) {
  const line = _safe(fields);
  Object.keys(line).forEach((k) => { if (line[k] === null) delete line[k]; });
  (level === 'warn' ? console.warn : console.log)('[AIUsage] ' + JSON.stringify(line));
  return line;
}

// ── 2. Guardrail ─────────────────────────────────────────────────
class PromptTooLargeError extends Error {
  constructor(chars, limit) {
    super('This request is too large to process. Shorten the input and try again.');
    this.name = 'PromptTooLargeError';
    this.code = 'AI_PROMPT_TOO_LARGE';
    this.status = 413;
    this.chars = chars;
    this.limit = limit;
  }
}

// Sanitize + size-check. Returns sanitized { messages } (or strings).
// Throws PromptTooLargeError (no provider call happens) when over limit.
function prepareText({ task, model, system, user, messages }) {
  let removed = 0;
  let out;
  if (Array.isArray(messages)) {
    const r = sanitizeMessages(messages); removed = r.removed; out = { messages: r.messages };
  } else {
    const a = sanitizeText(system); const b = sanitizeText(user);
    removed = a.removed + b.removed; out = { system: a.text, user: b.text };
  }
  const chars = out.messages ? promptChars(out.messages) : promptChars([out.system || '', out.user || '']);
  if (removed) _log('warn', { event: 'prompt_inline_data_removed', task, model, promptChars: chars, removedInlineChars: removed, reason: 'inline_binary_in_text_prompt' });
  const limit = maxPromptChars();
  if (chars > limit) {
    _log('warn', { event: 'prompt_rejected', task, model, promptChars: chars, success: false, reason: 'prompt_over_limit' });
    throw new PromptTooLargeError(chars, limit);
  }
  if (chars > warnPromptChars()) _log('warn', { event: 'prompt_large', task, model, promptChars: chars, reason: 'prompt_over_warn_threshold' });
  out.promptChars = chars;
  out.removedInlineChars = removed;
  return out;
}

// ── 3. Usage extraction + record ─────────────────────────────────
// Reads only token counts the provider actually reported. Supports the
// OpenAI shape (prompt_tokens/completion_tokens/total_tokens) and the
// Anthropic shape (input_tokens/output_tokens). Missing => null, never
// estimated.
function extractUsage(data) {
  const u = data && typeof data === 'object' ? data.usage : null;
  if (!u || typeof u !== 'object') return { promptTokens: null, completionTokens: null, totalTokens: null, reported: false };
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const p = n(u.prompt_tokens) != null ? n(u.prompt_tokens) : n(u.input_tokens);
  const c = n(u.completion_tokens) != null ? n(u.completion_tokens) : n(u.output_tokens);
  let t = n(u.total_tokens);
  if (t == null && p != null && c != null) t = p + c;
  return { promptTokens: p, completionTokens: c, totalTokens: t, reported: p != null || c != null || t != null };
}

function record({ task, model, provider, data, promptChars: chars, success, reason }) {
  const usage = success ? extractUsage(data) : { promptTokens: null, completionTokens: null, totalTokens: null, reported: false };
  const c = current();
  if (c) {
    c.calls += 1;
    c.model = model || c.model;
    c.provider = provider || 'aimlapi';
    if (usage.promptTokens != null) c.tokensIn = (c.tokensIn || 0) + usage.promptTokens;
    if (usage.completionTokens != null) c.tokensOut = (c.tokensOut || 0) + usage.completionTokens;
  }
  const line = _log(success ? 'log' : 'warn', {
    event: 'ai_call', task, model, provider, promptChars: chars, success,
    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
    tokensReported: usage.reported, reason: success ? null : (reason || 'provider_error'),
  });
  _persist(line);
  return line;
}

// Optional DB sink — OFF unless AI_USAGE_DB=true and a client was given.
// Requires the ai_usage_events table (see migration in the change report).
// Fire-and-forget; a failure only logs a short warning.
let _db = null;
function configureDb(supabaseClient) { _db = supabaseClient || null; }
function _persist(line) {
  if (!_db || process.env.AI_USAGE_DB !== 'true') return;
  try {
    _db.from('ai_usage_events').insert({
      created_at: line.ts, user_id: line.userId || null, provider: line.provider || null, model: line.model || null,
      task: line.task || null, route: line.route || line.operation || null,
      prompt_tokens: line.promptTokens == null ? null : line.promptTokens,
      completion_tokens: line.completionTokens == null ? null : line.completionTokens,
      total_tokens: line.totalTokens == null ? null : line.totalTokens,
      success: !!line.success,
    }).then(({ error }) => { if (error) console.warn('[AIUsage] db insert failed:', String(error.message || '').slice(0, 120)); }, () => {});
  } catch (_) { /* never break an AI call over telemetry */ }
}

module.exports = {
  middleware, withContext, current, setUser, setJobUser, totals,
  sanitizeText, sanitizeMessages, promptChars, prepareText, extractUsage, record,
  configureDb, PromptTooLargeError, INLINE_PLACEHOLDER,
  maxPromptChars, warnPromptChars,
};
