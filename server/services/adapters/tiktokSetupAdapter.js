// ════════════════════════════════════════════════════════════════
// TikTok Setup Adapter — Phase 5, extended in the Completion Pass
//
// PIXEL CREATION remains an honest gap: multiple research passes
// (public search, TikTok's own official js_sdk GitHub repo docs
// directory, the Postman-hosted "TikTok Business API V1.3"
// collection) could NOT confirm an official Pixel CREATE/LIST
// endpoint with the confidence Meta/Google/Pinterest's tracking
// endpoints were confirmed with. Per the mandatory research rule
// ("if uncertain, classify as C, do not fake A"), Pixel creation is
// still NOT implemented — the user must create the Pixel itself in
// TikTok Ads Manager (platformCapabilities.js: still MANUAL).
//
// RE-RESEARCHED during the Completion Pass, per the explicit
// instruction to check again: TikTok's official js_sdk BCApi.md DOES
// document three real, confirmed Pixel-related endpoints living under
// Business Center scope (a detail the earlier pass, which searched
// for a standalone Pixel doc file, missed):
//   GET  /open_api/v1.3/bc/pixel/link/get/    — list ad accounts an
//        EXISTING pixel (identified by pixel_code) is linked to
//   POST /open_api/v1.3/bc/pixel/link/update/ — link/unlink an
//        EXISTING pixel to/from advertiser accounts
// Both require an already-known pixel_code as input — neither
// discovers or creates a pixel from nothing, so they do NOT overturn
// the MANUAL classification for pixel CREATION. What they DO enable,
// genuinely new this pass: ORIVEN can verify/ensure the user's
// already-created pixel is actually LINKED to the active advertiser
// account — a real, API-backed piece of the pixel setup story beyond
// "send one test event." This is why tiktok.pixel is now HYBRID
// (ORIVEN: linkage read+ensure; user: pixel creation) rather than
// pure MANUAL.
//
// Also newly wired this pass — the HIGH PRIORITY completion target:
//   GET  /open_api/v1.3/bc/get/              — discover Business
//        Centers the authenticated user has access to (no create API
//        exists for the BC itself — confirmed absent from BCApi.md's
//        47-method table; BC creation stays MANUAL)
//   POST /open_api/v1.3/bc/advertiser/create/ — create an advertiser
//        (ad) account under an existing, already-discovered BC
//
// Response field names for bcAdvertiserCreate are NOT documented with
// a JSON example anywhere in the official SDK docs (the generated
// docs only show the generic InlineResponse200 envelope) — rather
// than guess a field name and risk silently trusting an absent value,
// ensureAdvertiserAccount() verifies success ENTIRELY via a follow-up
// call to the caller-supplied `listAdvertisers` function (the same,
// already-working discovery path _fetchTikTokAdvertisers already
// uses elsewhere in this codebase), exactly like every other
// adapter's "verify after mutation" rule.
//
//   POST /open_api/v1.3/event/track/          — send one server-side
//        event to an existing pixel (unchanged from Phase 5)
// ════════════════════════════════════════════════════════════════

/**
 * Sends one server-side event to an existing TikTok pixel. Does NOT
 * create, discover, or verify the pixel itself — that capability is
 * unconfirmed (see header). The caller is responsible for having a
 * real pixel_id (today: user-provided, copied from TikTok Ads
 * Manager). NOT idempotent by design — every call is a distinct event.
 */
async function sendEvent(apiClient, { pixelCode, event, eventId, context }) {
  if (!pixelCode) { const e = new Error('A TikTok pixel code is required — ORIVEN cannot discover one automatically yet.'); e.status = 400; throw e; }
  const result = await apiClient.post('/event/track/', {
    pixel_code: pixelCode,
    event,
    event_id: eventId,
    context: context || {},
  });
  return { sent: !!(result && result.code === 0), raw: result };
}

