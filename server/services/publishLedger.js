// ════════════════════════════════════════════════════════════════
// Publish ledger — durable, per-campaign publish operations.
//
// One row per (user, platform, campaign) in `publish_operations`
// (docs/migrations/2026-10-publish-operations.sql). It is what makes a
// publish idempotent across double clicks, retries, proxy timeouts,
// browser refreshes and server restarts — the in-memory lock in server.js
// only covers one process for the length of one request.
//
//   publishing   — a request is (or was) sending objects to the platform
//   published    — the platform confirmed creation (external ids stored)
//   failed       — confirmed not created / rolled back; publishing again is safe
//   unconfirmed  — a request started but never finished (crash, restart);
//                  the platform may or may not have the campaign. Nothing is
//                  sent again until a status check (or the user) resolves it.
//
// The state machine is storage-agnostic: `store` is the Supabase adapter
// below in production and an in-memory adapter in tests.
// ════════════════════════════════════════════════════════════════
const STALE_MS = 10 * 60 * 1000; // a publish request never legitimately runs this long

class LedgerUnavailable extends Error {
  constructor(msg) { super(msg || 'Publish ledger unavailable'); this.code = 'PUBLISH_LEDGER_UNAVAILABLE'; }
}

function createLedger(opts) {
  const store = opts.store;
  const now = opts.now || (() => Date.now());
  const staleMs = opts.staleMs || STALE_MS;
  const iso = () => new Date(now()).toISOString();
  const isStale = (op) => op.state === 'publishing' && now() - new Date(op.started_at).getTime() >= staleMs;

  async function get(userId, platform, campId) {
    return store.get(userId, platform, campId);
  }

  // Claim the campaign for one publish. Returns { ok:true, op } or
  // { ok:false, code, op } — never sends anything itself.
  async function begin({ userId, platform, campId, opId, campaignName, accountId }) {
    const row = {
      user_id: userId, platform, client_ref_id: campId, op_id: opId || null, state: 'publishing',
      campaign_name: campaignName || null, external_account_id: accountId || null,
      external_campaign_id: null, external_ids: null, error: null, rollback: null,
      started_at: iso(), finished_at: null, updated_at: iso(),
    };
    const ins = await store.insert(row);
    if (ins.row) return { ok: true, op: ins.row };
    const op = ins.existing || await store.get(userId, platform, campId);
    if (!op) return { ok: false, code: 'PUBLISH_IN_PROGRESS', op: null };
    if (op.state === 'published') return { ok: false, code: 'ALREADY_PUBLISHED', op };
    if (op.state === 'unconfirmed') return { ok: false, code: 'RESULT_UNCONFIRMED', op };
    if (op.state === 'publishing') {
      if (!isStale(op)) return { ok: false, code: 'PUBLISH_IN_PROGRESS', op };
      const u = await store.updateIf(op.id, ['publishing'], { state: 'unconfirmed', updated_at: iso() });
      return { ok: false, code: 'RESULT_UNCONFIRMED', op: u || op };
    }
    // failed → a new attempt (conditional, so two racing requests can't both win)
    const claimed = await store.updateIf(op.id, ['failed'], Object.assign({}, row, { user_id: undefined, platform: undefined, client_ref_id: undefined }));
    if (claimed) return { ok: true, op: claimed };
    return { ok: false, code: 'PUBLISH_IN_PROGRESS', op: await store.get(userId, platform, campId) };
  }

  async function succeed(op, r) {
    return store.updateIf(op.id, ['publishing', 'unconfirmed'], {
      state: 'published', external_campaign_id: r.campaignId ? String(r.campaignId) : null,
      external_account_id: r.accountId ? String(r.accountId) : op.external_account_id,
      external_ids: r.ids || null, error: null, finished_at: iso(), updated_at: iso(),
    });
  }

  async function fail(op, r) {
    return store.updateIf(op.id, ['publishing', 'unconfirmed'], {
      state: 'failed', error: r && r.error ? String(r.error).slice(0, 500) : null,
      rollback: r && r.rollback ? r.rollback : null, finished_at: iso(), updated_at: iso(),
    });
  }

  // A status check (or the user) settled an unconfirmed operation.
  async function resolve(op, r) {
    if (r.state === 'published') return succeed(op, r);
    return store.updateIf(op.id, ['publishing', 'unconfirmed'], {
      state: 'failed', error: r.error ? String(r.error).slice(0, 500) : null, finished_at: iso(), updated_at: iso(),
    });
  }

  // Records that an in-flight operation outlived any real request.
  async function settleStale(op) {
    if (!op || !isStale(op)) return op;
    return (await store.updateIf(op.id, ['publishing'], { state: 'unconfirmed', updated_at: iso() })) || op;
  }

  // What a client may show for this operation (no secrets in rows).
  function view(op) {
    if (!op) return { state: 'none' };
    const state = isStale(op) ? 'unconfirmed' : op.state;
    return {
      state, opId: op.op_id || null, startedAt: op.started_at, finishedAt: op.finished_at,
      campaignId: op.external_campaign_id || null, accountId: op.external_account_id || null,
      accountName: (op.external_ids && op.external_ids.accountName) || null,
      ids: op.external_ids || null, error: op.error || null, rollback: op.rollback || null,
    };
  }

  return { begin, succeed, fail, resolve, get, view, isStale, settleStale, staleMs };
}

// ── Supabase adapter ───────────────────────────────────────────────
function supabaseStore(db, table) {
  table = table || 'publish_operations';
  const missing = (e) => e && (e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message || ''));
  const wrap = (e) => { throw new LedgerUnavailable(missing(e) ? 'publish_operations table is missing — apply docs/migrations/2026-10-publish-operations.sql' : (e && e.message) || 'ledger error'); };
  return {
    async get(userId, platform, campId) {
      const { data, error } = await db.from(table).select('*').eq('user_id', userId).eq('platform', platform).eq('client_ref_id', campId).maybeSingle();
      if (error) wrap(error);
      return data || null;
    },
    async insert(row) {
      const { data, error } = await db.from(table).insert(row).select().maybeSingle();
      if (!error) return { row: data };
      if (error.code === '23505') return { row: null };
      wrap(error);
    },
    async updateIf(id, states, patch) {
      const clean = {}; for (const k of Object.keys(patch)) if (patch[k] !== undefined) clean[k] = patch[k];
      const { data, error } = await db.from(table).update(clean).eq('id', id).in('state', states).select().maybeSingle();
      if (error) wrap(error);
      return data || null;
    },
  };
}

// ── In-memory adapter (tests) — same conflict semantics as the table ──
function memoryStore() {
  const rows = [];
  let seq = 0;
  const key = (r) => r.user_id + '|' + r.platform + '|' + r.client_ref_id;
  return {
    rows,
    async get(userId, platform, campId) { const r = rows.find((x) => key(x) === userId + '|' + platform + '|' + campId); return r ? Object.assign({}, r) : null; },
    async insert(row) {
      if (rows.some((x) => key(x) === key(row))) return { row: null };
      const r = Object.assign({ id: 'op' + (++seq) }, row); rows.push(r); return { row: Object.assign({}, r) };
    },
    async updateIf(id, states, patch) {
      const r = rows.find((x) => x.id === id);
      if (!r || !states.includes(r.state)) return null;
      for (const k of Object.keys(patch)) if (patch[k] !== undefined) r[k] = patch[k];
      return Object.assign({}, r);
    },
  };
}

module.exports = { createLedger, supabaseStore, memoryStore, LedgerUnavailable, STALE_MS };
