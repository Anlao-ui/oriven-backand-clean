// ════════════════════════════════════════════════════════════════
// Campaign management / creation tools for the Oriven Tool Router.
//
// Every tool calls an EXISTING backend route over an internal loopback
// HTTP request (same process, same port) — never Google/Meta/TikTok
// directly, and never re-implements the mutation logic that already
// lives in those routes. This mirrors the stated principle exactly:
// User -> Oriven Brain -> Tool Router -> Existing Backend API -> platform.
// ════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const toolRouter = require('../services/toolRouter');

const PORT = parseInt(process.env.PORT || '5500', 10);
const BASE = `http://localhost:${PORT}`;

const PLATFORM_LABELS = { google: 'Google Ads', meta: 'Meta Ads', tiktok: 'TikTok Ads' };

// Some routes (e.g. Google/Meta/TikTok mutation failures) relay raw platform
// API error text via their `error` field — technical jargon, embedded codes,
// or JSON fragments that should never reach a chat reply. Anything that
// doesn't look like one of our own short, plain-English messages gets
// replaced with a clean fallback; the raw text is still logged server-side
// by the routes themselves and by toolRouter's own catch blocks.
function _looksRawProviderError(msg) {
  if (!msg) return false;
  if (msg.length > 140) return true;
  if (/[{}[\]]/.test(msg)) return true;          // embedded JSON fragment
  if (/[A-Z_]{6,}/.test(msg)) return true;        // SCREAMING_SNAKE_CASE platform error codes
  return false;
}

function _platformFromPath(path) {
  const m = /\/api\/(google|meta|tiktok)\b/.exec(path);
  return m ? PLATFORM_LABELS[m[1]] : 'The platform';
}

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
    err.friendlyMessage = _looksRawProviderError(rawMsg)
      ? `${_platformFromPath(path)} couldn't complete that request right now. Please try again in a moment, or check it directly on the platform.`
      : rawMsg;
    throw err;
  }
  return data;
}

// ── Campaign search across platforms ───────────────────────────────
async function findCampaignByName(ctx, query, platformFilter) {
  const platforms = platformFilter ? [platformFilter] : ['google', 'meta', 'tiktok'];
  const listPaths = {
    google: '/api/google/campaigns',
    meta:   '/api/meta/campaigns',
    tiktok: '/api/tiktok/campaigns'
  };

  const results = await Promise.allSettled(
    platforms.map(p => _authedFetch(ctx, 'GET', listPaths[p]))
  );

  const q = String(query || '').trim().toLowerCase();
  const matches = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value || !Array.isArray(r.value.campaigns)) return;
    const platform = platforms[i];
    r.value.campaigns.forEach(c => {
      if (!q || (c.campaign_name || '').toLowerCase().includes(q)) {
        matches.push({ platform, campaignId: c.campaign_id, campaignName: c.campaign_name, status: c.status });
      }
    });
  });
  return matches;
}

// ── Shared campaign resolution: explicit id > current campaign > name search
async function _resolveCampaign(params, ctx) {
  if (params.platform && params.campaignId) {
    return { platform: params.platform, campaignId: String(params.campaignId), campaignName: params.campaignName || null };
  }
  if (!params.campaignQuery && ctx.currentCampaign && ctx.currentCampaign.campaignId) {
    return ctx.currentCampaign;
  }
  const query = params.campaignQuery || (ctx.currentCampaign && ctx.currentCampaign.campaignName);
  if (!query) return { needsClarification: 'Which campaign do you mean?' };

  const matches = await findCampaignByName(ctx, query, params.platform);
  if (!matches.length) return { needsClarification: `I couldn't find a campaign matching "${query}". Could you check the name?` };
  if (matches.length > 1) {
    const list = matches.map(m => `"${m.campaignName}" (${PLATFORM_LABELS[m.platform]})`).join(', ');
    return { needsClarification: `I found more than one match: ${list}. Which one did you mean?` };
  }
  return matches[0];
}

function _campaignPath(platform, campaignId, suffix) {
  return `/api/${platform}/campaign/${campaignId}${suffix || ''}`;
}

// ── pause_campaign / resume_campaign / change_status ───────────────
async function _setStatus(resolved, ctx, targetStatus) {
  return _authedFetch(ctx, 'POST', _campaignPath(resolved.platform, resolved.campaignId, `/${targetStatus}`));
}

