// ── Free first ad: one rendered ad image for a new Free account ──────
//
// OFF unless FREE_FIRST_AD_ENABLED=true AND FREE_FIRST_AD_SINCE is set (needs
// product approval and docs/migrations/2026-10-free-first-ad.sql).
//
// FREE_FIRST_AD_SINCE — the launch cutoff (ISO time). Only accounts created on
// or after it (and after the onboarding rollout) qualify, so accounts that
// existed before the feature launched never get it. Unset = nobody qualifies,
// even with the flag on. The browser never decides: it only reads
// GET /api/onboarding/state → freeFirstAd.available, computed here.
//
// What it adds: a new Free account already gets its campaign build (copy,
// headlines, targeting, visual concepts) through the existing daily free
// build (requireSubOrOnboardingGen, server.js). This covers the one thing
// Free can never afford — rendering the ad image (75 credits vs. 10 a day).
// With it, the first build is a complete, usable ad.
//
// The claim lives in its own table, public.free_first_ad_claims, which only
// the backend (service role) can read or write — never on profiles, so no
// browser can reset it.
//
// Rules (all server-side):
//   - Free plan, account created on/after the launch cutoff
//     (FREE_FIRST_AD_SINCE, and never before the onboarding rollout),
//     never for accounts that existed before the launch;
//   - one image, ever: claimed atomically before the provider is called
//     (insert for the first claim; compare-and-set on attempts after that);
//   - if the image fails, the claim is released through the normal paid-action
//     settlement (paidActions refunds "reservations"); at most MAX_ATTEMPTS
//     claims per account, so failures can't become a free-generation loop;
//   - nothing else is free: further images, regenerations and video follow
//     the normal credit rules (Free → 402 → plans).

const crypto = require('crypto');
const onboarding = require('./onboarding');

const MAX_ATTEMPTS = 2;
const TABLE = 'free_first_ad_claims';
let _db = null;
function init({ db }) { _db = db; }

function enabled() { return String(process.env.FREE_FIRST_AD_ENABLED || '').trim().toLowerCase() === 'true'; }

// Launch cutoff (FREE_FIRST_AD_SINCE). null when unset or invalid.
function since() {
  const raw = process.env.FREE_FIRST_AD_SINCE;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}
let _warnedNoCutoff = false;

// Structured log lines — no user id, email, prompt or key: accounts appear as
// a short one-way hash so events for the same account can be correlated.
//   [FirstAd] {"event":"claimed"|"succeeded"|"failed_released"|"duplicate_blocked"|
//              "attempts_exhausted"|"release_error", "acct":"…", "attempt":n, …}
function _acct(userId) { return crypto.createHash('sha256').update('first-ad:' + String(userId)).digest('hex').slice(0, 12); }
function _log(level, event, fields) {
  console[level]('[FirstAd] ' + JSON.stringify(Object.assign({ event }, fields || {})));
}

const _isMissing = (err) => !!err && (err.code === 'PGRST205' || err.code === '42P01' || err.code === '42703' || err.code === 'PGRST204');

// Pure rule. profile: { subscription_status, created_at }; claim: { claimed_at, attempts } | null
function eligibility(profile, claim) {
  if (!enabled()) return { available: false, reason: 'disabled' };
  const cut = since();
  if (!cut) {
    if (!_warnedNoCutoff) { _warnedNoCutoff = true; _log('warn', 'config_missing_cutoff', { note: 'FREE_FIRST_AD_ENABLED is on but FREE_FIRST_AD_SINCE is not set or invalid; nobody qualifies' }); }
    return { available: false, reason: 'no_launch_cutoff' };
  }
  if (!profile) return { available: false, reason: 'no_profile' };
  if ((profile.subscription_status || 'free') !== 'free') return { available: false, reason: 'paid_plan' };
  const created = profile.created_at ? Date.parse(profile.created_at) : NaN;
  const from = Math.max(cut.getTime(), onboarding.since().getTime());
  if (!Number.isFinite(created) || created < from) return { available: false, reason: 'existing_account' };
  if (claim && claim.claimed_at) return { available: false, reason: 'used' };
  if (claim && (claim.attempts || 0) >= MAX_ATTEMPTS) return { available: false, reason: 'attempts_used' };
  return { available: true, reason: 'eligible' };
}

// Returns { profile, claim } or null when the data can't be read (feature then off).
async function _read(userId) {
  const { data: profile, error: e1 } = await _db.from('profiles').select('subscription_status, created_at').eq('id', userId).maybeSingle();
  if (e1) { console.warn('[FirstAd] profile read failed:', e1.code || e1.message); return null; }
  const { data: claim, error: e2 } = await _db.from(TABLE).select('claimed_at, attempts').eq('user_id', userId).maybeSingle();
  if (e2) { if (!_isMissing(e2)) console.warn('[FirstAd] claim read failed:', e2.code || e2.message); return null; }
  return { profile, claim: claim || null };
}

