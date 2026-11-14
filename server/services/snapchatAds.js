// ════════════════════════════════════════════════════════════════════
// Snapchat Ads (Snap Marketing API v1) — OAuth, API client, discovery,
// media, reporting and status changes. server.js wires the routes; the
// publish flow lives in routes/publishRoutes.js like every other platform.
//
// Verified against Snap's own developer docs (developers.snap.com,
// 2026-11):
//   • authorize  GET  https://accounts.snapchat.com/login/oauth2/authorize
//                     response_type=code, client_id, redirect_uri (must match
//                     the OAuth app exactly), scope, state
//   • token      POST https://accounts.snapchat.com/login/oauth2/access_token
//                     form fields; grant_type authorization_code | refresh_token
//   • scope      snapchat-marketing-api ("read and write to the Snapchat
//                marketing APIs") — the only scope OrivenAI requests
//   • access token valid 3600 s; the refresh token does not expire but stops
//     working when the user's access is removed. Whether a refresh returns a
//     new refresh token is not documented, so whatever the latest response
//     returns is stored.
//   • API base   https://adsapi.snapchat.com/v1, Authorization: Bearer
//   • money is micro-currency (1.00 = 1 000 000)
//   • rate limits: ~10 requests/s per token (429 when exceeded)
// Tokens never leave the server and are never logged.
// ════════════════════════════════════════════════════════════════════
'use strict';

const AUTH_BASE = 'https://accounts.snapchat.com/login/oauth2';
const API = 'https://adsapi.snapchat.com/v1';
const SCOPE = 'snapchat-marketing-api';
const PROVIDER = 'snapchat_ads';
const PROD_REDIRECT = 'https://oriven-backand-clean.onrender.com/auth/snapchat/callback';
const DEV_REDIRECT = 'http://localhost:5500/auth/snapchat/callback';
const MICRO = 1e6;
// Snap limits (Ads API reference): headline ≤ 34, brand name ≤ 32, names ≤ 375,
// ad squad daily budget ≥ 5 (all currencies), Top Snap image 1080×1920 ≤ 5 MB,
// Top Snap video 1080×1920 mp4/mov, single upload ≤ 32 MB.
const LIMITS = { HEADLINE: 34, BRAND: 32, NAME: 375, MIN_DAILY: 5, IMAGE_BYTES: 5 * 1024 * 1024, VIDEO_BYTES: 32 * 1024 * 1024, W: 1080, H: 1920, MIN_AGE_MAX: 35, MAX_AGE_CAP: 55 };
// call_to_action values Snap allows for WEB_VIEW creatives (CTA mapping table).
const WEB_VIEW_CTAS = ['APPLY_NOW', 'MORE', 'ORDER_NOW', 'PLAY', 'READ', 'SHOP_NOW', 'SHOW', 'SIGN_UP', 'VIEW', 'WATCH', 'DONATE', 'DOWNLOAD', 'RESPOND', 'BUY_TICKETS', 'SHOWTIMES', 'BOOK_NOW', 'GET_NOW', 'LISTEN', 'TRY', 'VOTE', 'VIEW_MENU', 'PRE_REGISTER', 'PLAY_GAME', 'EXPLORE_MORE', 'REQUEST_QUOTE'];
// OrivenAI goal → Snap objective_v2_type + ad squad optimization goal.
// Sales and Leads optimise for Snap Pixel events (PIXEL_PURCHASE /
// PIXEL_SIGNUP), which need a pixel OrivenAI can't select yet — those goals
// are refused at validation, never published with a different meaning.
const GOAL_CONFIG = {
  Traffic: { objective: 'TRAFFIC', optimization: 'SWIPES' },
  Awareness: { objective: 'AWARENESS_AND_ENGAGEMENT', optimization: 'IMPRESSIONS' },
};

function config(env) {
  env = env || process.env;
  const clientId = String(env.SNAPCHAT_CLIENT_ID || '').trim();
  const clientSecret = String(env.SNAPCHAT_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.SNAPCHAT_REDIRECT_URI || '').trim() || (env.RENDER ? PROD_REDIRECT : DEV_REDIRECT);
  return { clientId, clientSecret, redirectUri, configured: !!(clientId && clientSecret) };
}

