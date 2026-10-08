// ── Onboarding: eligibility, completion, first value, activation events ──
//
// Server-side source of truth for the welcome experience (frontend
// js/onboarding.js). Nothing here touches credits or subscriptions.
//
// Eligibility: an account sees the welcome screen when
//   1. it was created on or after ONBOARDING_V2_SINCE, and
//   2. profiles.onboarding_completed is not true.
// Accounts created before the rollout never see it, whatever their
// onboarding_completed value: several historical accounts still have
// onboarding_completed=false from the old plan-step flow, and they must not
// be interrupted. No existing row is rewritten to achieve this.
//
// Completion: choosing a goal or skipping sets onboarding_completed=true
// (and primary_goal for a choice). First value — the first successful
// Create or Research result — is tracked separately in first_value_at /
// first_value_kind, written once with a conditional update.
//
// Activation events go to the `events` table (docs/migrations/
// 2026-10-onboarding-activation.sql) through the service role only. Client
// events are allowlisted and their properties reduced to short tokens, so a
// prompt, business detail, token or payment detail can never be stored.
// Every write tolerates the migration not being applied yet.

const DEFAULT_SINCE = '2026-10-08T00:00:00Z';

// Goals offered by the welcome screen, and how they are stored in
// profiles.primary_goal (which already uses the sidebar page ids; Explore
// lands in Control Center, the 'business' goal).
const WELCOME_GOALS = { create: 'create', research: 'research', explore: 'business' };
// Values the older goal step stored; still accepted by PUT /api/onboarding/goal.
const LEGACY_GOALS = ['create', 'research', 'launch', 'campaigns', 'autopilot', 'business'];

const CLIENT_EVENTS = new Set([
  'visited_site', 'created_account', 'started_generation', 'completed_generation',
  'onboarding_shown', 'onboarding_goal_selected', 'onboarding_dismissed',
  'create_started', 'research_started',
  'paywall_shown', 'plan_selected', 'checkout_started', 'checkout_completed', 'checkout_canceled',
  'draft_restored', 'next_step_clicked',
]);
// Events that may be sent before sign-in.
const ANONYMOUS_EVENTS = new Set(['visited_site']);
const PROP_KEYS = new Set(['goal', 'action', 'plan', 'source', 'reason', 'kind', 'required', 'balance', 'target']);

let _db = null;
function init({ db }) { _db = db; }

function since() {
  const raw = process.env.ONBOARDING_V2_SINCE;
  const t = raw ? Date.parse(raw) : NaN;
  return new Date(Number.isFinite(t) ? t : Date.parse(DEFAULT_SINCE));
}

// Pure: what the welcome screen should do for this profile row.
function eligibility(profile, now) {
  if (!profile) return { eligible: false, reason: 'no_profile', newAccount: false };
  const created = profile.created_at ? Date.parse(profile.created_at) : NaN;
  const newAccount = Number.isFinite(created) && created >= since().getTime();
  if (profile.onboarding_completed === true) return { eligible: false, reason: 'completed', newAccount };
  if (!newAccount) return { eligible: false, reason: 'existing_account', newAccount };
  return { eligible: true, reason: 'new_account', newAccount };
}

const _isMissingColumn = (err, col) => !!err && (err.code === '42703' || err.code === 'PGRST204' || new RegExp(col).test(err.message || ''));

// authCreatedAt: the auth user's own creation time, used when the profile
// row doesn't exist yet (created by the app on first load).
async function getState(userId, authCreatedAt) {
  let { data, error } = await _db.from('profiles')
    .select('created_at, onboarding_completed, primary_goal, subscription_status, first_value_at, first_value_kind')
    .eq('id', userId).maybeSingle();
  if (error && _isMissingColumn(error, 'first_value')) {
    ({ data, error } = await _db.from('profiles')
      .select('created_at, onboarding_completed, primary_goal, subscription_status')
      .eq('id', userId).maybeSingle());
  }
  if (error) throw error;
  const e = eligibility(data || (authCreatedAt ? { created_at: authCreatedAt, onboarding_completed: null } : null));
  return {
    eligible: e.eligible,
    reason: e.reason,
    newAccount: e.newAccount,
    completed: !!(data && data.onboarding_completed === true),
    goal: (data && data.primary_goal) || null,
    plan: (data && data.subscription_status) || 'free',
    firstValueAt: (data && data.first_value_at) || null,
    firstValueKind: (data && data.first_value_kind) || null,
  };
}

// Marks onboarding complete. goal: a WELCOME_GOALS key, or null when skipped.
// Idempotent: a repeat call only rewrites the same values.
async function complete(userId, goal) {
  const patch = { onboarding_completed: true };
  if (goal && WELCOME_GOALS[goal]) patch.primary_goal = WELCOME_GOALS[goal];
  let { data, error } = await _db.from('profiles')
    .update(Object.assign({ onboarding_completed_at: new Date().toISOString() }, patch))
    .eq('id', userId).select('onboarding_completed, primary_goal, subscription_status').maybeSingle();
  if (error && _isMissingColumn(error, 'onboarding_completed_at')) {
    ({ data, error } = await _db.from('profiles').update(patch)
      .eq('id', userId).select('onboarding_completed, primary_goal, subscription_status').maybeSingle());
  }
  if (error && patch.primary_goal && _isMissingColumn(error, 'primary_goal')) {
    delete patch.primary_goal;
    ({ data, error } = await _db.from('profiles').update(patch)
      .eq('id', userId).select('onboarding_completed, subscription_status').maybeSingle());
  }
  if (error) throw error;
  return {
    onboarding_completed: true,
    primary_goal: (data && data.primary_goal) || null,
    subscription_status: (data && data.subscription_status) || null,
  };
}

function _sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(props)) {
    if (!PROP_KEYS.has(k) || n >= 8) continue;
    const v = props[k];
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = Math.round(v); n++; }
    else if (typeof v === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(v)) { out[k] = v.toLowerCase(); n++; }
    else if (typeof v === 'boolean') { out[k] = v; n++; }
  }
  return n ? out : null;
}

let _warnedNoTable = false;
function _sessionId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null; }

// Never throws: analytics must not break the request that triggered it.
async function recordEvent({ name, userId, sessionId, props }) {
  try {
    const { error } = await _db.from('events').insert({
      event_name: name, user_id: userId || null, session_id: _sessionId(sessionId), props: _sanitizeProps(props),
    });
    if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
      if (!_warnedNoTable) { _warnedNoTable = true; console.warn('[Activation] events table missing — run docs/migrations/2026-10-onboarding-activation.sql'); }
    } else if (error && _isMissingColumn(error, 'props')) {
      await _db.from('events').insert({ event_name: name, user_id: userId || null, session_id: _sessionId(sessionId) });
    } else if (error) {
      console.warn('[Activation] event not stored:', name, error.code || error.message);
    }
  } catch (err) {
    console.warn('[Activation] event not stored:', name, err.message);
  }
}

// Validates a client-sent event. Returns the row fields or { error }.
function acceptClientEvent(body, userId) {
  const name = body && body.event;
  if (typeof name !== 'string' || !CLIENT_EVENTS.has(name)) return { error: 'unknown_event' };
  if (!userId && !ANONYMOUS_EVENTS.has(name)) return { error: 'auth_required' };
  return { name, userId: userId || null, sessionId: body.sessionId, props: body.props };
}

// Links this browser session's anonymous events to the account that just
// signed in. Only recent, still-anonymous rows of anonymous-allowed events.
async function linkSession(userId, sessionId) {
  const sid = _sessionId(sessionId);
  if (!userId || !sid) return;
  try {
    await _db.from('events').update({ user_id: userId })
      .eq('session_id', sid).is('user_id', null)
      .in('event_name', Array.from(ANONYMOUS_EVENTS))
      .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  } catch (err) {
    console.warn('[Activation] session link failed:', err.message);
  }
}

// First successful Create/Research result. Conditional update: only the
// first call per account writes, so retries and parallel results are safe.
// Fire-and-forget from the routes; never throws.
async function recordFirstValue(userId, kind) {
  if (!userId || (kind !== 'create' && kind !== 'research')) return false;
  try {
    const { data, error } = await _db.from('profiles')
      .update({ first_value_at: new Date().toISOString(), first_value_kind: kind })
      .eq('id', userId).is('first_value_at', null).select('id');
    if (error) {
      if (!_isMissingColumn(error, 'first_value')) console.warn('[Activation] first value not stored:', error.code || error.message);
      return false;
    }
    if (Array.isArray(data) && data.length) {
      await recordEvent({ name: 'first_' + kind + '_success', userId });
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[Activation] first value not stored:', err.message);
    return false;
  }
}

// Fixed-window limiter for the public events endpoint (per process).
const _hits = new Map();
function allowEvent(key, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const h = _hits.get(key);
  if (!h || now - h.at > windowMs) { _hits.set(key, { at: now, n: 1 }); return true; }
  if (_hits.size > 5000) _hits.clear();
  h.n++;
  return h.n <= limit;
}

module.exports = {
  init, since, eligibility, getState, complete, recordEvent, acceptClientEvent, linkSession,
  recordFirstValue, allowEvent, WELCOME_GOALS, LEGACY_GOALS, CLIENT_EVENTS, _sanitizeProps,
};
