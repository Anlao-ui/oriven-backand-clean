// ════════════════════════════════════════════════════════════════
// Universal Advertising Setup Engine — Phase 1: Capability Registry
//
// The single source of truth for "what can ORIVEN actually do, per
// platform, for a given piece of advertising infrastructure, through
// the official API — and what genuinely requires the user to act on
// the platform itself." Every classification below is backed by a
// real, dated source (current official docs/behavior, researched
// 2026-08), not inferred from a library, a blog post, or the
// assumption that a readable object must also be writable.
//
// This registry is PURELY DEFINITIONAL — it makes no network calls,
// reads no user data, and creates nothing. setupStateEngine.js is
// the layer that combines this registry with a user's actual stored
// connection state to answer "is THIS user's THIS platform ready."
//
// Classification model (spec: universal A/B/C model):
//   API          — ORIVEN can perform the whole operation through the
//                   official API, no platform UI involved.
//   API_GATED    — same as API, but the official API itself imposes an
//                   eligibility gate (spend history, verification,
//                   account limits) ORIVEN must check before attempting
//                   it — NOT universally available just because the
//                   endpoint exists.
//   HYBRID       — ORIVEN performs part of the operation; a real user
//                   action (usually outside ORIVEN, e.g. installing a
//                   website tag) is still required to complete it.
//   MANUAL       — the platform requires this to happen in its own UI;
//                   ORIVEN cannot perform it via API at all today.
//   UNSUPPORTED  — the platform's current API does not expose this
//                   capability in any form ORIVEN could use.
//
// `implemented` is a SEPARATE axis from the classification above: it
// records whether ORIVEN's own codebase actually performs/verifies
// this capability today. A capability can be legitimately API-doable
// (`type: 'API'`) while `implemented: false` — that just means nobody
// has built it in ORIVEN yet. The setup-state engine must only ever
// report a capability as satisfied when `implemented` is true AND the
// user's real stored data confirms it — never on classification alone.
// ════════════════════════════════════════════════════════════════

const TYPE = Object.freeze({
  API: 'API',
  API_GATED: 'API_GATED',
  HYBRID: 'HYBRID',
  MANUAL: 'MANUAL',
  UNSUPPORTED: 'UNSUPPORTED',
});

const CATEGORY = Object.freeze({
  AUTHENTICATION: 'AUTHENTICATION',
  BUSINESS: 'BUSINESS',
  AD_ACCOUNT: 'AD_ACCOUNT',
  ASSETS: 'ASSETS',
  TRACKING: 'TRACKING',
  CONVERSIONS: 'CONVERSIONS',
  AUDIENCES: 'AUDIENCES',
  BILLING: 'BILLING',
  PERMISSIONS: 'PERMISSIONS',
  VERIFICATION: 'VERIFICATION',
  CAMPAIGNS: 'CAMPAIGNS',
  REPORTING: 'REPORTING',
});

/**
 * @typedef {Object} Capability
 * @property {string} platform
 * @property {string} category    - one of CATEGORY
 * @property {string} key         - stable identifier, e.g. 'meta.adAccount'
 * @property {string} label       - user-facing name (never raw API terms)
 * @property {string} type        - one of TYPE
 * @property {boolean} implemented - does ORIVEN's code do this today?
 * @property {string|null} apiEndpoint - official endpoint reference, for devs only
 * @property {string[]} requiredScopes - OAuth scopes this needs
 * @property {string[]} prerequisites  - other capability keys required first
 * @property {string} verification - HOW readiness is actually confirmed (plain text)
 * @property {string} retry        - retry behavior on failure
 * @property {string} rollback     - rollback behavior on partial failure
 * @property {string|null} humanAction - what the user must personally do, if anything
 * @property {{label:string, urlTemplate:string}|null} officialFlow - "Continue to X" destination
 * @property {string} docs         - source this classification is based on
 */

function cap(c) {
  return Object.freeze({
    requiredScopes: [],
    prerequisites: [],
    humanAction: null,
    officialFlow: null,
    apiEndpoint: null,
    ...c,
  });
}

