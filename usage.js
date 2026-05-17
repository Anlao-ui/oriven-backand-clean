// ════════════════════════════════════════════════════════════════
// USAGE TRACKING — plan limits, monthly quotas
// ════════════════════════════════════════════════════════════════

// ── Plan configuration ────────────────────────────────────────
// Free = 0 generations. The free plan is an exploration tier only.
var PLAN_LIMITS = {
  free:     { limit: 0,   label: "Free",     price: null,  explore: true  },
  starter:  { limit: 50,  label: "Starter",  price: "€19", explore: false },
  premium:  { limit: 200, label: "Premium",  price: "€49", explore: false },
  business: { limit: 400, label: "Business", price: "€99", explore: false }
};

// ── Plan cache — avoids hammering Supabase on every generation ─
var _cachedPlan   = null;
var _planCachedAt = 0;
var _PLAN_TTL     = 5 * 60 * 1000; // 5 minutes

async function _getCachedPlan(){
  var now = Date.now();
  if(_cachedPlan && (now - _planCachedAt) < _PLAN_TTL) return _cachedPlan;
  var plan = "free";
  try {
    if(typeof checkSubscriptionStatus === "function"){
      plan = (await checkSubscriptionStatus()) || "free";
    }
  } catch(_){}
  _cachedPlan   = plan;
  _planCachedAt = Date.now();
  return _cachedPlan;
}

function invalidatePlanCache(){
  _cachedPlan   = null;
  _planCachedAt = 0;
}

// ── Storage key — per-user ────────────────────────────────────
function _usageKey(){
  try { if(S && S.user && S.user.id) return "oriven_usage_" + S.user.id; } catch(_){}
  return "oriven_usage_anon";
}

async function _getAccessToken(){
  try {
    var { data } = await SB.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  } catch(_){ return null; }
}

// ── Sync usage from server ────────────────────────────────────
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

function _readUsage(){
  try { var raw = localStorage.getItem(_usageKey()); return raw ? JSON.parse(raw) : {}; } catch(_){ return {}; }
}
function _writeUsage(data){
  try { localStorage.setItem(_usageKey(), JSON.stringify(data)); } catch(_){}
}

function _today(){ return new Date().toISOString().slice(0, 10); }
function _month(){ return new Date().toISOString().slice(0, 7);  }

function _getCounts(){
  var d     = _readUsage();
  var today = _today();
  var month = _month();
  if(d.dailyDate   !== today){ d.dailyDate  = today; d.dailyCount   = 0; }
  if(d.monthlyKey  !== month){ d.monthlyKey = month; d.monthlyCount = 0; }
  return d;
}

// ── Check whether the user may generate ──────────────────────
// Returns { allowed, message }
async function checkUsageLimit(){
  var plan = await _getCachedPlan();
  var cfg  = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  // Free plan has no generation access
  if(cfg.explore){
    return { allowed: false, message: "upgrade" };
  }

  var used  = _getCounts().monthlyCount;
  var limit = cfg.limit;
  if(used < limit) return { allowed: true, message: "" };

  var msg;
  if(plan === "business"){
    msg = "You've reached your Business monthly limit (" + limit + " generations). Contact us to discuss higher limits.";
  } else {
    msg = "You've reached your " + cfg.label + " monthly limit (" + limit + " generations). Upgrade to continue creating.";
  }
  return { allowed: false, message: msg };
}

// ── Consume one generation unit ───────────────────────────────
function consumeUsage(){
  var d = _getCounts();
  d.dailyCount   = (d.dailyCount   || 0) + 1;
  d.monthlyCount = (d.monthlyCount || 0) + 1;
  _writeUsage(d);
  _refreshUsageUI();
  _getAccessToken().then(function(token){
    if(!token) return;
    fetch(API_BASE_URL + "/api/increment-usage", {
      method: "POST", headers: { "Authorization": "Bearer " + token }
    }).catch(function(){});
  });
}

// ── True when a paid user has used their last credit ─────────
async function isLastFreeCreditUsed(){
  var plan = await _getCachedPlan();
  if(plan === "free" || plan === "business") return false;
  var cfg = PLAN_LIMITS[plan];
  if(!cfg) return false;
  return _getCounts().monthlyCount >= cfg.limit;
}

