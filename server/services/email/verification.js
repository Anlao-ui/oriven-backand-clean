// ── Email verification delivery: Resend first, SMTP fallback ─────────
//
// Used by POST /api/signup and POST /api/resend-verification (server.js).
// Transactional: independent of marketing consent.
//
// Order:
//   1. Resend, when it can deliver to this address right now
//      (EMAIL_MODE=live, or EMAIL_MODE=test and the address is in
//      EMAIL_TEST_ALLOWLIST, with RESEND_API_KEY + EMAIL_FROM set);
//   2. otherwise — or if Resend fails — the existing SMTP path (kept until
//      Resend has been tested in production);
//   3. otherwise nothing is sent (the account still works).
// Addresses on the suppression list (hard bounce, complaint) get nothing.
//
// Duplicates: one email per token. The Resend idempotency key is derived
// from the token hash (Resend ignores a repeat within 24h), and
// /api/resend-verification has a cooldown before a new token is issued.

const sender = require('./sender');
const templates = require('./templates');
const lifecycle = require('./lifecycle');

const VALID_DAYS = 14;
const RESEND_COOLDOWN_MS = 60e3;

// opts: { to, firstName, verifyUrl, tokenHash, smtpSend: async () => void | null }
// Returns { via: 'resend' | 'smtp' | 'none', reason? }
async function sendVerification({ to, firstName, verifyUrl, tokenHash, smtpSend }) {
  if (!to || !verifyUrl || !tokenHash) return { via: 'none', reason: 'invalid' };
  try { if (await lifecycle.isSuppressed(to)) return { via: 'none', reason: 'suppressed' }; } catch (_) {}
  let resendError = null;
  if (sender.canDeliver(to)) {
    const out = templates.render('verify_email', { firstName, verifyUrl, validDays: VALID_DAYS }, { appUrl: 'https://orivenai.com/app' });
    const r = await sender.send({
      to, subject: out.subject, html: out.html, text: out.text,
      tags: [{ name: 'template', value: 'verify_email' }],
      idempotencyKey: `oriven:${sender.scope()}:verify:${String(tokenHash).slice(0, 32)}`,
    });
    if (r.id) return { via: 'resend' };
    resendError = r.error || r.skipped || 'unknown';
  }
  if (typeof smtpSend === 'function') {
    try { await smtpSend(); return { via: 'smtp', reason: resendError ? 'resend_failed' : 'resend_not_used' }; }
    catch (err) { return { via: 'none', reason: 'smtp_failed' }; }
  }
  return { via: 'none', reason: resendError ? 'resend_failed' : 'no_provider' };
}

// Whether any provider could send a verification email to this address.
function canSendVerification(to, smtpReady) { return sender.canDeliver(to) || !!smtpReady; }

module.exports = { sendVerification, canSendVerification, VALID_DAYS, RESEND_COOLDOWN_MS };
