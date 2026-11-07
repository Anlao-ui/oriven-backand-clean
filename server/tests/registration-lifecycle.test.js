// ════════════════════════════════════════════════════════════════
// Registration ↔ deletion lifecycle on the real server.js (Supabase Auth,
// database and Stripe mocked; tests/helpers/mockServer.js models Supabase
// Auth: case-insensitive duplicate check, soft delete hashes the email).
//
//   A. New registration: auth user + profile, onboarding starts
//   B. Duplicate address (any case/whitespace): clear 409, nothing created
//   C. Delete (supported flow) → the same address registers again;
//      partial failures never report success and can be retried;
//      a profile deleted by hand is not a deletion (address still taken),
//      and the operator deletion (services/accountDeletion.js) fixes it
//   D. Invalid input: one specific reason per field, never a generic
//      "missing fields" for something else; text/plain JSON and snake_case
//      names are read correctly
//   E. Existing accounts are untouched (profile, assistant, onboarding)
//
// RUN: node tests/registration-lifecycle.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5682, env: { SIGNUP_LIMIT_PER_IP_HOUR: '500' } });
const { check, log, done } = reporter();
let n = 0;
const ip = () => ({ 'X-Forwarded-For': '198.51.100.' + (++n % 250) });
const signup = (body, headers) => H.call('POST', '/api/signup', null, body, Object.assign(ip(), headers || {}));
const users = (email) => H.AUTH.users.filter((u) => String(u.email).toLowerCase() === email);
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const GENERIC = /first name, email and password are required/i;

