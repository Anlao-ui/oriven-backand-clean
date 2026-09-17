// ════════════════════════════════════════════════════════════════
// Research URL Evidence — urlContextFetcher.js unit + live-network tests
// (Research UX/product pass — optional URL context capability)
//
// Two kinds of checks:
// - SSRF range logic (1-N): pure unit tests against exported internals,
//   no network at all — every RFC1918/loopback/link-local/cloud-metadata/
//   documentation/multicast range that matters.
// - Live network checks: this module's whole point is to make REAL
//   fetch attempts safely, so a handful of checks here genuinely try to
//   fetch http://localhost:<this test's own ephemeral port>/ and a real
//   public URL (example.com, a stable IANA-reserved test domain) to
//   prove the protection is real end-to-end, not just a code-reading
//   exercise. No destructive/production calls; example.com is the
//   standard safe-to-fetch test domain.
//
// RUN: node tests/research-url-context.test.js
// ════════════════════════════════════════════════════════════════

const path = require('path');
const http = require('http');
const fetcher = require(path.resolve(__dirname, '../services/urlContextFetcher'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

async function main() {
  // ── SSRF range logic (pure, no network) ─────────────────────────
  const v4Blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.1.1', '0.0.0.0', '100.64.0.1', '198.51.100.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255'];
  const v4Allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255'];
  check('1. Every RFC1918/loopback/CGNAT/documentation/multicast/reserved IPv4 range is blocked', v4Blocked.every((ip) => fetcher._internal.isBlockedIP(ip)), v4Blocked);
  check('2. Cloud metadata endpoint (169.254.169.254) specifically blocked', fetcher._internal.isBlockedIP('169.254.169.254'));
  check('3. Ordinary public IPv4 addresses are NOT blocked (false positive check)', v4Allowed.every((ip) => !fetcher._internal.isBlockedIP(ip)), v4Allowed);
  const v6Blocked = ['::1', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::'];
  const v6Allowed = ['2001:4860:4860::8888', '2606:4700:4700::1111'];
  check('4. IPv6 loopback/unique-local/link-local/multicast/mapped-private blocked', v6Blocked.every((ip) => fetcher._internal.isBlockedIP(ip)), v6Blocked);
  check('5. Ordinary public IPv6 addresses are NOT blocked (false positive check)', v6Allowed.every((ip) => !fetcher._internal.isBlockedIP(ip)), v6Allowed);
  check('6. A malformed/unrecognizable address fails CLOSED (blocked)', fetcher._internal.isBlockedIP('not-an-ip'));

  // ── URL syntax / protocol validation (pure) ─────────────────────
  const rejectCases = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/file', 'data:text/html,<script>', 'not a url', ''];
  let syntaxRejectOk = true;
  rejectCases.forEach((u) => { try { fetcher.validateUrlSyntax(u); syntaxRejectOk = false; } catch (_) {} });
  check('7. Non-http(s) protocols and malformed strings are all rejected', syntaxRejectOk, rejectCases);
  let httpsAccepted = false;
  try { fetcher.validateUrlSyntax('https://example.com/page?x=1'); httpsAccepted = true; } catch (_) {}
  check('8. A well-formed https:// URL is accepted', httpsAccepted);

  // ── Live network: real localhost/private-address rejection ──────
  // Spins up a throwaway local HTTP server so this test genuinely proves
  // an attempted SSRF fetch is refused end to end, not just that the
  // range-check function returns true in isolation.
  const localServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>should never be reachable</title>'); });
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const localPort = localServer.address().port;

  const localhostResult = await fetcher.fetchUrlContext('http://localhost:' + localPort + '/');
  check('9. Real fetch to localhost is refused, never reaches the local server', localhostResult.ok === false && localhostResult.code === 'private_address', localhostResult);

  const loopbackLiteralResult = await fetcher.fetchUrlContext('http://127.0.0.1:' + localPort + '/');
  check('10. Real fetch to a literal 127.0.0.1 URL is refused', loopbackLiteralResult.ok === false && loopbackLiteralResult.code === 'private_address', loopbackLiteralResult);

  const metadataResult = await fetcher.fetchUrlContext('http://169.254.169.254/latest/meta-data/');
  check('11. Real fetch to the cloud metadata IP literal is refused', metadataResult.ok === false && metadataResult.code === 'private_address', metadataResult);

  localServer.close();

  const invalidResult = await fetcher.fetchUrlContext('not a url at all');
  check('12. An invalid URL fails safely with a clear reason, never throws', invalidResult.ok === false && invalidResult.code === 'invalid_url', invalidResult);

  const fileResult = await fetcher.fetchUrlContext('file:///etc/passwd');
  check('13. file:// scheme fails safely, never attempts local file access', fileResult.ok === false && fileResult.code === 'invalid_protocol', fileResult);

  // ── Live network: a real public fetch actually works ────────────
  const realResult = await fetcher.fetchUrlContext('https://example.com/');
  check('14. A real public URL is fetched and extracted successfully', realResult.ok === true, { ok: realResult.ok, reason: realResult.reason });
  if (realResult.ok) {
    check('14b. Extracted title is real, non-empty, not fabricated', typeof realResult.title === 'string' && realResult.title.length > 0, realResult.title);
    check('14c. Extracted text is real, non-empty, capped, and contains no leftover HTML tags', typeof realResult.text === 'string' && realResult.text.length > 0 && realResult.text.length <= 6000 && !/<[a-z][\s\S]*>/i.test(realResult.text), { len: realResult.text.length, sample: realResult.text.slice(0, 80) });
    check('14d. Domain is the real requested domain, not invented', realResult.domain === 'example.com', realResult.domain);
  }

  // A domain that resolves to nothing (fails DNS) still returns a safe,
  // honest failure rather than throwing or hanging past the timeout.
  const dnsFailResult = await fetcher.fetchUrlContext('https://this-domain-genuinely-does-not-exist-oriven-test.invalid/');
  check('15. A DNS resolution failure fails safely with a real reason', dnsFailResult.ok === false && !!dnsFailResult.reason, dnsFailResult);

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + results.length + ' checks run, ' + (results.length - failed) + ' passed, ' + failed + ' failed.');
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
