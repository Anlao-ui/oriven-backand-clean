// ════════════════════════════════════════════════════════════════
// Business Brain tools for the Oriven Tool Router (V7 Phase 1).
//
// Same principle as tools/campaignTools.js: every tool calls an existing
// backend route over an internal loopback HTTP request, never touches the
// database directly. remember_business_fact reuses the exact confirmation-
// card flow already built for campaign actions — "Would you like me to
// remember this?" is the same pending-action mechanism, not a new one.
// ════════════════════════════════════════════════════════════════

const toolRouter = require('../services/toolRouter');

const PORT = parseInt(process.env.PORT || '5500', 10);
const BASE = `http://localhost:${PORT}`;

async function _authedFetch(ctx, method, path, body) {
  const headers = { Authorization: ctx.authHeader };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `Request to ${path} failed (${resp.status})`);
    err.status = resp.status;
    err.friendlyMessage = (data && data.error) || 'That could not be saved.';
    throw err;
  }
  return data;
}

const MEMORY_TYPES = ['fact', 'winning_headline', 'winning_cta', 'winning_campaign', 'winning_audience', 'winning_keyword', 'winning_platform', 'winning_offer', 'winning_landing_page', 'preference'];

toolRouter.register({
  name: 'remember_business_fact',
  description: 'Save a new piece of business knowledge Oriven just learned from the conversation (e.g. a new product, a preference, a rule) into the permanent Business Brain so it never has to be explained again. Always confirm before saving.',
  params: '{ content: string, type?: "fact"|"preference"|"winning_headline"|"winning_cta"|"winning_campaign"|"winning_audience"|"winning_keyword"|"winning_platform"|"winning_offer"|"winning_landing_page" }',
  requiresConfirmation: true,
  resolve: (params) => {
    if (!params.content || !String(params.content).trim()) return { needsClarification: 'What should I remember?' };
    const type = MEMORY_TYPES.includes(params.type) ? params.type : 'fact';
    return { content: String(params.content).trim(), type };
  },
  execute: (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/business/memory', { content: resolved.content, type: resolved.type, source: 'chat' }),
  formatSummary: (r) => `Remember: "${r.content}"`,
  formatResult: (_res, r) => `Got it — I'll remember that ${r.content.charAt(0).toLowerCase() + r.content.slice(1)}`
});

module.exports = {};
