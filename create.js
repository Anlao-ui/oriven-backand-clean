// ═══ CREATE PAGE ══════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// IMAGE — type / format definitions (used by prompt builders)
// ════════════════════════════════════════════════════════════════

var IMG_TYPES = {
  visual: {
    label: "Visuals",
    formats: [
      { id:"square",   label:"Square",     ratio:"1:1",  hint:"1024×1024" },
      { id:"wide",     label:"Widescreen", ratio:"16:9", hint:"1792×1024" },
      { id:"portrait", label:"Portrait",   ratio:"3:4",  hint:"1024×1792" }
    ],
    rules: "Create a premium, editorial brand visual. Composition must be deliberate and strong — clear focal point, intentional use of negative space. Colour palette must reflect the brand identity provided. No text overlays unless explicitly requested. Lighting must be purposeful. The output must look like a professional brand shoot or high-end design asset."
  },
  poster: {
    label: "Posters",
    formats: [
      { id:"a4",     label:"A4 Poster",     ratio:"1:1.41", hint:"Portrait" },
      { id:"a3",     label:"A3 Poster",     ratio:"1:1.41", hint:"Portrait" },
      { id:"square", label:"Square Poster", ratio:"1:1",    hint:"1024×1024" }
    ],
    rules: "Create a bold, typographically strong poster with a clear, dominant visual hierarchy. High-contrast, intentional colour blocking. Structured, impactful layout that feels like professional print design."
  },
  social: {
    label: "Social Media",
    formats: [
      { id:"ig_post",  label:"Instagram Post",    ratio:"1:1",  hint:"1024×1024"  },
      { id:"ig_story", label:"Instagram Story",   ratio:"9:16", hint:"1024×1792"  },
      { id:"tiktok",   label:"TikTok / Reel",     ratio:"9:16", hint:"1024×1792"  },
      { id:"yt_thumb", label:"YouTube Thumbnail", ratio:"16:9", hint:"1792×1024"  },
      { id:"ad_45",    label:"Ad Creative",       ratio:"4:5",  hint:"1024×1024"  }
    ],
    rules: "Create a scroll-stopping social media design that commands attention immediately. Bold colour, strong contrast, single dominant visual element. Clean and intentional — never two competing focal points."
  }
};

// ════════════════════════════════════════════════════════════════
// SIZE RESOLUTION
// DALL-E 3 ONLY supports: 1024x1024 | 1024x1792 | 1792x1024
// ════════════════════════════════════════════════════════════════

function _ratioToDallESize(ratio){
  if(ratio === "16:9")   return "1792x1024";
  if(ratio === "9:16")   return "1024x1792";
  if(ratio === "3:4")    return "1024x1792";
  if(ratio === "1:1.41") return "1024x1792";
  return "1024x1024";
}

// ── Color formatter — handles {name,hex} objects or plain strings ──
function _formatBrandColors(colors){
  if(!colors || !colors.length) return null;
  return colors.map(function(c){
    if(c && typeof c === "object"){
      var str = (c.name || "").trim();
      if(c.hex) str += (str ? " " : "") + c.hex;
      return str || null;
    }
    return String(c) || null;
  }).filter(Boolean).join(", ");
}


// ════════════════════════════════════════════════════════════════
// ADS — format definitions
// ════════════════════════════════════════════════════════════════

var ADS_FORMATS = {
  meta_feed: { label:"Meta Feed Ad",       ratio:"4:5",  hint:"4:5",          platform:"Meta — Facebook / Instagram Feed",   rules:"High-converting Meta feed ad. Focal point in the top two-thirds. Strong contrast, single clear headline, urgent CTA." },
  square:    { label:"Square Ad",          ratio:"1:1",  hint:"1:1",          platform:"Meta — Facebook / Instagram Square", rules:"Compact, balanced square ad. Readable and impactful at a glance. Versatile and clean." },
  story:     { label:"Story / Reel Ad",    ratio:"9:16", hint:"9:16 vertical", platform:"Instagram / Facebook Story & Reel",  rules:"Full-screen vertical story ad. Impact in the first 2 seconds. Bold visual or headline at top. Brand and CTA prominent." },
  tiktok:    { label:"TikTok Ad",          ratio:"9:16", hint:"9:16 vertical", platform:"TikTok",                             rules:"Vertical TikTok ad — native, authentic, energetic. Not polished-corporate. Hook leads. Brand integrated, not plastered." },
  youtube:   { label:"YouTube Ad",         ratio:"16:9", hint:"16:9 widescreen",platform:"YouTube",                           rules:"Cinematic widescreen YouTube ad. Opening frame justifies staying past skip. Strong horizontal composition, premium feel." }
};

function adsSelectFormat(fmtId){
  S._adsFormat = fmtId;
  document.querySelectorAll("#adsFormatPills .img-pill").forEach(function(btn){
    btn.classList.toggle("active", btn.dataset.afmt === fmtId);
  });
}


// ════════════════════════════════════════════════════════════════
// CAMPAIGN — pack definitions
// ════════════════════════════════════════════════════════════════

var CAMPAIGN_PACKS = {
  meta:     { label:"Meta Campaign Pack",      hint:"Feed · Story · Square", assets:[{label:"Feed Asset",ratio:"4:5",purpose:"awareness",platform:"Meta Feed"},{label:"Story Asset",ratio:"9:16",purpose:"engagement",platform:"Instagram Story"},{label:"Square Retargeting",ratio:"1:1",purpose:"retargeting",platform:"Meta Square"}], rules:"Cohesive Meta pack. 4:5 bold scroll-stopper. 9:16 full-screen native. 1:1 conversion-focused. Unified visual language." },
  social:   { label:"Social Launch Pack",      hint:"Story · Post · Thumb",  assets:[{label:"Story/Reel",ratio:"9:16",purpose:"awareness",platform:"Instagram Story/Reel"},{label:"Feed Post",ratio:"1:1",purpose:"engagement",platform:"Instagram Feed"},{label:"YouTube Thumbnail",ratio:"16:9",purpose:"conversion",platform:"YouTube"}], rules:"Social launch pack. 9:16 leads with maximum energy. 1:1 deepens with brand storytelling. 16:9 click-worthy thumbnail." },
  vertical: { label:"Vertical Content Pack",   hint:"Reel · TikTok",         assets:[{label:"Instagram Reel",ratio:"9:16",purpose:"engagement",platform:"Instagram Reel"},{label:"TikTok Content",ratio:"9:16",purpose:"awareness",platform:"TikTok"}], rules:"Vertical content pack. Instagram Reel: polished, brand-aligned. TikTok: native, organic, energetic." },
  full:     { label:"Full Campaign Pack",       hint:"4 formats",             assets:[{label:"Feed Asset",ratio:"4:5",purpose:"awareness",platform:"Meta Feed"},{label:"Story/Reel Asset",ratio:"9:16",purpose:"engagement",platform:"Story/Reel"},{label:"Square Asset",ratio:"1:1",purpose:"retargeting",platform:"Meta/Instagram"},{label:"YouTube/Widescreen",ratio:"16:9",purpose:"conversion",platform:"YouTube"}], rules:"Full funnel pack. 4:5 awareness. 9:16 engagement. 1:1 retargeting. 16:9 conversion. Rigid consistency across all four." }
};

function campaignSelectPack(packId){
  S._campPack = packId;
  document.querySelectorAll("#campPackPills .img-pill").forEach(function(btn){
    btn.classList.toggle("active", btn.dataset.cpack === packId);
  });
}


// ════════════════════════════════════════════════════════════════
// VIDEO — format definitions and prompt builder (chat-based)
// ════════════════════════════════════════════════════════════════

var VIDEO_FORMATS = {
  short_vertical: { label:"Short Vertical Video", ratio:"9:16", duration:"15–30 seconds", hint:"9:16 · 15–30s", rules:"Hook in first 2 seconds. Structure: Hook → Tension → Solution → Brand → CTA. Works with sound off." },
  standard_ad:    { label:"Standard Video Ad",     ratio:"16:9", duration:"15–30 seconds", hint:"16:9 · 15–30s", rules:"First 5 seconds must justify continued viewing. Structure: Hook → Build → Solution → CTA. Cinematic and brand-aligned." },
  square_promo:   { label:"Square Promo Video",    ratio:"1:1",  duration:"15–30 seconds", hint:"1:1 · 15–30s",  rules:"Designed for 1:1 — all key elements centred. Structure: Reveal → Key Benefit → Brand → CTA. Feed-optimised." },
  hook_bumper:    { label:"Hook / Bumper Video",   ratio:"Any",  duration:"~6 seconds",    hint:"Any format · 6s", rules:"Full message in the first frame. Single visual → Brand → CTA. No build-up. No wasted frames." },
  tiktok_reel:    { label:"TikTok / Reel Video",   ratio:"9:16", duration:"15–60 seconds", hint:"9:16 · 15–60s",  rules:"Hook is the most interesting moment — lead with it. Native tone: direct, energetic, real. Brand integrated organically." }
};

function videoSelectFormat(fmtId){
  S._vidFormat = fmtId;
  document.querySelectorAll("#vidFormatPills .img-pill").forEach(function(btn){
    btn.classList.toggle("active", btn.dataset.vfmt === fmtId);
  });
  var inp = document.getElementById("cwsInput");
  if(inp){
    var fmt = VIDEO_FORMATS[fmtId];
    if(fmt) inp.placeholder = "Describe the video — e.g. 'A " + fmt.duration + " " + fmt.label.toLowerCase() + " for our product launch'";
  }
}

function buildVideoPrompt(userDesc){
  var fmtId = S._vidFormat || "short_vertical";
  var fmt   = VIDEO_FORMATS[fmtId] || VIDEO_FORMATS.short_vertical;
  var bc    = S.brandCore;
  var parts = [];
  parts.push("VIDEO FORMAT: " + fmt.label + " — Aspect ratio: " + fmt.ratio + " — Duration: " + fmt.duration + ".");
  parts.push("VIDEO RULES (non-negotiable): " + fmt.rules);
  parts.push("VIDEO BRIEF: " + userDesc);
  if(bc && bc.name){
    var bLines = ["BRAND IDENTITY:"];
    bLines.push("Brand: " + bc.name);
    var cs = _formatBrandColors(bc.colors);
    if(cs) bLines.push("Colours: " + cs);
    if(bc.tone)     bLines.push("Tone: " + (Array.isArray(bc.tone) ? bc.tone.join(", ") : bc.tone));
    if(bc.audience) bLines.push("Audience: " + bc.audience);
    if(bc.style)    bLines.push("Style: " + bc.style);
    if(bc.promise)  bLines.push("Brand promise: " + bc.promise);
    parts.push(bLines.join("\n"));
  }
  parts.push("OUTPUT STRUCTURE: Generate a complete production-ready brief:\nTITLE:\nCONCEPT:\nTARGET AUDIENCE:\nHOOK:\nSCENES: (numbered)\nVOICEOVER / SCRIPT:\nVISUAL STYLE:\nEDITING STYLE:\nCTA:\n\nMake every section specific, actionable, and production-ready.");
  return parts.join("\n\n");
}


// ════════════════════════════════════════════════════════════════
// TEXT — type definitions (used by builder)
// ════════════════════════════════════════════════════════════════

var TEXT_TYPES = {
  headlines:    { label:"Headlines",            placeholder:"What is the headline for?",                    rules:"Generate 5 distinct headline options. Sharp, specific, benefit-forward. No 'Introducing' or 'Welcome to'. Vary angle: benefit, emotion, urgency, curiosity, authority." },
  body_copy:    { label:"Body Copy",            placeholder:"What is the copy for?",                        rules:"Professional brand body copy. Open with the most compelling idea. Short paragraphs. No filler, no clichés, no 'passionate' or 'dedicated'. End with a strong directional statement." },
  captions:     { label:"Captions",             placeholder:"Describe the post and context",                rules:"3 distinct captions at different tonal registers. Strong first line (hooks before 'more' cutoff). Natural, direct language. Clear CTA or invitation. 3–5 hashtags at end of each." },
  hooks:        { label:"Hooks",                placeholder:"What context are these hooks for?",            rules:"6 distinct hooks. Each must land in 2–3 seconds. Formats: bold claim, provocative question, surprising stat, direct address, pattern interrupt, story opener. Every word counts." },
  product_desc: { label:"Product Description",  placeholder:"Describe the product",                         rules:"Lead with primary benefit, not the product name. Specific, sensory language. Structure: benefit opening → 2–3 features as prose → brand promise. No 'high quality' or generic claims." },
  ad_copy:      { label:"Ad Copy",              placeholder:"Describe the ad campaign and offer",           rules:"3 variants with different angles. Each: Headline (max 8 words), Primary Text (2–3 sentences), CTA (max 4 words). Angle 1: benefit-led. Angle 2: urgency/scarcity. Angle 3: social proof/authority." }
};

function textSelectType(ttype){
  S._txtType = ttype;
  document.querySelectorAll("#txtTypePills .img-pill").forEach(function(btn){
    btn.classList.toggle("active", btn.dataset.ttype === ttype);
  });
  var def = TEXT_TYPES[ttype];
  if(!def) return;
  var inp = document.getElementById("cwsInput");
  if(inp) inp.placeholder = def.placeholder;
}


// ════════════════════════════════════════════════════════════════
// BRAND ASSISTANT — prompt builder + personalized starters
// (chat-based, unchanged)
// ════════════════════════════════════════════════════════════════

function buildAssistantPrompt(userMsg){
  var bc = S.brandCore;
  var parts = [];
  if(bc && bc.name){
    var ctx = "BRAND CONTEXT:\n";
    ctx += "Brand name: " + bc.name + "\n";
    if(bc.promise)  ctx += "Brand promise: " + bc.promise + "\n";
    if(bc.mission)  ctx += "Mission: " + bc.mission + "\n";
    if(bc.vision)   ctx += "Vision: " + bc.vision + "\n";
    if(bc.tone)     ctx += "Tone of voice: " + (Array.isArray(bc.tone) ? bc.tone.join(", ") : bc.tone) + "\n";
    if(bc.audience) ctx += "Target audience: " + bc.audience + "\n";
    if(bc.style)    ctx += "Visual style: " + bc.style + "\n";
    if(bc.diff)     ctx += "Positioning: " + bc.diff + "\n";
    var cs = _formatBrandColors(bc.colors);
    if(cs)          ctx += "Brand colors: " + cs + "\n";
    if(bc.wordsUse   && bc.wordsUse.length)   ctx += "Words to use: "   + bc.wordsUse.join(", ")   + "\n";
    if(bc.wordsAvoid && bc.wordsAvoid.length) ctx += "Words to avoid: " + bc.wordsAvoid.join(", ") + "\n";
    parts.push(ctx.trim());
  }
  parts.push("USER MESSAGE: " + userMsg);
  return parts.join("\n\n");
}

function _buildAssistantStarters(bc){
  if(!bc || !bc.name){
    return [
      "How can I make my brand look more premium and trustworthy to my audience?",
      "What would make my brand's tone of voice feel more distinct and memorable?",
      "How can I improve my brand's visual consistency across platforms?"
    ];
  }
  var name     = bc.name;
  var tone     = bc.tone     ? bc.tone     : "professional";
  var audience = bc.audience ? bc.audience : "my target audience";
  var style    = bc.style    ? bc.style    : "my current visual direction";
  return [
    "How can I make " + name + " look more premium and distinctive to " + audience + "? What specific changes would have the biggest impact?",
    "My brand tone is " + tone + " — how can I push this further to make " + name + " more memorable and consistent?",
    "Looking at " + style + " as my visual direction, what would make " + name + " stand out more clearly in my market?"
  ];
}

function assistantFill(text){
  var inp = document.getElementById("cwsInput");
  if(!inp) return;
  inp.value = text;
  inp.dispatchEvent(new Event("input"));
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}


// ════════════════════════════════════════════════════════════════
// CREATE TYPES
// ════════════════════════════════════════════════════════════════

var CREATE_TYPES = {
  image:     { label:"Image",           outType:"poster",   placeholder:"Describe the visual",                                                                    icon:"<path d='M3 3h10v10H3zM13 8l4-3v8l-4-3'/><circle cx='6.5' cy='6.5' r='1.5'/>" },
  text:      { label:"Text",            outType:"copy",     placeholder:"Describe the copy",                                                                      icon:"<path d='M3 5h10M3 9h7M3 13h9'/>" },
  video:     { label:"Video",           outType:"copy",     placeholder:"Describe the video — e.g. 'A 15-second product launch video for Instagram Reels'",       icon:"<rect x='2' y='4' width='10' height='10' rx='2'/><path d='M12 7l4-2v8l-4-2'/>" },
  ads:       { label:"Ads",             outType:"ad_copy",  placeholder:"Describe the ad",                                                                        icon:"<path d='M2 5h12v8H2z'/><path d='M14 7l2-1v6l-2-1'/>" },
  campaign:  { label:"Campaign",        outType:"campaign", placeholder:"Describe the campaign",                                                                  icon:"<path d='M2 13L5 5l4 5 3-4 4 7'/><circle cx='5' cy='5' r='1'/>" },
  ideas:     { label:"Ideas",           outType:"headline", placeholder:"Describe what you need ideas for — e.g. 'Content ideas for a sustainable fashion brand'", icon:"<circle cx='8' cy='7' r='4'/><path d='M8 11v3M6 14h4'/>" },
  assistant: { label:"Brand Assistant", outType:"copy",     placeholder:"Ask your Brand Assistant anything…",                                                     icon:"<path d='M8 1L10 6H15L11 9L12.5 14L8 11L3.5 14L5 9L1 6H6Z'/>" }
};

var CWS_CFG_MAP = {
  video: "vidCfg"
};

var CWS_ALL_CFGS = ["imgCfg", "adsCfg", "campCfg", "vidCfg", "txtCfg"];


// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  STRUCTURED BUILDER SYSTEM
//  Used by: Image, Text, Ads, Campaign
//  Brand Assistant, Video, Ideas remain chat-based
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════

// ── Pill selector helpers ─────────────────────────────────────

function _bSection(label, stateKey, options, defaultVal){
  return '<div class="builder-section">'
    + '<div class="builder-lbl">' + label + '</div>'
    + _bPills(stateKey, options, defaultVal)
    + '</div>';
}

function _bPills(stateKey, options, defaultVal){
  var current = (S._builder && S._builder[stateKey] != null)
    ? S._builder[stateKey]
    : defaultVal;
  return '<div class="b-pills">'
    + options.map(function(opt){
        return '<button class="b-pill' + (opt.val === current ? " active" : "") + '"'
          + ' data-val="' + opt.val + '"'
          + ' onclick="bPick(\'' + stateKey + '\',\'' + opt.val + '\',this)">'
          + opt.label
          + '</button>';
      }).join("")
    + '</div>';
}

function bPick(stateKey, val, btn){
  if(!S._builder) S._builder = {};
  S._builder[stateKey] = val;
  if(btn && btn.parentNode){
    btn.parentNode.querySelectorAll(".b-pill").forEach(function(p){
      p.classList.toggle("active", p === btn);
    });
  }
}

// ── Subject pill picker — shows/hides model description row ───
function bPickSubject(val, btn){
  bPick("imgSubject", val, btn);
  var row = document.getElementById("imgModelDescRow");
  if(row) row.style.display = (val === "person") ? "" : "none";
}

// ── Reference image helpers ────────────────────────────────────
function _imgRefAreaHtml(){
  var hasRef = S._builder && S._builder.imgRefData;
  if(hasRef){
    return '<div class="img-ref-preview-wrap">'
      + '<img src="' + S._builder.imgRefData + '" class="img-ref-thumb" alt="Reference">'
      + '<div class="img-ref-info">'
      + '<span class="img-ref-label">Reference uploaded</span>'
      + '<button class="btn btn-g btn-sm" onclick="_imgRefRemove()">Remove</button>'
      + '</div></div>';
  }
  return '<div class="img-ref-upload" onclick="_imgRefUpload()" role="button" tabindex="0">'
    + '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">'
    + '<path d="M10 13V3M6 7l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M3 14v1a2 2 0 002 2h10a2 2 0 002-2v-1" opacity=".45" stroke-linecap="round"/>'
    + '</svg>'
    + '<span>Upload reference image</span>'
    + '<span class="img-ref-hint">Style, mood, product, or inspiration</span>'
    + '</div>';
}

