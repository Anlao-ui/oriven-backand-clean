// ════════════════════════════════════════════════════════════════
// services/planCatalog.js: every Marketing Plan action says how it happens
// (in OrivenAI / prepared for you / through your ad account), what you
// need before you start and what exists when it's done — and the browser
// gets those fields with each plan (clientCatalog). The labels must be
// honest: audiences and campaign drafts are prepared in OrivenAI; launching
// and anything on live campaigns goes through the connected ad account.
// Pure module test: no server, no network, no database.
// RUN: node tests/plan-catalog.test.js   (from oriven-backend/server)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const C = require(path.join(__dirname, '..', 'services', 'planCatalog'));
let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' | ' + JSON.stringify(info).slice(0, 400))); };

const ids = Object.keys(C.ACTIONS);
check('every action has a mode (done / prepared / platform), what it needs and its result', ids.every((id) => ['done', 'prepared', 'platform'].includes(C.ACTIONS[id].mode) && C.ACTIONS[id].needs.length > 10 && C.ACTIONS[id].result.length > 10), ids.filter((id) => !C.ACTIONS[id].mode));
const cc = C.clientCatalog();
check('the browser catalogue carries mode, needs and result for every action (same values)', ids.every((id) => cc[id].mode === C.ACTIONS[id].mode && cc[id].needs === C.ACTIONS[id].needs && cc[id].result === C.ACTIONS[id].result));
check('…and still its page, button, stage and verification kind', ids.every((id) => cc[id].page && cc[id].button && cc[id].stage && ['auto', 'manual'].includes(cc[id].verify)));
check('honest: building an audience and a campaign are prepared in OrivenAI, not created in the ad account', C.ACTIONS.build_audience.mode === 'prepared' && C.ACTIONS.build_campaign.mode === 'prepared' && /set up in the platform/.test(C.ACTIONS.build_audience.result));
check('honest: connecting, launching (created paused), automations and campaign results go through the ad account', ['connect_platform', 'launch_campaign', 'create_automation', 'review_campaigns', 'compare_campaigns', 'optimise_campaigns'].every((id) => C.ACTIONS[id].mode === 'platform') && /paused/.test(C.ACTIONS.launch_campaign.result));
check('research, content and setup happen in OrivenAI', ['research_market', 'analyze_competitors', 'create_image', 'create_video', 'test_creatives', 'complete_business'].every((id) => C.ACTIONS[id].mode === 'done'));
check('nothing claims a guaranteed outcome', ids.every((id) => !/guarantee|will increase|more sales|higher roas|best results/i.test(C.ACTIONS[id].result + ' ' + C.ACTIONS[id].needs)));
console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
