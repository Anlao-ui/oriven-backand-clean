// ════════════════════════════════════════════════════════════════
// Exchange rates for DISPLAY ONLY (GET /api/exchange-rates).
//
// The pricing page can show approximate prices in other currencies. Nothing
// here affects what a customer pays: checkout sends only a plan id, and the
// server charges that plan's EUR Stripe Price (services/pricing.js).
//
// Source: the European Central Bank's daily euro reference rates (free, no
// API key, EUR as the base, published once per working day around 16:00 CET).
// The rates are cached in memory for 12 hours, so the ECB is asked at most
// twice a day per server instance however many visitors open the page. If
// the ECB cannot be reached, the last good rates keep being served (marked
// stale); with no rates at all the endpoint answers 503 and the page stays
// in EUR.
// ════════════════════════════════════════════════════════════════

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const TTL_MS = 12 * 60 * 60 * 1000;      // serve cached rates this long
const RETRY_MS = 10 * 60 * 1000;          // after a failure, wait this long before asking again
const TIMEOUT_MS = 5000;

let _cache = null;          // { base, date, rates, fetchedAt }
let _lastFailureAt = 0;
let _inflight = null;
let _fetch = (...a) => fetch(...a);

// ECB XML: <Cube time="2026-11-04"> … <Cube currency="USD" rate="1.0812"/> …
function parseEcb(xml) {
  const date = (/time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml) || [])[1] || null;
  const rates = {};
  const re = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
  let m;
  while ((m = re.exec(xml))) {
    const r = Number(m[2]);
    if (Number.isFinite(r) && r > 0) rates[m[1]] = r;
  }
  if (!date || Object.keys(rates).length === 0) throw new Error('unexpected ECB response');
  rates.EUR = 1;
  return { date, rates };
}

async function fetchFresh() {
  const res = await _fetch(ECB_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/xml, text/xml' } });
  if (!res.ok) throw new Error('ECB answered ' + res.status);
  const parsed = parseEcb(await res.text());
  return { base: 'EUR', date: parsed.date, rates: parsed.rates, fetchedAt: Date.now() };
}

// Cached rates; refreshes when older than TTL_MS. One request at a time.
// Returns { base, date, rates, stale } or null when no rates are available.
async function getRates(now = Date.now()) {
  const fresh = _cache && now - _cache.fetchedAt < TTL_MS;
  const backingOff = now - _lastFailureAt < RETRY_MS;
  if (!fresh && !backingOff) {
    if (!_inflight) {
      _inflight = fetchFresh()
        .then((r) => { _cache = r; })
        .catch((e) => { _lastFailureAt = Date.now(); console.warn('[ExchangeRates] ECB fetch failed:', e.message); })
        .finally(() => { _inflight = null; });
    }
    await _inflight;
  }
  if (!_cache) return null;
  return { base: _cache.base, date: _cache.date, rates: _cache.rates, stale: Date.now() - _cache.fetchedAt >= TTL_MS };
}

// Express handler. Browsers and CDNs may keep the answer for an hour.
async function handler(req, res) {
  const r = await getRates();
  if (!r) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'Exchange rates are unavailable right now.', code: 'RATES_UNAVAILABLE', base: 'EUR' });
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(Object.assign({ note: 'Display only. All payments are processed in EUR.' }, r));
}

// Tests only.
function _reset(opts = {}) { _cache = null; _lastFailureAt = 0; _inflight = null; _fetch = opts.fetch || ((...a) => fetch(...a)); }

module.exports = { getRates, handler, parseEcb, ECB_URL, TTL_MS, RETRY_MS, _reset };
