// ════════════════════════════════════════════════════════════════
// A new Marketing Plan on request — POST /api/onboarding/plan/regenerate
// (services/onboardingFlow.js regeneratePlan), end to end against the REAL
// server.js.
//
//   • paid access required; the cost (FEATURE_COSTS.plan_generation) is
//     charged once and returned when the new plan can't be written
//   • the owner's instructions, their onboarding answers and what they saved
//     in OrivenAI (research, audiences, competitors, campaigns) reach the
//     model; tasks stay in-app (planCatalog actions only)
//   • the current plan stays until the new one is ready; a failure changes
//     nothing; the replaced plan is kept
//   • Progress follows the new plan: its tasks, dated from today, manual
//     ticks of the old plan don't carry over, results from before don't
//     complete new tasks
//   • nothing else is touched (research, content, campaigns, audiences,
//     the assistant)
//
// Faked: Supabase (in memory), the AIML provider. No network, no paid AI.
// RUN: node tests/plan-regenerate.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const AIML = 'http://aiml.mock.invalid';
const H = boot({ port: 5677, env: { AIML_BASE_OVERRIDE: AIML } });
const { check, log, done } = reporter();
const FLOW = require(path.join(H.SERVER_DIR, 'services', 'onboardingFlow'));
const { FEATURE_COSTS } = require(path.join(H.SERVER_DIR, 'services', 'pricing'));
const { roadmapFor } = require('./helpers/planFixture');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const sess = (id) => H.rows('onboarding_sessions').find((r) => r.user_id === id);
const UID = '00000000-0000-4000-8000-000000009001';
const TOK = 'tok_regen';
H.TOKENS[TOK] = { id: UID, email: 'regen@example.invalid' };

const ANSWERS = {
  business: { name: 'Bloom & Wick', industry: 'Retail & e-commerce', offer: 'Hand-poured soy candles and candle workshops', area: 'Utrecht, Netherlands', website: 'bloomandwick.example', socials: ['https://instagram.com/bloomandwick'] },
  audience: { type: 'b2c', ideal: 'Gift shoppers and interior lovers aged 25–45', location: 'regional', problem: 'Finding a gift that feels personal' },
  offer: { main: 'Soy candles', different: 'Poured by hand in our own studio', price: 'premium', why: 'Natural ingredients and a local studio' },
  goals: { primary: 'sales', secondary: 'retention', success: '50 online orders a month' },
  marketing: { channels: ['instagram', 'email'], working: ['instagram'], challenge: 'time', paidAds: 'no' },
  budget: { budget: '250_500', time: '2_5', team: 'me' },
};
const STRATEGY = (summary) => ({
  summary,
  overview: { text: 'Bloom & Wick sells hand-poured soy candles from a studio in Utrecht, mostly to gift shoppers.' },
  audience: { text: 'Gift shoppers and interior lovers in and around Utrecht.', segments: [{ name: 'Gift shoppers', needs: 'A thoughtful present' }] },
  positioning: { statement: 'Hand-poured, natural candles from an Utrecht studio.', proof_points: ['Poured by hand'] },
  objectives: [{ objective: 'Grow repeat orders', measure: 'Repeat orders per month' }],
  channels: [{ channel: 'Meta', role: 'Discovery', why: 'Visual product', effort: 'medium' }],
  content: { pillars: [{ name: 'Studio', ideas: ['Pouring process'] }], cadence: 'Three ads a week' },
  campaigns: [{ name: 'Gift boxes', goal: 'Sales', idea: 'Gift boxes for Mother’s Day' }],
  priorities: ['Research the gift-box market', 'Build the gift-shopper audience'],
});

