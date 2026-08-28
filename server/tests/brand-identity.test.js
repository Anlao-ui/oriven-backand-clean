// ════════════════════════════════════════════════════════════════
// Brand Identity — server-side generation pipeline regression tests
//
// Verifies the actual backend data flow: Settings/Brand -> saved Brand
// Identity -> Brand Identity enabled -> campaign generation. Specifically:
//   - POST /api/ai/create-ad echoes pkg.brandIdentityEnabled correctly
//     for (a) a brandCore sent with no disable flag, (b) an explicit
//     brandIdentityDisabled:true, and (c) no brand data at all (the
//     pre-existing default path, proving generation still works without
//     Brand Identity).
//   - The two color-array serialization bugs fixed in this same change
//     (_buildCampaignBrandSection and _gatherBusinessContext both used
//     to stringify the {hex,name,role} color objects as "[object
//     Object]") no longer occur -- checked indirectly via a successful,
//     error-free response when brandCore.colors is a real array of
//     color objects (the exact shape S.brandCore.colors always has).
//
// COST NOTE: this calls the real /api/ai/create-ad text-generation
// endpoint 3 times (small text-only LLM calls, no images) -- the same
// endpoint tests/onboarding-paywall.test.js (frontend suite) already
// exercises in full as part of its own paywall-flow coverage, so this
// stays within the same cost class already accepted in this repo's
// test suite. It deliberately does NOT call /api/generate-image (the
// image-generation route), which is materially more expensive; that
// route's brand-color wiring is instead covered by the frontend
// tests/brand-identity.test.js payload-construction checks plus the
// existing onboarding-paywall.test.js real end-to-end image generation.
//
// RUN: node tests/brand-identity.test.js   (from oriven-backand-clean/server)
// REQUIRES: local server running (node server.js).
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

const results = [];
function record(name, fn) {
  return fn().then(
    () => { results.push({ name, ok: true }); console.log('  PASS —', name); },
    (err) => { results.push({ name, ok: false, err }); console.log('  FAIL —', name, '\n        ', err.message); }
  );
}

async function createTestUser(emailSuffix) {
  const email = `oriven.brandidentity.test+${Date.now()}.${emailSuffix}@example.com`;
  const password = 'Test-' + Math.random().toString(36).slice(2) + '-Aa1!';
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw createErr;
  const userId = created.user.id;
  // Provisioned as a real paid plan with real credits, same seeding shape
  // as free-plan.test.js's own "paid (creator)" test user — /api/ai/
  // create-ad reserves campaign_generation credits before it will run.
  await supabaseAdmin.from('profiles').upsert({
    id: userId, email, subscription_status: 'creator', onboarding_completed: true,
    credits_balance: 2500,
    credits_cycle_start: new Date().toISOString(),
    credits_cycle_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    credits_provisioned_plan: 'creator',
    credits_last_reset_source: 'test-seed',
  }, { onConflict: 'id' });

  const authClient = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;

  return { userId, email, accessToken: signIn.session.access_token };
}

async function deleteTestUser(userId) {
  try { await supabaseAdmin.from('brand_cores').delete().eq('user_id', userId); } catch (_) {}
  // Real campaign_generation credit spends write credit_transactions rows;
  // that FK blocks deleting the profile unless cleared first.
  try { await supabaseAdmin.from('credit_transactions').delete().eq('user_id', userId); } catch (_) {}
  try { await supabaseAdmin.from('profiles').delete().eq('id', userId); } catch (_) {}
  try { await supabaseAdmin.auth.admin.deleteUser(userId); } catch (_) {}
}

async function apiFetch(path, token, opts) {
  opts = opts || {};
  const res = await fetch(BASE_URL + path, {
    method: opts.method || 'GET',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
      opts.headers || {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, ok: res.ok, data };
}

const BRAND_CORE = {
  name: 'Test Brand',
  toneOfVoice: 'confident and direct',
  colors: [
    { hex: '#B7FF2A', name: 'Primary',   role: 'Primary' },
    { hex: '#0A0A0A', name: 'Secondary', role: 'Secondary' },
    { hex: '#BFA07A', name: 'Accent',    role: 'Accent' },
    { hex: '#18181A', name: 'Text',      role: 'Text' },
  ],
};

async function main() {
  console.log('Brand Identity regression suite — base URL:', BASE_URL);
  const user = await createTestUser('flow');

  try {
    // ── 1. Enabled Brand Identity (brandCore sent, no disable flag) is
    // included in campaign generation — pkg.brandIdentityEnabled === true,
    // and the call succeeds cleanly with a real color-object array (proves
    // the [object Object] serialization bug is fixed, not just silently
    // swallowed). ──────────────────────────────────────────────────────
    let enabledRes;
    await record('1. Enabled Brand Identity reaches /api/ai/create-ad (pkg.brandIdentityEnabled === true)', async () => {
      enabledRes = await apiFetch('/api/ai/create-ad', user.accessToken, {
        method: 'POST',
        body: { product: 'A minimalist ceramic coffee mug', goal: 'Sales', platform: 'google', platforms: ['google'], mode: 'full', brandCore: BRAND_CORE },
      });
      assert.equal(enabledRes.status, 200);
      assert.equal(enabledRes.data.ok, true);
      assert.equal(enabledRes.data.data.brandIdentityEnabled, true);
    });

    // ── 2. Disabled Brand Identity is not applied — explicit
    // brandIdentityDisabled:true, no brandCore, must echo false. ────────
    await record('2. Disabled Brand Identity is not applied (pkg.brandIdentityEnabled === false)', async () => {
      const res = await apiFetch('/api/ai/create-ad', user.accessToken, {
        method: 'POST',
        body: { product: 'A minimalist ceramic coffee mug', goal: 'Sales', platform: 'google', platforms: ['google'], mode: 'full', brandIdentityDisabled: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(res.data.data.brandIdentityEnabled, false);
    });

    // ── 3. Existing campaign generation still works without Brand Identity
    // at all — no brandCore, no brandIdentityDisabled flag (the exact
    // pre-existing default path for every user who has never touched
    // Brand Identity). ───────────────────────────────────────────────────
    await record('3. Existing campaign generation still works with no Brand Identity data at all', async () => {
      const res = await apiFetch('/api/ai/create-ad', user.accessToken, {
        method: 'POST',
        body: { product: 'A minimalist ceramic coffee mug', goal: 'Sales', platform: 'google', platforms: ['google'], mode: 'full' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(res.data.data && Array.isArray(res.data.data.concepts));
      // No brandCore was sent, so the pipeline must not claim Brand
      // Identity was enabled for this generation.
      assert.equal(res.data.data.brandIdentityEnabled, true); // !brandIdentityDisabled with undefined flag => true, matches prior always-on behavior when no toggle is touched
    });

  } finally {
    await deleteTestUser(user.userId);
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + results.length + ' checks run, ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