function authorizeUrl(cfg, state) {
  const q = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: SCOPE, state });
  return AUTH_BASE + '/authorize?' + q.toString();
}

class SnapError extends Error {
  constructor(message, status, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
}

// Never let a credential reach a log line or an error message.
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/(access_token|refresh_token|client_secret|code)(["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

// Snap's OAuth error field (RFC 6749 §5.2) reduced to a fixed set of safe
// codes — the only part of a token-endpoint error that is logged or shown.
const OAUTH_ERRORS = ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable'];
function oauthReason(status, j) {
  const e = String((j && j.error) || '').toLowerCase();
  if (OAUTH_ERRORS.includes(e)) return e;
  if (status >= 500) return 'server_error';
  if (status && status !== 200) return 'http_' + status;
  return 'no_access_token';
}

// One POST to the token endpoint. Client authentication: Snap's Marketing
// API docs send client_id + client_secret in the form body; RFC 6749 §2.3.1
// also allows HTTP Basic, which every OAuth server must support. Body first
// (the documented way); 'basic' is used only as the fallback below.
async function _tokenPost(cfg, fields, fetchImpl, auth) {
  const f = fetchImpl || fetch;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const form = Object.assign({}, fields);
  if (auth === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(cfg.clientId) + ':' + encodeURIComponent(cfg.clientSecret)).toString('base64');
    form.client_id = cfg.clientId;
  } else Object.assign(form, { client_id: cfg.clientId, client_secret: cfg.clientSecret });
  let r;
  try { r = await f(AUTH_BASE + '/access_token', { method: 'POST', headers, body: new URLSearchParams(form).toString() }); }
  catch (e) { throw new SnapError('Could not reach Snapchat to sign in (' + redact(e.message) + ').', 502, { code: 'NETWORK', reason: 'network' }); }
  let j = {};
  const text = await r.text().catch(() => '');
  try { j = text ? JSON.parse(text) : {}; } catch (_) { j = {}; }
  return { ok: r.ok && !!j.access_token, status: r.status, j, diag: tokenDiag(r, j, text, auth) };
}

// What a refused token request can safely tell us: HTTP status, Snap's error
// and error_description (cleaned, length-capped, long token-like runs
// removed), the response content type, request-id style headers, and how the
// request was sent. Never the code, a token, the secret or the request body.
function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '[…]')
    .replace(/[^A-Za-z0-9 .,:;'()_\-[\]…]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max || 160);
}
function tokenDiag(r, j, text, auth) {
  const h = (n) => { try { return r.headers && r.headers.get ? r.headers.get(n) : null; } catch (_) { return null; } };
  const ids = {};
  ['x-request-id', 'x-snap-request-id', 'x-envoy-upstream-service-time', 'www-authenticate', 'date'].forEach((n) => { const v = h(n); if (v) ids[n] = cleanText(v, 80); });
  return {
    status: r.status,
    error: cleanText(j && j.error, 40) || null,
    description: cleanText(j && j.error_description, 160) || null,
    contentType: cleanText(h('content-type'), 60) || null,
    jsonBody: !!(text && j && Object.keys(j).length),
    headers: ids,
    request: { method: 'POST', contentType: 'application/x-www-form-urlencoded', clientAuth: auth === 'basic' ? 'basic' : 'body' },
  };
}
async function _tokenRequest(cfg, fields, fetchImpl) {
  let res = await _tokenPost(cfg, fields, fetchImpl, 'body');
  // invalid_client on in-body credentials: authentication failed before the
  // grant was looked at (the code isn't consumed), so try HTTP Basic once.
  if (!res.ok && oauthReason(res.status, res.j) === 'invalid_client') res = await _tokenPost(cfg, fields, fetchImpl, 'basic');
  if (!res.ok) {
    const reason = oauthReason(res.status, res.j);
    const reconnect = ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(reason);
    throw new SnapError('Snapchat refused the sign-in (' + reason + ').', reconnect || res.status === 400 || res.status === 401 ? 401 : 502, { code: reconnect ? 'RECONNECT_REQUIRED' : 'TOKEN_FAILED', reason, diag: res.diag });
  }
  const j = res.j;
  return { accessToken: j.access_token, refreshToken: j.refresh_token || null, expiresIn: Number(j.expires_in) || 3600 };
}
// redirectUri: the exact URI the code was issued for (RFC 6749 §4.1.3:
// "identical" to the authorization request's; Snap: "Must match redirect_uri
// from the previous /authorize call"). Defaults to the configured one.
const exchangeCode = (cfg, code, fetchImpl, redirectUri) => _tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri || cfg.redirectUri }, fetchImpl);

