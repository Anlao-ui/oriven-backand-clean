// ════════════════════════════════════════════════════════════════
// Automations run through ONE engine. automation_rules are evaluated only by
// services/automations (cron "automations-rules"). The old Autopilot
// evaluator (_evaluateAutomationRules, called from the 4-hourly
// intelligence monitoring) re-ran the same enabled rules without pause-all,
// the kill switch, missing-data guards, approvals or idempotency — and,
// because its retired 'autopilot' credit key threw, it ran "uncharged" via a
// fail-open branch. Static guard: no network, no database.
// RUN: node tests/automation-single-engine.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 300))); };
const lineOf = (i) => src.slice(0, i).split('\n').length;

const calls = [...src.matchAll(/_evaluateAutomationRules\s*\(/g)].map((m) => ({ line: lineOf(m.index), def: /async function\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index)) }));
check('the legacy evaluator is never called (only its definition remains)', calls.filter((c) => !c.def).length === 0, calls);

const crons = [...src.matchAll(/_scheduleBackgroundJob\('([a-z-]+)'/g)].map((m) => m[1]);
check('the Automations engine cron is registered (automations-rules + automations-scheduler)', crons.includes('automations-rules') && crons.includes('automations-scheduler'), crons);

const evalBody = (() => { const a = src.indexOf('async function _evaluateAutomationRules'); return a < 0 ? '' : src.slice(a, src.indexOf('\n}\n', a)); })();
check('the legacy evaluator never runs a rule uncharged when the credit check errors (fails closed)', !/allowing this execution:`, err\.message\);\s*\n\s*}\s*\n\s*\n\s*\/\/ At most once/.test(evalBody) && /skipping this rule this tick/.test(evalBody));

check('no paid route continues after a credit reservation error (fail closed everywhere)', !/Credit reservation error:', err\.message\);\s*\n\s*}/.test(src),
  [...src.matchAll(/console\.warn\('\[([^\]]+)\] Credit reservation error:', err\.message\);\s*\n\s*}/g)].map((m) => m[1]));

console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
