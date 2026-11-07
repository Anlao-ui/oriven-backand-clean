# Deleting an account

## The rule

An OrivenAI account is two things:

- **the sign-in account** — the Supabase Auth user in `auth.users` (email, password, sessions);
- **the application data** — `public.profiles` and everything that references it (business details, campaigns, files, automations, onboarding, purchases, the credit ledger, …).

Deleting a row from `public.profiles` (or any other table) by hand is **not** a deletion:

- the Auth user still exists, so the person can still sign in (the app recreates a bare profile on the next request);
- the email address is still registered, so signing up again with it is refused ("An account with this email address already exists");
- the profile delete itself fails or leaves orphans for any account with purchases, campaigns or other referencing rows.

## The supported ways

All of them run the same code, `services/accountDeletion.js`:

| Who | How |
|---|---|
| The person | Settings → Delete account (`POST /api/account/delete`) |
| Unverified accounts older than 14 days | the `unverified-account-cleanup` job (only when `UNVERIFIED_ACCOUNT_CLEANUP=true`) |
| An operator | `node scripts/delete-account.js --email <address>` (dry run) then add `--apply` — from `oriven-backend/server`, with that environment's `.env` |

Steps, in this order (each is safe to repeat, so a failure is fixed by running it again):

1. A legacy Stripe subscription is cancelled. If Stripe can't confirm, nothing is deleted.
2. The user's uploaded and generated files are removed from Storage.
3. `delete_account_data(user_id)` (migration `2026-11-account-deletion.sql`) deletes the personal data and keeps the profile as an anonymised tombstone, because purchases and the credit ledger are kept for bookkeeping and reference it.
4. The Auth user's email is moved to `deleted-<id>@deleted.orivenai.invalid`, then the user is soft-deleted. Supabase hashes the email, removes the password and sessions, and keeps the row so the kept records stay valid.
5. A check that the Auth user no longer holds the original address. If it still does, the deletion is reported as **failed**, never as done.

Afterwards, the same address can register again and gets a completely new account (new id, new profile). The old tombstone stays separate.

## Accounts deleted by hand earlier

This read-only query, run in the Supabase SQL editor, lists sign-in accounts without a profile row:

```sql
SELECT u.id, u.created_at, u.deleted_at IS NOT NULL AS soft_deleted
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
 WHERE p.id IS NULL
 ORDER BY u.created_at DESC;
```

Rows with `soft_deleted = false` still block their email address. Delete each one properly with `node scripts/delete-account.js --user-id <id> --apply` (it handles a missing profile). If the person wants to keep the account, they can simply sign in, and the app recreates their profile.

Do not delete `auth.users` rows by hand either. A hard delete cascades into, or is blocked by, the kept financial records.
