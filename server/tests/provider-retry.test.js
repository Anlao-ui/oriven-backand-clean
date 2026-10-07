// ════════════════════════════════════════════════════════════════
// AI provider retry / timeout / queue policy — unit tests
//
// Exercises the REAL providers/aimlProvider.js request path with global
// fetch replaced by a scripted fake: nothing leaves the machine, no key is
// real, nothing is billed.
//
// RUN: node tests/provider-retry.test.js   (from oriven-backand-clean/server)
// ════════════════════════════════════════════════════════════════

for (const k of Object.keys(process.env)) if (/AIML/.test(k)) delete process.env[k];
Object.assign(process.env, {
  AIML_API_KEY: 'mock-not-a-key',
  AIML_BASE_OVERRIDE: 'http://provider.mock.invalid',
  AIML_MAX_CONCURRENT: '1',
  AIML_MAX_QUEUE: '2',
});

const path = require('path');
let script = [];
let fetchCalls = 0;
const hanging = [];
globalThis.fetch = (url, opts) => {
  if (!String(url).startsWith('http://provider.mock.invalid/')) return Promise.reject(new Error('network blocked: ' + url));
  fetchCalls++;
  const step = script.shift() || { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
  if (step.hang) {
    return new Promise((resolve, reject) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      if (opts && opts.signal) opts.signal.addEventListener('abort', onAbort);
      hanging.push(() => resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'late' } }] }) }));
    });
  }
  if (step.netCode) { const e = new TypeError('fetch failed'); e.cause = { code: step.netCode }; return Promise.reject(e); }
  return Promise.resolve({
    ok: step.status >= 200 && step.status < 300,
    status: step.status,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? step.retryAfter || null : null) },
    json: async () => { if (step.nonJson) throw new SyntaxError('bad json'); return step.body || {}; },
    text: async () => 'not json',
  });
};

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  origLog((cond ? '  PASS — ' : '  FAIL — ') + name + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
}
const origWarn = console.warn, origLog = console.log;

(async () => {
  console.warn = () => {};
  const aiml = require(path.resolve(__dirname, '../providers/aimlProvider'));
  const log = origLog;
  console.log = () => {};
  async function run(steps, fn) {
    script = steps.slice(); fetchCalls = 0;
    try { return { value: await (fn ? fn() : aiml.generateText('s', 'u', { model: 'claude-opus-4-8', returnFull: true })), calls: fetchCalls }; }
    catch (e) { return { err: e, calls: fetchCalls }; }
  }

  let r = await run([{ status: 500, body: { error: 'boom' } }]);
  check('500: not retried (may already be processed upstream) — 1 attempt', r.err && r.err.status === 500 && r.calls === 1, { calls: r.calls });
  r = await run([{ status: 502 }]);
  check('502: not retried — 1 attempt', r.err && r.calls === 1);
  r = await run([{ status: 504 }]);
  check('504: not retried — 1 attempt', r.err && r.calls === 1);
  r = await run([{ status: 429, retryAfter: '0.01' }, { status: 200, body: { choices: [{ message: { content: 'ok' } }] } }]);
  check('429 then 200: one retry, succeeds — 2 attempts', !r.err && r.calls === 2, { calls: r.calls, err: r.err && r.err.message });
  r = await run([{ status: 503, retryAfter: '0.01' }, { status: 503, retryAfter: '0.01' }, { status: 200 }]);
  check('503 twice: retried once only, then fails — max 2 attempts', r.err && r.err.status === 503 && r.calls === 2, { calls: r.calls });
  r = await run([{ netCode: 'ECONNREFUSED' }, { status: 200, body: { choices: [{ message: { content: 'ok' } }] } }]);
  check('connection refused before send: retried once — 2 attempts', !r.err && r.calls === 2, { calls: r.calls });
  r = await run([{ netCode: 'UND_ERR_SOCKET' }, { status: 200 }]);
  check('socket dropped after send: NOT retried — 1 attempt', r.err && r.calls === 1 && r.err.retryable === false, { calls: r.calls });
  r = await run([{ status: 403, body: { error: 'forbidden' } }]);
  check('403: provider-account error, not retried', r.err && r.err.providerAccount === true && r.calls === 1);
  r = await run([{ status: 400, body: { error: { message: 'Insufficient balance on your account' } } }]);
  check('400 "insufficient balance": provider-account error, not retried', r.err && r.err.providerAccount === true && r.calls === 1);
  r = await run([{ status: 400, body: { error: { message: 'max_tokens too large' } } }]);
  check('other 400: plain error, not retried', r.err && !r.err.providerAccount && r.calls === 1);
  r = await run([{ status: 200, nonJson: true }]);
  check('malformed body: error, not retried', r.err && r.calls === 1);

  process.env.AIML_TIMEOUT_MS = '150';
  r = await run([{ hang: true }, { status: 200 }]);
  check('timeout: aborted after AIML_TIMEOUT_MS, marked timeout, NOT retried — 1 attempt', r.err && r.err.timeout === true && r.calls === 1, { calls: r.calls, err: r.err && r.err.message });
  delete process.env.AIML_TIMEOUT_MS;

  // Bounded queue: concurrency 1, queue 2 → the 4th simultaneous request is refused immediately.
  script = [{ hang: true }, { status: 200 }, { status: 200 }, { status: 200 }]; fetchCalls = 0;
  const ps = [0, 1, 2, 3].map(() => aiml.generateText('s', 'u', { model: 'm', returnFull: true }).then((v) => ({ v }), (e) => ({ e })));
  const fourth = await ps[3];
  check('queue full: extra request refused instantly with AI_BUSY (nothing sent)', fourth.e && fourth.e.code === 'AI_BUSY' && fourth.e.busy === true, fourth.e && fourth.e.message);
  hanging.splice(0).forEach((resolve) => resolve());
  await Promise.all(ps);

  // Hooks: a refusing before-hook means no request is sent at all.
  aiml.setHooks({ before: () => { const e = new Error('spend limit'); e.code = 'AI_SPEND_LIMIT'; throw e; } });
  r = await run([{ status: 200 }]);
  check('spend-guard hook refuses: zero requests sent', r.err && r.err.code === 'AI_SPEND_LIMIT' && r.calls === 0);
  let seen = null;
  aiml.setHooks({ after: (o) => { seen = o; } });
  r = await run([{ status: 403 }]);
  check('after-hook sees provider-account failures (for alerting)', seen && seen.providerAccount === true && seen.ok === false);
  aiml.setHooks({});

  console.log = origLog; console.warn = origWarn;
  const failed = results.filter((x) => !x).length;
  log(`\n${results.length} checks run, ${results.length - failed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log = origLog; console.log('CRASH', e); process.exit(2); });
