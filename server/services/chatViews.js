// ── Which page the user has open, for the assistant (Oriven Chat) ──
//
// The app sends `context.view`: the id of the page open in the sidebar
// navigation (oriven-frontend js/appNav.js, e.g. 'plan', 'audiences').
// Only an id from this fixed list is used; anything else is ignored. The
// browser's string is never copied into the prompt: the page's name and the
// hint below are the server's own text. The view only says where the user
// is. It never chooses the assistant (services/agents.js resolves that from
// the account), never changes the chat mode, credits or tools, and carries no
// user data.

const VIEWS = {
  dashboard:        { name: 'Dashboard (Overview)', hint: 'the start page: an overview of their advertising, what needs attention and their business context. Help them see what matters and decide what to do next.' },
  plan:             { name: 'AI Plans (their marketing plan)', hint: 'their marketing plan for the period they bought. Help them understand the plan, its priorities and this week’s tasks, and turn a task into action.' },
  progress:         { name: 'Tasks (plan progress)', hint: 'the tasks from their marketing plan and which are done. Help them pick the next task and get it done.' },
  research:         { name: 'Research', hint: 'where they start market, competitor, audience and opportunity research. Help them ask a good research question or understand a report.' },
  insights:         { name: 'Saved Research', hint: 'their saved research findings, opportunities and actions. Help them choose what to act on.' },
  competitors:      { name: 'Competitor Analysis', hint: 'their competitors and how they compare. Help them understand competitors and find a way to stand out.' },
  create:           { name: 'Create Ads (Creative Studio)', hint: 'where they turn a brief into ad copy, images, videos and a campaign structure. Help them write a stronger brief or improve the creative.' },
  content:          { name: 'My Creatives', hint: 'the images, videos, emails and pages they saved. Help them reuse or improve what they made.' },
  testing:          { name: 'Creative Testing', hint: 'where they compare creative variations. Help them decide what to test and read the result.' },
  adstudio:         { name: 'Campaigns (review and launch)', hint: 'where drafts are reviewed for readiness by platform and published. Help them get a draft ready and understand any warning or blocker.' },
  audiences:        { name: 'Audiences', hint: 'where they define the audiences their campaigns target. Help them describe and choose the right audience.' },
  overview:         { name: 'Performance Overview (Analytics)', hint: 'the performance of their live campaigns by platform and date range. Help them understand results and what to change.' },
  builder:          { name: 'Campaign Builder', hint: 'where they open an existing campaign to edit it. Help them decide what to change.' },
  compare:          { name: 'Cross-platform Comparison', hint: 'campaigns side by side. Help them compare results fairly and pick a winner.' },
  'auto-overview':  { name: 'Automation Overview (Autopilot)', hint: 'their automations for published campaigns. Help them understand what runs and why.' },
  'auto-scheduler': { name: 'Automations scheduler', hint: 'schedules for published campaigns. Help them plan when campaigns run.' },
  'auto-rules':     { name: 'My Automations (rules)', hint: 'rules that notify, ask first or act within limits. Help them design a safe, useful rule.' },
  'auto-activity':  { name: 'Automation History', hint: 'the record of what their automations did. Help them read it.' },
  simulator:        { name: 'Ad Simulator', hint: 'where they try hypothetical budgets, platforms and assumptions before spending. The numbers there are their own assumptions and simulations, never real results or forecasts. Help them choose realistic assumptions, read a simulated range and compare scenarios.' },
  adsettings:       { name: 'Advertising Settings', hint: 'where they manage tracking per platform and ad account: pixels and tags, conversion actions, Conversions API tests and diagnostics. Help them understand what each setting does and what to do on the platform where OrivenAI can’t do it.' },
  platforms:        { name: 'Ad Platforms', hint: 'where they connect Google, Meta, TikTok, Pinterest and Snapchat ad accounts (they sign in with the platform themselves). Help them connect the right account.' },
};

const isView = (v) => typeof v === 'string' && v.length <= 32 && Object.prototype.hasOwnProperty.call(VIEWS, v);

// The prompt line for a valid view, or '' (unknown, missing or not a string).
function viewSection(view) {
  if (!isView(view)) return '';
  const v = VIEWS[view];
  return `\n\nCURRENT PAGE: the user has "${v.name}" open in OrivenAI — ${v.hint} Shape your answer (and any suggestions) around this page when it fits the question. You know which page is open, not what is on their screen: use only the details given elsewhere in this prompt or returned by your tools, and never claim to see the page or data you haven't been given.`;
}

module.exports = { VIEWS, isView, viewSection };
