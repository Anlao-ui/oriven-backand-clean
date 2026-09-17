// ════════════════════════════════════════════════════════════════
// Universal Setup Engine — concurrency guard unit tests (Completion
// Pass). Pure unit test, no server/network required.
// RUN: node tests/setup-locks.test.js
// ════════════════════════════════════════════════════════════════

const assert = require('assert');
const { withSetupLock } = require('../services/setupLocks');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name + (detail ? ' (' + detail + ')' : ''));
}

(async () => {
  // Simulates the double-click / two-tab race: two concurrent callers
  // hit the same key before the first has resolved.
  let executions = 0;
  const fn = async () => { executions++; await new Promise((r) => setTimeout(r, 30)); return 'created:' + executions; };
  const [a, b] = await Promise.all([
    withSetupLock('user1:meta-pixel', fn),
    withSetupLock('user1:meta-pixel', fn),
  ]);
  check('1. Two concurrent calls with the SAME key execute the underlying function only once', executions === 1, 'executions=' + executions);
  check('2. Both concurrent callers receive the SAME resolved result (the second awaited the first, never raced it)', a === b, JSON.stringify({ a, b }));

  executions = 0;
  const c = await withSetupLock('user1:meta-pixel', fn);
  check('3. A call AFTER the lock has cleared executes the function again (not permanently stuck)', executions === 1 && c === 'created:1', 'executions=' + executions);

  executions = 0;
  const [x, y] = await Promise.all([
    withSetupLock('user1:tiktok-advertiser', fn),
    withSetupLock('user2:tiktok-advertiser', fn),
  ]);
  check('4. Different keys (different users) never block each other — both execute independently', executions === 2, 'executions=' + executions);

  let threw = null;
  try {
    await withSetupLock('user1:will-fail', async () => { throw new Error('real platform rejection'); });
  } catch (e) { threw = e; }
  const after = await withSetupLock('user1:will-fail', async () => 'recovered');
  check('5. A failed call releases its lock — a subsequent call is not stuck behind a rejected promise forever', !!threw && after === 'recovered', JSON.stringify({ threw: threw && threw.message, after }));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks run, ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
})();
