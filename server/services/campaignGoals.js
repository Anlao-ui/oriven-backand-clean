// ════════════════════════════════════════════════════════════════
// Oriven Campaign Goals — single source of truth
//
// Exactly four business goals, platform-agnostic. The user only ever
// picks one of these; every platform-specific objective/optimization
// setting is translated from it here, in one place, so Google/Meta/
// TikTok stay in sync and a 5th goal can be added later without
// touching the publish pipeline, AI prompt, or Intelligence/Autopilot
// call sites individually.
// ════════════════════════════════════════════════════════════════

const GOALS = ['Sales', 'Leads', 'Traffic', 'Awareness'];

// Backwards compatibility: any campaign stored before this sprint has no
// goal at all (the field didn't exist) -- every generation call before
// today's change hardcoded 'Sales' as the value sent to the AI, so
// defaulting missing goals to 'Sales' reflects what those campaigns
// actually were, not a guess.
const DEFAULT_GOAL = 'Sales';

function normalizeGoal(goal) {
  return GOALS.includes(goal) ? goal : DEFAULT_GOAL;
}

// ── UI metadata (icon/title/description) — single source for the
// frontend goal-selection cards, so copy never drifts from this file. ──
const GOAL_UI = {
  Sales:     { icon: '💰', label: 'Sales',     desc: 'Drive purchases and revenue.' },
  Leads:     { icon: '📝', label: 'Leads',     desc: 'Generate enquiries, quotes and sign-ups.' },
  Traffic:   { icon: '🌐', label: 'Traffic',   desc: 'Drive visitors to your website.' },
  Awareness: { icon: '📢', label: 'Awareness', desc: 'Increase reach and brand awareness.' },
};

// ── AI creative direction — injected into every ad-copy generation
// prompt so headlines/descriptions/CTAs/keywords adapt to intent. ──
const GOAL_CREATIVE_DIRECTION = {
  Sales: `This is a SALES campaign — the goal is driving purchases and revenue.
Focus on: urgency, offers/discounts, buying language, concrete value ("save X", "X% off"), conversion-oriented CTAs ("Buy Now", "Shop Now", "Get Yours"). Keywords should be high commercial/transactional intent (e.g. "buy", "price", "order").`,
  Leads: `This is a LEADS campaign — the goal is generating enquiries, quotes and sign-ups, not an immediate purchase.
Focus on: trust-building, low-friction next steps, consultation/quote/demo language, CTAs like "Get a Quote", "Book a Call", "Request Info", "Sign Up". Keywords should target research/comparison intent (e.g. "best", "near me", "consultation").`,
  Traffic: `This is a TRAFFIC campaign — the goal is driving visitors to the website, not an immediate conversion.
Focus on: curiosity, "learn more"/"discover" framing, click-through appeal, CTAs like "Learn More", "See How", "Explore". Keywords should target informational/discovery intent, broader than transactional.`,
  Awareness: `This is an AWARENESS campaign — the goal is reach and brand recognition, not a direct response.
Focus on: brand storytelling, emotion, memorability, visibility — not a hard sell. Avoid aggressive CTAs; prefer soft framing ("Discover [Brand]", "Meet [Brand]"). Keywords should be broad, brand- and category-level rather than transactional.`,
};

// ── Google Ads — campaign-level bidding strategy per goal ──
// Oriven's Google publish pipeline only ever builds SEARCH campaigns
// (ad group + keywords + responsive search ad) — there's no Display-ad
// creative generation, so Awareness stays on SEARCH too, differentiated
// by bidding strategy + broader/brand-level keywords and copy rather
// than switching channel type. targetImpressionShare is a real,
// Search-native Google Ads bidding strategy for "be seen more often"
// goals (distinct from Display-only strategies like Manual CPM, which
// would be rejected on a SEARCH campaign).
const GOOGLE_GOAL_CONFIG = {
  Sales:     { biddingField: 'maximizeConversions', biddingValue: {}, label: 'Google Sales' },
  Leads:     { biddingField: 'maximizeConversions', biddingValue: {}, label: 'Google Leads' },
  Traffic:   { biddingField: 'targetSpend',         biddingValue: {}, label: 'Website Traffic' },
  Awareness: { biddingField: 'targetImpressionShare', biddingValue: { location: 'ANYWHERE_ON_PAGE', locationFractionMicros: 300000 }, label: 'Brand Awareness / Reach' },
};

