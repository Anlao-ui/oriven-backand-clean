// ════════════════════════════════════════════════════════════════
// AI CONVERSATION FLOW
// Replaces the form-based builder for Image, Text, and Campaign.
// Keys are aligned with S._builder / FLOWS in create.js so the
// existing runBuilder() engine is used unchanged for generation.
// ════════════════════════════════════════════════════════════════

var CF_FLOWS = {

  image: [
    {
      key:  "imgDesignType",
      q:    "What kind of image do you need?",
      desc: "This defines the type and purpose of the visual.",
      options: [
        { val: "product",      label: "Product Image" },
        { val: "social",       label: "Social Post" },
        { val: "poster",       label: "Poster" },
        { val: "ad_creative",  label: "Ad Creative" },
        { val: "promo",        label: "Promo Image" },
        { val: "announcement", label: "Announcement" }
      ]
    },
    {
      key:  "imgPurpose",
      q:    "What is the purpose of this image?",
      desc: "Define how the image will be used — this shapes the composition and messaging.",
      options: [
        { val: "launch",       label: "Product Launch" },
        { val: "promotion",    label: "Promotion" },
        { val: "awareness",    label: "Brand Awareness" },
        { val: "sales",        label: "Drive Sales" },
        { val: "engagement",   label: "Engagement" },
        { val: "introduction", label: "Introduction" }
      ]
    },
    {
      key:  "imgSubject",
      q:    "Should this image include a person?",
      desc: "Choose whether the image should feature a human subject.",
      options: [
        { val: "person", label: "Yes — include a person" },
        { val: "no",     label: "No — brand visual only" }
      ]
    },
    {
      key:  "imgVisualStyle",
      q:    "What visual style do you want?",
      desc: "This sets the aesthetic direction — composition, mood, and overall look.",
      options: [
        { val: "editorial",    label: "Editorial" },
        { val: "minimal",      label: "Minimal" },
        { val: "bold",         label: "Bold" },
        { val: "cinematic",    label: "Cinematic" },
        { val: "lifestyle",    label: "Lifestyle" },
        { val: "dark",         label: "Dark" }
      ]
    },
    {
      key:  "imgMood",
      q:    "What mood should this image evoke?",
      desc: "Mood shapes the emotional response and energy of the composition.",
      options: [
        { val: "premium",   label: "Premium" },
        { val: "energetic", label: "Energetic" },
        { val: "calm",      label: "Calm" },
        { val: "dramatic",  label: "Dramatic" },
        { val: "playful",   label: "Playful" },
        { val: "serene",    label: "Serene" }
      ]
    },
    {
      key:  "imgLighting",
      q:    "What lighting style do you want?",
      desc: "Lighting is one of the strongest signals of quality and brand feel.",
      options: [
        { val: "natural",  label: "Natural" },
        { val: "studio",   label: "Studio" },
        { val: "dramatic", label: "Dramatic" },
        { val: "soft",     label: "Soft" },
        { val: "ambient",  label: "Ambient" }
      ]
    },
    {
      key:  "imgIncludeText",
      q:    "Do you want to include text in the image?",
      desc: "Add a title, slogan, or message that should appear in the image.",
      options: [
        { val: "none",   label: "No text" },
        { val: "title",  label: "Short title" },
        { val: "slogan", label: "Slogan" },
        { val: "custom", label: "Custom text" }
      ]
    },
    {
      key:          "imgTextContent",
      q:            "What text should be included?",
      desc:         "This text will be integrated into the image design.",
      type:         "textarea",
      placeholder:  "Type the exact text to include in the image…",
      optional:     false,
      conditional:  "imgIncludeText",
      conditionalVal: "custom"
    },
    {
      key:  "imgFormat",
      q:    "What format do you need?",
      desc: "This sets the dimensions and aspect ratio of the output.",
      options: [
        { val: "1:1",  label: "Square 1:1" },
        { val: "4:5",  label: "Portrait 4:5" },
        { val: "9:16", label: "Story 9:16" },
        { val: "16:9", label: "Wide 16:9" }
      ]
    },
    {
      key:  "_extraNotes",
      q:    "Anything else you'd like to add?",
      desc: "The more specific your input, the better the final result.",
      type: "textarea",
      placeholder: "Describe any specific details, references, colors, lighting, or elements…",
      optional: true
    }
  ],

  text: [
    {
      key:  "txtType",
      q:    "What type of content are you creating?",
      desc: "This shapes the format, length, and structure of the output.",
      options: [
        { val: "headline",     label: "Headline" },
        { val: "body_copy",    label: "Body Copy" },
        { val: "caption",      label: "Social Caption" },
        { val: "hook",         label: "Hook" },
        { val: "ad_copy",      label: "Ad Copy" },
        { val: "product_desc", label: "Product Description" }
      ]
    },
    {
      key:  "txtPurpose",
      q:    "What is the purpose of this text?",
      desc: "This defines the goal and shapes how the copy is written.",
      options: [
        { val: "launch",      label: "Product Launch" },
        { val: "awareness",   label: "Build Awareness" },
        { val: "conversion",  label: "Drive Conversions" },
        { val: "engagement",  label: "Engage Audience" },
        { val: "brand_intro", label: "Brand Introduction" },
        { val: "promotion",   label: "Promotion" }
      ]
    },
    {
      key:  "txtObjective",
      q:    "What is the writing objective?",
      desc: "This shapes the angle, structure, and intensity of the copy.",
      options: [
        { val: "promote",  label: "Promote" },
        { val: "educate",  label: "Educate" },
        { val: "convert",  label: "Convert" },
        { val: "engage",   label: "Engage" },
        { val: "inspire",  label: "Inspire" },
        { val: "announce", label: "Announce" }
      ]
    },
    {
      key:  "txtCtaStyle",
      q:    "What CTA style do you want?",
      desc: "Defines how the call-to-action is delivered in the copy.",
      options: [
        { val: "direct",  label: "Direct Action" },
        { val: "soft",    label: "Soft Nudge" },
        { val: "urgency", label: "Urgency" },
        { val: "none",    label: "No CTA" }
      ]
    },
    {
      key:  "_extraNotes",
      q:    "Anything else you'd like to add?",
      desc: "The more specific your input, the better the final result.",
      type: "textarea",
      placeholder: "Add context, key messages, product details, or anything specific…",
      optional: true
    }
  ],

  campaign: [
    {
      key:  "campType",
      q:    "What type of campaign are you running?",
      desc: "This defines the overarching strategy and campaign structure.",
      options: [
        { val: "launch",      label: "Product Launch" },
        { val: "awareness",   label: "Brand Awareness" },
        { val: "conversion",  label: "Conversion" },
        { val: "promotion",   label: "Seasonal / Promo" },
        { val: "retargeting", label: "Retargeting" }
      ]
    },
    {
      key:  "campChannel",
      q:    "Which platform will this campaign run on?",
      desc: "Select where this campaign will live and be distributed.",
      options: [
        { val: "meta",    label: "Meta / Facebook / Instagram" },
        { val: "tiktok",  label: "TikTok" },
        { val: "youtube", label: "YouTube" },
        { val: "multi",   label: "Multi-platform" }
      ]
    },
    {
      key:  "campFormat",
      q:    "What format do you need?",
      desc: "This sets the dimensions across all campaign variations.",
      options: [
        { val: "square",     label: "Square 1:1" },
        { val: "portrait",   label: "Portrait 4:5" },
        { val: "story_reel", label: "Story / Reel" },
        { val: "mixed",      label: "Mixed formats" }
      ]
    },
    {
      key:  "campSubject",
      q:    "What is this campaign about?",
      desc: "Knowing the subject shapes the creative angle and messaging.",
      options: [
        { val: "product", label: "Product" },
        { val: "service", label: "Service" },
        { val: "brand",   label: "Brand" },
        { val: "offer",   label: "Offer / Deal" }
      ]
    },
    {
      key:  "campFunnelStage",
      q:    "What stage of the funnel is this campaign for?",
      desc: "Funnel stage defines message intensity and creative direction.",
      options: [
        { val: "awareness",     label: "Awareness" },
        { val: "consideration", label: "Consideration" },
        { val: "conversion",    label: "Conversion" },
        { val: "retention",     label: "Retention" }
      ]
    },
    {
      key:  "campAudienceWarmth",
      q:    "How warm is your target audience?",
      desc: "Warm audiences already know your brand — cold ones don't.",
      options: [
        { val: "cold",       label: "Cold Audience" },
        { val: "warm",       label: "Warm Audience" },
        { val: "retargeted", label: "Retargeted" }
      ]
    },
    {
      key:  "campVariations",
      q:    "How many ad variations do you want?",
      desc: "Each variation is a unique creative angle within the campaign.",
      options: [
        { val: "2", label: "2 variations" },
        { val: "3", label: "3 variations" },
        { val: "4", label: "4 variations" }
      ]
    },
    {
      key:  "_extraNotes",
      q:    "Anything else you'd like to add?",
      desc: "The more specific your input, the better the final result.",
      type: "textarea",
      placeholder: "Describe your offer, audience, key messages, or any creative direction…",
      optional: true
    }
  ],

  ugc: [
    {
      key:  "ucAvatar",
      type: "avatar-picker",
      q:    "Choose your creator.",
      desc: "Select the AI creator that will deliver your ad."
    },
    {
      key:  "ucScriptMode",
      q:    "How do you want the script?",
      desc: "ORIVEN AI can write a high-converting script, or bring your own.",
      options: [
        { val: "ai",     label: "Write with AI",     desc: "ORIVEN generates a script tailored to your brand" },
        { val: "custom", label: "Use my own script", desc: "Paste a script you've already written" }
      ]
    },
    {
      key:            "ucAdFeeling",
      q:              "What should the ad feel like?",
      desc:           "Controls hook structure, script energy, pacing, and call-to-action.",
      conditional:    "ucScriptMode",
      conditionalVal: "ai",
      options: [
        { val: "viral",       label: "Viral",       desc: "Punchy, shareable, built to spread" },
        { val: "cinematic",   label: "Cinematic",   desc: "Evocative, visual, emotionally charged" },
        { val: "emotional",   label: "Emotional",   desc: "Heart-led, personal, drives connection" },
        { val: "aggressive",  label: "Aggressive",  desc: "Direct, bold, no fluff — buy now energy" },
        { val: "luxury",      label: "Luxury",      desc: "Slow, deliberate, aspirational" },
        { val: "startup",     label: "Startup",     desc: "Scrappy, exciting, disruption energy" },
        { val: "friendly",    label: "Friendly",    desc: "Warm, helpful, genuinely likeable" },
        { val: "high_energy", label: "High Energy", desc: "Fast, loud, nonstop excitement" }
      ]
    },
    {
      key:            "ucGoal",
      q:              "What's the goal of this ad?",
      desc:           "Shapes the hook angle, CTA style, and script structure.",
      conditional:    "ucScriptMode",
      conditionalVal: "ai",
      options: [
        { val: "sales",     label: "Drive Sales",     desc: "Push toward immediate purchase" },
        { val: "awareness", label: "Brand Awareness", desc: "Introduce the brand and create desire" },
        { val: "downloads", label: "App Downloads",   desc: "Drive installs and first opens" },
        { val: "clicks",    label: "Website Clicks",  desc: "Pull traffic to a specific page or offer" },
        { val: "launch",    label: "Product Launch",  desc: "Announce something new with impact" }
      ]
    },
    {
      key:            "ucContext",
      q:              "Any context for the AI? (optional)",
      desc:           "Product name, key benefit, or anything specific the script should mention.",
      type:           "textarea",
      placeholder:    "e.g. ORIVEN AI — the brand OS for modern founders. Key benefit: saves 10+ hours a week.",
      optional:       true,
      maxChars:       400,
      conditional:    "ucScriptMode",
      conditionalVal: "ai"
    },
    {
      key:            "ucCustomScript",
      q:              "Paste your script below.",
      desc:           "Spoken directly by the AI creator. Keep it conversational — aim for 30–60 seconds.",
      type:           "textarea",
      placeholder:    "Paste your UGC script here…",
      optional:       false,
      maxChars:       900,
      conditional:    "ucScriptMode",
      conditionalVal: "custom"
    },
  ],

  web: [
    {
      key:  "webType",
      q:    "What kind of website do you need?",
      desc: "Choose the type that best matches your goal — this shapes the structure and content.",
      options: [
        { val: "one-page",  label: "One Page",         desc: "Single scroll — intro, features, contact" },
        { val: "portfolio", label: "Portfolio",         desc: "Showcase your work or personal brand" },
        { val: "saas",      label: "SaaS / Startup",   desc: "Feature-rich product site with pricing" },
        { val: "ecommerce", label: "E-commerce",        desc: "Products, store layout, and CTAs" },
        { val: "agency",    label: "Agency / Service",  desc: "Services, case studies, and contact" },
        { val: "landing",   label: "Landing Page",      desc: "Single goal — one offer, one CTA" }
      ]
    },
    {
      key:         "webPromotion",
      q:           "What are you promoting?",
      desc:        "Describe the product, service, or offer this website is for.",
      type:        "textarea",
      placeholder: "e.g. A SaaS tool for freelance designers that automates invoicing…",
      optional:    false
    },
    {
      key:  "webStyle",
      q:    "What design style do you want?",
      desc: "Sets the visual language and layout density of the page.",
      options: [
        { val: "minimal",    label: "Minimal" },
        { val: "modern",     label: "Modern" },
        { val: "bold",       label: "Bold" },
        { val: "luxury",     label: "Luxury" },
        { val: "futuristic", label: "Futuristic" },
        { val: "clean",      label: "Clean" },
        { val: "corporate",  label: "Corporate" },
        { val: "playful",    label: "Playful" },
        { val: "elegant",    label: "Elegant" },
        { val: "startup",    label: "Startup" },
        { val: "dark",       label: "Dark" },
        { val: "light",      label: "Light" }
      ]
    },
    {
      key:  "webConversionGoal",
      q:    "What is the primary conversion goal?",
      desc: "Every element on the page will orient toward this goal.",
      options: [
        { val: "signup",    label: "Sign Up / Free Trial" },
        { val: "purchase",  label: "Purchase" },
        { val: "contact",   label: "Contact / Enquiry" },
        { val: "download",  label: "Download" },
        { val: "book_call", label: "Book a Call" },
        { val: "awareness", label: "Brand Awareness" }
      ]
    },
    {
      key:  "webAnimations",
      q:    "What animation style should the page use?",
      desc: "Animations improve feel but may affect load time on slower devices.",
      options: [
        { val: "none",               label: "None" },
        { val: "subtle",             label: "Subtle" },
        { val: "smooth",             label: "Smooth" },
        { val: "fade-in",            label: "Fade In" },
        { val: "slide-up",           label: "Slide Up" },
        { val: "slide-in-left",      label: "Slide Left" },
        { val: "slide-in-right",     label: "Slide Right" },
        { val: "zoom-in",            label: "Zoom In" },
        { val: "parallax",           label: "Parallax" },
        { val: "staggered",          label: "Staggered" },
        { val: "hover-effects",      label: "Hover Effects" },
        { val: "micro-interactions", label: "Micro Interactions" }
      ]
    },
    {
      key:         "_extraNotes",
      q:           "Anything else you'd like to add?",
      desc:        "The more specific your input, the better the final result.",
      type:        "textarea",
      placeholder: "Specific copy direction, color preferences, tone notes, inspiration…",
      optional:    true
    }
  ]

};

