// ── Paid actions: one transaction pattern for every credit charge ──
//
// The rule: NO usable final result = NO permanent credit charge.
//
// How it works (one mechanism for every route — routes don't hand-roll
// refunds):
//
//  1. claim — expensive routes are mounted behind laneGuard(lane). Before
//     the handler runs it resolves the user and claims the action:
//       • idempotency: one X-Idempotency-Key = one billable action. The
//         same key again (double click, browser/network retry, frontend
//         bug) gets 409 — no second charge, no second provider call.
//       • lane lock: at most ONE in-flight action per user per lane for
//         'create-ad', 'research', 'video' and 'chat'. 'image' allows a
//         small number in parallel (PAID_IMAGE_CONCURRENCY, default 6)
//         because one campaign legitimately renders one image per ad slot.
//         Extra requests get 409 before anything is charged or sent.
//     Claims live in the credit_actions table (unique indexes make them
//     atomic across processes — migration 2026-10-credit-actions.sql) and
//     in memory (fast path; also the fallback until the table exists).
//
//  2. charge — creditManager.reserveCredits() (unchanged call sites)
//     attaches every successful charge to the current request's action.
//     This also applies to routes without a lane guard, so refunds cover
//     every one of the ~36 charging routes automatically.
//
//  3. settle — when the route answers (res.json/res.end), the action is
//     settled exactly once:
//       success  = HTTP < 400, body.ok !== false, and the route didn't call
//                  markFailed() (e.g. "image step produced no image")
//       anything else → every charge made in this request is refunded
//                  exactly once (per-charge flag + conditional DB status
//                  update), and a "<feature>_refund" ledger row is written.
//     The refund completes BEFORE the response is sent, and the response
//     carries creditsRefunded:true so the UI can say so.
//
//  4. async video — a video route that submits a provider job calls
//     awaitAsync(jobId); the charge is settled later by the status
//     endpoints (failed → refund, completed → succeeded) or by the sweep.
//
//  5. sweep — a gated background job refunds actions left in_progress by a
//     crashed/hung process, and settles abandoned async video jobs.

const crypto = require('crypto');
const aiUsage = require('./aiUsage');

// Every lane releases as soon as its request answers; staleMs only frees a
// lane held by a request that never answered (crash/hang).
const DEFAULT_STALE_MS = 10 * 60 * 1000;
function laneCapacity(lane) {
  if (lane === 'image') {
    const n = parseInt(process.env.PAID_IMAGE_CONCURRENCY, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 6;
  }
  return 1;
}
const ASYNC_STALE_MS = 3 * 60 * 60 * 1000; // provider video jobs finish well within this
const KEY_MEMORY_MS = 24 * 60 * 60 * 1000;  // duplicate-key memory window
const SETTLE_REFUND_TIMEOUT_MS = 8000;

const MESSAGES = {
  'create-ad': 'Your campaign is still being built. Wait for it to finish before starting another.',
  research: 'Your research is still running. Wait for it to finish before starting another.',
  image: 'Several images are still being generated. Wait for them to finish before starting more.',
  video: 'A video is still being submitted. Wait for it to finish before starting another.',
  chat: 'OrivenAI is still answering your previous message.',
};

let _db = null;
let _cm = null;
let _getUser = null;
// 'unknown' until the first DB call; 'missing' when the credit_actions
// table doesn't exist yet (memory-only protection, re-checked every 10 min).
let _dbState = 'unknown';
let _dbMissingAt = 0;

function init({ db, creditManager, getUser }) {
  _db = db || null;
  _cm = creditManager || null;
  _getUser = getUser || null;
}

// ── In-memory state (per process) ─────────────────────────────────
const mem = {
  keys: new Map(),     // `${userId}|${key}` -> { actionId, status, at }
  lanes: new Map(),    // `${userId}|${lane}` -> Map(actionId -> { at, slot })
  async: new Map(),    // jobId -> { userId, actionId, reservations, at, settled }
};
function _pruneKeys() {
  if (mem.keys.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of mem.keys) if (now - v.at > KEY_MEMORY_MS) mem.keys.delete(k);
}

function _dbUsable() {
  if (!_db) return false;
  if (_dbState === 'missing' && Date.now() - _dbMissingAt < 10 * 60 * 1000) return false;
  return true;
}
function _isMissingTable(error) {
  const code = error && error.code;
  const msg = String((error && error.message) || '');
  return code === '42P01' || code === 'PGRST205' || /credit_actions/.test(msg) && /does not exist|could not find/i.test(msg);
}
function _noteDbError(error, where) {
  if (_isMissingTable(error)) {
    if (_dbState !== 'missing') console.warn('[paidActions] credit_actions table not found — using in-memory protection only. Apply docs/migrations/2026-10-credit-actions.sql.');
    _dbState = 'missing';
    _dbMissingAt = Date.now();
    return;
  }
  console.warn(`[paidActions] ${where} failed:`, String((error && error.message) || error).slice(0, 160));
}

function sanitizeKey(raw) {
  const k = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_.:-]{8,100}$/.test(k) ? k : null;
}

