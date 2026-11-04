// ════════════════════════════════════════════════════════════════
// Free first ad — RETIRED with the paid-only model (2026-10-30). This suite
// proves the retirement holds through the REAL /api/generate-image and
// /api/onboarding/* routes, even with the old FREE_FIRST_AD_* flags switched
// on: an account without access gets no free image (403, no provider call,
// no claim), a paying account is charged normally, and onboarding never
// offers the free ad. Existing free_first_ad_claims rows are left alone.
// RUN: node tests/first-ad.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const FC = require('../services/pricing').FEATURE_COSTS;
const H = boot({ port: 5599, env: {} });
const { check, log, done } = reporter();
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const claims = (id) => H.rows('free_first_ad_claims').filter((c) => c.user_id === id);
const NEW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 20 * 864e5).toISOString();
let provider = { calls: 0 };
H.net.handler = async (url) => {
  if (!/api\.aimlapi\.com\/v1\/images\/generations/.test(url)) return null;
  provider.calls++;
  return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.invalid/ad.png' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
let keyN = 0;
const img = (tok) => H.call('POST', '/api/generate-image', tok, { prompt: 'coffee bag on a table', size: '1024x1024' }, { 'X-Idempotency-Key': 'k' + (++keyN) });
function user(id, status, extra) {
  H.rows('profiles').push(Object.assign({ id, subscription_status: status, created_at: NEW, credits_balance: status === 'free' ? 10 : 1000,
    credits_cycle_end: FUTURE, onboarding_completed: false, access_expires_at: status === 'free' ? null : FUTURE, access_plan: status === 'free' ? null : 'monthly' }, extra || {}));
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: NEW };
}

(async () => {
  await H.start();
  let r0;

  for (const [label, env] of [['flags off', {}], ['old flags switched on', { FREE_FIRST_AD_ENABLED: 'true', FREE_FIRST_AD_SINCE: new Date(Date.now() - 3600e3).toISOString() }]]) {
    log('\n' + label);
    Object.assign(process.env, env);
    const id = 'nf_' + label.replace(/\W+/g, '_');
    user(id, 'free');
    const calls0 = provider.calls;
    let r = await img('tok_' + id);
    // A new account without access is in the mandatory onboarding (server.js
    // onboarding gate): every non-onboarding route answers ONBOARDING_REQUIRED.
    check(`${label}: new account without access, image → 403 ONBOARDING_REQUIRED (mandatory onboarding first)`, r.status === 403 && r.body.code === 'ONBOARDING_REQUIRED', r);
    check(`${label}: no provider call, no claim, balance untouched`, provider.calls === calls0 && !claims(id).length && prof(id).credits_balance === 10);
    let st = await H.call('GET', '/api/onboarding/state', 'tok_' + id);
    check(`${label}: onboarding state says the free ad is not available (retired)`, st.status === 200 && st.body.freeFirstAd && st.body.freeFirstAd.available === false, st.body);
    r = await H.call('PUT', '/api/onboarding/goal', 'tok_' + id, { goal: 'create' });
    st = await H.call('GET', '/api/onboarding/state', 'tok_' + id);
    check(`${label}: "Create Your First Ad" saves the goal but never leads to a free-ad stage`, r.status === 200 && st.body.goal === 'create' && st.body.stage === 'welcome', { r: r.status, stage: st.body.stage, goal: st.body.goal });
  }

  log('\nExisting account without access (unchanged behaviour)');
  user('ef1', 'free', { created_at: '2026-01-01T00:00:00Z' });
  const callsE = provider.calls;
  r0 = await img('tok_ef1');
  check('account from before the rollout, no access, image → 403 SUBSCRIPTION_REQUIRED as before (not the onboarding gate)', r0.status === 403 && r0.body.code === 'SUBSCRIPTION_REQUIRED' && provider.calls === callsE && prof('ef1').credits_balance === 10, r0);

  log('\nPaying accounts');
  user('np1', 'paid');
  const calls0 = provider.calls;
  let r = await img('tok_np1');
  check('new account with a period plan → image generated, charged image_generation, no claim', r.status === 200 && provider.calls === calls0 + 1 && prof('np1').credits_balance === 1000 - FC.image_generation && !claims('np1').length, { s: r.status, bal: prof('np1').credits_balance });
  user('np2', 'paid', { access_expires_at: new Date(Date.now() - 864e5).toISOString() });
  r = await img('tok_np2');
  check('access ended → 403, nothing charged', r.status === 403 && prof('np2').credits_balance === 1000);

  log('\nExisting records');
  H.rows('free_first_ad_claims').push({ user_id: 'old1', claimed_at: '2026-10-20T10:00:00Z', attempts: 1 });
  user('old1', 'free');
  r = await img('tok_old1');
  check('an account with an old claim row → 403 like everyone without access; the claim row is kept', r.status === 403 && claims('old1').length === 1 && claims('old1')[0].attempts === 1);

  done();
})().catch((e) => { console.error(e); process.exit(1); });
