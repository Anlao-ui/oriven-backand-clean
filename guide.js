// ════════════════════════════════════════════════════════════════
// ORIVEN Guided Product Tour — 6-step walkthrough of the entire app
//
// Flow: Dashboard → Create → Studio → Inspiration → Settings → CTA
//
// Each step spotlights a sidebar nav item and shows a tooltip.
// User clicks "Next" to advance. Steps persist across refresh via
// localStorage so the tour can be resumed if interrupted.
//
// Reset: localStorage.removeItem('oriven_guide_step')
// ════════════════════════════════════════════════════════════════

var GT = {
  step:   -1,   // -1 = not started, 0 = done/skipped, 1-6 = active
  active: false
};

var GT_TOTAL = 6;

// ── Mobile helpers ─────────────────────────────────────────────

function _gtIsMobile(){
  return window.innerWidth <= 768;
}

function _gtOpenSidebar(){
  var sb = document.getElementById("sidebar");
  var ov = document.getElementById("sbOverlay");
  if(sb && !sb.classList.contains("sb-open")){
    sb.classList.add("sb-open");
    if(ov){ ov.style.display = "block"; }
  }
}

function _gtCloseSidebar(){
  var sb = document.getElementById("sidebar");
  var ov = document.getElementById("sbOverlay");
  if(sb && sb.classList.contains("sb-open")){
    sb.classList.remove("sb-open");
    if(ov){ ov.style.display = "none"; }
  }
}

// ── Step definitions ───────────────────────────────────────────
// navTo:     navigate() call before rendering (null = stay on current page)
// targetSel: CSS selector for spotlight element (null = no spotlight)
// centered:  show as a centered modal instead of a positioned tooltip
// bullets:   ["Label — Description", ...] rendered as a styled list
// onAction:  what happens when the CTA button is clicked

var GT_STEPS = [
  null, // index 0 unused — steps are 1-indexed

  // ──────────────────────────────────────────────────────────────
  // Step 1 — Dashboard
  // ──────────────────────────────────────────────────────────────
  {
    navTo:     null,
    targetSel: '[data-page="dashboard"]',
    centered:  false,
    orbMsg:    "Let me show you around ORIVEN",
    title:     "Your Dashboard",
    body:      "Your command center. See an overview of your brand, recent content, and activity — all in one place.",
    bullets:   null,
    cta:       "Next",
    onAction:  function(){ gtAdvance(); }
  },

  // ──────────────────────────────────────────────────────────────
  // Step 2 — Create
  // ──────────────────────────────────────────────────────────────
  {
    navTo:     "create",
    targetSel: '[data-page="create"]',
    centered:  false,
    orbMsg:    "This is where the magic happens",
    title:     "Create everything",
    body:      "Your AI creation hub. Every tool uses your BrandCore to stay perfectly on-brand.",
    bullets: [
      "Image — Brand visuals and social media designs",
      "Text — Copy, headlines, and captions",
      "Video — Scripts and video concepts",
      "Ads — High-converting ad creatives",
      "Campaign — Full multi-channel campaigns",
      "Brand Assistant — AI brand guidance"
    ],
    cta:       "Next",
    onAction:  function(){ gtAdvance(); }
  },

  // ──────────────────────────────────────────────────────────────
  // Step 3 — Studio
  // ──────────────────────────────────────────────────────────────
  {
    navTo:     "studio",
    targetSel: '[data-page="studio"]',
    centered:  false,
    orbMsg:    "Your brand identity lives here",
    title:     "Brand Studio",
    body:      "Your central workspace. Manage everything that defines and drives your brand.",
    bullets: [
      "Saved — All your generated content and assets",
      "Brand Core — Colors, fonts, and tone of voice",
      "Brand Check — Analyze brand consistency",
      "Campaigns — Manage your active campaigns"
    ],
    cta:       "Next",
    onAction:  function(){ gtAdvance(); }
  },

  // ──────────────────────────────────────────────────────────────
  // Step 4 — Ideas
  // ──────────────────────────────────────────────────────────────
  {
    navTo:     "inspiration",
    targetSel: '[data-page="inspiration"]',
    centered:  false,
    orbMsg:    "Get inspired when you need it",
    title:     "Ideas",
    body:      "Proven content frameworks, ad angles, visual styles, and campaign concepts — ready to use or generate from.",
    bullets:   null,
    cta:       "Next",
    onAction:  function(){ gtAdvance(); }
  },

  // ──────────────────────────────────────────────────────────────
  // Step 5 — Settings
  // ──────────────────────────────────────────────────────────────
  {
    navTo:     "settings",
    targetSel: '[data-page="settings"]',
    centered:  false,
    orbMsg:    "Make ORIVEN yours",
    title:     "Settings",
    body:      "Customize your workspace to fit your workflow and preferences.",
    bullets: [
      "Workspace — Workspace name and brand lock",
      "Appearance — Light or dark mode",
      "Language — Display and generation language",
      "Notifications — Alert preferences",
      "Export — Download your brand assets",
      "Brand Reset — Clear and start fresh"
    ],
    cta:       "Next",
    onAction:  function(){ gtAdvance(); }
  },

  // ──────────────────────────────────────────────────────────────
  // Step 6 — Final CTA (centered modal, no spotlight)
  // ──────────────────────────────────────────────────────────────
  {
    navTo:     null,
    targetSel: null,
    centered:  true,
    orbMsg:    "You're ready to build something great",
    title:     "Everything starts with your brand",
    body:      "Create your BrandCore — strategy, colors, tone of voice, and identity. Every piece of content ORIVEN generates flows directly from it.",
    bullets:   null,
    cta:       "Create your BrandCore",
    onAction:  function(){
      gtComplete();
      navigate("studio");
      setTimeout(function(){
        if(typeof switchStudioTab === "function") switchStudioTab("brandcore");
      }, 150);
    }
  }
];

