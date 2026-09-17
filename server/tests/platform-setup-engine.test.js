// ════════════════════════════════════════════════════════════════
// Universal Advertising Setup Engine (Phase 1 + 2) — regression tests
//
// Covers:
//   - the capability registry (platformCapabilities.js) is well-formed
//     and honest about what's implemented vs. merely classified
//   - the setup state engine (setupStateEngine.js) computes the right
//     state for every real transition it's designed to detect, via
//     real HTTP calls against the running local server + real
//     hand-seeded `integrations` rows (same pattern as
//     tests/pinterest-ads.test.js in the frontend repo)
//   - the two new read-only routes (/api/setup/status,
//     /api/setup/:platform/status) require auth, reject unknown
//     platforms, and never claim `ready: true` without the real
//     stored data to back it up
//
// COST/SIDE-EFFECT NOTE: creates one throwaway Supabase user + hand-
// seeded `integrations` rows with FAKE tokens (never calls Meta/
// Google/TikTok/Pinterest — this phase makes no external API calls
// by design), all cleaned up in a `finally` block.
//
// RUN: node tests/platform-setup-engine.test.js   (from oriven-backand-clean/server)
// REQUIRES: local server already running (`node server.js`), SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY in .env.
// ════════════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const assert = require('assert/strict');
const { createClient } = require('@supabase/supabase-js');

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 5500}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env — aborting.');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);
const platformCapabilities = require('../services/platformCapabilities');
const setupStateEngine = require('../services/setupStateEngine');

const results = [];
function record(name, fn) {
  return fn().then(
    () => { results.push({ name, ok: true }); console.log('  PASS —', name); },
    (err) => { results.push({ name, ok: false, err }); console.log('  FAIL —', name, '\n        ', err.message); }
  );
}

async function createTestUser(emailSuffix) {
  const email = `oriven.setupengine.test+${Date.now()}.${emailSuffix}@example.com`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + '-Aa1!';
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;
  const userId = created.user.id;
  await supabaseAdmin.from('profiles').upsert({ id: userId, email, subscription_status: 'creator', onboarding_completed: true }, { onConflict: 'id' });
  const signInClient = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: signInData, error: signInErr } = await signInClient.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  return { userId, email, password, token: signInData.session.access_token };
}

async function deleteTestUser(userId) {
  try { await supabaseAdmin.from('integrations').delete().eq('user_id', userId); } catch (_) {}
  try { await supabaseAdmin.from('profiles').delete().eq('id', userId); } catch (_) {}
  try { await supabaseAdmin.auth.admin.deleteUser(userId); } catch (_) {}
}

async function seedIntegration(userId, provider, fields) {
  await supabaseAdmin.from('integrations').upsert({
    user_id: userId, provider, connected_at: new Date().toISOString(), ...fields,
  }, { onConflict: 'user_id,provider' });
}