// ── State ─────────────────────────────────────────────────────
var _cfType      = null;
var _cfStep      = 0;
var _cfAnswers   = {};
var _cfTypingId  = null;

// ── Type label + icon map ─────────────────────────────────────
var CF_META = {
  image: {
    label: "Image",
    icon: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="16" height="16" rx="3.5"/><circle cx="7" cy="7" r="1.5"/><path d="M2 14l4.5-4.5 3.5 3.5 2.5-2.5 4 4"/></svg>'
  },
  text: {
    label: "Text",
    icon: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 6h14M3 10h9M3 14h11"/></svg>'
  },
  campaign: {
    label: "Campaign",
    icon: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14L6 6l3.5 5.5L12 8l4.5 7"/><circle cx="6" cy="6" r="1"/></svg>'
  },
  web: {
    label: "Web",
    icon: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="18" height="13" rx="2.5"/><path d="M1 6h18"/><path d="M4 4h.01M6.5 4h.01M9 4h.01"/><path d="M6 18h8M10 15v3"/></svg>'
  },
  ugc: {
    label: "UGC Creator",
    icon: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="4" width="12" height="12" rx="2.5"/><path d="M13.5 8L18 6v9l-4.5-2"/></svg>'
  }
};

// ── Open ──────────────────────────────────────────────────────
function openAIFlow(type){
  _cfType    = type;
  _cfStep    = 0;
  _cfAnswers = {};

  var meta  = CF_META[type] || CF_META.image;
  var icon  = document.getElementById("cfTypeIcon");
  var label = document.getElementById("cfTypeLabel");
  if(icon)  icon.innerHTML = meta.icon;
  if(label) label.textContent = meta.label;

  // Clear state
  var hist  = document.getElementById("cfHistory");
  var opts  = document.getElementById("cfOptions");
  var free  = document.getElementById("cfFreeInput");
  var qTxt  = document.getElementById("cfQuestionText");
  var qDesc = document.getElementById("cfQuestionDesc");
  if(hist)  hist.innerHTML = "";
  if(opts)  opts.innerHTML = "";
  if(free)  free.style.display  = "none";
  if(qTxt)  qTxt.textContent    = "";
  if(qDesc) qDesc.textContent   = "";

  // Reset progress
  _cfUpdateProgress(0);

  // Reset question block position
  var block = document.getElementById("cfQuestionBlock");
  if(block){
    block.style.transition = "none";
    block.style.opacity    = "0";
    block.style.transform  = "translateY(20px)";
  }

  // Show overlay
  var overlay = document.getElementById("cfOverlay");
  if(!overlay) return;
  overlay.style.display = "flex";
  overlay.style.opacity = "0";
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      overlay.style.opacity = "1";
      setTimeout(function(){ _cfShowStep(); }, 180);
    });
  });
}