function _newPaid(fields) {
  return Object.assign({
    actionId: crypto.randomUUID(), lane: null, userId: null, idemKey: null,
    claimed: false, dbRow: false, reservations: [], failedReason: null,
    asyncJobId: null, settling: null, createdAt: Date.now(),
  }, fields || {});
}
function _ctxPaid(create) {
  const c = aiUsage.current();
  if (!c || c.operation) return null; // background jobs settle their own charges
  if (!c.paid && create) c.paid = _newPaid();
  return c.paid || null;
}

// ── 1. Claim ──────────────────────────────────────────────────────
function _memRelease(p) {
  if (!p || !p.claimed || p._memReleased) return;
  p._memReleased = true;
  const lk = `${p.userId}|${p.lane}`;
  const held = mem.lanes.get(lk);
  if (held) { held.delete(p.actionId); if (!held.size) mem.lanes.delete(lk); }
}

async function claim({ userId, lane, idemKey, route }) {
  const actionId = crypto.randomUUID();
  const key = idemKey || ('srv-' + actionId);
  const kk = `${userId}|${key}`;
  const lk = `${userId}|${lane}`;
  const now = Date.now();
  const cap = laneCapacity(lane);

  // Synchronous in-process checks first — no await before the memory
  // marks below, so two requests in this process can never both pass.
  const prev = mem.keys.get(kk);
  if (prev && now - prev.at < KEY_MEMORY_MS) {
    return prev.status === 'in_progress'
      ? { ok: false, httpStatus: 409, code: 'ACTION_IN_PROGRESS', message: MESSAGES[lane] || 'This action is already in progress.' }
      : { ok: false, httpStatus: 409, code: 'DUPLICATE_ACTION', message: 'This action was already completed. Start a new one if you want to run it again.' };
  }
  let held = mem.lanes.get(lk);
  if (held) for (const [id, h] of held) if (now - h.at >= DEFAULT_STALE_MS) held.delete(id);
  if (held && held.size >= cap) {
    return { ok: false, httpStatus: 409, code: 'ACTION_IN_PROGRESS', message: MESSAGES[lane] || 'This action is already in progress.' };
  }
  const usedSlots = new Set(held ? [...held.values()].map((h) => h.slot) : []);
  let slot = 0; while (usedSlots.has(slot)) slot++;
  if (!held) { held = new Map(); mem.lanes.set(lk, held); }
  held.set(actionId, { at: now, slot });
  mem.keys.set(kk, { actionId, status: 'in_progress', at: now });
  _pruneKeys();
  const p = { userId, lane, actionId, claimed: true };

  // Cross-process truth: atomic insert guarded by unique indexes.
  let dbRow = false;
  if (_dbUsable()) {
    const res = await _dbInsertClaim({ actionId, userId, lane, key, route, slot, cap });
    if (res.conflict) {
      mem.keys.delete(kk);
      _memRelease(p);
      return res.conflict;
    }
    dbRow = res.ok;
  }
  return { ok: true, actionId, idemKey: key, dbRow };
}

// Lanes with capacity > 1 use slotted lane names ('image:0'..'image:5') so
// the single partial unique index (user_id, lane) WHERE in_progress still
// enforces the per-user limit atomically.
async function _dbInsertClaim({ actionId, userId, lane, key, route, slot, cap }, retried) {
  const laneName = cap > 1 ? `${lane}:${slot}` : lane;
  const row = { id: actionId, user_id: userId, lane: laneName, idempotency_key: key, route: route || null, status: 'in_progress' };
  const { error } = await _db.from('credit_actions').insert(row);
  if (!error) { _dbState = 'ok'; return { ok: true }; }
  if (error.code !== '23505') { _noteDbError(error, 'claim insert'); return { ok: false }; }

  // Conflict: same idempotency key, or the lane is busy.
  const { data: sameKey } = await _db.from('credit_actions').select('id, status')
    .eq('user_id', userId).eq('idempotency_key', key).maybeSingle();
  if (sameKey) {
    return { conflict: sameKey.status === 'in_progress' || sameKey.status === 'awaiting_async'
      ? { ok: false, httpStatus: 409, code: 'ACTION_IN_PROGRESS', message: MESSAGES[lane] || 'This action is already in progress.' }
      : { ok: false, httpStatus: 409, code: 'DUPLICATE_ACTION', message: 'This action was already completed. Start a new one if you want to run it again.' } };
  }
  const { data: busy } = await _db.from('credit_actions').select('*')
    .eq('user_id', userId).eq('lane', laneName).eq('status', 'in_progress').maybeSingle();
  if (busy && !retried && Date.now() - new Date(busy.created_at).getTime() > DEFAULT_STALE_MS) {
    await _expireStale(busy);
    return _dbInsertClaim({ actionId, userId, lane, key, route, slot, cap }, true);
  }
  // Slot taken by another process: try the next free slot.
  if (cap > 1 && slot + 1 < cap) return _dbInsertClaim({ actionId, userId, lane, key, route, slot: slot + 1, cap }, retried);
  return { conflict: { ok: false, httpStatus: 409, code: 'ACTION_IN_PROGRESS', message: MESSAGES[lane] || 'This action is already in progress.' } };
}

