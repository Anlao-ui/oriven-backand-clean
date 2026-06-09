// ═══ AUTH + DATABASE ══════════════════════════════════════════
// Handles: sign up, sign in, sign out, session restore,
//          BrandCore save/load from Supabase.

var _currentUser     = null;
var _onboardingShown = false;
var _postPayment     = false; // True when landing from Stripe ?success=true — suppresses subscription gate

// ── Route helpers ─────────────────────────────────────────────

function _setAppRoute(route){
  try { history.replaceState(null, "", route); } catch(_){}
  // Fire a page_view so Google Ads URL-based conversions trigger on /app
  if(typeof gtag === "function"){
    gtag("event", "page_view", { page_path: route, page_title: document.title });
  }
}

// ── UI helpers ────────────────────────────────────────────────

function showApp(){
  var overlay = document.getElementById("authOverlay");
  var app     = document.querySelector(".app");
  if(overlay) overlay.style.display = "none";
  if(app)     app.style.display     = "";
}

function showAuthPage(){
  var overlay = document.getElementById("authOverlay");
  var app     = document.querySelector(".app");
  if(overlay) overlay.style.display = "flex";
  if(app)     app.style.display     = "none";
}

function switchAuthTab(tab){
  var siForm = document.getElementById("authSigninForm");
  var suForm = document.getElementById("authSignupForm");
  var siTab  = document.getElementById("authTabSignin");
  var suTab  = document.getElementById("authTabSignup");
  var errSi  = document.getElementById("authErrorSi");
  var errSu  = document.getElementById("authErrorSu");
  if(errSi){ errSi.textContent=""; errSi.style.display="none"; }
  if(errSu){ errSu.textContent=""; errSu.style.display="none"; }
  var activeStyle   = "color:var(--gm);border-bottom:2px solid var(--gm);margin-bottom:-1px";
  var inactiveStyle = "color:var(--muted)";
  if(tab === "signin"){
    siForm.style.display = "";
    suForm.style.display = "none";
    if(siTab) siTab.setAttribute("style", siTab.getAttribute("style").replace(/color:[^;]+;border-bottom:[^;]+;margin-bottom:[^;]+|color:[^;]+/,"") + activeStyle);
    if(suTab) suTab.setAttribute("style", suTab.getAttribute("style").replace(/color:[^;]+;border-bottom:[^;]+;margin-bottom:[^;]+|color:[^;]+/,"") + inactiveStyle);
  } else {
    siForm.style.display = "none";
    suForm.style.display = "";
    if(siTab) siTab.setAttribute("style", siTab.getAttribute("style").replace(/color:[^;]+;border-bottom:[^;]+;margin-bottom:[^;]+|color:[^;]+/,"") + inactiveStyle);
    if(suTab) suTab.setAttribute("style", suTab.getAttribute("style").replace(/color:[^;]+;border-bottom:[^;]+;margin-bottom:[^;]+|color:[^;]+/,"") + activeStyle);
  }
}

function showAuthError(formType, msg){
  var id = formType === "signin" ? "authErrorSi" : "authErrorSu";
  var el = document.getElementById(id);
  if(el){ el.textContent = msg; el.style.display = "block"; }
}

function _authMapError(err){
  var msg = (err && err.message) ? err.message : String(err || "");
  if(/invalid login credentials|invalid_credentials/i.test(msg))
    return "Incorrect email or password. Please try again.";
  if(/email not confirmed/i.test(msg))
    return "Please verify your email address before signing in.";
  if(/user already registered|already registered|already in use/i.test(msg))
    return "An account with this email already exists. Try signing in instead.";
  if(/unable to validate email|invalid.*email/i.test(msg))
    return "Please enter a valid email address.";
  if(/password.*at least/i.test(msg))
    return "Password must be at least 6 characters.";
  if(/signup.*disabled|signups.*not allowed/i.test(msg))
    return "Account creation is currently unavailable.";
  if(/too many requests|rate.?limit/i.test(msg))
    return "Too many attempts — please wait a moment and try again.";
  if(/network|failed to fetch/i.test(msg))
    return "Connection error. Please check your internet and try again.";
  return msg || "Something went wrong. Please try again.";
}

function _authClearInputErr(ids){
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.classList.remove("inp-err");
  });
}

function _authMarkInputErr(ids){
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.classList.add("inp-err");
  });
}

