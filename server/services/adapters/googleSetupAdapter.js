// ════════════════════════════════════════════════════════════════
// Google Ads Setup Adapter — Phase 4
//
// Pure logic module: takes a `gadsClient` — { query(gaql), mutate
// (resource, operations) } already bound to a specific access token +
// customer ID + login-customer-id — rather than owning HTTP/auth code
// itself. server.js wires in the EXISTING _gadsQuery/_gadsMutate
// helpers (which already handle developer-token headers, MCC
// login-customer-id logic, and error classification); tests wire in
// a mock client.
//
// Endpoints/resources used (verified against developers.google.com,
// 2026-08 research):
//   ConversionActionService.MutateConversionActions — create
//   GAQL `SELECT conversion_action... FROM conversion_action`  — read/verify
//
// Deliberately does NOT touch primary_for_goal or any existing
// CustomerConversionGoal on an already-existing conversion action —
// spec section "GOOGLE CONVERSION SETUP" / "27. GOOGLE CONVERSION
// GOALS" is explicit that the engine must not randomly alter live
// bidding/goal configuration.
// ════════════════════════════════════════════════════════════════

async function findExistingConversionAction(gadsClient, name) {
  const rows = await gadsClient.query(
    `SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name,
            conversion_action.status, conversion_action.category, conversion_action.origin
     FROM conversion_action
     WHERE conversion_action.name = '${String(name).replace(/'/g, "\\'")}'`
  );
  return (rows && rows.length) ? rows[0].conversionAction : null;
}

/**
 * Idempotent: reuses an existing conversion action with the same name
 * rather than creating a duplicate. Google itself auto-creates the
 * matching CustomerConversionGoal for a NEW action's category+origin
 * (documented behavior) — this function never touches goal config on
 * an EXISTING action, only creates a fresh one when none exists.
 */
async function ensureConversionAction(gadsClient, { name, category, type }) {
  const existing = await findExistingConversionAction(gadsClient, name);
  if (existing) return { created: false, conversionAction: existing };

  const operations = [{
    create: {
      name,
      category: category || 'DEFAULT',
      type: type || 'WEBPAGE',
      status: 'ENABLED',
    },
  }];
  const result = await gadsClient.mutate('conversionActions', operations);
  const resourceName = result && result.results && result.results[0] && result.results[0].resourceName;
  if (!resourceName) {
    const e = new Error('Google did not return a conversion action resource name after creation'); e.status = 502; throw e;
  }
  // Verify the resulting object rather than trusting the mutate response alone.
  const verified = await findExistingConversionAction(gadsClient, name);
  if (!verified) {
    const e = new Error('Created conversion action could not be verified'); e.status = 502; throw e;
  }
  return { created: true, conversionAction: verified };
}

async function checkConversionActionStatus(gadsClient, name) {
  const action = await findExistingConversionAction(gadsClient, name);
  if (!action) return { exists: false, enabled: false, status: null };
  return { exists: true, enabled: action.status === 'ENABLED', status: action.status };
}

/**
 * Retrieves the real website tag snippet(s) (global_site_tag +
 * event_snippet) Google generates for a conversion action — confirmed
 * via developers.google.com's ConversionAction field reference:
 * `tag_snippets` is a real, read-only field, but it is NOT populated
 * on the object returned by the create mutation itself — it must be
 * fetched via a separate follow-up query. This is what
 * platformCapabilities.js calls google.tag: ORIVEN retrieves and
 * displays the REAL snippet (the API-doable part); actually installing
 * it on the website remains the user's action (the HYBRID part) —
 * ORIVEN does not claim to have installed anything.
 */
async function fetchTagSnippets(gadsClient, name) {
  const rows = await gadsClient.query(
    `SELECT conversion_action.id, conversion_action.tag_snippets
     FROM conversion_action
     WHERE conversion_action.name = '${String(name).replace(/'/g, "\\'")}'`
  );
  const action = rows && rows.length && rows[0].conversionAction;
  if (!action) return { exists: false, snippets: [] };
  const snippets = (action.tagSnippets || action.tag_snippets || []).map((s) => ({
    type: s.type,
    pageFormat: s.pageFormat || s.page_format,
    globalSiteTag: s.globalSiteTag || s.global_site_tag || null,
    eventSnippet: s.eventSnippet || s.event_snippet || null,
  }));
  return { exists: true, snippets };
}

/**
 * Real remote verification of the active customer account itself
 * (Completion Pass — "checkGoogleSetup must evolve beyond stored
 * data"). `customer.status` is a real, standard field
 * (developers.google.com/google-ads/api/fields — ENABLED, CANCELED,
 * SUSPENDED, CLOSED); a live API call here also incidentally proves
 * the stored access/refresh token still actually works, not just that
 * it hasn't expired by our own clock.
 */
async function checkCustomerStatus(gadsClient) {
  const rows = await gadsClient.query('SELECT customer.id, customer.status, customer.manager FROM customer LIMIT 1');
  const customer = rows && rows.length && rows[0].customer;
  if (!customer) return { exists: false, active: false, status: null };
  return { exists: true, active: customer.status === 'ENABLED', status: customer.status, isManager: !!customer.manager };
}

module.exports = { findExistingConversionAction, ensureConversionAction, checkConversionActionStatus, fetchTagSnippets, checkCustomerStatus };
