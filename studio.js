// ═══ STUDIO ═══════════════════════════════════════════════════

function refreshStudio(){
  renderAssets();
  updateStudioBCPanel();
  resetCheckPanel();
  _studioRefreshMain();
  var sisc=document.getElementById("siSavedCount");
  if(sisc) sisc.textContent=S.assets.length+" asset"+(S.assets.length===1?"":"s");
}

function _studioRefreshMain(){
  var intel=(typeof _dashComputeIntel==="function")?_dashComputeIntel():null;
  if(!intel) return;

  var bc=S.brandCore;

  // ── Toggle empty vs profile ────────────────────────────────────
  var emptyEl   = document.getElementById("stBCEmpty2");
  var profileEl = document.getElementById("bcProfileContent");
  if(emptyEl)   emptyEl.style.display   = bc ? "none" : "";
  if(profileEl) profileEl.style.display = bc ? ""     : "none";

  // Eyebrow dot
  var dot=document.getElementById("stEyebrowDot");
  if(dot) dot.className="bcp-eyebrow-dot"+(bc?" active":"");

  // Score display
  var scoreLbl = document.getElementById("stLevelBadge");
  var scoreFill= document.getElementById("stIlFill");
  var scoreMsg = document.getElementById("stIlMsg");
  if(scoreLbl)  scoreLbl.textContent = intel.pct+"%";
  if(scoreFill) setTimeout(function(){ scoreFill.style.width=intel.pct+"%"; },80);
  if(scoreMsg)  scoreMsg.textContent = intel.msg;

  // Quick access count
  var qa=document.getElementById("stQaAssets");
  var ac=(S.assets||[]).length;
  if(qa) qa.textContent=ac+" item"+(ac===1?"":"s");

  if(!bc) return;

  // ── Section 1: Brand name + tagline ───────────────────────────
  var nameEl    = document.getElementById("bcProfileName");
  var taglineEl = document.getElementById("bcProfileTagline");
  if(nameEl)    nameEl.textContent    = bc.name    || "";
  if(taglineEl) taglineEl.textContent = bc.tagline || "";

  // ── Section 2: Color System ────────────────────────────────────
  _bcRenderColors();

  // ── Section 3: Typography ──────────────────────────────────────
  _bcRenderTypo();

  // ── Section 4: Personality chips ──────────────────────────────
  _bcRenderPersonality();

  // ── Section 5: Tone of Voice ───────────────────────────────────
  _bcRenderTone();

  // ── Section 6: Positioning ────────────────────────────────────
  _bcRenderPositioning();

  // ── Section 7: Target Audience ────────────────────────────────
  _bcRenderAudience();

  // ── Section 8: Visual Direction ───────────────────────────────
  _bcRenderVisual();

  // ── Section 9: Logo System ────────────────────────────────────
  _bcRenderLogos();

  // ── Moodboard ─────────────────────────────────────────────────
  _bcRenderMoodboard();
}

// ── Color System ───────────────────────────────────────────────
function _bcRenderColors(){
  var el=document.getElementById("bcProfileColors");
  if(!el) return;
  var bc=S.brandCore;
  if(!bc||(bc.colors||[]).length===0){
    el.innerHTML='<div class="bcp-empty-field">No colors configured</div>';
    return;
  }
  // Show up to 5 fixed colors (Primary, Secondary, Accent 1, Accent 2, Text) — no add slot
  el.innerHTML=(bc.colors||[]).slice(0,5).map(function(c,i){
    var luma=_hexLuma(c.hex);
    var txtCol=luma>0.5?"#0A0A0A":"#F0F0F0";
    return '<div class="bcp-color-chip" onclick="bcpEditColor('+i+')" title="Click to edit">'
      +'<div class="bcp-color-swatch" style="background:'+c.hex+'">'
      +'<span class="bcp-color-hex" style="color:'+txtCol+'">'+c.hex+'</span>'
      +'</div>'
      +'<div class="bcp-color-meta">'
      +'<div class="bcp-color-role">'+c.name+'</div>'
      +(c.explanation?'<div class="bcp-color-exp">'+c.explanation+'</div>':'')
      +'</div>'
      +'</div>';
  }).join("");
}

function _hexLuma(hex){
  try{
    var r=parseInt(hex.slice(1,3),16)/255;
    var g=parseInt(hex.slice(3,5),16)/255;
    var b=parseInt(hex.slice(5,7),16)/255;
    return 0.2126*r+0.7152*g+0.0722*b;
  }catch(_){ return 0; }
}

// ── Typography ─────────────────────────────────────────────────
function _bcRenderTypo(){
  var el=document.getElementById("bcProfileTypo");
  if(!el) return;
  var bc=S.brandCore;
  if(!bc||(bc.fonts||[]).length===0){
    el.innerHTML='<div class="bcp-empty-field">No typography configured</div>';
    return;
  }
  el.innerHTML=(bc.fonts||[]).slice(0,2).map(function(f){
    var isHeading=f.role&&f.role.toLowerCase().indexOf("head")>=0;
    var sample=isHeading?"Your Brand. Defined.":"Every word, every line, on-brand.";
    return '<div class="bcp-typo-card">'
      +'<div class="bcp-typo-role">'+f.role+'</div>'
      +'<div class="bcp-typo-sample" style="font-family:\''+f.family+'\',serif,sans-serif">'+sample+'</div>'
      +'<div class="bcp-typo-name">'+f.family+'</div>'
      +(f.explanation?'<div class="bcp-typo-reason">'+f.explanation+'</div>':'')
      +'</div>';
  }).join("");
}

// ── Brand Personality chips ────────────────────────────────────
function _bcRenderPersonality(){
  var el=document.getElementById("bcProfilePersonality");
  if(!el) return;
  var bc=S.brandCore;
  var pers=Array.isArray(bc.personality)?bc.personality:(bc.tone||[]);
  if(!pers.length){
    el.innerHTML='<div class="bcp-empty-field">No personality defined</div>';
    return;
  }
  el.innerHTML=pers.slice(0,4).map(function(k,i){
    var accents=["bcp-chip-a","bcp-chip-b","bcp-chip-c","bcp-chip-d"];
    return '<span class="bcp-chip '+accents[i%4]+'">'+k+'</span>';
  }).join("");
}

// ── Tone of Voice ──────────────────────────────────────────────
function _bcRenderTone(){
  var el=document.getElementById("bcProfileTone");
  if(!el) return;
  var bc=S.brandCore;
  var tov=bc.toneOfVoice||(bc.tone&&bc.tone.join(", "))||"";
  el.innerHTML=tov
    ?'<div class="bcp-quote">&ldquo;'+tov+'&rdquo;</div>'
    :'<div class="bcp-empty-field">Tone of voice not defined</div>';
}

