// ════════════════════════════════════════════════════════════════
// Entitlements, enforced on the server (not just the UI). One product since
// 2026-10-30: every paying account with current access (a period plan, or a
// legacy monthly subscription that is still running) gets everything:
//   Oriven Chat — incl. alternate payloads/endpoints
//   In-app notification center
//   Priority Support + admin review/reply + reply email
// An account without access (never bought, or access ended) gets none of it.
// Boots the real server.js with Supabase, Resend, the AI provider and all
// networks mocked. No real users, emails, AI calls or ad-account changes.
// RUN: node tests/subscription-entitlements.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const ADMIN = '00000000-0000-4000-8000-0000000002aa';
const H = boot({ port: 5620, env: {
  ADMIN_USER_IDS: ADMIN, EMAIL_MODE: 'live', RESEND_API_KEY: 're_test_mock', EMAIL_FROM: 'OrivenAI <hello@mail.orivenai.com>',
  EMAIL_UNSUBSCRIBE_SECRET: 'unsub-test-secret', FRONTEND_URL: 'https://orivenai.com',
} });
const { check, log, done } = reporter();

const ai = { bodies: [] };
const resend = [];
H.net.handler = async (url, opts) => {
  if (/api\.aimlapi\.com\/v1\/chat\/completions/.test(url)) {
    ai.bodies.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Here is a short answer.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url === 'https://api.resend.com/emails') {
    const b = JSON.parse(opts.body); resend.push({ to: b.to[0], subject: b.subject, html: b.html });
    return new Response(JSON.stringify({ id: 'em_' + resend.length }), { status: 200 });
  }
  return null;
};

