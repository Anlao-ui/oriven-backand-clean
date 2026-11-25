// ════════════════════════════════════════════════════════════════
// Ad Simulator — saved simulations (services/simulationRoutes.js) through
// the REAL server.js, Supabase mocked (tests/helpers/mockServer.js).
// Ownership, validation/clamping, list/get/update/delete, kept out of
// My Content and out of Progress; no credits are ever touched.
//
// No network, no AI calls, no payments.
// RUN: node tests/simulations.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5691 });
const { check, log, done } = reporter();
const DAY = 864e5, iso = (ms) => new Date(ms).toISOString(), NOW = Date.now();
const facts = require(path.join(H.SERVER_DIR, 'services', 'progressFacts'));

let n = 0;
function user() {
  const id = 'sm' + String(++n).padStart(4, '0') + '-0000-4000-8000-000000000000';
  H.rows('profiles').push({ id, created_at: iso(NOW - 30 * DAY), subscription_status: 'paid', access_plan: 'annual', access_expires_at: iso(NOW + 200 * DAY), credits_balance: 1000, onboarding_completed: true, preferences: {} });
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: iso(NOW - 30 * DAY) };
  return { id, tok: 'tok_' + id, prof: () => H.rows('profiles').find((p) => p.id === id) };
}
const SIM = {
  name: 'Q4 candles',
  activeId: 'a',
  scenarios: [
    { id: 'a', name: 'Meta only', objective: 'sales', budget: 1500, days: 30, uncertainty: 'medium', channels: [{ platform: 'meta', share: 100, basis: 'cpm', cpm: 9, ctr: 1.1, cvr: 2.4, value: 48 }] },
    { id: 'b', name: 'Meta + Google', budget: 1500, days: 30, channels: [{ platform: 'meta', share: 60, cpm: 9, ctr: 1.1, cvr: 2.4, value: 48 }, { platform: 'google', share: 40, basis: 'cpc', cpc: 0.9, ctr: 4, cvr: 3, value: 48, source: { kind: 'account', label: 'Google Ads, last 30 days', since: '2026-10-26', until: '2026-11-24' } }] },
  ],
};