// ── Positioning ────────────────────────────────────────────────
function _bcRenderPositioning(){
  var el=document.getElementById("bcProfilePositioning");
  if(!el) return;
  var bc=S.brandCore;
  var pos=bc.positioning||bc.promise||bc.diff||"";
  el.innerHTML=pos
    ?'<div class="bcp-statement">'+pos+'</div>'
    :'<div class="bcp-empty-field">Positioning not defined</div>';
}

// ── Target Audience ────────────────────────────────────────────
function _bcRenderAudience(){
  var el=document.getElementById("bcProfileAudience");
  if(!el) return;
  var bc=S.brandCore;
  var aud=bc.audience||bc.aud||"";
  el.innerHTML=aud
    ?'<div class="bcp-audience-text">'+aud+'</div>'
    :'<div class="bcp-empty-field">Target audience not defined</div>';
}

// ── Visual Direction ───────────────────────────────────────────
function _bcRenderVisual(){
  var el=document.getElementById("bcProfileVisual");
  if(!el) return;
  var bc=S.brandCore;
  var vd=bc.visualDirection||bc.styleDirection||"";
  el.innerHTML=vd
    ?'<div class="bcp-visual-desc">'+vd+'</div>'
    :'<div class="bcp-empty-field">Visual direction not defined</div>';
}

// ── Logo System ────────────────────────────────────────────────
function _bcRenderLogos(){
  var el=document.getElementById("bcProfileLogos");
  if(!el) return;
  var bc=S.brandCore;
  var logos=bc.logos||{};
  var SLOTS=[
    {key:"primary",   label:"Primary Logo",   hint:"Main brand mark for light backgrounds"},
    {key:"secondary", label:"Secondary Logo",  hint:"Variant for dark backgrounds"},
    {key:"icon",      label:"Brand Mark",      hint:"Compact icon for small placements"}
  ];
  // Never inject ORIVEN placeholders — show clean empty state if no real logos
  var hasAnyLogo=SLOTS.some(function(s){ return logos[s.key]&&logos[s.key].url&&logos[s.key].source!=="placeholder"; });

  if(!hasAnyLogo&&!logos.description){
    el.innerHTML='<div class="bcp-logo-empty">'
      +'<div class="bcp-logo-empty-msg">No logo generated yet</div>'
      +'<div class="bcp-logo-empty-sub">Generate a logo system with AI, or upload your own assets.</div>'
      +'<div class="bcp-logo-empty-actions">'
      +'<button class="bcp-action-btn bcp-action-btn-primary" onclick="openLogoAIModal()">Generate with AI</button>'
      +'<button class="bcp-action-btn" onclick="uploadLogo(\'primary\')">Upload Logo</button>'
      +'</div></div>';
    return;
  }

  el.innerHTML=SLOTS.map(function(slot){
    var logo=logos[slot.key];
    var hasLogo=logo&&logo.url&&logo.source!=="placeholder";
    return '<div class="bcp-logo-slot">'
      +(hasLogo
        ?'<div class="bcp-logo-preview" onclick="uploadLogo(\''+slot.key+'\')"><img src="'+logo.url+'" alt="'+slot.label+'" class="bcp-logo-img"><div class="bcp-logo-overlay">Replace</div></div>'
        :'<div class="bcp-logo-upload" onclick="uploadLogo(\''+slot.key+'\')"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" width="22" height="22"><path d="M10 13V3M6 7l4-4 4 4M3 16v1a1 1 0 001 1h12a1 1 0 001-1v-1" stroke-linecap="round"/></svg><span>Upload</span></div>'
      )
      +'<div class="bcp-logo-footer">'
      +'<div class="bcp-logo-name">'+slot.label+'</div>'
      +'<div class="bcp-logo-hint">'+slot.hint+'</div>'
      +(hasLogo?'<button class="bcp-logo-remove" onclick="removeLogo(\''+slot.key+'\')">Remove</button>':'')
      +'</div>'
      +'</div>';
  }).join("")
  +(logos.description?'<div class="bcp-logo-desc-block"><div class="bcp-logo-desc-lbl">Logo Description</div><div class="bcp-logo-desc-txt">'+logos.description+'</div></div>':'');
}

// ── Moodboard / Visual References ─────────────────────────────
function _bcRenderMoodboard(){
  var el=document.getElementById("bcMoodGrid");
  if(!el) return;
  var bc=S.brandCore;
  var refs=(bc.visualReferences||[]);
  if(!refs.length){ el.innerHTML=""; return; }
  el.innerHTML=refs.map(function(r,i){
    return '<div class="bcp-mood-item">'
      +'<img src="'+r.url+'" alt="Visual reference" class="bcp-mood-img">'
      +'<button class="bcp-mood-remove" onclick="bcRemoveVisualRef('+i+')" title="Remove">✕</button>'
      +'</div>';
  }).join("");
}

function _studioRenderBCGrid(){
  // Legacy function — new profile rendering is handled by _studioRefreshMain.
  // Kept to avoid JS errors from any external callers.
  var bc=S.brandCore;
  var grid=document.getElementById("stBCGrid");
  if(!grid) return;
  if(!bc){ grid.innerHTML=""; return; }

  // Profile rendering is now handled by _studioRefreshMain → individual _bcRender* functions.
}

function switchStudioTab(name){
  document.querySelectorAll(".studio-panel").forEach(function(p){p.classList.remove("active");});
  var panelEl=document.getElementById("tab-"+name);
  if(panelEl) panelEl.classList.add("active");

  var hub=document.getElementById("studioHubView");
  var pv=document.getElementById("studioPanelView");
  var titleEl=document.getElementById("studioPanelTitle");
  var titles={saved:"Saved",brandcore:"Brand Core",check:"Brand Check"};
  if(titleEl) titleEl.textContent=titles[name]||name;

  if(hub){
    hub.style.transition="opacity 0.22s ease";
    hub.style.opacity="0";
    setTimeout(function(){
      hub.style.display="none";
      hub.style.opacity="";
      hub.style.transition="";
      if(pv) pv.classList.remove("hidden");
    }, 220);
  } else {
    if(pv) pv.classList.remove("hidden");
  }

  if(name==="saved") renderAssets();
  if(name==="brandcore") refreshBC();
  if(name==="check") setTimeout(function(){ startBrandCheck(); }, 200);
}

function showStudioHub(){
  var hub=document.getElementById("studioHubView");
  var pv=document.getElementById("studioPanelView");
  if(pv) pv.classList.add("hidden");
  if(hub){
    hub.style.display="";
    hub.style.opacity="0";
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        hub.style.transition="opacity 0.3s ease";
        hub.style.opacity="1";
        setTimeout(function(){hub.style.opacity="";hub.style.transition="";},320);
      });
    });
  }
}

