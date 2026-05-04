// ════════════════════════════════════════════════════════════
// GUEST FLOW — try-before-signup experience
// Journey: Intro → What to create → Generate 1 result → Gate → Signup
// State:   localStorage "guestGenerationUsed" = "true"
// ════════════════════════════════════════════════════════════

var _isGuestMode       = false;
var _guestLastImageUrl = null;
var _guestGenerating   = false;
var _originalNavigate  = null;
var _guestCreateType   = "image"; // "image" | "campaign" | "copy"
var _guestAdCount      = 1;       // 1 | 3 | 5 (campaign only)
var _savedGT_STEPS     = null;    // saved before guest tour overrides them
var _savedGT_TOTAL     = null;

// ── Entry point (called from auth.js on no-session + on signout) ──

function showGuestLanding(){
  _isGuestMode       = true;
  _guestGenerating   = false;
  _guestLastImageUrl = null;

  showApp();
  if(typeof updateSidebarGuest === "function") updateSidebarGuest();

  // Hook navigate() to block locked tabs
  if(typeof navigate === "function" && !_originalNavigate){
    _originalNavigate = navigate;
    navigate = function(page){
      var locked = ["studio","inspiration","settings","usage","team"];
      if(_isGuestMode && locked.indexOf(page) !== -1){
        _showGuestLockScreen(page);
        return;
      }
      _originalNavigate(page);
    };
  }

  _guestInstallTabGuard();

  // Patch openAIFlow — block web and enforce 1-generation limit
  if(typeof openAIFlow === "function" && !_originalOpenAIFlow){
    _originalOpenAIFlow = openAIFlow;
    openAIFlow = function(type){
      if(_isGuestMode && type === "web"){
        _showGuestWebLock();
        return;
      }
      if(_isGuestMode){
        if(localStorage.getItem("guestGenerationUsed") === "true"){
          _showGuestGate();
          return;
        }
        localStorage.setItem("guestGenerationUsed", "true");
      }
      _originalOpenAIFlow(type);
    };
  }

  // Already generated on a prior visit → skip to gate
  if(localStorage.getItem("guestGenerationUsed") === "true"){
    if(typeof _originalNavigate === "function") _originalNavigate("create");
    setTimeout(function(){ _showGuestGate(); }, 400);
    return;
  }

  // Show full black entry screen
  setTimeout(function(){ _guestShowEntry(); }, 200);
}

// Kept for backwards-compat
function hideGuestLanding(){}

var _originalOpenAIFlow = null;

// ── Entry screen ──────────────────────────────────────────────

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
  trackEvent("clicked_try");
  var overlay = document.getElementById("guestOnboard");
  if(overlay){
    overlay.style.transition = "opacity 0.25s ease";
    overlay.style.opacity    = "0";
    setTimeout(function(){ overlay.style.display = "none"; }, 250);
  }
  if(typeof _originalNavigate === "function") _originalNavigate("dashboard");
  setTimeout(function(){
    if(typeof startGuestTour === "function") startGuestTour();
  }, 450);
}

function _guestOnboardLogin(){
  var overlay = document.getElementById("guestOnboard");
  if(overlay){
    overlay.style.transition = "opacity 0.25s ease";
    overlay.style.opacity    = "0";
    setTimeout(function(){ overlay.style.display = "none"; }, 250);
  }
  setTimeout(function(){
    _showGuestGate();
    setTimeout(function(){ _ggShow("login"); }, 30);
  }, 200);
}

// ── Tab guard — intercept locked sidebar items ────────────────