function setAuthBtnLoading(btnId, loading){
  var btn = document.getElementById(btnId);
  if(!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : btn.getAttribute("data-label");
}

// ── Sign In ───────────────────────────────────────────────────

async function handleSignIn(){
  var email = (document.getElementById("siEmail").value||"").trim();
  var pass  = document.getElementById("siPass").value||"";
  _authClearInputErr(["siEmail","siPass"]);
  if(!email || !pass){
    showAuthError("signin","Enter your email and password.");
    _authMarkInputErr(!email ? ["siEmail"] : ["siPass"]);
    return;
  }
  var errEl = document.getElementById("authErrorSi");
  if(errEl){ errEl.style.display="none"; }
  var btn = document.getElementById("authSigninBtn");
  if(btn){ btn.disabled=true; btn.textContent="Signing in…"; }
  console.log("[Auth] Signing in:", email);
  try {
    document.activeElement && document.activeElement.blur();
    var result = await SB.auth.signInWithPassword({ email:email, password:pass });
    if(result.error) throw result.error;
    _authClearInputErr(["siEmail","siPass"]);
    console.log("[Auth] Sign in successful:", result.data.user.id);
    await onUserSignedIn(result.data.user);
  } catch(err){
    console.error("[Auth] Sign in error:", err.message);
    showAuthError("signin", _authMapError(err));
    _authMarkInputErr(["siEmail","siPass"]);
    if(btn){ btn.disabled=false; btn.textContent="Sign In"; }
  }
}

// ── Sign Up ───────────────────────────────────────────────────

async function handleSignUp(){
  var firstName = (document.getElementById("suFirst").value||"").trim();
  var lastName  = (document.getElementById("suLast").value||"").trim();
  var email     = (document.getElementById("suEmail").value||"").trim();
  var pass      = document.getElementById("suPass").value||"";
  var phone     = (document.getElementById("suPhone").value||"").trim();
  _authClearInputErr(["suFirst","suEmail","suPass"]);
  if(!firstName || !email || !pass){
    showAuthError("signup","First name, email and password are required.");
    _authMarkInputErr([!firstName?"suFirst":null, !email?"suEmail":null, !pass?"suPass":null].filter(Boolean));
    return;
  }
  if(pass.length < 6){
    showAuthError("signup","Password must be at least 6 characters.");
    _authMarkInputErr(["suPass"]);
    return;
  }
  var errEl = document.getElementById("authErrorSu");
  if(errEl){ errEl.style.display="none"; }
  var btn = document.getElementById("authSignupBtn");
  if(btn){ btn.disabled=true; btn.textContent="Creating account…"; }
  console.log("[Auth] Signing up:", email);
  try {
    var signupResult = await apiFetch("/api/signup", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ firstName, lastName, email, password: pass, phone: phone||null })
    });
    if(!signupResult.ok) throw new Error(signupResult.data.error || "Signup failed");

    document.activeElement && document.activeElement.blur();
    var result = await SB.auth.signInWithPassword({ email, password: pass });
    if(result.error) throw result.error;

    _authClearInputErr(["suFirst","suEmail","suPass"]);
    console.log("[Auth] Account created and signed in:", result.data.user.id);
    await onUserSignedIn(result.data.user);
    trackEvent("created_account", result.data.user);
  } catch(err){
    console.error("[Auth] Sign up error:", err.message);
    showAuthError("signup", _authMapError(err));
    _authMarkInputErr(["suEmail","suPass"]);
    if(btn){ btn.disabled=false; btn.textContent="Create Account"; }
  }
}

// ── Sign Out ──────────────────────────────────────────────────

async function authSignOut(){
  console.log("[Auth] Signing out");
  _currentUser     = null;
  _onboardingShown = false;
  await SB.auth.signOut();
  S.brandCore = null;
  // Clear guest generation flag so user gets a fresh try after logout
  localStorage.removeItem("guestGenerationUsed");
  showGuestLanding();
  toast("Signed out");
}

// ── After sign in: update UI, load BrandCore, show app ───────

