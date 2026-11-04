// ════════════════════════════════════════════════════════════════
// Missing marketing plan (paying customers from before the onboarding),
// Research → Insights and the local preview probe, end to end against the
// REAL server.js.
//
// Faked: Supabase (in memory, tests/helpers/mockServer.js), the AIML provider
// (AIML_BASE_OVERRIDE → an in-process fake) and Stripe (H.STRIPE stubs). No
// network, no paid AI calls, no real users, nothing written anywhere real.
//
// RUN: node tests/onboarding-recovery.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const AIML = 'http://aiml.mock.invalid';
const H = boot({ port: 5633, env: { AIML_BASE_OVERRIDE: AIML } });
const { check, log, done } = reporter();

const OLD = '2026-01-15T10:00:00Z';
const FUTURE = new Date(Date.now() + 20 * 864e5).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const sess = (id) => H.rows('onboarding_sessions').find((r) => r.user_id === id);
function user(id, extra) {
  H.rows('profiles').push(Object.assign({ id, subscription_status: 'free', created_at: OLD, credits_balance: 0, onboarding_completed: true, access_expires_at: null, preferences: {} }, extra || {}));
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: OLD };
  return 'tok_' + id;
}
async function waitPlan(id) { for (let i = 0; i < 200 && sess(id) && sess(id).plan_status === 'generating'; i++) await sleep(25); }

