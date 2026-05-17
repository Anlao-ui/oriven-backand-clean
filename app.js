// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
var S={
  brandCore:null,
  assets:[],
  campaigns:[],
  chatHistory:[],
  lastScore:null,
  currentTplId:null,
  renameId:null
};

// ═══════════════════════════════════════════════════════════════
// IDEAS — data + panel logic
// ═══════════════════════════════════════════════════════════════

var ID_PANELS = {
  content: {
    title: "Content Ideas",
    ideas: [
      {
        label: "Educational Posts",
        desc:  "Teach one thing your audience doesn't know. Share a counter-intuitive insight from your industry. Position your brand as the expert before you ever pitch a product.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Product Spotlight",
        desc:  "Put one product, feature, or detail under the microscope. Zoom in on what makes it different. Not a feature dump — one angle, explained well. Make the ordinary feel remarkable.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Founder Story",
        desc:  "Why did you start this? What did you risk, fail at, or discover? People don't buy from brands — they buy from people. Tell the story behind the brand before you tell the brand story.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Transformation Story",
        desc:  "Show the before and after — not just visually, but emotionally. What changed? How did life, work, or perspective shift? Make the reader see themselves in the transformation.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Customer Result",
        desc:  "One real customer. One real result. Be specific — numbers, timelines, context. Vague testimonials do nothing. Precise stories convert. Let their result sell for you.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Comparison Post",
        desc:  "Old way vs. your way. Generic vs. specific. Complicated vs. simple. Frame the comparison so your brand wins without ever directly attacking anyone. Let the contrast do the work.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Myth vs. Truth",
        desc:  "Call out a common belief in your space that's holding people back. Then replace it with what actually works. This format earns trust fast — and makes your brand the authority.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Before / After",
        desc:  "Show the contrast. The messy desk and the organized one. The clunky process and the streamlined one. Visually or in copy — before/after is one of the most compelling structures in content.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Routine / Workflow",
        desc:  "Show how you, your team, or your customer actually uses your product in a real workflow. \"How I start my day\" or \"The process behind every project\" — process content builds depth and trust.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      },
      {
        label: "Authority Builder",
        desc:  "Share a strong opinion on something in your industry. Take a clear stance. Disagree with the conventional wisdom. Brands with a point of view attract loyal audiences. Neutral brands attract no one.",
        useLabel: "Use this idea",
        genLabel: "Generate post"
      }
    ]
  },
  angles: {
    title: "Ad Angles",
    ideas: [
      {
        label: "Problem → Solution",
        desc:  "Name the exact pain your audience feels right now. Make it specific enough that they feel seen. Then show the fix. Make it obvious your product is the only logical bridge between where they are and where they want to be.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Aspiration",
        desc:  "Show the life they want. Not what your product does — what their life looks like after they use it. Then position your brand as the bridge. Sell the destination, not the vehicle.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Transformation",
        desc:  "Open with where they are. Close with where they could be. The transformation is the product. Make the gap vivid — the wider the gap feels, the more valuable the bridge becomes.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Urgency",
        desc:  "Limited time, limited stock, or limited access — make the scarcity real. Manufactured urgency backfires. Real constraints convert. Give them one reason to act now, not later.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Scarcity",
        desc:  "Not everyone can have this — and that's the point. Exclusive access, waitlists, limited batches. Scarcity signals value. If everyone has it, no one wants it. Frame exclusivity deliberately.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Pain Point Agitation",
        desc:  "Don't just name the problem — press on it. Make them feel the frustration, the wasted time, the cost of inaction. Agitate before you solve. Urgency lives in the pain, not the solution.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Social Proof",
        desc:  "Not just \"5 stars\" — give proof with context. Who got the result? How long did it take? What were they skeptical about first? Specific proof from a relatable person converts far better than generic praise.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Premium Positioning",
        desc:  "Don't compete on price — compete on category. If you're the best, act like it. Higher price = higher perceived value when the framing is right. Make the premium feel earned and obvious.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Benefit-First",
        desc:  "Lead with the outcome, not the feature. Not \"16-hour battery life\" — \"Get through your full day without thinking about your phone once.\" Translate every feature into the feeling it creates.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      },
      {
        label: "Emotional Hook",
        desc:  "Skip the logic entirely. Open with a feeling — relief, pride, excitement, belonging. People make decisions emotionally, then justify with logic. Lead with emotion, support with proof.",
        useLabel: "Try this angle",
        genLabel: "Generate ad"
      }
    ]
  },
  visual: {
    title: "Visual Styles",
    ideas: [
      {
        label: "Luxury Minimal",
        desc:  "Clean whites, generous white space, premium typography, restrained palette of one or two colors. Nothing decorative. Every element earns its place. Silence on the page communicates quality.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Bold Modern",
        desc:  "Strong geometry, high contrast, confident typography with zero decoration. No soft gradients, no unnecessary shadows. The grid is the design. Works for tech, finance, and performance brands.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Dark Premium",
        desc:  "Deep near-black tones, neon or gold accents, editorial framing, cinematic atmosphere. High-contrast hierarchy. Makes cheap products feel expensive. Strong for tech, streetwear, and beauty.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Soft Lifestyle",
        desc:  "Real people, natural light, warm candid moments, imperfect textures and fabrics. Staged photography is immediately obvious. Authentic beats polished every time when building emotional connection.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Editorial Clean",
        desc:  "Magazine-quality composition. Strong typography leading the layout. Product as art. Every visual feels intentional — nothing placed randomly. Used by fashion, beauty, and publishing brands.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "High Contrast",
        desc:  "Pure black against pure white. Or a single bold color pushed to maximum saturation. No mid-tones, no gradients. Maximum impact with minimum complexity. Demands attention on any feed.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Futuristic Sleek",
        desc:  "Metallic surfaces, cool blue or silver tones, clean lines, subtle glow effects. Feels ahead of its time. Works for AI, hardware, performance, and technology-forward brands.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Organic Natural",
        desc:  "Earthy tones, raw textures, uneven edges, botanical elements, hand-drawn details. Feels honest, grounded, and non-corporate. Ideal for wellness, food, skincare, and sustainability brands.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Sporty Performance",
        desc:  "Dynamic angles, motion blur, bold type, high saturation, energy. Designed to feel like movement even when static. Strong for fitness, sport, activewear, and energy brands.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      },
      {
        label: "Elegant Feminine",
        desc:  "Soft palettes, delicate typography, refined negative space, graceful composition. Warmth and sophistication in equal measure. Strong for beauty, fashion, home, and lifestyle brands.",
        useLabel: "Use this style",
        genLabel: "Generate visual"
      }
    ]
  },
  campaign: {
    title: "Campaign Concepts",
    ideas: [
      {
        label: "Product Launch",
        desc:  "Build anticipation → reveal → educate → convert. Sequence over one to two weeks. Tease before you show. Show before you sell. Educate before you ask. Convert with urgency at the close.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Brand Awareness",
        desc:  "Tell your story before you sell. Repeated low-pressure exposure across platforms. No CTA on every post. Show up with consistent value first. Sell later. This is the long game — and it compounds.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Seasonal Drop",
        desc:  "Anchor the campaign to a moment — holiday, season, cultural event. Build anticipation in the two weeks before, drop hard, then close with a final 48-hour push. Timing creates momentum.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Conversion Push",
        desc:  "Full-funnel campaign optimized for one action: buy, sign up, or book. Awareness ads → retargeting → cart abandon → last-chance email. Every touchpoint is designed to reduce friction and close.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Educational Funnel",
        desc:  "Teach your audience before you sell to them. Content → trust → product. A five-part series, a free guide, or a short course. By the time they see the offer, they already believe you.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Retargeting Sequence",
        desc:  "Re-engage people who already know you but haven't converted. Different message for different stages — visited site, started checkout, watched video. Each touchpoint moves them one step closer.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Limited Offer Sprint",
        desc:  "Short, intense campaign around a real limitation: 72 hours, 50 units, one cohort. Tight window = real urgency. Keep creative consistent, increase frequency, close hard at the deadline.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Founder-Led Campaign",
        desc:  "Put the founder front and center. Their face, their voice, their story. People trust people more than brands. A direct personal message from the founder can outperform any polished ad.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Testimonial-Driven",
        desc:  "Let your customers do the talking. Real words, real faces, real results. Collect five to ten strong testimonials. Build the entire campaign around their language — not yours. It converts because it's credible.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      },
      {
        label: "Community Campaign",
        desc:  "Build around your audience, not at them. User-generated content, community challenges, shared tags, collaborative moments. Turns customers into advocates. The brand steps back — the community leads.",
        useLabel: "Build this campaign",
        genLabel: "Generate assets"
      }
    ]
  }
};

function renderInspiration(){
  // Ideas hub is static HTML — panels rendered on demand by idShowPanel()
}

// Maps each Ideas category to its builder flow type
var ID_DEST = {
  content:  'text',
  angles:   'ads',
  visual:   'image',
  campaign: 'campaign'
};

function idShowPanel(cat){
  var data = ID_PANELS[cat];
  if(!data) return;

  // Track open panel so applyLanguage() can re-render on language switch
  S._currentIdPanel = cat;

  var hub     = document.getElementById("idHubView");
  var pv      = document.getElementById("idPanelView");
  var titleEl = document.getElementById("idPanelTitle");
  var content = document.getElementById("idPanelContent");

  if(hub)     hub.style.display = "none";

  // Panel title: key like "idContentTitle", "idAnglesTitle", etc.
  var catKey = cat.charAt(0).toUpperCase() + cat.slice(1);
  var titleKey = "id" + catKey + "Title";
  if(titleEl) titleEl.textContent = (t(titleKey) !== titleKey) ? t(titleKey) : data.title;

  if(pv) pv.classList.remove("hidden");

  if(content){
    var html = '<div class="id-ideas-grid">';
    data.ideas.forEach(function(idea, i){
      // Label: key like "idCont0Label", "idAng0Label", "idVis0Label", "idCamp0Label"
      var catPrefix = cat === "content" ? "Cont" : cat === "angles" ? "Ang" : cat === "visual" ? "Vis" : "Camp";
      var labelKey = "id" + catPrefix + i + "Label";
      var descKey  = "id" + catPrefix + i + "Desc";
      var useKey   = "id" + catKey + "UseLabel";
      var genKey   = "id" + catKey + "GenLabel";

      var label   = (t(labelKey) !== labelKey) ? t(labelKey) : idea.label;
      var desc    = (t(descKey)  !== descKey)  ? t(descKey)  : idea.desc;
      var useText = (t(useKey)   !== useKey)   ? t(useKey)   : idea.useLabel;

      var safeLabel = label.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      var safeDesc  = desc.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      html += '<div class="id-idea-card">';
      html += '<div class="id-idea-label">' + label + '</div>';
      html += '<div class="id-idea-desc">'  + desc  + '</div>';
      html += '<div class="id-idea-actions">';
      html += '<button class="id-cta-primary" onclick="idUseIdea(\'' + cat + '\',\'' + safeLabel + '\',\'' + safeDesc + '\')">' + useText + '</button>';
      html += '</div></div>';
    });
    html += '</div>';
    content.innerHTML = html;
  }
}

function idUseIdea(cat, label, desc){
  var builderType = ID_DEST[cat];
  // Compose the prefill text from the idea title and description
  var prefill = label + ' — ' + desc;

  if(builderType){
    // Store the prefill so openBuilder can inject it into the flow
    if(!window.S) S = {};
    S._ideaPrefill = prefill;
    // Open the structured builder flow — user still answers all questions,
    // but _extraNotes is pre-seeded so the idea lands in the final prompt
    openBuilder(builderType);
  } else {
    // Fallback: Brand Assistant chat
    navigate('aichat');
    setTimeout(function(){
      var inp = document.getElementById('chatInput');
      if(!inp) return;
      inp.value = prefill;
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    }, 80);
  }
}

function idShowHub(){
  var hub = document.getElementById("idHubView");
  var pv  = document.getElementById("idPanelView");
  if(hub) hub.style.display = "";
  if(pv)  pv.classList.add("hidden");
  S._currentIdPanel = null;
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════
function navigate(page){
  // Plan gate: free users cannot access Inspiration or Brand Assistant
  if(page==="inspiration" || page==="aichat"){
    var _gatePlan = (typeof S!=="undefined" && S && S.currentPlan) ? S.currentPlan : "free";
    if(_gatePlan==="free"){
      if(typeof toast==="function") toast("Upgrade your plan to access this feature","warn");
      if(typeof openPaywall==="function") openPaywall();
      return;
    }
  }
  document.querySelectorAll(".ni").forEach(function(e){e.classList.remove("active");});
  document.querySelectorAll(".page").forEach(function(e){e.classList.remove("active");});
  // highlight sidebar item — workspace shares "create" highlight
  var niPage=page==="create-workspace"?"create":page==="templates"?"inspiration":page;
  var ni=document.querySelector('[data-page="'+niPage+'"]');
  if(ni) ni.classList.add("active");
  var pg=document.getElementById("page-"+page);
  if(pg) pg.classList.add("active");
  if(page==="dashboard")  refreshDash();
  if(page==="brandcore")  refreshBC();
  if(page==="studio")     refreshStudio();
  if(page==="inspiration") renderInspiration();
  if(page==="aichat")     initChat();
  if(page==="create")     S._cwsHistory=[];
  if(page==="team")       { if(typeof initTeamPage==="function") initTeamPage(); }
  if(page==="ugc")        { if(typeof ugcInit==="function") ugcInit(); }
}

function openBCRegen(){
  var plan = (typeof S!=="undefined" && S && S.currentPlan) ? S.currentPlan : "free";
  if(plan==="free"){
    if(typeof toast==="function") toast("BrandCore regeneration requires a paid plan","warn");
    if(typeof openPaywall==="function") openPaywall();
    return;
  }
  if(typeof openModal==="function") openModal("modal-genbrand");
}
document.querySelectorAll(".ni").forEach(function(e){
  e.addEventListener("click",function(){ navigate(e.getAttribute("data-page")); });
});

// ═══════════════════════════════════════════════════════════════
// SIDEBAR TOGGLE (mobile)
// ═══════════════════════════════════════════════════════════════
function toggleSidebar(){
  var sb  = document.getElementById("sidebar");
  var ov  = document.getElementById("sbOverlay");
  if(!sb) return;
  var open = sb.classList.toggle("sb-open");
  if(ov) ov.classList.toggle("active", open);
}
function closeSidebar(){
  var sb = document.getElementById("sidebar");
  var ov = document.getElementById("sbOverlay");
  if(sb) sb.classList.remove("sb-open");
  if(ov) ov.classList.remove("active");
}
// Close sidebar when a nav item is clicked on mobile
document.querySelectorAll(".ni").forEach(function(e){
  e.addEventListener("click",function(){ if(window.innerWidth<=768) closeSidebar(); });
});

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
var tTimer;
function toast(msg,type){
  type=type||"ok";
  var t=document.getElementById("toast");
  t.textContent=msg;
  t.className="toast show "+(type==="ok"?"ok":"warn");
  clearTimeout(tTimer);
  tTimer=setTimeout(function(){t.className="toast";},3000);
}

// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add("open");}
function closeModal(id){document.getElementById(id).classList.remove("open");}
document.querySelectorAll(".mbk").forEach(function(b){
  b.addEventListener("click",function(e){if(e.target===b) b.classList.remove("open");});
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
function refreshDash(){
  var bc=S.brandCore;

  // ── Brand identity badge (hero row) ──────────────────────────
  var badgeEl=document.getElementById("dashBrandBadge");
  if(badgeEl){
    if(bc){
      // Color swatches (up to 4)
      var swatchHTML="";
      if(bc.colors&&bc.colors.length){
        bc.colors.slice(0,4).forEach(function(c){
          swatchHTML+='<span class="dash-badge-swatch" style="background:'+c.hex+'"></span>';
        });
      }
      // Tone pill
      var tone=(bc.tone&&bc.tone[0])||"";
      var toneHTML=tone?'<span class="dash-badge-tone">'+tone+'</span>':"";
      // Colors row
      var colorsHTML=swatchHTML?'<span class="dash-badge-colors">'+swatchHTML+'</span>':"";
      badgeEl.innerHTML=
        '<span class="dash-badge-name"><span class="dash-badge-dot"></span>'+bc.name+'</span>'+
        toneHTML+colorsHTML;
    } else {
      badgeEl.innerHTML='<button class="dash-badge-setup" onclick="navigate(\'studio\');setTimeout(function(){switchStudioTab(\'brandcore\')},100)">'+t("setUpBrandCore")+'</button>';
    }
  }

  // ── Brand snapshot card (below actions) ──────────────────────
  var snapEl=document.getElementById("dashSnapshot");
  if(snapEl){
    if(bc){
      // Swatches — up to 5 colors
      var snapSwatches="";
      if(bc.colors&&bc.colors.length){
        bc.colors.slice(0,5).forEach(function(c){
          snapSwatches+='<span class="dash-snap-swatch" style="background:'+c.hex+'" title="'+c.hex+'"></span>';
        });
      }
      // Meta: tone + industry (short)
      var snapMeta=[];
      if(bc.tone&&bc.tone[0]) snapMeta.push(bc.tone[0]);
      if(bc.industry) snapMeta.push(bc.industry);
      snapEl.innerHTML=
        '<div class="dash-snapshot">'+
          '<div class="dash-snap-ico">'+
            '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.4">'+
              '<path d="M10 2l2.2 5.5H18l-4.5 3.3 1.7 5.5L10 13.3l-5.2 3 1.7-5.5L2 7.5h5.8Z"/>'+
            '</svg>'+
          '</div>'+
          '<div class="dash-snap-body">'+
            '<div class="dash-snap-label">'+t("brandCore")+'</div>'+
            '<div class="dash-snap-name">'+bc.name+'</div>'+
            (snapMeta.length?'<div class="dash-snap-meta">'+snapMeta.join(' · ')+'</div>':'')+
            (snapSwatches?'<div class="dash-snap-colors">'+snapSwatches+'</div>':'')+
          '</div>'+
          '<button class="dash-snap-edit" onclick="navigate(\'studio\');setTimeout(function(){switchStudioTab(\'brandcore\')},100)">'+t("edit")+'</button>'+
        '</div>';
    } else {
      snapEl.innerHTML=
        '<div class="dash-snapshot">'+
          '<div class="dash-snap-ico">'+
            '<svg viewBox="0 0 20 20" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.4">'+
              '<path d="M10 2l2.2 5.5H18l-4.5 3.3 1.7 5.5L10 13.3l-5.2 3 1.7-5.5L2 7.5h5.8Z"/>'+
            '</svg>'+
          '</div>'+
          '<div class="dash-snap-body">'+
            '<div class="dash-snap-label">'+t("brandCore")+'</div>'+
            '<div class="dash-snap-name" style="color:var(--muted);font-weight:500">'+t("notConfigured")+'</div>'+
            '<div class="dash-snap-empty-txt">'+t("buildBrandIdentity")+'</div>'+
          '</div>'+
          '<button class="dash-snap-setup" onclick="navigate(\'studio\');setTimeout(function(){switchStudioTab(\'brandcore\')},100)">'+t("setUp")+'</button>'+
        '</div>';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// AI ENGINE — modular, brand-aware, variant-rich
// ═══════════════════════════════════════════════════════════════

// ── Brand reader ──────────────────────────────────────────────
function getBrandContext(){
  var bc=S.brandCore;
  if(!bc) return {name:"ORIVEN",color:"#0A0A0A",accent:"#B7FF2A",tone:["Strategic"],wordsUse:["clarity","impact"],promise:"",industry:"",audience:""};
  return {
    name:bc.name,
    color:bc.colors&&bc.colors[0]?bc.colors[0].hex:"#0A0A0A",
    accent:bc.colors&&bc.colors[1]?bc.colors[1].hex:"#B7FF2A",
    support:bc.colors&&bc.colors[2]?bc.colors[2].hex:"#BFA07A",
    tone:bc.tone||["Strategic"],
    wordsUse:bc.wordsUse||[],
    wordsAvoid:bc.wordsAvoid||[],
    promise:bc.promise||"",
    audience:bc.audience||"",
    industry:bc.ind||""
  };
}

// ── Prompt parser ─────────────────────────────────────────────
function parsePrompt(raw){
  var p=raw.toLowerCase();
  var result={
    raw:raw,
    type:"copy",
    visual:false,
    keywords:[],
    adjectives:[],
    subject:""
  };
  // Detect output type
  if(/\b(poster|banner|visual|design|artwork|graphic)\b/.test(p)) { result.type="poster"; result.visual=true; }
  else if(/\b(instagram|ig post|social post|feed post|square post)\b/.test(p)) { result.type="instagram"; result.visual=true; }
  else if(/\b(story|stories|reel)\b/.test(p)) { result.type="story"; result.visual=true; }
  else if(/\b(ad creative|display ad|paid ad|banner ad)\b/.test(p)) { result.type="ad_visual"; result.visual=true; }
  else if(/\b(headline|title|header|subject line)\b/.test(p)) result.type="headline";
  else if(/\b(caption|instagram caption|social caption)\b/.test(p)) result.type="caption";
  else if(/\b(ad idea|ad concept|ad copy|ad headline)\b/.test(p)) result.type="ad_copy";
  else if(/\b(campaign|campaign idea|launch campaign)\b/.test(p)) result.type="campaign";
  else if(/\b(slogan|tagline|catchphrase)\b/.test(p)) result.type="tagline";
  else if(/\b(email|newsletter|subject)\b/.test(p)) result.type="email";
  else if(/\b(cta|call to action|button text)\b/.test(p)) result.type="cta";
  else if(/\b(copy|write|text|message|brand message|homepage)\b/.test(p)) result.type="copy";

  // Detect adjectives/tone modifiers
  var adjWords=["premium","luxury","bold","modern","minimal","playful","serious","professional","clean","elegant","powerful","innovative","friendly","futuristic","organic","loud","soft","warm","cold","dark","bright"];
  adjWords.forEach(function(a){ if(p.indexOf(a)>=0) result.adjectives.push(a); });

  // Detect subject/context
  var subjectMatches=p.match(/\b(product|feature|launch|release|brand|startup|app|saas|fitness|food|tech|fashion|agency|studio|event|sale|collection)\b/);
  if(subjectMatches) result.subject=subjectMatches[0];

  // Extract numbers (for "give me X headlines")
  var numMatch=p.match(/\b(\d+)\b/);
  result.count=numMatch?Math.min(parseInt(numMatch[1]),8):5;

  return result;
}

// ── Variation seeder (pseudo-random but stable per session) ───
var _seed=Date.now();
function seededRand(arr){
  _seed=(_seed*9301+49297)%233280;
  return arr[_seed%arr.length];
}
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function pickN(arr,n){
  var shuffled=arr.slice().sort(function(){return Math.random()-.5;});
  return shuffled.slice(0,Math.min(n,arr.length));
}

// ── Visual gradient builder ────────────────────────────────────
function buildGradient(parsed,bctx){
  var adj=parsed.adjectives;
  // Tone-aware gradient direction & darkness
  if(adj.indexOf("bright")>=0||adj.indexOf("warm")>=0)
    return "linear-gradient(135deg,"+bctx.accent+" 0%,"+bctx.support+" 100%)";
  if(adj.indexOf("minimal")>=0||adj.indexOf("clean")>=0)
    return "linear-gradient(160deg,"+bctx.color+" 0%,#000000 100%)";
  if(adj.indexOf("bold")>=0||adj.indexOf("powerful")>=0)
    return "linear-gradient(120deg,#0a0a0a 0%,"+bctx.color+" 100%)";
  if(adj.indexOf("luxury")>=0||adj.indexOf("premium")>=0)
    return "linear-gradient(145deg,#1a1208 0%,"+bctx.color+" 60%,"+bctx.accent+" 100%)";
  // Default: use brand color with dark depth
  var dirs=["135deg","150deg","160deg","120deg","175deg"];
  return "linear-gradient("+pick(dirs)+","+bctx.color+" 0%,#000000 100%)";
}

// ── Headline generator ─────────────────────────────────────────
var HEADLINE_PATTERNS=[
  function(bctx,_parsed){ return ["Your brand. "+pick(["Perfectly consistent.","Always on-message.","Exactly as intended."])+" Everywhere.", "One workspace. "+pick(["Your entire brand identity.","Every asset covered.","Complete brand control."]), pick(["Stop worrying about","End the guessing around","Never compromise on"])+" brand consistency.", "The brand "+pick(["brain","system","engine"])+" your team has been missing.", bctx.name+": "+pick(["Built for scale.","Made for ambitious teams.","Designed for growth."])]; },
  function(bctx,_parsed){ return [pick(["Clarity","Consistency","Control"])+" starts here.", "Build once. "+pick(["Apply everywhere.","Scale effortlessly.","Stay consistent."]), bctx.name+" gives your brand a "+pick(["memory","backbone","system"])+".", pick(["Premium","Professional","Systematic"])+" branding, "+pick(["without the chaos.","finally automated.","made simple."]), "Your "+pick(["identity","brand","vision"])+", "+pick(["protected.","amplified.","systematized."])]; },
  function(bctx,parsed){ var subj=parsed.subject||"brand"; return ["The "+pick(["smartest","fastest","cleanest"])+" way to manage your "+subj+".", pick(["Launch","Scale","Grow"])+" with a brand that "+pick(["works for you.","never slips.","stays sharp."]), "What if your "+subj+" was always "+pick(["consistent?","on-point?","perfectly expressed?"])+" It can be.", pick(["Forget","Stop","End"])+" brand inconsistency. "+pick(["Forever.","Seriously.","For good."]), bctx.promise||"One system. Total brand confidence."]; }
];
function generateHeadlines(bctx,parsed){
  var gen=pick(HEADLINE_PATTERNS);
  var lines=gen(bctx,parsed);
  // Inject subject awareness
  if(parsed.subject){
    lines=lines.map(function(l){ return l.replace(/brand/g,parsed.subject||"brand"); });
  }
  return pickN(lines,parsed.count||5);
}

// ── Copy generator ─────────────────────────────────────────────
var COPY_STRUCTURES=[
  function(bctx,parsed){
    var subj=parsed.subject||"brand";
    return {blocks:[
      {l:"Headline",t:pick(["Your "+subj+", always consistent — everywhere.","One "+subj+". Infinite assets.","The "+subj+" system built for scale."])},
      {l:"Sub-headline",t:bctx.name+" manages your full "+subj+" identity in one workspace. From colors and fonts to "+pick(["tone of voice","messaging","positioning"])+", every asset stays perfectly on-brand."},
      {l:"Body",t:pick(["Stop manually checking if every post matches your brand. ","Say goodbye to brand inconsistency. ","No more scattered assets or off-brand content. "])+bctx.name+" "+pick(["remembers your full identity and applies it automatically.","keeps your brand sharp across every channel.","ensures every asset reflects your true brand voice."])},
      {l:"CTA",t:pick(["Start building your Brand Core","Get started free","Try "+bctx.name+" today","Build your brand system"])}
    ]};
  },
  function(bctx,parsed){
    var adj=parsed.adjectives[0]||"premium";
    return {blocks:[
      {l:"Opening",t:"There's a difference between a brand that looks "+adj+" and one that "+pick(["consistently delivers it.","actually lives it.","means it across every touchpoint."])},
      {l:"Value Proposition",t:bctx.name+" is "+pick(["the","your","a"])+" brand intelligence system that "+pick(["stores, understands, and applies your identity everywhere.","ensures every asset reflects who you really are.","makes brand consistency effortless and automatic."])},
      {l:"Proof Point",t:pick(["From social media to ad campaigns,","Across every platform and channel,","Whether it's a poster or a headline,"])+" "+bctx.name+" ensures your "+pick(["voice","identity","brand"])+" stays "+pick(["sharp.","consistent.","unmistakably yours."])},
      {l:"CTA",t:pick(["Experience the difference. Start free.","Build your Brand Core today.","See what brand consistency feels like."])}
    ]};
  }
];
function generateCopy(bctx,parsed){
  var gen=pick(COPY_STRUCTURES);
  return gen(bctx,parsed);
}

// ── Caption generator ──────────────────────────────────────────
var CAPTION_POOLS=[
  ["Consistency isn't a nice-to-have. It's the thing that separates brands people trust from ones they forget. "+bctx_placeholder+" has one job: make sure your brand never slips.\n\n#branding #brandidentity #consistency","Every pixel, every word, every asset — your brand should feel like you. That's what "+bctx_placeholder+" is built for. One system. Total control.\n\n#brandstrategy #design #startup","Your brand is what people say about you when you're not in the room. Make sure it's always saying the right thing.\n\n#marketing #branddesign #growthmindset"],
  ["The brief was simple: make the brand feel like us on every platform. The result? "+bctx_placeholder+" — one workspace, infinite consistency.\n\n#brandcore #saas #buildinpublic","We used to spend hours checking if assets matched our brand guidelines. Now "+bctx_placeholder+" does it in seconds.\n\n#branding #productlaunch #design","Brand Check just saved us from posting something completely off-brand. This thing actually works.\n\n#brandcheck #marketingtools #consistency"]
];
var bctx_placeholder="[brand]";
function generateCaption(bctx,_parsed){
  var pool=pick(CAPTION_POOLS);
  var caption=pick(pool).replace(/\[brand\]/g,bctx.name);
  return {blocks:[{l:"Caption",t:caption},{l:"Hashtags",t:"#"+bctx.name.toLowerCase().replace(/\s+/g,"")+" #branding #brandidentity #"+pick(["startup","saas","design","marketing","growth"])}]};
}

// ── Ad ideas generator ─────────────────────────────────────────
var AD_IDEA_TEMPLATES=[
  function(bctx,_subj){ return [
    '"'+pick(["Stop guessing.","End the chaos.","No more off-brand assets."])+'" — Problem/solution ad targeting '+pick(["brand managers","founders","marketing teams"]),
    "Before/After: "+pick(["Scattered assets","Manual brand checks","Inconsistent visuals"])+" vs. "+bctx.name+" — visual comparison ad",
    '"'+pick(["Our team saved 4 hours a week","We stopped worrying about brand consistency","Every asset is now on-brand"])+' with '+bctx.name+'." — testimonial ad',
    "Feature spotlight: "+pick(["Brand Check","Brand Core","AI Chat"])+" — "+pick(["30-second demo video","animated carousel","interactive story ad"]),
    pick(["Launch special","Limited offer","Free trial"])+": Try "+bctx.name+" for free — "+pick(["acquisition","retargeting","awareness"])+" campaign"
  ]; },
  function(bctx,_subj){ return [
    '"Your brand deserves to look '+pick(["this good.","this consistent.","this intentional."])+'" — aspirational brand ad',
    "Social proof wall: 3 founders share how "+bctx.name+" changed their brand — LinkedIn carousel",
    "Product tour ad: 5 screens, 5 features, one system — "+pick(["Instagram Story","YouTube pre-roll","LinkedIn video"]),
    '"Finally, a brand system that '+pick(["thinks for you.","works across everything.","actually remembers your guidelines."])+'" — feature-led copy',
    "Comparison: "+bctx.name+" vs. "+pick(["a full design agency","manual brand guidelines","scattered Google Docs"])+" — cost/value ad"
  ]; }
];
function generateAdIdeas(bctx,parsed){
  var gen=pick(AD_IDEA_TEMPLATES);
  return gen(bctx,parsed.subject||"brand");
}

// ── Campaign ideas ─────────────────────────────────────────────
function generateCampaign(bctx,_parsed){
  var names=["Product Launch","Brand Awareness","Retargeting","Feature Spotlight","Seasonal Push"];
  var picks=pickN(names,3);
  var blocks=picks.map(function(name){
    var dur=pick(["2-week","3-week","4-week","6-week"]);
    var channels=pickN(["Instagram","LinkedIn","Email","Google Display","Twitter","YouTube"],3);
    var goal=pick(["awareness + trial signups","lead generation","conversion","engagement","brand recall"]);
    return {l:"Campaign — "+name,t:'"'+bctx.name+' '+name+'" — A '+dur+' campaign across '+channels.join(", ")+'. Goal: '+goal+'. Tone: '+bctx.tone.slice(0,2).join(" + ")+". Brand promise integrated: \""+bctx.promise+"\""};
  });
  return {blocks:blocks};
}

// ── Tagline/slogan ─────────────────────────────────────────────
function generateTaglines(bctx,_parsed){
  var opts=[
    bctx.name+". "+pick(["Your brand, always consistent.","Where brand identity meets intelligence.","Built for brands that mean it."]),
    pick(["One system.","One workspace.","One source of truth."])+" "+pick(["Total brand control.","Infinite consistency.","Your identity, everywhere."]),
    "Brand identity, "+pick(["systematized.","automated.","amplified."]),
    pick(["Think.","Know.","Own."])+" Your Brand.",
    "The "+pick(["smartest","only","last"])+" brand system you'll ever need."
  ];
  return opts;
}

// ── CTA generator ─────────────────────────────────────────────
function generateCTAs(bctx,_parsed){
  return [
    pick(["Start building","Build"])+" your Brand Core "+pick(["free","today","now"]),
    pick(["Try","See"])+" "+bctx.name+" in action",
    pick(["Get started","Start"])+" — no credit card",
    "Generate your first "+pick(["asset","post","headline"])+" free",
    pick(["Book a demo","Talk to us","See a walkthrough"])+" today"
  ];
}

// ── Email generator ────────────────────────────────────────────
function generateEmail(bctx,_parsed){
  return {blocks:[
    {l:"Subject Line",t:pick(["Introducing: ","Just launched: ","Big news: "])+bctx.name+" "+pick(["Brand Core","AI Chat","Brand Check"])+" — "+pick(["it changes everything","you're going to want this","your team needs to see this"])},
    {l:"Preview Text",t:pick(["Your brand will never look inconsistent again.","We just shipped something big.","The brand system your team has been asking for."])},
    {l:"Opening",t:"Hey [First Name],\n\n"+pick(["We've been building something for teams like yours.","A quick note about something that just launched.","This one's for anyone who's ever had an off-brand moment."])},
    {l:"Body",t:bctx.name+" now includes "+pick(["Brand Core","AI Chat","Brand Check"])+" — which means your team can "+pick(["generate brand-consistent content in seconds.","check any asset against your brand identity.","build a complete brand system with AI."])},
    {l:"CTA",t:"→ "+pick(["Try it free","Get started","See it in action"])}
  ]};
}

// ── Visual poster generator ────────────────────────────────────
var POSTER_HEADLINES=[
  ["Clarity starts here.","Built for teams that care.","One brand. Every channel."],
  ["Your vision, amplified.","Consistent. Always.","Brand identity, perfected."],
  ["Think in systems.","Built to scale.","Always on-brand."],
  ["Own your identity.","The brand brain you needed.","Nothing off-brand. Ever."]
];
var POSTER_SUBS=[
  "The brand identity system for ambitious teams.",
  "AI-powered brand consistency, built for scale.",
  "One workspace. Your entire brand identity.",
  "Stop worrying about brand consistency. Start owning it.",
  "Every asset. Every platform. Always you."
];
var POSTER_CTAS=["Get started","Build yours","Start free","See how","Explore"];
function generateVisual(bctx,parsed,type){
  var hl=pick(pick(POSTER_HEADLINES));
  var sub=pick(POSTER_SUBS);
  // Inject subject if present
  if(parsed.subject){
    var s=parsed.subject;
    hl=hl.replace("brand",s);
    sub=sub.replace("brand",s);
  }
  return {
    type:type||"poster",
    bg:buildGradient(parsed,bctx),
    brand:bctx.name,
    hl:hl,
    sub:sub,
    cta:pick(POSTER_CTAS),
    adjectives:parsed.adjectives
  };
}

// ── Instagram post ─────────────────────────────────────────────
var IG_HEADLINES=["Built for Growth.","Your Vision, Amplified.","Brand that scales.","Always on-brand.","Consistency is everything.","The brand brain you needed.","Own your identity.","Think in systems."];
var IG_BODIES=["Every asset. Every platform. Always on-brand.","Clarity. Consistency. Scale. The brand system built for teams that think big.","Stop guessing. Start generating. Your identity, systematized.","One workspace. Your entire brand. Always consistent.","Because your brand deserves to look this intentional."];
function generateIG(bctx,parsed){
  return {
    bg:buildGradient(parsed,bctx),
    brand:bctx.name,
    hl:pick(IG_HEADLINES),
    body:pick(IG_BODIES),
    cta:pick(["Learn more","Get started","Try free","See how"])
  };
}

// ── Master generate function ────────────────────────────────────
function generateResponse(promptText,outputTypeOverride){
  var parsed=parsePrompt(promptText);
  if(outputTypeOverride&&outputTypeOverride!=="auto") parsed.type=outputTypeOverride;
  var bctx=getBrandContext();

  var response={label:"",type:""};

  switch(parsed.type){
    case "poster":
    case "story":
    case "ad_visual":
      var vdata=generateVisual(bctx,parsed,parsed.type);
      response={label:parsed.type==="story"?"Brand Story":parsed.type==="ad_visual"?"Ad Creative":"Brand Poster",type:"visual",content:vdata};
      break;
    case "instagram":
      var igdata=generateIG(bctx,parsed);
      response={label:"Instagram Post",type:"ig",content:igdata};
      break;
    case "headline":
      response={label:"Headline Variations",type:"list",items:generateHeadlines(bctx,parsed)};
      break;
    case "caption":
      var capdata=generateCaption(bctx,parsed);
      response={label:"Instagram Caption",type:"copy",blocks:capdata.blocks};
      break;
    case "ad_copy":
      response={label:"Ad Ideas",type:"list",items:generateAdIdeas(bctx,parsed)};
      break;
    case "campaign":
      var campdata=generateCampaign(bctx,parsed);
      response={label:"Campaign Ideas",type:"copy",blocks:campdata.blocks};
      break;
    case "tagline":
      response={label:"Tagline Options",type:"list",items:generateTaglines(bctx,parsed)};
      break;
    case "cta":
      response={label:"CTA Options",type:"list",items:generateCTAs(bctx,parsed)};
      break;
    case "email":
      var emaildata=generateEmail(bctx,parsed);
      response={label:"Email Draft",type:"copy",blocks:emaildata.blocks};
      break;
    default:
      var copydata=generateCopy(bctx,parsed);
      response={label:"Brand Copy",type:"copy",blocks:copydata.blocks};
  }

  return response;
}

// ═══════════════════════════════════════════════════════════════
// AI CHAT
// ═══════════════════════════════════════════════════════════════
function initChat(){
  var feed=document.getElementById("chatFeed");
  if(!feed) return;
  if(S.chatHistory.length===0){
    feed.classList.add('feed-welcome');
    feed.innerHTML='<div class="chat-welcome"><div class="chat-welcome-icon"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M16 3L19 11H27L21 16L23 24L16 19.5L9 24L11 16L5 11H13Z"/></svg></div><h2>Brand Assistant</h2><p>Ask me anything about your brand. I can help you refine ideas, answer brand questions, and support your creative process.</p><div class="chat-suggestions"><div class="chat-sug" onclick="sendSuggestion(this)">How should I describe my brand voice?</div><div class="chat-sug" onclick="sendSuggestion(this)">What makes a strong brand identity?</div><div class="chat-sug" onclick="sendSuggestion(this)">Help me refine my brand positioning</div><div class="chat-sug" onclick="sendSuggestion(this)">Give me feedback on my brand strategy</div></div></div>';
  } else {
    renderChatHistory();
  }
}
function sendSuggestion(el){
  // Works for both assistant page and CWS workspace
  var cwsInp=document.getElementById("cwsInput");
  var chatInp=document.getElementById("chatInput");
  var pageCWS=document.getElementById("page-create-workspace");
  if(pageCWS&&pageCWS.classList.contains("active")&&cwsInp){
    cwsInp.value=el.textContent;
    sendCWS();
  } else if(chatInp){
    chatInp.value=el.textContent;
    sendChat();
  }
}
function sendChat(){
  var input=document.getElementById("chatInput");
  if(!input) return;
  var prompt=input.value.trim();
  if(!prompt) return;
  input.value="";
  // Auto-resize textarea back to 1 row
  input.style.height="auto";
  S.chatHistory.push({role:"user",text:prompt});
  renderChatHistory();
  var feed=document.getElementById("chatFeed");
  var typingId="typing-"+Date.now();
  var typingDiv=document.createElement("div");
  typingDiv.id=typingId;
  typingDiv.className="chat-msg ai";
  typingDiv.innerHTML='<div class="chat-ai-avatar"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2L12.5 7.5H18L13.5 11L15 16.5L10 13.5L5 16.5L6.5 11L2 7.5H7.5Z"/></svg></div><div class="chat-bubble ai-bubble"><div class="chat-typing"><span></span><span></span><span></span></div></div>';
  feed.appendChild(typingDiv);
  feed.scrollTop=feed.scrollHeight;
  // Vary response delay slightly for authenticity
  var delay=900+Math.floor(Math.random()*800);
  setTimeout(function(){
    var outTypeEl=document.getElementById("chatOutType");
    var outputType=outTypeEl?outTypeEl.value:"auto";
    var response=generateResponse(prompt,outputType);
    S.chatHistory.push({role:"ai",text:prompt,response:response});
    var typingEl=document.getElementById(typingId);
    if(typingEl) typingEl.remove();
    appendAIMessage(response,feed);
    feed.scrollTop=feed.scrollHeight;
  },delay);
}
function renderChatHistory(){
  var feed=document.getElementById("chatFeed");
  if(!feed) return;
  feed.classList.remove('feed-welcome');
  feed.innerHTML="";
  S.chatHistory.forEach(function(msg){
    if(msg.role==="user"){
      var div=document.createElement("div");
      div.className="chat-msg user";
      div.innerHTML='<div class="chat-bubble user-bubble">'+msg.text+"</div>";
      feed.appendChild(div);
    } else if(msg.role==="ai"&&msg.response){
      appendAIMessage(msg.response,feed);
    }
  });
  feed.scrollTop=feed.scrollHeight;
}
function renderResultHTML(response){
  var inner="";
  if(response.type==="visual"){
    var d=response.content;
    inner+='<div class="chat-visual" style="background:'+d.bg+'">';
    inner+='<div class="cv-brand">'+d.brand+"</div>";
    inner+='<div class="cv-hl">'+d.hl+"</div>";
    inner+='<div class="cv-sub">'+d.sub+"</div>";
    inner+='<div class="cv-cta">'+d.cta+"</div></div>";
  } else if(response.type==="ig"){
    var d=response.content;
    inner+='<div class="chat-ig" style="background:'+d.bg+'">';
    inner+='<div class="cig-top"><div class="cig-dot">'+d.brand.charAt(0)+"</div>";
    inner+='<div class="cig-name">'+d.brand+"</div></div>";
    inner+='<div class="cig-hl">'+d.hl+"</div>";
    inner+='<div class="cig-body">'+d.body+"</div>";
    inner+='<button class="cig-cta">'+d.cta+"</button></div>";
  } else if(response.type==="list"){
    inner+='<div class="chat-list">';
    response.items.forEach(function(item,i){
      inner+='<div class="chat-list-item"><span class="chat-list-num">'+(i+1)+"</span><span>"+item+"</span></div>";
    });
    inner+="</div>";
  } else if(response.type==="copy"){
    inner+='<div class="chat-copy">';
    response.blocks.forEach(function(b){
      inner+='<div class="chat-copy-block"><div class="chat-copy-label">'+b.l+"</div>";
      inner+='<div class="chat-copy-text">'+b.t+"</div></div>";
    });
    inner+="</div>";
  }
  return inner;
}
function appendAIMessage(response,feed){
  var div=document.createElement("div");
  div.className="chat-msg ai";
  var inner='<div class="chat-ai-avatar"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 2L12.5 7.5H18L13.5 11L15 16.5L10 13.5L5 16.5L6.5 11L2 7.5H7.5Z"/></svg></div>';
  inner+='<div class="chat-bubble ai-bubble"><div class="chat-result-label">'+response.label+"</div>";
  inner+=renderResultHTML(response);
  inner+='<div class="chat-actions"><button class="btn btn-sm btn-g" onclick="saveFromChat(this)">Save to Studio</button></div>';
  inner+="</div></div>";
  div.innerHTML=inner;
  feed.appendChild(div);
}
function saveFromChat(btn){
  S.assets.push({id:Date.now(),type:"chat",name:"AI output #"+(S.assets.length+1),category:"copy",brandColor:getBrandContext().color,brandName:getBrandContext().name,createdAt:new Date().toLocaleTimeString()});
  toast("Saved to Studio");
  btn.textContent="Saved!";
  btn.disabled=true;
}
// Auto-resize textarea
document.addEventListener("DOMContentLoaded",function(){
  var ci=document.getElementById("chatInput");
  if(ci){
    ci.addEventListener("keydown",function(e){
      if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendChat();}
    });
    ci.addEventListener("input",function(){
      this.style.height="auto";
      this.style.height=Math.min(this.scrollHeight,120)+"px";
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// BRAND CORE (shared — used by sidebar page AND studio tab)
// ═══════════════════════════════════════════════════════════════
function refreshBC(){
  var bc=S.brandCore;
  // Sidebar BC page
  var bcEmpty=document.getElementById("bcEmpty");
  var bcContent=document.getElementById("bcContent");
  if(bcEmpty) bcEmpty.classList.toggle("hidden",!!bc);
  if(bcContent) bcContent.classList.toggle("hidden",!bc);
  // Studio BC tab
  var stBCEmpty=document.getElementById("stBCEmpty");
  var stBCContent=document.getElementById("stBCContent");
  if(stBCEmpty) stBCEmpty.classList.toggle("hidden",!!bc);
  if(stBCContent) stBCContent.classList.toggle("hidden",!bc);
  // Studio info panel
  updateStudioBCPanel();
  if(!bc) return;
  renderColors("colorSwatches");
  renderColors("stColorSwatches");
  renderTypo("typoList");
  renderTypo("stTypoList");
  renderLogos("logoGrid");
  renderLogos("stLogoGrid");
  renderTone("toneTags","wordsUse","wordsAvoid");
  renderTone("stToneTags","stWordsUse","stWordsAvoid");
  renderPos("posGrid");
  renderPos("stPosGrid");
  var wdn=document.getElementById("wsNameDisp");
  if(wdn){ wdn.textContent=bc.name; document.getElementById("wsDot").textContent=bc.name.charAt(0).toUpperCase(); }
  refreshDash();
}
function updateStudioBCPanel(){
  var bc=S.brandCore;
  var el=document.getElementById("studioBC");
  if(!el) return;
  if(!bc){
    el.innerHTML='<div style="font-size:12px;color:var(--muted)">No Brand Core configured. <span onclick="navigate(\'brandcore\')" style="cursor:pointer;color:var(--gm);font-weight:500">Set it up</span></div>';
    return;
  }
  var swatches=bc.colors.slice(0,4).map(function(col){
    return '<div class="si-swatch" style="background:'+col.hex+'" title="'+col.name+'"></div>';
  }).join("");
  el.innerHTML='<div class="si-bc-block"><div class="si-bc-name">'+bc.name+'</div><div class="si-bc-meta">'+bc.tone.slice(0,2).join(" · ")+'</div><div class="si-colors">'+swatches+"</div></div>";
}
function renderColors(containerId){
  var el=document.getElementById(containerId);
  if(!el) return;
  var html="";
  S.brandCore.colors.forEach(function(col,i){
    html+='<div class="sw-card" onclick="editColor('+i+')">';
    html+='<div class="sw-blk" style="background:'+col.hex+'"></div>';
    html+='<div class="sw-name">'+col.name+"</div>";
    html+='<div class="sw-hex">'+col.hex+"</div></div>";
  });
  el.innerHTML=html;
}
function renderTypo(containerId){
  var el=document.getElementById(containerId);
  if(!el) return;
  var html="";
  S.brandCore.fonts.forEach(function(f){
    html+='<div class="frow"><div class="f-ptxt">';
    html+='<div class="f-role">'+f.role+"</div>";
    html+='<div class="f-demo">'+f.family+"</div>";
    html+='<div class="f-meta">'+f.usage+"</div>";
    html+="</div></div>";
  });
  el.innerHTML=html;
}
function renderLogos(containerId){
  var el=document.getElementById(containerId);
  if(!el) return;
  var bc=S.brandCore;
  var logos=bc.logos||{};
  var SLOTS=[
    {key:"primary",   label:"Primary Logo",  hint:"Light backgrounds"},
    {key:"secondary", label:"Secondary",      hint:"Dark backgrounds"},
    {key:"icon",      label:"Icon / Mark",    hint:"Compact use"}
  ];
  var html="";
  SLOTS.forEach(function(slot){
    var logo=logos[slot.key];
    html+='<div class="logo-mgmt-card">';
    if(logo&&logo.url){
      html+='<div class="lmc-preview"><img src="'+logo.url+'" alt="'+slot.label+'" class="lmc-img"></div>';
    } else {
      html+='<div class="lmc-empty" onclick="uploadLogo(\''+slot.key+'\')">'
        +'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><path d="M10 13V3M6 7l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14v1a2 2 0 002 2h10a2 2 0 002-2v-1" opacity=".5" stroke-linecap="round"/></svg>'
        +'<span>Upload</span></div>';
    }
    html+='<div class="lmc-footer">';
    html+='<span class="lmc-lbl">'+slot.label+'</span>';
    html+='<div class="lmc-actions">';
    if(logo&&logo.url){
      html+='<button class="btn btn-g btn-sm" onclick="uploadLogo(\''+slot.key+'\')">Replace</button>';
      html+='<button class="lmc-remove-btn" onclick="removeLogo(\''+slot.key+'\')" title="Remove">&#10005;</button>';
    } else {
      html+='<button class="btn btn-g btn-sm" onclick="uploadLogo(\''+slot.key+'\')">Upload</button>';
    }
    html+='</div></div></div>';
  });
  el.innerHTML=html;
}

// ── Upload logo via file picker ────────────────────────────────
function uploadLogo(category){
  var input=document.createElement("input");
  input.type="file";
  input.accept="image/png,image/jpeg,image/svg+xml,image/webp";
  input.onchange=function(e){
    var file=e.target.files[0];
    if(!file) return;
    if(file.size>4*1024*1024){toast("Image must be under 4 MB","warn");return;}
    var reader=new FileReader();
    reader.onload=function(ev){
      if(!S.brandCore.logos) S.brandCore.logos={};
      S.brandCore.logos[category]={url:ev.target.result,source:"upload"};
      renderLogos("logoGrid");
      renderLogos("stLogoGrid");
      if(typeof saveBCToDB==="function") saveBCToDB();
      toast("Logo saved");
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ── Remove logo ────────────────────────────────────────────────
function removeLogo(category){
  if(!S.brandCore||!S.brandCore.logos) return;
  S.brandCore.logos[category]=null;
  renderLogos("logoGrid");
  renderLogos("stLogoGrid");
  if(typeof saveBCToDB==="function") saveBCToDB();
  toast("Logo removed");
}

// ── Open AI Logo modal ─────────────────────────────────────────
function openLogoAIModal(){
  if(!S.brandCore){toast("Set up your Brand Core first","warn");return;}
  S._aiLogoResult=null;
  var resultArea=document.getElementById("logoAIResult");
  if(resultArea){resultArea.style.display="none";resultArea.innerHTML="";}
  var btn=document.getElementById("logoAIGenBtn");
  if(btn){btn.disabled=false;btn.textContent="Generate Logo";}
  var nameInp=document.getElementById("logoAIBrand");
  if(nameInp) nameInp.value=S.brandCore.name||"";
  var colorInp=document.getElementById("logoAIColors");
  if(colorInp){
    var cs=(S.brandCore.colors||[]).map(function(c){return (c.name||"")+" "+(c.hex||"");}).join(", ").trim();
    colorInp.value=cs||"";
  }
  // reset pills
  document.querySelectorAll("#logoAIStylePills .b-pill").forEach(function(p,i){p.classList.toggle("active",i===0);});
  document.querySelectorAll("#logoAIDirPills .b-pill").forEach(function(p,i){p.classList.toggle("active",i===0);});
  var desc=document.getElementById("logoAIDesc");
  if(desc) desc.value="";
  openModal("modal-logo-ai");
}

// ── Pick pill inside a modal (not builder state) ───────────────
function bPickModal(btn,groupId){
  var group=document.getElementById(groupId);
  if(!group) return;
  group.querySelectorAll(".b-pill").forEach(function(p){p.classList.remove("active");});
  btn.classList.add("active");
}

// ── Generate AI logo ───────────────────────────────────────────
async function generateAILogo(){
  var brandName=(document.getElementById("logoAIBrand")||{}).value||(S.brandCore&&S.brandCore.name)||"";
  if(!brandName){toast("Enter a brand name","warn");return;}
  var description=(document.getElementById("logoAIDesc")||{}).value||"";
  var activeSP=document.querySelector("#logoAIStylePills .b-pill.active");
  var logoStyle=activeSP?activeSP.dataset.val:"minimal icon";
  var activeDP=document.querySelector("#logoAIDirPills .b-pill.active");
  var styleDirection=activeDP?activeDP.dataset.val:"minimal clean";
  var colorPalette=(document.getElementById("logoAIColors")||{}).value||"";

  var btn=document.getElementById("logoAIGenBtn");
  if(btn){btn.disabled=true;btn.innerHTML='<div class="builder-loading-dots" style="display:inline-flex;gap:5px"><span></span><span></span><span></span></div> Generating\u2026';}
  var resultArea=document.getElementById("logoAIResult");
  if(resultArea){
    resultArea.style.display="";
    resultArea.innerHTML='<div class="builder-loading" style="padding:28px 0"><div class="builder-loading-dots"><span></span><span></span><span></span></div><span class="builder-loading-msg">Building your logo concept\u2026</span></div>';
  }

  try {
    var res=await fetch(API_BASE_URL+"/api/generate-logo",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({brandName:brandName,description:description,logoStyle:logoStyle,styleDirection:styleDirection,colorPalette:colorPalette})
    });
    var data=await res.json();
    if(data.error){
      toast(data.error,"warn");
      if(resultArea) resultArea.innerHTML='<div class="builder-error">'+_escHtml(data.error)+'</div>';
      return;
    }
    S._aiLogoResult=data.imageUrl;
    if(resultArea){
      resultArea.innerHTML=
        '<div class="logo-ai-result">'
        +'<img src="'+data.imageUrl+'" alt="Generated logo" class="logo-ai-img">'
        +'<div class="logo-ai-save-row">'
        +'<span class="logo-ai-save-lbl">Save as:</span>'
        +'<button class="btn btn-g btn-sm" onclick="saveAILogoTo(\'primary\')">Primary Logo</button>'
        +'<button class="btn btn-g btn-sm" onclick="saveAILogoTo(\'secondary\')">Secondary</button>'
        +'<button class="btn btn-g btn-sm" onclick="saveAILogoTo(\'icon\')">Icon</button>'
        +'</div></div>';
    }
  } catch(e){
    toast("Could not connect to ORIVEN services. Please try again.","warn");
    if(resultArea) resultArea.innerHTML='<div class="builder-error">Could not connect to ORIVEN services. Please try again.</div>';
  } finally {
    if(btn){btn.disabled=false;btn.textContent="Generate Logo";}
  }
}

// ── Save AI logo to a specific slot ───────────────────────────
function saveAILogoTo(category){
  if(!S._aiLogoResult){toast("No logo to save","warn");return;}
  if(!S.brandCore.logos) S.brandCore.logos={};
  S.brandCore.logos[category]={url:S._aiLogoResult,source:"ai"};
  renderLogos("logoGrid");
  renderLogos("stLogoGrid");
  if(typeof saveBCToDB==="function") saveBCToDB();
  var labels={primary:"Primary Logo",secondary:"Secondary Logo",icon:"Icon"};
  toast("Saved as "+(labels[category]||category));
  closeModal("modal-logo-ai");
}
function renderTone(tagsId,useId,avoidId){
  var bc=S.brandCore;
  var te=document.getElementById(tagsId);
  var ue=document.getElementById(useId);
  var ae=document.getElementById(avoidId);
  if(te) te.innerHTML=bc.tone.map(function(t){return '<span class="tag">'+t+"</span>";}).join("");
  if(ue) ue.innerHTML=bc.wordsUse.map(function(w){return '<span class="tag">'+w+"</span>";}).join("");
  if(ae) ae.innerHTML=bc.wordsAvoid.map(function(w){return '<span class="tag tag-r">'+w+"</span>";}).join("");
}
function renderPos(containerId){
  var el=document.getElementById(containerId);
  if(!el) return;
  var bc=S.brandCore;
  var items=[{l:"Brand Promise",v:bc.promise},{l:"Target Audience",v:bc.audience},{l:"Differentiator",v:bc.diff}];
  el.innerHTML=items.map(function(x){
    return '<div style="background:var(--bg2);border-radius:var(--rl);padding:16px"><div class="sec-lbl" style="margin-bottom:8px">'+x.l+'</div><div style="font-size:13px;color:var(--charcoal);line-height:1.6">'+(x.v||"—")+"</div></div>";
  }).join("");
}
function buildBC(name,ind,tone,aud,desc){
  return{
    name:name,ind:ind,tone:tone,aud:aud,desc:desc,
    logos:{},
    colors:[
      {hex:"#B7FF2A",name:"Neon Green",role:"Primary"},
      {hex:"#9FE81F",name:"Lime",role:"Accent"},
      {hex:"#BFA07A",name:"Warm Sand",role:"Support"},
      {hex:"#F6F3EE",name:"Off-White",role:"Background"},
      {hex:"#18181A",name:"Charcoal",role:"Text"}
    ],
    fonts:[
      {role:"Display / Headings",family:"Instrument Serif",usage:"Hero text, titles, brand voice"},
      {role:"Body / Interface",family:"Geist",usage:"Body copy, UI labels, navigation"}
    ],
    wordsUse:["clarity","transform","scale","impact"],
    wordsAvoid:["disruption","synergy","leverage"],
    promise:desc||name+" helps teams build brands as powerful as their vision.",
    audience:aud||"Growth-stage founders and marketing teams",
    diff:"The leading "+(ind||"brand")+" platform built for scale."
  };
}
function runGenBrand(){
  var name=document.getElementById("gbName").value.trim();
  if(!name){toast("Enter a brand name","warn");return;}
  var gbType=document.getElementById("gbType");
  var gbInd=document.getElementById("gbInd");
  var gbDesc=document.getElementById("gbDesc");
  var gbAud=document.getElementById("gbAud");
  var gbColorMood=document.getElementById("gbColorMood");
  var gbBrandStyle=document.getElementById("gbBrandStyle");
  var tags=[].slice.call(document.querySelectorAll("#gbTags .fb.active")).map(function(e){return e.textContent;});
  var payload={
    brandName:name,
    type:gbType?gbType.value:"",
    industry:gbInd?gbInd.value:"",
    description:gbDesc?gbDesc.value:"",
    targetAudience:gbAud?gbAud.value:"",
    colorMood:gbColorMood?gbColorMood.value:"",
    brandStyle:gbBrandStyle?gbBrandStyle.value:"",
    personality:tags.join(", ")
  };
  closeModal("modal-genbrand");
  var glov=document.getElementById("glov");
  glov.classList.add("open");
  var msgs=["Analyzing personality inputs...","Generating color palette...","Selecting typography...","Building tone of voice...","Finalizing Brand Brain..."];
  var mi=0;
  var iv=setInterval(function(){
    if(mi<msgs.length) document.getElementById("glovStatus").textContent=msgs[mi++];
  },900);
  fetch(API_BASE_URL+"/api/generate-brandcore",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  })
  .then(function(res){return res.json();})
  .then(function(data){
    clearInterval(iv);
    glov.classList.remove("open");
    if(data.error){toast(data.error,"warn");return;}
    var vi=data.visualIdentity||{};
    var bc_=data.brandCore||{};
    var bs=data.brandStrategy||{};
    var lc=data.logoConcept||{};
    var toneArr=(bs.toneOfVoice||"Strategic, Premium").split(/[,;\/]/).map(function(s){return s.trim();}).filter(Boolean);
    var prevLogos=(S.brandCore&&S.brandCore.logos)||{};
    S.brandCore={
      name:data.brandName||name,
      ind:payload.industry,
      tone:toneArr,
      aud:bs.targetAudience||payload.targetAudience,
      desc:payload.description,
      logos:prevLogos,
      colors:[
        {hex:vi.primaryColor||"#B7FF2A",name:"Primary",role:"Primary"},
        {hex:vi.secondaryColor||"#9FE81F",name:"Secondary",role:"Accent"},
        {hex:vi.accentColor||"#BFA07A",name:"Accent",role:"Support"},
        {hex:"#F6F3EE",name:"Background",role:"Background"},
        {hex:"#18181A",name:"Text",role:"Text"}
      ],
      fonts:[
        {role:"Display / Headings",family:vi.headingFont||"Instrument Serif",usage:"Hero text, titles, brand voice"},
        {role:"Body / Interface",family:vi.bodyFont||"Inter",usage:"Body copy, UI labels, navigation"}
      ],
      wordsUse:Array.isArray(bc_.values)&&bc_.values.length?bc_.values:["clarity","impact"],
      wordsAvoid:["generic","average","mediocre"],
      promise:bc_.brandPromise||name+" helps you build and grow.",
      audience:bs.targetAudience||payload.targetAudience||"Your target audience",
      diff:bs.positioning||"Unique in your space.",
      mission:bc_.mission||"",
      vision:bc_.vision||"",
      personality:bs.brandPersonality||"",
      styleDirection:vi.styleDirection||"",
      colorMood:vi.colorMood||"",
      logoConcept:lc
    };
    refreshBC();
    toast("Brand Core created!");
    saveBCToDB();
    if(typeof maybeShowPaywall==="function") maybeShowPaywall();
    // Guide tour: advance from step 1 → 2 when BrandCore is first created
    if(typeof gtAdvance==="function") gtAdvance(1);
  })
  .catch(function(err){
    clearInterval(iv);
    glov.classList.remove("open");
    console.error("[BrandCore] Error:",err);
    toast("Could not connect to ORIVEN services. Please try again.","warn");
  });
}
function saveBCManual(){
  var name=document.getElementById("bcsName").value.trim();
  if(!name){toast("Enter a brand name","warn");return;}
  var prevLogos=(S.brandCore&&S.brandCore.logos)||{};
  S.brandCore={
    name:name,tone:["Strategic","Premium"],
    logos:prevLogos,
    colors:[{hex:document.getElementById("bcsPrimary").value||"#B7FF2A",name:"Primary",role:"Primary"}],
    fonts:[
      {role:"Heading",family:document.getElementById("bcsHead").value||"Instrument Serif",usage:"Headlines"},
      {role:"Body",family:document.getElementById("bcsBody").value||"Geist",usage:"Body text"}
    ],
    wordsUse:["clarity","impact"],wordsAvoid:["synergy"],
    promise:document.getElementById("bcsPromise").value||name+" helps you build and grow.",
    audience:"Your target audience",diff:"Unique in your space."
  };
  closeModal("modal-bcsetup"); refreshBC();
  toast("Brand Core saved!");
  saveBCToDB();
  if(typeof maybeShowPaywall==="function") maybeShowPaywall();
}
function openAddColorModal(){
  document.getElementById("colorModalTtl").textContent="Add Brand Color";
  document.getElementById("colorHex").value="";
  document.getElementById("colorName").value="";
  document.getElementById("colorPrev").style.background="#B7FF2A";
  S._editCI=null; openModal("modal-addcolor");
}
function editColor(i){
  var col=S.brandCore.colors[i];
  document.getElementById("colorModalTtl").textContent="Edit Color";
  document.getElementById("colorHex").value=col.hex;
  document.getElementById("colorName").value=col.name;
  document.getElementById("colorPrev").style.background=col.hex;
  S._editCI=i; openModal("modal-addcolor");
}
function updateColorPrev(v){if(/^#[0-9A-Fa-f]{6}$/.test(v)) document.getElementById("colorPrev").style.background=v;}
function saveColor(){
  var hex=document.getElementById("colorHex").value.trim();
  var name=document.getElementById("colorName").value.trim();
  var role=document.getElementById("colorRole").value;
  if(!/^#[0-9A-Fa-f]{6}$/.test(hex)){toast("Enter a valid hex color","warn");return;}
  if(!name){toast("Enter a color name","warn");return;}
  if(S._editCI!==null&&S._editCI!==undefined) S.brandCore.colors[S._editCI]={hex:hex,name:name,role:role};
  else S.brandCore.colors.push({hex:hex,name:name,role:role});
  closeModal("modal-addcolor");
  renderColors("colorSwatches");
  renderColors("stColorSwatches");
  updateStudioBCPanel();
  toast("Color saved!");
}

// ═══════════════════════════════════════════════════════════════
// STUDIO
// ═══════════════════════════════════════════════════════════════
