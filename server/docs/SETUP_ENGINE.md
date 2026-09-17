# Oriven — Universal Advertising Setup Engine

This describes the system as it actually exists, after two build passes: the original Phase 1–9 build, and a subsequent **Completion Pass** that re-researched every unimplemented capability, wired everything that turned out to be genuinely possible, and hardened the engine's safety properties (error taxonomy, concurrency, fail-closed verification, Autopilot gating, real remote verification). It covers the Capability Registry, the Setup State Engine, the platform adapters, the tracking/conversions routes built on top of them, and how Launch and Autopilot both consult readiness before acting. It does not describe an aspirational end state — every "not implemented" below is really not implemented, matching `platformCapabilities.js`'s own `implemented` flags. 25 of the registry's 36 capabilities are implemented as of the Completion Pass (up from 19).

## Why this exists

Oriven's product principle is **"Manage your advertising from ORIVEN"** — not "you never need Meta/Google" and not "everything is automated." Meta, Google, TikTok, and Pinterest remain the authoritative platforms; Oriven is the orchestration layer that (1) detects what a user already has, (2) detects what's missing, (3) creates resources through official APIs where that's genuinely supported, (4) sends users through the real platform UI where the platform requires it, (5) verifies what actually happened rather than trusting an HTTP 200, and (6) never claims readiness or capability that isn't real.

**Connected is not Ready.** A valid OAuth token proves a platform is *connected*. It does not prove a campaign can actually be published — that also needs an ad account (and, per-platform, a Page/identity/manager relationship). The state machine below keeps these as separate, named states rather than one boolean.

## The four layers

```
Oriven UI (Connections page, Launch)
  → Setup State Engine (services/setupStateEngine.js)      — pure, reads only what's already stored
  → Capability Registry (services/platformCapabilities.js) — what's real, per platform/capability
  → Platform Adapters (services/adapters/*SetupAdapter.js) — pure logic, injected {get,post}/{query,mutate} client
  → server.js routes wire adapters to the existing, already-battle-tested low-level HTTP helpers
      (_metaFetch/_metaApiPost, _gadsQuery/_gadsMutate, _pinterestApiRequest, _tiktokPost)
  → the real Meta/Google/TikTok/Pinterest APIs
```

No new HTTP client code was written for any platform. Every adapter takes a small `{get, post}` (Meta/Pinterest/TikTok) or `{query, mutate}` (Google) object; `server.js` supplies thin wrapper functions (`_metaClientFor`, `_gadsClientFor`, `_pinterestClientFor`, `_tiktokClientFor`) around the existing helpers, and tests supply mock clients. This is what makes the adapters unit-testable without live elevated-permission OAuth credentials.

## Capability Registry — `services/platformCapabilities.js`

Every advertising capability across all four platforms is one entry: `{platform, category, key, label, type, implemented, apiEndpoint, requiredScopes, prerequisites, verification, retry, rollback, humanAction, officialFlow, docs}`.

`type` is one of:

- **`API`** — Oriven can do this through an official, documented endpoint, unconditionally.
- **`API_GATED`** — Oriven can do this through an official API, but the platform gates it on eligibility Oriven cannot grant (e.g. Google `CreateCustomerClient` requires >$1,000 historical spend and clean policy standing on the manager account; Meta ad account creation requires Business Verification).
- **`HYBRID`** — Oriven does part of the work; the user must complete part of it (typically: Oriven creates the resource, the user must approve/configure something on the platform).
- **`MANUAL`** — the platform requires its own UI; Oriven sends the user there via `officialFlow` and re-verifies on return.
- **`UNSUPPORTED`** — the platform doesn't expose this at all.

`implemented` is a second, independent flag. A capability can be correctly classified `API` and still have `implemented: false` if the adapter/route hasn't been built yet — the registry is not allowed to claim readiness that isn't wired up. `getCapabilities(platform)` / `getCapability(platform, key)` are the only reads.

**Registry corrections made during this phase** (the "do not blindly trust earlier research — verify against current official docs" rule, applied for real):