function _bbHover(node, active){
  var line=document.getElementById("bb-line-"+node);
  if(line) line.classList.toggle("bb-line-active",active);
}

// ═══ SAVED ════════════════════════════════════════════════════

function renderAssets(){
  var grid=document.getElementById("assetGrid");
  var empty=document.getElementById("assetEmpty");
  var badge=document.getElementById("savedCount");
  if(badge) badge.textContent=S.assets.length+" item"+(S.assets.length===1?"":"s");
  var sisc=document.getElementById("siSavedCount");
  if(sisc) sisc.textContent=S.assets.length+" asset"+(S.assets.length===1?"":"s");
  if(!S.assets.length){
    if(grid) grid.innerHTML="";
    if(empty) empty.classList.remove("hidden");
    return;
  }
  if(empty) empty.classList.add("hidden");
  if(!grid) return;
  var html="";
  S.assets.forEach(function(a){
    var isCopy=a.category==="copy";
    var bg=a.brandColor||"#B7FF2A";
    var thumb=isCopy
      ?'<div style="font-size:11px;font-weight:600;color:var(--c2)">Copy</div>'
      :'<div style="width:48px;height:48px;border-radius:10px;background:'+bg+';display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff">'+(a.brandName||"A").charAt(0)+"</div>";
    html+='<div class="acard">';
    html+='<div class="ath"'+(isCopy?' style="background:var(--bg3)"':' style="background:linear-gradient(135deg,'+bg+'22,'+bg+'44)"')+">"+thumb+"</div>";
    html+='<div class="ameta"><div class="a-name">'+a.name+'</div><div class="a-info">'+a.category+" · "+(a.createdAt||"")+"</div></div>";
    html+='<div class="aov">';
    html+='<button class="aov-btn" onclick="openRename('+a.id+')" title="Rename"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12h10M10.5 2.5a1.5 1.5 0 0 1 2.1 2.1L4.5 12.7l-3 .8.8-3L10.5 2.5z"/></svg></button>';
    html+='<button class="aov-btn" onclick="toast(\'Exported\')" title="Export"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1v9M4 7l3 3 3-3M2 12h10"/></svg></button>';
    html+='<button class="aov-btn" onclick="addAssetToCampaign('+a.id+')" title="Use in campaign" style="background:rgba(183,255,42,0.3)"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7h8M7 3v8"/></svg></button>';
    html+='<button class="aov-btn" onclick="delAsset('+a.id+')" title="Delete" style="background:rgba(239,68,68,.3)"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h10M5 4V2h4v2M11 4l-1 8H4L3 4"/></svg></button>';
    html+="</div></div>";
  });
  grid.innerHTML=html;
}

function addAssetToCampaign(id){
  if(!S.campaigns.length){
    toast("Create a campaign first","warn");
    return;
  }
  // Add to most recent campaign
  var camp=S.campaigns[S.campaigns.length-1];
  if(!camp.assets) camp.assets=[];
  if(camp.assets.indexOf(id)<0){
    camp.assets.push(id);
    toast("Added to \""+camp.name+"\"");
  } else {
    toast("Already in \""+camp.name+"\"","warn");
  }
}

function delAsset(id){
  S.assets=S.assets.filter(function(a){return a.id!==id;});
  toast("Asset deleted"); renderAssets();
}
function openRename(id){
  S.renameId=id;
  var a=S.assets.find(function(x){return x.id===id;});
  document.getElementById("renameInp").value=a?a.name:"";
  openModal("modal-rename");
}
function doRename(){
  var n=document.getElementById("renameInp").value.trim();
  if(!n) return;
  var a=S.assets.find(function(x){return x.id===S.renameId;});
  if(a){a.name=n; toast("Renamed");}
  closeModal("modal-rename"); renderAssets();
}

// ═══ BRAND CHECK ══════════════════════════════════════════════

var _BC_STEPS = [
  { key:"colors",      label:"Analyzing Color System"     },
  { key:"typo",        label:"Analyzing Typography"        },
  { key:"personality", label:"Analyzing Brand Personality" },
  { key:"tone",        label:"Analyzing Tone of Voice"     },
  { key:"positioning", label:"Analyzing Positioning"       },
  { key:"audience",    label:"Analyzing Target Audience"   },
  { key:"visual",      label:"Analyzing Visual Direction"  },
  { key:"logo",        label:"Analyzing Logo"              }
];

var _bcAnimDone = false;
var _bcApiData  = null;
var _bcRunning  = false;

function _onBcBothDone(){
  if(!_bcAnimDone || !_bcApiData) return;
  _bcRunning = false;
  var analyzing = document.getElementById("ckAnalyzing");
  if(analyzing) analyzing.classList.add("hidden");
  if(_bcApiData.error){
    toast(_bcApiData.error,"warn");
    var idle = document.getElementById("ckIdle");
    if(idle) idle.classList.remove("hidden");
    return;
  }
  S.lastScore = _bcApiData.score;
  S._lastBrandCheckData = _bcApiData;
  showCheckResult(_bcApiData);
}

function _renderBcSteps(){
  var stepsEl = document.getElementById("ckSteps");
  if(!stepsEl) return;
  var bc = S.brandCore;
  var hasLogo = bc && (bc.logoConcept || (bc.logos && bc.logos.length));
  stepsEl.innerHTML = "";
  _BC_STEPS.forEach(function(step){
    if(step.key === "logo" && !hasLogo) return;
    var div = document.createElement("div");
    div.className = "bc-step";
    div.id = "bcStep-" + step.key;
    div.innerHTML =
      '<div class="bc-step-icon" id="bcStepIco-'+step.key+'"><div class="bc-step-spinner"></div></div>' +
      '<span class="bc-step-lbl">'+step.label+'</span>' +
      '<div class="bc-step-ck hidden" id="bcStepCk-'+step.key+'">' +
        '<svg viewBox="0 0 10 10" fill="none" stroke="#B7FF2A" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.5l2 2 4-4"/></svg>' +
      '</div>';
    stepsEl.appendChild(div);
  });
}

function _animateBcSteps(){
  var bc = S.brandCore;
  var hasLogo = bc && (bc.logoConcept || (bc.logos && bc.logos.length));
  var steps = _BC_STEPS.filter(function(s){ return s.key !== "logo" || hasLogo; });
  var i = 0;
  function next(){
    if(i >= steps.length){
      var sub = document.getElementById("ckAnalyzeSub");
      if(sub) sub.textContent = "Finalizing report…";
      _bcAnimDone = true;
      _onBcBothDone();
      return;
    }
    var step = steps[i];
    var stepEl = document.getElementById("bcStep-"+step.key);
    if(stepEl) stepEl.classList.add("bc-step-active");
    setTimeout(function(){
      var ckEl  = document.getElementById("bcStepCk-"+step.key);
      var icoEl = document.getElementById("bcStepIco-"+step.key);
      if(icoEl) icoEl.style.display = "none";
      if(ckEl)  ckEl.classList.remove("hidden");
      if(stepEl){ stepEl.classList.remove("bc-step-active"); stepEl.classList.add("bc-step-done"); }
      i++;
      setTimeout(next, 100);
    }, 600);
  }
  next();
}

