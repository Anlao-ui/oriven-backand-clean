// ════════════════════════════════════════════════════════════════
// AIML API Provider — Oriven experimental AI layer
//
// Single provider for image and video generation.
// Swap or extend models by passing options.model to any function.
//
// Video (create): POST https://api.aimlapi.com/v2/video/generations
//   Default model: kling-video/v1/standard/text-to-video
//   Response:      { id, status }
//
// Video (poll):   GET  https://api.aimlapi.com/v2/video/generations?generation_id={id}
//   Response:      { id, status, video: { url } }
//
// Auth:   Authorization: Bearer ${AIML_API_KEY}
// Key:    ALWAYS from process.env.AIML_API_KEY — never hardcoded or sent to frontend.
// ════════════════════════════════════════════════════════════════

// AIML_BASE_OVERRIDE lets tests/staging point this provider at a local
// mock or sandbox endpoint without touching provider logic — unset in
// every real environment, so production always uses the real API.
const AIML_BASE          = process.env.AIML_BASE_OVERRIDE || 'https://api.aimlapi.com';
const DEFAULT_VID_MODEL  = 'kling-video/v1/standard/text-to-video';
const DEFAULT_TXT_MODEL  = 'gpt-4o';

// ── Key helpers ───────────────────────────────────────────────

function _readRaw() {
  const raw = process.env.AIML_API_KEY || '';
  return raw.replace(/^﻿/, '').replace(/^[\s\r\n]+|[\s\r\n]+$/g, '');
}

function _key() {
  const key = _readRaw();
  if (!key) throw new Error('AIML_API_KEY is not configured — set it in .env');
  return key;
}

function isConfigured() {
  return !!_readRaw();
}

// ── Startup diagnostic ────────────────────────────────────────

function diagnose() {
  const envName = 'AIML_API_KEY';
  const raw     = process.env[envName];
  const trimmed = _readRaw();

  console.log('');
  console.log('── AIML API Provider ─────────────────────────────────');
  console.log('[AIML] env var              :', envName);
  console.log('[AIML] exists               :', raw !== undefined);
  console.log('[AIML] raw length           :', raw ? raw.length : 0);
  console.log('[AIML] trimmed length       :', trimmed.length);

  if (raw && raw.length !== trimmed.length) {
    console.warn('[AIML] ⚠️  whitespace detected in AIML_API_KEY — this may cause 401 errors');
  }

  if (trimmed) {
    const masked = trimmed.slice(0, 5) + '[...' + trimmed.slice(-4) + ']';
    console.log('[AIML] key (first 5 / last 4):', masked);
    console.log('[AIML] auth header            : Authorization: Bearer ' + masked);
    console.log('[AIML] video endpoint         :', AIML_BASE + '/v2/video/generations');
    console.log('[AIML] default video model    :', DEFAULT_VID_MODEL);
    console.log('[AIML] configured             : true ✅');
  } else {
    console.error('[AIML] ❌ AIML_API_KEY not set — image and video generation will return 503');
    console.error('[AIML]    Set AIML_API_KEY in .env (local) or Render dashboard (prod)');
  }
  console.log('──────────────────────────────────────────────────────');
  console.log('');
}

// ── Brand Core injection ──────────────────────────────────────
// Converts the brandCore object into a formatted context string
// that is injected into every image and video generation prompt.

function buildBrandContext(brandCore) {
  if (!brandCore) return '';
  const bc = brandCore;
  const lines = [];

  if (bc.name)        lines.push(`Brand: ${bc.name}`);
  if (bc.toneOfVoice) lines.push(`Tone of voice: ${bc.toneOfVoice}`);
  if (bc.personality) lines.push(`Brand personality: ${bc.personality}`);
  if (bc.audience)    lines.push(`Target audience: ${bc.audience}`);
  if (bc.messaging)   lines.push(`Key message: ${bc.messaging}`);

  // Colours: accept [{ hex, name }] arrays or flat primaryColor/secondaryColor fields
  if (Array.isArray(bc.colors) && bc.colors.length > 0) {
    const cols = bc.colors
      .slice(0, 3)
      .map(c => (typeof c === 'string' ? c : (c.hex || c.name || '')))
      .filter(Boolean)
      .join(', ');
    if (cols) lines.push(`Brand colours: ${cols}`);
  } else {
    if (bc.primaryColor)   lines.push(`Primary colour: ${bc.primaryColor}`);
    if (bc.secondaryColor) lines.push(`Secondary colour: ${bc.secondaryColor}`);
  }

  return lines.join('\n');
}

