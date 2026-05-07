// ════════════════════════════════════════════════════════════
// GUEST FLOW — try-before-signup experience
// Journey: Welcome → BrandCore setup → view BrandCore → Signup CTA
// Guests always start fresh — no localStorage, no prior state
// ════════════════════════════════════════════════════════════

var _isGuestMode          = false;
var _guestBCGenerated     = false;   // true once BrandCore is generated this session
var _guestLastImageUrl    = null;
var _guestGenerating      = false;
var _originalNavigate     = null;
var _originalOpenModal    = null;
var _originalSaveBCToDB   = null;
var _originalOpenAIFlow   = null;
var _guestPopstateHandler = null;
var _guestCreateType      = "image"; // "image" | "campaign" | "copy"
var _guestAdCount         = 1;       // 1 | 3 | 5 (campaign only)
var _savedGT_STEPS        = null;
var _savedGT_TOTAL        = null;

// ── Entry point (called from auth.js on no-session + on signout) ──

function showGuestLanding(){
  _isGuestMode      = true;
  _guestBCGenerated = false;
  _guestGenerating  = false;
  _guestLastImageUrl = null;

  showApp();
  document.body.classList.add("guest-mode");
  if(typeof _setAppRoute === "function") _setAppRoute("/onboarding");
  if(typeof updateSidebarGuest === "function") updateSidebarGuest();

  // Block payment / upgrade modals — guests never see pricing
  if(typeof showSoftPaywall === "function"){
    var _origSSP = showSoftPaywall;
    showSoftPaywall = function(){ if(_isGuestMode) return; return _origSSP.apply(this,arguments); };
  }
  if(typeof _showUpgradeBar === "function"){
    var _origSUB = _showUpgradeBar;
    _showUpgradeBar = function(){ if(_isGuestMode) return; return _origSUB.apply(this,arguments); };
  }
  if(typeof openModal === "function" && !_originalOpenModal){
    _originalOpenModal = openModal;
    openModal = function(id){
      if(_isGuestMode && id === "modal-paywall") return;
      return _originalOpenModal.apply(this,arguments);
    };
  }

  // Patch navigate() — pre-gen: studio open; post-gen: everything locked
  if(typeof navigate === "function" && !_originalNavigate){
    _originalNavigate = navigate;
    navigate = function(page){
      var locked = _guestBCGenerated
        ? ["dashboard","create","inspiration","settings","usage","team","studio"]
        : ["dashboard","create","inspiration","settings","usage","team"];
      if(_isGuestMode && locked.indexOf(page) !== -1){
        // Back button on page-builder calls navigate('create') — redirect to studio instead
        var builderPage = document.getElementById("page-builder");
        if(page === "create" && builderPage && builderPage.classList.contains("active")){
          _originalNavigate("studio");
          return;
        }
        _showGuestLockScreen(page);
        return;
      }
      _originalNavigate(page);
    };
  }

  // Patch saveBCToDB — fires after BrandCore is generated or manually saved
  if(typeof saveBCToDB === "function" && !_originalSaveBCToDB){
    _originalSaveBCToDB = saveBCToDB;
    saveBCToDB = function(){
      if(_isGuestMode){
        clearInterval(_gbeLoadTimer);
        var gbeEl = document.getElementById("guestBCEntry");
        if(gbeEl){
          gbeEl.style.transition = "opacity 0.4s ease";
          gbeEl.style.opacity    = "0";
          setTimeout(function(){ gbeEl.style.display = "none"; }, 420);
        }
        var bsEl = document.getElementById("brandSetup");
        if(bsEl && bsEl.style.display !== "none"){
          bsEl.style.transition = "opacity 0.35s ease";
          bsEl.style.opacity    = "0";
          setTimeout(function(){ bsEl.style.display = "none"; }, 380);
        }
        // Call original to render BrandCore UI; Supabase auth error is suppressed
        try {
          var r = _originalSaveBCToDB.apply(this,arguments);
          if(r && typeof r.then === "function") r.catch(function(){});
        } catch(_){}
        _guestBCGenerated = true;
        _guestExtendTabGuard();
        setTimeout(function(){ _guestAutoGenerateLogo(); }, 600);
        setTimeout(function(){ _showGuestCTA(); }, 3000);
        return;
      }
      return _originalSaveBCToDB.apply(this,arguments);
    };
  }

  _guestInstallTabGuard();

  // Load Studio/BrandCore silently in the background — ready when overlay dismisses
  navigate("studio");
  setTimeout(function(){
    if(typeof switchStudioTab === "function") switchStudioTab("brandcore");
    var emptyEl = document.getElementById("stBCEmpty");
    if(emptyEl) emptyEl.style.display = "none";
  }, 80);

  // Landing overlay — user sees this first
  _guestShowEntry();
}

