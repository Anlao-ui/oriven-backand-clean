// ════════════════════════════════════════════════════════════════
// ORIVEN — Settings
//
// Persistence: localStorage key "oriven_settings" (JSON object).
// initSettings() is called on DOMContentLoaded to apply saved state.
// Each handler saves its slice via saveSettings(patch).
// ════════════════════════════════════════════════════════════════

// ── Persistence ────────────────────────────────────────────────

var SETTINGS_KEY = "oriven_settings";

var SETTINGS_DEFAULTS = {
  wsName:            "My Workspace",
  theme:             "light",
  accent:            "green",
  language:          "en",
  notifBrandCheck:   true,
  notifGenComplete:  true,
  notifUpdates:      true,
  autoSave:          true,
  aiLearning:        true,
  brandConsistency:  true,
  generationHistory: true,
  generatorView:     "grid",
  // "free" is the only safe default — paid plans must be explicitly granted.
  // In production this value is overwritten on sign-in from the backend/Stripe.
  currentPlan:      "free",
  planRenewalDate:  null,
  pendingPlan:      null,
  pendingPlanDate:  null
};

// Plan data lives in plans.js (ORIVEN_PLANS / ORIVEN_PLAN_LIST / ORIVEN_PAID_PLANS).
// settings.js reads from those globals — do not duplicate plan definitions here.

function loadSettings(){
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if(raw) return Object.assign({}, SETTINGS_DEFAULTS, JSON.parse(raw));
  } catch(_){}
  return Object.assign({}, SETTINGS_DEFAULTS);
}

function saveSettings(patch){
  var current = loadSettings();
  var updated = Object.assign(current, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated)); } catch(_){}
  return updated;
}


// ── Apply all saved settings to the UI on page load ────────────

function initSettings(){
  var cfg = loadSettings();

  // Theme first (sets dark-mode class), then accent on top of it
  _applyTheme(cfg.theme);
  _applyAccent(cfg.accent || "green");

  // Workspace name
  var wsInp = document.getElementById("wsNameInp");
  if(wsInp) wsInp.value = cfg.wsName || "";
  _updateSidebarName(cfg.wsName);

  // Language — set dropdown + apply strings
  CURRENT_LANG = cfg.language || "en";
  var langSel = document.getElementById("langSelect");
  if(langSel) langSel.value = CURRENT_LANG;
  applyLanguage();

  // Notification toggles
  var nb = document.getElementById("tglNotifBrandCheck");
  var ng = document.getElementById("tglNotifGenComplete");
  var nu = document.getElementById("tglNotifUpdates");
  if(nb) nb.classList.toggle("on", cfg.notifBrandCheck !== false);
  if(ng) ng.classList.toggle("on", cfg.notifGenComplete !== false);
  if(nu) nu.classList.toggle("on", cfg.notifUpdates !== false);

  // Intelligence toggles
  var tglAI = document.getElementById("tglAILearning");
  if(tglAI) tglAI.classList.toggle("on", cfg.aiLearning !== false);
  _updateHint("hintAILearning", cfg.aiLearning !== false,
    "Future personalization active", "No history used for recommendations");

  var tglBC = document.getElementById("tglBrandConsistency");
  if(tglBC) tglBC.classList.toggle("on", cfg.brandConsistency !== false);
  _updateHint("hintBrandConsistency", cfg.brandConsistency !== false,
    "Maximum brand consistency", "Creative freedom enabled");

  // Workspace toggles
  var tglGH = document.getElementById("tglGenHistory");
  if(tglGH) tglGH.classList.toggle("on", cfg.generationHistory !== false);
  _updateHint("hintGenHistory", cfg.generationHistory !== false,
    "History is being saved", "Generations are not stored");

  var tglAS = document.getElementById("tglAutoSave");
  if(tglAS) tglAS.classList.toggle("on", cfg.autoSave !== false);
  _updateHint("hintAutoSave", cfg.autoSave !== false,
    "BrandCore changes are saved automatically", "Save manually required");

  // Default view
  _applyGeneratorView(cfg.generatorView || "grid");

  // Profile email
  _loadProfileEmail();

  // Plan section
  initPlan();
}


// ════════════════════════════════════════════════════════════════
// WORKSPACE / PROFILE
// ════════════════════════════════════════════════════════════════

function saveWsName(){
  var inp = document.getElementById("wsNameInp");
  if(!inp) return;
  var name = inp.value.trim();
  if(!name){ toast("Enter a workspace name", "warn"); return; }
  saveSettings({ wsName: name });
  _updateSidebarName(name);
  toast("Workspace updated");
}

function _updateSidebarName(name){
  if(!name) return;
  var el = document.getElementById("sidebarUserName");
  if(el) el.textContent = name;
}

async function _loadProfileEmail(){
  try {
    var res = await SB.auth.getSession();
    var session = res && res.data && res.data.session;
    if(session && session.user){
      var emailEl = document.getElementById("profileEmailVal");
      if(emailEl) emailEl.textContent = session.user.email || "—";
      var authEl = document.getElementById("profileAuthVal");
      if(authEl){
        var provider = (session.user.app_metadata && session.user.app_metadata.provider) || "email";
        authEl.textContent = provider === "google" ? "Google" : "Email & Password";
      }
    }
  } catch(_){}
}

async function sendPasswordReset(){
  try {
    var res = await SB.auth.getSession();
    var session = res && res.data && res.data.session;
    if(!session || !session.user){ toast("Not signed in", "warn"); return; }
    await SB.auth.resetPasswordForEmail(session.user.email);
    toast("Password reset email sent");
  } catch(err){
    toast("Could not send reset email — try again", "err");
  }
}

function _updateHint(id, isOn, onText, offText){
  var el = document.getElementById(id);
  if(!el) return;
  el.textContent = isOn ? onText : offText;
  el.classList.toggle("se-tgl-hint--off", !isOn);
}


// ════════════════════════════════════════════════════════════════
// APPEARANCE — THEME
// ════════════════════════════════════════════════════════════════

function setTheme(mode){
  _applyTheme(mode);
  // Re-apply accent because dark-mode CSS vars override :root values
  _applyAccent(loadSettings().accent || "green");
  saveSettings({ theme: mode });
  toast(mode === "dark" ? "Dark mode enabled" : "Light mode enabled");
}

function _applyTheme(mode){
  document.body.classList.toggle("dark-mode", mode === "dark");
  var tl = document.getElementById("themeLight");
  var td = document.getElementById("themeDark");
  if(tl) tl.classList.toggle("active", mode !== "dark");
  if(td) td.classList.toggle("active",  mode === "dark");
}


// ════════════════════════════════════════════════════════════════
// APPEARANCE — ACCENT COLOR
// ════════════════════════════════════════════════════════════════

// Each palette has light/dark variants for:
//   --green  (darkest — primary buttons, strong UI)
//   --gm     (medium — active states, focus rings, hover fills)
//   --glt    (light  — subtle backgrounds, selected pill fills)
//   --gpale  (pale   — hover backgrounds, very light tints)

var ACCENT_PALETTES = {
  green: {
    light: { green:"#B7FF2A", gm:"#9FE81F", glt:"rgba(183,255,42,0.07)", gpale:"rgba(183,255,42,0.04)", deep:"#0A0A0A" },
    dark:  { green:"#B7FF2A", gm:"#9FE81F", glt:"rgba(183,255,42,0.08)", gpale:"rgba(183,255,42,0.05)", deep:"#000000" }
  },
  blue: {
    light: { green:"#1e3a5f", gm:"#1971C2", glt:"#DBEAFE", gpale:"#EFF6FF", deep:"#0D1F3C" },
    dark:  { green:"#1c4ed8", gm:"#3b82f6", glt:"#172554", gpale:"#1e3058", deep:"#0A1628" }
  },
  purple: {
    light: { green:"#3b0764", gm:"#7C3AED", glt:"#EDE9FE", gpale:"#F5F3FF", deep:"#1E0336" },
    dark:  { green:"#5b21b6", gm:"#8B5CF6", glt:"#2e1065", gpale:"#1e1b4b", deep:"#120022" }
  },
  red: {
    light: { green:"#7f1d1d", gm:"#DC2626", glt:"#FEE2E2", gpale:"#FEF2F2", deep:"#450A0A" },
    dark:  { green:"#991b1b", gm:"#EF4444", glt:"#450a0a", gpale:"#3b0808", deep:"#2C0000" }
  },
  orange: {
    light: { green:"#7c2d12", gm:"#EA580C", glt:"#FFEDD5", gpale:"#FFF7ED", deep:"#431407" },
    dark:  { green:"#9a3412", gm:"#F97316", glt:"#431407", gpale:"#2c1000", deep:"#2C0E00" }
  },
  pink: {
    light: { green:"#831843", gm:"#DB2777", glt:"#FCE7F3", gpale:"#FDF2F8", deep:"#4A0E2A" },
    dark:  { green:"#9d174d", gm:"#EC4899", glt:"#4a0e28", gpale:"#2d0019", deep:"#200010" }
  }
};

function setAccent(name){
  _applyAccent(name);
  saveSettings({ accent: name });
  toast("Accent color updated");
}

// Sets accent CSS custom properties directly on body as inline styles,
// which takes precedence over both :root and body.dark-mode stylesheet rules.
function _applyAccent(name){
  var isDark   = document.body.classList.contains("dark-mode");
  var palette  = ACCENT_PALETTES[name] || ACCENT_PALETTES.green;
  var vars     = isDark ? palette.dark : palette.light;

  document.body.style.setProperty("--green",      vars.green);
  document.body.style.setProperty("--gm",         vars.gm);
  document.body.style.setProperty("--glt",        vars.glt);
  document.body.style.setProperty("--gpale",      vars.gpale);
  document.body.style.setProperty("--green-deep", vars.deep);

  // Update picker active state
  document.querySelectorAll(".accent-swatch").forEach(function(el){
    el.classList.toggle("active", el.dataset.accent === name);
  });
}


// ════════════════════════════════════════════════════════════════
// LANGUAGE
// ════════════════════════════════════════════════════════════════

var CURRENT_LANG = "en";

