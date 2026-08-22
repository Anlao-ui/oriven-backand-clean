// ════════════════════════════════════════════════════════════════
// Ad-editing tools for the Oriven Tool Router — the conversational
// editing workspace that opens after a campaign package has been
// generated (POST /api/ai/create-ad), before it's ever published to a
// live platform.
//
// Unlike campaignTools.js (which resolves/mutates LIVE, already-published
// campaigns by campaignId via internal HTTP calls), these tools operate
// on the unpublished `pkg` object the frontend already holds in memory
// and localStorage. There is no live external resource to mutate, so
// each tool reads/writes fields on ctx.currentCampaign.pkg (forwarded
// verbatim by /api/ai/chat from the client's window.orvContext.campaign,
// see server.js's ai/chat route) and returns the new value for the
// frontend to apply to its own copy of pkg and persist via
// window._orvUpdateCampPkg — the backend never owns this object.
//
// Where real AI/generation work is needed, every tool proxies to an
// EXISTING, already credit-metered route (never re-implementing the
// charge or the model call): /api/creative/improve (campaign_improvement,
// 10 credits) for text rewrites, /api/generate-image (image_generation,
// 75 credits) for new creatives, /api/ai/create-ad (campaign_generation,
// 25 credits) for a genuine platform conversion. Simple direct-value
// edits (explicit CTA text, explicit budget number, explicit audience
// text) touch nothing but the pkg field itself — no extra charge beyond
// the base ai_chat cost already reserved once per chat message.
// ════════════════════════════════════════════════════════════════

const toolRouter = require('../services/toolRouter');

const PORT = parseInt(process.env.PORT || '5500', 10);
const BASE = `http://localhost:${PORT}`;

const PLATFORM_LABELS = { google: 'Google Ads', meta: 'Meta Ads', tiktok: 'TikTok Ads' };

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
    const rawMsg = (data && data.error) || `Request to ${path} failed (${resp.status})`;
    const err = new Error(rawMsg);
    err.status = resp.status;
    err.code = data && data.code;
    err.friendlyMessage = err.status === 402
      ? rawMsg
      : `That didn't go through. Please try again in a moment.`;
    throw err;
  }
  return data;
}

function _currentPkg(ctx) {
  return ctx.currentCampaign && ctx.currentCampaign.pkg ? ctx.currentCampaign.pkg : null;
}

const NO_CAMPAIGN = { needsClarification: "You don't have a campaign open right now — generate one first." };

// ── edit_ad_copy — headline / description / primary text / CTA ────────
// Field-to-pkg-path map, one entry per platform where that field
// genuinely exists in the generated package shape (server.js's
// googleAds/metaAds/tiktokAds schemas — see _generateAdPackage). A
// field with no mapping for the current platform is "unsupported", not
// silently faked onto a field that doesn't exist there.
const FIELD_MAP = {
  headline:    { google: ['googleAds', 'headlines', 0],   meta: ['metaAds', 'headline'],   tiktok: ['tiktokAds', 'hook'] },
  description: { google: ['googleAds', 'descriptions', 0], meta: ['metaAds', 'description'], tiktok: ['tiktokAds', 'script'] },
  primaryText: { meta: ['metaAds', 'primaryText'] },
  cta:         { meta: ['metaAds', 'cta'],                 tiktok: ['tiktokAds', 'cta'] }
};

const IMPROVE_ACTIONS = [
  'rewrite', 'improve', 'shorten', 'expand', 'premium', 'luxury', 'funny',
  'professional', 'minimal', 'high_ctr', 'high_roas', 'high_engagement'
];
const ACTION_PHRASES = {
  rewrite: 'rewrote it', improve: 'improved it', shorten: 'made it shorter', expand: 'expanded it',
  premium: 'gave it a more premium tone', luxury: 'gave it a luxury tone', funny: 'made it funnier',
  professional: 'made it more professional', minimal: 'made it more minimal',
  high_ctr: 'sharpened it for a stronger click-through', high_roas: 'strengthened the call to action',
  high_engagement: 'made it more engaging'
};