// The redirect URI to send at the token exchange, given the path Snapchat
// actually redirected the browser to. Express routes match loosely (a
// trailing slash and letter case are ignored), so a callback can arrive at
// "/auth/snapchat/callback/" while the configured URI has no slash — the
// code is then bound to the URI Snap used, not the configured one. Only a
// variant of the configured callback (same origin, same path ignoring one
// trailing slash and case) is accepted; anything else keeps the configured URI.
function exchangeRedirectUri(cfg, actualPath) {
  let conf;
  try { conf = new URL(cfg.redirectUri); } catch (_) { return { uri: cfg.redirectUri, variant: false }; }
  const p = String(actualPath || '');
  const norm = (s) => s.replace(/\/$/, '').toLowerCase();
  if (!p || p === conf.pathname || norm(p) !== norm(conf.pathname) || !/^\/[A-Za-z0-9/_\-]*$/.test(p)) return { uri: cfg.redirectUri, variant: false };
  return { uri: conf.origin + p, variant: true };
}
const refreshAccessToken = (cfg, refreshToken, fetchImpl) => _tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);

// Does Snap accept the configured app credentials? One token request with a
// code that can't exist: Snap answers invalid_grant when the client
// authenticated (credentials right) and invalid_client when it didn't.
// Nothing is created; no secret or token is returned.
async function checkCredentials(cfg, fetchImpl) {
  if (!cfg.configured) return { credentials: 'not_configured' };
  const fields = { grant_type: 'authorization_code', code: 'orivenai-credential-check', redirect_uri: cfg.redirectUri };
  const probe = async (auth) => { const r = await _tokenPost(cfg, fields, fetchImpl, auth); return oauthReason(r.status, r.j); };
  // Does Snap verify the client SECRET before the code? The same request
  // with a deliberately wrong secret: invalid_client means it does (so the
  // configured secret is proven right); invalid_grant means Snap rejects the
  // code first, and "accepted" above says nothing about the secret.
  const secretOrder = async () => {
    const wrong = Object.assign({}, cfg, { clientSecret: cfg.clientSecret + '-orivenai-wrong' });
    const r = await _tokenPost(wrong, fields, fetchImpl, 'body');
    const reason = oauthReason(r.status, r.j);
    return { wrongSecretReason: reason, secretVerified: reason === 'invalid_client' ? true : reason === 'invalid_grant' ? 'not_checked_before_code' : 'unknown' };
  };
  const clientIdHint = cfg.clientId.length > 8 ? cfg.clientId.slice(0, 4) + '…' + cfg.clientId.slice(-4) : '(short)';
  try {
    const body = await probe('body');
    if (body !== 'invalid_client') {
      const order = body === 'invalid_grant' ? await secretOrder() : {};
      // Only call the credentials accepted when Snap provably checked the secret.
      const credentials = body !== 'invalid_grant' ? 'unknown' : order.secretVerified === true ? 'accepted' : 'client_id_known_secret_unverified';
      return Object.assign({ credentials, clientAuth: 'body', snapReason: body, clientIdHint, clientIdLength: cfg.clientId.length }, order);
    }
    const basic = await probe('basic');
    return basic === 'invalid_client' ? { credentials: 'rejected', snapReason: 'invalid_client' } : { credentials: basic === 'invalid_grant' ? 'accepted' : 'unknown', clientAuth: 'basic', snapReason: basic };
  } catch (e) { return { credentials: 'unknown', snapReason: e.reason || 'network' }; }
}

