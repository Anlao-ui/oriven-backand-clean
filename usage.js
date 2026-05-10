// ════════════════════════════════════════════════════════════════
// USAGE TRACKING — plan limits, daily / monthly quotas
// ════════════════════════════════════════════════════════════════

// ── Plan limit configuration ─────────────────────────────────
// type "daily"   → resets every calendar day (Free plan)
// type "monthly" → resets every calendar month (paid plans)
var PLAN_LIMITS = {
  free:     { type: "monthly", limit: 1,   label: "Free"     },
  starter:  { type: "monthly", limit: 50,  label: "Starter"  },
  premium:  { type: "monthly", limit: 200, label: "Premium"  },
  business: { type: "monthly", limit: 400, label: "Business" }
};

// ── Plan cache ────────────────────────────────────────────────
// Avoids hammering Supabase on every generation
var _cachedPlan  = null;
var _planCachedAt = 0;
var _PLAN_TTL    = 5 * 60 * 1000; // 5 minutes

async function _getCachedPlan(){
  var now = Date.now();
  if(_cachedPlan && (now - _planCachedAt) < _PLAN_TTL){
    return _cachedPlan;
  }
  var plan = "free";
  try {
    if(typeof checkSubscriptionStatus === "function"){
      plan = (await checkSubscriptionStatus()) || "free";
    }
  } catch(_){}
  _cachedPlan  = plan;
  _planCachedAt = Date.now();
  return _cachedPlan;
}

function invalidatePlanCache(){
  _cachedPlan  = null;
  _planCachedAt = 0;
}

// ── Storage key — per-user so multi-account machines work ────
function _usageKey(){
  try {
    if(S && S.user && S.user.id) return "oriven_usage_" + S.user.id;
  } catch(_){}
  return "oriven_usage_anon";
}

// ── Get current session access token ─────────────────────────
async function _getAccessToken(){
  try {
    var { data } = await SB.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  } catch(_){ return null; }
}

// ── Sync usage from server into localStorage ──────────────────
async function _syncUsageFromServer(){
  var token = await _getAccessToken();
  if(!token) return;
  try {
    var resp = await fetch(API_BASE_URL + "/api/get-usage", {
      headers: { "Authorization": "Bearer " + token }
    });
    if(!resp.ok) return;
    var data = await resp.json();
    var d = _readUsage();
    d.monthlyKey   = data.monthly_key;
    d.monthlyCount = data.monthly_count;
    d.dailyDate    = data.daily_key;
    d.dailyCount   = data.daily_count;
    _writeUsage(d);
  } catch(_){}
}

// ── Read / write usage record from localStorage ───────────────
function _readUsage(){
  try {
    var raw = localStorage.getItem(_usageKey());
    return raw ? JSON.parse(raw) : {};
  } catch(_){ return {}; }
}

function _writeUsage(data){
  try { localStorage.setItem(_usageKey(), JSON.stringify(data)); } catch(_){}
}

// ── Get today / this-month strings ───────────────────────────
function _today(){ return new Date().toISOString().slice(0, 10); }   // "YYYY-MM-DD"
function _month(){ return new Date().toISOString().slice(0, 7);  }   // "YYYY-MM"

// ── Normalised counts — auto-reset if date bucket changed ────
function _getCounts(){
  var d     = _readUsage();
  var today = _today();
  var month = _month();

  if(d.dailyDate !== today){
    d.dailyDate  = today;
    d.dailyCount = 0;
  }
  if(d.monthlyKey !== month){
    d.monthlyKey   = month;
    d.monthlyCount = 0;
  }
  return d;
}

// ── Public: check whether the current user may generate ───────
// Returns { allowed: boolean, message: string }
async function checkUsageLimit(){
  var plan = await _getCachedPlan();
  var cfg  = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  var d    = _getCounts();

  var used  = cfg.type === "daily" ? d.dailyCount : d.monthlyCount;
  var limit = cfg.limit;

  if(used < limit){
    return { allowed: true, message: "" };
  }

  var msg;
  if(plan === "free"){
    msg = "Free plan limit reached — 1 generation per month is included. Upgrade to continue.";
  } else if(plan === "business"){
    msg = "You've reached the " + cfg.label + " monthly limit (" + limit + " generations). Contact us to discuss higher limits.";
  } else {
    msg = "You've reached the " + cfg.label + " monthly limit (" + limit + " generations). Upgrade your plan for more.";
  }

  return { allowed: false, message: msg };
}