async function syncSubscriptionFromDB(){
  if(typeof ORIVEN_DEV !== "undefined" && ORIVEN_DEV){
    if(typeof S !== "undefined" && S) S.currentPlan = "professional";
    if(typeof _updateSidebarPlan === "function") _updateSidebarPlan("professional");
    if(typeof invalidatePlanCache === "function") invalidatePlanCache();
    if(typeof renderPlanPanel === "function") renderPlanPanel();
    return;
  }
  try {
    var sessionResult = await SB.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if(!session) return;
    var result = await apiFetch("/api/get-subscription", {
      headers: { "Authorization": "Bearer " + session.access_token }
    });
    if(!result.ok){ console.warn("[Subscription] GET /api/get-subscription failed:", result.status); return; }
    var data = result.data;
    console.log("[Subscription] Synced from server:", JSON.stringify(data));
    var patch = {};
    if(data.subscription_status){
      S.currentPlan = data.subscription_status;
      patch.currentPlan = data.subscription_status;
    }
    var serverPending     = data.pending_plan      || null;
    var serverPendingDate = data.pending_plan_date || null;
    S.pendingPlan     = serverPending;
    S.pendingPlanDate = serverPendingDate;
    patch.pendingPlan     = serverPending;
    patch.pendingPlanDate = serverPendingDate;
    saveSettings(patch);
    if(typeof _updateSidebarPlan === "function") _updateSidebarPlan(S.currentPlan);
    if(typeof invalidatePlanCache === "function") invalidatePlanCache();
    if(typeof renderPlanPanel === "function") renderPlanPanel();
  } catch(err){
    console.warn("[Subscription] Sync error (non-fatal):", err.message);
  }
}

async function onUserSignedIn(user){
  _currentUser = user;
  linkSessionToUser(user.id);
  console.log("[Auth] User signed in:", user.id);
  updateSidebarUser(user);
  showApp();
  _setAppRoute("/app");
  navigate("dashboard");
  // All background work fires in parallel — none delays the UI
  loadBrandCoreFromDB(user);
  syncSubscriptionFromDB();
  if(typeof initUsageTracking === "function") initUsageTracking(user);
  _loadUserProfile(user);
}

// ── Profile: single consolidated query ───────────────────────

async function _loadUserProfile(user){
  try {
    var result = await SB.from("profiles")
      .select("onboarding_completed, email_verified, created_at, subscription_status, pending_plan, pending_plan_date")
      .eq("id", user.id)
      .maybeSingle();
    if(result.error) throw result.error;
    var data = result.data;

    // Email verification banner
    if(data && !data.email_verified){
      var createdAt   = data.created_at ? new Date(data.created_at) : new Date();
      var daysElapsed = Math.floor((Date.now() - createdAt.getTime()) / (1000*60*60*24));
      var daysLeft    = Math.max(0, 14 - daysElapsed);
      _showVerifyBanner(daysLeft);
    }

    // Subscription sync from DB — dev mode always wins
    if(typeof ORIVEN_DEV !== "undefined" && ORIVEN_DEV){
      S.currentPlan = "professional";
      if(typeof _updateSidebarPlan === "function") _updateSidebarPlan("professional");
      if(typeof invalidatePlanCache === "function") invalidatePlanCache();
      if(typeof renderPlanPanel === "function") renderPlanPanel();
    } else {
      var _dbPlan = data && data.subscription_status;
      var _isPaid = _dbPlan && typeof ORIVEN_PLANS !== "undefined" && ORIVEN_PLANS[_dbPlan];
      if(_isPaid){
        S.currentPlan = _dbPlan;
        saveSettings({ currentPlan: _dbPlan });
        if(typeof _updateSidebarPlan === "function") _updateSidebarPlan(S.currentPlan);
        if(typeof invalidatePlanCache === "function") invalidatePlanCache();
        if(typeof renderPlanPanel === "function") renderPlanPanel();
      } else if(!_postPayment){
        // No valid paid subscription — redirect to plan selection
        window.location.href = "/plan";
        return;
      }
    }

    var completed = data ? data.onboarding_completed === true : false;
    console.log("[Onboarding] Status:", completed ? "completed" : "pending (awaits payment)");
  } catch(err){
    console.error("[Profile] Load error (non-fatal):", err.message);
  }
}

async function markOnboardingComplete(){
  var user = _currentUser;
  if(!user) return;
  console.log("[Onboarding] Marking complete for user:", user.id);
  try {
    var result = await SB.from("profiles")
      .update({ onboarding_completed: true })
      .eq("id", user.id);
    if(result.error) throw result.error;
    console.log("[Onboarding] Marked as complete in database");
  } catch(err){
    console.error("[Onboarding] Mark complete error:", err.message);
  }
}

