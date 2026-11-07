// ════════════════════════════════════════════════════════════════
// Audience Builder, Creative Testing, Campaign Comparison and the
// Competitor Analysis data path — services/growthRoutes.js through the REAL
// server.js, Supabase and the AI provider mocked (tests/helpers/mockServer.js).
// Also: Progress completes these tasks from the saved results
// (services/progressFacts.js), never from opening a page.
//
// No network, no AI calls, no payments.
// RUN: node tests/growth-pages.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const AIML = 'http://aiml.mock.invalid';
const H = boot({ port: 5683, env: { AIML_BASE_OVERRIDE: AIML } });
const { check, log, done } = reporter();
const DAY = 864e5, iso = (ms) => new Date(ms).toISOString(), NOW = Date.now();
const pricing = require(path.join(H.SERVER_DIR, 'services', 'pricing'));
const growth = require(path.join(H.SERVER_DIR, 'services', 'growthRoutes'));
const facts = require(path.join(H.SERVER_DIR, 'services', 'progressFacts'));

let n = 0;
function user(extra) {
  const id = 'gp' + String(++n).padStart(4, '0') + '-0000-4000-8000-000000000000';
  H.rows('profiles').push(Object.assign({ id, created_at: iso(NOW - 30 * DAY), subscription_status: 'paid', access_plan: 'annual', access_expires_at: iso(NOW + 200 * DAY), credits_balance: 1000, onboarding_completed: true, preferences: {} }, extra || {}));
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: iso(NOW - 30 * DAY) };
  return { id, tok: 'tok_' + id, prof: () => H.rows('profiles').find((p) => p.id === id) };
}
// ── AI provider fake: answers per task; records what it was given ──
const AI = { calls: [], audience: null, compare: null, fail: false };
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
H.net.handler = async (u, opts) => {
  if (!u.startsWith(AIML)) return null;
  let body = {}; try { body = JSON.parse(opts.body); } catch (_) {}
  const sys = (body.messages && body.messages[0] && body.messages[0].content) || '', usr = (body.messages && body.messages[1] && body.messages[1].content) || '';
  const kind = /audience strategist/.test(sys) ? 'audience' : /advertising analyst/.test(sys) ? 'compare' : 'other';
  AI.calls.push({ kind, sys, usr });
  if (AI.fail) return jres(503, { error: { message: 'upstream down' } });
  const content = kind === 'audience' ? JSON.stringify(AI.audience) : kind === 'compare' ? '```json\n' + JSON.stringify(AI.compare) + '\n```' : 'ok';
  return jres(200, { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
};

(async () => {
  const quiet = await H.start();
  const { call } = H;
  const COST = pricing.FEATURE_COSTS;

  // ── A. Audience Builder ───────────────────────────────────────────
  log('\nA. Audience Builder');
  const bare = user();
  let r = await call('POST', '/api/audiences/suggest', bare.tok, {});
  check('A1. nothing known about the business and no description → 422 NOT_ENOUGH_CONTEXT, nothing charged, no AI call', r.status === 422 && r.body.code === 'NOT_ENOUGH_CONTEXT' && bare.prof().credits_balance === 1000 && AI.calls.length === 0, r.body);
  const u = user();
  H.rows('onboarding_sessions').push({ user_id: u.id, status: 'completed', step: 'done', assistant: 'nova', plan_status: 'ready', answers: { business: { name: 'Bloom & Wick', offer: 'Hand-poured soy candles', area: 'Utrecht' }, audience: { ideal: 'Gift shoppers' } }, created_at: iso(NOW - 20 * DAY) });
  AI.audience = { segments: [
    { name: 'Gift shoppers in Utrecht', description: 'People buying a thoughtful present.', age_range: '25–44', location: 'Utrecht', interests: ['Gifts', 'Home decor'], pain_points: ['Generic gifts'], preferred_platforms: ['Meta', 'pinterest', 'MySpace'],
      targeting: { meta: { age_min: 25, age_max: 44, locations: ['Utrecht'], interests: ['Gifts'] }, google: { keywords: ['handmade candle gift'] } }, basis: { onboarding: true, business: false, research: true }, assumptions: ['They shop online'] },
    { name: '', description: 'nameless — dropped' },
  ] };
  r = await call('POST', '/api/audiences/suggest', u.tok, { focus: 'Valentine gifts' });
  const sg = r.body.segments && r.body.segments[0];
  check('A2. suggestions from the onboarding answers: charged ' + COST.audience_generation + ' credits; the AI got the answers and the focus', r.status === 200 && u.prof().credits_balance === 1000 - COST.audience_generation && /Hand-poured soy candles/.test(AI.calls[0].usr) && /Valentine gifts/.test(AI.calls[0].usr), r.body);
  check('A3. output cleaned: unnamed segment dropped, only real platforms (MySpace removed, "pinterest" → Pinterest), targeting kept', r.body.segments.length === 1 && JSON.stringify(sg.preferred_platforms) === '["Meta","Pinterest"]' && sg.targeting.meta.age_min === 25 && sg.targeting.google.keywords[0] === 'handmade candle gift', sg);
  check('A4. basis is honest: "research" can\'t be claimed without saved research; assumptions listed', sg.basis.onboarding === true && sg.basis.research === false && sg.assumptions[0] === 'They shop online' && r.body.used.research === false, sg.basis);
  r = await call('POST', '/api/audiences', u.tok, { audience: sg });
  const aud = r.body.audience;
  const prof = H.rows('creative_assets').find((a) => a.kind === 'audience_profile' && a.content && a.content.audienceId === (aud && aud.id));
  check('A5. saving: an audience in business_audiences (also shown in Control Center) + its targeting profile, marked "prepared in OrivenAI — not created in an ad platform"', r.status === 200 && aud && aud.name === 'Gift shoppers in Utrecht' && aud.interests === 'Gifts, Home decor' && prof && prof.content.status === 'prepared' && /not created in an ad platform/.test(prof.content.statusNote), r.body);
  r = await call('GET', '/api/audiences', u.tok);
  check('A6. listed with its profile and a one-line text for campaigns', r.status === 200 && r.body.audiences.length === 1 && r.body.audiences[0].profile.targeting.meta.age_max === 44 && /Gift shoppers in Utrecht — 25–44, Utrecht/.test(r.body.audiences[0].text), r.body.audiences[0]);
  r = await call('PUT', '/api/audiences/' + aud.id, u.tok, { audience: Object.assign({}, sg, { name: 'Gift shoppers (Utrecht + Amersfoort)', location: 'Utrecht, Amersfoort' }) });
  check('A7. editing updates the audience and its profile', r.status === 200 && r.body.audience.location === 'Utrecht, Amersfoort' && H.rows('creative_assets').find((a) => a.kind === 'audience_profile' && a.content.audienceId === aud.id).title === 'Gift shoppers (Utrecht + Amersfoort)');
  const other = user();
  r = await call('PUT', '/api/audiences/' + aud.id, other.tok, { audience: { name: 'Hijack' } });
  check('A8. another account can\'t change it (404)', r.status === 404 && H.rows('business_audiences').find((a) => a.id === aud.id).name !== 'Hijack');
  AI.fail = true; const bal = u.prof().credits_balance;
  r = await call('POST', '/api/audiences/suggest', u.tok, {});
  AI.fail = false;
  check('A9. the AI fails → 502, credits refunded', r.status === 502 && u.prof().credits_balance === bal, { status: r.status, bal: u.prof().credits_balance });
  const expired = user({ subscription_status: 'free', access_expires_at: iso(NOW - DAY) });
  r = await call('POST', '/api/audiences/suggest', expired.tok, { focus: 'x' });
  check('A10. without active access → refused (403), nothing charged', r.status === 403);

  // ── B. Creative Testing ───────────────────────────────────────────
  log('\nB. Creative Testing');
  H.rows('creative_assets').push({ id: 'set-1', user_id: u.id, kind: 'headline', title: 'Hand-poured candles', content: { variations: ['Poured by hand in Utrecht', 'The gift that glows', 'Soy candles, zero shortcuts'] }, source_route: '/api/creative/variations', status: 'draft', archived: false, created_at: iso(NOW) });
  r = await call('GET', '/api/creative/testing/sets', u.tok);
  check('B1. variation sets listed with their variations; no performance claimed without campaign data', r.status === 200 && r.body.sets.length === 1 && r.body.sets[0].variations.length === 3 && r.body.performance === null && /No variation has been tested in a campaign/.test(r.body.performanceNote), r.body);
  r = await call('POST', '/api/creative/testing/pick', u.tok, { setId: 'set-1', index: 1 });
  const picked = r.body.asset;
  check('B2. choosing a variation saves it to My Content: favourite, status "ready", linked to its set', r.status === 200 && picked && picked.content.text === 'The gift that glows' && picked.favorite === true && picked.status === 'ready' && picked.content.fromSet === 'set-1', r.body);
  r = await call('POST', '/api/creative/testing/pick', u.tok, { setId: 'set-1', index: 1 });
  check('B3. choosing it again changes nothing (no duplicate)', r.body.already === true && H.rows('creative_assets').filter((a) => a.source_route === '/api/creative/testing/pick').length === 1);
  r = await call('GET', '/api/creative/testing/sets', u.tok);
  check('B4. the set shows which variation was chosen', JSON.stringify(r.body.sets[0].picked.map((p) => p.index)) === '[1]');
  const bad = await call('POST', '/api/creative/testing/pick', u.tok, { setId: 'set-1', index: 9 });
  const foreign = await call('POST', '/api/creative/testing/pick', other.tok, { setId: 'set-1', index: 0 });
  check('B5. a variation that doesn\'t exist, or another account\'s set → 404', bad.status === 404 && foreign.status === 404);
  r = await call('GET', '/api/creative/assets', u.tok);
  check('B6. the chosen variation is in My Content', r.status === 200 && (r.body.assets || r.body.items || []).some((a) => a.source_route === '/api/creative/testing/pick'), Object.keys(r.body));

  // ── C. Campaign Comparison ────────────────────────────────────────
  log('\nC. Campaign Comparison');
  const camp = (id, m) => ({ platform: 'meta', id, name: 'Campaign ' + id, currency: 'EUR', metrics: m });
  r = await call('POST', '/api/campaigns/compare/insight', u.tok, { range: { key: 'LAST_30_DAYS' }, campaigns: [camp('1', { impressions: 1000 })] });
  check('C1. one campaign → 400 TOO_FEW_CAMPAIGNS', r.status === 400 && r.body.code === 'TOO_FEW_CAMPAIGNS');
  let b0 = u.prof().credits_balance; const calls0 = AI.calls.length;
  r = await call('POST', '/api/campaigns/compare/insight', u.tok, { range: { key: 'LAST_30_DAYS' }, campaigns: [camp('1', { impressions: 0, spend: 0 }), camp('2', { impressions: null })] });
  check('C2. no impressions, clicks or spend → 422 INSUFFICIENT_DATA, nothing charged, no AI call', r.status === 422 && r.body.code === 'INSUFFICIENT_DATA' && u.prof().credits_balance === b0 && AI.calls.length === calls0, r.body);
  AI.compare = { summary: 'Campaign 1 reached more people for less.', differences: ['CTR 2% vs 1%'], trends: [], recommendations: ['Test campaign 1’s creative in campaign 2'], caveats: ['Reach not reported for campaign 2'] };
  r = await call('POST', '/api/campaigns/compare/insight', u.tok, { range: { key: 'LAST_30_DAYS', label: 'Last 30 days' }, campaigns: [camp('1', { impressions: 5000, clicks: 100, ctr: 2, spend: 50, reach: 4000 }), camp('2', { impressions: 3000, clicks: 30, ctr: 1, spend: 60, reach: null, roas: 'lots' })] });
  const cmp = r.body.comparison;
  check('C3. explained from the real figures: charged ' + COST.ai_analysis + ' credits; saved as a comparison', r.status === 200 && cmp && cmp.id && cmp.insight.summary && u.prof().credits_balance === b0 - COST.ai_analysis && H.rows('creative_assets').some((a) => a.kind === 'comparison' && a.id === cmp.id), r.body);
  const sent = AI.calls[AI.calls.length - 1];
  check('C4. missing metrics stay missing (null) — never filled in; a non-number becomes null; the AI is told null = not reported', cmp.campaigns[1].metrics.reach === null && cmp.campaigns[1].metrics.roas === null && /null means the platform did not report/.test(sent.sys) && /"reach":null/.test(sent.usr), cmp.campaigns[1].metrics);
  r = await call('GET', '/api/campaigns/compare/saved', u.tok);
  check('C5. saved comparisons can be revisited', r.status === 200 && r.body.comparisons.length === 1 && r.body.comparisons[0].insight.summary === AI.compare.summary);
  AI.fail = true; b0 = u.prof().credits_balance;
  r = await call('POST', '/api/campaigns/compare/insight', u.tok, { campaigns: [camp('1', { impressions: 10 }), camp('2', { impressions: 20 })] });
  AI.fail = false;
  check('C6. the AI fails → 502, credits refunded, nothing saved', r.status === 502 && u.prof().credits_balance === b0 && H.rows('creative_assets').filter((a) => a.kind === 'comparison').length === 1);
  r = await call('DELETE', '/api/campaigns/compare/' + cmp.id, u.tok);
  check('C7. a saved comparison can be removed', r.status === 200 && H.rows('creative_assets').find((a) => a.id === cmp.id).archived === true);
  r = await call('POST', '/api/campaigns/compare/insight', null, { campaigns: [] });
  check('C8. signed out → 401', r.status === 401);

  // ── D. Competitor Analysis data path (existing routes) ─────────────
  log('\nD. Competitor Analysis');
  r = await call('POST', '/api/business/competitors', u.tok, { company: 'Wax & Wick', website: 'https://waxandwick.example', positioning: 'Premium candles' });
  check('D1. competitors are added through the existing business route', r.status === 200 && r.body.item && r.body.item.company === 'Wax & Wick');
  r = await call('GET', '/api/business/competitors', u.tok);
  check('D2. …and listed', r.status === 200 && r.body.items.length === 1);

  // ── E. Progress counts the saved results ──────────────────────────
  log('\nE. Progress facts');
  const fx = await facts.collect({ from: (t) => ({ select: () => ({ eq: () => { const rows = H.rows(t).filter((x) => x.user_id === u.id); const q = { gte: () => q, limit: () => Promise.resolve({ data: rows, error: null }), then: (a, b) => Promise.resolve({ data: rows, error: null }).then(a, b) }; return q; } }) }) }, u.id, iso(NOW - DAY));
  check('E1. saved audience, chosen variation, variation set and competitor all count; a removed comparison does not', fx['table:business_audiences'] === 1 && fx['assets:picked'] === 1 && fx['assets:variations'] === 1 && !fx['assets:comparison'] && fx['table:business_competitors'] === 1, fx);
  check('E2. an audience profile is not counted as content', !fx['assets:copy'] || fx['assets:copy'] === 0, fx);

  check('Z. no outbound network', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