function _imgRefUpload(){
  var input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif";
  input.onchange = function(e){
    var file = e.target.files[0];
    if(!file) return;
    if(file.size > 8 * 1024 * 1024){ toast("Reference image must be under 8 MB","warn"); return; }
    var reader = new FileReader();
    reader.onload = function(ev){
      if(!S._builder) S._builder = {};
      S._builder.imgRefData = ev.target.result;
      var area = document.getElementById("imgRefArea");
      if(area) area.innerHTML = _imgRefAreaHtml();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function _imgRefRemove(){
  if(!S._builder) return;
  S._builder.imgRefData = null;
  var area = document.getElementById("imgRefArea");
  if(area) area.innerHTML = _imgRefAreaHtml();
}

// ── Image builder — dynamic type / purpose helpers ────────────

function _imgPurposesForType(typeVal){
  var map = {
    logo:        [{val:"brand_identity",label:"Brand identity"},{val:"rebrand",label:"Rebranding"}],
    social:      [{val:"promotion",label:"Promotion"},{val:"engagement",label:"Engagement"},{val:"brand_awareness",label:"Brand awareness"}],
    ad_creative: [{val:"promotion",label:"Promotion"},{val:"engagement",label:"Engagement"},{val:"brand_awareness",label:"Brand awareness"}],
    product:     [{val:"showcase",label:"Showcase product"},{val:"features",label:"Highlight features"}],
    poster:      [{val:"campaign",label:"Campaign visual"},{val:"storytelling",label:"Brand storytelling"}]
  };
  return map[typeVal] || map.social;
}

function _imgPurposePillsHtml(typeVal){
  var opts = _imgPurposesForType(typeVal);
  var current = S._builder && S._builder.imgPurpose;
  if(!current || !opts.find(function(o){ return o.val === current; })){
    current = opts[0].val;
    if(!S._builder) S._builder = {};
    S._builder.imgPurpose = current;
  }
  return '<div class="b-pills">'
    + opts.map(function(opt){
        return '<button class="b-pill' + (opt.val === current ? " active" : "") + '"'
          + ' onclick="bPick(\'imgPurpose\',\'' + opt.val + '\',this)">'
          + opt.label + '</button>';
      }).join("")
    + '</div>';
}

function _imgBuilderTypeChanged(typeVal, btn){
  bPick("imgDesignType", typeVal, btn);
  var el = document.getElementById("imgBuilderPurposePills");
  if(el) el.innerHTML = _imgPurposePillsHtml(typeVal);
}

function _imgBuilderPersonToggle(val, btn){
  bPick("imgSubject", val, btn);
  var row = document.getElementById("imgBuilderPersonDesc");
  if(row) row.style.display = (val === "yes") ? "" : "none";
}

function _imgBuilderTextToggle(val, btn){
  bPick("_hasText", val, btn);
  var row = document.getElementById("imgBuilderTextContent");
  if(row) row.style.display = (val === "yes") ? "" : "none";
}

function _imgBrandPreviewHtml(){
  var bc = S.brandCore;
  if(!bc || !bc.name){
    return '<div class="img-brand-preview img-brand-preview--empty">'
      + '<span>No brand identity set. <a href="#" onclick="switchTab(\'brand\');return false">Set up your brand →</a></span>'
      + '</div>';
  }
  var rows = [];
  var cs = _formatBrandColors(bc.colors);
  if(cs) rows.push('<div class="ibp-row"><span class="ibp-lbl">Colors</span><span class="ibp-val">' + cs + '</span></div>');
  if(bc.tone) rows.push('<div class="ibp-row"><span class="ibp-lbl">Tone</span><span class="ibp-val">' + (Array.isArray(bc.tone) ? bc.tone.join(", ") : bc.tone) + '</span></div>');
  if(bc.audience) rows.push('<div class="ibp-row"><span class="ibp-lbl">Audience</span><span class="ibp-val">' + bc.audience + '</span></div>');
  var vstyle = bc.styleDirection || bc.style;
  if(vstyle) rows.push('<div class="ibp-row"><span class="ibp-lbl">Style</span><span class="ibp-val">' + vstyle + '</span></div>');
  return '<div class="img-brand-preview">'
    + '<div class="ibp-header"><span class="ibp-title">Your brand identity</span>'
    + '<a class="ibp-edit" href="#" onclick="switchTab(\'brand\');return false">Edit →</a></div>'
    + (rows.length ? '<div class="ibp-rows">' + rows.join("") + '</div>' : '')
    + '</div>';
}


// ── Render controls for each builder type ────────────────────

function _renderBuilderControls(type){
  if(type === "image"){
    var currentType = (S._builder && S._builder.imgDesignType) || "social";
    var personVal   = (S._builder && S._builder.imgSubject)    || "no";
    var textVal     = (S._builder && S._builder._hasText)      || "no";
    var modelDescVal   = (S._builder && S._builder.imgModelDesc   || "");
    var textContentVal = (S._builder && S._builder.imgTextContent || "");

    return '<div class="builder-section">'
      + '<div class="builder-lbl">Image Type</div>'
      + '<div class="b-pills">'
      + [{val:"logo",label:"Logo"},{val:"social",label:"Social Post"},{val:"ad_creative",label:"Ad Creative"},{val:"poster",label:"Poster"},{val:"product",label:"Product Image"}].map(function(opt){
          return '<button class="b-pill' + (opt.val === currentType ? " active" : "") + '"'
            + ' onclick="_imgBuilderTypeChanged(\'' + opt.val + '\',this)">'
            + opt.label + '</button>';
        }).join("") + '</div>'
      + '</div>'

      + '<div class="builder-section">'
      + '<div class="builder-lbl">Purpose</div>'
      + '<div id="imgBuilderPurposePills">' + _imgPurposePillsHtml(currentType) + '</div>'
      + '</div>'

      + '<div class="builder-section">'
      + '<div class="builder-lbl">Include a person?</div>'
      + '<div class="b-pills">'
      + [{val:"no",label:"No"},{val:"yes",label:"Yes"}].map(function(opt){
          return '<button class="b-pill' + (opt.val === personVal ? " active" : "") + '"'
            + ' onclick="_imgBuilderPersonToggle(\'' + opt.val + '\',this)">'
            + opt.label + '</button>';
        }).join("") + '</div>'
      + '<div id="imgBuilderPersonDesc" style="margin-top:10px;' + (personVal === "yes" ? "" : "display:none") + '">'
      + '<input class="inp" id="imgModelDesc" placeholder="e.g. confident woman in her 30s, professional setting" autocomplete="off"'
      + ' oninput="if(!S._builder)S._builder={};S._builder.imgModelDesc=this.value"'
      + (modelDescVal ? ' value="' + modelDescVal.replace(/"/g, "&quot;") + '"' : "")
      + '></div>'
      + '</div>'

      + '<div class="builder-section">'
      + '<div class="builder-lbl">Include text in image?</div>'
      + '<div class="b-pills">'
      + [{val:"no",label:"No"},{val:"yes",label:"Yes"}].map(function(opt){
          return '<button class="b-pill' + (opt.val === textVal ? " active" : "") + '"'
            + ' onclick="_imgBuilderTextToggle(\'' + opt.val + '\',this)">'
            + opt.label + '</button>';
        }).join("") + '</div>'
      + '<div id="imgBuilderTextContent" style="margin-top:10px;' + (textVal === "yes" ? "" : "display:none") + '">'
      + '<input class="inp" id="imgTextContent" placeholder="e.g. Launch day." autocomplete="off"'
      + ' oninput="if(!S._builder)S._builder={};S._builder.imgTextContent=this.value"'
      + (textContentVal ? ' value="' + textContentVal.replace(/"/g, "&quot;") + '"' : "")
      + '></div>'
      + '</div>'

      + _bSection("Format", "imgFormat", [
          {val:"1:1",  label:"1:1 Square"},
          {val:"4:5",  label:"4:5 Portrait"},
          {val:"9:16", label:"9:16 Vertical"},
          {val:"16:9", label:"16:9 Wide"}
        ], "1:1")

      + '<div class="builder-section builder-section--brand">'
      + _imgBrandPreviewHtml()
      + '</div>';
  }

  if(type === "text"){
    return _bSection("Content Type", "txtType", [
      {val:"headlines",    label:"Headline"},
      {val:"body_copy",    label:"Body Copy"},
      {val:"captions",     label:"Caption"},
      {val:"hooks",        label:"Hook"},
      {val:"product_desc", label:"Product Desc"},
      {val:"ad_copy",      label:"Ad Copy"}
    ], "headlines")
    + _bSection("Tone", "txtTone", [
      {val:"brandcore",      label:"BrandCore Default"},
      {val:"professional",   label:"Professional"},
      {val:"conversational", label:"Conversational"},
      {val:"bold",           label:"Bold"},
      {val:"playful",        label:"Playful"},
      {val:"authoritative",  label:"Authoritative"}
    ], "brandcore")
    + _bSection("Length", "txtLen", [
      {val:"short",  label:"Short"},
      {val:"medium", label:"Medium"},
      {val:"long",   label:"Long"}
    ], "medium");
  }

  if(type === "ads"){
    return _bSection("Platform", "adsPlatform", [
      {val:"meta",      label:"Meta"},
      {val:"instagram", label:"Instagram"},
      {val:"tiktok",    label:"TikTok"},
      {val:"youtube",   label:"YouTube"}
    ], "meta")
    + _bSection("Format", "adsFormat", [
      {val:"feed",   label:"Feed"},
      {val:"story",  label:"Story"},
      {val:"reel",   label:"Reel"},
      {val:"square", label:"Square"}
    ], "feed")
    + _bSection("Goal", "adsGoal", [
      {val:"awareness",  label:"Awareness"},
      {val:"engagement", label:"Engagement"},
      {val:"conversion", label:"Conversion"}
    ], "awareness")
    + _bSection("Creative Angle", "adsAngle", [
      {val:"problem",         label:"Problem / Solution"},
      {val:"aspiration",      label:"Aspiration"},
      {val:"urgency",         label:"Urgency"},
      {val:"transformation",  label:"Transformation"},
      {val:"social_proof",    label:"Social Proof"}
    ], "problem");
  }

  if(type === "campaign"){
    return _bSection("Campaign Type", "campType", [
      {val:"launch",      label:"Launch"},
      {val:"awareness",   label:"Awareness"},
      {val:"conversion",  label:"Conversion"},
      {val:"retargeting", label:"Retargeting"}
    ], "launch")
    + _bSection("Channel", "campChannel", [
      {val:"meta",      label:"Meta"},
      {val:"instagram", label:"Instagram"},
      {val:"tiktok",    label:"TikTok"},
      {val:"youtube",   label:"YouTube"}
    ], "meta")
    + _bSection("Asset Pack", "campAssets", [
      {val:"feed",  label:"Feed"},
      {val:"story", label:"Story"},
      {val:"square",label:"Square"},
      {val:"video", label:"Video Concept"}
    ], "feed")
    + _bSection("Goal", "campGoal", [
      {val:"reach",  label:"Reach"},
      {val:"clicks", label:"Clicks"},
      {val:"sales",  label:"Sales"}
    ], "reach");
  }

  return "";
}


// ── Prompt builders — called by runBuilder() ──────────────────

// Maximum characters sent to the API. Server appends up to ~700 chars of vision
// analysis, so keep the client-built prompt well under 3000.
var _IMG_PROMPT_MAX = 2800;

function _buildImageBuilderPrompt(custom){
  var b   = S._builder || {};
  var bc  = S.brandCore;
  var fmt = b.imgFormat || "1:1";

  var isLogo = (b.imgDesignType === "logo");

  // ── Human-readable type labels ────────────────────────────────
  var typeLabels = {
    logo:        "logo",
    social:      "social media post",
    ad_creative: "ad creative",
    poster:      "poster",
    product:     "product image"
  };

  // ── Purpose descriptions ──────────────────────────────────────
  var purposeLabels = {
    promotion:      "Promotion — create desire, lead with value",
    engagement:     "Engagement — invite interaction, emotionally compelling",
    brand_awareness:"Brand awareness — memorable, brand-first, no hard sell",
    showcase:       "Showcase product — hero product, best angle, deliberate staging",
    features:       "Highlight features — detail-forward, shows what makes it distinct",
    campaign:       "Campaign visual — bold, cohesive, campaign-defining",
    storytelling:   "Brand storytelling — narrative-driven, emotional, authentic",
    brand_identity: "Brand identity — definitive, distinctive, built to last",
    rebrand:        "Rebranding — fresh direction, signals evolution"
  };

  // ── Resolve text content (builder and flow paths) ─────────────
  var wantsText = (b._hasText === "yes");
  var textContent = (b.imgTextContent || "").trim();
  if(!textContent){
    var fp = [b.imgHeadline, b.imgSubtext, b.imgCta].filter(Boolean);
    if(fp.length){ textContent = fp.join(" / "); wantsText = true; }
  }

  // ── Person ───────────────────────────────────────────────────
  var wantsPerson = (b.imgSubject === "yes" || b.imgSubject === "person");
  var modelDesc   = (b.imgModelDesc || "").trim();

  // ── Section builders ─────────────────────────────────────────

  // 1. Opening
  var typeLabel = typeLabels[b.imgDesignType] || "brand visual";
  var opening = "Create a " + typeLabel + " for a brand with the following identity:";

  // 2. Brand identity block (full — trimmed only under budget pressure)
  var brandLines = [];
  if(bc && bc.name)     brandLines.push("Brand: " + bc.name);
  if(bc && bc.audience) brandLines.push("Target audience: " + bc.audience);
  var vstyle = bc && (bc.styleDirection || bc.style);
  if(vstyle)            brandLines.push("Style: " + vstyle);
  var tone = bc && bc.tone;
  if(tone)              brandLines.push("Mood: " + (Array.isArray(tone) ? tone.join(", ") : tone));
  var cs = bc && _formatBrandColors(bc.colors);
  if(cs)                brandLines.push("Color palette: " + cs + " — apply to surfaces, environment, props. Not to skin.");
  if(bc && bc.promise)  brandLines.push("Visual direction: " + bc.promise);
  var brandBlock = brandLines.length
    ? brandLines.join("\n")
    : "Brand: Not defined. Clean, minimal aesthetic — neutral palette with one intentional accent. Premium feel.";

  // 3. Purpose
  var purposeLabel = purposeLabels[b.imgPurpose] || "";
  var purposeBlock = purposeLabel ? ("Purpose: " + purposeLabel) : "";

  // 3b. Visual style, mood, lighting (from flow enrichment)
  var visualStyleMap = {
    editorial: "editorial — bold graphic composition, fashion-magazine aesthetic, strong geometric structure",
    minimal:   "minimal — abundant white space, single strong focal point, quiet and deliberate",
    bold:      "bold — high contrast, saturated color, immediate visual impact, no ambiguity",
    cinematic: "cinematic — widescreen feel, dramatic lighting, film-quality atmosphere, depth of field",
    lifestyle: "lifestyle — authentic, natural, human-first, real-world context, organic and unposed",
    dark:      "dark — low-key, premium, moody, shadow-dominant, depth and mystery"
  };
  var moodMap = {
    premium:   "premium, aspirational, elevated and refined",
    energetic: "energetic, active, dynamic and high-energy",
    calm:      "calm, composed, quiet confidence",
    dramatic:  "dramatic, intense, high-emotion",
    playful:   "playful, light, approachable and warm",
    serene:    "serene, peaceful, meditative stillness"
  };
  var lightingMap = {
    natural:  "natural light — soft, directional, authentic and unmanipulated",
    studio:   "studio lighting — clean, controlled, deliberate shadows",
    dramatic: "dramatic lighting — high contrast, strong shadows, chiaroscuro effect",
    soft:     "soft box lighting — diffused, flattering, professional and clean",
    ambient:  "ambient light — environmental light sources, atmospheric and contextual"
  };
  var visualStyleBlock = b.imgVisualStyle ? ("VISUAL STYLE: " + (visualStyleMap[b.imgVisualStyle] || b.imgVisualStyle)) : "";
  var moodBlock        = b.imgMood        ? ("MOOD: "         + (moodMap[b.imgMood]               || b.imgMood))       : "";
  var lightingBlock    = b.imgLighting    ? ("LIGHTING: "     + (lightingMap[b.imgLighting]        || b.imgLighting))   : "";

  // 4. Person (conditional)
  var personBlock = "";
  if(!isLogo){
    if(wantsPerson){
      personBlock = "Include a person in this image."
        + (modelDesc
          ? " Description: " + modelDesc + " — reproduce exactly. Do not alter gender, age, or appearance."
          : "")
        + " Authentically human, genuine expression. Brand-aligned wardrobe and setting.";
    } else {
      personBlock = "No person. Pure brand visual — deliberate composition, premium feel.";
    }
  }

  // 5. Text (conditional)
  var textBlock = "";
  if(wantsText && textContent){
    textBlock = 'Include text: "' + textContent.slice(0, 200) + '"'
      + " — clean typography, fully legible, naturally integrated into the composition."
      + " Font style must align with the brand mood and style.";
  } else if(!isLogo){
    textBlock = "No text in the image. Pure visual — typography added in post-production.";
  }

  // 6. Upload context (conditional)
  var uploadBlock = "";
  var uploadType = b.imgUploadType;
  if(uploadType === "product"){
    uploadBlock = "Product reference uploaded: reproduce the product as the hero — exact shape, color, material, proportions. Stage in a brand-aligned environment.";
  } else if(uploadType === "reference"){
    uploadBlock = "Style reference uploaded: apply its aesthetic — lighting, composition, color temperature, mood. Elevate it, do not copy literally.";
  } else if(uploadType === "logo"){
    uploadBlock = "Logo reference uploaded: do not include the logo. Use its visual language — shapes, forms, palette — to inform the composition.";
  }

  // 7. Additional context (droppable under budget pressure)
  var extraBlock = custom ? ("Additional context: " + custom.slice(0, 400)) : "";

  // 8. Quality instruction
  var qualityBlock = isLogo
    ? "Logo design: clean vector-style mark, scalable at any size. Flat or semi-flat graphic style. Simple, iconic, memorable. White or transparent background. Crisp edges. NOT photorealistic."
    : "The image must feel cohesive, premium, and aligned with the brand identity. Avoid generic AI outputs.\nPhotorealistic quality. Real, motivated lighting. No painterly blur, dreamlike gradients, or AI aesthetic.";

  // 9. Technical format
  var techBlock = "Format: " + fmt + " — fill edge to edge. Keep the " + _imgTextZone(fmt) + " uncluttered for text overlay.";

  // ── Assemble: all sections except extras ─────────────────────
  var coreSections = [opening, brandBlock, purposeBlock, visualStyleBlock, moodBlock, lightingBlock, personBlock, textBlock, uploadBlock, qualityBlock, techBlock]
    .filter(Boolean);
  var coreText = coreSections.join("\n\n");
  var result   = extraBlock ? (coreText + "\n\n" + extraBlock) : coreText;

  console.log("[ImagePrompt] Raw length: " + result.length);

  // Budget trimming: drop extra context first
  if(result.length > _IMG_PROMPT_MAX && extraBlock){
    result = coreText;
    console.log("[ImagePrompt] Dropped extra context. Length: " + result.length);
  }

  // Still over: trim brand to name + audience + colors only
  if(result.length > _IMG_PROMPT_MAX && bc && bc.name){
    var shortBrandLines = [];
    if(bc.name)     shortBrandLines.push("Brand: " + bc.name);
    if(bc.audience) shortBrandLines.push("Target audience: " + bc.audience);
    var cs2 = _formatBrandColors(bc.colors);
    if(cs2)         shortBrandLines.push("Color palette: " + cs2);
    var shortBrand = shortBrandLines.join("\n");
    var trimSections = [opening, shortBrand, purposeBlock, visualStyleBlock, moodBlock, lightingBlock, personBlock, textBlock, uploadBlock, qualityBlock, techBlock].filter(Boolean);
    result = trimSections.join("\n\n");
    console.log("[ImagePrompt] Trimmed brand block. Length: " + result.length);
  }

  // Hard clamp — final safety net
  if(result.length > _IMG_PROMPT_MAX){
    result = result.slice(0, _IMG_PROMPT_MAX);
    console.log("[ImagePrompt] Hard-clamped.");
  }

  console.log("[ImagePrompt] Final length: " + result.length);
  return result;
}

// Returns the text-safe zone for a given format
function _imgTextZone(fmt){
  if(fmt === "9:16")  return "lower third";
  if(fmt === "16:9")  return "lower quarter";
  if(fmt === "4:5")   return "lower third";
  return "lower third"; // 1:1 default
}

function _buildTextBuilderPrompt(custom){
  var b  = S._builder || {};
  var bc = S.brandCore;

  var typeRules = {
    headline:     "Generate ONE strong, punchy headline. Max 10 words. Specific, benefit-forward, brand-voice specific. No \u2018Introducing\u2019 or \u2018Welcome to\u2019. Output only the headline — no label, no explanation.",
    headlines:    "Generate ONE strong, punchy headline. Max 10 words. Specific, benefit-forward, brand-voice specific. No \u2018Introducing\u2019 or \u2018Welcome to\u2019. Output only the headline \u2014 no label, no explanation.",
    body_copy:    "Generate ONE polished body copy paragraph. 2\u20133 sentences. Open with the most compelling idea. No filler, no clich\u00e9s. End with a strong directional statement. Output only the copy.",
    caption:      "Generate ONE strong caption. Strong first line that hooks before the \u2018more\u2019 cutoff. Natural, direct language. Clear CTA or invitation. 3\u20135 relevant hashtags at the end. Output only the caption.",
    hook:         "Generate ONE powerful hook. Lands in 2\u20133 seconds. Bold claim, provocative question, or pattern interrupt. Every word earns its place. Output only the hook.",
    product_desc: "Generate ONE product description. Lead with the primary benefit, not the product name. Specific, sensory language. Structure: benefit opening \u2192 2\u20133 features \u2192 brand promise. Output only the description.",
    ad_copy:      "Generate ONE complete ad copy set: Headline (max 8 words), Primary Text (2\u20133 sentences), CTA (max 4 words). Benefit-led, brand-voice specific. Format clearly: HEADLINE: / TEXT: / CTA:",
    other:        "Generate ONE strong, polished piece of brand copy. Use the brief and brand context to determine the best format. Output only the final copy."
  };

  var purposeContext = {
    launch:      "CONTEXT: This is for a launch. Create urgency, excitement, and a clear sense of arrival.",
    promotion:   "CONTEXT: This is for a promotion. Value-forward, clear benefit, compelling reason to act now.",
    brand_intro: "CONTEXT: This is a brand introduction. Confident, clear, establishes the brand identity in the opening line.",
    awareness:   "CONTEXT: This is for awareness. Memorable, distinctive, brand-first. Not a hard sell.",
    conversion:  "CONTEXT: This is for conversion. Every word drives action. Remove hesitation. Create clarity.",
    engagement:  "CONTEXT: This is for engagement. Conversational, inviting, prompts a response.",
    other:       ""
  };

  var parts = [];

  parts.push(
    "OUTPUT RULE: Generate exactly ONE final, polished result. "
    + "Do NOT output multiple versions, variants, or options. "
    + "One result, ready to use. No preamble. No meta-commentary. No labels unless the format requires them."
  );

  var typeKey = b.txtType || "headline";
  parts.push("COPY TYPE: " + (typeRules[typeKey] || typeRules.other));

  var ctx = purposeContext[b.txtPurpose || "awareness"];
  if(ctx) parts.push(ctx);

  // Writing objective (from flow enrichment)
  var objectiveMap = {
    promote:  "WRITING OBJECTIVE: Promote — lead with value, create desire, make the offer compelling and specific.",
    educate:  "WRITING OBJECTIVE: Educate — clarity above all, break down complexity, build authority through precision.",
    convert:  "WRITING OBJECTIVE: Convert — remove hesitation, value proposition unmissable, strong CTA, urgency without desperation.",
    engage:   "WRITING OBJECTIVE: Engage — invite interaction, emotionally resonant, prompts a reaction or response.",
    inspire:  "WRITING OBJECTIVE: Inspire — aspirational, evocative, shifts perspective or sparks ambition.",
    announce: "WRITING OBJECTIVE: Announce — confident arrival, excitement, unmistakably clear what is new or happening."
  };
  var ctaStyleMap = {
    direct:  "CTA DIRECTION: Direct action — explicit, imperative, clear instruction: \"do this now.\"",
    soft:    "CTA DIRECTION: Soft nudge — low friction, invitation, zero pressure: \"when you're ready\" energy.",
    urgency: "CTA DIRECTION: Urgency — scarcity or time-sensitivity, creates genuine immediacy without being manipulative.",
    none:    "CTA DIRECTION: No CTA — let the copy breathe. Do not include any call-to-action."
  };
  var objKey = b.txtObjective;
  var ctaKey = b.txtCtaStyle;
  if(objKey && objectiveMap[objKey]) parts.push(objectiveMap[objKey]);
  if(ctaKey && ctaStyleMap[ctaKey])  parts.push(ctaStyleMap[ctaKey]);

  if(custom){
    parts.push(
      "BRIEF — FOLLOW EXACTLY:\n" + custom
      + "\n\nCRITICAL: Write specifically and precisely for this brief. Do not generalize, reinterpret, or substitute. "
      + "Every word must serve the stated purpose and audience."
    );
  }

  // BrandCore provides tone, audience, and voice — no manual tone selection needed
  if(bc && bc.name){
    var bLines = ["BRAND IDENTITY \u2014 write exclusively for this brand, not generically:"];
    bLines.push("Brand: " + bc.name);
    if(bc.tone) bLines.push("Tone of voice (use throughout): " + (Array.isArray(bc.tone) ? bc.tone.join(", ") : bc.tone));
    if(bc.audience) bLines.push("Audience: " + bc.audience);
    if(bc.promise)  bLines.push("Brand promise: " + bc.promise);
    if(bc.style)    bLines.push("Brand style: " + bc.style);
    if(bc.wordsUse   && bc.wordsUse.length)   bLines.push("Words to use: "   + bc.wordsUse.join(", "));
    if(bc.wordsAvoid && bc.wordsAvoid.length) bLines.push("Words to avoid: " + bc.wordsAvoid.join(", "));
    parts.push(bLines.join("\n"));
  }

  parts.push(
    "QUALITY RULE: Senior brand copywriter standard. Specific, intentional, and on-brand. "
    + "Never generic. This must feel written for this brand alone."
  );

  return parts.join("\n\n");
}

function _buildAdsBuilderPrompt(custom){
  var b  = S._builder || {};
  var bc = S.brandCore;

  var platforms = {
    meta:    "Meta (Facebook / Instagram)",
    tiktok:  "TikTok",
    youtube: "YouTube",
    other:   "Digital advertising"
  };

  var formats = {
    square:   "Square 1:1 — compact, versatile, feed-optimised",
    portrait: "Portrait 4:5 — scroll context, 1\u20133 second attention window",
    story:    "Story/Reel 9:16 — full-screen vertical, immersive, native content",
    wide:     "Wide 16:9 — cinematic, widescreen, YouTube/desktop optimised",
    // legacy keys kept for safety
    feed:     "Feed 4:5 — scroll context, 1\u20133 second attention window",
    reel:     "Reel 9:16 — full-screen vertical, native content feel"
  };

  var goals = {
    awareness:  "Goal: Awareness \u2014 memorable first impression, brand-first, no hard sell.",
    engagement: "Goal: Engagement \u2014 drive reactions, comments, saves. Emotional resonance.",
    conversion: "Goal: Conversion \u2014 drive direct action. Value proposition unmissable.",
    sales:      "Goal: Sales \u2014 direct purchase intent, clear offer, strong CTA.",
    launch:     "Goal: Launch \u2014 maximum energy, announce arrival, first impression."
  };

  var subjects = {
    product: "What is advertised: A product.",
    service: "What is advertised: A service.",
    brand:   "What is advertised: The brand itself.",
    offer:   "What is advertised: A specific offer or deal.",
    other:   "What is advertised: See brief."
  };

  var parts = [];

  parts.push(
    "AD PLATFORM: " + (platforms[b.adsPlatform || "meta"] || platforms.meta) + "\n"
    + "AD FORMAT: " + (formats[b.adsFormat || "square"] || formats.square)
  );
  parts.push(goals[b.adsGoal || "awareness"] || goals.awareness);
  parts.push(subjects[b.adsSubject || "product"] || subjects.product);

  if(custom) parts.push("AD BRIEF / SPECIFIC DETAILS: " + custom);

  // BrandCore handles style, tone, and visual direction automatically
  if(bc && bc.name){
    var bLines = ["BRAND IDENTITY \u2014 apply to all copy and visual direction:"];
    bLines.push("Brand: " + bc.name);
    var cs = _formatBrandColors(bc.colors);
    if(cs) bLines.push("Brand colours: " + cs);
    if(bc.tone) bLines.push("Tone: " + (Array.isArray(bc.tone) ? bc.tone.join(", ") : bc.tone));
    if(bc.audience) bLines.push("Audience: " + bc.audience);
    if(bc.promise)  bLines.push("Brand promise: " + bc.promise);
    if(bc.diff || bc.positioning) bLines.push("Positioning: " + (bc.diff || bc.positioning));
    parts.push(bLines.join("\n"));
  }

  parts.push(
    "OUTPUT: Generate ONE complete ad concept. Reply with valid JSON only (no markdown, no extra text):\n"
    + '{"title":"...","headline":"...","body":"...","cta":"..."}\n'
    + "\u2014 title: ad name/concept title (max 6 words, brand-specific)\n"
    + "\u2014 headline: punchy, platform-optimised (max 10 words), brand-voice specific\n"
    + "\u2014 body: benefit-led copy in brand voice (2\u20133 sentences, no generic filler)\n"
    + "\u2014 cta: direct action CTA (max 4 words)"
  );

  return parts.join("\n\n");
}

function _buildCampaignBuilderPrompt(custom){
  var b  = S._builder || {};
  var bc = S.brandCore;
  var n  = parseInt(b.campVariations || "5", 10);

  var campTypes = {
    launch:      "Campaign type: Launch \u2014 maximum energy, first impression, announces arrival.",
    awareness:   "Campaign type: Awareness \u2014 build familiarity, consistency of message, no hard sell.",
    conversion:  "Campaign type: Conversion \u2014 drive action, clear value proposition, remove friction.",
    promotion:   "Campaign type: Promotion \u2014 specific offer, value-forward, compelling reason to act now.",
    retargeting: "Campaign type: Retargeting \u2014 warm audience, new angle or social proof, address objection.",
    other:       "Campaign type: General brand campaign."
  };

  var channels = {
    meta:    "Channel: Meta (Facebook + Instagram ecosystem)",
    tiktok:  "Channel: TikTok (native content + paid)",
    youtube: "Channel: YouTube (pre-roll + bumper ads)",
    multi:   "Channel: Multi-platform \u2014 output must work across Meta, TikTok, and YouTube"
  };

  var formats = {
    square:     "Format: Square 1:1 \u2014 versatile, feed-optimised",
    portrait:   "Format: Portrait 4:5 \u2014 scroll-stopping feed asset",
    story_reel: "Format: Story/Reel 9:16 \u2014 full-screen vertical native content",
    mixed:      "Format: Mixed \u2014 vary format across variations"
  };

  var subjects = {
    product: "Campaign subject: A product.",
    service: "Campaign subject: A service.",
    brand:   "Campaign subject: The brand itself.",
    offer:   "Campaign subject: A specific offer or deal.",
    other:   "Campaign subject: See brief."
  };

  var parts = [];

  parts.push(campTypes[b.campType || "awareness"] || campTypes.awareness);
  parts.push(channels[b.campChannel || "meta"]    || channels.meta);
  parts.push(formats[b.campFormat || "square"]    || formats.square);
  parts.push(subjects[b.campSubject || "brand"]   || subjects.brand);

  // Funnel stage and audience warmth (from flow enrichment)
  var funnelMap = {
    awareness:     "FUNNEL STAGE: Awareness — first impression, brand-first, maximum reach priority over persuasion. Prioritise memorability.",
    consideration: "FUNNEL STAGE: Consideration — educate, differentiate, build preference. Show why this brand over alternatives.",
    conversion:    "FUNNEL STAGE: Conversion — drive action now. Remove every objection. Value proposition unmissable. CTA dominant.",
    retention:     "FUNNEL STAGE: Retention — reward loyalty, deepen relationship. Tone is appreciative, exclusive, insider-feeling."
  };
  var audienceMap = {
    cold:       "AUDIENCE WARMTH: Cold — no prior brand exposure. Lead with problem recognition or strong hook, not brand claims. Earn trust before asking.",
    warm:       "AUDIENCE WARMTH: Warm — brand-aware. Lean into differentiation, unique proof points, and what makes this brand the right choice.",
    retargeted: "AUDIENCE WARMTH: Retargeted — visited or engaged before but didn't convert. New angle, social proof, address the specific hesitation."
  };
  if(b.campFunnelStage    && funnelMap[b.campFunnelStage])       parts.push(funnelMap[b.campFunnelStage]);
  if(b.campAudienceWarmth && audienceMap[b.campAudienceWarmth])  parts.push(audienceMap[b.campAudienceWarmth]);

  if(custom){
    parts.push(
      "CAMPAIGN BRIEF — FOLLOW EXACTLY:\n" + custom
      + "\n\nCRITICAL: Build every variation specifically for this brief. Do not generalize the offer, audience, or product. "
      + "The brief overrides any generic defaults — treat it as the primary creative directive."
    );
  }

  // BrandCore is the primary intelligence — applied across all variations
  if(bc && bc.name){
    var bLines = ["BRAND IDENTITY \u2014 must be consistent and unmistakable across all variations:"];
    bLines.push("Brand: " + bc.name);
    var cs = _formatBrandColors(bc.colors);
    if(cs) bLines.push("Brand colours: " + cs + " \u2014 apply to every variation.");
    if(bc.tone) bLines.push("Tone: " + (Array.isArray(bc.tone) ? bc.tone.join(", ") : bc.tone));
    if(bc.audience) bLines.push("Audience: " + bc.audience);
    if(bc.promise)  bLines.push("Brand promise: " + bc.promise);
    if(bc.diff || bc.positioning) bLines.push("Positioning: " + (bc.diff || bc.positioning));
    parts.push(bLines.join("\n"));
  }

  parts.push(
    "OUTPUT: Generate exactly " + n + " campaign variation objects as a valid JSON array.\n"
    + "Each variation is one adset-style creative concept. Use genuinely different angles \u2014 not repetitions.\n"
    + "Reply with ONLY the JSON array. No markdown fences. No extra text.\n"
    + '[{"title":"...","headline":"...","body":"...","cta":"...","imagePrompt":"..."},...]\n'
    + "\u2014 title: variation name (max 5 words, unique per variation)\n"
    + "\u2014 headline: platform-optimised headline (max 10 words, brand-voice specific)\n"
    + "\u2014 body: benefit-led copy (2\u20133 sentences, brand voice, no filler)\n"
    + "\u2014 cta: direct action CTA (max 4 words)\n"
    + "\u2014 imagePrompt: a 100\u2013180 char DALL-E 3 prompt for this variation\u2019s visual. "
    + "CRITICAL: 100% text-free visual description. Must use brand colours. No text/letters/logos in image. "
    + "Describe the visual composition, subject, mood, and colour palette specifically."
  );

  return parts.join("\n\n");
}

function _buildBuilderPrompt(type){
  var custom = "";
  // 1. Flow wizard answers (original builder)
  if(S._flow && S._flow.answers && S._flow.answers._extraNotes){
    custom = (S._flow.answers._extraNotes || "").trim();
  }
  // 2. AI conversation flow writes directly into S._builder
  if(!custom && S._builder && S._builder._extraNotes){
    custom = (S._builder._extraNotes || "").trim();
  }
  // 3. Legacy custom input field (create-workspace page)
  if(!custom){
    custom = ((document.getElementById("builderCustomInp") || {}).value || "").trim();
  }
  if(type === "image")    return _buildImageBuilderPrompt(custom);
  if(type === "text")     return _buildTextBuilderPrompt(custom);
  if(type === "ads")      return _buildAdsBuilderPrompt(custom);
  if(type === "campaign") return _buildCampaignBuilderPrompt(custom);
  if(type === "web")      return _buildWebBuilderPrompt(custom);
  return custom;
}

function _buildWebBuilderPrompt(custom){
  var b    = S._builder   || {};
  var bc   = S.brandCore  || {};
  var parts = [];

  if(bc.name)      parts.push("Brand: " + bc.name);
  if(bc.industry)  parts.push("Industry: " + bc.industry);
  if(bc.values)    parts.push("Brand values: " + bc.values);
  if(bc.tone)      parts.push("Brand tone: " + bc.tone);
  if(bc.palette)   parts.push("Brand palette: " + bc.palette);

  if(b.webPromotion) parts.push("Promoting: " + b.webPromotion);
  if(b.webAudience)  parts.push("Target audience: " + b.webAudience);
  if(b.webStyle)     parts.push("Design style: " + b.webStyle);
  if(b.webAnimations)parts.push("Animations: " + b.webAnimations);
  if(b.webSections)  parts.push("Page sections: " + b.webSections.replace(/-/g, " + "));
  if(custom)         parts.push("Additional notes: " + custom);

  return parts.join("\n");
}


// ── DALL-E size resolution for builder ───────────────────────

function _builderImgSize(){
  var fmt = (S._builder || {}).imgFormat || "1:1";
  if(fmt === "9:16") return "1024x1792";
  if(fmt === "16:9") return "1792x1024";
  return "1024x1024";
}

function _builderAdsSize(){
  var fmt = (S._builder || {}).adsFormat || "square";
  if(fmt === "story" || fmt === "reel" || fmt === "story_reel") return "1024x1792";
  if(fmt === "wide") return "1792x1024";
  return "1024x1024";
}

function _builderCampSize(){
  var fmt = (S._builder || {}).campFormat || "square";
  if(fmt === "story_reel") return "1024x1792";
  if(fmt === "wide")       return "1792x1024";
  return "1024x1024";
}


// ════════════════════════════════════════════════════════════════
// GUIDED FLOW DEFINITIONS
// Each flow is an ordered array of step objects.
// step.when(answers) — optional predicate; if false, step is skipped.
// step.type — "pills" (auto-advance) | "text" | "textarea" (need Continue)
// ════════════════════════════════════════════════════════════════

var FLOWS = {

  // ── IMAGE ─────────────────────────────────────────────────────
  // Only practical content questions. BrandCore supplies style,
  // colours, tone, and visual direction automatically.
  image: [
    {
      key: "imgDesignType",
      ai:  "What kind of image do you need?",
      type:"pills",
      options:[
        {val:"logo",        label:"Logo"},
        {val:"social",      label:"Social Post"},
        {val:"ad_creative", label:"Ad Creative"},
        {val:"poster",      label:"Poster"},
        {val:"product",     label:"Product Image"}
      ]
    },
    {
      key: "imgPurpose",
      ai:  "What is the purpose?",
      type:"pills",
      options:[
        {val:"promotion",      label:"Promotion"},
        {val:"engagement",     label:"Engagement"},
        {val:"brand_awareness",label:"Brand awareness"}
      ],
      when:function(a){ return !a.imgDesignType || a.imgDesignType === "social" || a.imgDesignType === "ad_creative"; }
    },
    {
      key: "imgPurpose",
      ai:  "What is the purpose?",
      type:"pills",
      options:[
        {val:"showcase", label:"Showcase product"},
        {val:"features", label:"Highlight features"}
      ],
      when:function(a){ return a.imgDesignType === "product"; }
    },
    {
      key: "imgPurpose",
      ai:  "What is the purpose?",
      type:"pills",
      options:[
        {val:"campaign",     label:"Campaign visual"},
        {val:"storytelling", label:"Brand storytelling"}
      ],
      when:function(a){ return a.imgDesignType === "poster"; }
    },
    {
      key: "imgPurpose",
      ai:  "What is the purpose?",
      type:"pills",
      options:[
        {val:"brand_identity", label:"Brand identity"},
        {val:"rebrand",        label:"Rebranding"}
      ],
      when:function(a){ return a.imgDesignType === "logo"; }
    },
    {
      key: "_brandcoreReview",
      ai:  "This image will be based on your brand identity.",
      type:"brandcore"
    },
    {
      key: "_imgUploads",
      ai:  "Do you want to include any visual references?",
      type:"upload"
    },
    {
      key: "imgSubject",
      ai:  "Should this image include a person?",
      type:"pills",
      options:[
        {val:"yes", label:"Yes"},
        {val:"no",  label:"No"}
      ]
    },
    {
      key: "imgModelDesc",
      ai:  "Describe the person.",
      type:"text",
      placeholder:"e.g. young creative entrepreneur, minimal outfit, clean aesthetic",
      optional:true,
      when:function(a){ return a.imgSubject === "yes"; }
    },
    {
      key: "imgFormat",
      ai:  "What format do you need?",
      type:"pills",
      grid:true,
      options:[
        {val:"1:1",  label:"1:1 \u2014 Square"},
        {val:"4:5",  label:"4:5 \u2014 Portrait"},
        {val:"9:16", label:"9:16 \u2014 Story"},
        {val:"16:9", label:"16:9 \u2014 Wide"}
      ]
    },
    {
      key: "_hasText",
      ai:  "Should this image include text?",
      type:"pills",
      options:[
        {val:"yes", label:"Yes"},
        {val:"no",  label:"No"}
      ]
    },
    {
      key: "imgTextContent",
      ai:  "Enter the exact text.",
      type:"text",
      placeholder:"e.g. Launch day.",
      when:function(a){ return a._hasText === "yes"; }
    },
    {
      key: "_extraNotes",
      ai:  "Any extra details or direction?",
      type:"textarea",
      placeholder:"e.g. show the product on a clean white surface, warm lighting, outdoor feel",
      optional:true
    }
  ],

  // ── TEXT ──────────────────────────────────────────────────────
  // BrandCore provides tone automatically. No tone/length questions.
  // Generates ONE polished result.
  text: [
    {
      key: "txtType",
      ai:  "What type of text do you need?",
      type:"pills",
      options:[
        {val:"headline",     label:"Headline"},
        {val:"body_copy",    label:"Body Copy"},
        {val:"caption",      label:"Caption"},
        {val:"hook",         label:"Hook"},
        {val:"product_desc", label:"Product Description"},
        {val:"ad_copy",      label:"Ad Copy"},
        {val:"other",        label:"Other"}
      ]
    },
    {
      key: "txtPurpose",
      ai:  "What is the purpose of this text?",
      type:"pills",
      options:[
        {val:"launch",      label:"Launch"},
        {val:"promotion",   label:"Promotion"},
        {val:"brand_intro", label:"Brand Introduction"},
        {val:"awareness",   label:"Awareness"},
        {val:"conversion",  label:"Conversion"},
        {val:"engagement",  label:"Engagement"},
        {val:"other",       label:"Other"}
      ]
    },
    {
      key: "_extraNotes",
      ai:  "Describe what this text is for.",
      type:"textarea",
      placeholder:"e.g. Homepage headline for our new SaaS product targeting marketing teams",
      optional:true
    }
  ],

  // ── ADS ───────────────────────────────────────────────────────
  // Always outputs: 1 image + 1 headline + 1 description + 1 title.
  // BrandCore handles style, tone, and visual direction.
  ads: [
    {
      key: "adsPlatform",
      ai:  "Which platform is this ad for?",
      type:"pills",
      options:[
        {val:"meta",    label:"Meta / Facebook / Instagram"},
        {val:"tiktok",  label:"TikTok"},
        {val:"youtube", label:"YouTube"},
        {val:"other",   label:"Other"}
      ]
    },
    {
      key: "adsFormat",
      ai:  "What format do you need?",
      type:"pills",
      grid:true,
      options:[
        {val:"square",   label:"Square 1:1"},
        {val:"portrait", label:"Portrait 4:5"},
        {val:"story",    label:"Story / Reel"},
        {val:"wide",     label:"Wide 16:9"}
      ]
    },
    {
      key: "adsGoal",
      ai:  "What is the goal of this ad?",
      type:"pills",
      options:[
        {val:"awareness",  label:"Awareness"},
        {val:"engagement", label:"Engagement"},
        {val:"conversion", label:"Conversion"},
        {val:"sales",      label:"Sales"},
        {val:"launch",     label:"Launch"}
      ]
    },
    {
      key: "adsSubject",
      ai:  "What is being advertised?",
      type:"pills",
      options:[
        {val:"product", label:"Product"},
        {val:"service", label:"Service"},
        {val:"brand",   label:"Brand"},
        {val:"offer",   label:"Offer"},
        {val:"other",   label:"Other"}
      ]
    },
    {
      key: "_extraNotes",
      ai:  "Any specific details about the ad?",
      type:"textarea",
      placeholder:"e.g. 20% off summer sale for skincare products, targeting 25\u201340 year olds",
      optional:true
    }
  ],

  // ── CAMPAIGN ──────────────────────────────────────────────────
  // Generates N adset-style variations, each with image + headline
  // + description + title. BrandCore applied across all.
  campaign: [
    {
      key: "campType",
      ai:  "What type of campaign is this?",
      type:"pills",
      options:[
        {val:"launch",      label:"Launch"},
        {val:"awareness",   label:"Awareness"},
        {val:"conversion",  label:"Conversion"},
        {val:"promotion",   label:"Promotion"},
        {val:"retargeting", label:"Retargeting"},
        {val:"other",       label:"Other"}
      ]
    },
    {
      key: "campChannel",
      ai:  "Which platform is this campaign on?",
      type:"pills",
      options:[
        {val:"meta",    label:"Meta / Facebook / Instagram"},
        {val:"tiktok",  label:"TikTok"},
        {val:"youtube", label:"YouTube"},
        {val:"multi",   label:"Multi-platform"}
      ]
    },
    {
      key: "campFormat",
      ai:  "What format do you need?",
      type:"pills",
      grid:true,
      options:[
        {val:"square",     label:"Square 1:1"},
        {val:"portrait",   label:"Portrait 4:5"},
        {val:"story_reel", label:"Story / Reel"},
        {val:"mixed",      label:"Mixed formats"}
      ]
    },
    {
      key: "campVariations",
      ai:  "How many ads do you want in this campaign?",
      type:"pills",
      grid:true,
      options:[
        {val:"1", label:"1 ad"},
        {val:"2", label:"2 ads"},
        {val:"3", label:"3 ads"},
        {val:"4", label:"4 ads"},
        {val:"5", label:"5 ads"}
      ]
    },
    {
      key: "campSubject",
      ai:  "What is this campaign about?",
      type:"pills",
      options:[
        {val:"product", label:"Product"},
        {val:"service", label:"Service"},
        {val:"brand",   label:"Brand"},
        {val:"offer",   label:"Offer"},
        {val:"other",   label:"Other"}
      ]
    },
    {
      key: "_extraNotes",
      ai:  "Any specific details about the campaign?",
      type:"textarea",
      placeholder:"e.g. Summer collection launch, 20% off, targeting 25\u201340 year olds",
      optional:true
    }
  ]
};


// ════════════════════════════════════════════════════════════════
// FLOW ENGINE
// S._flow = { type, stepIndex, answers, activeSteps }
// ════════════════════════════════════════════════════════════════

function _flowStart(type){
  if(!S._builder) S._builder = {};
  // Pre-seed answers from anything already in _builder (e.g. idea prefill)
  var seedAnswers = {};
  if(S._builder._extraNotes) seedAnswers._extraNotes = S._builder._extraNotes;
  S._flow = { type:type, stepIndex:0, answers:seedAnswers, activeSteps:[] };
  _flowUpdateActiveSteps();
  _flowRender();
}

function _flowUpdateActiveSteps(){
  if(!S._flow) return;
  var all = FLOWS[S._flow.type] || [];
  var a   = S._flow.answers;
  S._flow.activeSteps = all.filter(function(s){ return !s.when || s.when(a); });
}

function _flowCurrentStep(){
  if(!S._flow) return null;
  return S._flow.activeSteps[S._flow.stepIndex] || null;
}

// Called when a pill option is clicked
function _flowPickOption(val){
  var step = _flowCurrentStep();
  if(!step) return;
  S._flow.answers[step.key] = val;
  if(!S._builder) S._builder = {};
  S._builder[step.key] = val;
  _flowUpdateActiveSteps();
  // Highlight immediately
  document.querySelectorAll(".flow-option").forEach(function(el){
    var isActive = el.dataset.val === String(val);
    el.classList.toggle("active", isActive);
    var chk = el.querySelector(".flow-option-check");
    if(chk){
      chk.innerHTML = isActive
        ? '<svg viewBox="0 0 10 8" width="10" height="8" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : "";
    }
  });
  // Auto-advance after brief pause for visual feedback
  setTimeout(function(){ _flowAdvance(); }, 340);
}

// Called by Continue button (text / textarea / brandcore steps)
function flowContinue(){
  var step = _flowCurrentStep();
  if(!step) return;
  if(step.type === "brandcore"){
    _flowAdvance();
    return;
  }
  if(step.type === "upload"){
    // Store whatever the user selected (type is stored live by _flowUploadSelectType)
    // If nothing picked yet, default to "none"
    if(!S._flow.answers[step.key]) S._flow.answers[step.key] = "none";
    if(!S._builder) S._builder = {};
    S._builder[step.key] = S._flow.answers[step.key];
    _flowAdvance();
    return;
  }
  var val = "";
  if(step.type === "text"){
    var inp = document.getElementById("flowTextInp");
    val = inp ? inp.value.trim() : "";
    if(!val && !step.optional){
      if(inp){ inp.focus(); inp.style.borderColor = "#DC2626"; }
      return;
    }
  } else if(step.type === "textarea"){
    var ta = document.getElementById("flowTextareaInp");
    val = ta ? ta.value.trim() : "";
    if(!val && !step.optional){
      if(ta){ ta.focus(); ta.style.borderColor = "#DC2626"; }
      return;
    }
  }
  if(!S._builder) S._builder = {};
  S._flow.answers[step.key] = val;
  S._builder[step.key] = val;
  _flowUpdateActiveSteps();
  _flowAdvance();
}

// Called by Back button
function flowBack(){
  if(!S._flow) return;
  if(S._flow.stepIndex > 0){
    S._flow.stepIndex--;
    _flowRender();
  } else {
    navigate("create");
  }
}

// Jump back to a previous step (via history tap)
function flowJumpTo(idx){
  if(!S._flow || idx < 0 || idx >= S._flow.stepIndex) return;
  // Clear answers from the jumped-to step forward
  S._flow.activeSteps.slice(idx).forEach(function(s){ delete S._flow.answers[s.key]; });
  S._flow.stepIndex = idx;
  _flowUpdateActiveSteps();
  _flowRender();
}

function _flowAdvance(){
  _flowUpdateActiveSteps();
  if(S._flow.stepIndex < S._flow.activeSteps.length - 1){
    S._flow.stepIndex++;
    _flowRender();
  } else {
    _flowGenerate();
  }
}

// ── Render the current step ───────────────────────────────────

function _flowRender(){
  var step  = _flowCurrentStep();
  if(!step) return;
  var idx   = S._flow.stepIndex;
  var total = S._flow.activeSteps.length;

  // Update AI message with fade
  var msgEl = document.getElementById("flowGuideMessage");
  if(msgEl){
    msgEl.style.opacity = "0";
    setTimeout(function(){
      msgEl.textContent = step.ai;
      msgEl.style.opacity = "1";
    }, 130);
  }

  // Progress dots
  var progEl = document.getElementById("flowProgress");
  if(progEl){
    progEl.innerHTML = S._flow.activeSteps.map(function(_, i){
      var cls = i < idx ? "flow-dot done" : (i === idx ? "flow-dot active" : "flow-dot");
      return '<div class="' + cls + '"></div>';
    }).join("");
  }

  // History strip (previous Q&A, tappable to go back)
  var histEl = document.getElementById("flowHistory");
  if(histEl){
    var hhtml = "";
    for(var i = 0; i < idx; i++){
      var s   = S._flow.activeSteps[i];
      var ans = S._flow.answers[s.key];
      if(ans == null || ans === "") continue;
      var disp = String(ans);
      if(s.type === "pills" && s.options){
        var found = s.options.filter(function(o){ return o.val === ans; })[0];
        if(found) disp = found.label;
      }
      hhtml += '<div class="flow-hist-item" onclick="flowJumpTo(' + i + ')">'
        + '<span class="flow-hist-q">' + _escHtml(s.ai) + '</span>'
        + '<span class="flow-hist-a">' + _escHtml(disp.slice(0, 38)) + '</span>'
        + '</div>';
    }
    histEl.innerHTML = hhtml;
  }

  // Step content (re-animate)
  var stepEl = document.getElementById("flowStep");
  if(stepEl){
    stepEl.style.animation = "none";
    stepEl.offsetHeight; // force reflow
    stepEl.style.animation = "";
    stepEl.innerHTML = _flowStepHtml(step);
    // Auto-focus text inputs
    if(step.type === "text"){
      var inp2 = document.getElementById("flowTextInp");
      if(inp2) setTimeout(function(){ inp2.focus(); }, 80);
    } else if(step.type === "textarea"){
      var ta2 = document.getElementById("flowTextareaInp");
      if(ta2) setTimeout(function(){ ta2.focus(); }, 80);
    }
  }

  // Nav bar
  var navEl   = document.getElementById("flowNav");
  var backBtn = document.getElementById("flowNavBack");
  var contBtn = document.getElementById("flowNavContinue");
  var isTextStep   = (step.type === "text" || step.type === "textarea" || step.type === "brandcore" || step.type === "upload");
  var isBrandcore  = (step.type === "brandcore");
  var isUpload     = (step.type === "upload");
  var isLast       = (idx === total - 1);

  if(navEl)   navEl.style.display   = (isTextStep || idx > 0) ? "" : "none";
  if(backBtn) backBtn.style.visibility = idx > 0 ? "visible" : "hidden";
  if(contBtn){
    contBtn.style.display = isTextStep ? "" : "none";
    if(isTextStep){
      if(isBrandcore){
        contBtn.textContent = "Looks good \u2014 continue";
      } else if(isUpload){
        var uploadAns = S._flow && S._flow.answers && S._flow.answers[step.key];
        contBtn.textContent = (uploadAns && uploadAns !== "none") ? "Continue" : "Skip";
      } else {
        contBtn.textContent = isLast ? "Generate" : (step.optional ? "Skip" : "Continue");
      }
    }
  }

  // Hide result area when browsing steps
  var resWrap = document.getElementById("builderResultWrap");
  if(resWrap) resWrap.style.display = "none";
}

function _flowStepHtml(step){
  var cur = S._flow.answers[step.key];

  if(step.type === "pills"){
    var cls = step.grid ? "flow-options-grid" : "flow-options";
    return '<div class="' + cls + '">'
      + step.options.map(function(opt){
          var isActive = (cur === opt.val);
          var chkHtml  = isActive
            ? '<svg viewBox="0 0 10 8" width="10" height="8" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : "";
          return '<button class="flow-option' + (isActive ? " active" : "") + '"'
            + ' data-val="' + _escHtml(opt.val) + '"'
            + ' onclick="_flowPickOption(\'' + opt.val.replace(/\\/g,"\\\\").replace(/'/g,"\\'") + '\')">'
            + '<div class="flow-option-check">' + chkHtml + '</div>'
            + '<span class="flow-option-label">' + _escHtml(opt.label) + '</span>'
            + '</button>';
        }).join("")
      + '</div>';
  }

  if(step.type === "text"){
    return '<div class="flow-input-wrap">'
      + '<input type="text" class="flow-inp" id="flowTextInp"'
      + ' placeholder="' + _escHtml(step.placeholder || "") + '"'
      + ' value="' + _escHtml(cur || "") + '"'
      + ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();flowContinue();}"'
      + ' autocomplete="off">'
      + '</div>';
  }

  if(step.type === "textarea"){
    var helperHtml = "";
    if(step.key === "_extraNotes"){
      helperHtml = '<div class="flow-helper-text">The more specific your direction, the more intentional the result.</div>';
    }
    return '<div class="flow-input-wrap">'
      + helperHtml
      + '<textarea class="flow-inp" id="flowTextareaInp"'
      + ' placeholder="' + _escHtml(step.placeholder || "") + '">'
      + _escHtml(cur || "")
      + '</textarea>'
      + '</div>';
  }

  if(step.type === "upload"){
    var uploadType = (S._flow && S._flow.answers && S._flow.answers[step.key]) || "";
    var uploadData = (S._builder && S._builder.imgUploadData) || "";
    var types = [
      { val:"product",   label:"Product image",   hint:"I want the product to appear in the image" },
      { val:"reference", label:"Style reference",  hint:"Use this image for mood & visual style" },
      { val:"logo",      label:"Brand logo",        hint:"Use my logo to guide the visual identity" }
    ];
    var html = '<div class="flow-upload-step">';
    html += '<div class="flow-upload-types">';
    types.forEach(function(t){
      var isActive = uploadType === t.val;
      html += '<button class="flow-upload-type-btn' + (isActive ? " active" : "") + '"'
        + ' onclick="_flowUploadSelectType(\'' + t.val + '\')">'
        + '<div class="fut-label">' + _escHtml(t.label) + '</div>'
        + '<div class="fut-hint">' + _escHtml(t.hint) + '</div>'
        + '</button>';
    });
    html += '</div>';
    if(uploadType && uploadType !== "none"){
      if(uploadData){
        html += '<div class="flow-upload-done">'
          + '<div class="fud-check">'
          + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M2.5 8l4 4 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          + '</div>'
          + '<div class="fud-info">Image uploaded</div>'
          + '<button class="fud-remove" onclick="_flowUploadRemove()">Remove</button>'
          + '</div>';
      } else {
        html += '<div class="flow-upload-area" onclick="_flowUploadFile()">'
          + '<div class="fua-label">Tap to upload</div>'
          + '<div class="fua-hint">JPG, PNG, WEBP \u00b7 Max 10MB</div>'
          + '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  if(step.type === "brandcore"){
    var bc = S.brandCore;
    if(!bc || !bc.name){
      return '<div class="flow-brandcore-panel flow-brandcore-empty">'
        + '<div class="fbp-empty-icon">'
        + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><circle cx="8" cy="8" r="6.5"/><path d="M8 5v4M8 11v.5" stroke-linecap="round"/></svg>'
        + '</div>'
        + '<div class="fbp-empty-title">No BrandCore found</div>'
        + '<div class="fbp-empty-sub">Your image will be generated with a clean, professional default style. Set up your BrandCore to unlock brand-specific generation.</div>'
        + '</div>';
    }

    var bhtml = '<div class="flow-brandcore-panel">';

    // Header: icon + brand name + sub-label
    bhtml += '<div class="fbp-header">'
      + '<div class="fbp-icon">'
      + '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">'
      + '<path d="M8 2L10 7H15L11 10L12.5 14L8 11.5L3.5 14L5 10L1 7H6Z" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>'
      + '</div>'
      + '<div>'
      + '<div class="fbp-brand-name">' + _escHtml(bc.name) + '</div>'
      + '<div class="fbp-sub">Applied automatically to every element of this image</div>'
      + '</div>'
      + '</div>';

    bhtml += '<div class="fbp-rows">';

    // Brand colours with swatches
    var bcColors = bc.colors;
    if(bcColors && bcColors.length){
      bhtml += '<div class="fbp-row">'
        + '<div class="fbp-row-label">Colours</div>'
        + '<div class="fbp-colors">';
      bcColors.slice(0, 6).forEach(function(c){
        var hex  = (c && typeof c === "object") ? c.hex  : c;
        var name = (c && typeof c === "object") ? c.name : "";
        if(hex){
          bhtml += '<div class="fbp-swatch" style="background:' + _escHtml(hex) + '"'
            + (name ? ' title="' + _escHtml(name + " " + hex) + '"' : ' title="' + _escHtml(hex) + '"')
            + '></div>';
        }
      });
      bhtml += '</div></div>';
    }

    // Visual style
    var vstyle = bc.styleDirection || bc.style;
    if(vstyle){
      bhtml += '<div class="fbp-row">'
        + '<div class="fbp-row-label">Visual style</div>'
        + '<div class="fbp-row-value">' + _escHtml(vstyle) + '</div>'
        + '</div>';
    }

    // Tone of voice
    var tone = bc.tone;
    if(tone){
      var toneStr = Array.isArray(tone) ? tone.join(", ") : String(tone);
      bhtml += '<div class="fbp-row">'
        + '<div class="fbp-row-label">Tone</div>'
        + '<div class="fbp-row-value">' + _escHtml(toneStr) + '</div>'
        + '</div>';
    }

    // Target audience
    if(bc.audience){
      bhtml += '<div class="fbp-row">'
        + '<div class="fbp-row-label">Audience</div>'
        + '<div class="fbp-row-value">' + _escHtml(bc.audience) + '</div>'
        + '</div>';
    }

    bhtml += '</div>'; // fbp-rows

    // Promise / visual direction
    if(bc.promise){
      bhtml += '<div class="fbp-row">'
        + '<div class="fbp-row-label">Promise</div>'
        + '<div class="fbp-row-value">' + _escHtml(bc.promise) + '</div>'
        + '</div>';
    }

    bhtml += '</div>'; // fbp-rows

    bhtml += '<div class="fbp-footer">'
      + '<div class="fbp-note">These brand elements shape every element of your image automatically.</div>'
      + '<a href="#" class="fbp-edit-link" onclick="switchTab(\'brand\');return false">Edit brand identity →</a>'
      + '</div>';

    bhtml += '</div>'; // flow-brandcore-panel
    return bhtml;
  }

  return "";
}

// ── Upload step helpers ───────────────────────────────────────

function _flowUploadSelectType(type){
  var step = _flowCurrentStep();
  if(!step || step.type !== "upload") return;
  if(!S._flow.answers) S._flow.answers = {};
  S._flow.answers[step.key] = type;
  if(!S._builder) S._builder = {};
  S._builder.imgUploadType = type;
  // Clear any previously uploaded data when switching type
  delete S._builder.imgUploadData;
  _flowRender();
}

function _flowUploadFile(){
  var inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/jpeg,image/png,image/webp";
  inp.onchange = function(){
    var file = inp.files && inp.files[0];
    if(!file) return;
    if(file.size > 10 * 1024 * 1024){
      alert("Please choose an image under 10MB.");
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e){
      if(!S._builder) S._builder = {};
      S._builder.imgUploadData = e.target.result; // base64 data URL
      _flowRender();
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

function _flowUploadRemove(){
  if(S._builder) delete S._builder.imgUploadData;
  _flowRender();
}

// ── Trigger generation after flow completes ───────────────────

function _flowGenerate(){
  if(!S._builder) S._builder = {};
  // Copy all flow answers into S._builder
  var a = S._flow.answers;
  Object.keys(a).forEach(function(k){ S._builder[k] = a[k]; });

  // Set defaults for any skipped optional fields
  if(!S._builder.imgFormat)    S._builder.imgFormat    = "1:1";
  if(!S._builder.imgTextStyle) S._builder.imgTextStyle = "clean";
  if(!S._builder.imgSubject)   S._builder.imgSubject   = "abstract";
  if(!S._builder.imgComposition) S._builder.imgComposition = "minimal";
  if(!S._builder.imgMood)      S._builder.imgMood      = "professional";
  if(!S._builder.txtTone)      S._builder.txtTone      = "brandcore";
  if(!S._builder.txtLen)       S._builder.txtLen       = "medium";

  // Update AI guide message
  var msgEl = document.getElementById("flowGuideMessage");
  if(msgEl) msgEl.textContent = "We\u2019re all set. Creating your " + S._builderType + " now\u2026";

  // Hide nav and progress
  var navEl  = document.getElementById("flowNav");
  var progEl = document.getElementById("flowProgress");
  var histEl = document.getElementById("flowHistory");
  if(navEl)  navEl.style.display  = "none";
  if(progEl) progEl.innerHTML     = "";
  if(histEl) histEl.innerHTML     = "";

  // Show pulsing generating state in step area
  var stepEl = document.getElementById("flowStep");
  if(stepEl){
    stepEl.style.animation = "none";
    stepEl.offsetHeight;
    stepEl.style.animation = "";
    stepEl.innerHTML = '<div class="flow-generating">'
      + '<div class="flow-generating-icon">'
      + '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20">'
      + '<path d="M14 3L17 10H24L19 14L21 21L14 17L7 21L9 14L4 10H11Z" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg></div>'
      + '<div class="flow-generating-text">Generating your ' + S._builderType + '\u2026</div>'
      + '<div class="flow-generating-sub">This takes a few seconds.</div>'
      + '</div>';
  }

  runBuilder();
}


// ── openBuilder — entry point for the guided flow system ─────

function openBuilder(type){
  S._builderType = type;
  S._builder     = {};

  // Inject any idea prefill into _extraNotes before the flow starts
  if(S._ideaPrefill){
    S._builder._extraNotes = S._ideaPrefill;
    S._ideaPrefill = null;
  }

  // Brand pill
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

  // Reset result area
  var resultWrap = document.getElementById("builderResultWrap");
  if(resultWrap) resultWrap.style.display = "none";
  S._lastBuilderResult = null;

  navigate("builder");
  _flowStart(type);
}


// ── runBuilder — execute generation ──────────────────────────

async function runBuilder(){
  var type = S._builderType;
  if(!type) return;

  // Usage gate
  if(typeof gateUsage === "function"){
    var allowed = await gateUsage();
    if(!allowed) return;
  }

  trackEvent("started_generation", _currentUser || null);

  var resultWrap = document.getElementById("builderResultWrap");
  var resultBody = document.getElementById("builderResultBody");
  var saveBtn    = document.getElementById("builderSaveBtn");

  // Loading state
  if(resultWrap) resultWrap.style.display = "";
  if(resultBody) resultBody.innerHTML = _buildCodeLoader(type);
  if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "Save to Studio"; }

  var prompt = _buildBuilderPrompt(type);

  var endpoint, requestBody;

  if(type === "image"){
    endpoint = API_BASE_URL+"/api/generate-image";
    var _b   = S._builder || {};
    requestBody = {
      prompt:       prompt,
      size:         _builderImgSize(),
      type:         "image",
      imageFormat:  _b.imgFormat    || "1:1",
      textStyle:    _b.imgTextStyle || "clean",
      headline:     (_b.imgHeadline  || "").trim(),
      subtext:      (_b.imgSubtext   || "").trim(),
      cta:          (_b.imgCta       || "").trim(),
      refImageData: _b.imgUploadData || _b.imgRefData || null,
      uploadType:   _b.imgUploadType || null
    };
  } else if(type === "ads"){
    endpoint    = API_BASE_URL+"/api/generate-ad";
    requestBody = {
      prompt:    prompt,
      size:      _builderAdsSize(),
      type:      "ads",
      adFormat:  (S._builder || {}).adsFormat || "feed"
    };
  } else if(type === "campaign"){
    endpoint    = API_BASE_URL+"/api/generate-campaign";
    requestBody = {
      prompt: prompt,
      size:   _builderCampSize(),
      type:   "campaign"
    };
  } else if(type === "text"){
    endpoint    = API_BASE_URL+"/api/generate-text";
    requestBody = { prompt: prompt, type: "text" };
  } else if(type === "web"){
    var _b = S._builder  || {};
    var _c = S.brandCore || {};
    endpoint    = API_BASE_URL+"/api/generate-web";
    requestBody = {
      brand_name:      _c.name             || "",
      product:         _b.webPromotion     || "",
      audience:        _b.webAudience      || "",
      tone:            _c.tone             || "",
      color:           _c.palette          || "#B7FF2A",
      goal:            _b.webConversionGoal || "conversion",
      style:           _b.webStyle          || "modern",
      animations:      _b.webAnimations     || "subtle",
      sections:        _b.webSections       || "hero-features-cta",
      web_type:        _b.webType           || "",
      layout:          _b.webLayout         || ""
    };
  }

  console.log("[Builder/" + type + "] → " + endpoint);

  try {
    var res  = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(requestBody)
    });
    var data = await res.json();
    // For image type, attach the client-side text overlay data to the result
    // (server only returns imageUrl — text overlay is purely client-side)
    if(type === "image"){
      data.headline    = requestBody.headline    || "";
      data.subtext     = requestBody.subtext     || "";
      data.cta         = requestBody.cta         || "";
      data.textStyle   = requestBody.textStyle   || "clean";
      data.imageFormat = requestBody.imageFormat || "1:1";
    }
    S._lastBuilderResult = { type: type, data: data };
    _showBuilderResult(type, data);
    trackEvent("completed_generation", _currentUser || null);
    if(saveBtn){ saveBtn.disabled = false; }

    // Soft paywall: fire after last free generation
    if(typeof isLastFreeCreditUsed === "function" && typeof showSoftPaywall === "function"){
      isLastFreeCreditUsed().then(function(isLast){ if(isLast) setTimeout(showSoftPaywall, 450); });
    }

    // Clear the generating spinner left in #flowStep by _flowGenerate()
    var stepEl = document.getElementById("flowStep");
    if(stepEl && stepEl.querySelector(".flow-generating")) stepEl.innerHTML = "";

    var msgEl = document.getElementById("flowGuideMessage");
    if(msgEl) msgEl.textContent = "Here's your " + type + ". You can regenerate or save it to Studio.";
  } catch(e){
    console.error("[Builder/" + type + "] error:", e);
    if(resultBody) resultBody.innerHTML =
      '<div class="builder-error">Could not connect to ORIVEN services. Please try again.</div>';

    // Clear spinner on error too
    var stepEl2 = document.getElementById("flowStep");
    if(stepEl2 && stepEl2.querySelector(".flow-generating")) stepEl2.innerHTML = "";

    var msgEl2 = document.getElementById("flowGuideMessage");
    if(msgEl2) msgEl2.textContent = "Something went wrong. Please try again.";
  }
}


// ── _showBuilderResult — render result into result area ───────

function _showBuilderResult(type, data){
  _stopCodeLoader();
  var body = document.getElementById("builderResultBody");
  if(!body) return;

  if(data.error){
    body.innerHTML = '<div class="builder-error">' + _escHtml(data.error) + '</div>';
    return;
  }

  if(type === "image"){
    if(!data.imageUrl){
      body.innerHTML = '<div class="builder-error">No image was returned.</div>';
      return;
    }

    // Build composite: image background + text overlay layer
    var fmt       = (data.imageFormat || "1:1").replace(":","x");
    var txtStyle  = data.textStyle   || "clean";
    var headline  = data.headline    || "";
    var subtext   = data.subtext     || "";
    var cta       = data.cta         || "";
    var hasText   = headline || subtext || cta;

    var html = '<div class="img-composite">';

    // Frame with correct aspect ratio
    html += '<div class="img-frame img-frame-' + fmt + '">';
    html += '<img src="' + data.imageUrl + '" class="img-bg-layer" alt="Generated visual">';

    if(hasText){
      html += '<div class="img-text-layer img-txt-' + txtStyle + ' img-txt-light" id="imgTextLayer">';
      html += '<div class="img-text-inner">';
      if(headline) html += '<div class="itl-headline">' + _escHtml(headline) + '</div>';
      if(subtext)  html += '<div class="itl-subtext">'  + _escHtml(subtext)  + '</div>';
      if(cta)      html += '<div class="itl-cta">'      + _escHtml(cta)      + '</div>';
      html += '</div></div>';
    }

    html += '</div>'; // img-frame

    // Controls bar — only shown when there is text to overlay
    if(hasText){
      html += '<div class="img-composite-bar">';
      html += '<label class="img-toggle-label">'
        + '<input type="checkbox" id="imgTextToggle" checked onchange="_toggleImgText(this.checked)">'
        + '<span>Text overlay</span></label>';
      html += '<div class="img-color-row">';
      html += '<span class="img-bar-lbl">Text:</span>';
      html += '<button class="icb icb-light active" id="icbLight" onclick="_setImgTextColor(\'light\')">Light</button>';
      html += '<button class="icb icb-dark" id="icbDark" onclick="_setImgTextColor(\'dark\')">Dark</button>';
      html += '</div>';
      html += '</div>'; // composite-bar
    }

    html += '</div>'; // img-composite

    body.innerHTML = html;
    return;
  }

  if(type === "text"){
    if(!data.result){
      body.innerHTML = '<div class="builder-error">No content was returned.</div>';
      return;
    }
    body.innerHTML = '<div class="builder-result-text">' + _formatBrief(data.result) + '</div>';
    return;
  }

  if(type === "ads"){
    if(!data.headline && !data.body){
      body.innerHTML = '<div class="builder-error">No ad content returned.</div>';
      return;
    }
    var ahtml = '<div class="builder-ad-result">';
    if(data.title)    ahtml += '<div class="bar-title">'    + _escHtml(data.title)    + '</div>';
    if(data.headline) ahtml += '<div class="bar-headline">' + _escHtml(data.headline) + '</div>';
    if(data.body)     ahtml += '<div class="bar-body">'     + _escHtml(data.body)     + '</div>';
    if(data.cta)      ahtml += '<div class="bar-cta-row"><span class="bar-cta">' + _escHtml(data.cta) + '</span></div>';
    if(data.imageUrl) ahtml += '<img src="' + data.imageUrl + '" alt="Ad visual" class="builder-result-img" style="margin-top:18px">';
    ahtml += '</div>';
    body.innerHTML = ahtml;
    return;
  }

  if(type === "campaign"){
    var vars = (data.variations && data.variations.length) ? data.variations : null;
    if(!vars){
      body.innerHTML = '<div class="builder-error">No campaign variations were returned.</div>';
      return;
    }
    var chtml = '<div class="camp-variations">';
    vars.forEach(function(v, i){
      chtml += '<div class="camp-var-card">';
      if(v.imageUrl){
        chtml += '<div class="cvcard-img-wrap"><img src="' + v.imageUrl + '" class="cvcard-img" alt="Variation ' + (i + 1) + '"></div>';
      }
      chtml += '<div class="cvcard-body">';
      chtml += '<div class="cvcard-num">Variation ' + (i + 1) + '</div>';
      if(v.title)    chtml += '<div class="cvcard-title">'    + _escHtml(v.title)    + '</div>';
      if(v.headline) chtml += '<div class="cvcard-headline">' + _escHtml(v.headline) + '</div>';
      if(v.body)     chtml += '<div class="cvcard-text">'     + _escHtml(v.body)     + '</div>';
      if(v.cta)      chtml += '<div class="cvcard-cta-row"><span class="cvcard-cta">' + _escHtml(v.cta) + '</span></div>';
      chtml += '</div></div>';
    });
    chtml += '</div>';
    body.innerHTML = chtml;
    return;
  }

  if(type === "web"){
    if(!data.html){
      body.innerHTML = '<div class="builder-error">No page was returned.</div>';
      return;
    }
    _renderWebResult(
      data.html, body,
      document.getElementById("flowGuideMessage"),
      document.getElementById("flowStep"),
      document.getElementById("builderSaveBtn")
    );
    return;
  }

  body.innerHTML = '<div class="builder-result-text">' + _formatBrief(data.result || "") + '</div>';
}

// ════════════════════════════════════════════════════════════════
// CODE LOADER — real-time sequential build animation
// ════════════════════════════════════════════════════════════════

var _clTimer  = null;
var _clActive = false;

var _CL_STEPS = {
  web:      ["Parsing brand identity…","Generating layout structure…","Writing HTML structure…","Applying brand styles…","Optimizing for mobile…","Finalizing assets…"],
  image:    ["Analyzing brand identity…","Composing visual layout…","Applying color palette…","Rendering final image…","Finalizing output…"],
  text:     ["Reading brand voice…","Structuring content outline…","Writing copy…","Refining tone and style…","Polishing output…"],
  ads:      ["Loading brand assets…","Writing ad copy…","Building visual layout…","Optimizing for platform…","Finalizing creative…"],
  campaign: ["Building campaign strategy…","Generating variations…","Applying brand guidelines…","Reviewing copy…","Packaging results…"]
};

var _CL_MICRO = [
  "Compiling sections…",
  "Injecting components…",
  "Linking styles…",
  "Processing fonts…",
  "Normalizing spacing…",
  "Resolving variables…",
  "Optimizing assets…",
  "Checking responsiveness…"
];

function _stopCodeLoader(){
  _clActive = false;
  if(_clTimer){ clearTimeout(_clTimer); _clTimer = null; }
}

function _buildCodeLoader(type){
  _stopCodeLoader();
  _clActive = true;

  var steps = _CL_STEPS[type] || _CL_STEPS.web;

  // Start the chained step animation (first step fires after a short pause)
  _clTimer = setTimeout(function(){ _clRunStep(steps, 0); }, 280);

  return '<div class="code-loader">'
    + '<div class="cl-header">'
    + '<div class="cl-dot cl-red"></div>'
    + '<div class="cl-dot cl-yellow"></div>'
    + '<div class="cl-dot cl-green"></div>'
    + '<span class="cl-title">oriven.build</span>'
    + '</div>'
    + '<div class="cl-body" id="clBody"></div>'
    + '</div>';
}

function _clRunStep(steps, idx){
  if(!_clActive) return;
  var body = document.getElementById("clBody");
  if(!body) return;

  // Mark previous active step as done
  var prev = body.querySelector(".cl-line-active");
  if(prev){
    prev.classList.remove("cl-line-active");
    prev.classList.add("cl-line-done");
    var dots = prev.querySelector(".cl-dots");
    if(dots) dots.remove();
  }
  // Remove micro-update lines before adding new main step (keep log tidy)
  body.querySelectorAll(".cl-micro").forEach(function(m){ m.remove(); });

  var isLast = (idx === steps.length - 1);
  var div = document.createElement("div");
  div.className = "cl-line cl-line-active cl-enter";
  div.innerHTML = '<span class="cl-prompt">›</span>'
    + '<span class="cl-text">' + steps[idx] + '</span>'
    + (isLast ? '<span class="cl-cursor"></span>' : '<span class="cl-dots"></span>');
  body.appendChild(div);

  // Remove .cl-enter on next paint to trigger transition
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){ div.classList.remove("cl-enter"); });
  });

  if(!isLast){
    // 4–7s between main steps; add micro-update midway through
    var totalMs  = 4000 + Math.floor(Math.random() * 3000);
    var microMs  = Math.floor(totalMs * 0.52);

    _clTimer = setTimeout(function(){
      if(!_clActive) return;
      var b = document.getElementById("clBody");
      if(b) _clAddMicro(b);

      _clTimer = setTimeout(function(){
        _clRunStep(steps, idx + 1);
      }, totalMs - microMs);
    }, microMs);
  }
}

function _clAddMicro(body){
  var text = _CL_MICRO[Math.floor(Math.random() * _CL_MICRO.length)];
  var div = document.createElement("div");
  div.className = "cl-micro cl-enter";
  div.innerHTML = '<span class="cl-micro-prompt">·</span>'
    + '<span class="cl-micro-text">' + text + '</span>';
  body.appendChild(div);
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){ div.classList.remove("cl-enter"); });
  });
}

// ════════════════════════════════════════════════════════════════
// WEB GENERATOR — Brand-aware landing page generation
// ════════════════════════════════════════════════════════════════

// ── Helpers: resolve brand identity from brandCore + any builder overrides ──

function _webBrand(){
  var _b = S._builder  || {};
  var _c = S.brandCore || {};
  var colors = (_c.colors || []);
  var fonts  = (_c.fonts  || []);
  var logos  = (_c.logos  || {});
  return {
    name:       _c.name || "",
    primary:    _b._webPrimary    || (colors[0] && colors[0].hex) || "#B7FF2A",
    secondary:  _b._webSecondary  || (colors[1] && colors[1].hex) || "#9FE81F",
    accent:     _b._webAccent     || (colors[2] && colors[2].hex) || "#BFA07A",
    background: _b._webBackground || (colors[3] && colors[3].hex) || "#F6F3EE",
    text:       _b._webText       || (colors[4] && colors[4].hex) || "#18181A",
    headingFont:_b._webHeadingFont || (fonts[0] && fonts[0].family) || "Georgia, serif",
    bodyFont:   _b._webBodyFont    || (fonts[1] && fonts[1].family) || "system-ui, sans-serif",
    logoUrl:    (logos.primary && logos.primary.url) || (logos.dark && logos.dark.url) || "",
    tone:       Array.isArray(_c.tone) ? _c.tone.join(", ") : (_c.tone || "")
  };
}

// ── Step 1: Brand confirmation panel ─────────────────────────

function _showWebBrandConfirm(){
  var br     = _webBrand();
  var msgEl  = document.getElementById("flowGuideMessage");
  var stepEl = document.getElementById("flowStep");
  var navEl  = document.getElementById("flowNav");
  var progEl = document.getElementById("flowProgress");
  var histEl = document.getElementById("flowHistory");

  if(navEl)  navEl.style.display  = "none";
  if(progEl) progEl.innerHTML     = "";
  if(histEl) histEl.innerHTML     = "";
  if(msgEl)  msgEl.textContent    = "Confirm your brand identity before generating.";

  var logoHtml = '<div class="wbc-logo-empty">' + (br.name || "No logo") + '</div>';
  if(br.logoUrl) logoHtml = '<img src="' + br.logoUrl + '" class="wbc-logo-img" alt="Logo">';

  var html = '<div class="wbc-panel">'
    + '<div class="wbc-title">Brand Identity</div>'
    + '<div class="wbc-sub">Your website will use these settings. Click a swatch to change a color.</div>'
    + '<div class="wbc-logo-wrap">' + logoHtml + '</div>'
    + '<div class="wbc-cols">'

    // Colors column
    + '<div class="wbc-section">'
    + '<div class="wbc-section-label">Colors</div>'
    + _wbcColorRow("Primary",    "_webPrimary",    br.primary)
    + _wbcColorRow("Secondary",  "_webSecondary",  br.secondary)
    + _wbcColorRow("Accent",     "_webAccent",     br.accent)
    + _wbcColorRow("Background", "_webBackground", br.background)
    + _wbcColorRow("Text",       "_webText",       br.text)
    + '</div>'

    // Typography column
    + '<div class="wbc-section">'
    + '<div class="wbc-section-label">Typography</div>'
    + '<div class="wbc-font-row"><span class="wbc-font-role">Heading</span>'
    + '<span class="wbc-font-name" style="font-family:' + br.headingFont + '">' + br.headingFont + '</span></div>'
    + '<div class="wbc-font-row"><span class="wbc-font-role">Body</span>'
    + '<span class="wbc-font-name" style="font-family:' + br.bodyFont + '">' + br.bodyFont + '</span></div>'
    + '</div>'

    + '</div>' // wbc-cols

    // Section picker — pre-check based on website type
    + (function(){
        var _ds = (S._builder && S._builder._webTypeDefaultSections) || ["hero","features","cta"];
        var _has = function(id){ return _ds.indexOf(id) !== -1; };
        var _typeName = {"one-page":"One Page","portfolio":"Portfolio","saas":"SaaS / Startup","ecommerce":"E-commerce","agency":"Agency","landing":"Landing Page"}[S._builder && S._builder.webType] || "";
        return '<div class="wbc-section-full">'
          + '<div class="wbc-section-label">Page Sections'
          + (_typeName ? ' <span style="font-weight:400;opacity:.5;font-size:11px">· ' + _typeName + '</span>' : '')
          + '</div>'
          + '<div class="wbc-section-sub">Hero is always included. Click to toggle sections.</div>'
          + '<div class="wbs-grid">'
          + _wbsSectionItem("hero",         "Hero",             true,              true)
          + _wbsSectionItem("features",     "Features",         _has("features"),  false)
          + _wbsSectionItem("cta",          "Call to Action",   _has("cta"),       false)
          + _wbsSectionItem("benefits",     "Benefits",         _has("benefits"),  false)
          + _wbsSectionItem("pricing",      "Pricing",          _has("pricing"),   false)
          + _wbsSectionItem("testimonials", "Testimonials",     _has("testimonials"),false)
          + _wbsSectionItem("faq",          "FAQ",              _has("faq"),       false)
          + _wbsSectionItem("about",        "About",            _has("about"),     false)
          + _wbsSectionItem("contact",      "Contact",          _has("contact"),   false)
          + _wbsSectionItem("banner",       "Banner",           _has("banner"),    false)
          + _wbsSectionItem("showcase",     "Product Showcase", _has("showcase"),  false)
          + _wbsSectionItem("stats",        "Stats & Numbers",  _has("stats"),     false)
          + '</div></div>';
      })()

    + '<div class="wbc-actions">'
    + '<button class="btn btn-p" onclick="generateWeb()">Generate Website</button>'
    + '</div>'
    + '</div>';

  if(stepEl) stepEl.innerHTML = html;

  // Wire up color pickers
  ["_webPrimary","_webSecondary","_webAccent","_webBackground","_webText"].forEach(function(key){
    var inp = document.getElementById("wbc-inp-" + key);
    if(!inp) return;
    inp.addEventListener("input", function(){
      if(!S._builder) S._builder = {};
      S._builder[key] = this.value;
      var sw = document.getElementById("wbc-sw-" + key);
      var hx = document.getElementById("wbc-hx-" + key);
      if(sw) sw.style.background = this.value;
      if(hx) hx.textContent = this.value;
    });
  });

  // Wire up section toggles (Hero locked)
  document.querySelectorAll(".wbs-check:not([disabled])").forEach(function(cb){
    cb.addEventListener("change", function(){
      var item = this.closest(".wbs-item");
      if(item) item.classList.toggle("wbs-item-on", this.checked);
    });
  });
}

function _wbsSectionItem(id, label, checked, locked){
  var cls = "wbs-item" + (checked ? " wbs-item-on" : "") + (locked ? " wbs-item-locked" : "");
  var chk = checked ? " checked" : "";
  var dis = locked  ? " disabled" : "";
  return '<label class="' + cls + '">'
    + '<input type="checkbox" class="wbs-check" id="wbs-' + id + '" value="' + id + '"' + chk + dis + '>'
    + '<span class="wbs-label">' + label + (locked ? ' <span class="wbs-lock">always</span>' : '') + '</span>'
    + '</label>';
}

function _wbcColorRow(label, key, hex){
  return '<label class="wbc-color-row">'
    + '<div class="wbc-swatch-wrap">'
    + '<div class="wbc-swatch" id="wbc-sw-' + key + '" style="background:' + hex + '"></div>'
    + '<input type="color" class="wbc-color-inp" id="wbc-inp-' + key + '" value="' + hex + '">'
    + '</div>'
    + '<div class="wbc-color-info">'
    + '<span class="wbc-color-label">' + label + '</span>'
    + '<span class="wbc-color-hex" id="wbc-hx-' + key + '">' + hex + '</span>'
    + '</div>'
    + '</label>';
}

// ── Step 2: Fetch + render ────────────────────────────────────

function generateWeb(){
  var _b  = S._builder || {};
  var br  = _webBrand();

  var resultWrap = document.getElementById("builderResultWrap");
  var resultBody = document.getElementById("builderResultBody");
  var saveBtn    = document.getElementById("builderSaveBtn");
  var stepEl     = document.getElementById("flowStep");
  var msgEl      = document.getElementById("flowGuideMessage");

  if(resultWrap) resultWrap.style.display = "";
  if(resultBody) resultBody.innerHTML = _buildCodeLoader("web");
  if(saveBtn) saveBtn.disabled = true;
  if(msgEl)  msgEl.textContent = "Generating your landing page…";
  if(stepEl) stepEl.innerHTML  = "";

  // Collect checked sections from the picker (falls back to default)
  var _checkedSections = [];
  document.querySelectorAll(".wbs-check:checked").forEach(function(cb){
    _checkedSections.push(cb.value);
  });
  if(!_checkedSections.length) _checkedSections = ["hero","features","cta"];
  if(!S._builder) S._builder = {};
  S._builder._webSectionIds = _checkedSections;

  var _payload = {
    brand_name:       br.name          || "Your Brand",
    product:          _b.webPromotion  || "",
    audience:         _b.webAudience   || "",
    tone:             br.tone          || "",
    goal:             "sales",
    style:            _b.webStyle      || "minimal",
    style_hint:       _detectBrandStyle(_b.webPromotion || br.name || ""),
    layout_variant:   _webPickLayout(),
    animations:       _b.webAnimations || "subtle",
    website_type:     _b.webType       || "",
    sections:         _checkedSections.join(","),
    primary_color:    br.primary,
    secondary_color:  br.secondary,
    accent_color:     br.accent,
    background_color: br.background,
    text_color:       br.text
  };
  console.log("Payload size:", JSON.stringify(_payload).length);

  fetch(API_BASE_URL + "/api/generate-web", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(_payload)
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    console.log("[Web] response received, html length:", data.html ? data.html.length : 0);
    if(!data.html){
      if(resultBody) resultBody.innerHTML =
        '<div class="builder-error">' + (data.error || "No page was returned.") + '</div>';
      if(msgEl) msgEl.textContent = "Something went wrong. Please try again.";
      _webRegenBtn(stepEl);
      return;
    }
    _renderWebResult(data.html, resultBody, msgEl, stepEl, saveBtn);
  })
  .catch(function(err){
    console.error("[Web] fetch error:", err);
    if(resultBody) resultBody.innerHTML =
      '<div class="builder-error">Could not reach ORIVEN services. Please try again.</div>';
    if(msgEl) msgEl.textContent = "Connection failed. Please try again.";
    _webRegenBtn(stepEl);
  });
}