// One Ads API call. Errors carry an HTTP-ish status the routes can return:
// 401 token invalid/expired, 403 permission, 429 rate limited, 400 Snap
// refused the request (its own message), 502 Snap unavailable.
async function request(token, method, path, body, opts) {
  opts = opts || {};
  const f = opts.fetchImpl || fetch;
  const init = { method: method || 'GET', headers: { Authorization: 'Bearer ' + token } };
  if (opts.form) init.body = opts.form;
  else if (body !== undefined) { init.headers['Content-Type'] = opts.contentType || 'application/json'; init.body = JSON.stringify(body); }
  const url = /^https?:\/\//.test(path) ? path : API + path;
  let r;
  try { r = await f(url, init); } catch (e) { throw new SnapError('Snapchat could not be reached (' + redact(e.message) + ').', 502, { code: 'NETWORK' }); }
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (_) { j = { raw: text.slice(0, 200) }; }
  if (r.status === 401) throw new SnapError('Snapchat no longer accepts OrivenAI’s access. Reconnect Snapchat Ads.', 401, { code: 'RECONNECT_REQUIRED' });
  if (r.status === 403) throw new SnapError('Your Snapchat user doesn’t have permission for this ad account or action.' + (j.display_message ? ' ' + j.display_message : ''), 403, { code: 'PERMISSION' });
  if (r.status === 429) throw new SnapError('Snapchat is limiting requests right now. Try again in a minute.', 429, { code: 'RATE_LIMITED' });
  if (r.status === 404) throw new SnapError(j.display_message || 'Snapchat could not find this item.', 404, { code: 'NOT_FOUND' });
  if (r.status >= 500) throw new SnapError('Snapchat is temporarily unavailable (' + r.status + '). Try again later.', 502, { code: 'SNAP_UNAVAILABLE' });
  if (!r.ok || String(j.request_status || '').toUpperCase() === 'ERROR') {
    const msg = j.display_message || j.debug_message || subError(j) || ('Snapchat refused the request (' + r.status + ').');
    throw new SnapError(redact(msg).slice(0, 400), 400, { code: 'SNAP_REJECTED', errorCode: j.error_code || null });
  }
  return j;
}

// First entity-level error in a bulk response ({ campaigns: [{ sub_request_status,
// sub_request_error_reason }] } …), or null.
function subError(j) {
  if (!j || typeof j !== 'object') return null;
  for (const k of Object.keys(j)) {
    if (!Array.isArray(j[k])) continue;
    const bad = j[k].find((x) => x && String(x.sub_request_status || '').toUpperCase() === 'ERROR');
    if (bad) return String(bad.sub_request_error_reason || 'Snapchat refused one of the items.');
  }
  return null;
}
// Items of a bulk response, e.g. items(j, 'campaigns', 'campaign').
function items(j, list, one) {
  const err = subError(j);
  if (err && String(j.request_status || '').toUpperCase() !== 'SUCCESS') throw new SnapError(redact(err).slice(0, 400), 400, { code: 'SNAP_REJECTED' });
  return ((j && j[list]) || []).map((x) => x && x[one]).filter(Boolean);
}
// Created entity of a single-item create call; throws Snap's own reason.
function created(j, list, one) {
  const arr = (j && j[list]) || [];
  const first = arr[0] || {};
  if (String(first.sub_request_status || '').toUpperCase() === 'ERROR' || !first[one] || !first[one].id) {
    throw new SnapError(redact(first.sub_request_error_reason || subError(j) || ('Snapchat did not return the new ' + one + '.')).slice(0, 400), 400, { code: 'SNAP_REJECTED' });
  }
  return first[one];
}

