// ════════════════════════════════════════════════════════════════
// Analytics: first-touch attribution, cookieless page views, conversion
// events, admin authorization and dashboard aggregation — through the REAL
// server.js (mocked Supabase/Stripe, no network).
// RUN: node tests/analytics.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const ADMIN = '00000000-0000-4000-8000-00000000ad01';
const H = boot({ port: 5594, env: { SMTP_USER: 'mailer@example.invalid', SMTP_PASS: 'x', SIGNUP_LIMIT_PER_IP_HOUR: '50', ADMIN_USER_IDS: ADMIN + ', not-a-uuid', ANALYTICS_SALT: 'test-salt' } });
const { check, log, done } = reporter();
const prof = (id) => H.rows('profiles').find((p) => p.id === id);
const ip = (n) => ({ 'X-Forwarded-For': '203.0.113.' + n });
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36' };
const beacon = (body, headers) => H.call('POST', '/api/t', null, JSON.stringify(body), Object.assign({ 'Content-Type': 'text/plain;charset=UTF-8' }, UA, headers || {}));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await H.start();
  const A = require(H.SERVER_DIR + '/services/analytics.js');

  log('\nA. Channel classification and sanitizing (server-side only)');
  const ch = (a) => A.sanitizeAttribution(a).acq_channel;
  const cases = [
    [{ referrer: 'https://www.google.com/' }, 'google_organic'], [{ referrer: 'https://www.google.nl/search?q=x' }, 'google_organic'],
    [{ referrer: 'https://www.linkedin.com/feed/' }, 'linkedin'], [{ referrer: 'https://lnkd.in/abc' }, 'linkedin'],
    [{ source: 'linkedin', medium: 'social' }, 'linkedin'], [{ source: 'linkedin', medium: 'cpc' }, 'linkedin_ads'],
    [{ source: 'google', medium: 'cpc' }, 'google_ads'], [{ click: 'google', referrer: 'https://www.google.com/' }, 'google_ads'],
    [{ source: 'facebook', medium: 'paid_social' }, 'meta_ads'], [{ source: 'newsletter', medium: 'email' }, 'email'],
    [{ referrer: 'https://chatgpt.com/' }, 'ai_assistant'], [{ referrer: 'https://www.bing.com/' }, 'other_search'],
    [{ referrer: 'https://t.co/x' }, 'social'], [{ referrer: 'https://someblog.example/post' }, 'referral'],
    [{}, 'direct'], [{ referrer: 'https://orivenai.com/pricing' }, 'direct'], [{ source: 'partner_x' }, 'campaign'],
  ];
  const wrong = cases.filter(([a, want]) => ch(a) !== want).map(([a, want]) => [a, want, ch(a)]);
  check('17 traffic sources classified correctly', wrong.length === 0, wrong);
  const s = A.sanitizeAttribution({ source: '<script>alert(1)</script>' + 'x'.repeat(300), medium: 'CPC', campaign: 'Spring Sale 2026!!', referrer: 'javascript:alert(1)', landing: '/pricing?email=a@b.c#x', firstSeen: '2000-01-01' });
  check('values sanitized: tags stripped, lower-case, length-limited, query strings and emails dropped', !/[<>()]/.test(s.acq_source) && s.acq_source.length <= 80 && s.acq_medium === 'cpc' && s.acq_campaign === 'spring_sale_2026' && s.acq_referrer_host === null && s.acq_landing_path === '/pricing' && s.acq_first_seen_at === null, s);
  check('referrer stored as host only (no path, query or full URL)', A.sanitizeAttribution({ referrer: 'https://www.linkedin.com/in/someone?trk=abc' }).acq_referrer_host === 'linkedin.com');
  check('own site as referrer is not a referral', A.sanitizeAttribution({ referrer: 'https://www.orivenai.com/learn/' }).acq_referrer_host === null);

  log('\nB. Cookieless page views (POST /api/t)');
  let r = await beacon({ p: '/learn/what-is-ppc-automation/?utm_source=x', r: 'https://www.google.com/', k: 'pageview' }, ip(1));
  await wait(60);
  let pv = H.rows('site_pageviews');
  check('page view stored: path without query, google_organic, entry', r.status === 204 && pv.length === 1 && pv[0].path === '/learn/what-is-ppc-automation/' && pv[0].channel === 'google_organic' && pv[0].entry === true, pv);
  check('no IP address, user agent, cookie or user id stored', !JSON.stringify(pv).includes('203.0.113') && !/Mozilla|Chrome/.test(JSON.stringify(pv)) && !('user_id' in pv[0]) && /^[a-f0-9]{16}$/.test(pv[0].visitor_hash), pv[0]);
  await beacon({ p: '/pricing', r: 'https://orivenai.com/learn/', k: 'pageview' }, ip(1)); await wait(40);
  pv = H.rows('site_pageviews');
  check('internal navigation: not an entry, same daily visitor hash', pv[1].entry === false && pv[1].visitor_hash === pv[0].visitor_hash && pv[1].channel === 'direct');
  check('visitor hash rotates every day (no cross-day tracking)', A.visitorDayHash('203.0.113.1', 'ua', Date.parse('2026-10-10T10:00:00Z')) !== A.visitorDayHash('203.0.113.1', 'ua', Date.parse('2026-10-11T10:00:00Z')));
  const n0 = H.rows('site_pageviews').length;
  await beacon({ p: '/' }, Object.assign(ip(2), { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }));
  await beacon({ p: '/' }, Object.assign(ip(3), { DNT: '1' }));
  await beacon({ p: '/' }, Object.assign(ip(4), { 'Sec-GPC': '1' }));
  await H.call('POST', '/api/t', null, 'not json', Object.assign({ 'Content-Type': 'text/plain' }, UA, ip(5)));
  await beacon({ p: 'https://evil.example/' }, ip(6));
  await wait(60);
  check('bots, Do Not Track, Global Privacy Control, junk and foreign paths are ignored', H.rows('site_pageviews').length === n0, H.rows('site_pageviews').slice(n0));
  await beacon({ p: '/signup', k: 'signup_started' }, ip(7)); await wait(40);
  check('signup_started recorded as its own kind', H.rows('site_pageviews').some((x) => x.kind === 'signup_started' && x.path === '/signup'));
  for (let i = 0; i < 125; i++) await beacon({ p: '/x' + i }, ip(8));
  await wait(80);
  check('rate limit: at most 120 page views per address per minute', H.rows('site_pageviews').filter((x) => /^\/x\d+$/.test(x.path)).length === 120);

  log('\nC. Signup attribution (first touch, insert-only)');
  const attribution = { source: 'linkedin', medium: 'social', campaign: 'launch_post', referrer: 'https://www.linkedin.com/feed/', landing: '/learn/', firstSeen: new Date(Date.now() - 3600e3).toISOString() };
  r = await H.call('POST', '/api/signup', null, { firstName: 'Ann', email: 'ann@example.com', password: 'secret123', attribution }, ip(20));
  const u1 = H.AUTH.users.find((u) => u.email === 'ann@example.com');
  await wait(60);
  let p1 = prof(u1.id);
  check('signup stores channel, UTM values, referrer host, landing page, first-seen time', r.status === 200 && p1.acq_channel === 'linkedin' && p1.acq_source === 'linkedin' && p1.acq_campaign === 'launch_post' && p1.acq_referrer_host === 'linkedin.com' && p1.acq_landing_path === '/learn/' && !!p1.acq_first_seen_at, p1);
  check('signup_completed event carries the channel', H.rows('events').some((e) => e.event_name === 'signup_completed' && e.user_id === u1.id && e.props && e.props.channel === 'linkedin'));
  r = await H.call('POST', '/api/profile/ensure', 'tok_' + u1.id, { attribution: { source: 'google', medium: 'cpc' } });
  check('original source never overwritten (ensure on an existing profile)', prof(u1.id).acq_channel === 'linkedin');
  await A.recordSignupAttribution(u1.id, { referrer: 'https://www.google.com/' });
  check('…and not by a second attribution write either (insert-only)', prof(u1.id).acq_channel === 'linkedin');
  r = await H.call('POST', '/api/signup', null, { firstName: 'Bo', email: 'bo@example.com', password: 'secret123' }, ip(21));
  await wait(60);
  const u2 = H.AUTH.users.find((u) => u.email === 'bo@example.com');
  check('signup without attribution → direct', prof(u2.id).acq_channel === 'direct');
  r = await H.call('POST', '/api/signup', null, { firstName: 'Cy', email: 'cy@example.com', password: 'secret123', attribution: 'not an object' }, ip(22));
  check('malformed attribution never breaks signup', r.status === 200);
  r = await H.call('POST', '/api/signup', null, { firstName: 'Di', email: 'di@example.com', password: 'secret123', attribution: { optOut: true, source: 'google' } }, ip(23));
  await wait(60);
  check('statistics switched off → channel "unknown", nothing else stored', prof(H.AUTH.users.find((u) => u.email === 'di@example.com').id).acq_channel === 'unknown' && !prof(H.AUTH.users.find((u) => u.email === 'di@example.com').id).acq_source);

  log('\nD. Conversion events (server-side, deduplicated)');
  const tok = (String(H.mail.find((m) => /ann@example\.com/.test(m.to)).text).match(/verify_token=([a-f0-9]{64})/) || [])[1];
  r = await H.call('POST', '/api/verify-email', null, { token: tok });
  await wait(40);
  check('email verified → email_verified_at + one email_verified event', r.status === 200 && !!prof(u1.id).email_verified_at && H.rows('events').filter((e) => e.event_name === 'email_verified' && e.user_id === u1.id).length === 1);
  r = await H.call('POST', '/api/onboarding/complete', 'tok_' + u1.id, { goal: 'explore' });
  await wait(40);
  check('onboarding completed → onboarding_completed {goal}', r.status === 200 && H.rows('events').some((e) => e.event_name === 'onboarding_completed' && e.user_id === u1.id && e.props.goal === 'explore'));
  const before = H.rows('events').length;
  const resUp = await H.call('POST', '/api/events', 'tok_' + u1.id, { event: 'checkout_started', props: { plan: 'starter' } });
  check('browser copies of checkout events are refused (server records them)', resUp.status >= 400 && H.rows('events').length === before);
  r = await H.call('POST', '/api/ai/create-ad', 'tok_' + u1.id, { product: 'x' });
  await H.call('POST', '/api/ai/create-ad', 'tok_' + u1.id, { product: 'y' });
  await wait(40);
  check('first campaign build attempt → first_ad_started once', H.rows('events').filter((e) => e.event_name === 'first_ad_started' && e.user_id === u1.id).length === 1);

  log('\nE. Owner dashboard authorization');
  H.TOKENS.tok_admin = { id: ADMIN, email: 'owner@example.invalid' };
  r = await H.call('GET', '/api/admin/analytics?days=30', null);
  const r2 = await H.call('GET', '/api/admin/analytics?days=30', 'tok_forged');
  const r3 = await H.call('GET', '/api/admin/analytics?days=30', 'tok_' + u1.id);
  check('no token → 401, forged → 401, signed-in customer → 403', r.status === 401 && r2.status === 401 && r3.status === 403, [r.status, r2.status, r3.status]);
  const me = await H.call('GET', '/api/admin/me', 'tok_' + u1.id), meA = await H.call('GET', '/api/admin/me', 'tok_admin');
  check('/api/admin/me tells the truth for each user (decided on the server)', me.body.admin === false && meA.body.admin === true);
  r = await H.call('GET', '/api/admin/analytics?days=30', 'tok_admin');
  check('admin → 200 with aggregates, no-store', r.status === 200 && r.body.registrations && r.headers.get('cache-control') === 'no-store', r.status);
  const body = JSON.stringify(r.body);
  check('response contains no emails, names or user ids', !/@example|Ann|Bo|00000000-0000-4000-8000/.test(body), body.match(/@example|Ann|00000000-0000-4000-8000[0-9a-f-]*/));
  r = await H.call('GET', '/api/admin/analytics?from=2020-01-01&to=2026-12-31', 'tok_admin');
  check('ranges over 366 days are refused', r.status === 400);
  let limited = 0; for (let i = 0; i < 65; i++) { const x = await H.call('GET', '/api/admin/me', 'tok_admin'); if (x.status === 429) limited++; }
  const rl = await H.call('GET', '/api/admin/analytics?days=7', 'tok_admin');
  check('admin endpoints are rate limited', rl.status === 429);
  delete process.env.ADMIN_USER_IDS;
  check('ADMIN_USER_IDS unset → nobody is admin', A.isAdmin(ADMIN) === false && A.adminIds().length === 0);
  process.env.ADMIN_USER_IDS = ADMIN;

  log('\nF. Dashboard aggregation (known dataset)');
  // A small fake database with known rows; dashboard() must count exactly.
  const now = Date.now(), d = (days) => new Date(now - days * 864e5).toISOString();
  const T = {
    profiles: [
      { id: 'p1', created_at: d(2), email_verified: true, onboarding_completed: true, first_value_at: d(1), first_value_kind: 'create', subscription_status: 'starter', stripe_subscription_id: 'sub_1', acq_channel: 'google_organic' },
      { id: 'p2', created_at: d(3), email_verified: false, onboarding_completed: true, first_value_at: null, subscription_status: 'free', acq_channel: 'linkedin' },
      { id: 'p3', created_at: d(5), email_verified: true, onboarding_completed: false, first_value_at: d(4), first_value_kind: 'create', subscription_status: 'free', acq_channel: 'linkedin' },
      { id: 'p4', created_at: d(6), email_verified: null, onboarding_completed: false, first_value_at: null, subscription_status: 'free', acq_channel: null },
      { id: 'old', created_at: d(60), email_verified: null, subscription_status: 'professional', stripe_subscription_id: null },
    ],
    events: [
      { event_name: 'first_ad_started', user_id: 'p1', created_at: d(1) }, { event_name: 'first_ad_started', user_id: 'p3', created_at: d(4) }, { event_name: 'first_ad_started', user_id: 'p2', created_at: d(2) },
      { event_name: 'first_create_success', user_id: 'p1', created_at: d(1) }, { event_name: 'first_create_success', user_id: 'p3', created_at: d(4) },
      { event_name: 'checkout_started', user_id: 'p1', created_at: d(1) }, { event_name: 'checkout_started', user_id: 'p1', created_at: d(1) }, { event_name: 'checkout_started', user_id: 'p2', created_at: d(1) },
      { event_name: 'subscription_activated', user_id: 'p1', created_at: d(1) },
    ],
    free_first_ad_claims: [], stripe_webhook_events: [], site_pageviews: [{ created_at: d(10) }],
  };
  const fake = {
    from(t) {
      const f = []; let lim = null, cols = null; const q = {
        select(c) { cols = c; return q; }, gte(c, v) { f.push((r) => r[c] >= v); return q; }, lte(c, v) { f.push((r) => r[c] <= v); return q; },
        in(c, a) { f.push((r) => a.includes(r[c])); return q; }, not(c, op, v) { f.push((r) => r[c] != null); return q; }, is() { return q; },
        order() { return q; }, limit(n) { lim = n; return q; }, range(a, b) { return Promise.resolve({ data: (T[t] || []).filter((r) => f.every((fn) => fn(r))).slice(a, b + 1), error: null }); },
        then(ok, bad) { let rows = (T[t] || []).filter((r) => f.every((fn) => fn(r))); if (lim != null) rows = rows.slice(0, lim); return Promise.resolve({ data: rows, error: null }).then(ok, bad); },
      }; return q;
    },
    rpc: async () => ({ data: { pageviews: 400, visitors: 120, entries: 150, daily: [], channels: [], landingPages: [], topPages: [] }, error: null }),
  };
  const fakeStripe = { checkout: { sessions: { list: () => (async function* () { for (const s of [{ status: 'complete', payment_status: 'paid', mode: 'subscription', metadata: { userId: 'p1', plan: 'starter' } }, { status: 'expired', payment_status: 'unpaid', mode: 'subscription', metadata: { userId: 'p1', plan: 'starter' } }, { status: 'expired', payment_status: 'unpaid', mode: 'subscription', metadata: { userId: 'p2', plan: 'creator' } }]) yield s; })() } },
    subscriptions: { list: () => (async function* () { yield { created: Math.floor(now / 1000) - 86400, canceled_at: null, status: 'active', items: { data: [{ price: { unit_amount: 995 } }] } }; })() } };
  A.init({ db: fake, stripe: fakeStripe }); A._cacheClear();
  const D = await A.dashboard(A.parseRange({ days: '30' }));
  check('signups = 4 in range (60-day-old account excluded)', D.registrations.signups === 4, D.registrations);
  check('signups by channel incl. "not_tracked" for missing attribution', JSON.stringify(D.registrations.byChannel) === JSON.stringify({ google_organic: 1, linkedin: 2, not_tracked: 1 }), D.registrations.byChannel);
  check('verification rate only over accounts created with verification (2 of 3)', D.registrations.verified === 2 && D.registrations.verifiable === 3 && D.registrations.verificationRate === 66.7, D.registrations);
  check('onboarding rate 2 of 4 = 50%', D.registrations.onboardingRate === 50);
  check('first ads: started 3 users, completed 2, success 66.7%', D.activation.firstAdsStarted === 3 && D.activation.firstAdsCompleted === 2 && D.activation.firstAdSuccessRate === 66.7, D.activation);
  check('checkout events: 3 starts by 2 unique users (events vs users kept apart)', D.subscriptions.events.checkoutStarted === 3 && D.subscriptions.events.checkoutStartedUsers === 2);
  check('Stripe sessions: 3 sessions, 2 unique users, 1 paying → 50% (people, not sessions)', D.subscriptions.checkout.sessions === 3 && D.subscriptions.checkout.uniqueUsers === 2 && D.subscriptions.checkout.uniquePayingUsers === 1 && D.subscriptions.checkoutConversionRate === 50, D.subscriptions.checkout);
  check('active paid = current snapshot incl. manually granted (2: starter + professional, 1 Stripe-billed)', D.subscriptions.activePaid === 2 && D.subscriptions.stripeBilled === 1 && D.subscriptions.manuallyGranted === 1, D.subscriptions);
  check('funnel is one cohort: 4 signups → 2 verified (of 3) → 2 first ads → 1 paid', JSON.stringify(D.funnel.steps.map((x) => x.value)) === JSON.stringify([4, 2, 2, 1]) && D.funnel.steps[1].base === 3, D.funnel.steps);
  check('visitors are a separate population (ratio labelled, not a funnel step)', D.funnel.visitors === 120 && D.funnel.visitorsToSignups === 3.3 && !D.funnel.steps.some((x) => x.key === 'visitors'));
  check('tracking coverage dates reported (missing history ≠ zero)', 'pageviewsSince' in D.tracking && 'eventsSince' in D.tracking);
  check('system status: booleans/timestamps only', D.system.freeFirstAd && typeof D.system.freeFirstAd.enabled === 'boolean' && !JSON.stringify(D.system).match(/sk_|whsec_|service_role|test-salt/));

  check('no outbound network (the create-ad calls in D are blocked AI requests, never sent)', H.net.blocked.every((u) => /api.aimlapi.com/.test(u)), H.net.blocked);
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