function _webEnableEdit(){
  var frame = document.getElementById("web-preview");
  if(!frame) return;

  // Upgrade sandbox so parent JS can access contentDocument
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");

  frame.onload = function(){
    frame.onload = null;
    var doc = frame.contentDocument;
    if(!doc) return;

    // Inject edit highlight styles
    if(!doc.getElementById("oriven-edit-style")){
      var s = doc.createElement("style");
      s.id = "oriven-edit-style";
      s.textContent = "[contenteditable]{outline:2px dashed #BFA07A!important;outline-offset:2px;"
        + "cursor:text;background:rgba(191,160,122,.08)!important;border-radius:3px!important;transition:outline .15s}"
        + "[contenteditable]:focus{outline:2px solid #BFA07A!important;background:rgba(191,160,122,.15)!important}";
      if(doc.head) doc.head.appendChild(s);
    }

    // Make text elements editable
    doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,button,a").forEach(function(el){
      el.setAttribute("contenteditable", "true");
      el.setAttribute("spellcheck", "false");
    });

    var editBtn = document.getElementById("bwr-edit-btn");
    var doneBtn = document.getElementById("bwr-done-btn");
    var editBar = document.getElementById("bwr-editbar");
    if(editBtn) editBtn.style.display = "none";
    if(doneBtn) doneBtn.style.display = "";
    if(editBar) editBar.style.display = "";
  };

  // Reload iframe with current HTML to apply expanded sandbox
  frame.srcdoc = S._lastWebHTML || "";
}

