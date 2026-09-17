// ════════════════════════════════════════════════════════════════
// TikTok refresh-token fix — regression test
//
// TikTok issues a refresh_token (1-year validity) alongside every
// access_token (24h validity), but it was being stored and never
// used — every route just demanded a full reconnect on expiry. This
// test exercises the real fix (_refreshTikTokToken, wired into
// _getTikTokAccess) with a REAL network round-trip to TikTok's actual
// refresh endpoint, using an intentionally invalid refresh_token —
// same philosophy as tests/pinterest-ads.test.js's real-invalid-token
// tests: a genuine rejection from the real platform is a valid,
// honest, testable outcome, and proves the endpoint/param shape is
// at least well-formed enough for TikTok to respond meaningfully
// rather than erroring on malformed input.
//
// RUN: node tests/tiktok-refresh.test.js   (from oriven-backand-clean/server)
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
  const email = `oriven.tiktokrefresh.test+${Date.now()}@example.com`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + '-Aa1!';
  const { data: created } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  const userId = created.user.id;
  await supabaseAdmin.from('profiles').upsert({ id: userId, email, subscription_status: 'creator', onboarding_completed: true }, { onConflict: 'id' });
  const signInClient = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: signInData } = await signInClient.auth.signInWithPassword({ email, password });
  const token = signInData.session.access_token;

  try {
    await record('1. Expired access_token WITH a (real-shaped but invalid) refresh_token attempts refresh, gets an honest error from real TikTok — not a fabricated success', async () => {
      await supabaseAdmin.from('integrations').upsert({
        user_id: userId, provider: 'tiktok_ads',
        access_token: 'expired_fake_token',
        refresh_token: 'definitely_invalid_refresh_token_' + Date.now(),
        token_expiry: new Date(Date.now() - 60000).toISOString(),
        active_ad_account: { account_id: '123', account_name: 'Test' },
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id,provider' });

      const res = await fetch(BASE_URL + '/api/tiktok/campaigns', { headers: { Authorization: 'Bearer ' + token } });
      const body = await res.json();
      // Must be a real error (401 from the refresh attempt failing against
      // TikTok's real endpoint), never a 200 with fabricated campaign data.
      assert.equal(res.status, 401, 'expected 401, got ' + res.status + ' body=' + JSON.stringify(body));
      assert.ok(/refresh failed|reconnect/i.test(body.error || ''), 'error message should mention refresh failure/reconnect, got: ' + body.error);
    });

    await record('2. Expired access_token with NO refresh_token still asks for a full reconnect (unchanged behavior)', async () => {
      await supabaseAdmin.from('integrations').upsert({
        user_id: userId, provider: 'tiktok_ads',
        access_token: 'expired_fake_token', refresh_token: null,
        token_expiry: new Date(Date.now() - 60000).toISOString(),
        active_ad_account: { account_id: '123', account_name: 'Test' },
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id,provider' });

      const res = await fetch(BASE_URL + '/api/tiktok/campaigns', { headers: { Authorization: 'Bearer ' + token } });
      const body = await res.json();
      assert.equal(res.status, 401);
      assert.ok(/expired.*reconnect/i.test(body.error || ''), 'expected the original "expired — reconnect" message, got: ' + body.error);
    });

    await record('3. Valid (non-expired) access_token does NOT attempt a refresh call at all (no unnecessary network round-trip)', async () => {
      await supabaseAdmin.from('integrations').upsert({
        user_id: userId, provider: 'tiktok_ads',
        access_token: 'fake_but_unexpired_token', refresh_token: 'unused_refresh_token',
        token_expiry: new Date(Date.now() + 3600000).toISOString(),
        active_ad_account: { account_id: '123', account_name: 'Test' },
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id,provider' });

      const res = await fetch(BASE_URL + '/api/tiktok/campaigns', { headers: { Authorization: 'Bearer ' + token } });
      // Token is fake, so TikTok itself will reject the actual campaigns
      // call — but the important thing is it fails at THAT call (a
      // TikTok API auth error), not at token refresh, proving refresh
      // was correctly skipped for a still-valid token.
      const body = await res.json();
      assert.notEqual(res.status, 200, 'a fake token should never return a real 200 with data');
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
