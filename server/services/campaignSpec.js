// ════════════════════════════════════════════════════════════════
// Campaign spec — the complete, platform-specific configuration of a
// campaign, derived from the generated package (pkg) + the business
// profile + the user's own choices, validated against each platform's
// documented requirements, and turned into the exact API payloads.
//
// ONE place for all of it, so what the user reviews in the app, what Oriven
// Chat edits, what Launch checks and what the publish routes send can never
// drift apart:
//
//   buildSpec(pkg, platform, ctx)   → spec   (derived + user overrides)
//   validate(spec, ctx)             → issues [{ level, field, code, message }]
//   applyChanges(pkg, platform, ch) → { pkg, applied, rejected }  (Oriven Chat / review UI)
//   payloads.<platform>.*(spec, ids)→ request bodies (pure, tested)
//
// Storage: everything lives inside the existing campaign package (jsonb,
// browser + /api/campaigns) — no schema change. Fields the existing editors
// already own stay where they are (budget: pkg.<platform>.budget /
// strategy.budgetRecommendation; destination: strategy.landingPageUrl;
// copy: pkg.concepts / pkg.<platform>; Meta placement: pkg.metaAds.placement;
// goal: pkg.strategy.goal). Settings that had no home get one:
// pkg.spec.overrides (countries, languages, ages, pixel, conversion event,
// special ad categories, EU payer/beneficiary, tracking parameters, sitelink
// URLs, extra ad sets). Only the user (review UI or Chat) writes overrides;
// derivation never overwrites them.
//
// Sources: every user-facing setting carries where it came from —
//   'user'    chosen by the user (review UI, Chat, budget dialog)
//   'profile' read from the business profile / saved advertising preference
//   'auto'    a safe technical default chosen by OrivenAI
//   'ai'      written by the AI (copy, keywords, assets)
//   'missing' must be provided before publishing
//
// Platform facts below were checked against the platforms' current
// documentation (October 2026); see the report for sources. Anything that
// could not be verified without a live account is listed in LIVE_UNVERIFIED.
// ════════════════════════════════════════════════════════════════

const campaignGoals = require('./campaignGoals');

const SPEC_VERSION = 1;
const PLATFORMS = ['meta', 'google', 'tiktok', 'pinterest'];
const PK = { google: 'googleAds', meta: 'metaAds', tiktok: 'tiktokAds', pinterest: 'pinterestAds' };
const GOALS = ['Sales', 'Leads', 'Traffic', 'Awareness'];

// ── Countries ──────────────────────────────────────────────────────
// iso: ISO 3166-1 alpha-2. geo: GeoNames id (TikTok location_ids use the
// GeoNames country id — UNVERIFIED without a live account, see
// LIVE_UNVERIFIED). eu: EU member (Meta's DSA payer/beneficiary rule).
// pin: Pinterest ads available (public market list; Pinterest itself is the
// final authority — outside this list we warn, we don't guess).
const COUNTRIES = [
  ['US', 'United States', ['usa', 'u.s.', 'u.s.a.', 'united states of america', 'america', 'verenigde staten'], 6252001, 0, 1],
  ['GB', 'United Kingdom', ['uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'verenigd koninkrijk'], 2635167, 0, 1],
  ['IE', 'Ireland', ['ierland', 'eire'], 2963597, 1, 1],
  ['CA', 'Canada', [], 6251999, 0, 1],
  ['AU', 'Australia', ['australië'], 2077456, 0, 1],
  ['NZ', 'New Zealand', ['nieuw-zeeland'], 2186224, 0, 1],
  ['NL', 'Netherlands', ['the netherlands', 'nederland', 'holland', 'niederlande', 'pays-bas'], 2750405, 1, 1],
  ['BE', 'Belgium', ['belgië', 'belgie', 'belgique', 'belgien'], 2802361, 1, 1],
  ['LU', 'Luxembourg', ['luxemburg'], 2960313, 1, 1],
  ['DE', 'Germany', ['deutschland', 'duitsland', 'allemagne'], 2921044, 1, 1],
  ['AT', 'Austria', ['österreich', 'oostenrijk'], 2782113, 1, 1],
  ['CH', 'Switzerland', ['schweiz', 'suisse', 'svizzera', 'zwitserland'], 2658434, 0, 1],
  ['FR', 'France', ['frankrijk', 'frankreich'], 3017382, 1, 1],
  ['ES', 'Spain', ['españa', 'espana', 'spanje', 'spanien'], 2510769, 1, 1],
  ['IT', 'Italy', ['italia', 'italië', 'italien'], 3175395, 1, 1],
  ['PT', 'Portugal', [], 2264397, 1, 1],
  ['DK', 'Denmark', ['danmark', 'denemarken', 'dänemark'], 2623032, 1, 1],
  ['SE', 'Sweden', ['sverige', 'zweden', 'schweden'], 2661886, 1, 1],
  ['NO', 'Norway', ['norge', 'noorwegen', 'norwegen'], 3144096, 0, 1],
  ['FI', 'Finland', ['suomi', 'finnland'], 660013, 1, 1],
  ['PL', 'Poland', ['polska', 'polen'], 798544, 1, 1],
  ['CZ', 'Czechia', ['czech republic', 'česko', 'cesko', 'tsjechië'], 3077311, 1, 1],
  ['SK', 'Slovakia', ['slovensko'], 3057568, 1, 1],
  ['HU', 'Hungary', ['magyarország', 'hongarije'], 719819, 1, 1],
  ['RO', 'Romania', ['românia', 'roemenië'], 798549, 1, 1],
  ['GR', 'Greece', ['hellas', 'griekenland'], 390903, 1, 1],
  ['MX', 'Mexico', ['méxico'], 3996063, 0, 1],
  ['BR', 'Brazil', ['brasil', 'brazilië'], 3469034, 0, 1],
  ['AR', 'Argentina', [], 3865483, 0, 1],
  ['CL', 'Chile', [], 3895114, 0, 1],
  ['CO', 'Colombia', [], 3686110, 0, 1],
  ['JP', 'Japan', ['日本'], 1861060, 0, 0],
  ['IN', 'India', [], 1269750, 0, 0],
  ['ZA', 'South Africa', ['zuid-afrika'], 953987, 0, 0],
  ['AE', 'United Arab Emirates', ['uae', 'emirates'], 290557, 0, 0],
  ['SG', 'Singapore', [], 1880251, 0, 0],
  ['TR', 'Türkiye', ['turkey', 'turkije'], 298795, 0, 0],
  ['IL', 'Israel', [], 294640, 0, 0],
].map(([iso, name, alt, geo, eu, pin]) => ({ iso, name, alt, geo, eu: !!eu, pin: !!pin }));
const COUNTRY_BY_ISO = Object.fromEntries(COUNTRIES.map((c) => [c.iso, c]));
const EU_EXTRA = ['BG', 'HR', 'CY', 'EE', 'LV', 'LT', 'MT', 'SI']; // EU members not in the table above
const _norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const _COUNTRY_LOOKUP = (() => {
  const m = new Map();
  for (const c of COUNTRIES) { m.set(_norm(c.iso), c.iso); m.set(_norm(c.name), c.iso); for (const a of c.alt) m.set(_norm(a), c.iso); }
  return m;
})();
// Free text → ISO codes. Returns null when ANY part can't be read with
// certainty ("Benelux", a city, a typo): OrivenAI then asks, never guesses.
function parseCountries(input) {
  if (input == null) return null;
  const list = Array.isArray(input) ? input : String(input).split(/,|;|\/|\+|&|\band\b|\ben\b|\bund\b|\bet\b/i);
  const out = [];
  for (const raw of list) {
    const t = _norm(raw).replace(/^the /, '');
    if (!t) continue;
    const iso = _COUNTRY_LOOKUP.get(t) || _COUNTRY_LOOKUP.get('the ' + t);
    if (!iso) return null;
    if (!out.includes(iso)) out.push(iso);
  }
  return out.length ? out : null;
}
const isEu = (iso) => !!((COUNTRY_BY_ISO[iso] && COUNTRY_BY_ISO[iso].eu) || EU_EXTRA.includes(iso));
const countryName = (iso) => (COUNTRY_BY_ISO[iso] ? COUNTRY_BY_ISO[iso].name : iso);

// ── Languages (ISO 639-1) ──────────────────────────────────────────
// googleCode: Google Ads language_constant.code (Hebrew is "iw" there).
const LANGUAGES = {
  en: { name: 'English', alt: ['engels', 'englisch', 'anglais'] },
  nl: { name: 'Dutch', alt: ['nederlands', 'netherlands', 'flemish', 'vlaams', 'niederländisch'] },
  de: { name: 'German', alt: ['deutsch', 'duits', 'allemand'] },
  fr: { name: 'French', alt: ['français', 'francais', 'frans', 'französisch'] },
  es: { name: 'Spanish', alt: ['español', 'espanol', 'spaans', 'spanisch'] },
  it: { name: 'Italian', alt: ['italiano', 'italiaans'] },
  pt: { name: 'Portuguese', alt: ['português', 'portugees'] },
  da: { name: 'Danish', alt: ['dansk', 'deens'] },
  sv: { name: 'Swedish', alt: ['svenska', 'zweeds'] },
  no: { name: 'Norwegian', alt: ['norsk', 'noors'] },
  fi: { name: 'Finnish', alt: ['suomi', 'fins'] },
  pl: { name: 'Polish', alt: ['polski', 'pools'] },
  cs: { name: 'Czech', alt: ['čeština', 'cestina', 'tsjechisch'] },
  el: { name: 'Greek', alt: ['ελληνικά', 'grieks'] },
  hu: { name: 'Hungarian', alt: ['magyar', 'hongaars'] },
  ro: { name: 'Romanian', alt: ['română', 'roemeens'] },
  ja: { name: 'Japanese', alt: ['日本語', 'japans'] },
  tr: { name: 'Turkish', alt: ['türkçe', 'turks'] },
  ar: { name: 'Arabic', alt: ['arabisch'] },
};
const GOOGLE_LANG_CODE = { he: 'iw' };
const _LANG_LOOKUP = (() => {
  const m = new Map();
  for (const [code, l] of Object.entries(LANGUAGES)) { m.set(code, code); m.set(_norm(l.name), code); for (const a of l.alt) m.set(_norm(a), code); }
  return m;
})();
function parseLanguages(input) {
  if (input == null || input === '') return null;
  const list = Array.isArray(input) ? input : String(input).split(/,|;|\/|\+|&|\band\b|\ben\b/i);
  const out = [];
  for (const raw of list) {
    const t = _norm(raw);
    if (!t) continue;
    const code = _LANG_LOOKUP.get(t);
    if (!code) return null;
    if (!out.includes(code)) out.push(code);
  }
  return out.length ? out : null;
}

// ── Platform rules ────────────────────────────────────────────────
// Meta: special ad categories (FINANCIAL_PRODUCTS_SERVICES replaced CREDIT
// in January 2025); any category requires special_ad_category_country.
const META_SPECIAL_CATEGORIES = ['HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES', 'ISSUES_ELECTIONS_POLITICS'];
const META_CONVERSION_EVENTS = ['PURCHASE', 'LEAD', 'COMPLETE_REGISTRATION', 'ADD_TO_CART', 'INITIATED_CHECKOUT', 'CONTACT', 'SUBSCRIBE', 'START_TRIAL', 'SUBMIT_APPLICATION', 'SCHEDULE'];
const META_DEFAULT_EVENT = { Sales: 'PURCHASE', Leads: 'LEAD' };
const META_PLACEMENTS = { automatic: 'Facebook and Instagram (automatic placements)', instagram_only: 'Instagram only', facebook_only: 'Facebook only' };
// Pinterest: SALES → CHECKOUT/ADD_TO_CART, LEADS → SIGNUP/LEAD; a conversion
// tag is required for these events (Pinterest objective-simplification docs).
const PINTEREST_CONVERSION_EVENTS = { Sales: ['CHECKOUT', 'ADD_TO_CART'], Leads: ['LEAD', 'SIGNUP'] };
// TikTok: daily budgets must EXCEED 20 (ad group) / 50 (campaign) in USD
// (TikTok help: "About budgets"). OrivenAI sets the budget on the ad group
// only, so the 20 floor applies; for EUR/GBP the same floor is used.
const TIKTOK_MIN_ADGROUP_DAILY = 20;
const TIKTOK_MIN_CURRENCIES = ['USD', 'EUR', 'GBP'];
// Google text limits (RSA / PMax / Demand Gen docs).
const G = {
  RSA_HEADLINE: 30, RSA_DESCRIPTION: 90, RSA_MIN_H: 3, RSA_MAX_H: 15, RSA_MIN_D: 2, RSA_MAX_D: 4,
  PMAX_LONG_HEADLINE: 90, PMAX_SHORT_DESCRIPTION: 60, BUSINESS_NAME: 25,
  DG_HEADLINE: 40, DG_DESCRIPTION: 90, DG_MAX: 5,
  CALLOUT: 25, SNIPPET_VALUE: 25, SITELINK_TEXT: 25, SITELINK_DESC: 35,
  LANDSCAPE_RATIO: 1.91, RATIO_TOLERANCE: 0.01,
};
const GOOGLE_SNIPPET_HEADERS = ['Amenities', 'Brands', 'Courses', 'Degree programs', 'Destinations', 'Featured hotels', 'Insurance coverage', 'Models', 'Neighborhoods', 'Service catalog', 'Shows', 'Styles', 'Types'];
const GOOGLE_MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'];
const TIKTOK_AGE_GROUPS = [['AGE_18_24', 18, 24], ['AGE_25_34', 25, 34], ['AGE_35_44', 35, 44], ['AGE_45_54', 45, 54], ['AGE_55_100', 55, 100]];

// What each platform/goal combination needs and whether OrivenAI can
// publish it today. An unsupported combination is BLOCKED with a reason —
// never swapped for a different objective.
// Publishable platform capabilities — read from services/createCompat.js,
// the same schema Create (frontend) and /api/ai/create-ad (before charging)
// use, so Create, generation and Launch can never disagree.
const createCompat = require('./createCompat');
const _tiktokBlocked = {};
for (const g of GOALS) if (!createCompat.typeInfo('tiktok').goals.includes(g)) {
  const r = createCompat.REASONS['tiktok_goal_' + g];
  _tiktokBlocked[g] = r ? (r.message + ' ' + r.suggestion).trim() : 'This goal can’t be published to TikTok by OrivenAI yet.';
}
const SUPPORT = {
  meta: { goals: GOALS, video: createCompat.platformSupportsFormat('meta', 'video') },
  google: { types: createCompat.typeKeys('google'), goals: GOALS },
  tiktok: { goals: createCompat.typeInfo('tiktok').goals.slice(), videoRequired: !createCompat.platformSupportsFormat('tiktok', 'image'), blockedGoals: _tiktokBlocked },
  pinterest: { goals: GOALS },
};

// Facts that need a real (test) ad account to confirm — reported, not hidden.
const LIVE_UNVERIFIED = {
  meta: ['Marketing API v25.0 payloads (campaign/ad set/creative/ad) have not been sent to a live ad account yet.'],
  google: ['Search, Performance Max (brand guidelines at campaign level) and Demand Gen payloads have not been sent to a live Google Ads account yet.'],
  tiktok: ['location_ids use GeoNames country ids; video ads (SINGLE_VIDEO) and ad-group-only budgets have not been sent to a live TikTok account yet.'],
  pinterest: ['targeting_spec LOCATION array and SALES/LEADS conversion metadata (optimization_goal_metadata) have not been sent to a live Pinterest account yet.'],
};

// ── helpers ───────────────────────────────────────────────────────
const _str = (v) => (v == null ? '' : String(v)).trim();
const _clone = (o) => JSON.parse(JSON.stringify(o == null ? null : o));
function _num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  const n = m ? parseFloat(m[1]) : null;
  return n && n > 0 ? n : null;
}
function slug(s) { return _norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'campaign'; }
function validUrl(u) {
  u = _str(u);
  if (!u) return 'missing';
  let p; try { p = new URL(u); } catch (_) { return 'invalid'; }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') return 'invalid';
  if (!/\./.test(p.hostname)) return 'invalid';
  return null;
}
function googleType(pkg) { return ((pkg.googleAds || {}).campaignType) || 'SEARCH'; }
function structureOf(pkg) {
  const raw = pkg.campaignStructure
    || (pkg.metaStructure ? { groups: pkg.metaStructure.adSets, adsPerGroup: pkg.metaStructure.adsPerAdSet } : null)
    || { groups: 1, adsPerGroup: 1 };
  return {
    groups: Math.max(1, Math.min(5, parseInt(raw.groups, 10) || 1)),
    adsPerGroup: Math.max(1, Math.min(5, parseInt(raw.adsPerGroup, 10) || 1)),
  };
}
function overridesOf(pkg) {
  const sp = pkg && pkg.spec && typeof pkg.spec === 'object' ? pkg.spec : {};
  return sp.overrides && typeof sp.overrides === 'object' ? sp.overrides : {};
}

// Budget: user-controlled. A value the user set (budget dialog / Chat /
// review) is pkg.<platform>.budget, or for Google strategy.budgetRecommendation
// as an object {amount} (what setBudget writes). The AI's text suggestion
// is shown but never published without the user confirming it.
function budgetOf(pkg, platform) {
  const s = pkg.strategy || {};
  const br = s.budgetRecommendation;
  if (platform === 'google') {
    if (br && typeof br === 'object' && _num(br.amount != null ? br.amount : br.daily)) {
      return { amount: _num(br.amount != null ? br.amount : br.daily), source: 'user', currency: br.currency || null };
    }
  } else {
    const o = pkg[PK[platform]] || {};
    if (_num(o.budget)) return { amount: _num(o.budget), source: 'user', currency: null };
  }
  const suggestion = _num(typeof br === 'object' && br ? (br.amount || br.daily) : br) || _num(s.dailyBudget) || null;
  return { amount: null, suggestion, source: 'missing', currency: null };
}
function destinationOf(pkg, platform, profile) {
  const s = pkg.strategy || {};
  const o = pkg[PK[platform]] || {};
  const field = platform === 'pinterest' ? 'destinationUrl' : 'finalUrl';
  const fromPkg = _str(s.landingPageUrl || o[field] || pkg.websiteUrl || s.websiteUrl);
  if (fromPkg) return { url: fromPkg, source: s.landingPageUrl ? 'user' : 'ai' };
  const site = _str(profile && profile.website);
  if (site) return { url: /^https?:\/\//i.test(site) ? site : 'https://' + site, source: 'profile' };
  return { url: '', source: 'missing' };
}
function imagesOf(pkg, platform) {
  const o = pkg[PK[platform]] || {};
  const vcs = (pkg.visualConcepts || []).filter((v) => v && v.generatedImageUrl);
  const primary = o.imageUrl || (platform === 'meta' ? o.uploadedImageUrl : null) || (vcs[0] && vcs[0].generatedImageUrl) || null;
  const all = Array.from(new Set([primary].concat(vcs.map((v) => v.generatedImageUrl)).filter(Boolean)));
  return { primary, all };
}
function videoOf(pkg, platform) {
  const o = pkg[PK[platform]] || {};
  const v = (Array.isArray(pkg.videoAssets) && pkg.videoAssets.find((x) => x && x.videoUrl)) || null;
  return o.videoUrl || (v && v.videoUrl) || null;
}
// A video Create submitted but that hasn't finished rendering (Create keeps
// it in pkg.videoJobs until the file exists, then moves it to videoAssets).
function videoPendingOf(pkg) {
  return Array.isArray(pkg.videoJobs) && pkg.videoJobs.some((j) => j && (j.videoId || j.ref));
}

// Copy variants per ad, from pkg.concepts first (one per concept, cycled),
// falling back to the platform object — the same order the routes used.
function variantsOf(pkg, platform, campaignName) {
  const o = pkg[PK[platform]] || {};
  const imgs = imagesOf(pkg, platform);
  const vcs = pkg.visualConcepts || [];
  const concepts = Array.isArray(pkg.concepts) ? pkg.concepts : [];
  const out = concepts.map((c) => {
    const copy = (c && c.adCopy) || {};
    const vc = vcs.find((v) => v && c && v.conceptRef === c.angle);
    if (platform === 'tiktok') {
      const hook = (c && (c.hook || copy.headline)) || o.hook || o.opening3Seconds || campaignName;
      const script = copy.primaryText || o.script || '';
      return { headline: _str(hook), primaryText: _str(String(script).replace(/\[[^\]]*\]/g, ' ')), description: '', cta: (c && c.cta) || o.cta || '', imageUrl: (vc && vc.generatedImageUrl) || imgs.primary };
    }
    return {
      headline: _str(copy.headline || o.headline || o.title || campaignName),
      primaryText: _str(copy.primaryText || o.primaryText || o.description || campaignName),
      description: _str(copy.description || (platform === 'meta' ? o.description : '') || ''),
      cta: (c && c.cta) || o.cta || '',
      imageUrl: (vc && vc.generatedImageUrl) || imgs.primary,
    };
  });
  if (!out.length) {
    if (platform === 'tiktok') out.push({ headline: _str(o.hook || o.opening3Seconds || campaignName), primaryText: _str(String(o.script || '').replace(/\[[^\]]*\]/g, ' ')), description: '', cta: o.cta || '', imageUrl: imgs.primary });
    else if (platform === 'pinterest') out.push({ headline: _str(o.title || campaignName), primaryText: _str(o.description || ''), description: '', cta: o.cta || '', imageUrl: imgs.primary });
    else out.push({ headline: _str(o.headline || campaignName), primaryText: _str(o.primaryText || o.description || campaignName), description: _str(o.description || ''), cta: o.cta || '', imageUrl: imgs.primary });
  }
  return out;
}

