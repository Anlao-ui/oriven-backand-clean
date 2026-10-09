// ════════════════════════════════════════════════════════════════
// Database security — runs the REAL 2026-10 migration files against a real
// Postgres (PGlite, Postgres compiled to WebAssembly) set up like Supabase:
// roles anon / authenticated / service_role, auth.uid(), Supabase's default
// "GRANT ALL" privileges, and the production profiles policy
// ("update own profile": auth.uid() = id).
//
// Proves: before the lockdown a signed-in user can raise their own credits;
// after it, browsers can read only their own row and write nothing, while
// the backend (service role) still can. Also: existing data untouched, new
// columns empty, every migration safe to run twice.
//
// Needs @electric-sql/pglite (not a dependency of this app):
//   npm install --no-save @electric-sql/pglite   (or set PGLITE_PATH)
// RUN: node tests/db-security.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const MIG = path.resolve(__dirname, '..', 'docs', 'migrations');
let PGlite;
try { PGlite = require(process.env.PGLITE_PATH || '@electric-sql/pglite').PGlite; } catch (_) {
  console.log('SKIPPED — @electric-sql/pglite not installed (npm install --no-save @electric-sql/pglite, or set PGLITE_PATH).');
  process.exit(0);
}
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 300))); };
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const ORDER = ['2026-10-onboarding-activation.sql', '2026-10-signup-verification.sql', '2026-10-email-lifecycle.sql', '2026-10-free-first-ad.sql', '2026-10-profiles-lockdown.sql', '2026-10-analytics.sql'];