| Capability | Before | After | Why |
|---|---|---|---|
| `tiktok.pixel` | `HYBRID`, unimplemented | `MANUAL`, unimplemented | No confirmed Pixel create/list endpoint exists in TikTok's own official `tiktok-business-api-sdk` docs directory, despite that same directory having a confirmed `BCApi.md` for advertiser-account creation. Absence of a Pixel doc file, right next to a directory that clearly does document adjacent endpoints, was treated as a real signal, not guessed around. |
| `meta.pixel` | unimplemented | `implemented: true` | Real adapter + routes now exist (below). |
| `google.conversionAction` | unimplemented | `implemented: true` | Real adapter + routes now exist. |
| `pinterest.tag` | unimplemented | `implemented: true` | Real adapter + routes now exist. Never call this "Pinterest Pixel" in UI or docs — Pinterest's own term is "Tag." |
| `tiktok.eventsApi` | unimplemented | `implemented: true` | Server-side event send via `POST /open_api/v1.3/event/track/`, confirmed official. |

**Completion Pass corrections and additions** — every one of these is a genuine re-research result, not a relabeling:

| Capability | Before | After | Why |
|---|---|---|---|
| `meta.conversionsApi` | unimplemented | `implemented: true` | Real server-side event send via `POST /{pixel_id}/events`, confirmed against Meta's server-event + response-field docs. A state SEPARATE from `meta.pixel` (object existence). |
| `google.tag` | unimplemented | `implemented: true` | `conversion_action.tag_snippets` confirmed real, read-only, populated only on a follow-up query (not the create response). ORIVEN retrieves and displays the real snippet — installing it is still the user's action. |
| `pinterest.conversionsApi` | unimplemented | `implemented: true` | Real event send via `POST /ad_accounts/{id}/events`, confirmed against Pinterest's generated OpenAPI client. A SEPARATE system from the Tag. |
| `tiktok.advertiserAccount` | "endpoint confirmed, unwired" | `implemented: true` | HIGH PRIORITY completion target. Wired `GET /bc/get/` (Business Center discovery) + `POST /bc/advertiser/create/`. Response field names for a new advertiser are undocumented anywhere in the official SDK, so success is verified ENTIRELY via a real follow-up call to the existing `_fetchTikTokAdvertisers` discovery function — never a guessed field. |
| `tiktok.pixel` | `MANUAL`, unimplemented | **`HYBRID`, implemented** | Re-researched per explicit instruction to check again. TikTok's official SDK documents real Pixel-**linking** endpoints (`bc/pixel/link/get`, `bc/pixel/link/update`) under Business Center scope that the earlier pass missed by searching only for a standalone Pixel doc file. Both require an already-known `pixel_code` — neither discovers/creates a pixel from nothing, so **creation genuinely remains unconfirmed** and MANUAL. What's new: ORIVEN can verify/ensure the user's pixel is actually linked to the active advertiser account. |
| `pinterest.firstAdAccount` | `MANUAL`, unimplemented | **`API_GATED`, implemented** | Re-researched. Pinterest's own generated OpenAPI client documents a real `POST /ad_accounts` endpoint with no "first account only via UI" restriction in the API contract itself — the help-center guidance steering first-timers to the UI is onboarding advice, not a documented technical gate. Attempted for real; any real platform rejection falls back to the manual flow. Required adding the `user_accounts:read` OAuth scope to resolve `owner_user_id`. |
| `meta.businessManager` | unimplemented | **`API_GATED`, implemented** (discovery only) | Corrected, not just implemented: `POST /{business_id}/businesses` requires an EXISTING `business_id` in its own URL — it creates a client/sub-business under a Business Manager the caller already owns, and is structurally incapable of creating a user's first Business Manager. Creation stays unimplemented for the right reason. Discovery (`GET /me/businesses`, unconditional, no gate) is real and now wired. |

Everything else in the registry (Meta/Google/TikTok/Pinterest ad-account or Business-entity creation gated by Business Verification/spend/UI-only-BC-creation, billing, verification, `pinterest.audiences`, campaign-object capabilities) is unchanged and remains `implemented: false` — see "Not implemented" below.

## Setup State Engine — `services/setupStateEngine.js`

`STATE` enum: `not_started, authentication_required, authenticated, account_selection_required, account_creation_required, assets_required, ready_limited_verification, ready, error, manual_action_required`.

`checkMetaSetup(row)` / `checkGoogleSetup(row)` / `checkTikTokSetup(row)` / `checkPinterestSetup(row)` are pure functions over an already-fetched `integrations` row — no network calls. They walk auth → account → platform-specific asset (Meta: Page; Google: non-manager customer; TikTok: advertiser + identity; Pinterest: ad account) and return the first state that isn't satisfied.

`ready_limited_verification` is a deliberate, honestly-named state beyond the spec's literal enum: it fires once the real, current minimum bar for a successful publish is met (auth + account + platform asset), while tracking/billing/conversions/verification — which aren't fully implemented for any platform yet — are reported as `not_verified_by_oriven` rather than either silently assumed to pass or used to permanently block readiness. `ready` is reserved for a future point where those are actually checked.

