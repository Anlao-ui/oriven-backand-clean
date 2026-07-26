# Oriven — Architecture Overview

This describes the system as it actually exists, not an aspirational design. It reflects the codebase after V5 (AI Foundation) through V10 (Production Readiness).

## Repository layout

Oriven is split across **two separate git repositories**, not one monorepo:

- **Frontend** — `C:\files` (this repo's parent when checked out alongside the server). A single large multi-page app (`app.html`, ~13,000+ lines) plus one JavaScript file per major feature area (`app.js`, `auth.js`, `create.js`, `workspace.js`, `autopilot.js`, `settings.js`, `guide.js`, `assistant.js`, `guest.js`, `ads.js`, `productshoots.js`, `ugc.js`, `videoads.js`, `motiongraphics.js`, `inspiration.js`, `competitor.js`, `create-flow.js`, `team.js`, `usage.js`, `paywall.js`, `supabase.js`, `tracking.js`, `plans.js`) and one stylesheet (`styles.css`).
- **Backend** — this repo (`oriven-backand-clean/server`). A single Express app (`server.js`, ~9,500+ lines) plus `services/` (shared engines) and `tools/` (Tool Router tool definitions).

At the time of writing, **neither repo has been committed past its last real commit** — everything from V6 (Marketing Intelligence) onward exists only as uncommitted working-tree changes. See `PRODUCTION_CHECKLIST.md`.

## The AI pipeline

There is **one** path to the AI, used by every feature:

```
feature code → _aimlText(taskType, system, user, opts) / _aimlChat(messages, opts) / _aimlImage(...) / _aimlVision(...)
            → services/modelRouter.js: routeTask(taskType)   [throws if taskType isn't registered]
            → providers/aimlProvider.js: generateText() / generateImage() / generateVideo()
            → AIML gateway (api.aimlapi.com), proxying to the underlying model
```

`@anthropic-ai/sdk` and `openai` are listed in `package.json` but are **not imported anywhere** in this codebase — confirmed by grep across every `.js` file. All text generation actually runs through the AIML gateway. These are candidates for dependency cleanup (see `PRODUCTION_CHECKLIST.md`), left in place for this pass since removing a dependency this close to launch without a full re-test is a real (if small) risk.

Every new AI capability must be registered in `modelRouter.js`'s `TASKS` map before it can be called — `routeTask()` throws on an unregistered type by design (this caught a real bug once, in V6 Phase 1).

## The Tool Router — safe AI-triggered actions

`services/toolRouter.js` is the only path from an AI conversation (or an Autopilot recommendation) to a real backend mutation. Every tool (`tools/campaignTools.js`, `tools/businessTools.js`) follows the same shape:

```js
{ name, description, params, requiresConfirmation,
  resolve(params, ctx)   → resolved fields | { needsClarification } | { unsupported }
  execute(resolved, ctx) → result
  formatSummary(resolved), formatResult(result, resolved) }
```

Tools never call Google/Meta/TikTok or the database directly — they call an **existing** Express route on the same server over loopback HTTP with the real user's auth token (`_authedFetch` in each tool file). This means a tool can never do anything a signed-in user couldn't already do by calling the API directly.

Three ways a tool call resolves:
1. **No confirmation required** (e.g. `create_campaign_package`, all Creative Engine wrappers) — executes immediately, since nothing on a live account is touched.
2. **Confirmation required, live chat** — `resolveTool()` stores `{userId, tool, resolved}` in an in-memory `PENDING` map (`toolRouter.js`, 10-minute TTL) keyed by a generated `actionId`; the frontend renders an action card; `POST /api/ai/execute` calls `executeAction(actionId, ...)`, single-use.
3. **Confirmation required, no live session (Autopilot)** — `toolRouter.executeDirect(toolName, resolved, ctx)` (added in V9), a second entry point into the same tool registry for callers that already have a resolved params object and real auth header but no PENDING-map entry (e.g. approving a recommendation from the Autopilot Center hours after it was generated). This is why Automation Rules (V9) never auto-execute unattended: `_authedFetch` requires a real user JWT, which a background cron tick has no way to hold — only a live, authenticated "Approve" click does.

## The Business Brain — Context Engine

`_gatherBusinessContext(userId)` (`server.js`) is the single reusable function every AI-facing route calls to inject what Oriven already knows about a business: profile, products, audiences, competitors, brand voice (`_getBrandCore`), website knowledge, remembered facts (`business_memory`), and the top confidence-ranked `business_learnings`. It returns `{ text, sources }` — `text` goes into the prompt, `sources` is a short list used for the chat UI's "Using: ..." transparency chip. One function, one shape, every caller — chat, campaign generation, every Creative Engine route, Autopilot's recommendation narration.

## The Learning Engine

`_runLearningEngine(user, platform, analysis)` (`server.js`, called from the monitoring cron below) writes to `business_learnings`: winning campaigns/products/audiences/creatives, headline-length patterns (Google only — Meta's creative name field isn't real ad copy), and messaging classification, each with a confidence score from the same deterministic `_calcConfidence({clicks, conversions, days})` formula used everywhere in this app. Every write is an `upsert` on `(user_id, entity_type, entity_name, category)`, so re-detecting the same pattern refreshes it instead of duplicating it. Stale learnings (not re-confirmed in 90+ days) are archived, not deleted, by `_archiveStaleLearnings()`.

**"Calculate, don't invent"** is the one philosophy applied everywhere in this codebase: confidence scores, campaign priority, forecasts, and creative quality sub-scores are all deterministic math over real fetched data. AI is only ever used to *narrate* numbers that already exist — never to invent them. This was an explicit fix in V6 Phase 2a (confidence used to be AI-self-reported) and has been the rule for every feature built since.

## Continuous monitoring → Autopilot

`cron.schedule('0 */4 * * *', ...)` runs `_runIntelligenceMonitoring()` every 4 hours for every user with a connected ad account. For each platform it calls `_monitorPlatform(user, platform)`, which:
1. Re-runs the same `_analyzeGoogleAccount`/`_analyzeMetaAccount` functions the on-demand analysis routes use (no separate analysis logic).
2. Logs findings/recommendations/creative-fatigue/opportunities into `intelligence_events`, deduped against the last 24h by title.
3. Runs the Learning Engine (above).
4. Runs `_evaluateAutomationRules` (V9) — checks the user's enabled `automation_rules` against real per-campaign CTR/CPA/ROAS and creates an `autopilot_recommendations` row on a match (never auto-executes — see Tool Router section above).
5. Detects budget-waste and audience-saturation conditions (reusing the same `_campaignPriority` classification, not a new detector) and creates recommendations for those too.

Three more cron jobs (8am/1pm/6pm UTC) generate Morning/Midday/Evening briefs by reusing `/api/business/reflection`'s exact mechanism with a 1-day window, logging the result as an `intelligence_events` row (`type: 'daily_brief'`) instead of new storage.

## Frontend page/nav model

Every top-level page is a `<div class="page" id="page-X">`; `navigate(page)` (`app.js`) toggles `.active` on the matching `#page-X` and highlights the matching `.ni[data-page="X"]` nav button. Several features wrap `window.navigate` in a layered chain (each feature file captures the previous `navigate`, checks for its own page, then calls through) — `workspace.js` and `autopilot.js` both do this to run their page-specific init function, following the same pattern already established for `integrations`/`ads`/`performance`/`connect`.

The onboarding spotlight tour (`auth.js`, `_OB_STEPS`) walks new users through the top nav in order; it's a plain ordered array of `{page, section, title, desc}`, extended in V10 to include the Creative Workspace and Autopilot pages added in V8/V9.
