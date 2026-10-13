// ════════════════════════════════════════════════════════════════
// Restores the profiles row of Supabase Auth users that have none.
//
// Uses the same code the app uses (accounts.ensureProfile): the row is
// created from Auth only — email, first and last name — with the defaults
// every new account gets (Free plan, onboarding not completed). Insert-only:
// a profile that exists (or appears meanwhile) is never overwritten.
//
// DRY RUN by default: prints what it would do (dates and field presence
// only — no email addresses, names or ids). Writes only with --apply.
//
// RUN (from server/, with the production .env):
//   node scripts/restore-missing-profiles.js            # dry run
//   node scripts/restore-missing-profiles.js --apply    # create the rows
// ════════════════════════════════════════════════════════════════
const path = require('path');
require('dotenv').config({ path: process.env.ENV_PATH || path.resolve(__dirname, '../../../.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');
const accounts = require('../services/accounts');

const APPLY = process.argv.includes('--apply');

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  accounts.init({ db });

  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  const { data: profs, error: pErr } = await db.from('profiles').select('id');
  if (pErr) throw pErr;
  const have = new Set(profs.map((p) => p.id));
  const missing = users.filter((u) => !have.has(u.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — auth users ${users.length}, profiles ${profs.length}, missing ${missing.length}`);
  let created = 0, skipped = 0, failed = 0;
  for (const u of missing) {
    const m = u.user_metadata || {};
    const desc = `created ${String(u.created_at).slice(0, 16)} · email ${u.email ? 'yes' : 'no'} · first name ${m.first_name ? 'yes' : 'no'} · last name ${m.last_name ? 'yes' : 'no'}`;
    if (!APPLY) { console.log('  would restore:', desc); continue; }
    try {
      const r = await accounts.ensureProfile(u);
      if (r.created) { created++; console.log('  restored:', desc); }
      else { skipped++; console.log('  already present, left unchanged:', desc); }
    } catch (err) {
      failed++; console.log('  FAILED:', desc, '—', err.code || err.message);
    }
  }
  if (APPLY) console.log(`done — restored ${created}, already present ${skipped}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('ERROR', e.message); process.exit(1); });
