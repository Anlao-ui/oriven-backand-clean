// ════════════════════════════════════════════════════════════════
// Guided onboarding — questionnaire, website reading, plan generation and the
// paywall, end to end against the REAL server.js (services/onboardingFlow.js).
//
// Faked: Supabase (in memory, tests/helpers/mockServer.js), the AIML provider
// (AIML_BASE_OVERRIDE → an in-process fake) and website fetches (the flow's
// fetcher is swapped for a fake; private-address URLs go to the REAL
// SSRF-safe fetcher, which refuses them before any connection). No network,
// no paid AI calls, no Stripe, no real users.
//
// RUN: node tests/onboarding-flow.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const AIML = 'http://aiml.mock.invalid';
const H = boot({ port: 5631, env: { AIML_BASE_OVERRIDE: AIML, AI_USER_DAILY_CALL_CAP: '6' } });
const { check, log, done } = reporter();

const NEW = new Date().toISOString();
const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const sess = (id) => H.rows('onboarding_sessions').find((r) => r.user_id === id);
function user(id, extra) {
  H.rows('profiles').push(Object.assign({ id, subscription_status: 'free', created_at: NEW, credits_balance: 0, onboarding_completed: false, access_expires_at: null, preferences: {} }, extra || {}));
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: NEW };
  return 'tok_' + id;
}

// ── Fake provider ──
const AI = { plan: 'ok', hold: null, calls: [] };
const SITE_TEXT = 'Bloom & Wick makes hand-poured soy candles in Utrecht. Every candle is poured by hand in our studio using natural soy wax and cotton wicks. '
  + 'We sell to gift shoppers and interior lovers who want a calm home without synthetic fragrance. Order online or visit our studio shop on Oudegracht. '
  + 'Workshops every Saturday teach you to pour your own candle. Free delivery in the Netherlands on orders over 40 euros.';
