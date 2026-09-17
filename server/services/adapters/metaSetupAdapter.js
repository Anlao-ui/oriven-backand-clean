// ════════════════════════════════════════════════════════════════
// Meta Setup Adapter — Phase 3
//
// Pure logic module: every function takes an `apiClient` — a tiny
// { get(path, params), post(path, params) } pair already bound to a
// specific access token — rather than owning its own HTTP/fetch
// code. server.js wires in the EXISTING, already-battle-tested
// _metaFetch/_metaApiPost helpers (error classification, retry
// semantics already live there — not duplicated here); tests wire in
// a mock client. This is what "reuse the existing platform client"
// means concretely for a module that can't literally require()
// functions out of the server.js monolith.
//
// Endpoints used (verified against developers.facebook.com,
// 2026-08 research — see platformCapabilities.js for full citations):
//   GET  /{ad_account_id}/adspixels             — discover existing pixels (already reused, see server.js _metaFetch call in /api/publish/meta)
//   POST /{ad_account_id}/adspixels              — create a pixel (name required)
//   GET  /{pixel_id}?fields=last_fired_time,has_1p_pixel_event — pixel health
//   POST /{pixel_id}/events                      — Conversions API: send server-side events (Completion Pass — new)
//
// CONVERSIONS API IS A SEPARATE STATE FROM "PIXEL EXISTS": a pixel
// object existing (ensurePixel above) proves nothing about whether
// server-side events are actually being sent to it. sendServerEvent()
// below is that distinct capability — it uses the SAME pixel/dataset
// ID (Meta's Conversions API sends to the Pixel's own ID, there is no
// separate "dataset id" concept for a standard web Pixel), but success
// here (events_received > 0) is a different, additional signal from
// checkPixelHealth()'s receivingEvents (which only reflects browser-
// side firing) — never collapsed together.
// ════════════════════════════════════════════════════════════════

/**
 * Discovers Business Manager(s) the authenticated user already has
 * access to. Read-only, unconditional — GET /me/businesses carries no
 * eligibility gate. Creating a NEW Business Manager (POST
 * /{business_id}/businesses) is deliberately NOT implemented here:
 * that endpoint requires an EXISTING business_id in its own URL path
 * (confirmed via developers.facebook.com/docs/business-management-apis),
 * meaning it creates a client/sub-business under a Business Manager
 * the caller already owns — structurally, it cannot create a user's
 * VERY FIRST Business Manager, which is the case that matters for
 * ORIVEN's onboarding flow. That first Business Manager remains a
 * platform-UI-only step (see officialFlow in platformCapabilities.js).
 */
async function findExistingBusinesses(apiClient) {
  const data = await apiClient.get('/me/businesses', { fields: 'id,name,verification_status' });
  return ((data && data.data) || []).map((b) => ({ id: b.id, name: b.name, verificationStatus: b.verification_status || null }));
}

async function findExistingPixel(apiClient, adAccountId) {
  const data = await apiClient.get('/' + adAccountId + '/adspixels', { fields: 'id,name,last_fired_time' });
  const list = (data && data.data) || [];
  return list.length ? list[0] : null;
}

/**
 * Idempotent: reuses an existing pixel on the ad account rather than
 * ever creating a duplicate, per spec section 61 (retry/idempotency).
 */
async function ensurePixel(apiClient, adAccountId, name) {
  const existing = await findExistingPixel(apiClient, adAccountId);
  if (existing) return { created: false, pixel: existing };
  const result = await apiClient.post('/' + adAccountId + '/adspixels', { name: name || 'ORIVEN Pixel' });
  if (!result || !result.id) {
    const e = new Error('Meta did not return a pixel id after creation'); e.status = 502; throw e;
  }
  // Verify the resulting object, per spec section "verify after every
  // mutation" — never assume success just because the POST returned 200.
  const verified = await apiClient.get('/' + result.id, { fields: 'id,name' });
  if (!verified || !verified.id) {
    const e = new Error('Meta pixel creation could not be verified'); e.status = 502; throw e;
  }
  return { created: true, pixel: { id: verified.id, name: verified.name } };
}

/**
 * Distinguishes EXISTS from INSTALLED from RECEIVING EVENTS — spec
 * section "META TRACKING" is explicit that these are not the same
 * thing and must never be collapsed into one boolean.
 */
async function checkPixelHealth(apiClient, pixelId) {
  const data = await apiClient.get('/' + pixelId, { fields: 'id,name,last_fired_time,has_1p_pixel_event' });
  if (!data || !data.id) {
    return { exists: false, installed: false, receivingEvents: false, lastFiredAt: null };
  }
  return {
    exists: true,
    // "Installed" here means "has fired at least once, ever" — the
    // closest honest proxy available from this endpoint. This is NOT
    // the same claim as "actively receiving events now" (that needs a
    // recency check the UI layer applies to lastFiredAt).
    installed: !!data.last_fired_time,
    receivingEvents: !!data.has_1p_pixel_event,
    lastFiredAt: data.last_fired_time || null,
  };
}

/**
 * Meta's own account_status/disable_reason check — mirrors the logic
 * already live inline in /api/publish/meta (_verifyMetaAdAccountWritable)
 * but exposed here as a reusable, independently-callable verification
 * step for the setup engine (spec: "does account have restrictions").
 */
async function checkAdAccountStatus(apiClient, adAccountId) {
  const data = await apiClient.get('/' + adAccountId, { fields: 'account_status,disable_reason' });
  return {
    exists: !!(data && data.account_status !== undefined),
    active: !!(data && data.account_status === 1),
    disableReason: (data && data.disable_reason) || null,
  };
}

/**
 * Sends one or more server-side conversion events via Meta's
 * Conversions API to an existing pixel. `events` is an array of
 * { eventName, eventTime, actionSource, userData, customData, eventId }
 * — field names confirmed against Meta's official server-event
 * parameter reference. `testEventCode` (optional, from Meta's Test
 * Events tool) lets ORIVEN's own "send test event" action validate
 * delivery without affecting real ad optimization. Honestly reports
 * events_received — never assumes success from HTTP 200 alone (a
 * malformed event can still return 200 with events_received: 0 or a
 * per-event error in `messages`).
 */
async function sendServerEvent(apiClient, pixelId, events, testEventCode) {
  if (!Array.isArray(events) || !events.length) { const e = new Error('At least one event is required.'); e.status = 400; throw e; }
  const data = events.map((ev) => ({
    event_name: ev.eventName,
    event_time: ev.eventTime || Math.floor(Date.now() / 1000),
    action_source: ev.actionSource || 'website',
    event_id: ev.eventId,
    event_source_url: ev.eventSourceUrl,
    user_data: ev.userData || {},
    custom_data: ev.customData || {},
  }));
  const body = { data: JSON.stringify(data) };
  if (testEventCode) body.test_event_code = testEventCode;
  const result = await apiClient.post('/' + pixelId + '/events', body);
  const eventsReceived = (result && result.events_received) || 0;
  return { sent: eventsReceived > 0, eventsReceived, fbtraceId: (result && result.fbtrace_id) || null, messages: (result && result.messages) || [], raw: result };
}

module.exports = { findExistingBusinesses, findExistingPixel, ensurePixel, checkPixelHealth, checkAdAccountStatus, sendServerEvent };