// ═══════════════════════════════════════════════════════════════
// CORE: Show a step
// ═══════════════════════════════════════════════════════════════

function gtShow(step){
  if(step < 1 || step > GT_TOTAL) return;
  var def = GT_STEPS[step];
  if(!def) return;

  GT.step   = step;
  GT.active = true;
  _gtSave(step);

  var mobile      = _gtIsMobile();
  var isNavTarget = def.targetSel && def.targetSel.indexOf("[data-page=") !== -1;

  // Navigate first if needed, then render after a brief settle delay
  if(def.navTo){
    navigate(def.navTo);
    if(mobile && isNavTarget){
      setTimeout(function(){
        _gtOpenSidebar();
        setTimeout(function(){ _gtRender(def, step); }, 280);
      }, 240);
    } else {
      setTimeout(function(){ _gtRender(def, step); }, 240);
    }
  } else if(mobile && isNavTarget){
    _gtOpenSidebar();
    setTimeout(function(){ _gtRender(def, step); }, 260);
  } else {
    _gtRender(def, step);
  }
}

// ── Render spotlight + tooltip for a given step def ───────────

function _gtRender(def, step){
  var targetRect = def.targetSel ? _gtGetRect(def.targetSel) : null;

  // ── Spotlight ──────────────────────────────────────────────
  var spot = document.getElementById("gtSpot");
  if(spot){
    if(targetRect && !def.centered){
      var pad = 9;
      spot.style.left   = (targetRect.left   - pad) + "px";
      spot.style.top    = (targetRect.top    - pad) + "px";
      spot.style.width  = (targetRect.width  + pad * 2) + "px";
      spot.style.height = (targetRect.height + pad * 2) + "px";
      spot.style.display = "block";
      requestAnimationFrame(function(){ spot.classList.add("gt-on"); });
    } else {
      spot.classList.remove("gt-on");
      setTimeout(function(){
        if(!spot.classList.contains("gt-on")) spot.style.display = "none";
      }, 340);
    }
  }

  // ── Backdrop (centered steps only) ────────────────────────
  var bd = document.getElementById("gtBd");
  if(bd){
    if(def.centered){
      bd.style.display = "block";
      requestAnimationFrame(function(){ bd.classList.add("gt-on"); });
    } else {
      bd.classList.remove("gt-on");
      setTimeout(function(){
        if(!bd.classList.contains("gt-on")) bd.style.display = "none";
      }, 340);
    }
  }

  // ── Tooltip card ──────────────────────────────────────────
  var tip = document.getElementById("gtTip");
  if(!tip) return;

  // Populate text content
  var stepEl    = document.getElementById("gtTipStep");
  var titleEl   = document.getElementById("gtTipTitle");
  var bodyEl    = document.getElementById("gtTipBody");
  var btnEl     = document.getElementById("gtTipBtn");
  var bulletsEl = document.getElementById("gtTipBullets");

  if(stepEl)  stepEl.textContent  = step + " / " + GT_TOTAL;
  if(titleEl) titleEl.textContent = def.title;
  if(bodyEl)  bodyEl.textContent  = def.body;
  if(btnEl)   btnEl.textContent   = def.cta;

  // Bullet list
  if(bulletsEl){
    if(def.bullets && def.bullets.length){
      bulletsEl.innerHTML = def.bullets.map(function(b){
        // Format: "Label — Description"
        var dash = b.indexOf(" — ");
        if(dash !== -1){
          return '<li><strong>' + b.slice(0, dash) + '</strong>' +
                 '<span> — ' + b.slice(dash + 3) + '</span></li>';
        }
        return '<li>' + b + '</li>';
      }).join("");
      bulletsEl.style.display = "block";
    } else {
      bulletsEl.innerHTML = "";
      bulletsEl.style.display = "none";
    }
  }

  // Centered vs positioned mode (always centered on mobile)
  var useCenter = def.centered || _gtIsMobile();
  if(useCenter){
    tip.classList.add("gt-centered");
  } else {
    tip.classList.remove("gt-centered");
  }

  // Update skip button label for final step only
  var skipBtn = document.getElementById("gtSkipBtn");
  if(skipBtn) skipBtn.style.display = def.centered ? "none" : "";

  // Position, then animate in
  _gtPositionTip(tip, targetRect, useCenter);
  tip.classList.remove("gt-on");
  tip.style.display = "block";
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){ tip.classList.add("gt-on"); });
  });

  // Progress dots
  _gtSetDots(step);

  // Orb message
  _gtShowOrb(def.orbMsg);

  console.log("[Tour] ▶ Step " + step + " / " + GT_TOTAL + ": " + def.title);
}

