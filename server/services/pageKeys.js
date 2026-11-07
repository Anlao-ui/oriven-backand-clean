// ════════════════════════════════════════════════════════════════
// Pages of OrivenAI that something on the server can point the user to —
// one list for the personal assistant's "open page" button
// (tools/agentTools.js), the Marketing Plan's task buttons and Progress
// (services/planCatalog.js). Neutral keys: the browser maps each one to the
// app's own navigation (js/pageRegistry.js). Keep both lists in step
// (tests/agents-consistency.test.js in the frontend checks them).
// ════════════════════════════════════════════════════════════════
const PAGES = {
  'control-center': { label: 'Control Center' },
  'marketing-plan': { label: 'Marketing Plan' },
  progress: { label: 'Progress' },
  research: { label: 'Research' },
  'competitor-analysis': { label: 'Competitor Analysis' },
  insights: { label: 'Insights' },
  create: { label: 'Create' },
  'creative-testing': { label: 'Creative Testing' },
  'my-content': { label: 'My Content' },
  launch: { label: 'Ad Studio' },
  'audience-builder': { label: 'Audience Builder' },
  campaigns: { label: 'Campaign Overview' },
  'campaign-builder': { label: 'Campaign Builder' },
  'campaign-comparison': { label: 'Campaign Comparison' },
  automations: { label: 'Automations' },
  settings: { label: 'Settings' },
  'ad-platforms': { label: 'Ad Platforms' },
};
function isPage(key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PAGES, key); }

module.exports = { PAGES, isPage };
