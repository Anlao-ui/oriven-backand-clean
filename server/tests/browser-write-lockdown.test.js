// ════════════════════════════════════════════════════════════════
// Browser write lockdown — runs the REAL migration files against a real
// Postgres (PGlite) set up like Supabase: roles anon / authenticated /
// service_role, auth.uid(), Supabase's default "GRANT ALL" privileges.
//
// Proves: after the 2026-09/10 migrations a signed-in user can write their
// own automations and campaigns straight through the API (skipping consent,
// validation and the creation charge); after 2026-11-browser-write-lockdown.sql
// they can only read their own rows, while the backend (service role) still
// writes. Covers automation_rules, campaigns and the autopilot_* tables.
//
// Needs @electric-sql/pglite (not a dependency of this app):
//   npm install --no-save @electric-sql/pglite   (or set PGLITE_PATH)
// RUN: node tests/browser-write-lockdown.test.js   (from oriven-backend/server)
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
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const R1 = 'aaaaaaaa-1111-4111-8111-111111111111', R2 = 'bbbbbbbb-2222-4222-8222-222222222222';

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "select own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
    INSERT INTO public.profiles VALUES ('${A}', 'a@example.invalid'), ('${B}', 'b@example.invalid');
    GRANT UPDATE (email) ON public.profiles TO authenticated;   -- a stray column grant
    -- the tables browsers must not touch (as in production: RLS on, Supabase default grants)
    CREATE TABLE public.integrations (id uuid PRIMARY KEY, user_id uuid, meta_access_token text);
    CREATE TABLE public.credit_actions (id uuid PRIMARY KEY, user_id uuid, status text);
    CREATE TABLE public.credit_transactions (id uuid PRIMARY KEY, user_id uuid, amount integer);
    CREATE TABLE public.stripe_webhook_events (id text PRIMARY KEY, status text);
    CREATE TABLE public.events (id bigserial PRIMARY KEY, user_id uuid, event_name text);
    DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['integrations','credit_actions','credit_transactions','stripe_webhook_events','events'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$;
    INSERT INTO public.integrations VALUES (gen_random_uuid(), '${A}', 'token-A'), (gen_random_uuid(), '${B}', 'token-B');
    INSERT INTO public.credit_transactions VALUES (gen_random_uuid(), '${A}', -30);
    INSERT INTO public.stripe_webhook_events VALUES ('evt_1', 'processed');
    -- brand_cores: the one table the frontend writes (own row); here without RLS, the unsafe case
    CREATE TABLE public.brand_cores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, brand_data jsonb, created_at timestamptz DEFAULT now());
    INSERT INTO public.brand_cores (user_id, brand_data) VALUES ('${A}', '{"name":"A"}'), ('${B}', '{"name":"B"}');
    CREATE TABLE public.truncate_probe (n int); INSERT INTO public.truncate_probe VALUES (1), (2);
    -- a view owned by the migration role reads with the owner's rights (no RLS for the reader)
    CREATE VIEW public.token_view AS SELECT user_id, meta_access_token FROM public.integrations;
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
  const apply = async (f) => {
    try { await db.exec('BEGIN;\n' + fs.readFileSync(path.join(MIG, f), 'utf8') + '\nCOMMIT;'); check('applied ' + f, true); return true; }
    catch (e) { await db.exec('ROLLBACK;').catch(() => {}); check('applied ' + f, false, e.message); return false; }
  };
  const evil = (id, uid) => `INSERT INTO automation_rules (id, user_id, name, action_type, mode, kind, enabled) VALUES ('${id}', '${uid}', 'x', 'increase_budget', 'automatic', 'rule', true)`;

  console.log('\nA. Existing migrations (production today)');
  if (!(await apply('2026-09-automation-rules-schema-cache.sql'))) return done();
  if (!(await apply('2026-10-automations.sql'))) return done();
  if (!(await apply('2026-09-campaigns-durable-persistence.sql'))) return done();
  if (!(await apply('2026-09-autopilot-recommendations-tasks-workflows.sql'))) return done();
  const CA = 'ffffffff-6666-4666-8666-666666666666';
  await db.exec(`INSERT INTO campaigns (id, user_id, source, name, status) VALUES ('${CA}', '${A}', 'oriven_generated', 'Spring', 'draft')`);
  let c0 = await asUser(A, `UPDATE campaigns SET status = 'published' WHERE id = '${CA}'`);
  check('VULNERABLE before: a user can rewrite their campaign status directly', c0.ok && c0.affected === 1, c0);
  await db.exec(`INSERT INTO automation_rules (id, user_id, name, action_type, mode, kind, enabled) VALUES ('${R1}', '${A}', 'A rule', 'pause_campaign', 'approval', 'rule', true), ('${R2}', '${B}', 'B rule', 'pause_campaign', 'notify', 'rule', true)`);
  let r = await asUser(A, evil('cccccccc-3333-4333-8333-333333333333', A));
  check('VULNERABLE before: a signed-in user can insert an automatic budget rule directly', r.ok && r.affected === 1, r);
  r = await asUser(A, `UPDATE automation_rules SET mode = 'automatic' WHERE id = '${R1}'`);
  check('VULNERABLE before: a user can switch their rule to automatic without consent', r.ok && r.affected === 1, r);
  await db.exec(`DELETE FROM automation_rules WHERE id = 'cccccccc-3333-4333-8333-333333333333'; UPDATE automation_rules SET mode = 'approval' WHERE id = '${R1}';`);

  console.log('\nB. Apply the lockdown');
  r = await asUser(A, `TRUNCATE public.truncate_probe`);
  check('VULNERABLE before: a signed-in user can TRUNCATE a table (RLS does not apply to TRUNCATE)', r.ok && (await db.query('SELECT count(*)::int n FROM truncate_probe')).rows[0].n === 0, r);
  await db.exec('INSERT INTO truncate_probe VALUES (1), (2)');
  r = await asUser(A, `SELECT meta_access_token FROM integrations`);
  check('before: integrations readable by signed-in browsers wherever RLS policies allow (table privilege granted)', (await db.query(`SELECT has_table_privilege('authenticated', 'public.integrations', 'SELECT') x`)).rows[0].x === true);
  r = await asUser(A, `SELECT user_id FROM brand_cores`);
  check('VULNERABLE before: brand_cores without RLS → a signed-in user reads every customer\'s brand', r.ok && r.rows.length === 2, r);
  r = await asUser(A, `SELECT meta_access_token FROM token_view`);
  check('VULNERABLE before: a view over integrations hands every customer\'s token to a signed-in user', r.ok && r.rows.length === 2, r);
  check('before: browsers hold MAINTAIN (VACUUM/REINDEX/LOCK) on tables', (await db.query(`SELECT has_table_privilege('authenticated', 'public.profiles', 'MAINTAIN') x`)).rows[0].x === true);

  if (!(await apply('2026-11-browser-write-lockdown.sql'))) return done();

  console.log('\nC. Browsers can no longer write automations');
  r = await asUser(A, evil('dddddddd-4444-4444-8444-444444444444', A));
  check('INSERT own rule → permission denied', !r.ok && /permission denied/.test(r.error), r);
  for (const [c, v] of [['mode', "'automatic'"], ['enabled', 'false'], ['action_params', `'{"percent":500}'`], ['scope', `'{"type":"account"}'`], ['deleted_at', 'now()'], ['charge', 'null']]) {
    r = await asUser(A, `UPDATE automation_rules SET ${c} = ${v} WHERE id = '${R1}'`);
    check(`UPDATE own rule ${c} → permission denied`, !r.ok && /permission denied/.test(r.error), r);
  }
  r = await asUser(A, `DELETE FROM automation_rules WHERE id = '${R1}'`);
  check('DELETE own rule → permission denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asRole('anon', `SELECT id FROM automation_rules`);
  check('anon: no access at all', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `UPDATE campaigns SET status = 'draft' WHERE id = '${CA}'`);
  check('campaigns: UPDATE own row → permission denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `INSERT INTO campaigns (user_id, source, name) VALUES ('${A}', 'manual', 'x')`);
  check('campaigns: INSERT → permission denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `DELETE FROM campaigns WHERE id = '${CA}'`);
  check('campaigns: DELETE own row → permission denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `SELECT id, status FROM campaigns`);
  check('campaigns: no direct read either (the app reads campaigns through the backend)', !r.ok && /permission denied/.test(r.error), r);
  for (const t of ['autopilot_recommendations', 'autopilot_tasks', 'autopilot_workflows']) {
    r = await asUser(A, `DELETE FROM ${t} WHERE user_id = '${A}'`);
    check(`${t}: DELETE → permission denied`, !r.ok && /permission denied/.test(r.error), r);
    r = await asUser(A, `SELECT count(*)::int AS n FROM ${t}`);
    check(`${t}: no direct read either`, !r.ok && /permission denied/.test(r.error), r);
  }

  console.log('\nD. Allowlist: browsers read only profiles and brand_cores');
  r = await asUser(A, `SELECT id, mode FROM automation_rules`);
  check('automation_rules: no direct read (nothing depends on its RLS any more)', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `SELECT meta_access_token FROM token_view`);
  check('the view over integrations: permission denied (views are locked too)', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `SELECT * FROM truncate_probe`);
  check('a table without RLS: a signed-in user can no longer read it', !r.ok && /permission denied/.test(r.error), r);
  r = await asRole('service_role', `SELECT mode FROM automation_rules WHERE id = '${R1}'`);
  check('the backend still reads the rule, unchanged', r.ok && r.rows.length === 1 && r.rows[0].mode === 'approval', r);

  console.log('\nE. The backend (service role) is unaffected');
  r = await asRole('service_role', `UPDATE automation_rules SET enabled = false, updated_at = now() WHERE id = '${R1}'`);
  check('service role can update', r.ok && r.affected === 1, r);
  r = await asRole('service_role', evil('eeeeeeee-5555-4555-8555-555555555555', A));
  check('service role can insert', r.ok && r.affected === 1, r);

  console.log('\nF. Safe to run twice, data kept');
  await apply('2026-11-browser-write-lockdown.sql');
  check('rows kept', (await db.query(`SELECT count(*)::int AS n FROM automation_rules`)).rows[0].n === 3);
  const g = await db.query(`SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name IN ('automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows') AND grantee IN ('anon','authenticated') ORDER BY 1, 2, 3`);
  check('second run in the same session (helpers recreated): no browser grants left on the five tables', g.rows.length === 0, g.rows);
  const pol = await db.query(`SELECT tablename, cmd FROM pg_policies WHERE tablename IN ('automation_rules','campaigns','autopilot_recommendations','autopilot_tasks','autopilot_workflows') AND cmd <> 'SELECT'`);
  check('no browser write policies left', pol.rows.length === 0, pol.rows);

  console.log('\nG. Every table: TRUNCATE, logged-out visitors, backend-only tables, brand_cores');
  const tables = (await db.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`)).rows.map((x) => x.relname);
  const priv = async (role, t, p) => (await db.query(`SELECT has_table_privilege($1, $2, $3) x`, [role, 'public.' + t, p])).rows[0].x;
  let open = [];
  for (const t of tables) for (const role of ['anon', 'authenticated']) for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) if (await priv(role, t, p)) open.push(role + ':' + t + ':' + p);
  check(`TRUNCATE / REFERENCES / TRIGGER / MAINTAIN: no browser role has them on any of the ${tables.length} tables`, open.length === 0, open);
  r = await asUser(A, `TRUNCATE public.truncate_probe`);
  check('TRUNCATE as a signed-in user → permission denied, rows kept', !r.ok && /permission denied/.test(r.error) && (await db.query('SELECT count(*)::int n FROM truncate_probe')).rows[0].n === 2, r);
  open = [];
  for (const t of tables) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) if (await priv('anon', t, p)) open.push(t + ':' + p);
  check('logged-out visitors (anon): no privilege on any table', open.length === 0, open);
  open = [];
  for (const t of tables.filter((x) => x !== 'brand_cores')) for (const p of ['INSERT', 'UPDATE', 'DELETE']) if (await priv('authenticated', t, p)) open.push(t + ':' + p);
  check('signed-in browsers: no INSERT / UPDATE / DELETE on any table except brand_cores', open.length === 0, open);
  for (const t of ['integrations', 'credit_actions', 'credit_transactions', 'stripe_webhook_events', 'events']) {
    r = await asUser(A, `SELECT * FROM ${t}`);
    check(`${t}: backend-only — a signed-in user cannot even read it`, !r.ok && /permission denied/.test(r.error), r);
  }
  r = await asUser(A, `UPDATE profiles SET email = 'evil@example.invalid' WHERE id = '${A}'`);
  check('the stray column grant on profiles is gone: UPDATE (email) denied', !r.ok && /permission denied/.test(r.error), r);
  r = await asUser(A, `SELECT id, email FROM profiles`);
  check('reading your own profile still works (only your own row)', r.ok && r.rows.length === 1 && r.rows[0].id === A, r);
  const bcRls = (await db.query(`SELECT relrowsecurity x FROM pg_class WHERE oid = 'public.brand_cores'::regclass`)).rows[0].x;
  check('brand_cores: RLS switched on, own-row policies created', bcRls === true && (await db.query(`SELECT count(*)::int n FROM pg_policies WHERE tablename = 'brand_cores'`)).rows[0].n === 4);
  r = await asUser(A, `SELECT user_id FROM brand_cores`);
  check('brand_cores: a user reads only their own brand', r.ok && r.rows.length === 1 && r.rows[0].user_id === A, r);
  r = await asUser(A, `UPDATE brand_cores SET brand_data = '{"name":"A2"}' WHERE user_id = '${A}'`);
  const r2 = await asUser(A, `UPDATE brand_cores SET brand_data = '{"hacked":true}' WHERE user_id = '${B}'`);
  check('brand_cores: the frontend can still update its own brand; another customer\'s is untouched', r.ok && r.affected === 1 && r2.ok && r2.affected === 0 && (await db.query(`SELECT brand_data->>'name' n FROM brand_cores WHERE user_id = '${B}'`)).rows[0].n === 'B', { r, r2 });
  r = await asUser(A, `INSERT INTO brand_cores (user_id, brand_data) VALUES ('${B}', '{}')`);
  check('brand_cores: inserting a brand for someone else → refused by RLS', !r.ok && /row-level security/.test(r.error), r);
  r = await asUser(A, `DELETE FROM brand_cores WHERE user_id = '${A}'`);
  check('brand_cores: the frontend can delete its own brand (as it does today)', r.ok && r.affected === 1, r);
  r = await asRole('service_role', `SELECT count(*)::int n FROM integrations`);
  check('the backend (service role) still reads backend-only tables', r.ok && r.rows[0].n === 2, r);
  await db.exec(`CREATE TABLE public.created_later (id int, user_id uuid)`);
  check('a table created later: no anon access, no browser writes or TRUNCATE by default', !(await priv('anon', 'created_later', 'SELECT')) && !(await priv('authenticated', 'created_later', 'INSERT')) && !(await priv('authenticated', 'created_later', 'TRUNCATE')));

  console.log('\nH. A table this role cannot change: the migration aborts, nothing half-applied');
  const db2 = new PGlite();
  await db2.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE editor NOLOGIN; CREATE ROLE supabase_admin NOLOGIN;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    GRANT USAGE, CREATE ON SCHEMA public TO editor, supabase_admin;
    CREATE TABLE public.mine (id int); ALTER TABLE public.mine OWNER TO editor; GRANT ALL ON public.mine TO anon, authenticated;
    CREATE TABLE public.not_mine (id int); ALTER TABLE public.not_mine OWNER TO supabase_admin;
    SET ROLE supabase_admin; GRANT ALL ON public.not_mine TO anon, authenticated; RESET ROLE;`);
  await db2.exec('SET ROLE editor');
  let e2 = null; try { await db2.exec(fs.readFileSync(path.join(MIG, '2026-11-browser-write-lockdown.sql'), 'utf8')); } catch (e) { e2 = e.message; }
  await db2.exec('ROLLBACK').catch(() => {}); await db2.exec('RESET ROLE');
  check('run by a non-owner: pre-flight aborts and names the table, its owner and what is open', /browser lockdown blocked — nothing applied\. Role editor cannot change: not_mine \(owner supabase_admin: .*anon SELECT.*authenticated TRUNCATE/.test(e2 || ''), e2);
  check('…and nothing was applied (its own table still has the old grants)', (await db2.query(`SELECT has_table_privilege('anon', 'public.mine', 'SELECT') x`)).rows[0].x === true);
  await db2.close();

  console.log('\nH2. integrations owned by supabase_admin: the owner locks it, then the lockdown runs');
  const db3 = new PGlite();
  await db3.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE editor NOLOGIN; CREATE ROLE supabase_admin NOLOGIN;
    GRANT authenticated TO editor;   -- as in Supabase: postgres may act as authenticated
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; GRANT USAGE, CREATE ON SCHEMA public TO editor, supabase_admin;
    CREATE TABLE public.mine (id int); ALTER TABLE public.mine OWNER TO editor; GRANT ALL ON public.mine TO anon, authenticated;
    SET ROLE supabase_admin;
    CREATE TABLE public.integrations (id int, user_id uuid, access_token text);
    INSERT INTO public.integrations VALUES (1, NULL, 'tok');
    GRANT ALL ON public.integrations TO anon, authenticated, service_role, editor; GRANT SELECT (access_token) ON public.integrations TO anon;
    RESET ROLE;`);
  const ownerFile = fs.readFileSync(path.join(MIG, '2026-11-integrations-owner-lockdown.sql'), 'utf8');
  const lockFile = fs.readFileSync(path.join(MIG, '2026-11-browser-write-lockdown.sql'), 'utf8');
  const tryAs = async (role, sql) => { let e = null; await db3.exec(`SET ROLE ${role}`); try { await db3.exec(sql); } catch (x) { e = x.message; } await db3.exec('ROLLBACK').catch(() => {}); await db3.exec('RESET ROLE'); return e; };
  const p3 = async (role, p) => (await db3.query(`SELECT ${/SELECT|INSERT|UPDATE|REFERENCES/.test(p) ? 'has_any_column_privilege' : 'has_table_privilege'}('${role}', 'public.integrations', '${p}') x`)).rows[0].x;
  let e4 = await tryAs('editor', ownerFile);
  check('owner file run by the migration role: refuses, names the owner, nothing applied', /must run as the table owner supabase_admin \(current role: editor\)/.test(e4 || '') && (await p3('anon', 'SELECT')), e4);
  e4 = await tryAs('editor', lockFile);
  check('lockdown before the owner step: blocked on integrations, nothing applied', /cannot change: integrations \(owner supabase_admin: .*anon SELECT/.test(e4 || '') && (await db3.query(`SELECT has_table_privilege('anon', 'public.mine', 'SELECT') x`)).rows[0].x === true, e4);
  e4 = await tryAs('supabase_admin', ownerFile);
  const ownerOk = !e4 && !(await p3('anon', 'SELECT')) && !(await p3('authenticated', 'SELECT')) && !(await p3('authenticated', 'UPDATE')) && !(await p3('authenticated', 'TRUNCATE'))
    && (await p3('service_role', 'SELECT')) && (await p3('service_role', 'DELETE'))
    && (await db3.query(`SELECT relrowsecurity x, pg_get_userbyid(relowner) o FROM pg_class WHERE oid = 'public.integrations'::regclass`)).rows[0].x === true;
  check('owner file run as supabase_admin: browsers lose read (incl. the token column grant), write and TRUNCATE; service_role keeps access; RLS on', ownerOk, e4);
  check('…ownership is unchanged', (await db3.query(`SELECT pg_get_userbyid(relowner) o FROM pg_class WHERE oid = 'public.integrations'::regclass`)).rows[0].o === 'supabase_admin');
  e4 = await tryAs('editor', lockFile);
  check('then the lockdown as the migration role succeeds and locks its own tables', !e4 && !(await db3.query(`SELECT has_table_privilege('anon', 'public.mine', 'SELECT') x`)).rows[0].x, e4);
  await db3.exec('SET ROLE service_role');
  const r3 = await db3.query(`SELECT count(*)::int n FROM public.integrations`).catch((x) => ({ error: x.message }));
  await db3.exec('RESET ROLE');
  check('the backend (service role) still reads integrations', r3.rows && r3.rows[0].n === 1, r3);
  await db3.exec('SET ROLE anon');
  const r4 = await db3.query(`SELECT access_token FROM public.integrations`).catch((x) => ({ error: x.message }));
  await db3.exec('RESET ROLE');
  check('a browser reading tokens: permission denied', /permission denied/.test(r4.error || ''), r4);
  await db3.close();

  console.log('\nJ. Browser-readable tables must be isolated and readable: the migration aborts otherwise');
  const lockSql = fs.readFileSync(path.join(MIG, '2026-11-browser-write-lockdown.sql'), 'utf8');
  const tryFixture = async (extra) => {
    const d = new PGlite();
    await d.exec(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
      GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text); GRANT ALL ON public.profiles TO anon, authenticated;
      CREATE TABLE public.team_members (owner_user_id uuid, accepted_user_id uuid); GRANT ALL ON public.team_members TO anon, authenticated;` + extra);
    let e = null; try { await d.exec(lockSql); } catch (x) { e = x.message; }
    await d.exec('ROLLBACK').catch(() => {});
    const stillOpen = (await d.query(`SELECT has_table_privilege('anon', 'public.team_members', 'SELECT') x`)).rows[0].x;
    await d.close();
    return { e, stillOpen };
  };
  let j = await tryFixture('');
  check('profiles with RLS off (every user could read every profile): aborts, nothing applied', /incomplete — nothing applied\. Still open: .*profiles \(row-level security off/.test(j.e || '') && j.stillOpen, j);
  j = await tryFixture('ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;');
  check('profiles with RLS on but no SELECT policy (the app would see nothing): aborts', /profiles \(no SELECT policy/.test(j.e || '') && j.stillOpen, j);
  j = await tryFixture(`ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id OR EXISTS (SELECT 1 FROM public.team_members t WHERE t.owner_user_id = profiles.id AND t.accepted_user_id = auth.uid()));`);
  check('a profiles policy that reads a now-locked table: the probe aborts, nothing applied (no broken app)', /could no longer read profiles\/brand_cores/.test(j.e || '') && j.stillOpen, j);
  j = await tryFixture(`ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; CREATE POLICY own ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);`);
  check('a correct own-row policy: applies', !j.e && !j.stillOpen, j);

  console.log('\nI. Rollback (emergency only)');
  const rowsBefore = (await db.query(`SELECT (SELECT count(*) FROM automation_rules) + (SELECT count(*) FROM brand_cores) + (SELECT count(*) FROM integrations) AS n`)).rows[0].n;
  let e3 = null; try { await db.exec(fs.readFileSync(path.join(MIG, '2026-11-browser-write-lockdown-rollback.sql'), 'utf8')); } catch (e) { e3 = e.message; }
  const pol2 = (await db.query(`SELECT count(*)::int n FROM pg_policies WHERE tablename = 'automation_rules' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')`)).rows[0].n;
  check('rollback restores the previous grants and write policies, changes no data', !e3 && pol2 === 3 && (await priv('authenticated', 'campaigns', 'INSERT')) && (await priv('anon', 'integrations', 'SELECT')) && (await db.query(`SELECT (SELECT count(*) FROM automation_rules) + (SELECT count(*) FROM brand_cores) + (SELECT count(*) FROM integrations) AS n`)).rows[0].n === rowsBefore, { e3, pol2 });
  return done();
  async function done() { console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`); setTimeout(() => process.exit(fail ? 1 : 0), 100); } // let PGlite settle first (Windows libuv abort otherwise)
})().catch((e) => { console.error(e); process.exit(1); });