// ── Onboarding: UI ────────────────────────────────────────────
// 2-step mini onboarding: intro → feature highlights → Enter ORIVEN

var _obStep       = 1;
var _obTotalSteps = 5; // 5 for Starter/Creator, 6 for Professional (Team step)

function _obConfigureSteps(){
  var plan = (typeof S !== "undefined" && S && S.currentPlan) ? S.currentPlan : "free";
  var isProfessionalPlan = (plan === "professional");
  _obTotalSteps = isProfessionalPlan ? 6 : 5;

  // Show/hide Team step and its dot
  var teamStep = document.getElementById("obStep6");
  var teamDot  = document.getElementById("obDot6");
  if(teamStep) teamStep.style.display = isProfessionalPlan ? ""  : "none";
  if(teamDot)  teamDot.style.display  = isProfessionalPlan ? ""  : "none";
}

function showOnboarding(){
  var el = document.getElementById("onboardingOverlay");
  if(!el) return;

  _obConfigureSteps();
  _obStep = 1;

  // Reset all steps
  for(var i = 1; i <= 6; i++){
    var s = document.getElementById("obStep" + i);
    if(s){ s.classList.remove("ob-active","ob-exit"); }
  }

  // Show overlay
  el.style.opacity = "0";
  el.style.display = "flex";
  el.style.transition = "opacity 0.4s ease";
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      el.style.opacity = "1";
      setTimeout(function(){
        var s1 = document.getElementById("obStep1");
        if(s1) s1.classList.add("ob-active");
        _obUpdateNav();
      }, 100);
    });
  });

  _obSetDots(1);
  console.log("[Onboarding] Tour shown — Step 1 of", _obTotalSteps);
}

function hideOnboarding(){
  var el = document.getElementById("onboardingOverlay");
  if(el){
    el.style.transition = "opacity 0.28s ease";
    el.style.opacity = "0";
    setTimeout(function(){
      el.style.display = "none";
      el.style.opacity = "";
      el.style.transition = "";
    }, 300);
  }
}

function _obSetDots(active){
  for(var i = 1; i <= 6; i++){
    var d = document.getElementById("obDot" + i);
    if(!d) continue;
    if(i === active) d.classList.add("ob-dot-active");
    else             d.classList.remove("ob-dot-active");
  }
}

function _obUpdateNav(){
  var backBtn = document.getElementById("obBackBtn");
  var nextBtn = document.getElementById("obNextBtn");
  var isLast  = (_obStep === _obTotalSteps);

  if(backBtn){
    backBtn.style.visibility = _obStep > 1 ? "visible" : "hidden";
  }
  if(nextBtn){
    nextBtn.textContent = isLast ? "Enter ORIVEN →" : "Next →";
    if(isLast){
      nextBtn.classList.add("ob-finish");
      nextBtn.onclick = function(){ obFinish(); };
    } else {
      nextBtn.classList.remove("ob-finish");
      nextBtn.onclick = function(){ obGoTo(_obStep + 1); };
    }
  }
}

function obGoTo(step){
  if(step < 1 || step > _obTotalSteps || step === _obStep) return;

  var prev   = _obStep;
  var prevEl = document.getElementById("obStep" + prev);
  var nextEl = document.getElementById("obStep" + step);

  if(prevEl){ prevEl.classList.add("ob-exit"); prevEl.classList.remove("ob-active"); }

  setTimeout(function(){
    if(prevEl) prevEl.classList.remove("ob-exit");

    if(nextEl){
      nextEl.classList.remove("ob-exit","ob-active");
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){ nextEl.classList.add("ob-active"); });
      });
    }

    _obStep = step;
    _obSetDots(step);
    _obUpdateNav();
    console.log("[Onboarding] Step →", step, "of", _obTotalSteps);
  }, 250);
}

function obFinish(){
  console.log("[Onboarding] Tour complete");
  markOnboardingComplete();
  hideOnboarding();
  setTimeout(function(){
    navigate("dashboard");
  }, 300);
}

// ── Email verification helpers ────────────────────────────────

