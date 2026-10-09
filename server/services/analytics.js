// ── First-party analytics: attribution, site page views, owner dashboard ──
//
// Privacy model (see docs/migrations/2026-10-analytics.sql and the privacy
// policy on orivenai.com):
//   • Site page views are stored WITHOUT cookies, IP addresses or user ids:
//     path, a coarse traffic channel, UTM values, the referrer's host only,
//     and a visitor hash that rotates every UTC day (SHA-256 of a secret salt
//     + day + IP + user agent, truncated). The same person can't be followed
//     from one day to the next, and the hash can't be reversed.
//   • First-touch attribution is stored on the profile once, at signup
//     (insert-only — never overwritten), as a channel + UTM values + referrer
//     host + landing path. Every value is sanitized and length-limited here;
//     nothing the browser sends is trusted beyond that shape.
//   • The owner dashboard only ever returns aggregates (counts, rates,
//     breakdowns). No emails, names or ids leave this module.
const crypto = require('crypto');

let _db = null, _stripe = null;
function init({ db, stripe }) { _db = db; _stripe = stripe; }

const DAY = 864e5;

// ── Sanitizers ──────────────────────────────────────────────────────
function cleanToken(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[^a-z0-9 ._+\-/]/g, '').replace(/\s+/g, '_').slice(0, max || 100);
  return s || null;
}
function cleanHost(v) {
  if (typeof v !== 'string' || !v) return null;
  let host = v.trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname; } catch (_) { return null; }
  host = host.replace(/^www\./, '').split('/')[0].split(':')[0];
  return /^[a-z0-9.-]{1,100}$/.test(host) && host.includes('.') ? host.slice(0, 100) : null;
}
function cleanPath(v) {
  if (typeof v !== 'string' || v[0] !== '/') return null;
  const p = v.split(/[?#]/)[0].replace(/[^A-Za-z0-9/_.\-]/g, '').slice(0, 200);
  return p || '/';
}
const OWN_HOSTS = /(^|\.)orivenai\.com$|(^|\.)oriven\.netlify\.app$|^localhost$/;

// ── Channel classification (server-side, from sanitized values only) ──
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid_search|paid-search|paidsocial|paid_social|paid-social|display|cpm|cpv|retargeting|ads?)$/;
const SEARCH = /(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|yandex\.[a-z.]+|baidu\.com|qwant\.com|startpage\.com|brave\.com)$/;
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|t\.co|x\.com|twitter\.com|reddit\.com|youtube\.com|tiktok\.com|pinterest\.[a-z.]+|threads\.net)$/;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com)$/;
function classify({ source, medium, referrerHost, paidClick }) {
  const src = source || '', med = medium || '';
  if (paidClick === 'google' || (PAID_MEDIUM.test(med) && /google|adwords/.test(src))) return 'google_ads';
  if (paidClick === 'linkedin' || (PAID_MEDIUM.test(med) && /linkedin/.test(src))) return 'linkedin_ads';
  if (paidClick === 'meta' || (PAID_MEDIUM.test(med) && /facebook|meta|instagram|^fb$|^ig$/.test(src))) return 'meta_ads';
  if (PAID_MEDIUM.test(med)) return 'other_paid';
  if (/linkedin|^li$/.test(src)) return 'linkedin';
  if (med === 'email' || /newsletter|email/.test(src)) return 'email';
  if (src) return 'campaign';
  const h = referrerHost || '';
  if (!h || OWN_HOSTS.test(h)) return 'direct';
  if (/(^|\.)google\.[a-z.]+$/.test(h) && !/^(mail|docs|drive|accounts)\./.test(h)) return 'google_organic';
  if (SEARCH.test(h)) return 'other_search';
  if (/(^|\.)(linkedin\.com|lnkd\.in)$/.test(h)) return 'linkedin';
  if (AI.test(h)) return 'ai_assistant';
  if (SOCIAL.test(h)) return 'social';
  return 'referral';
}
const CHANNELS = ['google_organic', 'google_ads', 'linkedin', 'linkedin_ads', 'meta_ads', 'other_paid', 'social', 'ai_assistant', 'other_search', 'email', 'campaign', 'referral', 'direct', 'unknown'];

