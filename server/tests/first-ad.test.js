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
// Launch cutoff for the enabled sections: one hour before the test accounts.
const LAUNCH = new Date(Date.now() - 3600e3).toISOString();
// [FirstAd] log lines, checked in section I (privacy + coverage).
const FA_LOG = [];
let provider = { fail: 0, calls: 0, delay: 0 };
H.net.handler = async (url) => {
  if (!/api\.aimlapi\.com\/v1\/images\/generations/.test(url)) return null;
  provider.calls++;
  if (provider.delay) await new Promise((r) => setTimeout(r, provider.delay));
  if (provider.fail > 0) { provider.fail--; return new Response(JSON.stringify({ error: { message: 'model error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  return new Response(JSON.stringify(Object.assign({ data: [{ url: 'https://cdn.example.invalid/ad.png' }] }, provider.usage ? { usage: provider.usage } : {})), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  // (after start(): it silences the console while the server boots)
  for (const lvl of ['log', 'warn']) { const orig = console[lvl]; console[lvl] = function () { const s = Array.prototype.join.call(arguments, ' '); if (s.indexOf('[FirstAd]') === 0) FA_LOG.push(s); return orig.apply(console, arguments); }; }
  const firstAd = require(H.SERVER_DIR + '/services/firstAd.js');

  log('\nA. Off by default');
  user('nf1', 'free', NEW);
  let r = await img('tok_nf1');
  check('flag off: new Free account image → 402 (normal credit rules)', r.status === 402 && r.body.code === 'CREDITS_EXHAUSTED', r);
  check('flag off: nothing claimed, no provider call', claim('nf1').none && provider.calls === 0);
  let st = await H.call('GET', '/api/onboarding/state', 'tok_nf1');
  check('flag off: state says not available', st.body.freeFirstAd && st.body.freeFirstAd.available === false, st.body);

  process.env.FREE_FIRST_AD_ENABLED = 'true';
  process.env.FREE_FIRST_AD_SINCE = LAUNCH;
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
  log('\nH. Onboarding stage — server data only (welcome → first ad → plan step)');
  const fresh = (id) => { user(id, 'free', NEW); prof(id).onboarding_completed = false; prof(id).primary_goal = null; };
  fresh('st1');
  st = await H.call('GET', '/api/onboarding/state', 'tok_st1');
  check('new Free account, no choice yet → stage welcome, free ad available', st.body.stage === 'welcome' && st.body.eligible === true && st.body.freeFirstAd.available === true && st.body.freeFirstAd.used === false, st.body);
  r = await H.call('PUT', '/api/onboarding/goal', 'tok_st1', { goal: 'create' });
  st = await H.call('GET', '/api/onboarding/state', 'tok_st1');
  check('"Create Your First Ad" saves the goal WITHOUT completing onboarding → stage first_ad', r.status === 200 && prof('st1').onboarding_completed === false && st.body.stage === 'first_ad' && st.body.eligible === true, [r.status, st.body]);
  check('…and grants nothing (no claim, credits untouched)', claim('st1').none && prof('st1').credits_balance === 10);
  const st2 = await H.call('GET', '/api/onboarding/state', 'tok_st1');
  check('refresh / sign-in again / other device: same stage from the server', st2.body.stage === 'first_ad');
  const c0 = provider.calls;
  r = await img('tok_st1');
  st = await H.call('GET', '/api/onboarding/state', 'tok_st1');
  check('free image generated → stage choose_plan, free ad used (0 credits)', r.status === 200 && st.body.stage === 'choose_plan' && st.body.freeFirstAd.used === true && st.body.freeFirstAd.available === false && prof('st1').credits_balance === 10, st.body);
  r = await img('tok_st1');
  check('another image after a refresh → normal credit rules (402), no provider call', r.status === 402 && provider.calls === c0 + 1);
  const dupKey = { 'X-Idempotency-Key': 'dup-key-1' };
  fresh('st3'); await H.call('PUT', '/api/onboarding/goal', 'tok_st3', { goal: 'create' });
  const d1 = await H.call('POST', '/api/generate-image', 'tok_st3', { prompt: 'p', size: '1024x1024' }, dupKey);
  const c1 = provider.calls;
  const d2 = await H.call('POST', '/api/generate-image', 'tok_st3', { prompt: 'p', size: '1024x1024' }, dupKey);
  check('duplicate submission (same idempotency key) → 409, no second provider call', d1.status === 200 && d2.status === 409 && provider.calls === c1, [d1.status, d2.status]);
  r = await H.call('POST', '/api/onboarding/complete', 'tok_st1', { goal: 'create' });
  st = await H.call('GET', '/api/onboarding/state', 'tok_st1');
  check('Free chosen → onboarding complete → stage done', r.status === 200 && st.body.stage === 'done' && st.body.eligible === false);
  // the image fails twice → plan step anyway (no free-generation loop)
  fresh('st4'); await H.call('PUT', '/api/onboarding/goal', 'tok_st4', { goal: 'create' });
  provider.fail = 2; await img('tok_st4'); await img('tok_st4'); provider.fail = 0;
  st = await H.call('GET', '/api/onboarding/state', 'tok_st4');
  check('two failed images → stage choose_plan (no free loop), credits untouched', st.body.stage === 'choose_plan' && claim('st4').attempts === 2 && prof('st4').credits_balance === 10, st.body);
  // one failure → still first_ad, can retry
  fresh('st5'); await H.call('PUT', '/api/onboarding/goal', 'tok_st5', { goal: 'create' });
  provider.fail = 1; await img('tok_st5'); provider.fail = 0;
  st = await H.call('GET', '/api/onboarding/state', 'tok_st5');
  check('one failed image → still first_ad, free image available again (safe retry)', st.body.stage === 'first_ad' && st.body.freeFirstAd.available === true && !st.body.onboarding_completed, st.body);
  // explore, paid, existing, flag off
  fresh('st6'); await H.call('PUT', '/api/onboarding/goal', 'tok_st6', { goal: 'business' });
  st = await H.call('GET', '/api/onboarding/state', 'tok_st6');
  check('other goals never enter the first-ad stage', st.body.stage === 'welcome');
  user('st7', 'starter', NEW); prof('st7').onboarding_completed = false; prof('st7').primary_goal = 'create';
  st = await H.call('GET', '/api/onboarding/state', 'tok_st7');
  check('new paid account: never first_ad (no free ad on paid plans)', st.body.stage === 'welcome' && st.body.freeFirstAd.available === false);
  user('st8', 'free', OLD); prof('st8').onboarding_completed = false; prof('st8').primary_goal = 'create';
  st = await H.call('GET', '/api/onboarding/state', 'tok_st8');
  check('existing (pre-rollout) account: stage done, no free ad', st.body.stage === 'done' && st.body.freeFirstAd.available === false);
  process.env.FREE_FIRST_AD_ENABLED = '';
  fresh('st9'); prof('st9').primary_goal = 'create';
  st = await H.call('GET', '/api/onboarding/state', 'tok_st9');
  check('flag off: a "create" choice falls back to the welcome/plan step (no first_ad)', st.body.stage === 'welcome' && st.body.freeFirstAd.available === false);
  process.env.FREE_FIRST_AD_ENABLED = 'true';
  const onb = require(H.SERVER_DIR + '/services/onboarding.js');
  check('stage(): pure rules', onb.stage({ eligible: false }, {}) === 'done' && onb.stage({ eligible: true, goal: 'create', plan: 'free' }, { available: true }) === 'first_ad'
    && onb.stage({ eligible: true, goal: 'create', plan: 'free' }, { reason: 'used' }) === 'choose_plan' && onb.stage({ eligible: true, goal: 'create', plan: 'creator' }, { available: true }) === 'welcome'
    && onb.stage({ eligible: true, goal: null, plan: 'free' }, { available: true }) === 'welcome');

  log('\nI. Launch cutoff (FREE_FIRST_AD_SINCE) — accounts from before the launch never qualify');
  // An account created after the onboarding rollout but BEFORE the feature launch
  // (like the 3 production accounts), and one created after the launch.
  const PRE = new Date(Date.now() - 2 * 3600e3).toISOString();   // 2h ago, before LAUNCH (1h ago)
  const POST = new Date(Date.now() - 1800e3).toISOString();      // 30 min ago, after LAUNCH
  user('pre1', 'free', PRE); prof('pre1').onboarding_completed = false;
  user('post1', 'free', POST); prof('post1').onboarding_completed = false;
  let sPre = await H.call('GET', '/api/onboarding/state', 'tok_pre1');
  let sPost = await H.call('GET', '/api/onboarding/state', 'tok_post1');
  check('pre-launch account (post-rollout): not available → frontend shows plan-first flow', sPre.body.freeFirstAd.available === false && sPre.body.stage === 'welcome', sPre.body);
  check('post-launch account: available', sPost.body.freeFirstAd.available === true, sPost.body);
  const cPre = provider.calls;
  r = await img('tok_pre1');
  check('pre-launch account image → normal credit rules (402), no claim, no provider call', r.status === 402 && claim('pre1').none && provider.calls === cPre);
  await H.call('PUT', '/api/onboarding/goal', 'tok_pre1', { goal: 'create' });
  sPre = await H.call('GET', '/api/onboarding/state', 'tok_pre1');
  check('pre-launch account choosing "create" still gets no free ad (stage stays welcome)', sPre.body.stage === 'welcome' && sPre.body.freeFirstAd.available === false);
  provider.usage = { input_tokens: 120, output_tokens: 1056, total_tokens: 1176 };
  r = await img('tok_post1');
  provider.usage = null;
  check('post-launch account → free image, 0 credits, one claim', r.status === 200 && claim('post1').attempts === 1 && prof('post1').credits_balance === 10);
  check('cutoff boundary: created exactly at launch qualifies, 1 ms before does not',
    firstAd.eligibility({ subscription_status: 'free', created_at: LAUNCH }, null).available === true &&
    firstAd.eligibility({ subscription_status: 'free', created_at: new Date(Date.parse(LAUNCH) - 1).toISOString() }, null).available === false);
  const savedCut = process.env.FREE_FIRST_AD_SINCE;
  delete process.env.FREE_FIRST_AD_SINCE;
  user('post2', 'free', NEW);
  let s2 = await H.call('GET', '/api/onboarding/state', 'tok_post2');
  const cNo = provider.calls; r = await img('tok_post2');
  check('flag on but NO cutoff set → nobody qualifies (fail closed)', s2.body.freeFirstAd.available === false && r.status === 402 && provider.calls === cNo && firstAd.eligibility({ subscription_status: 'free', created_at: NEW }, null).reason === 'no_launch_cutoff');
  process.env.FREE_FIRST_AD_SINCE = 'not-a-date';
  check('invalid cutoff → nobody qualifies', firstAd.eligibility({ subscription_status: 'free', created_at: NEW }, null).available === false);
  process.env.FREE_FIRST_AD_SINCE = '2026-01-01T00:00:00Z';
  check('a cutoff earlier than the onboarding rollout never re-opens historical accounts', firstAd.eligibility({ subscription_status: 'free', created_at: OLD }, null).available === false
    && firstAd.eligibility({ subscription_status: 'free', created_at: '2026-09-01T00:00:00Z' }, null).available === false);
  process.env.FREE_FIRST_AD_SINCE = savedCut;
  check('normal Free credits untouched for every account in this suite', ['pre1', 'post1', 'post2'].every((id) => prof(id).credits_balance === 10));

  log('\nJ. Logging (no personal data, no keys)');
  const ev = FA_LOG.map((l) => { try { return JSON.parse(l.replace('[FirstAd] ', '')); } catch (_) { return { event: 'unparsed', raw: l }; } });
  const has = (e) => ev.some((x) => x.event === e);
  check('logged: claimed, succeeded, failed_released, duplicate_blocked, attempts_exhausted', ['claimed', 'succeeded', 'failed_released', 'duplicate_blocked', 'attempts_exhausted'].every(has), [...new Set(ev.map((x) => x.event))]);
  const succ = ev.filter((x) => x.event === 'succeeded');
  check('success lines carry model, attempt, duration and a cost estimate', succ.length >= 1 && succ.every((x) => x.model && x.attempt >= 1 && typeof x.durationMs === 'number' && typeof x.estCostUsd === 'number'), succ[0]);
  check('provider-reported image tokens logged when the provider sends them', succ.some((x) => x.tokensReported === true && x.imageTokens === 1056 && x.totalTokens === 1176), succ.map((x) => [x.imageTokens, x.tokensReported]));
  const fails = ev.filter((x) => x.event === 'failed_released');
  check('failure lines say how many free attempts remain', fails.length >= 1 && fails.every((x) => typeof x.attemptsLeft === 'number'));
  const ids = H.rows('profiles').map((p) => p.id);
  check('no user id, email, token, key or prompt in any [FirstAd] line', FA_LOG.length > 0 && FA_LOG.every((l) => !ids.some((id) => l.includes('"' + id + '"') || l.includes(' ' + id)) && !/@|tok_|re_test|Bearer|coffee bag/.test(l)), FA_LOG.slice(0, 3));
  check('accounts appear as a short stable hash (same account → same hash)', ev.every((x) => !x.acct || /^[a-f0-9]{12}$/.test(x.acct)) && firstAd._acct('post1') === firstAd._acct('post1') && firstAd._acct('post1') !== firstAd._acct('pre1'));

  check('max attempts is 2', firstAd.MAX_ATTEMPTS === 2);
  check('paid plan never eligible', firstAd.eligibility({ subscription_status: 'creator', created_at: NEW }, null).available === false);
  check('used claim never eligible', firstAd.eligibility({ subscription_status: 'free', created_at: NEW }, { claimed_at: NEW, attempts: 1 }).available === false);
  check('no outbound network except the mocked provider', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