/** Business Centers the authenticated user has access to. Read-only discovery — no creation API exists for the BC resource itself. */
async function findBusinessCenters(apiClient) {
  const data = await apiClient.get('/bc/get/', {});
  const list = (data && data.list) || [];
  return list.map((bc) => ({ bcId: String(bc.bc_id), name: bc.name || bc.bc_id, role: bc.role || null }));
}

/**
 * Idempotent: reuses an existing advertiser account under this BC
 * (discovered via the caller-injected `listAdvertisers` — the same
 * function server.js already uses for account discovery elsewhere)
 * rather than ever creating a duplicate. `advertiserInfo` is the
 * user-supplied {name, currency, timezone} — all officially optional
 * per AdvertiserCreateBody, but `name` is required by ORIVEN for a
 * usable account.
 */
async function ensureAdvertiserAccount(apiClient, listAdvertisers, bcId, advertiserInfo) {
  if (!bcId) { const e = new Error('A TikTok Business Center is required before an advertiser account can be created.'); e.status = 400; throw e; }
  if (!advertiserInfo || !advertiserInfo.name) { const e = new Error('An account name is required.'); e.status = 400; throw e; }
  const before = await listAdvertisers();
  if (before && before.length) return { created: false, advertisers: before };

  await apiClient.post('/bc/advertiser/create/', {
    bc_id: bcId,
    advertiser_info: {
      name: advertiserInfo.name,
      currency: advertiserInfo.currency,
      timezone: advertiserInfo.timezone,
    },
    customer_info: {
      company: advertiserInfo.company || advertiserInfo.name,
    },
  });
  // Response field names for a newly-created advertiser are not
  // reliably documented (see header) — verify entirely via a real
  // follow-up discovery call rather than trusting any field on the
  // create response itself.
  const after = await listAdvertisers();
  if (!after || !after.length) {
    const e = new Error('TikTok accepted the advertiser account request but it could not be verified yet — this can take a few minutes; check back shortly.');
    e.status = 202; throw e;
  }
  return { created: true, advertisers: after };
}

/** Which advertiser accounts an EXISTING pixel (by pixel_code) is currently linked to. */
async function checkPixelLinkage(apiClient, bcId, pixelCode) {
  if (!bcId || !pixelCode) return { linked: false, advertiserIds: [] };
  const data = await apiClient.get('/bc/pixel/link/get/', { bc_id: bcId, pixel_code: pixelCode });
  const list = (data && data.list) || (data && data.advertiser_ids) || [];
  const advertiserIds = list.map((x) => String((x && x.advertiser_id) || x));
  return { linked: advertiserIds.length > 0, advertiserIds };
}

/**
 * Idempotent: links an existing, user-supplied pixel to the active
 * advertiser account, but only if it isn't linked there already
 * (checked via checkPixelLinkage first). Never creates a pixel —
 * that capability is unconfirmed (see header).
 */
async function ensurePixelLinked(apiClient, bcId, pixelCode, advertiserId) {
  if (!bcId || !pixelCode || !advertiserId) { const e = new Error('Business Center, pixel code, and advertiser account are all required to link a pixel.'); e.status = 400; throw e; }
  const before = await checkPixelLinkage(apiClient, bcId, pixelCode);
  if (before.advertiserIds.includes(String(advertiserId))) return { linked: false, alreadyLinked: true, advertiserIds: before.advertiserIds };
  await apiClient.post('/bc/pixel/link/update/', {
    bc_id: bcId,
    pixel_code: pixelCode,
    advertiser_ids: [String(advertiserId)],
    link_action: 'LINK',
  });
  const after = await checkPixelLinkage(apiClient, bcId, pixelCode);
  if (!after.advertiserIds.includes(String(advertiserId))) {
    const e = new Error('TikTok did not confirm the pixel link — please verify it directly in TikTok Ads Manager.'); e.status = 502; throw e;
  }
  return { linked: true, alreadyLinked: false, advertiserIds: after.advertiserIds };
}

module.exports = { sendEvent, findBusinessCenters, ensureAdvertiserAccount, checkPixelLinkage, ensurePixelLinked };
