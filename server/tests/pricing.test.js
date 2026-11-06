// ════════════════════════════════════════════════════════════════
// services/pricing.js — the one source for plans, prices, credits and action
// costs — checked for internal consistency, the 70% contribution-margin
// rule, and drift against the frontend copy (oriven-frontend/js/plans.js).
// Pure: no server, no network, no database.
// RUN: node tests/pricing.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const pricing = require('../services/pricing');
const creditManager = require('../services/creditManager');
const planEntitlements = require('../services/planEntitlements');

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('  PASS — ' + name); } else { fail++; console.log('  FAIL — ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const { PLANS, PLAN_ORDER, FEATURE_COSTS } = pricing;

console.log('\nA. Plans');
check('five plans in the order Flex, Monthly, Quarterly, Semi-Annual, Annual', PLAN_ORDER.join() === 'flex,monthly,quarterly,semiannual,annual' && PLAN_ORDER.every((id) => PLANS[id] && PLANS[id].id === id));
check('prices incl. VAT: €17, €29, €78, €143, €245', PLAN_ORDER.map((id) => PLANS[id].priceInclVat).join() === '17,29,78,143,245');
check('durations: 14 days, 1, 3, 6 and 12 months (exactly one of days/months)', PLAN_ORDER.map((id) => PLANS[id].days ? PLANS[id].days + 'd' : PLANS[id].months + 'm').join() === '14d,1m,3m,6m,12m' && PLAN_ORDER.every((id) => !!PLANS[id].days !== !!PLANS[id].months));
check('instalments: one per month of access (Flex and Monthly: one)', PLAN_ORDER.every((id) => PLANS[id].instalments === Math.max(1, PLANS[id].months)));
check('credits divide evenly into the instalments', PLAN_ORDER.every((id) => Number.isInteger(PLANS[id].credits / PLANS[id].instalments)), PLAN_ORDER.map((id) => PLANS[id].credits / PLANS[id].instalments));
check('a longer plan never costs more per month than a shorter one', PLAN_ORDER.slice(1).every((id, i) => { const a = PLANS[PLAN_ORDER[i]]; const b = PLANS[id]; return !a.months || b.priceInclVat / b.months <= a.priceInclVat / a.months; }));
// Credits follow the money (30% of revenue / planning cost per credit), so
// every plan gives about the same credits per euro; only rounding to
// instalment-friendly numbers moves it. Longer plans are cheaper per month.
const perEuro = PLAN_ORDER.map((id) => PLANS[id].credits / PLANS[id].priceInclVat);
check('credits are proportional to the price: credits per euro within 4% across plans', Math.max(...perEuro) / Math.min(...perEuro) <= 1.04, perEuro.map((x) => x.toFixed(2)));
check('price in cents is exact', pricing.priceInclVatCents(PLANS.semiannual) === 14300 && pricing.priceInclVatCents(PLANS.flex) === 1700);
check('VAT 21%: €29 incl. = €23.97 excl. + €5.03 VAT', pricing.priceExVat(PLANS.monthly) === 23.97 && pricing.vatAmount(PLANS.monthly) === 5.03);
check('labels: "€29", "1 month", "14 days", "12 months"', pricing.priceLabel(PLANS.monthly) === '€29' && pricing.periodLabel(PLANS.monthly) === '1 month' && pricing.periodLabel(PLANS.flex) === '14 days' && pricing.periodLabel(PLANS.annual) === '12 months');

console.log('\nB. The 70% contribution-margin rule');
// AI may cost at most 30% of revenue excl. VAT. At the planning cost per
// credit (heavy usage), a plan's full allowance must fit inside that budget.
for (const id of PLAN_ORDER) {
  const p = PLANS[id];
  const revenue = p.priceInclVat / (1 + pricing.VAT_RATE);
  const aiCostAllUsed = p.credits * pricing.PLANNING_COST_PER_CREDIT_EUR;
  const margin = 1 - aiCostAllUsed / revenue;
  check(`${p.name}: every credit used at €${pricing.PLANNING_COST_PER_CREDIT_EUR}/credit → margin ${(margin * 100).toFixed(1)}% ≥ 70%`, margin >= 0.70 - 1e-9, { revenue, aiCostAllUsed });
  check(`${p.name}: the allowance uses at least 95% of the AI budget (not needlessly stingy)`, aiCostAllUsed >= 0.95 * pricing.aiBudget(p), { aiCostAllUsed, budget: pricing.aiBudget(p) });
}
check('aiBudget = 30% of revenue excl. VAT', pricing.aiBudget(PLANS.annual) === Math.round(245 / 1.21 * 0.3 * 100) / 100);

console.log('\nC. Action costs');
const keys = Object.keys(FEATURE_COSTS);
check('every action cost is a positive whole number of credits, rounded to 5', keys.every((k) => Number.isInteger(FEATURE_COSTS[k]) && FEATURE_COSTS[k] > 0 && FEATURE_COSTS[k] % 5 === 0), FEATURE_COSTS);
check('creditManager charges exactly these costs', JSON.stringify(creditManager.FEATURE_COSTS) === JSON.stringify(FEATURE_COSTS));
check('a 10-second video costs about twice a 5-second one (Kling bills per second)', FEATURE_COSTS.video_generation_10s >= 2 * FEATURE_COSTS.video_generation - 10);
check('each further chat model call is charged (ai_chat_step), at most maxModelCalls in total', FEATURE_COSTS.ai_chat_step > 0 && pricing.CHAT_LIMITS.maxModelCalls === 3);
check('chat input is bounded (history turns, characters per turn, output tokens)', pricing.CHAT_LIMITS.historyTurns === 10 && pricing.CHAT_LIMITS.historyTurnChars === 2000 && pricing.CHAT_LIMITS.maxTokens === 1000);
check('the cheapest plan covers a real first week: ≥ 5 complete image ads (copy + image)', PLANS.flex.credits / (FEATURE_COSTS.campaign_generation + FEATURE_COSTS.image_generation) >= 5);

console.log('\nD. Access');
const future = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 1000).toISOString();
check('hasAccess: paying status + future access_expires_at', pricing.hasAccess({ subscription_status: 'paid', access_expires_at: future }) && pricing.hasAccess({ subscription_status: 'creator', access_expires_at: future }));
check('hasAccess: never on the label alone (no or past expiry)', !pricing.hasAccess({ subscription_status: 'paid' }) && !pricing.hasAccess({ subscription_status: 'professional', access_expires_at: past }));
check('hasAccess: free never has access, whatever the date says', !pricing.hasAccess({ subscription_status: 'free', access_expires_at: future }));
check('accessEnd: calendar months, month-end clamped like Postgres (31 Jan + 1 month = 28 Feb)', pricing.accessEnd(PLANS.monthly, new Date('2027-01-31T12:00:00Z')).toISOString() === '2027-02-28T12:00:00.000Z');
check('accessEnd: Flex is 14 days', pricing.accessEnd(PLANS.flex, new Date('2026-11-01T00:00:00Z')).toISOString() === '2026-11-15T00:00:00.000Z');
check('every paying status gets every entitlement; free gets none', pricing.PAID_STATUSES.every((s) => Object.values(planEntitlements.PLAN_ENTITLEMENTS[s]).every(Boolean)) && Object.values(planEntitlements.PLAN_ENTITLEMENTS.free).every((v) => !v));
check('legacy allowances unchanged for running subscriptions (1,000 / 2,500 / 4,000)', JSON.stringify(pricing.LEGACY_ALLOWANCES) === JSON.stringify({ starter: 1000, creator: 2500, professional: 4000 }));
check('public plan list (GET /api/pricing) carries the price BEFORE VAT (VAT added at checkout), period, credits, instalments', pricing.publicPlans().length === 5 && pricing.publicPlans().every((p) => p.price === pricing.PLANS[p.id].priceInclVat && p.priceExVat === p.price && p.taxBehavior === 'exclusive' && p.vatAddedAtCheckout === true && !('priceInclVat' in p) && p.credits && p.instalments && p.creditsPerInstalment && (p.months || p.days)));
check('public prices before VAT: Flex 17, Monthly 29, Quarterly 78, Semi-Annual 143, Annual 245', pricing.publicPlans().map((p) => p.price).join() === '17,29,78,143,245');

console.log('\nE. Frontend copy (oriven-frontend/js/plans.js) matches');
const FE = path.resolve(__dirname, '..', '..', '..', 'oriven-frontend', 'js', 'plans.js');
if (!fs.existsSync(FE)) {
  console.log('  SKIP — ' + FE + ' not found (frontend repo not next to the backend)');
} else {
  delete require.cache[FE];
  const fe = require(FE);
  const P = fe.ORIVEN_PRICING;
  check('VAT rate and currency', P.vatRate === pricing.VAT_RATE && P.currency.toLowerCase() === pricing.CURRENCY);
  check('the same five plans with the same price, duration, credits and instalments', P.plans.length === 5 && P.plans.every((p, i) => {
    const b = PLANS[PLAN_ORDER[i]];
    return p.id === b.id && p.name === b.name && p.priceInclVat === b.priceInclVat && p.days === b.days && p.months === b.months && p.credits === b.credits && p.instalments === b.instalments && p.description === b.description;
  }), P.plans);
  check('the same action costs', JSON.stringify(P.featureCosts) === JSON.stringify(FEATURE_COSTS), { fe: P.featureCosts, be: FEATURE_COSTS });
  check('renewal manual, credits expire with access', P.renewal === 'manual' && P.creditsExpireWithAccess === true);
  check('frontend complete-ad totals are the sum of the real server steps', fe.CREDIT_COSTS.imageAdComplete === FEATURE_COSTS.campaign_generation + FEATURE_COSTS.image_generation && fe.CREDIT_COSTS.videoAdComplete === FEATURE_COSTS.campaign_generation + FEATURE_COSTS.video_generation);
  check('frontend entitlements: every paying status gets everything, free nothing', fe.ORIVEN_PAID_STATUSES.join() === pricing.PAID_STATUSES.join() && pricing.PAID_STATUSES.every((s) => ['research', 'autopilot', 'orivenChat', 'notifications', 'prioritySupport', 'weeklyReport'].every((k) => fe.orvPlanHas(s, k))) && !fe.orvPlanHas('free', 'research'));
}

console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