// ── Get bounding rect, returns null if not found or hidden ────

function _gtGetRect(sel){
  var el = document.querySelector(sel);
  if(!el) return null;
  var r = el.getBoundingClientRect();
  if(r.width === 0 && r.height === 0) return null;
  return r;
}

// ── Position the tooltip ──────────────────────────────────────

function _gtPositionTip(tip, targetRect, centered){
  var tipW = 306;
  var vw   = window.innerWidth;
  var vh   = window.innerHeight;
  var m    = 16;   // minimum margin from any screen edge
  var tipH = 460;  // conservative max tooltip height (accommodates bullet-heavy steps)

  // Centered mode — CSS transform handles the centering
  if(centered){
    tip.style.left   = "50%";
    tip.style.top    = "50%";
    tip.style.right  = "";
    tip.style.bottom = "";
    return;
  }

  if(targetRect){
    var left, top;

    // ── Horizontal: try right of spotlight, then left, then clamp ──
    var candidateRight = targetRect.right + 18;
    var candidateLeft  = targetRect.left  - tipW - 18;

    if(candidateRight + tipW <= vw - m){
      // Fits to the right — preferred placement
      left = candidateRight;
    } else if(candidateLeft >= m){
      // Fits to the left
      left = candidateLeft;
    } else {
      // Neither side fits — center-align under/over target
      left = Math.max(m, Math.min(targetRect.left, vw - tipW - m));
    }

    // ── Vertical: center on target, then clamp to viewport ──
    top = targetRect.top + (targetRect.height / 2) - 80;

    // If tip would overflow the bottom, nudge it up
    if(top + tipH > vh - m){
      top = vh - tipH - m;
    }
    // Never above the top edge
    top = Math.max(m, top);

    tip.style.left   = left + "px";
    tip.style.top    = top  + "px";
    tip.style.right  = "";
    tip.style.bottom = "";
  } else {
    // No target — float above corner orb
    tip.style.right  = "24px";
    tip.style.bottom = "108px";
    tip.style.left   = "";
    tip.style.top    = "";
  }
}

// ── Update progress dots ──────────────────────────────────────

function _gtSetDots(active){
  var container = document.getElementById("gtProgressDots");
  if(!container) return;
  container.querySelectorAll(".gt-pdot").forEach(function(d, i){
    d.classList.toggle("gt-pdot-on", i < active);
    d.classList.toggle("gt-pdot-active", i + 1 === active);
  });
}

// ═══════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════

