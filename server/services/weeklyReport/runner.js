// ── Weekly AI Performance Report: the job ────────────────────────────
//
// One pass (runOnce) is triggered by the in-process scheduler every 30
// minutes (server.js, only with WEEKLY_REPORTS_ENABLED=true) and/or by an
// external scheduler through the protected POST /api/internal/weekly-reports/run.
// A run that finds nothing due does nothing, so extra or overlapping triggers
// are harmless.
//
// For every Professional account whose report for the last completed week
// is due (period.isDue — Monday 07:00 to Wednesday, user's timezone):
//   1. claim  — insert weekly_reports (user, week, scope): UNIQUE, so a second
//               run, a second instance or a retry can't take the same week;
//               a crashed claim is re-taken only after its lease expires;
//   2. build  — collect real platform data, aggregate (metrics.js), ONE AI
//               call (insights.js, skipped when there is nothing to explain or
//               the run's AI budget is spent), validate, store. A retry
//               re-uses the stored report and never calls the AI again;
//   3. send   — Resend with an idempotency key per user and week, recorded in
//               email_sends (UNIQUE user + dedupe key) like every other email.
// Temporary send failures (network, 429, 5xx) are retried up to MAX_ATTEMPTS,
// at least RETRY_AFTER_MS apart; anything else is final.
//
// Never sent: accounts not on Professional at send time, addresses on the
// suppression list, users who turned weekly reports off
// (profiles.preferences.weeklyReportEmail === false). EMAIL_MODE=test only
// processes allowlisted addresses and keeps its rows in scope 'test'.
// Logs carry short ids and status codes only — no addresses, names or metrics.

const crypto = require('crypto');
const period = require('./period');
const metrics = require('./metrics');
const insights = require('./insights');
const planEntitlements = require('../planEntitlements');

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 10 * 60e3;
const LEASE_MS = 15 * 60e3;
const DEFAULT_USER_LIMIT = 200;      // accounts considered per run
const DEFAULT_AI_BUDGET = 50;        // AI calls per run
const CONCURRENCY = 2;               // accounts built at the same time
const LANGS = ['en', 'nl', 'de', 'fr', 'es', 'pt'];