`getSetupStatus(supabaseAdmin, userId, platform)` and `getAllSetupStatuses(supabaseAdmin, userId)` are the only functions that touch the database — a plain `SELECT *` against the existing `integrations` table, no new schema.

**What this deliberately does not yet do**: per the Phase 8 spec, these state functions are meant to eventually make real API checks (does the ad account still exist, is the token still valid beyond expiry math, is there a billing block) rather than trusting stored rows. That evolution has not happened — `checkXSetup()` still only reads what's stored. See "Known gaps" below.

Routes: `GET /api/setup/status` (all platforms), `GET /api/setup/:platform/status` (one platform).

## Platform Adapters — `services/adapters/`

Each adapter is pure logic with no HTTP client of its own, and follows the same **idempotent "ensure" pattern**: look up an existing resource first and reuse it if found; only create if genuinely absent; then verify the created resource with a follow-up read rather than trusting the mutation response. This satisfies "verify after every mutation — never assume HTTP 200 means success" without needing a database lock, because the check-then-create happens against the platform itself, which is the actual source of truth.

- **`metaSetupAdapter.js`** — `findExistingPixel`, `ensurePixel(apiClient, adAccountId, name)` (`POST /act_{id}/adspixels`, verifies via `GET /{pixel_id}`), `checkPixelHealth(apiClient, pixelId)` → `{exists, installed, receivingEvents, lastFiredAt}` kept as three distinct signals (a pixel can exist without being installed, and be installed without recently firing — collapsing these would be a false readiness claim), `checkAdAccountStatus(apiClient, adAccountId)` reading `account_status`/`disable_reason`.
- **`googleSetupAdapter.js`** — `findExistingConversionAction` (GAQL query by name), `ensureConversionAction(gadsClient, {name, category, type})` (`ConversionActionService.MutateConversionActions`, create-only — never touches `primary_for_goal` or any other config on an action that already exists), `checkConversionActionStatus`.
- **`pinterestSetupAdapter.js`** — `findExistingTag`, `ensureTag(apiClient, adAccountId, name)` (`POST /ad_accounts/{id}/conversion_tags`, defaults `enhanced_match_status: 'DISABLED'` and `aem_enablement_status: 'OPTED_OUT'` — conservative; never silently opts a user into enhanced matching), `checkTagHealth`.
- **`tiktokSetupAdapter.js`** — intentionally minimal. Only exports `sendEvent(apiClient, {pixelCode, event, eventId, context})`, `POST /open_api/v1.3/event/track/`, requiring a real user-supplied `pixelCode` (throws 400 — "Oriven cannot discover one automatically yet" — if missing). No `ensurePixel` exists here, matching the registry's `MANUAL` classification above.

## Error taxonomy — `services/setupErrors.js` (Completion Pass)

Every new route maps a raw platform error into one of 18 stable internal codes (`AUTH_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REFRESH_FAILED`, `PERMISSION_REQUIRED`, `ACCOUNT_REQUIRED`, `ACCOUNT_CREATION_REQUIRED`, `ASSET_REQUIRED`, `TRACKING_REQUIRED`, `CONVERSION_SETUP_REQUIRED`, `BILLING_REQUIRED`, `VERIFICATION_REQUIRED`, `ACCOUNT_RESTRICTED`, `REGION_UNSUPPORTED`, `RATE_LIMITED`, `PLATFORM_UNAVAILABLE`, `INVALID_CONFIGURATION`, `ALREADY_EXISTS`, `UNKNOWN_ERROR`) via `mapPlatformError(platform, err)`. The client only ever sees `{error: plainLanguageMessage, code}` — raw platform payloads/messages are never forwarded; the real detail is always `console.error`'d server-side. `withPlatformRetry(platform, fn)` wraps a mutation with bounded exponential backoff (3 attempts, ~400ms base) but ONLY for the two genuinely transient codes (`RATE_LIMITED`, `PLATFORM_UNAVAILABLE`) — a real 400/401/403/409 is never retried, since retrying it would just hammer the platform for a problem only a human can fix. Applied to the Conversions API send routes (Meta, Pinterest) where a transient blip is the most likely real-world failure.

## Concurrency guard — `services/setupLocks.js` (Completion Pass)

