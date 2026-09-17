// ════════════════════════════════════════════════════════════════
// urlContextFetcher — safe fetch + extraction for USER-PROVIDED URLs
// attached to a Research investigation as optional evidence/context.
//
// This is a genuinely different trust boundary from everything else
// Research does: the user is handing ORIVEN an arbitrary URL, and
// whatever that page contains is UNTRUSTED EXTERNAL CONTENT — it must
// never be able to reach internal network services (SSRF) and its text
// must never be treated as instructions (prompt injection), only as
// data to analyze. Both concerns are handled here; the injection
// framing itself is applied by the caller (server.js) using the exact
// same SECURITY rule pattern already used for retrieved web-search
// content, so the model sees one consistent untrusted-content contract
// regardless of where the content came from.
//
// SSRF defense, specifically:
// - protocol allowlist: http/https only (no file://, data:, ftp://, etc.)
// - the literal host, if already an IP, is validated directly
// - a hostname is DNS-resolved and EVERY returned address is validated
//   before any connection is attempted
// - the actual TCP connection is pinned to the SAME validated address
//   via a custom `lookup` passed to http(s).request — this is what
//   closes the DNS-rebinding gap a "check then fetch normally" approach
//   would leave open (the hostname could resolve to a public IP at
//   validation time and a private one moments later at connect time)
// - redirects are followed manually (Node's automatic redirect-following
//   is never used here), up to a small hop limit, re-validating the new
//   target from scratch on every hop — never trusting a Location header
// - a hard timeout and a hard response-byte cap (checked while
//   streaming, not after buffering the whole body)
// - a Content-Type allowlist (text/html, text/plain, application/xhtml+xml)
//
// Reuses the SAME lightweight, dependency-free HTML->text approach
// server.js's existing _fetchWebsiteText already uses for Business
// Website Refresh (regex-based title/description/text extraction, no
// HTML parser dependency) rather than inventing a second extraction
// style — but with the SSRF/size/redirect protections that function
// does not have. This module intentionally does NOT touch
// _fetchWebsiteText or its one caller (POST /api/business/website/refresh)
// at all: reusing the extraction APPROACH, not the function itself, so
// Business's existing behavior is completely unaffected.
// ════════════════════════════════════════════════════════════════

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const MAX_URLS = 5;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5MB cap on the raw response body
const MAX_EXTRACTED_TEXT = 6000; // matches _fetchWebsiteText's existing cap
const ALLOWED_CONTENT_TYPE_RE = /^(text\/html|text\/plain|application\/xhtml\+xml)\b/i;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
function inV4Range(long, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (long & mask) === (ipv4ToLong(base) & mask);
}
// Every RFC1918/loopback/link-local/CGNAT/documentation/reserved/multicast
// range that matters for SSRF — most critically 169.254.0.0/16 (covers the
// AWS/GCP/Azure cloud metadata endpoint, 169.254.169.254) and 127.0.0.0/8.
const V4_BLOCKED_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
];
function isBlockedV4(ip) {
  const long = ipv4ToLong(ip);
  if (long === null) return true; // malformed -- fail closed
  return V4_BLOCKED_RANGES.some(([base, bits]) => inV4Range(long, base, bits));
}
function isBlockedV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) -- validate the embedded IPv4 too.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}
function isBlockedIP(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not a recognizable IP -- fail closed
}

class UrlSafetyError extends Error {
  constructor(message, code) { super(message); this.code = code || 'unsafe_url'; }
}

function validateUrlSyntax(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new UrlSafetyError('Not a valid URL.', 'invalid_url'); }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) throw new UrlSafetyError('Only http:// and https:// URLs are supported.', 'invalid_protocol');
  if (!u.hostname) throw new UrlSafetyError('Not a valid URL.', 'invalid_url');
  return u;
}

// Resolves `hostname` and returns ONE validated, public address (throws if
// every resolved address is private/reserved, or if the literal hostname
// is itself a blocked IP). Prefers an IPv4 result when both families
// resolve, purely for deterministic behavior; either family is validated
// identically.
async function resolveValidatedAddress(hostname) {
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isBlockedIP(hostname)) throw new UrlSafetyError('That address is not allowed.', 'private_address');
    return { address: hostname, family: literalFamily };
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UrlSafetyError('Could not resolve that domain.', 'dns_failure');
  }
  if (!records || !records.length) throw new UrlSafetyError('Could not resolve that domain.', 'dns_failure');
  const safe = records.find((r) => !isBlockedIP(r.address));
  if (!safe) throw new UrlSafetyError('That address is not allowed.', 'private_address');
  return { address: safe.address, family: safe.family };
}