// ── Close ─────────────────────────────────────────────────────
function closeAIFlow(){
  _cfStopTyping();
  var overlay = document.getElementById("cfOverlay");
  if(!overlay) return;
  overlay.style.transition = "opacity 0.25s ease";
  overlay.style.opacity = "0";
  setTimeout(function(){ overlay.style.display = "none"; }, 260);
}

// ── Render current step ───────────────────────────────────────
function _cfShowStep(){
  var steps = CF_FLOWS[_cfType];
  if(!steps) return;
  var step = steps[_cfStep];
  if(!step) return;

  _cfUpdateProgress(_cfStep);

  var qEl   = document.getElementById("cfQuestionText");
  var dEl   = document.getElementById("cfQuestionDesc");
  var opts  = document.getElementById("cfOptions");
  var free  = document.getElementById("cfFreeInput");
  var block = document.getElementById("cfQuestionBlock");

  // Reset children
  if(opts)  { opts.innerHTML = ""; opts.style.opacity = "1"; opts.style.transform = "none"; opts.style.transition = "none"; }
  if(free)  { free.style.display = "none"; free.style.opacity = "1"; free.style.transform = "none"; }
  if(qEl)   qEl.textContent = "";
  if(dEl)   { dEl.textContent = ""; dEl.style.opacity = "0"; }

  // Slide block in
  if(block){
    block.style.transition = "none";
    block.style.opacity    = "0";
    block.style.transform  = "translateY(18px)";
    requestAnimationFrame(function(){
      block.style.transition = "opacity 0.35s ease, transform 0.35s ease";
      block.style.opacity    = "1";
      block.style.transform  = "translateY(0)";
    });
  }

  // Type the question text, then reveal desc + options
  setTimeout(function(){
    _cfTypeText(step.q, function(){
      if(dEl){
        dEl.textContent = step.desc || "";
        dEl.style.transition = "opacity 0.4s ease";
        dEl.style.opacity = "1";
      }
      setTimeout(function(){ _cfRenderOptions(step); }, 120);
    });
  }, 100);
}