// Express middleware for expensive paid routes.
function laneGuard(lane) {
  return async function paidLaneGuard(req, res, next) {
    try {
      const user = _getUser ? await _getUser(req) : null;
      if (!user) return next(); // unauthenticated: the route itself decides (no credits involved)
      const idemKey = sanitizeKey(req.get('x-idempotency-key'));
      const r = await claim({ userId: user.id, lane, idemKey, route: `${req.method} ${req.baseUrl || ''}${req.path}` });
      if (!r.ok) {
        console.warn('[paidActions] refused', JSON.stringify({ lane, code: r.code, userId: String(user.id).slice(0, 64) }));
        return res.status(r.httpStatus).json({ error: r.message, code: r.code });
      }
      const c = aiUsage.current();
      if (c) c.paid = _newPaid({ actionId: r.actionId, lane, userId: user.id, idemKey: r.idemKey, claimed: true, dbRow: r.dbRow });
      next();
    } catch (err) {
      console.error('[paidActions] lane guard error:', err.message);
      next(); // never block a request because the guard itself failed
    }
  };
}

// ── 2. Charges ────────────────────────────────────────────────────
// Called by creditManager.reserveCredits after a successful charge.
function attachReservation(reservation) {
  if (!reservation || !reservation.charged) return;
  const p = _ctxPaid(true);
  if (!p) return; // background job (e.g. Autopilot cron) — handled by its own code path
  if (!p.userId) p.userId = reservation.userId;
  reservation.requestId = p.actionId; // one id across ledger rows + [AIUsage] lines
  p.reservations.push(reservation);
  if (p.dbRow && _dbUsable()) {
    const total = p.reservations.reduce((n, r) => n + (r.charged ? r.cost : 0), 0);
    _db.from('credit_actions').update({ charged: true, credits_cost: total, feature_key: reservation.featureKey || null, updated_at: new Date().toISOString() })
      .eq('id', p.actionId).then(({ error }) => { if (error) _noteDbError(error, 'charge update'); }, () => {});
  }
}

function markFailed(reason) {
  const p = _ctxPaid(false);
  if (p && !p.failedReason) p.failedReason = String(reason || 'unusable_result').slice(0, 80);
}
function awaitAsync(jobId) {
  const p = _ctxPaid(false);
  if (p && jobId) p.asyncJobId = String(jobId);
}

// ── 3. Settle ─────────────────────────────────────────────────────
async function _refundReservations(reservations, route, reason) {
  let refundedAny = false, failedAny = false;
  for (const r of reservations) {
    if (!r.charged) continue;
    try {
      const did = await _cm.refundCredits(r);
      if (did) {
        refundedAny = true;
        _cm.finalizeCreditLog(
          { requestId: r.requestId, cost: r.cost, charged: false, userId: r.userId },
          (r.featureKey || 'credits') + '_refund',
          { success: true, route, error: reason ? 'refund: ' + reason : null }
        ).catch(() => {});
      }
    } catch (err) {
      failedAny = true;
      console.error('[paidActions] REFUND FAILED — manual review needed', JSON.stringify({ userId: String(r.userId).slice(0, 64), cost: r.cost, feature: r.featureKey, actionId: r.requestId, error: String(err.message).slice(0, 160) }));
    }
  }
  return { refundedAny, failedAny };
}

