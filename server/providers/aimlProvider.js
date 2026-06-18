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

const AIML_BASE          = 'https://api.aimlapi.com';
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

// ── Internal HTTP helper ──────────────────────────────────────

async function _request(method, path, body) {
  const key  = _key();
  const url  = `${AIML_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const response = await fetch(url, opts);

  let data;
  try {
    data = await response.json();
  } catch (_) {
    const text = await response.text().catch(() => '(empty)');
    throw new Error(`AIML API non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(_friendlyError(data, response.status));
  }

  return data;
}

// ── Friendly error mapping ────────────────────────────────────

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

  const masked = _readRaw().slice(0, 5) + '[...]';
  console.log('[AIML/txt] → POST /v1/chat/completions | model:', model, '| key prefix:', masked);

  const data = await _request('POST', '/v1/chat/completions', body);
  return data?.choices?.[0]?.message?.content || '';
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
// Uses OpenAI-compatible body format (size, n) since AIML proxies gpt-image-1.
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
  return urls;
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

  return {
    status,
    videoUrl:      data?.video?.url || null,
    failureReason: data?.error      || data?.message || null,
  };
}

module.exports = {
  isConfigured,
  diagnose,
  buildBrandContext,
  generateText,
  generateTextWithVision,
  generateImage,
  generateVideo,
  generateVideoFromImage,
  getVideoStatus,
};