// ── Concurrency limiter ─────────────────────────────────────────
// A single campaign generation can fan out many simultaneous
// /api/generate-image calls (one per ad slot in the campaign structure --
// up to 25 for a large ad set), each of which reaches this SAME shared
// AIML account/key. Firing all of them at once needlessly multiplies the
// odds of tripping AIML's own rate limit on ourselves, independent of
// whatever headroom the account actually has. This caps how many AIML
// HTTP calls are in flight at once, server-wide (across every request,
// every user), queuing the rest in arrival order -- not a rate limiter
// (no time window), just bounded concurrency, so ordinary sequential
// traffic is never slowed down, only genuinely simultaneous bursts.
// Tunable via AIML_MAX_CONCURRENT without a code change.
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.AIML_MAX_CONCURRENT, 10) || 5;
let _activeRequests = 0;
const _requestQueue = [];

// The wait queue is bounded (AIML_MAX_QUEUE, default 20): past that the
// request is refused immediately (503, nothing sent, credits refunded by
// the paid-action settlement) instead of piling up minutes of billable
// work behind a burst.
const MAX_QUEUE = parseInt(process.env.AIML_MAX_QUEUE, 10) || 20;
function _acquireSlot() {
  if (_activeRequests < MAX_CONCURRENT_REQUESTS) {
    _activeRequests++;
    return Promise.resolve();
  }
  if (_requestQueue.length >= MAX_QUEUE) {
    const err = new Error('OrivenAI\'s generation service is busy right now. Please try again in a moment.');
    err.status = 503;
    err.code = 'AI_BUSY';
    err.busy = true;
    err.retryable = false;
    return Promise.reject(err);
  }
  return new Promise((resolve) => _requestQueue.push(resolve));
}
function queueState() { return { active: _activeRequests, queued: _requestQueue.length, maxConcurrent: MAX_CONCURRENT_REQUESTS, maxQueue: MAX_QUEUE }; }
function _releaseSlot() {
  const next = _requestQueue.shift();
  if (next) next(); // hand the slot straight to the next queued caller
  else _activeRequests--;
}

// ── Retry / timeout policy ───────────────────────────────────────
// A provider request is retried ONLY when the provider certainly did not
// start (and so cannot bill) the work:
//   • the connection failed before the request was sent (DNS failure,
//     connection refused, connect timeout, host/network unreachable)
//   • HTTP 429 or 503 — the provider refused it up front
// Each of those gets at most ONE retry (AIML_MAX_RETRIES caps attempts at
// 2), honoring Retry-After up to 15s.
//
// Never retried: a timeout, a connection dropped after sending, 500/502/
// 504, provider-account errors (401/402/403/quota/billing), other 4xx and
// malformed bodies. Those may already have been processed — and billed —
// upstream, or can't succeed on a retry; the caller fails and the paid
// action is refunded (services/paidActions.js).
//
// Every attempt has a hard timeout (AbortController), so a hung provider
// can never keep a request (and the user's credits) in limbo:
//   chat/text 180s (AIML_TIMEOUT_MS), image 240s, image edit 240s,
//   video submit 60s, status polls 30s.
const RETRY_STATUS = new Set([429, 503]);
const MAX_ATTEMPTS = Math.min(Math.max(parseInt(process.env.AIML_MAX_RETRIES, 10) || 2, 1), 2);
const BASE_DELAY_MS = 1500;
const MAX_RETRY_AFTER_MS = 15000;
const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function _retryDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (!Number.isNaN(sec) && sec > 0) return Math.min(sec * 1000, MAX_RETRY_AFTER_MS);
  }
  return Math.round(BASE_DELAY_MS * attempt * (1 + 0.25 * Math.random()));
}

function _timeoutFor(method, path) {
  if (method === 'GET') return 30000;
  if (path.indexOf('/v2/video/') === 0) return 60000;
  if (path.indexOf('/v1/images/') === 0) return 240000;
  return parseInt(process.env.AIML_TIMEOUT_MS, 10) || 180000;
}

