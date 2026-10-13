// ════════════════════════════════════════════════════════════════
// Every signed-in account has a complete profiles row, and nothing can
// leave an Auth user without one.
//
// Real server.js + services/accounts.js; Supabase (data + auth admin),
// Stripe, email and cron are in-memory mocks — nothing leaves this process.
//
// Covers: a missing profile is created on the first signed-in request
// (email + name from Auth, Free defaults); a bare row (created by a route's
// upsert before the profile existed) gets only its empty identity fields
// filled; existing values, plan, credits and Stripe ids are never changed;
// concurrent first requests create one row; account deletion restores the
// profile exactly when the Auth deletion fails; the restore script's logic
// (accounts.ensureProfile) is insert-only.
//
// RUN: node tests/profile-integrity.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5615 });
const { check, log, done } = reporter();

const uid = (n) => '00000000-0000-4000-8000-' + String(900 + n).padStart(12, '0');
function authUser(n, meta) {
  const u = { id: uid(n), email: 'Person' + n + '@Example.invalid', user_metadata: meta || { first_name: 'Sam', last_name: 'Lee' }, created_at: '2026-10-01T00:00:00Z' };
  H.AUTH.users.push(u); H.TOKENS['tok_' + u.id] = u; return u;
}
const prof = (id) => H.rows('profiles').filter((p) => p.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await H.start();
  const accounts = require(H.SERVER_DIR + '/services/accounts.js');

  log('\nA. Missing profile → created on the first signed-in request');
  const a = authUser(1);
  let r = await H.call('GET', '/api/onboarding/state', 'tok_' + a.id);
  let p = prof(a.id);
  check('one profile row now exists', p.length === 1, p);
  check('…filled from Auth: email (lower-case), first and last name', p[0] && p[0].email === 'person1@example.invalid' && p[0].first_name === 'Sam' && p[0].last_name === 'Lee', p[0]);
  check('…with the defaults every new account gets (Free, onboarding not completed)', p[0] && p[0].subscription_status === 'free' && p[0].onboarding_completed === false, p[0]);
  check('the request itself still answered normally', r.status === 200, r.status);

  log('\nB. Concurrent first requests create exactly one row');
  const b = authUser(2);
  await Promise.all([H.call('GET', '/api/onboarding/state', 'tok_' + b.id), H.call('GET', '/api/get-subscription', 'tok_' + b.id), H.call('PUT', '/api/user/preferences', 'tok_' + b.id, { theme: 'dark' })]);
  await sleep(50);
  check('one row, complete (not a bare row from the preferences upsert)', prof(b.id).length === 1 && prof(b.id)[0].email === 'person2@example.invalid' && prof(b.id)[0].first_name === 'Sam', prof(b.id));

  log('\nC. A bare row gets only its empty identity fields');
  const c = authUser(3);
  H.rows('profiles').push({ id: c.id, timezone: 'Europe/Amsterdam', subscription_status: 'starter', credits_balance: 777, stripe_customer_id: 'cus_C', email: null, first_name: null, last_name: null });
  await H.call('GET', '/api/onboarding/state', 'tok_' + c.id);
  p = prof(c.id)[0];
  check('email and name filled from Auth', p.email === 'person3@example.invalid' && p.first_name === 'Sam' && p.last_name === 'Lee', p);
  check('plan, credits, Stripe id and timezone unchanged', p.subscription_status === 'starter' && p.credits_balance === 777 && p.stripe_customer_id === 'cus_C' && p.timezone === 'Europe/Amsterdam', p);

  log('\nD. An existing complete profile is never changed');
  const d = authUser(4, { first_name: 'AuthName', last_name: 'AuthLast' });
  const orig = { id: d.id, email: 'chosen@example.invalid', first_name: 'Chosen', last_name: 'Name', subscription_status: 'professional', credits_balance: 4000, stripe_customer_id: 'cus_D', stripe_subscription_id: 'sub_D', onboarding_completed: true };
  H.rows('profiles').push(Object.assign({}, orig));
  await H.call('GET', '/api/onboarding/state', 'tok_' + d.id);
  check('row identical after a signed-in request (Auth metadata does not overwrite it)', JSON.stringify(prof(d.id)[0]) === JSON.stringify(orig), prof(d.id)[0]);
  r = await accounts.ensureProfile(d);
  check('ensureProfile directly: no write for a complete row', r.created === false && !r.filled && JSON.stringify(prof(d.id)[0]) === JSON.stringify(orig), r);

  log('\nE. Account deletion never leaves a login without its profile');
  const e = authUser(5);
  const eRow = { id: e.id, email: 'person5@example.invalid', first_name: 'Sam', subscription_status: 'creator', credits_balance: 1500, stripe_customer_id: 'cus_E', stripe_subscription_id: 'sub_E', onboarding_completed: true };
  H.rows('profiles').push(Object.assign({}, eRow));
  H.AUTH.deleteFail = 'Database error deleting user';
  r = await H.call('POST', '/api/account/delete', 'tok_' + e.id);
  p = prof(e.id);
  check('Auth deletion fails → error to the user', r.status === 500, r);
  check('…and the profile is back, identical (plan, credits, Stripe ids)', p.length === 1 && ['subscription_status', 'credits_balance', 'stripe_customer_id', 'stripe_subscription_id', 'email', 'first_name', 'onboarding_completed'].every((k) => p[0][k] === eRow[k]), p);
  r = await H.call('POST', '/api/account/delete', 'tok_' + e.id);
  check('a successful deletion removes both the profile and the login', r.status === 200 && prof(e.id).length === 0 && H.AUTH.deleted.includes(e.id), { status: r.status, rows: prof(e.id).length });

  log('\nF. Restore logic (scripts/restore-missing-profiles.js uses accounts.ensureProfile)');
  const f = authUser(6, {});
  r = await accounts.ensureProfile(f);
  check('Auth user without name metadata: row created with email, name left empty', r.created === true && prof(f.id)[0].email === 'person6@example.invalid' && prof(f.id)[0].first_name == null, prof(f.id)[0]);
  r = await accounts.ensureProfile(f);
  check('running it again changes nothing (idempotent)', r.created === false && prof(f.id).length === 1, r);
  check('no unexpected outbound requests', H.net.blocked.length === 0, H.net.blocked);

  done();
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