function startBrandCheck(force){
  var bc = S.brandCore;
  if(!bc){ return; }
  if(_bcRunning) return;
  if(!force && S._lastBrandCheckData){
    showCheckResult(S._lastBrandCheckData);
    return;
  }
  _bcAnimDone = false;
  _bcApiData  = null;
  _bcRunning  = true;

  var idle      = document.getElementById("ckIdle");
  var analyzing = document.getElementById("ckAnalyzing");
  var score     = document.getElementById("ckScore");
  if(idle)      idle.classList.add("hidden");
  if(score)     score.classList.add("hidden");
  if(analyzing){ analyzing.classList.remove("hidden"); _renderBcSteps(); }

  _animateBcSteps();

  var toneArr = bc.tone ? (Array.isArray(bc.tone) ? bc.tone : [bc.tone]) : [];
  var wordsArr = Array.isArray(bc.wordsUse) ? bc.wordsUse : [];
  var avoidArr = Array.isArray(bc.wordsAvoid) ? bc.wordsAvoid : [];
  var valuesStr = wordsArr.join(", ") + (avoidArr.length ? " (avoid: "+avoidArr.join(", ")+")" : "");
  var payload = {
    brandName:      bc.name,
    tagline:        bc.tagline     || bc.promise || "",
    colors:         bc.colors      ? bc.colors.map(function(c){ return c.hex+" ("+c.name+")"; }) : [],
    fonts:          bc.fonts       ? bc.fonts.map(function(f){ return f.role+": "+f.family; })   : [],
    brandPromise:   bc.promise     || "",
    description:    bc.desc        || "",
    targetAudience: bc.audience    || bc.aud || "",
    styleDirection: bc.styleDirection || bc.style || "",
    colorMood:      bc.colorMood   || "",
    mission:        bc.mission     || "",
    vision:         bc.vision      || "",
    personality:    bc.personality || (Array.isArray(bc.traits) ? bc.traits.join(", ") : ""),
    toneOfVoice:    toneArr.join(", "),
    values:         valuesStr,
    positioning:    bc.diff        || bc.positioning || "",
    logoConcept:    bc.logoConcept ? bc.logoConcept.description : ""
  };

  fetch(API_BASE_URL+"/api/brand-check",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    _bcApiData = data;
    _onBcBothDone();
  })
  .catch(function(err){
    console.error("[BrandCheck]",err);
    _bcApiData = { error:"Could not connect to ORIVEN services. Please try again." };
    _onBcBothDone();
  });
}

function resetCheck(){
  S._lastBrandCheckData = null;
  _bcRunning  = false;
  _bcAnimDone = false;
  _bcApiData  = null;
  var idle      = document.getElementById("ckIdle");
  var analyzing = document.getElementById("ckAnalyzing");
  var score     = document.getElementById("ckScore");
  if(analyzing) analyzing.classList.add("hidden");
  if(score)     score.classList.add("hidden");
  if(idle)      idle.classList.remove("hidden");
}

function _ucFirst(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : ""; }

function showCheckResult(data){
  var card = document.getElementById("ckScore");
  if(!card) return;
  card.classList.remove("hidden");
  var score  = data.score || 0;
  var scoreColor = score>=85 ? "#B7FF2A" : score>=70 ? "#F59E0B" : "#EF4444";
  var levelLabel = score>=90 ? "Excellent" : score>=80 ? "Strong" : score>=70 ? "Good" : score>=55 ? "Developing" : "Needs Attention";

  var html = '<div class="bc-score-block">';
  html += '<div class="bc-score-ring" style="border-color:'+scoreColor+';box-shadow:0 0 32px '+scoreColor+'26">';
  html +=   '<div class="bc-score-num" style="color:'+scoreColor+'">'+score+'<span>%</span></div>';
  html +=   '<div class="bc-score-lbl">Brand Score</div>';
  html += '</div>';
  html += '<div class="bc-score-meta">';
  html +=   '<div class="bc-score-level" style="color:'+scoreColor+'">'+levelLabel+'</div>';
  html +=   '<div class="bc-score-level-sub">'+(data.professionalLevel ? _ucFirst(data.professionalLevel)+' level brand identity' : 'Brand Intelligence Report')+'</div>';
  html +=   '<button class="btn btn-g btn-sm bc-reanalyze-btn" onclick="startBrandCheck(true)">↺ Re-analyze</button>';
  html += '</div>';
  html += '</div>';

  var strengths = data.strengths || [];
  if(strengths.length){
    html += '<div class="bc-section">';
    html +=   '<div class="bc-section-hd"><div class="bc-section-dot bc-dot-str"></div>Strengths</div>';
    strengths.forEach(function(s){
      html += '<div class="bc-item">' +
        '<svg viewBox="0 0 10 10" fill="none" stroke="#B7FF2A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="10" height="10" style="flex-shrink:0;margin-top:3px"><path d="M2 5.5l2 2 4-4"/></svg>' +
        '<span>'+s+'</span></div>';
    });
    html += '</div>';
  }

  var opps = data.opportunities || [];
  if(!opps.length)(data.weaknesses||[]).concat(data.improvements||[]).forEach(function(x){ opps.push(x); });
  if(opps.length){
    html += '<div class="bc-section">';
    html +=   '<div class="bc-section-hd"><div class="bc-section-dot bc-dot-opp"></div>Opportunities</div>';
    opps.forEach(function(o){
      html += '<div class="bc-item">' +
        '<svg viewBox="0 0 10 10" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="10" height="10" style="flex-shrink:0;margin-top:3px"><path d="M5 2v4M5 8v.5"/></svg>' +
        '<span>'+o+'</span></div>';
    });
    html += '</div>';
  }

  var recs = data.recommendations || [];
  if(recs.length){
    html += '<div class="bc-section">';
    html +=   '<div class="bc-section-hd"><div class="bc-section-dot bc-dot-rec"></div>Strategic Recommendations</div>';
    recs.forEach(function(r, i){
      html += '<div class="bc-item bc-rec-item">' +
        '<span class="bc-rec-num">'+(i+1)+'</span>' +
        '<span>'+r+'</span></div>';
    });
    html += '</div>';
  }

  if(data.summary){
    html += '<div class="bc-summary">'+data.summary+'</div>';
  }

  card.innerHTML = html;
}

