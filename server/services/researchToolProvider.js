// ════════════════════════════════════════════════════════════════
// Research Tool Provider — Real Retrieval adapter (Research Production
// Sprint).
//
// A clean boundary between the Research engine (server.js) and whatever
// underlying search/retrieval mechanism is actually configured. The
// Research engine consumes only normalized results from this module —
// it never knows or cares whether the underlying call is AIML's
// perplexity/sonar, a future Responses-API provider, or something else
// entirely. Swapping the retrieval mechanism later means editing this
// one file, not server.js.
//
// Capability detection here is NOT a blind "Astra officially supports
// X" claim. It reflects what THIS project's configured provider
// (AIMLAPI) was actually verified — via their own published
// documentation, not a live API call (this account currently has zero
// funds; no live/paid testing is in scope) — to expose:
//   - AIMLAPI documents a real, native web-search capability for a
//     specific model list: gpt-4o-search-preview, gpt-4o-mini-search-
//     preview, perplexity/sonar, perplexity/sonar-pro,
//     alibaba/qwen3.6-{flash,plus,max-preview}, moonshot/kimi-k2-
//     {preview,0905-preview}. openai/gpt-6-astra is CONFIRMED NOT on
//     that list — Astra supports web search natively on OpenAI's own
//     platform, but AIMLAPI's proxy for this specific model does not
//     expose it, despite some of AIMLAPI's own model-reference pages
//     appearing to describe Astra's general OpenAI-side capabilities.
//   - perplexity/sonar is used as the search model here: per AIMLAPI's
//     documented example, it needs no `tools` array (web search is
//     native/automatic for this model — a plain chat completion
//     returns real `citations` (string[]) and `search_results`
//     ({title,url,date,last_updated}[]) fields alongside the normal
//     `choices` array), which reuses this codebase's existing plain-
//     fetch Chat Completions pattern with zero new request-shape
//     complexity.
//   - AIMLAPI's own gpt-6-astra reference page also documents a
//     `/v1/responses` endpoint with tool/web-search/computer-use/MCP
//     references, but a sitemap-level documentation search returned no
//     dedicated "Responses API" or "computer use" pages, and no
//     concrete request/response JSON example for that endpoint was
//     found anywhere in AIMLAPI's docs. Treated as documented-but-
//     unverified below, never assumed working.
// ════════════════════════════════════════════════════════════════

const aimlProvider = require('../providers/aimlProvider');
const modelRouter = require('./modelRouter');

const MAX_SEARCH_RESULTS = 8;
const MAX_QUERY_LEN = 300;

// ── Capability detection ──────────────────────────────────────────
function getCapabilities() {
  return {
    provider: 'aimlapi',
    webSearch: true,                          // verified via AIMLAPI docs (model list above)
    webSearchModel: modelRouter.MODELS.aiml.webSearch,
    astraWebSearch: false,                    // verified: gpt-6-astra is not on AIMLAPI's web-search model list
    responsesApi: 'documented_unverified',    // documented for gpt-6-astra, but no concrete example found, no live call made
    computerUse: false,                       // no dedicated documentation page found; not assumed available
    mcp: 'documented_unverified',
    functionCalling: true,                    // standard OpenAI-compatible tools/tool_choice, already plumbed in aimlProvider.generateText
    structuredOutputs: 'prompt_enforced',      // no native JSON-schema mode confirmed; enforced via prompt + server-side validation (server.js _rm* helpers)
    streaming: 'unverified',
  };
}

// Deterministic domain-based classification — never a fabricated
// "quality score" (spec 29). Conservative and easy to extend.
function classifySourceType(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/wikipedia\.org$/.test(host)) return 'reference';
    if (/reddit\.com$|forum\.|community\./.test(host)) return 'community';
    if (/amazon\.|etsy\.|shopify\./.test(host)) return 'marketplace';
    if (/\.(gov|edu)$/.test(host)) return 'official';
    if (/news\.|reuters\.|bloomberg\.|forbes\.|techcrunch\./.test(host)) return 'news';
    if (/instagram\.|tiktok\.|facebook\.|x\.com|twitter\./.test(host)) return 'social';
    if (/ads\.|library|transparency/.test(host)) return 'advertising';
    return 'web';
  } catch (_) {
    return 'web';
  }
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'].forEach((p) => u.searchParams.delete(p));
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return rawUrl;
  }
}

// search(query) — the one real retrieval primitive. Returns
// { ok:true, answer, sources, resultCount } on success or
// { ok:false, reason } on any failure. Never throws for an expected
// provider failure (billing/network/malformed shape) — the Research
// engine treats a real failure as "live web retrieval unavailable right
// now" and falls back to the existing honest synthesis-only path,
// never a crash, never fabricated data.
async function search(query) {
  const q = String(query || '').trim().slice(0, MAX_QUERY_LEN);
  if (!q) return { ok: false, reason: 'empty_query' };
  try {
    const route = modelRouter.routeTask('research-web-search');
    const data = await aimlProvider.generateText(
      'Answer using real web search grounding. Be concise and factual.',
      q,
      { model: route.model, max_tokens: 900, returnFull: true }
    );
    const message = data && data.choices && data.choices[0] && data.choices[0].message;
    const searchResults = Array.isArray(data && data.search_results) ? data.search_results : [];
    const citations = Array.isArray(data && data.citations) ? data.citations : [];

    const seen = new Set();
    const sources = [];
    searchResults.slice(0, MAX_SEARCH_RESULTS).forEach((r) => {
      if (!r || typeof r.url !== 'string' || !r.url.trim()) return;
      const normUrl = normalizeUrl(r.url.trim());
      if (seen.has(normUrl)) return;
      seen.add(normUrl);
      let domain = '';
      try { domain = new URL(normUrl).hostname.replace(/^www\./, ''); } catch (_) {}
      sources.push({
        id: 'ws' + (sources.length + 1),
        title: (typeof r.title === 'string' && r.title.trim()) ? r.title.trim().slice(0, 200) : domain,
        url: normUrl,
        domain,
        sourceType: classifySourceType(normUrl),
        query: q,
        retrievedAt: new Date().toISOString(),
        publishedDate: (typeof r.date === 'string' && r.date.trim()) ? r.date.trim() : null,
      });
    });
    // citations[]-only fallback — some responses may only carry plain
    // cited URLs without the richer search_results objects.
    citations.forEach((url) => {
      if (sources.length >= MAX_SEARCH_RESULTS || typeof url !== 'string' || !url.trim()) return;
      const normUrl = normalizeUrl(url.trim());
      if (seen.has(normUrl)) return;
      seen.add(normUrl);
      let domain = '';
      try { domain = new URL(normUrl).hostname.replace(/^www\./, ''); } catch (_) {}
      sources.push({ id: 'ws' + (sources.length + 1), title: domain, url: normUrl, domain, sourceType: classifySourceType(normUrl), query: q, retrievedAt: new Date().toISOString(), publishedDate: null });
    });

    return { ok: true, answer: (message && message.content) || '', sources, resultCount: sources.length };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'search_failed' };
  }
}

module.exports = { getCapabilities, search, normalizeUrl, classifySourceType, MAX_SEARCH_RESULTS, MAX_QUERY_LEN };
