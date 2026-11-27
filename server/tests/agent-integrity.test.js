// ════════════════════════════════════════════════════════════════
// Personal assistant integrity (services/agents.js), without a database:
// a small in-memory fake stands in for Supabase so failures can be injected.
//
//   A. A failed lookup never answers with another assistant (throws
//      AGENT_LOOKUP_FAILED) and never writes anything
//   B. The onboarding copy is used only when the profile was READ and has no
//      choice; the copy keeps every other preference
//   C. Chosen once: another id is refused, the same id is a no-op
//   D. One user's choice never touches another user's row
//
// RUN: node tests/agent-integrity.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const agents = require(path.join(__dirname, '..', 'services', 'agents'));

let pass = 0, fail = 0;
function check(name, ok, info) { if (ok) pass++; else { fail++; console.log('FAIL — ' + name + (info !== undefined ? ' | ' + JSON.stringify(info) : '')); } }

// tables: { profiles: [{id, preferences}], onboarding_sessions: [{user_id, assistant}] }
// fail: { 'profiles:select': err, 'onboarding_sessions:select': err, ... }
function fakeDb(tables, failOn) {
  const writes = [];
  const fails = failOn || {};
  const keyCol = (t) => (t === 'profiles' ? 'id' : 'user_id');
  return {
    writes,
    from(table) {
      const rows = tables[table] || (tables[table] = []);
      return {
        select() {
          return { eq(col, val) { return { async maybeSingle() {
            if (fails[table + ':select']) return { data: null, error: fails[table + ':select'] };
            const r = rows.find((x) => x[col] === val);
            return { data: r ? JSON.parse(JSON.stringify(r)) : null, error: null };
          } }; } };
        },
        update(obj) {
          return { async eq(col, val) {
            if (fails[table + ':update']) return { error: fails[table + ':update'] };
            writes.push({ table, col, val, obj: JSON.parse(JSON.stringify(obj)) });
            rows.filter((x) => x[col] === val).forEach((x) => Object.assign(x, obj));
            return { error: null };
          } };
        },
        _key: keyCol(table),
      };
    },
  };
}
const NET = { message: 'fetch failed', code: 'ECONNRESET' };
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';

(async () => {
  // ── A. failures
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: { assistant: 'momentum', theme: 'dark' } }], onboarding_sessions: [{ user_id: A, assistant: 'scout' }] }, { 'profiles:select': NET });
    let err = null; try { await agents.resolveAgent(db, A); } catch (e) { err = e; }
    check('A1 profile read fails → AGENT_LOOKUP_FAILED (503), not the default or the onboarding copy', err && err.code === 'AGENT_LOOKUP_FAILED' && err.status === 503, err && err.code);
    check('A2 …and nothing is written (preferences not replaced by the old onboarding choice)', db.writes.length === 0, db.writes);
    let e2 = null; try { await agents.chooseAgent(db, A, 'vector'); } catch (e) { e2 = e; }
    check('A3 choosing while the lookup fails is refused (no overwrite of Momentum)', e2 && e2.code === 'AGENT_LOOKUP_FAILED' && db.writes.length === 0, e2 && e2.code);
  }
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: {} }] }, { 'onboarding_sessions:select': NET });
    let err = null; try { await agents.resolveAgent(db, A); } catch (e) { err = e; }
    check('A4 onboarding read fails (transient) → AGENT_LOOKUP_FAILED, not "never chose"', err && err.code === 'AGENT_LOOKUP_FAILED');
  }
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: {} }] }, { 'onboarding_sessions:select': { code: '42P01', message: 'relation "onboarding_sessions" does not exist' } });
    const r = await agents.resolveAgent(db, A);
    check('A5 onboarding table missing is a real absence → default, assigned:false', r.id === agents.DEFAULT_AGENT && r.assigned === false);
  }

  // ── B. onboarding copy
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: { theme: 'dark', weeklyReportEmail: false } }], onboarding_sessions: [{ user_id: A, assistant: 'nova' }] });
    const r = await agents.resolveAgent(db, A);
    const p = db.writes.find((w) => w.table === 'profiles');
    check('B1 profile read, no choice, onboarding says Nova → Nova (assigned)', r.id === 'nova' && r.assigned && r.source === 'onboarding');
    check('B2 …copied onto that profile, every other preference kept', p && p.val === A && p.obj.preferences.assistant === 'nova' && p.obj.preferences.theme === 'dark' && p.obj.preferences.weeklyReportEmail === false, p);
  }
  {
    const db = fakeDb({ profiles: [], onboarding_sessions: [{ user_id: A, assistant: 'nova' }] });
    const r = await agents.resolveAgent(db, A);
    check('B3 no profile row yet: onboarding choice answers, nothing written to a missing row', r.id === 'nova' && db.writes.length === 0);
  }
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: { assistant: 'momentum' } }], onboarding_sessions: [{ user_id: A, assistant: 'scout' }] });
    const r = await agents.resolveAgent(db, A);
    check('B4 the profile wins over an older onboarding copy (Momentum, not Scout), read-only', r.id === 'momentum' && r.source === 'preferences' && db.writes.length === 0);
  }

  // ── C. chosen once
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: { assistant: 'momentum', theme: 'dark' } }] });
    let e = null; try { await agents.chooseAgent(db, A, 'scout'); } catch (x) { e = x; }
    check('C1 another assistant than the saved one → 409 ASSISTANT_ALREADY_CHOSEN, nothing written', e && e.code === 'ASSISTANT_ALREADY_CHOSEN' && e.current === 'momentum' && db.writes.length === 0);
    const same = await agents.chooseAgent(db, A, 'momentum');
    check('C2 the same assistant again is a no-op', same === 'momentum' && db.writes.length === 0);
  }
  {
    const db = fakeDb({ profiles: [{ id: A, preferences: { theme: 'dark' } }], onboarding_sessions: [{ user_id: A, assistant: null }] });
    await agents.chooseAgent(db, A, 'flux');
    const prof = db.writes.find((w) => w.table === 'profiles');
    check('C3 first choice is stored on the profile (other preferences kept) and the onboarding copy follows', prof && prof.obj.preferences.assistant === 'flux' && prof.obj.preferences.theme === 'dark' && db.writes.some((w) => w.table === 'onboarding_sessions' && w.obj.assistant === 'flux'));
    const r = await agents.resolveAgent(db, A);
    check('C4 a later lookup (e.g. after signing out and in) returns the stored choice', r.id === 'flux' && r.assigned);
  }

  // ── D. isolation
  {
    const tables = { profiles: [{ id: A, preferences: { assistant: 'momentum' } }, { id: B, preferences: {} }], onboarding_sessions: [] };
    const db = fakeDb(tables);
    await agents.chooseAgent(db, B, 'nova');
    check('D1 user B choosing writes only B’s rows', db.writes.every((w) => w.val === B), db.writes.map((w) => w.val));
    check('D2 user A keeps Momentum', tables.profiles[0].preferences.assistant === 'momentum' && (await agents.resolveAgent(db, A)).id === 'momentum');
    check('D3 user B now has Nova', (await agents.resolveAgent(db, B)).id === 'nova');
  }
  {
    const r = await agents.resolveAgent(fakeDb({}), null);
    check('D4 no user → default, assigned:false (nothing read or written for anyone)', r.id === agents.DEFAULT_AGENT && r.assigned === false);
  }

  console.log(`agent-integrity: ${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
