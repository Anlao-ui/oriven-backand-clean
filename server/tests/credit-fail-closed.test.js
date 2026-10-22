// ════════════════════════════════════════════════════════════════
// Credit checks fail CLOSED. When the credit reservation itself errors
// (database / RPC outage — not "insufficient credits", which answers 402),
// a paid action must not run uncharged: the route answers 503
// CREDIT_CHECK_FAILED and no provider (AI, video) is contacted.
// Control: with a healthy credit RPC the same request is charged, and when
// the (blocked) provider then fails, the charge is refunded.
//
// Runs the REAL server.js through tests/helpers/mockServer.js: Supabase,
// Stripe, SMTP and cron are in-memory mocks and every outbound request is
// blocked. No .env, no real users, no provider calls, no charges.
// RUN: node tests/credit-fail-closed.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5631 });
const { check, log, done } = reporter();

const USER = { id: '00000000-0000-4000-8000-00000000c0de', email: 'credits@example.invalid' };
const TOK = 'tok_credit_fail_closed';

const CASES = [
  ['POST', '/api/generate-ugc-video', { script: 'A linen shirt for warm evenings.' }, 'Create · video (UGC)'],
  ['POST', '/api/video-ads/generate', { mode: 'script', script: 'A linen shirt for warm evenings.', prompt: 'A linen shirt for warm evenings.', length: '5' }, 'Create · video ad'],
  ['POST', '/api/generate-campaign', { prompt: 'Light linen shirts for adults 25-45', goal: 'Sales', platform: 'meta' }, 'Create · campaign'],
  ['POST', '/api/ai/create-ad', { product: 'Linen shirts', description: 'Light linen shirts for summer', platform: 'meta', goal: 'Sales' }, 'Create · ad'],
  ['POST', '/api/creative/improve', { text: 'Linen shirts — light and breathable.', action: 'premium', platform: 'meta' }, 'Create · improve creative'],
  ['POST', '/api/creative/variations', { kind: 'headline', seed: 'Linen shirts — light and breathable.', count: 3 }, 'Create · creative variations'],
  ['POST', '/api/ai/chat', { message: 'How are my campaigns doing?', messages: [{ role: 'user', content: 'How are my campaigns doing?' }] }, 'Oriven Chat'],
];

(async () => {
  const quiet = await H.start();
  H.rows('profiles').push({ id: USER.id, email: USER.email, subscription_status: 'creator', credits_balance: 5000, onboarding_completed: true });
  H.TOKENS[TOK] = USER;
  let seq = 0;
  const send = (m, p, b) => H.call(m, p, TOK, b, { 'X-Idempotency-Key': 'cfc-' + (++seq) + '-' + Date.now() });

  log('\nA. Credit RPC down → nothing runs, nothing is charged');
  H.RPC.fail = (name) => name === 'spend_credits';
  for (const [m, p, b, label] of CASES) {
    H.net.blocked.length = 0;
    const before = H.rows('profiles')[0].credits_balance;
    const r = await send(m, p, b);
    check(label + ': ' + p + ' answers 503 CREDIT_CHECK_FAILED', r.status === 503 && r.body && r.body.code === 'CREDIT_CHECK_FAILED', { status: r.status, body: r.body });
    check(label + ': says nothing was charged', /nothing was charged/i.test(String(r.body && r.body.error)), r.body);
    check(label + ': no provider was contacted', H.net.blocked.length === 0, H.net.blocked.slice(0, 3));
    check(label + ': balance unchanged', H.rows('profiles')[0].credits_balance === before);
  }

  log('\nB. Control — credit RPC healthy: the video job is charged, then refunded when the provider fails');
  H.RPC.fail = null;
  H.net.blocked.length = 0;
  const startBal = H.rows('profiles')[0].credits_balance;
  const calls0 = H.rpcCalls.length;
  const r2 = await send('POST', '/api/generate-ugc-video', CASES[0][2]);
  const rpcs = H.rpcCalls.slice(calls0);
  check('credit was reserved before the provider call (spend_credits)', rpcs.includes('spend_credits'), rpcs);
  check('the provider was actually attempted (blocked in this test)', H.net.blocked.length > 0, r2);
  check('the failed generation is not reported as a success', r2.status >= 400, { status: r2.status, body: r2.body });
  await new Promise((res) => setTimeout(res, 300));
  check('the charge was refunded (refund_credits) — balance back to where it started', H.rpcCalls.slice(calls0).includes('refund_credits') && H.rows('profiles')[0].credits_balance === startBal, { rpcs: H.rpcCalls.slice(calls0), bal: H.rows('profiles')[0].credits_balance, startBal });

  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