function _showVerifyBanner(daysLeft){
  var banner = document.getElementById("verifyBanner");
  var text   = document.getElementById("verifyBannerText");
  if(!banner) return;
  if(text){
    var timeStr;
    if(daysLeft <= 0){
      timeStr = " — your account may be removed soon";
    } else if(daysLeft === 1){
      timeStr = " — only 1 day remaining";
    } else if(daysLeft <= 3){
      timeStr = " — only " + daysLeft + " days remaining";
    } else {
      timeStr = " (" + daysLeft + " days remaining)";
    }
    text.textContent = "Please verify your email to keep your account active" + timeStr + ".";
  }
  banner.style.display = "flex";
}

function _hideVerifyBanner(){
  var banner = document.getElementById("verifyBanner");
  if(banner) banner.style.display = "none";
}

async function resendVerificationEmail(){
  var btn = document.getElementById("verifyBannerResend");
  if(btn){ btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    var sessionResult = await SB.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if(!session){ toast("Please sign in first"); return; }
    var result = await apiFetch("/api/resend-verification", {
      method:  "POST",
      headers: { "Authorization": "Bearer " + session.access_token }
    });
    if(!result.ok) throw new Error(result.data.error || "Failed to send");
    toast("Verification email sent — check your inbox");
  } catch(err){
    console.error("[EmailVerify] Resend error:", err.message);
    toast("Could not send — " + err.message, "warn");
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = "Resend Email"; }
  }
}

async function _handleVerifyToken(){
  var params = new URLSearchParams(window.location.search);
  var token  = params.get("verify_token");
  if(!token) return;
  history.replaceState(null, "", window.location.pathname);
  try {
    var result = await apiFetch("/api/verify-email", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ token })
    });
    if(result.ok && result.data.ok){
      _hideVerifyBanner();
      setTimeout(function(){ toast("Email verified — your account is confirmed!"); }, 600);
    } else {
      setTimeout(function(){ toast("Verification link is invalid or already used. Request a new one.", "warn"); }, 600);
    }
  } catch(err){
    console.error("[EmailVerify] Token error:", err.message);
  }
}

function updateSidebarUser(user){
  var meta      = user.user_metadata || {};
  var firstName = meta.first_name || user.email.split("@")[0];
  var initial   = firstName.charAt(0).toUpperCase();
  var nameEl    = document.getElementById("sidebarUserName");
  var dotEl     = document.getElementById("sidebarUserDot");
  if(nameEl) nameEl.textContent = firstName;
  if(dotEl)  dotEl.textContent  = initial;
  // Switch sidebar to authenticated state
  var authEl  = document.getElementById("sbIdentityAuth");
  var guestEl = document.getElementById("sbIdentityGuest");
  if(authEl)  authEl.style.display  = "";
  if(guestEl) guestEl.style.display = "none";
  // Show plan/usage row
  var usageWrap = document.querySelector(".sb-usage-wrap");
  if(usageWrap) usageWrap.style.display = "";
  console.log("[Auth] Sidebar updated for:", firstName);
}

function updateSidebarGuest(){
  var authEl  = document.getElementById("sbIdentityAuth");
  var guestEl = document.getElementById("sbIdentityGuest");
  if(authEl)  authEl.style.display  = "none";
  if(guestEl) guestEl.style.display = "";
  // Hide plan/usage row — not relevant for guests
  var usageWrap = document.querySelector(".sb-usage-wrap");
  if(usageWrap) usageWrap.style.display = "none";
}

// ── BrandCore: save to Supabase ───────────────────────────────

async function saveBCToDB(){
  if(typeof SB === "undefined"){ console.warn("[DB] Supabase not initialized"); return; }
  var userResult = await SB.auth.getUser();
  var user = userResult.data && userResult.data.user;
  if(!user){ console.log("[DB] Not logged in — BrandCore not saved to cloud"); return; }
  if(!S.brandCore){ console.log("[DB] No BrandCore to save"); return; }
  console.log("[DB] Saving BrandCore to Supabase for user:", user.id, "brand:", S.brandCore.name);
  try {
    var result = await SB.from("brand_cores").upsert(
      { user_id: user.id, brand_data: S.brandCore },
      { onConflict: "user_id" }
    );
    if(result.error) throw result.error;
    console.log("[DB] BrandCore saved successfully");
    toast("Brand Core saved to cloud");
  } catch(err){
    console.error("[DB] Save BrandCore error:", err.message);
  }
}

// ── BrandCore: load from Supabase ────────────────────────────