function createRunner({ db, sender, templates, lifecycle, collect, aiCall, appUrl, apiUrl, log, env }) {
  log = log || (() => {});
  env = env || process.env;
  const scope = () => sender.scope();
  const ledgerKey = (week) => (scope() === 'test' ? 'test:' : '') + 'weekly_report:' + week;
  const short = (id) => String(id).slice(0, 8);
  const app = () => (typeof appUrl === 'function' ? appUrl() : appUrl) || 'https://orivenai.com/app';
  const api = () => (typeof apiUrl === 'function' ? apiUrl() : apiUrl) || 'https://oriven-backand-clean.onrender.com';

  // Signed one-click "turn off weekly reports" link (same per-user HMAC as
  // the other email links, its own route).
  function offUrl(userId) {
    try {
      const u = lifecycle && lifecycle.unsubscribeUrl ? lifecycle.unsubscribeUrl(userId) : null;
      const t = u ? new URL(u).searchParams.get('t') : null;
      return t ? `${api()}/api/email/weekly-report/off?u=${encodeURIComponent(userId)}&t=${t}` : null;
    } catch (_) { return null; }
  }

  async function tableReady() {
    const { error } = await db.from('weekly_reports').select('id').limit(1);
    if (!error) return true;
    log('[WeeklyReport] weekly_reports not available (' + (error.code || 'error') + ') — apply docs/migrations/2026-10-weekly-reports.sql');
    return false;
  }

  async function candidates(limit) {
    let q = db.from('profiles').select('id, email, first_name, subscription_status, timezone, preferences').eq('subscription_status', 'professional');
    if (sender.mode() === 'test') {
      const allow = Array.from(sender.testAllowlist());
      if (!allow.length) return [];
      q = q.in('email', allow);
    }
    const { data, error } = await q.order('id', { ascending: true }).limit(limit);
    if (error) throw error;
    return (data || []).filter((u) => planEntitlements.hasEntitlement(u.subscription_status, 'weeklyReport'));
  }

  const langOf = (u) => { const l = u.preferences && u.preferences.language; return LANGS.includes(l) ? l : 'en'; };
  const optedOut = (u) => !!(u.preferences && u.preferences.weeklyReportEmail === false);

  // Takes the user's row for this week, or returns null when it's done or
  // someone else holds it.
  async function claim(user, week, now) {
    const leaseUntil = new Date(now + LEASE_MS).toISOString();
    const row = { user_id: user.id, week_start: week.start, week_end: week.end, timezone: week.timeZone, scope: scope(), status: 'building', attempts: 1, lease_until: leaseUntil };
    const ins = await db.from('weekly_reports').insert(row).select('*').maybeSingle();
    if (!ins.error && ins.data) return ins.data;
    if (ins.error && ins.error.code !== '23505') throw ins.error;
    const { data: cur } = await db.from('weekly_reports').select('*').eq('user_id', user.id).eq('week_start', week.start).eq('scope', scope()).maybeSingle();
    if (!cur || ['sent', 'skipped', 'error'].includes(cur.status) || cur.attempts >= MAX_ATTEMPTS) return null;
    const leaseOver = !cur.lease_until || Date.parse(cur.lease_until) <= now;
    const retryDue = cur.status === 'failed' && Date.parse(cur.updated_at) <= now - RETRY_AFTER_MS;
    if (!(retryDue || (['building', 'ready', 'sending'].includes(cur.status) && leaseOver))) return null;
    const { data: taken } = await db.from('weekly_reports')
      .update({ status: cur.report ? 'ready' : 'building', attempts: cur.attempts + 1, lease_until: leaseUntil, updated_at: new Date(now).toISOString() })
      .eq('id', cur.id).eq('status', cur.status).eq('attempts', cur.attempts).select('*');
    return taken && taken.length ? taken[0] : null;
  }

  async function finish(rowId, patch) {
    await db.from('weekly_reports').update(Object.assign({ lease_until: null, updated_at: new Date().toISOString() }, patch)).eq('id', rowId);
  }

  async function businessName(userId) {
    try { const { data } = await db.from('business_profile').select('company_name').eq('user_id', userId).maybeSingle(); return (data && data.company_name) || null; } catch (_) { return null; }
  }

  async function build(user, week, row, budget) {
    if (row.report) return { report: row.report, insights: row.insights || null, aiStatus: row.ai_status || null };
    const results = await collect({ id: user.id }, week);
    const report = metrics.buildReport(results, week, { businessName: await businessName(user.id) });
    let ai = { status: report.hasData ? 'disabled' : 'not_needed', insights: null };
    if (report.hasData && budget.left > 0 && typeof aiCall === 'function') {
      budget.left--;
      ai = await insights.generate({ report, lang: langOf(user), aiCall });
    }
    await db.from('weekly_reports').update({ status: 'ready', report, insights: ai.insights, ai_status: ai.status + (ai.reason ? ':' + ai.reason : ''), updated_at: new Date().toISOString() }).eq('id', row.id);
    return { report, insights: ai.insights, aiStatus: ai.status };
  }

  async function ledger(userId, week) {
    const key = ledgerKey(week);
    const ins = await db.from('email_sends').insert({ user_id: userId, template: 'weekly_report', dedupe_key: key, category: 'service', status: 'sending', attempts: 1 }).select('id, status, attempts').maybeSingle();
    if (!ins.error && ins.data) return ins.data;
    const { data } = await db.from('email_sends').select('id, status, attempts').eq('user_id', userId).eq('dedupe_key', key).maybeSingle();
    return data || null;
  }

  async function send(user, week, built, row) {
    const led = await ledger(user.id, week.start);
    if (led && ['sent', 'delivered'].includes(led.status)) { await finish(row.id, { status: 'sent' }); return 'sent'; }
    const out = templates.render('weekly_report', {
      report: built.report, insights: built.insights, lang: langOf(user),
      campaignsUrl: app() + '?page=performance', connectUrl: app() + '?page=businessbrain&tab=connections', offUrl: offUrl(user.id),
    }, { appUrl: app(), postalAddress: env.EMAIL_POSTAL_ADDRESS || '' });
    const off = offUrl(user.id);
    const r = await sender.send({
      to: user.email, subject: out.subject, html: out.html, text: out.text,
      headers: off ? { 'List-Unsubscribe': `<${off}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
      tags: [{ name: 'template', value: 'weekly_report' }],
      idempotencyKey: `oriven:${scope()}:${user.id}:weekly_report:${week.start}`,
    });
    const now = new Date().toISOString();
    let status;
    if (r && r.id) status = 'sent';
    else if (r && r.skipped) status = 'skipped';
    else status = sender.isRetryable(r && r.error) && row.attempts < MAX_ATTEMPTS ? 'failed' : 'error';
    const code = r && (r.error || r.skipped) ? String(r.error || r.skipped).slice(0, 80) : null;
    if (led) await db.from('email_sends').update({ status, provider_id: r && r.id ? r.id : null, sent_at: r && r.id ? now : null, error: code, attempts: row.attempts, updated_at: now }).eq('id', led.id);
    await finish(row.id, { status, provider_id: r && r.id ? r.id : null, sent_at: r && r.id ? now : null, error: code });
    return status;
  }

  async function processUser(user, now, budget, summary) {
    const tz = period.resolveTimeZone(user.timezone);
    if (!period.isDue(now, tz)) return;
    if (!user.email || optedOut(user)) { summary.skipped++; return; }
    if (lifecycle && lifecycle.isSuppressed && await lifecycle.isSuppressed(user.email)) { summary.skipped++; return; }
    const week = period.lastCompletedWeek(now, user.timezone);
    const row = await claim(user, week, now);
    if (!row) return;
    summary.claimed++;
    let built;
    try { built = await build(user, week, row, budget); }
    catch (err) {
      log('[WeeklyReport] build failed | user ' + short(user.id) + ' | ' + (err.code || err.status || 'error'));
      await finish(row.id, { status: row.attempts >= MAX_ATTEMPTS ? 'error' : 'failed', error: 'build_failed' });
      summary.failed++; return;
    }
    const st = await send(user, week, built, row);
    if (st === 'sent') summary.sent++; else if (st === 'skipped') summary.skipped++; else summary.failed++;
    if (built.aiStatus === 'ok') summary.withInsights++;
  }

  // One pass. Returns a summary without personal data.
  async function runOnce({ now, limit, aiBudget } = {}) {
    now = now || Date.now();
    const summary = { considered: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, withInsights: 0 };
    if (sender.mode() === 'off') return Object.assign(summary, { disabled: 'mode_off' });
    if (!sender.configured()) return Object.assign(summary, { disabled: 'not_configured' });
    if (!(await tableReady())) return Object.assign(summary, { disabled: 'table_missing' });
    const users = await candidates(limit || DEFAULT_USER_LIMIT);
    const envBudget = String(env.WEEKLY_REPORT_AI_BUDGET || '').trim();
    const budget = { left: aiBudget != null ? aiBudget : (/^\d+$/.test(envBudget) ? Number(envBudget) : DEFAULT_AI_BUDGET) };
    let i = 0;
    const worker = async () => {
      while (i < users.length) {
        const u = users[i++];
        summary.considered++;
        try { await processUser(u, now, budget, summary); }
        catch (err) { summary.failed++; log('[WeeklyReport] user ' + short(u.id) + ' failed: ' + (err.code || 'error')); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker));
    return summary;
  }

  return { runOnce, offUrl, _claim: claim };
}

// Constant-time check of the scheduler secret (header X-Weekly-Report-Secret).
function checkSchedulerSecret(given, expected) {
  if (!expected || typeof expected !== 'string' || expected.length < 32 || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createRunner, checkSchedulerSecret, MAX_ATTEMPTS, RETRY_AFTER_MS, LEASE_MS };
