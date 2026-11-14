# Snapchat Ads in OrivenAI

Status as of 2026-11-14. Source of truth for the API: Snap's **Marketing API**
docs (developers.snap.com/marketing-api). Login Kit and the Public Profile API
are different products and are not used (the Public Profile API is allow-listed).

## Code map

| Part | File |
|---|---|
| API client, OAuth, media, reporting, status changes | `services/snapchatAds.js` |
| Routes (OAuth, accounts, campaigns, ad squads, ads, overview, pause/resume, config-check) | `server.js` (block "SNAPCHAT ADS") |
| Spec, validation, payloads | `services/campaignSpec.js` (`platform === 'snapchat'`, `payloads.snapchat`) |
| Create rules (shared with the frontend) | `services/createCompat.js` (`PLATFORMS.snapchat`) |
| Publish | `routes/publishRoutes.js` (`POST /api/publish/snapchat`) |
| Activation (Launch + Automations) | `services/campaignActivation.js` |
| Automations adapter / metrics | `services/automations/platforms.js`, `services/automations/metrics.js` |
| Tests | `tests/snapchat-ads.test.js` (real server.js, in-memory DB, fake Snap) |

## OAuth

- Authorize `GET https://accounts.snapchat.com/login/oauth2/authorize` — `response_type=code`, `client_id`, `redirect_uri`, `scope=snapchat-marketing-api`, `state`.
- Token `POST https://accounts.snapchat.com/login/oauth2/access_token` — form body `grant_type`, `client_id`, `client_secret`, `code`, `redirect_uri` (identical to the authorize call).
- Access token 3600 s; refreshed 5 min early, one refresh per user at a time, one retry on 401. Refresh token doesn't expire but stops when the user loses access.
- Env: `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET`, `SNAPCHAT_REDIRECT_URI` (default on Render `https://oriven-backand-clean.onrender.com/auth/snapchat/callback`).
- Snap checks the **code before the client secret**: a wrong secret is not detectable with an impossible code (`/api/snapchat/config-check` reports `client_id_known_secret_unverified`). 2026-11-14: `invalid_grant "Invalid code."` with a fresh code was fixed by the owner by correcting the Client ID / Secret pair in Render.
- Storage: `integrations` row `provider = 'snapchat_ads'`; `active_ad_account` holds `account_id, account_name, currency, timezone, organization_id, profile_id`.

## Hierarchy and publish order

Ad account → **Campaign** → **Ad Squad** (budget, targeting, optimisation) → **Ad** → **Creative** → **Media**.

Publish (`POST /api/publish/snapchat`), everything `PAUSED`:
1. Media: `POST /adaccounts/{id}/media` then `POST /media/{id}/upload` (multipart `file`, ≤ 32 MB), then poll `GET /media/{id}` until `media_status = READY` (90 s max; `FAILED` or timeout stops the publish before anything else is created).
2. Campaign: `POST /adaccounts/{id}/campaigns` — `objective_v2_properties.objective_v2_type`, `buy_model AUCTION`, `start_time`.
3. Ad squads: `POST /campaigns/{id}/adsquads` — `type SNAP_ADS`, `placement_v2 {config: AUTOMATIC}`, `billing_event IMPRESSION`, `optimization_goal`, `bid_strategy AUTO_BID`, `daily_budget_micro`, `delivery_constraint DAILY_BUDGET`, `targeting {geos:[{country_code}], demographics:[{min_age, max_age?}]}`.
4. Creative: `POST /adaccounts/{id}/creatives` — `type WEB_VIEW`, `top_snap_media_id`, `headline` (≤ 34), `brand_name` (≤ 32), `call_to_action`, `web_view_properties.url`, optional `profile_properties.profile_id`.
5. Ad: `POST /adsquads/{id}/ads` — `type REMOTE_WEBPAGE`, `status PAUSED`.

Ledger + publish lock prevent duplicates; on failure ads, ad squads and the campaign are deleted (Snap has no delete for creatives/media — they stay unused).
Activation: ads → ad squads → campaign, each a full-object `PUT` with only `status` changed (Snap resets omitted fields on PUT).

## Supported objectives and formats

| OrivenAI goal | Snap objective | Optimisation |
|---|---|---|
| Traffic | `TRAFFIC` | `SWIPES` |
| Awareness | `AWARENESS_AND_ENGAGEMENT` | `IMPRESSIONS` |

Not offered: Sales and Leads (need a Snap Pixel / lead forms OrivenAI can't set up), App promotion.
Formats: full-screen image (framed whole on a blurred 1080 × 1920 background, JPEG ≤ 5 MB) and vertical video (1080 × 1920, MP4/MOV, ≥ 3 s, ≤ 32 MB, uploaded as is).
Rules enforced in validation: one country per campaign (Snap needs a language entry for multi-country targeting), ≥ 5 per day per ad squad (budget split evenly), min age ≤ 35, `max_age` omitted at 55+.

## Metrics mapping (`GET /adaccounts/{id}/stats?breakdown=campaign`, DAY/HOUR start/end on the account timezone's hour)

| OrivenAI | Snap field | Note |
|---|---|---|
| Spend | `spend` | micro-currency ÷ 1 000 000, account currency |
| Impressions | `impressions` | |
| Clicks | `swipes` | swipe-ups |
| CTR / CPC / CPM | derived from the three above | |
| Video views | `video_views` | read, not shown yet |
| Conversions | — | null ("not reported"), never 0 — needs a Snap Pixel |

Reach and frequency are not requested (Snap's `uniques` is not available per campaign breakdown in our query). Data is finalised by Snap 48 h after the day ends.

## Automations

Status (pause/resume via activation) and budgets (campaign `daily_budget_micro`, or ad squad daily budgets scaled together; refused below 5 per ad squad). Metrics available to rules: spend, impressions, clicks, CTR, CPC, status.

## Limitations

- Public Profile ID is pasted by the user (profile listing API is allow-listed).
- No Snap Pixel / conversions, no Sales/Leads objectives, no Lens/Collection/Story/App ads.
- Audience Builder has no Snapchat targeting model; the weekly report and the setup-readiness checklist don't include Snapchat yet.
- Reads retry once on 429; writes never retry automatically.

## Verification status

- Mocked: everything above (`tests/snapchat-ads.test.js`).
- Real Snap responses: token endpoint error shapes and order; OAuth connection with a real account (owner, 2026-11-14).
- Not yet verified with the real account: campaign/ad squad/media/creative/ad creation, stats, status/budget changes.
