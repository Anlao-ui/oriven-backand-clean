// No part of an API key or token is written to the logs.
// Runs the AIML provider's startup diagnostic with a fake key and captures
// console output; checks server.js's startup report and Google Ads
// diagnostics statically. No network, no database.
// Run: node tests/secret-logging.test.js
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, ok, info) { if (ok) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name, info === undefined ? '' : String(info).slice(0, 300)); } }

const FAKE = 'zz9Q7fakeKEYfor-tests-ONLY-1234567890abcdWXYZ';
process.env.AIML_API_KEY = FAKE;

const captured = [];
const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
for (const k of Object.keys(orig)) console[k] = (...a) => captured.push(a.map(String).join(' '));
let diagErr = null;
try {
  const p = require('../providers/aimlProvider');
  if (typeof p.diagnose === 'function') p.diagnose();
} catch (e) { diagErr = e; }
for (const k of Object.keys(orig)) console[k] = orig[k];

console.log('\n1. AIML provider diagnostic');
const out = captured.join('\n');
check('diagnose() ran', !diagErr && captured.length > 0, diagErr && diagErr.message);
const pieces = [FAKE.slice(0, 5), FAKE.slice(-4), FAKE.slice(0, 10), FAKE.slice(8, 20)];
check('no fragment of the key is logged (prefix, suffix or middle)', pieces.every((x) => !out.includes(x)), out);
check('still reports that the key is set', /key\s*:\s*set/.test(out), out);

console.log('\n2. server.js startup report');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const startup = src.slice(src.indexOf('(function checkEnv()'), src.indexOf('const PRICE_IDS = {'));
check('startup section found', startup.length > 500, startup.length);
check('no key value is sliced into a log line', !/console\.(log|warn|error)\([^\n]*(val|sk|srk|key)\.(slice|substring|substr)\(/.test(startup));
check('legacy price ids reported as set / not set only', /\(legacy\) =', process\.env\[k\] \? 'set' : 'not set'/.test(startup));

console.log('\n3. Google Ads diagnostics');
const diagLines = src.split('\n').filter((l) => /console\.(log|warn|error)\(/.test(l) && /mutateHeaders/.test(l));
check('header logs found', diagLines.length > 0);
check('Authorization and developer-token redacted in every header log', diagLines.every((l) => /Authorization: 'Bearer \*\*\*redacted\*\*\*'/.test(l) && /'developer-token': '\*\*\*redacted\*\*\*'/.test(l)), diagLines.join('\n'));
check('developer token value never passed to a log call', !/console\.(log|warn|error)\([^\n]*(,|\+)\s*(process\.env\.)?GOOGLE_ADS_DEVELOPER_TOKEN\b/.test(src));

console.log('\n4. Response hardening');
const head = src.slice(0, src.indexOf('const PORT ='));
check('x-powered-by disabled right after the app is created', /const app = express\(\);\s*\n[^\n]*\n\s*app\.disable\('x-powered-by'\);/.test(head));
check('every response: nosniff + no framing', /res\.setHeader\('X-Content-Type-Options', 'nosniff'\); res\.setHeader\('X-Frame-Options', 'DENY'\); next\(\);/.test(head));
// The frontend's Netlify headers, when that repository is checked out next to this one.
const hdrPath = path.join(__dirname, '..', '..', '..', 'oriven-frontend', '_headers');
if (fs.existsSync(hdrPath)) {
  const hdrs = fs.readFileSync(hdrPath, 'utf8');
  check('frontend _headers: SAMEORIGIN framing, nosniff, referrer policy for every path', /\n\/\*\r?\n(\s+[^\n]+\n)*\s+X-Frame-Options: SAMEORIGIN/.test(hdrs) && /X-Content-Type-Options: nosniff/.test(hdrs) && /Referrer-Policy: strict-origin-when-cross-origin/.test(hdrs));
} else console.log('  SKIP frontend _headers (oriven-frontend not checked out next to this repository)');

console.log(`\n${passed + failed} checks run: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