async function status(userId) {
  if (!enabled()) return { available: false, reason: 'disabled' };
  const d = await _read(userId);
  if (!d) return { available: false, reason: 'unavailable' };
  return eligibility(d.profile, d.claim);
}

// Claims the free image for this request. Returns a paid-action reservation
// (cost 0, release() gives the claim back) or null when not eligible / lost
// a race — the caller then charges credits as usual.
async function claim(userId) {
  if (!enabled() || !userId) return null;
  const d = await _read(userId);
  if (!d) return null;
  const el = eligibility(d.profile, d.claim);
  if (!el.available) {
    // Only the free-ad-relevant refusals are logged (every image request of
    // every other account passes through here).
    if (el.reason === 'attempts_used') _log('log', 'attempts_exhausted', { acct: _acct(userId), attempts: d.claim && d.claim.attempts });
    // Claimed moments ago: a double submission or a parallel request (later
    // images of an account that already used its free ad are not logged).
    else if (el.reason === 'used' && d.claim && d.claim.claimed_at && Date.now() - Date.parse(d.claim.claimed_at) < 10 * 60e3) _log('log', 'duplicate_blocked', { acct: _acct(userId), attempt: d.claim.attempts, via: 'already_claimed' });
    return null;
  }
  const claimedAt = new Date().toISOString();
  let won = false, attempt = 1;
  if (!d.claim) {
    // First claim: the primary key on user_id makes a parallel second insert fail.
    const { error } = await _db.from(TABLE).insert({ user_id: userId, claimed_at: claimedAt, attempts: 1, updated_at: claimedAt });
    if (error) {
      if (error.code === '23505') _log('log', 'duplicate_blocked', { acct: _acct(userId), attempt: 1, via: 'insert' });
      else _log('warn', 'claim_error', { acct: _acct(userId), code: error.code || 'unknown' });
      return null;
    }
    won = true;
  } else {
    // Retry after a released (failed) attempt: compare-and-set on attempts.
    attempt = (d.claim.attempts || 0) + 1;
    const { data, error } = await _db.from(TABLE)
      .update({ claimed_at: claimedAt, attempts: attempt, updated_at: claimedAt })
      .eq('user_id', userId).is('claimed_at', null).eq('attempts', d.claim.attempts || 0)
      .select('user_id');
    if (error) { _log('warn', 'claim_error', { acct: _acct(userId), code: error.code || 'unknown' }); return null; }
    won = Array.isArray(data) && data.length > 0;
    if (!won) _log('log', 'duplicate_blocked', { acct: _acct(userId), attempt, via: 'retry' });
  }
  if (!won) return null;
  const acct = _acct(userId), startedAt = Date.now();
  _log('log', 'claimed', { acct, attempt });
  return {
    charged: true, cost: 0, featureKey: 'free_first_ad_image', userId, attempt, acct, startedAt,
    // Called by paidActions when the image request fails: the account may
    // try again (until MAX_ATTEMPTS claims have been made).
    release: async () => {
      const { error: e } = await _db.from(TABLE).update({ claimed_at: null, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('claimed_at', claimedAt);
      if (e) { _log('warn', 'release_error', { acct, attempt, code: e.code || 'unknown' }); throw e; }
      _log('log', 'failed_released', { acct, attempt, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempt), durationMs: Date.now() - startedAt });
      return true;
    },
  };
}

// The free image was delivered. usage: what the provider reported (tokens),
// when it did; estCostUsd: services/spendGuard.js list-price estimate for the
// model (AIMLAPI does not return a billed amount per request).
function recordSuccess(reservation, { model, usage, estCostUsd } = {}) {
  if (!reservation || reservation.featureKey !== 'free_first_ad_image') return;
  onboarding.recordEvent({ name: 'free_first_ad_succeeded', userId: reservation.userId, props: { kind: 'image' } });
  _log('log', 'succeeded', {
    acct: reservation.acct, attempt: reservation.attempt, model: model || null,
    imageTokens: usage && usage.completionTokens != null ? usage.completionTokens : null,
    totalTokens: usage && usage.totalTokens != null ? usage.totalTokens : null,
    tokensReported: !!(usage && usage.reported),
    estCostUsd: typeof estCostUsd === 'number' ? +estCostUsd.toFixed(4) : null,
    durationMs: Date.now() - (reservation.startedAt || Date.now()),
  });
}

module.exports = { init, enabled, since, eligibility, status, claim, recordSuccess, MAX_ATTEMPTS, TABLE, _acct };
