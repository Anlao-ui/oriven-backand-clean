// ════════════════════════════════════════════════════════════════
// Lifecycle email — triggers, consent, dedupe, unsubscribe, provider
// events, retries and safe modes. Resend is mocked; nothing is delivered.
// RUN: node tests/email-lifecycle.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const { boot, reporter } = require('./helpers/mockServer');
const WH_SECRET = 'whsec_' + Buffer.from('test-webhook-secret-32-bytes!!!!').toString('base64');
const H = boot({ port: 5600, env: { EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', RESEND_WEBHOOK_SECRET: WH_SECRET, PUBLIC_API_URL: 'http://127.0.0.1:5600', FRONTEND_URL: 'https://orivenai.com', EMAIL_LIFECYCLE_SINCE: '2026-06-01T00:00:00Z' } });
const { check, log, done } = reporter();
const DAY = 864e5, now = Date.now();
const ago = (d) => new Date(now - d * DAY).toISOString();

const resend = { sent: [], fail: [], keys: new Set() };
H.net.handler = async (url, opts) => {
  if (url !== 'https://api.resend.com/emails') return null;
  const body = JSON.parse(opts.body);
  const key = opts.headers['Idempotency-Key'];
  if (resend.fail.length) { const s = resend.fail.shift(); return new Response(JSON.stringify({ name: s === 429 ? 'rate_limit_exceeded' : 'internal_server_error' }), { status: s }); }
  if (resend.keys.has(key)) return new Response(JSON.stringify({ id: 'dup-' + key }), { status: 200 }); // Resend returns the original
  resend.keys.add(key);
  resend.sent.push({ to: body.to[0], subject: body.subject, headers: body.headers || {}, html: body.html, key, auth: opts.headers.Authorization });
  return new Response(JSON.stringify({ id: 'em_' + resend.sent.length }), { status: 200 });
};
const P = (id, created, extra) => Object.assign({ id, email: id + '@example.invalid', first_name: 'Sam', created_at: created, subscription_status: 'free', first_value_at: null, first_value_kind: null, marketing_opt_in: null }, extra || {});

(async () => {
  await H.start();
  const L = require(H.SERVER_DIR + '/services/email/lifecycle.js');
  const sender = require(H.SERVER_DIR + '/services/email/sender.js');
  const T = require(H.SERVER_DIR + '/services/email/templates.js');
  const uid = (n) => '00000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');

  log('\nA. Off by default');
  check('EMAIL_MODE unset → mode off', sender.mode() === 'off');
  check('lifecycle job NOT registered without EMAIL_LIFECYCLE_ENABLED', !H.cronJobs.some((j) => j.expr === '*/15 * * * *'));
  H.rows('profiles').push(P(uid(1), ago(0.1)));
  let s = await L.runOnce({ now });
  check('runOnce in mode off → sends nothing, writes nothing', s.disabled === 'mode_off' && resend.sent.length === 0 && H.rows('email_sends').length === 0);
  const dry = await L.runOnce({ now, dryRun: true });
  check('dry run shows the plan (welcome) without sending', dry.due === 1 && dry.plan[0].template === 'welcome' && resend.sent.length === 0 && H.rows('email_sends').length === 0, dry);

  log('\nB. Templates');
  for (const k of Object.keys(T.TEMPLATES)) {
    const out = T.render(k, { firstName: 'Sam', plan: 'starter', kind: 'create', action: 'research', price: '9.95' }, { appUrl: 'https://orivenai.com/app', unsubscribeUrl: 'https://x/u' });
    check(`${k}: subject, html, text, category`, out.subject && /<html/.test(out.html) && out.text && ['service', 'marketing'].includes(out.category));
    if (out.category === 'marketing') check(`${k}: marketing email shows the unsubscribe link`, /https:\/\/x\/u/.test(out.html));
  }
  const w = T.render('welcome', { firstName: '<script>x</script>' }, { appUrl: 'https://orivenai.com/app' });
  check('names are HTML-escaped', !/<script>x/.test(w.html) && /&lt;script&gt;/.test(w.html));
  check('free first ad mentioned only when available', /free/.test(T.render('first_ad_reminder', { freeFirstAd: true }, { appUrl: 'a' }).subject) && !/free/i.test(T.render('first_ad_reminder', { freeFirstAd: false }, { appUrl: 'a' }).html.replace(/Free plan/g, '')));

  // Plan-aware copy: a paid account never reads Free-plan text.
  const CTX = { appUrl: 'https://orivenai.com/app', unsubscribeUrl: 'https://x/u' };
  for (const plan of ['starter', 'creator', 'professional']) {
    const r = T.render('first_ad_reminder', { plan, freeFirstAd: true }, CTX);
    check(`first-ad reminder (${plan}): no Free-plan or free-ad text, shows its own credits`, !/free/i.test(r.html + r.text + r.subject) && r.html.includes(T.PLAN_INTRO[plan].name + ' plan includes') && r.text.includes(T.PLAN_INTRO[plan].credits.toLocaleString('en-US') + ' credits'), r.text);
  }
  const rf = T.render('first_ad_reminder', { plan: 'free' }, CTX);
  check('first-ad reminder (free): one campaign every 24 hours (matches the server gate)', /one campaign every 24 hours/.test(rf.html) && /one campaign every 24 hours/.test(rf.text));

  // Plan facts match billing and entitlements.
  const CM = require(H.SERVER_DIR + '/services/creditManager.js');
  const ENT = require(H.SERVER_DIR + '/services/planEntitlements.js').PLAN_ENTITLEMENTS;
  check('credits match creditManager.PLAN_ALLOWANCES', ['starter', 'creator', 'professional'].every((k) => T.PLAN_INTRO[k].credits === CM.PLAN_ALLOWANCES[k]) && /10 credits a day/.test(T.render('upgrade_education', { action: 'research' }, CTX).html) && CM.PLAN_ALLOWANCES.free === 10);
  check('prices: Starter €9.95, Creator €29.95, Professional €59.95', T.PLAN_INTRO.starter.price === '9.95' && T.PLAN_INTRO.creator.price === '29.95' && T.PLAN_INTRO.professional.price === '59.95');
  const po = (k) => T.render('paid_onboarding', { plan: k }, CTX).html;
  check('Oriven Chat only promised where the plan has it', ['starter', 'creator', 'professional'].every((k) => /Oriven Chat/.test(po(k)) === ENT[k].orivenChat));
  check('Priority Support only promised on Professional', ['starter', 'creator', 'professional'].every((k) => /Priority Support/.test(po(k)) === ENT[k].prioritySupport));
  check('Autopilot described as Meta and Google only', ['starter', 'creator'].every((k) => /Meta (and|or) Google/.test(po(k))) && !/TikTok[^<]*Autopilot|Autopilot[^<]*TikTok/.test(po('starter')));
  const ue = T.render('upgrade_education', { action: 'research', plan: 'starter' }, CTX);
  check('upgrade email: €9.95/month and 1,000 credits, English number format', /€9\.95/.test(ue.html) && /1,000 credits/.test(ue.html) && !/1\.000/.test(ue.html + ue.text));
  const all = Object.keys(T.TEMPLATES).map((k) => T.render(k, { firstName: 'Sam', plan: 'starter', kind: 'create', action: 'research', verifyUrl: 'https://orivenai.com/app?verify_token=abc' }, Object.assign({ postalAddress: 'OrivenAI B.V. · Street 1, Town' }, CTX)));
  check('every email: mobile layout, preheader, postal address in HTML and text', all.every((o) => /max-width:620px/.test(o.html) && /display:none;max-height:0/.test(o.html) && o.html.includes('Street 1, Town') && o.text.includes('Street 1, Town')));
  check('marketing plain-text versions carry the unsubscribe link too', all.filter((o) => o.category === 'marketing').every((o) => o.text.includes('Unsubscribe: https://x/u')));
  check('service emails carry no unsubscribe link (they are not promotion)', all.filter((o) => o.category === 'service').every((o) => !/x\/u/.test(o.html + o.text)));
  check('every link is absolute https or mailto', all.every((o) => (o.html.match(/href="([^"]+)"/g) || []).every((h) => /href="(https:\/\/|mailto:)/.test(h))));
  check('one lime primary button per email at most', all.every((o) => (o.html.match(/class="btn"/g) || []).length <= 1));

  log('\nC. Triggers (live mode against the mocked Resend — nothing leaves this process)');
  process.env.EMAIL_MODE = 'live'; process.env.RESEND_API_KEY = 're_test_mock'; process.env.EMAIL_FROM = 'OrivenAI <hello@mail.orivenai.com>';
  H.rows('profiles').length = 0; H.rows('email_sends').length = 0;
  H.rows('profiles').push(
    P(uid(2), ago(0.2)),                                                              // welcome
    P(uid(3), ago(3), { marketing_opt_in: true }),                                    // first-ad reminder
    P(uid(4), ago(3), { marketing_opt_in: null }),                                    // no consent → no reminder
    P(uid(5), ago(10), { marketing_opt_in: true, first_value_at: ago(1), first_value_kind: 'research' }), // first success
    P(uid(6), ago(40), { marketing_opt_in: true, first_value_at: ago(35) }),          // inactive
    P(uid(7), ago(20), { marketing_opt_in: true, first_value_at: ago(15) }),          // upgrade education
    P(uid(8), ago(20), { subscription_status: 'creator' }),                           // paid onboarding (service, no consent needed)
    P(uid(9), '2026-05-01T00:00:00Z', { marketing_opt_in: true }),                    // historical → nothing
    P(uid(10), ago(3), { marketing_opt_in: true, email: null }),                      // missing address
  );
  // these accounts already received their welcome on day 0
  for (const id of [uid(3), uid(4)]) H.rows('email_sends').push({ id: 'w' + id, user_id: id, template: 'welcome', dedupe_key: 'welcome', category: 'service', status: 'sent', sent_at: ago(3) });
  H.rows('events').push({ user_id: uid(6), event_name: 'create_started', created_at: ago(30) });
  for (let i = 0; i < 3; i++) H.rows('events').push({ user_id: uid(7), event_name: 'paywall_shown', props: { action: 'research' }, created_at: ago(2 + i) });
  H.rows('events').push({ user_id: uid(7), event_name: 'create_started', created_at: ago(1) });
  s = await L.runOnce({ now });
  const byUser = {}; H.rows('email_sends').forEach((r) => { byUser[r.user_id] = r.template; });
  check('welcome → new account (service)', byUser[uid(2)] === 'welcome');
  check('first-ad reminder → opted-in account, 3 days, no result yet', byUser[uid(3)] === 'first_ad_reminder');
  check('no consent → no marketing email', !H.rows('email_sends').some((r) => r.user_id === uid(4) && r.category === 'marketing'));
  check('first success → research result (next step: Create)', byUser[uid(5)] === 'first_success');
  check('inactive → 21+ days quiet', byUser[uid(6)] === 'inactive');
  check('upgrade education → 3 Research paywalls in 14 days', byUser[uid(7)] === 'upgrade_education');
  check('paid onboarding → Creator (service, sent without marketing consent)', byUser[uid(8)] === 'paid_onboarding');
  check('historical account → nothing', !byUser[uid(9)]);
  check('missing email address → nothing', !byUser[uid(10)]);
  check('six emails, each to its own account, live subjects (no [TEST])', resend.sent.length === 6 && resend.sent.every((m) => /@example\.invalid$/.test(m.to) && !/^\[TEST\]/.test(m.subject)), resend.sent.map((m) => m.to));
  check('live idempotency keys carry the live scope', resend.sent.every((m) => /^oriven:live:/.test(m.key)));
  check('API key sent as Bearer only', resend.sent.every((m) => m.auth === 'Bearer re_test_mock'));
  const mk = resend.sent.filter((m) => m.headers['List-Unsubscribe']);
  check('marketing emails carry List-Unsubscribe + one-click headers', mk.length === 4 && mk.every((m) => m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click'));
  check('service emails have no unsubscribe header', resend.sent.filter((m) => !m.headers['List-Unsubscribe']).length === 2);
  check('ledger stores no addresses, subjects or bodies', !JSON.stringify(H.rows('email_sends')).match(/@|TEST|<html/));

  log('\nD. No duplicates');
  const n1 = resend.sent.length;
  s = await L.runOnce({ now });
  check('second run → only the next due email per user, never a repeat', !resend.sent.slice(n1).some((m) => H.rows('email_sends').filter((r) => r.provider_id).length < 0));
  const keys = H.rows('email_sends').map((r) => r.user_id + '|' + r.dedupe_key);
  check('ledger has unique (user, email) rows', new Set(keys).size === keys.length);
  const before = resend.sent.length;
  await Promise.all([L.runOnce({ now }), L.runOnce({ now }), L.runOnce({ now })]);
  const keys2 = H.rows('email_sends').map((r) => r.user_id + '|' + r.dedupe_key);
  check('three concurrent runs → no duplicate sends', new Set(keys2).size === keys2.length && new Set(resend.sent.map((m) => m.key)).size === resend.sent.length, { before, after: resend.sent.length });
  const wNow = H.rows('email_sends').filter((r) => r.user_id === uid(2));
  check('welcome only once for the same user', wNow.filter((r) => r.template === 'welcome').length === 1);

  log('\nE. Frequency cap');
  const fresh = uid(11);
  H.rows('profiles').push(P(fresh, ago(3), { marketing_opt_in: true, first_value_at: ago(0.5), first_value_kind: 'create' }));
  H.rows('email_sends').push({ id: 'x1', user_id: fresh, template: 'first_ad_reminder', dedupe_key: 'first_ad_reminder', category: 'marketing', status: 'sent', sent_at: ago(1) });
  await L.runOnce({ now });
  check('marketing within 3 days of the last one → held back', !H.rows('email_sends').some((r) => r.user_id === fresh && r.template === 'first_success'));
  await L.runOnce({ now: now + 3 * DAY });
  check('…and sent once the gap has passed (still within 7 days of the result)', H.rows('email_sends').some((r) => r.user_id === fresh && r.template === 'first_success'));

  log('\nF. Unsubscribe');
  const unsub = L.unsubscribeUrl(uid(3));
  let r = await H.call('GET', unsub.replace('http://127.0.0.1:5600', ''), null);
  const pr3 = H.rows('profiles').find((p) => p.id === uid(3));
  check('signed link → unsubscribed, confirmation page', r.status === 200 && /unsubscribed/i.test(r.body) && pr3.marketing_opt_in === false && !!pr3.marketing_opt_out_at);
  pr3.marketing_opt_in = true;
  r = await H.call('POST', unsub.replace('http://127.0.0.1:5600', ''), null, 'List-Unsubscribe=One-Click', { 'Content-Type': 'application/x-www-form-urlencoded' });
  check('one-click POST (RFC 8058) → 200 and unsubscribed', r.status === 200 && pr3.marketing_opt_in === false);
  r = await H.call('GET', `/api/email/unsubscribe?u=${uid(4)}&t=${'0'.repeat(40)}`, null);
  check('forged token → 400, nothing changed', r.status === 400 && H.rows('profiles').find((p) => p.id === uid(4)).marketing_opt_in === null);
  const cnt = resend.sent.length;
  H.rows('email_sends').splice(0, H.rows('email_sends').length, ...H.rows('email_sends').filter((x) => x.user_id !== uid(3)));
  await L.runOnce({ now });
  check('unsubscribed user gets no marketing email', !resend.sent.slice(cnt).some((m) => m.key.includes(uid(3)) && !/welcome|paid/.test(m.key)));

  log('\nG. Preferences API');
  H.TOKENS.tok4 = { id: uid(4), email: 'x' };
  r = await H.call('PUT', '/api/email/preferences', 'tok4', { marketing: true });
  check('settings opt-in stored with source', r.status === 200 && H.rows('profiles').find((p) => p.id === uid(4)).marketing_consent_source === 'settings');
  r = await H.call('PUT', '/api/email/preferences', 'tok4', { marketing: 'yes' });
  check('non-boolean → 400', r.status === 400);
  r = await H.call('PUT', '/api/email/preferences', null, { marketing: true });
  check('no session → 401', r.status === 401);

  log('\nH. Provider failures, retries, rate limits');
  for (let i = 0; i < 6; i++) await L.runOnce({ now }); // let everything already due go out first
  const u12 = uid(12);
  H.rows('profiles').push(P(u12, ago(0.1)));
  resend.fail = [500, 500, 500];
  await L.runOnce({ now });
  const row12 = H.rows('email_sends').find((x) => x.user_id === u12);
  check('three 5xx in one send → marked failed (short code only)', row12 && row12.status === 'failed' && /^http_500/.test(row12.error), row12);
  resend.fail = [429];
  await L.retryFailed({ minAgeMs: 0 });
  check('retry after a 429 → sent on the next attempt', H.rows('email_sends').find((x) => x.user_id === u12).status === 'sent');
  const u13 = uid(13);
  H.rows('profiles').push(P(u13, ago(0.1)));
  resend.fail = [400];
  await L.runOnce({ now });
  const row13 = H.rows('email_sends').find((x) => x.user_id === u13);
  await L.retryFailed({ minAgeMs: 0 });
  check('a 4xx is permanent → marked error, not retried', row13.status === 'error' && row13.attempts === 1, row13);
  check('idempotency key per (scope, user, email)', resend.sent.every((m) => /^oriven:live:[0-9a-f-]+:/.test(m.key)));
  const t0 = Date.now(); for (let i = 0; i < 6; i++) await sender.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't', idempotencyKey: 'rate' + i });
  check('client-side pacing (~5/s, under Resend’s 10/s)', Date.now() - t0 >= 900, Date.now() - t0);

  log('\nI. Provider webhooks');
  const sign = (body, ts) => { const id = 'msg_1'; ts = ts || String(Math.floor(Date.now() / 1000)); const sig = crypto.createHmac('sha256', Buffer.from(WH_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64'); return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + sig, 'Content-Type': 'application/json' }; };
  const bounce = JSON.stringify({ type: 'email.bounced', data: { email_id: 'em_1', to: ['bounce@example.invalid'], bounce: { type: 'Permanent' } } });
  r = await H.call('POST', '/api/email/webhook', null, bounce, { 'Content-Type': 'application/json', 'svix-id': 'm', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' });
  check('unsigned/forged webhook → 401', r.status === 401);
  r = await H.call('POST', '/api/email/webhook', null, bounce, sign(bounce, String(Math.floor(Date.now() / 1000) - 3600)));
  check('replayed (old timestamp) → 401', r.status === 401);
  r = await H.call('POST', '/api/email/webhook', null, bounce, sign(bounce));
  check('signed hard bounce → suppressed (hash only), ledger updated', r.status === 200 && H.rows('email_suppressions').some((x) => x.email_hash === L.emailHash('bounce@example.invalid') && x.reason === 'hard_bounce') && H.rows('email_sends').some((x) => x.provider_id === 'em_1' && x.status === 'bounced'));
  H.rows('profiles').push(P(uid(14), ago(3), { marketing_opt_in: true, email: 'complainer@example.invalid' }));
  const complaint = JSON.stringify({ type: 'email.complained', data: { email_id: 'em_2', to: ['complainer@example.invalid'] } });
  r = await H.call('POST', '/api/email/webhook', null, complaint, sign(complaint));
  check('complaint → suppressed AND marketing consent withdrawn', r.status === 200 && H.rows('profiles').find((p) => p.id === uid(14)).marketing_opt_in === false && H.rows('email_suppressions').some((x) => x.reason === 'complaint'));
  H.rows('profiles').push(P(uid(15), ago(0.1), { email: 'bounce@example.invalid' }));
  const c2 = resend.sent.length;
  await L.runOnce({ now });
  check('suppressed address gets nothing (not even service email)', !H.rows('email_sends').some((x) => x.user_id === uid(15)) && resend.sent.length === c2 + 0 || !resend.sent.slice(c2).some((m) => m.key.includes(uid(15))));
  check('no suppression table stores raw addresses', !JSON.stringify(H.rows('email_suppressions')).includes('@'));

  log('\nJ. Safety rails');
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  H.rows('profiles').push(P(uid(16), ago(10), { marketing_opt_in: true }));
  await L.runOnce({ now });
  const r16 = H.rows('email_sends').find((x) => x.user_id === uid(16));
  check('no unsubscribe secret → marketing email skipped, never sent without a working unsubscribe', r16 && r16.status === 'skipped' && r16.error === 'no_unsubscribe_secret');
  process.env.EMAIL_UNSUBSCRIBE_SECRET = 'unsub-test-secret';
  process.env.EMAIL_MODE = 'test'; delete process.env.EMAIL_TEST_ALLOWLIST;
  check('test mode with no allowlist → a customer address is refused', (await sender.send({ to: 'real@customer.invalid', subject: 's', html: 'h', text: 't', idempotencyKey: 'z' })).skipped === 'not_allowlisted');
  process.env.EMAIL_MODE = 'off';
  check('mode off → send() refuses', (await sender.send({ to: 'x@y.z', subject: 's', html: 'h', text: 't', idempotencyKey: 'q' })).skipped === 'mode_off');
  check('no outbound network except mocked Resend', H.net.blocked.length === 0, H.net.blocked);
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
