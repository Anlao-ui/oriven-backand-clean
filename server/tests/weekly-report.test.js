// ════════════════════════════════════════════════════════════════
// Weekly AI Performance Report — periods, aggregation, AI validation,
// email rendering, the job (eligibility, idempotency, retries, opt-out,
// AI cost controls) and its protected scheduler endpoint.
// Supabase, Resend, the AI provider and every ad platform are mocked;
// nothing leaves the process, no email is delivered, no AI credit is spent.
// RUN: node tests/weekly-report.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const SECRET = 'wr-secret-0123456789-0123456789-abcdef';
const H = boot({ port: 5610, env: {
  EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', PUBLIC_API_URL: 'http://127.0.0.1:5610', FRONTEND_URL: 'https://orivenai.com',
  WEEKLY_REPORTS_ENABLED: 'true', WEEKLY_REPORTS_SECRET: SECRET, ENABLE_BACKGROUND_JOBS: 'true',
} });
const { check, log, done } = reporter();

(async () => {
  await H.start();
  const S = H.SERVER_DIR + '/services/weeklyReport/';
  const period = require(S + 'period.js');
  const metrics = require(S + 'metrics.js');
  const insights = require(S + 'insights.js');
  const collectMod = require(S + 'collect.js');
  const runnerMod = require(S + 'runner.js');
  const T = require(H.SERVER_DIR + '/services/email/templates.js');
  const ENT = require(H.SERVER_DIR + '/services/planEntitlements.js');
  const db = require('@supabase/supabase-js').createClient();
  const uid = (n) => '00000000-0000-4000-8000-0000000001' + String(n).padStart(2, '0');

  // ── A. Plans ─────────────────────────────────────────────────────
  log('\nA. Plan entitlements');
  check('weeklyReport: Professional only', ['free', 'starter', 'creator'].every((p) => !ENT.hasEntitlement(p, 'weeklyReport')) && ENT.hasEntitlement('professional', 'weeklyReport'));
  check('notifications (in-app center): Creator and Professional', !ENT.hasEntitlement('free', 'notifications') && !ENT.hasEntitlement('starter', 'notifications') && ENT.hasEntitlement('creator', 'notifications') && ENT.hasEntitlement('professional', 'notifications'));
  check('prioritySupport: Professional only; orivenChat: Creator and Professional', ENT.minPlanFor('prioritySupport') === 'professional' && ENT.minPlanFor('orivenChat') === 'creator');
  check('Automations (and their emails) unchanged: from Starter', ENT.minPlanFor('autopilot') === 'starter');

  // ── B. Reporting periods ─────────────────────────────────────────
  log('\nB. Reporting periods and timezones');
  // Monday 2026-10-19 08:00 UTC = 10:00 Amsterdam (CEST, UTC+2).
  const mon = Date.parse('2026-10-19T08:00:00Z');
  const w = period.lastCompletedWeek(mon, 'Europe/Amsterdam');
  check('previous completed Monday–Sunday week', w.start === '2026-10-12' && w.end === '2026-10-18', w);
  check('previous week for comparison', w.previous.start === '2026-10-05' && w.previous.end === '2026-10-11', w.previous);
  check('due Monday 10:00 Amsterdam', period.isDue(mon, 'Europe/Amsterdam'));
  check('NOT due Monday 06:00 Amsterdam (before 07:00)', !period.isDue(Date.parse('2026-10-19T04:00:00Z'), 'Europe/Amsterdam'));
  check('still due Wednesday; not due Thursday or Sunday', period.isDue(Date.parse('2026-10-21T12:00:00Z'), 'Europe/Amsterdam') && !period.isDue(Date.parse('2026-10-22T12:00:00Z'), 'Europe/Amsterdam') && !period.isDue(Date.parse('2026-10-18T12:00:00Z'), 'Europe/Amsterdam'));
  // Same instant: still Sunday evening in Los Angeles.
  const la = period.lastCompletedWeek(Date.parse('2026-10-19T03:00:00Z'), 'America/Los_Angeles');
  check('timezone-aware: Sunday night in Los Angeles → the week before', la.start === '2026-10-05' && la.end === '2026-10-11', la);
  check('Tokyo Monday morning → that just-finished week', period.lastCompletedWeek(Date.parse('2026-10-18T23:00:00Z'), 'Asia/Tokyo').start === '2026-10-12');
  const bad = period.lastCompletedWeek(mon, 'Not/AZone');
  check('invalid timezone → documented default (Europe/Amsterdam), flagged', bad.timeZone === 'Europe/Amsterdam' && bad.defaultTimeZone === true && bad.start === '2026-10-12');
  check('DST end week (Oct 25 2026) keeps 7 calendar days', (() => { const x = period.lastCompletedWeek(Date.parse('2026-11-02T09:00:00Z'), 'Europe/Amsterdam'); return x.start === '2026-10-26' && x.end === '2026-11-01'; })());

  // ── C. Aggregation ───────────────────────────────────────────────
  log('\nC. Metric aggregation');
  const metaRes = { platform: 'meta', status: 'ok', account: { name: 'Shop NL', currency: 'EUR' }, metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue', 'reach'],
    current: { campaigns: [
      { id: '1', name: 'Autumn Sale', spend: 120.5, impressions: 20000, clicks: 400, conversions: 12, conversionValue: 600 },
      { id: '2', name: 'Brand Video', spend: 30, impressions: 5000, clicks: 0, conversions: 0, conversionValue: 0 },
    ], reach: 15000 },
    previous: { campaigns: [{ id: '1', name: 'Autumn Sale', spend: 100, impressions: 16000, clicks: 320, conversions: 10, conversionValue: 500 }], reach: 12000 } };
  const gRes = { platform: 'google', status: 'ok', account: { name: 'Shop US', currency: 'USD' }, metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversionValue'],
    current: { campaigns: [{ id: '9', name: 'Search Brand', spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 }, { id: '8', name: 'Search Generic', spend: 50, impressions: 4000, clicks: 80, conversions: 0, conversionValue: 0 }] }, previous: null };
  const tRes = { platform: 'tiktok', status: 'ok', account: { name: 'TT', currency: null }, metrics: ['spend', 'impressions', 'clicks', 'conversions'], current: { campaigns: [{ id: '5', name: 'TT One', spend: 10, impressions: 3000, clicks: 30, conversions: 0 }], reach: null }, previous: null };
  const rep = metrics.buildReport([gRes, metaRes, tRes, { platform: 'pinterest', status: 'not_connected' }], w, { businessName: 'Acme <b>BV</b>' });
  const pm = rep.platforms.find((p) => p.platform === 'meta'), pg = rep.platforms.find((p) => p.platform === 'google'), pt = rep.platforms.find((p) => p.platform === 'tiktok');
  check('Meta totals summed per campaign', pm.totals.spend === 150.5 && pm.totals.impressions === 25000 && pm.totals.clicks === 400 && pm.totals.conversions === 12, pm.totals);
  check('derived CTR / CPC / ROAS', pm.totals.ctr === 1.6 && pm.totals.cpc === 0.38 && pm.totals.roas === 3.99, pm.totals);
  check('reach = the platform’s deduplicated account reach, not a campaign sum', pm.totals.reach === 15000);
  check('reach unavailable where not reported (Google) → null, not 0', pg.totals.reach === null);
  check('ROAS only with a reported conversion value (> 0)', pg.totals.roas === null && pt.totals.roas === null);
  check('a reported zero stays 0 (Google conversions)', pg.totals.conversions === 0);
  check('week-over-week change only with a retrieved previous week', pm.changes.spend === 50.5 && pm.comparison === 'available' && pg.comparison === 'unavailable' && Object.keys(pg.changes).length === 0, pm.changes);
  check('unverified currency → no money at all (TikTok spend null, flagged)', pt.totals.spend === null && pt.totals.cpc === null && pt.currencyMissing === true && pt.totals.clicks === 30);
  check('spend never summed across currencies', JSON.stringify(rep.overview.spendByCurrency) === JSON.stringify([{ currency: 'EUR', amount: 150.5 }, { currency: 'USD', amount: 50 }]), rep.overview);
  check('campaigns with delivery counted (zero-delivery campaign excluded)', pg.totals.campaignsWithDelivery === 1 && pm.totals.campaignsWithDelivery === 2);
  check('needs attention: spend without clicks', pm.attention.length === 1 && pm.attention[0].name === 'Brand Video' && pm.attention[0].reason === 'spend_no_clicks');
  check('performing well ranked by conversions when reported', pm.top[0].name === 'Autumn Sale' && pm.rankedBy === 'conversions');
  check('not connected platform kept as status, no numbers', rep.platforms.find((p) => p.platform === 'pinterest').totals === undefined);
  check('report has data; not-connected ≠ failed', rep.hasData && rep.connected === 3 && rep.failed.length === 0);
  check('Meta conversions de-duplicated across alias action types', collectMod.metaConversions([{ action_type: 'purchase', value: '5' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' }, { action_type: 'lead', value: '2' }]) === 7);
  const empty = metrics.buildReport([{ platform: 'google', status: 'not_connected' }, { platform: 'meta', status: 'failed' }], w, {});
  check('no connected platform → no data; retrieval failure reported separately', !empty.hasData && empty.connected === 0 && empty.failed[0] === 'meta');

  // ── D. AI insights ───────────────────────────────────────────────
  log('\nD. AI insights: validation, fallback, cost');
  const good = { summary: 'Meta spend rose 50.5% to 150.5 with 12 conversions.', wentWell: ['"Autumn Sale" drove 12 conversions at a CTR of 2%.'], needsAttention: ['"Brand Video" spent 30 without clicks.'], opportunities: [], actions: ['Review the creative of "Brand Video" before adding budget.'] };
  let calls = 0;
  const ai = (out) => async () => { calls++; return typeof out === 'string' ? out : JSON.stringify(out); };
  let g = await insights.generate({ report: rep, lang: 'en', aiCall: ai(good) });
  check('valid insights accepted', g.status === 'ok' && g.insights.summary.includes('150.5'), g);
  g = await insights.generate({ report: rep, lang: 'en', aiCall: ai(Object.assign({}, good, { summary: 'Spend rose to 999 this week.' })) });
  check('an invented number → rejected', g.status === 'invalid' && g.reason === 'unknown_number', g);
  g = await insights.generate({ report: rep, lang: 'en', aiCall: ai(Object.assign({}, good, { wentWell: ['"Winter Promo" did well.'] })) });
  check('an invented campaign name → rejected', g.status === 'invalid' && g.reason === 'unknown_campaign', g);
  g = await insights.generate({ report: rep, lang: 'en', aiCall: ai(Object.assign({}, good, { actions: ['Raising the budget is guaranteed to improve results.'] })) });
  check('a guaranteed outcome → rejected', g.status === 'invalid' && g.reason === 'guarantee');
  const noConvRep = metrics.buildReport([gRes], w, {});
  g = await insights.generate({ report: noConvRep, lang: 'en', aiCall: ai({ summary: 'Conversions were steady.', wentWell: [], needsAttention: [], opportunities: [], actions: [] }) });
  check('conversion claims without conversion data → rejected', g.status === 'invalid' && g.reason === 'conversions_without_data', g);
  g = await insights.generate({ report: noConvRep, lang: 'en', aiCall: ai({ summary: 'ROAS looks fine.', wentWell: [], needsAttention: [], opportunities: [], actions: [] }) });
  check('ROAS claims without ROAS data → rejected', g.status === 'invalid');
  g = await insights.generate({ report: rep, lang: 'en', aiCall: async () => { throw new Error('provider down'); } });
  check('provider error → failed (no insights, no throw)', g.status === 'failed' && g.insights === null);
  g = await insights.generate({ report: rep, lang: 'en', aiCall: () => new Promise(() => {}), timeoutMs: 50 });
  check('provider timeout → failed', g.status === 'failed' && g.reason === 'timeout');
  g = await insights.generate({ report: rep, lang: 'en', aiCall: ai('not json at all') });
  check('unparseable answer → failed', g.status === 'failed');
  calls = 0;
  g = await insights.generate({ report: empty, lang: 'en', aiCall: ai(good) });
  check('no data → no AI call at all', g.status === 'not_needed' && calls === 0);
  const pr = insights.prompt(rep, 'nl');
  check('prompt: Dutch requested, metrics only, no tokens/emails', /Write in Dutch/.test(pr.system) && !/token|@/.test(pr.user) && pr.user.includes('Autumn Sale'));
  check('max_tokens is small (cost cap)', insights.MAX_TOKENS <= 800);

  // ── E. Email rendering ───────────────────────────────────────────
  log('\nE. Email rendering');
  const ctx = { appUrl: 'https://orivenai.com/app' };
  const em = T.render('weekly_report', { report: rep, insights: good, lang: 'en', campaignsUrl: 'https://orivenai.com/app?page=performance', offUrl: 'https://api/off?u=x&t=y' }, ctx);
  check('subject', em.subject === 'Your Weekly OrivenAI Performance Report');
  check('service email with HTML and plain-text versions', em.category === 'service' && /<html lang="en"/.test(em.html) && em.text.length > 200);
  check('reporting period shown', /12 October/.test(em.html) && /18 October 2026/.test(em.html));
  check('money in each account’s own currency, never converted', em.html.includes('€150.50') && em.html.includes('US$50.00'), em.text.slice(0, 600));
  check('unavailable metric reads "Not reported", never 0', /Reach: Not reported/.test(em.text) === false ? /Spend: Not reported/.test(em.text) : true);
  check('TikTok without verified currency: spend "Not reported" + explanation', /TikTok Ads[\s\S]*Spend: Not reported/.test(em.text) && em.text.includes('currency couldn’t be verified'));
  check('change vs previous week shown where available', em.text.includes('+50.5%'));
  check('no comparison note where unavailable', em.text.includes('No comparison with the previous week available.'));
  check('not-connected platform labelled', /Pinterest Ads: Not connected/.test(em.text));
  check('AI insights section + disclaimer', em.html.includes('AI insights') && em.text.includes('Written by AI from the figures in this email only'));
  check('business name escaped', em.html.includes('Acme &lt;b&gt;BV&lt;/b&gt;') && !em.html.includes('<b>BV</b>'));
  check('CTA to Campaigns + off link + timezone line', em.html.includes('page=performance') && em.html.includes('Turn off weekly reports') && em.text.includes('Europe/Amsterdam'));
  check('no tokens or secrets in the email', !/access_token|refresh_token|Bearer/i.test(em.html + em.text));
  const noAi = T.render('weekly_report', { report: rep, insights: null, lang: 'en' }, ctx);
  check('AI unavailable → factual report with a clear note', noAi.html.includes('AI insights weren’t available this week') && noAi.html.includes('€150.50'));
  const nd = T.render('weekly_report', { report: empty, lang: 'en', connectUrl: 'https://orivenai.com/app?page=businessbrain&tab=connections' }, ctx);
  check('no data → labelled "No performance data available", no fabricated figures', nd.subject.includes('no performance data available') && nd.html.includes('No performance data available') && !/€|\$\d/.test(nd.html) && nd.html.includes('tab=connections'));
  for (const l of ['nl', 'de', 'fr', 'es', 'pt']) {
    const x = T.render('weekly_report', { report: rep, insights: good, lang: l }, ctx);
    check(`${l}: localized subject + html lang`, x.subject !== em.subject && x.html.includes(`<html lang="${l}"`) && x.text.length > 200);
  }
  check('unknown language → English', T.render('weekly_report', { report: rep, lang: 'xx' }, ctx).subject === em.subject);
  check('support reply email: no message content, link to the thread', (() => { const s = T.render('support_reply', { lang: 'de', url: 'https://orivenai.com/app?settings=subscription' }, ctx); return s.category === 'service' && /Antwort/.test(s.subject) && s.html.includes('settings=subscription'); })());

  // ── F. The job ───────────────────────────────────────────────────
  log('\nF. The job: eligibility, idempotency, retries, opt-out');
  const sends = [];
  let sendPlan = [];
  const fakeSender = {
    mode: () => 'live', scope: () => 'live', configured: () => true, testAllowlist: () => new Set(),
    isRetryable: (e) => /^(network|http_429|http_5\d\d)/.test(String(e || '')),
    send: async (m) => { const next = sendPlan.shift(); if (next) return next; if (sends.some((s) => s.idempotencyKey === m.idempotencyKey)) return { id: 'dup' }; sends.push(m); return { id: 'em_' + sends.length }; },
  };
  const lifecycle = require(H.SERVER_DIR + '/services/email/lifecycle.js');
  let collectCalls = 0, aiCalls = 0, collectFail = false;
  const collect = async (user) => { collectCalls++; if (collectFail) throw Object.assign(new Error('x'), { code: 'X' }); return [metaRes, gRes, { platform: 'tiktok', status: 'not_connected' }, { platform: 'pinterest', status: 'reconnect' }]; };
  const aiCall = async () => { aiCalls++; return JSON.stringify(good); };
  const R = runnerMod.createRunner({ db, sender: fakeSender, templates: T, lifecycle, collect, aiCall, appUrl: 'https://orivenai.com/app', apiUrl: 'https://api.test', log: () => {} });
  const prof = (n, plan, extra) => Object.assign({ id: uid(n), email: 'u' + n + '@example.invalid', subscription_status: plan, timezone: 'Europe/Amsterdam', preferences: { language: 'en' } }, extra || {});
  H.rows('profiles').push(prof(1, 'professional'), prof(2, 'creator'), prof(3, 'starter'), prof(4, 'free'), prof(5, 'professional', { preferences: { weeklyReportEmail: false } }), prof(6, 'professional', { timezone: 'Asia/Tokyo', preferences: { language: 'nl' } }));

  H.MISSING.weekly_reports = 'table';
  let s = await R.runOnce({ now: mon });
  check('table missing → disabled, nothing sent', s.disabled === 'table_missing' && sends.length === 0);
  delete H.MISSING.weekly_reports;
  const offR = runnerMod.createRunner({ db, sender: Object.assign({}, fakeSender, { mode: () => 'off' }), templates: T, lifecycle, collect, aiCall });
  check('EMAIL_MODE off → disabled', (await offR.runOnce({ now: mon })).disabled === 'mode_off');

  s = await R.runOnce({ now: Date.parse('2026-10-22T12:00:00Z') });
  check('not due on Thursday → nothing claimed', s.claimed === 0 && sends.length === 0);

  s = await R.runOnce({ now: mon });
  const to = sends.map((m) => m.to).sort();
  check('only Professional accounts that didn’t opt out receive it', JSON.stringify(to) === JSON.stringify(['u1@example.invalid', 'u6@example.invalid']), to);
  check('one AI call per user', aiCalls === 2, aiCalls);
  check('idempotency key per user and week', sends[0].idempotencyKey === `oriven:live:${uid(1)}:weekly_report:2026-10-12`);
  check('List-Unsubscribe header to the weekly-report off link', /weekly-report\/off/.test(sends[0].headers['List-Unsubscribe']));
  check('Dutch account gets the Dutch email', sends.find((m) => m.to === 'u6@example.invalid').subject === 'Je wekelijkse OrivenAI-prestatierapport');
  const wr = H.rows('weekly_reports');
  check('rows stored sent with validated report + insights', wr.length === 2 && wr.every((r) => r.status === 'sent' && r.report && r.insights && r.ai_status === 'ok'), wr.map((r) => r.status));
  check('email_sends ledger rows (service, weekly_report:<week>)', H.rows('email_sends').filter((r) => r.template === 'weekly_report' && r.status === 'sent' && r.dedupe_key === 'weekly_report:2026-10-12').length === 2);
  check('stored report holds no tokens or email addresses', !/access_token|@example/.test(JSON.stringify(wr.map((r) => r.report))));

  s = await R.runOnce({ now: mon + 3600e3 });
  check('second run the same week → no duplicate email, no new AI call', sends.length === 2 && aiCalls === 2 && s.claimed === 0);
  const [a1, a2] = await Promise.all([R.runOnce({ now: mon + 7200e3 }), R.runOnce({ now: mon + 7200e3 })]);
  check('two overlapping runs → still no duplicate', sends.length === 2 && a1.claimed + a2.claimed === 0);

  // Retry: a new Professional account whose first send fails temporarily.
  H.rows('profiles').push(prof(7, 'professional'));
  sendPlan = [{ error: 'http_503', retryable: true }];
  s = await R.runOnce({ now: mon });
  const r7 = () => H.rows('weekly_reports').find((r) => r.user_id === uid(7));
  check('temporary send failure → row "failed", nothing delivered', r7().status === 'failed' && sends.length === 2 && aiCalls === 3, r7());
  r7().updated_at = new Date(mon).toISOString();
  s = await R.runOnce({ now: mon + 60e3 });
  check('no retry before 10 minutes', r7().status === 'failed' && s.claimed === 0);
  s = await R.runOnce({ now: mon + 11 * 60e3 });
  check('retry after 10 minutes sends it, re-using the stored report (no second AI call)', r7().status === 'sent' && sends.length === 3 && aiCalls === 3 && r7().attempts === 2, { st: r7().status, ai: aiCalls });
  check('retry uses the same idempotency key', sends[2].idempotencyKey === `oriven:live:${uid(7)}:weekly_report:2026-10-12`);

  // Final failures stop after the attempt limit.
  H.rows('profiles').push(prof(8, 'professional'));
  sendPlan = [{ error: 'http_422', retryable: false }];
  await R.runOnce({ now: mon });
  check('non-retryable error → final ("error"), never retried', H.rows('weekly_reports').find((r) => r.user_id === uid(8)).status === 'error');

  // AI failure still sends the factual report.
  H.rows('profiles').push(prof(9, 'professional'));
  const R2 = runnerMod.createRunner({ db, sender: fakeSender, templates: T, lifecycle, collect, aiCall: async () => { throw new Error('down'); }, log: () => {} });
  await R2.runOnce({ now: mon });
  const m9 = sends.find((m) => m.to === 'u9@example.invalid');
  check('AI failure → report still sent, without insights', !!m9 && m9.html.includes('AI insights weren’t available') && H.rows('weekly_reports').find((r) => r.user_id === uid(9)).ai_status.startsWith('failed'));

  // AI budget per run.
  H.rows('profiles').push(prof(10, 'professional'));
  let budgetCalls = 0;
  const R3 = runnerMod.createRunner({ db, sender: fakeSender, templates: T, lifecycle, collect, aiCall: async () => { budgetCalls++; return JSON.stringify(good); }, log: () => {} });
  await R3.runOnce({ now: mon, aiBudget: 0 });
  check('AI budget 0 → no AI call, report sent without insights', budgetCalls === 0 && !!sends.find((m) => m.to === 'u10@example.invalid'));

  // Data collection failure.
  H.rows('profiles').push(prof(11, 'professional'));
  collectFail = true;
  await R.runOnce({ now: mon });
  const r11 = H.rows('weekly_reports').find((r) => r.user_id === uid(11));
  check('collection failure → "failed", no email', r11.status === 'failed' && !sends.find((m) => m.to === 'u11@example.invalid'));
  collectFail = false;

  // Suppressed address.
  H.rows('profiles').push(prof(12, 'professional'));
  await lifecycle.suppress('u12@example.invalid', 'hard_bounce');
  await R.runOnce({ now: mon });
  check('suppressed address → skipped', !sends.find((m) => m.to === 'u12@example.invalid'));

  // Downgraded between weeks.
  H.rows('profiles').find((p) => p.id === uid(1)).subscription_status = 'creator';
  const next = Date.parse('2026-10-26T08:00:00Z');
  const before = sends.length;
  await R.runOnce({ now: next });
  check('no longer Professional → no report next week', !sends.slice(before).some((m) => m.to === 'u1@example.invalid'));

  // Test mode: allowlisted only, separate scope.
  const tSends = [];
  const testSender = Object.assign({}, fakeSender, { mode: () => 'test', scope: () => 'test', testAllowlist: () => new Set(['u6@example.invalid']), send: async (m) => { tSends.push(m); return { id: 't' + tSends.length }; } });
  const RT = runnerMod.createRunner({ db, sender: testSender, templates: T, lifecycle, collect, aiCall, log: () => {} });
  await RT.runOnce({ now: mon });
  check('test mode: only allowlisted addresses, own scope (doesn’t block live)', tSends.length === 1 && tSends[0].to === 'u6@example.invalid' && H.rows('weekly_reports').some((r) => r.user_id === uid(6) && r.scope === 'test'));

  // ── G. Scheduler endpoint, cron, off link ────────────────────────
  log('\nG. Scheduler endpoint, cron and opt-out link');
  check('in-process job registered every 30 minutes', H.cronJobs.some((j) => j.expr === '*/30 * * * *'));
  check('no secret → 401', (await H.call('POST', '/api/internal/weekly-reports/run')).status === 401);
  check('wrong secret → 401', (await H.call('POST', '/api/internal/weekly-reports/run', null, null, { 'X-Weekly-Report-Secret': 'nope' })).status === 401);
  check('a user session is not enough → 401', (await H.call('POST', '/api/internal/weekly-reports/run', 'tok_any', {})).status === 401);
  const ok = await H.call('POST', '/api/internal/weekly-reports/run', null, null, { 'X-Weekly-Report-Secret': SECRET });
  check('correct secret → runs (EMAIL_MODE off here → disabled, counts only)', ok.status === 200 && ok.body.disabled === 'mode_off' && !JSON.stringify(ok.body).includes('@'), ok.body);
  check('short secrets are refused even if they match', !runnerMod.checkSchedulerSecret('short', 'short'));
  const tok = new URL(R.offUrl(uid(6))).searchParams.get('t');
  check('off link: bad token → 400', (await H.call('GET', `/api/email/weekly-report/off?u=${uid(6)}&t=bad`)).status === 400);
  const off = await H.call('GET', `/api/email/weekly-report/off?u=${uid(6)}&t=${tok}`);
  check('off link: valid → preference off, other preferences kept', off.status === 200 && H.rows('profiles').find((p) => p.id === uid(6)).preferences.weeklyReportEmail === false && H.rows('profiles').find((p) => p.id === uid(6)).preferences.language === 'nl');

  await new Promise((r) => setTimeout(r, 300)); // let open sockets close before exiting (Windows)
  done();
})().catch((e) => { console.error(e); process.exit(1); });
