// ════════════════════════════════════════════════════════════════
// Universal Setup Engine — Error Taxonomy (Completion Pass)
//
// Stable internal error codes every setup adapter/route maps a real
// platform error into, so the frontend can render one consistent set
// of states regardless of which of the 4 platforms' wildly different
// raw error shapes (Meta's {error:{code,error_subcode,message}},
// Google's GoogleAdsFailure error list, TikTok's {code,message}
// envelope, Pinterest's {code,message}) produced it. Raw API
// payloads/messages are never sent to the client — only the code +
// a plain-language message; full technical detail (raw body, status,
// platform) is always console-logged server-side for debugging.
// ════════════════════════════════════════════════════════════════

const CODE = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REFRESH_FAILED: 'TOKEN_REFRESH_FAILED',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  ACCOUNT_REQUIRED: 'ACCOUNT_REQUIRED',
  ACCOUNT_CREATION_REQUIRED: 'ACCOUNT_CREATION_REQUIRED',
  ASSET_REQUIRED: 'ASSET_REQUIRED',
  TRACKING_REQUIRED: 'TRACKING_REQUIRED',
  CONVERSION_SETUP_REQUIRED: 'CONVERSION_SETUP_REQUIRED',
  BILLING_REQUIRED: 'BILLING_REQUIRED',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  REGION_UNSUPPORTED: 'REGION_UNSUPPORTED',
  RATE_LIMITED: 'RATE_LIMITED',
  PLATFORM_UNAVAILABLE: 'PLATFORM_UNAVAILABLE',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
});

// Plain-language, user-safe message per code — never a raw platform
// error string. Callers may still attach a platform-specific detail
// via SetupError's own `message`, but the CODE is what drives UI state.
const MESSAGE = Object.freeze({
  [CODE.AUTH_REQUIRED]: 'Connect your account to continue.',
  [CODE.TOKEN_EXPIRED]: 'Your connection expired — reconnect to continue.',
  [CODE.TOKEN_REFRESH_FAILED]: 'We could not refresh your connection — reconnect to continue.',
  [CODE.PERMISSION_REQUIRED]: 'ORIVEN is missing a permission it needs — reconnect and grant full access.',
  [CODE.ACCOUNT_REQUIRED]: 'Select an ad account to continue.',
  [CODE.ACCOUNT_CREATION_REQUIRED]: 'An ad account is required before this can continue.',
  [CODE.ASSET_REQUIRED]: 'A required asset (e.g. Page, Identity) is missing.',
  [CODE.TRACKING_REQUIRED]: 'Tracking (Pixel/Tag) must be set up before this can continue.',
  [CODE.CONVERSION_SETUP_REQUIRED]: 'Conversion tracking must be set up before this can continue.',
  [CODE.BILLING_REQUIRED]: 'Billing must be set up on the platform before this can continue.',
  [CODE.VERIFICATION_REQUIRED]: 'The platform requires verification before this can continue.',
  [CODE.ACCOUNT_RESTRICTED]: 'This account is restricted by the platform — resolve it there before continuing.',
  [CODE.REGION_UNSUPPORTED]: 'This isn’t available in your account’s region.',
  [CODE.RATE_LIMITED]: 'The platform is temporarily limiting requests — try again shortly.',
  [CODE.PLATFORM_UNAVAILABLE]: 'The platform is temporarily unavailable — try again shortly.',
  [CODE.INVALID_CONFIGURATION]: 'That configuration isn’t valid — check the details and try again.',
  [CODE.ALREADY_EXISTS]: 'That already exists — nothing new was created.',
  [CODE.UNKNOWN_ERROR]: 'Something went wrong on the platform’s side — try again in a moment.',
});

// Which codes are safe to retry automatically (transient), vs never
// (the caller must fix something first). Used by withPlatformRetry().
const RETRYABLE = Object.freeze(new Set([CODE.RATE_LIMITED, CODE.PLATFORM_UNAVAILABLE]));

function isRetryable(code) {
  return RETRYABLE.has(code);
}

