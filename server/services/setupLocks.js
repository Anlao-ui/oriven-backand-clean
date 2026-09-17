// ════════════════════════════════════════════════════════════════
// Universal Setup Engine — lightweight concurrency guard
//
// Deliberately NOT a database lock (spec: "do not overengineer this").
// Every setup mutation already goes through the idempotent "ensure"
// pattern (check-before-create, verify-after-create) in each adapter,
// which is what actually prevents a duplicate resource. This module
// adds one more real protection on top for the narrow "two clicks
// (or two tabs) land on this server within milliseconds of each
// other" case: the second caller AWAITS the first call's in-flight
// promise instead of racing it with its own duplicate "does it exist
// yet?" read — the classic TOCTOU gap check-then-create alone can't
// close on a single Node process.
//
// Single-process, in-memory by design — this server runs as one
// Node process (confirmed: no cluster/pm2 multi-instance setup
// anywhere in this repo's deployment config), so this is a complete,
// real fix for that process, not a partial one masquerading as full
// coverage across replicas.
// ════════════════════════════════════════════════════════════════

const INFLIGHT = new Map(); // key -> Promise

function withSetupLock(key, fn) {
  const existing = INFLIGHT.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => {
    if (INFLIGHT.get(key) === p) INFLIGHT.delete(key);
  });
  INFLIGHT.set(key, p);
  return p;
}

module.exports = { withSetupLock };