function _getPath(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

toolRouter.register({
  name: 'edit_ad_copy',
  description: "Change a text field (headline, description, primary text, or CTA) on the campaign currently open in the ad editing workspace. Pass `value` for an explicit replacement (e.g. a specific CTA), or `action` to have Oriven rewrite the current text (rewrite/improve/shorten/expand/premium/luxury/funny/professional/minimal/high_ctr/high_roas/high_engagement).",
  params: '{ field: "headline"|"description"|"primaryText"|"cta", value?: string, action?: string }',
  requiresConfirmation: false,
  resolve: async (params, ctx) => {
    const pkg = _currentPkg(ctx);
    if (!pkg) return NO_CAMPAIGN;
    const field = params.field;
    const map = FIELD_MAP[field];
    if (!map) return { needsClarification: 'Which field — headline, description, primary text, or CTA?' };
    const path = map[pkg.platform];
    if (!path) return { unsupported: `${PLATFORM_LABELS[pkg.platform]} campaigns don't have a ${field === 'primaryText' ? 'primary text' : field} field in Oriven today.` };

    if (params.value && String(params.value).trim()) {
      return { platform: pkg.platform, field, path, value: String(params.value).trim(), direct: true };
    }
    const action = params.action;
    if (!action || !IMPROVE_ACTIONS.includes(action)) return { needsClarification: `How would you like the ${field} changed?` };
    const currentValue = _getPath(pkg, path);
    if (!currentValue) return { needsClarification: `There's no existing ${field} to work from yet.` };
    return { platform: pkg.platform, field, path, action, currentValue, direct: false };
  },
  execute: async (resolved, ctx) => {
    if (resolved.direct) return { path: resolved.path, field: resolved.field, value: resolved.value };
    const res = await _authedFetch(ctx, 'POST', '/api/creative/improve', { text: resolved.currentValue, action: resolved.action });
    return { path: resolved.path, field: resolved.field, value: res.result, action: resolved.action };
  },
  formatSummary: (r) => r.direct ? `Change the ${r.field} to "${r.value}"` : `Change the ${r.field} (${r.action})`,
  formatResult: (execResult) => `Done. ${execResult.action ? 'I ' + ACTION_PHRASES[execResult.action] + '.' : `Updated the ${execResult.field}.`}`
});

// ── update_campaign_budget — direct, local, no AI call ─────────────────
toolRouter.register({
  name: 'update_campaign_budget',
  description: "Change the daily budget of the campaign currently open in the ad editing workspace.",
  params: '{ value: number }',
  requiresConfirmation: false,
  resolve: (params, ctx) => {
    const pkg = _currentPkg(ctx);
    if (!pkg) return NO_CAMPAIGN;
    const value = Number(params.value);
    if (!params.value || Number.isNaN(value) || value <= 0) return { needsClarification: 'What would you like the new daily budget to be?' };
    return { value };
  },
  execute: async (resolved) => ({ value: resolved.value }),
  formatSummary: (r) => `Change the daily budget to ${r.value}/day`,
  formatResult: (execResult) => `Done. Budget changed to ${execResult.value}/day.`
});

// ── update_audience — direct, local, no AI call ─────────────────────────
toolRouter.register({
  name: 'update_audience',
  description: "Change the target audience of the campaign currently open in the ad editing workspace.",
  params: '{ value: string }',
  requiresConfirmation: false,
  resolve: (params, ctx) => {
    const pkg = _currentPkg(ctx);
    if (!pkg) return NO_CAMPAIGN;
    if (!params.value || !String(params.value).trim()) return { needsClarification: 'Who should the audience be?' };
    return { value: String(params.value).trim() };
  },
  execute: async (resolved) => ({ value: resolved.value }),
  formatSummary: (r) => `Change the audience to "${r.value}"`,
  formatResult: () => `Done. Audience updated.`
});

// ── generate_new_creative — proxies to the existing image route ────────
toolRouter.register({
  name: 'generate_new_creative',
  description: "Generate a brand-new ad visual for the campaign currently open in the ad editing workspace, replacing the existing one. Optionally pass an instruction (e.g. 'more minimal', 'brighter, more energetic') to steer the new visual.",
  params: '{ visualConceptIndex?: number, instruction?: string }',
  requiresConfirmation: false,
  resolve: (params, ctx) => {
    const pkg = _currentPkg(ctx);
    if (!pkg) return NO_CAMPAIGN;
    const idx = Number.isInteger(params.visualConceptIndex) ? params.visualConceptIndex : (pkg.activeConceptIndex || 0);
    const vc = pkg.visualConcepts && pkg.visualConcepts[idx];
    if (!vc || !vc.imagePrompts || !vc.imagePrompts[0]) return { needsClarification: "I don't have a visual concept to generate a new creative from for this campaign." };
    const prompt = vc.imagePrompts[0] + (params.instruction ? ` — ${params.instruction}` : '');
    return { idx, prompt };
  },
  execute: async (resolved, ctx) => {
    const res = await _authedFetch(ctx, 'POST', '/api/generate-image', { prompt: resolved.prompt, size: '1:1', imageType: 'display' });
    return { idx: resolved.idx, imageUrl: res.imageUrl };
  },
  formatSummary: () => `Generate a new creative image`,
  formatResult: () => `Done. New creative ready.`
});

// ── convert_platform — a genuine regeneration, not a relabel ───────────
toolRouter.register({
  name: 'convert_platform',
  description: "Convert the campaign currently open in the ad editing workspace to a different advertising platform (Google, Meta, or TikTok) — regenerates the full campaign package for the new platform's ad format.",
  params: '{ platform: "google"|"meta"|"tiktok" }',
  requiresConfirmation: false,
  resolve: (params, ctx) => {
    const cc = ctx.currentCampaign;
    const pkg = cc && cc.pkg;
    if (!pkg) return NO_CAMPAIGN;
    const platform = params.platform;
    if (!['google', 'meta', 'tiktok'].includes(platform)) return { needsClarification: 'Which platform — Google, Meta, or TikTok?' };
    if (platform === pkg.platform) return { unsupported: `This campaign is already set up for ${PLATFORM_LABELS[platform]}.` };
    const product = cc.prompt || pkg.campaignName || (pkg.strategy && pkg.strategy.positioning) || 'this product';
    const goal = (pkg.strategy && pkg.strategy.goal) || cc.goal || 'Sales';
    return { platform, product, goal };
  },
  execute: async (resolved, ctx) => {
    const body = { product: resolved.product, goal: resolved.goal, platform: resolved.platform, platforms: [resolved.platform], mode: 'full', brandCore: ctx.brandCore || undefined };
    const res = await _authedFetch(ctx, 'POST', '/api/ai/create-ad', body);
    return { platform: resolved.platform, pkg: res.data || res };
  },
  formatSummary: (r) => `Convert this campaign to ${PLATFORM_LABELS[r.platform]}`,
  formatResult: (execResult) => `Done. The campaign is now formatted for ${PLATFORM_LABELS[execResult.platform]}.`
});

// ── select_concept_variant — local only, uses data already generated ───
toolRouter.register({
  name: 'select_concept_variant',
  description: "Switch which of the (up to 3) already-generated ad concept variants is shown as the active creative for the campaign currently open in the ad editing workspace. No generation involved — every generated campaign already includes 3 concept variants.",
  params: '{ index: 0|1|2 }',
  requiresConfirmation: false,
  resolve: (params, ctx) => {
    const pkg = _currentPkg(ctx);
    if (!pkg) return NO_CAMPAIGN;
    const idx = Number(params.index);
    if (![0, 1, 2].includes(idx)) return { needsClarification: 'Which version — 1, 2, or 3?' };
    if (!pkg.concepts || !pkg.concepts[idx]) return { unsupported: "This campaign doesn't have that many variants." };
    return { idx };
  },
  execute: async (resolved) => ({ idx: resolved.idx }),
  formatSummary: (r) => `Switch to concept variant ${r.idx + 1}`,
  formatResult: (execResult) => `Done. Showing version ${execResult.idx + 1}.`
});

module.exports = {};
