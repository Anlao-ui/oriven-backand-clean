// ════════════════════════════════════════════════════════════════
// Automations API (replaces the user-facing Autopilot).
//
//   GET    /api/automations/overview            real counts, next run, last check, accounts, system state
//   GET    /api/automations/capabilities        what each platform supports (metrics, actions, budget scopes)
//   GET    /api/automations/campaigns?platform  the user's campaigns, read live (for selection)
//   GET    /api/automations                     list (rules + schedules)
//   GET    /api/automations/:id                 detail + recent activity + upcoming runs
//   POST   /api/automations/preview             validate + summary + cost (never charges)
//   POST   /api/automations                     create — 50 credits once, after validation
//   PATCH  /api/automations/:id                 edit (free)
//   POST   /api/automations/:id/pause|resume    switch one automation off/on (free)
//   DELETE /api/automations/:id                 delete (history kept; no refund)
//   GET    /api/automations/activity            execution ledger
//   GET    /api/automations/approvals           pending (and recent) approvals
//   POST   /api/automations/approvals/:id/approve|reject
//   GET    /api/automations/jobs                upcoming scheduled runs
//   POST   /api/automations/jobs/:id/cancel     cancel one scheduled run
//   GET    /api/automations/settings            persisted settings
//   PUT    /api/automations/settings
//   POST   /api/automations/pause-all | resume-all
//   GET    /api/automations/notifications       in-app automation notifications
//   POST   /api/automations/notifications/read
//   GET    /api/automations/email/off           one-click "turn off automation emails"
//
// Access: requireAutopilotAccess (the existing plan entitlement, Starter and
// up). Every query is scoped to the signed-in user; campaign ids from the
// browser are only used after being found in that user's own connected
// account (engine.validate / executeAction).
// ════════════════════════════════════════════════════════════════
'use strict';

const M = require('../services/automations/metrics');
const B = require('../services/automations/budget');
const P = require('../services/automations/platforms');
const S = require('../services/automations/schedule');
const L = require('../services/automations/limits');
const { createEngine, normalizeRule, summarize, RULE_ACTIONS, MODES } = require('../services/automations/engine');
const { createNotifier, EMAIL_EVENTS } = require('../services/automations/notify');

