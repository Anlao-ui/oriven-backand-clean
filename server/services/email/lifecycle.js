// ── Lifecycle emails: who gets which email, once ─────────────────────
//
// One scheduled job (server.js, every 15 minutes, registered ONLY when
// EMAIL_LIFECYCLE_ENABLED=true) reads account state and sends what is due.
// State-based instead of hooks in signup/billing: nothing on the paid or
// signup paths can fail because of email, and a missed run simply catches
// up on the next one.
//
//   welcome            service    account created (within 48 hours)
//   paid_onboarding    service    paid plan active (once per plan)
//   first_ad_reminder  marketing  2–14 days after signup, no first result yet
//   first_success      marketing  first Create/Research result (within 7 days)
//   inactive           marketing  active before, nothing for 21 days
//   upgrade_education  marketing  Free, 3+ refusals of one paid action in 14 days
//
// Safety:
//   - only accounts created on/after EMAIL_LIFECYCLE_SINCE (default: the
//     onboarding rollout) — historical users are never enrolled;
//   - marketing needs profiles.marketing_opt_in === true (explicit consent);
//     every marketing email has a signed one-click unsubscribe link and
//     List-Unsubscribe headers;
//   - suppressed addresses (hard bounce, complaint) get nothing;
//   - email_sends has UNIQUE (user_id, dedupe_key): a duplicate run, a second
//     process or a retry can't send the same email twice;
//   - at most one email per user per run; marketing at most every 3 days;
//   - the ledger stores template keys and provider ids only — never
//     addresses, subjects or content;
//   - test mode (EMAIL_MODE=test) processes ONLY accounts whose address is in
//     EMAIL_TEST_ALLOWLIST. Its ledger rows carry a 'test:' dedupe-key prefix
//     and its idempotency keys a 'test' scope, so a test send never counts as
//     (or blocks) the real email later;
//   - only temporary failures (network, 429, 5xx) are retried; skips and
//     other errors are final;
//   - nothing is written while sending isn't configured.

const crypto = require('crypto');
const templates = require('./templates');
const sender = require('./sender');
const onboarding = require('../onboarding');

const DAY = 864e5;
const MARKETING_GAP_DAYS = 3;
const MAX_ATTEMPTS = 3;
const WELCOME_WINDOW = 2 * DAY;
const PAID = ['starter', 'creator', 'professional'];
const PRIORITY = ['paid_onboarding', 'welcome', 'first_success', 'first_ad_reminder', 'upgrade_education', 'inactive'];

let _db = null;
function init({ db }) { _db = db; }

// Ledger key prefix for the current scope: test rows never mix with live ones.
const keyPrefix = () => (sender.scope() === 'test' ? 'test:' : '');
const inScope = (dedupeKey) => (sender.scope() === 'test') === String(dedupeKey || '').startsWith('test:');
const bareKey = (dedupeKey) => String(dedupeKey || '').replace(/^test:/, '');

function since() {
  const t = process.env.EMAIL_LIFECYCLE_SINCE ? Date.parse(process.env.EMAIL_LIFECYCLE_SINCE) : NaN;
  return Number.isFinite(t) ? new Date(t) : onboarding.since();
}
function appUrl() { return process.env.FRONTEND_URL ? String(process.env.FRONTEND_URL).replace(/\/$/, '') + '/app' : 'https://orivenai.com/app'; }
function apiUrl() { return (process.env.PUBLIC_API_URL || 'https://oriven-backand-clean.onrender.com').replace(/\/$/, ''); }
const emailHash = (e) => crypto.createHash('sha256').update(String(e || '').trim().toLowerCase()).digest('hex');

// ── Unsubscribe links (HMAC of the user id; no expiry, single purpose) ──
function unsubToken(userId) {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('unsub:' + userId).digest('hex').slice(0, 40);
}
function unsubscribeUrl(userId) {
  const t = unsubToken(userId);
  return t ? `${apiUrl()}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${t}` : null;
}
function checkUnsubToken(userId, token) {
  const t = unsubToken(userId);
  return !!t && typeof token === 'string' && token.length === t.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(t));
}