function goalOf(pkg) {
  const g = campaignGoals.normalizeGoal(pkg.strategy && pkg.strategy.goal);
  return GOALS.includes(g) ? g : 'Traffic';
}

// ── buildSpec ─────────────────────────────────────────────────────
// ctx: { profile, preferences, options } — options are facts fetched from
// the connected ad account (pixels, conversion tags, Instagram account,
// currency, conversion actions); absent = not known (validation says so).
function buildSpec(pkg, platform, ctx) {
  pkg = pkg || {};
  ctx = ctx || {};
  if (!PLATFORMS.includes(platform)) throw new Error('Unknown platform ' + platform);
  const profile = ctx.profile || {};
  const prefs = ctx.preferences || {};
  const opt = ctx.options || {};
  const ov = overridesOf(pkg);
  const o = pkg[PK[platform]] || {};
  const s = pkg.strategy || {};
  const name = _str(pkg.campaignName || s.goal || 'OrivenAI campaign').slice(0, 200);
  const goal = goalOf(pkg);
  const src = {};

  // Countries: user → business profile → saved advertising preference → ask.
  let countries = null;
  if (Array.isArray(ov.countries) && ov.countries.length) { countries = ov.countries.filter((c) => /^[A-Z]{2}$/.test(c)); src.countries = 'user'; }
  if (!countries || !countries.length) { const p = parseCountries(profile.country); if (p) { countries = p; src.countries = 'profile'; } }
  if (!countries || !countries.length) { const p = parseCountries(prefs.adCountries); if (p) { countries = p; src.countries = 'profile'; } }
  if (!countries || !countries.length) { countries = []; src.countries = 'missing'; }

  // Languages: user → business profile → none (all languages; the platform default).
  let languages = null;
  if (Array.isArray(ov.languages)) { languages = ov.languages.filter((l) => LANGUAGES[l]); src.languages = 'user'; }
  if (!languages) { const p = parseLanguages(profile.languages); if (p) { languages = p; src.languages = 'profile'; } }
  if (!languages) { languages = []; src.languages = 'auto'; }

  const ageMin = Number.isInteger(ov.ageMin) ? ov.ageMin : 18;
  const ageMax = Number.isInteger(ov.ageMax) ? ov.ageMax : 65;
  src.age = Number.isInteger(ov.ageMin) || Number.isInteger(ov.ageMax) ? 'user' : 'auto';

  const budget = budgetOf(pkg, platform);
  src.budget = budget.source;
  const dest = destinationOf(pkg, platform, profile);
  src.destinationUrl = dest.source;
  const utm = Object.assign({ source: { meta: 'facebook', google: 'google', tiktok: 'tiktok', pinterest: 'pinterest' }[platform], medium: platform === 'google' ? 'cpc' : 'paid_social', campaign: slug(name) }, ov.utm || {});
  src.utm = ov.utm ? 'user' : 'auto';
  const urlParams = 'utm_source=' + encodeURIComponent(utm.source) + '&utm_medium=' + encodeURIComponent(utm.medium) + '&utm_campaign=' + encodeURIComponent(utm.campaign) + (utm.content ? '&utm_content=' + encodeURIComponent(utm.content) : '');

  const struct = structureOf(pkg);
  const variants = variantsOf(pkg, platform, name);
  const images = imagesOf(pkg, platform);
  const video = videoOf(pkg, platform);

  const spec = {
    version: SPEC_VERSION,
    platform,
    campaignType: platform === 'google' ? googleType(pkg) : 'STANDARD',
    status: 'PAUSED',
    campaign: { name, goal },
    targeting: { countries, languages, ageMin, ageMax },
    budget: { amount: budget.amount, suggestion: budget.suggestion || null, period: 'DAILY', currency: opt.currency || budget.currency || null },
    tracking: { destinationUrl: dest.url, utm, urlParams },
    adGroups: [],
    assets: {},
    suggestions: {
      audienceDescription: _str(s.targetAudience || o.targetAudience) || null,
      retargetingIdea: _str(o.retargetingVariation) || null,
      lookalikeIdea: _str(o.lookalikeVariation) || null,
    },
    sources: src,
    liveUnverified: LIVE_UNVERIFIED[platform],
  };

  // Ad sets / ad groups: the structure chosen in Create (or changed via the
  // review / Chat), each with its own optional name and age range override.
  const groupOv = Array.isArray(ov.adGroups) ? ov.adGroups : [];
  const groups = [];
  let k = 0;
  const totalGroups = struct.groups;
  for (let i = 0; i < totalGroups; i++) {
    const gOv = groupOv[i] || {};
    const ads = [];
    for (let j = 0; j < struct.adsPerGroup; j++) { const v = variants[k % variants.length]; k++; ads.push(Object.assign({ name: '' }, v)); }
    groups.push({
      name: _str(gOv.name) || (name + (totalGroups > 1 ? ' — ' + (platform === 'meta' ? 'Ad set ' : 'Ad group ') + (i + 1) : (platform === 'meta' ? ' — Ad set' : ' — Ad group'))),
      ageMin: Number.isInteger(gOv.ageMin) ? gOv.ageMin : null,
      ageMax: Number.isInteger(gOv.ageMax) ? gOv.ageMax : null,
      ads: ads.map((a, j) => Object.assign(a, { name: (_str(gOv.name) || name) + ' — Ad ' + (j + 1) })),
    });
  }
  spec.adGroups = groups;

  if (platform === 'meta') {
    const placement = ['instagram_only', 'facebook_only'].includes(o.placement) ? o.placement : 'automatic';
    src.placement = o.placement ? 'user' : 'auto';
    // Extra Meta objectives older Create screens offered (Engagement, App
    // Promotion) can't be published: Engagement needs an on-post
    // destination and App Promotion an app id, neither of which OrivenAI
    // sends. Such a package publishes with the standard objective for its
    // goal — and the review says so (validate: objective_unsupported).
    const metaObjKey = o.objective ? campaignGoals.META_OBJECTIVE_MAP[String(o.objective).trim().toLowerCase().replace(/\s+/g, '_')] : null;
    const metaObjUnsupported = !!(o.objective && metaObjKey && !GOALS.includes(metaObjKey));
    if (metaObjUnsupported) spec.unsupportedObjective = String(o.objective);
    const cfg = campaignGoals.getMetaObjective(goal, metaObjUnsupported ? null : o.objective);
    const isDefaultAge = ageMin <= 25 && ageMax === 65;
    const cats = Array.isArray(ov.specialAdCategories) ? ov.specialAdCategories.filter((c) => META_SPECIAL_CATEGORIES.includes(c)) : null;
    src.specialAdCategories = cats ? 'user' : 'missing';
    const needsConversion = goal === 'Sales' || goal === 'Leads';
    // Pixel: never silently chosen. One pixel on the account → selected and
    // shown as automatic; several → the user picks; none → blocked.
    const pixels = Array.isArray(opt.pixels) ? opt.pixels : null;
    let pixelId = ov.pixelId || null;
    if (pixelId) src.pixel = 'user';
    else if (pixels && pixels.length === 1) { pixelId = pixels[0].id; src.pixel = 'auto'; }
    else src.pixel = needsConversion ? 'missing' : 'auto';
    const event = ov.conversionEvent && META_CONVERSION_EVENTS.includes(ov.conversionEvent) ? ov.conversionEvent : (META_DEFAULT_EVENT[goal] || null);
    src.conversionEvent = ov.conversionEvent ? 'user' : 'auto';
    const beneficiary = _str(ov.dsaBeneficiary || profile.company_name);
    const payor = _str(ov.dsaPayor || ov.dsaBeneficiary || profile.company_name);
    src.dsa = ov.dsaBeneficiary || ov.dsaPayor ? 'user' : (profile.company_name ? 'profile' : 'missing');
    spec.campaign.objective = cfg.objective;
    spec.campaign.specialAdCategories = cats || [];
    spec.campaign.specialAdCategoriesConfirmed = !!cats;
    spec.campaign.budgetLevel = 'AD_SET';
    spec.campaign.bidStrategy = 'LOWEST_COST_WITHOUT_CAP';
    spec.optimization = { goal: cfg.optimization_goal, billingEvent: cfg.billing_event, destinationType: goal === 'Awareness' ? null : 'WEBSITE' };
    spec.targeting.placement = placement;
    spec.targeting.placementLabel = META_PLACEMENTS[placement];
    spec.targeting.advantageAudience = isDefaultAge && !(cats && cats.length);
    spec.tracking.needsConversion = needsConversion;
    spec.tracking.pixelId = needsConversion ? pixelId : null;
    spec.tracking.conversionEvent = needsConversion ? event : null;
    spec.identity = { pageId: opt.pageId || null, instagramUserId: opt.instagramUserId || null, instagramUsername: opt.instagramUsername || null };
    spec.compliance = { euTargeted: countries.some(isEu), dsaBeneficiary: beneficiary || null, dsaPayor: payor || null };
    spec.creative = { format: 'IMAGE', imageUrl: images.primary, images: images.all };
  }

  if (platform === 'google') {
    const g = pkg.googleAds || {};
    const type = spec.campaignType;
    const bidCfg = type === 'PERFORMANCE_MAX' ? campaignGoals.GOOGLE_PMAX_GOAL_CONFIG[goal]
      : type === 'DEMAND_GEN' ? campaignGoals.GOOGLE_DEMANDGEN_GOAL_CONFIG[goal]
      : campaignGoals.GOOGLE_GOAL_CONFIG[goal];
    spec.campaign.biddingField = bidCfg ? bidCfg.biddingField : null;
    spec.campaign.biddingValue = bidCfg ? bidCfg.biddingValue : null;
    spec.campaign.bidStrategyLabel = bidCfg ? bidCfg.label : null;
    spec.campaign.euPolitical = 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING';
    spec.campaign.network = type === 'SEARCH' ? { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false } : null;
    spec.tracking.needsConversion = spec.campaign.biddingField === 'maximizeConversions' || spec.campaign.biddingField === 'maximizeConversionValue' || spec.campaign.biddingField === 'targetCpa';
    spec.tracking.conversionActions = Number.isInteger(opt.conversionActions) ? opt.conversionActions : null;
    const headlines = (g.headlines || []).map(_str).filter(Boolean);
    const descriptions = (g.descriptions || []).map(_str).filter(Boolean);
    const matchType = GOOGLE_MATCH_TYPES.includes(String(g.matchType || '').toUpperCase()) ? String(g.matchType).toUpperCase() : 'PHRASE';
    const negOv = Array.isArray(ov.negativeKeywords) ? ov.negativeKeywords : null;
    const negatives = (negOv || g.negativeKeywords || []).map(_str).filter(Boolean).slice(0, 50);
    src.negativeKeywords = negOv ? 'user' : 'ai';
    const callouts = (Array.isArray(ov.callouts) ? ov.callouts : (g.callouts || [])).map(_str).filter(Boolean);
    const snippetVals = (Array.isArray(ov.snippetValues) ? ov.snippetValues : (g.structuredSnippets || [])).map(_str).filter(Boolean);
    const snippetHeader = GOOGLE_SNIPPET_HEADERS.includes(ov.snippetHeader) ? ov.snippetHeader : (GOOGLE_SNIPPET_HEADERS.includes(g.structuredSnippetHeader) ? g.structuredSnippetHeader : 'Types');
    const sitelinkUrls = ov.sitelinks && typeof ov.sitelinks === 'object' ? ov.sitelinks : {};
    const sitelinks = (Array.isArray(g.sitelinks) ? g.sitelinks : []).map((x) => {
      const text = _str(typeof x === 'object' && x ? (x.text || x.linkText || x.name) : x);
      const url = _str(sitelinkUrls[text] || (typeof x === 'object' && x ? x.url : ''));
      return { text, url, description1: _str(x && x.description1), description2: _str(x && x.description2) };
    }).filter((x) => x.text);
    for (const [text, url] of Object.entries(sitelinkUrls)) if (!sitelinks.some((x) => x.text === text)) sitelinks.push({ text, url: _str(url), description1: '', description2: '' });
    spec.assets = {
      headlines, descriptions,
      longHeadline: _str(g.longHeadline) || null,
      negativeKeywords: negatives,
      callouts,
      structuredSnippet: snippetVals.length ? { header: snippetHeader, values: snippetVals } : null,
      sitelinks,
      businessName: _str(profile.company_name) || null,
      logoUrl: _str(profile.logo_url) || null,
      squareImageUrl: images.primary,
      landscapeImageUrl: _str(g.pmaxLandscapeImageUrl) || null,
    };
    src.businessName = profile.company_name ? 'profile' : 'missing';
    src.logo = profile.logo_url ? 'profile' : 'missing';
    if (type === 'SEARCH') {
      const kws = (g.keywords || []).map((x) => (typeof x === 'object' && x ? x : { text: x })).map((x) => ({ text: _str(x.text), matchType: GOOGLE_MATCH_TYPES.includes(String(x.matchType || '').toUpperCase()) ? String(x.matchType).toUpperCase() : matchType })).filter((x) => x.text);
      const n = spec.adGroups.length;
      spec.adGroups.forEach((grp, i) => {
        grp.keywords = n === 1 ? kws.slice(0, 20) : kws.filter((_, j) => j % n === i).slice(0, 20);
        grp.ads = grp.ads.map((_, j) => ({ name: grp.name + ' — RSA ' + (j + 1), headlines: rotate(headlines, G.RSA_MAX_H, i + j), descriptions: rotate(descriptions, G.RSA_MAX_D, i + j) }));
      });
    } else {
      spec.adGroups = [{ name: name + (type === 'DEMAND_GEN' ? ' — Ad group' : ' — Asset group'), ads: [{ name: name + ' — Ad' }] }];
    }
  }

  if (platform === 'tiktok') {
    const cfg = campaignGoals.TIKTOK_GOAL_CONFIG[goal] || campaignGoals.TIKTOK_GOAL_CONFIG.Traffic;
    spec.campaign.objective = cfg.objective_type;
    spec.campaign.budgetLevel = 'AD_GROUP';
    spec.optimization = { goal: cfg.optimization_goal, billingEvent: cfg.billing_event, bidType: 'BID_TYPE_NO_BID', promotionType: 'WEBSITE' };
    spec.targeting.placement = 'tiktok';
    spec.targeting.placementLabel = 'TikTok feed';
    spec.targeting.ageGroups = tiktokAgeGroups(ageMin, ageMax);
    spec.identity = { identityId: opt.identityId || null, identityType: opt.identityType || null, displayName: opt.identityName || null };
    // Cover image: a generated/attached campaign image when there is one;
    // otherwise (every video made in Create — video mode never produces an
    // image) the publish route uses the cover frame TikTok itself extracts
    // from the uploaded video (/file/video/ad/info/ → video_cover_url).
    spec.creative = { format: video ? 'VIDEO' : 'IMAGE', videoUrl: video, coverImageUrl: images.primary, coverFromVideo: !!(video && !images.primary), videoPending: !video && videoPendingOf(pkg) };
    // Video Views / App Promotion were offered by older Create screens but
    // never wired into this spec (it always used the goal's objective).
    if (o.objective) spec.unsupportedObjective = String(o.objective);
    spec.adGroups.forEach((grp) => grp.ads.forEach((ad) => { ad.adText = (ad.primaryText || ad.headline || name).replace(/\s+/g, ' ').trim().slice(0, 100); }));
  }

  if (platform === 'pinterest') {
    const cfg = campaignGoals.getPinterestObjective(goal, o.objective);
    const needsConversion = goal === 'Sales' || goal === 'Leads';
    const tags = Array.isArray(opt.conversionTags) ? opt.conversionTags : null;
    let tagId = ov.conversionTagId || null;
    if (tagId) src.conversionTag = 'user';
    else if (tags && tags.length === 1) { tagId = tags[0].id; src.conversionTag = 'auto'; }
    else src.conversionTag = needsConversion ? 'missing' : 'auto';
    const allowed = PINTEREST_CONVERSION_EVENTS[goal] || [];
    const evt = allowed.includes(ov.conversionEvent) ? ov.conversionEvent : (allowed[0] || null);
    spec.campaign.objective = cfg.objective_type;
    spec.campaign.budgetLevel = 'CAMPAIGN';
    spec.optimization = { billableEvent: needsConversion ? 'IMPRESSION' : cfg.billable_event, bidStrategy: 'AUTOMATIC_BID' };
    spec.tracking.needsConversion = needsConversion;
    spec.tracking.conversionTagId = needsConversion ? tagId : null;
    spec.tracking.conversionEvent = needsConversion ? evt : null;
    spec.pinterestObjective = (o.objective && /video.?completion/i.test(String(o.objective))) ? 'Video Completion' : null;
    spec.pin = { title: _str(o.title || (variants[0] && variants[0].headline) || name).slice(0, 100), description: _str(o.description || '').slice(0, 800), altText: _str(o.altText || '').slice(0, 500) };
    spec.creative = { format: (o.creativeType === 'video' && video) ? 'VIDEO' : 'IMAGE', imageUrl: images.primary, images: images.all, videoUrl: video, wantsVideo: o.creativeType === 'video', videoPending: !video && videoPendingOf(pkg) };
  }

  return spec;
}

