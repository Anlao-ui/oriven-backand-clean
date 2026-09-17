// ════════════════════════════════════════════════════════════════
// Universal Advertising Setup Engine — Phase 2: Setup State Model
//
// Turns a user's REAL, ALREADY-STORED connection state (the same
// `integrations` table every platform's OAuth flow already writes to
// — server.js:9723-9734 Meta, 7497-7507 Google, 8599-8611 TikTok,
// 10835-10844 Pinterest) into an explicit, honest readiness state.
//
// Hard constraints this file honors (do not weaken these later
// without re-reading spec sections 2/53/60/74):
//
//   1. NO new external API calls. Every check function only reads
//      the `integrations` row(s) other, already-existing code paths
//      already populated. This makes these functions safe to call as
//      often as needed with zero rate-limit/quota risk.
//
//   2. "Connected" and "Ready" are different things (spec section
//      53). `connected` means: a valid, unexpired token exists.
//      `ready` means: the real, current minimum bar this codebase's
//      own /api/publish/<platform> routes actually require to
//      publish a campaign successfully is met (auth + account +
//      whatever platform-specific asset that platform's publish
//      route genuinely needs, e.g. Meta requires a selected Page).
//      `ready` is NOT the same as "every capability in
//      platformCapabilities.js is implemented and verified" — most
//      of them (tracking, billing, conversions, verification) are
//      NOT implemented anywhere in this codebase yet. See point 3.
//
//   3. Capabilities this codebase does not yet verify (tracking,
//      conversions, billing, verification — for every platform) are
//      reported with an explicit `NOT_VERIFIED_BY_ORIVEN` status,
//      never silently assumed to pass and never used to permanently
//      block `ready`. The platform's own API already enforces most
//      of these at publish time today (e.g. Meta's own
//      account_status/disable_reason check inside /api/publish/meta)
//      — this engine is additive visibility, not a new gate.
//      Marking these true without real verification, or blocking
//      `ready` on a check this codebase cannot actually perform,
//      would both violate spec section 2 ("never fake") in opposite
//      directions.
// ════════════════════════════════════════════════════════════════

const { PLATFORMS, getCapabilities } = require('./platformCapabilities');

// Full state vocabulary (spec section 10) plus one phase-honest
// addition: READY_LIMITED_VERIFICATION. The spec's own terminal state
// READY is reserved for once tracking/billing/conversions/verification
// are actually implemented and confirmed for a given platform — until
// then, a platform that meets today's real publish-readiness bar gets
// this distinct, clearly-named state instead of a bare, misleading
// "ready".
const STATE = Object.freeze({
  NOT_STARTED: 'not_started',
  AUTHENTICATION_REQUIRED: 'authentication_required',
  AUTHENTICATED: 'authenticated',
  ACCOUNT_SELECTION_REQUIRED: 'account_selection_required',
  ACCOUNT_CREATION_REQUIRED: 'account_creation_required',
  ASSETS_REQUIRED: 'assets_required',
  READY_LIMITED_VERIFICATION: 'ready_limited_verification',
  READY: 'ready',
  ERROR: 'error',
  MANUAL_ACTION_REQUIRED: 'manual_action_required',
});

const STEP_STATUS = Object.freeze({
  COMPLETE: 'complete',
  ACTION_REQUIRED: 'action_required',
  NOT_STARTED: 'not_started',
  NOT_VERIFIED_BY_ORIVEN: 'not_verified_by_oriven',
});

function isTokenValid(row) {
  if (!row || !row.access_token) return false;
  if (!row.token_expiry) return true; // some rows (Meta) may not always carry an expiry
  return new Date(row.token_expiry).getTime() > Date.now();
}

function step(status, extra) {
  return Object.freeze({ status, ...extra });
}

// The 4 capability categories no platform has real verification for
// yet (per platformCapabilities.js — implemented:false on every
// platform's TRACKING/CONVERSIONS/BILLING/VERIFICATION entries).
// Surfaced identically for every platform so the UI can render one
// consistent "ORIVEN can't check this yet" treatment.
function unverifiedSteps(platform) {
  const caps = getCapabilities(platform);
  const byCategory = (category) => caps.filter((c) => c.category === category);
  const toStep = (c) => step(STEP_STATUS.NOT_VERIFIED_BY_ORIVEN, {
    key: c.key,
    label: c.label,
    reason: 'ORIVEN does not yet check this — the platform enforces it at publish time today.',
    officialFlow: c.officialFlow,
  });
  return {
    tracking: byCategory('TRACKING').map(toStep),
    conversions: byCategory('CONVERSIONS').map(toStep),
    billing: byCategory('BILLING').map(toStep),
    verification: byCategory('VERIFICATION').map(toStep),
  };
}