var LANG_STRINGS = {
  en:{
    // Navigation
    dashboard:"Dashboard", create:"Create", studio:"BrandCore",
    inspiration:"Inspiration", settings:"Settings",
    // Greetings
    goodMorning:"Good morning", goodAfternoon:"Good afternoon",
    goodEvening:"Good evening", goodNight:"Good night",
    // Dashboard / FAB
    brandAssistant:"Brand Assistant", openAIChat:"Start Creating",
    // Studio
    savedAssets:"Saved Assets", brandCore:"Brand Core",
    brandCheck:"Brand Check", campaigns:"Campaigns",
    // Settings nav
    workspace:"Workspace", plan:"Your Plan", appearance:"Appearance", language:"Language",
    notifications:"Notifications", exportPref:"Export", brandReset:"Brand Reset",
    // Appearance labels
    themeLabel:"Theme", lightMode:"Light Mode", darkMode:"Dark Mode",
    accentLabel:"Accent Color",
    accentHelp:"Choose the highlight color used across buttons, active states, and UI elements.",
    // Empty states
    noItems:"No saved assets yet",
    createContent:"Generate content in AI Chat and save it here.",
    // Welcome
    welcomeMsg:"How can I support your brand today?",
    // Create page
    createSub:"Choose a creation type to get started. Your Brand Core shapes every output.",
    imageTitle:"Visuals",     imageDesc:"Generate on-brand visuals, ads, and social media designs.",
    textTitle:"Text",        textDesc:"Generate captions, headlines, and brand copy.",
    campaignTitle:"Campaign",campaignDesc:"Build full campaigns with visuals and copy.",
    videoTitle:"Video",      videoDesc:"Create video ideas, scripts, and concepts.",
    webTitle:"Web",          webDesc:"Build brand-aligned landing pages and web assets.",
    assistantDesc:"Ask your brand AI for guidance, ideas, and creative direction.",
    comingSoon:"Coming soon",
    // Sidebar identity
    brandWorkspace:"Brand Workspace", signOut:"Sign out",
    // Dashboard headline & tagline
    dashHeadlinePrefix:"Your brand is", dashHeadlineHighlight:"ready.",
    dashTagline:"Let's turn it into content, ads, and growth.",
    // Dashboard action cards
    dashCreateLabel:"Create Content",   dashCreateDesc:"Images, copy, video scripts, and more.",
    dashIdeasLabel:"Explore Ideas",     dashIdeasDesc:"Content ideas, ad angles, and campaign concepts.",
    dashCampaignLabel:"Build Campaign", dashCampaignDesc:"Full multi-channel campaigns end to end.",
    dashBrandLabel:"Edit Brand Core",   dashBrandDesc:"Colors, fonts, tone of voice, and identity.",
    // Dashboard snapshot
    edit:"Edit", setUp:"Set up", notConfigured:"Not configured",
    buildBrandIdentity:"Build your brand identity to get started.",
    setUpBrandCore:"Set up your Brand Core →",
    // Create page
    createH1Line1:"What would you like to", createH1Line2:"create today?",
    // Studio hub
    brandStudioTitle:"Brand Studio", brandStudioSub:"Everything that defines and drives your brand.",
    studioSavedLabel:"Saved",    studioSavedDesc:"All your generated content and assets.",
    studioBCDesc:"Colors, fonts, tone of voice, and identity.",
    studioCheckLabel:"Brand Check", studioCheckDesc:"Analyze content for brand consistency.",
    studioCampDesc:"Manage and launch your active campaigns.",
    studioBackBtn:"Back",
    // Studio: empty states + actions
    noBCConfigured:"No Brand Core configured yet",
    noBCConfiguredSub:"Set up your brand identity to unlock AI generation.",
    aiGenerateBtn:"AI Generate", manualSetupBtn:"Manual Setup",
    savedAssetsHeader:"Saved Assets",
    openAIChatBtn:"Open AI Chat",
    noCampaignsTitle:"No campaigns yet",
    noCampaignsSub:"Bundle saved assets into visual campaign concepts for social media and ads.",
    newCampaignBtn:"+ New Campaign",
    // Brand Check
    dropImageTitle:"Drop your image here",
    dropImageSub:"PNG, JPG, or WEBP — drag and drop or click to browse",
    checkBrandNoImgBtn:"Check Brand Without Image",
    readyForCheck:"Ready for brand check",
    runBrandCheckBtn:"Run Brand Check", resetBtn:"Reset", removeBtn:"Remove",
    analyzingBrand:"Analyzing brand consistency...",
    checkingDetails:"Checking colors, typography, and visual style",
    // Ideas hub
    ideasTitle:"Ideas", ideasSub:"Proven frameworks to spark your next piece of content.",
    contentIdeasLabel:"Content Ideas",      contentIdeasDesc:"Posts, stories, and formats that build audiences.",
    adAnglesLabel:"Ad Angles",             adAnglesDesc:"Messaging frameworks that turn attention into action.",
    visualStylesLabel:"Visual Styles",     visualStylesDesc:"Aesthetic directions for your brand's visual identity.",
    campaignConceptsLabel:"Campaign Concepts", campaignConceptsDesc:"End-to-end structures that drive real results.",
    // Ideas panel titles
    idContentTitle:"Content Ideas", idAnglesTitle:"Ad Angles",
    idVisualTitle:"Visual Styles",  idCampaignTitle:"Campaign Concepts",
    // Ideas button labels per category
    idContentUseLabel:"Use this idea",       idContentGenLabel:"Generate post",
    idAnglesUseLabel:"Try this angle",       idAnglesGenLabel:"Generate ad",
    idVisualUseLabel:"Use this style",       idVisualGenLabel:"Generate visual",
    idCampaignUseLabel:"Build this campaign",idCampaignGenLabel:"Generate assets",
    // Ideas: content idea labels
    idCont0Label:"Educational Posts",   idCont1Label:"Product Spotlight",
    idCont2Label:"Founder Story",       idCont3Label:"Transformation Story",
    idCont4Label:"Customer Result",     idCont5Label:"Comparison Post",
    idCont6Label:"Myth vs. Truth",      idCont7Label:"Before / After",
    idCont8Label:"Routine / Workflow",  idCont9Label:"Authority Builder",
    // Ideas: ad angle labels
    idAng0Label:"Problem → Solution",   idAng1Label:"Aspiration",
    idAng2Label:"Transformation",       idAng3Label:"Urgency",
    idAng4Label:"Scarcity",             idAng5Label:"Pain Point Agitation",
    idAng6Label:"Social Proof",         idAng7Label:"Premium Positioning",
    idAng8Label:"Benefit-First",        idAng9Label:"Emotional Hook",
    // Ideas: visual style labels
    idVis0Label:"Luxury Minimal",       idVis1Label:"Bold Modern",
    idVis2Label:"Dark Premium",         idVis3Label:"Soft Lifestyle",
    idVis4Label:"Editorial Clean",      idVis5Label:"High Contrast",
    idVis6Label:"Futuristic Sleek",     idVis7Label:"Organic Natural",
    idVis8Label:"Sporty Performance",   idVis9Label:"Elegant Feminine",
    // Ideas: campaign concept labels
    idCamp0Label:"Product Launch",      idCamp1Label:"Brand Awareness",
    idCamp2Label:"Seasonal Drop",       idCamp3Label:"Conversion Push",
    idCamp4Label:"Educational Funnel",  idCamp5Label:"Retargeting Sequence",
    idCamp6Label:"Limited Offer Sprint",idCamp7Label:"Founder-Led Campaign",
    idCamp8Label:"Testimonial-Driven",  idCamp9Label:"Community Campaign",
    // Team
    teamTitle:"Team", teamSub:"Manage your Business workspace team.",
    // Settings structural
    settingsTitle:"Settings", settingsSub:"Manage your workspace and preferences.",
    spWorkspaceSub:"Manage your brand workspace details and preferences.",
    wsNameLabel:"Workspace Name",
    wsNameHelp:"This is the name of your workspace inside ORIVEN. It appears in your sidebar and throughout the app.",
    saveBtn:"Save",
    brandLockLabel:"Brand Lock", lockBCLabel:"Lock BrandCore",
    lockBCSub:"When enabled, your BrandCore stays fixed and is applied consistently across all generated content. Disable to make changes to your brand setup.",
    spAppearanceSub:"Choose how ORIVEN looks and feels. Your preference is saved and persists across sessions.",
    spLanguageSub:"Set the display and content generation language for your workspace. Your selection is saved and applied on every session.",
    langDisplayLabel:"Display & Generation Language",
    langDisplayHelp:"ORIVEN will use this language for interface labels and when generating content with your BrandCore.",
    spNotificationsSub:"Control in-app notifications. Changes are saved immediately.",
    notifBrandCheckLabel:"Brand Check alerts",
    notifBrandCheckSub:"Show a notification when your Brand Check score drops below 70%.",
    notifGenCompleteLabel:"Generation complete",
    notifGenCompleteSub:"Notify you when AI finishes generating content.",
    notifUpdatesLabel:"Product updates",
    notifUpdatesSub:"Receive in-app announcements about new ORIVEN features and improvements.",
    spExportTitle:"Export Preferences", spExportSub:"Control how your generated content is prepared for export and download.",
    expFormatLabel:"Default Export Format",
    expFormatHelp:"Choose the default file format when downloading generated assets. You can always change the format at the point of export.",
    autoSaveLabel:"Auto-save generated content",
    autoSaveSub:"Automatically save your workspace changes and generated content to Studio. When enabled, every generation is stored without requiring a manual save.",
    spDangerSub:"Permanent actions — these cannot be undone.",
    resetBCTitle:"Reset Brand Core",
    resetBCDesc:"This resets your entire brand setup — colors, tone of voice, positioning, and identity data. Your generated assets saved in Studio will not be affected, but all future generations will lose brand context until you create a new BrandCore. This action is permanent and cannot be reversed.",
    resetBCBtn:"Reset Brand Core",
    // Banner
    // Builder
    builderResultLabel:"Result", regenerateBtn:"Regenerate", saveToStudioBtn:"Save to Studio"
  },

  nl:{
    dashboard:"Dashboard", create:"Maken", studio:"BrandCore",
    inspiration:"Inspiratie", settings:"Instellingen",
    goodMorning:"Goedemorgen", goodAfternoon:"Goedemiddag",
    goodEvening:"Goedenavond", goodNight:"Goedenacht",
    brandAssistant:"Merkassistent", openAIChat:"Begin met Maken",
    savedAssets:"Opgeslagen Bestanden", brandCore:"Merkkern",
    brandCheck:"Merkcontrole", campaigns:"Campagnes",
    workspace:"Werkruimte", plan:"Uw abonnement", appearance:"Weergave", language:"Taal",
    notifications:"Meldingen", exportPref:"Exporteren", brandReset:"Merk Reset",
    themeLabel:"Thema", lightMode:"Lichte modus", darkMode:"Donkere modus",
    accentLabel:"Accentkleur",
    accentHelp:"Kies de markeringskleur voor knoppen, actieve staten en UI-elementen.",
    noItems:"Nog geen opgeslagen bestanden",
    createContent:"Maak inhoud in AI Chat en sla het hier op.",
    welcomeMsg:"Hoe kan ik uw merk vandaag ondersteunen?",
    createSub:"Kies een type en begin. Uw BrandCore vormt elke uitvoer.",
    imageTitle:"Afbeelding",  imageDesc:"Maak visuals, posters en social media ontwerpen.",
    textTitle:"Tekst",        textDesc:"Genereer onderschriften, koppen en merkteksten.",
    campaignTitle:"Campagne", campaignDesc:"Bouw complete campagnes met visuals en teksten.",
    videoTitle:"Video",       videoDesc:"Maak video-ideeën, scripts en concepten.",
    webTitle:"Web",           webDesc:"Bouw merkgerichte landingspagina's en webmaterialen.",
    assistantDesc:"Vraag je merk-AI om begeleiding, ideeën en creatieve richting.",
    comingSoon:"Binnenkort",
    brandWorkspace:"Merkwerkruimte", signOut:"Uitloggen",
    dashHeadlinePrefix:"Jouw merk is", dashHeadlineHighlight:"klaar.",
    dashTagline:"Laten we het omzetten in content, advertenties en groei.",
    dashCreateLabel:"Inhoud maken",     dashCreateDesc:"Afbeeldingen, tekst, videoscripts en meer.",
    dashIdeasLabel:"Ideeën verkennen",  dashIdeasDesc:"Contentideeën, advertentiehoeken en campagneconcepten.",
    dashCampaignLabel:"Campagne maken", dashCampaignDesc:"Volledige multi-channel campagnes van begin tot eind.",
    dashBrandLabel:"Brand Core bewerken", dashBrandDesc:"Kleuren, lettertypen, toon en identiteit.",
    edit:"Bewerken", setUp:"Instellen", notConfigured:"Niet geconfigureerd",
    buildBrandIdentity:"Bouw je merkidentiteit om te beginnen.",
    setUpBrandCore:"Stel je Brand Core in →",
    createH1Line1:"Wat wil je vandaag", createH1Line2:"creëren?",
    brandStudioTitle:"Brand Studio", brandStudioSub:"Alles wat jouw merk definieert en aandrijft.",
    studioSavedLabel:"Opgeslagen", studioSavedDesc:"Al jouw gegenereerde content en bestanden.",
    studioBCDesc:"Kleuren, lettertypen, toon en identiteit.",
    studioCheckLabel:"Merkcontrole",  studioCheckDesc:"Analyseer content op merkconsistentie.",
    studioCampDesc:"Beheer en lanceer jouw actieve campagnes.",
    studioBackBtn:"Terug",
    noBCConfigured:"Nog geen Brand Core geconfigureerd",
    noBCConfiguredSub:"Stel jouw merkidentiteit in om AI-generatie te ontgrendelen.",
    aiGenerateBtn:"AI Genereren", manualSetupBtn:"Handmatig instellen",
    savedAssetsHeader:"Opgeslagen bestanden",
    openAIChatBtn:"Open AI Chat",
    noCampaignsTitle:"Nog geen campagnes",
    noCampaignsSub:"Bundel opgeslagen bestanden in visuele campagneconcepten voor social media en advertenties.",
    newCampaignBtn:"+ Nieuwe campagne",
    dropImageTitle:"Sleep jouw afbeelding hier",
    dropImageSub:"PNG, JPG of WEBP — sleep of klik om te bladeren",
    checkBrandNoImgBtn:"Merk controleren zonder afbeelding",
    readyForCheck:"Klaar voor merkcontrole",
    runBrandCheckBtn:"Merkcontrole uitvoeren", resetBtn:"Reset", removeBtn:"Verwijderen",
    analyzingBrand:"Merkconsistentie analyseren...",
    checkingDetails:"Kleuren, typografie en visuele stijl controleren",
    ideasTitle:"Ideeën", ideasSub:"Bewezen raamwerken om jouw volgende content te inspireren.",
    contentIdeasLabel:"Contentideeën",      contentIdeasDesc:"Posts, verhalen en formats die publiek opbouwen.",
    adAnglesLabel:"Advertentiehoeken",      adAnglesDesc:"Berichtgeving die aandacht omzet in actie.",
    visualStylesLabel:"Visuele Stijlen",    visualStylesDesc:"Esthetische richtingen voor jouw merkidentiteit.",
    campaignConceptsLabel:"Campagneconcepten", campaignConceptsDesc:"Complete structuren die echte resultaten opleveren.",
    idContentTitle:"Contentideeën", idAnglesTitle:"Advertentiehoeken",
    idVisualTitle:"Visuele Stijlen", idCampaignTitle:"Campagneconcepten",
    idContentUseLabel:"Gebruik dit idee",        idContentGenLabel:"Genereer bericht",
    idAnglesUseLabel:"Probeer deze hoek",         idAnglesGenLabel:"Genereer advertentie",
    idVisualUseLabel:"Gebruik deze stijl",        idVisualGenLabel:"Genereer visual",
    idCampaignUseLabel:"Bouw deze campagne",      idCampaignGenLabel:"Genereer bestanden",
    idCont0Label:"Educatieve Posts",     idCont1Label:"Product Spotlight",
    idCont2Label:"Oprichtersverhaal",    idCont3Label:"Transformatieverhaal",
    idCont4Label:"Klantresultaat",       idCont5Label:"Vergelijkingspost",
    idCont6Label:"Mythe vs. Waarheid",   idCont7Label:"Voor / Na",
    idCont8Label:"Routine / Werkwijze",  idCont9Label:"Autoriteitsopbouwer",
    idCont0Desc:"Leer je publiek één ding dat ze nog niet weten. Deel een contra-intuïtief inzicht uit jouw branche. Positioneer jouw merk als de expert voordat je ooit een product pitcht.",
    idCont1Desc:"Zet één product, functie of detail onder de aandacht. Focus op wat het anders maakt. Geen opsomming van functies — één hoek, goed uitgelegd. Maak het gewone opmerkelijk.",
    idCont2Desc:"Waarom ben je hiermee begonnen? Wat heb je geriskeert, mislukt of ontdekt? Mensen kopen niet van merken — ze kopen van mensen. Vertel het verhaal achter het merk.",
    idCont3Desc:"Toon de voor en na — niet alleen visueel, maar emotioneel. Wat veranderde er? Laat de lezer zichzelf in de transformatie zien.",
    idCont4Desc:"Één echte klant. Één echt resultaat. Wees specifiek — cijfers, tijdlijnen, context. Vage getuigenissen doen niets. Precieze verhalen converteren.",
    idCont5Desc:"Oude manier vs. jouw manier. Generiek vs. specifiek. Formuleer de vergelijking zodat jouw merk wint zonder iemand direct aan te vallen. Laat het contrast het werk doen.",
    idCont6Desc:"Ontkracht een veelvoorkomende overtuiging die mensen tegenhoudt. Vervang het door wat écht werkt. Dit formaat bouwt snel vertrouwen op en maakt jouw merk tot de autoriteit.",
    idCont7Desc:"Toon het contrast. Het rommelige bureau en het georganiseerde. Het omslachtige proces en het gestroomlijnde. Visueel of in tekst — voor/na is een van de meest overtuigende structuren.",
    idCont8Desc:"Toon hoe jij, jouw team of jouw klant jouw product gebruikt in een echte workflow. Procesinhoud bouwt diepte en vertrouwen.",
    idCont9Desc:"Deel een sterke mening over iets in jouw branche. Neem een duidelijk standpunt in. Merken met een standpunt trekken loyale doelgroepen aan. Neutrale merken trekken niemand aan.",
    idAng0Label:"Probleem → Oplossing",  idAng1Label:"Aspiratie",
    idAng2Label:"Transformatie",         idAng3Label:"Urgentie",
    idAng4Label:"Schaarste",             idAng5Label:"Pijnagitering",
    idAng6Label:"Sociaal Bewijs",        idAng7Label:"Premium Positionering",
    idAng8Label:"Voordeel Eerst",        idAng9Label:"Emotionele Haak",
    idAng0Desc:"Benoem de exacte pijn die jouw doelgroep nu voelt. Maak het specifiek genoeg dat ze zich gezien voelen. Toon dan de oplossing. Maak duidelijk dat jouw product de logische brug is.",
    idAng1Desc:"Toon het leven dat ze willen. Niet wat jouw product doet — hoe hun leven eruitziet nadat ze het gebruiken. Positioneer jouw merk als de brug. Verkoop de bestemming, niet het voertuig.",
    idAng2Desc:"Open waar ze zijn. Sluit waar ze kunnen zijn. De transformatie is het product. Maak het gat levendig — hoe groter het gat aanvoelt, hoe waardevoller de brug wordt.",
    idAng3Desc:"Beperkte tijd, beperkte voorraad of beperkte toegang — maak de schaarste reëel. Neppe urgentie werkt averechts. Echte beperkingen converteren. Geef hen één reden om nú te handelen.",
    idAng4Desc:"Niet iedereen kan dit hebben — en dat is het punt. Exclusieve toegang, wachtlijsten, beperkte batches. Schaarste signaleert waarde. Als iedereen het heeft, wil niemand het.",
    idAng5Desc:"Benoem het probleem niet alleen — druk erop. Laat hen de frustratie, de verspilde tijd, de kosten van inactie voelen. Agiteer voordat je oplost. Urgentie leeft in de pijn, niet in de oplossing.",
    idAng6Desc:"Niet alleen '5 sterren' — geef bewijs met context. Wie behaalde het resultaat? Hoe lang duurde het? Specifiek bewijs van een herkenbaar persoon converteert ver beter dan generieke lof.",
    idAng7Desc:"Concurreer niet op prijs — concurreer op categorie. Als je de beste bent, gedraag je daarnaar. Hogere prijs = hogere gepercipieerde waarde wanneer de positionering klopt.",
    idAng8Desc:"Begin met de uitkomst, niet de functie. Niet '16 uur batterij' — 'Kom de hele dag door zonder eens aan je telefoon te denken.' Vertaal elke functie in het gevoel dat het creëert.",
    idAng9Desc:"Sla de logica volledig over. Open met een gevoel — opluchting, trots, opwinding, verbondenheid. Mensen nemen beslissingen emotioneel en rechtvaardigen met logica.",
    idVis0Label:"Luxe Minimaal",       idVis1Label:"Gedurfd Modern",
    idVis2Label:"Donker Premium",      idVis3Label:"Zachte Levensstijl",
    idVis4Label:"Redactioneel Strak",  idVis5Label:"Hoog Contrast",
    idVis6Label:"Futuristisch Slank",  idVis7Label:"Organisch Natuurlijk",
    idVis8Label:"Sportief Prestatie",  idVis9Label:"Elegant Vrouwelijk",
    idVis0Desc:"Schone vlakken, royale witruimte, premium typografie, ingetogen palet. Niets decoratiefs. Elk element heeft zijn reden. Stilte op de pagina communiceert kwaliteit.",
    idVis1Desc:"Sterke geometrie, hoog contrast, zelfverzekerde typografie zonder decoratie. Geen zachte gradients, geen onnodige schaduwen. Het grid is het ontwerp.",
    idVis2Desc:"Diepe bijna-zwarte tonen, neon of goud accenten, redactionele framing, cinematische sfeer. Sterk voor tech, streetwear en beauty.",
    idVis3Desc:"Echte mensen, natuurlijk licht, warme spontane momenten, onvolmaakte texturen. Authentiek verslaat gepolijst bij het opbouwen van emotionele connectie.",
    idVis4Desc:"Magazine-kwaliteit compositie. Sterke typografie die de layout leidt. Product als kunst. Elk visueel voelt intentioneel. Gebruikt door fashion, beauty en media merken.",
    idVis5Desc:"Puur zwart tegen puur wit. Of een enkele vette kleur naar maximale verzadiging. Geen middentonen, geen gradients. Maximale impact met minimale complexiteit.",
    idVis6Desc:"Metalen oppervlakken, koele tonen, strakke lijnen, subtiele gloed-effecten. Voelt voor zijn tijd uit. Werkt voor AI, hardware en tech-voorwaartse merken.",
    idVis7Desc:"Aardse tonen, ruwe texturen, botanische elementen, handgetekende details. Voelt eerlijk en gegrond. Ideaal voor wellness, voeding, huidverzorging en duurzaamheidsmerken.",
    idVis8Desc:"Dynamische hoeken, bewegingsvervaging, vette typografie, hoge verzadiging. Ontworpen om als beweging te voelen. Sterk voor fitness, sport en energiemerken.",
    idVis9Desc:"Zachte paletten, delicate typografie, verfijnde negatieve ruimte. Warmte en verfijning in gelijke mate. Sterk voor beauty, fashion, home en lifestyle merken.",
    idCamp0Label:"Productlancering",        idCamp1Label:"Merkbekendheid",
    idCamp2Label:"Seizoenslancering",       idCamp3Label:"Conversiepush",
    idCamp4Label:"Educatieve Funnel",       idCamp5Label:"Retargetingreeks",
    idCamp6Label:"Beperkt Aanbod Sprint",   idCamp7Label:"Oprichtercampagne",
    idCamp8Label:"Getuigeniscampagne",      idCamp9Label:"Gemeenschapscampagne",
    idCamp0Desc:"Bouw anticipatie → onthul → educeer → converteer. Reeks over één tot twee weken. Teaser voor je toont. Toon voor je verkoopt. Educeer voor je vraagt.",
    idCamp1Desc:"Vertel jouw verhaal voor je verkoopt. Herhaalde lage-druk blootstelling via platforms. Geen CTA op elke post. Verschijn eerst met consistente waarde. Verkoop later.",
    idCamp2Desc:"Verankerd aan een moment — feestdag, seizoen, culturele gebeurtenis. Bouw anticipatie van tevoren, lanceer hard, sluit af met een laatste 48-uurs push.",
    idCamp3Desc:"Full-funnel campagne geoptimaliseerd voor één actie: kopen, aanmelden of boeken. Bewustzijnsadvertenties → retargeting → winkelwagen verlaten → last-chance e-mail.",
    idCamp4Desc:"Leer jouw doelgroep voordat je aan hen verkoopt. Content → vertrouwen → product. Een serie, een gratis gids of een korte cursus. Tegen de tijd dat ze het aanbod zien, geloven ze je al.",
    idCamp5Desc:"Heractiveer mensen die je al kennen maar niet hebben geconverteerd. Ander bericht voor verschillende stadia — bezocht de site, begon checkout, bekeek video.",
    idCamp6Desc:"Korte, intensieve campagne rond een echte beperking: 72 uur, 50 eenheden, één cohort. Smal venster = echte urgentie. Sluit hard af bij de deadline.",
    idCamp7Desc:"Zet de oprichter centraal. Hun gezicht, hun stem, hun verhaal. Mensen vertrouwen mensen meer dan merken. Een direct persoonlijk bericht van de oprichter kan elke advertentie overtreffen.",
    idCamp8Desc:"Laat jouw klanten het woord doen. Echte woorden, echte gezichten, echte resultaten. Verzamel sterke getuigenissen en bouw de campagne rond hun taal — niet de jouwe.",
    idCamp9Desc:"Bouw rondom jouw doelgroep, niet op hen gericht. Door gebruikers gegenereerde content, uitdagingen, gedeelde tags. Verandert klanten in pleitbezorgers.",
    teamTitle:"Team", teamSub:"Beheer jouw Business workspace team.",
    settingsTitle:"Instellingen", settingsSub:"Beheer jouw werkruimte en voorkeuren.",
    spWorkspaceSub:"Beheer jouw merkwerkruimte en voorkeuren.",
    wsNameLabel:"Naam werkruimte",
    wsNameHelp:"Dit is de naam van jouw werkruimte in ORIVEN. Het verschijnt in de zijbalk en door de hele app.",
    saveBtn:"Opslaan",
    brandLockLabel:"Merkvergrendeling", lockBCLabel:"Vergrendel BrandCore",
    lockBCSub:"Wanneer ingeschakeld, blijft jouw BrandCore vast en wordt het consistent toegepast op alle gegenereerde content.",
    spAppearanceSub:"Kies hoe ORIVEN eruitziet en aanvoelt. Jouw voorkeur wordt opgeslagen.",
    spLanguageSub:"Stel de weergave- en contentgeneratietaal in voor jouw werkruimte.",
    langDisplayLabel:"Weergave- en Generatietaal",
    langDisplayHelp:"ORIVEN gebruikt deze taal voor interface-labels en bij het genereren van content met jouw BrandCore.",
    spNotificationsSub:"Beheer meldingen in de app. Wijzigingen worden direct opgeslagen.",
    notifBrandCheckLabel:"Merkcontrolemeldingen",
    notifBrandCheckSub:"Toon een melding wanneer jouw merkscore onder de 70% daalt.",
    notifGenCompleteLabel:"Generatie voltooid",
    notifGenCompleteSub:"Ontvang een melding wanneer de AI klaar is met het genereren van content.",
    notifUpdatesLabel:"Productupdates",
    notifUpdatesSub:"Ontvang in-app aankondigingen over nieuwe ORIVEN-functies en verbeteringen.",
    spExportTitle:"Exportvoorkeuren", spExportSub:"Bepaal hoe jouw gegenereerde content wordt voorbereid voor export.",
    expFormatLabel:"Standaard exportformaat",
    expFormatHelp:"Kies het standaard bestandsformaat bij het downloaden van gegenereerde bestanden.",
    autoSaveLabel:"Gegenereerde content automatisch opslaan",
    autoSaveSub:"Sla jouw wijzigingen en gegenereerde content automatisch op in Studio.",
    spDangerSub:"Permanente acties — deze kunnen niet ongedaan worden gemaakt.",
    resetBCTitle:"Brand Core resetten",
    resetBCDesc:"Dit reset jouw volledige merkinstelling — kleuren, toon, positionering en identiteitsdata. Jouw opgeslagen bestanden in Studio worden niet beïnvloed, maar toekomstige generaties verliezen merkcontext. Deze actie is permanent en kan niet worden teruggedraaid.",
    resetBCBtn:"Brand Core resetten",
    builderResultLabel:"Resultaat", regenerateBtn:"Opnieuw genereren", saveToStudioBtn:"Opslaan in Studio"
  },

  es:{
    dashboard:"Inicio", create:"Crear", studio:"Estudio",
    inspiration:"Inspiración", settings:"Ajustes",
    goodMorning:"Buenos días", goodAfternoon:"Buenas tardes",
    goodEvening:"Buenas noches", goodNight:"Buenas noches",
    brandAssistant:"Asistente de Marca", openAIChat:"Empezar a Crear",
    savedAssets:"Archivos Guardados", brandCore:"Núcleo de Marca",
    brandCheck:"Verificación", campaigns:"Campañas",
    workspace:"Espacio de trabajo", plan:"Su plan", appearance:"Apariencia", language:"Idioma",
    notifications:"Notificaciones", exportPref:"Exportar", brandReset:"Restablecer Marca",
    themeLabel:"Tema", lightMode:"Modo claro", darkMode:"Modo oscuro",
    accentLabel:"Color de acento",
    accentHelp:"Elige el color de resaltado para botones, estados activos y elementos de interfaz.",
    noItems:"Sin archivos guardados aún",
    createContent:"Genera contenido en AI Chat y guárdalo aquí.",
    welcomeMsg:"¿Cómo puedo apoyar tu marca hoy?",
    createSub:"Elige un tipo de creación para empezar. Tu Brand Core da forma a cada resultado.",
    imageTitle:"Imagen",      imageDesc:"Crea visuales, carteles y diseños para redes sociales.",
    textTitle:"Texto",        textDesc:"Genera leyendas, titulares y textos de marca.",
    campaignTitle:"Campaña",  campaignDesc:"Crea campañas completas con visuales y textos.",
    videoTitle:"Video",       videoDesc:"Crea ideas de vídeo, guiones y conceptos.",
    webTitle:"Web",           webDesc:"Crea páginas de destino y activos web alineados con tu marca.",
    assistantDesc:"Pide a tu IA de marca orientación, ideas y dirección creativa.",
    comingSoon:"Próximamente",
    brandWorkspace:"Espacio de Marca", signOut:"Cerrar sesión",
    dashHeadlinePrefix:"Tu marca está", dashHeadlineHighlight:"lista.",
    dashTagline:"Convirtámosla en contenido, anuncios y crecimiento.",
    dashCreateLabel:"Crear contenido",   dashCreateDesc:"Imágenes, textos, guiones de video y más.",
    dashIdeasLabel:"Explorar ideas",     dashIdeasDesc:"Ideas de contenido, ángulos de anuncios y conceptos.",
    dashCampaignLabel:"Crear campaña",   dashCampaignDesc:"Campañas multicanal completas de principio a fin.",
    dashBrandLabel:"Editar Brand Core",  dashBrandDesc:"Colores, fuentes, tono de voz e identidad.",
    edit:"Editar", setUp:"Configurar", notConfigured:"No configurado",
    buildBrandIdentity:"Construye tu identidad de marca para empezar.",
    setUpBrandCore:"Configura tu Brand Core →",
    createH1Line1:"¿Qué te gustaría", createH1Line2:"crear hoy?",
    brandStudioTitle:"Brand Studio", brandStudioSub:"Todo lo que define y mueve tu marca.",
    studioSavedLabel:"Guardado",    studioSavedDesc:"Todo tu contenido y archivos generados.",
    studioBCDesc:"Colores, fuentes, tono de voz e identidad.",
    studioCheckLabel:"Verificación", studioCheckDesc:"Analiza contenido para consistencia de marca.",
    studioCampDesc:"Gestiona y lanza tus campañas activas.",
    studioBackBtn:"Atrás",
    noBCConfigured:"Sin Brand Core configurado aún",
    noBCConfiguredSub:"Configura tu identidad de marca para desbloquear la generación de IA.",
    aiGenerateBtn:"Generar con IA", manualSetupBtn:"Configuración manual",
    savedAssetsHeader:"Archivos guardados", openAIChatBtn:"Abrir AI Chat",
    noCampaignsTitle:"Sin campañas aún",
    noCampaignsSub:"Agrupa archivos guardados en conceptos de campaña visual.",
    newCampaignBtn:"+ Nueva campaña",
    dropImageTitle:"Suelta tu imagen aquí", dropImageSub:"PNG, JPG o WEBP — arrastra o haz clic para explorar",
    checkBrandNoImgBtn:"Verificar marca sin imagen", readyForCheck:"Listo para verificación de marca",
    runBrandCheckBtn:"Ejecutar verificación", resetBtn:"Resetear", removeBtn:"Eliminar",
    analyzingBrand:"Analizando consistencia de marca...", checkingDetails:"Verificando colores, tipografía y estilo visual",
    ideasTitle:"Ideas", ideasSub:"Marcos probados para inspirar tu próximo contenido.",
    contentIdeasLabel:"Ideas de Contenido",   contentIdeasDesc:"Posts, historias y formatos que construyen audiencias.",
    adAnglesLabel:"Ángulos de Anuncios",      adAnglesDesc:"Marcos de mensajería que convierten atención en acción.",
    visualStylesLabel:"Estilos Visuales",     visualStylesDesc:"Direcciones estéticas para la identidad visual de tu marca.",
    campaignConceptsLabel:"Conceptos de Campaña", campaignConceptsDesc:"Estructuras completas que generan resultados reales.",
    idContentTitle:"Ideas de Contenido", idAnglesTitle:"Ángulos de Anuncios",
    idVisualTitle:"Estilos Visuales",    idCampaignTitle:"Conceptos de Campaña",
    idContentUseLabel:"Usar esta idea",       idContentGenLabel:"Generar publicación",
    idAnglesUseLabel:"Probar este ángulo",    idAnglesGenLabel:"Generar anuncio",
    idVisualUseLabel:"Usar este estilo",      idVisualGenLabel:"Generar visual",
    idCampaignUseLabel:"Construir esta campaña", idCampaignGenLabel:"Generar recursos",
    idCont0Label:"Posts Educativos",     idCont1Label:"Spotlight del Producto",
    idCont2Label:"Historia del Fundador",idCont3Label:"Historia de Transformación",
    idCont4Label:"Resultado de Cliente", idCont5Label:"Post de Comparación",
    idCont6Label:"Mito vs. Realidad",   idCont7Label:"Antes / Después",
    idCont8Label:"Rutina / Flujo de Trabajo", idCont9Label:"Constructor de Autoridad",
    idAng0Label:"Problema → Solución",  idAng1Label:"Aspiración",
    idAng2Label:"Transformación",        idAng3Label:"Urgencia",
    idAng4Label:"Escasez",               idAng5Label:"Agitación del Punto de Dolor",
    idAng6Label:"Prueba Social",         idAng7Label:"Posicionamiento Premium",
    idAng8Label:"Beneficio Primero",     idAng9Label:"Gancho Emocional",
    idVis0Label:"Lujo Minimal",          idVis1Label:"Moderno Audaz",
    idVis2Label:"Premium Oscuro",        idVis3Label:"Estilo de Vida Suave",
    idVis4Label:"Editorial Limpio",      idVis5Label:"Alto Contraste",
    idVis6Label:"Futurista Elegante",    idVis7Label:"Orgánico Natural",
    idVis8Label:"Deportivo de Rendimiento", idVis9Label:"Elegante Femenino",
    idCamp0Label:"Lanzamiento de Producto", idCamp1Label:"Reconocimiento de Marca",
    idCamp2Label:"Lanzamiento Estacional",  idCamp3Label:"Impulso de Conversión",
    idCamp4Label:"Embudo Educativo",        idCamp5Label:"Secuencia de Retargeting",
    idCamp6Label:"Sprint de Oferta Limitada", idCamp7Label:"Campaña del Fundador",
    idCamp8Label:"Impulsada por Testimonios", idCamp9Label:"Campaña Comunitaria",
    teamTitle:"Equipo", teamSub:"Gestiona el equipo de tu espacio de trabajo Business.",
    settingsTitle:"Ajustes", settingsSub:"Gestiona tu espacio de trabajo y preferencias.",
    spWorkspaceSub:"Gestiona los detalles y preferencias de tu espacio de trabajo de marca.",
    wsNameLabel:"Nombre del espacio de trabajo",
    wsNameHelp:"Este es el nombre de tu espacio de trabajo en ORIVEN. Aparece en tu barra lateral y en toda la app.",
    saveBtn:"Guardar",
    brandLockLabel:"Bloqueo de Marca", lockBCLabel:"Bloquear BrandCore",
    lockBCSub:"Cuando está activado, tu BrandCore permanece fijo y se aplica de forma consistente.",
    spAppearanceSub:"Elige cómo se ve y siente ORIVEN. Tu preferencia se guarda entre sesiones.",
    spLanguageSub:"Establece el idioma de visualización y generación de contenido para tu espacio de trabajo.",
    langDisplayLabel:"Idioma de visualización y generación",
    langDisplayHelp:"ORIVEN usará este idioma para etiquetas de interfaz y al generar contenido con tu BrandCore.",
    spNotificationsSub:"Controla las notificaciones en la app. Los cambios se guardan inmediatamente.",
    notifBrandCheckLabel:"Alertas de verificación de marca",
    notifBrandCheckSub:"Muestra una notificación cuando tu puntuación de marca baje del 70%.",
    notifGenCompleteLabel:"Generación completa",
    notifGenCompleteSub:"Notifícate cuando la IA termine de generar contenido.",
    notifUpdatesLabel:"Actualizaciones del producto",
    notifUpdatesSub:"Recibe anuncios en la app sobre nuevas funciones y mejoras de ORIVEN.",
    spExportTitle:"Preferencias de exportación", spExportSub:"Controla cómo se prepara tu contenido generado para exportar.",
    expFormatLabel:"Formato de exportación predeterminado",
    expFormatHelp:"Elige el formato de archivo predeterminado al descargar recursos generados.",
    autoSaveLabel:"Guardar automáticamente el contenido generado",
    autoSaveSub:"Guarda automáticamente los cambios y el contenido generado en Studio.",
    spDangerSub:"Acciones permanentes — no se pueden deshacer.",
    resetBCTitle:"Resetear Brand Core", resetBCBtn:"Resetear Brand Core",
    builderResultLabel:"Resultado", regenerateBtn:"Regenerar", saveToStudioBtn:"Guardar en Studio"
  },

  pt:{
    dashboard:"Painel", create:"Criar", studio:"Estúdio",
    inspiration:"Inspiração", settings:"Configurações",
    goodMorning:"Bom dia", goodAfternoon:"Boa tarde",
    goodEvening:"Boa noite", goodNight:"Boa noite",
    brandAssistant:"Assistente de Marca", openAIChat:"Começar a Criar",
    savedAssets:"Arquivos Salvos", brandCore:"Núcleo da Marca",
    brandCheck:"Verificação", campaigns:"Campanhas",
    workspace:"Espaço de trabalho", plan:"Seu plano", appearance:"Aparência", language:"Idioma",
    notifications:"Notificações", exportPref:"Exportar", brandReset:"Redefinir Marca",
    themeLabel:"Tema", lightMode:"Modo claro", darkMode:"Modo escuro",
    accentLabel:"Cor de destaque",
    accentHelp:"Escolha a cor de realce usada em botões, estados ativos e elementos de interface.",
    noItems:"Nenhum arquivo salvo ainda",
    createContent:"Gere conteúdo no AI Chat e salve aqui.",
    welcomeMsg:"Como posso apoiar sua marca hoje?",
    createSub:"Escolha um tipo de criação para começar. Seu Brand Core molda cada resultado.",
    imageTitle:"Imagem",      imageDesc:"Crie visuais, pôsteres e designs para redes sociais.",
    textTitle:"Texto",        textDesc:"Gere legendas, manchetes e textos de marca.",
    campaignTitle:"Campanha", campaignDesc:"Crie campanhas completas com visuais e textos.",
    videoTitle:"Vídeo",       videoDesc:"Crie ideias de vídeo, roteiros e conceitos.",
    webTitle:"Web",           webDesc:"Crie landing pages e ativos web alinhados à marca.",
    assistantDesc:"Peça à sua IA de marca orientação, ideias e direção criativa.",
    comingSoon:"Em breve",
    brandWorkspace:"Espaço de Marca", signOut:"Sair",
    dashHeadlinePrefix:"Sua marca está", dashHeadlineHighlight:"pronta.",
    dashTagline:"Vamos transformá-la em conteúdo, anúncios e crescimento.",
    dashCreateLabel:"Criar conteúdo",   dashCreateDesc:"Imagens, textos, roteiros de vídeo e mais.",
    dashIdeasLabel:"Explorar ideias",   dashIdeasDesc:"Ideias de conteúdo, ângulos de anúncios e conceitos.",
    dashCampaignLabel:"Criar campanha", dashCampaignDesc:"Campanhas multicanal completas do início ao fim.",
    dashBrandLabel:"Editar Brand Core", dashBrandDesc:"Cores, fontes, tom de voz e identidade.",
    edit:"Editar", setUp:"Configurar", notConfigured:"Não configurado",
    buildBrandIdentity:"Construa sua identidade de marca para começar.",
    setUpBrandCore:"Configure seu Brand Core →",
    createH1Line1:"O que você gostaria de", createH1Line2:"criar hoje?",
    brandStudioTitle:"Brand Studio", brandStudioSub:"Tudo que define e impulsiona sua marca.",
    studioSavedLabel:"Salvo",       studioSavedDesc:"Todo seu conteúdo e arquivos gerados.",
    studioBCDesc:"Cores, fontes, tom de voz e identidade.",
    studioCheckLabel:"Verificação", studioCheckDesc:"Analise conteúdo para consistência de marca.",
    studioCampDesc:"Gerencie e lance suas campanhas ativas.",
    studioBackBtn:"Voltar",
    noBCConfigured:"Sem Brand Core configurado ainda",
    noBCConfiguredSub:"Configure sua identidade de marca para desbloquear a geração de IA.",
    aiGenerateBtn:"Gerar com IA", manualSetupBtn:"Configuração manual",
    savedAssetsHeader:"Arquivos salvos", openAIChatBtn:"Abrir AI Chat",
    noCampaignsTitle:"Sem campanhas ainda",
    noCampaignsSub:"Agrupe arquivos salvos em conceitos de campanha visual.",
    newCampaignBtn:"+ Nova campanha",
    dropImageTitle:"Solte sua imagem aqui", dropImageSub:"PNG, JPG ou WEBP — arraste ou clique para navegar",
    checkBrandNoImgBtn:"Verificar marca sem imagem", readyForCheck:"Pronto para verificação de marca",
    runBrandCheckBtn:"Executar verificação", resetBtn:"Resetar", removeBtn:"Remover",
    analyzingBrand:"Analisando consistência de marca...", checkingDetails:"Verificando cores, tipografia e estilo visual",
    ideasTitle:"Ideias", ideasSub:"Estruturas comprovadas para inspirar seu próximo conteúdo.",
    contentIdeasLabel:"Ideias de Conteúdo",    contentIdeasDesc:"Posts, histórias e formatos que constroem audiências.",
    adAnglesLabel:"Ângulos de Anúncios",       adAnglesDesc:"Estruturas de mensagem que convertem atenção em ação.",
    visualStylesLabel:"Estilos Visuais",       visualStylesDesc:"Direções estéticas para a identidade visual da sua marca.",
    campaignConceptsLabel:"Conceitos de Campanha", campaignConceptsDesc:"Estruturas completas que geram resultados reais.",
    idContentTitle:"Ideias de Conteúdo", idAnglesTitle:"Ângulos de Anúncios",
    idVisualTitle:"Estilos Visuais",     idCampaignTitle:"Conceitos de Campanha",
    idContentUseLabel:"Usar esta ideia",       idContentGenLabel:"Gerar publicação",
    idAnglesUseLabel:"Testar este ângulo",     idAnglesGenLabel:"Gerar anúncio",
    idVisualUseLabel:"Usar este estilo",       idVisualGenLabel:"Gerar visual",
    idCampaignUseLabel:"Construir esta campanha", idCampaignGenLabel:"Gerar recursos",
    idCont0Label:"Posts Educativos",     idCont1Label:"Destaque do Produto",
    idCont2Label:"História do Fundador", idCont3Label:"História de Transformação",
    idCont4Label:"Resultado do Cliente", idCont5Label:"Post de Comparação",
    idCont6Label:"Mito vs. Verdade",     idCont7Label:"Antes / Depois",
    idCont8Label:"Rotina / Fluxo de Trabalho", idCont9Label:"Construtor de Autoridade",
    idAng0Label:"Problema → Solução",   idAng1Label:"Aspiração",
    idAng2Label:"Transformação",         idAng3Label:"Urgência",
    idAng4Label:"Escassez",              idAng5Label:"Agitação do Ponto de Dor",
    idAng6Label:"Prova Social",          idAng7Label:"Posicionamento Premium",
    idAng8Label:"Benefício Primeiro",    idAng9Label:"Gancho Emocional",
    idVis0Label:"Luxo Minimal",          idVis1Label:"Moderno Audacioso",
    idVis2Label:"Premium Escuro",        idVis3Label:"Estilo de Vida Suave",
    idVis4Label:"Editorial Limpo",       idVis5Label:"Alto Contraste",
    idVis6Label:"Futurista Elegante",    idVis7Label:"Orgânico Natural",
    idVis8Label:"Esportivo de Desempenho", idVis9Label:"Elegante Feminino",
    idCamp0Label:"Lançamento de Produto", idCamp1Label:"Reconhecimento de Marca",
    idCamp2Label:"Lançamento Sazonal",    idCamp3Label:"Impulso de Conversão",
    idCamp4Label:"Funil Educativo",       idCamp5Label:"Sequência de Retargeting",
    idCamp6Label:"Sprint de Oferta Limitada", idCamp7Label:"Campanha do Fundador",
    idCamp8Label:"Impulsada por Depoimentos", idCamp9Label:"Campanha Comunitária",
    teamTitle:"Equipe", teamSub:"Gerencie a equipe do seu espaço de trabalho Business.",
    settingsTitle:"Configurações", settingsSub:"Gerencie seu espaço de trabalho e preferências.",
    spWorkspaceSub:"Gerencie os detalhes e preferências do seu espaço de trabalho de marca.",
    wsNameLabel:"Nome do espaço de trabalho",
    wsNameHelp:"Este é o nome do seu espaço de trabalho no ORIVEN. Aparece na barra lateral e em toda a app.",
    saveBtn:"Salvar",
    brandLockLabel:"Bloqueio de Marca", lockBCLabel:"Bloquear BrandCore",
    lockBCSub:"Quando ativado, seu BrandCore permanece fixo e é aplicado de forma consistente.",
    spAppearanceSub:"Escolha como o ORIVEN parece e se sente. Sua preferência é salva entre sessões.",
    spLanguageSub:"Defina o idioma de exibição e geração de conteúdo para seu espaço de trabalho.",
    langDisplayLabel:"Idioma de exibição e geração",
    langDisplayHelp:"O ORIVEN usará este idioma para rótulos de interface e ao gerar conteúdo com seu BrandCore.",
    spNotificationsSub:"Controle notificações no app. As alterações são salvas imediatamente.",
    notifBrandCheckLabel:"Alertas de verificação de marca",
    notifBrandCheckSub:"Mostra uma notificação quando sua pontuação de marca cair abaixo de 70%.",
    notifGenCompleteLabel:"Geração completa",
    notifGenCompleteSub:"Notifique-se quando a IA terminar de gerar conteúdo.",
    notifUpdatesLabel:"Atualizações do produto",
    notifUpdatesSub:"Receba anúncios no app sobre novos recursos e melhorias do ORIVEN.",
    spExportTitle:"Preferências de exportação", spExportSub:"Controle como seu conteúdo gerado é preparado para exportação.",
    expFormatLabel:"Formato de exportação padrão",
    expFormatHelp:"Escolha o formato de arquivo padrão ao baixar recursos gerados.",
    autoSaveLabel:"Salvar automaticamente o conteúdo gerado",
    autoSaveSub:"Salve automaticamente as alterações e o conteúdo gerado no Studio.",
    spDangerSub:"Ações permanentes — não podem ser desfeitas.",
    resetBCTitle:"Redefinir Brand Core", resetBCBtn:"Redefinir Brand Core",
    builderResultLabel:"Resultado", regenerateBtn:"Regenerar", saveToStudioBtn:"Salvar no Studio"
  },

  de:{
    dashboard:"Dashboard", create:"Erstellen", studio:"BrandCore",
    inspiration:"Inspiration", settings:"Einstellungen",
    goodMorning:"Guten Morgen", goodAfternoon:"Guten Nachmittag",
    goodEvening:"Guten Abend", goodNight:"Gute Nacht",
    brandAssistant:"Marken-Assistent", openAIChat:"Erstellen beginnen",
    savedAssets:"Gespeicherte Dateien", brandCore:"Markenkern",
    brandCheck:"Markenprüfung", campaigns:"Kampagnen",
    workspace:"Arbeitsbereich", plan:"Ihr Plan", appearance:"Erscheinungsbild", language:"Sprache",
    notifications:"Benachrichtigungen", exportPref:"Exportieren", brandReset:"Marke zurücksetzen",
    themeLabel:"Thema", lightMode:"Heller Modus", darkMode:"Dunkler Modus",
    accentLabel:"Akzentfarbe",
    accentHelp:"Wähle die Hervorhebungsfarbe für Schaltflächen, aktive Zustände und UI-Elemente.",
    noItems:"Noch keine gespeicherten Dateien",
    createContent:"Erstelle Inhalte im AI Chat und speichere sie hier.",
    welcomeMsg:"Wie kann ich Ihre Marke heute unterstützen?",
    createSub:"Wähle einen Erstellungstyp. Dein Brand Core beeinflusst jeden Output.",
    imageTitle:"Bild",          imageDesc:"Erstelle Visuals, Poster und Social-Media-Designs.",
    textTitle:"Text",           textDesc:"Erstelle Bildunterschriften, Überschriften und Markentexte.",
    campaignTitle:"Kampagne",   campaignDesc:"Erstelle vollständige Kampagnen mit Visuals und Texten.",
    videoTitle:"Video",         videoDesc:"Erstelle Videoideen, Skripte und Konzepte.",
    webTitle:"Web",             webDesc:"Erstelle markengerechte Landing Pages und Web-Assets.",
    assistantDesc:"Frag deine Marken-KI um Anleitung, Ideen und kreative Richtung.",
    comingSoon:"Demnächst",
    brandWorkspace:"Marken-Arbeitsbereich", signOut:"Abmelden",
    dashHeadlinePrefix:"Deine Marke ist", dashHeadlineHighlight:"bereit.",
    dashTagline:"Verwandeln wir sie in Content, Anzeigen und Wachstum.",
    dashCreateLabel:"Inhalt erstellen",  dashCreateDesc:"Bilder, Texte, Videoskripte und mehr.",
    dashIdeasLabel:"Ideen erkunden",     dashIdeasDesc:"Content-Ideen, Anzeigenwinkel und Kampagnenkonzepte.",
    dashCampaignLabel:"Kampagne erstellen", dashCampaignDesc:"Vollständige Multi-Channel-Kampagnen von Anfang bis Ende.",
    dashBrandLabel:"Brand Core bearbeiten", dashBrandDesc:"Farben, Schriften, Tonalität und Identität.",
    edit:"Bearbeiten", setUp:"Einrichten", notConfigured:"Nicht konfiguriert",
    buildBrandIdentity:"Baue deine Markenidentität auf, um zu beginnen.",
    setUpBrandCore:"Brand Core einrichten →",
    createH1Line1:"Was möchtest du heute", createH1Line2:"erstellen?",
    brandStudioTitle:"Brand Studio", brandStudioSub:"Alles, was deine Marke definiert und antreibt.",
    studioSavedLabel:"Gespeichert", studioSavedDesc:"All deine generierten Inhalte und Dateien.",
    studioBCDesc:"Farben, Schriften, Tonalität und Identität.",
    studioCheckLabel:"Markenprüfung", studioCheckDesc:"Analysiere Inhalte auf Markenkonsistenz.",
    studioCampDesc:"Verwalte und starte deine aktiven Kampagnen.",
    studioBackBtn:"Zurück",
    noBCConfigured:"Noch kein Brand Core konfiguriert",
    noBCConfiguredSub:"Richte deine Markenidentität ein, um KI-Generierung freizuschalten.",
    aiGenerateBtn:"KI generieren", manualSetupBtn:"Manuelle Einrichtung",
    savedAssetsHeader:"Gespeicherte Dateien", openAIChatBtn:"AI Chat öffnen",
    noCampaignsTitle:"Noch keine Kampagnen",
    noCampaignsSub:"Bündele gespeicherte Dateien in visuellen Kampagnenkonzepten.",
    newCampaignBtn:"+ Neue Kampagne",
    dropImageTitle:"Bild hier ablegen", dropImageSub:"PNG, JPG oder WEBP — ziehen oder klicken zum Durchsuchen",
    checkBrandNoImgBtn:"Marke ohne Bild prüfen", readyForCheck:"Bereit für Markenprüfung",
    runBrandCheckBtn:"Markenprüfung starten", resetBtn:"Zurücksetzen", removeBtn:"Entfernen",
    analyzingBrand:"Markenkonsistenz analysieren...", checkingDetails:"Farben, Typografie und visuellen Stil prüfen",
    ideasTitle:"Ideen", ideasSub:"Bewährte Frameworks für deinen nächsten Inhalt.",
    contentIdeasLabel:"Content-Ideen",     contentIdeasDesc:"Posts, Storys und Formate, die Zielgruppen aufbauen.",
    adAnglesLabel:"Anzeigenwinkel",        adAnglesDesc:"Botschafts-Frameworks, die Aufmerksamkeit in Aktion umwandeln.",
    visualStylesLabel:"Visuelle Stile",    visualStylesDesc:"Ästhetische Richtungen für deine Markenidentität.",
    campaignConceptsLabel:"Kampagnenkonzepte", campaignConceptsDesc:"End-to-End-Strukturen, die echte Ergebnisse liefern.",
    idContentTitle:"Content-Ideen",    idAnglesTitle:"Anzeigenwinkel",
    idVisualTitle:"Visuelle Stile",    idCampaignTitle:"Kampagnenkonzepte",
    idContentUseLabel:"Diese Idee nutzen",      idContentGenLabel:"Beitrag erstellen",
    idAnglesUseLabel:"Diesen Winkel ausprobieren", idAnglesGenLabel:"Anzeige erstellen",
    idVisualUseLabel:"Diesen Stil nutzen",      idVisualGenLabel:"Visual erstellen",
    idCampaignUseLabel:"Diese Kampagne aufbauen", idCampaignGenLabel:"Assets erstellen",
    idCont0Label:"Bildungsinhalt",       idCont1Label:"Produkt-Spotlight",
    idCont2Label:"Gründergeschichte",    idCont3Label:"Transformationsgeschichte",
    idCont4Label:"Kundenergebnis",       idCont5Label:"Vergleichspost",
    idCont6Label:"Mythos vs. Wahrheit",  idCont7Label:"Vorher / Nachher",
    idCont8Label:"Routine / Arbeitsablauf", idCont9Label:"Autorität aufbauen",
    idAng0Label:"Problem → Lösung",     idAng1Label:"Aspiration",
    idAng2Label:"Transformation",        idAng3Label:"Dringlichkeit",
    idAng4Label:"Knappheit",             idAng5Label:"Schmerzpunkt-Agitation",
    idAng6Label:"Sozialer Beweis",       idAng7Label:"Premium-Positionierung",
    idAng8Label:"Nutzen zuerst",         idAng9Label:"Emotionaler Aufhänger",
    idVis0Label:"Luxus Minimal",         idVis1Label:"Modern und Kühn",
    idVis2Label:"Dunkel Premium",        idVis3Label:"Sanfter Lifestyle",
    idVis4Label:"Editorial Clean",       idVis5Label:"Hoher Kontrast",
    idVis6Label:"Futuristisch-Schlank",  idVis7Label:"Organisch-Natürlich",
    idVis8Label:"Sportliche Performance",idVis9Label:"Elegant-Feminin",
    idCamp0Label:"Produkteinführung",    idCamp1Label:"Markenbekanntheit",
    idCamp2Label:"Saisonaler Drop",      idCamp3Label:"Konversions-Push",
    idCamp4Label:"Bildungs-Funnel",      idCamp5Label:"Retargeting-Sequenz",
    idCamp6Label:"Limitiertes Angebot",  idCamp7Label:"Gründer-Kampagne",
    idCamp8Label:"Testimonial-getrieben",idCamp9Label:"Community-Kampagne",
    teamTitle:"Team", teamSub:"Verwalte dein Business-Workspace-Team.",
    settingsTitle:"Einstellungen", settingsSub:"Verwalte deinen Arbeitsbereich und deine Einstellungen.",
    spWorkspaceSub:"Verwalte die Details und Einstellungen deines Marken-Arbeitsbereichs.",
    wsNameLabel:"Name des Arbeitsbereichs",
    wsNameHelp:"Dies ist der Name deines Arbeitsbereichs in ORIVEN. Er erscheint in deiner Seitenleiste und in der gesamten App.",
    saveBtn:"Speichern",
    brandLockLabel:"Marken-Sperre", lockBCLabel:"BrandCore sperren",
    lockBCSub:"Wenn aktiviert, bleibt dein BrandCore fest und wird konsistent auf alle generierten Inhalte angewendet.",
    spAppearanceSub:"Wähle, wie ORIVEN aussieht und sich anfühlt. Deine Einstellung wird gespeichert.",
    spLanguageSub:"Lege die Anzeige- und Inhaltssprache für deinen Arbeitsbereich fest.",
    langDisplayLabel:"Anzeige- und Generierungssprache",
    langDisplayHelp:"ORIVEN verwendet diese Sprache für Interface-Labels und bei der Inhaltsgenerierung mit deinem BrandCore.",
    spNotificationsSub:"Steuere In-App-Benachrichtigungen. Änderungen werden sofort gespeichert.",
    notifBrandCheckLabel:"Markenprüfungs-Benachrichtigungen",
    notifBrandCheckSub:"Zeige eine Benachrichtigung, wenn dein Markenscore unter 70% fällt.",
    notifGenCompleteLabel:"Generierung abgeschlossen",
    notifGenCompleteSub:"Benachrichtige dich, wenn die KI die Inhaltsgenerierung abgeschlossen hat.",
    notifUpdatesLabel:"Produktaktualisierungen",
    notifUpdatesSub:"Erhalte In-App-Ankündigungen zu neuen ORIVEN-Funktionen und Verbesserungen.",
    spExportTitle:"Exporteinstellungen", spExportSub:"Steuere, wie dein generierter Inhalt für den Export vorbereitet wird.",
    expFormatLabel:"Standard-Exportformat",
    expFormatHelp:"Wähle das Standard-Dateiformat beim Herunterladen generierter Assets.",
    autoSaveLabel:"Generierten Inhalt automatisch speichern",
    autoSaveSub:"Speichere Workspace-Änderungen und generierten Inhalt automatisch im Studio.",
    spDangerSub:"Dauerhafte Aktionen — diese können nicht rückgängig gemacht werden.",
    resetBCTitle:"Brand Core zurücksetzen", resetBCBtn:"Brand Core zurücksetzen",
    builderResultLabel:"Ergebnis", regenerateBtn:"Neu generieren", saveToStudioBtn:"In Studio speichern"
  },

  zh:{
    dashboard:"主页", create:"创建", studio:"工作室",
    inspiration:"灵感", settings:"设置",
    goodMorning:"早上好", goodAfternoon:"下午好",
    goodEvening:"晚上好", goodNight:"晚安",
    brandAssistant:"品牌助手", openAIChat:"开始创建",
    savedAssets:"已保存文件", brandCore:"品牌核心",
    brandCheck:"品牌检查", campaigns:"活动",
    workspace:"工作区", plan:"您的方案", appearance:"外观", language:"语言",
    notifications:"通知", exportPref:"导出", brandReset:"重置品牌",
    themeLabel:"主题", lightMode:"浅色模式", darkMode:"深色模式",
    accentLabel:"强调色",
    accentHelp:"选择按钮、活动状态和界面元素使用的高亮颜色。",
    noItems:"暂无已保存文件",
    createContent:"在AI Chat中生成内容并保存到此处。",
    welcomeMsg:"今天我能如何支持您的品牌？",
    createSub:"选择创建类型开始。您的品牌核心塑造每个输出。",
    imageTitle:"图片",    imageDesc:"创建视觉内容、海报和社交媒体设计。",
    textTitle:"文本",     textDesc:"生成标题、说明文字和品牌文案。",
    campaignTitle:"活动", campaignDesc:"构建包含视觉和文案的完整活动。",
    videoTitle:"视频",    videoDesc:"创建视频创意、脚本和概念。",
    webTitle:"网页",      webDesc:"构建品牌一致的落地页和网页资产。",
    assistantDesc:"向您的品牌AI寻求指导、创意和方向。",
    comingSoon:"即将推出",
    brandWorkspace:"品牌工作区", signOut:"退出登录",
    dashHeadlinePrefix:"您的品牌已", dashHeadlineHighlight:"就绪。",
    dashTagline:"让我们将其转化为内容、广告和增长。",
    dashCreateLabel:"创建内容",   dashCreateDesc:"图片、文案、视频脚本等。",
    dashIdeasLabel:"探索创意",    dashIdeasDesc:"内容创意、广告角度和活动概念。",
    dashCampaignLabel:"构建活动", dashCampaignDesc:"从头到尾的完整多渠道活动。",
    dashBrandLabel:"编辑品牌核心", dashBrandDesc:"颜色、字体、语调和品牌标识。",
    edit:"编辑", setUp:"设置", notConfigured:"未配置",
    buildBrandIdentity:"构建您的品牌标识以开始使用。",
    setUpBrandCore:"设置您的品牌核心 →",
    createH1Line1:"您今天想", createH1Line2:"创建什么？",
    brandStudioTitle:"品牌工作室", brandStudioSub:"定义和驱动您品牌的一切。",
    studioSavedLabel:"已保存", studioSavedDesc:"您所有生成的内容和文件。",
    studioBCDesc:"颜色、字体、语调和品牌标识。",
    studioCheckLabel:"品牌检查", studioCheckDesc:"分析内容的品牌一致性。",
    studioCampDesc:"管理和启动您的活跃活动。",
    studioBackBtn:"返回",
    noBCConfigured:"尚未配置品牌核心",
    noBCConfiguredSub:"设置您的品牌标识以解锁AI生成功能。",
    aiGenerateBtn:"AI生成", manualSetupBtn:"手动设置",
    savedAssetsHeader:"已保存文件", openAIChatBtn:"打开AI聊天",
    noCampaignsTitle:"尚无活动",
    noCampaignsSub:"将保存的文件捆绑到视觉活动概念中。",
    newCampaignBtn:"+ 新活动",
    dropImageTitle:"将图片拖放至此", dropImageSub:"PNG、JPG或WEBP — 拖放或点击浏览",
    checkBrandNoImgBtn:"无图片品牌检查", readyForCheck:"准备好进行品牌检查",
    runBrandCheckBtn:"运行品牌检查", resetBtn:"重置", removeBtn:"删除",
    analyzingBrand:"分析品牌一致性...", checkingDetails:"检查颜色、排版和视觉风格",
    ideasTitle:"创意", ideasSub:"经过验证的框架，激发您的下一个内容。",
    contentIdeasLabel:"内容创意",    contentIdeasDesc:"构建受众的帖子、故事和格式。",
    adAnglesLabel:"广告角度",        adAnglesDesc:"将注意力转化为行动的消息框架。",
    visualStylesLabel:"视觉风格",    visualStylesDesc:"品牌视觉标识的美学方向。",
    campaignConceptsLabel:"活动概念",campaignConceptsDesc:"产生真实结果的端到端结构。",
    idContentTitle:"内容创意",    idAnglesTitle:"广告角度",
    idVisualTitle:"视觉风格",     idCampaignTitle:"活动概念",
    idContentUseLabel:"使用此创意",       idContentGenLabel:"生成帖子",
    idAnglesUseLabel:"尝试此角度",        idAnglesGenLabel:"生成广告",
    idVisualUseLabel:"使用此风格",        idVisualGenLabel:"生成视觉",
    idCampaignUseLabel:"构建此活动",      idCampaignGenLabel:"生成素材",
    idCont0Label:"教育帖子",     idCont1Label:"产品聚焦",
    idCont2Label:"创始人故事",   idCont3Label:"转型故事",
    idCont4Label:"客户结果",     idCont5Label:"对比帖子",
    idCont6Label:"神话与真相",   idCont7Label:"前后对比",
    idCont8Label:"日常/工作流",  idCont9Label:"权威建设",
    idAng0Label:"问题→解决方案", idAng1Label:"愿景",
    idAng2Label:"转型",          idAng3Label:"紧迫性",
    idAng4Label:"稀缺性",        idAng5Label:"痛点激化",
    idAng6Label:"社会证明",      idAng7Label:"高端定位",
    idAng8Label:"利益优先",      idAng9Label:"情感钩子",
    idVis0Label:"奢华极简",      idVis1Label:"大胆现代",
    idVis2Label:"暗色高端",      idVis3Label:"柔和生活方式",
    idVis4Label:"编辑清洁",      idVis5Label:"高对比度",
    idVis6Label:"未来简约",      idVis7Label:"有机自然",
    idVis8Label:"运动表现",      idVis9Label:"优雅女性",
    idCamp0Label:"产品发布",     idCamp1Label:"品牌知名度",
    idCamp2Label:"季节性活动",   idCamp3Label:"转化推广",
    idCamp4Label:"教育漏斗",     idCamp5Label:"再营销序列",
    idCamp6Label:"限时冲刺",     idCamp7Label:"创始人主导活动",
    idCamp8Label:"证言驱动",     idCamp9Label:"社区活动",
    teamTitle:"团队", teamSub:"管理您的Business工作区团队。",
    settingsTitle:"设置", settingsSub:"管理您的工作区和偏好。",
    spWorkspaceSub:"管理您的品牌工作区详细信息和偏好。",
    wsNameLabel:"工作区名称",
    wsNameHelp:"这是您在ORIVEN中的工作区名称。它出现在您的侧边栏和整个应用程序中。",
    saveBtn:"保存",
    brandLockLabel:"品牌锁定", lockBCLabel:"锁定BrandCore",
    lockBCSub:"启用后，您的BrandCore保持固定并一致应用于所有生成的内容。",
    spAppearanceSub:"选择ORIVEN的外观和感觉。您的偏好会在会话间保存。",
    spLanguageSub:"为您的工作区设置显示和内容生成语言。",
    langDisplayLabel:"显示和生成语言",
    langDisplayHelp:"ORIVEN将使用此语言显示界面标签并使用您的BrandCore生成内容。",
    spNotificationsSub:"控制应用内通知。更改立即保存。",
    notifBrandCheckLabel:"品牌检查提醒",
    notifBrandCheckSub:"当您的品牌得分低于70%时显示通知。",
    notifGenCompleteLabel:"生成完成",
    notifGenCompleteSub:"当AI完成内容生成时通知您。",
    notifUpdatesLabel:"产品更新",
    notifUpdatesSub:"在应用内接收关于新ORIVEN功能和改进的公告。",
    spExportTitle:"导出偏好", spExportSub:"控制如何为导出准备您的生成内容。",
    expFormatLabel:"默认导出格式",
    expFormatHelp:"选择下载生成素材时的默认文件格式。",
    autoSaveLabel:"自动保存生成的内容",
    autoSaveSub:"自动将您的工作区更改和生成内容保存到Studio。",
    spDangerSub:"永久操作 — 无法撤销。",
    resetBCTitle:"重置品牌核心", resetBCBtn:"重置品牌核心",
    builderResultLabel:"结果", regenerateBtn:"重新生成", saveToStudioBtn:"保存到Studio"
  }
};

