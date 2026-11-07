// ── Accounts: signup validation, profile creation, email verification ──
//
// Used by POST /api/signup, /api/verify-email and /api/resend-verification
// (server.js).
//
// Profile creation: the signup route used to write four columns that do not
// exist in production (phone, email_verified, verification_token,
// verification_sent_at). PostgREST rejects the whole upsert, so new accounts
// got no profile row from signup at all — the browser later created a bare
// one — and no verification token was ever stored. createProfile() writes
// only real columns: the base profile always, the verification fields only
// when docs/migrations/2026-10-signup-verification.sql has been applied.
// The phone number stays in the auth user's metadata (nothing reads it from
// profiles).
//
// Verification tokens: only a SHA-256 hash is stored; the link carries the
// token. Links expire after VERIFY_TTL_DAYS. email_verified is three-valued:
// true = verified, false = sent and pending, NULL = accounts created before
// verification worked (never treated as "unverified").

const crypto = require('crypto');

const VERIFY_TTL_DAYS = 14;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

let _db = null;
function init({ db }) { _db = db; }

const _isMissingColumn = (err) => !!err && (err.code === '42703' || err.code === 'PGRST204' || /column/i.test(err.message || ''));

function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }

// One email form everywhere: trimmed and lower-cased (Supabase Auth compares
// addresses case-insensitively; profiles.email stores the same form).
function normalizeEmail(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

// Returns { value } or { error, field, code } — one specific reason per
// field, in form order, so a filled-in field is never reported as missing.
// The same rules and messages as the browser (oriven-frontend js/accountForms.js).
// Accepts the snake_case names too (first_name/last_name), so a client using
// either spelling is read correctly.
function validateSignup(body) {
  const b = body && typeof body === 'object' ? body : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const firstName = str(b.firstName !== undefined ? b.firstName : b.first_name);
  const lastName = str(b.lastName !== undefined ? b.lastName : b.last_name);
  const email = normalizeEmail(b.email), phone = str(b.phone);
  const password = typeof b.password === 'string' ? b.password : '';
  const bad = (field, error, code) => ({ error, field, code: code || 'FIELD_INVALID' });
  if (!firstName) return bad('firstName', 'Enter your first name.', 'FIELD_REQUIRED');
  if (firstName.length > 80) return bad('firstName', 'Your first name can be at most 80 characters.');
  if (lastName.length > 80) return bad('lastName', 'Your last name can be at most 80 characters.');
  if (!email) return bad('email', 'Enter your email address.', 'FIELD_REQUIRED');
  if (!EMAIL_RE.test(email)) return bad('email', 'Enter a valid email address.');
  if (!password) return bad('password', 'Choose a password.', 'FIELD_REQUIRED');
  if (password.length < 6) return bad('password', 'Your password needs at least 6 characters.');
  if (password.length > 200) return bad('password', 'That password is too long (200 characters at most).');
  if (phone && !/^[+\d][\d\s().-]{5,24}$/.test(phone)) return bad('phone', 'Enter a valid phone number, or leave it empty.');
  return { value: { firstName, lastName, email, password, phone: phone || null } };
}

// Supabase Auth's createUser error → what the person sees. Never "missing
// fields" for something else, and no account details beyond "this address
// already has an account" (which the form needs to say).
function signupAuthError(err) {
  const msg = String((err && err.message) || '');
  const code = String((err && err.code) || '');
  if (code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered|already exists|email.*(exists|taken|in use)/i.test(msg)) {
    return { status: 409, body: { error: 'An account with this email address already exists. Please sign in or reset your password.', code: 'EMAIL_EXISTS', field: 'email' } };
  }
  if (code === 'weak_password' || /password/i.test(msg)) return { status: 400, body: { error: 'Choose a stronger password (at least 6 characters).', code: 'WEAK_PASSWORD', field: 'password' } };
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid|validate email/i.test(msg)) return { status: 400, body: { error: 'Enter a valid email address.', code: 'FIELD_INVALID', field: 'email' } };
  if (code === 'over_request_rate_limit' || /rate limit|too many/i.test(msg)) return { status: 429, body: { error: 'Too many attempts. Please wait a moment and try again.', code: 'RATE_LIMITED' } };
  return { status: 500, body: { error: 'We couldn’t create your account right now. Please try again in a moment.', code: 'SIGNUP_FAILED' } };
}

// Creates (or completes) the profile row for a just-created auth user.
// Idempotent: upsert on id. Returns { ok, verification: bool, error? }.
async function createProfile({ userId, firstName, lastName, email, tokenHash }) {
  const base = {
    id: userId,
    first_name: firstName,
    last_name: lastName || null,
    email,
    subscription_status: 'free',
    onboarding_completed: false,
  };
  const withVerify = Object.assign({}, base, tokenHash ? {
    email_verified: false,
    verification_token_hash: tokenHash,
    verification_sent_at: new Date().toISOString(),
  } : {});
  let { error } = await _db.from('profiles').upsert(withVerify, { onConflict: 'id' });
  if (!error) return { ok: true, verification: !!tokenHash };
  if (tokenHash && _isMissingColumn(error)) {
    // Verification migration not applied yet: still create a real profile.
    ({ error } = await _db.from('profiles').upsert(base, { onConflict: 'id' }));
    if (!error) return { ok: true, verification: false };
  }
  // One retry for a transient failure (network / lock).
  ({ error } = await _db.from('profiles').upsert(base, { onConflict: 'id' }));
  if (!error) return { ok: true, verification: false };
  return { ok: false, verification: false, error };
}

