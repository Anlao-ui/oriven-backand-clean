// ── safeFetch: fetch() for URLs that come from users ────────────────
//
// Image URLs in a campaign package, a business website address and a source
// logo URL all arrive from the browser. Fetching them with a plain fetch()
// lets anyone make the server request internal addresses (cloud metadata at
// 169.254.169.254, localhost services, private networks) — SSRF.
//
// safeFetch(url, opts) only allows http(s) URLs whose host resolves to
// public addresses (the same blocklist as services/urlContextFetcher.js),
// follows redirects itself and re-checks every hop. It returns the normal
// fetch Response. A refused URL throws SafeFetchError (status 422).
//
// Unlike urlContextFetcher (which pins the socket to the checked address),
// this uses the global fetch so existing callers and their mocks keep
// working; the remaining gap is DNS rebinding between check and connect,
// which needs an attacker-controlled DNS server with a very short TTL.

const dns = require('dns').promises;
const net = require('net');
const { _internal: { isBlockedIP } } = require('./urlContextFetcher');

const MAX_REDIRECTS = 5;

class SafeFetchError extends Error {
  constructor(message, code) { super(message); this.code = code || 'unsafe_url'; this.status = 422; }
}

let _lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { throw new SafeFetchError('Not a valid URL.', 'invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchError('Only http:// and https:// URLs are supported.', 'invalid_protocol');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new SafeFetchError('Not a valid URL.', 'invalid_url');
  if (net.isIP(host)) {
    if (isBlockedIP(host)) throw new SafeFetchError('That address is not allowed.', 'private_address');
    return u;
  }
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw new SafeFetchError('That address is not allowed.', 'private_address');
  let records;
  try { records = await _lookup(host); } catch (_) { throw new SafeFetchError('Could not resolve that domain.', 'dns_failure'); }
  if (!Array.isArray(records) || !records.length) throw new SafeFetchError('Could not resolve that domain.', 'dns_failure');
  // fetch may connect to any of the addresses, so every one must be public.
  if (records.some((r) => isBlockedIP(r.address))) throw new SafeFetchError('That address is not allowed.', 'private_address');
  return u;
}

async function safeFetch(raw, opts) {
  let url = String(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, Object.assign({}, opts || {}, { redirect: 'manual' }));
    const loc = res.status >= 300 && res.status < 400 && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    if (!loc) return res;
    try { url = new URL(loc, url).href; } catch (_) { throw new SafeFetchError('Invalid redirect target.', 'invalid_redirect'); }
    if (res.body && typeof res.body.cancel === 'function') { try { await res.body.cancel(); } catch (_) {} }
  }
  throw new SafeFetchError('Too many redirects.', 'too_many_redirects');
}

// Tests only: replace DNS resolution (mock suites use unresolvable hosts).
function _setLookup(fn) { _lookup = fn || ((host) => dns.lookup(host, { all: true, verbatim: true })); }

module.exports = { safeFetch, assertPublicUrl, SafeFetchError, MAX_REDIRECTS, _setLookup };