// ────────────────────────────────────────────────────────────────
// META
// ────────────────────────────────────────────────────────────────
const META = Object.freeze([
  cap({
    platform: 'meta', category: CATEGORY.AUTHENTICATION, key: 'meta.auth',
    label: 'Connect your Meta account', type: TYPE.API, implemented: true,
    apiEndpoint: 'GET /auth/meta/callback (Facebook OAuth)',
    requiredScopes: ['ads_read', 'ads_management', 'business_management', 'pages_show_list'],
    verification: 'A stored, unexpired access_token exists on the integrations row (provider=meta_ads).',
    retry: 'User can re-run OAuth at any time; no partial state to clean up.',
    rollback: 'N/A — OAuth is atomic (either a token is stored or it is not).',
    docs: 'server.js:9558-9743 (existing implementation)',
  }),
  cap({
    platform: 'meta', category: CATEGORY.BUSINESS, key: 'meta.businessManager',
    label: 'Meta Business Manager', type: TYPE.API_GATED, implemented: true,
    apiEndpoint: 'GET /me/businesses (discover — real, unconditional, implemented); POST /{business_id}/businesses (create — NOT implemented, see verification)',
    requiredScopes: ['business_management'],
    prerequisites: ['meta.auth'],
    verification: 'RE-RESEARCHED and CORRECTED during the Completion Pass: the Phase 1 note ("creating a Business is API-doable") was imprecise about what that endpoint actually creates. POST /{business_id}/businesses requires an EXISTING business_id in its own URL path (developers.facebook.com/docs/business-management-apis) — it creates a client/sub-business UNDER a Business Manager the caller already owns. It is structurally incapable of creating a user\'s VERY FIRST Business Manager, which is the case that matters for ORIVEN\'s onboarding — so creation is deliberately NOT implemented rather than built against a capability that would not solve the real problem. DISCOVERY, by contrast, genuinely is real and unconditional (no eligibility gate) and is now implemented: services/adapters/metaSetupAdapter.js findExistingBusinesses(), wired at GET /api/setup/meta/businesses.',
    retry: 'N/A for discovery (read-only).',
    rollback: 'Do not delete a real Business if a later step fails — mark setup incomplete instead.',
    humanAction: 'A first Business Manager must be created through business.facebook.com — there is no API path that creates one from nothing. Advanced Access / programmatic ad-account creation under an existing Business additionally requires Business Verification.',
    officialFlow: { label: 'Continue to Meta', urlTemplate: 'https://business.facebook.com/overview' },
    docs: 'services/adapters/metaSetupAdapter.js findExistingBusinesses(); server.js GET /api/setup/meta/businesses; developers.facebook.com/docs/business-management-apis (2026 research — corrected: create endpoint requires an existing business_id, cannot create a first Business Manager).',
  }),
  cap({
    platform: 'meta', category: CATEGORY.AD_ACCOUNT, key: 'meta.adAccount',
    label: 'Ad account', type: TYPE.API_GATED, implemented: false,
    apiEndpoint: 'POST /{business_id}/adaccount',
    requiredScopes: ['ads_management', 'business_management'],
    prerequisites: ['meta.businessManager'],
    verification: 'Today: existing ad accounts are only discovered (GET /me/adaccounts), never created. account_status/disable_reason ARE checked live at publish time (_verifyMetaAdAccountWritable) but that result is not persisted or exposed as a setup state.',
    retry: 'Check meta_ads_accounts for an existing usable account before attempting creation.',
    rollback: 'Never delete a real ad account on later-step failure.',
    humanAction: 'Business Verification is required before an ad account can be created programmatically for most apps.',
    officialFlow: { label: 'Continue to Meta', urlTemplate: 'https://business.facebook.com/settings/ad-accounts' },
    docs: 'developers.facebook.com/docs/marketing-api/reference/ad-account (2026 research: POST /{business_id}/adaccount exists; gated by Business Verification).',
  }),
  cap({
    platform: 'meta', category: CATEGORY.ASSETS, key: 'meta.assets',
    label: 'Facebook Page & Instagram account', type: TYPE.API, implemented: true,
    apiEndpoint: 'GET /me/accounts (Pages)',
    requiredScopes: ['pages_show_list'],
    prerequisites: ['meta.auth'],
    verification: 'meta_pages is populated from a real API call (_fetchMetaPages) and active_page is user-selected + stored.',
    retry: 'Re-fetch pages via GET /api/meta/pages at any time.',
    rollback: 'N/A — read-only discovery, nothing created.',
    docs: 'server.js:9877-9910 (existing implementation)',
  }),
  cap({
    platform: 'meta', category: CATEGORY.TRACKING, key: 'meta.pixel',
    label: 'Meta Pixel', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'GET /{ad_account_id}/adspixels (discover/reuse), POST /{ad_account_id}/adspixels (create, name required), GET /{pixel_id}?fields=last_fired_time,has_1p_pixel_event (health)',
    requiredScopes: ['ads_management'],
    prerequisites: ['meta.adAccount'],
    verification: 'services/adapters/metaSetupAdapter.js: ensurePixel() reuses an existing pixel (idempotent, never duplicates) or creates + verifies one via a follow-up GET; checkPixelHealth() distinguishes exists / installed (has ever fired) / receivingEvents (has_1p_pixel_event) as three separate signals — never collapsed into one boolean. Wired at POST/GET /api/setup/meta/tracking(/health). Endpoint-correctness verified against developers.facebook.com; creation/health NOT verified against a real live ad account (no elevated-permission Meta app credentials in this environment) — covered by mock-API tests (tests/setup-adapters.test.js) and real-network auth-rejection tests (tests/setup-tracking-routes.test.js) instead.',
    retry: 'Always check for an existing pixel on the ad account before creating a new one (implemented).',
    rollback: 'N/A for reuse; creation never deletes a pixel with real event history (no delete path exists).',
    humanAction: 'Installing the pixel base code on the website is still a user/website action ORIVEN does not perform.',
    docs: 'services/adapters/metaSetupAdapter.js; server.js POST/GET /api/setup/meta/tracking; developers.facebook.com/docs/marketing-api/reference/ads-pixel (2026 research, endpoint confirmed).',
  }),
  cap({
    platform: 'meta', category: CATEGORY.CONVERSIONS, key: 'meta.conversionsApi',
    label: 'Server-side conversion tracking (Conversions API)', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'POST /{pixel_id}/events — same pixel/dataset id as meta.pixel, there is no separate CAPI dataset id for a standard web Pixel',
    prerequisites: ['meta.pixel'],
    verification: 'services/adapters/metaSetupAdapter.js: sendServerEvent() sends real server-side event(s) to the existing pixel and reports success ONLY from events_received > 0 in Meta\'s response — never assumed from HTTP 200. This is a SEPARATE state from meta.pixel (object existence) and from checkPixelHealth().receivingEvents (browser-side firing) — deliberately never collapsed. Wired at POST /api/setup/meta/conversions, retried on transient failure via services/setupErrors.js. Endpoint/response shape confirmed against developers.facebook.com server-event + response-field references; not verified against a real live pixel (no elevated Meta app credentials in this environment) — covered by mock-API tests.',
    retry: 'Automatic bounded retry on RATE_LIMITED/PLATFORM_UNAVAILABLE only (services/setupErrors.js withPlatformRetry) — never retried on a real rejection.',
    rollback: 'N/A — events are not created resources to roll back.',
    humanAction: 'A real, ongoing server-side (or website) event stream is what makes tracking actually useful — ORIVEN\'s one test-event send proves the pipe works, it does not by itself mean production events are flowing continuously.',
    docs: 'services/adapters/metaSetupAdapter.js sendServerEvent(); server.js POST /api/setup/meta/conversions; developers.facebook.com/docs/marketing-api/conversions-api + .../parameters/server-event (2026 research, endpoint + response fields confirmed).',
  }),
  cap({
    platform: 'meta', category: CATEGORY.BILLING, key: 'meta.billing',
    label: 'Billing', type: TYPE.MANUAL, implemented: false,
    verification: 'Not implemented. account_status/disable_reason (checked live, not persisted) is Meta\'s own eligibility flag, not a funding-source/payment-method check.',
    retry: 'N/A.',
    rollback: 'N/A — never store payment credentials in ORIVEN.',
    humanAction: 'Payment method must be added in Meta Business Manager.',
    officialFlow: { label: 'Complete in Meta', urlTemplate: 'https://business.facebook.com/billing_hub' },
    docs: 'No official API for adding a funding source; Meta requires this in-product.',
  }),
  cap({
    platform: 'meta', category: CATEGORY.VERIFICATION, key: 'meta.verification',
    label: 'Business verification', type: TYPE.MANUAL, implemented: false,
    verification: 'Not implemented — no code reads Meta Business Verification status.',
    retry: 'N/A.',
    rollback: 'N/A.',
    humanAction: 'Business Verification (documents, domain, etc.) must be completed in Meta Business Manager.',
    officialFlow: { label: 'Complete in Meta', urlTemplate: 'https://business.facebook.com/settings/security' },
    docs: 'developers.facebook.com — Business Verification is required for Advanced Access / programmatic account creation.',
  }),
  cap({
    platform: 'meta', category: CATEGORY.CAMPAIGNS, key: 'meta.campaigns',
    label: 'Campaign creation & management', type: TYPE.API, implemented: true,
    apiEndpoint: 'POST /api/publish/meta -> Marketing API campaign/ad set/ad creation',
    requiredScopes: ['ads_management'],
    prerequisites: ['meta.adAccount', 'meta.assets'],
    verification: 'Real, working publish pipeline with full rollback on partial failure.',
    retry: 'Publish can be retried; existing rollback deletes partially-created objects in reverse order.',
    rollback: 'Implemented: ads -> creatives -> ad sets -> campaign, in that order (server.js:6880-6896).',
    docs: 'server.js:6610 (existing implementation)',
  }),
  cap({
    platform: 'meta', category: CATEGORY.REPORTING, key: 'meta.reporting',
    label: 'Performance reporting', type: TYPE.API, implemented: true,
    verification: 'Real insights API calls power dashboard aggregation.',
    retry: 'Standard re-fetch.',
    rollback: 'N/A — read-only.',
    docs: 'server.js:13178-13227 (_metaFetchTotals, _metaFetchDailySeries)',
  }),
]);