(async () => {
  await H.start();
  const id = (n) => '00000000-0000-4000-8000-0000000002' + String(n).padStart(2, '0');
  const FUTURE = new Date(Date.now() + 20 * 864e5).toISOString();
  const PAST = new Date(Date.now() - 864e5).toISOString();
  // free: never bought · expired: a period plan that ended · starter: a legacy
  // subscription still running · paid / paid2: period plans with access.
  const accounts = {
    free: { n: 1, status: 'free', access_expires_at: null },
    expired: { n: 2, status: 'paid', access_expires_at: PAST, access_plan: 'monthly' },
    starter: { n: 3, status: 'starter', access_expires_at: FUTURE, access_plan: 'starter' },
    paid: { n: 4, status: 'paid', access_expires_at: FUTURE, access_plan: 'quarterly' },
    paid2: { n: 5, status: 'paid', access_expires_at: FUTURE, access_plan: 'flex' },
  };
  for (const [k, a] of Object.entries(accounts)) {
    H.rows('profiles').push({ id: id(a.n), email: k + '@example.invalid', subscription_status: a.status, access_expires_at: a.access_expires_at, access_plan: a.access_plan || null, credits_balance: 1000, credits_cycle_end: FUTURE, preferences: { language: 'en' } });
    H.TOKENS['tok_' + k] = { id: id(a.n), email: k + '@example.invalid' };
  }
  H.rows('profiles').push({ id: ADMIN, email: 'owner@example.invalid', subscription_status: 'free', access_expires_at: null, credits_balance: 0 });
  H.TOKENS.tok_admin = { id: ADMIN, email: 'owner@example.invalid' };
  const chat = (tok, body) => H.call('POST', '/api/ai/chat', tok, Object.assign({ message: 'What should I do about my campaigns?' }, body || {}));
  const bal = (k) => H.rows('profiles').find((p) => p.id === id(accounts[k].n)).credits_balance;

  // ── A. Oriven Chat ───────────────────────────────────────────────
  log('\nA. Oriven Chat — server-side entitlement');
  for (const k of ['free', 'expired']) {
    let r = await chat('tok_' + k, { surface: 'oriven-chat', context: { page: 'performance' } });
    check(`${k}: chat panel payload → 403 SUBSCRIPTION_REQUIRED`, r.status === 403 && r.body.code === 'SUBSCRIPTION_REQUIRED', r.body);
    r = await chat('tok_' + k, { context: { page: 'performance' } });
    check(`${k}: same request WITHOUT the surface field → still 403`, r.status === 403);
    r = await chat('tok_' + k, { context: 'Campaign: X' });
    check(`${k}: legacy string context → 403`, r.status === 403);
    r = await chat('tok_' + k, { message: 'Make the headline shorter', context: { page: 'ad-workspace', currentCampaign: { campaignName: 'Autumn Sale', platform: 'meta' } } });
    check(`${k}: Create’s ad editor → 403 too (no free assistant left)`, r.status === 403);
  }
  check('nothing was sent to the AI provider for refused requests', ai.bodies.length === 0);
  check('refused requests are not charged', bal('free') === 1000 && bal('expired') === 1000);

  let r = await chat('tok_paid', { surface: 'oriven-chat', context: { page: 'performance' } });
  check('period plan → answered', r.status === 200 && r.body.reply, r.body);
  const fullPrompt = ai.bodies[ai.bodies.length - 1].messages[0].content;
  check('assistant prompt has the full tool catalog', /TOOLS AVAILABLE/.test(fullPrompt) && /pause_campaign/.test(fullPrompt));
  check('…and tells the assistant this plan includes Priority Support', /This user's plan includes Priority Support/.test(fullPrompt) && !/Professional plan|Creator and Professional/.test(fullPrompt));
  r = await chat('tok_starter', { context: { page: 'performance' } });
  check('legacy Starter (still running) → answered: the same product as every paid plan', r.status === 200 && r.body.reply);
  const n0 = ai.bodies.length;
  r = await chat('tok_starter', { message: 'Make the headline shorter', context: { page: 'ad-workspace', currentCampaign: { campaignName: 'Autumn Sale', platform: 'meta' } } });
  const edPrompt = ai.bodies[n0] && ai.bodies[n0].messages[0].content;
  check('legacy Starter in Create’s ad editor → the full assistant (no restricted mode needed)', r.status === 200 && /TOOLS AVAILABLE/.test(edPrompt || '') && !/ad editor inside ORIVEN Create/.test(edPrompt || ''));
  const n1 = ai.bodies.length;
  r = await chat('tok_paid', { mode: 'research-followup', context: { research: { question: 'Coffee market NL', summary: 'Growing.' } } });
  const rsPrompt = ai.bodies[n1] && ai.bodies[n1].messages[0].content;
  check('research follow-up with a market map → served in one model call, no tool catalog', r.status === 200 && ai.bodies.length === n1 + 1 && !!rsPrompt && !/TOOLS AVAILABLE/.test(rsPrompt));

  log('\nA2. Alternate endpoint: /api/generate-text assistant mode');
  r = await H.call('POST', '/api/generate-text', 'tok_free', { prompt: 'User: hi', type: 'assistant' });
  check('no access, generate-text type "assistant" → 403', r.status === 403, r.body);
  r = await H.call('POST', '/api/generate-text', 'tok_paid', { prompt: 'User: hi', type: 'assistant' });
  check('period plan, generate-text type "assistant" → allowed', r.status !== 403, r.status);

  // ── B. In-app notification center ────────────────────────────────
  log('\nB. In-app notification center');
  H.rows('intelligence_events').push({ id: 'ev1', user_id: id(4), type: 'campaign_action', title: 'Published', severity: 'low', dismissed: false, read: false, created_at: new Date().toISOString() },
    { id: 'ev2', user_id: id(1), type: 'campaign_action', title: 'Published', severity: 'high', dismissed: false, read: false, created_at: new Date().toISOString() });
  for (const [k, want] of [['free', 403], ['expired', 403], ['starter', 200], ['paid', 200]]) {
    r = await H.call('GET', '/api/notifications', 'tok_' + k);
    check(`GET /api/notifications — ${k} → ${want}`, r.status === want, r.status);
  }
  r = await H.call('GET', '/api/notifications', 'tok_paid');
  check('a customer sees only their own events', r.body.events.length === 1 && r.body.events[0].id === 'ev1');
  check('unauthenticated → 401', (await H.call('GET', '/api/notifications')).status === 401);
  for (const p of ['/api/intelligence/events/read-all', '/api/intelligence/events/dismiss-all', '/api/intelligence/events/ev2/read', '/api/intelligence/events/ev2/dismiss']) {
    r = await H.call('PATCH', p, 'tok_free');
    check(`no access PATCH ${p.replace('/api/intelligence/events', '')} → 403`, r.status === 403);
  }
  check('events untouched by refused calls', H.rows('intelligence_events').find((e) => e.id === 'ev2').dismissed === false);
  r = await H.call('PATCH', '/api/intelligence/events/ev2/dismiss', 'tok_paid');
  check('a customer can’t dismiss another user’s event (scoped to their own rows)', H.rows('intelligence_events').find((e) => e.id === 'ev2').dismissed === false);
  r = await H.call('PATCH', '/api/intelligence/events/read-all', 'tok_paid');
  check('mark-all-read → 200', r.status === 200 && H.rows('intelligence_events').find((e) => e.id === 'ev1').read === true);

  // ── C. Priority Support ──────────────────────────────────────────
  log('\nC. Priority Support');
  for (const k of ['free', 'expired']) {
    check(`${k}: GET thread → 403`, (await H.call('GET', '/api/support/messages', 'tok_' + k)).status === 403);
    check(`${k}: POST message → 403`, (await H.call('POST', '/api/support/messages', 'tok_' + k, { body: 'help' })).status === 403);
  }
  check('accounts without access wrote nothing', !H.rows('support_messages').length);
  r = await H.call('POST', '/api/support/messages', 'tok_paid', { body: 'My Meta campaign won’t publish.' });
  check('period plan: message sent', r.status === 200 && H.rows('support_messages').length === 1 && H.rows('support_messages')[0].user_id === id(4));
  await H.call('POST', '/api/support/messages', 'tok_paid2', { body: 'Other customer question' });
  r = await H.call('GET', '/api/support/messages', 'tok_paid');
  check('a customer only sees their own thread', r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].body.includes('Meta'));
  r = await H.call('GET', '/api/support/messages?user_id=' + id(5), 'tok_paid');
  check('a user id in the request is ignored', r.body.messages.length === 1 && !r.body.messages.some((m) => /Other customer/.test(m.body)));

  log('\nC2. Admin review and reply');
  check('non-admin: threads → 403', (await H.call('GET', '/api/support/admin/threads', 'tok_paid')).status === 403);
  check('non-admin: reply → 403', (await H.call('POST', '/api/support/admin-reply', 'tok_paid', { userId: id(5), body: 'x' })).status === 403);
  check('a client "admin" flag is ignored', (await H.call('POST', '/api/support/admin-reply', 'tok_paid', { userId: id(5), body: 'x', admin: true, isAdmin: true })).status === 403);
  check('unauthenticated admin call → 401', (await H.call('GET', '/api/support/admin/threads')).status === 401);
  r = await H.call('GET', '/api/support/admin/threads', 'tok_admin');
  check('admin (no plan needed): both threads listed, awaiting reply', r.status === 200 && r.body.threads.length === 2 && r.body.threads.every((t) => t.awaitingReply), r.body);
  r = await H.call('GET', '/api/support/admin/threads/' + id(4), 'tok_admin');
  check('admin: one thread', r.status === 200 && r.body.messages.length === 1 && r.body.email === 'paid@example.invalid');
  check('admin: invalid id → 400', (await H.call('GET', '/api/support/admin/threads/not-a-uuid', 'tok_admin')).status === 400);
  r = await H.call('POST', '/api/support/admin-reply', 'tok_admin', { userId: id(3), body: 'Hi' });
  check('admin: reply to an account without a thread → 404 (no arbitrary messages)', r.status === 404 && !H.rows('support_messages').some((m) => m.user_id === id(3)));
  r = await H.call('POST', '/api/support/admin-reply', 'tok_admin', { userId: id(4), body: 'Reconnect Meta in Control Center → Connections, then publish again.' });
  check('admin: reply stored in the customer’s thread', r.status === 200 && H.rows('support_messages').filter((m) => m.user_id === id(4) && m.sender === 'admin').length === 1);
  check('customer emailed that a reply is waiting (no reply text in the email)', r.body.email === 'sent' && resend.length === 1 && resend[0].to === 'paid@example.invalid' && !resend[0].html.includes('Reconnect Meta'), r.body);
  check('reply email ledgered', H.rows('email_sends').some((e) => e.template === 'support_reply' && e.status === 'sent'));
  r = await H.call('GET', '/api/support/messages', 'tok_paid');
  check('customer sees the reply in their thread; marked read', r.body.messages.length === 2 && r.body.messages[1].sender === 'admin' && r.body.unread === 1 && H.rows('support_messages').find((m) => m.sender === 'admin').read_by_user === true);
  check('no AI or ad-platform call was made by support', !H.net.blocked.some((u) => /graph\.facebook|googleads|tiktok|pinterest/.test(u)));

  done();
})().catch((e) => { console.error(e); process.exit(1); });
