// ════════════════════════════════════════════════════════════════
// Onboarding × payment, end to end in one in-process Postgres (PGlite):
// the REAL services/purchases.js + docs/migrations/2026-10-access-purchases.sql
// (checkout, Stripe webhook / checkout-return fulfilment, credits, access) and
// the REAL services/onboardingFlow.js + services/onboarding.js +
// docs/migrations/2026-10-onboarding-sessions.sql (unlock, completion, the
// plan written after payment for the purchased period). Checkout uses the
// plan's Stripe Price (services/pricing.js). Stripe and the AI model are
// faked (tests/helpers/pgPayments.js). No network, no Supabase, no Stripe.
//
// Covers: normal return, browser closed before confirmation, delayed webhook,
// refresh during confirmation (parallel reads), duplicate webhooks, duplicate
// checkouts, completion failing after payment (retried), access expiring
// after unlock, another account's strategy — and that credits are granted
// exactly once and never touched by onboarding.
//
// PGlite is not a dependency of this project: the test SKIPS (exit 0) unless
// it can load '@electric-sql/pglite' (point NODE_PATH at a node_modules
// folder that has it).
//
// RUN: NODE_PATH=/path/to/node_modules node tests/onboarding-payment.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) {
  console.log('SKIP — @electric-sql/pglite not found (set NODE_PATH to a node_modules folder that has it)');
  process.exit(0);
}

const MIG = path.join(__dirname, '..', 'docs', 'migrations');
const purchases = require('../services/purchases');
const pricing = require('../services/pricing');
const { BASE, adapter, installTestPrices, makeStripe } = require('./helpers/pgPayments');
const flow = require('../services/onboardingFlow');
const onboarding = require('../services/onboarding');

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 500) : '')); } }
const _log = console.log, _warn = console.warn;
console.log = (...a) => { if (/^\[(Purchases|OnboardingFlow|Activation)\]/.test(String(a[0] || ''))) return; _log(...a); };
console.warn = (...a) => { if (/^\[(Purchases|OnboardingFlow|Activation)\]/.test(String(a[0] || ''))) return; _warn(...a); };

const { stripe, S, paidSession } = makeStripe(installTestPrices(pricing));
const PLAN = { summary: 'Grow repeat candle sales in Utrecht with email and one social channel you can keep up.',
  overview: { text: 'Bloom & Wick sells hand-poured candles in Utrecht and online; the plan focuses on repeat buyers first.' },
  audience: { text: 'Local gift shoppers and interior lovers who value natural products.', segments: [{ name: 'Gift shoppers', needs: 'A personal present' }] },
  positioning: { statement: 'Hand-poured, natural candles from a local studio.', proof_points: ['Poured by hand'] },
  objectives: [{ objective: 'Grow repeat orders', measure: 'Repeat orders per month' }], channels: [{ channel: 'Email', role: 'Repeat sales', why: 'Owned audience', effort: 'low' }],
  content: { pillars: [{ name: 'Studio', ideas: ['How a candle is poured'] }], cadence: 'Weekly' }, campaigns: [{ name: 'Workshop launch', goal: 'Bookings', idea: 'Invite past buyers' }],
  priorities: ['Start an email list', 'Plan the first workshop'],
};
// The plan answers with the roadmap phases the prompt asks for (the purchased period).
let aiCalls = 0;
const aiText = async (task, system) => {
  aiCalls++;
  const m = String(system || '').match(/"roadmap":\[(.*)\]\}\s*\nRoadmap:/);
  const names = m ? Array.from(m[1].matchAll(/"phase":"([^"]+)"/g)).map((x) => x[1]) : [];
  return JSON.stringify(Object.assign({}, PLAN, { roadmap: names.map((n) => ({ phase: n, focus: 'Focus', actions: [{ step: 'Plan the ' + n + ' email', area: 'create' }, { step: 'Review ' + n + ' orders', area: 'outside' }] })) }));
};
const HOOK = { calls: 0, failNext: 0 };
const ANSWERS = { business: { name: 'Bloom & Wick', industry: 'Retail', offer: 'Candles', area: 'Utrecht', website: 'bloom.example' }, audience: { type: 'b2c', ideal: 'x', location: 'local', problem: 'x' },
  offer: { main: 'x', different: 'x', price: 'mid' }, goals: { primary: 'sales', success: 'x' }, marketing: { channels: ['none'], challenge: 'time', paidAds: 'no' }, budget: { budget: 'none', time: 'lt2', team: 'me' } };

const one = async (pg, sql, p) => (await pg.query(sql, p || [])).rows[0];
const all = async (pg, sql, p) => (await pg.query(sql, p || [])).rows;