// ────────────────────────────────────────────────────────────────
// GOOGLE
// ────────────────────────────────────────────────────────────────
const GOOGLE = Object.freeze([
  cap({
    platform: 'google', category: CATEGORY.AUTHENTICATION, key: 'google.auth',
    label: 'Connect your Google account', type: TYPE.API, implemented: true,
    apiEndpoint: 'GET /auth/google/callback (Google OAuth 2.0) + GOOGLE_ADS_DEVELOPER_TOKEN header',
    requiredScopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/adwords'],
    verification: 'A stored, refreshable access_token exists on the integrations row (provider=google_ads); refresh is real and working.',
    retry: 'Refresh token is used automatically on expiry (server.js:10471-10494); full re-OAuth only needed if refresh itself fails.',
    rollback: 'N/A — OAuth is atomic.',
    docs: 'server.js:7410-7534 (existing implementation, includes real refresh-token logic)',
  }),
  cap({
    platform: 'google', category: CATEGORY.BUSINESS, key: 'google.managerAccount',
    label: 'Manager account (MCC)', type: TYPE.API, implemented: true,
    apiEndpoint: 'customers:listAccessibleCustomers + customer_client GAQL',
    prerequisites: ['google.auth'],
    verification: 'Real discovery, including recursive expansion of ALL non-manager descendants at any depth, with correct login-customer-id derivation per account (server.js:7215-7398, 10457-10517).',
    retry: 'Re-fetch via GET /api/google/accounts.',
    rollback: 'N/A — discovery only, nothing created.',
    docs: 'server.js:7215-7398 (existing implementation — the most mature account-discovery logic of any platform in this codebase)',
  }),
  cap({
    platform: 'google', category: CATEGORY.AD_ACCOUNT, key: 'google.customerClient',
    label: 'Google Ads account', type: TYPE.API_GATED, implemented: false,
    apiEndpoint: 'CustomerService.CreateCustomerClient',
    requiredScopes: ['https://www.googleapis.com/auth/adwords'],
    prerequisites: ['google.managerAccount'],
    verification: 'Not implemented — only discovery of EXISTING customer_client accounts exists today; CreateCustomerClient is never called.',
    retry: 'Must check manager-account eligibility (see humanAction) before every attempt — do not retry blindly on CREATION_DENIED_INELIGIBLE_MCC.',
    rollback: 'Never delete a real customer account on later-step failure.',
    humanAction: 'Only eligible when the authenticated manager account has >$1,000 USD historical spend and is in good policy standing; an ineligible manager gets CustomerError.CREATION_DENIED_INELIGIBLE_MCC and must create the account via Google Ads UI instead.',
    officialFlow: { label: 'Continue to Google Ads', urlTemplate: 'https://ads.google.com/aw/overview' },
    docs: 'developers.google.com/google-ads/api/docs/account-management/create-account + CreateCustomerClientRequest reference (2026 research: real endpoint, real eligibility gate — must NOT be exposed as universally available).',
  }),
  cap({
    platform: 'google', category: CATEGORY.TRACKING, key: 'google.tag',
    label: 'Website conversion tag', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'GAQL SELECT conversion_action.tag_snippets FROM conversion_action (read-only; NOT populated by the create mutation itself — requires a follow-up query)',
    prerequisites: ['google.conversionAction'],
    verification: 'services/adapters/googleSetupAdapter.js: fetchTagSnippets() retrieves the REAL global_site_tag + event_snippet Google generates for an existing conversion action. This is the API-doable half (HYBRID): ORIVEN retrieves and displays the real snippet, but does not and cannot install it on the user\'s website — that remains the user\'s action. Never claims installation happened. Wired at GET /api/setup/google/conversions/:name/tag. Field confirmed via developers.google.com\'s ConversionAction reference (tag_snippets is real, output-only, populated only on a follow-up read); not verified against a real live Google Ads account (no Standard/Advanced developer-token access confirmed in this environment).',
    retry: 'Standard re-fetch.',
    rollback: 'N/A — read-only.',
    humanAction: 'Website-side tag installation (pasting the retrieved snippet into the site) is still a real, required user/developer action ORIVEN does not perform for most conversion types even after retrieval.',
    docs: 'services/adapters/googleSetupAdapter.js fetchTagSnippets(); server.js GET /api/setup/google/conversions/:name/tag; developers.google.com/google-ads/api/fields (2026 research, tag_snippets field confirmed real and output-only).',
  }),
  cap({
    platform: 'google', category: CATEGORY.CONVERSIONS, key: 'google.conversionAction',
    label: 'Conversion tracking', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'ConversionActionService.MutateConversionActions (create); GAQL SELECT ... FROM conversion_action (read/verify); creating one also auto-creates its CustomerConversionGoal',
    prerequisites: ['google.customerClient'],
    verification: 'services/adapters/googleSetupAdapter.js: ensureConversionAction() looks up an existing action by name first (idempotent) or creates + verifies via a follow-up GAQL query; never touches primary_for_goal or any existing goal config. Wired at POST /api/setup/google/conversions and GET .../:name/status. Endpoint-correctness verified against developers.google.com; creation NOT verified against a real live Google Ads account (no Standard/Advanced developer-token access confirmed in this environment) — covered by mock-API tests instead.',
    retry: 'Checks for an existing ConversionAction with the same name before creating (implemented) — does not yet dedupe on category+origin specifically.',
    rollback: 'Never deletes or alters primary_for_goal/goal config on an existing conversion action — creation-only.',
    humanAction: 'Website tracking install still required for most categories; object creation alone is not "tracking ready."',
    docs: 'services/adapters/googleSetupAdapter.js; server.js POST /api/setup/google/conversions; developers.google.com/google-ads/api/samples/add-conversion-action (2026 research, endpoint confirmed).',
  }),
  cap({
    platform: 'google', category: CATEGORY.BILLING, key: 'google.billing',
    label: 'Billing', type: TYPE.MANUAL, implemented: false,
    verification: 'Not implemented — no billing/payments-profile check exists; the only signal today is indirect (POLICY_FINDING errors surfaced at publish time).',
    retry: 'N/A.',
    rollback: 'N/A — never store payment credentials in ORIVEN.',
    humanAction: 'Billing setup must be completed in the Google Ads UI.',
    officialFlow: { label: 'Complete in Google Ads', urlTemplate: 'https://ads.google.com/aw/billing' },
    docs: 'No general-availability billing-setup API; Google requires this in-product.',
  }),
  cap({
    platform: 'google', category: CATEGORY.CAMPAIGNS, key: 'google.campaigns',
    label: 'Campaign creation & management', type: TYPE.API, implemented: true,
    apiEndpoint: 'POST /api/publish/google -> Search/Demand Gen/Performance Max batch mutate',
    prerequisites: ['google.customerClient'],
    verification: 'Real, working publish pipeline with rollback of orphaned campaign/budget resources on failure.',
    retry: 'Publish can be retried.',
    rollback: 'Implemented (server.js:6540-6583).',
    docs: 'server.js:5835 (existing implementation)',
  }),
  cap({
    platform: 'google', category: CATEGORY.REPORTING, key: 'google.reporting',
    label: 'Performance reporting', type: TYPE.API, implemented: true,
    verification: 'Real GAQL-based dashboard aggregation.',
    retry: 'Standard re-fetch.',
    rollback: 'N/A — read-only.',
    docs: 'server.js:13152-13201 (_gadsFetchTotals, _gadsFetchDailySeries)',
  }),
]);