// ── Public: consume one unit (call AFTER a successful gate check)
function consumeUsage(){
  var d = _getCounts();
  d.dailyCount   = (d.dailyCount   || 0) + 1;
  d.monthlyCount = (d.monthlyCount || 0) + 1;
  _writeUsage(d);
  _refreshUsageUI();
  // Fire-and-forget server increment (best-effort)
  _getAccessToken().then(function(token){
    if(!token) return;
    fetch(API_BASE_URL + "/api/increment-usage", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token }
    }).catch(function(){});
  });
}

// ── Public: true when all free credits are now consumed ───────
async function isLastFreeCreditUsed(){
  var plan = await _getCachedPlan();
  if(plan !== "free") return false;
  var d = _getCounts();
  return d.monthlyCount >= PLAN_LIMITS.free.limit;
}

// ── Public: combined gate — check then consume ─────────────────
// Returns true if generation is allowed (and usage consumed).
// Returns false and shows an in-feed message if blocked.
async function gateUsage(){
  var result = await checkUsageLimit();
  if(!result.allowed){
    _showLimitMessage(result.message);
    // Show soft paywall for free users who hit the wall mid-session
    if((_cachedPlan || "free") === "free" && typeof showSoftPaywall === "function"){
      setTimeout(showSoftPaywall, 400);
    }
    return false;
  }
  consumeUsage();
  return true;
}

// ── Show limit message inside the create-workspace feed ────────
function _showLimitMessage(msg){
  var feed = document.getElementById("cwsFeed");
  if(!feed){
    if(typeof toast === "function") toast(msg, "warn");
    return;
  }

  // Remove any previous limit message so it doesn't stack
  var prev = feed.querySelector(".usage-limit-msg");
  if(prev) prev.remove();

  var el = document.createElement("div");
  el.className = "usage-limit-msg";
  el.innerHTML =
    '<div class="usage-limit-inner">' +
      '<div class="usage-limit-icon">' +
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">' +
          '<circle cx="10" cy="10" r="8.5"/>' +
          '<path d="M10 6v5" stroke-linecap="round"/>' +
          '<circle cx="10" cy="14" r=".6" fill="currentColor"/>' +
        '</svg>' +
      '</div>' +
      '<div class="usage-limit-text">' +
        '<div class="usage-limit-title">Generation limit reached</div>' +
        '<div class="usage-limit-sub">' + msg + '</div>' +
      '</div>' +
      '<button class="btn btn-p btn-sm usage-limit-cta" onclick="openPaywall()">Upgrade</button>' +
    '</div>';
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ── Refresh the usage badge in the sidebar ────────────────────
async function _refreshUsageUI(){
  var badge = document.getElementById("usageBadge");
  if(!badge) return;

  var plan = await _getCachedPlan();
  var cfg  = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  var d    = _getCounts();
  var used = cfg.type === "daily" ? d.dailyCount : d.monthlyCount;
  var rem  = Math.max(0, cfg.limit - used);

  var label, cls;
  if(cfg.type === "daily"){
    label = rem > 0 ? rem + " left today" : "Limit reached";
    cls   = rem > 0 ? "usage-badge-ok" : "usage-badge-empty";
  } else {
    label = used + " of " + cfg.limit + " used this month";
    cls   = rem === 0 ? "usage-badge-empty" : rem <= Math.ceil(cfg.limit * 0.1) ? "usage-badge-low" : "usage-badge-ok";
  }

  badge.textContent = label;
  badge.className   = "usage-badge " + cls;

  // Also show the plan name in the plan-label span if it exists
  var planLabel = document.getElementById("sbPlanLabel");
  if(planLabel){
    planLabel.textContent = cfg.label;
    planLabel.className   = "sb-plan-label sb-plan-" + plan;
  }
}

// ── Team nav visibility: Business only ────────────────────────
async function updateTeamNavVisibility(){
  var plan    = await _getCachedPlan();
  var teamNav = document.getElementById("teamNavItem");
  if(teamNav){
    teamNav.style.display = plan === "business" ? "" : "none";
  }
}

// ── Called from auth.js after sign-in ─────────────────────────
function initUsageTracking(user){
  if(user && user.id){
    if(!S.user) S.user = {};
    S.user.id = user.id;
  }
  invalidatePlanCache();
  // Sync from server first, then refresh UI
  _syncUsageFromServer().then(function(){
    _refreshUsageUI();
    updateTeamNavVisibility();
  });
}

// ── Boot: refresh UI once DOM is ready (before auth, best-effort)
document.addEventListener("DOMContentLoaded", function(){
  setTimeout(_refreshUsageUI, 1600);
});