// ═══ CAMPAIGNS ════════════════════════════════════════════════

function renderCampaigns(){
  var list=document.getElementById("campList");
  var empty=document.getElementById("campEmpty");
  // Close any open detail view first
  var detail=document.getElementById("campDetail");
  if(detail) detail.classList.add("hidden");
  var main=document.getElementById("campMain");
  if(main) main.classList.remove("hidden");

  if(!S.campaigns.length){
    if(list) list.innerHTML="";
    if(empty) empty.classList.remove("hidden");
    return;
  }
  if(empty) empty.classList.add("hidden");
  if(!list) return;
  var html="";
  S.campaigns.forEach(function(camp){
    var assetCount=(camp.assets||[]).length;
    var prog=camp.prog||10;
    html+='<div class="camp-card" onclick="openCampaignDetail('+camp.id+')">';
    html+='<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px">';
    html+='<div class="camp-name">'+camp.name+"</div>";
    html+='<span class="badge bg-grey" style="font-size:10px">'+assetCount+" asset"+(assetCount===1?"":"s")+"</span></div>";
    html+='<div class="camp-meta">'+camp.obj+" · "+camp.aud+"</div>";
    html+='<div class="camp-pb"><div class="camp-pf" style="width:'+prog+'%"></div></div></div>';
  });
  list.innerHTML=html;
}

function createCampaign(){
  var name=document.getElementById("ncName").value.trim();
  if(!name){toast("Enter a campaign name","warn");return;}
  // Collect selected asset IDs from the modal picker
  var selectedAssets=[];
  document.querySelectorAll(".nc-asset-pick.selected").forEach(function(el){
    selectedAssets.push(parseInt(el.getAttribute("data-id")));
  });
  var camp={
    id:Date.now(),
    name:name,
    obj:document.getElementById("ncObj").value,
    aud:document.getElementById("ncAud").value,
    notes:document.getElementById("ncNotes").value,
    assets:selectedAssets,
    prog:selectedAssets.length?40:10,
    createdAt:new Date().toLocaleDateString()
  };
  S.campaigns.push(camp);
  closeModal("modal-newcamp");
  document.getElementById("ncName").value="";
  document.getElementById("ncNotes").value="";
  toast("Campaign created");
  renderCampaigns();
}

function openCampaignDetail(id){
  var camp=S.campaigns.find(function(c){return c.id===id;});
  if(!camp) return;
  S._activeCampId=id;
  var main=document.getElementById("campMain");
  var detail=document.getElementById("campDetail");
  if(main) main.classList.add("hidden");
  if(detail){
    detail.classList.remove("hidden");
    renderCampaignDetail(camp);
  }
}

function renderCampaignDetail(camp){
  var el=document.getElementById("campDetail");
  if(!el) return;
  var linkedAssets=S.assets.filter(function(a){return (camp.assets||[]).indexOf(a.id)>=0;});

  var html='<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">';
  html+='<button class="btn btn-g btn-sm" onclick="closeCampaignDetail()">← Back</button>';
  html+='<div style="font-size:16px;font-weight:700;color:var(--charcoal)">'+camp.name+"</div></div>";

  // Info grid
  html+='<div class="camp-detail-grid">';
  html+='<div class="camp-detail-card"><div class="camp-detail-label">Objective</div><div class="camp-detail-val">'+camp.obj+"</div></div>";
  html+='<div class="camp-detail-card"><div class="camp-detail-label">Audience</div><div class="camp-detail-val">'+(camp.aud||"—")+"</div></div>";
  if(camp.notes) html+='<div class="camp-detail-card" style="grid-column:span 2"><div class="camp-detail-label">Notes</div><div class="camp-detail-val">'+camp.notes+"</div></div>";
  html+="</div>";

  // Linked assets
  html+='<div style="margin:20px 0 10px;font-size:13px;font-weight:600;color:var(--charcoal)">Linked Assets <span style="color:var(--muted);font-weight:400;font-size:12px">('+linkedAssets.length+")</span></div>";
  if(linkedAssets.length){
    html+='<div class="camp-asset-row">';
    linkedAssets.forEach(function(a){
      var bg=a.brandColor||"#B7FF2A";
      html+='<div class="camp-asset-thumb" style="background:linear-gradient(135deg,'+bg+'33,'+bg+'66)">';
      html+='<span style="font-size:16px;font-weight:700;color:'+bg+'">'+( a.brandName||"A").charAt(0)+"</span></div>";
    });
    html+="</div>";
  } else {
    html+='<div style="font-size:12px;color:var(--muted);margin-bottom:16px">No assets linked yet.</div>';
  }

  // Preview formats
  html+='<div style="margin:20px 0 12px;font-size:13px;font-weight:600;color:var(--charcoal)">Preview Formats</div>';
  html+='<div class="camp-preview-grid">';
  var bc=S.brandCore;
  var col=bc?bc.colors[0].hex:"#B7FF2A";
  var bn=bc?bc.name:"ORIVEN";
  [
    {label:"Square Post",w:1,h:1,tag:"1080 × 1080"},
    {label:"Landscape Banner",w:1.78,h:1,tag:"1920 × 1080"},
    {label:"Portrait",w:0.8,h:1,tag:"1080 × 1350"},
    {label:"Story",w:0.56,h:1,tag:"1080 × 1920"}
  ].forEach(function(fmt){
    var pw=140; var ph=Math.round(pw/fmt.w);
    if(ph>180) ph=180;
    html+='<div class="camp-preview-item">';
    html+='<div class="camp-preview-frame" style="width:'+pw+'px;height:'+ph+'px;background:linear-gradient(135deg,'+col+' 0%,#000000 100%);border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer" onclick="generatePreview(\''+fmt.label+'\')">';
    html+='<div style="font-size:9px;color:rgba(255,255,255,.5);letter-spacing:1px;text-transform:uppercase">'+bn+"</div>";
    html+='<div style="font-size:'+(pw>100?12:10)+'px;font-weight:700;color:#fff;text-align:center;padding:0 8px;line-height:1.2">'+camp.name+"</div>";
    html+='<div style="font-size:8px;color:rgba(255,255,255,.35);margin-top:2px">'+fmt.tag+"</div></div>";
    html+='<div style="font-size:11px;color:var(--c2);font-weight:500;margin-top:6px;text-align:center">'+fmt.label+"</div></div>";
  });
  html+="</div>";

  // Actions
  html+='<div class="camp-detail-actions">';
  html+='<button class="btn btn-g" onclick="editCampaign('+camp.id+')">Edit Campaign</button>';
  html+='<button class="btn btn-g" onclick="changeCampaignImages('+camp.id+')">Change Images</button>';
  html+='<button class="btn btn-p" onclick="generatePreview(\'Poster\')">Generate Poster Preview</button>';
  html+="</div>";

  el.innerHTML=html;
}