function t(key){
  var lang = LANG_STRINGS[CURRENT_LANG] || LANG_STRINGS.en;
  return lang[key] || LANG_STRINGS.en[key] || key;
}

function setLanguage(lang){
  CURRENT_LANG = lang;
  saveSettings({ language: lang });
  applyLanguage();
  var langSel = document.getElementById("langSelect");
  var label   = langSel ? langSel.options[langSel.selectedIndex].text : lang;
  toast("Language saved — " + label);
}

// Central translation applier — processes every [data-i18n] element in the DOM
// plus special cases that can't use data-i18n (sidebar nav, studio tabs, etc.)
function applyLanguage(){
  // ── [data-i18n] elements — covers Create, Settings, and any future elements ──
  document.querySelectorAll("[data-i18n]").forEach(function(el){
    var key = el.getAttribute("data-i18n");
    var str = t(key);
    if(str && str !== key) el.textContent = str;
  });

  // ── Sidebar nav labels ──────────────────────────────────────────────────────
  document.querySelectorAll(".ni span").forEach(function(el){
    var ni   = el.closest(".ni");
    var page = ni ? ni.getAttribute("data-page") : null;
    if(page && t(page) !== page) el.textContent = t(page);
  });

  // ── Settings nav items ──────────────────────────────────────────────────────
  document.querySelectorAll(".snav-item").forEach(function(el){
    var sp = el.getAttribute("data-sp");
    if(sp && t(sp) !== sp) el.textContent = t(sp);
  });

  // ── Studio tabs ─────────────────────────────────────────────────────────────
  var tabMap = { saved:"savedAssets", brandcore:"brandCore", check:"brandCheck", campaigns:"campaigns" };
  document.querySelectorAll(".stab").forEach(function(el){
    var tab = el.getAttribute("data-tab");
    if(tab && tabMap[tab] && t(tabMap[tab]) !== tabMap[tab]) el.textContent = t(tabMap[tab]);
  });

  // ── Dashboard headline (mixed content — rebuilt via JS) ────────────────────
  var hEl = document.getElementById("dashHeadline");
  if(hEl) hEl.innerHTML = t("dashHeadlinePrefix") + ' <span class="dash-hl-grad" id="dashHeadlineWord">' + t("dashHeadlineHighlight") + '</span>';

  // ── Dashboard (snapshot, FAB) ───────────────────────────────────────────────
  if(typeof refreshDash === "function") refreshDash();
  var fabTag = document.getElementById("fabBCTag");
  if(fabTag && S.brandCore) fabTag.textContent = S.brandCore.name + " " + t("brandCore");

  // ── Idea panel — re-render if one is currently open ────────────────────────
  if(typeof idShowPanel === "function" && typeof S !== "undefined" && S._currentIdPanel){
    idShowPanel(S._currentIdPanel);
  }

  // ── Studio empty state ──────────────────────────────────────────────────────
  var emptyTtl = document.querySelector("#assetEmpty .empty-ttl");
  if(emptyTtl) emptyTtl.textContent = t("noItems");
  var emptySub = document.querySelector("#assetEmpty .empty-sub");
  if(emptySub) emptySub.textContent = t("createContent");
}