function hideGuestLanding(){}

// ── Welcome screen ────────────────────────────────────────────

function _guestShowEntry(){
  var overlay = document.getElementById("guestOnboard");
  if(!overlay) return;
  overlay.style.display    = "flex";
  overlay.style.opacity    = "0";
  overlay.style.transition = "";
  requestAnimationFrame(function(){
    overlay.style.transition = "opacity 0.4s ease";
    overlay.style.opacity    = "1";
  });
}

function _guestOnboardTryFree(){
  var overlay = document.getElementById("guestOnboard");
  if(overlay){
    overlay.style.transition = "opacity 0.4s ease";
    overlay.style.opacity    = "0";
    setTimeout(function(){ overlay.style.display = "none"; }, 400);
  }
  setTimeout(function(){
    _gbeShowState("choose");
    var bcEntry = document.getElementById("guestBCEntry");
    if(bcEntry){
      bcEntry.style.display    = "flex";
      bcEntry.style.opacity    = "0";
      bcEntry.style.transition = "";
      requestAnimationFrame(function(){
        bcEntry.style.transition = "opacity 0.45s ease";
        bcEntry.style.opacity    = "1";
      });
    }
  }, 350);
}

function _guestOnboardLogin(){
  var overlay = document.getElementById("guestOnboard");
  if(overlay){
    overlay.style.transition = "opacity 0.25s ease";
    overlay.style.opacity    = "0";
    setTimeout(function(){ overlay.style.display = "none"; }, 250);
  }
  setTimeout(function(){ _showGuestGate("login"); }, 200);
}

// ── Tab guard ─────────────────────────────────────────────────

function _guestInstallTabGuard(){
  var locked = ["dashboard","create","inspiration","settings","usage","team"];
  document.querySelectorAll(".ni[data-page]").forEach(function(ni){
    if(locked.indexOf(ni.dataset.page) !== -1){
      ni.addEventListener("click", _guestTabGuardHandler, true);
    }
  });
}

function _guestTabGuardHandler(e){
  if(!_isGuestMode) return;
  e.stopPropagation();
  e.preventDefault();
  _showGuestLockScreen(this.dataset.page);
}

// After BrandCore is generated: studio sidebar item also gets locked
function _guestExtendTabGuard(){
  var allLocked = ["dashboard","create","inspiration","settings","usage","team","studio"];
  document.querySelectorAll(".ni[data-page]").forEach(function(ni){
    if(allLocked.indexOf(ni.dataset.page) !== -1){
      ni.removeEventListener("click", _guestTabGuardHandler, true);
      ni.addEventListener("click", _guestTabGuardHandler, true);
    }
  });
  // Block browser back button
  _guestPopstateHandler = function(){
    if(_isGuestMode && _guestBCGenerated){
      window.history.pushState(null, null, window.location.href);
    }
  };
  window.history.pushState(null, null, window.location.href);
  window.addEventListener("popstate", _guestPopstateHandler);
}