// Fetches ONE hop with the connection pinned to `pinnedAddress` (closes
// the DNS-rebinding TOCTOU gap between validation and connection) and a
// hard byte cap enforced while streaming.
function fetchPinned(targetUrl, pinnedAddress, pinnedFamily) {
  return new Promise((resolve, reject) => {
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OrivenResearchBot/1.0; +https://oriven.ai)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      },
      timeout: FETCH_TIMEOUT_MS,
      // Pins the actual TCP connection to the address we already
      // validated, regardless of what a fresh DNS lookup might return at
      // connect time. Node's Happy-Eyeballs socket path (default since
      // v20, `autoSelectFamily`) calls this with `options.all: true` and
      // expects an ARRAY of {address,family} back, not the classic
      // 2-value dns.lookup callback shape -- handle both forms.
      lookup: (_hostname, options, cb) => {
        if (options && options.all) return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
        return cb(null, pinnedAddress, pinnedFamily);
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ redirect: res.headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new UrlSafetyError('The page returned status ' + status + '.', 'http_error'));
        return;
      }
      const contentType = res.headers['content-type'] || '';
      if (!ALLOWED_CONTENT_TYPE_RE.test(contentType)) {
        res.resume();
        reject(new UrlSafetyError('Unsupported content type for research context.', 'unsupported_content_type'));
        return;
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { req.destroy(); reject(new UrlSafetyError('The page is too large to use as context.', 'too_large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), contentType }));
      res.on('error', (err) => reject(err));
    });
    req.on('timeout', () => { req.destroy(); reject(new UrlSafetyError('Timed out fetching that page.', 'timeout')); });
    req.on('error', (err) => reject(new UrlSafetyError(err.message || 'Fetch failed.', 'fetch_error')));
    req.end();
  });
}

// Same lightweight regex-based extraction _fetchWebsiteText already uses
// (server.js) -- title, meta description, and visible-text-ish content
// with script/style/nav noise stripped. Deliberately not a full DOM
// parser; this project has none as a dependency and this is a "good
// enough for LLM context" extraction, not a rendering engine.
function extractContent(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  text = text.slice(0, MAX_EXTRACTED_TEXT);
  return {
    title: titleMatch ? titleMatch[1].trim().slice(0, 200) : null,
    description: descMatch ? descMatch[1].trim().slice(0, 400) : null,
    text,
  };
}

// Fetches and extracts ONE user-provided URL, fully validated and
// SSRF-protected end to end (including across redirects). Never throws
// for an ordinary "this URL/page didn't work" case -- returns
// { ok:false, url, reason, code } instead, so a single bad URL can never
// take down a whole research request. A genuinely unexpected error still
// resolves the same honest shape rather than propagating.
async function fetchUrlContext(rawUrl) {
  let current;
  try {
    current = validateUrlSyntax(rawUrl);
  } catch (err) {
    return { ok: false, url: rawUrl, reason: err.message, code: err.code };
  }
  let hop = 0;
  try {
    while (true) {
      hop += 1;
      if (hop > MAX_REDIRECTS + 1) return { ok: false, url: current.href, reason: 'Too many redirects.', code: 'too_many_redirects' };
      const { address, family } = await resolveValidatedAddress(current.hostname);
      const result = await fetchPinned(current, address, family);
      if (result.redirect) {
        let next;
        try { next = new URL(result.redirect, current); } catch { return { ok: false, url: current.href, reason: 'Invalid redirect target.', code: 'invalid_redirect' }; }
        if (!ALLOWED_PROTOCOLS.has(next.protocol)) return { ok: false, url: current.href, reason: 'Redirect used an unsupported protocol.', code: 'invalid_redirect' };
        current = next; // re-validated from scratch at the top of the next loop iteration
        continue;
      }
      const extracted = extractContent(result.body);
      return {
        ok: true,
        url: current.href,
        finalUrl: current.href,
        domain: current.hostname.replace(/^www\./, ''),
        title: extracted.title || current.hostname,
        description: extracted.description,
        text: extracted.text,
      };
    }
  } catch (err) {
    if (err instanceof UrlSafetyError) return { ok: false, url: (current && current.href) || rawUrl, reason: err.message, code: err.code };
    return { ok: false, url: (current && current.href) || rawUrl, reason: 'Could not fetch that page.', code: 'fetch_error' };
  }
}

module.exports = {
  fetchUrlContext,
  validateUrlSyntax,
  MAX_URLS,
  MAX_REDIRECTS,
  MAX_BYTES,
  // exported for unit testing the SSRF logic directly without real DNS/network
  _internal: { isBlockedIP, isBlockedV4, isBlockedV6, ipv4ToLong },
};