`withSetupLock(key, fn)` is a small, deliberately single-process, in-memory in-flight-request map — the second of two near-simultaneous callers (a double-click, or two open tabs) with the same key awaits the FIRST call's real result instead of racing it with an independent read-then-create. This closes the TOCTOU gap idempotency alone can't close on a single check-then-create round trip. Applied to the two new account-creation routes (`POST /api/setup/tiktok/advertiser-account`, `POST /api/setup/pinterest/ad-account`) keyed by `platform:userId`. This server runs as one Node process (no cluster/pm2 setup anywhere in this repo), so this is complete coverage for this deployment, not a partial stand-in for a distributed lock. Every mutation additionally keeps its own idempotent "ensure" pattern (check-before-create, verify-after-create) as the primary, always-correct protection — the lock is what makes that protection race-free under real concurrency, not a replacement for it.

## Real remote verification — `POST /api/setup/:platform/recheck` (Completion Pass)

The Phase 1-9 build left `checkXSetup()` reading only stored `integrations` data, with the evolution to real API-based verification explicitly deferred. The Completion Pass adds it as a **separate, explicitly-triggered** endpoint rather than folding it into the polled `GET /api/setup/:platform/status` — that route is read by the UI on every Connections-page load, and a live platform call on every poll would be exactly the "unnecessary API call" the spec warns against. `POST /api/setup/:platform/recheck` makes one real call per platform, reusing already-battle-tested functions (no new unconfirmed endpoints): Meta's `checkAdAccountStatus`, Google's new `checkCustomerStatus` (GAQL `SELECT customer.status`), TikTok's and Pinterest's own existing discovery functions re-invoked and checked for the active account's continued presence. The result is cached in-memory for 5 minutes (`_setSetupVerifyCache`) and surfaced on the next `GET /api/setup/:platform/status` read as `remoteVerification: {checked, ok, lastVerifiedAt}` — a deliberate performance/rate-limit courtesy, not persisted state (no DB migration needed for what the platform itself remains the source of truth for; resets on server restart, same tradeoff as the concurrency lock above). The Connections UI exposes this as a "Recheck" link on every ready platform.

**Cache safety, audited and proven, not assumed** (Final Production Audit pass): the cache is purely additive display data attached at `status.remoteVerification` — `status.ready`/`status.state` are computed entirely by `setupStateEngine.getSetupStatus()` from stored `integrations` data, on a code path that never reads the cache. Neither the Launch gate (`_orvCheckSetupReadyBeforePublish`, which only reads `res.data.state`) nor the Autopilot gate (which calls `setupStateEngine.getSetupStatus` directly, never the recheck route) consult it either. Concretely: a stale, empty, or negative cache entry can never make readiness say "ready" when it isn't, and can never make it say "not ready" when stored data says it is — proven by dedicated tests in `tests/setup-completion-routes.test.js` (`status.ready` is identical before any recheck, immediately after a failed recheck, and after a repeated failed recheck). Being in-memory means it resets on server restart and does not share state across multiple processes/instances — acceptable because it is never authoritative for anything, only ever a "here's what we last confirmed" hint next to the real, always-freshly-computed state.

## Fail-closed Launch gate (Completion Pass)

The original `_orvCheckSetupReadyBeforePublish` (`app.html`) failed OPEN on any error — if the status check itself couldn't be reached, publish proceeded anyway. Hardened this pass per the explicit instruction ("if ORIVEN cannot verify setup, do not silently allow the setup engine to claim readiness"): a confirmed non-blocking state still proceeds (unchanged), a confirmed blocking state still blocks with the platform-named "setup isn't finished" message (unchanged), but now an **inconclusive result** — the status call failing, timing out, or returning no usable state — also blocks, with a distinct "Unable to verify your [Platform] setup right now. Please try again." message. This remains a pure client-side UX layer on top of, never a replacement for, `/api/publish/:platform`'s own real server-side validation (unchanged) — a false block here costs one retry click; it can never let through something the server would have rejected. Live-verified (`tests/setup-engine-completion.test.js`): a simulated network failure on `/api/setup/meta/status` blocks the real `/api/publish/meta` call and shows the distinct message.

## Autopilot integration (Completion Pass)