// ════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════════════════════════════

function toggleNotif(el, key){
  el.classList.toggle("on");
  var patch = {};
  patch[key] = el.classList.contains("on");
  saveSettings(patch);
  toast("Notifications updated");
}


// ════════════════════════════════════════════════════════════════
// INTELLIGENCE
// ════════════════════════════════════════════════════════════════

function toggleAILearning(el){
  el.classList.toggle("on");
  var on = el.classList.contains("on");
  saveSettings({ aiLearning: on });
  _updateHint("hintAILearning", on, "Future personalization active", "No history used for recommendations");
  toast(on ? "AI Learning enabled" : "AI Learning disabled");
}

function toggleBrandConsistency(el){
  el.classList.toggle("on");
  var on = el.classList.contains("on");
  saveSettings({ brandConsistency: on });
  _updateHint("hintBrandConsistency", on, "Maximum brand consistency", "Creative freedom enabled");
  toast(on ? "Brand Consistency Mode on" : "Creative freedom mode on");
}

function getBrandConsistency(){
  return loadSettings().brandConsistency !== false;
}


// ════════════════════════════════════════════════════════════════
// WORKSPACE SETTINGS
// ════════════════════════════════════════════════════════════════

function toggleGenHistory(el){
  el.classList.toggle("on");
  var on = el.classList.contains("on");
  saveSettings({ generationHistory: on });
  _updateHint("hintGenHistory", on, "History is being saved", "Generations are not stored");
  toast(on ? "Generation history enabled" : "Generation history disabled");
}