function _webSaveEdit(){
  var frame = document.getElementById("web-preview");
  if(!frame || !frame.contentDocument) return;
  var doc = frame.contentDocument;

  // Remove edit styles
  var styleEl = doc.getElementById("oriven-edit-style");
  if(styleEl) styleEl.parentNode.removeChild(styleEl);

  // Remove contenteditable
  doc.querySelectorAll("[contenteditable]").forEach(function(el){
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
  });

  // Capture updated HTML with edits applied
  S._lastWebHTML = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;

  // Return to secure sandbox — reload with link blocker re-injected
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = _webInjectLinkBlocker(S._lastWebHTML);

  var editBtn = document.getElementById("bwr-edit-btn");
  var doneBtn = document.getElementById("bwr-done-btn");
  var editBar = document.getElementById("bwr-editbar");
  if(editBtn) editBtn.style.display = "";
  if(doneBtn) doneBtn.style.display = "none";
  if(editBar) editBar.style.display = "none";
}

function _webRegenBtn(stepEl){
  if(!stepEl) return;
  stepEl.innerHTML =
    '<div style="text-align:center;padding:24px 0">'
    + '<button class="btn btn-p" onclick="generateWeb()" style="font-size:14px;padding:12px 28px">Try Again</button>'
    + '</div>';
}