async function loadBrandCoreFromDB(user){
  if(typeof SB === "undefined"){ return; }
  if(!user) user = _currentUser;
  if(!user){
    var userResult = await SB.auth.getUser();
    user = userResult.data && userResult.data.user;
  }
  if(!user) return;
  console.log("[DB] Loading BrandCore from Supabase for user:", user.id);
  try {
    var result = await SB.from("brand_cores")
      .select("brand_data")
      .eq("user_id", user.id)
      .maybeSingle();
    if(result.error) throw result.error;
    if(!result.data){ console.log("[DB] No BrandCore found for user"); return; }
    S.brandCore = result.data.brand_data;
    console.log("[DB] BrandCore loaded:", S.brandCore.name);
    if(typeof refreshBC === "function") refreshBC();
  } catch(err){
    console.error("[DB] Load BrandCore error:", err.message);
  }
}

// ── BrandCore: delete from Supabase ──────────────────────────

async function deleteBCFromDB(){
  if(typeof SB === "undefined"){ return; }
  var userResult = await SB.auth.getUser();
  var user = userResult.data && userResult.data.user;
  if(!user) return;
  console.log("[DB] Deleting BrandCore from Supabase for user:", user.id);
  try {
    var result = await SB.from("brand_cores").delete().eq("user_id", user.id);
    if(result.error) throw result.error;
    console.log("[DB] BrandCore deleted from cloud");
  } catch(err){
    console.error("[DB] Delete BrandCore error:", err.message);
  }
}

// ── Paywall ───────────────────────────────────────────────────

async function checkSubscriptionStatus(){
  if(typeof ORIVEN_DEV !== "undefined" && ORIVEN_DEV){
    if(typeof S !== "undefined" && S) S.currentPlan = "professional";
    return "professional";
  }
  if(typeof SB === "undefined"){
    console.error("[Paywall] SB client not initialized — cannot check subscription");
    return "free";
  }

  // Always fetch a fresh user object — never use a cached value
  var userResult = await SB.auth.getUser();
  var user = userResult.data && userResult.data.user;
  if(!user){
    console.log("[Paywall] No authenticated user — defaulting to free");
    return "free";
  }

  console.log("[Paywall] Fetching LIVE subscription status from Supabase for user:", user.id);

  try {
    var resp = await SB.from("profiles")
      .select("subscription_status")
      .eq("id", user.id)
      .maybeSingle();

    // Always log the raw response so the cause is visible in the console
    var rawData  = resp.data  ? JSON.stringify(resp.data) : "null (no row)";
    var rawError = resp.error ? resp.error.message + " [code: " + resp.error.code + "]" : "none";
    console.log("[Paywall] Supabase response — data:", rawData, "| error:", rawError);

    if(resp.error){
      // Most common causes:
      //   42703 — column does not exist (ALTER TABLE not yet run)
      //   42501 — RLS blocking the SELECT
      console.error("[Paywall] Query failed:", resp.error.message);
      if(resp.error.code === "42703"){
        console.error("[Paywall] FIX: run this in Supabase SQL Editor:\n  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_status text default 'free';");
      }
      return "free"; // fail-safe — never block the user on a DB error
    }

    if(!resp.data){
      // Profile row does not exist — create it so future checks work
      console.warn("[Paywall] No profile row found for user:", user.id, "— upserting defaults");
      var upsert = await SB.from("profiles").upsert(
        { id: user.id, email: user.email, subscription_status: "free", onboarding_completed: false },
        { onConflict: "id" }
      );
      if(upsert.error) console.error("[Paywall] Could not upsert profile:", upsert.error.message);
      return "free";
    }

    // We have a real row — read the value directly, do NOT fall back silently
    var status = resp.data.subscription_status;
    if(!status){
      console.warn("[Paywall] subscription_status is null/empty in DB — treating as free. " +
        "Run the ALTER TABLE SQL, then set it to 'creator' or 'professional' for paid users.");
      return "free";
    }

    var isPaid = status !== "free";
    console.log("[Paywall] subscription_status:", status, "→", isPaid
      ? "✓ SUBSCRIBED — paywall will NOT show"
      : "✗ FREE — paywall will show");
    return status;

  } catch(err){
    console.error("[Paywall] Unexpected JS error:", err.message);
    return "free";
  }
}

async function maybeShowPaywall(){
  console.log("[Paywall] Triggered — checking subscription before showing paywall...");
  var status = await checkSubscriptionStatus();
  if(status !== "free"){
    console.log("[Paywall] Subscribed user (" + status + ") — paywall suppressed");
    return;
  }
  console.log("[Paywall] Free user — opening paywall modal");
  if(typeof openPaywall === "function") openPaywall();
}

