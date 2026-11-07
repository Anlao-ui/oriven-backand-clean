// ═══════════════════════════════════════════════════════════
// Deletes ONE OrivenAI account the supported way — the same steps as
// Settings → Delete account (services/accountDeletion.js): cancel a legacy
// Stripe subscription, remove the user's files, delete/anonymise the data
// (delete_account_data), release the email and soft-delete the sign-in
// account, then check the address is free to register again.
//
// Use this instead of deleting a row from public.profiles by hand: that leaves
// the Supabase Auth user (auth.users) in place, so the person can still sign
// in and the same email address can't create a new account. It also works for
// such an account (one whose profile row is already gone).
//
// DRY RUN by default (prints what it found; nothing changes). --apply deletes.
// RUN (from oriven-backend/server, with that environment's .env):
//   node scripts/delete-account.js --email someone@example.com
//   node scripts/delete-account.js --email someone@example.com --apply
//   node scripts/delete-account.js --user-id <uuid> --apply
// ═══════════════════════════════════════════════════════════
const path = require('path');
require('dotenv').config({ path: process.env.ENV_PATH || path.resolve(__dirname, '../../.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');
const deletion = require('../services/accountDeletion');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const BUCKET = 'manual-campaign-creatives'; // server.js MANUAL_CREATIVE_BUCKET

(async () => {
  const email = arg('--email'), userIdArg = arg('--user-id');
  if (!email && !userIdArg) throw new Error('Pass --email <address> or --user-id <uuid>.');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let userId = userIdArg;
  if (!userId) {
    const u = await deletion.findAuthUserByEmail(db, email);
    if (!u) { console.log('No sign-in account (auth user) has this email address. If a profile row still has it, it is an orphan: nothing blocks registering again.'); return; }
    userId = u.id;
  }
  const { data: prof } = await db.from('profiles').select('id, deleted_at, subscription_status, stripe_subscription_id').eq('id', userId).maybeSingle();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — account ${userId}: profile ${prof ? (prof.deleted_at ? 'already deleted (tombstone)' : 'present (' + prof.subscription_status + ')') : 'missing (deleted by hand?)'}; legacy Stripe subscription: ${prof && prof.stripe_subscription_id ? 'yes — will be cancelled' : 'no'}`);
  if (!APPLY) { console.log('Nothing changed. Re-run with --apply to delete this account.'); return; }

  const Stripe = require('stripe');
  const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (prof && prof.stripe_subscription_id && !stripe) throw new Error('This account has a Stripe subscription but STRIPE_SECRET_KEY is not set; nothing was deleted.');
  const out = await deletion.deleteAccount({ db, stripe, storage: db.storage, bucket: BUCKET }, userId);
  console.log('Deleted. Sign-in account released and soft-deleted:', JSON.stringify(out.auth), '— the email address can register again.');
})().catch((e) => { console.error('FAILED (' + (e.code || 'error') + '):', e.message, '— nothing after the failed step ran; it is safe to run again.'); process.exit(1); });
