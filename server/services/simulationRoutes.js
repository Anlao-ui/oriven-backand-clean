// ════════════════════════════════════════════════════════════════
// Ad Simulator — saved simulations (frontend js/adSimulator.js).
//
// No new table: a simulation is a creative_assets row with kind
// 'simulation' (the same pattern as saved comparisons and audience
// profiles), owned by its user_id. The calculations themselves run in the
// browser (js/adSimEngine.js) and never cost credits; the server only
// stores the assumptions, after checking every number against the same
// limits the engine uses (keep LIMITS in step with js/adSimEngine.js).
//
//   GET    /api/simulations          list (name, scenario count, saved at)
//   GET    /api/simulations/:id      one simulation
//   POST   /api/simulations          save a new one   { simulation }
//   PUT    /api/simulations/:id      replace          { simulation }
//   DELETE /api/simulations/:id      delete (the user's own only)
// ════════════════════════════════════════════════════════════════
const KIND = 'simulation';
const MAX_SIMULATIONS = 100;
const PLATFORMS = ['google', 'meta', 'tiktok', 'pinterest', 'snapchat'];
const OBJECTIVES = ['sales', 'leads', 'traffic', 'awareness'];
const UNCERTAINTY = ['low', 'medium', 'high'];
const LIMITS = {
  budget: [1, 10000000], days: [1, 365], frequency: [1, 20], creatives: [1, 20],
  cpm: [0.01, 1000], cpc: [0.001, 500], ctr: [0, 100], cvr: [0, 100], value: [0, 1000000], share: [0, 100],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const _s = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
function _n(v, key, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
  if (!Number.isFinite(n)) return dflt;
  const [lo, hi] = LIMITS[key];
  return Math.min(hi, Math.max(lo, n));
}
const _date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');

function sanitizeChannel(c) {
  c = c && typeof c === 'object' ? c : {};
  const src = c.source && typeof c.source === 'object' ? c.source : {};
  return {
    platform: PLATFORMS.includes(c.platform) ? c.platform : 'meta',
    share: _n(c.share, 'share', 100),
    basis: c.basis === 'cpc' ? 'cpc' : 'cpm',
    cpm: _n(c.cpm, 'cpm', 8), cpc: _n(c.cpc, 'cpc', 0.6),
    ctr: _n(c.ctr, 'ctr', 1.2), cvr: _n(c.cvr, 'cvr', 2), value: _n(c.value, 'value', 50),
    source: { kind: src.kind === 'account' ? 'account' : 'manual', label: _s(src.label, 160), since: _date(src.since), until: _date(src.until) },
  };
}
function sanitizeScenario(s, i) {
  s = s && typeof s === 'object' ? s : {};
  const seen = new Set();
  const channels = (Array.isArray(s.channels) ? s.channels : []).slice(0, PLATFORMS.length).map(sanitizeChannel)
    .filter((c) => (seen.has(c.platform) ? false : (seen.add(c.platform), true)));
  return {
    id: _s(String(s.id || ''), 40).replace(/[^\w-]/g, '') || 's' + i,
    name: _s(s.name, 80) || 'Scenario ' + (i + 1),
    objective: OBJECTIVES.includes(s.objective) ? s.objective : 'sales',
    budget: _n(s.budget, 'budget', 1000),
    days: Math.round(_n(s.days, 'days', 30)),
    frequency: _n(s.frequency, 'frequency', 1.8),
    creatives: Math.round(_n(s.creatives, 'creatives', 1)),
    uncertainty: UNCERTAINTY.includes(s.uncertainty) ? s.uncertainty : 'medium',
    channels: channels.length ? channels : [sanitizeChannel({ platform: 'meta' })],
  };
}
// null when there is nothing usable to save.
function sanitizeSimulation(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.scenarios) || !raw.scenarios.length) return null;
  const scenarios = raw.scenarios.slice(0, 8).map(sanitizeScenario);
  const ids = new Set();
  scenarios.forEach((s) => { while (ids.has(s.id)) s.id += 'x'; ids.add(s.id); });
  const activeId = scenarios.some((s) => s.id === raw.activeId) ? raw.activeId : scenarios[0].id;
  return { name: _s(raw.name, 100) || 'Untitled simulation', scenarios, activeId, version: 1 };
}

