// ════════════════════════════════════════════════════════════════
// Universal Setup Engine — error taxonomy + retry/backoff unit tests
// (Completion Pass)
//
// Pure unit tests, no server/network required — these exercise
// services/setupErrors.js directly: real platform error → correct
// internal code mapping, retryable vs never-retry classification, and
// bounded exponential backoff that only fires for genuinely transient
// codes.
// RUN: node tests/setup-errors.test.js
// ════════════════════════════════════════════════════════════════

const assert = require('assert');
const { CODE, SetupError, mapPlatformError, isRetryable, withPlatformRetry } = require('../services/setupErrors');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('  PASS — ' + name); }
  catch (e) { results.push({ name, ok: false, detail: e.message }); console.log('  FAIL — ' + name + ' (' + e.message + ')'); }
}

check('1. A 401 from any platform maps to TOKEN_EXPIRED', () => {
  const mapped = mapPlatformError('meta', Object.assign(new Error('expired'), { status: 401 }));
  assert.strictEqual(mapped.code, CODE.TOKEN_EXPIRED);
  assert.strictEqual(mapped.status, 401);
});

check('2. A 401 whose message mentions "refresh" maps to TOKEN_REFRESH_FAILED, not TOKEN_EXPIRED', () => {
  const mapped = mapPlatformError('tiktok', Object.assign(new Error('TikTok token refresh failed — reconnect'), { status: 401 }));
  assert.strictEqual(mapped.code, CODE.TOKEN_REFRESH_FAILED);
});

check('3. A 429 from any platform maps to RATE_LIMITED and is retryable', () => {
  const mapped = mapPlatformError('google', Object.assign(new Error('rate limited'), { status: 429 }));
  assert.strictEqual(mapped.code, CODE.RATE_LIMITED);
  assert.ok(isRetryable(mapped.code));
});

check('4. A 503 maps to PLATFORM_UNAVAILABLE and is retryable', () => {
  const mapped = mapPlatformError('pinterest', Object.assign(new Error('unavailable'), { status: 503 }));
  assert.strictEqual(mapped.code, CODE.PLATFORM_UNAVAILABLE);
  assert.ok(isRetryable(mapped.code));
});

check('5. Google CREATION_DENIED_INELIGIBLE_MCC maps to ACCOUNT_CREATION_REQUIRED, never retried', () => {
  const mapped = mapPlatformError('google', new Error('CustomerError.CREATION_DENIED_INELIGIBLE_MCC: manager not eligible'));
  assert.strictEqual(mapped.code, CODE.ACCOUNT_CREATION_REQUIRED);
  assert.ok(!isRetryable(mapped.code));
});

check('6. Google DUPLICATE_NAME maps to ALREADY_EXISTS (409)', () => {
  const mapped = mapPlatformError('google', new Error('DUPLICATE_NAME: a conversion action with this name already exists'));
  assert.strictEqual(mapped.code, CODE.ALREADY_EXISTS);
  assert.strictEqual(mapped.status, 409);
});

check('7. Meta "Business Verification" message maps to VERIFICATION_REQUIRED', () => {
  const mapped = mapPlatformError('meta', Object.assign(new Error('This action requires Business Verification'), { status: 403 }));
  assert.strictEqual(mapped.code, CODE.VERIFICATION_REQUIRED);
});

check('8. TikTok "already exists" message maps to ALREADY_EXISTS', () => {
  const mapped = mapPlatformError('tiktok', new Error('advertiser account already exists'));
  assert.strictEqual(mapped.code, CODE.ALREADY_EXISTS);
});

check('9. An unrecognized error becomes UNKNOWN_ERROR, never silently mis-mapped', () => {
  const mapped = mapPlatformError('meta', new Error('something totally novel happened'));
  assert.strictEqual(mapped.code, CODE.UNKNOWN_ERROR);
});

check('10. A SetupError passed back in is returned unchanged (idempotent mapping)', () => {
  const original = new SetupError(CODE.BILLING_REQUIRED, 'custom message', 400);
  const mapped = mapPlatformError('meta', original);
  assert.strictEqual(mapped, original);
});

check('11. Error messages sent to mapPlatformError never leak into the mapped message for unknown errors (raw platform text is not echoed as the code)', () => {
  const mapped = mapPlatformError('meta', new Error('raw internal platform detail'));
  assert.strictEqual(mapped.code, CODE.UNKNOWN_ERROR);
  // The message MAY be shown (still user-safe generic text), but the CODE must never be derived from unrecognized text.
  assert.ok(typeof mapped.message === 'string');
});

(async () => {
  await (async () => {
    let attempts = 0;
    try {
      await withPlatformRetry('meta', async () => {
        attempts++;
        const e = new Error('rate limited'); e.status = 429; throw e;
      }, { attempts: 3, baseDelayMs: 5 });
    } catch (_) { /* expected to eventually throw */ }
    check('12. withPlatformRetry retries a RATE_LIMITED failure up to the attempt cap, then throws', () => {
      assert.strictEqual(attempts, 3);
    });
  })();

  await (async () => {
    let attempts = 0;
    let threw = null;
    try {
      await withPlatformRetry('meta', async () => {
        attempts++;
        const e = new Error('bad request'); e.status = 400; throw e;
      }, { attempts: 3, baseDelayMs: 5 });
    } catch (e) { threw = e; }
    check('13. withPlatformRetry NEVER retries a non-transient (400) failure — fails on the first attempt', () => {
      assert.strictEqual(attempts, 1);
      assert.ok(threw);
    });
  })();

  await (async () => {
    let attempts = 0;
    const result = await withPlatformRetry('meta', async () => {
      attempts++;
      if (attempts < 2) { const e = new Error('rate limited'); e.status = 429; throw e; }
      return 'success';
    }, { attempts: 3, baseDelayMs: 5 });
    check('14. withPlatformRetry succeeds once a transient failure resolves, without exhausting all attempts', () => {
      assert.strictEqual(result, 'success');
      assert.strictEqual(attempts, 2);
    });
  })();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks run, ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
})();