// ── Typing animation ──────────────────────────────────────────
function _cfTypeText(text, onDone){
  _cfStopTyping();
  var el = document.getElementById("cfQuestionText");
  if(!el){ if(onDone) onDone(); return; }

  var i     = 0;
  var len   = text.length;
  // Scale speed: 1000ms for short, 1600ms for very long — feels deliberate
  var total = Math.max(900, Math.min(1800, len * 22));
  var delay = Math.round(total / len);

  el.textContent = "";
  el.classList.add("cf-typing");

  _cfTypingId = setInterval(function(){
    el.textContent = text.slice(0, i + 1);
    i++;
    if(i >= len){
      clearInterval(_cfTypingId);
      _cfTypingId = null;
      el.classList.remove("cf-typing");
      if(onDone) onDone();
    }
  }, delay);
}

function _cfStopTyping(){
  if(_cfTypingId){ clearInterval(_cfTypingId); _cfTypingId = null; }
  var el = document.getElementById("cfQuestionText");
  if(el) el.classList.remove("cf-typing");
}

// ── Render options ────────────────────────────────────────────
function _cfRenderOptions(step){
  var opts = document.getElementById("cfOptions");
  var free = document.getElementById("cfFreeInput");
  if(!opts) return;

  // ── Avatar picker — format tabs + real HeyGen thumbnails + ratio detection ──
  if(step.type === "avatar-picker"){
    if(free) free.style.display = "none";
    opts.className = "cf-options cf-avatar-grid-wrap";
    opts.innerHTML = '<div class="cf-avatar-loading">'
      + '<div class="spin" style="width:18px;height:18px;border-width:2px;margin:0 auto 12px;display:block"></div>'
      + '<span>Loading creators…</span></div>';
    opts.style.opacity   = "1";
    opts.style.transform = "none";

    var capturedStep  = step;
    var _cfActiveFmt  = "vertical";  // default format tab

    // Filter grid cards by the active format tab
    function _applyFmtFilter(grid){
      grid.querySelectorAll(".cf-avatar-card").forEach(function(card){
        var ratio = card.dataset.ratio || "all";
        card.style.display = (ratio === "all" || ratio === _cfActiveFmt) ? "" : "none";
      });
    }

    // Async: load video metadata to detect native aspect ratio
    // Uses loadedmetadata (downloads only container headers, not full video)
    function _detectRatios(avatars, cardMap, grid){
      avatars.slice(0, 50).forEach(function(avatar){
        var card = cardMap[avatar.avatar_id];
        if(!card || !avatar.preview_video_url) return;
        var vid  = document.createElement("video");
        var done = false;
        var timer = setTimeout(function(){
          if(done) return; done = true;
          vid.src = "";
          // no update — stays 'all', filter unchanged
        }, 5000);
        vid.addEventListener("loadedmetadata", function(){
          if(done) return; done = true;
          clearTimeout(timer);
          var w = vid.videoWidth, h = vid.videoHeight;
          vid.src = "";
          if(!w || !h) return;
          var r = w / h;
          card.dataset.ratio = r < 0.75 ? "vertical" : r > 1.4 ? "landscape" : "square";
          _applyFmtFilter(grid);
        });
        vid.addEventListener("error", function(){
          if(done) return; done = true;
          clearTimeout(timer);
          vid.src = "";
        });
        vid.preload = "metadata";
        vid.src = avatar.preview_video_url;
      });
    }

    SB.auth.getSession().then(function(s){
      var token = s && s.data && s.data.session && s.data.session.access_token;
      if(!token){ opts.innerHTML = '<p class="cf-avatar-err">Please sign in to browse creators.</p>'; return null; }
      return Promise.all([
        apiFetch("/api/ugc-avatars", { headers: { "Authorization": "Bearer " + token } }),
        apiFetch("/api/ugc-voices",  { headers: { "Authorization": "Bearer " + token } })
      ]);
    }).then(function(results){
      if(!results) return;
      var avatars = (results[0].ok && results[0].data && results[0].data.avatars) || [];
      var voices  = (results[1].ok && results[1].data && results[1].data.voices)   || [];

      var femaleVoice  = voices.find(function(v){ return (v.gender||"").toLowerCase() === "female"; });
      var maleVoice    = voices.find(function(v){ return (v.gender||"").toLowerCase() === "male";   });
      var defaultVoice = femaleVoice || maleVoice || voices[0] || {};

      if(!avatars.length){
        opts.innerHTML = "<p class=\"cf-avatar-err\">No creators found. Check your HeyGen API key.</p>";
        return;
      }

      opts.innerHTML = "";
      opts.className = "cf-options cf-avatar-grid-wrap";
      console.log("[UGC] Fetched", avatars.length, "avatars from HeyGen");

      // ── Format tabs ────────────────────────────────────────────
      var tabsEl = document.createElement("div");
      tabsEl.className = "cf-fmt-tabs";

      var FMT_TABS = [
        { val: "vertical",  label: "Vertical",  ratio: "9:16" },
        { val: "square",    label: "Square",    ratio: "1:1"  },
        { val: "landscape", label: "Landscape", ratio: "16:9" },
      ];
      FMT_TABS.forEach(function(fmt){
        var btn = document.createElement("button");
        btn.type      = "button";
        btn.className = "cf-fmt-tab" + (fmt.val === "vertical" ? " cf-fmt-tab-active" : "");
        btn.dataset.fmt = fmt.val;
        btn.innerHTML = '<span class="cf-fmt-ratio">' + fmt.ratio + '</span>'
                      + '<span class="cf-fmt-label">' + fmt.label + '</span>';
        btn.onclick = function(){
          _cfActiveFmt = fmt.val;
          tabsEl.querySelectorAll(".cf-fmt-tab").forEach(function(t){
            t.classList.toggle("cf-fmt-tab-active", t.dataset.fmt === fmt.val);
          });
          _applyFmtFilter(grid);
        };
        tabsEl.appendChild(btn);
      });
      opts.appendChild(tabsEl);

      // ── Avatar grid ────────────────────────────────────────────
      var grid    = document.createElement("div");
      grid.className = "cf-avatar-grid";
      opts.appendChild(grid);

      var cardMap = {};

      avatars.forEach(function(avatar){
        var gender    = (avatar.gender || "").toLowerCase();
        var voiceObj  = gender === "female" ? (femaleVoice || defaultVoice)
                      : gender === "male"   ? (maleVoice   || defaultVoice)
                      : defaultVoice;
        var voiceId   = voiceObj.voice_id || "";
        var name      = avatar.avatar_name || avatar.avatar_id;
        var thumb     = avatar.preview_image_url || "";
        var videoUrl  = avatar.preview_video_url  || "";

        var card = document.createElement("button");
        card.type         = "button";
        card.className    = "cf-avatar-card";
        card.dataset.ratio = "all";  // classified async; all tabs show it until detected

        var thumbHtml = thumb
          ? '<img src="' + _cfEsc(thumb) + '" class="cf-avatar-thumb" loading="lazy" />'
          : '<div class="cf-avatar-thumb cf-avatar-nothumb"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>';

        card.innerHTML = thumbHtml
          + (videoUrl ? '<div class="cf-avatar-play-hint"></div>' : '')
          + '<span class="cf-avatar-name">' + _cfEsc(name) + '</span>';

        // ── Video hover preview ───────────────────────────────
        if(videoUrl && thumb){
          card.addEventListener("mouseenter", function(){
            if(card.querySelector("video.cf-avatar-thumb")) return;
            var img = card.querySelector("img.cf-avatar-thumb");
            if(!img) return;
            var vid = document.createElement("video");
            vid.src = videoUrl; vid.className = "cf-avatar-thumb";
            vid.autoplay = true; vid.muted = true;
            vid.loop = true; vid.playsInline = true;
            card.replaceChild(vid, img);
            vid.play().catch(function(){});
          });
          card.addEventListener("mouseleave", function(){
            var vid = card.querySelector("video.cf-avatar-thumb");
            if(!vid) return;
            var img = document.createElement("img");
            img.src = thumb; img.className = "cf-avatar-thumb"; img.loading = "lazy";
            card.replaceChild(img, vid);
          });
        }

        card.onclick = function(){
          grid.querySelectorAll(".cf-avatar-card").forEach(function(c){
            c.classList.remove("cf-avatar-selected"); c.disabled = true;
          });
          card.classList.add("cf-avatar-selected"); card.disabled = false;
          _cfAnswers[capturedStep.key] = {
            val:     avatar.avatar_id,
            label:   name,
            voiceId: voiceId,
            gender:  gender,
            format:  _cfActiveFmt,
          };
          console.log("[UGC] Avatar selected:", avatar.avatar_id,
            "| format:", _cfActiveFmt, "| voice:", voiceId);
          setTimeout(function(){ _cfAdvance(capturedStep, name); }, 340);
        };

        cardMap[avatar.avatar_id] = card;
        grid.appendChild(card);
      });

      // ── "Create Your Creator" stub ────────────────────────────
      var createCard = document.createElement("button");
      createCard.type          = "button";
      createCard.className     = "cf-avatar-card cf-avatar-create";
      createCard.dataset.ratio = "all";
      createCard.innerHTML =
        '<div class="cf-avatar-thumb cf-avatar-create-thumb">'
        + '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>'
        + '</div>'
        + '<span class="cf-avatar-name">Create Creator</span>';
      createCard.onclick = function(){
        if(typeof toast === "function") toast("Custom creator upload — coming soon", "info");
      };
      grid.appendChild(createCard);

      // ── Async ratio detection — runs in background ────────────
      // Detects video native aspect ratio, updates data-ratio, re-filters
      _detectRatios(avatars, cardMap, grid);

    }).catch(function(err){
      opts.innerHTML = '<p class="cf-avatar-err">Could not load creators: ' + _cfEsc(err.message) + '</p>';
    });
    return;
  }

  if(step.type === "textarea"){
    opts.innerHTML = "";
    if(free){
      var ta      = document.getElementById("cfTextarea");
      var skip    = document.getElementById("cfSkipBtn");
      var counter = document.getElementById("cfCharCounter");

      // Remove stale counter from previous step
      if(counter) counter.parentNode.removeChild(counter);

      if(ta){ ta.value = ""; ta.setAttribute("placeholder", step.placeholder || "Type here…"); ta.oninput = null; }
      if(skip) skip.style.display = step.optional ? "" : "none";

      // Inject live counter for steps with a character cap
      if(step.maxChars && ta){
        var ctr = document.createElement("div");
        ctr.id        = "cfCharCounter";
        ctr.className = "cf-char-counter";
        ctr.innerHTML = "0 / " + step.maxChars + " chars";
        ta.parentNode.insertBefore(ctr, ta.nextSibling);

        ta.oninput = function(){
          var len  = ta.value.length;
          var sec  = Math.round(len / 12);
          ctr.innerHTML = len + " / " + step.maxChars + " chars · ~" + sec + "s";
          ctr.className = "cf-char-counter"
            + (len > step.maxChars ? " cf-char-over" : len > step.maxChars * 0.8 ? " cf-char-warn" : "");
        };
      }

      free.style.display   = "";
      free.style.opacity   = "0";
      free.style.transform = "translateY(10px)";
      free.style.transition = "none";
      requestAnimationFrame(function(){
        free.style.transition = "opacity 0.3s ease, transform 0.3s ease";
        free.style.opacity   = "1";
        free.style.transform = "translateY(0)";
      });
      if(ta) setTimeout(function(){ ta.focus(); }, 320);
    }
    return;
  }

  var isCard = step.options && step.options[0] && step.options[0].desc;
  opts.className = "cf-options" + (isCard ? " cf-opts-cards" : "");

  var html = "";
  if(isCard){
    (step.options || []).forEach(function(opt, i){
      html += '<button class="cf-opt-card" onclick="cfSelectOpt(' + i + ')">'
            + '<span class="cf-opt-card-label">' + _cfEsc(opt.label) + '</span>'
            + '<span class="cf-opt-card-desc">'  + _cfEsc(opt.desc)  + '</span>'
            + '</button>';
    });
  } else {
    // Pill options — staggered fade-in
    (step.options || []).forEach(function(opt, i){
      html += '<button class="cf-opt" style="animation-delay:' + (i * 45) + 'ms" '
            + 'onclick="cfSelectOpt(' + i + ')">'
            + _cfEsc(opt.label)
            + '</button>';
    });
  }
  opts.innerHTML = html;
  opts.style.opacity   = "0";
  opts.style.transform = "translateY(10px)";
  opts.style.transition = "none";
  requestAnimationFrame(function(){
    opts.style.transition = "opacity 0.28s ease, transform 0.28s ease";
    opts.style.opacity   = "1";
    opts.style.transform = "translateY(0)";
  });
}

