// ── Free first ad: one rendered ad image for a new Free account ──────
//
// OFF unless FREE_FIRST_AD_ENABLED=true (needs product approval and
// docs/migrations/2026-10-free-first-ad.sql).
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
//   - Free plan, account created on/after the onboarding rollout
//     (services/onboarding.js since()), never for historical accounts;
//   - one image, ever: claimed atomically before the provider is called
//     (insert for the first claim; compare-and-set on attempts after that);
//   - if the image fails, the claim is released through the normal paid-action
//     settlement (paidActions refunds "reservations"); at most MAX_ATTEMPTS
//     claims per account, so failures can't become a free-generation loop;
//   - nothing else is free: further images, regenerations and video follow
//     the normal credit rules (Free → 402 → plans).

const onboarding = require('./onboarding');

const MAX_ATTEMPTS = 2;
const TABLE = 'free_first_ad_claims';
let _db = null;
function init({ db }) { _db = db; }

function enabled() { return String(process.env.FREE_FIRST_AD_ENABLED || '').trim().toLowerCase() === 'true'; }

const _isMissing = (err) => !!err && (err.code === 'PGRST205' || err.code === '42P01' || err.code === '42703' || err.code === 'PGRST204');

// Pure rule. profile: { subscription_status, created_at }; claim: { claimed_at, attempts } | null
function eligibility(profile, claim) {
  if (!enabled()) return { available: false, reason: 'disabled' };
  if (!profile) return { available: false, reason: 'no_profile' };
  if ((profile.subscription_status || 'free') !== 'free') return { available: false, reason: 'paid_plan' };
  const created = profile.created_at ? Date.parse(profile.created_at) : NaN;
  if (!Number.isFinite(created) || created < onboarding.since().getTime()) return { available: false, reason: 'existing_account' };
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
  if (!d || !eligibility(d.profile, d.claim).available) return null;
  const claimedAt = new Date().toISOString();
  let won = false, attempt = 1;
  if (!d.claim) {
    // First claim: the primary key on user_id makes a parallel second insert fail.
    const { error } = await _db.from(TABLE).insert({ user_id: userId, claimed_at: claimedAt, attempts: 1, updated_at: claimedAt });
    if (error) { if (error.code !== '23505') console.warn('[FirstAd] claim failed:', error.code || error.message); return null; }
    won = true;
  } else {
    // Retry after a released (failed) attempt: compare-and-set on attempts.
    attempt = (d.claim.attempts || 0) + 1;
    const { data, error } = await _db.from(TABLE)
      .update({ claimed_at: claimedAt, attempts: attempt, updated_at: claimedAt })
      .eq('user_id', userId).is('claimed_at', null).eq('attempts', d.claim.attempts || 0)
      .select('user_id');
    if (error) { console.warn('[FirstAd] claim failed:', error.code || error.message); return null; }
    won = Array.isArray(data) && data.length > 0;
  }
  if (!won) return null;
  console.log('[FirstAd] free first-ad image claimed | user:', userId, '| attempt:', attempt);
  return {
    charged: true, cost: 0, featureKey: 'free_first_ad_image', userId,
    // Called by paidActions when the image request fails: the account may
    // try again (until MAX_ATTEMPTS claims have been made).
    release: async () => {
      const { error: e } = await _db.from(TABLE).update({ claimed_at: null, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('claimed_at', claimedAt);
      if (e) throw e;
      console.log('[FirstAd] claim released after a failed image | user:', userId);
      return true;
    },
  };
}

module.exports = { init, enabled, eligibility, status, claim, MAX_ATTEMPTS, TABLE };