// True only when the failure happened before any bytes reached the provider.
function _failedBeforeSend(netErr) {
  const code = (netErr && netErr.cause && netErr.cause.code) || (netErr && netErr.code) || '';
  return PRE_SEND_CODES.has(code);
}

// Optional hooks set by server.js: before() runs ahead of every billable
// (non-GET) request and may throw to refuse it (spend guard); after() sees
// the final outcome (provider-account alerting, video/edit cost tracking).
let _hooks = {};
function setHooks(hooks) { _hooks = hooks || {}; }

// One sender for JSON and multipart requests.
// makeOpts() returns fresh fetch options per attempt (a FormData/JSON body
// is rebuilt each time); `tag` only labels log lines.
async function _send(method, path, makeOpts, tag) {
  if (method !== 'GET' && typeof _hooks.before === 'function') _hooks.before({ method, path });
  const url = `${AIML_BASE}${path}`;
  const timeoutMs = _timeoutFor(method, path);
  await _acquireSlot();
  let outcome = { ok: false, providerAccount: false, attempts: 0 };
  try {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      outcome.attempts = attempt;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let response, data, parseFailed = false, text = '';
      try {
        response = await fetch(url, Object.assign(makeOpts(), { signal: ctrl.signal }));
        try { data = await response.json(); }
        catch (parseErr) {
          if (parseErr && parseErr.name === 'AbortError') throw parseErr;
          parseFailed = true;
          text = await response.text().catch(() => '(empty)');
        }
      } catch (netErr) {
        clearTimeout(timer);
        if (netErr && netErr.name === 'AbortError') {
          lastErr = new Error(`AIML API timed out after ${Math.round(timeoutMs / 1000)}s (${path})`);
          lastErr.timeout = true;
          lastErr.retryable = false;
          throw lastErr;
        }
        lastErr = new Error(`AIML API network error: ${netErr && netErr.message}`);
        lastErr.retryable = _failedBeforeSend(netErr);
        if (lastErr.retryable && attempt < MAX_ATTEMPTS) {
          const delay = _retryDelay(attempt);
          console.warn(`[AIML] connection failed before send on attempt ${attempt}/${MAX_ATTEMPTS} (${path}) — retrying in ${delay}ms`);
          await _sleep(delay);
          continue;
        }
        throw lastErr;
      }
      clearTimeout(timer);

      if (!parseFailed && response.ok) { outcome.ok = true; return data; }

      lastErr = new Error(parseFailed
        ? `AIML API non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`
        : _friendlyError(data, response.status));
      lastErr.status = response.status;
      lastErr.retryable = RETRY_STATUS.has(response.status);
      if (_isProviderAccountError(response.status, parseFailed ? null : data)) {
        lastErr.providerAccount = true;
        lastErr.retryable = false;
        outcome.providerAccount = true;
      }
      if (lastErr.retryable && attempt < MAX_ATTEMPTS) {
        const delay = _retryDelay(attempt, response.headers.get('retry-after'));
        console.warn(`[AIML]${tag ? ' ' + tag : ''} HTTP ${response.status} on attempt ${attempt}/${MAX_ATTEMPTS} (${path}) — retrying in ${delay}ms`);
        await _sleep(delay);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  } finally {
    _releaseSlot();
    if (typeof _hooks.after === 'function') {
      try { _hooks.after(Object.assign({ method, path }, outcome)); } catch (_) {}
    }
  }
}

async function _request(method, path, body) {
  const key = _key();
  return _send(method, path, () => {
    const opts = { method, headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return opts;
  });
}

// ── Friendly error mapping ────────────────────────────────────

// OrivenAI's OWN provider account can't serve the request (no balance,
// plan/quota exhausted, or its key rejected). Never the end user's fault,
// so server.js treats it like any other provider-unavailable condition
// (refund what was reserved + a clear "temporarily unavailable" message)
// instead of a generic generation failure that keeps the charge.
function _isProviderAccountError(httpStatus, data) {
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) return true;
  if (httpStatus === 400 || httpStatus === 422) {
    const raw = String(data?.error?.message || data?.message || data?.error || '');
    return /(insufficient|not enough|no)\s+(credit|balance|fund)|quota|billing|payment required/i.test(raw);
  }
  return false;
}

function _friendlyError(data, httpStatus) {
  const friendly = {
    401: 'Provider authentication failed.',
    403: 'Provider access denied. Check your AIML API plan.',
    429: 'Insufficient AIML API credits or rate limit reached.',
  };
  if (friendly[httpStatus]) return friendly[httpStatus];
  if (httpStatus >= 500) return 'AIML API is temporarily unavailable. Please try again.';
  const raw = data?.error?.message || data?.message || data?.error || JSON.stringify(data);
  return `AIML API error (${httpStatus}): ${String(raw).slice(0, 200)}`;
}

// ── Text generation ───────────────────────────────────────────
// systemOrMessages: string (system prompt) OR messages array
// options: { model, max_tokens, temperature }
// Returns: string (assistant reply)

async function generateText(systemOrMessages, userPrompt, options = {}) {
  let messages;
  if (Array.isArray(systemOrMessages)) {
    messages = systemOrMessages;
  } else {
    messages = [
      { role: 'system', content: systemOrMessages || '' },
      { role: 'user',   content: userPrompt       || '' },
    ].filter(m => m.content);
  }

  const model = options.model || DEFAULT_TXT_MODEL;
  const body  = {
    model,
    messages,
    max_tokens: options.max_tokens || 4096,
  };
  // Claude models reject temperature — only send it for non-Claude models.
  if (!model.startsWith('claude') && options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  // Optional OpenAI-compatible function/tool-calling passthrough
  // (configuration-ready for GPT-6 Astra or any future model that supports
  // it via this same /v1/chat/completions endpoint — standard Chat
  // Completions tool-calling, NOT the separate Responses-API computer-use/
  // browser tool, which this endpoint does not expose). Purely additive:
  // untouched unless a caller explicitly passes options.tools, so every
  // existing call site (which never does) is byte-for-byte unaffected.
  if (Array.isArray(options.tools) && options.tools.length) {
    body.tools = options.tools;
    if (options.tool_choice !== undefined) body.tool_choice = options.tool_choice;
  }
  // web_search_options passthrough (Research Production Sprint — Real
  // Retrieval) — AIMLAPI's native web-search models (confirmed via their
  // docs: perplexity/sonar, perplexity/sonar-pro, gpt-4o-search-preview,
  // gpt-4o-mini-search-preview, and a few others — verified NOT to include
  // openai/gpt-6-astra) return grounding automatically for a plain chat
  // completion; this option is only forwarded when a caller explicitly
  // sets it, so every other call site is unaffected.
  if (options.web_search_options !== undefined) {
    body.web_search_options = options.web_search_options;
  }

  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/txt] → POST /v1/chat/completions | model:', model, '| key prefix:', masked);

  const data = await _request('POST', '/v1/chat/completions', body);
  // options.returnFull: the entire raw response body, needed for
  // web-search-native models — citations/search_results (real source
  // metadata: title/url/date) come back as TOP-LEVEL siblings of
  // `choices`, not nested inside message, so returnMessage alone can't
  // see them. Additive — only returned when a caller explicitly opts in.
  if (options.returnFull) return data || {};
  const message = data?.choices?.[0]?.message || {};
  // options.returnMessage: opt-in full message object (content + tool_calls)
  // for callers that need to see whether the model asked to call a tool.
  // Default stays a plain string — identical to every existing call site.
  return options.returnMessage ? message : (message.content || '');
}

// ── Text + Vision ─────────────────────────────────────────────
// Analyzes an image (base64 data URL) alongside text instructions.
// options: { model, max_tokens }
// Returns: string (assistant reply)

async function generateTextWithVision(system, user, imageDataUrl, options = {}) {
  const model    = options.model || DEFAULT_TXT_MODEL;
  const messages = [
    { role: 'system', content: system },
    {
      role:    'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text',      text:      user },
      ],
    },
  ];
  const body = { model, messages, max_tokens: options.max_tokens || 512 };

  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/vision] → POST /v1/chat/completions | model:', model, '| key prefix:', masked);

  const data = await _request('POST', '/v1/chat/completions', body);
  return data?.choices?.[0]?.message?.content || '';
}