function toggleAutoSave(el){
  el.classList.toggle("on");
  var on = el.classList.contains("on");
  saveSettings({ autoSave: on });
  _updateHint("hintAutoSave", on, "BrandCore changes are saved automatically", "Save manually required");
  toast(on ? "Auto-save enabled" : "Auto-save disabled — save manually");
}

function setGeneratorView(view){
  saveSettings({ generatorView: view });
  _applyGeneratorView(view);
  toast(view === "compact" ? "Compact view enabled" : "Grid view enabled");
}

function _applyGeneratorView(view){
  var grid = document.querySelector(".cr-grid");
  if(grid) grid.classList.toggle("cr-compact", view === "compact");
  document.querySelectorAll(".view-opt").forEach(function(el){
    el.classList.toggle("active", el.dataset.view === view);
  });
}


// ════════════════════════════════════════════════════════════════
// PLAN MANAGEMENT
// ════════════════════════════════════════════════════════════════

function initPlan(){
  var cfg = loadSettings();
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  // First run: seed the renewal date (30 days from today)
  if(!cfg.planRenewalDate){
    var first = new Date(today);
    first.setMonth(first.getMonth() + 1);
    saveSettings({ planRenewalDate: first.toISOString() });
    cfg = loadSettings();
  }

  // Check if a scheduled plan change is due
  var renewal = new Date(cfg.planRenewalDate);
  renewal.setHours(0, 0, 0, 0);
  if(cfg.pendingPlan && today >= renewal){
    var next = new Date(renewal);
    next.setMonth(next.getMonth() + 1);
    saveSettings({
      currentPlan:     cfg.pendingPlan,
      planRenewalDate: next.toISOString(),
      pendingPlan:     null,
      pendingPlanDate: null
    });
    cfg = loadSettings();
  }

  // Always sync the sidebar label on page load
  _updateSidebarPlan(cfg.currentPlan || "free");
  renderPlanPanel();
}

