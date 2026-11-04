// ── Marketing campaigns: manual, consent-aware, one email per account ──
//
// A campaign is sent only by an admin, on purpose, in steps:
//   1. preview   — render the email (sample unsubscribe link);
//   2. audience  — counts only: who is eligible and why others are excluded;
//   3. test      — send to the EMAIL_TEST_ALLOWLIST addresses only;
//   4. results   — what the ledger recorded;
//   5. send      — the real send, refused unless ALL of these hold:
//                  EMAIL_MODE=live, MARKETING_CAMPAIGN_APPROVED=<campaign id>
//                  (set on purpose in Render), the exact confirmation phrase,
//                  and the eligible count the admin reviewed still matching.
//                  Sends at most `limit` emails per call (default 50, max 200);
//                  call again to continue.
// No scheduled job sends campaigns.
//
// Eligible = all of, checked again right before each email:
//   - subscription_status is 'free' (never bought access; customers are never mailed);
//   - profiles.marketing_opt_in === true (NULL/false = no consent), AND the
//     consent was given under wording that covers this email (the campaign's
//     `consent` rule, checked on marketing_consent_source + marketing_opt_in_at);
//   - a valid email address that hasn't been marked unverified;
//   - not on the suppression list (bounces, complaints);
//   - not already sent this campaign (email_sends UNIQUE user + dedupe key);
//   - no other marketing email in the last MARKETING_GAP_DAYS (same pacing as
//     the lifecycle emails).
// Every email carries the signed one-click unsubscribe link (lifecycle.js);
// unsubscribing only turns marketing email off.
// EMAIL_MODE=test processes ONLY allowlisted accounts, with 'test:' ledger
// keys and test idempotency keys, so a rehearsal never blocks the real send.
// Logs carry counts and short ids only — never addresses.

const crypto = require('crypto');

const CAMPAIGNS = {
  'access-plans-2026-11': {
    id: 'access-plans-2026-11',
    name: 'Ready to do more with OrivenAI? (no plan → plans)',
    template: 'campaign_access_plans',
    audiencePlan: 'free',
    // Replaces starter-upgrade-2026-10 (never sent; the Starter plan is retired).
    // Promotional (a paid-plan offer): only consent given under wording that
    // names offers — signup consent ("tips and product updates") is not used.
    // The rule (sources + date cutoff) lives in lifecycle.consentCoversOffers,
    // the same check Settings and the Control Center opt-in card use.
    consent: 'offers',
  },
};
const CONFIRM = (id) => 'SEND ' + id;
const MARKETING_GAP_DAYS = 3;
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY = 864e5;

