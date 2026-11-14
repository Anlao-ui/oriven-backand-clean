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
//   mode    how it happens: 'done' (in OrivenAI), 'prepared' (prepared in
//           OrivenAI; you set it up or publish it), 'platform' (through your
//           connected ad account)
//   needs   what you need before you start; result: what exists when done.
//           Fixed text per action, shown on every plan (old ones included).
// ════════════════════════════════════════════════════════════════
const { PAGES } = require('./pageKeys');

const STAGES = ['setup', 'research', 'audience', 'strategy', 'creative', 'build', 'launch', 'analyse', 'optimise'];

const ACTIONS = {
  connect_platform:   { label: 'Connect an ad platform',            page: 'ad-platforms',        button: 'Open Ad Platforms',         stage: 'setup',    verify: { kind: 'integration' },
    mode: 'platform', needs: "Access to the ad account you use (Google, Meta, TikTok, Pinterest or Snapchat)", result: "A connected ad account OrivenAI can publish to and read results from" },
  complete_business:  { label: 'Complete your business details',    page: 'control-center',      button: 'Open Control Center',       stage: 'setup',    verify: null,
    mode: 'done', needs: "Your business name, offer and goals", result: "Business details every OrivenAI tool uses" },
  add_products:       { label: 'Add your products or services',     page: 'control-center',      button: 'Open Control Center',       stage: 'setup',    verify: { kind: 'table', table: 'business_products' },
    mode: 'done', needs: "The products or services you advertise, with prices", result: "Your products saved, ready for research, ads and campaigns" },
  research_market:    { label: 'Research your market',              page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'market' },
    mode: 'done', needs: "A clear question about your market", result: "A saved market research report with sources" },
  research_audience:  { label: 'Research your audience',            page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'audience' },
    mode: 'done', needs: "Who you think your customers are", result: "A saved audience research report with sources" },
  research_opportunity: { label: 'Find advertising opportunities',  page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'opportunity' },
    mode: 'done', needs: "Your offer and the market you sell in", result: "A saved report of advertising opportunities" },
  research_product:   { label: 'Research your product or niche',    page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'product' },
    mode: 'done', needs: "The product or niche to look into", result: "A saved product or niche research report" },
  research_advertising: { label: 'Research advertising approaches', page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'advertising' },
    mode: 'done', needs: "Your offer and the platforms you consider", result: "A saved report on advertising approaches" },
  research_trends:    { label: 'Research current trends',           page: 'research',            button: 'Open Research',             stage: 'research', verify: { kind: 'research', type: 'trends' },
    mode: 'done', needs: "Your market or category", result: "A saved report on current trends" },
  add_competitors:    { label: 'Add your competitors',              page: 'competitor-analysis', button: 'Open Competitor Analysis',  stage: 'research', verify: { kind: 'table', table: 'business_competitors' },
    mode: 'done', needs: "The names or websites of businesses you compete with", result: "Your competitor list in Competitor Analysis" },
  analyze_competitors: { label: 'Analyse your competitors',         page: 'competitor-analysis', button: 'Open Competitor Analysis',  stage: 'research', verify: { kind: 'research', type: 'competitor' },
    mode: 'done', needs: "At least one competitor in your list", result: "A saved competitor analysis report with sources" },
  review_insights:    { label: 'Review your insights',              page: 'insights',            button: 'Open Insights',             stage: 'strategy', verify: null,
    mode: 'done', needs: "At least one finished research report", result: "The findings you’ll act on, saved in Insights" },
  build_audience:     { label: 'Build an audience',                 page: 'audience-builder',    button: 'Open Audience Builder',     stage: 'audience', verify: { kind: 'table', table: 'business_audiences' },
    mode: 'prepared', needs: "Your offer, and research or your own customer knowledge", result: "A saved audience with targeting suggestions per platform (set up in the platform when you launch)" },
  create_ad_copy:     { label: 'Write ad copy',                     page: 'create',              button: 'Open Create',               stage: 'creative', verify: { kind: 'assets', match: 'copy' },
    mode: 'done', needs: "Your offer and who it’s for", result: "Ad copy saved in My Content" },
  create_image:       { label: 'Create an ad image',                page: 'create',              button: 'Open Create',               stage: 'creative', verify: { kind: 'assets', match: 'image' },
    mode: 'done', needs: "Your offer, and your brand look if you have one", result: "An ad image saved in My Content" },
  create_video:       { label: 'Create a video ad',                 page: 'create',              button: 'Open Create',               stage: 'creative', verify: { kind: 'assets', match: 'video' },
    mode: 'done', needs: "Your offer and a short idea for the video", result: "A short video ad saved in My Content" },
  test_creatives:     { label: 'Create creative variations',        page: 'creative-testing',    button: 'Open Creative Testing',     stage: 'creative', verify: { kind: 'assets', match: 'variations' },
    mode: 'done', needs: "An ad idea to vary", result: "Several versions side by side, saved in My Content" },
  choose_creatives:   { label: 'Choose your strongest variations',  page: 'creative-testing',    button: 'Open Creative Testing',     stage: 'creative', verify: { kind: 'assets', match: 'picked' },
    mode: 'done', needs: "Versions made in Creative Testing", result: "The versions you keep, saved and ready for Campaign Builder" },
  review_content:     { label: 'Review your content',               page: 'my-content',          button: 'Open My Content',           stage: 'creative', verify: null,
    mode: 'done', needs: "Content made in Create", result: "Content you’ve checked and chosen to use" },
  build_campaign:     { label: 'Build a campaign',                  page: 'campaign-builder',    button: 'Open Campaign Builder',     stage: 'build',    verify: { kind: 'campaigns', status: 'built' },
    mode: 'prepared', needs: "An offer, an audience and at least one creative", result: "A campaign draft with its structure, targeting, budget and ads" },
  launch_campaign:    { label: 'Launch a campaign',                 page: 'launch',              button: 'Open Ad Studio',            stage: 'launch',   verify: { kind: 'campaigns', status: 'published' },
    mode: 'platform', needs: "A ready draft and a connected ad account", result: "A campaign in your ad account, created paused until you switch it on" },
  review_campaigns:   { label: 'Review your campaigns',             page: 'campaigns',           button: 'Open Campaign Overview',    stage: 'analyse',  verify: null,
    mode: 'platform', needs: "A published campaign with some results", result: "An understanding of what’s working, from the figures the platform reports" },
  compare_campaigns:  { label: 'Compare your campaigns',            page: 'campaign-comparison', button: 'Open Campaign Comparison',  stage: 'analyse',  verify: { kind: 'assets', match: 'comparison' },
    mode: 'platform', needs: "Two or more campaigns with reported results", result: "A saved comparison of your campaigns" },
  create_automation:  { label: 'Set up an automation',              page: 'automations',         button: 'Open Automations',          stage: 'optimise', verify: { kind: 'automations' },
    mode: 'platform', needs: "A published campaign and the limits you accept", result: "A rule or schedule that runs on your campaign within your limits" },
  optimise_campaigns: { label: 'Optimise your campaigns',           page: 'campaigns',           button: 'Open Campaign Overview',    stage: 'optimise', verify: null,
    mode: 'platform', needs: "Results from your campaigns", result: "Changes made to your campaigns, based on their results" },
  review_plan:        { label: 'Review your plan',                  page: 'marketing-plan',      button: 'Open Marketing Plan',       stage: 'analyse',  verify: null,
    mode: 'done', needs: "Your plan and what you’ve done so far", result: "A plan you’ve checked against what you learned" },
};

// Integrity at load: every action's page exists, and each says how it happens, what it needs and what it gives.
Object.keys(ACTIONS).forEach((id) => { const a = ACTIONS[id]; if (!PAGES[a.page]) throw new Error('planCatalog: unknown page ' + a.page + ' for ' + id); if (!['done', 'prepared', 'platform'].includes(a.mode) || !a.needs || !a.result) throw new Error('planCatalog: mode/needs/result missing for ' + id); });

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
  Object.keys(ACTIONS).forEach((id) => { const a = ACTIONS[id]; out[id] = { label: a.label, page: a.page, button: a.button, stage: a.stage, verify: a.verify ? 'auto' : 'manual', mode: a.mode, needs: a.needs, result: a.result }; });
  return out;
}

module.exports = { ACTIONS, STAGES, action, verifyKey, promptList, clientCatalog };