async function switchPlan(planId){
  var cfg = loadSettings();
  if(planId === cfg.currentPlan){
    toast("You're already on this plan", "warn");
    return;
  }
  if(cfg.pendingPlan === planId){
    toast("This change is already scheduled", "warn");
    return;
  }

  var planData = ORIVEN_PLAN_LIST.find(function(p){ return p.id === planId; });
  var name = planData ? planData.name : planId;

  // Disable buttons during async call
  var btns = document.querySelectorAll('[onclick*="switchPlan"]');
  btns.forEach(function(b){ b.disabled = true; });

  try {
    var sessionResult = await SB.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;

    if(!session){
      // Not authenticated — fall back to localStorage-only scheduling
      saveSettings({ pendingPlan: planId, pendingPlanDate: cfg.planRenewalDate });
      renderPlanPanel();
      toast("Scheduled: " + name + " starts " + _formatPlanDate(cfg.planRenewalDate));
      return;
    }

    // Unsubscribed → paid: use Stripe checkout instead of schedule-plan-change
    if(!ORIVEN_PLANS[cfg.currentPlan] && ORIVEN_PLANS[planId]){
      if(typeof selectPlan === "function") selectPlan(planId);
      return;
    }

    var planResult = await apiFetch("/api/schedule-plan-change", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.access_token
      },
      body: JSON.stringify({ plan: planId })
    });
    var data = planResult.data;

    if(!planResult.ok) throw new Error(data.error || "Server error");

    if(data.requiresCheckout){
      if(typeof selectPlan === "function") selectPlan(planId);
      return;
    }

    // Apply server response to local state
    if(data.subscription_status){
      // Plan was applied immediately (no active Stripe sub or fallback path)
      if(typeof S !== "undefined" && S) S.currentPlan = data.subscription_status;
      saveSettings({
        currentPlan:     data.subscription_status,
        pendingPlan:     null,
        pendingPlanDate: null
      });
      if(typeof invalidatePlanCache === "function") invalidatePlanCache();
      renderPlanPanel();
      if(typeof _renderPaywallCards === "function") _renderPaywallCards();
      toast(name + " plan is now active");
    } else {
      saveSettings({
        pendingPlan:     data.pending_plan     || planId,
        pendingPlanDate: data.pending_plan_date || cfg.planRenewalDate
      });
      renderPlanPanel();
      toast("Scheduled: " + name + " starts " + _formatPlanDate(data.pending_plan_date || cfg.planRenewalDate));
    }

  } catch(err){
    console.error("[Plan] switchPlan error:", err.message);
    toast("Could not schedule plan change — please try again", "err");
  } finally {
    btns.forEach(function(b){ b.disabled = false; });
  }
}

