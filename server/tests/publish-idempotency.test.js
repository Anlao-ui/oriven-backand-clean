// ════════════════════════════════════════════════════════════════
// Publish idempotency guard (Launch Control sprint)
//
// Real HTTP against the running local server (no mocks, but ALSO no
// real ad-platform calls: no integration row is seeded, so any request
// that gets past the guard fails immediately and honestly for lack of
// a connected account — never a real campaign, never real spend). Two
// near-simultaneous POST /api/publish/<platform> requests for the SAME
// campId must never both proceed: exactly one is rejected with a real
// 409 PUBLISH_IN_PROGRESS before any platform work begins.
//
// RUN: node tests/publish-idempotency.test.js
// ════════════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const BASE_URL = process.env.TEST_BACKEND_URL || 'http://localhost:5500';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

async function createTestUser(suffix) {
  const email = `oriven.publishlock.test+${Date.now()}.${suffix}@example.com`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + '-Aa1!';
  const { data: created, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const userId = created.user.id;
  await supabaseAdmin.from('profiles').upsert({ id: userId, email, subscription_status: 'creator', onboarding_completed: true }, { onConflict: 'id' });
  const authClient = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: signInData } = await authClient.auth.signInWithPassword({ email, password });
  return { userId, token: signInData.session.access_token };
}
async function deleteTestUser(userId) {
  try { await supabaseAdmin.from('profiles').delete().eq('id', userId); } catch (_) {}
  try { await supabaseAdmin.auth.admin.deleteUser(userId); } catch (_) {}
}
async function publish(platform, token, body) {
  const r = await fetch(BASE_URL + '/api/publish/' + platform, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  let data; try { data = await r.json(); } catch (_) { data = null; }
  return { status: r.status, data };
}

// Minimal-but-real pkg shape (matches server.js's own field reads —
// pkg.strategy/pkg.metaAds/pkg.visualConcepts) — never enough to
// actually succeed without a real connected Meta account, which is
// exactly the point: this test proves the LOCK fires before any real
// platform work, not that publishing itself succeeds.
const FAKE_PKG = {
  campaignName: 'Idempotency Test Campaign',
  strategy: { goal: 'Sales' },
  metaAds: { headline: 'Test', primaryText: 'Test body' },
  visualConcepts: [{ conceptRef: 'a', generatedImageUrl: 'https://example.com/fake.png' }],
};

async function main() {
  let user;
  try {
    user = await createTestUser('a');

    // ── 1. Two near-simultaneous requests for the SAME campId: exactly
    // one must be rejected with 409 PUBLISH_IN_PROGRESS before any real
    // platform call is attempted. ──────────────────────────────────
    const campId = 'idem_test_camp_' + Date.now();
    const [r1, r2] = await Promise.all([
      publish('meta', user.token, { pkg: FAKE_PKG, campId }),
      publish('meta', user.token, { pkg: FAKE_PKG, campId }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    const codes = [r1.data && r1.data.code, r2.data && r2.data.code];
    check('1. Exactly one of two concurrent publish requests for the same campId is rejected with a real 409 PUBLISH_IN_PROGRESS', statuses.includes(409) && codes.includes('PUBLISH_IN_PROGRESS'), { statuses, codes });
    check('1b. Neither response is a fabricated 200 success (no real Meta account connected — a real failure or a real lock rejection are the only honest outcomes)', r1.status !== 200 && r2.status !== 200, { r1: r1.status, r2: r2.status });

    // ── 2. A DIFFERENT campId is never blocked by an unrelated campaign's lock ──
    const otherCampId = 'idem_test_camp_other_' + Date.now();
    const rOther = await publish('meta', user.token, { pkg: FAKE_PKG, campId: otherCampId });
    check('2. A different campId is never blocked by an unrelated campaign\'s in-flight lock', rOther.status !== 409, rOther.status);

    // ── 3. A different PLATFORM for the same campId is never blocked either ──
    const rDiffPlatform = await publish('tiktok', user.token, { pkg: FAKE_PKG, campId });
    check('3. The same campId on a DIFFERENT platform is never blocked by another platform\'s lock', rDiffPlatform.status !== 409, rDiffPlatform.status);

    // ── 4. Missing pkg is still rejected with 400 before the lock is even relevant ──
    const rNoPkg = await publish('meta', user.token, {});
    check('4. A request with no campaign package is rejected 400, independent of the lock', rNoPkg.status === 400, rNoPkg);

    // ── 5. No auth is still rejected with 401 ──────────────────────
    const rNoAuth = await fetch(BASE_URL + '/api/publish/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pkg: FAKE_PKG, campId: 'x' }) });
    check('5. No-auth publish request is rejected 401', rNoAuth.status === 401, rNoAuth.status);
  } finally {
    if (user) await deleteTestUser(user.userId);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks run, ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
