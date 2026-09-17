// ════════════════════════════════════════════════════════════════
// Setup Engine tracking routes — real HTTP integration tests
//
// Cannot test successful creation against real Meta/Google/Pinterest
// accounts (no elevated-permission OAuth credentials in this
// environment — see the final report's "REAL API TESTS" section for
// the honest breakdown). What IS genuinely tested here, against the
// real running server with real (fake-token) seeded rows: auth
// requirements, input validation, and — critically — that these
// routes NEVER return a fabricated success when the underlying
// platform call would obviously fail (invalid/fake tokens correctly
// propagate as real errors, not 200s with invented data).
//
// RUN: node tests/setup-tracking-routes.test.js   (from oriven-backand-clean/server)
// ════════════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const assert = require('assert/strict');
const { createClient } = require('@supabase/supabase-js');

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 5500}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

const results = [];
function record(name, fn) {
  return fn().then(
    () => { results.push({ name, ok: true }); console.log('  PASS —', name); },
    (err) => { results.push({ name, ok: false, err }); console.log('  FAIL —', name, '\n        ', err.message); }
  );
}

async function main() {
  const email = `oriven.setuptracking.test+${Date.now()}@example.com`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + '-Aa1!';
  const { data: created } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  const userId = created.user.id;
  await supabaseAdmin.from('profiles').upsert({ id: userId, email, subscription_status: 'creator', onboarding_completed: true }, { onConflict: 'id' });
  const signInClient = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: signInData } = await signInClient.auth.signInWithPassword({ email, password });
  const token = signInData.session.access_token;

  try {
    // ── Auth requirements (all 6 new routes) ────────────────────
    const routes = [
      ['POST', '/api/setup/meta/tracking'],
      ['GET', '/api/setup/meta/tracking/health'],
      ['POST', '/api/setup/google/conversions'],
      ['GET', '/api/setup/google/conversions/Purchase/status'],
      ['POST', '/api/setup/pinterest/tag'],
      ['GET', '/api/setup/pinterest/tag/health'],
      ['POST', '/api/setup/tiktok/test-event'],
    ];
    for (const [method, path] of routes) {
      await record(`Auth required: ${method} ${path}`, async () => {
        const res = await fetch(BASE_URL + path, { method });
        assert.equal(res.status, 401);
      });
    }

    await record('POST /api/setup/google/conversions requires a name (400 without one)', async () => {
      const res = await fetch(BASE_URL + '/api/setup/google/conversions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 400);
    });

    await record('POST /api/setup/tiktok/test-event requires a pixelCode (400 without one)', async () => {
      const res = await fetch(BASE_URL + '/api/setup/tiktok/test-event', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 400);
    });

    // ── No platform connected -> real, honest error (never a fabricated 200) ──
    await record('POST /api/setup/meta/tracking with no Meta connection -> real error, not fabricated success', async () => {
      const res = await fetch(BASE_URL + '/api/setup/meta/tracking', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      assert.notEqual(res.status, 200);
      const body = await res.json();
      assert.ok(/not connected/i.test(body.error || ''));
    });

    await record('POST /api/setup/pinterest/tag with no Pinterest connection -> real error, not fabricated success', async () => {
      const res = await fetch(BASE_URL + '/api/setup/pinterest/tag', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      assert.notEqual(res.status, 200);
      const body = await res.json();
      assert.ok(/not connected/i.test(body.error || ''));
    });

    // ── Fake-but-connected token -> the real platform rejects it; must propagate honestly ──
    await record('POST /api/setup/meta/tracking with a fake token -> propagates a real Meta rejection, not fabricated pixel data', async () => {
      await supabaseAdmin.from('integrations').upsert({
        user_id: userId, provider: 'meta_ads', access_token: 'fake_meta_token_' + Date.now(),
        token_expiry: new Date(Date.now() + 3600000).toISOString(),
        active_ad_account: { account_id: 'act_fake123', account_name: 'Fake' },
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id,provider' });
      const res = await fetch(BASE_URL + '/api/setup/meta/tracking', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      assert.notEqual(res.status, 200, 'a fake Meta token must never produce a fabricated 200 pixel-created response');
    });

    await record('POST /api/setup/tiktok/test-event with a fake token -> honest sent:false or real error, never sent:true', async () => {
      await supabaseAdmin.from('integrations').upsert({
        user_id: userId, provider: 'tiktok_ads', access_token: 'fake_tiktok_token_' + Date.now(),
        token_expiry: new Date(Date.now() + 3600000).toISOString(),
        active_ad_account: { account_id: 'adv_fake123', account_name: 'Fake' },
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id,provider' });
      const res = await fetch(BASE_URL + '/api/setup/tiktok/test-event', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixelCode: 'fake_pixel', event: 'Purchase' }),
      });
      if (res.status === 200) {
        const body = await res.json();
        assert.equal(body.sent, false, 'a fake pixel code must never report sent:true');
      } else {
        assert.notEqual(res.status, 200);
      }
    });
  } finally {
    try { await supabaseAdmin.from('integrations').delete().eq('user_id', userId); } catch (_) {}
    try { await supabaseAdmin.from('profiles').delete().eq('id', userId); } catch (_) {}
    try { await supabaseAdmin.auth.admin.deleteUser(userId); } catch (_) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks run, ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
}

main().catch(e => { console.error('CRASH:', e); process.exit(1); });
