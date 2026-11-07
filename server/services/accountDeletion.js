// ── Account deletion: the one supported way to delete an OrivenAI account ──
//
// Used by POST /api/account/delete (the user, from Settings), the unverified-
// account cleanup job and scripts/delete-account.js (operators). Deleting a
// row from public.profiles by hand is NOT a deletion: the Supabase Auth user
// (auth.users) keeps the email address, so it can still sign in and the same
// address can't register again. Always use this.
//
// Steps, in order — each is safe to repeat, so a failure is fixed by retrying:
//   1. Stripe: a legacy monthly subscription is cancelled first (never leave
//      Stripe billing someone without an account). Stripe unsure → stop.
//   2. Storage: the user's uploaded and generated files (services/userStorage.js).
//   3. Database: delete_account_data (docs/migrations/2026-11-account-deletion.sql)
//      removes personal data, anonymises the profile (kept as a tombstone for
//      purchases/credit records) — one transaction.
//   4. Auth: the auth user's email is moved to a unique placeholder
//      (deleted-<id>@deleted.orivenai.invalid), then the user is soft-deleted
//      (Supabase Auth hashes the email, removes the password and sessions; the
//      row stays so the kept records' references stay valid). Moving the email
//      first frees the original address even where the email identity would
//      otherwise keep it.
//   5. Check: the auth user no longer holds the original address. If it still
//      does, the deletion is reported as failed (never as done).
//
// deps: { db (service-role Supabase client), stripe, storage, bucket }

const userStorage = require('./userStorage');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const placeholderEmail = (userId) => 'deleted-' + String(userId).toLowerCase() + '@deleted.orivenai.invalid';
const isPlaceholder = (email) => /@deleted\.orivenai\.invalid$/i.test(String(email || ''));

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

async function cancelSubscription(deps, userId) {
  const { data: profile, error } = await deps.db.from('profiles').select('stripe_subscription_id').eq('id', userId).maybeSingle();
  if (error) throw fail('DELETION_FAILED', error.message);
  const subId = profile && profile.stripe_subscription_id;
  if (!subId) return null;
  try {
    const sub = await deps.stripe.subscriptions.retrieve(subId);
    if (['canceled', 'incomplete_expired'].includes(sub.status)) return sub.status;
    await deps.stripe.subscriptions.cancel(subId);
    return 'canceled';
  } catch (err) {
    if (err && (err.code === 'resource_missing' || err.statusCode === 404)) return 'missing'; // unknown to Stripe: nothing is billing
    throw fail('STRIPE_CANCEL_FAILED', 'Stripe subscription could not be cancelled: ' + ((err && err.message) || err));
  }
}

const notFound = (err) => !!err && (Number(err.status) === 404 || /not.?found/i.test(String(err.message || '')));

async function getAuthUser(admin, userId) {
  if (typeof admin.getUserById !== 'function') return { user: null, unknown: true };
  const { data, error } = await admin.getUserById(userId);
  if (error) { if (notFound(error)) return { user: null }; throw fail('AUTH_DELETE_FAILED', error.message); }
  return { user: (data && data.user) || null };
}

// Steps 4–5. Returns { emailReleased, softDeleted }.
async function deleteAuthUser(deps, userId) {
  const admin = deps.db.auth.admin;
  const before = await getAuthUser(admin, userId);
  const original = before.user ? String(before.user.email || '').toLowerCase() : null;
  let emailReleased = !before.user || isPlaceholder(original) || !original;
  if (before.user && !emailReleased && typeof admin.updateUserById === 'function') {
    const { error } = await admin.updateUserById(userId, { email: placeholderEmail(userId), email_confirm: true, user_metadata: { deleted: true } });
    if (error && !notFound(error)) console.warn('[AccountDeletion] email not moved before soft delete (soft delete still hashes it):', String(error.message || '').slice(0, 120));
    else emailReleased = true;
  }
  const { error: delErr } = await admin.deleteUser(userId, true);
  if (delErr && !notFound(delErr)) throw fail('AUTH_DELETE_FAILED', delErr.message);
  // Step 5: the original address must be free now.
  if (original && !isPlaceholder(original)) {
    const after = await getAuthUser(admin, userId);
    // Soft-deleted or not: still holding the address means it can't register again.
    if (after.user && String(after.user.email || '').toLowerCase() === original) {
      throw fail('AUTH_DELETE_FAILED', 'the sign-in account still holds its email address');
    }
  }
  return { emailReleased, softDeleted: true };
}

async function deleteAccount(deps, userId) {
  if (!UUID.test(String(userId || ''))) throw fail('DELETION_FAILED', 'invalid user id');
  await cancelSubscription(deps, userId);
  try {
    const n = await userStorage.removeUserFiles(deps.storage, deps.bucket, userId);
    if (n) console.log('[Account] Removed', n, 'stored file(s) for', userId);
  } catch (err) { throw fail('STORAGE_DELETE_FAILED', err.message); }
  const { data, error } = await deps.db.rpc('delete_account_data', { p_user_id: userId });
  if (error) {
    const missing = /delete_account_data|PGRST202|42883/.test((error.code || '') + ' ' + (error.message || ''));
    throw fail(missing ? 'DELETION_NOT_MIGRATED' : 'DELETION_FAILED', missing ? 'account deletion is not available until the account-deletion migration has run' : error.message);
  }
  const auth = await deleteAuthUser(deps, userId);
  return Object.assign({}, data || {}, { auth });
}

// Operators: the account (auth user) for an email address, or null.
async function findAuthUserByEmail(db, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = (data && data.users) || [];
    const hit = users.find((u) => String(u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 1000) return null;
  }
  return null;
}

module.exports = { deleteAccount, deleteAuthUser, cancelSubscription, findAuthUserByEmail, placeholderEmail, isPlaceholder };