// ── Image generation via AIML proxy ──────────────────────────
// Calls /v1/images/generations on AIML using AIML_API_KEY.
// Uses OpenAI-compatible body format (size, n) — AIML proxies several
// OpenAI-compatible image models this way (production default is
// GPT Image 2.5 Sunburst, set centrally in services/modelRouter.js;
// options.model always arrives already populated from there for every
// real call site — the 'gpt-image-1' literal below is only a defensive
// fallback for a call that omits options.model entirely).
// options: { model, aspect_ratio, size, n }
// Returns: string[]  (array of image URLs)

const _RATIO_TO_SIZE = {
  '1:1':  '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
};

async function generateImage(prompt, options = {}) {
  const model    = options.model || 'gpt-image-1';
  const size     = options.size  || _RATIO_TO_SIZE[options.aspect_ratio] || '1024x1024';
  const n        = options.n     || options.num_images || 1;
  const endpoint = '/v1/images/generations';

  const body = { model, prompt, size, n };

  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/img] Provider: AIML');
  console.log('[AIML/img] Model:', model);
  console.log('[AIML/img] Endpoint:', endpoint);
  console.log('[AIML/img] → POST', endpoint, '| size:', size, '| n:', n, '| key prefix:', masked);
  console.log('[AIML/img]   prompt:', prompt.slice(0, 120));

  const data = await _request('POST', endpoint, body);

  console.log('[AIML/img] ← response keys:', Object.keys(data || {}).join(', '));

  const items = data?.data || [];
  const urls  = items.map(item => (typeof item === 'string' ? item : (item.url || item.b64_json))).filter(Boolean);

  if (!urls.length) throw new Error('AIML API returned no image URLs for model ' + model + '.');
  // Provider-reported usage, if any (logging/cost tracking only; not part of the array's values).
  Object.defineProperty(urls, 'usage', { value: (data && data.usage) || null, enumerable: false });
  return urls;
}