async function cancelPlanChange(){
  saveSettings({ pendingPlan: null, pendingPlanDate: null });
  renderPlanPanel();
  toast("Scheduled change cancelled");

  // Best-effort backend sync
  try {
    var sessionResult = await SB.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if(!session) return;
    await fetch(API_BASE_URL+"/api/cancel-plan-change", {
      method: "POST",
      headers: { "Authorization": "Bearer " + session.access_token }
    });
  } catch(err){
    console.warn("[Plan] cancelPlanChange backend sync failed:", err.message);
  }
}

function renderPlanPanel(){
  var container = document.getElementById("planPanelContent");
  if(!container) return;

  var cfg         = loadSettings();
  // S.currentPlan (live session state) is authoritative — it's written by the auth
  // sync immediately after login and is always at least as fresh as localStorage.
  var currentId   = (typeof S !== "undefined" && S && S.currentPlan) ? S.currentPlan : (cfg.currentPlan || "free");
  var pendingId   = (typeof S !== "undefined" && S && S.pendingPlan !== undefined) ? S.pendingPlan : (cfg.pendingPlan || null);
  var renewalStr  = _formatPlanDate(cfg.planRenewalDate);
  var currentData = ORIVEN_PLAN_LIST.find(function(p){ return p.id === currentId; });
  var currentRank = ORIVEN_PLAN_LIST.findIndex(function(p){ return p.id === currentId; });

  // Keep sidebar label in sync
  _updateSidebarPlan(currentId);

  // ── Status bar ────────────────────────────────────────────────
  var html = '<div class="plan-status-bar">';
  html += '<div class="plan-status-left">';
  html += '<span class="plan-status-badge">' + (currentData ? currentData.name : "No Subscription") + '</span>';
  if(!currentData){
    html += '<span class="plan-status-renew">No active subscription — choose a plan to start creating</span>';
  } else {
    html += '<span class="plan-status-renew">Renews on ' + renewalStr + '</span>';
  }
  html += '</div>';
  if(pendingId){
    var pendingData = ORIVEN_PLAN_LIST.find(function(p){ return p.id === pendingId; });
    var pendingName = pendingData ? pendingData.name : pendingId;
    var pendingDate = _formatPlanDate(cfg.pendingPlanDate || cfg.planRenewalDate);
    var isCancellation = pendingId === "free";
    html += '<div class="plan-status-pending">';
    html += '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" width="13" height="13"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></svg>';
    if(isCancellation){
      html += 'Cancellation scheduled — full access active until <strong>' + pendingDate + '</strong>';
      html += '<button class="plan-cancel-btn" onclick="cancelPlanChange()">Undo Cancellation</button>';
    } else {
      html += 'Scheduled change: <strong>' + pendingName + '</strong> starts ' + pendingDate;
      html += '<button class="plan-cancel-btn" onclick="cancelPlanChange()">Cancel Change</button>';
    }
    html += '</div>';
  }
  html += '</div>';

  // ── Credits usage block ───────────────────────────────────────
  if(currentData){
    var usedCr  = (typeof _getCounts === "function") ? (_getCounts().monthlyCount || 0) : 0;
    var totalCr = currentData.credits || currentData.limit || 0;
    var remCr   = Math.max(0, totalCr - usedCr);
    var pctCr   = totalCr > 0 ? Math.min(100, Math.round((usedCr / totalCr) * 100)) : 0;
    var barClr  = pctCr >= 90 ? "#EF4444" : pctCr >= 70 ? "#F59E0B" : "var(--gm)";
    html += '<div class="plan-credits-block">';
    html +=   '<div class="plan-credits-hd">';
    html +=     '<span class="plan-credits-label">Creative Credits</span>';
    html +=     '<span class="plan-credits-count">' + remCr + ' / ' + totalCr + '</span>';
    html +=   '</div>';
    html +=   '<div class="plan-credits-bar"><div class="plan-credits-fill" style="width:'+pctCr+'%;background:'+barClr+'"></div></div>';
    html +=   '<div class="plan-credits-sub">' + remCr + ' credits remaining · ' + (100 - pctCr) + '% of monthly quota · resets on billing date</div>';
    html += '</div>';
  }

  // ── Paid plan cards (Starter · Premium · Business) ────────────
  var paidPlans = ORIVEN_PAID_PLANS;
  html += '<div class="plan-cards">';
  paidPlans.forEach(function(plan){
    var isCurrent = plan.id === currentId;
    var isPending = plan.id === pendingId;
    var isPopular = !!plan.popular;
    var cls = 'plan-card';
    if(isCurrent)  cls += ' plan-card--current';
    if(isPending)  cls += ' plan-card--pending';
    if(isPopular && !isCurrent && !isPending) cls += ' plan-card--popular';

    html += '<div class="' + cls + '">';
    if(isPopular) html += '<div class="plan-popular-tag">Most Popular</div>';

    html += '<div class="plan-card-head">';
    html += '<span class="plan-card-name">' + plan.name + '</span>';
    if(isCurrent)      html += '<span class="plan-badge plan-badge--current">Current Plan</span>';
    else if(isPending) html += '<span class="plan-badge plan-badge--pending">Scheduled</span>';
    html += '</div>';

    html += '<div class="plan-card-price">';
    html += '<span class="plan-price-num">€' + plan.price + '</span>';
    html += '<span class="plan-price-per">/month</span>';
    html += '</div>';

    html += '<ul class="plan-features">';
    plan.features.forEach(function(f){
      html += '<li><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M2 7.5l3 3 7-6"/></svg>' + f + '</li>';
    });
    html += '</ul>';

    html += '<div class="plan-card-action">';
    if(isCurrent){
      html += '<button class="btn btn-g btn-sm" disabled>Your Current Plan</button>';
    } else if(isPending){
      html += '<button class="btn btn-g btn-sm" disabled>Scheduled</button>';
    } else {
      var planRank  = ORIVEN_PLAN_LIST.findIndex(function(p){ return p.id === plan.id; });
      var actionLabel = planRank > currentRank ? 'Upgrade' : 'Downgrade';
      html += '<button class="btn btn-p btn-sm" onclick="switchPlan(\'' + plan.id + '\')">' + actionLabel + '</button>';
    }
    html += '</div>';

    html += '</div>';
  });
  html += '</div>';

  // ── Cancel Plan section (paid users, no cancellation already pending) ──
  if(currentData && pendingId !== "free"){
    html += '<div class="plan-cancel-section">';
    html += '<div class="plan-cancel-section-info">';
    html += '<div class="plan-cancel-section-title">Cancel Plan</div>';
    html += '<div class="plan-cancel-section-sub">Your access stays active until ' + renewalStr + '. After that, generation access will be disabled.</div>';
    html += '</div>';
    html += '<button class="btn btn-g btn-sm" onclick="_showCancelConfirm()">Cancel Plan</button>';
    html += '</div>';
    html += '<div class="plan-cancel-confirm" id="planCancelConfirm" style="display:none">';
    html += '<div class="plan-cancel-confirm-text">Cancel your <strong>' + (currentData ? currentData.name : "") + '</strong> plan? You\'ll keep full access until <strong>' + renewalStr + '</strong>. After that, generation access will be disabled.</div>';
    html += '<div class="plan-cancel-confirm-btns">';
    html += '<button class="btn btn-danger btn-sm" onclick="switchPlan(\'free\')">Yes, Cancel Plan</button>';
    html += '<button class="btn btn-g btn-sm" onclick="_hideCancelConfirm()">Keep Plan</button>';
    html += '</div>';
    html += '</div>';
  }

  container.innerHTML = html;
}

