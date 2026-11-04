// ════════════════════════════════════════════════════════════════
// Payment lifecycle audit, in one in-process Postgres (PGlite): the REAL
// docs/migrations SQL (fulfill_purchase, grant_due_credit_instalments,
// expire_access, revoke_purchase, _end_access) and services/purchases.js.
// Time is moved by rewriting timestamps (access ends, grant dates), never by
// waiting. Stripe is faked (tests/helpers/pgPayments.js). No network, no
// Supabase, no Stripe, no real customer.
//
// Covers: migrations safe to re-run (records kept); a failing fulfilment rolls
// back completely; early renewal for all five plans (period, credits,
// schedule); delayed / repeated instalment jobs; expiry (what expires, what
// survives, repeats); refunds and disputes (current, stacked, old purchases;
// duplicates; partial; won disputes).
//
// SKIPS (exit 0) unless '@electric-sql/pglite' can be loaded (NODE_PATH).
// RUN: NODE_PATH=/path/to/node_modules node tests/payment-lifecycle.test.js   (from server/)
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
const pricing = require('../services/pricing');
const purchases = require('../services/purchases');
const { BASE, adapter, installTestPrices, makeStripe } = require('./helpers/pgPayments');
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 700) : '')); } }
const _log = console.log, _warn = console.warn;
console.log = (...a) => { if (/^\[Purchases\]/.test(String(a[0] || ''))) return; _log(...a); };
console.warn = (...a) => { if (/^\[Purchases\]/.test(String(a[0] || ''))) return; _warn(...a); };
const { stripe, S, paidSession } = makeStripe(installTestPrices(pricing));
const PER = { flex: 1050, monthly: 1750, quarterly: 1600, semiannual: 1475, annual: 1250 };
const INST = { flex: 1, monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const sql = (f) => fs.readFileSync(path.join(MIG, f), 'utf8');

(async () => {
  const pg = new PGlite();
  const one = async (q, p) => (await pg.query(q, p || [])).rows[0];
  const all = async (q, p) => (await pg.query(q, p || [])).rows;
  await pg.exec(BASE);

  // ── 1. Migrations: order, re-run, records kept ─────────────────
  console.log('\n1. Migrations');
  await pg.exec(sql('2026-10-stripe-webhook-events.sql'));
  await pg.exec(sql('2026-10-access-purchases.sql'));
  await pg.exec(sql('2026-10-onboarding-sessions.sql'));
  const u0 = crypto.randomUUID();
  await pg.query('INSERT INTO auth.users (id) VALUES ($1)', [u0]);
  await pg.query("INSERT INTO profiles (id, email, subscription_status, credits_balance, credits_cycle_end) VALUES ($1, 'legacy@example.invalid', 'starter', 640, now() + interval '9 days')", [u0]);
  await pg.query("INSERT INTO stripe_webhook_events (id, type, status) VALUES ('evt_keep', 'checkout.session.completed', 'processed')");
  const p0 = crypto.randomUUID();
  await pg.query("INSERT INTO purchases (id, user_id, plan_id, status, price_incl_vat_cents, duration_months, credits_total, instalments) VALUES ($1, $2, 'monthly', 'pending', 2900, 1, 1750, 1)", [p0, u0]);
  let rerunErr = null;
  try {
    await pg.exec(sql('2026-10-stripe-webhook-events.sql'));
    await pg.exec(sql('2026-10-access-purchases.sql'));
    await pg.exec(sql('2026-10-onboarding-sessions.sql'));
  } catch (e) { rerunErr = e.message; }
  const legacy = await one('SELECT * FROM profiles WHERE id = $1', [u0]);
  check('1.1 all three migrations re-run without error on an already-migrated database', !rerunErr, rerunErr);
  check('1.2 re-running keeps existing records (purchase, webhook event) and doesn’t touch a legacy subscriber twice', (await all('SELECT id FROM purchases WHERE id = $1', [p0])).length === 1 && (await all("SELECT id FROM stripe_webhook_events WHERE id = 'evt_keep'")).length === 1 && legacy.credits_balance === 640 && legacy.access_plan === 'starter');
  const ent0 = await one('SELECT kind, status, ends_at FROM legacy_entitlements WHERE user_id = $1', [u0]);
  const snap0 = await one('SELECT credits_balance, classification FROM legacy_transition_snapshot WHERE user_id = $1', [u0]);
  check('1.3 the legacy subscriber got an explicit entitlement (manual, active, no end date) and access at least 7 days ahead — not derived from credits_cycle_end; credits untouched and snapshotted', ent0 && ent0.kind === 'manual' && ent0.status === 'active' && ent0.ends_at === null && new Date(legacy.access_expires_at) - Date.now() > 6.9 * 864e5 && legacy.credits_balance === 640 && snap0 && snap0.credits_balance === 640 && snap0.classification === 'legacy_manual', { ent0, snap0, exp: legacy.access_expires_at });
  let orderErr = null;
  try { const pg2 = new PGlite(); await pg2.exec(BASE); await pg2.exec(sql('2026-10-onboarding-sessions.sql')); } catch (e) { orderErr = e.message; }
  check('1.4 order matters: onboarding-sessions before access-purchases fails clearly (it references purchases)', !!orderErr && /purchases/.test(orderErr), orderErr);
  const dupEvent = await (async () => { try { await pg.query("INSERT INTO stripe_webhook_events (id, type) VALUES ('evt_keep', 'x')"); return null; } catch (e) { return e.message; } })();
  const dupSession = await (async () => { try { await pg.query("UPDATE purchases SET stripe_checkout_session_id = 'cs_dup' WHERE id = $1", [p0]); const p1 = crypto.randomUUID(); await pg.query("INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, credits_total, instalments, stripe_checkout_session_id) VALUES ($1, $2, 'monthly', 2900, 1, 1750, 1, 'cs_dup')", [p1, u0]); return null; } catch (e) { return e.message; } })();
  check('1.5 unique constraints hold: a webhook event id once; a Checkout Session id on one purchase only', /duplicate key|unique/i.test(dupEvent || '') && /duplicate key|unique/i.test(dupSession || ''), { dupEvent, dupSession });
  const badCredits = await (async () => { try { await pg.query("INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, credits_total, instalments) VALUES ($1, $2, 'quarterly', 7800, 3, 4801, 3)", [crypto.randomUUID(), u0]); return null; } catch (e) { return e.message; } })();
  const badPlan = await (async () => { try { await pg.query("INSERT INTO purchases (id, user_id, plan_id, price_incl_vat_cents, duration_months, credits_total, instalments) VALUES ($1, $2, 'lifetime', 100, 1, 10, 1)", [crypto.randomUUID(), u0]); return null; } catch (e) { return e.message; } })();
  check('1.6 checks hold: credits must split evenly into instalments; only the five plan ids', /check/i.test(badCredits || '') && /check/i.test(badPlan || ''));
  await pg.query("DELETE FROM purchases WHERE id = $1", [p0]);

  const db = adapter(pg);
  purchases.init({ stripe, db });
  const profile = (id) => one('SELECT * FROM profiles WHERE id = $1', [id]);
  const rows = (id) => all('SELECT * FROM purchases WHERE user_id = $1 ORDER BY created_at', [id]);
  const grants = (pid) => all('SELECT * FROM credit_grants WHERE purchase_id = $1 ORDER BY instalment', [pid]);
  const ledger = (id) => all('SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY id', [id]);
  async function user(extra) {
    const id = crypto.randomUUID();
    await pg.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
    await pg.query('INSERT INTO profiles (id, email) VALUES ($1, $2)', [id, id.slice(0, 8) + '@example.invalid']);
    if (extra) await pg.query('UPDATE profiles SET ' + extra + ' WHERE id = $1', [id]);
    return { id, email: id.slice(0, 8) + '@example.invalid' };
  }
  async function buy(u, planId, over) {
    await purchases.createCheckout({ user: u, planId, successUrl: 'https://x/ok?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/no' });
    const c = S.created[S.created.length - 1];
    const r = await purchases.onCheckoutCompleted(paidSession(c, over));
    const row = (await rows(u.id)).filter((x) => x.stripe_checkout_session_id === c.id)[0];
    return { r, row, c };
  }
  // Move one paid purchase (and the profile's access end) so it ends in `days` days.
  async function endsIn(u, pid, days) {
    await pg.query(`UPDATE purchases SET access_start = now() - interval '20 days', access_end = now() + ($2 || ' days')::interval WHERE id = $1`, [pid, String(days)]);
    // the same instant as the purchase's end (two statements' now() can differ)
    await pg.query(`UPDATE profiles SET access_expires_at = (SELECT access_end FROM purchases WHERE id = $2) WHERE id = $1`, [u.id, pid]);
  }
  const ms = (a) => new Date(a).getTime();

  // ── 2. Atomicity ────────────────────────────────────────────────
  console.log('\n2. A failing fulfilment rolls back completely');
  const a = await user();
  await purchases.createCheckout({ user: a, planId: 'quarterly', successUrl: 'https://x', cancelUrl: 'https://x' });
  const ac = S.created[S.created.length - 1];
  await pg.exec(`CREATE OR REPLACE FUNCTION _test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger write failed (test)'; END $$;
    CREATE TRIGGER _test_boom BEFORE INSERT ON credit_ledger FOR EACH ROW EXECUTE FUNCTION _test_boom();`);
  let boom = null; try { await purchases.onCheckoutCompleted(paidSession(ac)); } catch (e) { boom = e.message; }
  const aRow = (await rows(a.id))[0], aProf = await profile(a.id);
  check('2.1 an error in the last step of fulfil_purchase (ledger insert) undoes everything: purchase still pending, no access, no credits, no grants', /ledger write failed/.test(boom || '') && aRow.status === 'pending' && !aProf.access_expires_at && aProf.credits_balance === 0 && (await grants(aRow.id)).length === 0, { boom, status: aRow.status, bal: aProf.credits_balance });
  await pg.exec('DROP TRIGGER _test_boom ON credit_ledger; DROP FUNCTION _test_boom();');
  const retry = await purchases.onCheckoutCompleted(paidSession(ac));
  check('2.2 Stripe’s retry then fulfils it normally, once', retry.fulfilled && (await profile(a.id)).credits_balance === 1600 && (await grants(aRow.id)).length === 3);

  // ── 3. Early renewal, every plan ───────────────────────────────
  console.log('\n3. Early renewal (current Monthly with 10 days left, 500 credits unused)');
  for (const planId of pricing.PLAN_ORDER) {
    const u = await user();
    const first = await buy(u, 'monthly');
    await endsIn(u, first.row.id, 10);
    await pg.query('UPDATE profiles SET credits_balance = 500 WHERE id = $1', [u.id]); // they spent 1,250 of 1,750
    const oldEnd = (await profile(u.id)).access_expires_at;
    const b = await buy(u, planId);
    const p = await profile(u.id), g = await grants(b.row.id);
    const expEnd = pricing.accessEnd(pricing.PLANS[planId], new Date(oldEnd));
    check(`3.${planId}.a renewal starts when the current period ends (no days lost) and runs its full length`, ms(b.row.access_start) === ms(oldEnd) && Math.abs(ms(b.row.access_end) - ms(expEnd)) < 1000 && ms(p.access_expires_at) === ms(b.row.access_end), { start: b.row.access_start, oldEnd, end: b.row.access_end });
    check(`3.${planId}.b the unused 500 credits stay; +${PER[planId]} now (1/${INST[planId]})`, p.credits_balance === 500 + PER[planId], p.credits_balance);
    check(`3.${planId}.c the rest is scheduled against THIS purchase, monthly from the new start, all before the new end`, g.length === INST[planId] && g.every((x) => x.user_id === u.id && x.credits === PER[planId]) && g.slice(1).every((x, i) => x.status === 'scheduled' && Math.abs(ms(x.grant_at) - ms(pricing.accessEnd({ months: i + 1, days: 0 }, new Date(oldEnd)))) < 1000 && ms(x.grant_at) < ms(b.row.access_end)), g.map((x) => [x.instalment, x.status, x.grant_at]));
    check(`3.${planId}.d the earlier purchase is untouched (still paid, same period, its grant kept)`, (await rows(u.id))[0].status === 'paid' && (await grants(first.row.id))[0].status === 'granted');
  }
  // Two renewals in a row stack end to end.
  const st = await user();
  const s1 = await buy(st, 'monthly'); await endsIn(st, s1.row.id, 5);
  const s1end = (await rows(st.id))[0].access_end;
  const s2 = await buy(st, 'quarterly'), s3 = await buy(st, 'flex');
  check('3.z two renewals stack end to end: each starts where the previous ends', ms(s2.row.access_start) === ms(s1end) && ms(s3.row.access_start) === ms(s2.row.access_end) && ms((await profile(st.id)).access_expires_at) === ms(s3.row.access_end));

  // ── 4. Instalment job ──────────────────────────────────────────
  console.log('\n4. Scheduled monthly grants');
  const an = await user();
  const ap = (await buy(an, 'annual')).row;
  await pg.query("UPDATE credit_grants SET grant_at = now() - interval '1 hour' WHERE purchase_id = $1 AND instalment IN (1, 2, 3)", [ap.id]); // job was down for 3 months
  const n1 = await purchases.grantDueInstalments();
  const n2 = await purchases.grantDueInstalments();
  const g4 = await grants(ap.id);
  check('4.1 a job that was down catches up: the 3 overdue instalments are granted once each (+3,750), later ones stay scheduled', n1 >= 3 && n2 === 0 && (await profile(an.id)).credits_balance === 1250 * 4 && g4.filter((x) => x.status === 'granted').length === 4 && g4.filter((x) => x.status === 'scheduled').length === 8);
  await pg.query("UPDATE credit_grants SET grant_at = now() - interval '1 hour' WHERE purchase_id = $1", [ap.id]);
  await purchases.grantDueInstalments(); await purchases.grantDueInstalments();
  check('4.2 even if every date is overdue, the purchase never gives more than its 15,000 credits', (await profile(an.id)).credits_balance === 15000 && (await all("SELECT SUM(delta)::int AS s FROM credit_ledger WHERE purchase_id = $1 AND kind = 'grant'", [ap.id]))[0].s === 15000);
  const lapse = await user();
  const lp = (await buy(lapse, 'quarterly')).row;
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '1 minute' WHERE id = $1", [lapse.id]);
  await pg.query("UPDATE credit_grants SET grant_at = now() - interval '2 minutes' WHERE purchase_id = $1 AND instalment = 1", [lp.id]);
  const bal0 = (await profile(lapse.id)).credits_balance;
  await purchases.grantDueInstalments();
  check('4.3 an instalment that comes due after access has ended is cancelled, not granted', (await grants(lp.id))[1].status === 'cancelled' && (await profile(lapse.id)).credits_balance === bal0);

  // ── 5. Expiry ──────────────────────────────────────────────────
  console.log('\n5. Expiry');
  const ex = await user();
  const exr = (await buy(ex, 'quarterly')).row;
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '1 minute', credits_balance = 700 WHERE id = $1", [ex.id]);
  await purchases.expireAccess(); await purchases.expireAccess();
  const exP = await profile(ex.id), exL = (await ledger(ex.id)).filter((x) => x.kind === 'expire');
  check('5.1 when access ends, the whole remaining balance expires once (one ledger entry, −700), status free, future instalments cancelled', exP.credits_balance === 0 && exP.subscription_status === 'free' && exL.length === 1 && exL[0].delta === -700 && (await grants(exr.id)).slice(1).every((x) => x.status === 'cancelled'));
  const act = await user();
  await buy(act, 'monthly');
  const before5 = await profile(act.id);
  await purchases.expireAccess();
  check('5.2 an account with access is never touched by the expiry job', (await profile(act.id)).credits_balance === before5.credits_balance && (await profile(act.id)).subscription_status === 'paid');
  const rn = await user();
  const rn1 = await buy(rn, 'monthly'); await endsIn(rn, rn1.row.id, 2);
  await pg.query('UPDATE profiles SET credits_balance = 900 WHERE id = $1', [rn.id]);
  await buy(rn, 'monthly');
  await purchases.expireAccess();
  check('5.3 with a renewal stacked, nothing expires when the first period ends (credits carry into the renewal: 900 + 1,750)', (await profile(rn.id)).credits_balance === 2650);
  const lateBuyer = await user();
  const lb1 = await buy(lateBuyer, 'monthly');
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '3 days', credits_balance = 300 WHERE id = $1", [lateBuyer.id]);
  await buy(lateBuyer, 'flex'); // expiry job never ran
  check('5.4 buying after access ended (job not run yet): the old 300 expire first, only the new 1,050 remain', (await profile(lateBuyer.id)).credits_balance === 1050 && (await ledger(lateBuyer.id)).some((x) => x.kind === 'expire' && x.delta === -300));

  // ── 6. Refunds and disputes ─────────────────────────────────────
  console.log('\n6. Refunds and disputes');
  const charge = (row, over) => Object.assign({ object: 'charge', payment_intent: row.stripe_payment_intent_id, amount: row.amount_total_cents, amount_refunded: row.amount_total_cents }, over || {});
  // 6a. full refund of the only purchase
  const r1 = await user();
  const r1p = (await buy(r1, 'quarterly')).row;
  await pg.query('UPDATE profiles SET credits_balance = 1000 WHERE id = $1', [r1.id]); // spent 600
  const rv = await purchases.onChargeRefunded(charge(r1p));
  await purchases.onChargeRefunded(charge(r1p)); // duplicate event
  const r1P = await profile(r1.id);
  check('6.1 full refund: access ends now, the 1,000 left are removed (never more than granted), future instalments cancelled, purchase refunded', rv.revoked && r1P.credits_balance === 0 && r1P.subscription_status === 'free' && ms(r1P.access_expires_at) <= Date.now() + 1000 && (await rows(r1.id))[0].status === 'refunded' && (await grants(r1p.id)).slice(1).every((x) => x.status === 'cancelled'));
  check('6.2 a duplicate refund event deducts nothing more (one revoke entry)', (await ledger(r1.id)).filter((x) => x.kind === 'revoke').length === 1);
  // 6b. partial refund, then full
  const r2 = await user();
  const r2p = (await buy(r2, 'monthly')).row;
  const pr = await purchases.onChargeRefunded(charge(r2p, { amount_refunded: 1000 }));
  check('6.3 partial refund: recorded for review, access and credits unchanged', pr.partialRefund && (await rows(r2.id))[0].status === 'partially_refunded' && (await profile(r2.id)).credits_balance === 1750);
  await purchases.onChargeRefunded(charge(r2p));
  check('6.4 refunded in full later: revoked then', (await rows(r2.id))[0].status === 'refunded' && (await profile(r2.id)).credits_balance === 0);
  // 6c. refund of a stacked (not yet started) renewal
  const r3 = await user();
  const r3a = await buy(r3, 'monthly'); await endsIn(r3, r3a.row.id, 10);
  await pg.query('UPDATE profiles SET credits_balance = 400 WHERE id = $1', [r3.id]);
  const r3end = (await profile(r3.id)).access_expires_at;
  const r3b = (await buy(r3, 'quarterly')).row;
  await purchases.onChargeRefunded(charge(r3b));
  const r3P = await profile(r3.id);
  check('6.5 refunding a renewal that hasn’t started: access goes back to the current end, its 1,600 removed, the current 400 kept, its instalments cancelled', Math.abs(ms(r3P.access_expires_at) - ms(r3end)) < 1000 && r3P.credits_balance === 400 && r3P.subscription_status === 'paid' && (await grants(r3b.id)).slice(1).every((x) => x.status === 'cancelled'), { exp: r3P.access_expires_at, r3end, bal: r3P.credits_balance });
  // 6d. refund of the current purchase with a renewal stacked behind it
  const r4 = await user();
  const r4a = await buy(r4, 'monthly'); await endsIn(r4, r4a.row.id, 10);
  const r4b = (await buy(r4, 'quarterly')).row;
  const len = ms(r4b.access_end) - ms(r4b.access_start);
  await purchases.onChargeRefunded(charge(r4a.row));
  const r4bNow = (await rows(r4.id)).filter((x) => x.id === r4b.id)[0];
  check('6.6 refunding the current purchase with a renewal behind it: the renewal moves forward to start now and keeps its full length and instalments', Math.abs(ms(r4bNow.access_start) - Date.now()) < 5000 && Math.abs((ms(r4bNow.access_end) - ms(r4bNow.access_start)) - len) < 1000 && (await grants(r4b.id)).slice(1).every((x) => x.status === 'scheduled') && (await profile(r4.id)).subscription_status === 'paid');
  // 6e. refund of an OLD purchase whose credits already expired, while a newer one is active
  const r5 = await user();
  const r5a = (await buy(r5, 'monthly')).row;
  await pg.query("UPDATE purchases SET access_start = now() - interval '60 days', access_end = now() - interval '30 days' WHERE id = $1", [r5a.id]);
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '30 days' WHERE id = $1", [r5.id]);
  await purchases.expireAccess(); // its 1,750 expire
  await buy(r5, 'monthly'); // a new month: 1,750
  const r5before = (await profile(r5.id)).credits_balance;
  await purchases.onChargeRefunded(charge(r5a)); // Stripe refunds the old, finished month
  const r5P = await profile(r5.id);
  check('6.7 refunding an old purchase whose credits already expired takes nothing from the newer purchase (1,750 stay), access unchanged', r5before === 1750 && r5P.credits_balance === 1750 && r5P.subscription_status === 'paid', { before: r5before, after: r5P.credits_balance });
  // 6e2. the same, when everything had been spent before it expired (nothing left to expire)
  const r8 = await user();
  const r8a = (await buy(r8, 'monthly')).row;
  await pg.query('UPDATE profiles SET credits_balance = 0 WHERE id = $1', [r8.id]);
  await pg.query("UPDATE purchases SET access_start = now() - interval '60 days', access_end = now() - interval '30 days' WHERE id = $1", [r8a.id]);
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '30 days' WHERE id = $1", [r8.id]);
  await purchases.expireAccess();
  await buy(r8, 'monthly');
  await purchases.onChargeRefunded(charge(r8a));
  check('6.7b …also when its credits were all spent before it ended (the expiry is still recorded): the newer 1,750 stay', (await profile(r8.id)).credits_balance === 1750 && (await ledger(r8.id)).some((x) => x.kind === 'expire' && x.delta === 0));
  // 6e3. a purchase made after access ended (expiry and grant in one transaction) is still fully refundable
  const r9 = await user();
  await buy(r9, 'monthly');
  await pg.query("UPDATE profiles SET access_expires_at = now() - interval '1 day', credits_balance = 200 WHERE id = $1", [r9.id]);
  const r9b = (await buy(r9, 'quarterly')).row; // old 200 expire, +1,600 in the same transaction
  await purchases.onChargeRefunded(charge(r9b));
  check('6.7c a purchase made after access ended is refunded correctly: its own 1,600 are removed', (await profile(r9.id)).credits_balance === 0 && (await ledger(r9.id)).some((x) => x.kind === 'revoke' && x.delta === -1600));
  // 6f. disputes
  const r6 = await user();
  const r6p = (await buy(r6, 'monthly')).row;
  const dp = { object: 'dispute', payment_intent: r6p.stripe_payment_intent_id, reason: 'fraudulent' };
  await purchases.onDisputeCreated(dp); await purchases.onDisputeCreated(dp);
  check('6.8 a dispute revokes like a full refund, once', (await rows(r6.id))[0].status === 'disputed' && (await profile(r6.id)).credits_balance === 0 && (await ledger(r6.id)).filter((x) => x.kind === 'revoke').length === 1);
  await purchases.onDisputeClosed(Object.assign({ status: 'won' }, dp));
  check('6.9 a won dispute is flagged for a person (dispute_won), nothing reinstated automatically', (await rows(r6.id))[0].status === 'dispute_won' && (await profile(r6.id)).credits_balance === 0);
  const r7 = await user();
  const r7p = (await buy(r7, 'monthly')).row;
  await purchases.onChargeRefunded(charge(r7p));
  await purchases.onDisputeCreated({ object: 'dispute', payment_intent: r7p.stripe_payment_intent_id });
  check('6.10 a dispute on an already refunded purchase deducts nothing more', (await ledger(r7.id)).filter((x) => x.kind === 'revoke').length === 1 && (await rows(r7.id))[0].status === 'refunded');

  // 6g. refunds while a newer purchase is active: the newer purchase's credits are never taken
  const r10 = await user();
  const r10a = await buy(r10, 'monthly'); await endsIn(r10, r10a.row.id, 10);
  await pg.query('UPDATE profiles SET credits_balance = 0 WHERE id = $1', [r10.id]); // A's 1,750 all spent
  await buy(r10, 'monthly'); // renewal B: +1,750
  await purchases.onChargeRefunded(charge(r10a.row));
  check('6.11 refunding a purchase whose credits were all spent, with a renewal active: the renewal’s 1,750 stay', (await profile(r10.id)).credits_balance === 1750, (await profile(r10.id)).credits_balance);
  const r11 = await user();
  const r11a = await buy(r11, 'monthly'); await endsIn(r11, r11a.row.id, 10);
  await pg.query('UPDATE profiles SET credits_balance = 1250 WHERE id = $1', [r11.id]); // A: 500 of 1,750 spent
  await buy(r11, 'monthly'); // B: +1,750 → 3,000
  await purchases.onChargeRefunded(charge(r11a.row));
  check('6.12 …partly spent (500 of 1,750): only A’s remaining 1,250 are removed, B’s 1,750 stay', (await profile(r11.id)).credits_balance === 1750 && (await ledger(r11.id)).some((x) => x.kind === 'revoke' && x.delta === -1250));
  const r12 = await user();
  const r12a = await buy(r12, 'monthly'); await endsIn(r12, r12a.row.id, 10);
  const r12b = (await buy(r12, 'monthly')).row; // 3,500 in total, nothing spent
  await purchases.onChargeRefunded(charge(r12b));
  await purchases.onDisputeCreated({ object: 'dispute', payment_intent: r12b.stripe_payment_intent_id });
  check('6.13 refund of the renewal, then a dispute on it: its 1,750 removed once, the first month’s 1,750 kept, access back to the first end', (await profile(r12.id)).credits_balance === 1750 && (await ledger(r12.id)).filter((x) => x.kind === 'revoke').length === 1 && (await profile(r12.id)).subscription_status === 'paid');

  // ── 7. Ledger ──────────────────────────────────────────────────
  console.log('\n7. Ledger');
  const L = await ledger(r1.id);
  check('7.1 the ledger tells the story: grant +1,600 → revoke −1,000 (balance_after consistent)', L[0].kind === 'grant' && L[0].delta === 1600 && L.some((x) => x.kind === 'revoke' && x.delta === -1000 && x.balance_after === 0));

  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