(async () => {
  const db = new PGlite();
  // ── Supabase-like setup ──
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY, email text, first_name text, last_name text,
      subscription_status text DEFAULT 'free', credits_balance integer DEFAULT 0,
      credits_cycle_start timestamptz, credits_cycle_end timestamptz, credits_provisioned_plan text,
      stripe_customer_id text, stripe_subscription_id text, pending_plan text, pending_plan_date timestamptz,
      onboarding_completed boolean, primary_goal text, free_campaign_used boolean, free_campaign_used_at timestamptz,
      preferences jsonb, created_at timestamptz DEFAULT now()
    );
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "select own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
    CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
    CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
    GRANT UPDATE (credits_balance) ON public.profiles TO authenticated;   -- a stray column grant, to prove it is removed too
    INSERT INTO public.profiles (id, email, subscription_status, credits_balance, stripe_customer_id, stripe_subscription_id, pending_plan, onboarding_completed, created_at) VALUES
      ('${A}', 'a@example.invalid', 'starter', 1000, 'cus_A', 'sub_A', 'creator', true, '2026-05-01'),
      ('${B}', 'b@example.invalid', 'professional', 4000, 'cus_B', 'sub_B', null, true, '2026-06-01'),
      ('${C}', 'c@example.invalid', 'free', 10, null, null, null, false, '2026-09-01');
  `);
  const asUser = async (uid, sql) => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false);`);
    try { const r = await db.query(sql); return { ok: true, rows: r.rows, affected: r.affectedRows }; }
    catch (e) { return { ok: false, error: e.message }; }
    finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`); }
  };
  const asRole = async (role, sql) => {
    await db.exec(`SET ROLE ${role};`);
    try { const r = await db.query(sql); return { ok: true, rows: r.rows, affected: r.affectedRows }; }
    catch (e) { return { ok: false, error: e.message }; }
    finally { await db.exec('RESET ROLE;'); }
  };
  const snapshot = async () => JSON.stringify((await db.query(`SELECT id, email, subscription_status, credits_balance, stripe_customer_id, stripe_subscription_id, pending_plan, onboarding_completed, created_at FROM public.profiles ORDER BY id`)).rows);

  console.log('\nA. Before the lockdown (production today)');
  let r = await asUser(A, `UPDATE public.profiles SET credits_balance = 999999 WHERE id = '${A}'`);
  check('VULNERABLE: a signed-in user can raise their own credits', r.ok && r.affected === 1, r);
  r = await asUser(C, `UPDATE public.profiles SET subscription_status = 'professional' WHERE id = '${C}'`);
  check('VULNERABLE: a Free user can make themselves Professional', r.ok && r.affected === 1, r);
  await db.exec(`UPDATE public.profiles SET credits_balance = 1000 WHERE id = '${A}'; UPDATE public.profiles SET subscription_status = 'free' WHERE id = '${C}';`);
  const before = await snapshot();

  console.log('\nB. Apply the migrations (real files, in order, each in a transaction)');
  for (const f of ORDER) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    try { await db.exec('BEGIN;\n' + sql + '\nCOMMIT;'); check('applied ' + f, true); }
    catch (e) { await db.exec('ROLLBACK;').catch(() => {}); check('applied ' + f, false, e.message); }
  }

  console.log('\nC. Browsers can no longer write profiles');
  const cols = { credits_balance: '999999', subscription_status: "'professional'", stripe_customer_id: "'cus_evil'", stripe_subscription_id: "'sub_evil'",
    pending_plan: "'professional'", credits_cycle_end: "'2099-01-01'", onboarding_completed: 'false', free_campaign_used: 'false', free_campaign_used_at: 'null',
    email_verified: 'true', marketing_opt_in: 'true', first_value_at: 'now()', primary_goal: "'create'", email: "'x@evil.invalid'" };
  for (const [c, v] of Object.entries(cols)) {
    r = await asUser(A, `UPDATE public.profiles SET ${c} = ${v} WHERE id = '${A}'`);
    check(`own row: UPDATE ${c} → permission denied`, !r.ok && /permission denied/.test(r.error), r);
  }
  r = await asUser(A, `INSERT INTO public.profiles (id, subscription_status, credits_balance) VALUES ('${A.replace(/^1/, '4')}', 'professional', 99999)`);
  check('INSERT a profile → permission denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `DELETE FROM public.profiles WHERE id = '${A}'`);
  check('DELETE own profile → permission denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asRole('anon', `UPDATE public.profiles SET credits_balance = 1 WHERE true`);
  check('anon UPDATE → permission denied', !r.ok && /permission denied/.test(r.error), r);

  console.log('\nD. Reading still works, only your own row');
  r = await asUser(A, `SELECT id, subscription_status, credits_balance FROM public.profiles`);
  check('signed-in user sees exactly their own row (plan + credits readable)', r.ok && r.rows.length === 1 && r.rows[0].id === A && r.rows[0].credits_balance === 1000, r);
  r = await asUser(A, `SELECT * FROM public.profiles WHERE id = '${B}'`);
  check("another customer's row is invisible", r.ok && r.rows.length === 0, r);
  r = await asRole('anon', `SELECT id FROM public.profiles`);
  check('logged-out visitor sees no profiles', (r.ok && r.rows.length === 0) || (!r.ok && /permission denied/.test(r.error)), r);

  console.log('\nE. New tables are backend-only');
  for (const t of ['events', 'email_sends', 'email_suppressions', 'free_first_ad_claims']) {
    const sel = await asUser(A, `SELECT * FROM public.${t}`);
    check(`${t}: browser SELECT → denied`, !sel.ok && /permission denied/.test(sel.error), sel);
  }
  r = await asUser(A, `INSERT INTO public.free_first_ad_claims (user_id, attempts) VALUES ('${A}', 0)`);
  check('free_first_ad_claims: a user cannot create/reset their own claim', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `INSERT INTO public.events (event_name) VALUES ('x')`);
  check('events: browser INSERT → denied', !r.ok && /permission denied/.test(r.error), r);

  console.log('\nF. The backend (service role) still does everything it needs');
  r = await asRole('service_role', `UPDATE public.profiles SET credits_balance = credits_balance - 25 WHERE id = '${A}'`);
  check('service role: spend credits', r.ok && r.affected === 1, r);
  await db.exec(`UPDATE public.profiles SET credits_balance = 1000 WHERE id = '${A}'`);
  r = await asRole('service_role', `UPDATE public.profiles SET onboarding_completed = true, primary_goal = 'create', onboarding_completed_at = now(), first_value_at = now(), first_value_kind = 'create', email_verified = false, verification_token_hash = 'h', verification_sent_at = now(), marketing_opt_in = true WHERE id = '${C}'`);
  check('service role: onboarding, first value, verification and consent columns', r.ok && r.affected === 1, r);
  r = await asRole('service_role', `INSERT INTO public.profiles (id, subscription_status, onboarding_completed) VALUES ('${'55555555-5555-4555-8555-555555555555'}', 'free', false) ON CONFLICT (id) DO NOTHING`);
  check('service role: create a missing profile (POST /api/profile/ensure)', r.ok && r.affected === 1, r);
  r = await asRole('service_role', `INSERT INTO public.events (event_name, user_id, props) VALUES ('signup_completed', '${A}', '{"plan":"free"}') RETURNING id`);
  check('service role: events insert (id sequence works)', r.ok && r.rows.length === 1, r);
  r = await asRole('service_role', `INSERT INTO public.email_sends (user_id, template, dedupe_key, category, status) VALUES ('${A}', 'welcome', 'welcome', 'service', 'sending') RETURNING id`);
  check('service role: email_sends insert (uuid default works)', r.ok && /^[0-9a-f-]{36}$/.test(r.rows[0].id), r);
  r = await asRole('service_role', `INSERT INTO public.email_sends (user_id, template, dedupe_key, category, status) VALUES ('${A}', 'welcome', 'welcome', 'service', 'sending')`);
  check('email_sends: duplicate (user, email) rejected by the database', !r.ok && /duplicate key/.test(r.error), r);
  r = await asRole('service_role', `INSERT INTO public.email_sends (user_id, template, dedupe_key, category, status) VALUES ('${A}', 'x', 'x', 'promo', 'sending')`);
  check('email_sends: unknown category rejected', !r.ok && /check constraint/.test(r.error), r);
  r = await asRole('service_role', `INSERT INTO public.free_first_ad_claims (user_id, claimed_at, attempts) VALUES ('${C}', now(), 1)`);
  const dup = await asRole('service_role', `INSERT INTO public.free_first_ad_claims (user_id, claimed_at, attempts) VALUES ('${C}', now(), 1)`);
  check('free_first_ad_claims: one row per account (second claim rejected)', r.ok && !dup.ok && /duplicate key/.test(dup.error), { r, dup });
  r = await asRole('service_role', `INSERT INTO public.email_suppressions (email_hash, reason) VALUES ('abc', 'hard_bounce')`);
  check('service role: suppression insert', r.ok, r);

  console.log('\nF2. Analytics migration (site_pageviews, one-time events, summary function)');
  r = await asUser(A, `SELECT count(*) FROM public.site_pageviews`);
  check('site_pageviews: browser SELECT → denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `INSERT INTO public.site_pageviews (path, visitor_hash) VALUES ('/', 'x')`);
  check('site_pageviews: browser INSERT → denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asRole('anon', `SELECT public.analytics_site_summary(now() - interval '1 day', now())`);
  const r2 = await asUser(A, `SELECT public.analytics_site_summary(now() - interval '1 day', now())`);
  check('analytics_site_summary: anon and signed-in users can not execute it', !r.ok && !r2.ok && /permission denied/.test(r.error + r2.error), [r.error, r2.error]);
  r = await asUser(A, `UPDATE public.profiles SET acq_channel = 'google_ads' WHERE id = '${A}'`);
  check('attribution columns are not writable from the browser', !r.ok);
  await asRole('service_role', `INSERT INTO public.site_pageviews (path, entry, channel, visitor_hash, created_at) VALUES
    ('/', true, 'google_organic', 'h1', now() - interval '2 hours'), ('/pricing', false, 'direct', 'h1', now() - interval '1 hour'),
    ('/learn/', true, 'linkedin', 'h2', now() - interval '1 hour'), ('/', true, 'direct', 'h3', now() - interval '3 days')`);
  await asRole('service_role', `INSERT INTO public.site_pageviews (kind, path, visitor_hash) VALUES ('signup_started', '/signup', 'h2')`);
  r = await asRole('service_role', `SELECT public.analytics_site_summary(now() - interval '1 day', now()) AS s`);
  const sm = r.ok && r.rows[0].s;
  check('summary: 3 page views, 2 visitors, 2 entries, 1 signup start in the last day', sm && Number(sm.pageviews) === 3 && Number(sm.visitors) === 2 && Number(sm.entries) === 2 && Number(sm.signupStarts) === 1, sm);
  check('summary: channels and landing pages from entries only', sm && JSON.stringify(sm.channels.map((x) => x.channel).sort()) === '["google_organic","linkedin"]' && sm.landingPages.length === 2, sm && sm.channels);
  r = await asRole('service_role', `INSERT INTO public.events (event_name, user_id) VALUES ('email_verified', '${B}')`);
  const d1 = await asRole('service_role', `INSERT INTO public.events (event_name, user_id) VALUES ('email_verified', '${B}')`);
  const d2 = await asRole('service_role', `INSERT INTO public.events (event_name, user_id) VALUES ('checkout_started', '${B}'), ('checkout_started', '${B}')`);
  check('one-time events unique per user (duplicate → 23505); repeatable events allowed', r.ok && !d1.ok && /duplicate key/.test(d1.error) && d2.ok, [r, d1.error, d2.error]);
  r = await asRole('service_role', `INSERT INTO public.site_pageviews (path, visitor_hash, channel) VALUES ('/' || repeat('x', 300), 'h', 'direct')`);
  check('oversized values rejected by the table itself', !r.ok, r);

  console.log('\nG. Existing data and re-running');
  await db.exec(`UPDATE public.profiles SET onboarding_completed = false, primary_goal = null WHERE id = '${C}'; DELETE FROM public.profiles WHERE id = '55555555-5555-4555-8555-555555555555';`);
  check('existing customer rows unchanged by the migrations (plan, credits, Stripe ids, pending plan)', (await snapshot()) === before);
  const nulls = (await db.query(`SELECT count(*)::int AS n FROM public.profiles WHERE id IN ('${A}','${B}') AND email_verified IS NULL AND marketing_opt_in IS NULL AND first_value_at IS NULL AND onboarding_completed_at IS NULL`)).rows[0].n;
  check('new columns are empty (NULL) for existing customers', nulls === 2, nulls);
  const noFreeAdOnProfiles = (await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name LIKE 'free_first_ad%'`)).rows[0].n;
  check('no free-first-ad columns on profiles', noFreeAdOnProfiles === 0);
  const snap2 = await snapshot();
  for (const f of ORDER) {
    try { await db.exec('BEGIN;\n' + fs.readFileSync(path.join(MIG, f), 'utf8') + '\nCOMMIT;'); check('re-run ' + f + ' → no error', true); }
    catch (e) { await db.exec('ROLLBACK;').catch(() => {}); check('re-run ' + f, false, e.message); }
  }
  check('re-running changes no data', (await snapshot()) === snap2);
  r = await asUser(A, `UPDATE public.profiles SET credits_balance = 5 WHERE id = '${A}'`);
  check('still locked after re-run', !r.ok);

  console.log('\nH. The verification queries from the instructions');
  const grants = (await db.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='profiles' AND grantee='authenticated' ORDER BY 1`)).rows.map((x) => x.privilege_type);
  check('authenticated has only SELECT on profiles', JSON.stringify(grants) === '["SELECT"]', grants);
  const colw = (await db.query(`SELECT count(*)::int AS n FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='profiles' AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE','REFERENCES')`)).rows[0].n;
  check('no column-level write grants left for browser roles', colw === 0, colw);
  const rls = (await db.query(`SELECT relname FROM pg_class WHERE relname IN ('profiles','events','email_sends','email_suppressions','free_first_ad_claims','site_pageviews') AND relrowsecurity ORDER BY 1`)).rows.map((x) => x.relname);
  check('row-level security on for all six tables', rls.length === 6, rls);

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(1); });