// Every page of a list endpoint (paging.next_link), bounded.
async function listAll(token, path, list, one, opts) {
  const out = [];
  let url = path + (path.includes('?') ? '&' : '?') + 'limit=500';
  for (let i = 0; i < 10 && url; i++) {
    const j = await request(token, 'GET', url, undefined, opts);
    items(j, list, one).forEach((x) => out.push(x));
    url = j && j.paging && j.paging.next_link ? j.paging.next_link : null;
  }
  return out;
}

// Organizations with their ad accounts → a flat list of the ad accounts this
// Snapchat user can reach. { accounts, error } — an empty list with no error
// is a real "no ad accounts", never a failed call.
async function discoverAccounts(token, opts) {
  try {
    const orgs = await listAll(token, '/me/organizations?with_ad_accounts=true', 'organizations', 'organization', opts);
    const accounts = [];
    for (const o of orgs) {
      for (const a of o.ad_accounts || []) {
        accounts.push({
          id: String(a.id), name: a.name || String(a.id), currency: a.currency || null, timezone: a.timezone || null,
          status: a.status || null, type: a.type || null, organization_id: String(o.id), organization_name: o.name || null,
        });
      }
    }
    return { accounts, error: null };
  } catch (e) {
    return { accounts: [], error: e.message, status: e.status || 502 };
  }
}

// ── Status changes ──────────────────────────────────────────────────
// Snap updates are PUT with the ENTIRE object ("Omitting attributes that
// have default values will reset those attributes to the default"), so the
// object is read first and written back with only the changed field.
const READ_ONLY = ['created_at', 'updated_at', 'delivery_status', 'review_status', 'review_status_reasons', 'render_type', 'effective_status'];
function _writable(obj, patch) {
  const o = Object.assign({}, obj, patch);
  READ_ONLY.forEach((k) => delete o[k]);
  return o;
}
async function getCampaign(token, id, opts) { return items(await request(token, 'GET', '/campaigns/' + encodeURIComponent(id), undefined, opts), 'campaigns', 'campaign')[0] || null; }
async function getAdSquad(token, id, opts) { return items(await request(token, 'GET', '/adsquads/' + encodeURIComponent(id), undefined, opts), 'adsquads', 'adsquad')[0] || null; }
async function getAd(token, id, opts) { return items(await request(token, 'GET', '/ads/' + encodeURIComponent(id), undefined, opts), 'ads', 'ad')[0] || null; }
async function updateCampaign(token, adAccountId, id, patch, opts) {
  const c = await getCampaign(token, id, opts);
  if (!c) throw new SnapError('Snapchat could not find this campaign.', 404, { code: 'NOT_FOUND' });
  return created(await request(token, 'PUT', '/adaccounts/' + encodeURIComponent(adAccountId) + '/campaigns', { campaigns: [_writable(c, patch)] }, opts), 'campaigns', 'campaign');
}
async function updateAdSquad(token, id, patch, opts) {
  const s = await getAdSquad(token, id, opts);
  if (!s) throw new SnapError('Snapchat could not find this ad squad.', 404, { code: 'NOT_FOUND' });
  return created(await request(token, 'PUT', '/campaigns/' + encodeURIComponent(s.campaign_id) + '/adsquads', { adsquads: [_writable(s, patch)] }, opts), 'adsquads', 'adsquad');
}
async function updateAd(token, id, patch, opts) {
  const a = await getAd(token, id, opts);
  if (!a) throw new SnapError('Snapchat could not find this ad.', 404, { code: 'NOT_FOUND' });
  return created(await request(token, 'PUT', '/adsquads/' + encodeURIComponent(a.ad_squad_id) + '/ads', { ads: [_writable(a, patch)] }, opts), 'ads', 'ad');
}
const remove = (token, kind, id, opts) => request(token, 'DELETE', '/' + kind + '/' + encodeURIComponent(id), undefined, opts);

