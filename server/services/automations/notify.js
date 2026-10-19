// ════════════════════════════════════════════════════════════════
// Automations — notifications.
//
// In-app: one automation_notifications row per event (unique per user +
// dedupe_key, so the same event is never stored twice), mirrored into
// intelligence_events so the existing notification bell shows it.
// Email: events are queued per user during a run and sent as ONE grouped
// email at flush() — at most SHARED.emailsPerHour per user; anything over
// stays in-app (email_status 'rate_limited'). Sends go through the same
// email_sends ledger + Resend sender as the lifecycle emails, so the
// provider webhook later marks them delivered/bounced. 'sent' here means
// accepted by the provider — never "delivered".
// ════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const { SHARED } = require('./limits');

const EMAIL_EVENTS = ['executed', 'failed', 'approval', 'paused', 'resumed', 'budget_changed', 'scheduled_completed', 'disconnected', 'credentials_expired'];
const KINDS = EMAIL_EVENTS.concat(['skipped', 'missed', 'conflict']);

function createNotifier({ db, sender, templates, lifecycle, getSettings, appUrl, apiUrl, log }) {
  log = log || (() => {});
  const queue = new Map(); // userId -> [notification rows]

  async function add(userId, n) {
    if (!userId || !n || !KINDS.includes(n.kind)) return null;
    const settings = await getSettings(userId);
    const row = {
      user_id: userId, automation_id: n.automationId || null, execution_id: n.executionId || null, kind: n.kind,
      title: String(n.title || '').slice(0, 200), body: n.body ? String(n.body).slice(0, 600) : null, severity: n.severity || 'low',
      dedupe_key: String(n.dedupeKey || crypto.randomUUID()).slice(0, 200), email_status: 'none',
    };
    const ins = await db.from('automation_notifications').insert(row).select().maybeSingle();
    if (ins.error) { if (ins.error.code === '23505') return null; throw ins.error; } // already notified
    const saved = ins.data || row;
    if (settings.notify_in_app !== false) {
      // The existing bell reads intelligence_events (type campaign_action).
      await db.from('intelligence_events').insert({
        user_id: userId, platform: n.platform || null, campaign_name: n.campaignName || null, type: 'campaign_action',
        title: (n.automationName ? `Automation "${n.automationName}": ` : 'Automation: ') + row.title,
        detail: row.body, severity: n.kind === 'failed' || n.kind === 'credentials_expired' || n.kind === 'disconnected' ? 'high' : (n.kind === 'approval' ? 'medium' : 'low'),
        message: row.body || row.title,
      }).then(() => {}, () => {});
    }
    const events = Array.isArray(settings.email_events) ? settings.email_events : EMAIL_EVENTS;
    if (settings.notify_email !== false && events.includes(n.kind)) {
      if (!queue.has(userId)) queue.set(userId, []);
      queue.get(userId).push(saved);
      await db.from('automation_notifications').update({ email_status: 'queued' }).eq('id', saved.id);
    }
    return saved;
  }

  function offUrl(userId) {
    try {
      const u = lifecycle && lifecycle.unsubscribeUrl ? lifecycle.unsubscribeUrl(userId) : null;
      const t = u ? new URL(u).searchParams.get('t') : null;
      return t ? `${apiUrl()}/api/automations/email/off?u=${encodeURIComponent(userId)}&t=${t}` : null;
    } catch (_) { return null; }
  }

  async function _send(userId, items, batch, attempt) {
    const { data: prof } = await db.from('profiles').select('id, email').eq('id', userId).maybeSingle();
    const ids = items.map((i) => i.id);
    if (!prof || !prof.email) { await db.from('automation_notifications').update({ email_status: 'skipped' }).in('id', ids); return 'skipped'; }
    const out = templates.render('automation_update', { items: items.map((i) => ({ title: i.title, detail: i.body })), count: items.length, appUrl: appUrl() + '?page=autopilot', settingsUrl: appUrl() + '?page=autopilot&tab=settings', offUrl: offUrl(userId) }, { appUrl: appUrl(), postalAddress: process.env.EMAIL_POSTAL_ADDRESS || '' });
    const r = await sender.send({ to: prof.email, subject: out.subject, html: out.html, text: out.text, tags: [{ name: 'template', value: 'automation_update' }], idempotencyKey: `oriven:${sender.scope()}:${userId}:automation:${batch}` });
    const now = new Date().toISOString();
    let status;
    if (r && r.id) status = 'sent';
    else if (r && r.skipped) status = 'skipped';
    else status = sender.isRetryable(r && r.error) ? 'failed' : 'error';
    await db.from('email_sends').update({ status, provider_id: r && r.id ? r.id : null, sent_at: r && r.id ? now : null, error: r && (r.error || r.skipped) ? String(r.error || r.skipped).slice(0, 80) : null, attempts: attempt, updated_at: now }).eq('user_id', userId).eq('dedupe_key', 'automation:' + batch);
    await db.from('automation_notifications').update({ email_status: status === 'error' ? 'failed' : status }).in('id', ids);
    return status;
  }

  // Sends one grouped email per user with queued events.
  async function flush() {
    const out = { sent: 0, skipped: 0, failed: 0, rateLimited: 0 };
    for (const [userId, items] of Array.from(queue.entries())) {
      queue.delete(userId);
      if (!items.length) continue;
      const ids = items.map((i) => i.id);
      try {
        if (sender.mode() === 'off' || !sender.configured()) { await db.from('automation_notifications').update({ email_status: 'skipped' }).in('id', ids); out.skipped++; continue; }
        const since = new Date(Date.now() - 3600e3).toISOString();
        const { data: recent } = await db.from('email_sends').select('id').eq('user_id', userId).eq('template', 'automation_update').gte('created_at', since);
        if ((recent || []).length >= SHARED.emailsPerHour) { await db.from('automation_notifications').update({ email_status: 'rate_limited' }).in('id', ids); out.rateLimited++; continue; }
        const batch = crypto.randomUUID();
        const ins = await db.from('email_sends').insert({ user_id: userId, template: 'automation_update', dedupe_key: 'automation:' + batch, category: 'service', status: 'sending', attempts: 1 }).select('id').maybeSingle();
        if (ins.error) { out.skipped++; continue; }
        await db.from('automation_notifications').update({ email_batch: batch }).in('id', ids);
        const st = await _send(userId, items, batch, 1);
        if (st === 'sent') out.sent++; else if (st === 'skipped') out.skipped++; else out.failed++;
      } catch (err) { log('[Automations] email flush failed: ' + err.message); out.failed++; }
    }
    return out;
  }

  // Temporary send failures are retried (max 3 attempts, 10+ minutes apart).
  async function retryFailed() {
    if (sender.mode() === 'off' || !sender.configured()) return 0;
    const cutoff = new Date(Date.now() - 10 * 60e3).toISOString();
    const { data } = await db.from('email_sends').select('id, user_id, dedupe_key, attempts').eq('template', 'automation_update').eq('status', 'failed').lt('attempts', 3).lte('updated_at', cutoff).limit(20);
    let n = 0;
    for (const row of data || []) {
      const { data: claimed } = await db.from('email_sends').update({ status: 'sending' }).eq('id', row.id).eq('status', 'failed').select('id');
      if (!claimed || !claimed.length) continue;
      const batch = String(row.dedupe_key).replace(/^automation:/, '');
      const { data: items } = await db.from('automation_notifications').select('*').eq('email_batch', batch);
      if (!items || !items.length) continue;
      await _send(row.user_id, items, batch, row.attempts + 1);
      n++;
    }
    return n;
  }

  return { add, flush, retryFailed, offUrl, _queue: queue };
}

module.exports = { createNotifier, EMAIL_EVENTS, KINDS };