// Attribution object from the browser → sanitized row fields.
function sanitizeAttribution(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  // Statistics switched off (Cookie settings / DNT / GPC): nothing captured.
  if (a.optOut === true) return { acq_channel: 'unknown' };
  const source = cleanToken(a.source, 80), medium = cleanToken(a.medium, 60), campaign = cleanToken(a.campaign, 100);
  const referrerHost = cleanHost(a.referrer);
  const landing = cleanPath(a.landing);
  const paidClick = ['google', 'linkedin', 'meta'].includes(a.click) ? a.click : null;
  const seen = Date.parse(a.firstSeen);
  return {
    acq_channel: classify({ source, medium, referrerHost: referrerHost && OWN_HOSTS.test(referrerHost) ? null : referrerHost, paidClick }),
    acq_source: source, acq_medium: medium, acq_campaign: campaign,
    acq_referrer_host: referrerHost && !OWN_HOSTS.test(referrerHost) ? referrerHost : null,
    acq_landing_path: landing,
    acq_first_seen_at: Number.isFinite(seen) && seen <= Date.now() + 60e3 && seen > Date.now() - 90 * DAY ? new Date(seen).toISOString() : null,
  };
}

// Stores first-touch attribution on a NEW profile. Insert-only semantics: it
// only fills a profile whose acq_channel is still empty, so the original
// acquisition source is never overwritten. Signups without attribution data
// are recorded as 'direct'. Never throws (signup must not fail on this).
async function recordSignupAttribution(userId, attribution) {
  try {
    const row = sanitizeAttribution(attribution) || { acq_channel: 'direct' };
    const { error } = await _db.from('profiles').update(row).eq('id', userId).is('acq_channel', null);
    if (error && !/acq_|column/i.test(error.message || '')) console.warn('[Analytics] attribution not stored:', error.code || error.message);
    return row.acq_channel;
  } catch (err) { console.warn('[Analytics] attribution not stored:', err.message); return null; }
}

// ── Site page views (cookieless) ────────────────────────────────────
const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|axios|node-fetch|go-http|java\/|httpclient|facebookexternalhit|embedly|whatsapp|telegram|discord/i;
function _salt() { return process.env.ANALYTICS_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || 'oriven-analytics'; }
function visitorDayHash(ip, ua, now) {
  const day = new Date(now || Date.now()).toISOString().slice(0, 10);
  return crypto.createHmac('sha256', _salt()).update(day + '|' + (ip || '') + '|' + (ua || '')).digest('hex').slice(0, 16);
}
const KINDS = new Set(['pageview', 'signup_started']);

// Builds the stored row from a beacon. Returns null for bots / invalid input.
function siteHitRow(body, { ip, ua, now }) {
  if (!body || typeof body !== 'object') return null;
  if (!ua || BOT_UA.test(ua)) return null;
  const kind = KINDS.has(body.k) ? body.k : 'pageview';
  const path = cleanPath(body.p);
  if (!path) return null;
  const a = sanitizeAttribution({ source: body.us, medium: body.um, campaign: body.uc, referrer: body.r, landing: path, click: body.c }) || {};
  const referrerHost = cleanHost(body.r);
  const external = !!(referrerHost && !OWN_HOSTS.test(referrerHost));
  // An "entry" starts a visit: arrived from outside, with campaign tags, or
  // with no referrer at all (typed, bookmark, app). Internal navigation isn't one.
  const entry = kind === 'pageview' && (external || !!a.acq_source || !referrerHost);
  return {
    kind, path, entry,
    channel: a.acq_channel || 'direct', source: a.acq_source || null, medium: a.acq_medium || null, campaign: a.acq_campaign || null,
    referrer_host: external ? referrerHost : null,
    visitor_hash: visitorDayHash(ip, ua, now),
  };
}

async function recordSiteHit(body, ctx) {
  const row = siteHitRow(body, ctx);
  if (!row) return false;
  const { error } = await _db.from('site_pageviews').insert(row);
  if (error) { if (!/site_pageviews|PGRST205|42P01/.test((error.code || '') + (error.message || ''))) console.warn('[Analytics] page view not stored:', error.code || error.message); return false; }
  return true;
}

// Fixed-window limiter (per process).
const _hits = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now(); const h = _hits.get(key);
  if (!h || now - h.at > windowMs) { _hits.set(key, { at: now, n: 1 }); if (_hits.size > 20000) _hits.clear(); return true; }
  h.n++; return h.n <= limit;
}

// ── Admin ───────────────────────────────────────────────────────────
// Owners are listed by Supabase user id in ADMIN_USER_IDS (comma-separated).
// The check runs on the server after the session token is verified; the
// browser never decides. Unset = nobody is an admin.
function adminIds() { return String(process.env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f-]{36}$/.test(s)); }
function isAdmin(userId) { return !!userId && adminIds().includes(String(userId).toLowerCase()); }