// ── Option selected ───────────────────────────────────────────
function cfSelectOpt(idx){
  var steps = CF_FLOWS[_cfType];
  if(!steps) return;
  var step = steps[_cfStep];
  if(!step || !step.options) return;
  var opt = step.options[idx];
  if(!opt) return;

  // Visual feedback (supports both pill and card layouts)
  var btns = document.querySelectorAll("#cfOptions .cf-opt, #cfOptions .cf-opt-card");
  btns.forEach(function(b, i){ b.classList.toggle("cf-opt-selected", i === idx); });
  btns.forEach(function(b, i){ if(i !== idx) b.disabled = true; });

  _cfAnswers[step.key] = { val: opt.val, label: opt.label };
  setTimeout(function(){ _cfAdvance(step, opt.label); }, 340);
}

// ── Text submitted ────────────────────────────────────────────
function cfSubmitText(){
  var ta    = document.getElementById("cfTextarea");
  var val   = ta ? ta.value.trim() : "";
  var steps = CF_FLOWS[_cfType];
  if(!steps) return;
  var step  = steps[_cfStep];
  if(!step) return;
  if(step.maxChars && val.length > step.maxChars){
    if(typeof toast === "function") toast("Script too long — keep it under " + step.maxChars + " characters (~60 seconds)", "warn");
    return;
  }
  _cfAnswers[step.key] = { val: val, label: val ? val.slice(0, 48) + (val.length > 48 ? "…" : "") : "Added details" };
  _cfAdvance(step, _cfAnswers[step.key].label);
}