function closePaywall(){
  if(typeof closeModal === "function") closeModal("modal-paywall");
  console.log("[Paywall] Dismissed by user");
}

async function selectPlan(plan){
  console.log("[Paywall] Plan selected:", plan);
  var btn = document.querySelector('[onclick="selectPlan(\'' + plan + '\')"]');
  if(btn){ btn.disabled = true; btn.textContent = "Redirecting…"; }

  try {
    var u = S.user || (await SB.auth.getUser()).data.user;
    var result = await apiFetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, userId: u.id, userEmail: u.email, source: 'app' })
    });
    if(!result.ok || !result.data.url) throw new Error(result.data.error || "No checkout URL returned");
    window.location.href = result.data.url;
  } catch(err) {
    console.error("[Paywall] Checkout error:", err);
    toast("Could not start checkout — please try again");
    if(btn){ btn.disabled = false; btn.textContent = btn.getAttribute("data-label") || "Get Started"; }
  }
}

// ── Session restore on page load ─────────────────────────────

document.addEventListener("DOMContentLoaded", async function(){
  trackEvent("visited_site");

  // Capture path before any redirects fire
  var _loadPath = window.location.pathname;

  // Handle email verification token from verify link in email
  await _handleVerifyToken();

  // Handle Stripe return URLs
  var params      = new URLSearchParams(window.location.search);
  var _stripeOk   = params.get("success")  === "true";
  var _stripeBail = params.get("canceled") === "true";
  var _tourParam  = params.get("tour")     === "1";

  if(_stripeOk){
    _postPayment = true;
    history.replaceState(null, "", "/app");
    _loadPath = "/app";
  } else if(_stripeBail){
    history.replaceState(null, "", "/app");
    toast("Checkout canceled — you can upgrade anytime.");
  } else if(_tourParam){
    history.replaceState(null, "", "/app");
    _loadPath = "/app";
  }

  // Hide app immediately — show only after auth confirmed
  var app = document.querySelector(".app");
  if(app) app.style.display = "none";

  console.log("[Auth] Checking existing session... (path:", _loadPath, ")");
  var sessionResult = await SB.auth.getSession();
  var session = sessionResult.data && sessionResult.data.session;

  if(session && session.user){
    console.log("[Auth] Session restored for:", session.user.id);
    await onUserSignedIn(session.user);

    // Fire onboarding tour after payment or dev ?tour=1
    if(_stripeOk){
      setTimeout(async function(){
        await syncSubscriptionFromDB();
        var plan = typeof S !== "undefined" && S && S.currentPlan;
        var hasPaid = plan && typeof ORIVEN_PLANS !== "undefined" && ORIVEN_PLANS[plan];
        if(hasPaid){
          toast("Your subscription is now active — welcome to ORIVEN!");
          setTimeout(function(){ showOnboarding(); }, 600);
        } else {
          // Webhook may not have arrived yet — retry once after a short delay
          toast("Payment received — activating your account...");
          setTimeout(async function(){
            await syncSubscriptionFromDB();
            plan = typeof S !== "undefined" && S && S.currentPlan;
            if(plan && typeof ORIVEN_PLANS !== "undefined" && ORIVEN_PLANS[plan]){
              toast("Your subscription is now active — welcome to ORIVEN!");
              setTimeout(function(){ showOnboarding(); }, 400);
            } else {
              toast("Subscription pending — please refresh in a moment.");
            }
          }, 3000);
        }
      }, 800);
    } else if(_tourParam){
      // Only show tour for users with an active paid subscription
      setTimeout(async function(){
        await syncSubscriptionFromDB();
        var plan = typeof S !== "undefined" && S && S.currentPlan;
        if(plan && typeof ORIVEN_PLANS !== "undefined" && ORIVEN_PLANS[plan]) showOnboarding();
      }, 500);
    }
  } else {
    console.log("[Auth] No session — showing guest landing");
    showGuestLanding();
  }

  // React to future auth changes (e.g. session expiry)
  SB.auth.onAuthStateChange(function(event, _session){
    console.log("[Auth] Auth state change:", event);
    if(event === "SIGNED_OUT"){
      S.brandCore = null;
      showGuestLanding();
    }
  });
});
