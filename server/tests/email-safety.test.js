// ════════════════════════════════════════════════════════════════
// Email safety — allowlist-only test mode, test/live separation, retry
// rules, 48h welcome, verification email over Resend with SMTP fallback,
// and the suppression-aware preferences API. Real server.js; Resend, SMTP
// and Supabase are mocked — nothing is delivered.
// RUN: node tests/email-safety.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5601, env: { SMTP_USER: 'mailer@example.invalid', SMTP_PASS: 'x', EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', PUBLIC_API_URL: 'http://127.0.0.1:5601', FRONTEND_URL: 'https://orivenai.com', EMAIL_LIFECYCLE_SINCE: '2026-06-01T00:00:00Z', SIGNUP_LIMIT_PER_IP_HOUR: '100' } });
const { check, log, done } = reporter();
const DAY = 864e5, HOUR = 36e5, now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();

const resend = { sent: [], fail: [], keys: new Map() };
H.net.handler = async (url, opts) => {
  if (url !== 'https://api.resend.com/emails') return null;
  const body = JSON.parse(opts.body);
  const key = opts.headers['Idempotency-Key'];
  if (resend.fail.length) { const st = resend.fail.shift(); return new Response(JSON.stringify({ name: 'error' }), { status: st }); }
  if (resend.keys.has(key)) return new Response(JSON.stringify({ id: resend.keys.get(key) }), { status: 200 });
  const id = 'em_' + (resend.sent.length + 1);
  resend.keys.set(key, id);
  resend.sent.push({ to: body.to[0], subject: body.subject, text: body.text, key });
  return new Response(JSON.stringify({ id }), { status: 200 });
};
const P = (id, email, createdMsAgo, extra) => Object.assign({ id, email, first_name: 'Sam', created_at: ago(createdMsAgo), subscription_status: 'free', first_value_at: null, first_value_kind: null, marketing_opt_in: null }, extra || {});
const OWNER = '00000000-0000-4000-8000-0000000000a1', CUST = '00000000-0000-4000-8000-0000000000c1';
const tokenFrom = (text) => (String(text || '').match(/verify_token=([a-f0-9]{64})/) || [])[1];
let ipN = 0; const ip = () => ({ 'X-Forwarded-For': '198.51.100.' + (++ipN) });
const setEnv = (o) => { for (const [k, v] of Object.entries(o)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };

(async () => {
  await H.start();
  const L = require(H.SERVER_DIR + '/services/email/lifecycle.js');
  const sender = require(H.SERVER_DIR + '/services/email/sender.js');
  const accounts = require(H.SERVER_DIR + '/services/accounts.js');

  log('\nA. Test mode processes ONLY allowlisted accounts');
  H.rows('profiles').push(P(OWNER, 'Owner@My-Company.test', 2 * HOUR), P(CUST, 'customer@example.invalid', 2 * HOUR));
  setEnv({ EMAIL_MODE: 'test', RESEND_API_KEY: 're_test_mock', EMAIL_FROM: 'OrivenAI <hello@mail.orivenai.com>', EMAIL_TEST_ALLOWLIST: '' });
  H.rows('profiles')[0].email = 'owner@my-company.test';
  let s = await L.runOnce({ now });
  check('empty allowlist → nobody processed, nothing written', s.considered === 0 && H.rows('email_sends').length === 0 && resend.sent.length === 0, s);
  setEnv({ EMAIL_TEST_ALLOWLIST: ' OWNER@my-company.test ;  qa2@my-company.test ' });
  s = await L.runOnce({ now });
  check('only the allowlisted account is read and considered', s.considered === 1, s);
  check('allowlisted account gets its own welcome, subject [TEST], not redirected', resend.sent.length === 1 && resend.sent[0].to === 'owner@my-company.test' && /^\[TEST\] /.test(resend.sent[0].subject), resend.sent);
  check('customer outside the allowlist: no email, no ledger row', !resend.sent.some((m) => m.to === 'customer@example.invalid') && !H.rows('email_sends').some((r) => r.user_id === CUST));
  check('test ledger row is kept separate (dedupe key test:welcome)', H.rows('email_sends').some((r) => r.user_id === OWNER && r.dedupe_key === 'test:welcome' && r.status === 'sent'));
  check('test idempotency key carries the test scope', /^oriven:test:/.test(resend.sent[0].key), resend.sent[0].key);
  s = await L.runOnce({ now });
  check('second test run → no duplicate test email', resend.sent.length === 1);
  check('allowlist is case-insensitive and accepts ; , and spaces', sender.testAllowlist().has('owner@my-company.test') && sender.testAllowlist().has('qa2@my-company.test'));
  let r = await sender.send({ to: 'customer@example.invalid', subject: 's', html: 'h', text: 't', idempotencyKey: 'x1' });
  check('sender itself refuses a non-allowlisted address in test mode', r.skipped === 'not_allowlisted' && resend.sent.length === 1);

  log('\nB. Test records never stand in for the real email');
  setEnv({ EMAIL_MODE: 'live' });
  s = await L.runOnce({ now });
  const live = resend.sent.slice(1);
  check('live: the owner still gets the real welcome (test row ignored)', live.some((m) => m.to === 'owner@my-company.test' && !/^\[TEST\]/.test(m.subject)), live);
  check('live: the customer gets their welcome', live.some((m) => m.to === 'customer@example.invalid'));
  check('live idempotency keys differ from the test ones', live.every((m) => /^oriven:live:/.test(m.key)));
  check('live rows use the plain dedupe key', H.rows('email_sends').filter((r) => r.dedupe_key === 'welcome').length === 2);
  setEnv({ EMAIL_MODE: 'test' });
  const before = resend.sent.length;
  await L.runOnce({ now });
  check('back in test mode: live rows don\'t count, test row prevents a repeat', resend.sent.length === before);

  log('\nC. Nothing is written while Resend is not configured');
  H.rows('profiles').push(P('00000000-0000-4000-8000-0000000000c2', 'new@example.invalid', HOUR));
  setEnv({ EMAIL_MODE: 'live', RESEND_API_KEY: null });
  const rowsBefore = H.rows('email_sends').length;
  s = await L.runOnce({ now });
  check('live without an API key → disabled, no ledger rows', s.disabled === 'not_configured' && H.rows('email_sends').length === rowsBefore, s);
  setEnv({ RESEND_API_KEY: 're_test_mock' });

  log('\nD. Welcome within 48 hours only');
  const facts = () => ({ sent: new Set(), paywalls: {}, suppressed: false });
  check('47h old → welcome', (L.decide(P('w1', 'a@b.c', 47 * HOUR), facts(), now) || {}).template === 'welcome');
  check('49h old → no welcome', L.decide(P('w2', 'a@b.c', 49 * HOUR), facts(), now) === null);
  check('window constant is 48h', L.WELCOME_WINDOW === 48 * HOUR);

  log('\nE. Only temporary failures are retried');
  const U = (n) => '00000000-0000-4000-8000-0000000000e' + n;
  await L.runOnce({ now }); // send whatever is already due, so the failures below hit these two accounts
  H.rows('profiles').push(P(U(1), 'e1@example.invalid', HOUR));
  resend.fail = [500, 500, 500];
  await L.runOnce({ now, limit: 500 });
  const e1 = H.rows('email_sends').find((x) => x.user_id === U(1));
  check('three 5xx → failed (retryable)', e1 && e1.status === 'failed', e1);
  H.rows('profiles').push(P(U(2), 'e2@example.invalid', HOUR));
  resend.fail = [422];
  await L.runOnce({ now });
  const e2 = H.rows('email_sends').find((x) => x.user_id === U(2));
  check('422 → error (final)', e2 && e2.status === 'error', e2);
  H.rows('email_sends').push({ id: 'sk1', user_id: U(1), template: 'x', dedupe_key: 'skipme', category: 'service', status: 'skipped', error: 'not_allowlisted', attempts: 1, updated_at: ago(DAY) });
  H.rows('email_sends').push({ id: 'ts1', user_id: U(2), template: 'welcome', dedupe_key: 'test:welcome', category: 'service', status: 'failed', error: 'http_500', attempts: 1, updated_at: ago(DAY) });
  const sentBefore = resend.sent.length;
  await L.retryFailed({ minAgeMs: 0 });
  check('live retry: the 5xx failure is retried and sent', H.rows('email_sends').find((x) => x.user_id === U(1) && x.dedupe_key === 'welcome').status === 'sent');
  check('skipped and 4xx rows are never retried', H.rows('email_sends').find((x) => x.id === 'sk1').status === 'skipped' && e2.status === 'error' && e2.attempts === 1);
  check('a test-scope failure is not retried in live mode', H.rows('email_sends').find((x) => x.id === 'ts1').status === 'failed');
  check('exactly one retry send', resend.sent.length === sentBefore + 1);

  log('\nF. Verification email: Resend first, SMTP fallback');
  const signup = async (email, extra) => H.call('POST', '/api/signup', null, Object.assign({ firstName: 'Ann', email, password: 'secret123' }, extra || {}), ip());
  const prof = (email) => H.rows('profiles').find((p) => p.email === email);
  setEnv({ EMAIL_MODE: 'live' });
  let n = resend.sent.length, m = H.mail.length;
  r = await signup('v1@example.invalid', { marketingOptIn: false });
  const v1 = resend.sent[n];
  check('live: verification sent through Resend, not SMTP', r.status === 200 && v1 && v1.to === 'v1@example.invalid' && /Confirm your email/.test(v1.subject) && H.mail.length === m, { v1, smtp: H.mail.length - m });
  check('…without marketing consent (transactional)', !prof('v1@example.invalid').marketing_opt_in);
  const t1 = tokenFrom(v1 && v1.text);
  check('link token matches the stored HASH (raw token not stored)', t1 && accounts.hashToken(t1) === prof('v1@example.invalid').verification_token_hash && !JSON.stringify(prof('v1@example.invalid')).includes(t1));
  check('idempotency key derived from the token hash', v1 && v1.key === 'oriven:live:verify:' + prof('v1@example.invalid').verification_token_hash.slice(0, 32), v1 && v1.key);
  r = await H.call('POST', '/api/verify-email', null, { token: t1 });
  check('the Resend link verifies the address', r.status === 200 && prof('v1@example.invalid').email_verified === true);

  n = resend.sent.length; m = H.mail.length;
  resend.fail = [500, 500, 500];
  r = await signup('v2@example.invalid');
  check('Resend down → SMTP fallback sends the verification', r.status === 200 && resend.sent.length === n && H.mail.length === m + 1 && /verify_token=/.test(H.mail[H.mail.length - 1].text));

  setEnv({ EMAIL_MODE: 'test', EMAIL_TEST_ALLOWLIST: 'tester@my-company.test' });
  n = resend.sent.length; m = H.mail.length;
  await signup('tester@my-company.test');
  check('test mode, allowlisted signup → Resend ([TEST])', resend.sent.length === n + 1 && /^\[TEST\] /.test(resend.sent[n].subject) && H.mail.length === m);
  n = resend.sent.length; m = H.mail.length;
  await signup('realcustomer@example.invalid');
  check('test mode, real customer → unchanged SMTP path, nothing via Resend', resend.sent.length === n && H.mail.length === m + 1);

  setEnv({ EMAIL_MODE: 'off' });
  n = resend.sent.length; m = H.mail.length;
  await signup('v3@example.invalid');
  check('mode off → SMTP (today\'s behaviour)', resend.sent.length === n && H.mail.length === m + 1);
  setEnv({ SMTP_USER: null, SMTP_PASS: null });
  n = resend.sent.length; m = H.mail.length;
  await signup('v4@example.invalid');
  check('no provider at all → no token stored, no email', !prof('v4@example.invalid').verification_token_hash && resend.sent.length === n && H.mail.length === m);
  setEnv({ SMTP_USER: 'mailer@example.invalid', SMTP_PASS: 'x', EMAIL_MODE: 'live' });

  log('\nG. No duplicate verification emails');
  const u5 = await signup('v5@example.invalid');
  const id5 = u5.body.userId; const tok5 = 'tok_' + id5;
  n = resend.sent.length;
  r = await H.call('POST', '/api/resend-verification', tok5);
  check('immediate "resend" → 429 cooldown, no email', r.status === 429 && r.body.code === 'VERIFY_COOLDOWN' && resend.sent.length === n, r);
  prof('v5@example.invalid').verification_sent_at = ago(2 * 60e3);
  const oldHash = prof('v5@example.invalid').verification_token_hash;
  r = await H.call('POST', '/api/resend-verification', tok5);
  check('after the cooldown → one new email with a new token', r.status === 200 && resend.sent.length === n + 1 && prof('v5@example.invalid').verification_token_hash !== oldHash);
  const again = await sender.send({ to: 'v5@example.invalid', subject: 's', html: 'h', text: 't', idempotencyKey: resend.sent[n].key });
  check('same token resent → Resend dedupes (same email id, nothing new)', again.id === 'em_' + (n + 1) && resend.sent.length === n + 1);

  log('\nH. Suppressed addresses');
  await L.suppress('v5@example.invalid', 'hard_bounce');
  prof('v5@example.invalid').verification_sent_at = ago(5 * 60e3);
  n = resend.sent.length; m = H.mail.length;
  r = await H.call('POST', '/api/resend-verification', tok5);
  check('suppressed address → no verification email by any provider (422)', r.status === 422 && resend.sent.length === n && H.mail.length === m, r);

  log('\nI. Preferences API');
  const u6 = await signup('p6@example.invalid'); const tok6 = 'tok_' + u6.body.userId;
  r = await H.call('GET', '/api/email/preferences', tok6);
  check('default: marketing off, not suppressed', r.status === 200 && r.body.marketing === false && r.body.suppressed === false && r.body.available === true, r.body);
  r = await H.call('PUT', '/api/email/preferences', tok6, { marketing: true });
  check('turn on → stored with source settings', r.status === 200 && prof('p6@example.invalid').marketing_opt_in === true && prof('p6@example.invalid').marketing_consent_source === 'settings');
  const unsub = L.unsubscribeUrl(u6.body.userId).replace('http://127.0.0.1:5601', '');
  await H.call('GET', unsub, null);
  r = await H.call('GET', '/api/email/preferences', tok6);
  check('unsubscribe link → preference shows off', r.body.marketing === false);
  await L.suppress('p6@example.invalid', 'complaint');
  r = await H.call('GET', '/api/email/preferences', tok6);
  check('suppressed → reported, shown as off', r.body.suppressed === true && r.body.marketing === false, r.body);
  r = await H.call('PUT', '/api/email/preferences', tok6, { marketing: true });
  check('suppressed → opting in refused (409 EMAIL_SUPPRESSED), nothing stored', r.status === 409 && r.body.code === 'EMAIL_SUPPRESSED' && prof('p6@example.invalid').marketing_opt_in === false, r);
  r = await H.call('PUT', '/api/email/preferences', tok6, { marketing: false });
  check('turning off always works', r.status === 200);

  check('no outbound network except mocked Resend', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