function _guestRemoveTabGuard(){
  var allLocked = ["dashboard","create","inspiration","settings","usage","team","studio"];
  document.querySelectorAll(".ni[data-page]").forEach(function(ni){
    if(allLocked.indexOf(ni.dataset.page) !== -1){
      ni.removeEventListener("click", _guestTabGuardHandler, true);
    }
  });
  if(_guestPopstateHandler){
    window.removeEventListener("popstate", _guestPopstateHandler);
    _guestPopstateHandler = null;
  }
}

// ── CTA bar — non-blocking bottom strip ──────────────────────

function _showGuestCTA(){
  var cta = document.getElementById("guestCTA");
  if(!cta) return;
  cta.style.display    = "flex";
  cta.style.opacity    = "0";
  cta.style.transition = "";
  requestAnimationFrame(function(){
    cta.style.transition = "opacity 0.5s ease";
    cta.style.opacity    = "1";
  });
}

// ── Create Modal ──────────────────────────────────────────────

function _guestShowCreateModal(){
  _guestAdCount = 1;
  _guestSetType("image");
  var modal = document.getElementById("guestCreateModal");
  if(!modal) return;
  modal.style.display    = "flex";
  modal.style.opacity    = "0";
  modal.style.transition = "";
  requestAnimationFrame(function(){
    modal.style.transition = "opacity 0.3s ease";
    modal.style.opacity    = "1";
  });
  var inp = document.getElementById("gcInput");
  if(inp){ inp.value = ""; setTimeout(function(){ inp.focus(); }, 350); }
  var resultArea = document.getElementById("gcResultArea");
  if(resultArea) resultArea.style.display = "none";
  var gcGate = document.getElementById("gcGate");
  if(gcGate) gcGate.style.display = "none";
  var gcFooter = document.querySelector("#guestCreateModal .gcm-footer");
  if(gcFooter) gcFooter.style.display = "";
}

function _guestCreateBack(){
  var modal = document.getElementById("guestCreateModal");
  if(modal){ modal.style.opacity = "0"; setTimeout(function(){ modal.style.display = "none"; }, 280); }
}

// ── Type selection ────────────────────────────────────────────

function _guestSetType(type){
  _guestCreateType = type;
  document.querySelectorAll(".gcm-type-chip").forEach(function(c){
    c.classList.toggle("gcm-type-chip-on", c.dataset.type === type);
  });
  var countRow = document.getElementById("gcCampaignCount");
  if(countRow) countRow.style.display = type === "campaign" ? "" : "none";
  var inp = document.getElementById("gcInput");
  var placeholders = {
    image:    "e.g. A clean product shot for a skincare brand…",
    campaign: "e.g. Summer launch for an eco clothing brand…",
    copy:     "e.g. Product description for a premium coffee brand…"
  };
  if(inp) inp.placeholder = placeholders[type] || "";
  var label = document.getElementById("gcGenLabel");
  var labels = { image:"Generate image", campaign:"Generate campaign", copy:"Generate copy" };
  if(label) label.textContent = labels[type] || "Generate";
}

function _guestSetAdCount(n){
  _guestAdCount = n;
  document.querySelectorAll(".gcm-count-btn").forEach(function(b){
    b.classList.toggle("gcm-count-btn-on", parseInt(b.dataset.count,10) === n);
  });
}

// ── Generation (create page) ──────────────────────────────────