async function main() {
  let user;
  try {
    // ── Registry sanity (no HTTP, no DB — pure module checks) ──────
    await record('1. Registry declares exactly the 4 spec\'d platforms, no more', async () => {
      assert.deepEqual(platformCapabilities.PLATFORMS.slice().sort(), ['google', 'meta', 'pinterest', 'tiktok']);
    });
    await record('2. Every capability has a real classification type (no undefined/typo values)', async () => {
      const validTypes = new Set(Object.values(platformCapabilities.TYPE));
      for (const platform of platformCapabilities.PLATFORMS) {
        for (const c of platformCapabilities.getCapabilities(platform)) {
          assert.ok(validTypes.has(c.type), `${platform}.${c.key} has invalid type "${c.type}"`);
        }
      }
    });
    await record('3. No capability with implemented:true lacks a real docs citation to existing code', async () => {
      for (const platform of platformCapabilities.PLATFORMS) {
        for (const c of platformCapabilities.getCapabilities(platform)) {
          if (c.implemented) {
            assert.ok(/server\.js(:\d+| )/.test(c.docs) || /tests\//.test(c.docs) || /services\/adapters\//.test(c.docs), `${platform}.${c.key} is marked implemented but docs "${c.docs}" doesn't cite existing code`);
          }
        }
      }
    });
    await record('4. BILLING/VERIFICATION remain honestly marked NOT implemented for every platform (untouched this phase)', async () => {
      for (const platform of platformCapabilities.PLATFORMS) {
        for (const c of platformCapabilities.getCapabilities(platform)) {
          if (c.category === 'BILLING' || c.category === 'VERIFICATION') {
            assert.equal(c.implemented, false, `${platform}.${c.key} (${c.category}) must be implemented:false — no billing/verification code exists yet`);
          }
        }
      }
    });
    // Phase 3-9 update: TRACKING/CONVERSIONS are no longer universally
    // unimplemented — real, mock-tested adapter code now exists for the
    // specific capabilities confirmed against current official docs
    // (meta.pixel, google.conversionAction, pinterest.tag,
    // tiktok.eventsApi). This asserts EXACTLY that set became
    // implemented — not "some capabilities did," which would silently
    // pass even if the wrong ones flipped.
    //
    // COMPLETION PASS update: the set grew again — meta.conversionsApi,
    // google.tag, pinterest.conversionsApi, and tiktok.pixel (re-
    // researched and corrected a second time — see 4c below) all became
    // real and implemented this pass. This asserts the FULL, current
    // set, not the Phase 3-9 subset, so unintended drift in either
    // direction (a capability silently un-implemented, or a NEW one
    // added without updating this test) is caught.
    await record('4b. Exactly the intended TRACKING/CONVERSIONS capabilities are implemented (no unintended drift)', async () => {
      const expectedImplemented = new Set([
        'meta.pixel', 'meta.conversionsApi',
        'google.tag', 'google.conversionAction',
        'pinterest.tag', 'pinterest.conversionsApi',
        'tiktok.pixel', 'tiktok.eventsApi',
      ]);
      for (const platform of platformCapabilities.PLATFORMS) {
        for (const c of platformCapabilities.getCapabilities(platform)) {
          if (c.category === 'TRACKING' || c.category === 'CONVERSIONS') {
            const shouldBeImplemented = expectedImplemented.has(c.key);
            assert.equal(c.implemented, shouldBeImplemented, `${platform}.${c.key} implemented=${c.implemented}, expected ${shouldBeImplemented}`);
          }
        }
      }
    });
    await record('4c. TikTok Pixel was RE-corrected from MANUAL to HYBRID during the Completion Pass (real linkage endpoints found; creation still unconfirmed)', async () => {
      const tikTokPixel = platformCapabilities.getCapability('tiktok', 'tiktok.pixel');
      assert.equal(tikTokPixel.type, 'HYBRID');
      assert.equal(tikTokPixel.implemented, true);
      // Creation must still not be claimed anywhere in the docs — only linkage.
      assert.ok(!/pixel.*creat(e|ion)\s+is\s+(now\s+)?(confirmed|implemented)/i.test(tikTokPixel.verification));
    });
    await record('5. Google customerClient and Meta adAccount remain eligibility-gated and unimplemented — real, stable platform restrictions confirmed unchanged this pass', async () => {
      const gcc = platformCapabilities.getCapability('google', 'google.customerClient');
      const madAcct = platformCapabilities.getCapability('meta', 'meta.adAccount');
      assert.equal(gcc.type, 'API_GATED');
      assert.equal(gcc.implemented, false);
      assert.equal(madAcct.type, 'API_GATED');
      assert.equal(madAcct.implemented, false);
    });
    await record('6. Pinterest first ad account was RE-researched and CORRECTED from MANUAL to API_GATED (real, confirmed POST /ad_accounts endpoint; no "first account only" restriction in the API contract itself)', async () => {
      const firstAcct = platformCapabilities.getCapability('pinterest', 'pinterest.firstAdAccount');
      assert.equal(firstAcct.type, 'API_GATED');
      assert.equal(firstAcct.implemented, true);
      assert.ok(firstAcct.officialFlow, 'must keep a manual fallback for when the API rejects it');
    });
    await record('6b. TikTok advertiser account creation moved from "endpoint confirmed, unwired" to genuinely wired this pass', async () => {
      const adv = platformCapabilities.getCapability('tiktok', 'tiktok.advertiserAccount');
      assert.equal(adv.implemented, true);
      assert.ok(/tiktokSetupAdapter\.js/.test(adv.docs));
    });
    await record('6c. Meta Business Manager discovery is real and implemented; creation remains honestly unimplemented with a corrected, specific reason', async () => {
      const bm = platformCapabilities.getCapability('meta', 'meta.businessManager');
      assert.equal(bm.implemented, true);
      assert.ok(/requires an existing business_id/i.test(bm.verification), 'must document the specific, re-researched reason creation cannot serve a first-time user');
    });

    // ── State engine pure-function checks (no HTTP) ────────────────
    await record('7. checkMetaSetup: no row -> not_started, disconnected, not ready', async () => {
      const r = setupStateEngine.checkMetaSetup(null);
      assert.equal(r.state, 'not_started');
      assert.equal(r.connected, false);
      assert.equal(r.ready, false);
    });
    await record('8. checkMetaSetup: expired token -> authentication_required', async () => {
      const r = setupStateEngine.checkMetaSetup({ access_token: 'x', token_expiry: new Date(Date.now() - 1000).toISOString() });
      assert.equal(r.state, 'authentication_required');
    });
    await record('9. checkGoogleSetup: manager-only account is correctly rejected as a publish target (mirrors real _getGadsAccess guard)', async () => {
      const r = setupStateEngine.checkGoogleSetup({
        access_token: 'x', token_expiry: new Date(Date.now() + 100000).toISOString(),
        google_ads_accounts: [{ customer_id: '1', is_manager: true }],
        active_ad_account: { account_id: '1', is_manager: true },
      });
      assert.equal(r.state, 'account_selection_required');
      assert.equal(r.ready, false);
    });
    await record('10. checkPinterestSetup: no accounts -> manual_action_required (distinct from generic account_creation_required)', async () => {
      const r = setupStateEngine.checkPinterestSetup({ access_token: 'x', refresh_token: 'r', token_expiry: new Date(Date.now() + 100000).toISOString(), pinterest_ads_accounts: [] });
      assert.equal(r.state, 'manual_action_required');
      assert.ok(r.officialFlow && /pinterest\.com/.test(r.officialFlow.urlTemplate));
    });
    await record('11. checkMetaSetup: fully set up (auth+account+page) -> ready_limited_verification, ready:true, but tracking/billing honestly unverified', async () => {
      const r = setupStateEngine.checkMetaSetup({
        access_token: 'x', token_expiry: new Date(Date.now() + 100000).toISOString(),
        meta_ads_accounts: [{ account_id: 'act_1' }], active_ad_account: { account_id: 'act_1' },
        meta_pages: [{ page_id: 'p1' }], active_page: { page_id: 'p1', page_name: 'Test' },
      });
      assert.equal(r.state, 'ready_limited_verification');
      assert.equal(r.ready, true);
      assert.ok(r.steps.tracking.every(s => s.status === 'not_verified_by_oriven'));
      assert.ok(r.steps.billing.every(s => s.status === 'not_verified_by_oriven'));
    });
    await record('12. No platform\'s state engine ever returns ready:true without connected:true', async () => {
      // Idempotency/safety property: run every checker against a battery
      // of partial/malformed rows and confirm the invariant always holds.
      const checkers = [setupStateEngine.checkMetaSetup, setupStateEngine.checkGoogleSetup, setupStateEngine.checkTikTokSetup, setupStateEngine.checkPinterestSetup];
      const rows = [null, {}, { access_token: 'x' }, { access_token: 'x', token_expiry: new Date(Date.now() - 1).toISOString() }];
      for (const checker of checkers) {
        for (const row of rows) {
          const r = checker(row);
          if (r.ready) assert.equal(r.connected, true, `${r.platform} returned ready:true with connected:false`);
        }
      }
    });

    // ── Real HTTP against the running server + real seeded rows ────
    user = await createTestUser('a');

    await record('13. GET /api/setup/status requires auth (401 without token)', async () => {
      const res = await fetch(BASE_URL + '/api/setup/status');
      assert.equal(res.status, 401);
    });
    await record('14. GET /api/setup/:platform/status rejects an unknown platform (404)', async () => {
      const res = await fetch(BASE_URL + '/api/setup/notaplatform/status', { headers: { Authorization: 'Bearer ' + user.token } });
      assert.equal(res.status, 404);
    });
    await record('15. Fresh user: all 4 platforms report not_started/disconnected/not-ready — never fabricated', async () => {
      const res = await fetch(BASE_URL + '/api/setup/status', { headers: { Authorization: 'Bearer ' + user.token } });
      assert.equal(res.status, 200);
      const body = await res.json();
      for (const platform of platformCapabilities.PLATFORMS) {
        assert.equal(body.platforms[platform].state, 'not_started');
        assert.equal(body.platforms[platform].connected, false);
        assert.equal(body.platforms[platform].ready, false);
      }
    });

    await record('16. Real integrations row (Meta, fully set up) -> /api/setup/meta/status reports ready_limited_verification via real HTTP', async () => {
      await seedIntegration(user.userId, 'meta_ads', {
        access_token: 'fake_token', token_expiry: new Date(Date.now() + 3600000).toISOString(),
        meta_ads_accounts: [{ account_id: 'act_123', account_name: 'Test Account' }],
        active_ad_account: { account_id: 'act_123', account_name: 'Test Account' },
        meta_pages: [{ page_id: 'p1', page_name: 'Test Page' }],
        active_page: { page_id: 'p1', page_name: 'Test Page' },
      });
      const res = await fetch(BASE_URL + '/api/setup/meta/status', { headers: { Authorization: 'Bearer ' + user.token } });
      const body = await res.json();
      assert.equal(body.state, 'ready_limited_verification');
      assert.equal(body.ready, true);
    });

    await record('17. Real integrations row (Google, manager-only) -> account_creation_required via real HTTP', async () => {
      await seedIntegration(user.userId, 'google_ads', {
        access_token: 'fake_token', refresh_token: 'fake_refresh', token_expiry: new Date(Date.now() + 3600000).toISOString(),
        google_ads_accounts: [{ customer_id: '111', name: 'My MCC', is_manager: true }],
      });
      const res = await fetch(BASE_URL + '/api/setup/google/status', { headers: { Authorization: 'Bearer ' + user.token } });
      const body = await res.json();
      assert.equal(body.state, 'account_creation_required');
      assert.equal(body.ready, false);
    });

    await record('18. Idempotency: running the same status check twice in a row produces identical state (no drift/side effects from reading)', async () => {
      const res1 = await fetch(BASE_URL + '/api/setup/meta/status', { headers: { Authorization: 'Bearer ' + user.token } });
      const res2 = await fetch(BASE_URL + '/api/setup/meta/status', { headers: { Authorization: 'Bearer ' + user.token } });
      const [b1, b2] = await Promise.all([res1.json(), res2.json()]);
      assert.equal(b1.state, b2.state);
      assert.equal(b1.ready, b2.ready);
    });

    await record('19. Aggregate /api/setup/status reflects all real seeded per-platform states at once', async () => {
      const res = await fetch(BASE_URL + '/api/setup/status', { headers: { Authorization: 'Bearer ' + user.token } });
      const body = await res.json();
      assert.equal(body.platforms.meta.state, 'ready_limited_verification');
      assert.equal(body.platforms.google.state, 'account_creation_required');
      assert.equal(body.platforms.tiktok.state, 'not_started');
      assert.equal(body.platforms.pinterest.state, 'not_started');
    });
  } finally {
    if (user) await deleteTestUser(user.userId);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks run, ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
}

main().catch(e => { console.error('CRASH:', e); process.exit(1); });