// ── Media ───────────────────────────────────────────────────────────
// Top Snap image: exactly 1080×1920. An image of another shape is placed,
// whole, on a blurred full-bleed copy of itself (never stretched, nothing
// important cut off); a 9:16 image is only resized. JPEG, under 5 MB.
async function topSnapImage(buf) {
  const sharp = require('sharp');
  const m = await sharp(buf).metadata();
  const r = m.width / m.height, target = LIMITS.W / LIMITS.H;
  let out;
  if (Math.abs(r - target) / target <= 0.02) {
    out = await sharp(buf).resize(LIMITS.W, LIMITS.H, { fit: 'cover' }).jpeg({ quality: 88 }).toBuffer();
  } else {
    const bg = await sharp(buf).resize(LIMITS.W, LIMITS.H, { fit: 'cover' }).blur(40).modulate({ brightness: 0.8 }).toBuffer();
    const fg = await sharp(buf).resize(LIMITS.W, LIMITS.H, { fit: 'inside' }).toBuffer();
    out = await sharp(bg).composite([{ input: fg, gravity: 'center' }]).jpeg({ quality: 88 }).toBuffer();
  }
  for (let q = 80; out.length > LIMITS.IMAGE_BYTES && q >= 50; q -= 10) out = await sharp(out).jpeg({ quality: q }).toBuffer();
  if (out.length > LIMITS.IMAGE_BYTES) throw new SnapError('The image is too large for Snapchat even after compressing (5 MB maximum).', 422, { code: 'MEDIA_TOO_LARGE' });
  return out;
}

// Creates the media entity and uploads the file (single request, ≤ 32 MB).
async function uploadMedia(token, adAccountId, { type, name, buffer, fileName, contentType }, opts) {
  if (type === 'VIDEO' && buffer.length > LIMITS.VIDEO_BYTES) throw new SnapError('The video is larger than 32 MB, Snapchat’s limit for a direct upload. Use a shorter or smaller video.', 422, { code: 'MEDIA_TOO_LARGE' });
  const media = created(await request(token, 'POST', '/adaccounts/' + encodeURIComponent(adAccountId) + '/media', { media: [{ name: String(name || 'OrivenAI media').slice(0, LIMITS.NAME), type, ad_account_id: String(adAccountId) }] }, opts), 'media', 'media');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), fileName);
  const up = await request(token, 'POST', '/media/' + encodeURIComponent(media.id) + '/upload', undefined, Object.assign({}, opts, { form }));
  const st = up && up.result && up.result.media_status;
  if (st && !/READY|PENDING/i.test(String(st))) throw new SnapError('Snapchat could not process the uploaded ' + type.toLowerCase() + ' (' + st + ').', 400, { code: 'MEDIA_FAILED' });
  return String(media.id);
}