function closeCampaignDetail(){
  var detail=document.getElementById("campDetail");
  var main=document.getElementById("campMain");
  if(detail) detail.classList.add("hidden");
  if(main) main.classList.remove("hidden");
  S._activeCampId=null;
}

function generatePreview(fmt){
  toast("Generating "+fmt+" preview...");
  setTimeout(function(){toast(fmt+" preview ready!");},1400);
}

function editCampaign(id){
  var camp=S.campaigns.find(function(c){return c.id===id;});
  if(!camp) return;
  // Pre-fill modal
  document.getElementById("ncName").value=camp.name;
  document.getElementById("ncObj").value=camp.obj||"Product Launch";
  document.getElementById("ncAud").value=camp.aud||"";
  document.getElementById("ncNotes").value=camp.notes||"";
  S._editCampId=id;
  openCampaignModal();
}

function changeCampaignImages(id){
  S._editCampId=id;
  openCampaignModal();
  toast("Select new images from your saved assets");
}

function openCampaignModal(){
  // Populate asset picker
  renderAssetPicker();
  openModal("modal-newcamp");
}

function renderAssetPicker(){
  var picker=document.getElementById("ncAssetPicker");
  if(!picker) return;
  if(!S.assets.length){
    picker.innerHTML='<div style="font-size:12px;color:var(--muted)">No saved assets yet. Generate content in AI Chat first.</div>';
    return;
  }
  var currentCampAssets=[];
  if(S._editCampId){
    var ec=S.campaigns.find(function(c){return c.id===S._editCampId;});
    if(ec) currentCampAssets=ec.assets||[];
  }
  var html="";
  S.assets.forEach(function(a){
    var sel=currentCampAssets.indexOf(a.id)>=0;
    var bg=a.brandColor||"#B7FF2A";
    html+='<div class="nc-asset-pick'+(sel?" selected":"")+'" data-id="'+a.id+'" onclick="toggleAssetPick(this)">';
    html+='<div style="width:32px;height:32px;border-radius:7px;background:'+bg+';display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0">'+(a.brandName||"A").charAt(0)+"</div>";
    html+='<div style="overflow:hidden"><div style="font-size:12px;font-weight:500;color:var(--charcoal);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+a.name+"</div>";
    html+='<div style="font-size:11px;color:var(--muted)">'+a.category+"</div></div>";
    if(sel) html+='<div style="margin-left:auto;color:var(--gm)"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M2 7l4 4 6-7"/></svg></div>';
    html+="</div>";
  });
  picker.innerHTML=html;
}

function toggleAssetPick(el){
  el.classList.toggle("selected");
  // Show/hide check icon
  var check=el.querySelector("svg");
  if(el.classList.contains("selected")){
    if(!check){
      el.insertAdjacentHTML("beforeend",'<div style="margin-left:auto;color:var(--gm)"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M2 7l4 4 6-7"/></svg></div>');
    }
  } else {
    var chkDiv=el.querySelector('[style*="margin-left:auto"]');
    if(chkDiv) chkDiv.remove();
  }
}



// ═══════════════════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════════════════
var TEMPLATES=[
  {id:1,name:"Instagram Launch Post",type:"Instagram 1080x1080",cat:"social",bg:"#0A0A0A"},
  {id:2,name:"Story Announcement",type:"Instagram Story",cat:"social",bg:"#0A0A0A"},
  {id:3,name:"Website Hero",type:"Web Section",cat:"web",bg:"var(--bg3)"},
  {id:4,name:"Testimonial Graphic",type:"Social Various",cat:"social",bg:"var(--charcoal)"},
  {id:5,name:"Founder Quote",type:"LinkedIn 1200x627",cat:"social",bg:"#2A1F14"},
  {id:6,name:"Product Reveal",type:"Instagram 1080x1080",cat:"social",bg:"#0A0A0A"},
  {id:7,name:"Ad Banner",type:"Display 728x90",cat:"ads",bg:"var(--green)"},
  {id:8,name:"Email Header",type:"Email 600x200",cat:"email",bg:"var(--bg2)"},
  {id:9,name:"Product Description",type:"Ecommerce Copy",cat:"copy",bg:"var(--sf2)"},
  {id:10,name:"Headline Variants",type:"Multi-use Copy",cat:"copy",bg:"var(--gpale)"},
  {id:11,name:"CTA Bundle",type:"Web and Email Copy",cat:"copy",bg:"#F6F3EE"},
  {id:12,name:"Carousel Series",type:"Instagram Carousel",cat:"social",bg:"#0A0A0A"}
];
var tplFilter="all";

// ═══ INSPIRATION ══════════════════════════════════════════════

