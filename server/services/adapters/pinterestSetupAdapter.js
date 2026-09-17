// ════════════════════════════════════════════════════════════════
// Pinterest Setup Adapter — Phase 6, extended in the Completion Pass
//
// Pure logic module: takes an `apiClient` — { get(path, params),
// post(path, body) } already bound to a specific access token —
// rather than owning its own HTTP code. server.js wires in a thin
// wrapper around the EXISTING _pinterestApiRequest helper; tests
// wire in a mock client.
//
// Endpoints used (verified against Pinterest's own generated OpenAPI
// client docs, 2026-08 research):
//   GET  /ad_accounts/{ad_account_id}/conversion_tags        — discover existing tags
//   POST /ad_accounts/{ad_account_id}/conversion_tags        — create a tag
//   POST /ad_accounts/{ad_account_id}/events                 — Conversions API: send server-side events (Completion Pass — new)
//   POST /ad_accounts                                        — create an ad account (Completion Pass — new; see ensureAdAccount)
//
// Terminology: this is the "Pinterest Tag" — NEVER "Pinterest Pixel"
// in any user-facing string this adapter's callers produce. The
// Conversions API is a SEPARATE system from the Tag — Pinterest
// explicitly recommends using both together for full event coverage;
// neither replaces the other, and this adapter never conflates them.
// ════════════════════════════════════════════════════════════════

async function findExistingTag(apiClient, adAccountId) {
  const data = await apiClient.get('/ad_accounts/' + adAccountId + '/conversion_tags', {});
  const list = (data && data.items) || [];
  return list.length ? list[0] : null;
}

/**
 * Idempotent: reuses an existing Pinterest Tag on the ad account
 * rather than ever creating a duplicate.
 */
async function ensureTag(apiClient, adAccountId, name) {
  const existing = await findExistingTag(apiClient, adAccountId);
  if (existing) return { created: false, tag: existing };
  const result = await apiClient.post('/ad_accounts/' + adAccountId + '/conversion_tags', {
    name: name || 'ORIVEN Tag',
    enhanced_match_status: 'DISABLED', // conservative default; enhanced match is a distinct opt-in the user should choose explicitly, not something ORIVEN silently turns on
    aem_enablement_status: 'OPTED_OUT',
  });
  if (!result || !result.id) {
    const e = new Error('Pinterest did not return a tag id after creation'); e.status = 502; throw e;
  }
  const verified = await findExistingTag(apiClient, adAccountId);
  if (!verified) {
    const e = new Error('Created Pinterest Tag could not be verified'); e.status = 502; throw e;
  }
  return { created: true, tag: verified };
}

/**
 * Distinguishes EXISTS from a real health signal Pinterest exposes
 * (last_receive_time / status) — never collapsed into a single
 * "tracking connected" boolean per spec section 47/72.
 */
async function checkTagHealth(apiClient, adAccountId) {
  const tag = await findExistingTag(apiClient, adAccountId);
  if (!tag) return { exists: false, receivingEvents: false, lastReceivedAt: null, status: null };
  return {
    exists: true,
    status: tag.status || null,
    receivingEvents: tag.status === 'ACTIVE' || !!tag.last_receive_time,
    lastReceivedAt: tag.last_receive_time || null,
  };
}

/**
 * Sends one or more server-side conversion events (Pinterest
 * Conversions API — distinct from the Tag above). `events` is an
 * array of { eventName, actionSource, eventTime, eventId, eventSourceUrl,
 * userData, customData } — field names confirmed against Pinterest's
 * own ConversionEventsApi/ConversionApiResponse generated docs.
 * `test: true` validates the request without recording real events
 * (used by ORIVEN's own "send test event" UI action, mirroring the
 * pattern already used for TikTok's Events API test-event route).
 * Honestly reports how many of the events Pinterest actually
 * processed — never assumes success from a 200 alone.
 */
async function sendConversionEvents(apiClient, adAccountId, events, test) {
  if (!Array.isArray(events) || !events.length) { const e = new Error('At least one event is required.'); e.status = 400; throw e; }
  const data = events.map((ev) => ({
    event_name: ev.eventName,
    action_source: ev.actionSource || 'web',
    event_time: ev.eventTime || Math.floor(Date.now() / 1000),
    event_id: ev.eventId,
    event_source_url: ev.eventSourceUrl,
    opt_out: !!ev.optOut,
    user_data: ev.userData || {},
    custom_data: ev.customData || {},
  }));
  const result = await apiClient.post('/ad_accounts/' + adAccountId + '/events', { data, test: !!test });
  const processed = (result && result.num_events_processed) || 0;
  const received = (result && result.num_events_received) || 0;
  return { sent: processed > 0, processed, received, events: (result && result.events) || [], raw: result };
}

/**
 * Idempotent: reuses an existing ad account discovered via the
 * caller-injected `listAccounts` (the same function server.js already
 * uses for account discovery elsewhere) rather than ever creating a
 * duplicate. Requires `ownerUserId` (from GET /user_account, scope
 * user_accounts:read) — a real, confirmed prerequisite this adapter
 * does not attempt to work around.
 *
 * Pinterest's own help-center guidance steers first-time advertisers
 * toward pinterest.com/business/create in the product UI, but the
 * official v5 API (per Pinterest's own generated OpenAPI client,
 * AdAccountsApi.md) exposes POST /ad_accounts unconditionally once a
 * Business Account exists — no documented "first account only via UI"
 * restriction in the API contract itself. Rather than assume the
 * help-center guidance is a hard technical gate, this attempts the
 * real API call; if Pinterest rejects it for a reason this codebase
 * cannot resolve (e.g. a business-account prerequisite not yet met),
 * that real rejection propagates honestly and the caller falls back
 * to the manual officialFlow — this function never fakes success.
 */
async function ensureAdAccount(apiClient, listAccounts, ownerUserId, { name, country }) {
  if (!ownerUserId) { const e = new Error('Your Pinterest user account could not be identified — reconnect Pinterest Ads to grant the required permission.'); e.status = 400; throw e; }
  if (!name || !country) { const e = new Error('An account name and country are required.'); e.status = 400; throw e; }
  const before = await listAccounts();
  if (before && before.accounts && before.accounts.length) return { created: false, accounts: before.accounts };

  const result = await apiClient.post('/ad_accounts', { name, country, owner_user_id: ownerUserId });
  if (!result || !result.id) {
    const e = new Error('Pinterest did not return an ad account id after creation'); e.status = 502; throw e;
  }
  const after = await listAccounts();
  if (!after || !after.accounts || !after.accounts.some((a) => String(a.id) === String(result.id))) {
    const e = new Error('Pinterest ad account creation could not be verified'); e.status = 502; throw e;
  }
  return { created: true, accounts: after.accounts };
}

module.exports = { findExistingTag, ensureTag, checkTagHealth, sendConversionEvents, ensureAdAccount };