toolRouter.register({
  name: 'pause_campaign',
  description: 'Pause a running campaign so it stops spending.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta"|"tiktok" }',
  requiresConfirmation: true,
  resolve: (params, ctx) => _resolveCampaign(params, ctx),
  execute: (resolved, ctx) => _setStatus(resolved, ctx, 'pause'),
  formatSummary: (r) => `Pause "${r.campaignName}" on ${PLATFORM_LABELS[r.platform]}`,
  formatResult: (_res, r) => `"${r.campaignName}" is now paused on ${PLATFORM_LABELS[r.platform]}.`
});

toolRouter.register({
  name: 'resume_campaign',
  description: 'Resume a paused campaign so it starts spending again.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta"|"tiktok" }',
  requiresConfirmation: true,
  resolve: (params, ctx) => _resolveCampaign(params, ctx),
  execute: (resolved, ctx) => _setStatus(resolved, ctx, 'resume'),
  formatSummary: (r) => `Resume "${r.campaignName}" on ${PLATFORM_LABELS[r.platform]}`,
  formatResult: (_res, r) => `"${r.campaignName}" is now active again on ${PLATFORM_LABELS[r.platform]}.`
});

toolRouter.register({
  name: 'change_status',
  description: 'Set a campaign to active or paused. Use this when the user names a target state rather than saying "pause"/"resume" directly.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta"|"tiktok", status: "active"|"paused" }',
  requiresConfirmation: true,
  resolve: async (params, ctx) => {
    const campaign = await _resolveCampaign(params, ctx);
    if (campaign.needsClarification || campaign.unsupported) return campaign;
    const raw = String(params.status || '').toLowerCase();
    const target = /pause/.test(raw) ? 'pause' : /(active|enable|resume|live)/.test(raw) ? 'resume' : null;
    if (!target) return { needsClarification: 'Should that campaign be active or paused?' };
    return { ...campaign, target };
  },
  execute: (resolved, ctx) => _setStatus(resolved, ctx, resolved.target),
  formatSummary: (r) => `${r.target === 'pause' ? 'Pause' : 'Resume'} "${r.campaignName}" on ${PLATFORM_LABELS[r.platform]}`,
  formatResult: (_res, r) => `"${r.campaignName}" is now ${r.target === 'pause' ? 'paused' : 'active'} on ${PLATFORM_LABELS[r.platform]}.`
});

// ── delete_campaign ─────────────────────────────────────────────────
toolRouter.register({
  name: 'delete_campaign',
  description: 'Permanently delete (or archive, on Meta) a campaign. Destructive — cannot be undone.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta"|"tiktok" }',
  requiresConfirmation: true,
  resolve: (params, ctx) => _resolveCampaign(params, ctx),
  execute: (resolved, ctx) => _authedFetch(ctx, 'DELETE', _campaignPath(resolved.platform, resolved.campaignId)),
  formatSummary: (r) => `Delete "${r.campaignName}" on ${PLATFORM_LABELS[r.platform]} — this cannot be undone`,
  formatResult: (_res, r) => `"${r.campaignName}" has been deleted from ${PLATFORM_LABELS[r.platform]}.`
});

// ── rename_campaign (Google + Meta only — no TikTok PATCH route exists) ──
toolRouter.register({
  name: 'rename_campaign',
  description: 'Rename a campaign. Supported on Google Ads and Meta Ads only — TikTok has no rename capability today.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta", newName: string }',
  requiresConfirmation: true,
  resolve: async (params, ctx) => {
    const campaign = await _resolveCampaign(params, ctx);
    if (campaign.needsClarification) return campaign;
    if (campaign.platform === 'tiktok') {
      return { unsupported: `TikTok doesn't support renaming campaigns yet — that's a gap in TikTok's Ads API integration, not something Oriven can work around right now.` };
    }
    if (!params.newName || !String(params.newName).trim()) return { needsClarification: 'What would you like to rename it to?' };
    return { ...campaign, newName: String(params.newName).trim() };
  },
  execute: (resolved, ctx) => _authedFetch(ctx, 'PATCH', _campaignPath(resolved.platform, resolved.campaignId), { name: resolved.newName }),
  formatSummary: (r) => `Rename "${r.campaignName}" to "${r.newName}" on ${PLATFORM_LABELS[r.platform]}`,
  formatResult: (_res, r) => `Renamed to "${r.newName}" on ${PLATFORM_LABELS[r.platform]}.`
});