// ── Fake provider: a plan with the phases the prompt asks for ──
const AI = { calls: 0 };
const PLAN = {
  summary: 'Grow repeat candle sales in Utrecht with email and one social channel you can keep up every week.',
  overview: { text: 'Bloom & Wick sells hand-poured soy candles in Utrecht and online; this plan starts with the buyers you already reach.' },
  audience: { text: 'Gift shoppers and interior lovers aged 25–45 who care about natural products.', segments: [{ name: 'Gift shoppers', needs: 'A personal present' }] },
  positioning: { statement: 'Hand-poured, natural candles from your own Utrecht studio.', proof_points: ['Poured by hand'] },
  objectives: [{ objective: 'Grow repeat orders', measure: 'Repeat orders per month' }],
  channels: [{ channel: 'Instagram', role: 'Discovery', why: 'Visual product', effort: 'medium' }],
  content: { pillars: [{ name: 'Studio', ideas: ['How a candle is poured'] }], cadence: 'Three posts a week' },
  campaigns: [{ name: 'Saturday workshops', goal: 'Bookings', idea: 'Invite past buyers first' }],
  priorities: ['Start an email list', 'Post three times a week'],
};
H.net.handler = async (u, opts) => {
  if (!u.startsWith(AIML)) return null;
  AI.calls++;
  let body = {}; try { body = JSON.parse(opts.body); } catch (_) {}
  const sys = (body.messages && body.messages[0] && body.messages[0].content) || '';
  AI.lastSystem = sys;
  const m = sys.match(/"roadmap":\[(.*)\]\}\s*\nRoadmap:/);
  const names = m ? Array.from(m[1].matchAll(/"phase":"([^"]+)"/g)).map((x) => x[1]) : [];
  const plan = Object.assign({}, PLAN, { roadmap: names.map((n) => ({ phase: n, focus: 'Focus', actions: [{ step: 'Write the ' + n + ' email', area: 'create' }, { step: 'Review ' + n + ' orders', area: 'outside' }] })) });
  return new Response(JSON.stringify({ model: 'claude-haiku-4-5', choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { completion_tokens: 1500 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// Stripe: legacy subscriptions report their billing interval.
const SUBS = { sub_month: { interval: 'month', interval_count: 1 }, sub_year: { interval: 'year', interval_count: 1 } };
H.STRIPE['subscriptions.retrieve'] = async (id) => {
  if (!SUBS[id]) throw Object.assign(new Error('No such subscription'), { statusCode: 404, code: 'resource_missing' });
  return { id, status: 'active', items: { data: [{ price: { id: 'price_x', recurring: SUBS[id] } }] } };
};

// Everything the form needs beyond the business profile.
const REST = {
  audience: { type: 'b2c', ideal: 'Gift shoppers aged 25–45', location: 'regional', problem: 'Finding a personal gift' },
  offer: { main: 'Soy candles', different: 'Poured by hand', price: 'premium' },
  goals: { primary: 'sales', success: '50 orders a month' },
  marketing: { channels: ['instagram'], challenge: 'time', paidAds: 'no' },
  budget: { budget: '250_500', time: '2_5', team: 'me' },
};
const BIZ_ANSWERS = { name: 'Bloom & Wick', industry: 'Retail & e-commerce', offer: 'Hand-poured soy candles', area: 'Utrecht' };

(async () => {
  const quiet = await H.start();
  const { call } = H;
  const flow = require(require('path').join(H.SERVER_DIR, 'services', 'onboardingFlow'));
  const untouched = (id, before) => { const p = prof(id); return p.credits_balance === before.credits_balance && p.access_expires_at === before.access_expires_at && p.subscription_status === before.subscription_status && p.access_plan === before.access_plan; };
  const purchases = () => (H.TABLES.purchases || []).length;
  const rpc0 = H.rpcCalls.length;

  // ── 1. Legacy subscriber, business profile only ────────────────
  log('\n1. Legacy subscriber with a business profile, no plan');
  const L1 = user('rcL1', { subscription_status: 'starter', access_expires_at: FUTURE, access_plan: 'starter', stripe_subscription_id: 'sub_month', credits_balance: 640 });
  H.rows('business_profile').push({ user_id: 'rcL1', company_name: 'Bloom & Wick', industry: 'Retail & e-commerce', description: 'Hand-poured soy candles', country: 'Utrecht', website: 'https://bloomandwick.example' });
  const before1 = Object.assign({}, prof('rcL1')), pur0 = purchases();
  let r = await call('GET', '/api/onboarding/plan', L1);
  check('1.1 the Marketing Plan read says this paying account can create its missing plan', r.status === 200 && r.body.locked === false && r.body.onboarding === false && r.body.recovery === true, r.body);
  r = await call('GET', '/api/onboarding/recovery', L1);
  const kn = Object.fromEntries((r.body.known || []).map((k) => [k.path, k]));
  check('1.2 recovery is available for the legacy subscription’s real interval (Stripe: monthly → 1 month)', r.body.available === true && r.body.period === 'monthly' && r.body.horizon.label === '1 month', r.body);
  check('1.3 what OrivenAI already knows is reused (business name, industry, offer, area from the business profile) and not asked again', ['business.name', 'business.industry', 'business.offer', 'business.area'].every((p) => kn[p] && kn[p].source === 'business_profile') && !r.body.missing.some((f) => f.path.startsWith('business.')), { known: Object.keys(kn), missing: r.body.missing.map((f) => f.path) });
  check('1.4 only the missing answers are asked (15), each with its question and, for choices, the options', r.body.missing.length === 15 && r.body.missing.every((f) => f.label && f.type) && r.body.missing.find((f) => f.path === 'budget.time').options.length === 5);
  check('1.5 reading the recovery form makes no AI call and no write', AI.calls === 0 && !sess('rcL1'));
  r = await call('POST', '/api/onboarding/recovery', L1, { answers: Object.assign({}, REST, { business: { name: 'Bloom & Wick Studio' } }), assistant: 'nova' });
  check('1.6 confirming starts the plan (202, generating) for the purchased period', r.status === 202 && r.body.status === 'generating' && r.body.period === 'monthly', r.body);
  await waitPlan('rcL1');
  check('1.7 one plan, written for 1 month (four weekly phases), from the confirmed answers — a correction (business name) is used', sess('rcL1').plan_status === 'ready' && sess('rcL1').plan.horizon.period === 'monthly' && sess('rcL1').plan.roadmap.length === 4 && AI.calls === 1 && sess('rcL1').answers.business.name === 'Bloom & Wick Studio' && /covering the next 1 month/.test(AI.lastSystem));
  check('1.8 nothing bought or granted: no purchase, same credits, same access end, same subscription', purchases() === pur0 && untouched('rcL1', before1) && H.rpcCalls.length === rpc0, { credits: prof('rcL1').credits_balance, rpc: H.rpcCalls.slice(rpc0) });
  check('1.9 the session is completed and unlocked with no purchase reference', sess('rcL1').status === 'completed' && !!sess('rcL1').unlocked_at && !sess('rcL1').purchase_id);
  r = await call('GET', '/api/onboarding/plan', L1);
  check('1.10 the plan is shown on Marketing Plan, and Progress has its steps', r.body.status === 'ready' && !!r.body.plan && (await call('GET', '/api/onboarding/progress', L1)).body.total === 8);
  r = await call('POST', '/api/onboarding/recovery', L1, { answers: REST, assistant: 'nova' });
  const r2 = await call('GET', '/api/onboarding/recovery', L1);
  check('1.11 a plan already exists: no second plan (409 PLAN_EXISTS, no AI call)', r.status === 409 && r.body.code === 'PLAN_EXISTS' && r2.body.reason === 'plan_exists' && AI.calls === 1);

  // ── 2. Paid with saved onboarding answers ──────────────────────
  log('\n2. Paid account with saved onboarding answers');
  const L2 = user('rcL2', { subscription_status: 'paid', access_expires_at: FUTURE, access_plan: 'quarterly', credits_balance: 1600, preferences: { assistant: 'metric' } });
  H.rows('onboarding_sessions').push({ user_id: 'rcL2', status: 'completed', step: 'done', answers: { business: BIZ_ANSWERS, audience: REST.audience, offer: REST.offer, goals: REST.goals, marketing: REST.marketing }, assistant: null, plan_status: 'none', plan_attempts: 0, website_attempts: 0, unlocked_at: '2026-10-20T10:00:00Z' });
  const before2 = Object.assign({}, prof('rcL2'));
  r = await call('GET', '/api/onboarding/plan', L2);
  check('2.1 Marketing Plan offers to complete the answers (paid, nothing started, answers missing)', r.body.locked === false && r.body.recovery === true && r.body.status === 'none' && AI.calls === 1, r.body);
  r = await call('GET', '/api/onboarding/recovery', L2);
  const kn2 = Object.fromEntries((r.body.known || []).map((k) => [k.path, k]));
  check('2.2 saved onboarding answers are reused (16 known, source "onboarding"); only the 3 budget questions are asked; the chosen assistant (Metric) is reused', r.body.known.length === 16 && kn2['offer.main'].source === 'onboarding' && JSON.stringify(r.body.missing.map((f) => f.path)) === '["budget.budget","budget.time","budget.team"]' && r.body.assistant === 'metric' && r.body.period === 'quarterly', { missing: r.body.missing.map((f) => f.path), a: r.body.assistant });
  r = await call('POST', '/api/onboarding/recovery', L2, { answers: { budget: REST.budget } });
  await waitPlan('rcL2');
  check('2.3 the plan is written for the purchased Quarterly period (6 phases) with the saved assistant', r.status === 202 && sess('rcL2').plan_status === 'ready' && sess('rcL2').plan.roadmap.length === 6 && sess('rcL2').assistant === 'metric' && /You are Metric/.test(AI.lastSystem));
  check('2.4 the original unlock time is kept, nothing bought or granted', sess('rcL2').unlocked_at === '2026-10-20T10:00:00Z' && untouched('rcL2', before2) && purchases() === pur0);

  // ── 3. Incomplete business information ────────────────────────
  log('\n3. Paid account with no business information');
  const L3 = user('rcL3', { subscription_status: 'paid', access_expires_at: FUTURE, access_plan: 'flex' });
  r = await call('GET', '/api/onboarding/recovery', L3);
  check('3.1 nothing known: all 19 essentials are asked, plus the assistant (none chosen)', r.body.available === true && r.body.missing.length === 19 && r.body.known.length === 0 && r.body.assistant === null && r.body.assistants.length === 6 && r.body.period === 'flex');
  const ai3 = AI.calls;
  r = await call('POST', '/api/onboarding/recovery', L3, { answers: { business: BIZ_ANSWERS }, assistant: 'vector' });
  check('3.2 sending only part of it → 400 with the missing fields; no session, no AI call', r.status === 400 && r.body.code === 'ANSWERS_INCOMPLETE' && r.body.missing.includes('budget.team') && !sess('rcL3') && AI.calls === ai3, r.body);
  r = await call('POST', '/api/onboarding/recovery', L3, { answers: Object.assign({ business: BIZ_ANSWERS }, REST) });
  check('3.3 no assistant chosen → 400 ASSISTANT_REQUIRED, nothing started', r.status === 400 && r.body.code === 'ASSISTANT_REQUIRED' && !sess('rcL3') && AI.calls === ai3);
  r = await call('POST', '/api/onboarding/recovery', L3, { answers: Object.assign({ business: BIZ_ANSWERS }, REST, { offer: { main: 'Soy candles', different: 'Poured by hand', price: 'luxury!!' } }), assistant: 'vector' });
  check('3.4 an invalid choice is cleaned like in the onboarding (price "luxury!!" → missing)', r.status === 400 && r.body.missing.includes('offer.price') && AI.calls === ai3);
  r = await call('POST', '/api/onboarding/recovery', L3, { answers: Object.assign({ business: BIZ_ANSWERS }, REST), assistant: 'vector' });
  await waitPlan('rcL3');
  check('3.5 complete answers → a Flex plan (2 phases)', r.status === 202 && sess('rcL3').plan.roadmap.length === 2 && sess('rcL3').plan.horizon.period === 'flex');

  // ── 4. Not paid ────────────────────────────────────────────────
  log('\n4. Accounts without paid access');
  const ai4 = AI.calls;
  const F1 = user('rcFree');
  const F2 = user('rcLapsed', { subscription_status: 'paid', access_expires_at: new Date(Date.now() - 864e5).toISOString(), access_plan: 'monthly' });
  const F3 = user('rcLabel', { subscription_status: 'paid', access_plan: 'monthly' }); // a paid label without an access period
  const res4 = [];
  for (const [t, id] of [[F1, 'rcFree'], [F2, 'rcLapsed'], [F3, 'rcLabel']]) {
    const g = await call('GET', '/api/onboarding/recovery', t);
    const p = await call('POST', '/api/onboarding/recovery', t, { answers: Object.assign({ business: BIZ_ANSWERS }, REST), assistant: 'vector' });
    const pl = await call('GET', '/api/onboarding/plan', t);
    res4.push([id, g.body.reason, p.status, p.body.code, !!sess(id), pl.body.recovery]);
  }
  check('4.1 free, lapsed and paid-label-only accounts: recovery unavailable (no_access), POST 402, no session, no AI call, not offered on Marketing Plan', res4.every((x) => x[1] === 'no_access' && x[2] === 402 && x[3] === 'ACCESS_REQUIRED' && !x[4] && !x[5]) && AI.calls === ai4, res4);
  await call('PUT', '/api/user/preferences', F1, { subscription_status: 'paid', access_expires_at: FUTURE, access: true });
  r = await call('POST', '/api/onboarding/recovery', F1, { answers: Object.assign({ business: BIZ_ANSWERS }, REST), assistant: 'vector' });
  check('4.2 writing "paid" into client preferences changes nothing (402)', r.status === 402 && AI.calls === ai4);

  // ── 5. Purchased period unknown ───────────────────────────────
  log('\n5. Original purchase length unknown');
  const U1 = user('rcU1', { subscription_status: 'creator', access_expires_at: FUTURE, access_plan: 'creator' }); // no Stripe subscription id
  const U2 = user('rcU2', { subscription_status: 'professional', access_expires_at: FUTURE, access_plan: 'professional', stripe_subscription_id: 'sub_gone' });
  const ai5 = AI.calls;
  const u1 = await call('GET', '/api/onboarding/recovery', U1), u2 = await call('GET', '/api/onboarding/recovery', U2);
  check('5.1 legacy access without a readable subscription interval: "period_unknown", no length invented (period null), the known answers still shown', u1.body.available === false && u1.body.reason === 'period_unknown' && u1.body.period === null && u2.body.reason === 'period_unknown' && Array.isArray(u1.body.missing), { u1: u1.body.reason, u2: u2.body.reason });
  r = await call('POST', '/api/onboarding/recovery', U1, { answers: Object.assign({ business: BIZ_ANSWERS }, REST), assistant: 'vector' });
  check('5.2 …and nothing is generated (409 PERIOD_UNKNOWN with the support contact), no session', r.status === 409 && r.body.code === 'PERIOD_UNKNOWN' && /contact@orivenai\.com/.test(r.body.error) && !sess('rcU1') && AI.calls === ai5, r.body);
  const Y = user('rcY', { subscription_status: 'professional', access_expires_at: FUTURE, access_plan: 'professional', stripe_subscription_id: 'sub_year' });
  r = await call('GET', '/api/onboarding/recovery', Y);
  check('5.3 a yearly legacy subscription maps to the Annual length (12 months)', r.body.period === 'annual' && r.body.horizon.label === '12 months');
  check('5.4 no credit, purchase or ledger writes anywhere in the recovery tests', purchases() === pur0 && H.rpcCalls.length === rpc0 && !(H.TABLES.credit_ledger || []).length && !(H.TABLES.credit_grants || []).length);
  check('5.5 pure prefill: saved answers win over the business profile; choices are never guessed from free text', (() => { const p = flow.legacyPrefill({ business: { name: 'Saved' } }, { company_name: 'Profile', industry: 'Retail', description: 'Candles', country: 'NL' }); return p.answers.business.name === 'Saved' && p.sources['business.name'] === 'onboarding' && p.answers.business.industry === 'Retail' && !p.answers.goals; })());

  // ── 6. Research → Insights ────────────────────────────────────
  log('\n6. Insights');
  const I = user('rcIns', { subscription_status: 'paid', access_expires_at: FUTURE, access_plan: 'monthly', preferences: { savedInsights: ['rep1:o1', 42] } });
  const rep = (id, title, extra, status, archived, owner) => H.rows('creative_assets').push({ id, user_id: owner || 'rcIns', kind: 'research', title, status: status || 'ready', archived: !!archived, created_at: new Date(Date.now() - (id === 'rep1' ? 2 : 1) * 864e5).toISOString(),
    content: Object.assign({ reportVersion: 2, type: 'market', question: title, sources: [{ id: 'ws1', title: 'Candle report', url: 'https://candles.example/report', domain: 'candles.example', fetched: true }, { id: 'ws2', title: 'Bad', url: 'javascript:alert(1)', domain: 'x' }] }, extra) });
  r = await call('GET', '/api/research/insights', I);
  check('6.1 no research yet: empty lists, nothing invented', r.status === 200 && r.body.reports.length === 0 && r.body.findings.length === 0 && r.body.opportunities.length === 0 && r.body.recurringCompetitors.length === 0);
  rep('rep1', 'Candle market Utrecht', { keyConclusions: [{ text: 'Gift buying peaks before December', why: 'Plan ads early', basis: 'source_checked', sourceIds: ['ws1', 'ws2'] }], opportunities: [{ id: 'o1', title: 'Workshop gifts', why: 'Gift buyers want experiences', basis: 'idea', supportBasis: 'source_cited', sourceIds: ['ws1'] }], competitors: [{ id: 'c1', name: 'Lumière Candles' }, { id: 'c2', name: 'Wax & Co' }], nextSteps: [{ id: 'n1', action: 'Start December gift ads in early November', why: 'Gift buying peaks', basis: 'analysis' }] });
  rep('rep2', 'Competitor scan', { type: 'competitor', competitors: [{ id: 'c1', name: 'lumière candles' }], keyConclusions: [{ text: 'Competitors rarely show prices', basis: 'analysis', sourceIds: [] }] });
  rep('rep3', 'Still running', {}, 'draft');
  rep('rep4', 'Removed', { keyConclusions: [{ text: 'ARCHIVED-FINDING', basis: 'analysis' }] }, 'ready', true);
  rep('rep5', 'Someone else', { keyConclusions: [{ text: 'OTHER-USER-FINDING', basis: 'analysis' }] }, 'ready', false, 'rcL1');
  r = await call('GET', '/api/research/insights', I);
  const f = r.body.findings || [];
  check('6.2 findings come from saved reports only (2 ready, not the running, archived or another account’s), each linked to its report', f.length === 2 && f.every((x) => ['rep1', 'rep2'].includes(x.reportId) && x.reportTitle) && !/ARCHIVED-FINDING|OTHER-USER-FINDING/.test(JSON.stringify(r.body)) && r.body.reports.length === 3, f.map((x) => x.reportId));
  check('6.3 sources are the report’s real links (https only; the javascript: link dropped); evidence labels kept', f[0].sources.length === 1 && f[0].sources[0].url === 'https://candles.example/report' && f.find((x) => x.reportId === 'rep1').basis === 'source_checked' && f.find((x) => x.reportId === 'rep2').basis === 'analysis');
  check('6.4 opportunities (labelled ideas, with their support) and recommended next actions (labelled analysis) are collected', r.body.opportunities.length === 1 && r.body.opportunities[0].basis === 'idea' && r.body.opportunities[0].supportBasis === 'source_cited' && r.body.actions.length === 1 && r.body.actions[0].basis === 'analysis');
  check('6.5 a competitor named in two reports is a recurring observation (case-insensitive), with both reports', r.body.recurringCompetitors.length === 1 && r.body.recurringCompetitors[0].reports.length === 2);
  check('6.6 saved insights come back (only valid ids)', JSON.stringify(r.body.saved) === '["rep1:o1"]');
  check('6.7 reading Insights makes no AI call and charges nothing', AI.calls === ai5 && H.rpcCalls.length === rpc0);
  r = await call('GET', '/api/research/insights', null);
  check('6.8 not signed in → 401', r.status === 401);

  // ── 7. Local preview and production enforcement ───────────────
  log('\n7. Local preview, paid actions still enforced');
  r = await call('GET', '/api/dev/local-preview', null);
  check('7.1 a local server (no RENDER) answers the preview probe', r.status === 200 && r.body.localPreview === true);
  const src = require('fs').readFileSync(require('path').join(H.SERVER_DIR, 'server.js'), 'utf8');
  const at = src.indexOf("app.get('/api/dev/local-preview'");
  check('7.2 the probe is only registered off Render and outside NODE_ENV=production (never in production)', at > 0 && /if \(!process\.env\.RENDER && process\.env\.NODE_ENV !== 'production'\) \{\s*$/.test(src.slice(Math.max(0, at - 200), at)));
  const ai7 = AI.calls;
  r = await call('POST', '/api/research/query', F1, { question: 'Who buys handmade candles in Utrecht?', type: 'trends' }, { 'X-Idempotency-Key': 'k-rc-1' });
  check('7.3 an account without paid access still can’t run research (refused by the server, no AI call, no report row)', [402, 403].includes(r.status) && AI.calls === ai7 && !(H.TABLES.creative_assets || []).some((x) => x.user_id === 'rcFree'), { status: r.status, code: r.body && r.body.code });
  r = await call('POST', '/api/research/query', I, { question: 'x', type: 'trends' }, { 'X-Idempotency-Key': 'k-rc-2' });
  check('7.4 the new research directions are accepted types (a too-short question is the only error)', r.status === 400 && r.body.code === 'QUESTION_TOO_SHORT');

  check('Z. no unexpected outbound network calls', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { console.error(e); process.exit(1); });