function cfSkipStep(){
  var steps = CF_FLOWS[_cfType];
  if(!steps) return;
  var step  = steps[_cfStep];
  if(!step) return;
  _cfAnswers[step.key] = { val: "", label: "Skipped" };
  _cfAdvance(step, "Skipped");
}

// ── Advance: move Q to history, show next ─────────────────────
function _cfAdvance(step, answerLabel){
  _cfStopTyping();

  var block = document.getElementById("cfQuestionBlock");
  var opts  = document.getElementById("cfOptions");
  var free  = document.getElementById("cfFreeInput");

  // Fade out options
  if(opts){ opts.style.transition = "opacity 0.15s ease"; opts.style.opacity = "0"; }
  if(free){ free.style.transition = "opacity 0.15s ease"; free.style.opacity = "0"; }

  setTimeout(function(){
    // Push to history
    _cfAppendHistory(step.q, answerLabel);

    // Slide question up and out
    if(block){
      block.style.transition = "opacity 0.2s ease, transform 0.2s ease";
      block.style.opacity    = "0";
      block.style.transform  = "translateY(-14px)";
    }

    setTimeout(function(){
      _cfStep++;
      var steps = CF_FLOWS[_cfType];

      // Skip conditional steps whose condition is not met
      while(steps && _cfStep < steps.length){
        var nextStep = steps[_cfStep];
        if(nextStep && nextStep.conditional){
          var condAnswer = _cfAnswers[nextStep.conditional];
          if(!condAnswer || condAnswer.val !== nextStep.conditionalVal){
            _cfStep++;
            continue;
          }
        }
        break;
      }

      if(!steps || _cfStep >= steps.length){
        _cfLaunch();
        return;
      }

      // Reset everything for next step
      if(opts){ opts.innerHTML = ""; opts.style.opacity = "1"; opts.style.transform = "none"; }
      if(free){ free.style.display = "none"; free.style.opacity = "1"; free.style.transform = "none"; }

      _cfShowStep();
    }, 220);
  }, 160);
}