// ── change_budget (Google + Meta only — no TikTok PATCH route exists) ──
toolRouter.register({
  name: 'change_budget',
  description: 'Change a campaign\'s daily budget. Supported on Google Ads and Meta Ads only — TikTok has no budget-update capability today.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta", newBudget: number }',
  requiresConfirmation: true,
  resolve: async (params, ctx) => {
    const campaign = await _resolveCampaign(params, ctx);
    if (campaign.needsClarification) return campaign;
    if (campaign.platform === 'tiktok') {
      return { unsupported: `TikTok doesn't support changing campaign budgets through Oriven yet — that's a gap in TikTok's Ads API integration. You'll need to adjust it in TikTok Ads Manager directly.` };
    }
    const newBudget = Number(params.newBudget);
    if (!params.newBudget || Number.isNaN(newBudget) || newBudget <= 0) return { needsClarification: 'What would you like the new daily budget to be?' };
    return { ...campaign, newBudget };
  },
  execute: (resolved, ctx) => _authedFetch(ctx, 'PATCH', _campaignPath(resolved.platform, resolved.campaignId), { daily_budget: resolved.newBudget }),
  formatSummary: (r) => `Change the daily budget of "${r.campaignName}" to ${r.newBudget}/day on ${PLATFORM_LABELS[r.platform]}`,
  formatResult: (_res, r) => `Budget for "${r.campaignName}" is now ${r.newBudget}/day on ${PLATFORM_LABELS[r.platform]}.`
});

// ── refresh_campaign (read-only) ─────────────────────────────────────
toolRouter.register({
  name: 'refresh_campaign',
  description: 'Get the latest status, budget, and details for a campaign. Read-only, no confirmation needed.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta"|"tiktok" }',
  requiresConfirmation: false,
  resolve: (params, ctx) => _resolveCampaign(params, ctx),
  execute: async (resolved, ctx) => {
    if (resolved.platform === 'tiktok') return { campaign: resolved }; // no single-campaign GET on TikTok — list search already has current fields
    const data = await _authedFetch(ctx, 'GET', _campaignPath(resolved.platform, resolved.campaignId));
    return data;
  },
  formatSummary: (r) => `Get the latest details for "${r.campaignName}"`,
  formatResult: (res, r) => {
    const c = res.campaign || r;
    const budget = c.budget_micros ? `${(c.budget_micros / 1e6).toFixed(2)}/day` : (c.daily_budget ? `${c.daily_budget}/day` : (c.budget || 'n/a'));
    return `"${c.campaign_name || r.campaignName}" on ${PLATFORM_LABELS[r.platform]} — status: ${c.status || 'unknown'}, budget: ${budget}.`;
  }
});

// ── duplicate_campaign (deferred — no backend support on any platform) ──
toolRouter.register({
  name: 'duplicate_campaign',
  description: 'Duplicate a campaign. NOT currently supported on any platform — always explain that this isn\'t available yet rather than attempting it.',
  params: '{ campaignQuery?: string, platform?: "google"|"meta"|"tiktok" }',
  requiresConfirmation: false,
  resolve: async (params, ctx) => {
    const campaign = await _resolveCampaign(params, ctx);
    if (campaign.needsClarification) return campaign;
    return { unsupported: `Duplicating campaigns isn't available yet${campaign.campaignName ? ` for "${campaign.campaignName}"` : ''} — it's on the roadmap. For now I can help you create a new campaign from scratch with similar settings.` };
  },
  execute: async () => ({}),
  formatSummary: () => 'Duplicate campaign',
  formatResult: () => 'Duplication is not available yet.'
});

// ── Campaign creation: package -> publish ────────────────────────────
// create_campaign_package caches the generated pkg by id, scoped to the
// owning user, so a later "publish it" can find it without the AI having
// to carry the raw id across turns (client-persisted chat history only
// keeps the final visible reply, not this tool's intermediate result).
const PKG_CACHE = new Map();               // packageId -> { userId, platform, pkg, createdAt }
const LAST_PKG_BY_USER_PLATFORM = new Map(); // `${userId}:${platform}` -> packageId
const PKG_TTL_MS = 15 * 60 * 1000;

