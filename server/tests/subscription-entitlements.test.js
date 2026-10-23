// ════════════════════════════════════════════════════════════════
// Subscription entitlements, enforced on the server (not just the UI):
//   Oriven Chat (Creator, Professional) — incl. alternate payloads/endpoints
//   In-app notification center (Creator, Professional)
//   Priority Support (Professional) + admin review/reply + reply email
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
  const plans = { free: 1, starter: 2, creator: 3, professional: 4, pro2: 5 };
  for (const [k, n] of Object.entries(plans)) {
    const plan = k === 'pro2' ? 'professional' : k;
    H.rows('profiles').push({ id: id(n), email: k + '@example.invalid', subscription_status: plan, credits_balance: 1000, credits_cycle_end: new Date(Date.now() + 20 * 864e5).toISOString(), preferences: { language: 'en' } });
    H.TOKENS['tok_' + k] = { id: id(n), email: k + '@example.invalid' };
  }
  H.rows('profiles').push({ id: ADMIN, email: 'owner@example.invalid', subscription_status: 'starter', credits_balance: 0 });
  H.TOKENS.tok_admin = { id: ADMIN, email: 'owner@example.invalid' };
  const chat = (tok, body) => H.call('POST', '/api/ai/chat', tok, Object.assign({ message: 'What should I do about my campaigns?' }, body || {}));

  // ── A. Oriven Chat ───────────────────────────────────────────────
  log('\nA. Oriven Chat — server-side entitlement');
  let r = await chat('tok_starter', { surface: 'oriven-chat', context: { page: 'performance' } });
  check('Starter, chat panel payload → 403 PLAN_REQUIRED', r.status === 403 && r.body.code === 'PLAN_REQUIRED' && r.body.feature === 'orivenChat', r.body);
  r = await chat('tok_starter', { context: { page: 'performance' } });
  check('Starter, same request WITHOUT the surface field → still 403 (gap closed)', r.status === 403 && r.body.code === 'PLAN_REQUIRED', r.body);
  r = await chat('tok_starter', { context: 'Campaign: X' });
  check('Starter, legacy string context → 403', r.status === 403);
  r = await chat('tok_starter', { mode: 'research-followup', context: { page: 'research' } });
  check('Starter, research-followup without a market map → 403', r.status === 403);
  r = await chat('tok_free', { context: {} });
  check('Free → refused (no paid plan)', r.status === 403);
  check('nothing was sent to the AI provider for refused requests', ai.bodies.length === 0);
  const balBefore = H.rows('profiles').find((p) => p.id === id(2)).credits_balance;
  check('refused requests are not charged', balBefore === 1000);

  r = await chat('tok_creator', { surface: 'oriven-chat', context: { page: 'performance' } });
  check('Creator → answered', r.status === 200 && r.body.reply, r.body);
  r = await chat('tok_professional', { context: { page: 'performance' } });
  check('Professional → answered (surface not needed)', r.status === 200 && r.body.reply);
  const fullPrompt = ai.bodies[ai.bodies.length - 1].messages[0].content;
  check('assistant prompt has the full tool catalog', /TOOLS AVAILABLE/.test(fullPrompt) && /pause_campaign/.test(fullPrompt));

  const n0 = ai.bodies.length;
  r = await chat('tok_starter', { message: 'Make the headline shorter', context: { page: 'ad-workspace', currentCampaign: { campaignName: 'Autumn Sale', platform: 'meta' } } });
  const edPrompt = ai.bodies[n0] && ai.bodies[n0].messages[0].content;
  check('Starter in Create’s ad editor → served (workflow feature kept)', r.status === 200 && !!edPrompt, r.body);
  check('…restricted prompt: only this ad, Oriven Chat named for anything else', /ad editor inside ORIVEN Create/.test(edPrompt || '') && /Oriven Chat, available on the Creator and Professional plans/.test(edPrompt || ''));
  check('…only ad-editing tools in the catalog', /- edit_ad_copy:/.test(edPrompt || '') && !/- (pause_campaign|delete_campaign|create_campaign_package|remember_business_fact|publish_[a-z]+_campaign):/.test(edPrompt || ''));
  check('…no assistant context (business knowledge, accounts, workspace)', !/BUSINESS KNOWLEDGE|CONNECTED AD ACCOUNTS|Workspace state/.test(edPrompt || ''));
  const n1 = ai.bodies.length;
  r = await chat('tok_starter', { mode: 'research-followup', context: { research: { question: 'Coffee market NL', summary: 'Growing.' } } });
  const rsPrompt = ai.bodies[n1] && ai.bodies[n1].messages[0].content;
  check('Starter research follow-up with a market map → served, map-only prompt, no tools', r.status === 200 && /one ORIVEN Research market map/.test(rsPrompt || '') && !/TOOLS AVAILABLE/.test(rsPrompt || ''));

  log('\nA2. Alternate endpoint: /api/generate-text assistant mode');
  r = await H.call('POST', '/api/generate-text', 'tok_starter', { prompt: 'User: hi', type: 'assistant' });
  check('Starter, generate-text type "assistant" → 403', r.status === 403 && r.body.feature === 'orivenChat', r.body);
  r = await H.call('POST', '/api/generate-text', 'tok_creator', { prompt: 'User: hi', type: 'assistant' });
  check('Creator, generate-text type "assistant" → allowed', r.status !== 403, r.status);

  // ── B. In-app notification center ────────────────────────────────
  log('\nB. In-app notification center');
  H.rows('intelligence_events').push({ id: 'ev1', user_id: id(3), type: 'campaign_action', title: 'Published', severity: 'low', dismissed: false, read: false, created_at: new Date().toISOString() },
    { id: 'ev2', user_id: id(2), type: 'campaign_action', title: 'Published', severity: 'high', dismissed: false, read: false, created_at: new Date().toISOString() });
  for (const [k, want] of [['free', 403], ['starter', 403], ['creator', 200], ['professional', 200]]) {
    r = await H.call('GET', '/api/notifications', 'tok_' + k);
    check(`GET /api/notifications — ${k} → ${want}`, r.status === want, r.status);
  }
  r = await H.call('GET', '/api/notifications', 'tok_creator');
  check('Creator sees only their own events', r.body.events.length === 1 && r.body.events[0].id === 'ev1');
  check('unauthenticated → 401', (await H.call('GET', '/api/notifications')).status === 401);
  for (const p of ['/api/intelligence/events/read-all', '/api/intelligence/events/dismiss-all', '/api/intelligence/events/ev2/read', '/api/intelligence/events/ev2/dismiss']) {
    r = await H.call('PATCH', p, 'tok_starter');
    check(`Starter PATCH ${p.replace('/api/intelligence/events', '')} → 403`, r.status === 403);
  }
  check('Starter’s events untouched by refused calls', H.rows('intelligence_events').find((e) => e.id === 'ev2').dismissed === false);
  r = await H.call('PATCH', '/api/intelligence/events/ev2/dismiss', 'tok_creator');
  check('Creator can’t dismiss another user’s event (scoped to their own rows)', H.rows('intelligence_events').find((e) => e.id === 'ev2').dismissed === false);
  r = await H.call('PATCH', '/api/intelligence/events/read-all', 'tok_creator');
  check('Creator mark-all-read → 200', r.status === 200 && H.rows('intelligence_events').find((e) => e.id === 'ev1').read === true);
  r = await H.call('GET', '/api/intelligence/events?days=7', 'tok_starter');
  check('the shared activity feed (Campaigns, Control Center) still works for Starter', r.status === 200 && r.body.events.length === 1);

  // ── C. Priority Support ──────────────────────────────────────────
  log('\nC. Priority Support');
  for (const k of ['free', 'starter', 'creator']) {
    check(`${k}: GET thread → 403`, (await H.call('GET', '/api/support/messages', 'tok_' + k)).status === 403);
    check(`${k}: POST message → 403`, (await H.call('POST', '/api/support/messages', 'tok_' + k, { body: 'help' })).status === 403);
  }
  check('Starter wrote nothing', !H.rows('support_messages').length);
  r = await H.call('POST', '/api/support/messages', 'tok_professional', { body: 'My Meta campaign won’t publish.' });
  check('Professional: message sent', r.status === 200 && H.rows('support_messages').length === 1 && H.rows('support_messages')[0].user_id === id(4));
  await H.call('POST', '/api/support/messages', 'tok_pro2', { body: 'Other customer question' });
  r = await H.call('GET', '/api/support/messages', 'tok_professional');
  check('a customer only sees their own thread', r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].body.includes('Meta'));
  r = await H.call('GET', '/api/support/messages?user_id=' + id(5), 'tok_professional');
  check('a user id in the request is ignored', r.body.messages.length === 1 && !r.body.messages.some((m) => /Other customer/.test(m.body)));

  log('\nC2. Admin review and reply');
  check('non-admin: threads → 403', (await H.call('GET', '/api/support/admin/threads', 'tok_professional')).status === 403);
  check('non-admin: reply → 403', (await H.call('POST', '/api/support/admin-reply', 'tok_professional', { userId: id(5), body: 'x' })).status === 403);
  check('a client "admin" flag is ignored', (await H.call('POST', '/api/support/admin-reply', 'tok_professional', { userId: id(5), body: 'x', admin: true, isAdmin: true })).status === 403);
  check('unauthenticated admin call → 401', (await H.call('GET', '/api/support/admin/threads')).status === 401);
  r = await H.call('GET', '/api/support/admin/threads', 'tok_admin');
  check('admin: both threads listed, awaiting reply', r.status === 200 && r.body.threads.length === 2 && r.body.threads.every((t) => t.awaitingReply), r.body);
  r = await H.call('GET', '/api/support/admin/threads/' + id(4), 'tok_admin');
  check('admin: one thread', r.status === 200 && r.body.messages.length === 1 && r.body.email === 'professional@example.invalid');
  check('admin: invalid id → 400', (await H.call('GET', '/api/support/admin/threads/not-a-uuid', 'tok_admin')).status === 400);
  r = await H.call('POST', '/api/support/admin-reply', 'tok_admin', { userId: id(3), body: 'Hi' });
  check('admin: reply to an account without a thread → 404 (no arbitrary messages)', r.status === 404 && !H.rows('support_messages').some((m) => m.user_id === id(3)));
  r = await H.call('POST', '/api/support/admin-reply', 'tok_admin', { userId: id(4), body: 'Reconnect Meta in Control Center → Connections, then publish again.' });
  check('admin: reply stored in the customer’s thread', r.status === 200 && H.rows('support_messages').filter((m) => m.user_id === id(4) && m.sender === 'admin').length === 1);
  check('customer emailed that a reply is waiting (no reply text in the email)', r.body.email === 'sent' && resend.length === 1 && resend[0].to === 'professional@example.invalid' && !resend[0].html.includes('Reconnect Meta'), r.body);
  check('reply email ledgered', H.rows('email_sends').some((e) => e.template === 'support_reply' && e.status === 'sent'));
  r = await H.call('GET', '/api/support/messages', 'tok_professional');
  check('customer sees the reply in their thread; marked read', r.body.messages.length === 2 && r.body.messages[1].sender === 'admin' && r.body.unread === 1 && H.rows('support_messages').find((m) => m.sender === 'admin').read_by_user === true);
  check('no AI or ad-platform call was made by support', !H.net.blocked.some((u) => /graph\.facebook|googleads|tiktok|pinterest/.test(u)));

  done();
})().catch((e) => { console.error(e); process.exit(1); });