// ── Append answered question to history ───────────────────────
function _cfAppendHistory(question, answer){
  var hist = document.getElementById("cfHistory");
  if(!hist) return;

  var item = document.createElement("div");
  item.className = "cf-hist-item";
  item.innerHTML =
    '<span class="cf-hist-q">' + _cfEsc(question) + '</span>'
  + '<span class="cf-hist-sep">&#8250;</span>'
  + '<span class="cf-hist-a">' + _cfEsc(answer) + '</span>';

  hist.appendChild(item);
  item.style.opacity   = "0";
  item.style.transform = "translateY(-5px)";
  item.style.transition = "none";
  requestAnimationFrame(function(){
    item.style.transition = "opacity 0.28s ease, transform 0.28s ease";
    item.style.opacity   = "1";
    item.style.transform = "translateY(0)";
  });
  hist.scrollTop = hist.scrollHeight;
}

// ── Update progress bar ───────────────────────────────────────
function _cfUpdateProgress(stepIndex){
  var steps = CF_FLOWS[_cfType];
  var total = steps ? steps.length : 1;
  var pct   = Math.round((stepIndex / total) * 100);
  var fill  = document.getElementById("cfProgressFill");
  if(fill) fill.style.width = pct + "%";
}

// ── Launch builder with conversation answers ──────────────────
function _cfLaunch(){
  // Show a brief "generating" state in the overlay before closing
  var block = document.getElementById("cfQuestionBlock");
  var opts  = document.getElementById("cfOptions");
  var free  = document.getElementById("cfFreeInput");
  var fill  = document.getElementById("cfProgressFill");

  if(opts)  { opts.style.opacity = "0"; }
  if(free)  { free.style.display = "none"; }
  if(fill)  fill.style.width = "100%";

  if(block){
    block.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    block.style.opacity    = "0";
    block.style.transform  = "translateY(-10px)";
  }

  setTimeout(function(){
    // Show generating message
    var qEl   = document.getElementById("cfQuestionText");
    var dEl   = document.getElementById("cfQuestionDesc");
    var _typeName = (CF_META[_cfType] && CF_META[_cfType].label) || _cfType;
    if(qEl)   qEl.textContent = _cfType === "ugc" ? "Generating your UGC video…" : "Building your " + _typeName + "…";
    if(dEl)   dEl.textContent = _cfType === "ugc" ? "Submitting your brief to HeyGen." : "Sending your brief to ORIVEN AI.";

    if(block){
      block.style.transition = "none";
      block.style.opacity    = "0";
      block.style.transform  = "translateY(12px)";
      requestAnimationFrame(function(){
        block.style.transition = "opacity 0.3s ease, transform 0.3s ease";
        block.style.opacity    = "1";
        block.style.transform  = "translateY(0)";
      });
    }

    setTimeout(function(){
      closeAIFlow();
      if(_cfType === "ugc"){
        _cfDispatchUGC();
      } else {
        _cfDispatch();
      }
    }, 520);
  }, 200);
}