async function _guestGenerate(){
  if(_guestGenerating) return;

  var inputEl = document.getElementById("gcInput");
  var prompt  = inputEl ? inputEl.value.trim() : "";

  if(!prompt){
    if(inputEl){
      inputEl.style.transition  = "border-color 0.15s";
      inputEl.style.borderColor = "var(--gm)";
      setTimeout(function(){ inputEl.style.borderColor = ""; }, 1200);
    }
    return;
  }

  if(_guestBCGenerated){ _showGuestGate("signup"); return; }

  _guestGenerating = true;

  var btn        = document.getElementById("gcGenBtn");
  var labelEl    = document.getElementById("gcGenLabel");
  var resultArea = document.getElementById("gcResultArea");
  var resultImg  = document.getElementById("gcResultImg");

  if(btn)        btn.disabled        = true;
  if(labelEl)    labelEl.textContent = "Generating…";
  if(inputEl)    inputEl.disabled    = true;
  if(resultArea) resultArea.style.display = "";

  var secEl     = document.getElementById("gcSecondaryResult");
  var secTextEl = document.getElementById("gcSecondaryText");
  if(secEl) secEl.style.display = "none";

  if(resultImg){
    resultImg.innerHTML =
      '<div class="gl-generating">'
      + '<div class="gl-gen-dots"><span></span><span></span><span></span></div>'
      + '<span>Creating your result…</span>'
      + '</div>';
  }

  try {
    if(_guestCreateType === "image"){
      await _guestGenerateImage(prompt, resultImg, secEl, secTextEl, labelEl);
    } else if(_guestCreateType === "campaign"){
      await _guestGenerateCampaign(prompt, resultImg, labelEl);
    } else {
      await _guestGenerateText(prompt, resultImg, labelEl);
    }
  } catch(err){
    console.error("[Guest] Generation error:", err);
    _guestResetAfterError();
  }
}

async function _guestGenerateImage(prompt, resultImg, secEl, secTextEl, labelEl){
  var res  = await fetch(API_BASE_URL + "/api/generate-image", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      prompt: prompt + ". Professional, high-quality, clean visual. No watermarks.",
      size: "1024x1024", type: "image", imageFormat: "1:1"
    })
  });
  var data = await res.json();
  if(!data || !data.imageUrl){ _guestResetAfterError(); return; }
  _guestLastImageUrl = data.imageUrl;
  if(resultImg){
    resultImg.innerHTML = '<img src="' + data.imageUrl + '" alt="Your creation" style="width:100%;display:block;border-radius:12px">';
  }
  if(labelEl) labelEl.textContent = "Adding caption…";
  if(secEl && secTextEl){
    secEl.style.display = "";
    secTextEl.innerHTML = '<span class="gl-gen-dots" style="display:inline-flex;gap:4px"><span></span><span></span><span></span></span>';
  }
  try {
    var textRes  = await fetch(API_BASE_URL + "/api/generate-text", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        prompt: "Write one short punchy social media caption (max 2 sentences) for: " + prompt,
        type: "captions"
      })
    });
    var textData = await textRes.json();
    if(textData && textData.result && secTextEl) secTextEl.textContent = textData.result;
    else if(secEl) secEl.style.display = "none";
  } catch(e){ if(secEl) secEl.style.display = "none"; }
  setTimeout(function(){ _showGcGate(data.imageUrl); }, 2500);
}

async function _guestGenerateCampaign(prompt, resultImg, labelEl){
  var count = _guestAdCount || 1;
  if(labelEl) labelEl.textContent = "Building campaign…";
  if(resultImg){
    resultImg.innerHTML =
      '<div class="gl-generating"><div class="gl-gen-dots"><span></span><span></span><span></span></div>'
      + '<span>Generating ' + count + ' ad' + (count > 1 ? 's' : '') + ' with images…</span></div>';
  }
  var campPrompt =
    "Generate exactly " + count + " campaign ad variation" + (count > 1 ? "s" : "") + " for: " + prompt
    + ". Each: punchy headline (max 10 words), conversion-focused body (2 sentences max), short CTA (max 4 words),"
    + " and a vivid 120-character text-free DALL-E 3 image prompt for the ad visual.";
  var res  = await fetch(API_BASE_URL + "/api/generate-campaign", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ prompt: campPrompt, size: "1024x1024" })
  });
  var data = await res.json();
  if(!data || !data.variations || !data.variations.length){ _guestResetAfterError(); return; }
  if(resultImg){
    var html = '<div class="gcm-camp-list">';
    data.variations.forEach(function(v, i){
      html += '<div class="gcm-camp-card">';
      if(v.imageUrl) html += '<img class="gcm-camp-img" src="' + _guestEsc(v.imageUrl) + '" alt="Ad ' + (i+1) + '">';
      html += '<div class="gcm-camp-body"><div class="gcm-camp-num">Ad ' + (i+1) + '</div>';
      if(v.headline) html += '<div class="gcm-camp-headline">' + _guestEsc(v.headline) + '</div>';
      if(v.body)     html += '<div class="gcm-camp-text">'     + _guestEsc(v.body)     + '</div>';
      if(v.cta)      html += '<div class="gcm-camp-cta-row"><span class="gcm-camp-cta">' + _guestEsc(v.cta) + '</span></div>';
      html += '</div></div>';
    });
    html += '</div>';
    resultImg.innerHTML = html;
  }
  setTimeout(function(){ _showGcGate(); }, 2500);
}

