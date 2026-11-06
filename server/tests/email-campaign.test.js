// ════════════════════════════════════════════════════════════════
// Marketing campaign "no plan → plans" — audience (Free + explicit consent
// only), exclusions, test mode, approval gates, duplicate prevention,
// unsubscribe, rendering and the admin API. Resend is mocked; nothing is
// delivered; Supabase is in-memory.
// RUN: node tests/email-campaign.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const ADMIN = '00000000-0000-4000-8000-0000000003aa';
const H = boot({ port: 5630, env: {
  ADMIN_USER_IDS: ADMIN, RESEND_API_KEY: 're_test_mock', EMAIL_FROM: 'OrivenAI <hello@mail.orivenai.com>',
  EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', PUBLIC_API_URL: 'http://127.0.0.1:5630', FRONTEND_URL: 'https://orivenai.com',
  EMAIL_POSTAL_ADDRESS: 'OrivenAI · Test Street 1 · Amsterdam',
} });
const { check, log, done } = reporter();
const CID = 'access-plans-2026-11';
const resend = [];
H.net.handler = async (url, opts) => {
  if (url !== 'https://api.resend.com/emails') return null;
  const b = JSON.parse(opts.body);
  resend.push({ to: b.to[0], subject: b.subject, html: b.html, text: b.text, headers: b.headers || {}, key: opts.headers['Idempotency-Key'] });
  return new Response(JSON.stringify({ id: 'em_' + resend.length }), { status: 200 });
};

