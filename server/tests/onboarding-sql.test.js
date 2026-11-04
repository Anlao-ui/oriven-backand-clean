// ════════════════════════════════════════════════════════════════
// docs/migrations/2026-10-onboarding-sessions.sql, executed for real in an
// in-process Postgres (PGlite): the table, its checks, re-running it, and
// that a signed-in browser (role authenticated / anon) can neither read nor
// write it — only the service role can — and the rollback.
//
// PGlite is not a dependency of this project. The test SKIPS (exit 0) unless
// it can load '@electric-sql/pglite' (point NODE_PATH at a node_modules
// folder that has it). No network, no Supabase.
//
// RUN: NODE_PATH=/path/to/node_modules node tests/onboarding-sql.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {
  console.log('SKIP — @electric-sql/pglite not found (set NODE_PATH to a node_modules folder that has it)');
  process.exit(0);
}

const migration = fs.readFileSync(path.join(__dirname, '..', 'docs', 'migrations', '2026-10-onboarding-sessions.sql'), 'utf8');
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 400) : '')); } }
async function fails(db, sql, params) { try { await db.query(sql, params || []); return null; } catch (e) { return e.message; } }

// The parts of the Supabase schema the migration references.
const BASE = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE purchases (id uuid PRIMARY KEY, user_id uuid);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase's default: new tables in public are granted to every API role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`;

(async () => {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(migration);
  const u = crypto.randomUUID(), p = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id) VALUES ($1)', [u]);
  await db.query('INSERT INTO purchases (id, user_id) VALUES ($1, $2)', [p, u]);

  await db.query('INSERT INTO onboarding_sessions (user_id) VALUES ($1)', [u]);
  const row = (await db.query('SELECT * FROM onboarding_sessions WHERE user_id = $1', [u])).rows[0];
  check('1. defaults: in_progress / welcome / plan none / 0 attempts / empty answers', row.status === 'in_progress' && row.step === 'welcome' && row.plan_status === 'none' && row.plan_attempts === 0 && JSON.stringify(row.answers) === '{}', row);
  check('2. one row per account (primary key)', !!(await fails(db, 'INSERT INTO onboarding_sessions (user_id) VALUES ($1)', [u])));
  check('3. unknown plan status rejected', !!(await fails(db, "UPDATE onboarding_sessions SET plan_status = 'unlocked' WHERE user_id = $1", [u])));
  check('4. unknown assistant rejected', !!(await fails(db, "UPDATE onboarding_sessions SET assistant = 'gandalf' WHERE user_id = $1", [u])));
  check('5. known assistant accepted', !(await fails(db, "UPDATE onboarding_sessions SET assistant = 'metric' WHERE user_id = $1", [u])));
  check('6. purchase reference must exist', !!(await fails(db, 'UPDATE onboarding_sessions SET purchase_id = $2 WHERE user_id = $1', [u, crypto.randomUUID()])) && !(await fails(db, 'UPDATE onboarding_sessions SET purchase_id = $2 WHERE user_id = $1', [u, p])));
  await db.query(`UPDATE onboarding_sessions SET plan = '{"summary":"secret plan"}'::jsonb, plan_status = 'ready' WHERE user_id = $1`, [u]);

  for (const role of ['authenticated', 'anon']) {
    await db.exec('SET ROLE ' + role);
    const readErr = await fails(db, 'SELECT plan FROM onboarding_sessions');
    const writeErr = await fails(db, "UPDATE onboarding_sessions SET plan_status = 'none'");
    const insErr = await fails(db, 'INSERT INTO onboarding_sessions (user_id) VALUES ($1)', [crypto.randomUUID()]);
    await db.exec('RESET ROLE');
    check(`7. ${role}: cannot read the plan, update or insert (permission denied)`, /permission denied/.test(readErr || '') && /permission denied/.test(writeErr || '') && /permission denied/.test(insErr || ''), { readErr, writeErr, insErr });
  }
  await db.exec('SET ROLE service_role');
  const svc = await db.query('SELECT plan FROM onboarding_sessions WHERE user_id = $1', [u]);
  await db.exec('RESET ROLE');
  check('8. service role (the backend) reads it', svc.rows.length === 1 && svc.rows[0].plan.summary === 'secret plan');
  const rls = (await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'onboarding_sessions'")).rows[0];
  const pol = (await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'onboarding_sessions'")).rows[0];
  check('9. row level security on, with no policy for browser roles', rls.relrowsecurity === true && pol.n === 0);

  let rerunErr = null; try { await db.exec(migration); } catch (e) { rerunErr = e.message; }
  check('10. migration can be run again', !rerunErr, rerunErr);
  await db.query('DELETE FROM auth.users WHERE id = $1', [u]);
  check('11. deleting the account deletes its onboarding row', (await db.query('SELECT 1 FROM onboarding_sessions WHERE user_id = $1', [u])).rows.length === 0);
  const rollback = migration.split('-- ── Rollback')[1].split('\n').filter((l) => /^--\s{3}\S/.test(l)).map((l) => l.replace(/^--\s+/, '')).join('\n');
  await db.exec(rollback);
  check('12. rollback drops only this table', (await db.query("SELECT to_regclass('public.onboarding_sessions') AS t, to_regclass('public.purchases') AS p")).rows[0].t === null);

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