// ── Pure decision ───────────────────────────────────────────────────
// profile: { id, email, first_name, created_at, subscription_status,
//            first_value_at, first_value_kind, marketing_opt_in }
// facts:   { sent: Set(dedupe_key), lastMarketingAt, lastActivityAt,
//            paywalls: { action: count in last 14 days }, suppressed,
//            freeFirstAd }
// Returns the ONE email due now, or null.
function decide(profile, facts, now) {
  now = now || Date.now();
  if (!profile || !profile.email || facts.suppressed) return null;
  const created = Date.parse(profile.created_at);
  if (!Number.isFinite(created) || created < since().getTime()) return null;
  const age = now - created;
  const plan = profile.subscription_status || 'free';
  const consent = profile.marketing_opt_in === true;
  const gapOk = !facts.lastMarketingAt || now - Date.parse(facts.lastMarketingAt) >= MARKETING_GAP_DAYS * DAY;
  const firstValue = profile.first_value_at ? Date.parse(profile.first_value_at) : null;
  const cand = [];

  if (age <= WELCOME_WINDOW) cand.push({ template: 'welcome', key: 'welcome', data: { firstName: profile.first_name } });
  if (PAID.includes(plan)) cand.push({ template: 'paid_onboarding', key: 'paid:' + plan, data: { plan } });
  if (consent && gapOk) {
    if (firstValue && now - firstValue <= 7 * DAY) {
      cand.push({ template: 'first_success', key: 'first_success', data: { kind: profile.first_value_kind, researchIncluded: PAID.includes(plan) } });
    }
    if (!firstValue && age >= 2 * DAY && age <= 14 * DAY) {
      cand.push({ template: 'first_ad_reminder', key: 'first_ad_reminder', data: { freeFirstAd: !!facts.freeFirstAd, plan } });
    }
    if (plan === 'free' && facts.paywalls) {
      const top = Object.keys(facts.paywalls).filter((a) => facts.paywalls[a] >= 3).sort((a, b) => facts.paywalls[b] - facts.paywalls[a])[0];
      if (top) cand.push({ template: 'upgrade_education', key: 'upgrade:' + top + ':' + Math.floor(now / (30 * DAY)), data: { action: top, plan: 'starter' } }); // price + credits come from templates.PLAN_INTRO
    }
    const last = facts.lastActivityAt ? Date.parse(facts.lastActivityAt) : null;
    if (last && now - last >= 21 * DAY && age >= 21 * DAY) {
      cand.push({ template: 'inactive', key: 'inactive:' + Math.floor(last / (60 * DAY)), data: {} });
    }
  }
  const due = cand.filter((c) => !facts.sent.has(c.key));
  due.sort((a, b) => PRIORITY.indexOf(a.template) - PRIORITY.indexOf(b.template));
  return due[0] || null;
}