function _cachePkg(userId, platform, pkg) {
  const id = crypto.randomUUID().slice(0, 8);
  PKG_CACHE.set(id, { userId, platform, pkg, createdAt: Date.now() });
  if (userId) LAST_PKG_BY_USER_PLATFORM.set(`${userId}:${platform}`, id);
  return id;
}
function _getPkg(id) {
  const entry = PKG_CACHE.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PKG_TTL_MS) { PKG_CACHE.delete(id); return null; }
  return entry;
}
function _getLastPkgId(userId, platform) {
  const id = LAST_PKG_BY_USER_PLATFORM.get(`${userId}:${platform}`);
  if (!id || !_getPkg(id)) return null; // also drops the pointer if expired
  return id;
}

toolRouter.register({
  name: 'create_campaign_package',
  description: 'Generate a full ad campaign package (copy, keywords/targeting, visual concepts) for a platform, ready to review or publish. Read-only — no live account is touched.',
  params: '{ product: string, goal?: string, platform: "google"|"meta"|"tiktok" }',
  requiresConfirmation: false,
  resolve: async (params, ctx) => {
    let product = params.product;
    if (!product) {
      // Never repeat the question if the Business Brain already knows the answer.
      try {
        const res = await _authedFetch(ctx, 'GET', '/api/business/products');
        const items = (res && res.items) || [];
        if (items.length === 1) {
          product = items[0].name;
        } else if (items.length > 1) {
          return { needsClarification: `Which product — ${items.map(p => p.name).join(', ')}?` };
        }
      } catch (_) { /* fall through to the generic question below */ }
    }
    if (!product) return { needsClarification: 'What product or service is this campaign for?' };
    if (!params.platform) return { needsClarification: 'Which platform — Google, Meta, or TikTok?' };
    return { product, goal: params.goal || 'Sales', platform: params.platform };
  },
  execute: async (resolved, ctx) => {
    const body = { product: resolved.product, goal: resolved.goal, platform: resolved.platform, mode: 'full', brandCore: ctx.brandCore || undefined };
    const res = await _authedFetch(ctx, 'POST', '/api/ai/create-ad', body);
    const packageId = _cachePkg(ctx.user && ctx.user.id, resolved.platform, res.data);
    return { packageId, pkg: res.data };
  },
  formatSummary: (r) => `Generate a ${PLATFORM_LABELS[r.platform]} campaign package for "${r.product}"`,
  formatResult: (res, r) => `Campaign package ready for "${res.pkg.campaignName || r.product}" on ${PLATFORM_LABELS[r.platform]}. Say "publish it" to create it as a paused campaign, ready for your review.`
});