async function _guestGenerateText(prompt, resultImg, labelEl){
  var count = _guestAdCount || 1;
  var textPrompts = {
    campaign: "Generate " + count + " ad" + (count > 1 ? "s" : "") + " for: " + prompt
              + ". Each ad: one punchy headline + one body sentence. Number them. Keep each ad short and conversion-focused.",
    copy:     "Write engaging copy for: " + prompt
              + ". Include a headline, a short subheadline, and 2–3 benefit-focused bullet points."
  };
  var textPrompt = textPrompts[_guestCreateType] || textPrompts.copy;
  var res  = await fetch(API_BASE_URL + "/api/generate-text", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ prompt: textPrompt, type: _guestCreateType })
  });
  var data = await res.json();
  if(!data || !data.result){ _guestResetAfterError(); return; }
  if(resultImg){
    resultImg.innerHTML =
      '<div style="padding:20px 18px;font-size:13.5px;line-height:1.8;color:rgba(240,237,230,0.82);white-space:pre-wrap;font-family:inherit">'
      + _guestEsc(data.result) + '</div>';
  }
  setTimeout(function(){ _showGcGate(); }, 2500);
}

function _guestEsc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function _guestResetAfterError(){
  _guestGenerating = false;
  var btn     = document.getElementById("gcGenBtn");
  var labelEl = document.getElementById("gcGenLabel");
  var inputEl = document.getElementById("gcInput");
  var resArea = document.getElementById("gcResultArea");
  var labels  = { image:"Generate image", campaign:"Generate campaign", copy:"Generate copy" };
  if(btn)     btn.disabled        = false;
  if(labelEl) labelEl.textContent = labels[_guestCreateType] || "Generate";
  if(inputEl) inputEl.disabled    = false;
  if(resArea) resArea.style.display = "none";
  if(typeof toast === "function") toast("Could not generate — please try again.");
}

// ── In-modal gate (create page) ───────────────────────────────

function _showGcGate(imageUrl){
  if(imageUrl) _guestLastImageUrl = imageUrl;
  var gate = document.getElementById("gcGate");
  if(!gate) return;
  var footer = document.querySelector("#guestCreateModal .gcm-footer");
  if(footer) footer.style.display = "none";
  gate.style.display = "";
}

function _gcGateCreate(){ _showGuestGate("signup"); }
function _gcGateLogin(){  _showGuestGate("login");  }

// ── Website builder lock ──────────────────────────────────────

function _showGuestWebLock(){
  var titleEl = document.getElementById("glsTitle");
  var descEl  = document.getElementById("glsDesc");
  if(titleEl) titleEl.textContent = "Website Builder";
  if(descEl)  descEl.textContent  = "Create an account to build and publish AI-generated landing pages.";
  var screen = document.getElementById("guestLockScreen");
  if(!screen) return;
  screen.style.display    = "flex";
  screen.style.opacity    = "0";
  screen.style.transition = "";
  requestAnimationFrame(function(){
    screen.style.transition = "opacity 0.25s ease";
    screen.style.opacity    = "1";
  });
}

// ── Locked tab screen ─────────────────────────────────────────