// ── Combined gate — check then consume ───────────────────────
// Free users → immediate paywall (no feed message, no quota noise).
// Paid users at limit → in-feed message + paywall after delay.
// Returns true if allowed (usage consumed), false if blocked.
async function gateUsage(){
  if(typeof ORIVEN_DEV !== "undefined" && ORIVEN_DEV) return true;

  var plan = await _getCachedPlan();

  // Free plan — exploration only, no generation access
  if((PLAN_LIMITS[plan] || PLAN_LIMITS.free).explore){
    if(typeof openPaywall === "function") openPaywall();
    return false;
  }

  var result = await checkUsageLimit();
  if(!result.allowed){
    _showLimitMessage(result.message);
    setTimeout(function(){ if(typeof openPaywall === "function") openPaywall(); }, 500);
    return false;
  }
  consumeUsage();

  // Soft paywall nudge after last credit for paid plans
  isLastFreeCreditUsed().then(function(isLast){
    if(isLast && typeof showSoftPaywall === "function") setTimeout(showSoftPaywall, 450);
  });

  return true;
}

// ── In-feed limit message ─────────────────────────────────────
function _showLimitMessage(msg){
  var feed = document.getElementById("cwsFeed");
  if(!feed){ if(typeof toast === "function") toast("Upgrade to continue creating", "warn"); return; }

  var prev = feed.querySelector(".usage-limit-msg");
  if(prev) prev.remove();

  var el = document.createElement("div");
  el.className = "usage-limit-msg";
  el.innerHTML =
    '<div class="usage-limit-inner">' +
      '<div class="usage-limit-icon">' +
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8.5"/><path d="M10 6v5" stroke-linecap="round"/><circle cx="10" cy="14" r=".6" fill="currentColor"/></svg>' +
      '</div>' +
      '<div class="usage-limit-text">' +
        '<div class="usage-limit-title">Creative limit reached</div>' +
        '<div class="usage-limit-sub">' + msg + '</div>' +
      '</div>' +
      '<button class="btn btn-p btn-sm usage-limit-cta" onclick="openPaywall()">Upgrade</button>' +
    '</div>';
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ── Sidebar usage badge ───────────────────────────────────────
async function _refreshUsageUI(){
  var badge     = document.getElementById("usageBadge");
  var planLabel = document.getElementById("sbPlanLabel");
  if(!badge) return;

  var plan = await _getCachedPlan();
  var cfg  = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  if(cfg.explore){
    badge.textContent = "Explore mode";
    badge.className   = "usage-badge usage-badge-free";
    if(planLabel){ planLabel.textContent = "Explore"; planLabel.className = "sb-plan-label sb-plan-free"; }
    return;
  }

  var used = _getCounts().monthlyCount;
  var rem  = Math.max(0, cfg.limit - used);
  var cls  = rem === 0 ? "usage-badge-empty" : rem <= Math.ceil(cfg.limit * 0.1) ? "usage-badge-low" : "usage-badge-ok";

  badge.textContent = used + " of " + cfg.limit + " used";
  badge.className   = "usage-badge " + cls;
  if(planLabel){ planLabel.textContent = cfg.label; planLabel.className = "sb-plan-label sb-plan-" + plan; }
}

// ── Team nav — Business only ──────────────────────────────────
async function updateTeamNavVisibility(){
  var plan    = await _getCachedPlan();
  var teamNav = document.getElementById("teamNavItem");
  if(teamNav) teamNav.style.display = plan === "business" ? "" : "none";
}

// ── Called from auth.js after sign-in ────────────────────────
function initUsageTracking(user){
  if(user && user.id){ if(!S.user) S.user = {}; S.user.id = user.id; }
  invalidatePlanCache();
  _syncUsageFromServer().then(function(){ _refreshUsageUI(); updateTeamNavVisibility(); });
}

document.addEventListener("DOMContentLoaded", function(){ setTimeout(_refreshUsageUI, 1600); });