// ── Meta Ads — ad-set optimization per goal ──
// A Meta Pixel is only genuinely required by Meta's API for
// OFFSITE_CONVERSIONS optimization (tracking a conversion on the
// advertiser's own website). Sales and Leads are both off-site
// conversion goals in Oriven today (no Facebook Page / on-platform
// Instant Form selection UI exists, which is what Meta's pixel-free
// LEAD_GENERATION optimization goal would require instead) -- kept
// pixel-gated until Instant Forms are built. Traffic and Awareness use
// their own native, pixel-free optimization goals.
const META_GOAL_CONFIG = {
  Sales:     { objective: 'OUTCOME_SALES',     optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', needsPixel: true,  customEventType: 'PURCHASE', label: 'Sales' },
  Leads:     { objective: 'OUTCOME_LEADS',     optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', needsPixel: true,  customEventType: 'LEAD',     label: 'Website Leads' },
  Traffic:   { objective: 'OUTCOME_TRAFFIC',   optimization_goal: 'LINK_CLICKS',         billing_event: 'IMPRESSIONS', needsPixel: false, label: 'Traffic' },
  Awareness: { objective: 'OUTCOME_AWARENESS', optimization_goal: 'REACH',               billing_event: 'IMPRESSIONS', needsPixel: false, label: 'Awareness' },
};

// ── TikTok Ads — campaign objective_type + ad-group optimization_goal/
// billing_event per goal. optimization_goal/billing_event govern the ad
// group (added when the publish pipeline grew from a campaign-shell-only
// call into a real Campaign→AdGroup→Ad graph) and must be a pairing
// TikTok's API accepts for the paired objective_type above them. These
// are TikTok's documented pairings for the 4 objectives this pipeline
// uses, cross-checked against the open-source tiktok-business-api-sdk's
// AdgroupCreateBody field list -- NOT live-verified against a real TikTok
// account (no live TikTok Ads credentials were available in this
// environment). If TikTok rejects a pairing, the publish route surfaces
// TikTok's own error rather than silently retrying with a guess.
const TIKTOK_GOAL_CONFIG = {
  Sales:     { objective_type: 'CONVERSIONS',     optimization_goal: 'CONVERT',         billing_event: 'OCPM', label: 'Sales' },
  Leads:     { objective_type: 'LEAD_GENERATION', optimization_goal: 'LEAD_GENERATION', billing_event: 'OCPM', label: 'Lead Generation' },
  Traffic:   { objective_type: 'TRAFFIC',         optimization_goal: 'CLICK',           billing_event: 'CPC',  label: 'Traffic' },
  Awareness: { objective_type: 'REACH',           optimization_goal: 'REACH',           billing_event: 'CPM',  label: 'Reach / Awareness' },
};

// ── TikTok Ads — map Oriven's freeform AI-generated CTA text to one of
// TikTok's call_to_action enum values. Mirrors server.js's _META_CTA_MAP/
// _metaCtaType pattern exactly. TikTok's own enum could not be
// independently confirmed against a live endpoint this session (the
// business-api.tiktok.com docs portal is client-rendered and returned no
// field content to automated fetches) -- built from TikTok's publicly
// documented Ads Manager CTA button list. Falls back to LEARN_MORE.
const TIKTOK_CTA_MAP = [
  [/shop|buy|order|purchase/i,                'SHOP_NOW'],
  [/sign\s*up|register|join/i,                'SIGN_UP'],
  [/quote|estimate/i,                         'GET_QUOTE'],
  [/contact|call|reach out|enquire|inquire/i, 'CONTACT_US'],
  [/subscribe/i,                              'SUBSCRIBE'],
  [/download/i,                               'DOWNLOAD_NOW'],
  [/apply/i,                                  'APPLY_NOW'],
  [/book/i,                                   'BOOK_NOW'],
  [/watch/i,                                  'WATCH_NOW'],
  [/play/i,                                   'PLAY_GAME'],
];
function tiktokCtaType(ctaText) {
  const text = String(ctaText || '');
  for (const [re, type] of TIKTOK_CTA_MAP) {
    if (re.test(text)) return type;
  }
  return 'LEARN_MORE';
}

// ── Google Ads — Demand Gen campaign bidding per goal ──
// Demand Gen (advertisingChannelType DEMAND_GEN) supports a narrower set
// of bidding strategies than Search -- it has no target-spend/maximize-
// clicks or target-impression-share strategy, so unlike Search's per-goal
// split (GOOGLE_GOAL_CONFIG above), all four goals converge on Maximize
// Conversions here; goals are differentiated by copy/targeting rather
// than bidding strategy for this channel type.
const GOOGLE_DEMANDGEN_GOAL_CONFIG = {
  Sales:     { biddingField: 'maximizeConversions', biddingValue: {}, label: 'Demand Gen — Sales' },
  Leads:     { biddingField: 'maximizeConversions', biddingValue: {}, label: 'Demand Gen — Leads' },
  Traffic:   { biddingField: 'maximizeConversions', biddingValue: {}, label: 'Demand Gen — Traffic' },
  Awareness: { biddingField: 'maximizeConversions', biddingValue: {}, label: 'Demand Gen — Awareness' },
};

// ── Intelligence — which KPIs actually matter for each goal, so a
// briefing reports on what the campaign was built to achieve instead of
// a fixed, one-size-fits-all metric set. ──
const GOAL_KPIS = {
  Sales:     ['ROAS', 'Purchases', 'CPA', 'Revenue'],
  Leads:     ['Cost per lead', 'Lead volume', 'Conversion rate'],
  Traffic:   ['CTR', 'Landing page visits', 'Click quality', 'CPC'],
  Awareness: ['Reach', 'Frequency', 'Impressions', 'CPM'],
};

// ── Autopilot — the trigger/action shape that actually makes sense per
// goal, offered as suggested defaults when a user creates a rule for a
// campaign whose goal is known; the automation_rules schema has no
// campaign/goal column today (rules are account+platform-wide), so this
// is not yet wired into live rule evaluation -- see server.js call site
// for the current, honest scope of this integration. ──
const GOAL_AUTOPILOT_HINTS = {
  Sales:     { trigger_metric: 'roas', trigger_operator: '>', suggestedValue: 3,  action_type: 'increase_budget', hint: 'Increase budget when ROAS exceeds target.' },
  Traffic:   { trigger_metric: 'cpc',  trigger_operator: '<', suggestedValue: 1,  action_type: 'increase_budget', hint: 'Increase budget when CPC decreases.' },
  Awareness: { trigger_metric: 'cpc',  trigger_operator: '<', suggestedValue: 5,  action_type: 'increase_budget', hint: 'Increase budget when CPM remains low.' }, // trigger_metric constrained to AUTOPILOT_RULE_METRICS (no native cpm entry today) — cpc used as the closest available proxy, flagged for a real cpm metric later
  Leads:     { trigger_metric: 'cpa',  trigger_operator: '>', suggestedValue: 50, action_type: 'pause_campaign',  hint: 'Pause campaigns with high cost per lead.' }, // trigger_metric constrained to AUTOPILOT_RULE_METRICS (no native cpl entry today) — cpa used as the closest available proxy
};

module.exports = {
  GOALS,
  DEFAULT_GOAL,
  normalizeGoal,
  GOAL_UI,
  GOAL_CREATIVE_DIRECTION,
  GOOGLE_GOAL_CONFIG,
  GOOGLE_DEMANDGEN_GOAL_CONFIG,
  META_GOAL_CONFIG,
  TIKTOK_GOAL_CONFIG,
  TIKTOK_CTA_MAP,
  tiktokCtaType,
  GOAL_KPIS,
  GOAL_AUTOPILOT_HINTS,
};