async function _dbSetStatus(p, fromStatuses, status, extra) {
  if (!p.dbRow || !_dbUsable()) return { updated: 1 }; // memory mode: caller relies on per-charge flags
  const { data, error } = await _db.from('credit_actions')
    .update(Object.assign({ status, updated_at: new Date().toISOString() }, extra || {}))
    .eq('id', p.actionId).in('status', fromStatuses).select('id');
  if (error) { _noteDbError(error, 'status update'); return { updated: 1 }; }
  if ((data || []).length) return { updated: data.length };
  // Nothing moved. Only a row that EXISTS in another state means someone
  // else already settled it; a missing row must not cost the user their
  // refund, so fall back to the per-charge flags (memory semantics).
  const { data: row, error: e2 } = await _db.from('credit_actions').select('id, status').eq('id', p.actionId).maybeSingle();
  if (e2 || !row) return { updated: 1 };
  return { updated: 0 };
}

function _isFailure(statusCode, body, p) {
  if (p.failedReason) return p.failedReason;
  if (statusCode >= 400) return 'http_' + statusCode;
  if (body && typeof body === 'object' && !Array.isArray(body) && body.ok === false) return 'ok_false';
  return null;
}

function settle(p, { statusCode, body, route }) {
  if (!p) return Promise.resolve({ failed: false, refunded: false });
  if (p.settling) return p.settling;
  p.settling = (async () => {
    const reason = _isFailure(statusCode, body, p);
    const charged = p.reservations.filter((r) => r.charged);
    const key = `${p.userId}|${p.idemKey}`;
    let out = { failed: !!reason, refunded: false };
    try {
      if (reason) {
        if (charged.length) {
          // Exactly once across processes: only the caller that moves the
          // row out of in_progress may refund.
          const claimRefund = await _dbSetStatus(p, ['in_progress'], 'refunding', { error: reason });
          if (claimRefund.updated) {
            const r = await _refundReservations(charged, route, reason);
            out.refunded = r.refundedAny || charged.every((x) => x._refundState === 'done');
            await _dbSetStatus(p, ['refunding'], r.failedAny ? 'refund_failed' : 'refunded');
          }
        } else {
          await _dbSetStatus(p, ['in_progress'], 'failed', { error: reason });
        }
        if (p.claimed && p.idemKey) mem.keys.set(key, { actionId: p.actionId, status: 'failed', at: Date.now() });
      } else if (p.asyncJobId && charged.length) {
        mem.async.set(p.asyncJobId, { userId: p.userId, actionId: p.actionId, reservations: charged, at: Date.now(), settled: false, route, dbRow: p.dbRow });
        await _dbSetStatus(p, ['in_progress'], 'awaiting_async', { async_job_id: p.asyncJobId });
        if (p.claimed && p.idemKey) mem.keys.set(key, { actionId: p.actionId, status: 'succeeded', at: Date.now() });
      } else {
        await _dbSetStatus(p, ['in_progress'], 'succeeded');
        if (p.claimed && p.idemKey) mem.keys.set(key, { actionId: p.actionId, status: 'succeeded', at: Date.now() });
      }
    } catch (err) {
      console.error('[paidActions] settle error:', err.message);
    } finally {
      _memRelease(p);
    }
    return out;
  })();
  return p.settling;
}

// Global middleware: settles the request's paid action (if any) right
// before the response goes out. Installed once, after aiUsage.middleware.
function responseHook(req, res, next) {
  const c = aiUsage.current();
  if (!c) return next();
  const route = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
  const origJson = res.json.bind(res);
  res.json = function (body) {
    const p = c.paid;
    if (!p || p.settling || (!p.claimed && !p.reservations.length)) return origJson(body);
    const settled = settle(p, { statusCode: res.statusCode, body, route });
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), SETTLE_REFUND_TIMEOUT_MS));
    Promise.race([settled, timeout]).then((r) => {
      let out = body;
      if (r && r.failed && r.refunded && body && typeof body === 'object' && !Array.isArray(body)) out = Object.assign({}, body, { creditsRefunded: true });
      origJson(out);
    }, () => origJson(body));
    return res;
  };
  const origEnd = res.end;
  res.end = function () {
    const p = c.paid;
    if (p && !p.settling && (p.claimed || p.reservations.length)) settle(p, { statusCode: res.statusCode, body: null, route });
    return origEnd.apply(this, arguments);
  };
  next();
}