/**
 * A normalized setup error. `status` is the HTTP status this should
 * surface as; `code` is the stable internal taxonomy code; `message`
 * is what the client sees (never raw platform text).
 */
class SetupError extends Error {
  constructor(code, message, status) {
    super(message || MESSAGE[code] || MESSAGE[CODE.UNKNOWN_ERROR]);
    this.code = code in MESSAGE ? code : CODE.UNKNOWN_ERROR;
    this.status = status || _defaultStatus(this.code);
  }
}

function _defaultStatus(code) {
  switch (code) {
    case CODE.AUTH_REQUIRED:
    case CODE.TOKEN_EXPIRED:
    case CODE.TOKEN_REFRESH_FAILED:
      return 401;
    case CODE.PERMISSION_REQUIRED:
    case CODE.ACCOUNT_RESTRICTED:
    case CODE.VERIFICATION_REQUIRED:
      return 403;
    case CODE.ACCOUNT_REQUIRED:
    case CODE.ACCOUNT_CREATION_REQUIRED:
    case CODE.ASSET_REQUIRED:
    case CODE.TRACKING_REQUIRED:
    case CODE.CONVERSION_SETUP_REQUIRED:
    case CODE.BILLING_REQUIRED:
    case CODE.INVALID_CONFIGURATION:
    case CODE.REGION_UNSUPPORTED:
      return 400;
    case CODE.ALREADY_EXISTS:
      return 409;
    case CODE.RATE_LIMITED:
      return 429;
    case CODE.PLATFORM_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

/**
 * Maps a raw error thrown by one of this codebase's existing platform
 * HTTP helpers (_metaFetch/_metaApiPost, _gadsQuery/_gadsMutate,
 * _pinterestApiRequest, _tiktokFetch/_tiktokPost — all of which already
 * set `.status` and, for TikTok, `.tikTokCode`) into a SetupError. This
 * is intentionally conservative: it only classifies patterns each
 * platform's real, observed error shape actually produces (documented
 * inline per platform below) — anything it doesn't recognize becomes
 * UNKNOWN_ERROR rather than a guessed, possibly-wrong code.
 */
function mapPlatformError(platform, err) {
  if (err instanceof SetupError) return err;
  const status = err && err.status;
  const rawMsg = (err && err.message) || '';
  const lower = rawMsg.toLowerCase();

  // Universal, status-driven signals every platform's helpers already
  // classify consistently today.
  if (status === 401) {
    return new SetupError(
      /refresh/.test(lower) ? CODE.TOKEN_REFRESH_FAILED : CODE.TOKEN_EXPIRED,
      rawMsg || undefined, 401
    );
  }
  if (status === 429) return new SetupError(CODE.RATE_LIMITED, undefined, 429);
  if (status === 503 || status === 502 || status === 504) return new SetupError(CODE.PLATFORM_UNAVAILABLE, undefined, status);

  if (platform === 'meta') {
    // Meta error_subcode/message patterns (developers.facebook.com/docs/graph-api/guides/error-handling).
    // Order matters: check the more specific patterns before the broad
    // 403/"permission" fallback, or a verification/restriction message
    // that also happens to return HTTP 403 would be mis-classified as
    // a generic permission problem.
    if (/business verification/.test(lower)) return new SetupError(CODE.VERIFICATION_REQUIRED, undefined, 403);
    if (/disabled|restricted/.test(lower)) return new SetupError(CODE.ACCOUNT_RESTRICTED, undefined, 403);
    if (status === 403 || /permission/.test(lower)) return new SetupError(CODE.PERMISSION_REQUIRED, undefined, 403);
  } else if (platform === 'google') {
    // GoogleAdsFailure.errors[].error_code enum names surface directly
    // in the thrown message today (_gadsMutate/_gadsQuery already join
    // errCodes into the error text) — matched by their real names.
    //
    // Connections UX overhaul — added after finding these two real,
    // common Google Ads API access-level problems fell through to a
    // generic UNKNOWN_ERROR (never mis-mapped to TOKEN_EXPIRED, but
    // also never given their own accurate, actionable state): a
    // developer token without Standard/Advanced access approval
    // (DEVELOPER_TOKEN_NOT_APPROVED/_NOT_WHITELISTED — a real,
    // documented Google Ads API restriction, genuinely different from
    // an OAuth problem, closest fit is "ORIVEN is missing a permission
    // it needs"), and a customer/login-customer mismatch
    // (INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_MISMATCH — a real
    // configuration problem, not an auth problem).
    if (/DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_NOT_WHITELISTED/i.test(rawMsg)) return new SetupError(CODE.PERMISSION_REQUIRED, undefined, 403);
    if (/LOGIN_CUSTOMER_ID.*MISMATCH|CUSTOMER_NOT_ENABLED/i.test(rawMsg)) return new SetupError(CODE.INVALID_CONFIGURATION, undefined, 400);
    if (/CREATION_DENIED_INELIGIBLE_MCC|not eligible/i.test(rawMsg)) return new SetupError(CODE.ACCOUNT_CREATION_REQUIRED, undefined, 403);
    if (/PERMISSION_DENIED|USER_PERMISSION_DENIED/i.test(rawMsg)) return new SetupError(CODE.PERMISSION_REQUIRED, undefined, 403);
    if (/DUPLICATE_NAME|ALREADY_EXISTS/i.test(rawMsg)) return new SetupError(CODE.ALREADY_EXISTS, undefined, 409);
    if (/POLICY_FINDING|POLICY_VIOLATION/i.test(rawMsg)) return new SetupError(CODE.ACCOUNT_RESTRICTED, undefined, 403);
    if (/BILLING/i.test(rawMsg)) return new SetupError(CODE.BILLING_REQUIRED, undefined, 400);
  } else if (platform === 'tiktok') {
    // TikTok's numeric `code` field (thrown as err.tikTokCode by
    // _tiktokFetch/_tiktokPost) — 40001/40105/40106 (auth), 40002/40007
    // (permission) are already mapped to HTTP 401/403 by those helpers
    // (server.js), so this only needs to add the codes NOT already
    // status-classified there.
    if (err && err.tikTokCode === 40100) return new SetupError(CODE.RATE_LIMITED, undefined, 429);
    if (/region|country/.test(lower)) return new SetupError(CODE.REGION_UNSUPPORTED, undefined, 400);
    if (/already exists|duplicate/.test(lower)) return new SetupError(CODE.ALREADY_EXISTS, undefined, 409);
    if (/business center|bc_id/i.test(rawMsg)) return new SetupError(CODE.ACCOUNT_CREATION_REQUIRED, undefined, 400);
  } else if (platform === 'pinterest') {
    // Pinterest's {code,message} envelope (_pinterestApiRequest,
    // server.js) — real observed codes for permission/rate/auth are
    // already status-classified upstream; this adds config/duplicate.
    if (/already exists|duplicate/.test(lower)) return new SetupError(CODE.ALREADY_EXISTS, undefined, 409);
    if (/invalid/.test(lower)) return new SetupError(CODE.INVALID_CONFIGURATION, undefined, 400);
  }

  if (status && status >= 400 && status < 500) return new SetupError(CODE.INVALID_CONFIGURATION, rawMsg || undefined, status);
  return new SetupError(CODE.UNKNOWN_ERROR, undefined, status || 500);
}

/**
 * Wraps a platform-mutating async function with bounded exponential
 * backoff retry — ONLY for the two genuinely transient failure modes
 * (RATE_LIMITED, PLATFORM_UNAVAILABLE). Never retries 400/401/403/409 —
 * those need the caller (a human) to change something first, and
 * blindly retrying them would just hammer the platform for no reason.
 * Deliberately small (3 attempts, capped ~4s) — this is meant to smooth
 * over a brief blip, not paper over a real outage.
 */
async function withPlatformRetry(platform, fn, { attempts = 3, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const mapped = mapPlatformError(platform, err);
      lastErr = mapped;
      if (!isRetryable(mapped.code) || i === attempts - 1) throw mapped;
      const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { CODE, MESSAGE, SetupError, mapPlatformError, isRetryable, withPlatformRetry };