module.exports = function registerAutomationRoutes(app, d) {
  const db = d.supabaseAdmin;
  const adapters = P.create(d.platformHelpers);
  const getSettingsRef = { fn: null };
  const notifier = createNotifier({ db, sender: d.sender, templates: d.templates, lifecycle: d.lifecycle, getSettings: (u) => getSettingsRef.fn(u), appUrl: d.appUrl, apiUrl: d.apiUrl, log: d.log });
  const engine = createEngine({ db, adapters, notifier, killSwitch: d.killSwitch, planOf: d.planOf, log: d.log });
  getSettingsRef.fn = engine.getSettings;
  const guard = d.requireAutopilotAccess;
  const COST = () => d.creditManager.FEATURE_COSTS.automation;

  function dbUnavailable(err) { return err && (err.code === 'PGRST205' || err.code === '42P01' || /schema cache|does not exist/i.test(err.message || '')); }
  function fail(res, err, where) {
    if (dbUnavailable(err)) return res.status(503).json({ error: 'Automations needs a database update before it can be used. Nothing was changed.', code: 'DB_UNAVAILABLE' });
    (d.log || console.error)(`[automations ${where}] ${err && err.message}`);
    return res.status(500).json({ error: 'Something went wrong. Nothing was changed. Please try again.', code: 'UNKNOWN_ERROR' });
  }
  async function owned(userId, id) {
    const { data, error } = await db.from('automation_rules').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data && !data.deleted_at ? data : null;
  }
  async function activeCount(userId) {
    const { data, error } = await db.from('automation_rules').select('id, deleted_at').eq('user_id', userId).eq('enabled', true);
    if (error) throw error;
    return (data || []).filter((r) => !r.deleted_at).length;
  }
  async function pendingJobCount(userId) {
    const { data } = await db.from('automation_jobs').select('id').eq('user_id', userId).eq('status', 'scheduled');
    return (data || []).length;
  }
  function view(row, extra) {
    const r = normalizeRule(row);
    return Object.assign({
      id: r.id, name: r.name, kind: r.kind, platform: r.platform, enabled: r.enabled, status: r.status, blocked: r.blocked, legacy: r.legacy,
      scope: r.scope, condition: r.condition || null, window: r.window || null, minData: r.minData || null, action: r.action, mode: r.mode,
      percent: r.percent || null, limits: r.limits || null, schedule: r.schedule || null, currency: r.currency || null,
      createdAt: r.createdAt, updatedAt: r.updatedAt, lastEvaluatedAt: r.lastEvaluatedAt, lastResult: r.lastResult, summary: summarize(r),
    }, extra || {});
  }

  // ── Read endpoints ───────────────────────────────────────────────
  app.get('/api/automations/capabilities', guard, async (req, res) => {
    const plan = await d.planOf(req.user.id);
    res.json({
      platforms: P.PLATFORMS.map((p) => ({ platform: p, label: P.LABEL[p], metrics: M.PLATFORM_METRICS[p], capabilities: P.CAPABILITIES[p] })),
      actions: RULE_ACTIONS, modes: MODES, windows: M.DATA_WINDOWS, defaultMinData: M.DEFAULT_MIN_DATA,
      budgetLimitDefaults: B.LIMIT_DEFAULTS, budgetLimitBounds: B.LIMIT_BOUNDS, scheduleActions: S.ACTIONS,
      cost: COST(), plan, limits: L.forPlan(plan), emailEvents: EMAIL_EVENTS,
    });
  });

  app.get('/api/automations/campaigns', guard, async (req, res) => {
    const platform = String(req.query.platform || '');
    if (!P.PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Choose a platform.' });
    try {
      const w = M.DATA_WINDOWS.includes(Number(req.query.window)) ? Number(req.query.window) : null;
      const out = await adapters[platform].listCampaigns({ id: req.user.id }, w);
      res.json({
        account: out.account,
        campaigns: out.campaigns.filter((c) => c.status !== 'archived').map((c) => ({
          id: c.id, name: c.name, status: c.status, metrics: c.metrics,
          budget: c.budget ? { scope: c.budget.scope, amount: c.budget.amount, currency: c.budget.currency, editable: c.budget.editable, reason: c.budget.reason || null, adsets: c.budget.items ? c.budget.items.length : 0, shared: c.budget.shared || null } : null,
        })),
      });
    } catch (err) {
      const k = P.classifyError(err);
      const status = k.kind === 'auth' || k.kind === 'not_connected' ? 409 : 502;
      res.status(status).json({ error: k.kind === 'auth' ? `${P.LABEL[platform]} needs to be reconnected.` : k.kind === 'not_connected' ? `Connect ${P.LABEL[platform]} first.` : `${P.LABEL[platform]} didn’t respond. Try again in a moment.`, code: k.kind });
    }
  });

  app.get('/api/automations', guard, async (req, res) => {
    try {
      const { data, error } = await db.from('automation_rules').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      const rows = (data || []).filter((r) => !r.deleted_at);
      const { data: jobs } = await db.from('automation_jobs').select('automation_id, run_at, action, campaign_name').eq('user_id', req.user.id).eq('status', 'scheduled').order('run_at', { ascending: true }).limit(500);
      const nextBy = {};
      (jobs || []).forEach((j) => { if (!nextBy[j.automation_id]) nextBy[j.automation_id] = { runAt: j.run_at, action: j.action, campaignName: j.campaign_name }; });
      res.json({ automations: rows.map((r) => view(r, { nextRun: nextBy[r.id] || null })) });
    } catch (err) { fail(res, err, 'list'); }
  });

  app.get('/api/automations/overview', guard, async (req, res) => {
    try {
      const uid = req.user.id;
      const [rules, jobs, approvals, execs, settings, intg] = await Promise.all([
        db.from('automation_rules').select('*').eq('user_id', uid).limit(500),
        db.from('automation_jobs').select('id, automation_id, run_at, action, campaign_name, platform, timezone, local_time').eq('user_id', uid).eq('status', 'scheduled').order('run_at', { ascending: true }).limit(200),
        db.from('automation_approvals').select('id').eq('user_id', uid).eq('status', 'pending'),
        db.from('automation_executions').select('id, status, created_at, finished_at').eq('user_id', uid).gte('created_at', new Date(Date.now() - 7 * 86400e3).toISOString()).limit(2000),
        engine.getSettings(uid),
        db.from('integrations').select('provider').eq('user_id', uid),
      ]);
      for (const r of [rules, jobs, approvals, execs]) if (r.error) throw r.error;
      const live = (rules.data || []).filter((r) => !r.deleted_at).map(normalizeRule);
      const managed = new Set();
      live.filter((r) => r.enabled).forEach((r) => { if (r.scope.type === 'account') managed.add(r.platform + ':*'); else (r.scope.campaign_ids || []).forEach((id) => managed.add(r.platform + ':' + id)); });
      const ex = execs.data || [];
      const providers = new Set((intg.data || []).map((i) => i.provider));
      const lastRun = ex.filter((e) => e.finished_at).map((e) => e.finished_at).sort().pop() || null;
      res.json({
        counts: {
          active: live.filter((r) => r.enabled && r.status === 'active').length,
          paused: live.filter((r) => !r.enabled && r.status !== 'completed').length,
          needsReview: live.filter((r) => r.status === 'needs_review').length,
          completed: live.filter((r) => r.status === 'completed').length,
          rules: live.filter((r) => r.kind === 'rule').length, schedules: live.filter((r) => r.kind === 'schedule').length,
          scheduled: (jobs.data || []).length, pendingApprovals: (approvals.data || []).length,
          completed7d: ex.filter((e) => e.status === 'completed').length, failed7d: ex.filter((e) => e.status === 'failed').length, skipped7d: ex.filter((e) => e.status === 'skipped').length,
          managedCampaigns: Array.from(managed).filter((k) => !k.endsWith(':*')).length, accountWide: Array.from(managed).filter((k) => k.endsWith(':*')).map((k) => k.split(':')[0]),
        },
        nextRun: (jobs.data || [])[0] || null,
        lastCheckAt: settings.rules_eval_at || null, lastActionAt: lastRun,
        pausedAll: !!settings.paused_all,
        accounts: P.PLATFORMS.map((p) => ({ platform: p, label: P.LABEL[p], connected: providers.has(P.PROVIDER[p]) })),
        system: { executionEnabled: !d.killSwitch(), backgroundJobs: d.backgroundJobs(), schedulerEveryMinutes: 1, rulesEveryMinutes: L.forPlan(await d.planOf(uid)).evalMinutes },
      });
    } catch (err) { fail(res, err, 'overview'); }
  });

  app.get('/api/automations/activity', guard, async (req, res) => {
    try {
      let q = db.from('automation_executions').select('*').eq('user_id', req.user.id);
      const st = String(req.query.status || '');
      if (['completed', 'failed', 'skipped', 'pending_approval', 'cancelled', 'running', 'scheduled'].includes(st)) q = q.eq('status', st);
      if (req.query.automation_id) q = q.eq('automation_id', String(req.query.automation_id));
      if (req.query.before) q = q.lt('created_at', String(req.query.before));
      const { data, error } = await q.order('created_at', { ascending: false }).limit(Math.min(100, Number(req.query.limit) || 50));
      if (error) throw error;
      res.json({ items: data || [] });
    } catch (err) { fail(res, err, 'activity'); }
  });

  app.get('/api/automations/approvals', guard, async (req, res) => {
    try {
      await engine.expireApprovals(Date.now());
      const st = String(req.query.status || 'pending');
      let q = db.from('automation_approvals').select('*').eq('user_id', req.user.id);
      if (st !== 'all') q = q.eq('status', st);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json({ approvals: data || [] });
    } catch (err) { fail(res, err, 'approvals'); }
  });

  app.get('/api/automations/jobs', guard, async (req, res) => {
    try {
      let q = db.from('automation_jobs').select('*').eq('user_id', req.user.id).eq('status', String(req.query.status || 'scheduled'));
      if (req.query.automation_id) q = q.eq('automation_id', String(req.query.automation_id));
      const { data, error } = await q.order('run_at', { ascending: true }).limit(200);
      if (error) throw error;
      res.json({ jobs: data || [] });
    } catch (err) { fail(res, err, 'jobs'); }
  });

  app.get('/api/automations/:id', guard, async (req, res, next) => {
    if (['overview', 'capabilities', 'campaigns', 'activity', 'approvals', 'jobs', 'settings', 'notifications', 'email'].includes(req.params.id)) return next();
    try {
      const row = await owned(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'Automation not found.' });
      const [{ data: acts }, { data: jobs }] = await Promise.all([
        db.from('automation_executions').select('*').eq('user_id', req.user.id).eq('automation_id', row.id).order('created_at', { ascending: false }).limit(20),
        db.from('automation_jobs').select('*').eq('user_id', req.user.id).eq('automation_id', row.id).eq('status', 'scheduled').order('run_at', { ascending: true }).limit(20),
      ]);
      res.json({ automation: view(row), activity: acts || [], jobs: jobs || [] });
    } catch (err) { fail(res, err, 'detail'); }
  });

  // ── Create / edit ────────────────────────────────────────────────
  app.post('/api/automations/preview', guard, async (req, res) => {
    try {
      const v = await engine.validate(req.user.id, req.body);
      const plan = await d.planOf(req.user.id);
      const lim = L.forPlan(plan);
      const active = await activeCount(req.user.id);
      if (!v.ok) return res.status(422).json({ ok: false, errors: v.errors, cost: COST() });
      res.json({ ok: true, summary: summarize(normalizeRule(Object.assign({ id: 'preview', user_id: req.user.id, enabled: true }, v.row))), cost: COST(), limitReached: active >= lim.active, activeLimit: lim.active });
    } catch (err) { fail(res, err, 'preview'); }
  });

  // laneGuard('automation'): one creation at a time per user, one charge per
  // X-Idempotency-Key (a double click or retry gets 409, never a 2nd charge),
  // and any failed response refunds the charge automatically (paidActions).
  app.post('/api/automations', guard, d.paidActions.laneGuard('automation'), async (req, res) => {
    const uid = req.user.id;
    let v;
    try {
      v = await engine.validate(uid, req.body); // validation first: invalid → no charge
      if (!v.ok) return res.status(422).json({ ok: false, errors: v.errors, error: v.errors[0].message, code: v.errors[0].code });
      const plan = await d.planOf(uid);
      const lim = L.forPlan(plan);
      if (await activeCount(uid) >= lim.active) return res.status(403).json({ ok: false, code: 'PLAN_LIMIT', error: `Your plan includes up to ${lim.active} active automations. Pause or delete one first.` });
      if (v.row.kind === 'schedule') {
        const add = v.row.schedule.items.length * v.row.scope.campaigns.length;
        if (await pendingJobCount(uid) + add > lim.pendingJobs) return res.status(403).json({ ok: false, code: 'PLAN_LIMIT', error: `Your plan includes up to ${lim.pendingJobs} upcoming scheduled actions.` });
      }
    } catch (err) { return fail(res, err, 'create.validate'); }
    // Fail closed: if the credit check or deduction fails for any reason,
    // nothing is created.
    let reservation;
    try {
      reservation = await d.creditManager.reserveCredits({ id: uid }, 'automation');
    } catch (err) {
      if (err instanceof d.creditManager.InsufficientCreditsError) return res.status(402).json({ ok: false, code: 'CREDITS_EXHAUSTED', error: `Creating an automation costs ${COST()} credits. You don’t have enough credits right now.` });
      (d.log || console.error)('[automations create] credit check failed: ' + err.message);
      return res.status(503).json({ ok: false, code: 'CREDIT_CHECK_FAILED', error: 'We couldn’t check your credits, so nothing was created or charged. Please try again.' });
    }
    try {
      const now = new Date().toISOString();
      const row = Object.assign({ user_id: uid, enabled: true, status: 'active', created_at: now, charge: { credits: reservation.cost, request_id: reservation.requestId, at: now } }, v.row);
      const ins = await db.from('automation_rules').insert(row).select().maybeSingle();
      if (ins.error || !ins.data) throw ins.error || new Error('insert returned nothing');
      if (ins.data.kind === 'schedule') await engine.materialize(ins.data, Date.now());
      d.creditManager.finalizeCreditLog(reservation, 'automation', { success: true, route: 'POST /api/automations' }).catch(() => {});
      res.json({ ok: true, automation: view(ins.data), charged: reservation.cost });
    } catch (err) {
      d.creditManager.finalizeCreditLog(reservation, 'automation', { success: false, error: err.message, route: 'POST /api/automations' }).catch(() => {});
      // A failed response refunds the charge (paidActions.responseHook).
      return fail(res, err, 'create.insert');
    }
  });

  app.patch('/api/automations/:id', guard, async (req, res) => {
    try {
      const row = await owned(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'Automation not found.' });
      const kind = row.kind || 'rule';
      const v = await engine.validate(req.user.id, Object.assign({}, req.body, { kind }));
      if (!v.ok) return res.status(422).json({ ok: false, errors: v.errors, error: v.errors[0].message, code: v.errors[0].code });
      // An edited automation is re-validated in full, so a "needs review" or
      // finished one becomes active again (still free).
      const patch = Object.assign({}, v.row, { status: 'active' });
      const { data, error } = await db.from('automation_rules').update(patch).eq('id', row.id).eq('user_id', req.user.id).select().maybeSingle();
      if (error) throw error;
      if (kind === 'schedule') { await engine.cancelPending(row.id, 'rescheduled'); if (data.enabled) await engine.materialize(data, Date.now()); }
      res.json({ ok: true, automation: view(data) }); // editing is free
    } catch (err) { fail(res, err, 'edit'); }
  });

  app.post('/api/automations/:id/pause', guard, async (req, res) => {
    try {
      const row = await owned(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'Automation not found.' });
      const { data, error } = await db.from('automation_rules').update({ enabled: false, updated_at: new Date().toISOString() }).eq('id', row.id).eq('user_id', req.user.id).select().maybeSingle();
      if (error) throw error;
      if ((row.kind || 'rule') === 'schedule') await engine.cancelPending(row.id, 'paused');
      res.json({ ok: true, automation: view(data) });
    } catch (err) { fail(res, err, 'pause'); }
  });

  app.post('/api/automations/:id/resume', guard, async (req, res) => {
    try {
      const row = await owned(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'Automation not found.' });
      const r = normalizeRule(row);
      if (r.blocked) return res.status(409).json({ ok: false, code: r.blocked, error: 'Edit this automation first — it needs a change before it can run.' });
      if (r.status === 'completed') return res.status(409).json({ ok: false, code: 'completed', error: 'This schedule has finished. Edit it to set new dates.' });
      const lim = L.forPlan(await d.planOf(req.user.id));
      if (!row.enabled && await activeCount(req.user.id) >= lim.active) return res.status(403).json({ ok: false, code: 'PLAN_LIMIT', error: `Your plan includes up to ${lim.active} active automations.` });
      const { data, error } = await db.from('automation_rules').update({ enabled: true, updated_at: new Date().toISOString() }).eq('id', row.id).eq('user_id', req.user.id).select().maybeSingle();
      if (error) throw error;
      if (r.kind === 'schedule') await engine.materialize(data, Date.now());
      res.json({ ok: true, automation: view(data) });
    } catch (err) { fail(res, err, 'resume'); }
  });

  app.delete('/api/automations/:id', guard, async (req, res) => {
    try {
      const row = await owned(req.user.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'Automation not found.' });
      const now = new Date().toISOString();
      const { error } = await db.from('automation_rules').update({ deleted_at: now, enabled: false, updated_at: now }).eq('id', row.id).eq('user_id', req.user.id);
      if (error) throw error;
      await engine.cancelPending(row.id, 'deleted');
      const { data: open } = await db.from('automation_approvals').select('id, execution_id').eq('user_id', req.user.id).eq('automation_id', row.id).eq('status', 'pending');
      for (const a of open || []) {
        await db.from('automation_approvals').update({ status: 'rejected', decided_at: now, error: 'automation_deleted' }).eq('id', a.id).eq('status', 'pending');
        if (a.execution_id) await db.from('automation_executions').update({ status: 'cancelled', reason: 'automation_deleted', finished_at: now }).eq('id', a.execution_id);
      }
      res.json({ ok: true }); // the creation charge is not refunded (shown before creating)
    } catch (err) { fail(res, err, 'delete'); }
  });

  // ── Approvals / jobs ─────────────────────────────────────────────
  for (const verb of ['approve', 'reject']) {
    app.post('/api/automations/approvals/:id/' + verb, guard, async (req, res) => {
      try {
        const r = await engine.decide(req.user.id, req.params.id, verb === 'approve');
        res.status(r.http).json(Object.assign({ ok: r.http < 400 }, r, { http: undefined }));
      } catch (err) { fail(res, err, verb); }
    });
  }
  app.post('/api/automations/jobs/:id/cancel', guard, async (req, res) => {
    try {
      const { data, error } = await db.from('automation_jobs').update({ status: 'cancelled', error: 'cancelled_by_user', updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id).eq('status', 'scheduled').select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: 'This scheduled action already ran or was cancelled.' });
      await db.from('automation_executions').insert({ user_id: req.user.id, automation_id: data.automation_id, source: 'schedule', job_id: data.id, platform: data.platform, campaign_id: data.campaign_id, campaign_name: data.campaign_name, mode: 'scheduled', action: data.action, status: 'cancelled', reason: 'cancelled_by_user', trigger: { scheduled_for: data.local_time, timezone: data.timezone }, idempotency_key: 'job:' + data.idempotency_key, finished_at: new Date().toISOString() }).then(() => {}, () => {});
      // The next weekly occurrence is still planned.
      const row = await owned(req.user.id, data.automation_id);
      if (row && row.enabled) await engine.materialize(row, new Date(data.run_at).getTime() + 1000);
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'job.cancel'); }
  });

  // ── Settings / pause all ─────────────────────────────────────────
  app.get('/api/automations/settings', guard, async (req, res) => {
    try { const s = await engine.getSettings(req.user.id); res.json({ settings: { pausedAll: !!s.paused_all, pausedAt: s.paused_at || null, notifyInApp: s.notify_in_app !== false, notifyEmail: s.notify_email !== false, emailEvents: Array.isArray(s.email_events) ? s.email_events : EMAIL_EVENTS } }); }
    catch (err) { fail(res, err, 'settings.get'); }
  });
  app.put('/api/automations/settings', guard, async (req, res) => {
    try {
      const b = req.body || {};
      const patch = {};
      if (typeof b.notifyInApp === 'boolean') patch.notify_in_app = b.notifyInApp;
      if (typeof b.notifyEmail === 'boolean') patch.notify_email = b.notifyEmail;
      if (Array.isArray(b.emailEvents)) patch.email_events = b.emailEvents.filter((e) => EMAIL_EVENTS.includes(e));
      await engine.saveSettings(req.user.id, patch);
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'settings.put'); }
  });
  for (const [path, on] of [['pause-all', true], ['resume-all', false]]) {
    app.post('/api/automations/' + path, guard, async (req, res) => {
      try { await engine.saveSettings(req.user.id, { paused_all: on, paused_at: on ? new Date().toISOString() : null }); res.json({ ok: true, pausedAll: on }); }
      catch (err) { fail(res, err, path); }
    });
  }

  // ── Notifications ────────────────────────────────────────────────
  app.get('/api/automations/notifications', guard, async (req, res) => {
    try {
      let q = db.from('automation_notifications').select('*').eq('user_id', req.user.id);
      if (req.query.unread) q = q.is('read_at', null);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      res.json({ notifications: data || [] });
    } catch (err) { fail(res, err, 'notifications'); }
  });
  app.post('/api/automations/notifications/read', guard, async (req, res) => {
    try { await db.from('automation_notifications').update({ read_at: new Date().toISOString() }).eq('user_id', req.user.id).is('read_at', null); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'notifications.read'); }
  });
  app.get('/api/automations/email/off', async (req, res) => {
    const u = String(req.query.u || ''), t = String(req.query.t || '');
    const ok = d.lifecycle && d.lifecycle.checkUnsubToken && d.lifecycle.checkUnsubToken(u, t);
    if (!ok) return res.status(400).type('html').send('<p style="font-family:sans-serif">This link isn’t valid any more. You can change automation emails in OrivenAI → Automations → Settings.</p>');
    try { await engine.saveSettings(u, { notify_email: false }); }
    catch (_) { return res.status(503).type('html').send('<p style="font-family:sans-serif">We couldn’t update your settings right now. Please try again, or change them in OrivenAI → Automations → Settings.</p>'); }
    res.type('html').send('<p style="font-family:sans-serif">Automation emails are off. You’ll still see updates in OrivenAI. You can turn them back on in Automations → Settings.</p>');
  });

  return { engine, notifier, adapters };
};