const PLAN = {
  summary: 'Focus on Instagram and email to turn local gift shoppers into repeat buyers.',
  overview: { text: 'Bloom & Wick sells hand-poured soy candles from a studio in Utrecht.' },
  audience: { text: 'Gift shoppers and interior lovers in Utrecht.', segments: [{ name: 'Gift shoppers', needs: 'A thoughtful present' }] },
  positioning: { statement: 'Hand-poured, natural candles from an Utrecht studio.', proof_points: ['Poured by hand'] },
  objectives: [{ objective: 'Grow repeat orders', measure: 'Repeat orders per month' }],
  channels: [{ channel: 'Instagram', role: 'Discovery', why: 'Visual product', effort: 'medium' }, { channel: 'Email', role: 'Repeat sales', why: 'Owned audience', effort: 'low' }, { channel: 'TikTok', role: 'x', why: 'x', effort: 'high' }],
  content: { pillars: [{ name: 'Studio', ideas: ['Pouring process'] }], cadence: 'Three posts a week' },
  campaigns: [{ name: 'Saturday workshops', goal: 'Bookings', idea: 'Promote workshops locally' }],
  priorities: ['Set up an email list', 'Post three times a week on Instagram'],
  roadmap: [{ phase: 'Days 1–30', focus: 'Foundations', actions: ['Set up email'] }, { phase: 'Days 31–60', focus: 'Grow', actions: ['Run a workshop campaign'] }, { phase: 'Days 61–90', focus: 'Repeat', actions: ['Launch a loyalty offer'] }],
};
// The roadmap the prompt asks for: its phase names, two actions each.
function planFor(sys) {
  const m = sys.match(/"roadmap":\[(.*)\]\}\s*\nRoadmap:/);
  const names = m ? Array.from(m[1].matchAll(/"phase":"([^"]+)"/g)).map((x) => x[1]) : [];
  return Object.assign({}, PLAN, { roadmap: names.map((n, i) => ({ phase: n, focus: 'Focus ' + (i + 1), actions: [{ step: 'Write the ' + n + ' workshop ad', area: 'create' }, { step: 'Check ' + n + ' results', area: 'campaigns' }] })) });
}
const PERIODS = { flex: 2, monthly: 4, quarterly: 6, semiannual: 6, annual: 12 };
// Payment confirmed (what fulfill_purchase does): paid purchase, access
// period and the purchased plan on the profile.
function pay(id, planId) {
  H.rows('purchases').push({ id: 'pur_' + id, user_id: id, plan_id: planId, status: 'paid', paid_at: new Date().toISOString() });
  Object.assign(prof(id), { subscription_status: 'paid', access_expires_at: FUTURE, access_plan: planId });
}
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
H.net.handler = async (u, opts) => {
  if (!u.startsWith(AIML)) return null;
  let body = {}; try { body = JSON.parse(opts.body); } catch (_) {}
  const sys = (body.messages && body.messages[0] && body.messages[0].content) || '';
  const kind = /extract facts about a business/.test(sys) ? 'website' : /marketing strategy covering the next/.test(sys) ? 'plan' : 'other';
  AI.calls.push({ kind, model: body.model, max_tokens: body.max_tokens, system: sys, user: body.messages && body.messages[1] && body.messages[1].content });
  if (kind === 'website') {
    return jres(200, { choices: [{ message: { content: JSON.stringify({ suggestions: {
      offer: { value: 'Hand-poured soy candles', quote: 'makes hand-poured soy candles in Utrecht' },
      audience: { value: 'Gift shoppers and interior lovers', quote: 'We sell to gift shoppers and interior lovers' },
      differentiator: { value: 'Award-winning candles', quote: 'Winner of the 2024 Dutch Candle Award' }, // not on the page: must be dropped
    } }) } }], usage: { prompt_tokens: 900, completion_tokens: 200 } });
  }
  if (kind === 'plan') {
    if (AI.hold) await AI.hold;
    if (AI.plan === 'down') return jres(503, { error: { message: 'upstream unavailable' } });
    if (AI.plan === 'garbage') return jres(200, { choices: [{ message: { content: 'Sorry, I cannot do that.' } }] });
    return jres(200, { choices: [{ message: { content: '```json\n' + JSON.stringify(planFor(sys)) + '\n```' } }], usage: { prompt_tokens: 2500, completion_tokens: 1800 } });
  }
  return jres(200, { choices: [{ message: { content: 'Hello.' } }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
};

// ── Fake website fetcher (private addresses go to the real SSRF-safe one) ──
const FETCH = { calls: [] };
const realFetcher = require(path.join(H.SERVER_DIR, 'services', 'urlContextFetcher'));
async function fakeFetch(url, opts) {
  FETCH.calls.push(url);
  const host = new URL(url).hostname;
  if (/^(127\.|10\.|169\.254\.|192\.168\.)/.test(host)) return realFetcher.fetchUrlContext(url, opts);
  if (host === 'down.example') return { ok: false, url, reason: 'Could not resolve that domain.', code: 'dns_failure' };
  if (host === 'slow.example') return { ok: false, url, reason: 'Timed out fetching that page.', code: 'timeout' };
  if (host === 'guarded.example') return { ok: false, url, reason: 'The page returned status 403.', code: 'http_error' };
  if (host === 'challenge.example') return { ok: true, url, finalUrl: url, domain: host, title: 'Just a moment...', description: '', text: 'Checking your browser before accessing challenge.example. Enable JavaScript and cookies to continue. ' + 'x '.repeat(200) };
  if (host === 'thin.example') return { ok: true, url, finalUrl: url, domain: host, title: 'Home', description: '', text: 'Welcome. Coming soon.' };
  if (host === 'pdf.example') return { ok: false, url, reason: 'Unsupported content type for research context.', code: 'unsupported_content_type' };
  return { ok: true, url, finalUrl: url, domain: host.replace(/^www\./, ''), title: 'Bloom & Wick — hand-poured candles', description: 'Soy candles from Utrecht', text: SITE_TEXT };
}

const ANSWERS = {
  business: { name: 'Bloom & Wick', industry: 'Retail & e-commerce', offer: 'Hand-poured soy candles and candle workshops', area: 'Utrecht, Netherlands', website: 'bloomandwick.example', socials: ['https://instagram.com/bloomandwick'] },
  audience: { type: 'b2c', ideal: 'Gift shoppers and interior lovers aged 25–45', location: 'regional', problem: 'Finding a gift that feels personal' },
  offer: { main: 'Soy candles', different: 'Poured by hand in our own studio', price: 'premium', why: 'Natural ingredients and a local studio' },
  goals: { primary: 'sales', secondary: 'retention', success: '50 online orders a month' },
  marketing: { channels: ['instagram', 'email'], working: ['instagram'], challenge: 'time', paidAds: 'no' },
  budget: { budget: '250_500', time: '2_5', team: 'me' },
};

(async () => {
  const quiet = await H.start();
  const flow = require(path.join(H.SERVER_DIR, 'services', 'onboardingFlow'));
  flow._setFetcherForTests(fakeFetch);
  const spendGuard = require(path.join(H.SERVER_DIR, 'services', 'spendGuard'));
  const { call } = H;
  const rpc0 = H.rpcCalls.length;

  // ── 1. Account and session ─────────────────────────────────────
  log('\n1. Account, eligibility and session');
  const A = user('obA');
  user('obOld', { created_at: '2026-01-01T00:00:00Z' });
  let r = await call('GET', '/api/onboarding/state', 'tok_obA');
  check('1.1 new account: state says the guided flow is enabled', r.status === 200 && r.body.flow && r.body.flow.enabled === true, r.body);
  r = await call('GET', '/api/onboarding/state', 'tok_obOld');
  check('1.2 existing (pre-rollout) account: flow not enabled (never interrupted)', r.status === 200 && r.body.flow && r.body.flow.enabled === false);
  r = await call('GET', '/api/onboarding/session', null);
  check('1.3 session without a token → 401', r.status === 401);
  r = await call('GET', '/api/onboarding/session', A);
  check('1.4 session is created on first read, at the welcome step', r.status === 200 && r.body.session.step === 'welcome' && r.body.session.plan.status === 'none' && !!sess('obA'));

  // ── 2. Questions: autosave, validation, resume ─────────────────
  log('\n2. Questions');
  r = await call('PUT', '/api/onboarding/session', A, { step: 'business', answers: { business: { name: '  Bloom & Wick  ', industry: 'Retail & e-commerce', offer: ANSWERS.business.offer, area: 'Utrecht', hacked: 'x' } } });
  check('2.1 autosave stores trimmed answers and drops unknown keys', r.status === 200 && sess('obA').answers.business.name === 'Bloom & Wick' && !('hacked' in sess('obA').answers.business) && r.body.session.step === 'business', { s: r.status, b: r.body, row: sess('obA') });
  r = await call('PUT', '/api/onboarding/session', A, { answers: { audience: { type: 'aliens', location: 'regional' } } });
  check('2.2 an invalid choice is not stored', r.status === 200 && sess('obA').answers.audience.type === '' && sess('obA').answers.audience.location === 'regional');
  r = await call('PUT', '/api/onboarding/session', A, { step: 'nowhere' });
  check('2.3 unknown step → 400', r.status === 400 && r.body.code === 'INVALID_STEP');
  const screenSteps = ['business-industry', 'business-offer', 'business-area', 'business-online', 'audience-ideal', 'audience-problem', 'offer-different', 'offer-price', 'goals-success', 'marketing-challenge', 'marketing-paid', 'budget-capacity'];
  const stepRes = [];
  for (const st of screenSteps) { const x = await call('PUT', '/api/onboarding/session', A, { step: st }); stepRes.push(x.status === 200 && x.body.session.step === st); }
  check('2.3b every one-question screen is a valid, resumable step', stepRes.every(Boolean), stepRes);
  r = await call('PUT', '/api/onboarding/session', A, { answers: { marketing: { channels: ['none', 'instagram'], working: ['tiktok'] } } });
  check('2.4 "None yet" excludes other channels; results only from used channels', JSON.stringify(sess('obA').answers.marketing.channels) === '["none"]' && sess('obA').answers.marketing.working.length === 0);
  r = await call('POST', '/api/onboarding/plan', A, {});
  check('2.5 a plan can’t be started before payment → 402 ACCESS_REQUIRED, no AI call', r.status === 402 && r.body.code === 'ACCESS_REQUIRED' && AI.calls.length === 0, r.body);
  r = await call('PUT', '/api/onboarding/session', A, { step: 'budget', answers: ANSWERS });
  r = await call('GET', '/api/onboarding/session', A);
  check('2.6 resume: answers and step come back exactly (editing earlier answers works the same way)', r.body.session.step === 'budget' && r.body.session.answers.offer.main === 'Soy candles' && r.body.session.missing.length === 0, r.body.session.missing);
  r = await call('GET', '/api/onboarding/plan', A);
  check('2.7 reading the plan before payment starts nothing: locked, status "none", no AI call', r.status === 200 && r.body.locked === true && r.body.status === 'none' && !r.body.plan && AI.calls.length === 0, r.body);
  {
    const N = user('obN');
    await call('PUT', '/api/onboarding/session', N, { answers: { business: { name: 'Half Done' } } });
    pay('obN', 'monthly');
    r = await call('POST', '/api/onboarding/plan', N, {});
    check('2.8 paid, but answers incomplete → 400 with the missing fields, no AI call', r.status === 400 && r.body.code === 'ANSWERS_INCOMPLETE' && r.body.missing.includes('offer.main') && AI.calls.length === 0, r.body);
    r = await call('GET', '/api/onboarding/plan', N);
    check('2.9 …and the plan page says which answers are missing (unlocked, no plan, no call)', r.body.locked === false && r.body.status === 'none' && r.body.missing.includes('offer.main') && !r.body.plan && AI.calls.length === 0, r.body);
  }

  // ── 3. Website reading ─────────────────────────────────────────
  log('\n3. Website reading');
  const web = async (url) => (await call('POST', '/api/onboarding/website', A, { url })).body;
  let w = await web('not a url');
  check('3.1 invalid address → "invalid", nothing fetched, no reading used', w.session.website.status === 'invalid' && FETCH.calls.length === 0 && w.session.websiteReadsLeft === 5, w);
  w = await web('http://169.254.169.254/latest/meta-data');
  check('3.2 private / metadata address refused by the SSRF-safe fetcher → "invalid", no AI call', w.session.website.status === 'invalid' && AI.calls.length === 0, w.session.website);
  w = await web('down.example');
  check('3.3 unreachable → "unreachable" with a clear message', w.session.website.status === 'unreachable' && /couldn’t reach/.test(w.session.website.message));
  w = await web('slow.example');
  check('3.4 timeout → "timeout"', w.session.website.status === 'timeout');
  w = await web('guarded.example');
  check('3.5 403 (bot protection) → "blocked"', w.session.website.status === 'blocked');
  r = await call('POST', '/api/onboarding/website', A, { url: 'challenge.example' });
  check('3.6 bot-check page → "blocked", no AI call', r.body.session && r.body.session.website.status === 'blocked' && AI.calls.length === 0, r.body);
  r = await call('POST', '/api/onboarding/website', A, { url: 'thin.example' });
  check('3.7a a 7th website request within a minute → 429 RATE_LIMITED (per-account rate limit), nothing fetched', r.status === 429 && r.body.code === 'RATE_LIMITED' && FETCH.calls.length === 5, r.body);
  const L = user('obL');
  await call('GET', '/api/onboarding/session', L);
  sess('obL').website_attempts = 5;
  r = await call('POST', '/api/onboarding/website', L, { url: 'thin.example' });
  check('3.7b after 5 readings per account → 429 WEBSITE_LIMIT, nothing fetched', r.status === 429 && r.body.code === 'WEBSITE_LIMIT' && FETCH.calls.length === 5, r.body);
  // A second account for the remaining website cases.
  const W = user('obW');
  await call('PUT', '/api/onboarding/session', W, { answers: ANSWERS });
  r = await call('POST', '/api/onboarding/website', W, { url: 'thin.example' });
  check('3.8 incomplete page → "incomplete", no suggestions, no AI call', r.body.session.website.status === 'incomplete' && AI.calls.length === 0);
  r = await call('POST', '/api/onboarding/website', W, { url: 'pdf.example' });
  check('3.9 unsupported content → "unreadable"', r.body.session.website.status === 'unreadable');
  r = await call('POST', '/api/onboarding/website', W, { url: 'bloomandwick.example' });
  const sg = r.body.session.website.suggestions || {};
  check('3.10 readable site → suggestions, one cheap-model call', r.body.session.website.status === 'ok' && AI.calls.length === 1 && AI.calls[0].kind === 'website' && AI.calls[0].model === 'claude-haiku-4-5', { w: r.body.session.website, calls: AI.calls.map((c) => c.model) });
  check('3.11 only suggestions quoted from the page are kept (an invented award is dropped)', sg.offer && sg.audience && !sg.differentiator, sg);
  check('3.12 the page text is passed as untrusted data', /untrusted data/.test(AI.calls[0].system) && /<page_text>/.test(AI.calls[0].user));
  const fetches = FETCH.calls.length;
  r = await call('POST', '/api/onboarding/website', W, { url: 'https://bloomandwick.example' });
  check('3.13 the same site again is served from the stored reading (no fetch, no AI call)', FETCH.calls.length === fetches && AI.calls.length === 1);
  check('3.14 website data never appears among the user’s answers unless the user saves it', sess('obW').answers.audience.ideal === ANSWERS.audience.ideal);

  // ── 4. Assistant ───────────────────────────────────────────────
  log('\n4. Assistant');
  r = await call('PUT', '/api/onboarding/session', A, { assistant: 'gandalf' });
  check('4.1 unknown assistant → 400', r.status === 400 && r.body.code === 'INVALID_ASSISTANT');
  r = await call('PUT', '/api/onboarding/session', A, { assistant: 'metric', step: 'assistant' });
  check('4.2 choice persisted on the session and mirrored to the account preferences', r.status === 200 && sess('obA').assistant === 'metric' && prof('obA').preferences.assistant === 'metric');

  // ── 5. Plan generation (after payment, for the purchased period) ──
  log('\n5. Plan generation');
  const callsBefore = AI.calls.length;
  pay('obA', 'monthly');
  let release; AI.hold = new Promise((res) => { release = res; });
  const parallel = await Promise.all([1, 2, 3, 4].map(() => call('GET', '/api/onboarding/plan', A)));
  await sleep(50);
  check('5.1 after payment the first plan reads start it: four parallel reads → exactly one provider call (atomic claim)', AI.calls.filter((c) => c.kind === 'plan').length === 1 && parallel.every((p) => p.status === 200 && p.body.locked === false), parallel.map((p) => [p.status, p.body.status]));
  check('5.1b while generating: unlocked, "generating", the purchased period, no plan yet', parallel.some((p) => p.body.status === 'generating') && parallel.every((p) => !p.body.plan && p.body.period === 'monthly' && p.body.horizon && p.body.horizon.label === '1 month'));
  check('5.1c payment completed onboarding before the plan exists (the app opens right away)', sess('obA').status === 'completed' && prof('obA').onboarding_completed === true && !!sess('obA').unlocked_at);
  r = await call('PUT', '/api/onboarding/session', A, { answers: { business: { name: 'Changed' } } });
  check('5.2 answers are locked once paid / while the plan is generating', r.status === 403 || (r.status === 409 && r.body.code === 'ANSWERS_LOCKED'), r.status);
  release(); AI.hold = null;
  for (let i = 0; i < 40 && sess('obA').plan_status !== 'ready'; i++) await sleep(25);
  const planCall = AI.calls.find((c) => c.kind === 'plan');
  check('5.3 plan ready after one call on the cheap model', sess('obA').plan_status === 'ready' && planCall.model === 'claude-haiku-4-5' && AI.calls.length === callsBefore + 1);
  check('5.3b the plan covers the purchased period: "the next 1 month", four weekly phases, stored with the plan', /covering the next 1 month/.test(planCall.system) && /exactly 4 phases/.test(planCall.system) && sess('obA').plan.roadmap.map((p) => p.phase).join('|') === 'Week 1|Week 2|Week 3|Week 4' && sess('obA').plan.horizon.period === 'monthly' && planCall.max_tokens === flow.HORIZONS.monthly.maxTokens);
  check('5.3c onboarding stays completed while and after generating (status not reset)', sess('obA').status === 'completed');
  check('5.4 the prompt carries the chosen assistant’s persona and the source labels', /You are Metric/.test(planCall.system) && /Precise, direct and evidence-oriented/.test(planCall.system) && /"source":"user"/.test(planCall.user) && /"source":"derived"/.test(planCall.user));
  check('5.4b the strategy is generated from this account’s actual answers', ['Bloom & Wick', 'Hand-poured soy candles and candle workshops', 'Gift shoppers and interior lovers aged 25–45', 'Poured by hand in our own studio', '50 online orders a month', '€250–€500 a month'].every((t) => planCall.user.includes(t)), planCall.user.slice(0, 400));
  {
    const fsx = require('fs');
    const svc = fsx.readFileSync(path.join(H.SERVER_DIR, 'services', 'onboardingFlow.js'), 'utf8');
    const srv = fsx.readFileSync(path.join(H.SERVER_DIR, 'server.js'), 'utf8');
    const feDir = path.resolve(H.SERVER_DIR, '..', '..', 'oriven-frontend', 'js');
    const fe = fsx.existsSync(feDir) ? fsx.readdirSync(feDir).filter((f) => f.endsWith('.js')).map((f) => fsx.readFileSync(path.join(feDir, f), 'utf8')).join('\n') : '';
    const hook = srv.indexOf("require('./devPreview/onboardingPreview')"), guard = srv.lastIndexOf("process.argv.includes('--onboarding-preview')", hook);
    check('5.4c the preview sample strategy exists only in the dev preview: not in the production service or any frontend script', !/PREVIEW SAMPLE/.test(svc) && !/PREVIEW SAMPLE/.test(fe) && !/devPreview/.test(svc));
    check('5.4d server.js loads the preview only behind its explicit flag (normal start never reaches it)', hook > 0 && guard >= 0 && hook - guard < 200 && (srv.match(/require\(['"]\.\/devPreview/g) || []).length === 1);
    check('5.4e the stored strategy is the AI result for this account, not a sample', !/PREVIEW SAMPLE/.test(JSON.stringify(sess('obA').plan)) && sess('obA').plan.summary === PLAN.summary);
  }
  check('5.5 budget/time constraints reach the prompt (2 channels max) and the stored plan respects them', /at most 2|Recommend at most max_active_channels/.test(planCall.system + planCall.user) && /"max_active_channels":\{"value":2/.test(planCall.user) && sess('obA').plan.channels.length === 2);
  check('5.6 the structured analysis is stored with every section and the period', ['business', 'website_analysis', 'target_audience', 'offer', 'marketing_goals', 'current_marketing', 'budget_and_capacity', 'selected_assistant', 'horizon'].every((k) => k in sess('obA').analysis));
  r = await call('POST', '/api/onboarding/plan', A, {});
  await call('GET', '/api/onboarding/plan', A); await call('GET', '/api/onboarding/plan', A);
  check('5.7 asking again or reading it again once ready → no new call', r.status === 200 && AI.calls.length === callsBefore + 1);
  check('5.8 no credits: balance unchanged, no credit RPC, no credit action rows', prof('obA').credits_balance === 0 && H.rpcCalls.length === rpc0 && !(H.TABLES.credit_actions || []).length);

  // Every period gets its own roadmap shape (pure: prompt + validation).
  {
    const an = flow.buildAnalysis({ answers: ANSWERS, assistant: 'vector' });
    const shapes = Object.keys(PERIODS).map((k) => {
      const h = flow.HORIZONS[k];
      const p = flow.planPrompt(an, 'vector', 2, h);
      const plan = flow.sanitizePlan(planFor(p.system), 2, h);
      return { k, ok: plan.roadmap.length === PERIODS[k] && plan.horizon.period === k && new RegExp('covering the next ' + h.label).test(p.system) };
    });
    check('5.8b each period plans its own length: Flex 2 phases, Monthly 4, Quarterly 6, Semi-Annual 6, Annual 12', shapes.every((x) => x.ok), shapes);
    const h = flow.HORIZONS.annual;
    const big = flow.sanitizePlan(Object.assign({}, PLAN, { roadmap: h.phases.map((n) => ({ phase: n, focus: 'f', actions: Array.from({ length: 14 }, (_, j) => ({ step: 'Action ' + n + ' ' + j, area: 'create' })) })) }), 2, h);
    const steps = flow.planSteps(big, '2026-11-01T00:00:00Z', {});
    check('5.8c an annual plan can hold more than 100 steps (12 × up to 9), capped per phase, never padded', steps.total === 108 && steps.phases.length === 12 && steps.phases.every((p) => p.steps.length === 9));
    const thin = Object.assign({}, PLAN, { roadmap: h.phases.map((n) => ({ phase: n, focus: 'f', actions: [{ step: 'Same', area: 'x' }, { step: 'same', area: 'create' }] })) });
    let threw = false; try { flow.sanitizePlan(thin, 2, h); } catch (e) { threw = e.code === 'PLAN_INCOMPLETE'; }
    check('5.8d repeated actions are dropped; a plan too thin for its period (under 2 steps a phase) is refused', threw);
    const fx = flow.sanitizePlan(planFor(flow.planPrompt(an, 'vector', 2, flow.HORIZONS.flex).system), 2, flow.HORIZONS.flex);
    const fs2 = flow.planSteps(fx, '2026-11-01T00:00:00Z', {});
    check('5.8e Flex: two phases over 14 days (Days 1–7 from 1 Nov, Days 8–14 to 14 Nov), unknown areas become "outside"', fs2.phases[0].starts.slice(0, 10) === '2026-11-01' && fs2.phases[1].ends.slice(0, 10) === '2026-11-14' && flow.sanitizePlan(Object.assign({}, fx, { roadmap: fx.roadmap.map((p) => ({ phase: p.phase, actions: [{ step: 'a1', area: 'moon' }, { step: 'a2' }] })) }), 2, flow.HORIZONS.flex).roadmap[0].actions[0].area === 'outside');
  }

  // Failure, retry, attempt cap: the first attempt starts by itself after
  // payment, later attempts only on request.
  const F = user('obF');
  await call('PUT', '/api/onboarding/session', F, { answers: ANSWERS, assistant: 'nova' });
  AI.plan = 'down';
  pay('obF', 'flex');
  await call('GET', '/api/onboarding/plan', F);
  for (let i = 0; i < 300 && sess('obF').plan_status === 'generating'; i++) await sleep(50);
  r = await call('GET', '/api/onboarding/plan', F);
  check('5.9 provider failure → plan "failed", answers kept, retry offered', r.body.status === 'failed' && r.body.attemptsLeft === 2 && r.body.locked === false && sess('obF').answers.business.name === 'Bloom & Wick', r.body);
  const fr = AI.calls.length;
  await call('GET', '/api/onboarding/plan', F); await call('GET', '/api/onboarding/plan', F);
  check('5.9b reading a failed plan never retries by itself (no call)', AI.calls.length === fr && sess('obF').plan_attempts === 1);
  AI.plan = 'garbage';
  await call('POST', '/api/onboarding/plan', F, {});
  for (let i = 0; i < 300 && sess('obF').plan_status === 'generating'; i++) await sleep(50);
  check('5.10 unusable output → "failed" (invalid_output), nothing stored as a plan', sess('obF').plan_status === 'failed' && sess('obF').plan_error === 'invalid_output' && !sess('obF').plan);
  AI.plan = 'ok';
  await call('POST', '/api/onboarding/plan', F, {});
  for (let i = 0; i < 300 && sess('obF').plan_status === 'generating'; i++) await sleep(50);
  check('5.11 controlled retry succeeds on the third attempt, still for the purchased Flex period', sess('obF').plan_status === 'ready' && sess('obF').plan_attempts === 3 && sess('obF').plan.horizon.period === 'flex' && sess('obF').plan.roadmap.length === 2);
  const G = user('obG');
  await call('PUT', '/api/onboarding/session', G, { answers: ANSWERS, assistant: 'flux' });
  H.rows('onboarding_sessions').find((x) => x.user_id === 'obG').plan_attempts = 3;
  H.rows('onboarding_sessions').find((x) => x.user_id === 'obG').plan_status = 'failed';
  pay('obG', 'monthly');
  const g0 = AI.calls.length;
  r = await call('POST', '/api/onboarding/plan', G, {});
  check('5.12 after three attempts no further call is made (429, support contact)', r.status === 429 && r.body.code === 'PLAN_ATTEMPTS_USED' && AI.calls.length === g0);

  // Spend guard still applies (per-user daily call cap = 6 in this run).
  const S = user('obS');
  await call('PUT', '/api/onboarding/session', S, { answers: ANSWERS, assistant: 'scout' });
  for (let i = 0; i < 6; i++) spendGuard.recordCall({ userId: 'obS', model: 'claude-haiku-4-5', usage: null, success: true });
  const s0 = AI.calls.length;
  pay('obS', 'monthly');
  await call('GET', '/api/onboarding/plan', S);
  for (let i = 0; i < 300 && sess('obS').plan_status === 'generating'; i++) await sleep(50);
  check('5.13 spend guard active: over the per-user cap → no provider call, plan "failed" (busy), retry allowed later', AI.calls.length === s0 && sess('obS').plan_status === 'failed' && sess('obS').plan_error === 'busy');

  // ── 6. Paywall ────────────────────────────────────────────────
  log('\n6. Paywall and unlock');
  const PLAN_WORDS = /Saturday workshops|loyalty offer|Repeat orders per month|Hand-poured, natural candles/;
  const U = user('obU');
  await call('PUT', '/api/onboarding/session', U, { answers: ANSWERS, assistant: 'metric', step: 'paywall' });
  const u0 = AI.calls.length;
  r = await call('GET', '/api/onboarding/plan', U);
  check('6.1 without payment: locked, only name/assistant/status, no plan content, nothing generated', r.status === 200 && r.body.locked === true && r.body.businessName === 'Bloom & Wick' && r.body.assistant === 'metric' && !r.body.plan && r.body.status === 'none' && AI.calls.length === u0, r.body);
  r = await call('GET', '/api/onboarding/session', U);
  check('6.2 the session response never contains a plan', !PLAN_WORDS.test(JSON.stringify(r.body)) && r.body.session.plan.status === 'none');
  r = await call('GET', '/api/onboarding/state', A);
  check('6.3 the state response never contains the plan', !PLAN_WORDS.test(JSON.stringify(r.body)));
  r = await call('GET', '/api/onboarding/plan?unlocked=true&paid=1', U, null, { 'X-Paid': 'true' });
  check('6.4 URL / header manipulation changes nothing', r.body.locked === true && !r.body.plan && AI.calls.length === u0);
  r = await call('GET', '/api/onboarding/plan', null);
  check('6.5 no token → 401, nothing returned', r.status === 401 && !PLAN_WORDS.test(JSON.stringify(r.body)));
  r = await call('GET', '/api/onboarding/plan', W);
  check('6.6 another account can’t see a plan (own row only)', r.body.locked === true && !r.body.plan && r.body.status === 'none');
  prof('obU').subscription_status = 'paid';
  r = await call('GET', '/api/onboarding/plan', U);
  check('6.7 a paid label without an access period is still locked (and starts nothing)', r.body.locked === true && !r.body.plan && AI.calls.length === u0);
  prof('obU').access_expires_at = new Date(Date.now() - 864e5).toISOString();
  r = await call('GET', '/api/onboarding/plan', U);
  check('6.8 an expired access period is still locked', r.body.locked === true && !r.body.plan);
  r = await call('PUT', '/api/user/preferences', U, { access: true, subscription_status: 'paid' });
  r = await call('GET', '/api/onboarding/plan', U);
  check('6.9 writing client preferences can’t unlock it', r.body.locked === true && !r.body.plan && AI.calls.length === u0);

  r = await call('GET', '/api/onboarding/plan', A);
  check('6.10 after confirmed payment: full plan with all nine sections and its period', r.status === 200 && r.body.locked === false && r.body.plan && r.body.plan.roadmap.length === 4 && r.body.sections.length === 9 && r.body.horizon.period === 'monthly');
  check('6.11 unlock recorded: purchase reference, completed, onboarding marked complete', sess('obA').purchase_id === 'pur_obA' && !!sess('obA').unlocked_at && sess('obA').status === 'completed' && prof('obA').onboarding_completed === true);
  const bp = (H.TABLES.business_profile || []).find((x) => x.user_id === 'obA');
  check('6.12 business profile seeded from the answers (empty fields only)', bp && bp.company_name === 'Bloom & Wick' && bp.industry === 'Retail & e-commerce');
  r = await call('GET', '/api/onboarding/state', A);
  check('6.13 after unlock the flow is no longer shown (Control Center next)', r.body.flow.enabled === false && r.body.completed === true);

  // ── 6e. Progress steps ───────────────────────────────────────
  log('\n6e. Progress');
  r = await call('GET', '/api/onboarding/progress', A);
  const allIds = r.body.phases ? r.body.phases.flatMap((p) => p.steps.map((x) => x.id)) : [];
  check('6e.1 steps come from the plan’s roadmap: 4 weekly phases, 8 steps, none done, each with where it’s done', r.status === 200 && r.body.locked === false && r.body.phases.length === 4 && r.body.total === 8 && r.body.completed === 0 && r.body.phases[0].steps[0].area === 'create' && r.body.phases[0].phase === 'Week 1' && new Set(allIds).size === 8, r.body);
  r = await call('POST', '/api/onboarding/progress', A, { stepId: 'p1-a1', done: true });
  const doneAt = r.body.phases && r.body.phases[0].steps[0].doneAt;
  check('6e.2 ticking a step off stores it', r.status === 200 && r.body.completed === 1 && r.body.phases[0].steps[0].done === true && !!doneAt && sess('obA').progress.done['p1-a1'] === doneAt);
  r = await call('GET', '/api/onboarding/progress', A);
  check('6e.3 …and it stays done on the next visit', r.body.completed === 1 && r.body.phases[0].steps[0].done === true && r.body.phases[0].steps[0].doneAt === doneAt);
  await call('POST', '/api/onboarding/progress', A, { stepId: 'p1-a1', done: true });
  check('6e.4 ticking it again keeps the first time', sess('obA').progress.done['p1-a1'] === doneAt);
  r = await call('POST', '/api/onboarding/progress', A, { stepId: 'p9-a9', done: true });
  const r2 = await call('POST', '/api/onboarding/progress', A, { stepId: 'p1-a2', done: 'yes' });
  check('6e.5 unknown steps (400 UNKNOWN_STEP) and malformed requests (400) are refused', r.status === 400 && r.body.code === 'UNKNOWN_STEP' && r2.status === 400);
  await call('POST', '/api/onboarding/progress', A, { stepId: 'p2-a1', done: true });
  r = await call('POST', '/api/onboarding/progress', A, { stepId: 'p2-a1', done: false });
  check('6e.6 a step can be unticked', r.body.completed === 1 && !r.body.phases[1].steps[0].done);
  r = await call('GET', '/api/onboarding/progress', U);
  const rU = await call('POST', '/api/onboarding/progress', U, { stepId: 'p1-a1', done: true });
  check('6e.7 without access: locked, no steps; ticking refused (402)', r.body.locked === true && r.body.total === 0 && rU.status === 402);
  const saved = JSON.parse(JSON.stringify(sess('obA').plan));
  sess('obA').plan = Object.assign({}, saved, { generated_at: new Date(Date.now() + 1000).toISOString() });
  r = await call('GET', '/api/onboarding/progress', A);
  check('6e.8 a new plan never inherits ticks from an older one', r.body.completed === 0);
  sess('obA').plan = saved;
  r = await call('GET', '/api/onboarding/progress', A);
  check('6e.9 the ticks for this plan are still there', r.body.completed === 1);
  const pp = AI.calls.length;
  for (let i = 0; i < 3; i++) await call('GET', '/api/onboarding/progress', A);
  check('6e.10 opening Progress never calls the AI or charges credits', AI.calls.length === pp && prof('obA').credits_balance === 0 && H.rpcCalls.length === rpc0);
  user('obNoOb', { subscription_status: 'paid', access_expires_at: FUTURE });
  r = await call('GET', '/api/onboarding/progress', 'tok_obNoOb');
  check('6e.11 a paying account without onboarding: no steps, status "none", no session created', r.status === 200 && r.body.status === 'none' && r.body.onboarding === false && r.body.total === 0 && !sess('obNoOb'));

  prof('obA').access_expires_at = new Date(Date.now() - 1000).toISOString();
  r = await call('GET', '/api/onboarding/plan', A);
  check('6.14 when access later ends the plan is locked again (checked on every request)', r.body.locked === true && !r.body.plan);
  prof('obA').access_expires_at = FUTURE;
  check('6.15 no credits were charged anywhere in the flow', H.rpcCalls.length === rpc0 && ['obA', 'obF', 'obW', 'obS'].every((id) => prof(id).credits_balance === 0));

  // ── 6c. Existing data is never overwritten ───────────────────
  log('\n6c. Existing customer data');
  const X = user('obX', { preferences: { theme: 'dark', accent: 'blue' } });
  H.rows('business_profile').push({ user_id: 'obX', company_name: 'Existing Co BV', website: 'https://existing.example', industry: null, description: '' });
  await call('PUT', '/api/onboarding/session', X, { answers: ANSWERS, assistant: 'flux' });
  check('6c.1 choosing an assistant keeps the other preferences', JSON.stringify(prof('obX').preferences) === JSON.stringify({ theme: 'dark', accent: 'blue', assistant: 'flux' }), prof('obX').preferences);
  pay('obX', 'quarterly');
  await call('GET', '/api/onboarding/plan', X);
  for (let i = 0; i < 300 && sess('obX').plan_status !== 'ready'; i++) await sleep(50);
  const bpx = H.rows('business_profile').filter((x) => x.user_id === 'obX');
  check('6c.2 business profile: entered values kept (name, website); only empty fields filled (industry, description)', bpx.length === 1 && bpx[0].company_name === 'Existing Co BV' && bpx[0].website === 'https://existing.example' && bpx[0].industry === 'Retail & e-commerce' && bpx[0].description === ANSWERS.business.offer, bpx);
  check('6c.3 the profile keeps its plan, credits and other fields', prof('obX').subscription_status === 'paid' && prof('obX').credits_balance === 0 && prof('obX').preferences.theme === 'dark' && prof('obX').onboarding_completed === true);

  // ── 6d. Oriven Chat uses the chosen assistant ─────────────────
  log('\n6d. Oriven Chat persona');
  const chatSys = async (tok, body) => {
    const n = AI.calls.length;
    const res = await call('POST', '/api/ai/chat', tok, Object.assign({ message: 'What should I do this week?' }, body || {}), { 'X-Idempotency-Key': 'k-' + Math.random().toString(36).slice(2) });
    const c = AI.calls.slice(n).find((x) => x.kind === 'other');
    return { status: res.status, system: c ? c.system : '' };
  };
  user('obChatP', { subscription_status: 'paid', access_expires_at: FUTURE, credits_balance: 1000, preferences: { assistant: 'momentum' } });
  user('obChatN', { subscription_status: 'paid', access_expires_at: FUTURE, credits_balance: 1000, preferences: { theme: 'dark' } });
  const cp = await chatSys('tok_obChatP');
  check('6d.1 a chosen assistant: Oriven Chat answers in that persona', cp.status === 200 && /YOUR PERSONA: The user chose Momentum \(Growth & Execution\)/.test(cp.system) && /Practical, motivating and to the point\./.test(cp.system), { status: cp.status, tail: cp.system.slice(-300) });
  const cn = await chatSys('tok_obChatN', { assistant: 'nova', persona: 'nova' });
  check('6d.2 no chosen assistant (every existing account): no persona added, and none can be injected from the request', cn.status === 200 && !/YOUR PERSONA/.test(cn.system) && !/Nova/.test(cn.system), { status: cn.status });
  check('6d.3 chat is still charged as before (onboarding changed nothing about it)', prof('obChatP').credits_balance < 1000 && prof('obChatN').credits_balance < 1000);

  // ── 6b. Abuse safeguards ──────────────────────────────────────
  log('\n6b. Abuse safeguards');
  const calls6b = AI.calls.length;
  user('obOld2', { created_at: '2026-01-01T00:00:00Z' });
  r = await call('PUT', '/api/onboarding/session', 'tok_obOld2', { answers: ANSWERS, assistant: 'vector' });
  const rP = await call('POST', '/api/onboarding/plan', 'tok_obOld2', {});
  const rW = await call('POST', '/api/onboarding/website', 'tok_obOld2', { url: 'bloomandwick.example' });
  check('6b.1 an account from before the rollout can’t save answers or read a website (403) or start a plan (402 without access), no AI call', r.status === 403 && rP.status === 402 && rW.status === 403 && AI.calls.length === calls6b && !sess('obOld2'));
  pay('obOld2', 'monthly');
  r = await call('POST', '/api/onboarding/plan', 'tok_obOld2', {});
  check('6b.1b an existing paying customer without onboarding answers: no session created, no AI call (404 NO_ONBOARDING)', r.status === 404 && r.body.code === 'NO_ONBOARDING' && !sess('obOld2') && AI.calls.length === calls6b, r.body);
  r = await call('POST', '/api/onboarding/plan', A, {});
  check('6b.2 once a plan exists, asking again starts nothing (200, ready, no call)', r.status === 200 && r.body.status === 'ready' && AI.calls.length === calls6b && (await call('GET', '/api/onboarding/plan', A)).status === 200);
  const C = user('obCap');
  await call('PUT', '/api/onboarding/session', C, { answers: ANSWERS, assistant: 'scout' });
  sess('obCap').plan_status = 'failed'; // not "none": reading the plan must not start it here
  pay('obCap', 'monthly');
  process.env.ONBOARDING_AI_DAILY_CALLS = String(flow._dailyForTests().calls); // the daily budget is used up
  const f0 = FETCH.calls.length;
  r = await call('POST', '/api/onboarding/plan', C, {});
  const rw = await call('POST', '/api/onboarding/website', C, { url: 'other-site.example' });
  check('6b.3 daily onboarding AI budget reached → 503 BUSY, no AI call, no fetch', r.status === 503 && r.body.code === 'BUSY' && rw.status === 503 && AI.calls.length === calls6b && FETCH.calls.length === f0, { r: r.body, rw: rw.body });
  check('6b.4 …and no attempt or reading was used up', sess('obCap').plan_attempts === 0 && sess('obCap').plan_status === 'failed' && sess('obCap').website_attempts === 0);
  delete process.env.ONBOARDING_AI_DAILY_CALLS;
  await call('POST', '/api/onboarding/plan', C, {});
  for (let i = 0; i < 300 && sess('obCap').plan_status === 'generating'; i++) await sleep(50);
  check('6b.5 with budget again the same account generates normally', sess('obCap').plan_status === 'ready' && sess('obCap').plan_attempts === 1);

  // ── 7. Missing migration ──────────────────────────────────────
  log('\n7. Migration not applied');
  flow._resetForTests();
  H.MISSING.onboarding_sessions = 'table';
  const M = user('obM');
  r = await call('GET', '/api/onboarding/state', M);
  check('7.1 state still answers; flow disabled → app falls back to the welcome tour', r.status === 200 && r.body.flow.enabled === false && r.body.eligible === true);
  r = await call('GET', '/api/onboarding/session', M);
  check('7.2 flow routes answer 503 FLOW_UNAVAILABLE', r.status === 503 && r.body.code === 'FLOW_UNAVAILABLE');
  delete H.MISSING.onboarding_sessions;

  check('Z. no unexpected outbound network calls', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { console.error(e); process.exit(1); });
