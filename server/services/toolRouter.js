// ════════════════════════════════════════════════════════════════
// Oriven Tool Router
//
// Bridges the AI chat pipeline to the existing backend API. Tools never
// touch Google/Meta/TikTok directly — every tool calls an existing
// Express route on this same server (see PRINCIPLE in the V5.4 spec:
// User -> Oriven Brain -> Tool Router -> Existing Backend API -> platform).
//
// Registration: tool files (e.g. tools/campaignTools.js) call register()
// for each tool. The chat route asks the AI to reply with a JSON envelope
// naming a tool + params (same "reply ONLY with valid JSON" convention
// already used elsewhere in server.js), then calls runTool().
// ════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const eventLog = require('./eventLog');

const TOOLS = new Map();

// actionId -> { userId, tool, resolved, createdAt }
const PENDING = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function _sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of PENDING) {
    if (now - entry.createdAt > PENDING_TTL_MS) PENDING.delete(id);
  }
}

// ── Registration ─────────────────────────────────────────────────
// tool = {
//   name, description, params (text description for the AI prompt),
//   requiresConfirmation: boolean,
//   resolve(params, ctx)  -> { ...resolvedFields } | { needsClarification: string } | { unsupported: string }
//   execute(resolved, ctx) -> result object
//   formatSummary(resolved) -> short string for the action card
//   formatResult(execResult, resolved) -> short string for success feedback
// }
function register(tool) {
  if (!tool || !tool.name) throw new Error('[ToolRouter] tool must have a name');
  TOOLS.set(tool.name, tool);
}

function getTool(name) {
  return TOOLS.get(name);
}

// ── Catalog prompt — injected into the chat system prompt ─────────
function getCatalogPrompt() {
  const lines = [];
  for (const tool of TOOLS.values()) {
    lines.push(`- ${tool.name}: ${tool.description} | params: ${tool.params}`);
  }
  return lines.join('\n');
}

// ── Run a tool through resolve() -> (confirm | execute) ───────────
// ctx: { user, authHeader, currentCampaign, brandCore }
async function resolveTool(name, params, ctx) {
  const tool = TOOLS.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  let resolved;
  try {
    resolved = await tool.resolve(params || {}, ctx);
  } catch (err) {
    console.error(`[ToolRouter] resolve failed for ${name}:`, err.message);
    return { ok: false, error: 'Could not process that request. Please try again.' };
  }

  if (resolved && resolved.needsClarification) {
    return { ok: true, clarification: resolved.needsClarification };
  }
  if (resolved && resolved.unsupported) {
    return { ok: true, unsupported: resolved.unsupported };
  }

  if (!tool.requiresConfirmation) {
    try {
      const execResult = await tool.execute(resolved, ctx);
      return { ok: true, executed: true, resolved, execResult, message: tool.formatResult(execResult, resolved) };
    } catch (err) {
      console.error(`[ToolRouter] execute failed for ${name}:`, err.message);
      // Additive only — status/code let a caller (e.g. the ai/chat route)
      // distinguish "out of credits" from a generic failure and show the
      // real paywall instead of a bare error bubble. No existing caller
      // reads these fields today, so nothing regresses.
      return { ok: false, error: err.friendlyMessage || 'That action could not be completed. Please try again.', status: err.status, code: err.code };
    }
  }

  // Confirmation-required tools always need an authenticated user to own the
  // pending action — enforced here so the module is safe regardless of caller,
  // not just because today's one caller (server.js) happens to check first.
  if (!ctx.user || !ctx.user.id) {
    return { ok: false, error: 'You need to be signed in for me to do that.' };
  }

  _sweepExpired();
  const actionId = crypto.randomUUID();
  PENDING.set(actionId, { userId: ctx.user.id, tool: name, resolved, createdAt: Date.now() });
  return {
    ok: true,
    pendingAction: { id: actionId, tool: name, summary: tool.formatSummary(resolved) }
  };
}

// ── Execute a previously confirmed pending action ──────────────────
async function executeAction(actionId, user, ctx) {
  _sweepExpired();
  const entry = PENDING.get(actionId);
  if (!entry) return { ok: false, status: 404, error: 'This action has expired. Please ask again.' };
  if (entry.userId !== user.id) return { ok: false, status: 403, error: 'Not authorized.' };
  PENDING.delete(actionId); // single-use

  const tool = TOOLS.get(entry.tool);
  if (!tool) return { ok: false, status: 500, error: 'That action is no longer available.' };

  try {
    const execResult = await tool.execute(entry.resolved, ctx);
    const message = tool.formatResult(execResult, entry.resolved);
    // V6 Final Phase â€” every real, executed action becomes a Timeline entry
    // alongside detected conditions, using the exact success message already
    // shown in the action card (no separate description to maintain).
    eventLog.logEvent({
      user_id: user.id,
      platform: entry.resolved.platform || null,
      campaign_name: entry.resolved.campaignName || entry.resolved.campaignId || null,
      type: 'campaign_action',
      title: tool.formatSummary ? tool.formatSummary(entry.resolved) : entry.tool,
      detail: message,
      message
    });
    return { ok: true, message };
  } catch (err) {
    console.error(`[ToolRouter] execute (confirmed) failed for ${entry.tool}:`, err.message);
    return { ok: false, status: 500, error: err.friendlyMessage || 'That action could not be completed. Please try again.' };
  }
}

// V9 (Epic 5) â€” a second entry point into the same tool registry, for
// callers that already have a resolved params object and no live chat
// session / PENDING-map entry to execute against (Autopilot's approval
// flow, which resolves a recommendation's action ahead of time and may
// execute it long after the recommendation was created). Reuses the exact
// same tool.execute()/eventLog path as executeAction â€” no duplicated
// execution logic.
async function executeDirect(toolName, resolved, ctx) {
  const tool = TOOLS.get(toolName);
  if (!tool) return { ok: false, status: 404, error: `Unknown tool: ${toolName}` };
  try {
    const execResult = await tool.execute(resolved, ctx);
    const message = tool.formatResult ? tool.formatResult(execResult, resolved) : 'Done.';
    if (ctx && ctx.user && ctx.user.id) {
      eventLog.logEvent({
        user_id: ctx.user.id,
        platform: resolved.platform || null,
        campaign_name: resolved.campaignName || resolved.campaignId || null,
        type: 'campaign_action',
        title: tool.formatSummary ? tool.formatSummary(resolved) : toolName,
        detail: message,
        message
      });
    }
    return { ok: true, message, execResult };
  } catch (err) {
    console.error(`[ToolRouter] executeDirect failed for ${toolName}:`, err.message);
    return { ok: false, status: 500, error: err.friendlyMessage || 'That action could not be completed.' };
  }
}

module.exports = { register, getTool, getCatalogPrompt, resolveTool, executeAction, executeDirect };
