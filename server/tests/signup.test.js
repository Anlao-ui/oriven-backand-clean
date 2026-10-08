// ════════════════════════════════════════════════════════════════
// Signup — profile creation, verification, validation, limits, and the
// gated unverified-account cleanup. Real server.js, mocked Supabase/SMTP.
// RUN: node tests/signup.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5598, env: { SMTP_USER: 'mailer@example.invalid', SMTP_PASS: 'x', SIGNUP_LIMIT_PER_IP_HOUR: '50' } });
const { check, log, done } = reporter();
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const ip = (n) => ({ 'X-Forwarded-For': '203.0.113.' + n });
const tokenFromMail = (m) => (String(m && m.text || '').match(/verify_token=([a-f0-9]{64})/) || [])[1];

(async () => {
  await H.start();
  const accounts = require(H.SERVER_DIR + '/services/accounts.js');

  log('\nA. Successful registration (verification migration applied)');
  let r = await H.call('POST', '/api/signup', null, { firstName: ' Jane ', lastName: 'Doe', email: ' Jane@Example.com ', password: 'secret123', phone: '+31 6 1234 5678', marketingOptIn: false }, ip(1));
  const u1 = H.AUTH.users[0];
  check('200 and an auth user', r.status === 200 && r.body.ok === true && !!u1, r);
  check('email normalised (trimmed, lower-case)', u1 && u1.email === 'jane@example.com');
  const p1 = u1 && prof(u1.id);
  check('profile row created by signup itself', !!p1);
  check('profile has first/last name, email, free plan, onboarding not completed', p1 && p1.first_name === 'Jane' && p1.last_name === 'Doe' && p1.email === 'jane@example.com' && p1.subscription_status === 'free' && p1.onboarding_completed === false, p1);
  check('no columns that do not exist (phone, verification_token)', p1 && !('phone' in p1) && !('verification_token' in p1));
  check('phone kept in auth metadata', u1 && u1.user_metadata.phone === '+31 6 1234 5678');
  check('email_verified=false + token HASH stored (never the raw token)', p1 && p1.email_verified === false && /^[a-f0-9]{64}$/.test(p1.verification_token_hash || '') && p1.verification_sent_at);
  const tok = tokenFromMail(H.mail[0]);
  check('verification email sent once, link carries the token', H.mail.length === 1 && !!tok && accounts.hashToken(tok) === p1.verification_token_hash);
  check('raw token not stored anywhere in the profile', !JSON.stringify(p1).includes(tok));
  check('signup_completed event recorded', H.rows('events').some((e) => e.event_name === 'signup_completed' && e.user_id === u1.id));
  check('no marketing consent without opt-in', !p1.marketing_opt_in);

  log('\nB. Email verification');
  r = await H.call('POST', '/api/verify-email', null, { token: 'nope' });
  check('malformed token → 404', r.status === 404);
  r = await H.call('POST', '/api/verify-email', null, { token: 'f'.repeat(64) });
  check('unknown token → 404', r.status === 404);
  r = await H.call('POST', '/api/verify-email', null, { token: tok });
  check('valid token → verified, hash cleared', r.status === 200 && prof(u1.id).email_verified === true && prof(u1.id).verification_token_hash === null, prof(u1.id));
  r = await H.call('POST', '/api/verify-email', null, { token: tok });
  check('same link again → 404 (single use)', r.status === 404);
  r = await H.call('POST', '/api/resend-verification', 'tok_' + u1.id);
  check('resend for a verified address → no new email', r.status === 200 && r.body.alreadyVerified === true && H.mail.length === 1);

  log('\nC. Duplicate, invalid input');
  r = await H.call('POST', '/api/signup', null, { firstName: 'J', email: 'jane@example.com', password: 'secret123' }, ip(2));
  check('duplicate email → 409, no second profile', r.status === 409 && H.rows('profiles').length === 1 && H.AUTH.users.length === 1);
  r = await H.call('POST', '/api/signup', null, { firstName: 'J', email: 'JANE@example.com', password: 'secret123' }, ip(2));
  check('duplicate with different case → 409', r.status === 409);
  for (const [body, why] of [[{ email: 'a@b.co', password: 'secret123' }, 'missing first name'], [{ firstName: 'A', email: 'not-an-email', password: 'secret123' }, 'invalid email'],
    [{ firstName: 'A', email: 'a@b.co', password: '123' }, 'short password'], [{ firstName: 'A'.repeat(81), email: 'a@b.co', password: 'secret123' }, 'long name'],
    [{ firstName: 'A', email: 'a@b.co', password: 'secret123', phone: 'call me' }, 'invalid phone'], [null, 'no body']]) {
    r = await H.call('POST', '/api/signup', null, body || {}, ip(3));
    check(`invalid input (${why}) → 400, no account`, r.status === 400 && H.AUTH.users.length === 1, r.status);
  }

  log('\nD. Expiry and resend');
  r = await H.call('POST', '/api/signup', null, { firstName: 'Ann', email: 'ann@example.com', password: 'secret123' }, ip(4));
  const u2 = H.AUTH.users[1];
  const tok2 = tokenFromMail(H.mail[H.mail.length - 1]);
  prof(u2.id).verification_sent_at = new Date(Date.now() - 15 * 864e5).toISOString();
  r = await H.call('POST', '/api/verify-email', null, { token: tok2 });
  check('expired link (15 days) → 410', r.status === 410 && prof(u2.id).email_verified === false);
  r = await H.call('POST', '/api/resend-verification', 'tok_' + u2.id);
  const tok3 = tokenFromMail(H.mail[H.mail.length - 1]);
  check('resend → new token, old one dead', r.status === 200 && tok3 && tok3 !== tok2 && (await H.call('POST', '/api/verify-email', null, { token: tok2 })).status === 404);
  check('new link verifies', (await H.call('POST', '/api/verify-email', null, { token: tok3 })).status === 200 && prof(u2.id).email_verified === true);
  r = await H.call('POST', '/api/resend-verification', null);
  check('resend without sign-in → 401', r.status === 401);

  log('\nE. Migration not applied yet / profile write failures');
  H.MISSING.profiles = new Set(['email_verified', 'verification_token_hash', 'verification_sent_at']);
  const mailBefore = H.mail.length;
  r = await H.call('POST', '/api/signup', null, { firstName: 'Bo', email: 'bo@example.com', password: 'secret123' }, ip(5));
  const u3 = H.AUTH.users[2];
  check('signup still creates a full base profile', r.status === 200 && prof(u3.id) && prof(u3.id).first_name === 'Bo' && prof(u3.id).email === 'bo@example.com');
  check('…and sends NO verification email (link could never work)', H.mail.length === mailBefore);
  r = await H.call('POST', '/api/resend-verification', 'tok_' + u3.id);
  check('resend → 503 until the migration exists', r.status === 503 && H.mail.length === mailBefore);
  H.MISSING.profiles = new Set(['first_name', 'email_verified']); // a profile write that can't succeed at all
  r = await H.call('POST', '/api/signup', null, { firstName: 'Cy', email: 'cy@example.com', password: 'secret123' }, ip(6));
  check('profile failure → account still created (signs in; app creates the row)', r.status === 200 && H.AUTH.users.length === 4 && !prof(H.AUTH.users[3].id));
  H.MISSING.profiles = new Set();
  H.AUTH.createFail = 'Database error creating new user';
  r = await H.call('POST', '/api/signup', null, { firstName: 'Di', email: 'di@example.com', password: 'secret123' }, ip(7));
  check('auth provider failure → 500 with a safe message, nothing created', r.status === 500 && !/Database/.test(r.body.error) && H.AUTH.users.length === 4, r.body);
  const st = await H.call('GET', '/api/onboarding/state', 'tok_' + H.AUTH.users[3].id);
  check('no profile row yet → still eligible for onboarding (auth created_at)', st.status === 200 && st.body.eligible === true, st.body);
  const st1 = await H.call('GET', '/api/onboarding/state', 'tok_' + u1.id);
  check('fresh signup → eligible for onboarding', st1.body.eligible === true);

  log('\nF. Marketing consent at signup');
  r = await H.call('POST', '/api/signup', null, { firstName: 'Ed', email: 'ed@example.com', password: 'secret123', marketingOptIn: true }, ip(8));
  await new Promise((res) => setTimeout(res, 50));
  const p5 = prof(H.AUTH.users[4].id);
  check('explicit opt-in stored with source', p5.marketing_opt_in === true && p5.marketing_consent_source === 'signup' && !!p5.marketing_opt_in_at);
  r = await H.call('POST', '/api/signup', null, { firstName: 'Fa', email: 'fa@example.com', password: 'secret123', marketingOptIn: 'yes' }, ip(9));
  check('anything but true is not consent', !prof(H.AUTH.users[5].id).marketing_opt_in);

  log('\nG. Rate limiting');
  let limited = 0;
  for (let i = 0; i < 52; i++) { const x = await H.call('POST', '/api/signup', null, { firstName: 'R', email: `r${i}@example.com`, password: 'secret123' }, ip(99)); if (x.status === 429) limited++; }
  check('per-network limit (50/hour in this test) → 429', limited >= 2, limited);

  log('\nH2. POST /api/profile/ensure (replaces the browser upsert)');
  r = await H.call('POST', '/api/profile/ensure', null);
  check('no session → 401', r.status === 401);
  const orphan = H.AUTH.users[3]; // auth user whose profile write failed in E
  r = await H.call('POST', '/api/profile/ensure', 'tok_' + orphan.id);
  check('missing row → created as a plain Free profile', r.status === 200 && r.body.created === true && prof(orphan.id) && prof(orphan.id).subscription_status === 'free' && prof(orphan.id).onboarding_completed === false, prof(orphan.id));
  r = await H.call('POST', '/api/profile/ensure', 'tok_' + orphan.id);
  check('second call → nothing created or changed', r.status === 200 && r.body.created === false && H.rows('profiles').filter((p) => p.id === orphan.id).length === 1);
  const paidRow = prof(u1.id);
  Object.assign(paidRow, { subscription_status: 'professional', credits_balance: 4000, stripe_customer_id: 'cus_x' });
  const snap = JSON.stringify(paidRow);
  r = await H.call('POST', '/api/profile/ensure', 'tok_' + u1.id, { subscription_status: 'free', credits_balance: 0 });
  check('existing paid row is never touched (body ignored)', r.status === 200 && r.body.created === false && JSON.stringify(prof(u1.id)) === snap);

  log('\nH. Unverified-account cleanup stays off');
  check('no cleanup cron registered without UNVERIFIED_ACCOUNT_CLEANUP=true', !H.cronJobs.some((j) => j.expr === '0 2 * * *'));
  check('no account deleted', H.AUTH.deleted.length === 0);
  check('no outbound network', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
