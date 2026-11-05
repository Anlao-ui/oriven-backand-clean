// services/safeFetch.js — user-supplied URLs can't reach internal addresses
// (SSRF), including through redirects; plus the shared IP blocklist.
// DNS and fetch are stubbed: no network.
// Run: node tests/safe-fetch.test.js
const { safeFetch, assertPublicUrl, _setLookup } = require('../services/safeFetch');
const { _internal: { isBlockedIP } } = require('../services/urlContextFetcher');

let passed = 0, failed = 0;
function check(name, ok, info) { if (ok) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name, info === undefined ? '' : JSON.stringify(info)); } }

const DNS = {
  'public.example': ['93.184.216.34'],
  'img.example': ['151.101.1.1'],
  'evil.example': ['169.254.169.254'],
  'mixed.example': ['93.184.216.34', '10.0.0.5'],
  'v6local.example': ['::1'],
};
_setLookup(async (h) => { const a = DNS[h]; if (!a) throw new Error('ENOTFOUND'); return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); });

const calls = [];
const ROUTES = {
  'https://public.example/ok.png': { status: 200, body: 'img' },
  'https://public.example/to-meta': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
  'https://public.example/to-local': { status: 301, location: 'http://evil.example/x' },
  'https://public.example/to-img': { status: 302, location: 'https://img.example/final.png' },
  'https://img.example/final.png': { status: 200, body: 'final' },
  'https://public.example/loop': { status: 302, location: '/loop' },
};
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), redirect: opts && opts.redirect });
  const r = ROUTES[String(url)];
  if (!r) return new Response('nf', { status: 404 });
  return new Response(r.body || '', { status: r.status, headers: r.location ? { location: r.location } : {} });
};

async function refused(url) { try { await safeFetch(url); return null; } catch (e) { return e; } }

(async () => {
  console.log('\n1. Internal targets are refused before any request');
  const bad = [
    'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5500/api/version', 'http://localhost/', 'http://LOCALHOST./',
    'http://10.1.2.3/', 'http://192.168.0.1/', 'http://172.16.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/',
    'http://0.0.0.0/', 'http://evil.example/', 'http://mixed.example/', 'http://v6local.example/', 'http://metadata.google.internal/',
    'file:///etc/passwd', 'ftp://public.example/', 'not a url', 'http://unknown.example/',
  ];
  for (const u of bad) {
    const before = calls.length;
    const e = await refused(u);
    check('refused: ' + u, !!e && e.status === 422 && calls.length === before, e ? e.code : 'allowed');
  }

  console.log('\n2. Public URLs work, redirects are re-checked');
  calls.length = 0;
  let r = await safeFetch('https://public.example/ok.png');
  check('public URL fetched', r.status === 200 && (await r.text()) === 'img');
  check('fetch called with redirect:"manual"', calls[0] && calls[0].redirect === 'manual', calls);
  r = await safeFetch('https://public.example/to-img');
  check('redirect to another public host followed', r.status === 200 && (await r.text()) === 'final');
  let e = await refused('https://public.example/to-meta');
  check('redirect to the metadata IP refused', !!e && e.code === 'private_address', e && e.code);
  check('…and the metadata address was never requested', !calls.some((c) => /169\.254/.test(c.url)));
  e = await refused('https://public.example/to-local');
  check('redirect to a host resolving to a private IP refused', !!e && e.code === 'private_address');
  e = await refused('https://public.example/loop');
  check('redirect loop stops', !!e && e.code === 'too_many_redirects');

  console.log('\n3. assertPublicUrl and the IPv6 blocklist');
  check('assertPublicUrl returns the URL for a public host', (await assertPublicUrl('https://public.example/a')).hostname === 'public.example');
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::a9fe:a9fe', 'fe80::1', 'fd00::1']) check('blocked IPv6 ' + ip, isBlockedIP(ip) === true);
  for (const ip of ['::ffff:808:808', '2606:4700:4700::1111', '8.8.8.8']) check('public ' + ip + ' allowed', isBlockedIP(ip) === false);

  console.log('\n4. The user-URL fetchers use it');
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fnWeb = src.slice(src.indexOf('async function _fetchWebsiteText('), src.indexOf('function _websiteChanged('));
  const fnImg = src.slice(src.indexOf('async function _decodeImageSource('), src.indexOf('async function _aimlVision('));
  check('website refresh fetch goes through safeFetch', /safeFetch\(url/.test(fnWeb) && !/[^.]\bfetch\(url/.test(fnWeb));
  check('logo source download goes through safeFetch', /safeFetch\(source\)/.test(fnImg) && !/await fetch\(source\)/.test(fnImg));
  const ai = fs.readFileSync(path.join(__dirname, '..', 'services', 'adImages.js'), 'utf8');
  check('campaign image download (publish) goes through safeFetch', /safeFetch\(s\)/.test(ai) && !/await fetch\(s\)/.test(ai));
  const img = require('../services/adImages');
  e = null; try { await img.fetchImage('http://169.254.169.254/latest/meta-data/iam'); } catch (x) { e = x; }
  check('adImages.fetchImage refuses the metadata address', !!e && e.status === 422, e && e.message);
  const buf = await img.fetchImage('https://public.example/ok.png');
  check('adImages.fetchImage still downloads public images', Buffer.isBuffer(buf) && buf.toString() === 'img');

  console.log(`\n${passed + failed} checks run: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
