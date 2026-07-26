# Oriven — API Reference

All routes live in `server.js` unless noted. Auth is enforced one of two ways in this codebase — both legitimate, established patterns:

- **`requireSubIfAuthed` middleware** — guest-friendly: passes through with no `req.user` if there's no auth header, populates `req.user` if there is one and it's valid. Used on generation routes shared with the guest demo.
- **In-handler `getUserFromToken(req)` + explicit 401** — used everywhere else (Business Brain, Creative Engine, Autopilot, platform campaign management). Hard auth, no guest access.

Every route below returns `401` when called without a valid token, verified via `curl` at the end of every phase that added routes.

## Auth & account

`/api/signup`, `/api/verify-email`, `/api/resend-verification`, `/api/send-invite`, `/api/create-checkout-session`, `/api/get-subscription`, `/api/schedule-plan-change`, `/api/cancel-plan-change`, `/api/get-usage`, `/api/increment-usage`, `/api/stripe-webhook`.

## Platform connections

`/api/google/*` (`auth-url`, `status`, `accounts`, `active-account`, `disconnect`, `diag`), `/auth/google`, `/auth/google/callback`, and the equivalent `/api/meta/*`/`/auth/meta*` and `/api/tiktok/*`/`/auth/tiktok*` sets.

## Campaign management (Google/Meta/TikTok)

Per platform: `GET .../campaigns`, `GET .../campaign/:id`, `PATCH .../campaign/:id`, `POST .../campaign/:id/pause`, `POST .../campaign/:id/resume`, `DELETE .../campaign/:id`, plus `/api/meta/adsets`, `/api/meta/ads`. These call the platform APIs directly (not cached local data) — a mutation always requires the user's own OAuth token to have permission on that campaign, which is the real ownership boundary here, not a database check.

## AI generation (Creative Engine core, V5–V8)

`/api/generate-web`, `/api/generate-text`, `/api/generate-email`, `/api/generate-deck`, `/api/generate-poster`, `/api/generate-infographic`, `/api/generate-image`, `/api/generate-ad`, `/api/generate-campaign`, `/api/generate-logo`, `/api/generate-brandcore`, `/api/brand-check`, `/api/competitor-intelligence`, `/api/generate-ugc*`, `/api/video-ads/*`, `/api/motion-graphics/*`, `/api/product-shoots/generate`. Every one of these injects real Business Brain context via `_gatherBusinessContext` (V8 Phase 1) and records its output to `creative_assets` via `_recordCreativeAsset`.

## Creative Engine (V8 Phase 1 & 2)

- `POST /api/creative/variations` — `{kind, seed, count}`, one endpoint for every "generate 10 X" button.
- `POST /api/creative/improve` — `{text, action, targetLanguage?, assetId?}`; with `assetId`, creates a version in that asset's family instead of a standalone record.
- `POST /api/creative/campaign-suite` — one product brief → Google + Meta + TikTok packages in parallel.
- `GET/DELETE/PATCH /api/creative/assets[/:id]`, `POST /api/creative/assets/:id/duplicate`, `GET /api/creative/assets/:id/versions`, `POST /api/creative/assets/:id/restore`, `GET/POST /api/creative/assets/:id/comments`.
- `POST /api/creative/score` — `{assetId}` or `{kind, content}` → deterministic + AI-predicted sub-scores, never faked.
- `GET /api/creative/search` — fans out across creative assets, products, audiences, competitors, memory, learnings.

## Business Brain (V7)

`GET/PUT /api/business/profile`, `GET/POST/PUT/DELETE /api/business/{products,audiences,competitors}[/:id]`, `GET/POST/DELETE /api/business/memory[/:id]`, `POST /api/business/website/refresh` (asks before overwriting on real change), `POST /api/business/website/confirm-update`, `GET /api/business/website`, `GET /api/business/health`, `GET /api/business/validate`, `GET /api/business/insights`, `GET/DELETE /api/business/learnings[/:id]`, `GET /api/business/timeline`, `GET /api/business/graph`, `GET /api/business/reflection?period=` (`weekly`/`monthly`/`quarterly`/`daily_morning`/`daily_midday`/`daily_evening`), `GET /api/business/dashboard`.

## Marketing Intelligence (V6)

`GET /api/intelligence/{home,forecast,kpi-trend,events,briefing,opportunities,executive}`, `PATCH /api/intelligence/events/:id/dismiss`, `GET /api/ads/{overview,campaigns,campaign/:id,campaign/:id/assets}`, `POST /api/ads/{analyze,recommend}`.

## Conversational AI

`POST /api/ai/chat` (the Tool Router entry point), `POST /api/ai/execute` (confirm a pending action), `POST /api/ai/create-ad`, `POST /api/publish/{google,meta,tiktok}`.

## Autopilot (V9)

- `GET/PATCH /api/autopilot/recommendations[/:id]`, `POST /api/autopilot/recommendations/:id/{approve,reject}`.
- `GET/POST/PATCH/DELETE /api/autopilot/rules[/:id]` — `trigger_metric`/`trigger_operator`/`action_type`/`platform` are all server-side constrained (V10).
- `GET/PATCH /api/autopilot/tasks[/:id]`.
- `GET/POST /api/autopilot/workflows`, `POST /api/autopilot/workflows/:id/advance`.
- `GET /api/autopilot/history` — fans out across events/recommendations/tasks/workflows.
- `GET /api/autopilot/predictions` — reuses `_computeForecast`/`_linearTrend` (V6), no new forecasting logic.

## Debug

`GET /api/debug/routes` — lists every registered Express route; `GET /api/google/diag` — non-destructive token/config diagnostic.