// ── Reporting ───────────────────────────────────────────────────────
// Snap's DAY/HOUR stats must start and end on the hour in the ad account's
// timezone. Midnight of a calendar date in a timezone, as ISO with offset.
function zonedMidnight(ymd, timeZone) {
  const tz = timeZone || 'UTC';
  const guess = new Date(ymd + 'T00:00:00Z');
  let offsetMin = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(guess);
    const name = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (m) offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch (_) { offsetMin = 0; }
  const sign = offsetMin < 0 ? '-' : '+', a = Math.abs(offsetMin);
  return ymd + 'T00:00:00.000' + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

const STAT_FIELDS = 'impressions,swipes,spend,video_views';
function _stat(s) {
  s = s || {};
  const num = (v) => (v == null || !isFinite(Number(v)) ? 0 : Number(v));
  const spend = num(s.spend) / MICRO, impressions = num(s.impressions), clicks = num(s.swipes);
  const conv = s.conversion_purchases != null ? num(s.conversion_purchases) : null;
  return { spend, impressions, clicks, videoViews: num(s.video_views), conversions: conv };
}
function _sum(rows) {
  const t = { spend: 0, impressions: 0, clicks: 0, videoViews: 0, conversions: null };
  rows.forEach((r) => { t.spend += r.spend; t.impressions += r.impressions; t.clicks += r.clicks; t.videoViews += r.videoViews; if (r.conversions != null) t.conversions = (t.conversions || 0) + r.conversions; });
  t.ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0;
  t.cpc = t.clicks > 0 ? t.spend / t.clicks : 0;
  t.cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0;
  t.cpa = t.conversions ? t.spend / t.conversions : 0;
  return t;
}

// Per-campaign totals for [sinceYmd, untilYmd] (inclusive), one request:
// GET /adaccounts/{id}/stats?breakdown=campaign (only available there).
// → { byCampaign: { id: stats }, totals }
async function campaignStats(token, account, sinceYmd, untilYmd, opts) {
  const tz = account.timezone || 'UTC';
  const q = new URLSearchParams({ granularity: 'TOTAL', breakdown: 'campaign', fields: STAT_FIELDS, start_time: zonedMidnight(sinceYmd, tz), end_time: zonedMidnight(addDays(untilYmd, 1), tz) });
  const j = await request(token, 'GET', '/adaccounts/' + encodeURIComponent(account.id) + '/stats?' + q.toString(), undefined, opts);
  const byCampaign = {};
  for (const ts of (j.total_stats || [])) {
    const st = ts && ts.total_stat;
    const list = st && st.breakdown_stats && st.breakdown_stats.campaign;
    (list || []).forEach((row) => { if (row && row.id) byCampaign[String(row.id)] = _stat(row.stats); });
  }
  return { byCampaign, totals: _sum(Object.values(byCampaign)) };
}

// Daily series for one campaign or the whole account (summed over campaigns).
async function dailySeries(token, account, sinceYmd, untilYmd, campaignIds, opts) {
  const tz = account.timezone || 'UTC';
  const byDate = {};
  for (const cid of campaignIds.slice(0, 25)) {
    const q = new URLSearchParams({ granularity: 'DAY', fields: STAT_FIELDS, start_time: zonedMidnight(sinceYmd, tz), end_time: zonedMidnight(addDays(untilYmd, 1), tz) });
    const j = await request(token, 'GET', '/campaigns/' + encodeURIComponent(cid) + '/stats?' + q.toString(), undefined, opts);
    for (const ts of (j.timeseries_stats || [])) {
      const series = (ts && ts.timeseries_stat && ts.timeseries_stat.timeseries) || [];
      series.forEach((d) => {
        const date = String(d.start_time || '').slice(0, 10);
        if (!date) return;
        const s = _stat(d.stats);
        const b = byDate[date] = byDate[date] || { date, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
        b.spend += s.spend; b.impressions += s.impressions; b.clicks += s.clicks; b.conversions += s.conversions || 0;
      });
    }
  }
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function ctaFor(text, goal) {
  const t = String(text || '').toLowerCase();
  const up = String(text || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (WEB_VIEW_CTAS.includes(up)) return up;
  if (/shop|buy|koop|kaufen|achet|order|bestel/.test(t)) return 'SHOP_NOW';
  if (/sign|subscribe|register|aanmeld|inschrijf|join/.test(t)) return 'SIGN_UP';
  if (/book|reserv/.test(t)) return 'BOOK_NOW';
  if (/quote|offerte/.test(t)) return 'REQUEST_QUOTE';
  if (/apply/.test(t)) return 'APPLY_NOW';
  if (/watch|bekijk/.test(t)) return 'WATCH';
  if (/try|probeer/.test(t)) return 'TRY';
  if (/get|claim/.test(t)) return 'GET_NOW';
  return goal === 'Awareness' ? 'MORE' : 'VIEW';
}

module.exports = {
  AUTH_BASE, API, SCOPE, PROVIDER, PROD_REDIRECT, DEV_REDIRECT, MICRO, LIMITS, WEB_VIEW_CTAS, GOAL_CONFIG,
  config, authorizeUrl, exchangeCode, exchangeRedirectUri, refreshAccessToken, checkCredentials, oauthReason, cleanText, request, items, created, listAll, subError, redact, SnapError,
  discoverAccounts, getCampaign, getAdSquad, getAd, updateCampaign, updateAdSquad, updateAd, remove,
  topSnapImage, uploadMedia, zonedMidnight, addDays, campaignStats, dailySeries, ctaFor,
};
