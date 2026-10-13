// ════════════════════════════════════════════════════════════════
// Video generation ownership.
//
// A provider generation id is all the status endpoints receive, and the
// provider answers for any id — so before asking it, the server checks the
// job belongs to the signed-in account. Unknown or someone else's job →
// the caller answers 404 (same answer for both, so ids can't be probed).
//
// Sources, in order (no schema change):
//   1. this process's record, written the moment a generation is started
//      (every video route calls record()) — decisive when present;
//   2. credit_actions.async_job_id + user_id (charged jobs, any instance,
//      survives restarts);
//   3. creative_assets.content.generationId + user_id (Video Ads and Motion
//      Graphics save their jobs to the asset library).
// ════════════════════════════════════════════════════════════════

const TTL_MS = 3 * 24 * 60 * 60 * 1000; // longer than any render + the client's polling
const MAX_ENTRIES = 20000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

const _mem = new Map(); // jobId -> { userId, at }
let _db = null;

function init({ db }) { _db = db || null; }

function validId(jobId) { return typeof jobId === 'string' && ID_RE.test(jobId); }

function _prune(now) {
  if (_mem.size < MAX_ENTRIES) return;
  for (const [id, e] of _mem) { if (now - e.at > TTL_MS || _mem.size >= MAX_ENTRIES) _mem.delete(id); else break; }
}

// Called right after the provider accepted a generation for this user.
function record(jobId, userId) {
  if (!jobId || !userId) return;
  const now = Date.now();
  _prune(now);
  _mem.set(String(jobId), { userId: String(userId), at: now });
}

async function _dbHas(table, build) {
  try {
    const { data, error } = await build(_db.from(table).select('id')).limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch (_) { return false; }
}

// true only when the job is known to belong to userId.
async function isOwner(jobId, userId) {
  if (!validId(jobId) || !userId) return false;
  const id = String(jobId), uid = String(userId);
  const e = _mem.get(id);
  if (e && Date.now() - e.at <= TTL_MS) return e.userId === uid;
  if (!_db) return false;
  if (await _dbHas('credit_actions', (q) => q.eq('async_job_id', id).eq('user_id', uid))) return true;
  if (await _dbHas('creative_assets', (q) => q.eq('user_id', uid).eq('content->>generationId', id))) return true;
  return false;
}

function _resetForTests() { _mem.clear(); }

module.exports = { init, record, isOwner, validId, _resetForTests };