`toolRouter.executeDirect(toolName, resolved, ctx)` is the single place Autopilot mutates a live ad account without a live chat session (confirmed by its own header comment — one caller in the whole codebase: `POST /api/autopilot/recommendations/:id/approve`). The readiness gate lives at that one call site: before executing a recommendation with a real `tool_name` and a real `rec.platform`, the route calls `setupStateEngine.getSetupStatus(supabaseAdmin, user.id, rec.platform)` — the exact same engine Connections and Launch already use, never a second readiness implementation — and rejects with `400 {code: 'ACCOUNT_REQUIRED'}` (marking the recommendation `failed`, not left dangling as `suggested`) if the platform isn't ready. Autopilot's other 13 routes never touch a live platform account directly (workflows are purely generative — headline/image/landing-page/email generation — the actual publish step explicitly defers to the campaign's own publish flow, already gated separately), so this one chokepoint is complete coverage, not partial. **Untestable via real HTTP in this dev environment** — discovered while testing, not assumed in advance: this Supabase project's `autopilot_recommendations` table does not exist (`PGRST205`), an infrastructure gap unrelated to this code. The gate's logic reuses `setupStateEngine.getSetupStatus`, which itself has 23 passing tests; `tests/setup-completion-routes.test.js` detects the missing table and reports the live-HTTP scenario as an honest SKIP rather than a false pass.

## Tracking/conversions routes (`server.js`)

All seven follow the same shape — auth required → resolve access via the existing `_getMetaAccess`/`_getGadsAccess`/`_getPinterestAccess`/`_getTikTokAccess` helper (unchanged) → call the adapter → structured JSON; real errors return the adapter's `err.status` with `err.message`, never a fabricated success:

- `POST /api/setup/meta/tracking`, `GET /api/setup/meta/tracking/health`
- `POST /api/setup/google/conversions` (`name` required), `GET /api/setup/google/conversions/:name/status`
- `POST /api/setup/pinterest/tag`, `GET /api/setup/pinterest/tag/health`
- `POST /api/setup/tiktok/test-event` (`pixelCode` required)

**Completion Pass additions:**

- `GET /api/setup/meta/businesses` — Business Manager discovery
- `POST /api/setup/meta/conversions` — Conversions API test event send (retried on transient failure)
- `GET /api/setup/google/conversions/:name/tag` — real website tag snippet
- `GET /api/setup/tiktok/business-centers` — Business Center discovery
- `POST /api/setup/tiktok/advertiser-account` (`bcId`, `name` required) — advertiser account creation, lock-guarded
- `POST /api/setup/tiktok/pixel/link`, `GET /api/setup/tiktok/pixel/link/status` (`bcId`, `pixelCode` required) — pixel-linkage ensure/check
- `POST /api/setup/pinterest/events` (`eventName` etc.) — Conversions API event send, retried on transient failure
- `POST /api/setup/pinterest/ad-account` (`name`, `country` required) — ad account creation, lock-guarded
- `POST /api/setup/:platform/recheck` — real remote verification, 5-minute in-memory cache

Every mutation logs a structured audit line via `_logSetupEvent(eventType, userId, payload)` — `console.log`-based, not a new DB table (see "Design decisions" below): `META_PIXEL_CREATED`, `META_CONVERSIONS_API_EVENT_SENT`, `GOOGLE_CONVERSION_ACTION_CREATED`, `PINTEREST_TAG_CONFIGURED`, `PINTEREST_CONVERSIONS_API_EVENT_SENT`, `PINTEREST_AD_ACCOUNT_CREATED`, `TIKTOK_ADVERTISER_CREATED`, `TIKTOK_PIXEL_LINKED`, `SETUP_VERIFIED`, `SETUP_FAILED`. Never includes tokens/secrets.

## Token refresh

Google and Pinterest already had real, working refresh-token flows before this phase (unchanged). Meta has no refresh token by design (long-lived, non-refreshable tokens) — `_getMetaAccess` still just surfaces expiry as "reconnect," which is correct behavior, not a gap.

TikTok stored a `refresh_token` but never used it before this phase — flagged explicitly in the spec as a known gap. Fixed: `_refreshTikTokToken(userId, refreshToken)` (`server.js`, mirrors Pinterest's exact pattern) calls `POST {TIKTOK_API}/oauth2/refresh_token/` with `{app_id, secret, grant_type:'refresh_token', refresh_token}`, updates the stored token, and preserves the existing `refresh_token` if TikTok doesn't rotate it. `_getTikTokAccess` now calls this on expiry when a `refresh_token` exists, and only throws "reconnect" when it doesn't. Verified against the real TikTok endpoint with an intentionally-invalid refresh token — it returned TikTok's real `{"code":40002,"message":"Invalid refresh_token..."}`, confirming the endpoint/param shape, not just documentation. See `tests/tiktok-refresh.test.js`.

## Connections UI (`app.html`)

Each platform card gets a `.con-ready-row` (populated by `_conFetchSetupStatus()` → `GET /api/setup/status`) showing plain-language status copy (`CON_STATE_COPY`), a **checklist** (Completion Pass — `_conChecklistRows`/`_conChecklistHtml`: Connected / Ad account / Page-or-Identity / Tracking / Conversions API / Website tag / Billing, only the rows relevant to that platform's real registry entries, `✓` for confirmed-complete, `○` for "ORIVEN doesn't verify this automatically yet" — never a fabricated checkmark), and the real action(s) for its state:

- **Manual/account-selection states** → an official-flow button (`window.open(url, '_blank', 'noopener,noreferrer')`, falling back to same-tab navigation with a toast if the popup is blocked) labeled `Continue to X` — never a verb implying Oriven is doing the work itself.
- **TikTok `account_creation_required`** (Completion Pass) → an inline "Create ad account" form (name input) that calls the real advertiser-creation route first, falling back to the official-flow button underneath if no Business Center is found or the platform rejects it.
- **Pinterest `manual_action_required`** (Completion Pass) → an inline "Create ad account" form (name + country) that attempts the real API creation, with the official-flow button kept alongside as the safety net.
- **Ready + tracking capability implemented** (Meta/Google/Pinterest) → a real `Set up X` button that calls the tracking route above and shows the real result.
- **Ready + Conversions API implemented** (Meta/Pinterest, Completion Pass) → a second, separate "Send test event (Conversions API)" button — deliberately not merged with the Pixel/Tag button, since object-exists and events-flowing are different states.
- **Ready, Google** (Completion Pass) → a "View install snippet" button showing the real retrieved `tag_snippets`.
- **Ready, TikTok specifically** → a pixel-code input + `Send test event` + (Completion Pass) `Link pixel to this account`, matching the honest Pixel-creation gap — there is no "Set up TikTok Pixel" button anywhere, because Oriven cannot create one, but linking an existing one is real.
- **Ready, any platform** (Completion Pass) → a "Recheck" link triggering `POST /api/setup/:platform/recheck` (real remote verification) and showing its honest result.

On return from an official-flow tab, a `visibilitychange` listener re-fetches real status rather than assuming success.

This is a simplified version of the spec's full popup+`postMessage` callback architecture — chosen because it matches the app's existing (unchanged) OAuth-connect pattern, which also doesn't use message-passing, and building the full architecture is separate, larger work. Documented here as a deliberate, disclosed scope reduction, not an oversight.

## Launch integration

`window.cgrPublishTo(platform, campId)` (`app.html`) is the single real entry point every "Publish to X" button calls. Before this phase it went straight from the free-user check to `POST /api/publish/:platform`. It now calls `_orvCheckSetupReadyBeforePublish(platform, onReady)` first:

```js
function _orvCheckSetupReadyBeforePublish(platform, onReady) {
  // blocks only on genuinely blocking states: not_started, authentication_required,
  // account_selection_required, account_creation_required, assets_required, manual_action_required
  // fails OPEN (calls onReady()) on any fetch error or inconclusive state —
  // this can never be the thing that blocks a publish the real server-side
  // /api/publish/:platform route would otherwise have allowed.
}
```

The original publish logic is unchanged and untouched — it was renamed to `_cgrPublishToConfirmed(platform, campId)` and is now only reached once the gate passes. `window.cgrPublishTo` keeps its name, so all six existing "Publish to X" `onclick` call sites needed no changes.

Live-verified end to end (`tests/launch-readiness-gate.test.js`, real browser + real running backend, disposable Supabase users, real `integrations` rows):
- A platform with no integration row at all (`not_started`) never triggers a `/api/publish/:platform` request, and shows a specific message naming the platform and pointing at Connections.
- A platform meeting the real readiness bar (auth + ad account + Page) is not blocked — the real `/api/publish/meta` request fires exactly as before this phase.

`/api/publish/:platform`'s own server-side validation is unchanged and remains the real, authoritative gate — this is a client-side UX improvement (avoid a doomed round-trip and a cryptic API error) on top of it, not a replacement for it.

## Testing

Backend (`oriven-backand-clean/server/tests/`, run via `npm test` in that directory):

| File | Checks | What it proves |
|---|---|---|
| `platform-setup-engine.test.js` | 23 | Registry shape, every classification correction (including the Completion Pass's) landed exactly as intended and nothing else drifted |
| `setup-adapters.test.js` | 37 | Mock-client tests: idempotency, verify-after-mutate, honest failure reporting, health-signal separation, for all four adapters — including every Completion Pass addition (Meta Business/CAPI, Google tag/customer-status, Pinterest events/ad-account, TikTok BC/advertiser/pixel-link) |
| `tiktok-refresh.test.js` | 3 | Real network calls against TikTok's real refresh endpoint — expired+invalid-refresh-token gets a real rejection, expired+no-refresh-token is unchanged, valid token never triggers a refresh call |
| `setup-tracking-routes.test.js` | 13 | Real HTTP against the running server: auth required, input validation, honest "not connected" errors, and real-platform rejection of fake tokens (Meta, TikTok) — never a fabricated success |
| `setup-errors.test.js` (Completion Pass) | 14 | Pure unit: real platform-error → correct internal code mapping (including a real bug this test caught and fixed — a Meta "Business Verification" 403 was mis-classified as generic `PERMISSION_REQUIRED` before a check-order fix), retry-vs-never-retry classification, bounded backoff behavior |
| `setup-locks.test.js` (Completion Pass) | 5 | Pure unit: same-key concurrent calls execute once and share the result, different keys never block each other, a failed call releases its lock instead of wedging forever |
| `setup-completion-routes.test.js` (Completion Pass) | 24 (23 real + 1 honest SKIP) | Real HTTP: auth/validation on every new route, honest "not connected" and real-platform-rejection behavior for every new capability, the Autopilot readiness gate (ready platform not blocked; not-ready platform blocked with `ACCOUNT_REQUIRED` and the recommendation marked `failed`) where testable, and a concurrency smoke test on the lock-guarded creation routes |

Frontend (`tests/`, run via `npm test` at the repo root):

| File | Checks | What it proves |
|---|---|---|
| `setup-engine-ui.test.js` | 12 | Correct status copy and correct action per state across all four platforms, official-flow buttons target real platform URLs (not invented ones), a tracking-setup click with a fake token surfaces a real error, zero JS console errors, no horizontal overflow at 3 viewports |
| `launch-readiness-gate.test.js` | 3 | The Launch integration above, live, in a real browser against the real backend |
| `setup-engine-completion.test.js` (Completion Pass) | 15 | Checklist rows render, Conversions API/tag-snippet/Recheck/pixel-link actions render and behave honestly on a fake token, TikTok/Pinterest inline creation forms render with their official-flow fallback intact, zero JS errors, no overflow at 3 viewports, and the FAIL-CLOSED Launch gate live-verified end to end (a simulated network failure on the status check blocks the real publish call with a distinct "unable to verify" message) |

All of the above are real HTTP/real browser tests against a running local server plus disposable Supabase test users — no mocked backend for the integration-level tests, only the adapter unit tests use mock clients (by design, since no elevated-permission live OAuth credentials exist in this dev environment for mutation testing). One scenario (the Autopilot gate's live-HTTP path) is an honest, environment-caused SKIP — see "Autopilot integration" above.

## Not implemented (honest, matches the registry, after the Completion Pass)

Everything below is `implemented: false` in `platformCapabilities.js` and has no adapter code. For each: **why**, **what the user must do**, **what ORIVEN does afterward**, **how ORIVEN verifies it**.

- **Meta Business Manager creation** (first one) — *why:* `POST /{business_id}/businesses` requires an existing `business_id`, structurally cannot create a user's first Business Manager (re-confirmed this pass). *User does:* create it at business.facebook.com (officialFlow). *ORIVEN does after:* nothing automatic yet — the user reconnects/refreshes Connections. *Verification:* `GET /api/setup/meta/businesses` (real, implemented) will show it once created.
- **Meta ad account creation** — *why:* `POST /{business_id}/adaccount` is real but gated by Business Verification for most apps (re-confirmed, unchanged). *User does:* complete Business Verification + create the account at business.facebook.com/settings/ad-accounts. *ORIVEN does after:* discovers it via existing `GET /me/adaccounts` (unchanged, already real). *Verification:* the existing account-discovery step in `checkMetaSetup`.
- **Meta billing / verification checks** — *why:* no general-availability API for either exists. *User does:* complete in Meta Business Manager (officialFlow). *ORIVEN does after:* nothing (no read API confirmed). *Verification:* none yet — reported as `not_verified_by_oriven`, never faked.
- **Google `CreateCustomerClient`** — *why:* real endpoint, gated by >$1,000 USD historical spend + policy standing on the manager account (re-confirmed, unchanged). *User does:* create the account in Google Ads UI if ineligible (officialFlow). *ORIVEN does after:* discovers it via existing account-discovery. *Verification:* `checkCustomerStatus` (new this pass) confirms the resulting customer is real and `ENABLED`.
- **Google billing checks** — *why:* no general-availability billing-setup/read API. *User does:* complete in Google Ads UI. *ORIVEN does after:* nothing yet. *Verification:* none — `not_verified_by_oriven`.
- **TikTok Business Center creation** — *why:* no create/list-from-scratch endpoint exists anywhere in the official SDK's 47-method BCApi table (re-confirmed this pass alongside the Pixel research). *User does:* create it in TikTok Business Center (officialFlow). *ORIVEN does after:* discovers it via the new `GET /bc/get/` (real, implemented). *Verification:* that same discovery call.
- **TikTok billing** — *why:* balance-read and transfer endpoints exist, but initial payment-method attachment is platform-UI-only. *User does:* attach a payment method in TikTok Business Center. *ORIVEN does after:* nothing yet (balance-read endpoints identified but not wired this pass). *Verification:* none yet.
- **TikTok Pixel creation** (linkage is now real — see corrections table) — *why:* no create/list endpoint confirmed after two genuine research passes. *User does:* create it in TikTok Ads Manager, copy the pixel code into ORIVEN. *ORIVEN does after:* verifies/links it to the active account (real, implemented this pass) and can send test events. *Verification:* `checkPixelLinkage`.
- **Pinterest Business Access verification** — *why:* no confirmed read API for verification status. *User does:* complete Business Access setup on Pinterest (officialFlow). *ORIVEN does after:* nothing yet. *Verification:* none — `not_verified_by_oriven`.
- **Pinterest billing** — *why:* no API for adding a funding source. *User does:* complete billing on Pinterest (officialFlow). *ORIVEN does after:* nothing yet. *Verification:* none.
- **Pinterest audiences** — *why:* out of scope this pass (not a completion-pass target; no research was done). *User does:* N/A. *ORIVEN does after:* N/A.
- All platforms: a persisted (DB-backed) `last_verified_at`/audit table (current caching is in-memory, current audit trail is `console.log` — both deliberate, documented tradeoffs, not oversights), a full popup+`postMessage` OAuth callback architecture (the simplified `window.open`+`visibilitychange` version remains, disclosed), rate-limit/backoff retrofit across every PRE-EXISTING route (only applied to the Completion Pass's new mutation routes), real two-process/distributed concurrency locking (the in-memory guard is complete for this single-process deployment, not for a hypothetical multi-instance one).

## Design decisions worth knowing before extending this

- **Audit logging is `console.log`, not a DB table.** `_logSetupEvent` was deliberately not routed through the existing `intelligence_events` table (`services/eventLog.js`) — that table's schema and purpose (campaign/monitoring events) don't obviously fit setup-provisioning events, and repurposing it without verifying schema fit first would risk malformed rows. A real audit table is a reasonable follow-up, not done here.
- **No shared platform-connection abstraction exists**, and this phase didn't add one. `_getMetaAccess`/`_getGadsAccess`/`_getTikTokAccess`/`_getPinterestAccess` remain four independently-written functions with a consistent naming convention but no shared code. What is genuinely shared: one `integrations` table (discriminated by `provider`), one `active_ad_account` JSONB column, and `services/campaignGoals.js`.
- **The popup/redirect flow is simplified**, not the full callback-message architecture (see "Connections UI" above) — a disclosed scope reduction, not an oversight.

## Adding a future platform (e.g. Microsoft Ads, Snapchat Ads)

1. Add capability entries to `platformCapabilities.js` (`PLATFORM_CAPABILITIES.<platform> = [...]`) with real, research-verified `type`/`implemented`/`apiEndpoint`/`officialFlow` values — never guessed.
2. Add a `checkXSetup(row)` function to `setupStateEngine.js` and wire it into `getSetupStatus`.
3. Add `services/adapters/xSetupAdapter.js` following the `{get,post}`/`{query,mutate}`-injected, idempotent-`ensure` pattern above. Map its real errors through `services/setupErrors.js`'s `mapPlatformError`/`withPlatformRetry`, and guard any creation route with `services/setupLocks.js`'s `withSetupLock`, rather than inventing new versions of either.
4. Add OAuth connect/callback routes following the existing per-platform pattern (there's no shared base to extend — write a new one matching the naming convention).
5. Add the platform to `CON_PLATFORM_LABEL`/`CON_STATE_COPY`/`CON_TRACKING_SETUP` in `app.html` and a `.con-card` in the Connections page markup.
6. Add the platform's blocking-state name to `_orvCheckSetupReadyBeforePublish`'s `platNames` map in `app.html`.

No rewrite of any existing platform's code is required for any of the above.