function _showGuestLockScreen(page){
  var titles = {
    studio: "Brand Studio", dashboard: "Dashboard", create: "Create",
    inspiration: "Ideas", settings: "Settings", usage: "Usage", team: "Team"
  };
  var titleEl = document.getElementById("glsTitle");
  var descEl  = document.getElementById("glsDesc");
  if(titleEl) titleEl.textContent = titles[page] || page;
  if(descEl)  descEl.textContent  = "Create a free account to continue.";
  var screen = document.getElementById("guestLockScreen");
  if(!screen) return;
  screen.style.display    = "flex";
  screen.style.opacity    = "0";
  screen.style.transition = "";
  requestAnimationFrame(function(){
    screen.style.transition = "opacity 0.25s ease";
    screen.style.opacity    = "1";
  });
}

function _hideGuestLockScreen(){
  var screen = document.getElementById("guestLockScreen");
  if(!screen) return;
  screen.style.opacity = "0";
  setTimeout(function(){ screen.style.display = "none"; }, 250);
}

// ── Auth gate modal (signup / login forms only) ───────────────

function _showGuestGate(view){
  var gate = document.getElementById("guestGate");
  if(!gate) return;
  _ggShow(view || "signup");
  gate.style.display    = "flex";
  gate.style.opacity    = "0";
  gate.style.transition = "";
  requestAnimationFrame(function(){
    gate.style.transition = "opacity 0.3s ease";
    gate.style.opacity    = "1";
  });
}

function _ggBack(){
  var gate = document.getElementById("guestGate");
  if(!gate) return;
  gate.style.transition = "opacity 0.25s ease";
  gate.style.opacity    = "0";
  setTimeout(function(){ gate.style.display = "none"; }, 260);
}

function _ggShow(view){
  ["signup","login"].forEach(function(v){
    var el = document.getElementById("gg" + v.charAt(0).toUpperCase() + v.slice(1));
    if(el) el.style.display = v === view ? "" : "none";
  });
  ["ggErr","ggLoginErr"].forEach(function(id){
    var el = document.getElementById(id);
    if(el){ el.textContent = ""; el.style.display = "none"; }
  });
  _ggClearErr(["ggFirst","ggLast","ggEmail","ggPass","ggLoginEmail","ggLoginPass"]);
}

function _guestSignupClick(){ _showGuestGate("signup"); }
function _guestLoginClick(){  _showGuestGate("login");  }

// ── Auth error helpers ────────────────────────────────────────

function _ggMapError(err){
  var msg = (err && err.message) ? err.message : String(err || "");
  if(/invalid login credentials|invalid_credentials/i.test(msg))  return "Incorrect email or password. Please try again.";
  if(/email not confirmed/i.test(msg))                             return "Please verify your email address before signing in.";
  if(/user already registered|already registered|already in use/i.test(msg)) return "An account with this email already exists. Try signing in instead.";
  if(/unable to validate email|invalid.*email/i.test(msg))        return "Please enter a valid email address.";
  if(/password.*at least/i.test(msg))                             return "Password must be at least 6 characters.";
  if(/too many requests|rate.?limit/i.test(msg))                  return "Too many attempts — please wait a moment and try again.";
  if(/network|failed to fetch/i.test(msg))                        return "Connection error. Please check your internet and try again.";
  return msg || "Something went wrong. Please try again.";
}

function _ggMarkErr(ids){
  ids.forEach(function(id){ var el = document.getElementById(id); if(el) el.classList.add("gg-input-err"); });
}

function _ggClearErr(ids){
  ids.forEach(function(id){ var el = document.getElementById(id); if(el) el.classList.remove("gg-input-err"); });
}

// ── Signup ────────────────────────────────────────────────────