function _guestInstallTabGuard(){
  var locked = ["studio","inspiration","settings","usage","team"];
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

function _guestRemoveTabGuard(){
  var locked = ["studio","inspiration","settings","usage","team"];
  document.querySelectorAll(".ni[data-page]").forEach(function(ni){
    if(locked.indexOf(ni.dataset.page) !== -1){
      ni.removeEventListener("click", _guestTabGuardHandler, true);
    }
  });
}

// ── Create Modal ──────────────────────────────────────────────

function _guestShowCreateModal(){
  _guestAdCount = 1;
  _guestSetType("image"); // reset to default type
  var modal = document.getElementById("guestCreateModal");
  if(!modal) return;
  modal.style.display   = "flex";
  modal.style.opacity   = "0";
  modal.style.transition = "";
  requestAnimationFrame(function(){
    modal.style.transition = "opacity 0.3s ease";
    modal.style.opacity    = "1";
  });
  var inp = document.getElementById("gcInput");
  if(inp){
    inp.value = "";
    setTimeout(function(){ inp.focus(); }, 350);
  }
  // Reset result area and in-modal gate
  var resultArea = document.getElementById("gcResultArea");
  if(resultArea) resultArea.style.display = "none";
  var gcGate = document.getElementById("gcGate");
  if(gcGate) gcGate.style.display = "none";
  var gcFooter = document.querySelector("#guestCreateModal .gcm-footer");
  if(gcFooter) gcFooter.style.display = "";
}

function _guestCreateBack(){
  var modal = document.getElementById("guestCreateModal");
  if(modal){
    modal.style.opacity = "0";
    setTimeout(function(){ modal.style.display = "none"; }, 280);
  }
}

// ── Type selection ────────────────────────────────────────────

function _guestSetType(type){
  _guestCreateType = type;

  document.querySelectorAll(".gcm-type-chip").forEach(function(c){
    c.classList.toggle("gcm-type-chip-on", c.dataset.type === type);
  });

  // Show count selector only for Campaign
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
  var labels = {
    image:    "Generate image",
    campaign: "Generate campaign",
    copy:     "Generate copy"
  };
  if(label) label.textContent = labels[type] || "Generate";
}

function _guestSetAdCount(n){
  _guestAdCount = n;
  document.querySelectorAll(".gcm-count-btn").forEach(function(b){
    b.classList.toggle("gcm-count-btn-on", parseInt(b.dataset.count, 10) === n);
  });
}

// ── Generation ────────────────────────────────────────────────

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

  if(localStorage.getItem("guestGenerationUsed") === "true"){
    _showGuestGate(); return;
  }

  _guestGenerating = true;
  localStorage.setItem("guestGenerationUsed", "true");

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
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt:      prompt + ". Professional, high-quality, clean visual. No watermarks.",
      size:        "1024x1024",
      type:        "image",
      imageFormat: "1:1"
    })
  });
  var data = await res.json();

  if(!data || !data.imageUrl){ _guestResetAfterError(); return; }

  _guestLastImageUrl = data.imageUrl;
  if(resultImg){
    resultImg.innerHTML =
      '<img src="' + data.imageUrl + '" alt="Your creation" style="width:100%;display:block;border-radius:12px">';
  }

  // Caption alongside the image
  if(labelEl) labelEl.textContent = "Adding caption…";
  if(secEl && secTextEl){
    secEl.style.display = "";
    secTextEl.innerHTML =
      '<span class="gl-gen-dots" style="display:inline-flex;gap:4px">'
      + '<span></span><span></span><span></span></span>';
  }
  try {
    var textRes  = await fetch(API_BASE_URL + "/api/generate-text", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Write one short punchy social media caption (max 2 sentences) for: " + prompt,
        type:   "captions"
      })
    });
    var textData = await textRes.json();
    if(textData && textData.result && secTextEl){
      secTextEl.textContent = textData.result;
    } else {
      if(secEl) secEl.style.display = "none";
    }
  } catch(e){ if(secEl) secEl.style.display = "none"; }

  setTimeout(function(){ _showGcGate(data.imageUrl); }, 2500);
}

