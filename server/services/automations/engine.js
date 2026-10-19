// ════════════════════════════════════════════════════════════════
// Automations engine — deterministic rules, schedules and approvals.
//
// No AI anywhere in this file. Every decision comes from real campaign data
// fetched through services/automations/platforms.js.
//
// Durability: every action attempt is a row in automation_executions with a
// UNIQUE idempotency_key, inserted BEFORE the platform call — a second
// worker, a retry or an overlapping run hits the unique key and does
// nothing. Scheduled jobs and approvals move between states with
// conditional updates (… WHERE status = 'scheduled' / 'pending'), so only
// one caller can ever win a transition.
//
// Before any change: the automation must still exist and be on (unless a
// person approved it), "pause all" and the emergency switch must be off,
// the campaign is re-read live from the platform (ownership, status,
// budget), and an action that is already satisfied is recorded as
// skipped, not repeated.
// ════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const M = require('./metrics');
const B = require('./budget');
const S = require('./schedule');
const P = require('./platforms');
const { forPlan, SHARED } = require('./limits');

const RULE_ACTIONS = ['pause_campaign', 'resume_campaign', 'increase_budget', 'decrease_budget', 'notify'];
const FINANCIAL = ['pause_campaign', 'resume_campaign', 'increase_budget', 'decrease_budget'];
const MODES = ['notify', 'approval', 'automatic'];
const LEGACY_MODE = { suggest_only: 'notify', require_approval: 'approval', fully_automatic: 'automatic' };
const ACTION_TO_STATUS = { pause_campaign: 'paused', resume_campaign: 'active', pause: 'paused', stop: 'paused', activate: 'active', resume: 'active' };

function isoNow(now) { return new Date(now).toISOString(); }
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function money(v, cur) { if (v == null) return ''; const r = B.round(v, cur); return (cur ? cur + ' ' : '') + r.toFixed(B.exponent(cur)); }

// ── Reading stored automations (new and legacy rows) ───────────────
function normalizeRule(row) {
  if (!row) return null;
  const ap = row.action_params || {};
  const kind = row.kind || 'rule';
  const r = {
    id: row.id, userId: row.user_id, name: row.name || 'Automation', kind, platform: row.platform || null,
    enabled: !!row.enabled && !row.deleted_at, deleted: !!row.deleted_at, status: row.status || 'active',
    createdAt: row.created_at, updatedAt: row.updated_at || null, lastEvaluatedAt: row.last_evaluated_at || null, lastResult: row.last_result || null,
    charged: !!row.charge, legacy: !row.kind, blocked: null,
  };
  r.scope = row.scope && typeof row.scope === 'object' ? row.scope
    : (ap.campaign_id && ap.campaign_id !== 'all' ? { type: 'campaigns', campaign_ids: [String(ap.campaign_id)], campaigns: [{ id: String(ap.campaign_id), name: ap.campaign_name || '' }] } : { type: 'account' });
  if (kind === 'schedule') {
    r.schedule = row.schedule || null;
    r.action = 'schedule';
    r.mode = 'scheduled';
    return r;
  }
  let action = row.action_type;
  let mode = row.mode || LEGACY_MODE[ap.mode] || 'approval';
  if (action === 'notify') mode = 'notify';
  if (mode === 'notify') action = RULE_ACTIONS.includes(action) ? action : 'notify';
  r.action = action;
  r.mode = mode;
  r.percent = Number(ap.percent) > 0 ? Number(ap.percent) : 15;
  r.limits = ap.limits || null;
  r.window = M.DATA_WINDOWS.includes(Number(row.data_window_days)) ? Number(row.data_window_days) : 7;
  r.minData = row.min_data || null;
  r.condition = { metric: row.trigger_metric, operator: row.trigger_operator, value: row.trigger_metric === 'status' ? row.trigger_text : Number(row.trigger_value) };
  r.currency = row.currency || null;
  // Old Autopilot rows that can't run safely as they are: kept, shown as
  // "needs review" with the reason, never charged again, free to edit.
  if (!RULE_ACTIONS.includes(action) && mode !== 'notify') r.blocked = 'legacy_action';
  else if (!r.platform) r.blocked = 'choose_platform';
  else if (!M.availableFor(r.platform, r.condition.metric)) r.blocked = 'metric_unavailable';
  else if (action === 'increase_budget' && mode !== 'notify' && !(r.limits && Number(r.limits.max_budget) > 0)) r.blocked = 'max_budget_required';
  if (r.blocked && r.status === 'active') r.status = 'needs_review';
  return r;
}

// Plain-English summary (emails/notifications; the app renders its own in six languages).
function summarize(r) {
  const who = r.scope && r.scope.type === 'campaigns' ? (r.scope.campaigns || []).map((c) => '"' + (c.name || c.id) + '"').join(', ') || 'the selected campaigns' : 'any eligible campaign';
  if (r.kind === 'schedule') return `Scheduled actions for ${who} on ${P.LABEL[r.platform] || r.platform}.`;
  const c = r.condition;
  const act = { pause_campaign: 'pause it', resume_campaign: 'resume it', increase_budget: `raise its daily budget by ${r.percent}%`, decrease_budget: `lower its daily budget by ${r.percent}%`, notify: 'notify you' }[r.action];
  const cond = c.metric === 'status' ? `is ${c.value}` : `${M.METRICS[c.metric] ? M.METRICS[c.metric].label : c.metric} ${c.operator} ${c.value} (last ${r.window} days)`;
  const how = r.mode === 'notify' ? 'OrivenAI will notify you' : r.mode === 'approval' ? `OrivenAI will ask you to approve: ${act}` : `OrivenAI will ${act} automatically`;
  return `When ${who} ${cond}, ${how}.`;
}