// ── Image editing (image-to-image) via AIML proxy ──────────────
// Calls /v1/images/edits — takes a real source image (not just a text
// prompt) so the model edits/reinterprets it rather than inventing a
// new image from scratch. Used for the business icon's "3D" transform:
// the user's own uploaded logo goes in, a dimensional reinterpretation
// of the SAME mark comes out.
//
// This is a genuinely different wire format from generateImage() above:
// OpenAI-compatible /images/edits is multipart/form-data (a real file
// upload), not a JSON body, so it needs its own minimal request helper
// rather than reusing _request(). Everything else — base URL, auth,
// retry/backoff, error shaping — is shared with the rest of this file.

async function _requestForm(path, form) {
  const key = _key();
  // Deliberately no Content-Type header: fetch sets
  // "multipart/form-data; boundary=..." itself from the FormData body,
  // and hand-setting it here would drop the boundary and break the request.
  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/img-edit] → POST', path, '| key prefix:', masked);
  return _send('POST', path, () => ({ method: 'POST', headers: { 'Authorization': `Bearer ${key}` }, body: form }), 'img-edit');
}

// imageBuffer: Buffer of the source image bytes. mimeType: e.g. 'image/png'.
// options: { model, size }
// Returns: string (a directly usable image URL, or a data: URI if the
// provider only returns base64 — callers should never have to care which).

async function editImage(imageBuffer, mimeType, prompt, options = {}) {
  const model = options.model || 'gpt-image-1';
  const size  = options.size || '1024x1024';

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  const ext = (mimeType || 'image/png').split('/')[1] || 'png';
  form.append('image', new Blob([imageBuffer], { type: mimeType || 'image/png' }), `source.${ext}`);

  console.log('[AIML/img-edit] model:', model, '| size:', size, '| source bytes:', imageBuffer.length);
  console.log('[AIML/img-edit]   prompt:', prompt.slice(0, 150));

  const data = await _requestForm('/v1/images/edits', form);
  console.log('[AIML/img-edit] ← response keys:', Object.keys(data || {}).join(', '));

  const item = (data?.data || [])[0];
  if (!item) throw new Error('AIML API returned no image for model ' + model + '.');
  if (item.url) return item.url;
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  throw new Error('AIML API returned an image in an unrecognized format.');
}

// ── Kling duration validator ──────────────────────────────────
// Kling only accepts 5 or 10 seconds. Anything else returns 400.
// Snap: ≤7 → "5", >7 → "10" (string, matching docs example).

function _snapKlingDuration(raw) {
  const n = Number(raw) || 5;
  const snapped = n <= 7 ? 5 : 10;
  if (snapped !== n) console.warn('[AIML] duration', n, '→ snapped to', snapped, '(Kling only accepts 5 or 10)');
  return String(snapped);
}

