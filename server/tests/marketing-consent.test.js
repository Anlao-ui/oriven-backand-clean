// ════════════════════════════════════════════════════════════════
// Marketing consent for promotional offers — the shared rule
// (lifecycle.consentCoversOffers), Settings confirmation, the Control Center
// opt-in card (offersInvite, "Yes, email me", "No thanks"), server-side
// source validation, identity from the session only, and that unsubscribe,
// bounces and complaints still work. In-memory Supabase; no email sent.
// RUN: node tests/marketing-consent.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const ADMIN = '00000000-0000-4000-8000-0000000004aa';
const H = boot({ port: 5640, env: { ADMIN_USER_IDS: ADMIN, EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', PUBLIC_API_URL: 'http://127.0.0.1:5640', FRONTEND_URL: 'https://orivenai.com' } });
const { check, log, done } = reporter();

(async () => {
  await H.start();
  const L = require(H.SERVER_DIR + '/services/email/lifecycle.js');
  const uid = (n) => '00000000-0000-4000-8000-0000000004' + String(n).padStart(2, '0');
  const P = (n, extra) => Object.assign({ id: uid(n), email: 'c' + n + '@example.invalid', subscription_status: 'free', marketing_opt_in: null, marketing_consent_source: null, marketing_opt_in_at: null, email_verified: true, preferences: { language: 'nl' } }, extra || {});
  const SIGNUP = { marketing_opt_in: true, marketing_consent_source: 'signup', marketing_opt_in_at: '2026-10-12T09:00:00Z' };
  const SETTINGS_NEW = { marketing_opt_in: true, marketing_consent_source: 'settings', marketing_opt_in_at: '2026-10-15T09:00:00Z' };
  const SETTINGS_OLD = { marketing_opt_in: true, marketing_consent_source: 'settings', marketing_opt_in_at: '2026-10-09T09:00:00Z' };
  H.rows('profiles').push(
    P(1, SIGNUP),                                  // signup consent: tips only
    P(2, SETTINGS_NEW),                            // covers offers
    P(3),                                          // no consent recorded
    P(4, { subscription_status: 'starter' }),      // paid: never invited
    P(5),                                          // bounced (suppressed below)
    P(6, { preferences: { offersInviteDismissedAt: '2026-10-20T10:00:00Z' } }), // dismissed earlier
    P(7, SETTINGS_OLD),                            // Settings consent under the old wording
    P(8, { marketing_opt_in: false }),             // unsubscribed
    { id: ADMIN, email: 'owner@example.invalid', subscription_status: 'professional' },
  );
  for (let n = 1; n <= 8; n++) H.TOKENS['tok' + n] = { id: uid(n), email: 'c' + n + '@example.invalid' };
  H.TOKENS.tok1b = { id: uid(1), email: 'c1@example.invalid' }; // same user, another device/session
  H.TOKENS.tok_admin = { id: ADMIN, email: 'owner@example.invalid' };
  await L.suppress('c5@example.invalid', 'hard_bounce');
  const prof = (n) => H.rows('profiles').find((p) => p.id === uid(n));
  const get = (n, tok) => H.call('GET', '/api/email/preferences', tok || 'tok' + n);

  // ── A. The shared rule ─────────────────────────────────────────
  log('\nA. consentCoversOffers (single rule for Settings, the card and campaigns)');
  check('signup consent does NOT cover offers', L.consentCoversOffers(P(0, SIGNUP)) === false);
  check('Settings consent under the old wording (before the cutoff) does not', L.consentCoversOffers(P(0, SETTINGS_OLD)) === false);
  check('Settings consent under the current wording does', L.consentCoversOffers(P(0, SETTINGS_NEW)) === true);
  check('opt-in card consent ("offers_invite") does', L.consentCoversOffers(P(0, { marketing_opt_in: true, marketing_consent_source: 'offers_invite', marketing_opt_in_at: '2026-10-26T09:00:00Z' })) === true);
  check('opted out / no consent / unknown source do not', !L.consentCoversOffers(P(0, Object.assign({}, SETTINGS_NEW, { marketing_opt_in: false }))) && !L.consentCoversOffers(P(0)) && !L.consentCoversOffers(P(0, { marketing_opt_in: true, marketing_consent_source: 'unsubscribe_link', marketing_opt_in_at: '2026-10-20T00:00:00Z' })));
  check('cutoff unchanged (2026-10-10T00:00:00Z); user-recordable sources: settings, offers_invite', L.OFFER_CONSENT.givenOnOrAfter === '2026-10-10T00:00:00Z' && JSON.stringify(L.USER_CONSENT_SOURCES) === JSON.stringify(['settings', 'offers_invite']));

  // ── B. What the app is told ────────────────────────────────────
  log('\nB. GET /api/email/preferences: offers + offersInvite');
  let r = await get(1);
  check('signup-consent Free user: marketing on, offers NOT covered, invited', r.status === 200 && r.body.marketing === true && r.body.offers === false && r.body.offersInvite === true, r.body);
  r = await get(2); check('already covers offers → no card', r.body.offers === true && r.body.offersInvite === false, r.body);
  r = await get(3); check('no consent recorded, Free → invited (consent not assumed)', r.body.marketing === false && r.body.offers === false && r.body.offersInvite === true);
  r = await get(4); check('paid plan → no card', r.body.offersInvite === false);
  r = await get(5); check('bounced address → no card, shown as suppressed', r.body.offersInvite === false && r.body.suppressed === true);
  r = await get(6); check('dismissed earlier → no card', r.body.offersInvite === false);
  r = await get(7); check('old-wording Settings consent → offers false, invited', r.body.offers === false && r.body.offersInvite === true);
  r = await get(8); check('unsubscribed Free user → marketing off, NOT invited (explicit opt-out respected)', r.body.marketing === false && r.body.offersInvite === false);
  check('not signed in → 401 (GET, PUT, dismiss)', (await H.call('GET', '/api/email/preferences')).status === 401 && (await H.call('PUT', '/api/email/preferences', null, { marketing: true })).status === 401 && (await H.call('POST', '/api/email/preferences/offers-invite/dismiss', null, {})).status === 401);
  check('reading preferences never changes consent', prof(1).marketing_consent_source === 'signup' && prof(3).marketing_opt_in === null);

  // ── C. Source validation + identity ────────────────────────────
  log('\nC. Server-side validation and identity');
  const before3 = JSON.stringify(prof(3));
  for (const src of ['signup', 'admin', 'backfill', '', 42]) {
    r = await H.call('PUT', '/api/email/preferences', 'tok3', { marketing: true, source: src });
    check('source ' + JSON.stringify(src) + ' → 400, nothing recorded', r.status === 400 && JSON.stringify(prof(3)) === before3);
  }
  r = await H.call('PUT', '/api/email/preferences', 'tok3', { marketing: true, source: 'offers_invite', userId: uid(4), id: uid(4) });
  check('"Yes, email me": records consent for the SIGNED-IN user only (ids in the body ignored)', r.status === 200 && prof(3).marketing_opt_in === true && prof(4).marketing_opt_in === null && prof(4).marketing_consent_source === null);
  check('…source "offers_invite" and a fresh timestamp', prof(3).marketing_consent_source === 'offers_invite' && Math.abs(Date.parse(prof(3).marketing_opt_in_at) - Date.now()) < 60e3);
  r = await get(3); check('…now covers offers; card no longer shown', r.body.offers === true && r.body.offersInvite === false);
  r = await H.call('PUT', '/api/email/preferences', 'tok5', { marketing: true, source: 'offers_invite' });
  check('bounced address can’t be opted in (409)', r.status === 409 && r.body.code === 'EMAIL_SUPPRESSED' && prof(5).marketing_opt_in === null);

  // ── D. Settings confirmation for signup consent ────────────────
  log('\nD. Settings: "Also send me special offers"');
  r = await H.call('PUT', '/api/email/preferences', 'tok1', { marketing: true, source: 'settings' });
  check('signup-consent user confirms → source "settings", new timestamp', r.status === 200 && prof(1).marketing_consent_source === 'settings' && Date.parse(prof(1).marketing_opt_in_at) > Date.parse(SIGNUP.marketing_opt_in_at));
  r = await get(1); check('…covers offers now; no card', r.body.offers === true && r.body.offersInvite === false);
  r = await H.call('PUT', '/api/email/preferences', 'tok2', { marketing: false });
  check('off switch still works (opt-out recorded, offers false)', r.status === 200 && prof(2).marketing_opt_in === false && !!prof(2).marketing_opt_out_at && (await get(2)).body.offers === false);
  r = await H.call('PUT', '/api/email/preferences', 'tok2', { marketing: true });
  check('switching on without a source records "settings" (existing behaviour)', r.status === 200 && prof(2).marketing_consent_source === 'settings');

  // ── E. "No thanks" ─────────────────────────────────────────────
  log('\nE. "No thanks"');
  const c7 = JSON.stringify({ a: prof(7).marketing_opt_in, b: prof(7).marketing_consent_source, c: prof(7).marketing_opt_in_at });
  r = await H.call('POST', '/api/email/preferences/offers-invite/dismiss', 'tok7', { userId: uid(8) });
  check('dismissal stored in the user’s own preferences', r.status === 200 && !!prof(7).preferences.offersInviteDismissedAt && !(prof(8).preferences || {}).offersInviteDismissedAt);
  check('…marketing consent untouched', JSON.stringify({ a: prof(7).marketing_opt_in, b: prof(7).marketing_consent_source, c: prof(7).marketing_opt_in_at }) === c7);
  check('…other preferences kept', prof(7).preferences.language === 'nl');
  r = await get(7); check('…card no longer shown', r.body.offersInvite === false);
  prof(6).preferences = { language: 'nl' };
  r = await get(6); check('(user 6 invited again once the old dismissal is removed)', r.body.offersInvite === true);
  await H.call('POST', '/api/email/preferences/offers-invite/dismiss', 'tok6', {});
  r = await H.call('GET', '/api/email/preferences', 'tok6'); // same account, later
  check('dismissal persists across sessions (read from the profile)', r.body.offersInvite === false && prof(6).marketing_opt_in === null);
  prof(1).preferences = { language: 'nl' }; prof(1).marketing_consent_source = 'signup'; prof(1).marketing_opt_in_at = SIGNUP.marketing_opt_in_at;
  await H.call('POST', '/api/email/preferences/offers-invite/dismiss', 'tok1', {});
  r = await get(1, 'tok1b');
  check('…and across devices (another session of the same user)', r.body.offersInvite === false && prof(1).marketing_consent_source === 'signup');

  // ── F. Campaign uses the same rule; exclusions unchanged ───────
  log('\nF. Campaign eligibility');
  r = await H.call('GET', '/api/admin/campaigns/access-plans-2026-11/audience', 'tok_admin');
  // free: 1 (signup again), 2 (settings, re-enabled now), 3 (offers_invite), 5 (bounced), 6 (no consent), 7 (old settings), 8 (opted out)
  check('eligible = only offers-covering consent (users 2 and 3)', r.status === 200 && r.body.eligible === 2 && r.body.consentSources.settings === 1 && r.body.consentSources.offers_invite === 1, r.body);
  check('signup + old-wording consent → consent_not_covering; others keep their reasons', r.body.excluded.consent_not_covering === 2 && r.body.excluded.no_consent === 2 && r.body.excluded.opted_out === 1, r.body.excluded);
  H.rows('email_sends').push({ id: 'mk3', user_id: uid(3), template: 'inactive', dedupe_key: 'inactive:9', category: 'marketing', status: 'sent', sent_at: new Date().toISOString() });
  r = await H.call('GET', '/api/admin/campaigns/access-plans-2026-11/audience', 'tok_admin');
  check('recent-marketing exclusion still applies', r.body.eligible === 1 && r.body.excluded.recent_marketing === 1);

  // ── G. Unsubscribe and complaints unchanged ────────────────────
  log('\nG. Unsubscribe, bounce and complaint handling');
  const link = L.unsubscribeUrl(uid(2)).replace('http://127.0.0.1:5640', '');
  r = await H.call('POST', link);
  check('one-click unsubscribe still turns marketing off', r.status === 200 && prof(2).marketing_opt_in === false && (await get(2)).body.offers === false);
  await L.handleProviderEvent({ type: 'email.complained', data: { email_id: 'x', to: ['c3@example.invalid'] } });
  r = await get(3);
  check('spam complaint → suppressed + opted out; no card, no offers', r.body.suppressed === true && r.body.offers === false && r.body.offersInvite === false && prof(3).marketing_opt_in === false);
  r = await H.call('GET', '/api/admin/campaigns/access-plans-2026-11/audience', 'tok_admin');
  check('…and the campaign has nobody left to mail', r.body.eligible === 0);

  await new Promise((res) => setTimeout(res, 300)); // let sockets close before exiting (Windows)
  done();
})().catch((e) => { console.error(e); process.exit(1); });