(async () => {
  const pg = new PGlite();
  await pg.exec(BASE);
  await pg.exec(fs.readFileSync(path.join(MIG, '2026-10-access-purchases.sql'), 'utf8'));
  await pg.exec(fs.readFileSync(path.join(MIG, '2026-10-onboarding-sessions.sql'), 'utf8'));
  const db = adapter(pg);
  purchases.init({ stripe, db });
  onboarding.init({ db });
  flow.init({ db, aiText, fetchUrl: async () => ({ ok: false, code: 'timeout' }), validateUrl: () => true,
    onComplete: async (userId) => { HOOK.calls++; if (HOOK.failNext > 0) { HOOK.failNext--; throw new Error('profile write failed (test)'); } await onboarding.complete(userId, null); } });

  const profile = (id) => one(pg, 'SELECT * FROM profiles WHERE id = $1', [id]);
  const sess = (id) => one(pg, 'SELECT * FROM onboarding_sessions WHERE user_id = $1', [id]);
  const access = async (id) => { const p = await profile(id); return { subscription_status: p.subscription_status, access_expires_at: p.access_expires_at, access_plan: p.access_plan }; };
  // The plan is written after payment in the background: wait for it.
  const waitPlan = async (id) => { for (let i = 0; i < 200; i++) { const r = await sess(id); if (!r || r.plan_status !== 'generating') return; await new Promise((ok) => setTimeout(ok, 10)); } };
  const getPlan = async (id) => { await flow.getPlan(id, await access(id)); await waitPlan(id); return flow.getPlan(id, await access(id)); };
  async function newUser() {
    const id = crypto.randomUUID();
    await pg.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await pg.query('INSERT INTO profiles (id, email) VALUES ($1, $2)', [id, id.slice(0, 8) + '@example.invalid']);
    await flow.saveProgress(id, { answers: ANSWERS, assistant: 'nova', step: 'paywall' });
    return { id, email: id.slice(0, 8) + '@example.invalid' };
  }
  async function buy(user, planId) {
    const r = await purchases.createCheckout({ user, planId, successUrl: 'https://x/app?success=true&session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/app' });
    return { r, created: S.created[S.created.length - 1] };
  }

  // ── 1. Normal: pay, webhook, browser returns ──────────────────
  console.log('\n1. Payment succeeds, the browser returns normally');
  const a = await newUser();
  check('1.1 before payment: answers saved, no plan generated, no AI call, no credits', (await sess(a.id)).plan_status === 'none' && aiCalls === 0 && (await profile(a.id)).credits_balance === 0);
  let g = await getPlan(a.id);
  check('1.2 before payment: locked, no plan content', g.locked === true && !g.plan);
  const A1 = await buy(a, 'monthly');
  let out = await purchases.onCheckoutCompleted(paidSession(A1.created));
  const sync = await purchases.fulfillFromSession(paidSession(A1.created)); // the checkout-return sync arrives too
  g = await getPlan(a.id);
  let s = await sess(a.id), p = await profile(a.id);
  check('1.3 webhook + checkout-return sync: fulfilled once (1,750 credits), access active', out.fulfilled && !sync.fulfilled && p.credits_balance === 1750 && p.subscription_status === 'paid', { out, sync, bal: p.credits_balance });
  check('1.4 the plan is written after payment for Monthly (4 weekly phases); purchase reference = this purchase; onboarding completed', g.locked === false && g.plan && g.plan.horizon.period === 'monthly' && g.plan.roadmap.length === 4 && s.purchase_id === A1.r.purchaseId && s.status === 'completed' && p.onboarding_completed === true);
  check('1.5 one AI call for the plan; unlocking changed no credits', p.credits_balance === 1750 && aiCalls === 1);

  // ── 2/3. Browser closed before confirmation; delayed webhook ──
  console.log('\n2–3. Browser closed before confirmation · webhook delayed');
  const b = await newUser();
  const B1 = await buy(b, 'flex');
  g = await getPlan(b.id); // user is back (or never left) before Stripe's webhook
  check('2.1 payment made but not yet confirmed: still locked, nothing granted', g.locked === true && !g.plan && (await profile(b.id)).credits_balance === 0);
  out = await purchases.onCheckoutCompleted(paidSession(B1.created)); // the webhook arrives later; no browser involved
  check('2.2 the webhook alone fulfils the purchase (browser closed)', out.fulfilled && (await profile(b.id)).credits_balance === 1050);
  g = await getPlan(b.id); // next visit, from any device
  check('3.1 next visit after the delayed webhook: unlocked and completed', g.locked === false && (await sess(b.id)).status === 'completed' && (await profile(b.id)).onboarding_completed === true);

  // ── 4. Refresh during confirmation: parallel reads ────────────
  console.log('\n4. Refresh during confirmation (parallel reads)');
  const c = await newUser();
  const C1 = await buy(c, 'monthly');
  await purchases.onCheckoutCompleted(paidSession(C1.created));
  const h0 = HOOK.calls;
  const reads = await Promise.all([1, 2, 3, 4, 5].map(() => getPlan(c.id)));
  s = await sess(c.id);
  check('4.1 five parallel reads: all unlocked, one unlock time, completion ran once', reads.every((x) => x.locked === false && x.plan) && new Set(reads.map((x) => new Date(x.unlockedAt).toISOString())).size === 1 && HOOK.calls === h0 + 1 && s.status === 'completed', { calls: HOOK.calls - h0, status: s.status, locked: reads.map((x) => x.locked) });
  check('4.2 …and credits granted once', (await profile(c.id)).credits_balance === 1750);

  // ── 5. Duplicate webhook delivery ──────────────────────────────
  console.log('\n5. Duplicate webhook delivery');
  for (let i = 0; i < 3; i++) await purchases.onCheckoutCompleted(paidSession(C1.created));
  await purchases.fulfillFromSession(paidSession(C1.created));
  const paidRows = await all(pg, "SELECT id FROM purchases WHERE user_id = $1 AND status = 'paid'", [c.id]);
  check('5.1 three more webhooks + a sync: still one paid purchase, 1,750 credits, purchase reference unchanged', paidRows.length === 1 && (await profile(c.id)).credits_balance === 1750 && (await sess(c.id)).purchase_id === C1.r.purchaseId);
  const before = (await sess(c.id)).unlocked_at;
  await getPlan(c.id);
  check('5.2 later reads don’t rewrite the unlock or rerun completion', String((await sess(c.id)).unlocked_at) === String(before) && HOOK.calls === h0 + 1);

  // ── 6. Duplicate checkout requests ─────────────────────────────
  console.log('\n6. Duplicate checkout requests (two tabs / double click)');
  const d = await newUser();
  const D1 = await buy(d, 'monthly');
  const D2 = await buy(d, 'monthly');
  const pend = await all(pg, 'SELECT id, status FROM purchases WHERE user_id = $1 ORDER BY created_at', [d.id]);
  check('6.1 the newer checkout expires the older one (Stripe and database)', S.expired.includes(D1.created.id) && pend.filter((x) => x.status === 'pending').length === 1, pend);
  await purchases.onCheckoutCompleted(paidSession(D2.created));
  g = await getPlan(d.id);
  check('6.2 paying the open checkout: one paid purchase, unlocked with that reference', g.locked === false && (await sess(d.id)).purchase_id === D2.r.purchaseId && (await profile(d.id)).credits_balance === 1750);

  // ── 7. Completion fails after payment ──────────────────────────
  console.log('\n7. Payment succeeds but completing onboarding fails');
  const e = await newUser();
  const E1 = await buy(e, 'monthly');
  await purchases.onCheckoutCompleted(paidSession(E1.created));
  HOOK.failNext = 1;
  const h1 = HOOK.calls;
  g = await flow.getPlan(e.id, await access(e.id)); // one read: completion fails
  await waitPlan(e.id);
  s = await sess(e.id); p = await profile(e.id);
  check('7.1 the customer paid: unlocked, unlock recorded, the plan still written', g.locked === false && s.plan_status === 'ready' && !!s.unlocked_at && s.purchase_id === E1.r.purchaseId);
  check('7.2 completion not marked done, so it will be retried', s.status !== 'completed' && p.onboarding_completed !== true && HOOK.calls === h1 + 1, { status: s.status });
  g = await getPlan(e.id);
  s = await sess(e.id); p = await profile(e.id);
  check('7.3 next read retries and completes; account no longer “in onboarding”', s.status === 'completed' && p.onboarding_completed === true && HOOK.calls === h1 + 2);
  await getPlan(e.id);
  check('7.4 once completed, it isn’t run again', HOOK.calls === h1 + 2);
  const st = await onboarding.getState(e.id);
  check('7.5 onboarding state after completion: not eligible (the flow won’t reopen)', st.eligible === false && st.completed === true);

  // ── 8. Access expires after unlock ─────────────────────────────
  console.log('\n8. Access expires after the plan was unlocked');
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '1 minute' WHERE id = $1", [a.id]);
  g = await getPlan(a.id);
  check('8.1 locked again: no plan content; unlock history kept', g.locked === true && !g.plan && !!(await sess(a.id)).unlocked_at);
  const A2 = await buy(a, 'flex');
  await purchases.onCheckoutCompleted(paidSession(A2.created));
  g = await getPlan(a.id);
  check('8.2 buying a new period unlocks it again (the existing plan is kept: no new AI call)', g.locked === false && g.plan && aiCalls === 5, aiCalls);

  // ── 9. Another account's strategy ──────────────────────────────
  console.log('\n9. Another account');
  const f = { id: crypto.randomUUID(), email: 'f@example.invalid' };
  await pg.query('INSERT INTO auth.users (id) VALUES ($1)', [f.id]);
  await pg.query('INSERT INTO profiles (id, email) VALUES ($1, $2)', [f.id, f.email]);
  const F1 = await buy(f, 'monthly');
  await purchases.onCheckoutCompleted(paidSession(F1.created));
  g = await getPlan(f.id);
  check('9.1 a paying account without onboarding answers gets no plan (only its own row is ever read) — it is offered the missing-plan recovery instead', g.onboarding === false && !g.plan && g.status === 'none' && g.recovery === true, g);
  const tamper = await purchases.onCheckoutCompleted(paidSession(F1.created, { client_reference_id: a.id }));
  check('9.2 a webhook naming another account (identity mismatch) grants nothing', !tamper.fulfilled);

  console.log('\nZ. Totals');
  check('Z.1 one AI call per account with onboarding answers (5), each after its payment; none on later reads', aiCalls === 5, aiCalls);
  check('Z.2 no onboarding row was ever created for an account by payment alone', !(await sess(f.id)));

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