async function _ggDoSignup(){
  var first = (document.getElementById("ggFirst").value  || "").trim();
  var last  = (document.getElementById("ggLast").value   || "").trim();
  var email = (document.getElementById("ggEmail").value  || "").trim();
  var pass  =  document.getElementById("ggPass").value   || "";
  var errEl = document.getElementById("ggErr");
  function showErr(msg){ if(errEl){ errEl.textContent = msg; errEl.style.display = ""; } }
  _ggClearErr(["ggFirst","ggEmail","ggPass"]);
  if(!first || !email || !pass){
    showErr("First name, email and password are required.");
    _ggMarkErr([!first?"ggFirst":null, !email?"ggEmail":null, !pass?"ggPass":null].filter(Boolean));
    return;
  }
  if(pass.length < 6){ showErr("Password must be at least 6 characters."); _ggMarkErr(["ggPass"]); return; }
  if(errEl) errEl.style.display = "none";
  var btn = document.getElementById("ggSignupBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Creating account…"; }
  try {
    document.activeElement && document.activeElement.blur();
    var reg = await apiFetch("/api/signup", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ firstName: first, lastName: last, email: email, password: pass })
    });
    if(!reg.ok) throw new Error(reg.data.error || "Signup failed");
    var result = await SB.auth.signInWithPassword({ email: email, password: pass });
    if(result.error) throw result.error;
    _ggClearErr(["ggFirst","ggEmail","ggPass"]);
    _guestOnSignedIn(result.data.user);
    trackEvent("created_account", result.data.user);
  } catch(err){
    showErr(_ggMapError(err));
    _ggMarkErr(["ggEmail","ggPass"]);
    if(btn){ btn.disabled = false; btn.textContent = "Create free account"; }
  }
}

// ── Login ─────────────────────────────────────────────────────

async function _ggDoLogin(){
  var email = (document.getElementById("ggLoginEmail").value || "").trim();
  var pass  =  document.getElementById("ggLoginPass").value  || "";
  var errEl = document.getElementById("ggLoginErr");
  function showErr(msg){ if(errEl){ errEl.textContent = msg; errEl.style.display = ""; } }
  _ggClearErr(["ggLoginEmail","ggLoginPass"]);
  if(!email || !pass){
    showErr("Enter your email and password.");
    _ggMarkErr([!email?"ggLoginEmail":null, !pass?"ggLoginPass":null].filter(Boolean));
    return;
  }
  if(errEl) errEl.style.display = "none";
  var btn = document.getElementById("ggLoginBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Signing in…"; }
  try {
    document.activeElement && document.activeElement.blur();
    var result = await SB.auth.signInWithPassword({ email: email, password: pass });
    if(result.error) throw result.error;
    _ggClearErr(["ggLoginEmail","ggLoginPass"]);
    _guestOnSignedIn(result.data.user);
  } catch(err){
    showErr(_ggMapError(err));
    _ggMarkErr(["ggLoginEmail","ggLoginPass"]);
    if(btn){ btn.disabled = false; btn.textContent = "Sign in"; }
  }
}

// ── After sign-in / sign-up ───────────────────────────────────

function _guestOnSignedIn(user){
  _isGuestMode      = false;
  _guestBCGenerated = false;
  document.body.classList.remove("guest-mode");

  if(_originalNavigate)   { navigate    = _originalNavigate;   _originalNavigate   = null; }
  if(_originalOpenAIFlow) { openAIFlow  = _originalOpenAIFlow; _originalOpenAIFlow = null; }
  if(_originalSaveBCToDB) { saveBCToDB  = _originalSaveBCToDB; _originalSaveBCToDB = null; }
  if(_originalOpenModal)  { openModal   = _originalOpenModal;  _originalOpenModal  = null; }

  _guestRemoveTabGuard();

  clearInterval(_gbeLoadTimer);
  ["guestGate","guestCTA","guestCreateModal","guestOnboard","guestLockScreen","brandSetup","guestBCEntry"].forEach(function(id){
    var el = document.getElementById(id);
    if(el){ el.style.opacity = "0"; setTimeout(function(){ el.style.display = "none"; }, 300); }
  });

  if(_savedGT_STEPS){ try{ GT_STEPS = _savedGT_STEPS; }catch(_){} _savedGT_STEPS = null; }
  if(_savedGT_TOTAL !== null){
    try {
      GT_TOTAL = _savedGT_TOTAL;
      var dotsEl = document.getElementById("gtProgressDots");
      if(dotsEl){
        dotsEl.innerHTML = "";
        for(var ri = 0; ri < _savedGT_TOTAL; ri++){
          var rd = document.createElement("div"); rd.className = "gt-pdot"; dotsEl.appendChild(rd);
        }
      }
    } catch(_){}
    _savedGT_TOTAL = null;
  }

  onUserSignedIn(user);
}

