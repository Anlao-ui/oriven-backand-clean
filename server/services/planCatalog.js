// ════════════════════════════════════════════════════════════════
// What a Marketing Plan task can be — ONLY work the user does inside
// OrivenAI. The plan generator (services/onboardingFlow.js) must pick one
// of these for every task; a task naming anything else is dropped, so the
// plan can never send the user to do marketing outside the product.
//
// Per action:
//   page    where it is done (services/pageKeys.js) — the task's button
//   button  the button text
//   verify  how completion is known:
//             null                  the user confirms it (can't be seen)
//             { kind: 'integration' }          an ad account connected
//             { kind: 'research', type }       a finished Research report
//             { kind: 'table', table }         a saved row (audience, …)
//             { kind: 'assets', match }        content saved in My Content
//             { kind: 'campaigns', status }    a campaign built / published
//             { kind: 'automations' }          an automation rule saved
//           A verified action is never completed by opening a page and
//           can't be ticked by hand; the n-th task of the same kind needs
//           n results (services/progressFacts.js).
//   stage   where it sits in the roadmap's natural order
// ════════════════════════════════════════════════════════════════
const { PAGES } = require('./pageKeys');

const STAGES = ['setup', 'research', 'audience', 'strategy', 'creative', 'build', 'launch', 'analyse', 'optimise'];

const ACTIONS = {
  connect_platform:   { label: 'Connect an ad platform',            page: 'ad-platforms',        button: 'Open Ad Platforms',         stage: 'setup',    verify: { kind: 'integration' } },
  complete_business:  { label: 'Complete your business details',    page: 'control-center',      button: 'Open Control Center',       stage: 'setup',    verify: null },
  add_products:       { label: 'Add your products or services',     page: 'control-center',      button: 'Open Control Center',       stage: 'setup',    verify: { kind: 'table', table: 'business_products' } },
  research_market:    { label: 'Research your market',              page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'market' } },
  research_audience:  { label: 'Research your audience',            page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'audience' } },
  research_opportunity: { label: 'Find advertising opportunities',  page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'opportunity' } },
  research_product:   { label: 'Research your product or niche',    page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'product' } },
  research_advertising: { label: 'Research advertising approaches', page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'advertising' } },
  research_trends:    { label: 'Research current trends',           page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'trends' } },
  add_competitors:    { label: 'Add your competitors',              page: 'competitor-analysis', button: 'Open Competitor Analysis',  stage: 'research', verify: { kind: 'table', table: 'business_competitors' } },
  analyze_competitors: { label: 'Analyse your competitors',         page: 'competitor-analysis', button: 'Open Competitor Analysis',  stage: 'research', verify: { kind: 'research', type: 'competitor' } },
  review_insights:    { label: 'Review your insights',              page: 'insights',            button: 'Open Insights',             stage: 'strategy', verify: null },
  build_audience:     { label: 'Build an audience',                 page: 'audience-builder',    button: 'Open Audience Builder',     stage: 'audience', verify: { kind: 'table', table: 'business_audiences' } },
  create_ad_copy:     { label: 'Write ad copy',                     page: 'create',              button: 'Open Create',               stage: 'creative', verify: { kind: 'assets', match: 'copy' } },
  create_image:       { label: 'Create an ad image',                page: 'create',              button: 'Open Create',               stage: 'creative', verify: { kind: 'assets', match: 'image' } },
  create_video:       { label: 'Create a video ad',                 page: 'create',              button: 'Open Create',               stage: 'creative', verify: { kind: 'assets', match: 'video' } },
  test_creatives:     { label: 'Create creative variations',        page: 'creative-testing',    button: 'Open Creative Testing',     stage: 'creative', verify: { kind: 'assets', match: 'variations' } },
  choose_creatives:   { label: 'Choose your strongest variations',  page: 'creative-testing',    button: 'Open Creative Testing',     stage: 'creative', verify: { kind: 'assets', match: 'picked' } },
  review_content:     { label: 'Review your content',               page: 'my-content',          button: 'Open My Content',           stage: 'creative', verify: null },
  build_campaign:     { label: 'Build a campaign',                  page: 'campaign-builder',    button: 'Open Campaign Builder',     stage: 'build',    verify: { kind: 'campaigns', status: 'built' } },
  launch_campaign:    { label: 'Launch a campaign',                 page: 'launch',              button: 'Open Ad Studio',            stage: 'launch',   verify: { kind: 'campaigns', status: 'published' } },
  review_campaigns:   { label: 'Review your campaigns',             page: 'campaigns',           button: 'Open Campaign Overview',    stage: 'analyse',  verify: null },
  compare_campaigns:  { label: 'Compare your campaigns',            page: 'campaign-comparison', button: 'Open Campaign Comparison',  stage: 'analyse',  verify: { kind: 'assets', match: 'comparison' } },
  create_automation:  { label: 'Set up an automation',              page: 'automations',         button: 'Open Automations',          stage: 'optimise', verify: { kind: 'automations' } },
  optimise_campaigns: { label: 'Optimise your campaigns',           page: 'campaigns',           button: 'Open Campaign Overview',    stage: 'optimise', verify: null },
  review_plan:        { label: 'Review your plan',                  page: 'marketing-plan',      button: 'Open Marketing Plan',       stage: 'analyse',  verify: null },
};

// Integrity at load: every action's page exists.
Object.keys(ACTIONS).forEach((id) => { if (!PAGES[ACTIONS[id].page]) throw new Error('planCatalog: unknown page ' + ACTIONS[id].page + ' for ' + id); });

function action(id) { return Object.prototype.hasOwnProperty.call(ACTIONS, id) ? ACTIONS[id] : null; }
// The key results of the same kind are counted under (e.g. 'research:market').
function verifyKey(id) {
  const a = action(id);
  if (!a || !a.verify) return null;
  const v = a.verify;
  return v.kind + ':' + (v.type || v.table || v.match || v.status || '');
}
// For the prompt: one line per action.
function promptList() {
  return Object.keys(ACTIONS).map((id) => `${id} — ${ACTIONS[id].label} (${PAGES[ACTIONS[id].page].label})`).join('\n');
}

// For the browser: each action's label, page, button and whether OrivenAI
// verifies it ('auto') or the user confirms it ('manual').
function clientCatalog() {
  const out = {};
  Object.keys(ACTIONS).forEach((id) => { const a = ACTIONS[id]; out[id] = { label: a.label, page: a.page, button: a.button, stage: a.stage, verify: a.verify ? 'auto' : 'manual' }; });
  return out;
}

module.exports = { ACTIONS, STAGES, action, verifyKey, promptList, clientCatalog };