// ── Transfer answers to S._builder and run generation ─────────
function _cfDispatch(){
  S._builderType = _cfType;
  if(!S._builder) S._builder = {};

  // Write all conversation answers into S._builder
  Object.keys(_cfAnswers).forEach(function(key){
    S._builder[key] = _cfAnswers[key].val;
  });

  // Fill defaults for fields builder expects that the conversation skips
  if(_cfType === "image"){
    if(!S._builder.imgFormat)    S._builder.imgFormat    = "1:1";
    S._builder._hasText      = "no";
    S._builder.imgTextStyle  = "clean";
    S._builder.imgHeadline   = "";
    S._builder.imgSubtext    = "";
    S._builder.imgCta        = "";
  } else if(_cfType === "campaign"){
    if(!S._builder.campVariations) S._builder.campVariations = "3";
    if(!S._builder.campFormat)     S._builder.campFormat = "square";
    if(!S._builder.campSubject)    S._builder.campSubject = "brand";
  } else if(_cfType === "web"){
    if(!S._builder.webStyle)      S._builder.webStyle      = "modern";
    if(!S._builder.webAnimations) S._builder.webAnimations = "subtle";
    // Map website type → default sections
    var _webTypeSections = {
      "one-page":  ["hero","features","about","contact"],
      "portfolio": ["hero","showcase","about","contact"],
      "saas":      ["hero","features","testimonials","pricing","cta"],
      "ecommerce": ["hero","showcase","features","cta"],
      "agency":    ["hero","features","showcase","testimonials","contact"],
      "landing":   ["hero","benefits","cta"]
    };
    var _wt = S._builder.webType || "saas";
    S._builder._webTypeDefaultSections = _webTypeSections[_wt] || ["hero","features","cta"];
  }

  // Set up builder page (matches openBuilder() setup)
  var pill     = document.getElementById("flowBrandPill");
  var pillName = document.getElementById("flowBrandName");
  if(pill){
    if(S.brandCore && S.brandCore.name){
      pill.style.display = "";
      if(pillName) pillName.textContent = S.brandCore.name;
    } else {
      pill.style.display = "none";
    }
  }

  var resultWrap = document.getElementById("builderResultWrap");
  if(resultWrap) resultWrap.style.display = "none";
  S._lastBuilderResult = null;

  // Initialize S._flow so _flowGenerate() doesn't crash on S._flow.answers
  S._flow = { type: _cfType, stepIndex: 0, answers: {}, activeSteps: [] };

  // Navigate then trigger generation (web shows brand confirm; others auto-generate)
  navigate("builder");
  if(_cfType === "web"){
    setTimeout(function(){ _showWebBrandConfirm(); }, 90);
  } else {
    setTimeout(function(){ _flowGenerate(); }, 90);
  }
}

// ── UGC flow dispatch — opens result overlay + triggers generation ──
function _cfDispatchUGC(){
  var a = _cfAnswers;

  _ucScriptMode  = (a.ucScriptMode && a.ucScriptMode.val) || "ai";
  _ucVideoFormat = (a.ucAvatar     && a.ucAvatar.format)   || "vertical";
  _ucAdFeeling   = (a.ucAdFeeling  && a.ucAdFeeling.val)  || "viral";

  // Avatar is now directly selected by the user from real HeyGen data
  var avatarAnswer = a.ucAvatar;
  if(avatarAnswer && avatarAnswer.val){
    _ucSelectedCreator = {
      id:       "custom",
      label:    avatarAnswer.label   || "Creator",
      avatarId: avatarAnswer.val,
      voiceId:  avatarAnswer.voiceId || "",
      background: null,
    };
  } else {
    _ucSelectedCreator = null;
  }
  // Use avatar's natural built-in scene — no separate background override
  _ucSelectedBg = null;

  // Reset video state
  _ucActiveId = null;
  if(typeof _ucPollTimer !== "undefined" && _ucPollTimer){
    clearInterval(_ucPollTimer); _ucPollTimer = null;
  }

  // Clear result UI
  var statusWrap = document.getElementById("ucStatusWrap");
  var videoWrap  = document.getElementById("ucVideoWrap");
  var retryRow   = document.getElementById("ucRetryRow");
  var newRow     = document.getElementById("ucNewRow");
  if(statusWrap) statusWrap.innerHTML = "";
  if(videoWrap)  videoWrap.style.display  = "none";
  if(retryRow)   retryRow.style.display   = "none";
  if(newRow)     newRow.style.display     = "none";

  // Open the result overlay
  var overlay = document.getElementById("ucOverlay");
  if(overlay){
    overlay.style.display    = "flex";
    overlay.style.opacity    = "0";
    overlay.style.transition = "none";
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        overlay.style.transition = "opacity 0.25s ease";
        overlay.style.opacity    = "1";
      });
    });
  }

  // Trigger generation after overlay is visible
  setTimeout(function(){
    if(typeof ucGenerateFromFlow === "function") ucGenerateFromFlow(a);
  }, 280);
}

// ── HTML escape ───────────────────────────────────────────────
function _cfEsc(s){
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