async function _guestGenerateCampaign(prompt, resultImg, labelEl){
  var count = _guestAdCount || 1;

  if(labelEl) labelEl.textContent = "Building campaign…";
  if(resultImg){
    resultImg.innerHTML =
      '<div class="gl-generating">'
      + '<div class="gl-gen-dots"><span></span><span></span><span></span></div>'
      + '<span>Generating ' + count + ' ad' + (count > 1 ? 's' : '') + ' with images…</span>'
      + '</div>';
  }

  var campPrompt =
    "Generate exactly " + count + " campaign ad variation" + (count > 1 ? "s" : "")
    + " for: " + prompt
    + ". Each: punchy headline (max 10 words), conversion-focused body (2 sentences max), short CTA (max 4 words), "
    + "and a vivid 120-character text-free DALL-E 3 image prompt for the ad visual.";

  var res  = await fetch(API_BASE_URL + "/api/generate-campaign", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: campPrompt, size: "1024x1024" })
  });
  var data = await res.json();

  if(!data || !data.variations || !data.variations.length){ _guestResetAfterError(); return; }

  if(resultImg){
    var html = '<div class="gcm-camp-list">';
    data.variations.forEach(function(v, i){
      html += '<div class="gcm-camp-card">';
      if(v.imageUrl){
        html += '<img class="gcm-camp-img" src="' + _guestEsc(v.imageUrl) + '" alt="Ad ' + (i + 1) + '">';
      }
      html += '<div class="gcm-camp-body">';
      html += '<div class="gcm-camp-num">Ad ' + (i + 1) + '</div>';
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
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: textPrompt, type: _guestCreateType })
  });
  var data = await res.json();

  if(!data || !data.result){ _guestResetAfterError(); return; }

  if(resultImg){
    resultImg.innerHTML =
      '<div style="padding:20px 18px;font-size:13.5px;line-height:1.8;color:rgba(240,237,230,0.82);white-space:pre-wrap;font-family:inherit">'
      + _guestEsc(data.result)
      + '</div>';
  }
  setTimeout(function(){ _showGcGate(); }, 2500);
}

function _guestEsc(s){
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function _guestResetAfterError(){
  localStorage.removeItem("guestGenerationUsed");
  _guestGenerating = false;
  var btn      = document.getElementById("gcGenBtn");
  var labelEl  = document.getElementById("gcGenLabel");
  var inputEl  = document.getElementById("gcInput");
  var resArea  = document.getElementById("gcResultArea");
  var labels   = { image: "Generate image", campaign: "Generate campaign", copy: "Generate copy" };
  if(btn)     btn.disabled        = false;
  if(labelEl) labelEl.textContent = labels[_guestCreateType] || "Generate";
  if(inputEl) inputEl.disabled    = false;
  if(resArea) resArea.style.display = "none";
  if(typeof toast === "function") toast("Could not generate — please try again.");
}

// ── In-modal soft gate ───────────────────────────────────────

function _showGcGate(imageUrl){
  if(imageUrl) _guestLastImageUrl = imageUrl;
  var gate = document.getElementById("gcGate");
  if(!gate) return;
  var footer = document.querySelector("#guestCreateModal .gcm-footer");
  if(footer) footer.style.display = "none";
  gate.style.display = "";
}

function _gcGateCreate(){
  _showGuestGate(_guestLastImageUrl);
  setTimeout(function(){ _ggShow("signup"); }, 30);
}

function _gcGateLogin(){
  _showGuestGate(_guestLastImageUrl);
  setTimeout(function(){ _ggShow("login"); }, 30);
}

// ── Website builder lock ──────────────────────────────────────

function _showGuestWebLock(){
  var titleEl = document.getElementById("glsTitle");
  var descEl  = document.getElementById("glsDesc");
  if(titleEl) titleEl.textContent = "Website Builder";
  if(descEl)  descEl.textContent  = "Create an account to build and publish AI-generated landing pages.";
  var screen = document.getElementById("guestLockScreen");
  if(!screen) return;
  screen.style.display   = "flex";
  screen.style.opacity   = "0";
  screen.style.transition = "";
  requestAnimationFrame(function(){
    screen.style.transition = "opacity 0.25s ease";
    screen.style.opacity    = "1";
  });
}

// ── Locked tab screen ─────────────────────────────────────────

function _showGuestLockScreen(page){
  var titles = {
    studio:      "Brand Studio",
    inspiration: "Ideas",
    settings:    "Settings",
    usage:       "Usage",
    team:        "Team"
  };
  var descs = {
    studio:      "Create an account to start building your brand.",
    inspiration: "Create an account to start building your brand.",
    settings:    "Create an account to start building your brand.",
    usage:       "Create an account to start building your brand.",
    team:        "Create an account to start building your brand."
  };

  var titleEl = document.getElementById("glsTitle");
  var descEl  = document.getElementById("glsDesc");
  if(titleEl) titleEl.textContent = titles[page] || page;
  if(descEl)  descEl.textContent  = descs[page]  || "";

  var screen = document.getElementById("guestLockScreen");
  if(!screen) return;
  screen.style.display   = "flex";
  screen.style.opacity   = "0";
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
  setTimeout(function(){
    screen.style.display = "none";
    if(typeof _originalNavigate === "function") _originalNavigate("dashboard");
  }, 250);
}

// ── Gate Modal (post-generation — no dismiss) ─────────────────

function _showGuestGate(imageUrl){
  var gate = document.getElementById("guestGate");
  if(!gate) return;

  var url = imageUrl || _guestLastImageUrl;
  if(url){
    var preview    = document.getElementById("ggPreview");
    var previewImg = document.getElementById("ggPreviewImg");
    if(preview && previewImg){
      previewImg.src        = url;
      preview.style.display = "";
    }
  }

  _ggShow("main");
  gate.style.display   = "flex";
  gate.style.opacity   = "0";
  gate.style.transition = "";
  requestAnimationFrame(function(){
    gate.style.transition = "opacity 0.3s ease";
    gate.style.opacity    = "1";
  });
  console.log("[Guest] Gate shown");
}

function _ggShow(view){
  ["main","signup","login"].forEach(function(v){
    var el = document.getElementById("gg" + v.charAt(0).toUpperCase() + v.slice(1));
    if(el) el.style.display = v === view ? "" : "none";
  });
  ["ggErr","ggLoginErr"].forEach(function(id){
    var el = document.getElementById(id);
    if(el){ el.textContent = ""; el.style.display = "none"; }
  });
  _ggClearErr(["ggFirst","ggLast","ggEmail","ggPass","ggLoginEmail","ggLoginPass"]);
}

function _guestSignupClick(){ _ggShow("signup"); }
function _guestLoginClick(){  _ggShow("login");  }

// ── Auth error helpers ────────────────────────────────────────

function _ggMapError(err){
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
  if(/too many requests|rate.?limit/i.test(msg))
    return "Too many attempts — please wait a moment and try again.";
  if(/network|failed to fetch/i.test(msg))
    return "Connection error. Please check your internet and try again.";
  return msg || "Something went wrong. Please try again.";
}

function _ggMarkErr(ids){
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.classList.add("gg-input-err");
  });
}