function _showCancelConfirm(){
  var el = document.getElementById("planCancelConfirm");
  if(el) el.style.display = "";
}

function _hideCancelConfirm(){
  var el = document.getElementById("planCancelConfirm");
  if(el) el.style.display = "none";
}

function _updateSidebarPlan(planId){
  var el = document.getElementById("sbPlanLabel");
  if(!el) return;
  var plan = ORIVEN_PLANS[planId];
  var name = plan ? plan.name : "No Subscription";
  el.textContent = name;
  el.className = "sb-plan-label sb-plan-" + (plan ? planId : "free");
}

function _formatPlanDate(iso){
  if(!iso) return "—";
  var d = new Date(iso);
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}


// ════════════════════════════════════════════════════════════════
// SETTINGS NAV
// ════════════════════════════════════════════════════════════════

function _initSettingsNav(){
  var sNav = document.getElementById("sNav");
  if(!sNav) return;
  sNav.addEventListener("click", function(e){
    var item = e.target.closest(".snav-item");
    if(!item) return;
    document.querySelectorAll(".snav-item").forEach(function(x){ x.classList.remove("active"); });
    document.querySelectorAll(".spanel").forEach(function(x){ x.classList.remove("active"); });
    item.classList.add("active");
    var panel = document.getElementById("sp-" + item.getAttribute("data-sp"));
    if(panel) panel.classList.add("active");
  });
}


// ════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", function(){
  initSettings();
  _initSettingsNav();
  refreshDash();
  renderInspiration();
  renderAssets();
});