// ── 4. Async (video) settlement ───────────────────────────────────
// Called by the video status endpoints once the provider reports a final
// state. Safe to call repeatedly (polling) — settles at most once.
async function settleAsync(jobId, completed, userId) {
  if (!jobId) return { settled: false };
  const entry = mem.async.get(String(jobId));
  if (entry) {
    if (entry.settled || (userId && entry.userId !== userId)) return { settled: false };
    entry.settled = true;
    mem.async.delete(String(jobId));
    const p = { actionId: entry.actionId, dbRow: entry.dbRow };
    if (completed) { await _dbSetStatus(p, ['awaiting_async'], 'succeeded'); return { settled: true, refunded: false }; }
    const claimRefund = await _dbSetStatus(p, ['awaiting_async'], 'refunding', { error: 'async_job_failed' });
    if (!claimRefund.updated) return { settled: false };
    const r = await _refundReservations(entry.reservations, entry.route, 'async_job_failed');
    await _dbSetStatus(p, ['refunding'], r.failedAny ? 'refund_failed' : 'refunded');
    return { settled: true, refunded: r.refundedAny };
  }
  // Not in this process's memory (restart / other instance) — use the row.
  if (!_dbUsable()) return { settled: false };
  let q = _db.from('credit_actions').select('*').eq('async_job_id', String(jobId)).eq('status', 'awaiting_async');
  if (userId) q = q.eq('user_id', userId);
  const { data: row, error } = await q.maybeSingle();
  if (error) { _noteDbError(error, 'async lookup'); return { settled: false }; }
  if (!row) return { settled: false };
  return _settleRow(row, completed ? 'succeeded' : 'refund', 'async_job_failed');
}

// Settles a credit_actions row without in-memory reservation objects.
async function _settleRow(row, outcome, reason) {
  const p = { actionId: row.id, dbRow: true };
  if (outcome === 'succeeded') { await _dbSetStatus(p, [row.status], 'succeeded'); return { settled: true, refunded: false }; }
  const claimRefund = await _dbSetStatus(p, [row.status], 'refunding', { error: reason });
  if (!claimRefund.updated) return { settled: false };
  if (!row.charged || !(row.credits_cost > 0)) { await _dbSetStatus(p, ['refunding'], 'failed'); return { settled: true, refunded: false }; }
  const reservation = { userId: row.user_id, cost: row.credits_cost, charged: true, requestId: row.id, featureKey: row.feature_key || 'credits' };
  const r = await _refundReservations([reservation], row.route, reason);
  await _dbSetStatus(p, ['refunding'], r.failedAny ? 'refund_failed' : 'refunded');
  return { settled: true, refunded: r.refundedAny };
}

async function _expireStale(row) {
  console.warn('[paidActions] expiring stale action', JSON.stringify({ id: row.id, lane: row.lane, status: row.status, created_at: row.created_at }));
  return _settleRow(row, 'refund', 'stale_' + row.status);
}

// ── 5. Sweep (background job) ─────────────────────────────────────
// getVideoStatus(jobId) -> { status } is injected so this module never
// talks to the provider itself.
async function sweep({ getVideoStatus } = {}) {
  const now = Date.now();
  // Memory: abandoned async jobs and lanes held by requests that never answered.
  for (const [jobId, e] of mem.async) {
    if (now - e.at < ASYNC_STALE_MS) continue;
    let st = null;
    try { st = getVideoStatus ? (await getVideoStatus(jobId)).status : null; } catch (_) {}
    if (st === 'completed') await settleAsync(jobId, true);
    else if (st === 'failed' || st == null) await settleAsync(jobId, false);
  }
  if (!_dbUsable()) return;
  const staleCut = new Date(now - DEFAULT_STALE_MS).toISOString();
  const { data: stuck, error } = await _db.from('credit_actions').select('*').eq('status', 'in_progress').lt('created_at', staleCut).limit(100);
  if (error) { _noteDbError(error, 'sweep'); return; }
  for (const row of stuck || []) await _expireStale(row);
  const asyncCut = new Date(now - ASYNC_STALE_MS).toISOString();
  const { data: waiting } = await _db.from('credit_actions').select('*').eq('status', 'awaiting_async').lt('created_at', asyncCut).limit(100);
  for (const row of waiting || []) {
    let st = null;
    try { st = getVideoStatus ? (await getVideoStatus(row.async_job_id)).status : null; } catch (_) {}
    if (st === 'completed') await _settleRow(row, 'succeeded');
    else if (st === 'failed' || st == null) await _settleRow(row, 'refund', 'async_job_abandoned');
  }
}

function _resetForTests() {
  mem.keys.clear(); mem.lanes.clear(); mem.async.clear();
  _dbState = 'unknown'; _dbMissingAt = 0;
}
function _state() {
  let inflight = 0; for (const h of mem.lanes.values()) inflight += h.size;
  return { keys: mem.keys.size, lanes: mem.lanes.size, inflight, async: mem.async.size, db: _dbState };
}

module.exports = {
  init, laneGuard, responseHook, claim, attachReservation, markFailed, awaitAsync,
  settle, settleAsync, sweep, sanitizeKey, _resetForTests, _state,
};