function createCampaigns({ db, sender, templates, lifecycle, appUrl, log, env }) {
  log = log || (() => {});
  env = env || process.env;
  const app = () => (typeof appUrl === 'function' ? appUrl() : appUrl) || 'https://orivenai.com/app';
  const prefix = () => (sender.scope() === 'test' ? 'test:' : '');
  const keyFor = (c) => 'campaign:' + c.id;
  const short = (id) => String(id).slice(0, 8);

  function get(id) { return CAMPAIGNS[id] || null; }
  const ctaUrl = () => app() + '?plans=1'; // opens the in-app plans for the signed-in user (js/onboarding.js)

  function render(c, userId) {
    const unsub = userId ? lifecycle.unsubscribeUrl(userId) : 'https://orivenai.com/unsubscribe-preview';
    return { unsub, out: templates.render(c.template, { ctaUrl: ctaUrl() }, { appUrl: app(), unsubscribeUrl: unsub || undefined, postalAddress: env.EMAIL_POSTAL_ADDRESS || '' }) };
  }

  function preview(id) {
    const c = get(id); if (!c) return null;
    const { out } = render(c, null);
    return { subject: out.subject, html: out.html, text: out.text, category: out.category, ctaUrl: ctaUrl() };
  }

  // Why an account is or isn't eligible (pure; facts are pre-loaded).
  function classify(c, p, f, now) {
    if (!p || p.subscription_status !== 'free') return 'not_free';
    if (!p.email || !EMAIL_RE.test(String(p.email).trim())) return 'invalid_email';
    if (p.email_verified === false) return 'unverified_email';
    if (p.marketing_opt_in !== true) return p.marketing_opt_in === false ? 'opted_out' : 'no_consent';
    if (c.consent === 'offers' && !lifecycle.consentCoversOffers(p)) return 'consent_not_covering';
    if (f.suppressed) return 'suppressed';
    if (f.alreadySent) return 'already_sent';
    if (f.lastMarketingAt && now - Date.parse(f.lastMarketingAt) < MARKETING_GAP_DAYS * DAY) return 'recent_marketing';
    return 'eligible';
  }

  async function _pageProfiles(build) {
    const out = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }

  async function _loadAudience(c, now) {
    let build = () => db.from('profiles').select('id, email, subscription_status, marketing_opt_in, marketing_consent_source, marketing_opt_in_at, email_verified').eq('subscription_status', c.audiencePlan).order('id', { ascending: true });
    if (sender.mode() === 'test') {
      const allow = Array.from(sender.testAllowlist());
      if (!allow.length) return [];
      const base = build; build = () => base().in('email', allow);
    }
    const profiles = await _pageProfiles(build);
    const ids = profiles.map((p) => p.id);
    const facts = {}; profiles.forEach((p) => { facts[p.id] = { suppressed: false, alreadySent: false, lastMarketingAt: null }; });
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { data: sends, error } = await db.from('email_sends').select('user_id, dedupe_key, category, status, sent_at, created_at').in('user_id', chunk);
      if (error) throw error;
      (sends || []).forEach((s) => {
        const f = facts[s.user_id]; if (!f) return;
        const test = String(s.dedupe_key || '').startsWith('test:');
        if (test !== (sender.scope() === 'test')) return; // test and live records never mix
        if (s.dedupe_key === prefix() + keyFor(c) && s.status !== 'failed') f.alreadySent = true;
        if (s.category === 'marketing' && ['sent', 'delivered'].includes(s.status) && s.dedupe_key !== prefix() + keyFor(c)) {
          const t = s.sent_at || s.created_at; if (!f.lastMarketingAt || t > f.lastMarketingAt) f.lastMarketingAt = t;
        }
      });
      const hashes = profiles.slice(i, i + 500).filter((p) => p.email).map((p) => lifecycle.emailHash(p.email));
      if (hashes.length) {
        const { data: sup } = await db.from('email_suppressions').select('email_hash').in('email_hash', hashes);
        const set = new Set((sup || []).map((s) => s.email_hash));
        profiles.slice(i, i + 500).forEach((p) => { if (p.email && set.has(lifecycle.emailHash(p.email))) facts[p.id].suppressed = true; });
      }
    }
    return profiles.map((p) => ({ p, reason: classify(c, p, facts[p.id], now) }));
  }

  // Counts only — no addresses or ids leave this function.
  async function audience(id, { now } = {}) {
    const c = get(id); if (!c) return null;
    now = now || Date.now();
    const rows = await _loadAudience(c, now);
    const excluded = {};
    const consentSources = {};
    rows.forEach((r) => {
      if (r.reason !== 'eligible') excluded[r.reason] = (excluded[r.reason] || 0) + 1;
      else { const s = r.p.marketing_consent_source || 'unknown'; consentSources[s] = (consentSources[s] || 0) + 1; }
    });
    return { campaign: c.id, mode: sender.mode(), freeAccounts: rows.length, eligible: rows.filter((r) => r.reason === 'eligible').length, excluded, consentSources,
      note: sender.mode() === 'test' ? 'EMAIL_MODE=test: only allowlisted accounts are counted.' : undefined };
  }

  // Test send: the allowlisted addresses only, never a customer. Not
  // ledgered (repeatable); each attempt gets its own idempotency key.
  async function sendTest(id) {
    const c = get(id); if (!c) return { error: 'unknown_campaign' };
    if (sender.mode() === 'off') return { error: 'email_mode_off' };
    if (!sender.configured()) return { error: 'not_configured' };
    const to = Array.from(sender.testAllowlist());
    if (!to.length) return { error: 'no_test_allowlist' };
    const results = [];
    for (const addr of to) {
      const { data: prof } = await db.from('profiles').select('id').eq('email', addr).maybeSingle();
      const { unsub, out } = render(c, prof && prof.id);
      const r = await sender.send({ to: addr, subject: '[Campaign test] ' + out.subject, html: out.html, text: out.text,
        headers: unsub && prof ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
        tags: [{ name: 'template', value: c.template }, { name: 'campaign', value: c.id.replace(/[^a-zA-Z0-9_-]/g, '_') }],
        idempotencyKey: `oriven:campaign-test:${c.id}:${crypto.randomUUID()}` });
      results.push(r && r.id ? 'sent' : (r && (r.skipped || r.error)) || 'error');
    }
    log('[Campaign] test ' + c.id + ' → ' + JSON.stringify(results));
    return { sent: results.filter((x) => x === 'sent').length, results, recipients: to.length };
  }

  function approval(c) {
    if (sender.mode() === 'off') return 'email_mode_off';
    if (!sender.configured()) return 'not_configured';
    if (sender.mode() === 'live' && String(env.MARKETING_CAMPAIGN_APPROVED || '').trim() !== c.id) return 'not_approved';
    return null;
  }

  // The real send (or, in EMAIL_MODE=test, a rehearsal limited to allowlisted
  // accounts). Each recipient is re-read and re-checked just before sending.
  async function send(id, { confirm, expectedEligible, limit, now } = {}) {
    const c = get(id); if (!c) return { error: 'unknown_campaign' };
    const blocked = approval(c); if (blocked) return { error: blocked };
    if (confirm !== CONFIRM(c.id)) return { error: 'confirmation_required', confirm: CONFIRM(c.id) };
    now = now || Date.now();
    const rows = await _loadAudience(c, now);
    const eligible = rows.filter((r) => r.reason === 'eligible');
    if (Number(expectedEligible) !== eligible.length) return { error: 'audience_changed', eligible: eligible.length };
    const max = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const summary = { campaign: c.id, mode: sender.mode(), attempted: 0, sent: 0, skipped: 0, failed: 0, remaining: 0 };
    for (const { p } of eligible) {
      if (summary.attempted >= max) { summary.remaining++; continue; }
      // Fresh check right before sending (plan, consent, address, suppression).
      const { data: cur } = await db.from('profiles').select('id, email, subscription_status, marketing_opt_in, marketing_consent_source, marketing_opt_in_at, email_verified').eq('id', p.id).maybeSingle();
      if (!cur || classify(c, cur, { suppressed: await lifecycle.isSuppressed(cur.email), alreadySent: false, lastMarketingAt: null }, now) !== 'eligible') { summary.skipped++; continue; }
      const ins = await db.from('email_sends').insert({ user_id: cur.id, template: c.template, dedupe_key: prefix() + keyFor(c), category: 'marketing', status: 'sending', attempts: 1 }).select('id').maybeSingle();
      if (ins.error || !ins.data) { summary.skipped++; continue; } // already sent (UNIQUE) — never twice
      summary.attempted++;
      const { unsub, out } = render(c, cur.id);
      if (!unsub) { await db.from('email_sends').update({ status: 'skipped', error: 'no_unsubscribe_secret', updated_at: new Date().toISOString() }).eq('id', ins.data.id); summary.skipped++; continue; }
      const r = await sender.send({ to: cur.email, subject: out.subject, html: out.html, text: out.text,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tags: [{ name: 'template', value: c.template }, { name: 'campaign', value: c.id.replace(/[^a-zA-Z0-9_-]/g, '_') }],
        idempotencyKey: `oriven:${sender.scope()}:${cur.id}:${keyFor(c)}` });
      const at = new Date().toISOString();
      if (r && r.id) { await db.from('email_sends').update({ status: 'sent', provider_id: r.id, sent_at: at, updated_at: at }).eq('id', ins.data.id); summary.sent++; }
      else if (r && r.skipped) { await db.from('email_sends').update({ status: 'skipped', error: String(r.skipped).slice(0, 80), updated_at: at }).eq('id', ins.data.id); summary.skipped++; }
      else { await db.from('email_sends').update({ status: 'error', error: String((r && r.error) || 'error').slice(0, 80), updated_at: at }).eq('id', ins.data.id); summary.failed++; log('[Campaign] send failed | user ' + short(cur.id) + ' | ' + ((r && r.error) || 'error')); }
    }
    log('[Campaign] ' + JSON.stringify(summary));
    return summary;
  }

  // Ledger summary for the current scope (counts only).
  async function results(id) {
    const c = get(id); if (!c) return null;
    const { data, error } = await db.from('email_sends').select('status').eq('dedupe_key', prefix() + keyFor(c));
    if (error) throw error;
    const byStatus = {}; (data || []).forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
    return { campaign: c.id, mode: sender.mode(), scope: sender.scope(), total: (data || []).length, byStatus };
  }

  function list() {
    return Object.values(CAMPAIGNS).map((c) => ({ id: c.id, name: c.name, consent: c.consent || null, approved: String(env.MARKETING_CAMPAIGN_APPROVED || '').trim() === c.id, confirm: CONFIRM(c.id) }));
  }

  return { list, preview, audience, sendTest, send, results, classify, CAMPAIGNS };
}

module.exports = { createCampaigns, CAMPAIGNS, CONFIRM, MARKETING_GAP_DAYS };