// ── In-Studio BrandCore entry block ──────────────────────────

var _gbeLoadTimer = null;

function _gbeShowState(state){
  var choose  = document.getElementById("gbeChoose");
  var ai      = document.getElementById("gbeAI");
  var loading = document.getElementById("gbeLoading");
  if(choose)  choose.style.display  = state === "choose"  ? "" : "none";
  if(ai)      ai.style.display      = state === "ai"      ? "" : "none";
  if(loading) loading.style.display = state === "loading" ? "" : "none";
  if(state === "ai"){
    var input = document.getElementById("gbeInput");
    if(input){ input.value = ""; setTimeout(function(){ input.focus(); }, 80); }
  }
}

function _gbeChooseAI(){     _gbeShowState("ai"); }
function _gbeChooseManual(){ if(typeof openModal === "function") openModal("modal-bcsetup"); }
function _gbeBack(){         _gbeShowState("choose"); }

function _gbeGenerate(){
  var input = document.getElementById("gbeInput");
  var idea  = input ? input.value.trim() : "";
  if(!idea){
    if(input){
      input.style.borderColor = "rgba(183,255,42,0.6)";
      input.focus();
      setTimeout(function(){ input.style.borderColor = ""; }, 1400);
    }
    return;
  }
  _gbeShowState("loading");
  _gbeAnimateSteps();
  var gbName = document.getElementById("gbName");
  var gbDesc = document.getElementById("gbDesc");
  if(gbName) gbName.value = idea;
  if(gbDesc) gbDesc.value = idea;
  if(typeof closeModal === "function") closeModal("modal-genbrand");
  if(typeof runGenBrand === "function") runGenBrand();
}

function _gbeAnimateSteps(){
  var steps = ["Analyzing idea…","Creating identity…","Designing visuals…","Building content…"];
  var el = document.getElementById("gbeLoadingStep");
  if(!el) return;
  var i = 0;
  el.textContent = steps[0];
  clearInterval(_gbeLoadTimer);
  _gbeLoadTimer = setInterval(function(){
    if(!el) return clearInterval(_gbeLoadTimer);
    el.style.opacity = "0";
    setTimeout(function(){
      i = (i + 1) % steps.length;
      el.textContent   = steps[i];
      el.style.opacity = "1";
    }, 300);
  }, 1600);
}

// ── Auto-generate logo after BrandCore creation ───────────────

function _guestAutoGenerateLogo(){
  if(!S || !S.brandCore) return;
  var bc = S.brandCore;
  var brandName = bc.name || "";
  if(!brandName) return;
  var description = (bc.logoConcept && bc.logoConcept.description) || bc.desc || bc.positioning || "";
  var colors = (bc.colors || []).slice(0,2).map(function(c){ return c.hex || ""; }).filter(Boolean).join(", ");
  fetch(API_BASE_URL + "/api/generate-logo", {
    method:  "POST",
    headers: {"Content-Type":"application/json"},
    body:    JSON.stringify({
      brandName:      brandName,
      description:    description,
      logoStyle:      "minimal icon",
      styleDirection: (bc.styleDirection || "minimal clean"),
      colorPalette:   colors
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if(!data || !data.imageUrl) return;
    if(!S.brandCore.logos) S.brandCore.logos = {};
    S.brandCore.logos.primary = { url: data.imageUrl, source: "ai" };
    if(typeof renderLogos === "function"){
      renderLogos("logoGrid");
      renderLogos("stLogoGrid");
    }
  })
  .catch(function(){});
}