// â”€â”€ V9 (Epic 5) â€” thin wrappers over V8's Creative Engine. Read-only,
// non-destructive (nothing on a live account is touched, only new
// creative is generated), so â€” like create_campaign_package â€” none of
// these require confirmation. This is what lets Automation Rules (Epic 6)
// and approved recommendations (Epic 7) execute them directly via
// toolRouter.executeDirect without a live chat session.
toolRouter.register({
  name: 'generate_headlines',
  description: 'Generate fresh headline variations for a product/campaign — reuses the Creative Engine\'s variations endpoint. Read-only.',
  params: '{ seed: string, count?: number }',
  requiresConfirmation: false,
  resolve: (params) => {
    if (!params.seed) return { needsClarification: 'What should the new headlines be about?' };
    return { seed: params.seed, count: params.count || 5 };
  },
  execute: async (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/creative/variations', { kind: 'headline', seed: resolved.seed, count: resolved.count }),
  formatSummary: (r) => `Generate ${r.count} new headlines for "${r.seed}"`,
  formatResult: (res) => `Generated ${(res.variations || []).length} new headlines.`
});

toolRouter.register({
  name: 'generate_ctas',
  description: 'Generate fresh CTA variations for a product/campaign — reuses the Creative Engine\'s variations endpoint. Read-only.',
  params: '{ seed: string, count?: number }',
  requiresConfirmation: false,
  resolve: (params) => {
    if (!params.seed) return { needsClarification: 'What should the new CTAs be about?' };
    return { seed: params.seed, count: params.count || 5 };
  },
  execute: async (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/creative/variations', { kind: 'cta', seed: resolved.seed, count: resolved.count }),
  formatSummary: (r) => `Generate ${r.count} new CTAs for "${r.seed}"`,
  formatResult: (res) => `Generated ${(res.variations || []).length} new CTAs.`
});

toolRouter.register({
  name: 'generate_email',
  description: 'Generate a new marketing email for a product/campaign — reuses the existing email generator. Read-only.',
  params: '{ prompt: string }',
  requiresConfirmation: false,
  resolve: (params) => {
    if (!params.prompt) return { needsClarification: 'What should this email be about?' };
    return { prompt: params.prompt };
  },
  execute: async (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/generate-email', { prompt: resolved.prompt }),
  formatSummary: (r) => `Generate an email for "${r.prompt}"`,
  formatResult: () => `Email generated and saved to your Asset Library.`
});

toolRouter.register({
  name: 'generate_landing_page',
  description: 'Generate a new landing page for a product/campaign — reuses the existing landing page generator. Read-only.',
  params: '{ prompt: string }',
  requiresConfirmation: false,
  resolve: (params) => {
    if (!params.prompt) return { needsClarification: 'What should this landing page be for?' };
    return { prompt: params.prompt };
  },
  execute: async (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/generate-web', { prompt: resolved.prompt }),
  formatSummary: (r) => `Generate a landing page for "${r.prompt}"`,
  formatResult: () => `Landing page generated and saved to your Asset Library.`
});

toolRouter.register({
  name: 'refresh_campaign_creative',
  description: 'Generate a complete refreshed campaign (Google + Meta + TikTok packages together) for a product — reuses the Creative Engine\'s campaign suite. Read-only.',
  params: '{ product: string, goal?: string }',
  requiresConfirmation: false,
  resolve: (params) => {
    if (!params.product) return { needsClarification: 'Which product should I refresh the campaign creative for?' };
    return { product: params.product, goal: params.goal || 'Sales' };
  },
  execute: async (resolved, ctx) => _authedFetch(ctx, 'POST', '/api/creative/campaign-suite', { product: resolved.product, goal: resolved.goal }),
  formatSummary: (r) => `Refresh campaign creative for "${r.product}" across Google, Meta, and TikTok`,
  formatResult: (res) => `Refreshed creative ready on ${Object.keys(res.packages || {}).length} platform(s).`
});

function _registerPublishTool(platform) {
  toolRouter.register({
    name: `publish_${platform}_campaign`,
    description: `Publish the most recently generated ${PLATFORM_LABELS[platform]} campaign package (from create_campaign_package), created in PAUSED state so nothing goes live automatically. Call with empty params — the last package for this user and platform is used automatically.`,
    params: '{}',
    requiresConfirmation: true,
    resolve: (params, ctx) => {
      const userId = ctx.user && ctx.user.id;
      const packageId = params.packageId || (userId && _getLastPkgId(userId, platform));
      if (!packageId) return { needsClarification: `I don't have a ${PLATFORM_LABELS[platform]} campaign package ready to publish — want me to generate one first?` };
      const entry = _getPkg(packageId);
      if (!entry || entry.userId !== userId) return { needsClarification: `I don't have a ${PLATFORM_LABELS[platform]} campaign package ready to publish — want me to generate one first?` };
      if (entry.platform !== platform) return { needsClarification: `That package was built for ${PLATFORM_LABELS[entry.platform]}, not ${PLATFORM_LABELS[platform]}.` };
      return { packageId, pkg: entry.pkg, campaignName: entry.pkg.campaignName || 'this campaign' };
    },
    execute: (resolved, ctx) => _authedFetch(ctx, 'POST', `/api/publish/${platform}`, { pkg: resolved.pkg }),
    formatSummary: (r) => `Publish "${r.campaignName}" to ${PLATFORM_LABELS[platform]} (created paused)`,
    formatResult: (_res, r) => `"${r.campaignName}" has been created on ${PLATFORM_LABELS[platform]}, paused and ready for your review before it goes live.`
  });
}
_registerPublishTool('google');
_registerPublishTool('meta');
_registerPublishTool('tiktok');

module.exports = { findCampaignByName };
