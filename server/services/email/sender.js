// ── Email sender: Resend REST API, with safe modes ───────────────────
//
// EMAIL_MODE (default 'off'):
//   off  — nothing is sent; send() returns { skipped: 'mode_off' }
//   test — ONLY addresses listed in EMAIL_TEST_ALLOWLIST can receive email
//          (subject prefixed [TEST]); every other address is refused. Test
//          sends use their own idempotency keys and ledger records, so they
//          never stand in for a real (live) email.
//   live — real delivery (requires explicit approval)
// EMAIL_TEST_ALLOWLIST  comma/space separated addresses (your own test accounts)
// RESEND_API_KEY        server-side only (Render env), never logged
// EMAIL_FROM            e.g. "OrivenAI <hello@mail.orivenai.com>" (verified domain)
// EMAIL_REPLY_TO        optional, e.g. contact@orivenai.com
//
// Sends: POST https://api.resend.com/emails with an Idempotency-Key (Resend
// keeps keys for 24h), so a retried send can't deliver twice. Retries on
// 429/5xx/network with backoff (max 3 attempts); 4xx are final. A process
// level limiter keeps well under Resend's default 10 requests/second.
// Logs never contain addresses, subjects or bodies.

const crypto = require('crypto');

const API = 'https://api.resend.com/emails';
let _fetch = (...a) => globalThis.fetch(...a);
function _setFetchForTests(f) { _fetch = f; }

function mode() {
  const m = String(process.env.EMAIL_MODE || 'off').trim().toLowerCase();
  return m === 'live' || m === 'test' ? m : 'off';
}

// 'test' | 'live' — which set of records/keys a send belongs to.
function scope() { return mode() === 'test' ? 'test' : 'live'; }

function configured() { return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM); }

function testAllowlist() {
  return new Set(String(process.env.EMAIL_TEST_ALLOWLIST || '')
    .split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => /@/.test(s)));
}

// Whether this address may receive email right now (mode + allowlist + config).
function canDeliver(to) {
  const m = mode();
  if (m === 'off' || !configured() || !to) return false;
  if (m === 'test') return testAllowlist().has(String(to).trim().toLowerCase());
  return true;
}

// ~5 requests/second per process.
let _next = 0;
async function _pace() {
  const now = Date.now();
  const wait = Math.max(0, _next - now);
  _next = Math.max(now, _next) + 200;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors worth another attempt later (everything else is final).
function isRetryable(error) { return /^(network|http_429|http_5\d\d)/.test(String(error || '')); }

// msg: { to, subject, html, text, headers?, tags?, idempotencyKey }
// Returns { id } | { skipped } | { error, retryable }
async function send(msg) {
  const m = mode();
  if (m === 'off') return { skipped: 'mode_off' };
  if (!configured()) return { skipped: 'not_configured' };
  if (!msg || !msg.to || !msg.idempotencyKey) return { error: 'invalid_message', retryable: false };
  const to = String(msg.to).trim();
  let subject = msg.subject;
  if (m === 'test') {
    // Never redirected: in test mode only allowlisted addresses receive mail.
    if (!testAllowlist().has(to.toLowerCase())) return { skipped: 'not_allowlisted' };
    subject = '[TEST] ' + subject;
  }
  const body = { from: process.env.EMAIL_FROM, to: [to], subject, html: msg.html, text: msg.text };
  if (process.env.EMAIL_REPLY_TO) body.reply_to = process.env.EMAIL_REPLY_TO;
  if (msg.headers) body.headers = msg.headers;
  if (msg.tags) body.tags = msg.tags;
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await _pace();
    try {
      const res = await _fetch(API, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': String(msg.idempotencyKey).slice(0, 256) },
        body: JSON.stringify(body),
      });
      let data = null; try { data = await res.json(); } catch (_) {}
      if (res.ok && data && data.id) return { id: data.id };
      const error = 'http_' + res.status + (data && data.name ? ':' + String(data.name).slice(0, 40) : '');
      last = { error, retryable: isRetryable(error) };
      if (!last.retryable) return last;
    } catch (err) {
      last = { error: 'network', retryable: true };
    }
    if (attempt < 3) await sleep(attempt * 1000);
  }
  return last;
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>"
// keyed by the base64 part of the endpoint secret ("whsec_..."). Rejects
// timestamps older than 5 minutes (replay protection).
function verifyWebhook(rawBody, headers, secret) {
  try {
    const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = headers['svix-signature'];
    if (!id || !ts || !sigs || !secret) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const keyB64 = String(secret).replace(/^whsec_/, '');
    const expected = crypto.createHmac('sha256', Buffer.from(keyB64, 'base64')).update(`${id}.${ts}.${rawBody}`).digest('base64');
    return String(sigs).split(' ').some((s) => {
      const v = s.split(',')[1];
      return v && v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected));
    });
  } catch (_) { return false; }
}

module.exports = { send, mode, scope, configured, canDeliver, testAllowlist, isRetryable, verifyWebhook, _setFetchForTests };