var INSP_CARDS=[
  {id:1,cat:"social",title:"Minimal Product Launch",desc:"Clean whitespace, centered type, one hero visual.",type:"image",prompt:"Create a minimal Instagram post for a premium product launch. Clean layout, strong typography.",tall:false,wide:false,style:"dark",bg:"#0A0A0A",bg2:"#000000",lbl:"LAUNCH",hl:"Something beautiful arrives.",sub:"01.03.2025"},
  {id:2,cat:"social",title:"Bold Brand Story",desc:"High-contrast storytelling for Instagram feed.",type:"image",prompt:"Create a bold high-contrast Instagram post about our brand journey and founding vision.",tall:true,wide:false,style:"dark",bg:"#18181A",bg2:"#2C2C2E",lbl:"STORY",hl:"This is how we build.",sub:"Chapter 1"},
  {id:3,cat:"social",title:"Feature Spotlight",desc:"Highlight a single product feature in a carousel-ready frame.",type:"image",prompt:"Create an Instagram carousel post spotlighting a key product feature with clean visual design.",tall:false,wide:true,style:"dark",bg:"#0A0A0A",bg2:"#000000",lbl:"NEW",hl:"Feature Release",sub:"Swipe to explore"},
  {id:4,cat:"social",title:"Testimonial Quote Card",desc:"Premium quote layout for social proof content.",type:"image",prompt:"Create a premium testimonial quote card for social media with strong typography and brand feel.",tall:false,wide:false,style:"light",bg:"#FAF8F5",bg2:"#EEE9E1",lbl:"TESTIMONIAL",hl:"The most consistent brand system.",sub:"Sarah K., Head of Brand"},
  {id:5,cat:"ads",title:"Bold Product Ad",desc:"Strong headline, clear CTA, brand-forward layout.",type:"ads",prompt:"Create a bold display ad creative for a product launch with a strong headline and clear CTA.",tall:false,wide:false,style:"dark",bg:"#1A1A2E",bg2:"#16213E",lbl:"AD",hl:"Stop guessing. Start building.",cta:"Try free"},
  {id:6,cat:"ads",title:"Retargeting Hook Ad",desc:"Conversational tone, problem-aware copy.",type:"ads",prompt:"Create a retargeting ad with a conversational hook that addresses a brand consistency problem.",tall:false,wide:true,style:"dark",bg:"#2D1B69",bg2:"#1A0A3D",lbl:"RETARGET",hl:"Still struggling with consistency?",sub:"You are not alone."},
  {id:7,cat:"ads",title:"Social Proof Ad",desc:"Metric-driven ad with strong credibility signals.",type:"ads",prompt:"Create a social proof ad featuring brand metrics and a clear value proposition.",tall:true,wide:false,style:"light",bg:"#F6F3EE",bg2:"#EEE9E1",lbl:"SOCIAL PROOF",metric:"500+",metricSub:"brands trust us",cta:"Start free"},
  {id:8,cat:"poster",title:"Minimal Launch Poster",desc:"Premium typography, generous whitespace, editorial feel.",type:"image",prompt:"Create a minimal premium brand poster for a product launch with editorial typography.",tall:true,wide:false,style:"light",bg:"#F6F3EE",bg2:"#EEE9E1",lbl:"BRAND",hl:"The Art of Consistency.",sub:"2025"},
  {id:9,cat:"poster",title:"Dark Premium Poster",desc:"Rich dark background, gold and accent details.",type:"image",prompt:"Create a dark premium brand poster with strong visual contrast and a luxury editorial feel.",tall:false,wide:false,style:"dark",bg:"#0A0A0A",bg2:"#1A1208",lbl:"PREMIUM",hl:"Quality is not an afterthought.",sub:"Limited Collection"},
  {id:10,cat:"poster",title:"Event Announcement",desc:"Date-forward layout for launches and events.",type:"image",prompt:"Create a premium event announcement poster with strong date typography and brand identity.",tall:false,wide:true,style:"dark",bg:"#0A0A0A",bg2:"#000000",bigNum:"03",bigSub:"MARCH",hl:"Brand Summit",sub:"Annual Brand Strategy Event"},
  {id:11,cat:"campaign",title:"Product Launch Series",desc:"Three-phase campaign: teaser, reveal, conversion.",type:"campaign",prompt:"Create a 3-phase product launch campaign with teaser, reveal, and conversion content.",tall:false,wide:true,style:"dark",bg:"#0A0A0A",bg2:"#111111",lbl:"PHASE 1",hl:"Launch Campaign",sub:"Teaser - Reveal - Convert"},
  {id:12,cat:"campaign",title:"Brand Awareness Push",desc:"Educational content series to build brand recognition.",type:"campaign",prompt:"Create a brand awareness campaign with educational posts and consistent visual language.",tall:false,wide:false,style:"dark",bg:"#2D1B69",bg2:"#1A0A3D",lbl:"AWARENESS",hl:"Make them remember you.",sub:"5-post LinkedIn series"},
  {id:13,cat:"campaign",title:"Seasonal Drop",desc:"Limited-time urgency campaign for seasonal moments.",type:"campaign",prompt:"Create a seasonal brand campaign for a limited product drop with urgency and premium visual language.",tall:true,wide:false,style:"dark",bg:"#7F1D1D",bg2:"#991B1B",lbl:"LIMITED",hl:"Season Drop.",sub:"Only this week"},
  {id:14,cat:"identity",title:"Monochrome Color System",desc:"Minimal tonal palette built for clarity and premium feel.",type:"image",prompt:"Create a minimal brand color system with tonal variations and usage guidelines.",tall:false,wide:false,style:"light",bg:"#F6F3EE",bg2:"#EEE9E1",palette:true},
  {id:15,cat:"identity",title:"Serif Typographic Brand",desc:"Editorial serif heading style with clean body pairing.",type:"image",prompt:"Create a brand typography system with an editorial serif display font and clean body pairing.",tall:false,wide:true,style:"dark",bg:"#18181A",bg2:"#2C2C2E",typo:true},
  {id:16,cat:"identity",title:"Bold Logo Direction",desc:"Symbol-driven logo mark with strong geometric form.",type:"image",prompt:"Create a bold logo direction for a brand with a geometric symbol mark and strong visual identity.",tall:true,wide:false,style:"dark",bg:"#0A0A0A",bg2:"#000000",logomark:true},
  {id:17,cat:"content",title:"Behind the Brand Story",desc:"Authentic founder or team narrative content.",type:"text",prompt:"Write a behind-the-brand story post about the founding vision and what drives the team.",tall:false,wide:false,style:"light",bg:"#FFF8E1",bg2:"#FFF3CD",lbl:"BEHIND THE BRAND",hl:"Why we built this.",sub:"Read the story"},
  {id:18,cat:"content",title:"Value Proposition Carousel",desc:"5-slide LinkedIn carousel breaking down the core value.",type:"text",prompt:"Create a 5-slide LinkedIn carousel post breaking down our core brand value proposition.",tall:false,wide:true,style:"light",bg:"#EDF2FF",bg2:"#E0EAFF",lbl:"CAROUSEL",hl:"5 reasons brands trust us.",sub:"Swipe through"},
  {id:19,cat:"content",title:"Visual Abstract Concept",desc:"Abstract, mood-driven visual for brand storytelling.",type:"image",prompt:"Create an abstract visual concept for brand storytelling that communicates clarity and ambition.",tall:true,wide:false,style:"light",bg:"#F3E8FF",bg2:"#E9D5FF",lbl:"ABSTRACT",hl:"Visual Direction",sub:"Brand storytelling concept"},
  {id:20,cat:"content",title:"Founder Thought Leadership",desc:"Personal brand post positioning the founder as a leader.",type:"text",prompt:"Write a thought leadership post from the founder perspective on brand strategy and consistency.",tall:false,wide:false,style:"light",bg:"#F0EFFF",bg2:"#E5E2FF",lbl:"THOUGHT LEADERSHIP",hl:"Why your brand is your moat.",sub:"LinkedIn Post"}
];