function createEngine(deps) {
  const db = deps.db;
  const adapters = deps.adapters;
  const notifier = deps.notifier;
  const log = deps.log || (() => {});
  const clock = deps.now || (() => Date.now());
  const worker = deps.workerId || ('w-' + crypto.randomBytes(4).toString('hex'));
  const killed = () => (deps.killSwitch ? !!deps.killSwitch() : false);

  // ── Settings ─────────────────────────────────────────────────────
  async function getSettings(userId) {
    const { data, error } = await db.from('automation_settings').select('*').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data || { user_id: userId, paused_all: false, notify_in_app: true, notify_email: true, email_events: null };
  }
  async function saveSettings(userId, patch) {
    const cur = await getSettings(userId);
    const row = Object.assign({}, cur, patch, { user_id: userId, updated_at: isoNow(clock()) });
    const exists = await db.from('automation_settings').select('user_id').eq('user_id', userId).maybeSingle();
    if (exists.data) await db.from('automation_settings').update(row).eq('user_id', userId);
    else await db.from('automation_settings').insert(row);
    return row;
  }

  // ── Ledger helpers ───────────────────────────────────────────────
  // Inserts the execution row first; returns null when the idempotency key
  // already exists (someone else already handled this exact action).
  async function claimExecution(row) {
    const ins = await db.from('automation_executions').insert(Object.assign({ created_at: isoNow(clock()) }, row)).select().maybeSingle();
    if (ins.error) { if (ins.error.code === '23505') return null; throw ins.error; }
    return ins.data || row;
  }
  async function finishExecution(id, patch) {
    await db.from('automation_executions').update(Object.assign({ finished_at: isoNow(clock()) }, patch)).eq('id', id);
  }
  async function budgetHistory(userId, platform, campaignId) {
    const since = isoNow(clock() - 30 * 24 * 3600e3);
    const { data } = await db.from('automation_executions').select('action, previous_value, new_value, finished_at, status').eq('user_id', userId).eq('platform', platform).eq('campaign_id', String(campaignId)).eq('status', 'completed').gte('created_at', since);
    return (data || []).filter((e) => (e.action === 'increase_budget' || e.action === 'decrease_budget') && e.previous_value && e.new_value)
      .map((e) => ({ at: e.finished_at, previous: Number(e.previous_value.amount), next: Number(e.new_value.amount) }));
  }

  // ── The one place a campaign is changed ─────────────────────────
  // args: { userId, platform, campaignId, action, percent, limits,
  //         automationId, requireEnabled, allowWhenPausedAll }
  async function executeAction(a) {
    const out = { status: 'failed', reason: null, previous: null, next: null, campaignName: null, accountId: null, error: null, errorKind: null };
    if (killed()) return Object.assign(out, { status: 'skipped', reason: 'kill_switch' });
    const settings = await getSettings(a.userId);
    if (settings.paused_all && !a.allowWhenPausedAll) return Object.assign(out, { status: 'skipped', reason: 'paused_all' });
    if (a.automationId && a.requireEnabled !== false) {
      const { data: row } = await db.from('automation_rules').select('id, enabled, deleted_at, status').eq('id', a.automationId).eq('user_id', a.userId).maybeSingle();
      if (!row || row.deleted_at) return Object.assign(out, { status: 'skipped', reason: 'automation_deleted' });
      if (!row.enabled) return Object.assign(out, { status: 'skipped', reason: 'automation_paused' });
    }
    const adapter = adapters[a.platform];
    if (!adapter) return Object.assign(out, { reason: 'platform_unsupported' });
    const user = { id: a.userId };
    let c;
    try { c = await adapter.getCampaign(user, a.campaignId); }
    catch (err) { const k = P.classifyError(err); return Object.assign(out, { reason: k.kind, error: trunc(k.message, 300), errorKind: k.kind }); }
    if (!c) return Object.assign(out, { reason: 'campaign_not_found' }); // not in this user's connected account
    out.campaignName = c.name; out.accountId = c.accountId || null;
    if (c.status === 'archived') return Object.assign(out, { status: 'skipped', reason: 'campaign_archived' });
    try {
      if (ACTION_TO_STATUS[a.action]) {
        const want = ACTION_TO_STATUS[a.action];
        if (c.status === want) return Object.assign(out, { status: 'skipped', reason: want === 'paused' ? 'already_paused' : 'already_active', previous: { status: c.status }, next: { status: c.status } });
        if (c.status !== 'active' && c.status !== 'paused') return Object.assign(out, { status: 'skipped', reason: 'status_unknown', previous: { status: c.rawStatus } });
        await adapter.setStatus(user, c.id, want);
        return Object.assign(out, { status: 'completed', previous: { status: c.status }, next: { status: want } });
      }
      if (a.action === 'increase_budget' || a.action === 'decrease_budget') {
        if (c.status !== 'active') return Object.assign(out, { status: 'skipped', reason: 'campaign_not_active' });
        if (!c.budget || !c.budget.editable) return Object.assign(out, { status: 'skipped', reason: (c.budget && c.budget.reason) || 'budget_not_editable', previous: c.budget ? { scope: c.budget.scope, amount: c.budget.amount, currency: c.budget.currency, shared: c.budget.shared || null } : null });
        if (!c.budget.currency) return Object.assign(out, { status: 'skipped', reason: 'unknown_currency' });
        const history = await budgetHistory(a.userId, a.platform, c.id);
        const limits = B.normalizeLimits(a.limits || {}, a.action === 'increase_budget' ? 'increase' : 'decrease');
        if (!limits.ok) return Object.assign(out, { status: 'skipped', reason: limits.code || 'invalid_limits' });
        const change = B.computeChange({ direction: a.action === 'increase_budget' ? 'increase' : 'decrease', pct: a.percent, current: c.budget.amount, currency: c.budget.currency, limits: limits.limits, history, now: clock() });
        if (!change.ok) return Object.assign(out, { status: 'skipped', reason: change.reason, previous: { amount: c.budget.amount, currency: c.budget.currency, scope: c.budget.scope } });
        const items = await adapter.setBudget(user, c, change);
        return Object.assign(out, { status: 'completed', previous: { amount: change.previous, currency: c.budget.currency, scope: c.budget.scope }, next: { amount: change.next, currency: c.budget.currency, scope: c.budget.scope, items: items.length > 1 ? items : undefined } });
      }
      return Object.assign(out, { reason: 'unknown_action' });
    } catch (err) {
      const k = P.classifyError(err);
      return Object.assign(out, { status: 'failed', reason: k.kind, error: trunc(k.message, 300) + (err.partial ? ` (${err.partial.changed} of ${err.partial.total} budgets changed, ${err.partial.rolledBack ? 'restored' : 'NOT restored — check the campaign'})` : ''), errorKind: k.kind });
    }
  }

  // Human text for a finished execution (notifications / activity).
  function describe(action, res, campaignName) {
    const name = '"' + (campaignName || res.campaignName || 'campaign') + '"';
    if (res.status === 'completed') {
      if (action === 'increase_budget' || action === 'decrease_budget') return { kind: 'budget_changed', title: `Budget changed for ${name}`, body: `${money(res.previous && res.previous.amount, res.previous && res.previous.currency)} → ${money(res.next && res.next.amount, res.next && res.next.currency)} per day.` };
      if (ACTION_TO_STATUS[action] === 'paused') return { kind: 'paused', title: `${name} paused`, body: 'The campaign was paused.' };
      return { kind: 'resumed', title: `${name} is running`, body: 'The campaign was switched on.' };
    }
    if (res.status === 'failed') return { kind: 'failed', title: `Couldn’t change ${name}`, body: res.error || res.reason || 'The platform refused the change.' };
    return { kind: 'skipped', title: `Skipped for ${name}`, body: res.reason };
  }

  // ── Validation (create + edit) ───────────────────────────────────
  // body: { name, kind, platform, scope, condition{metric,operator,value},
  //         window, min_data, action, mode, percent, limits, schedule,
  //         confirm_automatic }
  async function validate(userId, body, opts) {
    opts = opts || {};
    const b = body || {};
    const errors = [];
    const err = (code, message, field) => { errors.push({ code, message, field }); };
    const kind = b.kind === 'schedule' ? 'schedule' : 'rule';
    const name = String(b.name || '').trim();
    if (!name) err('name', 'Give the automation a name.', 'name');
    if (!P.PLATFORMS.includes(b.platform)) err('platform', 'Choose an advertising platform.', 'platform');
    const scope = b.scope || {};
    const ids = Array.isArray(scope.campaign_ids) ? Array.from(new Set(scope.campaign_ids.map(String))) : [];
    if (scope.type !== 'campaigns' && scope.type !== 'account') err('scope', 'Choose which campaigns this applies to.', 'scope');
    if (scope.type === 'campaigns' && !ids.length) err('scope', 'Select at least one campaign.', 'scope');
    if (ids.length > SHARED.maxCampaignsPerRule) err('scope', `Select at most ${SHARED.maxCampaignsPerRule} campaigns.`, 'scope');
    if (kind === 'schedule' && scope.type !== 'campaigns') err('scope', 'Scheduled actions need specific campaigns.', 'scope');
    const row = { name: name.slice(0, 120), kind, platform: b.platform, updated_at: isoNow(clock()) };
    if (kind === 'rule') {
      const c = b.condition || {};
      if (!M.METRICS[c.metric]) err('metric', 'Choose what to measure.', 'condition');
      else if (b.platform && !M.availableFor(b.platform, c.metric)) err('metric_unavailable', `${M.METRICS[c.metric].label} isn’t reported for ${P.LABEL[b.platform]} campaigns.`, 'condition');
      if (c.metric === 'status') {
        if (c.operator !== '==') err('operator', 'Status can only be compared with "is".', 'condition');
        if (c.value !== 'active' && c.value !== 'paused') err('value', 'Choose Active or Paused.', 'condition');
      } else {
        if (!M.OPERATORS[c.operator]) err('operator', 'Choose a comparison.', 'condition');
        const v = Number(c.value);
        if (c.value === '' || c.value == null || !Number.isFinite(v) || v < 0) err('value', 'Enter a number of zero or more.', 'condition');
      }
      const win = Number(b.window || 7);
      if (!M.DATA_WINDOWS.includes(win)) err('window', 'Choose a data window.', 'window');
      let minData = null;
      if (b.min_data && typeof b.min_data === 'object') {
        minData = {};
        for (const k of ['impressions', 'clicks', 'conversions', 'spend']) {
          if (b.min_data[k] == null || b.min_data[k] === '') continue;
          const v = Number(b.min_data[k]);
          if (!Number.isFinite(v) || v < 0) err('min_data', 'Minimum data must be zero or more.', 'min_data'); else minData[k] = v;
        }
      }
      let action = b.action, mode = b.mode;
      if (!MODES.includes(mode)) err('mode', 'Choose what OrivenAI may do.', 'mode');
      if (mode === 'notify') action = 'notify';
      if (!RULE_ACTIONS.includes(action)) err('action', 'Choose an action.', 'action');
      if (action === 'notify') mode = 'notify';
      if (c.metric === 'status' && ((c.value === 'paused' && action === 'pause_campaign') || (c.value === 'active' && action === 'resume_campaign'))) err('action', 'This action would do nothing for campaigns in that status.', 'action');
      const ap = {};
      if (action === 'increase_budget' || action === 'decrease_budget') {
        const pct = Number(b.percent);
        const lim = B.normalizeLimits(b.limits || {}, action === 'increase_budget' ? 'increase' : 'decrease');
        if (!lim.ok) err(lim.code === 'max_budget_required' ? 'max_budget_required' : 'limits', lim.code === 'max_budget_required' ? 'Set a maximum daily budget. Without one, OrivenAI won’t raise budgets.' : lim.error, 'limits');
        else if (!Number.isFinite(pct) || pct < 1 || pct > lim.limits.max_change_pct) err('percent', `Choose a change between 1% and ${lim.limits.max_change_pct}%.`, 'percent');
        if (lim.ok) ap.limits = lim.limits;
        ap.percent = pct;
      }
      if (mode === 'automatic' && FINANCIAL.includes(action) && b.confirm_automatic !== true) err('confirm_automatic', 'Confirm that OrivenAI may make this change automatically.', 'mode');
      Object.assign(row, {
        trigger_metric: c.metric, trigger_operator: c.metric === 'status' ? '==' : c.operator,
        trigger_value: c.metric === 'status' ? null : Number(c.value), trigger_text: c.metric === 'status' ? c.value : null,
        action_type: action, mode, data_window_days: win, min_data: minData, action_params: ap, schedule: null,
      });
    } else {
      const v = S.validate(b.schedule, { now: clock(), maxItems: SHARED.maxScheduleItems });
      if (!v.ok) err(v.code || 'schedule', v.error, 'schedule');
      else row.schedule = v.schedule;
      Object.assign(row, { action_type: 'schedule', mode: 'scheduled', trigger_metric: null, trigger_operator: null, trigger_value: null, trigger_text: null, action_params: {} });
    }
    if (errors.length) return { ok: false, errors };
    // Ownership: the campaigns must exist in the user's connected account,
    // read live (never trust ids from the browser).
    let campaigns = [];
    try {
      const list = await adapters[b.platform].listCampaigns({ id: userId }, null);
      const by = {}; (list.campaigns || []).forEach((x) => { by[x.id] = x; });
      if (scope.type === 'campaigns') {
        for (const id of ids) {
          const x = by[id];
          if (!x) { err('campaign_not_found', 'One of the selected campaigns isn’t in your connected account.', 'scope'); break; }
          if (x.status === 'archived') { err('campaign_archived', `"${x.name}" is archived.`, 'scope'); break; }
          campaigns.push({ id: x.id, name: x.name });
        }
        if (kind === 'rule' && (row.action_type === 'increase_budget' || row.action_type === 'decrease_budget')) {
          const editable = ids.map((id) => by[id]).filter((x) => x && x.budget && x.budget.editable);
          if (!editable.length) err('budget_not_editable', 'None of the selected campaigns has a daily budget OrivenAI can change (shared or lifetime budgets are left alone).', 'scope');
        }
      }
      row.currency = (list.account && list.account.currency) || null;
    } catch (e) {
      const k = P.classifyError(e);
      err(k.kind === 'auth' || k.kind === 'not_connected' ? 'not_connected' : 'platform_unavailable', k.kind === 'auth' || k.kind === 'not_connected' ? `Connect ${P.LABEL[b.platform]} first (or reconnect it).` : `${P.LABEL[b.platform]} didn’t respond. Try again in a moment.`, 'platform');
    }
    if (errors.length) return { ok: false, errors };
    row.scope = scope.type === 'campaigns' ? { type: 'campaigns', campaign_ids: ids, campaigns } : { type: 'account' };
    return { ok: true, row };
  }

  // ── Rules: evaluation ────────────────────────────────────────────
  function eligible(rule, c) {
    if (c.status === 'archived' || c.status === 'other') return 'campaign_not_eligible';
    if (rule.mode === 'notify') return null;
    if (rule.action === 'pause_campaign' && c.status !== 'active') return 'not_running';
    if (rule.action === 'resume_campaign' && c.status !== 'paused') return 'not_paused';
    if ((rule.action === 'increase_budget' || rule.action === 'decrease_budget')) {
      if (c.status !== 'active') return 'not_running';
      if (!c.budget || !c.budget.editable) return (c.budget && c.budget.reason) || 'budget_not_editable';
    }
    return null;
  }

  // Deterministic conflict resolution for one campaign in one run:
  // pause beats everything; pause+resume or increase+decrease cancel each
  // other (both skipped); notify-only rules never conflict.
  function resolveConflicts(cands) {
    const keep = [], skip = [];
    const by = {};
    cands.forEach((c) => { const k = c.platform + ':' + c.campaign.id; (by[k] = by[k] || []).push(c); });
    Object.values(by).forEach((list) => {
      const fin = list.filter((c) => c.rule.mode !== 'notify');
      list.filter((c) => c.rule.mode === 'notify').forEach((c) => keep.push(c));
      if (fin.length <= 1) { fin.forEach((c) => keep.push(c)); return; }
      const has = (a) => fin.some((c) => c.rule.action === a);
      if (has('pause_campaign') && has('resume_campaign')) { fin.forEach((c) => skip.push(Object.assign(c, { reason: 'conflict' }))); return; }
      if (has('pause_campaign')) {
        let kept = false;
        fin.forEach((c) => {
          if (c.rule.action === 'pause_campaign' && !kept) { keep.push(c); kept = true; }
          else skip.push(Object.assign(c, { reason: c.rule.action === 'pause_campaign' ? 'duplicate_rule' : 'superseded_by_pause' }));
        });
        return;
      }
      if (has('increase_budget') && has('decrease_budget')) { fin.filter((c) => /budget/.test(c.rule.action)).forEach((c) => skip.push(Object.assign(c, { reason: 'conflict' }))); fin.filter((c) => !/budget/.test(c.rule.action)).forEach((c) => keep.push(c)); return; }
      // Several rules wanting the same kind of change → the first (oldest) rule wins.
      const seen = new Set();
      fin.sort((a, b) => String(a.rule.createdAt).localeCompare(String(b.rule.createdAt))).forEach((c) => {
        const t = /budget/.test(c.rule.action) ? 'budget' : c.rule.action;
        if (seen.has(t)) skip.push(Object.assign(c, { reason: 'duplicate_rule' })); else { seen.add(t); keep.push(c); }
      });
    });
    return { keep, skip };
  }

  function bucketFor(rule, now) {
    const h = (rule.action === 'increase_budget' || rule.action === 'decrease_budget') && rule.limits && Number(rule.limits.min_hours_between) > 0 ? Number(rule.limits.min_hours_between) : SHARED.defaultCooldownHours;
    return Math.floor(now / (h * 3600e3));
  }

  async function handleCandidate(userId, cand, now) {
    const { rule, campaign, observed } = cand;
    const trigger = { metric: rule.condition.metric, operator: rule.condition.operator, threshold: rule.condition.value, observed, window_days: rule.window };
    const base = { user_id: userId, automation_id: rule.id, automation_name: rule.name, source: 'rule', platform: rule.platform, account_id: cand.accountId || null, campaign_id: campaign.id, campaign_name: campaign.name, mode: rule.mode, trigger };
    const bucket = bucketFor(rule, now);
    if (rule.mode === 'notify') {
      const ex = await claimExecution(Object.assign({}, base, { action: 'notify', status: 'completed', finished_at: isoNow(now), idempotency_key: `rule:${rule.id}:${campaign.id}:notify:${bucket}` }));
      if (!ex) return 'duplicate';
      await notifier.add(userId, { kind: 'executed', automationId: rule.id, automationName: rule.name, executionId: ex.id, platform: rule.platform, campaignName: campaign.name, dedupeKey: 'exec:' + ex.id,
        title: `Condition met for "${campaign.name}"`, body: `${M.METRICS[trigger.metric] ? M.METRICS[trigger.metric].label : trigger.metric} is ${typeof observed === 'number' ? B.round(observed, 'EUR') : observed} (rule: ${trigger.operator} ${trigger.threshold}, last ${rule.window} days).` });
      return 'notified';
    }
    if (rule.mode === 'approval') {
      const { data: open } = await db.from('automation_approvals').select('id').eq('user_id', userId).eq('automation_id', rule.id).eq('campaign_id', campaign.id).eq('status', 'pending').limit(1);
      if (open && open.length) return 'already_pending';
      const ex = await claimExecution(Object.assign({}, base, { action: rule.action, status: 'pending_approval', idempotency_key: `rule:${rule.id}:${campaign.id}:approval:${bucket}` }));
      if (!ex) return 'duplicate';
      const ap = await db.from('automation_approvals').insert({ user_id: userId, automation_id: rule.id, execution_id: ex.id, platform: rule.platform, account_id: cand.accountId || null, campaign_id: campaign.id, campaign_name: campaign.name, action: rule.action,
        params: { percent: rule.percent }, observed: trigger, status: 'pending', expires_at: isoNow(now + SHARED.approvalHours * 3600e3), created_at: isoNow(now) }).select().maybeSingle();
      if (ap.error) throw ap.error;
      await db.from('automation_executions').update({ approval_id: ap.data && ap.data.id }).eq('id', ex.id);
      await notifier.add(userId, { kind: 'approval', automationId: rule.id, automationName: rule.name, executionId: ex.id, platform: rule.platform, campaignName: campaign.name, dedupeKey: 'approval:' + (ap.data && ap.data.id),
        title: `Approval needed for "${campaign.name}"`, body: summarize(rule) });
      return 'approval_requested';
    }
    const ex = await claimExecution(Object.assign({}, base, { action: rule.action, status: 'running', idempotency_key: `rule:${rule.id}:${campaign.id}:${rule.action}:${bucket}` }));
    if (!ex) return 'duplicate';
    const res = await executeAction({ userId, platform: rule.platform, campaignId: campaign.id, action: rule.action, percent: rule.percent, limits: rule.limits, automationId: rule.id });
    await finishExecution(ex.id, { status: res.status, reason: res.reason, error: res.error, previous_value: res.previous, new_value: res.next, campaign_name: res.campaignName || campaign.name, account_id: res.accountId || cand.accountId || null });
    if (res.status !== 'skipped' || /^(budget_not_editable|shared_budget|lifetime_budget|unknown_currency|max_budget_required|no_max_budget)$/.test(res.reason || '')) {
      const d = describe(rule.action, res, campaign.name);
      await notifier.add(userId, Object.assign({ automationId: rule.id, automationName: rule.name, executionId: ex.id, platform: rule.platform, campaignName: campaign.name, dedupeKey: 'exec:' + ex.id }, d));
    }
    return res.status;
  }

  async function evaluateUser(userId, rules, now) {
    const results = {};
    const byPlatform = {};
    rules.forEach((r) => { (byPlatform[r.platform] = byPlatform[r.platform] || []).push(r); });
    const cands = [];
    for (const platform of Object.keys(byPlatform)) {
      const list = byPlatform[platform];
      const adapter = adapters[platform];
      const windows = Array.from(new Set(list.map((r) => r.window)));
      const data = {};
      let failure = null;
      for (const w of windows) {
        try { data[w] = await adapter.listCampaigns({ id: userId }, w); }
        catch (err) { failure = P.classifyError(err); break; }
      }
      if (failure) {
        list.forEach((r) => { results[r.id] = { status: 'blocked', reason: failure.kind, at: isoNow(now) }; });
        if (failure.kind === 'auth' || failure.kind === 'not_connected') {
          await notifier.add(userId, { kind: failure.kind === 'auth' ? 'credentials_expired' : 'disconnected', platform, dedupeKey: `conn:${platform}:${failure.kind}:${isoNow(now).slice(0, 10)}`, severity: 'high',
            title: failure.kind === 'auth' ? `${P.LABEL[platform]} needs to be reconnected` : `${P.LABEL[platform]} isn’t connected`, body: `Your automations for ${P.LABEL[platform]} are on hold until the account is connected again.` });
        }
        continue;
      }
      for (const r of list) {
        const res = { status: 'checked', at: isoNow(now), checked: 0, matched: 0, skipped: {} };
        const d = data[r.window];
        const pool = (d.campaigns || []).filter((c) => r.scope.type === 'account' || (r.scope.campaign_ids || []).includes(c.id));
        if (r.scope.type === 'campaigns') (r.scope.campaign_ids || []).forEach((id) => { if (!pool.some((c) => c.id === id)) res.skipped.campaign_not_found = (res.skipped.campaign_not_found || 0) + 1; });
        for (const c of pool) {
          const why = eligible(r, c);
          if (why) { if (why !== 'campaign_not_eligible') res.skipped[why] = (res.skipped[why] || 0) + 1; continue; }
          res.checked++;
          if (r.condition.metric !== 'status' && !c.metrics) { res.skipped.no_data = (res.skipped.no_data || 0) + 1; continue; }
          const mv = M.metricValue(c, r.condition.metric, r.minData, platform);
          if (!mv.ok) { res.skipped[mv.reason] = (res.skipped[mv.reason] || 0) + 1; continue; }
          if (!M.compare(mv.value, r.condition.operator, r.condition.value)) continue;
          res.matched++;
          cands.push({ rule: r, campaign: c, observed: mv.value, platform, accountId: d.account && d.account.id });
        }
        results[r.id] = res;
      }
    }
    const { keep, skip } = resolveConflicts(cands);
    for (const c of skip) {
      const ex = await claimExecution({ user_id: userId, automation_id: c.rule.id, automation_name: c.rule.name, source: 'rule', platform: c.platform, account_id: c.accountId || null, campaign_id: c.campaign.id, campaign_name: c.campaign.name, mode: c.rule.mode, action: c.rule.action, status: 'skipped', reason: c.reason, finished_at: isoNow(now),
        trigger: { metric: c.rule.condition.metric, operator: c.rule.condition.operator, threshold: c.rule.condition.value, observed: c.observed, window_days: c.rule.window }, idempotency_key: `rule:${c.rule.id}:${c.campaign.id}:skip:${bucketFor(c.rule, now)}` });
      if (ex && c.reason === 'conflict') await notifier.add(userId, { kind: 'conflict', automationId: c.rule.id, automationName: c.rule.name, executionId: ex.id, platform: c.platform, campaignName: c.campaign.name, dedupeKey: `conflict:${c.platform}:${c.campaign.id}:${isoNow(now).slice(0, 10)}`,
        title: `Conflicting automations for "${c.campaign.name}"`, body: 'Two automations wanted opposite changes at the same time, so neither was applied.' });
    }
    for (const c of keep) {
      try { await handleCandidate(userId, c, now); }
      catch (err) { log('[Automations] candidate failed: ' + err.message); }
    }
    for (const r of rules) {
      await db.from('automation_rules').update({ last_evaluated_at: isoNow(now), last_result: results[r.id] || null }).eq('id', r.id);
    }
    return results;
  }

  async function runRules(opts) {
    const now = (opts && opts.now) || clock();
    if (killed()) return { skipped: 'kill_switch' };
    const { data: rows, error } = await db.from('automation_rules').select('*').eq('enabled', true).limit(5000);
    if (error) throw error;
    const byUser = {};
    (rows || []).forEach((row) => {
      const r = normalizeRule(row);
      if (!r.enabled || r.kind !== 'rule' || r.blocked || r.status !== 'active') return;
      (byUser[row.user_id] = byUser[row.user_id] || []).push(r);
    });
    const summary = { users: 0, evaluated: 0 };
    for (const userId of Object.keys(byUser)) {
      summary.users++;
      try {
        const plan = await deps.planOf(userId);
        const lim = forPlan(plan);
        if (!lim.evalMinutes) continue; // plan without Automations
        const settings = await getSettings(userId);
        if (settings.paused_all) continue;
        if (settings.rules_eval_at && now - new Date(settings.rules_eval_at).getTime() < lim.evalMinutes * 60e3 && !(opts && opts.force)) continue;
        // Lease: one instance evaluates a user at a time.
        await saveSettings(userId, {});
        const leaseIso = isoNow(now);
        const { data: leased } = await db.from('automation_settings').update({ eval_lease_until: isoNow(now + 10 * 60e3), eval_lease_by: worker })
          .eq('user_id', userId).or(`eval_lease_until.is.null,eval_lease_until.lt.${leaseIso}`).select('user_id');
        if (!leased || !leased.length) continue;
        await evaluateUser(userId, byUser[userId], now);
        summary.evaluated++;
        await db.from('automation_settings').update({ rules_eval_at: isoNow(now), eval_lease_until: null, eval_lease_by: null }).eq('user_id', userId);
      } catch (err) { log('[Automations] rules for user failed: ' + err.message); }
    }
    await notifier.flush();
    return summary;
  }

  // ── Approvals ────────────────────────────────────────────────────
  async function expireApprovals(now) {
    const { data } = await db.from('automation_approvals').select('id, execution_id').eq('status', 'pending').lt('expires_at', isoNow(now)).limit(200);
    for (const a of data || []) {
      const { data: done } = await db.from('automation_approvals').update({ status: 'expired', decided_at: isoNow(now) }).eq('id', a.id).eq('status', 'pending').select('id');
      if (done && done.length && a.execution_id) await finishExecution(a.execution_id, { status: 'cancelled', reason: 'expired' });
    }
  }
  async function decide(userId, approvalId, approve) {
    const now = clock();
    const { data: a } = await db.from('automation_approvals').select('*').eq('id', approvalId).eq('user_id', userId).maybeSingle();
    if (!a) return { http: 404, error: 'This approval doesn’t exist.' };
    if (a.status !== 'pending') return { http: 409, code: 'already_' + a.status, error: `This approval was already ${a.status}.` };
    if (new Date(a.expires_at).getTime() < now) {
      await db.from('automation_approvals').update({ status: 'expired', decided_at: isoNow(now) }).eq('id', a.id).eq('status', 'pending');
      if (a.execution_id) await finishExecution(a.execution_id, { status: 'cancelled', reason: 'expired' });
      return { http: 410, code: 'expired', error: 'This approval has expired, so nothing was changed.' };
    }
    if (!approve) {
      const { data: done } = await db.from('automation_approvals').update({ status: 'rejected', decided_at: isoNow(now) }).eq('id', a.id).eq('status', 'pending').select('id');
      if (!done || !done.length) return { http: 409, error: 'This approval was already handled.' };
      if (a.execution_id) await finishExecution(a.execution_id, { status: 'cancelled', reason: 'rejected' });
      return { http: 200, status: 'rejected' };
    }
    if (killed()) return { http: 503, code: 'kill_switch', error: 'Automations are temporarily switched off by OrivenAI. Nothing was changed.' };
    // Exactly-once: only the caller that moves pending → executing proceeds.
    const { data: claimed } = await db.from('automation_approvals').update({ status: 'executing', decided_at: isoNow(now) }).eq('id', a.id).eq('status', 'pending').select('id');
    if (!claimed || !claimed.length) return { http: 409, error: 'This approval was already handled.' };
    const { data: ruleRow } = await db.from('automation_rules').select('*').eq('id', a.automation_id).eq('user_id', userId).maybeSingle();
    if (!ruleRow || ruleRow.deleted_at) {
      await db.from('automation_approvals').update({ status: 'failed', error: 'automation_deleted' }).eq('id', a.id);
      if (a.execution_id) await finishExecution(a.execution_id, { status: 'cancelled', reason: 'automation_deleted' });
      return { http: 409, code: 'automation_deleted', error: 'The automation was deleted, so nothing was changed.' };
    }
    const rule = normalizeRule(ruleRow);
    // Fresh state, fresh budget, current limits — the stored proposal is never trusted.
    const res = await executeAction({ userId, platform: a.platform, campaignId: a.campaign_id, action: a.action, percent: (a.params && a.params.percent) || rule.percent, limits: rule.limits, automationId: rule.id, requireEnabled: false, allowWhenPausedAll: true });
    await db.from('automation_approvals').update({ status: res.status === 'completed' ? 'completed' : (res.status === 'skipped' ? 'completed' : 'failed'), error: res.status === 'completed' ? null : (res.error || res.reason) }).eq('id', a.id);
    if (a.execution_id) await finishExecution(a.execution_id, { status: res.status, reason: res.reason, error: res.error, previous_value: res.previous, new_value: res.next, mode: 'approval' });
    const d = describe(a.action, res, a.campaign_name);
    await notifier.add(userId, Object.assign({ automationId: rule.id, automationName: rule.name, executionId: a.execution_id, platform: a.platform, campaignName: a.campaign_name, dedupeKey: 'approved:' + a.id }, d));
    await notifier.flush();
    return { http: res.status === 'failed' ? 502 : 200, status: res.status, reason: res.reason, error: res.status === 'failed' ? (res.error || 'The platform refused the change.') : undefined, previous: res.previous, next: res.next };
  }

  // ── Scheduler ────────────────────────────────────────────────────
  async function materialize(row, fromMs) {
    const r = normalizeRule(row);
    if (r.kind !== 'schedule' || !r.schedule || !r.enabled) return 0;
    let n = 0;
    for (const it of r.schedule.items) {
      for (const c of r.scope.campaigns || []) {
        // The same occurrence may already have a row (same idempotency key):
        // re-planned after a pause/edit → reactivate it; cancelled by the
        // user, or already run → move on to the following occurrence.
        let after = fromMs;
        for (let tries = 0; tries < 4; tries++) {
          const occ = S.nextOccurrence(it, r.schedule, after);
          if (!occ) break;
          const key = `sched:${r.id}:${it.key}:${occ.localKey}:${c.id}`;
          const ins = await db.from('automation_jobs').insert({ user_id: r.userId, automation_id: r.id, item_key: it.key, action: it.action, platform: r.platform, campaign_id: c.id, campaign_name: c.name,
            run_at: isoNow(occ.runAt), local_time: occ.localKey, timezone: r.schedule.timezone, status: 'scheduled', attempts: 0, idempotency_key: key, created_at: isoNow(clock()), updated_at: isoNow(clock()) });
          if (!ins.error) { n++; break; }
          if (ins.error.code !== '23505') throw ins.error;
          const { data: ex } = await db.from('automation_jobs').select('id, status, error').eq('idempotency_key', key).maybeSingle();
          if (ex && ex.status === 'scheduled') break;
          if (ex && ex.status === 'cancelled' && (ex.error === 'paused' || ex.error === 'rescheduled')) {
            await db.from('automation_jobs').update({ status: 'scheduled', error: null, attempts: 0, next_attempt_at: null, locked_by: null, run_at: isoNow(occ.runAt), action: it.action, campaign_name: c.name, updated_at: isoNow(clock()) }).eq('id', ex.id).eq('status', 'cancelled');
            n++; break;
          }
          after = occ.runAt; // that occurrence is done or was cancelled on purpose
        }
      }
    }
    return n;
  }
  async function cancelPending(automationId, reason) {
    await db.from('automation_jobs').update({ status: 'cancelled', error: reason || 'cancelled', updated_at: isoNow(clock()) }).eq('automation_id', automationId).eq('status', 'scheduled');
  }

  async function processJob(job, now) {
    const lim = SHARED;
    const execKey = job.idempotency_key;
    const finalize = async (status, patch, res) => {
      await db.from('automation_jobs').update(Object.assign({ status, updated_at: isoNow(clock()), locked_by: null }, patch || {})).eq('id', job.id);
      const exRow = { status, reason: (res && res.reason) || (patch && patch.error) || null, error: (res && res.error) || null, previous_value: res ? res.previous : null, new_value: res ? res.next : null, campaign_name: (res && res.campaignName) || job.campaign_name, account_id: (res && res.accountId) || null };
      const ins = await claimExecution(Object.assign({ user_id: job.user_id, automation_id: job.automation_id, automation_name: job._name || null, source: 'schedule', job_id: job.id, platform: job.platform, campaign_id: job.campaign_id, mode: 'scheduled', action: job.action, trigger: { scheduled_for: job.local_time, timezone: job.timezone }, idempotency_key: 'job:' + execKey, finished_at: isoNow(clock()) }, exRow));
      if (!ins) { const { data: ex } = await db.from('automation_executions').select('id').eq('idempotency_key', 'job:' + execKey).maybeSingle(); if (ex) await finishExecution(ex.id, exRow); return ex && ex.id; }
      return ins.id;
    };
    const { data: row } = await db.from('automation_rules').select('*').eq('id', job.automation_id).eq('user_id', job.user_id).maybeSingle();
    const r = row && normalizeRule(row);
    job._name = r && r.name;
    if (!r || r.deleted || r.kind !== 'schedule') { await finalize('cancelled', { error: 'automation_deleted' }, { reason: 'automation_deleted' }); return 'cancelled'; }
    const next = async () => {
      const it = (r.schedule.items || []).find((i) => i.key === job.item_key);
      if (it && it.type === 'weekly' && r.enabled) await materialize(row, Math.max(now, new Date(job.run_at).getTime()) + 1000);
    };
    const settings = await getSettings(job.user_id);
    if (!r.enabled || settings.paused_all) { await finalize('skipped', { error: !r.enabled ? 'automation_paused' : 'paused_all' }, { reason: !r.enabled ? 'automation_paused' : 'paused_all' }); await next(); return 'skipped'; }
    if (now - new Date(job.run_at).getTime() > lim.missedGraceMinutes * 60e3) {
      const exId = await finalize('skipped', { error: 'missed' }, { reason: 'missed' });
      await notifier.add(job.user_id, { kind: 'missed', automationId: r.id, automationName: r.name, executionId: exId, platform: job.platform, campaignName: job.campaign_name, dedupeKey: 'missed:' + job.id,
        title: `Scheduled action missed for "${job.campaign_name}"`, body: `It was due at ${job.local_time} (${job.timezone}) but OrivenAI couldn’t run it in time, so it was not run late.` });
      await next();
      return 'missed';
    }
    const res = await executeAction({ userId: job.user_id, platform: job.platform, campaignId: job.campaign_id, action: job.action, automationId: r.id });
    const transient = res.status === 'failed' && (res.errorKind === 'transient' || res.errorKind === 'rate_limited');
    if (transient && job.attempts < lim.maxRetries) {
      const wait = lim.retryBackoffMinutes[Math.min(job.attempts - 1, lim.retryBackoffMinutes.length - 1)] * 60e3;
      await db.from('automation_jobs').update({ status: 'scheduled', next_attempt_at: isoNow(now + wait), error: res.error, locked_by: null, updated_at: isoNow(clock()) }).eq('id', job.id);
      return 'retry';
    }
    const exId = await finalize(res.status, { result: { previous: res.previous, next: res.next }, error: res.error || res.reason }, res);
    if (res.status === 'completed' || res.status === 'failed') {
      const d = res.status === 'completed' ? { kind: 'scheduled_completed', title: `Scheduled: "${res.campaignName || job.campaign_name}" ${ACTION_TO_STATUS[job.action] === 'paused' ? 'paused' : 'switched on'}`, body: `As scheduled for ${job.local_time} (${job.timezone}).` } : describe(job.action, res, job.campaign_name);
      await notifier.add(job.user_id, Object.assign({ automationId: r.id, automationName: r.name, executionId: exId, platform: job.platform, campaignName: job.campaign_name, dedupeKey: 'job:' + job.id }, d));
    }
    if (job.action === 'stop' && res.status !== 'failed') {
      await cancelPending(r.id, 'stopped');
      await db.from('automation_rules').update({ status: 'completed', enabled: false, updated_at: isoNow(clock()) }).eq('id', r.id);
      return res.status;
    }
    await next();
    // A schedule with only one-time actions is complete once none are left.
    const { data: left } = await db.from('automation_jobs').select('id').eq('automation_id', r.id).eq('status', 'scheduled').limit(1);
    if ((!left || !left.length) && !(r.schedule.items || []).some((i) => i.type === 'weekly')) await db.from('automation_rules').update({ status: 'completed', updated_at: isoNow(clock()) }).eq('id', r.id);
    return res.status;
  }

  async function runDueJobs(opts) {
    const now = (opts && opts.now) || clock();
    if (killed()) return { skipped: 'kill_switch' };
    await expireApprovals(now);
    // A job left 'running' by a crashed instance goes back to the queue: every
    // scheduled action re-reads the campaign first, so re-running it is safe.
    const stale = isoNow(now - 10 * 60e3);
    const { data: stuck } = await db.from('automation_jobs').select('id').eq('status', 'running').lt('locked_at', stale).limit(50);
    for (const s of stuck || []) await db.from('automation_jobs').update({ status: 'scheduled', locked_by: null, updated_at: isoNow(now) }).eq('id', s.id).eq('status', 'running');
    const { data: due } = await db.from('automation_jobs').select('*').eq('status', 'scheduled').lte('run_at', isoNow(now)).order('run_at', { ascending: true }).limit(50);
    const out = { claimed: 0, results: {} };
    for (const j of due || []) {
      if (j.next_attempt_at && new Date(j.next_attempt_at).getTime() > now) continue;
      const { data: got } = await db.from('automation_jobs').update({ status: 'running', locked_by: worker, locked_at: isoNow(now), attempts: (j.attempts || 0) + 1, updated_at: isoNow(now) }).eq('id', j.id).eq('status', 'scheduled').select();
      if (!got || !got.length) continue; // another instance took it
      out.claimed++;
      try { const st = await processJob(Object.assign({}, j, got[0]), now); out.results[st] = (out.results[st] || 0) + 1; }
      catch (err) {
        log('[Automations] job failed: ' + err.message);
        await db.from('automation_jobs').update({ status: 'failed', error: trunc(P.classifyError(err).message, 300), locked_by: null }).eq('id', j.id);
      }
    }
    await notifier.flush();
    await notifier.retryFailed().catch(() => {});
    return out;
  }

  return { normalizeRule, summarize, validate, executeAction, evaluateUser, runRules, runDueJobs, decide, expireApprovals, materialize, cancelPending, getSettings, saveSettings, resolveConflicts, _worker: worker };
}

module.exports = { createEngine, normalizeRule, summarize, RULE_ACTIONS, FINANCIAL, MODES };