// ────────────────────────────────────────────────────────────────
// TIKTOK
// ────────────────────────────────────────────────────────────────
const TIKTOK = Object.freeze([
  cap({
    platform: 'tiktok', category: CATEGORY.AUTHENTICATION, key: 'tiktok.auth',
    label: 'Connect your TikTok account', type: TYPE.API, implemented: true,
    apiEndpoint: 'GET /auth/tiktok/callback (TikTok OAuth)',
    verification: 'A stored access_token exists on the integrations row (provider=tiktok_ads).',
    retry: 'A refresh_token IS captured and stored but never used — _getTikTokAccess only checks expiry and asks the user to fully reconnect rather than silently refreshing. This is a real, known gap worth closing in a later phase, not something Phase 1/2 papers over.',
    rollback: 'N/A — OAuth is atomic.',
    docs: 'server.js:8504-8611 (existing implementation)',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.BUSINESS, key: 'tiktok.businessCenter',
    label: 'TikTok Business Center', type: TYPE.MANUAL, implemented: false,
    verification: 'Explicitly and deliberately unimplemented: server.js:7041-7043 refuses BC_AUTH_TT identities with a clear user-facing message rather than faking support — this is the exact honest-refusal pattern the rest of the setup engine should follow.',
    retry: 'N/A.',
    rollback: 'N/A.',
    humanAction: 'Business Center itself must be created via TikTok\'s UI; ORIVEN has no API path to create the Business Center resource itself.',
    officialFlow: { label: 'Continue to TikTok', urlTemplate: 'https://business.tiktok.com/' },
    docs: 'server.js:7041-7043 (existing explicit refusal); ads.tiktok.com/help (2026 research: no BC-creation API found).',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.AD_ACCOUNT, key: 'tiktok.advertiserAccount',
    label: 'Advertiser account', type: TYPE.API_GATED, implemented: true,
    apiEndpoint: 'GET /open_api/v1.3/bc/get/ (discover Business Centers) + POST /open_api/v1.3/bc/advertiser/create/ (create, under an existing BC)',
    prerequisites: ['tiktok.businessCenter'],
    verification: 'COMPLETION PASS — wired for real: services/adapters/tiktokSetupAdapter.js findBusinessCenters()+ensureAdvertiserAccount(). Idempotent (reuses any existing advertiser account, never duplicates) and lock-guarded against a double-click/two-tab race (services/setupLocks.js). Response field names for a newly-created advertiser are not documented anywhere in the official SDK (only the generic InlineResponse200 envelope) — rather than trust an unconfirmed field, success is verified ENTIRELY via a real follow-up call to the same, already-working _fetchTikTokAdvertisers discovery function this codebase already used before this pass. Wired at GET /api/setup/tiktok/business-centers and POST /api/setup/tiktok/advertiser-account. Endpoint/request-body shape confirmed via the official SDK\'s BCApi.md + AdvertiserCreateBody/BcadvertisercreateAdvertiserInfo/BcadvertisercreateCustomerInfo model docs; not verified against a real live TikTok Business Center (no elevated Business Center admin access in this environment) — covered by mock-API tests.',
    retry: 'Does not blindly retry a rejection — region, verification, permission, and account-limit rejections are all real, non-transient failure modes mapped to distinct services/setupErrors.js codes.',
    rollback: 'Never delete a real advertiser account on later-step failure.',
    humanAction: 'The Business Center itself must already exist (tiktok.businessCenter, still MANUAL — no BC-creation API exists); requires Business Center admin/sufficient permission on the authenticated user; may still be blocked by region, verification, or account limits, in which case this becomes a manual step in TikTok Business Center.',
    officialFlow: { label: 'Continue to TikTok', urlTemplate: 'https://business.tiktok.com/' },
    docs: 'services/adapters/tiktokSetupAdapter.js findBusinessCenters()/ensureAdvertiserAccount(); server.js GET /api/setup/tiktok/business-centers, POST /api/setup/tiktok/advertiser-account; github.com/tiktok/tiktok-business-api-sdk js_sdk/docs/BCApi.md + AdvertiserCreateBody.md family (2026 research, confirmed real endpoints + request body shape via official SDK docs).',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.TRACKING, key: 'tiktok.pixel',
    label: 'TikTok Pixel', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'GET /open_api/v1.3/bc/pixel/link/get/ (which accounts an EXISTING pixel is linked to) + POST /open_api/v1.3/bc/pixel/link/update/ (link an existing pixel to the active advertiser account)',
    prerequisites: ['tiktok.advertiserAccount'],
    verification: 'PIXEL CREATION remains unconfirmed (see below) and stays the user\'s responsibility — this is why the type is HYBRID, not API. RE-RESEARCHED during the Completion Pass per explicit instruction to check again: TikTok\'s official js_sdk BCApi.md documents real, confirmed pixel-LINKING endpoints under Business Center scope (bcPixelLinkGet/bcPixelLinkUpdate) that the earlier research pass missed by searching only for a standalone Pixel doc file. Both require an already-known pixel_code as input — neither discovers/creates a pixel from nothing, so creation genuinely remains unconfirmed. What IS now real and implemented: services/adapters/tiktokSetupAdapter.js checkPixelLinkage()/ensurePixelLinked() verify/ensure the user\'s already-created pixel is actually linked to the active advertiser account — a real, API-backed, idempotent piece of the pixel story beyond "send one test event." Wired at GET /api/setup/tiktok/pixel/link/status, POST /api/setup/tiktok/pixel/link. Endpoint/param shapes confirmed via the official SDK\'s BCApi.md; not verified against a real live pixel (no elevated Business Center access in this environment) — covered by mock-API tests.',
    retry: 'ensurePixelLinked() checks existing linkage before ever attempting to link (idempotent, implemented).',
    rollback: 'N/A — linking/unlinking is not a resource-creation operation with data loss risk.',
    humanAction: 'Creating/managing the Pixel itself still happens in TikTok Ads Manager — that specific capability remains unconfirmed via API after two genuine research passes; the user copies the resulting pixel code into ORIVEN for linking and Events API use (see tiktok.eventsApi below).',
    officialFlow: { label: 'Continue to TikTok', urlTemplate: 'https://ads.tiktok.com/help/article/get-started-pixel' },
    docs: 'services/adapters/tiktokSetupAdapter.js checkPixelLinkage()/ensurePixelLinked(); server.js GET/POST /api/setup/tiktok/pixel/link(/status); github.com/tiktok/tiktok-business-api-sdk js_sdk/docs/BCApi.md (2026 research: bcPixelLinkGet/bcPixelLinkUpdate/bcPixelTransfer confirmed real; no create/list-from-scratch endpoint found in the same file\'s 47-method table).',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.CONVERSIONS, key: 'tiktok.eventsApi',
    label: 'Server-side event tracking (Events API)', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'POST /open_api/v1.3/event/track/',
    prerequisites: ['tiktok.pixel'],
    verification: 'services/adapters/tiktokSetupAdapter.js: sendEvent() sends one real server-side event to a pixel code the USER provides (ORIVEN cannot discover a pixel automatically — see tiktok.pixel above), and honestly reports sent:false on any non-zero TikTok response code rather than assuming success. Wired at POST /api/setup/tiktok/test-event. Endpoint confirmed via TikTok\'s own documentation; NOT verified against a real pixel (no elevated TikTok Business Center access in this environment) — covered by mock-API tests plus a real-network test confirming a fake pixel code is honestly rejected.',
    retry: 'N/A — sending is not idempotent by design (each call is a distinct event).',
    rollback: 'N/A — events are not created resources to roll back.',
    humanAction: 'The user must supply their real pixel code (copied from TikTok Ads Manager) since ORIVEN cannot discover it via API.',
    docs: 'services/adapters/tiktokSetupAdapter.js; server.js POST /api/setup/tiktok/test-event; TikTok Events API official docs (2026 research, endpoint confirmed).',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.BILLING, key: 'tiktok.billing',
    label: 'Billing', type: TYPE.HYBRID, implemented: false,
    apiEndpoint: 'GET /open_api/v1.3/bc/balance/get/, GET /open_api/v1.3/advertiser/balance/get/, POST /open_api/v1.3/bc/transfer/',
    verification: 'Not implemented, but genuinely more API-capable than the other 3 platforms: TikTok exposes real balance-read and fund-transfer endpoints (confirmed via official SDK docs) — only the initial payment-method attachment is platform-UI-only.',
    retry: 'Standard re-fetch for balance checks once implemented.',
    rollback: 'Never expose payment details in ORIVEN beyond balance figures; never attempt fund transfers without explicit user action.',
    humanAction: 'Initial payment method must be attached in TikTok Business Center; balance/transfer operations after that are API-capable.',
    officialFlow: { label: 'Continue to TikTok', urlTemplate: 'https://business.tiktok.com/' },
    docs: 'github.com/tiktok/tiktok-business-api-sdk BCApi.md (2026 research).',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.CAMPAIGNS, key: 'tiktok.campaigns',
    label: 'Campaign creation & management', type: TYPE.API, implemented: true,
    apiEndpoint: 'POST /api/publish/tiktok -> campaign/ad group/ad creation',
    prerequisites: ['tiktok.advertiserAccount'],
    verification: 'Real, working publish pipeline with rollback tracking.',
    retry: 'Publish can be retried.',
    rollback: 'Implemented (created = {campaignId, adGroupIds, adIds}).',
    docs: 'server.js:6919 (existing implementation)',
  }),
  cap({
    platform: 'tiktok', category: CATEGORY.REPORTING, key: 'tiktok.reporting',
    label: 'Performance reporting', type: TYPE.API, implemented: true,
    apiEndpoint: '/report/integrated/get/',
    verification: 'Real reporting API integration.',
    retry: 'Standard re-fetch.',
    rollback: 'N/A — read-only.',
    docs: 'server.js:8888-8903 (existing implementation)',
  }),
]);