// TikTok targets age buckets; a range maps to every bucket it overlaps
// (65 means "and over", i.e. includes AGE_55_100).
function tiktokAgeGroups(lo, hi) {
  return TIKTOK_AGE_GROUPS.filter(([, a, b]) => b >= lo && (a <= hi || (hi >= 65 && a === 55))).map(([k]) => k);
}
// Meta budgets are in the currency's minor unit; zero-decimal currencies have none.
const ZERO_DECIMAL = ['JPY', 'KRW', 'CLP', 'VND', 'ISK', 'HUF', 'TWD', 'COP', 'IDR', 'PYG'];
function minorUnits(amount, currency) { return ZERO_DECIMAL.includes(String(currency || '').toUpperCase()) ? Math.round(amount) : Math.round(amount * 100); }

// Strict goal reading for edits: only the four goals and their plain
// synonyms. Anything else is refused (the shared normalizeGoal falls back to
// a default, which would silently change the objective).
const GOAL_WORDS = {
  Sales: ['sales', 'sale', 'conversions', 'conversion', 'purchases', 'purchase', 'website sales', 'online sales'],
  Leads: ['leads', 'lead', 'lead generation', 'sign ups', 'signups', 'website leads'],
  Traffic: ['traffic', 'website traffic', 'clicks', 'link clicks', 'website visits', 'consideration'],
  Awareness: ['awareness', 'brand awareness', 'reach'],
};
function parseGoal(v) {
  const t = _norm(v).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [g, words] of Object.entries(GOAL_WORDS)) if (words.includes(t)) return g;
  return null;
}