// Dismiss tooltip + spotlight (leaves orb visible)
function gtDismiss(){
  GT.active = false;
  var tip  = document.getElementById("gtTip");
  var spot = document.getElementById("gtSpot");
  var bd   = document.getElementById("gtBd");
  if(tip)  tip.classList.remove("gt-on");
  if(spot) spot.classList.remove("gt-on");
  if(bd)   bd.classList.remove("gt-on");
  setTimeout(function(){
    if(tip  && !tip.classList.contains("gt-on"))  tip.style.display  = "none";
    if(spot && !spot.classList.contains("gt-on")) spot.style.display = "none";
    if(bd   && !bd.classList.contains("gt-on"))   bd.style.display   = "none";
  }, 380);
  // Close the sidebar drawer on mobile after each step
  if(_gtIsMobile()) _gtCloseSidebar();
}

// CTA button click
function gtAction(){
  var def = GT_STEPS[GT.step];
  if(def && def.onAction) def.onAction();
}

// Advance to next step
// fromStep: if provided, only advances if currently on that step
function gtAdvance(fromStep){
  if(GT.step <= 0) return;
  if(fromStep !== undefined && GT.step !== fromStep) return;

  var next = GT.step + 1;
  if(next > GT_TOTAL){
    gtComplete();
    return;
  }

  if(GT.active){
    gtDismiss();
    setTimeout(function(){ gtShow(next); }, 420);
  } else {
    gtShow(next);
  }
}

// Skip the entire tour
function gtSkipAll(){
  console.log("[Tour] Skipped at step", GT.step);
  gtDismiss();
  _gtHideOrb();
  GT.step = 0;
  _gtSave(0);
  toast("Tour skipped — you can restart it anytime from Settings.");
}

// Tour finished (called from final step's onAction)
function gtComplete(){
  console.log("[Tour] Completed");
  gtDismiss();
  _gtHideOrb();
  GT.step = 0;
  _gtSave(0);
}

// ═══════════════════════════════════════════════════════════════
// CORNER ORB + MESSAGE BUBBLE
// ═══════════════════════════════════════════════════════════════

function _gtShowOrb(msg){
  var orb    = document.getElementById("obCornerOrb");
  var bubble = document.getElementById("gtOrbMsg");
  var txt    = document.getElementById("gtOrbMsgText");

  if(orb) orb.classList.add("ob-orb-visible");

  if(bubble && txt && msg){
    txt.textContent = msg;
    bubble.classList.remove("gt-on");
    bubble.style.display = "flex";
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){ bubble.classList.add("gt-on"); });
    });
    clearTimeout(bubble._hideTimer);
    bubble._hideTimer = setTimeout(function(){
      bubble.classList.remove("gt-on");
      setTimeout(function(){ bubble.style.display = "none"; }, 400);
    }, 4800);
  }
}

function _gtHideOrb(){
  var orb    = document.getElementById("obCornerOrb");
  var bubble = document.getElementById("gtOrbMsg");
  if(orb) orb.classList.remove("ob-orb-visible");
  if(bubble){
    clearTimeout(bubble._hideTimer);
    bubble.classList.remove("gt-on");
    bubble.style.display = "none";
  }
}

// ═══════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════

function _gtSave(step){
  try { localStorage.setItem("oriven_guide_step", String(step)); } catch(_){}
}

function _gtLoad(){
  try {
    var v = parseInt(localStorage.getItem("oriven_guide_step"), 10);
    return isNaN(v) ? -1 : v;
  } catch(_){ return -1; }
}

// ═══════════════════════════════════════════════════════════════
// START / RESUME
// Called from auth.js after the intro overlay completes (obFinish)
// ═══════════════════════════════════════════════════════════════

function gtStart(){
  var saved = _gtLoad();

  // 0 = already completed or skipped — navigate to BrandCore directly
  if(saved === 0){
    console.log("[Tour] Already completed — going to BrandCore");
    navigate("studio");
    setTimeout(function(){
      if(typeof switchStudioTab === "function") switchStudioTab("brandcore");
    }, 150);
    return;
  }

  var step = (saved >= 1 && saved <= GT_TOTAL) ? saved : 1;
  GT.step = step;
  console.log("[Tour] Starting at step", step);

  // Fresh tour always starts from Dashboard
  if(step === 1) navigate("dashboard");

  // Slight delay so page/layout settles after the intro overlay hides
  setTimeout(function(){ gtShow(step); }, 900);
}