function baseResult(platform, row) {
  const connected = isTokenValid(row);
  return {
    platform,
    connected,
    ready: false,
    state: STATE.NOT_STARTED,
    actionRequired: null,
    officialFlow: null,
    steps: {
      authentication: step(STEP_STATUS.NOT_STARTED),
      account: step(STEP_STATUS.NOT_STARTED),
      assets: step(STEP_STATUS.NOT_STARTED),
      ...unverifiedSteps(platform),
    },
    lastCheckedAt: new Date().toISOString(),
  };
}

// ── META ────────────────────────────────────────────────────────
function checkMetaSetup(row) {
  const result = baseResult('meta', row);
  if (!row) {
    result.state = STATE.NOT_STARTED;
    result.actionRequired = 'authentication';
    return result;
  }
  if (!isTokenValid(row)) {
    result.state = STATE.AUTHENTICATION_REQUIRED;
    result.actionRequired = 'authentication';
    result.steps.authentication = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'Token missing or expired — Meta does not support silent refresh; full reconnect required.' });
    return result;
  }
  result.steps.authentication = step(STEP_STATUS.COMPLETE);

  const accounts = Array.isArray(row.meta_ads_accounts) ? row.meta_ads_accounts : [];
  const activeAccount = row.active_ad_account;
  if (!activeAccount) {
    if (accounts.length === 0) {
      result.state = STATE.ACCOUNT_CREATION_REQUIRED;
      result.actionRequired = 'account';
      result.officialFlow = { label: 'Continue to Meta', urlTemplate: 'https://business.facebook.com/settings/ad-accounts' };
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'No ad account found. Meta ad account creation requires Business Verification and is not something ORIVEN performs today.' });
    } else {
      result.state = STATE.ACCOUNT_SELECTION_REQUIRED;
      result.actionRequired = 'account';
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'One or more ad accounts found — select one to continue.', count: accounts.length });
    }
    return result;
  }
  result.steps.account = step(STEP_STATUS.COMPLETE, { accountId: activeAccount.account_id, accountName: activeAccount.account_name });

  // Meta's own publish pipeline needs a selected Facebook Page for
  // object_story_spec.page_id (server.js) — a real, current
  // requirement, not a speculative one.
  const pages = Array.isArray(row.meta_pages) ? row.meta_pages : [];
  const activePage = row.active_page;
  if (!activePage) {
    result.state = STATE.ASSETS_REQUIRED;
    result.actionRequired = 'assets';
    result.steps.assets = step(STEP_STATUS.ACTION_REQUIRED, { reason: pages.length ? 'Select a Facebook Page to advertise from.' : 'No Facebook Page found — connect one in Meta.', count: pages.length });
    return result;
  }
  result.steps.assets = step(STEP_STATUS.COMPLETE, { pageId: activePage.page_id, pageName: activePage.page_name });

  result.state = STATE.READY_LIMITED_VERIFICATION;
  result.ready = true;
  return result;
}