function rotate(pool, size, i) {
  size = Math.min(size, pool.length);
  if (pool.length <= size) return pool.slice();
  const off = (i * size) % pool.length;
  const out = [];
  for (let j = 0; j < size; j++) out.push(pool[(off + j) % pool.length]);
  return out;
}

// ── validate ──────────────────────────────────────────────────────
// level 'error' blocks publishing, 'warning' is shown, 'info' explains.
function validate(spec, ctx) {
  ctx = ctx || {};
  const opt = ctx.options || {};
  const issues = [];
  const add = (level, field, code, message, extra) => issues.push(Object.assign({ level, field, code, message }, extra || {}));
  const p = spec.platform;
  const goal = spec.campaign.goal;
  const pname = { meta: 'Meta', google: 'Google Ads', tiktok: 'TikTok', pinterest: 'Pinterest' }[p];

  // Countries — never a silent default, never "everywhere".
  if (!spec.targeting.countries.length) add('error', 'targeting.countries', 'country_missing', 'Choose the country or countries to advertise in. Your business profile has no country OrivenAI can read, so nothing is assumed.');
  if (p === 'pinterest') {
    const unsupported = spec.targeting.countries.filter((c) => !(COUNTRY_BY_ISO[c] && COUNTRY_BY_ISO[c].pin));
    if (unsupported.length) add('warning', 'targeting.countries', 'pinterest_market', 'Pinterest ads may not be available in ' + unsupported.map(countryName).join(', ') + '. Pinterest will reject the campaign if so.', { params: { countries: unsupported } });
  }
  if (p === 'tiktok') {
    const noId = spec.targeting.countries.filter((c) => !(COUNTRY_BY_ISO[c] && COUNTRY_BY_ISO[c].geo));
    if (noId.length) add('error', 'targeting.countries', 'tiktok_location', 'OrivenAI can’t target ' + noId.map(countryName).join(', ') + ' on TikTok yet. Choose a different country.', { params: { countries: noId } });
  }
  if (spec.targeting.ageMin < 13 || spec.targeting.ageMin > spec.targeting.ageMax || spec.targeting.ageMax > 65 && p === 'meta') add('error', 'targeting.age', 'age_range', 'The age range isn’t valid. Use ages between 18 and 65.');
  if (spec.targeting.ageMin < 18) add('error', 'targeting.age', 'age_min', 'OrivenAI only targets adults (18+).');

  // Budget — user-controlled spend.
  if (!spec.budget.amount) {
    add('error', 'budget.amount', 'budget_unconfirmed', spec.budget.suggestion
      ? 'Confirm the daily budget. The AI suggested about ' + spec.budget.suggestion + ' per day, but OrivenAI only spends what you set.'
      : 'Set a daily budget. OrivenAI only spends what you set.',
      spec.budget.suggestion ? { variant: 'suggested', params: { suggestion: spec.budget.suggestion } } : undefined);
  } else {
    if (p === 'tiktok') {
      const cur = (spec.budget.currency || '').toUpperCase();
      if (!cur || TIKTOK_MIN_CURRENCIES.includes(cur)) {
        if (!(spec.budget.amount > TIKTOK_MIN_ADGROUP_DAILY)) add('error', 'budget.amount', 'tiktok_budget_min', 'TikTok requires a daily ad group budget above ' + TIKTOK_MIN_ADGROUP_DAILY + ' (' + (cur || 'USD/EUR') + '). Set at least ' + (TIKTOK_MIN_ADGROUP_DAILY + 1) + ' per day.', { params: { min: TIKTOK_MIN_ADGROUP_DAILY, currency: cur || 'USD/EUR', atLeast: TIKTOK_MIN_ADGROUP_DAILY + 1 } });
      } else add('warning', 'budget.amount', 'tiktok_budget_currency', 'TikTok sets minimum budgets per currency. Check the minimum for ' + cur + ' in TikTok Ads Manager.', { params: { currency: cur } });
    }
    if (p === 'meta' && spec.budget.amount < 1) add('error', 'budget.amount', 'budget_min', 'Meta needs a daily budget of at least 1.', { params: { platform: 'Meta' } });
    if (p === 'google' && spec.budget.amount < 1) add('error', 'budget.amount', 'budget_min', 'Google Ads needs a daily budget of at least 1.', { params: { platform: 'Google Ads' } });
  }

  // Destination
  const u = validUrl(spec.tracking.destinationUrl);
  if (u === 'missing') add('error', 'tracking.destinationUrl', 'url_missing', 'Add the page people land on after clicking the ad.');
  else if (u === 'invalid') add('error', 'tracking.destinationUrl', 'url_invalid', 'The destination “' + spec.tracking.destinationUrl + '” isn’t a valid web address (start with https://).', { params: { url: spec.tracking.destinationUrl } });

  if (p === 'meta') {
    if (!spec.campaign.specialAdCategoriesConfirmed) add('error', 'campaign.specialAdCategories', 'special_categories_unconfirmed', 'Confirm whether this ad is about housing, employment, financial products or services, or social issues/elections/politics. Meta requires this declaration.');
    if (spec.compliance.euTargeted && !(spec.compliance.dsaBeneficiary && spec.compliance.dsaPayor)) add('error', 'compliance.dsa', 'dsa_missing', 'Ads shown in the EU must name who benefits from the ad and who pays for it. Add your business name in your business profile, or set them here.');
    if (spec.tracking.needsConversion) {
      if (opt.pixels && !opt.pixels.length) add('error', 'tracking.pixelId', 'pixel_none', 'This ' + goal + ' campaign optimises for conversions on your website, which needs a Meta Pixel. Add one in Meta Events Manager, or change the objective to Traffic or Awareness.', { params: { goal } });
      else if (!spec.tracking.pixelId) add('error', 'tracking.pixelId', 'pixel_choose', opt.pixels ? 'Choose which Meta Pixel measures conversions for this campaign.' : 'OrivenAI couldn’t check your Meta Pixels. Reconnect Meta and try again.', opt.pixels ? undefined : { variant: 'unchecked' });
      else if (opt.pixels && !opt.pixels.some((x) => x.id === spec.tracking.pixelId)) add('error', 'tracking.pixelId', 'pixel_unknown', 'The selected Meta Pixel isn’t on this ad account anymore. Choose another one.');
    }
    if (!spec.identity.pageId) add('error', 'identity.pageId', 'page_missing', 'Connect a Facebook Page in Connections. Meta ads run under a Page.');
    if (spec.unsupportedObjective) add('warning', 'campaign.objective', 'objective_unsupported', 'This campaign was made with the “' + spec.unsupportedObjective + '” objective, which OrivenAI can’t publish to Meta. It will be published with the standard ' + goal + ' objective.', { params: { objective: spec.unsupportedObjective, goal, platform: 'Meta' } });
    if (spec.targeting.placement === 'instagram_only' && opt.instagramChecked && !spec.identity.instagramUserId) add('error', 'identity.instagram', 'instagram_missing', 'Instagram-only ads need an Instagram account linked to your Facebook Page. Link one in Meta Business Settings, or use Facebook and Instagram placements.');
    if (!spec.creative.imageUrl) add('error', 'creative.image', 'image_missing', 'Add an image. Meta image ads need one.', { variant: 'meta' });
    spec.adGroups.forEach((grp, i) => grp.ads.forEach((ad, j) => {
      if (!ad.primaryText) add('error', `adGroups[${i}].ads[${j}].primaryText`, 'copy_missing', 'Ad ' + (j + 1) + ' in ' + grp.name + ' has no primary text.', { variant: 'meta', params: { n: j + 1, group: grp.name } });
      if (ad.headline.length > 255) add('error', `adGroups[${i}].ads[${j}].headline`, 'headline_long', 'A Meta headline is too long.', { variant: 'meta' });
    }));
    if ((spec.campaign.specialAdCategories || []).length && !spec.targeting.advantageAudience) {
      if (spec.targeting.ageMin !== 18 || spec.targeting.ageMax !== 65) add('error', 'targeting.age', 'special_category_age', 'Ads in a special ad category must target ages 18–65.');
    }
  }

  if (p === 'google') {
    const a = spec.assets;
    if (!SUPPORT.google.types.includes(spec.campaignType)) add('error', 'campaignType', 'google_type', 'This Google campaign type can’t be published by OrivenAI.');
    if (spec.tracking.needsConversion) {
      if (spec.tracking.conversionActions === 0) add('error', 'tracking.conversion', 'google_conversions_none', 'This campaign uses a conversion-based bid strategy, but your Google Ads account has no active conversion action. Set up conversion tracking in Google Ads, or choose Traffic.');
      else if (spec.tracking.conversionActions == null) add('warning', 'tracking.conversion', 'google_conversions_unknown', 'OrivenAI couldn’t check your Google Ads conversion tracking. Without it, a conversion-based bid strategy can’t learn.');
    }
    if (spec.campaignType === 'SEARCH') {
      const h = a.headlines.filter((x) => x.length <= G.RSA_HEADLINE), d = a.descriptions.filter((x) => x.length <= G.RSA_DESCRIPTION);
      if (h.length < G.RSA_MIN_H) add('error', 'assets.headlines', 'rsa_headlines', 'Search ads need at least 3 headlines of up to 30 characters (' + h.length + ' valid).', { params: { valid: h.length } });
      if (d.length < G.RSA_MIN_D) add('error', 'assets.descriptions', 'rsa_descriptions', 'Search ads need at least 2 descriptions of up to 90 characters (' + d.length + ' valid).', { params: { valid: d.length } });
      a.headlines.filter((x) => x.length > G.RSA_HEADLINE).forEach((x) => add('warning', 'assets.headlines', 'headline_long', '“' + x + '” is longer than 30 characters and won’t be used.', { params: { text: x } }));
      a.descriptions.filter((x) => x.length > G.RSA_DESCRIPTION).forEach((x) => add('warning', 'assets.descriptions', 'description_long', 'A description is longer than 90 characters and won’t be used.'));
      spec.adGroups.forEach((grp, i) => { if (!grp.keywords || !grp.keywords.length) add('error', `adGroups[${i}].keywords`, 'keywords_missing', grp.name + ' has no keywords.', { params: { group: grp.name } }); });
      a.callouts.filter((x) => x.length > G.CALLOUT).forEach((x) => add('warning', 'assets.callouts', 'callout_long', 'Callout “' + x + '” is longer than 25 characters and won’t be used.', { params: { text: x } }));
      if (a.structuredSnippet && a.structuredSnippet.values.filter((v) => v.length <= G.SNIPPET_VALUE).length < 3) add('warning', 'assets.structuredSnippet', 'snippet_values', 'Structured snippets need at least 3 values of up to 25 characters; they won’t be added.');
      const noUrl = a.sitelinks.filter((x) => !x.url);
      if (noUrl.length) add('info', 'assets.sitelinks', 'sitelink_urls', noUrl.length + ' sitelink idea' + (noUrl.length === 1 ? '' : 's') + ' (' + noUrl.map((x) => x.text).join(', ') + ') need a page address before they can be added.', { variant: noUrl.length === 1 ? 'one' : undefined, params: { n: noUrl.length, list: noUrl.map((x) => x.text).join(', ') } });
      a.sitelinks.filter((x) => x.url && validUrl(x.url)).forEach((x) => add('error', 'assets.sitelinks', 'sitelink_url_invalid', 'The sitelink “' + x.text + '” has an invalid address.', { params: { text: x.text } }));
    } else {
      if (!a.businessName) add('error', 'assets.businessName', 'business_name_missing', 'Add your company name in your business profile. Google requires a business name for this campaign type.');
      else if (a.businessName.length > G.BUSINESS_NAME) add('warning', 'assets.businessName', 'business_name_long', 'Google shows at most 25 characters of the business name; it will be shortened.');
      if (!a.logoUrl) add('error', 'assets.logo', 'logo_missing', 'Add your logo in your business profile. Google requires a logo for this campaign type.');
      if (!a.squareImageUrl) add('error', 'assets.squareImage', 'image_missing', 'Add an image for this campaign.', { variant: 'google' });
      if (spec.campaignType === 'PERFORMANCE_MAX') {
        const h = a.headlines.filter((x) => x.length <= G.RSA_HEADLINE), d = a.descriptions.filter((x) => x.length <= G.RSA_DESCRIPTION);
        if (h.length < 3) add('error', 'assets.headlines', 'pmax_headlines', 'Performance Max needs at least 3 headlines of up to 30 characters.');
        if (d.length < 2) add('error', 'assets.descriptions', 'pmax_descriptions', 'Performance Max needs at least 2 descriptions of up to 90 characters.');
        else if (!d.some((x) => x.length <= G.PMAX_SHORT_DESCRIPTION)) add('error', 'assets.descriptions', 'pmax_short_description', 'Performance Max needs one description of up to 60 characters.');
        if (!a.landscapeImageUrl) add('error', 'assets.landscapeImage', 'landscape_missing', 'Generate a landscape image. Performance Max needs a 1.91:1 marketing image (OrivenAI crops it to the exact size).');
      } else {
        if (!a.headlines.some((x) => x.length <= G.DG_HEADLINE)) add('error', 'assets.headlines', 'dg_headlines', 'Demand Gen needs at least one headline of up to 40 characters.');
        if (!a.descriptions.some((x) => x.length <= G.DG_DESCRIPTION)) add('error', 'assets.descriptions', 'dg_descriptions', 'Demand Gen needs at least one description of up to 90 characters.');
      }
    }
  }

  if (p === 'tiktok') {
    const blocked = SUPPORT.tiktok.blockedGoals[goal];
    if (blocked) add('error', 'campaign.goal', 'tiktok_goal', blocked, { params: { goal, reason: 'tiktok_goal_' + goal } });
    if (spec.creative.format !== 'VIDEO') {
      if (spec.creative.videoPending) add('error', 'creative.video', 'video_pending', 'The video for this campaign is still being generated. It can be published once the video is ready.', { variant: 'tiktok' });
      else add('error', 'creative.video', 'tiktok_video', 'TikTok feed ads are videos. Add a video to this campaign (upload one, or generate one) before publishing to TikTok. Single-image ads aren’t shown in the TikTok feed.');
    } else if (!/^https?:\/\//i.test(String(spec.creative.videoUrl || ''))) add('error', 'creative.video', 'video_not_online', 'The video isn’t stored online, so TikTok can’t fetch it. Generate or upload the video again.', { params: { platform: 'TikTok' } });
    if (spec.creative.format === 'VIDEO' && !spec.creative.coverImageUrl) {
      if (spec.creative.coverFromVideo) add('info', 'creative.cover', 'tiktok_cover_auto', 'No cover image was added, so OrivenAI uses the cover frame TikTok takes from your video. Add an image to this campaign if you want a specific cover.');
      else add('error', 'creative.cover', 'tiktok_cover', 'TikTok video ads need a cover image. Add an image to this campaign.');
    }
    if (spec.unsupportedObjective) add('warning', 'campaign.objective', 'objective_unsupported', 'This campaign was made with the “' + spec.unsupportedObjective + '” objective, which OrivenAI can’t publish to TikTok. It will be published with the standard ' + goal + ' objective.', { params: { objective: spec.unsupportedObjective, goal, platform: 'TikTok' } });
    if (!spec.identity.identityId) add('error', 'identity.tiktok', 'tiktok_identity', 'Choose the TikTok account your ads run under, in Connections → TikTok Ads.');
    if (spec.identity.identityType === 'BC_AUTH_TT') add('error', 'identity.tiktok', 'tiktok_identity_bc', 'This TikTok identity needs Business Center authorisation, which OrivenAI doesn’t support yet. Choose another linked TikTok account.');
    spec.adGroups.forEach((grp, i) => grp.ads.forEach((ad, j) => { if (!ad.adText) add('error', `adGroups[${i}].ads[${j}].adText`, 'copy_missing', 'Ad ' + (j + 1) + ' has no ad text.', { variant: 'tiktok', params: { n: j + 1 } }); }));
  }

  if (p === 'pinterest') {
    if (spec.tracking.needsConversion) {
      if (opt.conversionTags && !opt.conversionTags.length) add('error', 'tracking.conversionTagId', 'tag_none', 'Pinterest ' + goal + ' campaigns optimise for conversions and need a Pinterest Tag. Add one in Pinterest Ads Manager, or choose Awareness or Traffic.', { params: { goal } });
      else if (!spec.tracking.conversionTagId) add('error', 'tracking.conversionTagId', 'tag_choose', opt.conversionTags ? 'Choose which Pinterest Tag measures conversions.' : 'OrivenAI couldn’t check your Pinterest Tags. Reconnect Pinterest and try again.', opt.conversionTags ? undefined : { variant: 'unchecked' });
    }
    if (spec.creative.wantsVideo && spec.creative.format !== 'VIDEO') {
      if (spec.creative.videoPending) add('error', 'creative.video', 'video_pending', 'This Pin is set to video and the video is still being generated. It can be published once the video is ready.', { variant: 'pinterest' });
      else if (spec.creative.imageUrl) add('warning', 'creative.video', 'pin_video_missing', 'This Pin is set to video, but the campaign has no video. It will be published as an image Pin.');
    }
    if (spec.creative.format === 'VIDEO' && !/^https?:\/\//i.test(String(spec.creative.videoUrl || ''))) add('error', 'creative.video', 'video_not_online', 'The video isn’t stored online, so Pinterest can’t fetch it. Generate or upload the video again.', { params: { platform: 'Pinterest' } });
    if (spec.creative.format === 'IMAGE' && !spec.creative.imageUrl) add('error', 'creative.image', 'image_missing', 'Add an image. Pinterest ads are Pins.', { variant: 'pinterest' });
    if (!spec.pin.title) add('error', 'pin.title', 'pin_title', 'The Pin needs a title.');
    if (!spec.targeting.languages.length) add('info', 'targeting.languages', 'pinterest_language', 'Pinterest shows the ad to everyone in the chosen countries; OrivenAI doesn’t send a language restriction to Pinterest.', { variant: 'none' });
    else add('info', 'targeting.languages', 'pinterest_language', 'Pinterest language targeting isn’t sent by OrivenAI; your ad reaches everyone in the chosen countries.');
  }

  // Shared Create/Launch compatibility rules (services/createCompat.js) —
  // the same check /api/ai/create-ad runs before charging. Issues the
  // platform blocks above already explain in more detail are not repeated.
  {
    const fmt = p === 'google' ? (spec.campaignType === 'SEARCH' ? 'text' : 'image') : String((spec.creative && spec.creative.format) || 'IMAGE').toLowerCase();
    const cc = createCompat.check({ platform: p, campaignType: spec.campaignType, goal, format: fmt, objective: p === 'pinterest' ? (spec.pinterestObjective || null) : null });
    for (const iss of cc.issues || []) {
      if (p === 'tiktok' && (iss.field === 'goal' || iss.field === 'format')) continue;
      if (p === 'google' && iss.field === 'campaignType') continue;
      add('error', 'compat.' + iss.field, 'compat_' + iss.code, (iss.message + ' ' + (iss.suggestion || '')).trim(), { params: { reason: iss.reason || iss.code } });
    }
  }

  for (const note of spec.liveUnverified || []) add('info', 'platform', 'live_unverified', note);
  return issues;
}
const hasErrors = (issues) => issues.some((i) => i.level === 'error');

// ── Launch checklist ──────────────────────────────────────────────
// Every issue belongs to exactly one section; anything not recognised goes
// to 'other', so Launch can never drop an error. checklist() is what
// Launch shows: the sections that apply to this platform/type, each with
// its status (pass / warning / blocked) and a plain summary of what will
// be sent. The same issues block POST /api/publish/{platform}.
const SECTIONS = {
  campaign: 'Campaign & format', creative: 'Creative', copy: 'Ad copy', keywords: 'Keywords & extensions',
  destination: 'Destination', budget: 'Budget', targeting: 'Targeting', tracking: 'Tracking / conversions',
  compliance: 'Compliance', identity: 'Identity', other: 'Other settings',
};
function sectionOf(field) {
  const f = String(field || '');
  if (/^(compliance\.|campaign\.specialAdCategories)/.test(f)) return 'compliance';
  if (/^(campaign\.|campaignType|compat\.)/.test(f)) return 'campaign';
  if (/^(creative\.|assets\.(squareImage|landscapeImage|logo|businessName))/.test(f)) return 'creative';
  if (/^(assets\.(headlines|descriptions|longHeadline)|pin\.|adGroups\[\d+\]\.ads)/.test(f)) return 'copy';
  if (/^(adGroups\[\d+\]\.keywords|assets\.(sitelinks|callouts|structuredSnippet|negativeKeywords))/.test(f)) return 'keywords';
  if (/^tracking\.destinationUrl/.test(f)) return 'destination';
  if (/^budget\./.test(f)) return 'budget';
  if (/^targeting\./.test(f)) return 'targeting';
  if (/^tracking\./.test(f)) return 'tracking';
  if (/^identity\./.test(f)) return 'identity';
  return 'other';
}
const GOOGLE_TYPE_LABEL = { SEARCH: 'Search (text ads)', PERFORMANCE_MAX: 'Performance Max', DEMAND_GEN: 'Demand Gen' };
function formatLabel(spec) {
  if (spec.platform === 'google') return spec.campaignType === 'SEARCH' ? 'Text ads' : 'Image ads';
  return spec.creative && spec.creative.format === 'VIDEO' ? 'Video' : 'Image';
}
function checklist(spec, issues) {
  const p = spec.platform;
  const keys = ['campaign', 'creative', 'copy'];
  if (p === 'google' && spec.campaignType === 'SEARCH') keys.push('keywords');
  keys.push('destination', 'budget', 'targeting', 'tracking');
  if (p === 'meta') keys.push('compliance');
  if (p === 'meta' || p === 'tiktok') keys.push('identity');
  const ads = spec.adGroups.reduce((n, g) => n + (g.ads ? g.ads.length : 0), 0);
  const groupWord = p === 'meta' ? 'ad set' : 'ad group';
  const cur = spec.budget.currency ? ' ' + spec.budget.currency : '';
  const summary = {
    campaign: () => [spec.campaign.goal, p === 'google' ? GOOGLE_TYPE_LABEL[spec.campaignType] : formatLabel(spec), spec.adGroups.length + ' ' + groupWord + (spec.adGroups.length === 1 ? '' : 's') + ' · ' + ads + ' ad' + (ads === 1 ? '' : 's')].filter(Boolean).join(' · '),
    creative: () => {
      const c = spec.creative || {};
      if (p === 'google') return spec.campaignType === 'SEARCH' ? 'Text ads — no image is sent to Google.' : 'Image, logo and business name from your business profile.';
      if (c.format === 'VIDEO') return p === 'tiktok' ? ('Video' + (c.coverFromVideo ? ' — TikTok uses a frame of the video as the cover.' : ' with a cover image.')) : 'Video Pin.';
      const n = (c.images || []).length || (c.imageUrl ? 1 : 0);
      return (p === 'pinterest' ? 'Image Pin' : 'Image ad') + (n > 1 ? ' · ' + n + ' images' : '') + '.';
    },
    copy: () => p === 'google' ? (spec.assets.headlines.length + ' headlines · ' + spec.assets.descriptions.length + ' descriptions.') : p === 'pinterest' ? ('Pin title: “' + spec.pin.title + '”.') : (ads + ' ad' + (ads === 1 ? '' : 's') + ' with text.'),
    keywords: () => { const n = spec.adGroups.reduce((s, g) => s + ((g.keywords || []).length), 0); return n + ' keyword' + (n === 1 ? '' : 's') + (spec.assets.callouts.length ? ' · ' + spec.assets.callouts.length + ' callouts' : '') + '.'; },
    destination: () => spec.tracking.destinationUrl || '',
    budget: () => spec.budget.amount ? spec.budget.amount + cur + ' per day.' : '',
    targeting: () => [spec.targeting.countries.map(countryName).join(', '), 'Ages ' + spec.targeting.ageMin + '–' + spec.targeting.ageMax + (spec.targeting.ageMax >= 65 ? '+' : ''), spec.targeting.placementLabel].filter(Boolean).join(' · '),
    tracking: () => !spec.tracking.needsConversion ? 'Not needed for this objective.' : (p === 'meta' ? 'Meta Pixel selected · ' + spec.tracking.conversionEvent : p === 'pinterest' ? 'Pinterest Tag selected · ' + spec.tracking.conversionEvent : 'Conversion tracking is set up.'),
    compliance: () => 'Special ad categories confirmed' + (spec.compliance && spec.compliance.euTargeted ? ' · EU transparency: ' + spec.compliance.dsaBeneficiary : '') + '.',
    identity: () => p === 'meta' ? ('Facebook Page connected' + (spec.identity.instagramUsername ? ' · Instagram @' + spec.identity.instagramUsername : '') + '.') : ('TikTok identity: ' + (spec.identity.displayName || 'selected') + '.'),
  };
  const summaryCode = {
    campaign: () => ({ code: 'campaign', params: { goal: spec.campaign.goal, type: p === 'google' ? spec.campaignType : (spec.creative && spec.creative.format === 'VIDEO' ? 'VIDEO' : 'IMAGE'), groups: spec.adGroups.length, groupWord: p === 'meta' ? 'adset' : 'adgroup', ads } }),
    creative: () => {
      const c = spec.creative || {};
      if (p === 'google') return { code: spec.campaignType === 'SEARCH' ? 'creative_google_text' : 'creative_google_image' };
      if (c.format === 'VIDEO') return { code: p === 'tiktok' ? (c.coverFromVideo ? 'creative_tiktok_video_frame' : 'creative_tiktok_video_cover') : 'creative_video_pin' };
      const n = (c.images || []).length || (c.imageUrl ? 1 : 0);
      return { code: (p === 'pinterest' ? 'creative_image_pin' : 'creative_image_ad') + (n > 1 ? '_n' : ''), params: { n } };
    },
    copy: () => p === 'google' ? { code: 'copy_google', params: { headlines: spec.assets.headlines.length, descriptions: spec.assets.descriptions.length } } : p === 'pinterest' ? { code: 'copy_pin', params: { title: spec.pin.title } } : { code: 'copy_ads', params: { n: ads } },
    keywords: () => { const n = spec.adGroups.reduce((s, g) => s + ((g.keywords || []).length), 0); return { code: spec.assets.callouts.length ? 'keywords_callouts' : 'keywords', params: { n, callouts: spec.assets.callouts.length } }; },
    destination: () => ({ code: 'destination', params: { url: spec.tracking.destinationUrl } }),
    budget: () => ({ code: 'budget', params: { amount: spec.budget.amount, currency: spec.budget.currency || '' } }),
    targeting: () => ({ code: 'targeting', params: { countries: spec.targeting.countries.slice(), ageMin: spec.targeting.ageMin, ageMax: spec.targeting.ageMax, plus: spec.targeting.ageMax >= 65, placement: p === 'tiktok' ? 'tiktok_feed' : (spec.targeting.placement || null), placementLabel: spec.targeting.placementLabel || '' } }),
    tracking: () => !spec.tracking.needsConversion ? { code: 'tracking_none' } : { code: p === 'meta' ? 'tracking_pixel' : p === 'pinterest' ? 'tracking_tag' : 'tracking_google', params: { event: spec.tracking.conversionEvent || '' } },
    compliance: () => ({ code: spec.compliance && spec.compliance.euTargeted ? 'compliance_eu' : 'compliance', params: { beneficiary: (spec.compliance && spec.compliance.dsaBeneficiary) || '' } }),
    identity: () => p === 'meta' ? { code: spec.identity.instagramUsername ? 'identity_meta_ig' : 'identity_meta', params: { instagram: spec.identity.instagramUsername || '' } } : { code: spec.identity.displayName ? 'identity_tiktok' : 'identity_tiktok_selected', params: { name: spec.identity.displayName || '' } },
  };
  const by = {};
  for (const i of issues) { const s = sectionOf(i.field); (by[s] = by[s] || []).push(i); }
  if ((by.other || []).some((i) => i.level !== 'info')) keys.push('other');
  return keys.map((k) => {
    const list = (by[k] || []);
    const slim = (i) => Object.assign({ code: i.code, field: i.field, message: i.message }, i.params ? { params: i.params } : {}, i.variant ? { variant: i.variant } : {});
    const errors = list.filter((i) => i.level === 'error').map(slim);
    const warnings = list.filter((i) => i.level === 'warning').map(slim);
    const notes = list.filter((i) => i.level === 'info' && i.code !== 'live_unverified').map((i) => i.message);
    let text = '';
    try { text = summary[k] ? summary[k]() : ''; } catch (_) { text = ''; }
    let sc = null;
    try { sc = !errors.length && text && summaryCode[k] ? summaryCode[k]() : null; } catch (_) { sc = null; }
    return Object.assign({ key: k, label: SECTIONS[k], status: errors.length ? 'blocked' : warnings.length ? 'warning' : 'pass', summary: errors.length ? '' : text, errors, warnings, notes }, sc ? { summaryCode: sc.code, summaryParams: sc.params || {} } : {});
  });
}

// ── applyChanges (Oriven Chat + review UI) ─────────────────────────
// changes: { countries, languages, ageMin, ageMax, budget, placement,
//   goal, destinationUrl, utm, pixelId, conversionEvent, conversionTagId,
//   specialAdCategories, dsaBeneficiary, dsaPayor, negativeKeywords,
//   callouts, sitelink:{text,url}, headlines, descriptions, addAdGroup:{name,ageMin,ageMax},
//   removeAdGroup:index, snippetHeader }
// Validated per field; anything that can't be applied is returned in
// `rejected` with the reason — never silently coerced into something else.
function applyChanges(pkg, platform, changes) {
  const out = _clone(pkg || {});
  out.spec = out.spec && typeof out.spec === 'object' ? out.spec : {};
  out.spec.version = SPEC_VERSION;
  const ov = out.spec.overrides = out.spec.overrides && typeof out.spec.overrides === 'object' ? out.spec.overrides : {};
  const applied = [], rejected = [];
  const ok = (field, label) => applied.push({ field, label });
  const no = (field, reason, code, params) => rejected.push(Object.assign({ field, reason }, code ? { code } : {}, params ? { params } : {}));
  const pk = PK[platform];
  changes = changes || {};

  if (changes.countries != null) {
    const c = parseCountries(changes.countries);
    if (c) { ov.countries = c; ok('targeting.countries', 'Countries: ' + c.map(countryName).join(', ')); }
    else no('targeting.countries', 'I couldn’t recognise “' + [].concat(changes.countries).join(', ') + '” as a country. Name the country (for example Germany or DE).', 'country_unknown', { input: [].concat(changes.countries).join(', ') });
  }
  if (changes.languages != null) {
    if (Array.isArray(changes.languages) && !changes.languages.length) { ov.languages = []; ok('targeting.languages', 'Languages: all'); }
    else { const l = parseLanguages(changes.languages); if (l) { ov.languages = l; ok('targeting.languages', 'Languages: ' + l.map((x) => LANGUAGES[x].name).join(', ')); } else no('targeting.languages', 'I couldn’t recognise that language.', 'language_unknown'); }
  }
  if (changes.ageMin != null || changes.ageMax != null) {
    const lo = changes.ageMin != null ? parseInt(changes.ageMin, 10) : (ov.ageMin != null ? ov.ageMin : 18);
    const hi = changes.ageMax != null ? parseInt(changes.ageMax, 10) : (ov.ageMax != null ? ov.ageMax : 65);
    if (Number.isInteger(lo) && Number.isInteger(hi) && lo >= 18 && hi <= 65 && lo <= hi) { ov.ageMin = lo; ov.ageMax = hi; ok('targeting.age', 'Ages ' + lo + '–' + hi + (hi === 65 ? '+' : '')); }
    else no('targeting.age', 'Ages must be between 18 and 65, with the minimum not above the maximum.', 'age_invalid');
  }
  if (changes.budget != null) {
    const n = _num(changes.budget);
    if (!n) no('budget.amount', 'The budget must be a positive number.', 'budget_invalid');
    else if (platform === 'tiktok' && !(n > TIKTOK_MIN_ADGROUP_DAILY)) no('budget.amount', 'TikTok needs more than ' + TIKTOK_MIN_ADGROUP_DAILY + ' per day.', 'tiktok_budget_min', { min: TIKTOK_MIN_ADGROUP_DAILY });
    else {
      const v = Math.round(n * 100) / 100;
      if (platform === 'google') { out.strategy = out.strategy || {}; const prev = out.strategy.budgetRecommendation; out.strategy.budgetRecommendation = { amount: v, currency: (prev && typeof prev === 'object' && prev.currency) || null }; }
      else { out[pk] = out[pk] || {}; out[pk].budget = v; }
      ok('budget.amount', 'Daily budget: ' + v);
    }
  }
  if (changes.placement != null) {
    if (platform !== 'meta') no('targeting.placement', 'Placement choices apply to Meta campaigns.', 'placement_meta_only');
    else {
      const m = { automatic: 'automatic', both: 'automatic', facebook_and_instagram: 'automatic', instagram_only: 'instagram_only', instagram: 'instagram_only', facebook_only: 'facebook_only', facebook: 'facebook_only' }[String(changes.placement).toLowerCase()];
      if (m) { out.metaAds = out.metaAds || {}; out.metaAds.placement = m === 'automatic' ? 'both' : m; ok('targeting.placement', 'Placements: ' + META_PLACEMENTS[m]); }
      else no('targeting.placement', 'Placements can be Facebook and Instagram, Instagram only or Facebook only.', 'placement_invalid');
    }
  }
  if (changes.goal != null) {
    const g = parseGoal(changes.goal);
    if (!g) no('campaign.goal', 'The objective must be Sales, Leads, Traffic or Awareness.', 'goal_invalid');
    else if (platform === 'tiktok' && SUPPORT.tiktok.blockedGoals[g]) no('campaign.goal', SUPPORT.tiktok.blockedGoals[g], 'tiktok_goal', { goal: g, reason: 'tiktok_goal_' + g });
    else {
      out.strategy = out.strategy || {};
      const prevGoal = goalOf(out);
      out.strategy.goal = g;
      if (out[pk] && out[pk].objective) delete out[pk].objective; // the platform objective follows the goal again
      // Dependent settings: a conversion event chosen for the old objective no longer applies.
      if (prevGoal !== g) { delete ov.conversionEvent; if (g !== 'Sales' && g !== 'Leads') { delete ov.pixelId; delete ov.conversionTagId; } }
      ok('campaign.goal', 'Objective: ' + g + (prevGoal !== g ? ' (optimisation, bidding and conversion settings follow)' : ''));
    }
  }
  if (changes.destinationUrl != null) {
    const u = _str(changes.destinationUrl);
    if (validUrl(u)) no('tracking.destinationUrl', 'That isn’t a valid web address. Use a full address starting with https://.', 'url_invalid');
    else { out.strategy = out.strategy || {}; out.strategy.landingPageUrl = u; ok('tracking.destinationUrl', 'Destination: ' + u); }
  }
  if (changes.utm != null && typeof changes.utm === 'object') {
    const u = {};
    for (const k of ['source', 'medium', 'campaign', 'content']) if (changes.utm[k] != null) u[k] = String(changes.utm[k]).trim().slice(0, 100);
    ov.utm = Object.assign({}, ov.utm || {}, u); ok('tracking.utm', 'Tracking parameters updated');
  }
  if (changes.pixelId != null) { ov.pixelId = String(changes.pixelId); ok('tracking.pixelId', 'Meta Pixel selected'); }
  if (changes.conversionTagId != null) { ov.conversionTagId = String(changes.conversionTagId); ok('tracking.conversionTagId', 'Pinterest Tag selected'); }
  if (changes.conversionEvent != null) {
    const e = String(changes.conversionEvent).toUpperCase().replace(/\s+/g, '_');
    const allowed = platform === 'meta' ? META_CONVERSION_EVENTS : platform === 'pinterest' ? (PINTEREST_CONVERSION_EVENTS[goalOf(out)] || []) : [];
    if (allowed.includes(e)) { ov.conversionEvent = e; ok('tracking.conversionEvent', 'Conversion event: ' + e); }
    else no('tracking.conversionEvent', allowed.length ? 'Use one of: ' + allowed.join(', ') + '.' : 'This campaign doesn’t use a conversion event.', allowed.length ? 'event_invalid' : 'event_unused', allowed.length ? { allowed: allowed.join(', ') } : undefined);
  }
  if (changes.specialAdCategories != null) {
    const list = [].concat(changes.specialAdCategories).map((x) => String(x).toUpperCase().replace(/\s+/g, '_')).map((x) => (x === 'CREDIT' || x === 'FINANCIAL' ? 'FINANCIAL_PRODUCTS_SERVICES' : x === 'POLITICS' ? 'ISSUES_ELECTIONS_POLITICS' : x));
    const none = list.length === 0 || list.includes('NONE');
    if (none) { ov.specialAdCategories = []; ok('campaign.specialAdCategories', 'Special ad categories: none apply'); }
    else if (list.every((x) => META_SPECIAL_CATEGORIES.includes(x))) { ov.specialAdCategories = list; ok('campaign.specialAdCategories', 'Special ad categories: ' + list.join(', ')); }
    else no('campaign.specialAdCategories', 'Use housing, employment, financial products and services, social issues/elections/politics, or none.', 'categories_invalid');
  }
  if (changes.dsaBeneficiary != null) { ov.dsaBeneficiary = _str(changes.dsaBeneficiary).slice(0, 200); ok('compliance.dsa', 'EU beneficiary: ' + ov.dsaBeneficiary); }
  if (changes.dsaPayor != null) { ov.dsaPayor = _str(changes.dsaPayor).slice(0, 200); ok('compliance.dsa', 'EU payer: ' + ov.dsaPayor); }
  if (changes.negativeKeywords != null) {
    if (platform !== 'google') no('assets.negativeKeywords', 'Negative keywords apply to Google Search.', 'negatives_google_only');
    else { ov.negativeKeywords = [].concat(changes.negativeKeywords).map(_str).filter(Boolean).slice(0, 50); ok('assets.negativeKeywords', ov.negativeKeywords.length + ' negative keywords'); }
  }
  if (changes.callouts != null) {
    if (platform !== 'google') no('assets.callouts', 'Callouts apply to Google Search.', 'callouts_google_only');
    else { const list = [].concat(changes.callouts).map(_str).filter(Boolean); const long = list.filter((x) => x.length > G.CALLOUT); if (long.length) no('assets.callouts', 'Callouts can have at most 25 characters: ' + long.join(', '), 'callouts_long', { list: long.join(', ') }); else { ov.callouts = list.slice(0, 20); ok('assets.callouts', ov.callouts.length + ' callouts'); } }
  }
  if (changes.sitelink != null && typeof changes.sitelink === 'object') {
    if (platform !== 'google') no('assets.sitelinks', 'Sitelinks apply to Google Search.', 'sitelinks_google_only');
    else {
      const text = _str(changes.sitelink.text), url = _str(changes.sitelink.url);
      if (!text || text.length > G.SITELINK_TEXT) no('assets.sitelinks', 'Sitelink text must be 1–25 characters.', 'sitelink_text');
      else if (validUrl(url)) no('assets.sitelinks', 'The sitelink needs a valid address starting with https://.', 'sitelink_url');
      else { ov.sitelinks = Object.assign({}, ov.sitelinks || {}, { [text]: url }); ok('assets.sitelinks', 'Sitelink “' + text + '” → ' + url); }
    }
  }
  if (changes.snippetHeader != null) {
    const h = GOOGLE_SNIPPET_HEADERS.find((x) => _norm(x) === _norm(changes.snippetHeader));
    if (h) { ov.snippetHeader = h; ok('assets.structuredSnippet', 'Snippet header: ' + h); } else no('assets.structuredSnippet', 'Use one of: ' + GOOGLE_SNIPPET_HEADERS.join(', ') + '.', 'snippet_header', { allowed: GOOGLE_SNIPPET_HEADERS.join(', ') });
  }
  if (changes.headlines != null || changes.descriptions != null) {
    if (platform !== 'google') no('assets.headlines', 'Lists of headlines apply to Google; for other platforms, edit each ad’s headline.', 'headlines_google_only');
    else {
      out.googleAds = out.googleAds || {};
      if (changes.headlines != null) {
        const list = [].concat(changes.headlines).map(_str).filter(Boolean);
        const bad = list.filter((x) => x.length > G.RSA_HEADLINE);
        if (bad.length) no('assets.headlines', 'Google headlines can have at most 30 characters: ' + bad.join(' | '), 'headlines_long', { list: bad.join(' | ') });
        else { out.googleAds.headlines = changes.replaceHeadlines ? list.slice(0, 15) : Array.from(new Set((out.googleAds.headlines || []).concat(list))).slice(0, 15); ok('assets.headlines', (changes.replaceHeadlines ? 'Headlines replaced' : 'Headlines added') + ' (' + out.googleAds.headlines.length + ' total)'); }
      }
      if (changes.descriptions != null) {
        const list = [].concat(changes.descriptions).map(_str).filter(Boolean);
        const bad = list.filter((x) => x.length > G.RSA_DESCRIPTION);
        if (bad.length) no('assets.descriptions', 'Google descriptions can have at most 90 characters.', 'descriptions_long');
        else { out.googleAds.descriptions = changes.replaceDescriptions ? list.slice(0, 4) : Array.from(new Set((out.googleAds.descriptions || []).concat(list))).slice(0, 4); ok('assets.descriptions', 'Descriptions updated (' + out.googleAds.descriptions.length + ' total)'); }
      }
    }
  }
  if (changes.addAdGroup != null) {
    if (platform === 'google' && googleType(out) !== 'SEARCH') no('adGroups', 'This Google campaign type has one asset group.', 'groups_google_one');
    else {
      const struct = structureOf(out);
      if (struct.groups >= 5) no('adGroups', 'OrivenAI supports up to 5 ad sets per campaign.', 'groups_max');
      else {
        const a = changes.addAdGroup || {};
        const lo = a.ageMin != null ? parseInt(a.ageMin, 10) : null, hi = a.ageMax != null ? parseInt(a.ageMax, 10) : null;
        if ((lo != null && (lo < 18 || lo > 65)) || (hi != null && (hi < 18 || hi > 65)) || (lo != null && hi != null && lo > hi)) no('adGroups', 'Ages must be between 18 and 65.', 'group_age_invalid');
        else {
          out.campaignStructure = { groups: struct.groups + 1, adsPerGroup: struct.adsPerGroup };
          if (out.metaStructure) out.metaStructure = { adSets: struct.groups + 1, adsPerAdSet: struct.adsPerGroup };
          const groups = Array.isArray(ov.adGroups) ? ov.adGroups : [];
          while (groups.length < struct.groups) groups.push({});
          groups.push({ name: _str(a.name) || null, ageMin: lo, ageMax: hi });
          ov.adGroups = groups;
          ok('adGroups', 'Added ' + (platform === 'meta' ? 'an ad set' : 'an ad group') + (a.name ? ' “' + a.name + '”' : '') + (lo != null || hi != null ? ' (ages ' + (lo || 18) + '–' + (hi || 65) + ')' : ''));
        }
      }
    }
  }
  if (changes.removeAdGroup != null) {
    const struct = structureOf(out);
    const idx = parseInt(changes.removeAdGroup, 10);
    if (struct.groups <= 1 || !(idx >= 0 && idx < struct.groups)) no('adGroups', 'A campaign needs at least one ad set.', 'groups_min');
    else {
      out.campaignStructure = { groups: struct.groups - 1, adsPerGroup: struct.adsPerGroup };
      if (out.metaStructure) out.metaStructure = { adSets: struct.groups - 1, adsPerAdSet: struct.adsPerGroup };
      if (Array.isArray(ov.adGroups)) ov.adGroups.splice(idx, 1);
      ok('adGroups', 'Removed ad set ' + (idx + 1));
    }
  }
  return { pkg: out, applied, rejected };
}

// ════════════════════════════════════════════════════════════════
// Payload builders (pure). `ids` carries values resolved at publish time
// (uploaded image hashes/asset names, page/IG ids, geo resource names…).
// ════════════════════════════════════════════════════════════════
const payloads = {};

payloads.meta = {
  campaign(spec) {
    const body = {
      name: spec.campaign.name,
      objective: spec.campaign.objective,
      status: 'PAUSED',
      special_ad_categories: spec.campaign.specialAdCategories,
      // Budgets live on the ad sets; Meta requires this flag on campaigns
      // without a campaign budget.
      is_adset_budget_sharing_enabled: false,
    };
    if (spec.campaign.specialAdCategories.length) body.special_ad_category_country = spec.targeting.countries;
    return body;
  },
  adSet(spec, i, ids, campaignId) {
    const grp = spec.adGroups[i];
    const lo = grp.ageMin != null ? grp.ageMin : spec.targeting.ageMin;
    const hi = grp.ageMax != null ? grp.ageMax : spec.targeting.ageMax;
    const advantage = spec.targeting.advantageAudience && grp.ageMin == null && grp.ageMax == null;
    const targeting = { geo_locations: { countries: spec.targeting.countries }, age_min: lo, age_max: hi, targeting_automation: { advantage_audience: advantage ? 1 : 0 } };
    if (ids && Array.isArray(ids.localeKeys) && ids.localeKeys.length) targeting.locales = ids.localeKeys;
    if (spec.targeting.placement === 'instagram_only') targeting.publisher_platforms = ['instagram'];
    if (spec.targeting.placement === 'facebook_only') targeting.publisher_platforms = ['facebook'];
    const body = {
      name: grp.name,
      campaign_id: campaignId,
      status: 'PAUSED',
      daily_budget: minorUnits(spec.budget.amount, spec.budget.currency),
      billing_event: spec.optimization.billingEvent,
      optimization_goal: spec.optimization.goal,
      bid_strategy: spec.campaign.bidStrategy,
      targeting,
    };
    if (spec.optimization.destinationType) body.destination_type = spec.optimization.destinationType;
    if (spec.tracking.needsConversion) body.promoted_object = { pixel_id: spec.tracking.pixelId, custom_event_type: spec.tracking.conversionEvent };
    if (spec.compliance.euTargeted) { body.dsa_beneficiary = spec.compliance.dsaBeneficiary; body.dsa_payor = spec.compliance.dsaPayor; }
    return body;
  },
  creative(spec, ad, ids) {
    const link = spec.tracking.destinationUrl;
    const linkData = {
      link,
      message: ad.primaryText,
      name: ad.headline,
      image_hash: ids.imageHashes[ad.imageUrl] || ids.imageHashes[spec.creative.imageUrl],
      call_to_action: { type: metaCta(ad.cta), value: { link } },
    };
    if (ad.description) linkData.description = ad.description;
    const story = { page_id: spec.identity.pageId, link_data: linkData };
    if (spec.identity.instagramUserId) story.instagram_user_id = spec.identity.instagramUserId;
    return { name: ad.name + ' — Creative', object_story_spec: story, url_tags: spec.tracking.urlParams };
  },
  ad(spec, ad, adSetId, creativeId) {
    return { name: ad.name, adset_id: adSetId, creative: { creative_id: creativeId }, status: 'PAUSED' };
  },
};

const META_CTA = [
  [/shop/i, 'SHOP_NOW'], [/buy|order|get yours/i, 'BUY_NOW'], [/sign.?up|join|register/i, 'SIGN_UP'], [/subscribe/i, 'SUBSCRIBE'],
  [/download/i, 'DOWNLOAD'], [/book/i, 'BOOK_TRAVEL'], [/contact|call/i, 'CONTACT_US'], [/quote/i, 'GET_QUOTE'], [/offer|deal/i, 'GET_OFFER'],
  [/apply/i, 'APPLY_NOW'], [/watch/i, 'WATCH_MORE'], [/learn|discover|explore|see more|find out/i, 'LEARN_MORE'],
];
function metaCta(text) { for (const [re, t] of META_CTA) if (re.test(String(text || ''))) return t; return 'LEARN_MORE'; }

payloads.google = {
  budget(spec, name) { return { name, amountMicros: String(Math.round(spec.budget.amount * 1e6)), deliveryMethod: 'STANDARD', explicitlyShared: false }; },
  campaign(spec, budgetResourceName, extra) {
    const c = {
      name: spec.campaign.name,
      advertisingChannelType: spec.campaignType,
      status: 'PAUSED',
      campaignBudget: budgetResourceName,
      containsEuPoliticalAdvertising: spec.campaign.euPolitical,
      [spec.campaign.biddingField]: spec.campaign.biddingValue || {},
      finalUrlSuffix: spec.tracking.urlParams,
    };
    if (spec.campaign.network) c.networkSettings = spec.campaign.network;
    if (spec.campaignType === 'PERFORMANCE_MAX') c.brandGuidelinesEnabled = true;
    return Object.assign(c, extra || {});
  },
  // Location + language criteria. Search/PMax: campaign level; Demand Gen:
  // ad group level (Google's Demand Gen guide).
  targetingCriteria(spec, ids, parentField, parentResourceName) {
    const ops = [];
    for (const rn of ids.geoTargetConstants || []) ops.push({ [parentField]: parentResourceName, location: { geoTargetConstant: rn } });
    for (const rn of ids.languageConstants || []) ops.push({ [parentField]: parentResourceName, language: { languageConstant: rn } });
    return ops;
  },
  negativeKeywords(spec, campaignResourceName) {
    return spec.assets.negativeKeywords.map((text) => ({ campaign: campaignResourceName, negative: true, keyword: { text, matchType: 'PHRASE' } }));
  },
  searchAssets(spec) {
    const a = spec.assets, out = [];
    a.callouts.filter((x) => x.length <= G.CALLOUT).slice(0, 10).forEach((t) => out.push({ fieldType: 'CALLOUT', asset: { calloutAsset: { calloutText: t } } }));
    if (a.structuredSnippet) {
      const vals = a.structuredSnippet.values.filter((v) => v.length <= G.SNIPPET_VALUE).slice(0, 10);
      if (vals.length >= 3) out.push({ fieldType: 'STRUCTURED_SNIPPET', asset: { structuredSnippetAsset: { header: a.structuredSnippet.header, values: vals } } });
    }
    a.sitelinks.filter((x) => x.url && !validUrl(x.url) && x.text.length <= G.SITELINK_TEXT).slice(0, 8).forEach((x) => {
      const sl = { linkText: x.text };
      if (x.description1 && x.description2 && x.description1.length <= G.SITELINK_DESC && x.description2.length <= G.SITELINK_DESC) { sl.description1 = x.description1; sl.description2 = x.description2; }
      out.push({ fieldType: 'SITELINK', asset: { sitelinkAsset: sl, finalUrls: [x.url] } });
    });
    return out;
  },
  rsa(spec, ad, adGroupResourceName) {
    return { adGroup: adGroupResourceName, status: 'ENABLED', ad: { responsiveSearchAd: {
      headlines: ad.headlines.filter((h) => h.length <= G.RSA_HEADLINE).slice(0, 15).map((text) => ({ text })),
      descriptions: ad.descriptions.filter((d) => d.length <= G.RSA_DESCRIPTION).slice(0, 4).map((text) => ({ text })),
    }, finalUrls: [spec.tracking.destinationUrl] } };
  },
  pmaxText(spec) {
    const a = spec.assets;
    const headlines = a.headlines.filter((h) => h.length <= G.RSA_HEADLINE).slice(0, 15);
    let descriptions = a.descriptions.filter((d) => d.length <= G.RSA_DESCRIPTION);
    const short = descriptions.find((d) => d.length <= G.PMAX_SHORT_DESCRIPTION);
    descriptions = (short ? [short].concat(descriptions.filter((d) => d !== short)) : descriptions).slice(0, 5);
    const longHeadline = (a.longHeadline && a.longHeadline.length <= G.PMAX_LONG_HEADLINE ? a.longHeadline : (a.descriptions.find((d) => d.length <= G.PMAX_LONG_HEADLINE) || headlines[0] || spec.campaign.name)).slice(0, G.PMAX_LONG_HEADLINE);
    return { headlines, descriptions, longHeadline, businessName: (a.businessName || '').slice(0, G.BUSINESS_NAME) };
  },
  demandGenAd(spec, ids, adGroupResourceName) {
    const a = spec.assets;
    const ad = {
      headlines: a.headlines.filter((h) => h.length <= G.DG_HEADLINE).slice(0, G.DG_MAX).map((text) => ({ text })),
      descriptions: a.descriptions.filter((d) => d.length <= G.DG_DESCRIPTION).slice(0, G.DG_MAX).map((text) => ({ text })),
      businessName: (a.businessName || '').slice(0, G.BUSINESS_NAME),
      logoImages: [{ asset: ids.logoAsset }],
      squareMarketingImages: [{ asset: ids.squareAsset }],
    };
    if (ids.landscapeAsset) ad.marketingImages = [{ asset: ids.landscapeAsset }];
    return { adGroup: adGroupResourceName, status: 'ENABLED', ad: { demandGenMultiAssetAd: ad, finalUrls: [spec.tracking.destinationUrl] } };
  },
};

payloads.tiktok = {
  campaign(spec, advertiserId) {
    // Budget on the ad group only (campaign budget unlimited), so TikTok's
    // ad-group minimum is the one that applies.
    return { advertiser_id: advertiserId, campaign_name: spec.campaign.name, objective_type: spec.campaign.objective, budget_mode: 'BUDGET_MODE_INFINITE', operation_status: 'DISABLE' };
  },
  adGroup(spec, i, ids, advertiserId, campaignId, scheduleStart) {
    const grp = spec.adGroups[i];
    const lo = grp.ageMin != null ? grp.ageMin : spec.targeting.ageMin;
    const hi = grp.ageMax != null ? grp.ageMax : spec.targeting.ageMax;
    const ageGroups = tiktokAgeGroups(lo, hi);
    const body = {
      advertiser_id: advertiserId,
      campaign_id: String(campaignId),
      adgroup_name: grp.name,
      promotion_type: spec.optimization.promotionType,
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_TIKTOK'],
      location_ids: ids.locationIds,
      optimization_goal: spec.optimization.goal,
      billing_event: spec.optimization.billingEvent,
      bid_type: spec.optimization.bidType,
      budget_mode: 'BUDGET_MODE_DAY',
      budget: spec.budget.amount,
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: scheduleStart,
      pacing: 'PACING_MODE_SMOOTH',
      operation_status: 'DISABLE',
      identity_id: spec.identity.identityId,
      identity_type: spec.identity.identityType,
    };
    if (!(lo <= 18 && hi >= 65)) body.age_groups = ageGroups;
    if (spec.targeting.languages.length) body.languages = spec.targeting.languages;
    return body;
  },
  ad(spec, ad, ids, advertiserId, adGroupId) {
    return { advertiser_id: advertiserId, adgroup_id: String(adGroupId), creatives: [{
      ad_name: ad.name,
      ad_format: 'SINGLE_VIDEO',
      video_id: ids.videoId,
      image_ids: [ids.coverImageId],
      ad_text: ad.adText,
      call_to_action: campaignGoals.tiktokCtaType(ad.cta),
      landing_page_url: withParams(spec.tracking.destinationUrl, spec.tracking.urlParams),
      identity_id: spec.identity.identityId,
      identity_type: spec.identity.identityType,
      operation_status: 'DISABLE',
    }] };
  },
};

payloads.pinterest = {
  campaign(spec) {
    return { name: spec.campaign.name, objective_type: spec.campaign.objective, status: 'PAUSED', is_campaign_budget_optimization: true, daily_spend_cap: Math.round(spec.budget.amount * 1e6) };
  },
  adGroup(spec, i, campaignId) {
    const grp = spec.adGroups[i];
    const body = {
      campaign_id: String(campaignId),
      name: grp.name,
      status: 'PAUSED',
      budget_type: 'CBO_ADGROUP',
      billable_event: spec.optimization.billableEvent,
      bid_strategy_type: spec.optimization.bidStrategy,
      targeting_spec: { LOCATION: spec.targeting.countries.slice() }, // array of ISO codes (Pinterest targeting docs)
    };
    if (spec.tracking.needsConversion) {
      body.optimization_goal_metadata = { conversion_tag_v3_goal_metadata: { conversion_tag_id: spec.tracking.conversionTagId, conversion_event: spec.tracking.conversionEvent } };
    }
    return body;
  },
  pin(spec, boardId, mediaUrl, isVideo) {
    const b = { board_id: boardId, title: spec.pin.title, description: spec.pin.description, alt_text: spec.pin.altText || undefined, link: withParams(spec.tracking.destinationUrl, spec.tracking.urlParams) };
    b.media_source = isVideo ? { source_type: 'video_id', media_id: mediaUrl } : { source_type: 'image_url', url: mediaUrl };
    return b;
  },
  ad(spec, ad, adGroupId, pinId) {
    const b = { ad_group_id: String(adGroupId), name: ad.name, creative_type: spec.creative.format === 'VIDEO' ? 'VIDEO' : 'REGULAR', pin_id: String(pinId), destination_url: withParams(spec.tracking.destinationUrl, spec.tracking.urlParams), status: 'PAUSED' };
    const cta = campaignGoals.pinterestCtaType(ad.cta);
    if (cta) b.customizable_cta_type = cta;
    return b;
  },
};

function withParams(url, params) {
  if (!url || !params) return url;
  return url + (url.includes('?') ? '&' : '?') + params;
}

// Spec summary for the publish confirmation and logs — what will actually be sent.
function summary(spec) {
  return {
    platform: spec.platform,
    campaignType: spec.campaignType,
    name: spec.campaign.name,
    goal: spec.campaign.goal,
    objective: spec.campaign.objective || spec.campaign.bidStrategyLabel || null,
    countries: spec.targeting.countries,
    languages: spec.targeting.languages,
    ages: spec.platform === 'google' || spec.platform === 'pinterest' ? null : [spec.targeting.ageMin, spec.targeting.ageMax],
    budget: spec.budget.amount,
    currency: spec.budget.currency,
    adGroups: spec.adGroups.length,
    ads: spec.adGroups.reduce((n, g) => n + (g.ads ? g.ads.length : 0), 0),
    destinationUrl: spec.tracking.destinationUrl,
    status: 'PAUSED',
  };
}

// The route module registers how to load a user's live context (business
// profile + ad account facts), so Oriven Chat tools can validate edits the
// same way the review screen and publishing do.
let _contextLoader = null;
function setContextLoader(fn) { _contextLoader = fn; }
async function loadContext(user, platform) { return _contextLoader ? _contextLoader(user, platform, false) : {}; }

module.exports = {
  sectionOf, checklist, SECTIONS, formatLabel,
  setContextLoader, loadContext,
  SPEC_VERSION, PLATFORMS, GOALS, COUNTRIES, COUNTRY_BY_ISO, LANGUAGES, GOOGLE_LANG_CODE, META_SPECIAL_CATEGORIES, META_CONVERSION_EVENTS,
  META_PLACEMENTS, PINTEREST_CONVERSION_EVENTS, GOOGLE_SNIPPET_HEADERS, TIKTOK_MIN_ADGROUP_DAILY, SUPPORT, LIVE_UNVERIFIED, G,
  parseCountries, parseLanguages, isEu, countryName, validUrl,
  buildSpec, validate, hasErrors, applyChanges, payloads, summary, metaCta, withParams, budgetOf, destinationOf,
};