function renderCardPreview(card,bc){
  var col=(bc&&bc.colors&&bc.colors[0])?bc.colors[0].hex:"#B7FF2A";
  var isLight=card.style==="light";
  var textPrimary=isLight?"#18181A":"#fff";
  var textMuted=isLight?"rgba(24,24,26,.45)":"rgba(255,255,255,.45)";
  var textSub=isLight?"rgba(24,24,26,.55)":"rgba(255,255,255,.55)";
  var parts=[];

  if(card.palette){
    var shades=["#B7FF2A","#9FE81F","#7ACC15","#5BAA0C","#3D7A06"];
    if(bc&&bc.colors) shades=bc.colors.slice(0,5).map(function(x){return x.hex;});
    parts.push('<div style="display:flex;gap:8px;justify-content:center;margin-bottom:10px">');
    shades.slice(0,5).forEach(function(h){parts.push('<div style="width:30px;height:52px;border-radius:8px;background:'+h+'"></div>');});
    parts.push('</div>');
    parts.push('<div style="font-size:10px;color:'+textMuted+';text-align:center">Color System</div>');
    return parts.join("");
  }
  if(card.typo){
    return '<div style="font-family:\'Instrument Serif\',serif;font-size:52px;color:#fff;line-height:1;text-align:center">Aa</div>'
      +'<div style="font-size:11px;color:rgba(255,255,255,.5);text-align:center;margin-top:6px">Instrument Serif</div>'
      +'<div style="font-size:10px;color:rgba(255,255,255,.32);text-align:center;margin-top:3px">Body: Geist Regular</div>';
  }
  if(card.logomark){
    var initial=(bc&&bc.name)?bc.name.charAt(0).toUpperCase():"O";
    return '<div style="width:76px;height:76px;border-radius:18px;background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-family:\'Instrument Serif\',serif;font-size:44px;color:#fff">'+initial+'</div>'
      +'<div style="font-size:10px;color:rgba(255,255,255,.45);text-align:center">Primary Mark</div>';
  }
  if(card.metric){
    return '<div style="font-family:\'Instrument Serif\',serif;font-size:44px;color:'+col+';line-height:1;text-align:center">'+card.metric+'</div>'
      +'<div style="font-size:12px;color:'+textSub+';text-align:center;margin-top:4px">'+card.metricSub+'</div>'
      +(card.cta?'<div style="display:inline-block;background:'+col+';color:#fff;border-radius:8px;padding:5px 14px;font-size:11px;font-weight:600;margin-top:10px">'+card.cta+'</div>':"");
  }
  if(card.bigNum){
    return '<div style="font-family:\'Instrument Serif\',serif;font-size:52px;color:rgba(255,255,255,.12);line-height:1;text-align:center">'+card.bigNum+'</div>'
      +'<div style="font-size:10px;color:rgba(255,255,255,.5);text-align:center;letter-spacing:1px">'+card.bigSub+'</div>'
      +'<div style="font-family:\'Instrument Serif\',serif;font-size:20px;color:#fff;text-align:center;margin-top:6px">'+card.hl+'</div>'
      +(card.sub?'<div style="font-size:10px;color:rgba(255,255,255,.42);text-align:center;margin-top:4px">'+card.sub+'</div>':"");
  }
  // Standard layout
  if(card.lbl) parts.push('<div style="font-size:9px;font-weight:700;letter-spacing:1.2px;color:'+textMuted+';text-transform:uppercase;text-align:center">'+card.lbl+'</div>');
  if(card.hl) parts.push('<div style="font-family:\'Instrument Serif\',serif;font-size:20px;font-weight:700;color:'+textPrimary+';text-align:center;line-height:1.2;margin-top:6px">'+card.hl+'</div>');
  if(card.sub) parts.push('<div style="font-size:11px;color:'+textSub+';text-align:center;margin-top:6px">'+card.sub+'</div>');
  if(card.cta) parts.push('<div style="display:inline-block;background:rgba(255,255,255,.2);color:'+textPrimary+';border-radius:8px;padding:5px 14px;font-size:11px;font-weight:600;margin-top:8px">'+card.cta+'</div>');
  return parts.join("");
}

var _idCurrentFilter="all";
var _ID_CATS=["campaign","visual","web","text"];

function renderInspiration(){
  var feed=document.getElementById("idFeed");
  if(!feed) return;

  var cats=_idCurrentFilter==="all"?_ID_CATS:[_idCurrentFilter];
  var html="";
  cats.forEach(function(cat){
    var panel=ID_PANELS[cat];
    if(!panel||!panel.ideas) return;
    var color=panel.color||"#B7FF2A";
    var title=panel.title||cat;
    panel.ideas.forEach(function(idea,idx){
      html+='<div class="id-concept-card" onclick="idUseConcept(\''+cat+'\','+idx+')">';
      // Thumbnail
      html+='<div class="id-card-thumb" style="background:'+idea.bg+'">';
      html+='<div class="id-thumb-glow" style="background:'+idea.accent+'"></div>';
      html+='<div class="id-thumb-lbl">'+idea.lbl+'</div>';
      html+='<div class="id-thumb-hl">'+idea.hl+'</div>';
      html+='</div>';
      // Body
      html+='<div class="id-card-body">';
      html+='<div class="id-card-cat" style="color:'+color+'">'+title+'</div>';
      html+='<div class="id-card-title">'+idea.label+'</div>';
      html+='<div class="id-card-desc">'+idea.desc+'</div>';
      html+='<div class="id-card-foot">';
      html+='<span class="id-card-use">'+idea.useLabel+'</span>';
      html+='<svg class="id-card-arr" viewBox="0 0 14 14" fill="none" stroke-width="1.8"><path d="M4 7h6M7 4l3 3-3 3"/></svg>';
      html+='</div>';
      html+='</div>';
      html+='</div>';
    });
  });
  feed.innerHTML=html;

  var ct=document.getElementById("idCurationText");
  if(ct){
    var shown=feed.querySelectorAll(".id-concept-card").length;
    ct.textContent=shown===36?"36 AI-curated creative concepts":shown+" concepts";
  }
}

function idFilter(cat,btn){
  _idCurrentFilter=cat;
  document.querySelectorAll(".id-filt").forEach(function(b){b.classList.remove("id-filt-active");});
  if(btn) btn.classList.add("id-filt-active");
  renderInspiration();
}

function idUseConcept(cat,idx){
  var idea=ID_PANELS[cat]&&ID_PANELS[cat].ideas[idx];
  if(!idea) return;
  S._ideaPrefill=idea.label+" — "+idea.desc;
  var dest=ID_PANELS[cat].dest||ID_DEST[cat]||"text";
  openBuilder(dest);
}

function idUseIdea(cat,idx){
  idUseConcept(cat,idx);
}


// ═══════════════════════════════════════════════════════════════

// useTpl: called from modal-tpl "Use Template" button
function useTpl(){
  // Find template by currentTplId and open in Create workspace
  var t=TEMPLATES.find(function(x){return x.id===S.currentTplId;});
  if(!t) return;
  closeModal("modal-tpl");
  openCreateWorkspace("image","poster");
  setTimeout(function(){
    var inp=document.getElementById("cwsInput");
    if(inp) inp.value="Create a "+t.name;
    toast(t.name+" loaded in Create");
  },100);
}
