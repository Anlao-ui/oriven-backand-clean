// ════════════════════════════════════════════════════════════════
// Function privileges — runs the REAL
// docs/migrations/2026-11-function-privileges.sql (and its rollback) against
// a real Postgres (PGlite) set up like Supabase, with the three functions
// production exposed to browsers on 2026-11-04 (bodies as documented in
// services/creditManager.js; increment_autopilot_usage and rls_auto_enable
// SECURITY DEFINER as found in production):
//   increment_autopilot_usage(p_user_id, p_limit, p_cycle_end)
//   increment_campaigns_generated(p_user_id)
//   rls_auto_enable()  — event trigger that enables RLS on new tables
//
// Proves: before, anon could raise another account's automation counter
// through the SECURITY DEFINER function; after, no browser role can execute
// any of them, the backend (service_role) still can and gets the same
// results, increment_autopilot_usage runs as invoker, the event trigger still
// enables RLS on new tables, new functions are not browser-executable by
// default, a function this role doesn't own is reported (not a failure),
// and the rollback restores the previous state.
//
// Needs @electric-sql/pglite:  npm install --no-save @electric-sql/pglite  (or PGLITE_PATH)
// RUN: node tests/function-privileges.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let PGlite;
try { PGlite = require(process.env.PGLITE_PATH || '@electric-sql/pglite').PGlite; } catch (_) {
  console.log('SKIPPED — @electric-sql/pglite not installed (npm install --no-save @electric-sql/pglite, or set PGLITE_PATH).');
  process.exit(0);
}
const MIG = path.resolve(__dirname, '..', 'docs', 'migrations');
const MIGRATION = fs.readFileSync(path.join(MIG, '2026-11-function-privileges.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(MIG, '2026-11-function-privileges-rollback.sql'), 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 500))); };

const AUTOPILOT = `
CREATE OR REPLACE FUNCTION increment_autopilot_usage(p_user_id uuid, p_limit integer, p_cycle_end timestamptz)
RETURNS TABLE(ok boolean, used integer) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_used integer; v_reset_at timestamptz;
BEGIN
  SELECT autopilot_executions_used, autopilot_cycle_reset_at INTO v_used, v_reset_at FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF v_reset_at IS NULL OR v_reset_at < now() THEN
    v_used := 0;
    UPDATE profiles SET autopilot_executions_used = 0, autopilot_cycle_reset_at = p_cycle_end WHERE id = p_user_id;
  END IF;
  IF v_used < p_limit THEN
    UPDATE profiles SET autopilot_executions_used = autopilot_executions_used + 1 WHERE id = p_user_id;
    RETURN QUERY SELECT true, v_used + 1;
  ELSE
    RETURN QUERY SELECT false, v_used;
  END IF;
END; $$;`;
const CAMPAIGNS = `
CREATE OR REPLACE FUNCTION increment_campaigns_generated(p_user_id uuid)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  UPDATE profiles SET campaigns_generated = campaigns_generated + 1 WHERE id = p_user_id RETURNING campaigns_generated INTO v_count;
  RETURN v_count;
END; $$;`;
const RLS_AUTO = `
CREATE OR REPLACE FUNCTION rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE' AND schema_name = 'public' LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END; $$;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION rls_auto_enable();`;

async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE editor NOLOGIN; CREATE ROLE supabase_admin NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, editor;
    GRANT USAGE, CREATE ON SCHEMA public TO anon, authenticated, service_role, editor, supabase_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, campaigns_generated integer NOT NULL DEFAULT 0, autopilot_executions_used integer NOT NULL DEFAULT 0, autopilot_cycle_reset_at timestamptz);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "select own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
    CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
  ` + AUTOPILOT + CAMPAIGNS + RLS_AUTO);
  return db;
}
async function as(db, role, sub, sql, params) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${sub || ''}', false);`);
  try { const r = await db.query(sql, params || []); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`); }
}
const can = async (db, role, sig) => (await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, sig])).rows[0].x;
const SIG = { auto: 'increment_autopilot_usage(uuid, integer, timestamptz)', camp: 'increment_campaigns_generated(uuid)', rls: 'rls_auto_enable()' };

(async () => {
  const A = crypto.randomUUID(), B = crypto.randomUUID();
  let db = await makeDb();
  await db.query(`INSERT INTO profiles (id) VALUES ($1), ($2)`, [A, B]);

  console.log('\n1. Before (production on 2026-11-04)');
  for (const [k, sig] of Object.entries(SIG)) check(`VULNERABLE before: anon and authenticated can execute ${sig}`, await can(db, 'anon', sig) && await can(db, 'authenticated', sig));
  let r = await as(db, 'anon', '', `SELECT * FROM increment_autopilot_usage($1, 100, now() + interval '30 days')`, [B]);
  check('VULNERABLE before: a logged-out visitor raises another account\'s automation counter (SECURITY DEFINER)', r.ok && r.rows[0].ok === true && (await db.query(`SELECT autopilot_executions_used n FROM profiles WHERE id = $1`, [B])).rows[0].n === 1, r);
  await db.query(`UPDATE profiles SET autopilot_executions_used = 0, autopilot_cycle_reset_at = NULL`);

  console.log('\n2. After the migration');
  let notices = [];
  await db.exec(MIGRATION);
  for (const [k, sig] of Object.entries(SIG)) check(`anon and authenticated cannot execute ${sig}`, !(await can(db, 'anon', sig)) && !(await can(db, 'authenticated', sig)));
  check('service_role can execute both increment functions', await can(db, 'service_role', SIG.auto) && await can(db, 'service_role', SIG.camp));
  r = await as(db, 'anon', '', `SELECT * FROM increment_autopilot_usage($1, 100, now() + interval '30 days')`, [B]);
  const r2 = await as(db, 'authenticated', A, `SELECT increment_campaigns_generated($1)`, [A]);
  check('browser calls refused: permission denied for function; counters unchanged', !r.ok && /permission denied for function/.test(r.error) && !r2.ok && /permission denied for function/.test(r2.error) && (await db.query(`SELECT sum(autopilot_executions_used + campaigns_generated)::int s FROM profiles`)).rows[0].s === 0, { r, r2 });
  r = await as(db, 'service_role', '', `SELECT * FROM increment_autopilot_usage($1, 2, now() + interval '30 days')`, [A]);
  let r3 = await as(db, 'service_role', '', `SELECT * FROM increment_autopilot_usage($1, 2, now() + interval '30 days')`, [A]);
  let r4 = await as(db, 'service_role', '', `SELECT * FROM increment_autopilot_usage($1, 2, now() + interval '30 days')`, [A]);
  check('backend (service_role): increment_autopilot_usage works as before (1, 2, then refused at the limit)', r.ok && r.rows[0].used === 1 && r3.rows[0].used === 2 && r4.rows[0].ok === false, [r, r3, r4]);
  r = await as(db, 'service_role', '', `SELECT increment_campaigns_generated($1) AS n`, [A]);
  check('backend (service_role): increment_campaigns_generated works (1)', r.ok && r.rows[0].n === 1, r);
  const defs = Object.fromEntries((await db.query(`SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('increment_autopilot_usage', 'rls_auto_enable')`)).rows.map((x) => [x.proname, x]));
  check('increment_autopilot_usage now SECURITY INVOKER (owner rights not needed)', defs.increment_autopilot_usage.prosecdef === false);
  check('rls_auto_enable stays definer with a fixed search_path', defs.rls_auto_enable.prosecdef === true && (defs.rls_auto_enable.proconfig || []).some((c) => /^search_path=public, ?pg_temp$/.test(c)), defs.rls_auto_enable);
  await db.exec(`SET ROLE editor; CREATE TABLE public.made_by_editor (id int); RESET ROLE;`);
  check('the event trigger still enables RLS on a new table created by a non-superuser role', (await db.query(`SELECT relrowsecurity x FROM pg_class WHERE relname = 'made_by_editor'`)).rows[0].x === true);
  await db.exec(`CREATE FUNCTION public.new_helper() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`);
  check('a function created later is not browser-executable by default, service_role can', !(await can(db, 'anon', 'new_helper()')) && !(await can(db, 'authenticated', 'new_helper()')) && await can(db, 'service_role', 'new_helper()'));
  let err = null; try { await db.exec(MIGRATION); } catch (e) { err = e.message; }
  check('re-running the migration: no error, same privileges', !err && !(await can(db, 'anon', SIG.auto)) && await can(db, 'service_role', SIG.auto), err);

  console.log('\n3. A function owned by another role (e.g. Supabase\'s own) is reported, not fatal');
  const db2 = await makeDb();
  await db2.exec(`ALTER FUNCTION rls_auto_enable() OWNER TO supabase_admin; GRANT ALL ON ALL TABLES IN SCHEMA public TO editor; ALTER FUNCTION increment_autopilot_usage(uuid, integer, timestamptz) OWNER TO editor; ALTER FUNCTION increment_campaigns_generated(uuid) OWNER TO editor;`);
  await db2.exec('SET ROLE editor');
  err = null; try { await db2.exec(MIGRATION); } catch (e) { err = e.message; }
  await db2.exec('RESET ROLE');
  check('run as a non-owner: migration completes (the not-owned function is skipped with a NOTICE)', !err, err);
  check('…the functions it owns are fixed', !(await can(db2, 'anon', SIG.auto)) && !(await can(db2, 'authenticated', SIG.camp)));
  check('…the not-owned one is left as it was — the verification script (block 10) shows it', await can(db2, 'anon', SIG.rls));
  await db2.close();

  console.log('\n4. Rollback');
  err = null; try { await db.exec(ROLLBACK); } catch (e) { err = e.message; }
  const after = Object.fromEntries((await db.query(`SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('increment_autopilot_usage')`)).rows.map((x) => [x.proname, x.prosecdef]));
  check('rollback restores the previous state (browser EXECUTE, increment_autopilot_usage definer)', !err && await can(db, 'anon', SIG.auto) && await can(db, 'authenticated', SIG.camp) && after.increment_autopilot_usage === true, err);
  await db.close();

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch((e) => { console.log('CRASH', e && e.stack || e); setTimeout(() => process.exit(1), 100); });
