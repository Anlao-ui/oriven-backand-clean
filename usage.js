// ════════════════════════════════════════════════════════════════
// USAGE TRACKING — plan limits, monthly quotas
// ════════════════════════════════════════════════════════════════

// Plan limits and labels come from ORIVEN_PLANS (plans.js).
// usage.js references ORIVEN_PLANS[plan] directly — no separate copy.

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

// ── Check whether the user may generate (credit-aware) ───────
// creditCost: how many credits this generation consumes (default 1)
// Returns { allowed, message }
async function checkUsageLimit(creditCost){
  var cost = creditCost || 1;
  var plan = await _getCachedPlan();
  var cfg  = ORIVEN_PLANS[plan];

  if(!cfg) return { allowed: false, message: "upgrade" };

  var used      = _getCounts().monthlyCount;
  var total     = cfg.credits || cfg.limit;
  var remaining = Math.max(0, total - used);

  if(remaining >= cost) return { allowed: true, message: "" };

  var msg;
  if(remaining === 0){
    msg = "You've used all " + total + " credits on your " + cfg.name + " plan this month. Upgrade to keep creating.";
  } else {
    msg = "This generation costs " + cost + " credit" + (cost !== 1 ? "s" : "") +
          ", but you only have " + remaining + " remaining. Upgrade to continue.";
  }
  return { allowed: false, message: msg };
}

// ── Consume credits ───────────────────────────────────────────
// amount: credits to deduct (default 1)
function consumeUsage(amount){
  var n = amount || 1;
  var d = _getCounts();
  d.dailyCount   = (d.dailyCount   || 0) + n;
  d.monthlyCount = (d.monthlyCount || 0) + n;
  _writeUsage(d);
  _refreshUsageUI();
  _getAccessToken().then(function(token){
    if(!token) return;
    fetch(API_BASE_URL + "/api/increment-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ count: n })
    }).catch(function(){});
  });
}

// ── True when remaining credits are below minimum ─────────────
async function isLastFreeCreditUsed(){
  var plan = await _getCachedPlan();
  if(!ORIVEN_PLANS[plan] || plan === "professional") return false;
  var cfg = ORIVEN_PLANS[plan];
  if(!cfg) return false;
  var total = cfg.credits || cfg.limit;
  return _getCounts().monthlyCount >= total;
}

// ── Combined gate — check then consume ───────────────────────
// creditCost: credits required for this generation (default 1)
// Returns true if generation is allowed (credits deducted), false if blocked.
async function gateUsage(creditCost){
  if(typeof ORIVEN_DEV !== "undefined" && ORIVEN_DEV) return true;

  var cost = creditCost || 1;
  var plan = await _getCachedPlan();

  if(!ORIVEN_PLANS[plan]){
    if(typeof openPaywall === "function") openPaywall();
    return false;
  }

  var result = await checkUsageLimit(cost);
  if(!result.allowed){
    _showLimitMessage(result.message);
    setTimeout(function(){ if(typeof openPaywall === "function") openPaywall(); }, 500);
    return false;
  }
  consumeUsage(cost);

  isLastFreeCreditUsed().then(function(isLast){
    if(isLast && typeof showSoftPaywall === "function") setTimeout(showSoftPaywall, 450);
  });

  return true;
}

// ── In-feed limit message ─────────────────────────────────────
function _showLimitMessage(msg){
  var feed = document.getElementById("cwsFeed");
  if(!feed){ if(typeof toast === "function") toast("Credit limit reached — upgrade to continue", "warn"); return; }

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
        '<div class="usage-limit-title">Monthly credit limit reached</div>' +
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
  var cfg  = ORIVEN_PLANS[plan];

  if(!cfg){
    badge.textContent = "No Subscription";
    badge.className   = "usage-badge usage-badge-free";
    if(planLabel){ planLabel.textContent = "No Subscription"; planLabel.className = "sb-plan-label sb-plan-free"; }
    return;
  }

  var used  = _getCounts().monthlyCount;
  var total = cfg.credits || cfg.limit;
  var rem   = Math.max(0, total - used);
  var cls   = rem === 0 ? "usage-badge-empty" : rem <= Math.ceil(total * 0.1) ? "usage-badge-low" : "usage-badge-ok";

  badge.textContent = rem + " credits left";
  badge.className   = "usage-badge " + cls;
  if(planLabel){ planLabel.textContent = cfg.name; planLabel.className = "sb-plan-label sb-plan-" + plan; }
}

// ── Team nav — Professional only ──────────────────────────────
async function updateTeamNavVisibility(){
  var plan    = await _getCachedPlan();
  var teamNav = document.getElementById("teamNavItem");
  if(teamNav) teamNav.style.display = plan === "professional" ? "" : "none";
}

// ── Called from auth.js after sign-in ────────────────────────
function initUsageTracking(user){
  if(user && user.id){ if(!S.user) S.user = {}; S.user.id = user.id; }
  invalidatePlanCache();
  _syncUsageFromServer().then(function(){ _refreshUsageUI(); updateTeamNavVisibility(); });
}

document.addEventListener("DOMContentLoaded", function(){ setTimeout(_refreshUsageUI, 1600); });