// ── Dashboard aggregation ───────────────────────────────────────────
const PAID = ['starter', 'creator', 'professional'];
const isMissing = (e) => !!e && /PGRST20[45]|42P01|42703|does not exist|column/i.test((e.code || '') + ' ' + (e.message || ''));

async function _pageAll(build, max) {
  const out = []; const size = 1000;
  for (let from = 0; from < (max || 50000); from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

// Stripe list calls return an async iterator; anything else (an error, a
// stub) is awaited so a failure rejects here instead of going unhandled.
async function* _iter(list) {
  if (!list || typeof list[Symbol.asyncIterator] !== 'function') { await list; throw new Error('stripe_list_unavailable'); }
  for await (const x of list) yield x;
}

// Stripe lookups are cached so the dashboard never hammers the API.
const _cache = new Map();
async function cached(key, ms, fn) {
  const c = _cache.get(key);
  if (c && Date.now() - c.at < ms) return c.value;
  const value = await fn();
  _cache.set(key, { at: Date.now(), value });
  return value;
}

async function _stripeCheckout(fromSec, toSec) {
  if (!_stripe) return { available: false };
  return cached('cs:' + fromSec + ':' + toSec, 10 * 60e3, async () => {
    const sessions = [];
    for await (const s of _iter(_stripe.checkout.sessions.list({ created: { gte: fromSec, lte: toSec }, limit: 100 }))) {
      sessions.push({ status: s.status, paid: s.payment_status === 'paid' || s.payment_status === 'no_payment_required', plan: (s.metadata && s.metadata.plan) || null, user: (s.metadata && s.metadata.userId) || null, mode: s.mode });
      if (sessions.length >= 2000) break;
    }
    const subs = sessions.filter((s) => s.mode === 'subscription');
    const users = new Set(subs.filter((s) => s.user).map((s) => s.user));
    const paidUsers = new Set(subs.filter((s) => s.paid && s.user).map((s) => s.user));
    const byPlan = {};
    subs.filter((s) => s.paid).forEach((s) => { byPlan[s.plan || 'unknown'] = (byPlan[s.plan || 'unknown'] || 0) + 1; });
    return { available: true, sessions: subs.length, completedPaid: subs.filter((s) => s.paid).length, expired: subs.filter((s) => s.status === 'expired').length,
      open: subs.filter((s) => s.status === 'open').length, uniqueUsers: users.size, uniquePayingUsers: paidUsers.size, paidByPlan: byPlan };
  });
}

async function _stripeSubscriptions(fromMs, toMs) {
  if (!_stripe) return { available: false };
  return cached('subs', 10 * 60e3, async () => {
    const list = [];
    for await (const s of _iter(_stripe.subscriptions.list({ status: 'all', limit: 100 }))) {
      list.push({ created: s.created * 1000, canceledAt: s.canceled_at ? s.canceled_at * 1000 : null, status: s.status, amount: s.items && s.items.data[0] && s.items.data[0].price ? s.items.data[0].price.unit_amount : null });
      if (list.length >= 5000) break;
    }
    return list;
  }).then((list) => (list.available === false ? list : {
    available: true,
    newInRange: list.filter((s) => s.created >= fromMs && s.created <= toMs && !['incomplete', 'incomplete_expired'].includes(s.status)).length,
    canceledInRange: list.filter((s) => s.canceledAt && s.canceledAt >= fromMs && s.canceledAt <= toMs).length,
    activeNow: list.filter((s) => ['active', 'trialing', 'past_due'].includes(s.status)).length,
  }));
}

function _days(fromMs, toMs) {
  const out = []; for (let t = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate()); t <= toMs; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

async function dashboard({ from, to }) {
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const fromIso = new Date(fromMs).toISOString(), toIso = new Date(toMs).toISOString();
  const out = { range: { from: fromIso, to: toIso }, generatedAt: new Date().toISOString(), tracking: {}, website: null, registrations: null, activation: null, subscriptions: null, funnel: null, system: {} };

  // A. Website (aggregated in Postgres: analytics_site_summary)
  const site = await _db.rpc('analytics_site_summary', { p_from: fromIso, p_to: toIso });
  if (site.error) out.website = { status: isMissing(site.error) ? 'not_tracked' : 'error' };
  else out.website = Object.assign({ status: 'ok' }, site.data || {});

  // B/C/E. Profiles that signed up in the range (the cohort), aggregates only.
  let cohort = [];
  try {
    cohort = await _pageAll(() => _db.from('profiles').select('id, created_at, email_verified, email_verified_at, onboarding_completed, first_value_at, first_value_kind, subscription_status, stripe_subscription_id, acq_channel').gte('created_at', fromIso).lte('created_at', toIso).order('created_at'), 20000);
  } catch (e) {
    if (!isMissing(e)) throw e;
    cohort = await _pageAll(() => _db.from('profiles').select('id, created_at, email_verified, onboarding_completed, first_value_at, first_value_kind, subscription_status, stripe_subscription_id').gte('created_at', fromIso).lte('created_at', toIso).order('created_at'), 20000);
    out.tracking.attribution = 'not_migrated';
  }
  const ids = new Set(cohort.map((p) => p.id));
  const byChannel = {};
  cohort.forEach((p) => { const k = p.acq_channel || 'not_tracked'; byChannel[k] = (byChannel[k] || 0) + 1; });
  const verified = cohort.filter((p) => p.email_verified === true).length;
  const verifiable = cohort.filter((p) => p.email_verified !== null && p.email_verified !== undefined).length; // accounts created with email verification
  const onboarded = cohort.filter((p) => p.onboarding_completed === true).length;
  const firstAd = cohort.filter((p) => p.first_value_at && p.first_value_kind === 'create').length;
  const paidCohort = cohort.filter((p) => PAID.includes(p.subscription_status) || !!p.stripe_subscription_id).length;
  const signupDaily = {};
  cohort.forEach((p) => { const d = p.created_at.slice(0, 10); signupDaily[d] = (signupDaily[d] || 0) + 1; });
  out.registrations = {
    signups: cohort.length, byChannel,
    verified, verifiable, verificationRate: rate(verified, verifiable),
    onboarded, onboardingRate: rate(onboarded, cohort.length),
    daily: _days(fromMs, toMs).map((d) => ({ day: d, signups: signupDaily[d] || 0 })),
  };

  // Events in the range (one-time events are unique per user by index).
  let events = [];
  try {
    events = await _pageAll(() => _db.from('events').select('event_name, user_id, props, created_at').gte('created_at', fromIso).lte('created_at', toIso)
      .in('event_name', ['first_ad_started', 'first_create_success', 'free_first_ad_succeeded', 'checkout_started', 'checkout_completed', 'subscription_activated', 'subscription_changed', 'subscription_canceled', 'subscription_cancel_scheduled', 'payment_failed', 'signup_completed', 'email_verified', 'onboarding_completed']), 50000);
  } catch (e) { if (!isMissing(e)) throw e; }
  const evUsers = (name) => new Set(events.filter((e) => e.event_name === name && e.user_id).map((e) => e.user_id));
  const evCount = (name) => events.filter((e) => e.event_name === name).length;
  const startedUsers = evUsers('first_ad_started');
  const completedUsers = evUsers('first_create_success');
  let claims = { available: false };
  const cl = await _db.from('free_first_ad_claims').select('claimed_at, attempts, created_at').gte('created_at', fromIso).lte('created_at', toIso);
  if (!cl.error) claims = { available: true, accounts: (cl.data || []).length, used: (cl.data || []).filter((c) => c.claimed_at).length, failedAttempts: (cl.data || []).reduce((n, c) => n + Math.max(0, (c.attempts || 0) - (c.claimed_at ? 1 : 0)), 0) };
  out.activation = {
    firstAdsStarted: startedUsers.size, firstAdsCompleted: completedUsers.size,
    firstAdSuccessRate: rate([...startedUsers].filter((u) => completedUsers.has(u)).length, startedUsers.size),
    cohortFirstAds: firstAd, cohortFirstAdRate: rate(firstAd, cohort.length),
    freeFirstAd: claims,
  };

  // D. Subscriptions
  const paidNow = {};
  const { data: paidRows, error: pErr } = await _db.from('profiles').select('subscription_status, stripe_subscription_id').in('subscription_status', PAID);
  if (pErr) throw pErr;
  (paidRows || []).forEach((r) => { paidNow[r.subscription_status] = (paidNow[r.subscription_status] || 0) + 1; });
  const stripeBilled = (paidRows || []).filter((r) => r.stripe_subscription_id).length;
  let checkout = { available: false }, subs = { available: false };
  try { checkout = await _stripeCheckout(Math.floor(fromMs / 1000), Math.floor(toMs / 1000)); } catch (e) { checkout = { available: false, error: 'stripe_unavailable' }; }
  try { subs = await _stripeSubscriptions(fromMs, toMs); } catch (e) { subs = { available: false, error: 'stripe_unavailable' }; }
  out.subscriptions = {
    activePaid: Object.values(paidNow).reduce((a, b) => a + b, 0), byPlan: paidNow, stripeBilled, manuallyGranted: (paidRows || []).length - stripeBilled,
    stripe: subs, checkout,
    checkoutConversionRate: checkout.available ? rate(checkout.uniquePayingUsers, checkout.uniqueUsers) : null,
    events: { checkoutStarted: evCount('checkout_started'), checkoutStartedUsers: evUsers('checkout_started').size, checkoutCompleted: evCount('checkout_completed'),
      activated: evCount('subscription_activated'), changed: evCount('subscription_changed'), canceled: evCount('subscription_canceled'), cancelScheduled: evCount('subscription_cancel_scheduled'), paymentFailed: evCount('payment_failed') },
  };

  // E. Funnel — one cohort (accounts created in the range), so every step's
  // percentage compares the same people. Visitors are a separate population.
  const visitors = out.website && out.website.status === 'ok' ? out.website.visitors : null;
  out.funnel = {
    cohortNote: 'Signups in the selected range, followed through each step.',
    visitors, visitorsToSignups: visitors ? rate(cohort.length, visitors) : null,
    steps: [
      { key: 'signups', label: 'Signups', value: cohort.length },
      { key: 'verified', label: 'Verified email', value: verified, base: verifiable, note: verifiable < cohort.length ? 'Only accounts created with email verification can be counted.' : null },
      { key: 'first_ad', label: 'First ad created', value: firstAd },
      { key: 'paid', label: 'Paid subscriber', value: paidCohort },
    ],
  };

  // Tracking coverage — when each data source started, so missing history
  // reads as "not tracked yet", never as zero.
  const firstOf = async (table, col) => { const r = await _db.from(table).select(col).order(col, { ascending: true }).limit(1); return r.error ? null : (r.data && r.data[0] && r.data[0][col]) || null; };
  out.tracking.pageviewsSince = await firstOf('site_pageviews', 'created_at');
  out.tracking.eventsSince = await firstOf('events', 'created_at');
  out.tracking.attributionSince = await (async () => { const r = await _db.from('profiles').select('created_at').not('acq_channel', 'is', null).order('created_at', { ascending: true }).limit(1); return r.error ? null : (r.data && r.data[0] && r.data[0].created_at) || null; })();
  out.tracking.cohortWithAttribution = cohort.filter((p) => p.acq_channel).length;

  // System status (no secrets: booleans and timestamps only).
  const lastWh = await _db.from('stripe_webhook_events').select('created_at, status').order('created_at', { ascending: false }).limit(1);
  const fa = require('./firstAd');
  out.system = {
    freeFirstAd: { enabled: fa.enabled(), cutoffSet: !!fa.since(), cutoff: fa.since() ? fa.since().toISOString() : null },
    stripeWebhook: { lastEventAt: lastWh.error ? null : (lastWh.data && lastWh.data[0] && lastWh.data[0].created_at) || null, lastStatus: lastWh.error ? null : (lastWh.data && lastWh.data[0] && lastWh.data[0].status) || null },
    analyticsSaltConfigured: !!process.env.ANALYTICS_SALT,
  };
  return out;
}

// Range from query params: preset days (7/30/90) or custom from/to (ISO
// dates), max 366 days. Returns null when invalid.
function parseRange(q, now) {
  now = now || Date.now();
  if (q && /^(7|30|90)$/.test(String(q.days || ''))) return { from: new Date(now - Number(q.days) * DAY).toISOString(), to: new Date(now).toISOString() };
  const f = q && Date.parse(q.from), t = q && Date.parse(q.to);
  if (Number.isFinite(f) && Number.isFinite(t) && f <= t && t - f <= 366 * DAY) {
    const toEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to)) ? t + DAY - 1 : t;
    return { from: new Date(f).toISOString(), to: new Date(Math.min(toEnd, now)).toISOString() };
  }
  if (!q || (!q.days && !q.from)) return { from: new Date(now - 30 * DAY).toISOString(), to: new Date(now).toISOString() };
  return null;
}

module.exports = { init, sanitizeAttribution, classify, CHANNELS, recordSignupAttribution, siteHitRow, recordSiteHit, visitorDayHash, allow, isAdmin, adminIds, dashboard, parseRange, cleanPath, cleanHost, _cacheClear: () => _cache.clear() };