// ── Brand style inference from product description ────────────

function _detectBrandStyle(desc){
  if(!desc) return "";
  desc = desc.toLowerCase();
  if(desc.match(/fitness|gym|sport|workout|athletic|muscle/)) return "bold,dark,high-contrast,athletic,energetic";
  if(desc.match(/saas|software|app|platform|tech|ai|api|tool/)) return "clean,minimal,structured,technical,professional";
  if(desc.match(/fashion|clothing|apparel|wear|boutique|style/)) return "editorial,image-focused,fashion-forward,refined";
  if(desc.match(/food|restaurant|cafe|coffee|bakery|chef|cuisine/)) return "warm,organic,appetizing,friendly";
  if(desc.match(/luxury|premium|exclusive|high-end|elite/)) return "luxurious,dark,minimal,elegant,understated";
  if(desc.match(/finance|invest|bank|wealth|trading|crypto/)) return "professional,trustworthy,structured,serious";
  if(desc.match(/creative|agency|design|studio|art/)) return "creative,distinctive,modern,bold-typography";
  if(desc.match(/health|wellness|spa|beauty|skincare/)) return "soft,clean,natural,calming";
  return "";
}

function _webPickLayout(){
  var v = ["centered-hero","split-hero","bold-fullscreen","asymmetric","editorial","minimal-structured"];
  return v[Math.floor(Math.random() * v.length)];
}