function _ggClearErr(ids){
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.classList.remove("gg-input-err");
  });
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
  if(pass.length < 6){
    showErr("Password must be at least 6 characters.");
    _ggMarkErr(["ggPass"]); return;
  }

  if(errEl) errEl.style.display = "none";
  var btn = document.getElementById("ggSignupBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Creating account…"; }

  try {
    document.activeElement && document.activeElement.blur();
    var reg = await apiFetch("/api/signup", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
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

// ── After guest signs in or signs up ─────────────────────────

function _guestOnSignedIn(user){
  _isGuestMode = false;

  // Restore original navigate
  if(_originalNavigate){
    navigate = _originalNavigate;
    _originalNavigate = null;
  }

  // Restore original openAIFlow
  if(_originalOpenAIFlow){
    openAIFlow = _originalOpenAIFlow;
    _originalOpenAIFlow = null;
  }

  // Remove tab guards
  _guestRemoveTabGuard();

  // Close all guest overlays
  ["guestGate","guestCreateModal","guestOnboard","guestHero","guestLockScreen"].forEach(function(id){
    var el = document.getElementById(id);
    if(el){
      el.style.opacity = "0";
      setTimeout(function(){ el.style.display = "none"; }, 300);
    }
  });

  // Clear guest generation flag — user now has an account
  localStorage.removeItem("guestGenerationUsed");

  // Restore guide tour to original steps if guest tour had overridden them
  if(_savedGT_STEPS){
    try { GT_STEPS = _savedGT_STEPS; } catch(_){}
    _savedGT_STEPS = null;
  }
  if(_savedGT_TOTAL !== null){
    try {
      GT_TOTAL = _savedGT_TOTAL;
      var dotsEl = document.getElementById("gtProgressDots");
      if(dotsEl){
        dotsEl.innerHTML = "";
        for(var ri = 0; ri < _savedGT_TOTAL; ri++){
          var rd = document.createElement("div");
          rd.className = "gt-pdot";
          dotsEl.appendChild(rd);
        }
      }
    } catch(_){}
    _savedGT_TOTAL = null;
  }

  // Hand off to normal auth flow
  onUserSignedIn(user);
}

// ── Guest onboarding tour ─────────────────────────────────────
// Overrides GT_STEPS/GT_TOTAL with a 5-step guest-safe tour that
// spotlights locked pages without navigating to them.

function startGuestTour(){
  if(typeof GT === "undefined" || typeof gtShow !== "function") return;

  // Save originals so _guestOnSignedIn can restore them
  if(typeof GT_STEPS !== "undefined") _savedGT_STEPS = GT_STEPS;
  if(typeof GT_TOTAL !== "undefined") _savedGT_TOTAL = GT_TOTAL;

  var _guestFinalAction = function(){
    gtComplete();
    setTimeout(function(){
      _showGuestGate();
      setTimeout(function(){ _ggShow("signup"); }, 30);
    }, 200);
  };

  GT_TOTAL = 5;
  GT_STEPS = [
    null, // index 0 unused — steps are 1-indexed

    // Step 1 — Dashboard
    {
      navTo:     null,
      targetSel: '[data-page="dashboard"]',
      centered:  false,
      orbMsg:    "Welcome — let me show you around",
      title:     "Your Brand Dashboard",
      body:      "Your command center. Launch creations, run campaigns, and manage your brand — all from here.",
      bullets:   null,
      cta:       "Next",
      onAction:  function(){ gtAdvance(); }
    },

    // Step 2 — Create (safe to navigate)
    {
      navTo:     "create",
      targetSel: '[data-page="create"]',
      centered:  false,
      orbMsg:    "This is where the magic happens",
      title:     "Create content",
      body:      "Images, copy, campaigns, and websites — all generated using your brand identity.",
      bullets:   null,
      cta:       "Next",
      onAction:  function(){ gtAdvance(); }
    },

    // Step 3 — Studio (spotlight only, no navigation to locked page)
    {
      navTo:     null,
      targetSel: '[data-page="studio"]',
      centered:  false,
      orbMsg:    "Your brand identity lives here",
      title:     "Brand Studio",
      body:      "Define your colors, fonts, and tone of voice. Everything ORIVEN creates flows from your brand identity.",
      bullets:   null,
      cta:       "Next",
      onAction:  function(){ gtAdvance(); }
    },

    // Step 4 — Inspiration (spotlight only, no navigation to locked page)
    {
      navTo:     null,
      targetSel: '[data-page="inspiration"]',
      centered:  false,
      orbMsg:    "Get inspired when you need it",
      title:     "Ideas & Inspiration",
      body:      "Creative frameworks, ad angles, and campaign concepts ready to use or generate from.",
      bullets:   null,
      cta:       "Next",
      onAction:  function(){ gtAdvance(); }
    },

    // Step 5 — Final CTA (centered modal, no spotlight)
    {
      navTo:     null,
      targetSel: null,
      centered:  true,
      orbMsg:    "You're ready to build something great",
      title:     "Ready to build your brand?",
      body:      "Create a free account to start generating — images, campaigns, and a full website in your brand's identity.",
      bullets:   null,
      cta:       "Create free account",
      onAction:  _guestFinalAction
    }
  ];

  // Rebuild progress dots for 5 steps
  var dotsEl = document.getElementById("gtProgressDots");
  if(dotsEl){
    dotsEl.innerHTML = "";
    for(var i = 0; i < 5; i++){
      var d = document.createElement("div");
      d.className = "gt-pdot";
      dotsEl.appendChild(d);
    }
  }

  setTimeout(function(){ gtShow(1); }, 600);
}