function register(app, { getUserFromToken, supabaseAdmin }) {
  const db = supabaseAdmin;
  const authed = async (req, res) => { const u = await getUserFromToken(req); if (!u) res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }); return u; };
  const row = (r) => Object.assign({ id: r.id, savedAt: (r.content && r.content.savedAt) || r.created_at, createdAt: r.created_at }, r.content || {});

  app.get('/api/simulations', async (req, res) => {
    const user = await authed(req, res); if (!user) return;
    try {
      const { data, error } = await db.from('creative_assets').select('id, title, content, created_at').eq('user_id', user.id).eq('kind', KIND).eq('archived', false).order('created_at', { ascending: false }).limit(MAX_SIMULATIONS);
      if (error) throw error;
      const list = (data || []).map((r) => { const c = r.content || {}; return { id: r.id, name: c.name || r.title, scenarios: Array.isArray(c.scenarios) ? c.scenarios.length : 0, savedAt: c.savedAt || r.created_at, createdAt: r.created_at }; });
      list.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      res.json({ simulations: list });
    } catch (err) { console.error('[simulations GET]', err.message); res.status(500).json({ error: 'Could not load your simulations.' }); }
  });

  app.get('/api/simulations/:id', async (req, res) => {
    const user = await authed(req, res); if (!user) return;
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Simulation not found.' });
    try {
      const { data, error } = await db.from('creative_assets').select('id, content, created_at').eq('id', req.params.id).eq('user_id', user.id).eq('kind', KIND).eq('archived', false).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Simulation not found.' });
      res.json({ simulation: row(data) });
    } catch (err) { console.error('[simulations GET one]', err.message); res.status(500).json({ error: 'Could not load that simulation.' }); }
  });

  app.post('/api/simulations', async (req, res) => {
    const user = await authed(req, res); if (!user) return;
    const sim = sanitizeSimulation(req.body && req.body.simulation);
    if (!sim) return res.status(400).json({ error: 'A simulation needs at least one scenario.', code: 'INVALID_SIMULATION' });
    try {
      const { count } = await db.from('creative_assets').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('kind', KIND).eq('archived', false);
      if ((count || 0) >= MAX_SIMULATIONS) return res.status(409).json({ error: 'You have ' + MAX_SIMULATIONS + ' saved simulations. Delete one to save another.', code: 'SIMULATION_LIMIT' });
      const content = Object.assign({}, sim, { savedAt: new Date().toISOString() });
      const { data, error } = await db.from('creative_assets').insert({ user_id: user.id, kind: KIND, title: sim.name, content, status: 'draft', source_route: '/api/simulations', archived: false }).select('id, content, created_at').maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('insert returned no row');
      res.status(201).json({ simulation: row(data) });
    } catch (err) { console.error('[simulations POST]', err.message); res.status(500).json({ error: 'The simulation couldn’t be saved. Please try again.' }); }
  });

  app.put('/api/simulations/:id', async (req, res) => {
    const user = await authed(req, res); if (!user) return;
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Simulation not found.' });
    const sim = sanitizeSimulation(req.body && req.body.simulation);
    if (!sim) return res.status(400).json({ error: 'A simulation needs at least one scenario.', code: 'INVALID_SIMULATION' });
    try {
      const content = Object.assign({}, sim, { savedAt: new Date().toISOString() });
      const { data, error } = await db.from('creative_assets').update({ title: sim.name, content }).eq('id', req.params.id).eq('user_id', user.id).eq('kind', KIND).eq('archived', false).select('id, content, created_at').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Simulation not found.' });
      res.json({ simulation: row(data) });
    } catch (err) { console.error('[simulations PUT]', err.message); res.status(500).json({ error: 'The simulation couldn’t be saved. Please try again.' }); }
  });

  app.delete('/api/simulations/:id', async (req, res) => {
    const user = await authed(req, res); if (!user) return;
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Simulation not found.' });
    try {
      const { data: found, error: findErr } = await db.from('creative_assets').select('id').eq('id', req.params.id).eq('user_id', user.id).eq('kind', KIND).maybeSingle();
      if (findErr) throw findErr;
      if (!found) return res.status(404).json({ error: 'Simulation not found.' });
      const { error } = await db.from('creative_assets').delete().eq('id', req.params.id).eq('user_id', user.id).eq('kind', KIND);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) { console.error('[simulations DELETE]', err.message); res.status(500).json({ error: 'Could not delete that simulation.' }); }
  });
}

module.exports = { register, sanitizeSimulation, sanitizeScenario, LIMITS, KIND };