(async () => {
  const quiet = await H.start();
  const { call } = H;

  log('\nA. Auth and validation');
  let r = await call('GET', '/api/simulations', null);
  check('A1. not signed in → 401', r.status === 401, r.status);
  const u = user();
  r = await call('POST', '/api/simulations', u.tok, { simulation: { name: 'x', scenarios: [] } });
  check('A2. no scenarios → 400 INVALID_SIMULATION, nothing stored', r.status === 400 && r.body.code === 'INVALID_SIMULATION' && !H.rows('creative_assets').some((a) => a.kind === 'simulation'), r.body);

  log('\nB. Save, list, open');
  r = await call('POST', '/api/simulations', u.tok, { simulation: SIM });
  check('B1. saved → 201 with an id', r.status === 201 && !!(r.body.simulation && r.body.simulation.id), r.body);
  // The real table gives every row a uuid; the mock doesn't — give this one a uuid like Postgres would.
  const id = 'aaaaaaaa-1111-4111-8111-000000000001';
  const row = H.rows('creative_assets').find((a) => a.id === r.body.simulation.id); row.id = id;
  check('B2. stored as creative_assets kind "simulation", owned by the user, status draft', row && row.kind === 'simulation' && row.user_id === u.id && row.status === 'draft' && row.title === 'Q4 candles', row);
  check('B3. the account source of an assumption is kept (label + dates)', row.content.scenarios[1].channels[1].source.kind === 'account' && row.content.scenarios[1].channels[1].source.since === '2026-10-26');
  check('B4. saving costs nothing (credits unchanged)', u.prof().credits_balance === 1000);
  r = await call('GET', '/api/simulations', u.tok);
  check('B5. listed with name and scenario count', r.status === 200 && r.body.simulations.length === 1 && r.body.simulations[0].name === 'Q4 candles' && r.body.simulations[0].scenarios === 2, r.body);
  r = await call('GET', '/api/simulations/' + id, u.tok);
  check('B6. opened with its scenarios and active scenario', r.status === 200 && r.body.simulation.scenarios.length === 2 && r.body.simulation.activeId === 'a', r.body);

  log('\nC. Clamping (the server never trusts the numbers)');
  r = await call('POST', '/api/simulations', u.tok, { simulation: { name: '<b>Wild</b>', scenarios: [{ id: '../x', budget: -10, days: 9000, uncertainty: 'extreme', objective: 'win', channels: [{ platform: 'myspace', ctr: 900, cpm: 'abc' }, { platform: 'meta' }] }], extra: 'dropped' } });
  const w = r.body.simulation;
  const sc = w && w.scenarios[0];
  check('C1. out-of-range numbers clamped, unknown values defaulted, duplicate platform dropped', r.status === 201 && sc.budget === 1 && sc.days === 365 && sc.uncertainty === 'medium' && sc.objective === 'sales' && sc.channels.length === 1 && sc.channels[0].ctr === 100 && sc.channels[0].cpm === 8, sc);
  check('C2. ids restricted to word characters; unknown fields not stored', sc.id === 'x' && !('extra' in w), w);
  const many = { name: 'Many', scenarios: Array.from({ length: 12 }, (_, i) => ({ id: 'same', name: 'S' + i })) };
  r = await call('POST', '/api/simulations', u.tok, { simulation: many });
  check('C3. at most 8 scenarios, ids made unique', r.body.simulation.scenarios.length === 8 && new Set(r.body.simulation.scenarios.map((s) => s.id)).size === 8, r.body.simulation && r.body.simulation.scenarios.map((s) => s.id));

  log('\nD. Ownership');
  const other = user();
  r = await call('GET', '/api/simulations/' + id, other.tok);
  check('D1. someone else can’t open it → 404', r.status === 404, r.status);
  r = await call('PUT', '/api/simulations/' + id, other.tok, { simulation: SIM });
  check('D2. … nor change it → 404, unchanged', r.status === 404 && H.rows('creative_assets').find((a) => a.id === id).title === 'Q4 candles', r.status);
  r = await call('DELETE', '/api/simulations/' + id, other.tok);
  check('D3. … nor delete it → 404, still there', r.status === 404 && !!H.rows('creative_assets').find((a) => a.id === id), r.status);
  r = await call('GET', '/api/simulations', other.tok);
  check('D4. their list is empty', r.status === 200 && r.body.simulations.length === 0, r.body);
  r = await call('GET', '/api/simulations/not-a-uuid', u.tok);
  check('D5. a malformed id → 404', r.status === 404);

  log('\nE. Update and delete');
  r = await call('PUT', '/api/simulations/' + id, u.tok, { simulation: Object.assign({}, SIM, { name: 'Q4 candles v2', activeId: 'b' }) });
  check('E1. updated in place (same id, new name, active scenario kept)', r.status === 200 && r.body.simulation.id === id && r.body.simulation.name === 'Q4 candles v2' && r.body.simulation.activeId === 'b' && H.rows('creative_assets').find((a) => a.id === id).title === 'Q4 candles v2', r.body);
  r = await call('DELETE', '/api/simulations/' + id, u.tok);
  check('E2. deleted', r.status === 200 && !H.rows('creative_assets').find((a) => a.id === id), r.body);
  r = await call('DELETE', '/api/simulations/' + id, u.tok);
  check('E3. deleting again → 404', r.status === 404);

  log('\nF. Kept out of My Content, search and Progress');
  H.rows('creative_assets').push({ id: '11111111-1111-4111-8111-111111111111', user_id: u.id, kind: 'ad', title: 'Candle ad', content: { text: 'x' }, status: 'ready', archived: false, created_at: iso(NOW) });
  r = await call('GET', '/api/creative/assets', u.tok);
  const kinds = (r.body.assets || []).map((a) => a.kind);
  check('F1. My Content lists the ad, not the simulations', r.status === 200 && kinds.includes('ad') && !kinds.includes('simulation'), kinds);
  check('F2. Progress doesn’t count a simulation as creative work', facts.classifyAsset ? facts.classifyAsset({ kind: 'simulation' }) === null : true);

  await H.stop(quiet);
  done();
})().catch((e) => { console.error(e); process.exit(1); });
