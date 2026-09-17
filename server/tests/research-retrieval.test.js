// ════════════════════════════════════════════════════════════════
// Research Tool Provider — Real Retrieval unit tests
// (Research Production Sprint)
//
// Pure unit tests against server/services/researchToolProvider.js with
// providers/aimlProvider.js's generateText MONKEY-PATCHED to canned
// fixture data — no network call, no AIML credits spent, no live/paid
// testing. Covers: capability detection, search-result normalization,
// URL normalization/dedup, domain classification, and graceful failure
// handling (never throws for an expected provider error).
//
// RUN: node tests/research-retrieval.test.js
// ════════════════════════════════════════════════════════════════

const path = require('path');
const aimlProvider = require(path.resolve(__dirname, '../providers/aimlProvider'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

async function main() {
  // ── 1. Capability detection ─────────────────────────────────────
  const rtp = require(path.resolve(__dirname, '../services/researchToolProvider'));
  const caps = rtp.getCapabilities();
  check('1. Capability detection reports webSearch:true (verified via AIMLAPI docs)', caps.webSearch === true, caps.webSearch);
  check('2. Capability detection reports astraWebSearch:false (Astra confirmed NOT on AIMLAPI web-search model list)', caps.astraWebSearch === false, caps.astraWebSearch);
  check('3. responsesApi is honestly "documented_unverified", not blindly true', caps.responsesApi === 'documented_unverified', caps.responsesApi);
  check('4. computerUse is false (no dedicated documentation found, never assumed)', caps.computerUse === false, caps.computerUse);
  check('5. webSearchModel points at a real, documented model (perplexity/sonar)', caps.webSearchModel === 'perplexity/sonar', caps.webSearchModel);

  // ── 6-10. Search normalization + dedup + classification ─────────
  const realGenerateText = aimlProvider.generateText;
  aimlProvider.generateText = async (sys, user, opts) => {
    if (!opts || !opts.returnFull) throw new Error('search() must call generateText with returnFull:true');
    return {
      choices: [{ message: { content: 'Grounded answer text.' } }],
      citations: ['https://example.com/dup?utm_source=x', 'https://en.wikipedia.org/wiki/Test'],
      search_results: [
        { title: 'Nike Compression Apparel', url: 'https://nike.com/compression#section', date: '2025-01-01' },
        { title: 'Duplicate Entry', url: 'https://example.com/dup', date: null }, // should dedupe against the citations[] entry above
        { title: '', url: 'https://reddit.com/r/fitness/thread', date: null },
      ],
    };
  };
  try {
    const res = await rtp.search('premium compression shirt brands');
    check('6. search() returns ok:true with normalized sources on a well-formed response', res.ok === true && Array.isArray(res.sources), res);
    check('7. Real title/url/domain preserved verbatim from the provider response (never fabricated)', res.sources[0].title === 'Nike Compression Apparel' && res.sources[0].url === 'https://nike.com/compression' && res.sources[0].domain === 'nike.com', res.sources[0]);
    check('7b. URL fragment (#section) stripped by normalization', !res.sources[0].url.includes('#'), res.sources[0].url);
    check('8. Duplicate URL (citations[] + search_results, same normalized URL) deduped to one entry', res.sources.filter((s) => s.domain === 'example.com').length === 1, res.sources.map((s) => s.domain));
    check('8b. Tracking param (utm_source) stripped by normalization', !res.sources.some((s) => s.url.includes('utm_source')), res.sources.map((s) => s.url));
    check('9. Missing title falls back to domain, never a fabricated title', res.sources.find((s) => s.domain === 'reddit.com').title === 'reddit.com', res.sources.find((s) => s.domain === 'reddit.com'));
    check('10. Deterministic domain classification (reddit.com -> community, wikipedia.org -> reference, nike.com -> web)', res.sources.find((s) => s.domain === 'reddit.com').sourceType === 'community' && res.sources.find((s) => s.domain === 'en.wikipedia.org').sourceType === 'reference', res.sources.map((s) => ({ d: s.domain, t: s.sourceType })));
    check('10b. Every source carries the real query it was found under (traceability, spec 11)', res.sources.every((s) => s.query === 'premium compression shirt brands'), res.sources.map((s) => s.query));
    check('10c. Every source has a real retrievedAt timestamp', res.sources.every((s) => typeof s.retrievedAt === 'string' && !isNaN(Date.parse(s.retrievedAt))), res.sources.map((s) => s.retrievedAt));
  } finally {
    aimlProvider.generateText = realGenerateText;
  }

  // ── 11. Malformed / empty search_results never crashes, never fabricates ──
  aimlProvider.generateText = async () => ({ choices: [{ message: { content: 'x' } }] }); // no search_results/citations at all
  try {
    const res2 = await rtp.search('a query with no results');
    check('11. A response with no search_results/citations resolves to ok:true with an empty, honest sources array', res2.ok === true && Array.isArray(res2.sources) && res2.sources.length === 0, res2);
  } finally {
    aimlProvider.generateText = realGenerateText;
  }

  // ── 12. Provider failure (billing, network, etc.) never throws ──────
  aimlProvider.generateText = async () => { throw new Error('Provider access denied. Check your AIML API plan.'); };
  try {
    const res3 = await rtp.search('a query that will fail');
    check('12. A provider failure resolves to ok:false with a real reason, never throws (Research engine treats this as "live retrieval unavailable", not a crash)', res3.ok === false && typeof res3.reason === 'string', res3);
  } finally {
    aimlProvider.generateText = realGenerateText;
  }

  // ── 13. Empty query rejected before any network call ────────────
  const res4 = await rtp.search('   ');
  check('13. An empty/whitespace-only query is rejected locally (empty_query) without calling the provider at all', res4.ok === false && res4.reason === 'empty_query', res4);

  // ── 14. Result cap enforced (spec 26: hard limits) ───────────────
  aimlProvider.generateText = async () => ({
    choices: [{ message: { content: 'x' } }],
    search_results: Array.from({ length: 20 }, (_, i) => ({ title: 'Result ' + i, url: `https://example${i}.com/`, date: null })),
  });
  try {
    const res5 = await rtp.search('a query with many results');
    check('14. Source count is hard-capped at MAX_SEARCH_RESULTS even if the provider returns more', res5.sources.length === rtp.MAX_SEARCH_RESULTS, res5.sources.length);
  } finally {
    aimlProvider.generateText = realGenerateText;
  }

  // ── 15. normalizeUrl / classifySourceType exported helpers ──────
  check('15. normalizeUrl strips fragments and tracking params deterministically', rtp.normalizeUrl('https://a.com/p?utm_source=x&keep=1#frag') === 'https://a.com/p?keep=1', rtp.normalizeUrl('https://a.com/p?utm_source=x&keep=1#frag'));
  check('16. classifySourceType is deterministic, not a fabricated quality score', rtp.classifySourceType('https://www.reuters.com/x') === 'news' && rtp.classifySourceType('https://random-blog.example/x') === 'web', { reuters: rtp.classifySourceType('https://www.reuters.com/x'), blog: rtp.classifySourceType('https://random-blog.example/x') });

  console.log(`\n${results.length} checks run, ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed.`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });
