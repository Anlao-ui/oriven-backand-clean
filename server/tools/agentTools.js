// ════════════════════════════════════════════════════════════════
// Personal assistant tools for the Oriven Tool Router.
//
// Same rule as tools/campaignTools.js: every tool calls an EXISTING route on
// this server with the user's own Authorization header (loopback HTTP), so
// that route's authentication, ownership filter, validation, plan limits,
// credit charge and refund-on-failure all apply unchanged. No tool touches
// the database or an ad platform directly, and none accepts a user id.
//
// formatCard(execResult, resolved) → a small, structured result the chat
// shows as a card (server.js returns it as toolResults[]). Only fields the
// user may see; never tokens or raw provider payloads.
// ════════════════════════════════════════════════════════════════

const toolRouter = require('../services/toolRouter');
const M = require('../services/automations/metrics');
const P = require('../services/automations/platforms');
const { RULE_ACTIONS, MODES } = require('../services/automations/engine');

const PORT = parseInt(process.env.PORT || '5500', 10);
const BASE = `http://localhost:${PORT}`;

async function _authedFetch(ctx, method, path, body) {
  const headers = { Authorization: ctx.authHeader };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `Request to ${path} failed (${resp.status})`);
    err.status = resp.status;
    err.code = data && data.code;
    err.friendlyMessage = (data && data.error) || 'That could not be completed. Please try again.';
    err.data = data;
    throw err;
  }
  return data;
}
const _str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n || 300) : '');

// ── Pages the assistant may open: one list shared with the Marketing Plan
// and Progress (services/pageKeys.js). Neutral keys: the browser maps each
// one to the app's own navigation (js/pageRegistry.js). ──────────────────
const { PAGES } = require('../services/pageKeys');

toolRouter.register({
  name: 'open_page',
  description: 'Offer the user a button that opens a page in OrivenAI (use when they need to do something there themselves, e.g. connect an ad account or publish in Launch). Free.',
  params: `{ page: ${Object.keys(PAGES).map((k) => '"' + k + '"').join('|')} }`,
  requiresConfirmation: false,
  resolve: (params) => {
    const key = _str(params.page, 40).toLowerCase();
    if (!PAGES[key]) return { unsupported: 'I can’t open that page.' };
    return { key };
  },
  execute: async (resolved) => ({ key: resolved.key }),
  formatResult: (_r, resolved) => `A button to open ${PAGES[resolved.key].label} is shown below the answer.`,
  formatCard: (_r, resolved) => ({ type: 'link', title: 'Open ' + PAGES[resolved.key].label, page: resolved.key }),
});

toolRouter.register({
  name: 'get_credit_balance',
  description: 'Read the user’s current credit balance and access period. Free.',
  params: '{}',
  requiresConfirmation: false,
  resolve: () => ({}),
  execute: (_r, ctx) => _authedFetch(ctx, 'GET', '/api/credits/status'),
  formatResult: (s) => `Credit balance: ${s && s.balance != null ? s.balance : 'unknown'} credits` + (s && s.accessExpiresAt ? `; access until ${String(s.accessExpiresAt).slice(0, 10)}` : '') + '.',
  formatCard: (s) => ({ type: 'credits', title: 'Credits', balance: s && typeof s.balance === 'number' ? s.balance : null }),
});

toolRouter.register({
  name: 'list_campaigns',
  description: 'List the user’s campaigns saved in OrivenAI (drafts, published, live) with platform and status. Free. Use before improving or discussing "my campaigns".',
  params: '{ status?: "draft"|"published"|"active"|"paused" }',
  requiresConfirmation: false,
  resolve: (params) => ({ status: _str(params.status, 20).toLowerCase() || null }),
  execute: async (resolved, ctx) => {
    const res = await _authedFetch(ctx, 'GET', '/api/campaigns');
    let rows = Array.isArray(res && res.campaigns) ? res.campaigns : [];
    rows = rows.filter((c) => c.status !== 'archived');
    if (resolved.status) rows = rows.filter((c) => String(c.status || '').toLowerCase() === resolved.status);
    return { campaigns: rows.slice(0, 15).map((c) => ({ id: c.id, name: c.name, platform: c.platform, status: c.status, objective: c.objective, updated: c.updated_at })), total: rows.length };
  },
  formatResult: (r) => r.total
    ? `${r.total} campaign(s): ` + r.campaigns.map((c) => `"${c.name}" (${c.platform || 'no platform'}, ${c.status || 'draft'})`).join('; ')
    : 'The user has no saved campaigns yet.',
  formatCard: (r) => ({ type: 'list', title: r.total ? `Your campaigns (${r.total})` : 'No campaigns yet', items: r.campaigns.map((c) => ({ text: c.name, meta: [c.platform, c.status].filter(Boolean).join(' · ') })), page: 'launch' }),
});

// ── Research (async job: start now, read when ready) ──────────────────
const RESEARCH_TYPES = ['market', 'competitor', 'audience', 'opportunity'];
toolRouter.register({
  name: 'start_research',
  description: 'Start a Research report from real web sources (market, competitor, audience or opportunity research). Costs credits (see the guide) and runs in the background for a few minutes; tell the user it started and that the result appears here and in the Research library.',
  params: '{ type: "market"|"competitor"|"audience"|"opportunity", question: string (one clear research question, include names, product and country when known) }',
  requiresConfirmation: false,
  resolve: (params) => {
    const question = _str(params.question, 500);
    if (question.length < 8) return { needsClarification: 'What exactly should I research — the market, specific competitors, your audience or new opportunities?' };
    const type = RESEARCH_TYPES.includes(params.type) ? params.type : 'market';
    return { type, question };
  },
  execute: (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/research/query', { type: resolved.type, question: resolved.question }),
  formatResult: (r, resolved) => `Research started (${resolved.type}): "${resolved.question}". Report id ${r.reportId}. It runs for a few minutes.`,
  formatCard: (r, resolved) => ({ type: 'research', title: 'Research started', reportId: r.reportId, question: resolved.question, researchType: resolved.type, page: 'research' }),
});

// A compact, factual digest of a finished report (services/researchReport.js
// v2 shape): what the model needs to summarise and recommend, nothing more.
function _researchDigest(rep) {
  const r = rep || {};
  const t = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 220);
  const pick = (arr, f, n) => (Array.isArray(arr) ? arr.slice(0, n || 4).map(f).filter(Boolean) : []);
  const out = [];
  if (r.summary) out.push('Summary: ' + t(r.summary, 600));
  const kc = pick(r.keyConclusions, (x) => x && t(x.text), 5); if (kc.length) out.push('Key conclusions: ' + kc.join(' | '));
  if (r.marketOverview && r.marketOverview.description) out.push('Market: ' + t(r.marketOverview.description, 300));
  const comp = pick(r.competitors, (x) => x && x.name && (t(x.name, 60) + (x.positioning ? ' — ' + t(x.positioning, 140) : '')), 5); if (comp.length) out.push('Competitors: ' + comp.join(' | '));
  const sig = pick(r.signals, (x) => x && t(x.text, 140), 4); if (sig.length) out.push('Customer signals: ' + sig.join(' | '));
  const opp = pick(r.opportunities, (x) => x && x.title && (t(x.title, 100) + (x.angle ? ' (angle: ' + t(x.angle, 100) + ')' : '')), 4); if (opp.length) out.push('Opportunities: ' + opp.join(' | '));
  const ang = pick(r.angles, (x) => x && x.angle && (t(x.angle, 100) + (x.message ? ': "' + t(x.message, 90) + '"' : '')), 4); if (ang.length) out.push('Ad angles: ' + ang.join(' | '));
  const nx = pick(r.nextSteps, (x) => x && t(x.action, 140), 3); if (nx.length) out.push('Next steps: ' + nx.join(' | '));
  if (r.limitations) out.push('Limitations: ' + t(Array.isArray(r.limitations) ? r.limitations.join('; ') : r.limitations, 300));
  return out.join('\n').slice(0, 3000);
}
toolRouter.register({
  name: 'get_research',
  description: 'Read a Research report (by id, or the most recent one) to summarise it and recommend next steps. Free. A report that is still running has no findings yet.',
  params: '{ reportId?: string }',
  requiresConfirmation: false,
  resolve: (params) => ({ reportId: /^[0-9a-f-]{8,64}$/i.test(String(params.reportId || '')) ? String(params.reportId) : null }),
  execute: async (resolved, ctx) => {
    let id = resolved.reportId;
    if (!id) {
      const list = await _authedFetch(ctx, 'GET', '/api/research/reports');
      const first = list && Array.isArray(list.reports) && list.reports[0];
      if (!first) return { none: true };
      id = first.id;
    }
    const r = await _authedFetch(ctx, 'GET', '/api/research/reports/' + encodeURIComponent(id));
    const sum = (r && r.summary) || {};
    return { id, title: (r && r.report && r.report.title) || sum.title || sum.question || '', status: sum.status || (r && r.report ? 'ready' : null), digest: r && r.report ? _researchDigest(r.report) : '' };
  },
  formatResult: (r) => r.none ? 'The user has no research reports yet.'
    : r.status === 'running' ? `Report "${r.title}" is still running; it has no findings yet.`
    : r.status === 'failed' ? `Report "${r.title}" failed; no credits were kept for it.`
    : `Report "${r.title}" (${r.status || 'ready'}):\n${r.digest || '(no findings in this report)'}`,
  formatCard: (r) => r.none ? null : ({ type: 'research', title: r.title || 'Research report', reportId: r.id, status: r.status, page: 'research' }),
});

// ── Automations ───────────────────────────────────────────────────────
toolRouter.register({
  name: 'list_automations',
  description: 'List the user’s automations (schedules and rules) with their status. Free.',
  params: '{}',
  requiresConfirmation: false,
  resolve: () => ({}),
  execute: async (_r, ctx) => {
    const res = await _authedFetch(ctx, 'GET', '/api/automations');
    const rows = Array.isArray(res && res.automations) ? res.automations : [];
    return { automations: rows.slice(0, 15).map((a) => ({ name: a.name, platform: a.platform, status: a.status, summary: a.summary || null })), total: rows.length };
  },
  formatResult: (r) => r.total ? `${r.total} automation(s): ` + r.automations.map((a) => `"${a.name}" (${a.platform}, ${a.status})${a.summary ? ': ' + a.summary : ''}`).join('; ') : 'The user has no automations yet.',
  formatCard: (r) => ({ type: 'list', title: r.total ? `Your automations (${r.total})` : 'No automations yet', items: r.automations.map((a) => ({ text: a.name, meta: [a.platform, a.status].filter(Boolean).join(' · ') })), page: 'automations' }),
});

toolRouter.register({
  name: 'create_automation',
  description: 'Create an automation RULE for the user’s published campaigns: when a metric crosses a value, notify the user, ask for approval, or act automatically within limits. Needs the user’s confirmation; costs credits. Get campaign ids from list_campaigns (only published campaigns qualify).',
  params: `{ name: string, platform: ${P.PLATFORMS.map((p) => '"' + p + '"').join('|')}, scope: { type: "account" } | { type: "campaigns", campaign_ids: string[] }, condition: { metric: ${Object.keys(M.METRICS).map((k) => '"' + k + '"').join('|')}, operator: ${Object.keys(M.OPERATORS).map((k) => '"' + k + '"').join('|')}, value: number (or "active"|"paused" for status) }, window?: ${M.DATA_WINDOWS.join('|')} (days, default 7), action: ${RULE_ACTIONS.map((a) => '"' + a + '"').join('|')}, mode: ${MODES.map((m) => '"' + m + '"').join('|')}, percent?: number (budget actions), limits?: { max_daily_budget?: number, min_daily_budget?: number } }`,
  requiresConfirmation: true,
  resolve: async (params, ctx) => {
    const body = {
      kind: 'rule', name: _str(params.name, 120), platform: params.platform, scope: params.scope,
      condition: params.condition, window: params.window, action: params.action, mode: params.mode,
      percent: params.percent, limits: params.limits, min_data: params.min_data,
      // Automatic budget/status changes still need the user's yes — given by
      // confirming this action card.
      confirm_automatic: params.mode === 'automatic' ? true : undefined,
    };
    let prev;
    try { prev = await _authedFetch(ctx, 'POST', '/api/automations/preview', body); }
    catch (err) {
      const errs = err.data && Array.isArray(err.data.errors) ? err.data.errors.map((e) => e.message) : [err.friendlyMessage];
      return { needsClarification: 'Before I can set this up: ' + errs.slice(0, 3).join(' ') };
    }
    if (prev && prev.limitReached) return { unsupported: 'Your plan’s limit of active automations is reached. Pause or delete one in Automations first.' };
    return { body, summary: (prev && prev.summary) || body.name, cost: prev && prev.cost };
  },
  execute: (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/automations', resolved.body),
  formatSummary: (r) => `Create automation: ${typeof r.summary === 'string' ? r.summary : r.body.name}` + (r.cost ? ` (${r.cost} credits)` : ''),
  formatResult: (res) => `Automation "${res.automation && res.automation.name}" is active` + (res.charged ? ` (${res.charged} credits used).` : '.'),
  formatCard: (res) => ({ type: 'done', title: 'Automation created', text: res.automation && res.automation.name, page: 'automations' }),
});

module.exports = { PAGES, RESEARCH_TYPES, _researchDigest };