// ── Data access ─────────────────────────────────────────────────────
async function _loadCandidates(limit) {
  let q = _db.from('profiles')
    .select('id, email, first_name, created_at, subscription_status, first_value_at, first_value_kind, marketing_opt_in')
    .gte('created_at', since().toISOString());
  if (sender.mode() === 'test') {
    // Test mode never even reads accounts outside the allowlist.
    const allow = Array.from(sender.testAllowlist());
    if (!allow.length) return [];
    q = q.in('email', allow);
  }
  const { data, error } = await q.order('created_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return data || [];
}

async function _facts(users, now) {
  const ids = users.map((u) => u.id);
  const facts = {};
  users.forEach((u) => { facts[u.id] = { sent: new Set(), lastMarketingAt: null, lastActivityAt: null, paywalls: {}, suppressed: false, freeFirstAd: false }; });
  if (!ids.length) return facts;
  const { data: sends, error: e1 } = await _db.from('email_sends').select('user_id, dedupe_key, category, status, sent_at, created_at').in('user_id', ids);
  if (e1) throw e1;
  (sends || []).forEach((s) => {
    const f = facts[s.user_id]; if (!f || !inScope(s.dedupe_key)) return; // test and live records never mix
    if (s.status !== 'failed') f.sent.add(bareKey(s.dedupe_key)); // failed rows are retried by retryFailed()
    if (s.category === 'marketing' && s.status === 'sent') { const t = s.sent_at || s.created_at; if (!f.lastMarketingAt || t > f.lastMarketingAt) f.lastMarketingAt = t; }
  });
  const { data: evs } = await _db.from('events').select('user_id, event_name, props, created_at').in('user_id', ids)
    .gte('created_at', new Date(now - 90 * DAY).toISOString());
  (evs || []).forEach((e) => {
    const f = facts[e.user_id]; if (!f) return;
    if (!f.lastActivityAt || e.created_at > f.lastActivityAt) f.lastActivityAt = e.created_at;
    if (e.event_name === 'paywall_shown' && e.props && e.props.action && Date.parse(e.created_at) >= now - 14 * DAY) {
      f.paywalls[e.props.action] = (f.paywalls[e.props.action] || 0) + 1;
    }
  });
  const hashes = users.map((u) => emailHash(u.email));
  const { data: sup } = await _db.from('email_suppressions').select('email_hash').in('email_hash', hashes);
  const supSet = new Set((sup || []).map((s) => s.email_hash));
  users.forEach((u) => { facts[u.id].suppressed = supSet.has(emailHash(u.email)); });
  return facts;
}

function _message(user, due) {
  const marketingCtx = { appUrl: appUrl(), postalAddress: process.env.EMAIL_POSTAL_ADDRESS || '' };
  const unsub = unsubscribeUrl(user.id);
  if (unsub) marketingCtx.unsubscribeUrl = unsub;
  const out = templates.render(due.template, due.data, marketingCtx);
  if (out.category === 'marketing' && !unsub) return { error: 'no_unsubscribe_secret' }; // never send marketing without a working unsubscribe
  const headers = out.category === 'marketing' ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;
  return { to: user.email, subject: out.subject, html: out.html, text: out.text, headers, category: out.category,
    tags: [{ name: 'template', value: due.template }], idempotencyKey: `oriven:${sender.scope()}:${user.id}:${bareKey(due.key)}` };
}

async function _deliver(rowId, user, due) {
  const msg = _message(user, due);
  if (msg.error) {
    await _db.from('email_sends').update({ status: 'skipped', error: msg.error, updated_at: new Date().toISOString() }).eq('id', rowId);
    return 'skipped';
  }
  const r = await sender.send(msg);
  const now = new Date().toISOString();
  if (r.id) { await _db.from('email_sends').update({ status: 'sent', provider_id: r.id, sent_at: now, updated_at: now }).eq('id', rowId); return 'sent'; }
  // A skip (e.g. not allowlisted) is final — never retried.
  if (r.skipped) { await _db.from('email_sends').update({ status: 'skipped', error: r.skipped, updated_at: now }).eq('id', rowId); return 'skipped'; }
  // Temporary failures stay 'failed' for retryFailed(); anything else is final ('error').
  const retry = sender.isRetryable(r.error);
  await _db.from('email_sends').update({ status: retry ? 'failed' : 'error', error: String(r.error).slice(0, 80), updated_at: now }).eq('id', rowId);
  return retry ? 'failed' : 'error';
}

// One pass. dryRun: decide only, write nothing, send nothing.
async function runOnce({ now, limit, dryRun } = {}) {
  now = now || Date.now();
  const summary = { considered: 0, due: 0, sent: 0, skipped: 0, failed: 0, plan: [] };
  if (!dryRun && sender.mode() === 'off') return Object.assign(summary, { disabled: 'mode_off' });
  // Nothing is written while sending isn't possible (no ledger rows that would
  // later stand in for the real email).
  if (!dryRun && !sender.configured()) return Object.assign(summary, { disabled: 'not_configured' });
  const users = await _loadCandidates(limit || 500);
  const facts = await _facts(users, now);
  for (const u of users) {
    summary.considered++;
    const f = facts[u.id];
    if (!dryRun && f && !f.freeFirstAd && u.subscription_status === 'free' && !u.first_value_at) {
      try { f.freeFirstAd = !!(await require('../firstAd').status(u.id)).available; } catch (_) {}
    }
    const due = decide(u, f, now);
    if (!due) continue;
    summary.due++;
    summary.plan.push({ user: String(u.id).slice(0, 8), template: due.template });
    if (dryRun) continue;
    const category = templates.render(due.template, due.data, { appUrl: appUrl() }).category;
    const ins = await _db.from('email_sends').insert({ user_id: u.id, template: due.template, dedupe_key: keyPrefix() + due.key, category, status: 'sending', attempts: 1 }).select('id').maybeSingle();
    if (ins.error) { summary.skipped++; continue; } // unique (user_id, dedupe_key): already queued elsewhere
    const out = await _deliver(ins.data.id, u, due);
    if (out === 'sent') summary.sent++; else if (out === 'failed' || out === 'error') summary.failed++; else summary.skipped++;
  }
  await retryFailed({ summary, now });
  return summary;
}

// Retries temporary failures (network, 429, 5xx) of the current scope up to
// MAX_ATTEMPTS, no sooner than minAgeMs (default 10 minutes) after the last
// attempt. Skips and other errors are never retried.
async function retryFailed({ summary, now, minAgeMs } = {}) {
  if (sender.mode() === 'off' || !sender.configured()) return;
  const cutoff = new Date((now || Date.now()) - (minAgeMs == null ? 10 * 60e3 : minAgeMs)).toISOString();
  const { data } = await _db.from('email_sends').select('id, user_id, template, dedupe_key, attempts, error')
    .eq('status', 'failed').lt('attempts', MAX_ATTEMPTS).lte('updated_at', cutoff).limit(50);
  for (const row of data || []) {
    if (!inScope(row.dedupe_key) || !sender.isRetryable(row.error)) continue;
    const { data: u } = await _db.from('profiles').select('id, email, first_name, created_at, subscription_status, first_value_at, first_value_kind, marketing_opt_in').eq('id', row.user_id).maybeSingle();
    if (!u || !u.email) continue;
    const { data: claimed } = await _db.from('email_sends').update({ status: 'sending', attempts: row.attempts + 1 }).eq('id', row.id).eq('status', 'failed').select('id');
    if (!claimed || !claimed.length) continue;
    const due = { template: row.template, key: bareKey(row.dedupe_key), data: { firstName: u.first_name, plan: u.subscription_status, kind: u.first_value_kind } };
    const out = await _deliver(row.id, u, due);
    if (summary) { if (out === 'sent') summary.sent++; else if (out === 'skipped') summary.skipped++; else summary.failed++; }
  }
}

// ── Consent, unsubscribe, provider events ───────────────────────────
async function setConsent(userId, optIn, source) {
  const now = new Date().toISOString();
  const patch = optIn
    ? { marketing_opt_in: true, marketing_opt_in_at: now, marketing_consent_source: String(source || 'unknown').slice(0, 40) }
    : { marketing_opt_in: false, marketing_opt_out_at: now };
  const { error } = await _db.from('profiles').update(patch).eq('id', userId);
  if (error) { if (/marketing_/.test(error.message || '') || error.code === '42703' || error.code === 'PGRST204') return false; throw error; }
  return true;
}

async function isSuppressed(email) {
  if (!email) return false;
  const { data } = await _db.from('email_suppressions').select('email_hash').eq('email_hash', emailHash(email)).maybeSingle();
  return !!data;
}

async function suppress(email, reason) {
  if (!email) return;
  await _db.from('email_suppressions').upsert({ email_hash: emailHash(email), reason: String(reason).slice(0, 40) }, { onConflict: 'email_hash' });
}

// Resend webhook payload: { type, data: { email_id, to: [..], ... } }
async function handleProviderEvent(evt) {
  const type = evt && evt.type;
  const d = (evt && evt.data) || {};
  const to = Array.isArray(d.to) ? d.to[0] : d.to;
  const status = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed_provider', 'email.suppressed': 'suppressed', 'email.delivery_delayed': null }[type];
  if (status && d.email_id) {
    await _db.from('email_sends').update({ status, updated_at: new Date().toISOString() }).eq('provider_id', d.email_id);
  }
  if (type === 'email.bounced') {
    const hard = !d.bounce || !d.bounce.type || /permanent|hard/i.test(d.bounce.type);
    if (hard) await suppress(to, 'hard_bounce');
  }
  if (type === 'email.complained' || type === 'email.suppressed') {
    await suppress(to, type === 'email.complained' ? 'complaint' : 'provider_suppressed');
    if (type === 'email.complained' && to) {
      await _db.from('profiles').update({ marketing_opt_in: false, marketing_opt_out_at: new Date().toISOString() }).eq('email', String(to).toLowerCase());
    }
  }
  return { handled: !!status || type === 'email.bounced' };
}

module.exports = {
  init, decide, runOnce, retryFailed, setConsent, suppress, isSuppressed, handleProviderEvent,
  unsubscribeUrl, checkUnsubToken, emailHash, since, WELCOME_WINDOW,
};