// ── GOOGLE ──────────────────────────────────────────────────────
function checkGoogleSetup(row) {
  const result = baseResult('google', row);
  if (!row) {
    result.state = STATE.NOT_STARTED;
    result.actionRequired = 'authentication';
    return result;
  }
  if (!isTokenValid(row) && !row.refresh_token) {
    result.state = STATE.AUTHENTICATION_REQUIRED;
    result.actionRequired = 'authentication';
    result.steps.authentication = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'Token expired and no refresh token stored — reconnect required.' });
    return result;
  }
  // A stored refresh_token means the existing _getGadsAccess() will
  // silently refresh on next real use — that's real, working
  // behavior (server.js:10471-10494), so an expired access_token
  // alone does not mean re-authentication is needed here.
  result.steps.authentication = step(STEP_STATUS.COMPLETE);

  const accounts = Array.isArray(row.google_ads_accounts) ? row.google_ads_accounts : [];
  const nonManagerAccounts = accounts.filter((a) => !a.is_manager);
  const activeAccount = row.active_ad_account;
  if (!activeAccount) {
    if (nonManagerAccounts.length === 0) {
      result.state = STATE.ACCOUNT_CREATION_REQUIRED;
      result.actionRequired = 'account';
      result.officialFlow = { label: 'Continue to Google Ads', urlTemplate: 'https://ads.google.com/aw/overview' };
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, {
        reason: accounts.length
          ? 'Only manager (MCC) accounts found — an actual advertiser account is required. Creating one via API depends on manager-account spend/policy eligibility ORIVEN has not checked; use Google Ads to create or link one.'
          : 'No Google Ads account found.',
      });
    } else {
      result.state = STATE.ACCOUNT_SELECTION_REQUIRED;
      result.actionRequired = 'account';
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'One or more advertiser accounts found — select one to continue.', count: nonManagerAccounts.length });
    }
    return result;
  }
  if (activeAccount.is_manager) {
    // Mirrors the real, existing guard in _getGadsAccess (server.js:10503-10506) —
    // a manager account can never itself be the publish target.
    result.state = STATE.ACCOUNT_SELECTION_REQUIRED;
    result.actionRequired = 'account';
    result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'The selected account is a Manager (MCC) account and has no campaigns of its own — select a real advertiser account.' });
    return result;
  }
  result.steps.account = step(STEP_STATUS.COMPLETE, { accountId: activeAccount.account_id, accountName: activeAccount.account_name });
  // Google's publish route needs no further platform-specific asset
  // selection beyond the customer account itself.
  result.steps.assets = step(STEP_STATUS.COMPLETE, { reason: 'No additional asset selection required by the current publish pipeline.' });

  result.state = STATE.READY_LIMITED_VERIFICATION;
  result.ready = true;
  return result;
}

// ── TIKTOK ──────────────────────────────────────────────────────
function checkTikTokSetup(row) {
  const result = baseResult('tiktok', row);
  if (!row) {
    result.state = STATE.NOT_STARTED;
    result.actionRequired = 'authentication';
    return result;
  }
  if (!isTokenValid(row)) {
    result.state = STATE.AUTHENTICATION_REQUIRED;
    result.actionRequired = 'authentication';
    // Unlike Google/Pinterest, TikTok's stored refresh_token is never
    // actually used by _getTikTokAccess today (server.js:8039-8065) —
    // reported honestly as a full reconnect requirement, not silently
    // assumed to auto-refresh like Google/Pinterest.
    result.steps.authentication = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'Token expired. A refresh_token is stored but ORIVEN does not yet use it automatically — reconnect required.' });
    return result;
  }
  result.steps.authentication = step(STEP_STATUS.COMPLETE);

  const accounts = Array.isArray(row.tiktok_ads_accounts) ? row.tiktok_ads_accounts : [];
  const activeAccount = row.active_ad_account;
  if (!activeAccount) {
    if (accounts.length === 0) {
      result.state = STATE.ACCOUNT_CREATION_REQUIRED;
      result.actionRequired = 'account';
      result.officialFlow = { label: 'Continue to TikTok', urlTemplate: 'https://business.tiktok.com/' };
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'No advertiser account found. Creation requires a TikTok Business Center ORIVEN cannot create on your behalf today.' });
    } else {
      result.state = STATE.ACCOUNT_SELECTION_REQUIRED;
      result.actionRequired = 'account';
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'One or more advertiser accounts found — select one to continue.', count: accounts.length });
    }
    return result;
  }
  result.steps.account = step(STEP_STATUS.COMPLETE, { accountId: activeAccount.account_id, accountName: activeAccount.account_name });

  // TikTok's publish route additionally needs a selected Identity
  // (who the ad is posted as) — a real, current requirement
  // (server.js: active_identity, /api/publish/tiktok).
  const activeIdentity = row.active_identity;
  if (!activeIdentity) {
    result.state = STATE.ASSETS_REQUIRED;
    result.actionRequired = 'assets';
    result.steps.assets = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'Select a TikTok Identity to publish ads as.' });
    return result;
  }
  result.steps.assets = step(STEP_STATUS.COMPLETE, { identityId: activeIdentity.identity_id, displayName: activeIdentity.display_name });

  result.state = STATE.READY_LIMITED_VERIFICATION;
  result.ready = true;
  return result;
}