// ── Enhancement CSS injected into every generated site ────────

function _getWebEnhancementCSS(){
  return [
    "html{scroll-behavior:smooth}",
    "a,button,[role=button]{cursor:pointer}",
    /* Entrance animation classes — driven by JS IntersectionObserver */
    ".orv-hidden{opacity:0;transform:translateY(16px);transition:opacity 0.45s ease,transform 0.45s ease}",
    ".orv-visible{opacity:1!important;transform:translateY(0)!important}",
    /* Mobile nav open state */
    "@media(max-width:768px){",
    "  .nav-menu.orv-open,.mobile-nav.orv-open,.nav-links.orv-open,",
    "  nav>ul.orv-open,.menu-items.orv-open,.navbar-collapse.orv-open{",
    "    display:flex!important;flex-direction:column;",
    "    position:fixed;top:60px;left:0;right:0;",
    "    padding:20px 24px;z-index:9999;",
    "    box-shadow:0 8px 32px rgba(0,0,0,.25);",
    "    animation:orvMenuIn 0.2s ease both",
    "  }",
    "  @keyframes orvMenuIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}",
    "  [class*='hamburger'].orv-open span:nth-child(1),",
    "  .menu-toggle.orv-open span:nth-child(1){transform:rotate(45deg)translate(5px,5px)}",
    "  [class*='hamburger'].orv-open span:nth-child(2),",
    "  .menu-toggle.orv-open span:nth-child(2){opacity:0}",
    "  [class*='hamburger'].orv-open span:nth-child(3),",
    "  .menu-toggle.orv-open span:nth-child(3){transform:rotate(-45deg)translate(5px,-5px)}",
    "}"
  ].join("\n");
}

// ── Enhancement JS injected into every generated site ─────────

function _getWebEnhancementJS(){
  return "(function(){"
    + '"use strict";'
    + "document.addEventListener('DOMContentLoaded',function(){"

    /* ── 1. Smooth anchor scroll ── */
    + "document.querySelectorAll('a[href^=\"#\"]').forEach(function(a){"
    + "  a.addEventListener('click',function(e){"
    + "    var s=a.getAttribute('href');"
    + "    if(s.length<2)return;"
    + "    var t=document.querySelector(s);"
    + "    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'});}"
    + "  });"
    + "});"

    /* ── 2. Hamburger menu ── */
    + "var _tg=document.querySelector("
    + "  '.hamburger,.menu-toggle,.nav-toggle,.nav-hamburger,.menu-btn'"
    + "  ',[class*=\"hamburger\"],[aria-label*=\"menu\" i],[aria-label*=\"Menu\"]'"
    + ");"
    + "var _mn=document.querySelector("
    + "  '.mobile-nav,.nav-menu,.nav-links,.menu-items,.navbar-collapse,nav ul[class]'"
    + ");"
    + "if(_tg&&_mn&&!_tg.dataset.orv){"
    + "  _tg.dataset.orv='1';"
    + "  _tg.style.cursor='pointer';"
    + "  _tg.addEventListener('click',function(){"
    + "    _tg.classList.toggle('orv-open');"
    + "    _mn.classList.toggle('orv-open');"
    + "    _tg.setAttribute('aria-expanded',_mn.classList.contains('orv-open')?'true':'false');"
    + "  });"
    + "  _mn.querySelectorAll('a').forEach(function(a){"
    + "    a.addEventListener('click',function(){"
    + "      _tg.classList.remove('orv-open');"
    + "      _mn.classList.remove('orv-open');"
    + "    });"
    + "  });"
    + "}"

    /* ── 3. CTA button scroll routing ── */
    + "var _sm={"
    + "  'get started':'section:nth-of-type(2),.features,#features',"
    + "  'start free':'section:nth-of-type(2),.features',"
    + "  'learn more':'section:nth-of-type(2),.features,#features',"
    + "  'contact':'footer,#contact,.contact',"
    + "  'contact us':'footer,#contact,.contact',"
    + "  'sign up':'#cta,.cta,section:last-of-type',"
    + "  'get started free':'section:nth-of-type(2)',"
    + "  'buy now':'#pricing,.pricing',"
    + "  'see pricing':'#pricing,.pricing',"
    + "  'view pricing':'#pricing,.pricing',"
    + "  'schedule':'#contact,.contact,footer'"
    + "};"
    + "document.querySelectorAll('button,[class*=\"cta\"],[class*=\"btn\"],[class*=\"button\"]').forEach(function(btn){"
    + "  if(btn.dataset.orv||(btn.getAttribute('href')||'').charAt(0)==='#')return;"
    + "  btn.dataset.orv='1';"
    + "  var txt=btn.textContent.trim().toLowerCase();"
    + "  for(var k in _sm){"
    + "    if(txt.includes(k)){"
    + "      (function(sel){"
    + "        var t=document.querySelector(sel);"
    + "        if(t)btn.addEventListener('click',function(e){e.preventDefault();t.scrollIntoView({behavior:'smooth'});});"
    + "      })(_sm[k]);"
    + "      break;"
    + "    }"
    + "  }"
    + "});"

    /* ── 4. Scroll entrance animations ── */
    + "if(!window.IntersectionObserver)return;"
    + "setTimeout(function(){"
    + "  var obs=new IntersectionObserver(function(entries){"
    + "    entries.forEach(function(e){"
    + "      if(e.isIntersecting){"
    + "        e.target.classList.remove('orv-hidden');"
    + "        e.target.classList.add('orv-visible');"
    + "        obs.unobserve(e.target);"
    + "      }"
    + "    });"
    + "  },{threshold:0.08,rootMargin:'0px 0px -20px 0px'});"
    + "  document.querySelectorAll('section>*,h2,h3,.card,[class*=\"card\"],[class*=\"feature\"],[class*=\"item\"]').forEach(function(el){"
    + "    if(el.closest('header,nav'))return;"
    + "    var r=el.getBoundingClientRect();"
    + "    if(r.top<window.innerHeight-20){"
    + "      el.classList.add('orv-visible');"
    + "    }else{"
    + "      el.classList.add('orv-hidden');"
    + "      obs.observe(el);"
    + "    }"
    + "  });"
    + "},150);"

    + "});"
    + "})();";
}

// ── Post-processor — structural fixes + enhancement injection ──

function _postProcessWebHTML(html){
  try {
    var parser = new DOMParser();
    var doc    = parser.parseFromString(html, "text/html");
    var brandName = ((S.brandCore || {}).name || "");

    /* 1. Fix <a> missing/empty href */
    doc.querySelectorAll("a:not([href]), a[href=''], a[href='#!']").forEach(function(a){
      a.setAttribute("href", "#");
    });

    /* 2. Wrap bare nav/footer <li> text in <a> */
    doc.querySelectorAll("nav li, header nav li, footer li, footer ul li").forEach(function(li){
      if(li.tagName !== "A" && !li.querySelector("a") && li.textContent.trim()){
        var a = doc.createElement("a");
        a.setAttribute("href", "#");
        a.innerHTML = li.innerHTML;
        li.innerHTML = "";
        li.appendChild(a);
      }
    });

    /* 3. Assign section IDs for anchor navigation */
    var sectionKeys = ["hero","features","about","contact","pricing","benefits","faq","testimonials","cta","services","stats","showcase"];
    doc.querySelectorAll("section, footer").forEach(function(el){
      if(el.id) return;
      var cls  = (el.className || "").toLowerCase();
      var h    = el.querySelector("h1,h2,h3");
      var head = h ? h.textContent.trim().toLowerCase() : "";
      var id   = "";
      sectionKeys.forEach(function(k){
        if(!id && (cls.includes(k) || head.includes(k))) id = k;
      });
      if(!id && el.tagName === "FOOTER") id = "contact";
      if(id && !doc.getElementById(id)) el.id = id;
    });

    /* 4. Wire nav link text to section IDs */
    doc.querySelectorAll("nav a, header a").forEach(function(a){
      var href = a.getAttribute("href") || "";
      if(href && href !== "#") return;
      var txt  = a.textContent.trim().toLowerCase();
      var match = doc.getElementById(txt);
      if(!match) {
        sectionKeys.forEach(function(k){ if(!match && txt.includes(k)) match = doc.getElementById(k); });
      }
      if(match) a.setAttribute("href", "#" + match.id);
    });

    /* 5. Remove completely empty sections */
    doc.querySelectorAll("section, .section, [class*='block']").forEach(function(el){
      if(!el.textContent.trim() && !el.querySelector("img,svg,canvas,video")){
        if(el.parentNode) el.parentNode.removeChild(el);
      }
    });

    /* 6. Fill empty headings/paragraphs with fallback text */
    var fallbacks = { H1: brandName || "Welcome", H2: "Why Choose Us", H3: "Feature Name", P: "Discover what makes us different." };
    doc.querySelectorAll("h1,h2,h3,p").forEach(function(el){
      if(!el.textContent.trim()) el.textContent = fallbacks[el.tagName] || "";
    });

    /* 7. Inject enhancement CSS */
    if(!doc.getElementById("orv-css")){
      var style = doc.createElement("style");
      style.id  = "orv-css";
      style.textContent = _getWebEnhancementCSS();
      if(doc.head) doc.head.appendChild(style);
    }

    /* 8. Inject enhancement JS */
    if(!doc.getElementById("orv-js")){
      var script = doc.createElement("script");
      script.id  = "orv-js";
      script.textContent = _getWebEnhancementJS();
      if(doc.body) doc.body.appendChild(script);
    }

    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  } catch(e){
    console.warn("[Web] postProcess error:", e);
    return html;
  }
}

// ── Link-blocker for preview — allows same-page anchor scrolling ─

function _webInjectLinkBlocker(html){
  var script = '<script>document.addEventListener("click",function(e){'
    + 'var a=e.target.closest("a");'
    + 'if(a){'
    + '  e.preventDefault();e.stopPropagation();'
    + '  var h=a.getAttribute("href");'
    + '  if(h&&h.charAt(0)==="#"&&h.length>1){'
    + '    var t=document.querySelector(h);'
    + '    if(t)t.scrollIntoView({behavior:"smooth",block:"start"});'
    + '  }'
    + '}'
    + '},true);<\/script>';
  var idx = html.indexOf("</body>");
  if(idx !== -1) return html.slice(0, idx) + script + html.slice(idx);
  return html + script;
}

// ── Shared renderer: iframe + actions + publish guide ─────────

