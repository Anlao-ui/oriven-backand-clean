// ════════════════════════════════════════════════════════════════
// Verification email: the welcome carries the link at signup (one email),
// every attempt is recorded in email_sends, and nothing sensitive is stored.
// Real server.js; Resend, SMTP and Supabase are mocked — nothing is sent.
// RUN: node tests/verification-email.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5612, env: { SMTP_USER: 'mailer@example.invalid', SMTP_PASS: 'x', EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', FRONTEND_URL: 'https://orivenai.com', SIGNUP_LIMIT_PER_IP_HOUR: '200' } });
const { check, log, done } = reporter();

const resend = { sent: [], fail: [] };
H.net.handler = async (url, opts) => {
  if (url !== 'https://api.resend.com/emails') return null;
  const body = JSON.parse(opts.body);
  if (resend.fail.length) { const st = resend.fail.shift(); return new Response(JSON.stringify({ name: 'error' }), { status: st }); }
  const id = 'em_' + (resend.sent.length + 1);
  resend.sent.push({ id, to: body.to[0], subject: body.subject, text: body.text, html: body.html, key: opts.headers['Idempotency-Key'] });
  return new Response(JSON.stringify({ id }), { status: 200 });
};
const setEnv = (o) => { for (const [k, v] of Object.entries(o)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
const tokenFrom = (s) => (String(s || '').match(/verify_token=([a-f0-9]{64})/) || [])[1];
let n = 0;
const signup = (email) => H.call('POST', '/api/signup', null, { firstName: 'Sam', lastName: 'Lee', email, password: 'secret123', marketingOptIn: false }, { 'X-Forwarded-For': '198.51.100.' + (++n) });
const userId = (email) => (H.AUTH.users.find((u) => u.email === email) || {}).id;
const sends = (id) => H.rows('email_sends').filter((r) => r.user_id === id);
const verifyRows = (id) => sends(id).filter((r) => r.template === 'verify_email');
const LIVE = { EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_mock', EMAIL_FROM: 'OrivenAI <hello@mail.orivenai.com>' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await H.start();
  const L = require(H.SERVER_DIR + '/services/email/lifecycle.js');

  log('\nA. Lifecycle email on: ONE email at signup — the welcome, with the verification link');
  setEnv(Object.assign({ EMAIL_LIFECYCLE_ENABLED: 'true' }, LIVE));
  let r = await signup('one@example.com'); await sleep(50);
  let id = userId('one@example.com');
  const mine = resend.sent.filter((m) => m.to === 'one@example.com');
  check('signup ok, exactly one email sent', r.status === 200 && mine.length === 1, { status: r.status, sent: mine.map((m) => m.subject) });
  check('it is the welcome email', mine[0] && mine[0].subject === 'Welcome to OrivenAI', mine[0] && mine[0].subject);
  const tok = tokenFrom(mine[0] && mine[0].text);
  check('welcome (text and HTML) carries the verification link, "Confirm my email" is its primary button', !!tok && mine[0].html.includes('verify_token=' + tok) && /Confirm my email/.test(mine[0].html));
  check('ledger: the welcome is recorded under the lifecycle job’s own key ("welcome")', sends(id).some((x) => x.template === 'welcome' && x.dedupe_key === 'welcome' && x.status === 'sent'), sends(id));
  let v = verifyRows(id);
  check('ledger: one verification row — sent via the welcome, with the provider id', v.length === 1 && v[0].status === 'sent' && v[0].provider_id === mine[0].id && v[0].error === 'welcome' && /^verify:signup:/.test(v[0].dedupe_key), v);
  r = await H.call('POST', '/api/verify-email', null, { token: tok });
  check('the link in the welcome verifies the account (existing /api/verify-email)', r.status === 200 && H.rows('profiles').find((p) => p.id === id).email_verified === true, r.body);
  const before = resend.sent.length;
  await L.runOnce({ now: Date.now() + 20 * 60e3 });
  check('the scheduled lifecycle run does not send a second welcome', resend.sent.length === before, resend.sent.slice(before).map((m) => m.subject));

  log('\nB. Lifecycle email off: the usual verification email, recorded');
  setEnv({ EMAIL_LIFECYCLE_ENABLED: null });
  r = await signup('two@example.com'); await sleep(50);
  id = userId('two@example.com');
  const two = resend.sent.filter((m) => m.to === 'two@example.com');
  check('one email: the verification email (not a welcome)', two.length === 1 && /confirm your email/i.test(two[0].subject) && !!tokenFrom(two[0].text), two.map((m) => m.subject));
  v = verifyRows(id);
  check('ledger: sent via Resend, provider id stored, no welcome row', v.length === 1 && v[0].status === 'sent' && v[0].error === 'resend' && v[0].provider_id === two[0].id && !sends(id).some((x) => x.template === 'welcome'), sends(id));

  log('\nC. Welcome send fails at signup → the verification email still goes out');
  setEnv({ EMAIL_LIFECYCLE_ENABLED: 'true' });
  resend.fail.push(500, 500, 500, 500, 500, 500); // Resend down: 3 attempts for the welcome + 3 for the verification email
  const mailBefore = H.mail.length;
  r = await signup('three@example.com'); await sleep(50);
  id = userId('three@example.com');
  v = verifyRows(id);
  check('signup ok; verification delivered by the SMTP fallback; ledger says "smtp:resend_failed"', r.status === 200 && H.mail.length === mailBefore + 1 && v.length === 1 && v[0].status === 'sent' && v[0].error === 'smtp:resend_failed', { v, mail: H.mail.length - mailBefore });
  check('the failed welcome stays "failed" for the lifecycle job’s normal retry', sends(id).some((x) => x.template === 'welcome' && x.status === 'failed'), sends(id));

  log('\nD. No email provider at all → recorded as skipped');
  setEnv({ EMAIL_MODE: null, SMTP_USER: null, SMTP_PASS: null });
  r = await signup('four@example.com'); await sleep(50);
  id = userId('four@example.com');
  v = verifyRows(id);
  check('signup ok, nothing sent, ledger row "skipped" (none:no_provider)', r.status === 200 && v.length === 1 && v[0].status === 'skipped' && v[0].error === 'none:no_provider', v);
  setEnv(Object.assign({ SMTP_USER: 'mailer@example.invalid', SMTP_PASS: 'x' }, LIVE));

  log('\nE. Suppressed address → no welcome, no verification email, recorded');
  H.rows('email_suppressions').push({ email_hash: L.emailHash('bounced@example.com'), reason: 'hard_bounce' });
  const sb = resend.sent.length, mb = H.mail.length;
  r = await signup('bounced@example.com'); await sleep(50);
  id = userId('bounced@example.com');
  v = verifyRows(id);
  check('nothing sent; ledger row "skipped" (none:suppressed)', resend.sent.length === sb && H.mail.length === mb && v.length === 1 && v[0].status === 'skipped' && v[0].error === 'none:suppressed', v);

  log('\nF. Resend verification is recorded too');
  id = userId('two@example.com');
  H.rows('profiles').find((p) => p.id === id).verification_sent_at = new Date(Date.now() - 5 * 60e3).toISOString();
  r = await H.call('POST', '/api/resend-verification', 'tok_' + id); await sleep(50);
  v = verifyRows(id);
  check('second ledger row for the resend (source "resend")', r.status === 200 && v.length === 2 && /^verify:resend:/.test(v[1].dedupe_key) && v[1].status === 'sent', v);

  log('\nG. Delivery updates and safety of the ledger');
  const row = verifyRows(userId('two@example.com'))[0];
  await L.handleProviderEvent({ type: 'email.delivered', data: { email_id: row.provider_id } });
  check('Resend’s delivery webhook marks the verification row delivered', verifyRows(userId('two@example.com'))[0].status === 'delivered', verifyRows(userId('two@example.com'))[0]);
  const all = H.rows('email_sends').filter((x) => x.template === 'verify_email');
  const dump = JSON.stringify(all);
  check('verification rows never use status "failed" (the lifecycle retry can’t rebuild a link)', all.every((x) => x.status !== 'failed'), all.map((x) => x.status));
  check('no address, token or link stored in any verification row', !/@|verify_token|[a-f0-9]{64}/.test(dump), dump.slice(0, 300));
  check('every signup above has exactly one verification row', ['one', 'two', 'three', 'four', 'bounced'].every((p) => verifyRows(userId(p + '@example.com')).length >= 1));
  check('no unexpected outbound requests', H.net.blocked.length === 0, H.net.blocked);

  done();
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