// Makes sure the signed-in user has a complete profile row (called on the
// first authenticated request of each user per server process, and by the
// app when it finds none). A missing row is inserted from Auth (email,
// name); an existing row is never overwritten — only identity fields that
// are still empty (a bare row created by a route's upsert before the
// profile existed) are filled from Auth. Plan, credits, Stripe ids,
// onboarding and every other column are never touched. Browsers have no
// write access to profiles (docs/migrations/2026-10-profiles-lockdown.sql).
// Returns { ok, created, filled? }.
function _identityFromAuth(user) {
  const meta = user.user_metadata || {};
  return {
    email: user.email ? String(user.email).toLowerCase() : null,
    first_name: typeof meta.first_name === 'string' && meta.first_name ? meta.first_name.slice(0, 80) : null,
    last_name: typeof meta.last_name === 'string' && meta.last_name ? meta.last_name.slice(0, 80) : null,
  };
}
async function ensureProfile(user) {
  const { data: existing, error: e1 } = await _db.from('profiles').select('id, email, first_name, last_name').eq('id', user.id).maybeSingle();
  if (e1) throw e1;
  const ident = _identityFromAuth(user);
  if (existing) {
    const patch = {};
    for (const k of Object.keys(ident)) if (!existing[k] && ident[k]) patch[k] = ident[k];
    if (!Object.keys(patch).length) return { ok: true, created: false };
    // Each filled column is guarded by "still empty", so a concurrent real
    // write is never overwritten.
    let q = _db.from('profiles').update(patch).eq('id', user.id);
    for (const k of Object.keys(patch)) q = q.is(k, null);
    const { error: e2 } = await q;
    if (e2) throw e2;
    return { ok: true, created: false, filled: Object.keys(patch) };
  }
  const row = Object.assign({ id: user.id }, ident, { subscription_status: 'free', onboarding_completed: false });
  const { error } = await _db.from('profiles').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
  return { ok: true, created: true };
}

// Looks up a verification token. Returns { userId } | { error: 'invalid'|'expired'|'unavailable' }.
async function findToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { error: 'invalid' };
  const { data, error } = await _db.from('profiles')
    .select('id, verification_sent_at, email_verified')
    .eq('verification_token_hash', hashToken(token)).maybeSingle();
  if (error) return { error: _isMissingColumn(error) ? 'invalid' : 'unavailable' };
  if (!data) return { error: 'invalid' };
  const sent = data.verification_sent_at ? Date.parse(data.verification_sent_at) : NaN;
  if (!Number.isFinite(sent) || Date.now() - sent > VERIFY_TTL_DAYS * 864e5) return { error: 'expired' };
  return { userId: data.id };
}

// Returns true when this call verified the address (false if it already was).
async function markVerified(userId) {
  const now = new Date().toISOString();
  let { data, error } = await _db.from('profiles')
    .update({ email_verified: true, verification_token_hash: null, email_verified_at: now }).eq('id', userId)
    .select('id');
  if (error && _isMissingColumn(error)) {
    ({ data, error } = await _db.from('profiles').update({ email_verified: true, verification_token_hash: null }).eq('id', userId).select('id'));
  }
  if (error) throw error;
  return Array.isArray(data) ? data.length > 0 : true;
}

// Stores a fresh token for resend. Returns false if verification storage
// isn't available (migration not applied) — the caller then sends nothing.
async function storeNewToken(userId, tokenHash) {
  const { error } = await _db.from('profiles')
    .update({ verification_token_hash: tokenHash, verification_sent_at: new Date().toISOString() })
    .eq('id', userId).or('email_verified.is.null,email_verified.eq.false'); // never re-open a verified address
  if (error) { if (_isMissingColumn(error)) return false; throw error; }
  return true;
}

// Fixed-window limiter (per process). Signup is the entry point for free
// usage, so it is limited per client address and globally.
const _hits = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const h = _hits.get(key);
  if (!h || now - h.at > windowMs) { _hits.set(key, { at: now, n: 1 }); return true; }
  if (_hits.size > 5000) _hits.clear();
  h.n++;
  return h.n <= limit;
}
function _int(name, fallback) { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function allowSignup(clientKey) {
  return allow('ip:' + clientKey, _int('SIGNUP_LIMIT_PER_IP_HOUR', 5), 3600e3)
    && allow('all', _int('SIGNUP_LIMIT_GLOBAL_HOUR', 100), 3600e3);
}

module.exports = {
  init, validateSignup, normalizeEmail, signupAuthError, createProfile, ensureProfile, findToken, markVerified, storeNewToken,
  hashToken, newToken, allowSignup, VERIFY_TTL_DAYS, _resetForTests: () => _hits.clear(),
};
