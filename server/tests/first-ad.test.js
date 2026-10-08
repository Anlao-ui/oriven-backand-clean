// ════════════════════════════════════════════════════════════════
// Free first ad — one free ad image for a new Free account, through the
// REAL /api/generate-image (paid-action guard, credits, settlement), with
// the AI provider mocked. The claim lives in free_first_ad_claims (backend
// only), never on profiles. Off by default; turned on per section here.
// RUN: node tests/first-ad.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5599, env: {} });
const { check, log, done } = reporter();
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const claim = (id) => H.rows('free_first_ad_claims').find((c) => c.user_id === id) || { claimed_at: null, attempts: 0, none: true };
const NEW = new Date().toISOString(), OLD = '2026-05-01T00:00:00Z';
let provider = { fail: 0, calls: 0, delay: 0 };
H.net.handler = async (url) => {
  if (!/api\.aimlapi\.com\/v1\/images\/generations/.test(url)) return null;
  provider.calls++;
  if (provider.delay) await new Promise((r) => setTimeout(r, provider.delay));
  if (provider.fail > 0) { provider.fail--; return new Response(JSON.stringify({ error: { message: 'model error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.invalid/ad.png' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
let keyN = 0;
const img = (tok) => H.call('POST', '/api/generate-image', tok, { prompt: 'coffee bag on a table', size: '1024x1024' }, { 'X-Idempotency-Key': 'k' + (++keyN) });
function user(id, plan, created) {
  H.rows('profiles').push({ id, subscription_status: plan, created_at: created, credits_balance: plan === 'free' ? 10 : 1000,
    credits_cycle_end: new Date(Date.now() + 864e5).toISOString(), onboarding_completed: true });
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: created };
}

(async () => {
  await H.start();
  const firstAd = require(H.SERVER_DIR + '/services/firstAd.js');

  log('\nA. Off by default');
  user('nf1', 'free', NEW);
  let r = await img('tok_nf1');
  check('flag off: new Free account image → 402 (normal credit rules)', r.status === 402 && r.body.code === 'CREDITS_EXHAUSTED', r);
  check('flag off: nothing claimed, no provider call', claim('nf1').none && provider.calls === 0);
  let st = await H.call('GET', '/api/onboarding/state', 'tok_nf1');
  check('flag off: state says not available', st.body.freeFirstAd && st.body.freeFirstAd.available === false, st.body);

  process.env.FREE_FIRST_AD_ENABLED = 'true';
  log('\nB. Enabled: one free image for a new Free account');
  st = await H.call('GET', '/api/onboarding/state', 'tok_nf1');
  check('state says available', st.body.freeFirstAd.available === true);
  r = await img('tok_nf1');
  check('first image → 200, real image', r.status === 200 && r.body.imageUrl === 'https://cdn.example.invalid/ad.png', r);
  check('claim stored in free_first_ad_claims (timestamp + 1 attempt), no credits charged', !!claim('nf1').claimed_at && claim('nf1').attempts === 1 && prof('nf1').credits_balance === 10, claim('nf1'));
  r = await img('tok_nf1');
  check('second image (regenerate / another ad) → 402, normal rules', r.status === 402);
  check('exactly one provider call for the free image', provider.calls === 1, provider.calls);
  st = await H.call('GET', '/api/onboarding/state', 'tok_nf1');
  check('state now says used', st.body.freeFirstAd.available === false);

  log('\nC. Parallel requests (multi-ad build, double click, two tabs)');
  user('nf2', 'free', NEW);
  provider.delay = 150; const before = provider.calls;
  const par = await Promise.all([img('tok_nf2'), img('tok_nf2'), img('tok_nf2')]);
  provider.delay = 0;
  check('exactly one 200, the others 402 or refused by the paid-action guard', par.filter((x) => x.status === 200).length === 1 && par.every((x) => [200, 402, 409, 429].includes(x.status)), par.map((x) => x.status));
  check('one provider call, one claims row, attempts 1', provider.calls - before === 1 && claim('nf2').attempts === 1 && H.rows('free_first_ad_claims').filter((c) => c.user_id === 'nf2').length === 1);

  log('\nD. Provider failure → claim released, capped retries');
  user('nf3', 'free', NEW);
  provider.fail = 5; // more than the provider's own retries
  r = await img('tok_nf3');
  check('failed image → error, claim released, attempt counted', r.status >= 500 && claim('nf3').claimed_at === null && claim('nf3').attempts === 1, { s: r.status, c: claim('nf3') });
  provider.fail = 0;
  r = await img('tok_nf3');
  check('retry → 200 (second attempt)', r.status === 200 && claim('nf3').attempts === 2 && !!claim('nf3').claimed_at);
  user('nf4', 'free', NEW);
  provider.fail = 100;
  await img('tok_nf4'); await img('tok_nf4');
  check('two failures → both attempts used', claim('nf4').attempts === 2 && claim('nf4').claimed_at === null);
  provider.fail = 0;
  const c4 = provider.calls;
  r = await img('tok_nf4');
  check('third request → 402, no more free attempts, no provider call', r.status === 402 && provider.calls === c4);
  check('credits never touched for free claims', ['nf1', 'nf2', 'nf3', 'nf4'].every((id) => prof(id).credits_balance === 10));

  log('\nE. Who is NOT eligible');
  user('of1', 'free', OLD);
  r = await img('tok_of1');
  check('existing (pre-rollout) Free account → 402, nothing claimed', r.status === 402 && claim('of1').none);
  user('np1', 'starter', NEW);
  r = await img('tok_np1');
  check('new paid account → charged normally (1000 → 925), no claim', r.status === 200 && prof('np1').credits_balance === 925 && claim('np1').none, prof('np1'));

  log('\nF. Migration not applied');
  H.MISSING.free_first_ad_claims = 'table';
  user('nf5', 'free', NEW);
  r = await img('tok_nf5');
  check('flag on but claims table missing → normal 402, no crash, no free image', r.status === 402);
  st = await H.call('GET', '/api/onboarding/state', 'tok_nf5');
  check('state says not available', st.status === 200 && st.body.freeFirstAd.available === false);
  delete H.MISSING.free_first_ad_claims;

  log('\nG. Claims live outside profiles');
  check('no free-ad field was ever written to profiles', !H.writes.some(([t, , p]) => t === 'profiles' && p && Object.keys(p).some((k) => /free_first_ad/.test(k))));
  check('at most one claims row per account', H.rows('free_first_ad_claims').length === new Set(H.rows('free_first_ad_claims').map((c) => c.user_id)).size);

  log('\nH. Rules (pure)');
  check('max attempts is 2', firstAd.MAX_ATTEMPTS === 2);
  check('paid plan never eligible', firstAd.eligibility({ subscription_status: 'creator', created_at: NEW }, null).available === false);
  check('used claim never eligible', firstAd.eligibility({ subscription_status: 'free', created_at: NEW }, { claimed_at: NEW, attempts: 1 }).available === false);
  check('no outbound network except the mocked provider', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
