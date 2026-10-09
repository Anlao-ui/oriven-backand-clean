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

// Returns { value } or { error } — trimmed, lower-cased email; bounded fields.
function validateSignup(body) {
  const b = body || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const firstName = str(b.firstName), lastName = str(b.lastName), email = str(b.email).toLowerCase(), phone = str(b.phone);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!firstName || !email || !password) return { error: 'First name, email and password are required' };
  if (firstName.length > 80 || lastName.length > 80) return { error: 'Names can be at most 80 characters' };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address' };
  if (password.length < 6) return { error: 'Password must be at least 6 characters' };
  if (password.length > 200) return { error: 'Password is too long' };
  if (phone && !/^[+\d][\d\s().-]{5,24}$/.test(phone)) return { error: 'Enter a valid phone number' };
  return { value: { firstName, lastName, email, password, phone: phone || null } };
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

// Makes sure the signed-in user has a profile row (the app calls this when
// it finds none — e.g. signup's profile write failed). Insert-only: an
// existing row is never touched, so this can't change a plan, credits or
// anything else. Browsers have no write access to profiles at all
// (docs/migrations/2026-10-profiles-lockdown.sql); this is the only way a
// missing row gets created. Returns { ok, created }.
async function ensureProfile(user) {
  const { data: existing, error: e1 } = await _db.from('profiles').select('id').eq('id', user.id).maybeSingle();
  if (e1) throw e1;
  if (existing) return { ok: true, created: false };
  const meta = user.user_metadata || {};
  const row = {
    id: user.id,
    email: user.email ? String(user.email).toLowerCase() : null,
    first_name: typeof meta.first_name === 'string' ? meta.first_name.slice(0, 80) : null,
    last_name: typeof meta.last_name === 'string' && meta.last_name ? meta.last_name.slice(0, 80) : null,
    subscription_status: 'free',
    onboarding_completed: false,
  };
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
  init, validateSignup, createProfile, ensureProfile, findToken, markVerified, storeNewToken,
  hashToken, newToken, allowSignup, VERIFY_TTL_DAYS, _resetForTests: () => _hits.clear(),
};