// ── Video generation (text-to-video) ─────────────────────────
// options: { model, aspect_ratio, duration, negative_prompt }
// Returns: { generationId: string }

async function generateVideo(prompt, options = {}) {
  const model    = options.model || DEFAULT_VID_MODEL;
  const duration = _snapKlingDuration(options.duration || 5);
  const body     = {
    model,
    prompt,
    aspect_ratio: options.aspect_ratio || '16:9',
    duration,
  };
  if (options.negative_prompt) body.negative_prompt = options.negative_prompt;

  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/vid] → POST /v2/video/generations');
  console.log('[AIML/vid]   model:', model, '| duration:', duration, 's | aspect_ratio:', body.aspect_ratio, '| key prefix:', masked);
  console.log('[AIML/vid]   prompt:', prompt.slice(0, 120));
  console.log('[AIML/vid]   full body:', JSON.stringify(body));

  const data = await _request('POST', '/v2/video/generations', body);

  console.log('[AIML/vid] ← id:', data?.id, '| status:', data?.status);

  const id = data?.id;
  if (!id) throw new Error('AIML API returned no generation ID for video.');
  return { generationId: String(id) };
}

// ── Video generation (image-to-video) ────────────────────────
// options: { model, aspect_ratio, duration, image_end_url }
// Returns: { generationId: string }

async function generateVideoFromImage(imageUrl, prompt, options = {}) {
  const model    = options.model || DEFAULT_VID_MODEL;
  const duration = _snapKlingDuration(options.duration || 5);
  const body     = {
    model,
    prompt:       prompt || '',
    image_url:    imageUrl,
    aspect_ratio: options.aspect_ratio || '16:9',
    duration,
  };
  if (options.image_end_url) body.image_end_url = options.image_end_url;

  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/i2v] → POST /v2/video/generations');
  console.log('[AIML/i2v]   model:', model, '| key prefix:', masked);
  console.log('[AIML/i2v]   image_url:', imageUrl.slice(0, 80), '| prompt:', (prompt || '').slice(0, 80));

  const data = await _request('POST', '/v2/video/generations', body);

  console.log('[AIML/i2v] ← id:', data?.id, '| status:', data?.status);

  const id = data?.id;
  if (!id) throw new Error('AIML API returned no generation ID for image-to-video.');
  return { generationId: String(id) };
}

// ── Video status polling ──────────────────────────────────────
// Returns: { status: 'queued'|'processing'|'completed'|'failed', videoUrl, failureReason }

async function getVideoStatus(generationId) {
  const data = await _request('GET', `/v2/video/generations?generation_id=${encodeURIComponent(generationId)}`);

  const raw    = (data?.status || '').toLowerCase();
  const status = (raw === 'completed' || raw === 'succeeded' || raw === 'done')
               ? 'completed'
               : (raw === 'failed' || raw === 'errored' || raw === 'error')
               ? 'failed'
               : (raw === 'processing' || raw === 'running' || raw === 'dreaming')
               ? 'processing'
               : 'queued';

  console.log('[AIML/status] ←', generationId.slice(0, 16) + '...', '| raw:', raw, '→ normalised:', status);

  // failureReason must always be a plain string -- data.error from the AIML
  // API is frequently a nested object ({ message, code, type }), not a
  // string. Passing that object straight through let it get implicitly
  // stringified downstream as the literal text "[object Object]" wherever
  // a caller didn't defensively unwrap it (some do, some don't), which is
  // exactly the "(Object)" garbage that showed up in generated-video error
  // states. Unwrap it here once, at the source, so every consumer gets a
  // real string no matter what shape the provider returned.
  const rawError = data?.error;
  const failureReason = (rawError && typeof rawError === 'object')
    ? (rawError.message || rawError.error || JSON.stringify(rawError))
    : (rawError || data?.message || null);

  return {
    status,
    videoUrl: data?.video?.url || null,
    failureReason,
  };
}

module.exports = {
  isConfigured,
  diagnose,
  buildBrandContext,
  generateText,
  generateTextWithVision,
  generateImage,
  editImage,
  generateVideo,
  generateVideoFromImage,
  getVideoStatus,
  setHooks,
  queueState,
};
