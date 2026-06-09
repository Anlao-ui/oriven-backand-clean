// ════════════════════════════════════════════════════════════════
// ORIVEN — Central Plan Configuration
//
// SINGLE SOURCE OF TRUTH for all plan data.
// Load this before settings.js, usage.js, and paywall.js.
//
// To update any plan: change it here. Every surface that renders
// plan data (landing page, paywall, settings, onboarding) reads
// from this file — no other copies to keep in sync.
// ════════════════════════════════════════════════════════════════

// ── Credit cost per generation type ───────────────────────────
// Single source of truth — imported by usage.js and create.js.
var CREDIT_COSTS = {
  text:         1,
  copy:         1,
  campaign:     1,
  visual:       1,
  image:        1,
  ideas:        1,
  email:        2,
  poster:       2,
  infographic:  2,
  website:      3,
  web:          3,
  presentation: 4,
  deck:         4,
  video:        10,
  ugc:          10
};

var ORIVEN_PLANS = {
  starter: {
    id:       "starter",
    name:     "Starter",
    price:    7.95,
    stripeId: "price_1TgQmQ066sCcz3jQbSfa6lj4",
    limit:    50,
    credits:  50,
    explore:  false,
    desc:     "For solo founders building their brand.",
    features: [
      "50 Creative Credits / Month",
      "Unlimited Brand Assistant",
      "3 Website Generations / Month",
      "1 BrandCore Regeneration",
      "Access To Inspiration Library"
    ]
  },
  creator: {
    id:       "creator",
    name:     "Creator",
    price:    14.95,
    popular:  true,
    stripeId: "price_1TgQmp066sCcz3jQoiKzj393",
    limit:    150,
    credits:  150,
    explore:  false,
    desc:     "For active brands creating at scale.",
    features: [
      "150 Creative Credits / Month",
      "Unlimited Brand Assistant",
      "Unlimited Website Generations",
      "5 BrandCore Regenerations",
      "Premium Generation Quality",
      "Priority Support",
      "Access To Inspiration Library"
    ]
  },
  professional: {
    id:       "professional",
    name:     "Professional",
    price:    29.95,
    stripeId: "price_1TgQnT066sCcz3jQe3PUejI8",
    limit:    500,
    credits:  500,
    explore:  false,
    desc:     "For teams building shared brand intelligence.",
    features: [
      "500 Creative Credits / Month",
      "Unlimited Brand Assistant",
      "Unlimited Website Generations",
      "Unlimited BrandCore Regenerations",
      "Team Workspace Access",
      "Shared BrandCore Systems",
      "Multi-User Collaboration",
      "Priority Support",
      "Premium Generation Quality",
      "Access To Inspiration Library"
    ]
  }
};

// Ordered arrays — all plans are paid plans
var ORIVEN_PLAN_LIST  = ["starter","creator","professional"].map(function(k){ return ORIVEN_PLANS[k]; });
var ORIVEN_PAID_PLANS = ORIVEN_PLAN_LIST;

// ── SVG check mark (shared across all card styles) ─────────────
var _PLAN_CHK_SVG = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5l2.5 2.5 4.5-4.5"/></svg>';

// ── Render: Paywall modal (pw-card) ────────────────────────────
// Renders into the element with id="pwPlanGrid".
// Called by paywall.js every time the modal opens.
function renderPWPricingCards(containerEl){
  if(!containerEl) return;
  containerEl.innerHTML = ORIVEN_PAID_PLANS.map(function(plan){
    var feats = plan.features.map(function(f){
      return '<li class="pw-feat">' + f + '</li>';
    }).join("");
    return [
      '<div class="pw-card' + (plan.popular ? ' pw-card-featured' : '') + '">',
        plan.popular ? '<div class="pw-featured-badge">Most Popular</div>' : '',
        '<div class="pw-card-name"' + (plan.popular ? ' style="color:#B7FF2A"' : '') + '>' + plan.name + '</div>',
        '<div class="pw-price-row">',
          '<span class="pw-price">€' + plan.price + '</span>',
          '<span class="pw-period">/mo</span>',
        '</div>',
        plan.desc ? '<div class="pw-card-desc">' + plan.desc + '</div>' : '',
        '<div class="pw-card-divider"></div>',
        '<ul class="pw-feats-list">' + feats + '</ul>',
        '<button id="paywall-btn-' + plan.id + '" class="pw-btn ' + (plan.popular ? 'pw-btn-primary' : 'pw-btn-outline') + '" onclick="selectPlan(\'' + plan.id + '\')" data-label="Get Started">Get Started</button>',
      '</div>'
    ].join('');
  }).join('');
}

// ── Render: Landing page pricing (lp-plan) ─────────────────────
// Renders into the element with id="lpPricingGrid".
// Called once on DOMContentLoaded for the landing view.
function renderLPPricingCards(containerEl){
  if(!containerEl) return;
  containerEl.innerHTML = ORIVEN_PAID_PLANS.map(function(plan){
    var feats = plan.features.map(function(f){
      return '<li class="lp-plan-feat"><div class="lp-plan-feat-check">' + _PLAN_CHK_SVG + '</div><span>' + f + '</span></li>';
    }).join("");
    return [
      '<div class="lp-plan' + (plan.popular ? ' lp-plan-popular' : '') + '">',
        plan.popular ? '<div class="lp-plan-tag">Most Popular</div>' : '',
        '<div class="lp-plan-name">' + plan.name + '</div>',
        '<div class="lp-plan-price">',
          '<span class="lp-plan-price-num">€' + plan.price + '</span>',
          '<span class="lp-plan-price-period">/month</span>',
        '</div>',
        '<div class="lp-plan-divider"></div>',
        '<ul class="lp-plan-features">' + feats + '</ul>',
        '<button type="button" class="' + (plan.popular ? 'lp-cta-btn lp-plan-cta' : 'lp-plan-cta-outline') + '" onclick="lpStartPlan(\'' + plan.id + '\',this)">Get Started</button>',
      '</div>'
    ].join('');
  }).join('');
}

// ── Render: Plan selection / onboarding (pl-card) ──────────────
// Renders into the element with id="plPricingGrid".
// Called once on DOMContentLoaded for the plan view.
function renderPLPricingCards(containerEl){
  if(!containerEl) return;
  containerEl.innerHTML = ORIVEN_PAID_PLANS.map(function(plan){
    var feats = plan.features.map(function(f){
      return '<li class="pl-feat"><div class="pl-feat-chk">' + _PLAN_CHK_SVG + '</div><span>' + f + '</span></li>';
    }).join("");
    return [
      '<div class="pl-card' + (plan.popular ? ' pl-popular' : '') + '">',
        plan.popular ? '<div class="pl-tag">Most Popular</div>' : '',
        '<div class="pl-card-name">' + plan.name + '</div>',
        '<div class="pl-price">',
          '<span class="pl-price-num">€' + plan.price + '</span>',
          '<span class="pl-price-period">/month</span>',
        '</div>',
        '<div class="pl-divider"></div>',
        '<ul class="pl-feats">' + feats + '</ul>',
        '<button class="pl-btn ' + (plan.popular ? 'pl-btn-primary' : 'pl-btn-outline') + '" onclick="selectPlan(\'' + plan.id + '\',this)">Choose ' + plan.name + '</button>',
      '</div>'
    ].join('');
  }).join('');
}