// ── Fake provider: plan prompts answered with in-app tasks per phase ──
const AI = { mode: 'ok', calls: [], hold: null };
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
H.net.handler = async (u, opts) => {
  if (!u.startsWith(AIML)) return null;
  let body = {}; try { body = JSON.parse(opts.body); } catch (_) {}
  const sys = (body.messages && body.messages[0] && body.messages[0].content) || '';
  const usr = (body.messages && body.messages[1] && body.messages[1].content) || '';
  const isPlan = /strategy and action plan covering the next|You are continuing the .* action plan/.test(sys);
  if (isPlan) AI.calls.push({ sys, usr });
  if (AI.hold) await AI.hold;
  if (isPlan && AI.mode === 'down') return jres(503, { error: { message: 'upstream unavailable' } });
  const content = isPlan ? JSON.stringify(Object.assign(STRATEGY('Your new plan focuses on gift boxes on Meta, as you asked.'), { roadmap: roadmapFor(sys) })) : 'Hello.';
  return jres(200, { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
};

(async () => {
  await H.start();
  // A paying annual customer, 40 days in, with a ready plan and some progress.
  const unlocked = new Date(Date.now() - 40 * DAY).toISOString();
  const expires = new Date(Date.now() + 120 * DAY).toISOString(); // 120 days left → a 3-month plan
  H.rows('profiles').push({ id: UID, email: 'regen@example.invalid', subscription_status: 'paid', access_plan: 'annual', access_expires_at: expires, credits_balance: 500, onboarding_completed: true, created_at: unlocked, preferences: { assistant: 'scout', theme: 'dark' } });
  const h = FLOW.HORIZONS.annual;
  const old = FLOW.sanitizePlan(Object.assign(STRATEGY('Turn local gift shoppers into repeat buyers.'), { roadmap: h.phases.map((n) => ({ phase: n, focus: 'F', tasks: [
    { title: n + ' review campaigns', why: 'w', what: 'x', action: 'review_campaigns' },
    { title: n + ' write ad copy', why: 'w', what: 'x', action: 'create_ad_copy' },
    { title: n + ' build audience', why: 'w', what: 'x', action: 'build_audience' },
  ] })) }), 2, h);
  old.assistant = 'scout'; old.generated_at = unlocked;
  H.rows('onboarding_sessions').push({ user_id: UID, status: 'completed', step: 'done', answers: ANSWERS, assistant: 'scout', plan_status: 'ready', plan: old, plan_ready_at: unlocked, unlocked_at: unlocked, plan_attempts: 1, website_attempts: 0,
    analysis: { horizon: { period: 'annual', label: '12 months', days: 365 } }, progress: { planAt: unlocked, done: { 'p1-a1': unlocked } } });
  // What the owner saved in OrivenAI (and must survive)
  H.rows('creative_assets').push({ id: 'ra1', user_id: UID, kind: 'research', status: 'ready', title: 'Gift-box market in the Netherlands', content: { type: 'market' }, created_at: new Date(Date.now() - 10 * DAY).toISOString() });
  H.rows('creative_assets').push({ id: 'ad1', user_id: UID, kind: 'ad', status: 'ready', title: 'Workshop ad', content: { text: 'Pour your own candle' }, created_at: new Date(Date.now() - 5 * DAY).toISOString(), source_route: '/api/generate-text' });
  H.rows('business_audiences').push({ id: 'au1', user_id: UID, name: 'Gift shoppers Utrecht' });
  H.rows('business_competitors').push({ id: 'co1', user_id: UID, company: 'Wax & Wick' });
  H.rows('campaigns').push({ id: 'cp1', user_id: UID, name: 'Workshop launch', platform: 'meta', status: 'draft', created_at: new Date(Date.now() - 3 * DAY).toISOString() });
  const before = { assets: H.rows('creative_assets').length, aud: H.rows('business_audiences').length, comp: H.rows('business_competitors').length, camps: H.rows('campaigns').length };

  log('\nA. Before');
  let r = await H.call('GET', '/api/onboarding/plan', TOK);
  check('A1 the plan reads ready, with no regeneration running', r.status === 200 && r.body.status === 'ready' && r.body.plan && r.body.regen === null, { status: r.status, regen: r.body.regen });
  r = await H.call('GET', '/api/onboarding/progress', TOK);
  check('A2 Progress has the old plan’s tasks and one manual tick', r.body.status === 'ready' && r.body.total === 36 && r.body.phases[0].steps[0].done === true, { total: r.body.total });

  log('\nB. Access and credits');
  prof(UID).access_expires_at = new Date(Date.now() - DAY).toISOString();
  r = await H.call('POST', '/api/onboarding/plan/regenerate', TOK, { instructions: 'Focus on gift boxes' });
  check('B1 no active plan → 402, nothing charged, nothing started', r.status === 402 && r.body.code === 'ACCESS_REQUIRED' && prof(UID).credits_balance === 500 && !AI.calls.length, r.body);
  prof(UID).access_expires_at = expires;
  prof(UID).credits_balance = 10;
  r = await H.call('POST', '/api/onboarding/plan/regenerate', TOK, { instructions: 'Focus on gift boxes' });
  check('B2 not enough credits → 402 CREDITS_EXHAUSTED, nothing started', r.status === 402 && r.body.code === 'CREDITS_EXHAUSTED' && !AI.calls.length && !(sess(UID).analysis || {}).regen, r.body);
  prof(UID).credits_balance = 500;
  check('B3 no sign-in → 401', (await H.call('POST', '/api/onboarding/plan/regenerate', null, {})).status === 401);

  log('\nC. A new plan, written while the current one stays');
  let release; AI.hold = new Promise((res) => { release = res; });
  r = await H.call('POST', '/api/onboarding/plan/regenerate', TOK, { instructions: 'We now sell gift boxes and want to focus on Meta with a €500 budget.' });
  check('C1 accepted (202): the response still has the current plan and says a new one is being written', r.status === 202 && r.body.plan && r.body.plan.summary === old.summary && r.body.regen && r.body.regen.status === 'generating', { status: r.status, regen: r.body.regen });
  check('C2 the cost is charged once (' + FEATURE_COSTS.plan_generation + ' credits)', prof(UID).credits_balance === 500 - FEATURE_COSTS.plan_generation, prof(UID).credits_balance);
  r = await H.call('POST', '/api/onboarding/plan/regenerate', TOK, { instructions: 'again' });
  check('C3 a second request while it runs → 409 PLAN_REGENERATING, not charged again', r.status === 409 && r.body.code === 'PLAN_REGENERATING' && prof(UID).credits_balance === 500 - FEATURE_COSTS.plan_generation, r.body);
  r = await H.call('GET', '/api/onboarding/progress', TOK);
  check('C4 meanwhile Progress is unchanged (old plan, its tick kept)', r.body.total === 36 && r.body.phases[0].steps[0].done === true);
  release(); AI.hold = null;
  for (let i = 0; i < 40 && (sess(UID).analysis || {}).regen; i++) await sleep(50);
  const first = AI.calls[0] || { sys: '', usr: '' };
  check('C5 the model got the owner’s request, their answers, the previous plan and what they saved in OrivenAI', /We now sell gift boxes/.test(first.usr) && /Hand-poured soy candles and candle workshops/.test(first.usr) && /Turn local gift shoppers into repeat buyers/.test(first.usr) && /Gift-box market in the Netherlands/.test(first.usr) && /Gift shoppers Utrecht/.test(first.usr) && /Wax & Wick/.test(first.usr) && /Workshop launch/.test(first.usr), first.usr.slice(0, 300));
  check('C6 …and the rule to follow it within the in-app task rules', /owner_request/.test(first.sys) && /never overrides them/.test(first.sys) && /oriven_context/.test(first.sys));
  check('C7 it covers the rest of the access: 120 days left → a 3-month plan (6 phases)', /covering the next 3 months/.test(first.sys), first.sys.slice(0, 200));
  r = await H.call('GET', '/api/onboarding/plan', TOK);
  const np = r.body.plan || {};
  check('C8 the new plan is saved: new summary, version 2, the request recorded, starts today', np.summary === 'Your new plan focuses on gift boxes on Meta, as you asked.' && np.version === 2 && /gift boxes/.test(np.request) && Math.abs(Date.parse(np.startsAt) - Date.now()) < 60e3 && r.body.regen === null, { v: np.version, s: np.summary, regen: r.body.regen });
  check('C9 only in-app tasks (catalogue actions) in every phase', (np.roadmap || []).length === 6 && np.roadmap.every((p) => p.tasks.length >= 2 && p.tasks.every((t) => require(path.join(H.SERVER_DIR, 'services', 'planCatalog')).action(t.action))));
  check('C10 the replaced plan is kept', sess(UID).analysis.previous_plan && sess(UID).analysis.previous_plan.plan.summary === old.summary && r.body.previous && r.body.previous.replacedAt);
  check('C11 the plan still speaks as Scout (the account’s assistant)', np.assistant === 'scout' && /You are Scout/.test(first.sys));
  r = await H.call('GET', '/api/onboarding/progress', TOK);
  const manualDone = r.body.phases.reduce((n, p) => n + p.steps.filter((x) => x.verify === 'manual' && x.done).length, 0);
  const audDone = r.body.phases.reduce((n, p) => n + p.steps.filter((x) => x.action === 'build_audience' && x.done).length, 0);
  check('C12 Progress follows the new plan: its 18 tasks, dated from today, the old manual tick gone (only the audience that really exists counts)', r.body.status === 'ready' && r.body.total === 18 && manualDone === 0 && r.body.completed === audDone && audDone === 1 && Math.abs(Date.parse(r.body.phases[0].starts) - Date.now()) < 60e3, { total: r.body.total, completed: r.body.completed, starts: r.body.phases[0] && r.body.phases[0].starts });
  check('C13 results from before the new plan don’t complete its tasks (the ad made 5 days ago)', r.body.phases[0].steps.filter((x) => x.action === 'create_ad_copy').every((x) => !x.done));
  check('C14 nothing else changed: research, content, audiences, competitors, campaigns, the assistant, other preferences', H.rows('creative_assets').length === before.assets && H.rows('business_audiences').length === before.aud && H.rows('business_competitors').length === before.comp && H.rows('campaigns').length === before.camps && prof(UID).preferences.assistant === 'scout' && prof(UID).preferences.theme === 'dark');
  check('C15 the credits stay spent (no refund on success)', prof(UID).credits_balance === 500 - FEATURE_COSTS.plan_generation);

  log('\nD. A failed attempt changes nothing and returns the credits');
  AI.mode = 'down'; AI.calls.length = 0;
  const bal = prof(UID).credits_balance, planNow = sess(UID).plan;
  r = await H.call('POST', '/api/onboarding/plan/regenerate', TOK, { instructions: 'More video ads' });
  check('D1 accepted (202)', r.status === 202);
  for (let i = 0; i < 40 && (sess(UID).analysis || {}).regen && sess(UID).analysis.regen.status === 'generating'; i++) await sleep(50);
  await sleep(50);
  r = await H.call('GET', '/api/onboarding/plan', TOK);
  check('D2 the plan is unchanged and the failure is reported (with the instructions kept for a retry)', r.body.plan.summary === planNow.summary && r.body.regen && r.body.regen.status === 'failed' && r.body.regen.instructions === 'More video ads', r.body.regen);
  check('D3 the credits were returned', prof(UID).credits_balance === bal, { before: bal, now: prof(UID).credits_balance });
  r = await H.call('GET', '/api/onboarding/progress', TOK);
  check('D4 Progress is unchanged', r.body.total === 18);
  AI.mode = 'ok';
  r = await H.call('POST', '/api/onboarding/plan/regenerate', TOK, { instructions: 'More video ads' });
  for (let i = 0; i < 40 && (sess(UID).analysis || {}).regen; i++) await sleep(50);
  r = await H.call('GET', '/api/onboarding/plan', TOK);
  check('D5 trying again after a failure works (version 3, the failure cleared)', r.status === 200 && r.body.plan.version === 3 && r.body.regen === null, { v: r.body.plan.version, regen: r.body.regen });

  log('\nE. Without a plan');
  const U2 = '00000000-0000-4000-8000-000000009002';
  H.TOKENS.tok_noplan = { id: U2, email: 'np@example.invalid' };
  H.rows('profiles').push({ id: U2, email: 'np@example.invalid', subscription_status: 'paid', access_plan: 'monthly', access_expires_at: expires, credits_balance: 500, onboarding_completed: true, created_at: unlocked, preferences: {} });
  r = await H.call('POST', '/api/onboarding/plan/regenerate', 'tok_noplan', { instructions: 'x' });
  check('E1 no plan to replace → 409 NO_PLAN, and the credits were returned', r.status === 409 && r.body.code === 'NO_PLAN' && prof(U2).credits_balance === 500, { status: r.status, body: r.body, bal: prof(U2).credits_balance });

  log('\nF. Helpers');
  check('F1 horizonForDays picks the longest plan that fits (14→flex, 40→monthly, 120→quarterly, 200→semiannual, 400→annual)', ['flex', 'monthly', 'quarterly', 'semiannual', 'annual'].join() === [14, 40, 120, 200, 400].map((d) => FLOW.horizonForDays(d).period).join());

  check('no unexpected outbound requests', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
