# Oriven — Database Overview

Supabase Postgres, accessed exclusively via the service-role client (`supabaseAdmin`, `server.js`). There is no per-request Supabase client and no RLS-based enforcement — **every route that reads or writes user data must filter by `user_id` explicitly**, since the service role itself enforces nothing. This was audited in V10 (Epic 4): every `:id`-scoped mutation in `server.js` was grepped and confirmed to chain `.eq('user_id', ...)`.

**There is no migrations tool in this codebase** — confirmed by an empty search for `**/*.sql` and `**/migrations/**` at every phase that needed a new table. Every table below was created by asking a human to run the `CREATE TABLE`/`ALTER TABLE` SQL directly in the Supabase SQL editor. Any future schema change must follow the same process.

## Pre-existing tables (before V6)

- **`profiles`** — one row per user; subscription status (`free`/paid plan tiers), used by `requireSubscription`/`requireSubIfAuthed`.
- **`brand_cores`** — the original Brand Brain: name, tone of voice, USP, audience, colors, etc. Written client-side (`auth.js`), read server-side by `_getBrandCore(userId)` (added V7 Phase 1 — the first backend read of this table).
- **`integrations`** — one row per user per platform (`google_ads`/`meta_ads`/`tiktok_ads`), OAuth tokens, active ad account.

## V6 Final Phase

- **`intelligence_events`** — the shared event log for the Live Feed, notification bell, and Autopilot history. Columns include `user_id`, `platform`, `campaign_name`, `type` (grown organically: `finding`, `recommendation`, `creative_fatigue`, `opportunity`, `brand_drift`, `website_change`, `campaign_action`, `daily_brief` — no enum constraint, documented here instead of retrofitted onto a live table), `title`, `detail`, `severity`, `confidence`, `confidence_basis`, `message`, `dismissed`. Written by the monitoring cron, the Tool Router's `executeAction`/`executeDirect`, and the daily-brief cron.

## V7 Phase 1 — Business Brain

- **`business_profile`** — one row per user (`company_name`, `website`, `industry`, `country`, `languages text[]`, `description`, `mission`, `vision`, `primary_goals`, `business_stage`), upserted on `user_id`.
- **`business_products`**, **`business_audiences`**, **`business_competitors`** — many rows per user, CRUD via one generic helper (`_businessCrud(table, allowedFields)` + `_registerBusinessCrudRoutes`, `server.js`) instead of three hand-written route sets. Note: competitors use `company`/`positioning`, not `name`/`notes` — a real bug caught and fixed during V7 Phase 2 by reading the actual schema instead of assuming.
- **`business_memory`** — freeform remembered facts (`content`, `type`, `source`), written only through the `remember_business_fact` Tool Router tool (always confirmation-gated — the one case in this app where an AI-initiated write always asks first).
- **`business_website_knowledge`** — one row per user, real fetched-and-analyzed website content (`_fetchWebsiteText` + AI extraction), not URL-only speculation.

## V7 Phase 3 — Business Learning Engine

- **`business_learnings`** — see `ARCHITECTURE.md`. Unique on `(user_id, entity_type, entity_name, category)`; `confidence` bounded 8–96 by `_calcConfidence`; `status` (`active`/`archived`); `evidence jsonb`.

## V8 — Creative Engine

- **`creative_assets`** — every generated image/video/script/email/landing-page/ad, written fire-and-forget by every generator route via `_recordCreativeAsset`. Extended in Phase 2 with `status` (`draft`/`needs_improvement`/`ready`/`approved`/`published`/`rejected`), `favorite`, `archived`, `is_current`, `parent_asset_id` (self-referential, for version history), `version_label`, `scores jsonb` (from `/api/creative/score`), `notes`.
- **`creative_asset_comments`** — one-to-many, `user_id`-attributed per comment even though only one user can see it today (intentional: "prepare architecture for future team support" without building a team model that doesn't exist yet).

## V9 — Autopilot

- **`autopilot_recommendations`** — the structured, approvable output of the Recommendation Engine (`_generateRecommendation`). `source_event_id` optionally links back to `intelligence_events`; `tool_name`/`tool_params` is what executes on approval via `toolRouter.executeDirect`; `status` lifecycle: `suggested → approved/rejected/executed/failed`.
- **`automation_rules`** — user-defined IF/THEN rules, evaluated inside the existing monitoring pass (no second cron). `trigger_metric`/`trigger_operator`/`action_type` are constrained server-side (V10 hardening) to the exact sets the evaluator and its tool-map actually understand.
- **`autopilot_tasks`** — generated from three existing sources (stale Business Brain knowledge, Business Health recommendations, open high-confidence recommendations), not a separate detection engine.
- **`autopilot_workflows`** — a generic step-sequence engine over existing generators/tools; `steps jsonb` is an ordered array of `{step, label, status, result}`; pauses at a `request_approval` step and resumes once the linked recommendation is approved.

## Redundancy review (V10, Epic 8)

No redundant columns or duplicate data found across the tables above — each `jsonb` column (`evidence`, `action_params`, `scores`, `steps`) serves a distinct query/rendering pattern already exercised by real code, not speculative future use. The one deliberate non-normalization: campaign/product/audience "links" (e.g. a recommendation's `campaign_name`, a learning's `entity_name`) are soft name-matches, not foreign keys — marketing data lives on the ad platforms, not in this database, so a real foreign key isn't expressible. This has been a consistent, explicit design decision since V7 Phase 1.