// ────────────────────────────────────────────────────────────────
// PINTEREST
// ────────────────────────────────────────────────────────────────
const PINTEREST = Object.freeze([
  cap({
    platform: 'pinterest', category: CATEGORY.AUTHENTICATION, key: 'pinterest.auth',
    label: 'Connect your Pinterest account', type: TYPE.API, implemented: true,
    apiEndpoint: 'GET /auth/pinterest/callback (Pinterest OAuth 2.0)',
    requiredScopes: ['ads:read', 'ads:write', 'pins:read', 'pins:write', 'boards:read', 'boards:write'],
    verification: 'A stored, actively-refreshed access_token exists (provider=pinterest_ads) — the most complete refresh-token implementation of the 4 platforms (real 60-day rolling refresh).',
    retry: 'Refresh handled automatically; full re-OAuth only if refresh_token itself is absent/invalid.',
    rollback: 'N/A — OAuth is atomic.',
    docs: 'server.js:10678-10881, 11048-11095 (existing implementation)',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.BUSINESS, key: 'pinterest.businessAccess',
    label: 'Pinterest Business Access', type: TYPE.MANUAL, implemented: false,
    verification: 'Not implemented — no code checks or stores Business Access verification state.',
    retry: 'N/A.',
    rollback: 'N/A.',
    humanAction: 'A Pinterest Business account with Business Access enabled is a prerequisite for any advertising API use.',
    officialFlow: { label: 'Continue to Pinterest', urlTemplate: 'https://www.pinterest.com/business/create/' },
    docs: 'developers.pinterest.com/docs/work-with-ads (2026 research).',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.AD_ACCOUNT, key: 'pinterest.firstAdAccount',
    label: 'First ad account', type: TYPE.API_GATED, implemented: true,
    apiEndpoint: 'POST /ad_accounts — requires {country, name, owner_user_id}',
    requiredScopes: ['user_accounts:read', 'ads:write'],
    prerequisites: ['pinterest.businessAccess'],
    verification: 'RE-RESEARCHED and CORRECTED during the Completion Pass, per explicit instruction to re-check: Pinterest\'s own generated OpenAPI client (AdAccountsApi.md, AdAccountCreateRequest.md) documents a real POST /ad_accounts endpoint with no "first account only via UI" restriction in the API contract itself — Pinterest\'s help-center guidance steering first-time advertisers to pinterest.com/business/create is onboarding UX advice, not a documented hard technical gate. services/adapters/pinterestSetupAdapter.js ensureAdAccount() now attempts real API creation (idempotent — reuses any existing account, never duplicates); if Pinterest itself rejects the call for a reason this codebase cannot resolve, that real rejection propagates honestly and the UI falls back to the officialFlow button — this never assumes success and never claims the API path is unconditionally guaranteed to work for every account. Required a new OAuth scope (user_accounts:read, to resolve owner_user_id via GET /user_account) added this pass; a token stored before the scope rollout gets an honest PERMISSION_REQUIRED (reconnect), never a silent failure. Wired at POST /api/setup/pinterest/ad-account, lock-guarded against a double-click/two-tab race. Not verified against a real live Pinterest Business Account (no elevated Standard Access confirmed in this environment) — covered by mock-API tests.',
    retry: 'Checks for an existing ad account before ever attempting creation (idempotent, implemented).',
    rollback: 'Never delete a real ad account on later-step failure.',
    humanAction: 'A Pinterest Business Account must already exist (pinterest.businessAccess, still MANUAL); if the API rejects creation for any reason, the officialFlow fallback (pinterest.com/business/create) remains the safety net.',
    officialFlow: { label: 'Continue to Pinterest', urlTemplate: 'https://www.pinterest.com/business/create/' },
    docs: 'services/adapters/pinterestSetupAdapter.js ensureAdAccount(); server.js POST /api/setup/pinterest/ad-account, GET /user_account (_fetchPinterestUserAccount); github.com/pinterest/pinterest-python-generated-api-client AdAccountsApi.md + AdAccountCreateRequest.md (2026 research, endpoint + required fields confirmed via Pinterest\'s own generated OpenAPI client).',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.AD_ACCOUNT, key: 'pinterest.additionalAdAccount',
    label: 'Additional ad account (after the first exists)', type: TYPE.API, implemented: true,
    verification: 'Once an ad account exists, ORIVEN discovers and selects it via _fetchPinterestAdAccounts / active-account — real, working today.',
    retry: 'Re-fetch via GET /api/pinterest/accounts.',
    rollback: 'N/A — discovery only.',
    docs: 'server.js:10748, 10915-10953 (existing implementation)',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.TRACKING, key: 'pinterest.tag',
    label: 'Pinterest Tag', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'GET/POST /ad_accounts/{ad_account_id}/conversion_tags',
    prerequisites: ['pinterest.firstAdAccount'],
    verification: 'services/adapters/pinterestSetupAdapter.js: ensureTag() reuses an existing tag (idempotent) or creates + verifies one via a follow-up GET, with enhanced-match left OFF by default (a distinct opt-in, never silently enabled); checkTagHealth() distinguishes exists / receivingEvents / lastReceivedAt. Wired at POST/GET /api/setup/pinterest/tag(/health). Endpoint-correctness verified against Pinterest\'s own generated OpenAPI client docs; creation NOT verified against a real live ad account (no elevated Pinterest Standard Access confirmed in this environment) — covered by mock-API tests instead. Correct term "Pinterest Tag" used throughout — never "Pinterest Pixel".',
    retry: 'Checks for an existing Tag on the ad account before creating (implemented).',
    rollback: 'N/A for reuse; no delete path implemented.',
    humanAction: 'Base code must be installed on the website; event code configured per conversion action.',
    docs: 'services/adapters/pinterestSetupAdapter.js; server.js POST /api/setup/pinterest/tag; github.com/pinterest/pinterest-python-generated-api-client ConversionTagsApi.md (2026 research, endpoint confirmed via Pinterest\'s own generated client).',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.CONVERSIONS, key: 'pinterest.conversionsApi',
    label: 'Server-side conversion tracking (Conversions API)', type: TYPE.HYBRID, implemented: true,
    apiEndpoint: 'POST /ad_accounts/{ad_account_id}/events',
    prerequisites: ['pinterest.tag'],
    verification: 'services/adapters/pinterestSetupAdapter.js: sendConversionEvents() sends real server-side event(s) and reports success ONLY from num_events_processed > 0 in Pinterest\'s response (ConversionApiResponse) — never assumed from HTTP 200. A SEPARATE system from the Pinterest Tag (pinterest.tag) — Pinterest recommends using both together for full event coverage, and this adapter never conflates them. Wired at POST /api/setup/pinterest/events, retried on transient failure via services/setupErrors.js; supports Pinterest\'s own `test: true` validation mode (used by ORIVEN\'s "send test event" UI action by default, so a click never records a fake real event). Field names (event_name, action_source, event_time, event_id, user_data, custom_data) and response shape (num_events_received, num_events_processed, events) confirmed against Pinterest\'s own generated OpenAPI client (ConversionEventsApi.md, ConversionApiResponse.md); not verified against a real live ad account (no elevated Standard Access confirmed in this environment) — covered by mock-API tests.',
    retry: 'Automatic bounded retry on RATE_LIMITED/PLATFORM_UNAVAILABLE only (services/setupErrors.js withPlatformRetry) — never retried on a real rejection.',
    rollback: 'N/A — events are not created resources to roll back.',
    humanAction: 'A real, ongoing server-side event stream is what makes this actually useful — ORIVEN\'s one test-event send proves the pipe works, it does not by itself mean production events are flowing continuously.',
    docs: 'services/adapters/pinterestSetupAdapter.js sendConversionEvents(); server.js POST /api/setup/pinterest/events; github.com/pinterest/pinterest-python-generated-api-client ConversionEventsApi.md + ConversionApiResponse.md (2026 research, endpoint + request/response fields confirmed).',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.BILLING, key: 'pinterest.billing',
    label: 'Billing', type: TYPE.MANUAL, implemented: false,
    verification: 'Not implemented.',
    retry: 'N/A.',
    rollback: 'N/A — never store payment credentials in ORIVEN.',
    humanAction: 'Billing must be completed on Pinterest before the ad account can spend.',
    officialFlow: { label: 'Complete in Pinterest', urlTemplate: 'https://ads.pinterest.com/' },
    docs: 'Pinterest requires billing setup in-product; no API for adding a funding source.',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.AUDIENCES, key: 'pinterest.audiences',
    label: 'Audiences', type: TYPE.API, implemented: false,
    verification: 'Not implemented — no audience creation/management code exists for Pinterest yet.',
    retry: 'Standard.',
    rollback: 'Do not delete a real audience with existing membership.',
    humanAction: 'Respect Pinterest\'s minimum audience size when implemented — never create below the platform-allowed minimum.',
    docs: 'developers.pinterest.com/docs/api/v5 (2026 research).',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.CAMPAIGNS, key: 'pinterest.campaigns',
    label: 'Campaign, ad group & ad-only Pin creation', type: TYPE.API, implemented: true,
    apiEndpoint: 'POST /api/publish/pinterest -> campaign -> board -> Pin -> ad group -> ad',
    prerequisites: ['pinterest.firstAdAccount'],
    verification: 'Real, working publish pipeline (the most recently built and most thoroughly tested integration in the app) with archive-based rollback (Pinterest has no hard delete for campaigns/ad groups/ads).',
    retry: 'Publish can be retried.',
    rollback: 'Implemented: ads -> ad groups -> campaign archived, real Pins deleted, in that order (server.js:11547-11552, 11745-11768).',
    docs: 'server.js:11554-11772 (existing implementation); tests/pinterest-ads.test.js, tests/pinterest-launch.test.js',
  }),
  cap({
    platform: 'pinterest', category: CATEGORY.REPORTING, key: 'pinterest.reporting',
    label: 'Performance reporting', type: TYPE.API, implemented: true,
    verification: 'Real reporting integration.',
    retry: 'Standard re-fetch.',
    rollback: 'N/A — read-only.',
    docs: 'server.js:11395 (GET /api/pinterest/overview)',
  }),
]);

const PLATFORM_CAPABILITIES = Object.freeze({
  meta: META,
  google: GOOGLE,
  tiktok: TIKTOK,
  pinterest: PINTEREST,
});

const PLATFORMS = Object.freeze(['meta', 'google', 'tiktok', 'pinterest']);

function getCapabilities(platform) {
  return PLATFORM_CAPABILITIES[platform] || [];
}

function getCapability(platform, key) {
  return getCapabilities(platform).find((c) => c.key === key) || null;
}

module.exports = {
  TYPE,
  CATEGORY,
  PLATFORMS,
  PLATFORM_CAPABILITIES,
  getCapabilities,
  getCapability,
};