(async () => {
  await H.start();
  const deletion = require(path.join(H.SERVER_DIR, 'services', 'accountDeletion'));
  const accounts = require(path.join(H.SERVER_DIR, 'services', 'accounts'));

  // ── E (before) ──────────────────────────────────────────────────
  const OLD = '00000000-0000-4000-8000-0000000009e1';
  H.AUTH.users.push({ id: OLD, email: 'existing@example.com', created_at: '2026-10-01T00:00:00Z' });
  H.TOKENS['tok_old'] = { id: OLD, email: 'existing@example.com' };
  H.rows('profiles').push({ id: OLD, email: 'existing@example.com', first_name: 'Eva', subscription_status: 'paid', access_expires_at: new Date(Date.now() + 9e8).toISOString(), credits_balance: 777, onboarding_completed: true, preferences: { assistant: 'scout', theme: 'dark' } });
  H.rows('onboarding_sessions').push({ user_id: OLD, assistant: 'scout', status: 'completed', answers: { business: { name: 'Eva Studio' } } });
  const oldSnapshot = JSON.stringify(prof(OLD));

  // ── A ───────────────────────────────────────────────────────────
  log('\nA. New registration');
  let r = await signup({ firstName: '  Jane ', lastName: 'Doe', email: '  Jane.Doe@Example.COM ', password: 'secret123', marketingOptIn: false });
  const A1 = users('jane.doe@example.com')[0];
  check('200 { ok, userId } and one sign-in account', r.status === 200 && r.body.ok === true && !!A1 && r.body.userId === A1.id, r.body);
  check('email normalised once, the same everywhere (trimmed, lower-case)', A1 && A1.email === 'jane.doe@example.com' && prof(A1.id) && prof(A1.id).email === 'jane.doe@example.com');
  check('profile created by the server: name trimmed, onboarding not completed', prof(A1.id).first_name === 'Jane' && prof(A1.id).last_name === 'Doe' && prof(A1.id).onboarding_completed === false);
  H.TOKENS['tok_jane'] = { id: A1.id, email: A1.email, created_at: new Date().toISOString() };
  r = await H.call('GET', '/api/onboarding/state', 'tok_jane');
  check('the new account is sent into the onboarding', r.status === 200 && r.body && r.body.eligible === true, r.body);

  // ── B ───────────────────────────────────────────────────────────
  log('\nB. Duplicate registration');
  const before = { users: H.AUTH.users.length, profiles: H.rows('profiles').length };
  for (const variant of ['jane.doe@example.com', 'JANE.DOE@EXAMPLE.COM', '  Jane.Doe@example.com  ']) {
    r = await signup({ firstName: 'Janet', email: variant, password: 'another123' });
    check(`"${variant.trim()}" → 409 EMAIL_EXISTS, a clear message, never "missing fields"`, r.status === 409 && r.body.code === 'EMAIL_EXISTS' && r.body.field === 'email' && /already exists\. Please sign in or reset your password\./.test(r.body.error) && !GENERIC.test(r.body.error), r.body);
  }
  check('…no second sign-in account or profile, the first one unchanged', H.AUTH.users.length === before.users && H.rows('profiles').length === before.profiles && prof(A1.id).first_name === 'Jane');
  check('…the message says only that the address has an account (no names, ids or dates)', !/Jane|Doe|0000/.test(r.body.error));

  // ── C ───────────────────────────────────────────────────────────
  log('\nC. Delete, then register the same address again');
  r = await H.call('POST', '/api/account/delete', 'tok_jane', {});
  const a1 = H.AUTH.users.find((u) => u.id === A1.id);
  check('Settings → Delete account: 200', r.status === 200 && r.body.ok === true, r.body);
  check('…the sign-in account is soft-deleted and no longer holds the address', a1 && a1.deleted_at && a1.email !== 'jane.doe@example.com' && (H.AUTH.softDeleted || []).includes(A1.id), a1);
  check('…its old token no longer signs in', (await H.call('GET', '/api/agent', 'tok_jane')).status === 401);
  check('…the profile is an anonymised tombstone (financial records keep their reference)', prof(A1.id) && prof(A1.id).deleted_at && !prof(A1.id).email && !prof(A1.id).first_name);
  r = await signup({ firstName: 'Jane', lastName: 'Doe', email: 'Jane.Doe@example.com', password: 'brandnew123' });
  const A2 = H.AUTH.users.find((u) => u.email === 'jane.doe@example.com' && !u.deleted_at);
  check('the same address registers again: a NEW account (new id) and a fresh profile', r.status === 200 && A2 && A2.id !== A1.id && prof(A2.id) && prof(A2.id).email === 'jane.doe@example.com' && !prof(A2.id).deleted_at, r.body);
  check('…the old tombstone is kept separately (no data carried over)', prof(A1.id).deleted_at && prof(A2.id).subscription_status === 'free');

  // Even if Supabase's soft delete kept the address on the identity, the
  // deletion moves the email to a placeholder first.
  H.AUTH.keepEmailOnSoftDelete = true;
  r = await signup({ firstName: 'Kim', email: 'kim@example.com', password: 'secret123' });
  const K = H.AUTH.users.find((u) => u.email === 'kim@example.com'); H.TOKENS.tok_kim = { id: K.id, email: K.email };
  r = await H.call('POST', '/api/account/delete', 'tok_kim', {});
  check('deletion releases the email itself (placeholder address) before the soft delete', r.status === 200 && deletion.isPlaceholder(H.AUTH.users.find((u) => u.id === K.id).email));
  r = await signup({ firstName: 'Kim', email: 'kim@example.com', password: 'secret123' });
  check('…so the address registers again even then', r.status === 200);

  // Partial failures: never "deleted" while the address is still held.
  r = await signup({ firstName: 'Lou', email: 'lou@example.com', password: 'secret123' });
  const L = H.AUTH.users.find((u) => u.email === 'lou@example.com' && !u.deleted_at); H.TOKENS.tok_lou = { id: L.id, email: L.email };
  H.AUTH.updateFail = 'email update refused (test)';
  r = await H.call('POST', '/api/account/delete', 'tok_lou', {});
  check('email move refused + soft delete keeps the address → reported as FAILED (AUTH_DELETE_FAILED), not done', r.status === 500 && r.body.code === 'AUTH_DELETE_FAILED' && H.AUTH.users.find((u) => u.id === L.id).email === 'lou@example.com', r.body);
  r = await signup({ firstName: 'Lou', email: 'lou@example.com', password: 'secret123' });
  check('…the address is honestly still taken (409), nothing half-created', r.status === 409);
  H.AUTH.keepEmailOnSoftDelete = false;
  const L2 = H.AUTH.users.find((u) => u.id === L.id); delete L2.deleted_at; H.TOKENS.tok_lou = { id: L.id, email: L.email };
  r = await H.call('POST', '/api/account/delete', 'tok_lou', {});
  check('retrying the deletion completes it (every step is safe to repeat)', r.status === 200 && H.AUTH.users.find((u) => u.id === L.id).email !== 'lou@example.com', r.body);

  r = await signup({ firstName: 'Max', email: 'max@example.com', password: 'secret123' });
  const M = H.AUTH.users.find((u) => u.email === 'max@example.com'); H.TOKENS.tok_max = { id: M.id, email: M.email };
  H.AUTH.deleteFail = 'auth service unavailable (test)';
  r = await H.call('POST', '/api/account/delete', 'tok_max', {});
  check('sign-in account removal fails → 500 AUTH_DELETE_FAILED (the app says it couldn’t delete)', r.status === 500 && r.body.code === 'AUTH_DELETE_FAILED', r.body);
  H.TOKENS.tok_max = { id: M.id, email: M.email };
  r = await H.call('POST', '/api/account/delete', 'tok_max', {});
  check('…a retry finishes (data step already done, then the sign-in account)', r.status === 200 && H.AUTH.users.find((u) => u.id === M.id).deleted_at);

  log('\nC2. A profile deleted by hand is not a deletion');
  r = await signup({ firstName: 'Ola', email: 'ola@example.com', password: 'secret123' });
  const O = H.AUTH.users.find((u) => u.email === 'ola@example.com');
  H.rows('profiles').splice(H.rows('profiles').findIndex((p) => p.id === O.id), 1); // what a manual DELETE FROM profiles does
  r = await signup({ firstName: 'Ola', email: 'ola@example.com', password: 'secret123' });
  check('the sign-in account still exists → the address is still taken (409) — this is why manual deletion fails', r.status === 409 && r.body.code === 'EMAIL_EXISTS');
  const listOnly = { auth: { admin: { listUsers: async () => ({ data: { users: H.AUTH.users }, error: null }) } } };
  const found = await deletion.findAuthUserByEmail(listOnly, 'OLA@example.com');
  check('the operator lookup finds that account by email (case-insensitive)', found && found.id === O.id);
  const fakeDb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), rpc: async () => ({ data: { ok: true, profile: 'none' }, error: null }),
    auth: { admin: { getUserById: async (id) => ({ data: { user: H.AUTH.users.find((u) => u.id === id) || null }, error: null }), updateUserById: async (id, a) => { const u = H.AUTH.users.find((x) => x.id === id); u.email = a.email; return { data: { user: u }, error: null }; }, deleteUser: async (id) => { const u = H.AUTH.users.find((x) => x.id === id); u.deleted_at = new Date().toISOString(); u.email = 'hashed-' + id; return { error: null }; } } } };
  const out = await deletion.deleteAccount({ db: fakeDb, stripe: null, storage: null, bucket: 'b' }, O.id);
  check('scripts/delete-account.js’s deletion works for that profile-less account (profile: none) and releases the address', out.profile === 'none' && out.auth.emailReleased === true && H.AUTH.users.find((u) => u.id === O.id).deleted_at);
  r = await signup({ firstName: 'Ola', email: 'ola@example.com', password: 'secret123' });
  check('…after which the address registers again', r.status === 200);

  // ── D ───────────────────────────────────────────────────────────
  log('\nD. Invalid registration: specific reasons');
  const cases = [
    [{ email: 'a@b.co', password: 'secret123' }, 'firstName', /Enter your first name\./],
    [{ firstName: '    ', email: 'a@b.co', password: 'secret123' }, 'firstName', /Enter your first name\./],
    [{ firstName: 'Ann', password: 'secret123' }, 'email', /Enter your email address\./],
    [{ firstName: 'Ann', email: 'not-an-email', password: 'secret123' }, 'email', /Enter a valid email address\./],
    [{ firstName: 'Ann', email: 'ann@nodot', password: 'secret123' }, 'email', /Enter a valid email address\./],
    [{ firstName: 'Ann', email: 'ann@example.com' }, 'password', /Choose a password\./],
    [{ firstName: 'Ann', email: 'ann@example.com', password: '123' }, 'password', /at least 6 characters/],
    [{ firstName: 'Ann', email: 'ann@example.com', password: 'secret123', phone: 'call me' }, 'phone', /valid phone number/],
  ];
  const u0 = H.AUTH.users.length;
  for (const [body, field, re] of cases) {
    r = await signup(body);
    check(`${JSON.stringify(body).slice(0, 60)} → 400, field "${field}", specific message`, r.status === 400 && r.body.field === field && re.test(r.body.error) && !GENERIC.test(r.body.error), r.body);
  }
  check('…none of them created an account', H.AUTH.users.length === u0);
  r = await H.call('POST', '/api/signup', null, JSON.stringify({ firstName: 'Tex', email: 'tex@example.com', password: 'secret123' }), Object.assign(ip(), { 'Content-Type': 'text/plain;charset=UTF-8' }));
  check('a JSON body sent as text/plain is read (was: every field "missing")', r.status === 200 && users('tex@example.com').length === 1, r.body);
  r = await signup({ first_name: 'Sam', last_name: 'Lee', email: 'sam@example.com', password: 'secret123' });
  check('snake_case field names are read too', r.status === 200 && prof(users('sam@example.com')[0].id).first_name === 'Sam', r.body);
  H.AUTH.createFail = 'Database error saving new user';
  r = await signup({ firstName: 'Zed', email: 'zed@example.com', password: 'secret123' });
  check('an unexpected Supabase error → 500 "couldn’t create your account", never "missing fields"', r.status === 500 && r.body.code === 'SIGNUP_FAILED' && !GENERIC.test(r.body.error), r.body);
  check('Supabase errors are translated: weak password, invalid email, rate limit', accounts.signupAuthError({ code: 'weak_password', message: 'Password should be at least 6 characters' }).body.code === 'WEAK_PASSWORD' && accounts.signupAuthError({ message: 'Unable to validate email address: invalid format' }).body.field === 'email' && accounts.signupAuthError({ message: 'Too many requests' }).status === 429 && accounts.signupAuthError({ code: 'email_exists' }).status === 409);

  // ── E ───────────────────────────────────────────────────────────
  log('\nE. Existing accounts untouched');
  check('the existing account’s profile is byte-for-byte unchanged (credits, plan, assistant)', JSON.stringify(prof(OLD)) === oldSnapshot);
  r = await H.call('GET', '/api/agent', 'tok_old');
  check('…its token still works and its chosen assistant is still Scout', r.status === 200 && r.body.agent.id === 'scout');
  check('…its onboarding answers are unchanged', H.rows('onboarding_sessions').find((s) => s.user_id === OLD).answers.business.name === 'Eva Studio');
  r = await signup({ firstName: 'Eva', email: 'EXISTING@example.com', password: 'secret123' });
  check('…registering with its address (other case) is refused, the account intact', r.status === 409 && JSON.stringify(prof(OLD)) === oldSnapshot);

  check('no unexpected outbound requests', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