function _renderWebResult(html, resultBody, msgEl, stepEl, saveBtn){
  _stopCodeLoader();
  html = _postProcessWebHTML(html);
  S._lastWebHTML = html;

  var whtml = '<div class="builder-web-result">'
    + '<div class="bwr-toolbar">'
    + '<span class="bwr-label">Landing Page Preview</span>'
    + '<div class="bwr-actions">'
    + '<button id="bwr-edit-btn" class="bwr-btn bwr-btn-edit" onclick="_webEnableEdit()">Edit Text</button>'
    + '<button id="bwr-done-btn" class="bwr-btn bwr-btn-done" onclick="_webSaveEdit()" style="display:none">Done Editing</button>'
    + '<button class="bwr-btn" onclick="_downloadWebPage()">Download HTML</button>'
    + '<button class="bwr-btn bwr-btn-zip" onclick="_downloadWebZip()">Download ZIP</button>'
    + '</div>'
    + '</div>'
    + '<div id="bwr-editbar" class="bwr-editbar" style="display:none">Edit mode — click any text to edit it directly in the preview.</div>'
    + '<iframe id="web-preview" class="bwr-frame" sandbox="allow-scripts"></iframe>'
    + '</div>'
    + _buildPublishGuide();

  if(resultBody) resultBody.innerHTML = whtml;

  var frame = document.getElementById("web-preview");
  if(frame) frame.srcdoc = _webInjectLinkBlocker(html);

  if(saveBtn) saveBtn.disabled = false;
  if(msgEl)  msgEl.textContent = "Your landing page is ready. Download or publish below.";
  if(stepEl) stepEl.innerHTML =
    '<div style="text-align:center;padding:16px 0">'
    + '<button class="btn btn-g btn-sm" onclick="generateWeb()">Regenerate</button>'
    + '</div>';
}

function _buildPublishGuide(){
  return '<div class="bwr-publish">'
    + '<div class="bwr-publish-title">How to publish your website</div>'
    + '<ol class="bwr-publish-steps">'
    + '<li>Click <strong>Download ZIP</strong> above and unzip the folder.</li>'
    + '<li>Go to <strong>Netlify</strong> (netlify.com) or <strong>Vercel</strong> (vercel.com) and create a free account.</li>'
    + '<li>Drag and drop your folder onto the deploy area — or click <em>Add new site</em> and upload.</li>'
    + '<li>Your site will be live instantly with a public URL. You can add a custom domain in settings.</li>'
    + '</ol>'
    + '</div>';
}

// ── Download: HTML file ───────────────────────────────────────

function _downloadWebPage(){
  var html = S._lastWebHTML || "";
  if(!html) return;
  var blob = new Blob([html], { type: "text/html" });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement("a");
  a.href = url; a.download = "index.html";
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
}

// ── Download: ZIP file (proper offline project structure) ────

function _downloadWebZip(){
  var html = S._lastWebHTML || "";
  if(!html){ console.warn("[Web] No HTML to zip"); return; }

  if(typeof JSZip === "undefined"){
    _downloadWebPage();
    return;
  }

  // ── 1. Extract inline <style> blocks ──
  var rawCss = "";
  var indexHtml = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function(_, content){
    rawCss += content.trim() + "\n\n";
    return "";
  });

  // ── 2. Extract inline <script> blocks (no src="") ──
  var rawJs = "";
  indexHtml = indexHtml.replace(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi, function(_, content){
    if(content.trim()) rawJs += content.trim() + "\n\n";
    return "";
  });

  // ── 3. CSS: prepend offline-safe baseline, always output a file ──
  var finalCss = "/* Generated by ORIVEN AI */\n"
    + "*, *::before, *::after { box-sizing: border-box; }\n"
    + "body { margin: 0; padding: 0; font-family: system-ui, sans-serif; }\n\n"
    + rawCss;

  // ── 4. JS: wrap in DOMContentLoaded + try/catch so no error blocks render ──
  var finalJs = "";
  if(rawJs.trim()){
    var alreadyWrapped = rawJs.indexOf("DOMContentLoaded") !== -1;
    finalJs = alreadyWrapped
      ? "try {\n" + rawJs.trim() + "\n} catch(e) { console.error('[Site]', e); }"
      : "document.addEventListener('DOMContentLoaded', function() {\n"
          + "  try {\n    " + rawJs.trim().replace(/\n/g, "\n    ")
          + "\n  } catch(e) { console.error('[Site]', e); }\n});";
  }

  // ── 5. Inject external file references ──
  var cssLink   = '<link rel="stylesheet" href="./styles/style.css">';
  var scriptTag = '<script src="./scripts/script.js" defer><\/script>';

  // Insert CSS link before </head>
  if(indexHtml.indexOf("</head>") !== -1){
    indexHtml = indexHtml.replace("</head>", cssLink + "\n</head>");
  } else {
    indexHtml = cssLink + "\n" + indexHtml;
  }

  // Insert script before </body> (or append)
  if(finalJs){
    if(indexHtml.indexOf("</body>") !== -1){
      indexHtml = indexHtml.replace("</body>", scriptTag + "\n</body>");
    } else {
      indexHtml = indexHtml + "\n" + scriptTag;
    }
  }

  // ── 6. Determine project folder name ──
  var brandName = (((S.brandCore || {}).name || "website")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "website";

  // ── 7. Build ZIP with proper folder structure ──
  var zip  = new JSZip();
  var root = zip.folder(brandName);
  root.file("index.html", indexHtml);
  root.folder("styles").file("style.css", finalCss);
  if(finalJs) root.folder("scripts").file("script.js", finalJs);

  zip.generateAsync({ type: "blob" })
    .then(function(blob){
      var url = URL.createObjectURL(blob);
      var a   = document.createElement("a");
      a.href = url; a.download = brandName + ".zip";
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
    });
}


// ── Image overlay helpers ─────────────────────────────────────

function _toggleImgText(visible){
  var layer = document.getElementById("imgTextLayer");
  if(layer) layer.style.opacity = visible ? "" : "0";
  var toggle = document.getElementById("imgTextToggle");
  if(toggle) toggle.checked = !!visible;
}

function _setImgTextColor(mode){
  var layer = document.getElementById("imgTextLayer");
  if(!layer) return;
  layer.classList.remove("img-txt-light","img-txt-dark");
  layer.classList.add("img-txt-" + mode);
  document.querySelectorAll(".icb").forEach(function(b){ b.classList.remove("active"); });
  var btn = document.getElementById(mode === "light" ? "icbLight" : "icbDark");
  if(btn) btn.classList.add("active");
}


// ── builderSave — save last result to Studio ─────────────────

function builderSave(){
  if(!S._lastBuilderResult) return;

  var type = S._lastBuilderResult.type;
  var data = S._lastBuilderResult.data;
  var bc   = S.brandCore;

  var labelMap = { image:"Image", text:"Copy", ads:"Ad Creative", campaign:"Campaign" };
  var category = labelMap[type] || "Content";

  var name = "";
  if(type === "campaign" && data.variations && data.variations.length){
    name = (data.variations[0].title || "") || (category + " \u2014 " + new Date().toLocaleDateString());
  } else {
    name = data.title || data.headline || (category + " \u2014 " + new Date().toLocaleDateString());
  }

  // Build preview text for the Studio card
  var previewText = "";
  if(type === "image"){
    var iParts = [];
    if(data.headline) iParts.push(data.headline);
    if(data.subtext)  iParts.push(data.subtext);
    if(data.cta)      iParts.push(data.cta);
    previewText = iParts.join(" \u00b7 ");
  } else if(type === "campaign" && data.variations && data.variations.length){
    previewText = data.variations.map(function(v){ return v.headline || ""; }).filter(Boolean).join(" \u00b7 ");
  } else {
    previewText = data.result || data.message || data.body || "";
  }

  var asset = {
    id:        Date.now(),
    type:      type,
    category:  category,
    name:      name,
    thumb:     data.imageUrl || null,
    preview:   previewText,
    payload:   data,
    createdAt: new Date().toISOString()
  };

  if(!S.assets) S.assets = [];
  S.assets.unshift(asset);

  if(type === "campaign"){
    if(!S.campaigns) S.campaigns = [];
    S.campaigns.unshift({ id:asset.id, name:name, assets:[asset.id], createdAt:asset.createdAt });
    if(typeof renderCampaigns === "function") renderCampaigns();
  }

  if(typeof renderAssets === "function") renderAssets();

  var saveBtn = document.getElementById("builderSaveBtn");
  if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = "Saved ✓"; }

  if(typeof toast === "function") toast("Saved to Studio");
}


// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  CHAT-BASED CREATE WORKSPACE
//  Used by: Brand Assistant, Video, Ideas
//  Image, Text, Ads, Campaign are now handled by the structured
//  builder above (openBuilder / runBuilder).
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════

function openCreateWorkspace(type, outType){
  // ── Structured types → builder ─────────────────────────────
  if(type === "image" || type === "text" || type === "ads" || type === "campaign"){
    openBuilder(type);
    return;
  }

  // ── Chat-based: assistant, video, ideas ────────────────────
  var ct = CREATE_TYPES[type] || CREATE_TYPES.assistant;
  S._cwsType    = type;
  S._cwsHistory = [];

  var lbl = document.getElementById("cwsTypeLabel");
  var ico = document.getElementById("cwsTypeIcon");
  var ctx = document.getElementById("cwsContext");
  if(lbl) lbl.textContent = ct.label;
  if(ico) ico.innerHTML   = ct.icon;
  if(ctx && S.brandCore)  ctx.textContent = "Brand: " + S.brandCore.name;
  else if(ctx)            ctx.textContent = "";

  var sel = document.getElementById("cwsOutType");
  if(sel) sel.value = outType || ct.outType;

  // Show video configurator if needed, hide others
  CWS_ALL_CFGS.forEach(function(id){
    var el = document.getElementById(id);
    if(!el) return;
    var activeCfgId = CWS_CFG_MAP[type] || null;
    el.style.display = (id === activeCfgId) ? "" : "none";
  });

  var cwsCtrls = document.getElementById("cwsControls");
  var activeCfgId = CWS_CFG_MAP[type] || null;
  if(activeCfgId){
    if(cwsCtrls) cwsCtrls.style.display = "none";
  } else {
    if(cwsCtrls) cwsCtrls.style.display = "";
  }

  if(type === "video"){
    S._vidFormat = "short_vertical";
    videoSelectFormat("short_vertical");
  }

  var inp = document.getElementById("cwsInput");
  if(inp && !activeCfgId) inp.placeholder = ct.placeholder;

  // Welcome screen
  var feed = document.getElementById("cwsFeed");
  if(feed){
    var bc          = S.brandCore;
    var bcHint      = bc ? ' using your <strong>' + bc.name + '</strong> Brand Core' : "";
    var isAssistant = type === "assistant";

    var assistantBlock = "";
    if(isAssistant){
      var starters    = _buildAssistantStarters(bc);
      var starterHtml = starters.map(function(s){
        return '<div class="chat-sug" onclick="assistantFill(' + JSON.stringify(s) + ')">' + _escHtml(s) + '</div>';
      }).join("");
      var subline = bc
        ? 'Personalized for <strong>' + _escHtml(bc.name) + '</strong>. Select a prompt to get started, or ask anything.'
        : 'Select a prompt to get started, or ask anything about your brand.';
      assistantBlock =
        '<p class="chat-welcome-sub">' + subline + '</p>'
        + '<div class="chat-suggestions ast-starters">' + starterHtml + '</div>';
    }

    feed.innerHTML =
      '<div class="chat-welcome">'
      + '<div class="chat-welcome-icon"><svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.4" width="28" height="28"><path d="M14 3L17 10H24L19 14L21 21L14 17L7 21L9 14L4 10H11Z"/></svg></div>'
      + '<h2>' + (isAssistant ? "Brand Assistant" : "Create " + ct.label) + '</h2>'
      + '<p>' + (isAssistant ? t("welcomeMsg") : "Describe what you want to create" + bcHint + ". I will generate it for you.") + '</p>'
      + assistantBlock
      + '</div>';
  }

  navigate("create-workspace");
}


// ════════════════════════════════════════════════════════════════
// renderBubble — format AI responses for chat-based tools
// ════════════════════════════════════════════════════════════════

function _escHtml(s){
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function _formatBrief(raw){
  var s = _escHtml(raw);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\n)([A-Z][A-Z /]+:)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|\n)(\d+\.\s)/g, "$1<br>$2");
  s = s.replace(/\n\n/g, "<br><br>");
  s = s.replace(/\n/g, "<br>");
  return s;
}

function renderBubble(type, data){
  if(data.error) return _escHtml(data.error);
  if(type === "video"){
    if(!data.result) return "No video brief received.";
    return _formatBrief(data.result);
  }
  if(!data.result) return "No response received.";
  return _formatBrief(data.result);
}


// ════════════════════════════════════════════════════════════════
// cwsSaveToStudio — used by chat-based tool save buttons
// ════════════════════════════════════════════════════════════════

function cwsSaveToStudio(btn){
  if(!btn) return;
  var type    = btn.getAttribute("data-type") || "content";
  var payload = {};
  try { payload = JSON.parse(btn.getAttribute("data-payload") || "{}"); } catch(_){}

  var labelMap = { video:"Video Brief", assistant:"Brand Note", ideas:"Idea" };
  var category = labelMap[type] || "Content";
  var name     = payload.title || (category + " " + new Date().toLocaleDateString());
  var preview  = payload.result || payload.message || payload.body || "";

  var asset = {
    id:        Date.now(),
    type:      type,
    category:  category,
    name:      name,
    thumb:     null,
    preview:   preview,
    payload:   payload,
    createdAt: new Date().toISOString()
  };

  if(!S.assets) S.assets = [];
  S.assets.unshift(asset);
  if(typeof renderAssets === "function") renderAssets();

  btn.disabled    = true;
  btn.textContent = "Saved";
  btn.classList.add("cws-save-btn-done");
  if(typeof toast === "function") toast("Saved to Studio");
}


// ════════════════════════════════════════════════════════════════
// sendCWS — chat generation (assistant, video, ideas only)
// ════════════════════════════════════════════════════════════════

async function sendCWS(){
  var input = document.getElementById("cwsInput");
  if(!input) return;
  var prompt = input.value.trim();
  if(!prompt) return;

  if(typeof gateUsage === "function"){
    var allowed = await gateUsage();
    if(!allowed) return;
  }

  input.value = "";
  input.style.height = "auto";

  if(!S._cwsHistory) S._cwsHistory = [];
  S._cwsHistory.push({ role:"user", text:prompt });

  var feed = document.getElementById("cwsFeed");
  if(!feed) return;

  var welcome = feed.querySelector(".chat-welcome");
  if(welcome) welcome.remove();

  var ud = document.createElement("div");
  ud.className = "chat-msg user";
  ud.innerHTML = '<div class="chat-bubble user-bubble">' + _escHtml(prompt) + "</div>";
  feed.appendChild(ud);
  feed.scrollTop = feed.scrollHeight;

  var tid  = "cws-typing-" + Date.now();
  var tdiv = document.createElement("div");
  tdiv.id        = tid;
  tdiv.className = "chat-msg ai";
  tdiv.innerHTML = '<div class="chat-ai-avatar"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2L12.5 7.5H18L13.5 11L15 16.5L10 13.5L5 16.5L6.5 11L2 7.5H7.5Z"/></svg></div>'
    + '<div class="chat-bubble ai-bubble"><div class="chat-typing"><span></span><span></span><span></span></div></div>';
  feed.appendChild(tdiv);
  feed.scrollTop = feed.scrollHeight;

  var cwsType = S._cwsType || "assistant";

  var finalPrompt;
  if     (cwsType === "video")     finalPrompt = buildVideoPrompt(prompt);
  else if(cwsType === "assistant") finalPrompt = buildAssistantPrompt(prompt);
  else                             finalPrompt = prompt;

  var endpoint = API_BASE_URL+"/api/generate-text";

  fetch(endpoint, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ prompt: finalPrompt, type: cwsType })
  })
  .then(function(res){ return res.json(); })
  .then(function(data){
    var tel = document.getElementById(tid);
    if(tel) tel.remove();

    var ad = document.createElement("div");
    ad.className = "chat-msg ai";
    var bubbleContent = renderBubble(cwsType, data);
    var saveRow = !data.error
      ? '<div class="cws-save-row"><button class="cws-save-btn" onclick="cwsSaveToStudio(this)" data-type="' + cwsType + '" data-payload=\'' + JSON.stringify(data).replace(/'/g, "&#39;") + '\'>Save to Studio</button></div>'
      : "";
    ad.innerHTML =
      '<div class="chat-ai-avatar"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2L12.5 7.5H18L13.5 11L15 16.5L10 13.5L5 16.5L6.5 11L2 7.5H7.5Z"/></svg></div>'
      + '<div class="chat-bubble ai-bubble">' + bubbleContent + saveRow + "</div>";
    feed.appendChild(ad);
    feed.scrollTop = feed.scrollHeight;
    S._cwsHistory.push({ role:"ai", text:"[" + cwsType + " response]" });
  })
  .catch(function(err){
    console.error("[CWS/" + cwsType + "] error:", err);
    var tel = document.getElementById(tid);
    if(tel) tel.remove();

    var ad = document.createElement("div");
    ad.className = "chat-msg ai";
    ad.innerHTML =
      '<div class="chat-ai-avatar"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2L12.5 7.5H18L13.5 11L15 16.5L10 13.5L5 16.5L6.5 11L2 7.5H7.5Z"/></svg></div>'
      + '<div class="chat-bubble ai-bubble">Could not connect to ORIVEN services. Please try again.</div>';
    feed.appendChild(ad);
    feed.scrollTop = feed.scrollHeight;
  });
}


// ════════════════════════════════════════════════════════════════
// Input wiring
// ════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", function(){
  var ci = document.getElementById("cwsInput");
  if(ci){
    ci.addEventListener("keydown", function(e){
      if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendCWS(); }
    });
    ci.addEventListener("input", function(){
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 120) + "px";
    });
  }
});