(async () => {
  await H.start();
  const T = require(H.SERVER_DIR + '/services/email/templates.js');
  const L = require(H.SERVER_DIR + '/services/email/lifecycle.js');
  const uid = (n) => '00000000-0000-4000-8000-0000000003' + String(n).padStart(2, '0');
  const P = (n, extra) => Object.assign({ id: uid(n), email: 'u' + n + '@example.invalid', subscription_status: 'free', marketing_opt_in: true, marketing_consent_source: 'settings', marketing_opt_in_at: '2026-10-15T10:00:00Z', email_verified: true, created_at: '2026-10-01T00:00:00Z' }, extra || {});
  H.rows('profiles').push(
    P(1), P(2),                                                              // eligible (Settings consent naming offers)
    P(14, { marketing_consent_source: 'signup' }),                           // signup checkbox: tips and product updates only
    P(15, { marketing_opt_in_at: '2026-10-09T12:00:00Z' }),                  // Settings, but under the old wording (no offers)
    P(3, { marketing_opt_in: null }), P(4, { marketing_opt_in: false }),       // no consent / opted out
    P(5, { email: 'not-an-email' }), P(6, { email: null }),                   // invalid address
    P(7, { email_verified: false }),                                         // unverified
    P(8, { subscription_status: 'starter' }), P(9, { subscription_status: 'creator' }), P(10, { subscription_status: 'professional' }),
    P(11), P(12), P(13),                                                     // suppressed / recent marketing / already sent (below)
    { id: ADMIN, email: 'owner@example.invalid', subscription_status: 'professional', marketing_opt_in: true },
  );
  await L.suppress('u11@example.invalid', 'hard_bounce');
  H.rows('email_sends').push({ id: 'm12', user_id: uid(12), template: 'inactive', dedupe_key: 'inactive:1', category: 'marketing', status: 'sent', sent_at: new Date(Date.now() - 864e5).toISOString() });
  H.rows('email_sends').push({ id: 'm13', user_id: uid(13), template: 'campaign_access_plans', dedupe_key: 'campaign:' + CID, category: 'marketing', status: 'sent', sent_at: new Date().toISOString() });
  H.TOKENS.tok_admin = { id: ADMIN, email: 'owner@example.invalid' };
  H.TOKENS.tok_user = { id: uid(1), email: 'u1@example.invalid' };
  const A = (m, p, body) => H.call(m, '/api/admin/campaigns' + p, 'tok_admin', body);

  // ── A. The email ───────────────────────────────────────────────
  log('\nA. Email content and rendering');
  const e = T.render('campaign_access_plans', {}, { appUrl: 'https://orivenai.com/app', unsubscribeUrl: 'https://x/unsub', postalAddress: 'OrivenAI · Street' });
  check('subject', e.subject === 'Ready to do more with OrivenAI?');
  check('preview text', e.html.includes('The full advertising workflow, from €17 for 14 days.'));
  check('marketing category (needs consent + unsubscribe)', e.category === 'marketing');
  check('footer names where consent came from (Settings)', e.html.includes('because you turned on marketing emails in your OrivenAI settings'));
  check('every plan with price, period and credits from services/pricing.js', ['Flex · €17 · 14 days · 1,050 credits', 'Monthly · €29 · 1 month · 1,750 credits', 'Quarterly · €78 · 3 months · 4,800 credits', 'Semi-Annual · €143 · 6 months · 8,850 credits', 'Annual · €245 · 12 months · 15,000 credits'].every((t) => e.html.includes(t)) && T.PLAN_INTRO.monthly.price === '€29' && T.PLAN_INTRO.monthly.credits === 1750);
  check('says prices exclude VAT (added at checkout) and nothing renews automatically', e.html.includes('prices excl. VAT, added at checkout') && !/include VAT/i.test(e.html) && e.html.includes('nothing renews automatically'));
  check('no retired plan names or Free wording', !/Starter|Free account|€9\.95/.test(e.html + e.text));
  check('benefits: full workflow, research, create, launch, Automations', ['full advertising workflow', 'research your market, create advertising content, launch campaigns and manage them with Automations'].every((s) => e.html.includes(s)));
  check('the copy, in order', ['Hi there,', 'You’ve already taken the first step by joining OrivenAI.', 'OrivenAI gives you the full advertising workflow', 'Every plan includes every feature.', 'The OrivenAI Team'].every((t, i, a) => e.html.indexOf(t) >= 0 && (i === 0 || e.html.indexOf(t) > e.html.indexOf(a[i - 1]))));
  check('CTA "See the plans" → https://orivenai.com/app?plans=1 (opens the in-app plans)', /href="https:\/\/orivenai\.com\/app\?plans=1"[^>]*>See the plans/.test(e.html));
  check('dark design with lime accent; mobile rules; table layout', e.html.includes('background:#0A0A0A') && e.html.includes('#B7FF2A') && /max-width:620px/.test(e.html) && /role="presentation"/.test(e.html) && /color-scheme" content="dark"/.test(e.html));
  check('unsubscribe link + "account and billing emails still reach you" + postal address', e.html.includes('https://x/unsub') && e.html.includes('Account and billing emails will still reach you') && e.html.includes('OrivenAI · Street'));
  check('plain-text version with CTA and unsubscribe', e.text.includes('See the plans: https://orivenai.com/app?plans=1') && e.text.includes('Unsubscribe: https://x/unsub'));
  check('not aggressive: no urgency words', !/hurry|last chance|limited time|act now|expires/i.test(e.html));

  // ── B. Admin API is admin-only ─────────────────────────────────
  log('\nB. Admin-only');
  check('no session → 401', (await H.call('GET', '/api/admin/campaigns/' + CID + '/audience')).status === 401);
  check('customer session → 403', (await H.call('GET', '/api/admin/campaigns/' + CID + '/audience', 'tok_user')).status === 403);
  check('customer can’t trigger a send → 403', (await H.call('POST', '/api/admin/campaigns/' + CID + '/send', 'tok_user', { confirm: 'SEND ' + CID, expectedEligible: 2 })).status === 403 && resend.length === 0);
  let r = await A('GET', '');
  check('admin: campaign listed, not approved, mode off', r.status === 200 && r.body.campaigns[0].id === CID && r.body.campaigns[0].approved === false && r.body.mode === 'off');
  check('unknown campaign → 404', (await A('GET', '/nope/audience')).status === 404);
  r = await A('GET', '/' + CID + '/preview');
  check('preview returns the rendered email', r.status === 200 && r.body.subject === 'Ready to do more with OrivenAI?' && /See the plans/.test(r.body.html) && r.body.ctaUrl === 'https://orivenai.com/app?plans=1');

  // ── C. Audience ────────────────────────────────────────────────
  log('\nC. Audience: Free + explicit consent only');
  r = await A('GET', '/' + CID + '/audience');
  const a = r.body;
  check('only Free accounts considered (paid never counted)', a.freeAccounts === 12, a);
  check('eligible = the 2 consenting, valid, unsuppressed Free accounts', a.eligible === 2, a);
  check('excluded: no consent, opted out, invalid email ×2, unverified, suppressed, recent marketing, already sent', JSON.stringify(Object.fromEntries(Object.entries(a.excluded).sort())) === JSON.stringify(Object.fromEntries(Object.entries({ no_consent: 1, opted_out: 1, invalid_email: 2, unverified_email: 1, suppressed: 1, recent_marketing: 1, already_sent: 1, consent_not_covering: 2 }).sort())), a.excluded);
  check('consent sources reported: only Settings consent counts for this promotional email', a.consentSources.settings === 2 && !a.consentSources.signup);
  check('signup-only consent and pre-wording Settings consent are excluded (consent_not_covering)', a.excluded.consent_not_covering === 2);
  check('counts only: no addresses or ids in the response', !/@|0000-4000/.test(JSON.stringify(a)));

  // ── D. Safe by default ─────────────────────────────────────────
  log('\nD. Nothing goes out by default');
  r = await A('POST', '/' + CID + '/test', {});
  check('EMAIL_MODE off → test refused', r.status === 403 && r.body.error === 'email_mode_off' && resend.length === 0);
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 2 });
  check('EMAIL_MODE off → send refused', r.status === 403 && r.body.error === 'email_mode_off' && resend.length === 0);
  check('no campaign job is scheduled', !H.cronJobs.some((j) => /campaign/i.test(String(j.fn))));

  // ── E. Test mode ───────────────────────────────────────────────
  log('\nE. Test mode (allowlist only)');
  process.env.EMAIL_MODE = 'test'; process.env.EMAIL_TEST_ALLOWLIST = 'owner@example.invalid, u1@example.invalid';
  r = await A('POST', '/' + CID + '/test', {});
  check('test send → only the allowlisted addresses', r.status === 200 && r.body.sent === 2 && resend.every((m) => ['owner@example.invalid', 'u1@example.invalid'].includes(m.to)) && resend.length === 2, r.body);
  check('test subject marked', resend.every((m) => /^\[TEST\] \[Campaign test\] Ready to do more/.test(m.subject)));
  check('test send writes no campaign ledger row (repeatable)', !H.rows('email_sends').some((s) => /^test:campaign/.test(s.dedupe_key)));
  r = await A('GET', '/' + CID + '/audience');
  check('test-mode audience counts only allowlisted accounts', r.body.freeAccounts === 1 && r.body.eligible === 1 && /allowlisted/.test(r.body.note), r.body);
  const before = resend.length;
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 1 });
  check('rehearsal send (test mode) → only the allowlisted eligible account', r.status === 200 && r.body.sent === 1 && resend.length === before + 1 && resend[before].to === 'u1@example.invalid', r.body);
  check('rehearsal ledgered under "test:" (never blocks the real send)', H.rows('email_sends').some((s) => s.user_id === uid(1) && s.dedupe_key === 'test:campaign:' + CID && s.status === 'sent'));

  // ── F. Live mode: approval gates ───────────────────────────────
  log('\nF. Live: explicit approval required');
  process.env.EMAIL_MODE = 'live'; delete process.env.EMAIL_TEST_ALLOWLIST;
  const n0 = resend.length;
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 2 });
  check('live without MARKETING_CAMPAIGN_APPROVED → refused', r.status === 403 && r.body.error === 'not_approved' && resend.length === n0);
  process.env.MARKETING_CAMPAIGN_APPROVED = 'some-other-campaign';
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 2 });
  check('approval for a different campaign → refused', r.body.error === 'not_approved' && resend.length === n0);
  process.env.MARKETING_CAMPAIGN_APPROVED = CID;
  r = await A('POST', '/' + CID + '/send', { confirm: 'yes', expectedEligible: 2 });
  check('wrong confirmation phrase → 409, nothing sent', r.status === 409 && r.body.error === 'confirmation_required' && resend.length === n0);
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 5 });
  check('eligible count changed since review → 409, nothing sent', r.status === 409 && r.body.error === 'audience_changed' && r.body.eligible === 2 && resend.length === n0);

  log('\nG. Live send, batching, duplicates');
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 2, limit: 1 });
  check('batch of 1 → 1 sent, 1 remaining', r.status === 200 && r.body.sent === 1 && r.body.remaining === 1, r.body);
  r = await A('GET', '/' + CID + '/audience');
  check('audience now 1 eligible (the sent one is "already sent")', r.body.eligible === 1);
  const [s1, s2] = await Promise.all([A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 1 }), A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 1 })]);
  const live = resend.slice(n0);
  check('two overlapping sends → each account still gets ONE email', live.length === 2 && new Set(live.map((m) => m.to)).size === 2 && (s1.body.sent || 0) + (s2.body.sent || 0) === 1, { s1: s1.body, s2: s2.body });
  check('live recipients are exactly the eligible accounts', JSON.stringify(live.map((m) => m.to).sort()) === JSON.stringify(['u1@example.invalid', 'u2@example.invalid']));
  check('no paid, unconsented, unsubscribed, suppressed or recently-mailed account received anything', !resend.some((m) => /u(3|4|5|7|8|9|10|11|12|13|14|15)@/.test(m.to)));
  check('real subject (no test marker) + List-Unsubscribe one-click', live.every((m) => m.subject === 'Ready to do more with OrivenAI?' && /\/api\/email\/unsubscribe\?u=/.test(m.headers['List-Unsubscribe']) && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click'));
  check('each email has its own signed unsubscribe link', live.every((m) => m.html.includes('/api/email/unsubscribe?u=' + (m.to === 'u1@example.invalid' ? uid(1) : uid(2)))));
  check('idempotency key per account and campaign', live.every((m) => /^oriven:live:[0-9a-f-]{36}:campaign:access-plans-2026-11$/.test(m.key)));
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: 0 });
  check('running it again sends nothing', r.status === 200 && r.body.sent === 0 && resend.length === n0 + 2);
  r = await A('GET', '/' + CID + '/results');
  check('results: 2 sent in live scope (+ the earlier record), counts only', r.body.scope === 'live' && r.body.byStatus.sent === 3 && !/@/.test(JSON.stringify(r.body)), r.body);

  // ── H. Re-check right before sending ───────────────────────────
  log('\nH. Plan and consent re-checked at send time');
  H.rows('profiles').push(P(20), P(21));
  r = await A('GET', '/' + CID + '/audience');
  const el = r.body.eligible;
  H.rows('profiles').find((p) => p.id === uid(20)).subscription_status = 'starter'; // upgraded meanwhile
  r = await A('POST', '/' + CID + '/send', { confirm: 'SEND ' + CID, expectedEligible: el - 1 });
  check('account that upgraded since the review is not mailed', r.status === 200 && !resend.some((m) => m.to === 'u20@example.invalid') && resend.some((m) => m.to === 'u21@example.invalid'), r.body);

  // ── I. Unsubscribe ─────────────────────────────────────────────
  log('\nI. Unsubscribe');
  const link = resend.find((m) => m.to === 'u2@example.invalid').headers['List-Unsubscribe'].slice(1, -1).replace('http://127.0.0.1:5630', '');
  const u = await H.call('POST', link);
  check('one-click unsubscribe works (RFC 8058 POST)', u.status === 200 && H.rows('profiles').find((p) => p.id === uid(2)).marketing_opt_in === false);
  check('…only marketing is turned off (account stays, plan unchanged)', H.rows('profiles').find((p) => p.id === uid(2)).subscription_status === 'free' && !!H.rows('profiles').find((p) => p.id === uid(2)).email);
  H.rows('email_sends').splice(0, H.rows('email_sends').length, ...H.rows('email_sends').filter((s) => !(s.user_id === uid(2) && /campaign/.test(s.dedupe_key))));
  r = await A('GET', '/' + CID + '/audience');
  check('unsubscribed account is excluded even without its campaign record', r.body.excluded.opted_out === 2, r.body.excluded);

  await new Promise((res) => setTimeout(res, 300)); // let sockets close before exiting (Windows)
  done();
})().catch((e) => { console.error(e); process.exit(1); });