// ── PINTEREST ───────────────────────────────────────────────────
function checkPinterestSetup(row) {
  const result = baseResult('pinterest', row);
  if (!row) {
    result.state = STATE.NOT_STARTED;
    result.actionRequired = 'authentication';
    return result;
  }
  // Pinterest actively refreshes (real 60-day rolling refresh,
  // server.js:11048-11095) — only a truly dead connection (expired
  // AND no refresh_token) needs full re-authentication.
  if (!isTokenValid(row) && !row.refresh_token) {
    result.state = STATE.AUTHENTICATION_REQUIRED;
    result.actionRequired = 'authentication';
    result.steps.authentication = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'Token expired and no refresh token available — reconnect required.' });
    return result;
  }
  result.steps.authentication = step(STEP_STATUS.COMPLETE);

  const accounts = Array.isArray(row.pinterest_ads_accounts) ? row.pinterest_ads_accounts : [];
  const activeAccount = row.active_ad_account;
  if (!activeAccount) {
    if (accounts.length === 0) {
      // Pinterest is the one platform where first-account creation is
      // explicitly, deliberately UI-only per official guidance — this
      // is MANUAL_ACTION_REQUIRED, not the generic ACCOUNT_CREATION_REQUIRED
      // used for Meta/TikTok (which are API-gated, not API-absent).
      result.state = STATE.MANUAL_ACTION_REQUIRED;
      result.actionRequired = 'account';
      result.officialFlow = { label: 'Continue to Pinterest', urlTemplate: 'https://www.pinterest.com/business/create/' };
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'No ad account found. Pinterest requires first-time advertisers to create their first ad account on Pinterest directly — this is not an API operation.' });
    } else {
      result.state = STATE.ACCOUNT_SELECTION_REQUIRED;
      result.actionRequired = 'account';
      result.steps.account = step(STEP_STATUS.ACTION_REQUIRED, { reason: 'One or more ad accounts found — select one to continue.', count: accounts.length });
    }
    return result;
  }
  result.steps.account = step(STEP_STATUS.COMPLETE, { accountId: activeAccount.account_id, accountName: activeAccount.account_name });
  result.steps.assets = step(STEP_STATUS.COMPLETE, { reason: 'No additional asset selection required by the current publish pipeline (boards are created automatically as needed).' });

  result.state = STATE.READY_LIMITED_VERIFICATION;
  result.ready = true;
  return result;
}

const CHECKERS = Object.freeze({
  meta: checkMetaSetup,
  google: checkGoogleSetup,
  tiktok: checkTikTokSetup,
  pinterest: checkPinterestSetup,
});

/**
 * Fetch the stored integrations row for one platform and compute its
 * setup state. The ONLY database access in this whole module — a
 * plain SELECT against the same table/columns every platform's
 * existing OAuth code already reads and writes. No external API
 * calls, no new tables, no new columns.
 */
async function getSetupStatus(supabaseAdmin, userId, platform) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform "${platform}" — expected one of ${PLATFORMS.join(', ')}`);
  }
  const provider = { meta: 'meta_ads', google: 'google_ads', tiktok: 'tiktok_ads', pinterest: 'pinterest_ads' }[platform];
  const { data: row, error } = await supabaseAdmin
    .from('integrations')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) {
    return { platform, connected: false, ready: false, state: STATE.ERROR, actionRequired: null, error: error.message, lastCheckedAt: new Date().toISOString() };
  }
  return CHECKERS[platform](row);
}

async function getAllSetupStatuses(supabaseAdmin, userId) {
  const results = await Promise.all(PLATFORMS.map((p) => getSetupStatus(supabaseAdmin, userId, p)));
  const byPlatform = {};
  results.forEach((r) => { byPlatform[r.platform] = r; });
  return byPlatform;
}

module.exports = {
  STATE,
  STEP_STATUS,
  checkMetaSetup,
  checkGoogleSetup,
  checkTikTokSetup,
  checkPinterestSetup,
  getSetupStatus,
  getAllSetupStatuses,
};
