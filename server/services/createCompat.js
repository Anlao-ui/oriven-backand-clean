/* ════════════════════════════════════════════════════════════════
   Create compatibility schema — the ONE source of truth for which
   platform × campaign type × goal × creative format combinations
   OrivenAI can actually generate AND publish.

   This exact file is loaded by the backend (require) and by the browser
   (<script src="/js/createCompat.js">, exposed as window.OrivenCreateCompat).
   The frontend copy must be byte-identical to this one — tests/create-
   compat.test.js fails if they drift (it compares the two files and the
   VERSION string). Edit here, then copy to oriven-frontend/js/.

   What is listed here is what the PUBLISH code really does today
   (routes/publishRoutes.js + services/campaignSpec.js), not everything the
   ad platforms themselves offer:
     • Google — Search (text, RSA), Performance Max (images + business name
       + logo), Demand Gen (image + business name + logo). No Google video.
     • Meta — single-image ads only (publish uploads images to /adimages;
       there is no video upload path). Standard objectives only: the extra
       Engagement / App Promotion objectives are not publishable (no
       on-post destination, no app id is ever collected).
     • TikTok — video ads only (SINGLE_VIDEO), Traffic and Awareness only
       (Sales needs a TikTok Pixel event, Leads needs instant forms — neither
       is configured). Video Views / App Promotion are not wired into the
       publish spec.
     • Pinterest — image or video Pins; all four goals (Sales/Leads need a
       Pinterest Tag, checked in Launch); Video Completion only for video.
   ════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrivenCreateCompat = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '2026-10-17.1';
  var GOALS = ['Sales', 'Traffic', 'Leads', 'Awareness'];

  // Beginner-facing goal wording (the internal keys stay Sales/Leads/…).
  var GOAL_TEXT = {
    Sales:     { label: 'Get more sales',            desc: 'Get people to buy from you.' },
    Traffic:   { label: 'Get more website visitors', desc: 'Bring people to your website.' },
    Leads:     { label: 'Generate leads',            desc: 'Get enquiries, quotes or sign-ups.' },
    Awareness: { label: 'Increase brand awareness',  desc: 'Get your business noticed.' },
  };

  var FORMAT_TEXT = {
    text:  { label: 'Text',  desc: 'Headlines and descriptions, no image.' },
    image: { label: 'Image', desc: 'A ready-made image ad.' },
    video: { label: 'Video', desc: 'A short vertical video ad.' },
  };

  var PLATFORMS = {
    google: {
      label: 'Google Ads', sub: 'Search, YouTube, Gmail and more',
      tagline: 'Reach people searching for products like yours.',
      defaultType: 'SEARCH',
      types: {
        SEARCH: {
          label: 'Search', desc: 'Text ads in Google search results.',
          goals: GOALS, formats: ['text'], structure: true,
        },
        PERFORMANCE_MAX: {
          label: 'Performance Max', desc: 'Image ads across Search, YouTube, Display, Gmail and Maps.',
          goals: ['Sales', 'Leads'], formats: ['image'], structure: false,
          profileNeeds: ['businessName', 'logo'],
          note: 'Performance Max also uses your business name and logo from your business profile.',
        },
        DEMAND_GEN: {
          label: 'Demand Gen', desc: 'Visual ads on YouTube, Discover and Gmail.',
          goals: GOALS, formats: ['image'], structure: false,
          profileNeeds: ['businessName', 'logo'],
          note: 'Demand Gen also uses your business name and logo from your business profile.',
        },
      },
      // Which Google type an image ad uses by default, per goal.
      imageTypeFor: { Sales: 'PERFORMANCE_MAX', Leads: 'PERFORMANCE_MAX', Traffic: 'DEMAND_GEN', Awareness: 'DEMAND_GEN' },
    },
    meta: {
      label: 'Meta Ads', sub: 'Facebook and Instagram',
      tagline: 'Reach customers on Facebook and Instagram.',
      defaultType: 'STANDARD',
      types: { STANDARD: { label: 'Standard', goals: GOALS, formats: ['image'], structure: true } },
    },
    tiktok: {
      label: 'TikTok Ads', sub: 'Short vertical videos',
      tagline: 'Create engaging short-form video ads.',
      defaultType: 'STANDARD',
      types: { STANDARD: { label: 'Standard', goals: ['Traffic', 'Awareness'], formats: ['video'], structure: true } },
    },
    pinterest: {
      label: 'Pinterest Ads', sub: 'Promoted Pins',
      tagline: 'Reach people discovering products and ideas.',
      defaultType: 'STANDARD',
      types: {
        STANDARD: {
          label: 'Standard', goals: GOALS, formats: ['image', 'video'], structure: true,
          objectives: { 'Video Completion': { goals: ['Awareness'], formats: ['video'], desc: 'Optimise for people watching your video to the end.' } },
        },
      },
    },
  };

  // Why something is unavailable — written for a first-time advertiser,
  // always with a working alternative.
  var REASONS = {
    tiktok_goal_Sales: { message: 'TikTok sales campaigns need a TikTok Pixel purchase event, which OrivenAI can’t set up yet.', suggestion: 'Choose “Get more website visitors” on TikTok, or run a sales campaign on Meta or Google.' },
    tiktok_goal_Leads: { message: 'TikTok lead campaigns use TikTok’s own forms, which OrivenAI doesn’t support yet.', suggestion: 'Choose “Get more website visitors” on TikTok, or run a lead campaign on Meta or Google.' },
    pmax_goal: { message: 'Performance Max is for sales and leads.', suggestion: 'Use Demand Gen for image ads with this goal, or a Search text ad.' },
    format_meta_video: { message: 'OrivenAI can publish image ads to Meta, but not video ads yet.', suggestion: 'Use an image ad on Meta, or make a video ad for TikTok or Pinterest.' },
    format_tiktok_image: { message: 'TikTok ads are videos. Image-only ads don’t run in the TikTok feed.', suggestion: 'Use a video ad on TikTok, or an image ad on Meta or Pinterest.' },
    format_google_text_only: { message: 'Google Search ads are text only: they show headlines and descriptions, no image.', suggestion: 'Choose Text, or pick an image ad type for Google (Demand Gen or Performance Max).' },
    format_google_video: { message: 'OrivenAI doesn’t publish Google video (YouTube) campaigns yet.', suggestion: 'Use a text ad (Search) or an image ad (Demand Gen / Performance Max).' },
    format_google_image_only: { message: 'This Google ad type needs images, not text only.', suggestion: 'Choose Image, or switch to Search for a text ad.' },
    objective_unsupported: { message: 'This objective can’t be published by OrivenAI yet.', suggestion: 'Keep the standard objective for your goal.' },
    objective_video_completion: { message: 'Video Completion needs a video ad and the “Increase brand awareness” goal.', suggestion: 'Choose Video and “Increase brand awareness”, or keep the standard objective.' },
    platform_unknown: { message: 'Choose where the ad should run: Google, Meta, TikTok or Pinterest.', suggestion: '' },
    type_unknown: { message: 'This Google campaign type can’t be published by OrivenAI.', suggestion: 'Use Search, Performance Max or Demand Gen.' },
    goal_unknown: { message: 'Choose what the ad should achieve.', suggestion: '' },
    structure_range: { message: 'Choose 1 to 5 ad sets or ad groups, with 1 to 5 ads in each.', suggestion: 'Use a smaller number of ads.' },
    structure_fixed: { message: 'This ad type always publishes as one ad, so the number of ads can’t be changed.', suggestion: 'Keep one ad, or choose Search on Google for several ads.' },
    image_source: { message: 'Choose how the image is made: generated with AI, or your own image.', suggestion: '' },
  };
  // Problems with an uploaded image (the frontend shows these in the
  // interface language by code; the upload route returns them in English).
  var IMAGE_REASONS = {
    image_type: 'This file type isn’t supported. Use a JPG or PNG image.',
    image_size: 'This image is larger than 8 MB. Use a smaller file.',
    image_read: 'This image couldn’t be read. Try a different file.',
    image_small: 'This image is too small. Use an image of at least 600 × 314 pixels.',
    crop_google: 'Google needs specific shapes for this ad type. When you publish, OrivenAI centre-crops your image to those shapes — keep the important part in the middle.',
    meta_ratio: 'Meta shows feed images between 1.91:1 (wide) and 4:5 (tall). Meta may crop this image in some placements.',
    pin_wide: 'Pins look best tall (2:3). A wide image shows smaller in the Pinterest feed.',
    pin_tall: 'Pinterest cuts off Pins taller than 1:2.1 in the feed. Use a less tall image if the bottom matters.',
  };
  // Objectives the old Create offered that the publish code can't honour.
  var UNSUPPORTED_OBJECTIVES = ['engagement', 'app promotion', 'app_promotion', 'appromotion', 'video views', 'video_views', 'community interaction'];

  function _norm(s) { return String(s == null ? '' : s).trim(); }
  function _lower(s) { return _norm(s).toLowerCase(); }
  function normalizeGoal(g) {
    var t = _lower(g);
    if (!t) return null;
    for (var i = 0; i < GOALS.length; i++) if (GOALS[i].toLowerCase() === t) return GOALS[i];
    if (/sale|conversion|purchase/.test(t)) return 'Sales';
    if (/lead|sign.?up/.test(t)) return 'Leads';
    if (/traffic|visit|click|consideration/.test(t)) return 'Traffic';
    if (/aware|reach/.test(t)) return 'Awareness';
    return null;
  }
  // creativeMode ('images'/'videos', the existing Create field) → format.
  function formatFromMode(mode) {
    var m = _lower(mode);
    if (m === 'videos' || m === 'video') return 'video';
    if (m === 'text') return 'text';
    if (m === 'images' || m === 'image') return 'image';
    return null;
  }
  function modeFromFormat(fmt) { return fmt === 'video' ? 'videos' : 'images'; }

  function platformInfo(p) { return PLATFORMS[p] || null; }
  function typeKeys(p) { var pi = PLATFORMS[p]; return pi ? Object.keys(pi.types) : []; }
  function typeInfo(p, t) { var pi = PLATFORMS[p]; return pi ? (pi.types[t || pi.defaultType] || null) : null; }
  function resolveType(p, t) {
    var pi = PLATFORMS[p];
    if (!pi) return null;
    if (p !== 'google') return pi.defaultType;
    var k = _norm(t).toUpperCase();
    return k || pi.defaultType;
  }

  // ── Options for the guided UI ──────────────────────────────────────
  // Goals available on a platform (for Google: on ANY publishable type).
  function goalOptions(p, campaignType) {
    var pi = PLATFORMS[p];
    if (!pi) return [];
    return GOALS.map(function (g) {
      var ok;
      if (campaignType) { var ti = typeInfo(p, campaignType); ok = !!ti && ti.goals.indexOf(g) !== -1; }
      else ok = typeKeys(p).some(function (k) { return pi.types[k].goals.indexOf(g) !== -1; });
      var r = ok ? null : (REASONS[p + '_goal_' + g] || (p === 'google' ? REASONS.pmax_goal : REASONS.objective_unsupported));
      return { goal: g, label: GOAL_TEXT[g].label, desc: GOAL_TEXT[g].desc, available: ok, reason: r ? r.message : null, suggestion: r ? r.suggestion : null };
    });
  }
  // Formats for a platform + goal. For Google the format decides the
  // campaign type (Text → Search, Image → PMax/Demand Gen).
  function formatOptions(p, goal, campaignType) {
    var pi = PLATFORMS[p];
    if (!pi) return [];
    return ['text', 'image', 'video'].map(function (f) {
      var ok = false, reasonKey = null, type = null;
      if (p === 'google') {
        if (f === 'video') reasonKey = 'format_google_video';
        else if (f === 'text') { ok = !goal || PLATFORMS.google.types.SEARCH.goals.indexOf(goal) !== -1; type = 'SEARCH'; }
        else {
          type = typesForFormat('google', 'image', goal)[0] || null;
          ok = !!type;
        }
      } else {
        var ti = typeInfo(p, campaignType);
        ok = !!ti && ti.formats.indexOf(f) !== -1;
        if (!ok) reasonKey = p === 'meta' && f === 'video' ? 'format_meta_video' : (p === 'tiktok' && f === 'image' ? 'format_tiktok_image' : null);
        type = pi.defaultType;
      }
      var r = reasonKey ? REASONS[reasonKey] : null;
      var hidden = !ok && !r; // e.g. "text" on Meta: never offered, no need to explain
      return { format: f, label: FORMAT_TEXT[f].label, desc: FORMAT_TEXT[f].desc, available: ok, hidden: hidden, campaignType: type, reason: r ? r.message : null, suggestion: r ? r.suggestion : null };
    });
  }
  // Publishable Google types for a format (+goal), recommended first.
  function typesForFormat(p, fmt, goal) {
    if (p !== 'google') return PLATFORMS[p] ? [PLATFORMS[p].defaultType] : [];
    var out = typeKeys('google').filter(function (k) {
      var ti = PLATFORMS.google.types[k];
      return ti.formats.indexOf(fmt) !== -1 && (!goal || ti.goals.indexOf(goal) !== -1);
    });
    if (fmt === 'image' && goal) {
      var pref = PLATFORMS.google.imageTypeFor[goal];
      out.sort(function (a, b) { return (a === pref ? -1 : 0) - (b === pref ? -1 : 0); });
    }
    return out;
  }
  function objectiveOptions(p, campaignType, goal, fmt) {
    var ti = typeInfo(p, campaignType);
    if (!ti || !ti.objectives) return [];
    return Object.keys(ti.objectives).map(function (k) {
      var o = ti.objectives[k];
      var ok = (!goal || o.goals.indexOf(goal) !== -1) && (!fmt || o.formats.indexOf(fmt) !== -1);
      return { objective: k, desc: o.desc, available: ok, reason: ok ? null : REASONS.objective_video_completion.message };
    });
  }

  // ── The check (frontend before generation, backend before charging,
  //    Launch spec before publishing) ───────────────────────────────
  // input: { platform, campaignType, goal, format, objective }
  // opts.legacy: request from an older Create that always sent
  //   creativeMode 'images' — for Google Search that meant "the default",
  //   not a real image request, so it's read as text instead of refused.
  function check(input, opts) {
    input = input || {}; opts = opts || {};
    var issues = [];
    var add = function (code, field, key) { var r = REASONS[key] || REASONS[code] || { message: code, suggestion: '' }; issues.push({ code: code, field: field, reason: REASONS[key] ? key : code, message: r.message, suggestion: r.suggestion }); };
    var p = _lower(input.platform);
    var pi = PLATFORMS[p];
    if (!pi) { add('platform_unknown', 'platform', 'platform_unknown'); return { ok: false, issues: issues, version: VERSION }; }
    var goal = normalizeGoal(input.goal);
    if (!goal) add('goal_unknown', 'goal', 'goal_unknown');
    var type = resolveType(p, input.campaignType);
    var ti = pi.types[type];
    if (!ti) { add('type_unknown', 'campaignType', 'type_unknown'); return { ok: false, platform: p, issues: issues, version: VERSION }; }
    var fmt = _lower(input.format) || null;
    var normalized = [];
    if (!fmt) { fmt = ti.formats[0]; normalized.push('format'); }
    if (p === 'google' && type === 'SEARCH' && fmt === 'image' && opts.legacy) { fmt = 'text'; normalized.push('format'); }
    if (goal && ti.goals.indexOf(goal) === -1) {
      add(p === 'tiktok' ? 'tiktok_goal' : 'goal_type', 'goal', p === 'tiktok' ? 'tiktok_goal_' + goal : (type === 'PERFORMANCE_MAX' ? 'pmax_goal' : 'objective_unsupported'));
    }
    if (ti.formats.indexOf(fmt) === -1) {
      var fk = p === 'meta' && fmt === 'video' ? 'format_meta_video'
        : p === 'tiktok' ? 'format_tiktok_image'
        : p === 'google' && fmt === 'video' ? 'format_google_video'
        : p === 'google' && type === 'SEARCH' ? 'format_google_text_only'
        : p === 'google' ? 'format_google_image_only'
        : 'objective_unsupported';
      add('format_unsupported', 'format', fk);
    }
    var objective = _norm(input.objective) || null;
    // Ad quantity: what the publish code builds (spec.adGroups, 1–5 × 1–5).
    if (input.groups != null || input.adsPerGroup != null) {
      var sg = input.groups == null ? 1 : input.groups, sa = input.adsPerGroup == null ? 1 : input.adsPerGroup;
      if (!validStructure(sg, sa)) add('structure_range', 'structure', 'structure_range');
      else if (!ti.structure && (Number(sg) > 1 || Number(sa) > 1) && !opts.legacy) add('structure_fixed', 'structure', 'structure_fixed');
    }
    if (input.imageSource != null && ['ai', 'own'].indexOf(_lower(input.imageSource)) === -1) add('image_source', 'imageSource', 'image_source');
    if (objective) {
      var oi = ti.objectives && ti.objectives[objective];
      // Anything not listed for this type is refused — including the extra
      // objectives older Create screens offered (UNSUPPORTED_OBJECTIVES).
      if (!oi) add('objective_unsupported', 'objective', 'objective_unsupported');
      else if ((goal && oi.goals.indexOf(goal) === -1) || oi.formats.indexOf(fmt) === -1) {
        add('objective_combination', 'objective', 'objective_video_completion');
      }
    }
    return {
      ok: issues.length === 0, version: VERSION, issues: issues, normalized: normalized,
      platform: p, campaignType: p === 'google' ? type : null, goal: goal, format: fmt, objective: objective,
      creativeMode: modeFromFormat(fmt), assets: assetsFor(p, type, fmt),
    };
  }

  // What has to be generated for a publishable ad of this kind.
  //   images: 'per-ad' | 'pmax' (3 aspect variants) | 'single' | 0
  //   video:  'per-ad' | 'single' | 0
  function assetsFor(p, type, fmt) {
    if (fmt === 'text') return { copy: true, images: 0, video: 0 };
    if (fmt === 'video') return { copy: true, images: 0, video: p === 'pinterest' ? 'single' : 'per-ad' };
    if (p === 'google') return { copy: true, images: type === 'PERFORMANCE_MAX' ? 'pmax' : 'single', video: 0 };
    return { copy: true, images: 'per-ad', video: 0 };
  }
  // Number of generated creatives for a structure (groups × ads per group).
  function creativeUnits(assets, adCount) {
    var n = Math.max(1, adCount || 1);
    return {
      images: assets.images === 'per-ad' ? n : assets.images === 'pmax' ? 3 : assets.images === 'single' ? 1 : 0,
      videos: assets.video === 'per-ad' ? n : assets.video === 'single' ? 1 : 0,
    };
  }
  // Credit estimate from the server's own FEATURE_COSTS (never hardcoded here).
  // opts.imageSource 'own': the user's uploaded images are the ad images,
  // so no image is generated and none is charged (only the ad text).
  function estimateCredits(costs, assets, adCount, opts) {
    costs = costs || {}; opts = opts || {};
    var u = creativeUnits(assets, adCount);
    var ownSlots = _lower(opts.imageSource) === 'own' ? u.images : 0;
    if (ownSlots) u.images = 0;
    var copy = costs.campaign_generation || 0, img = costs.image_generation || 0, vid = costs.video_generation || 0;
    return { total: copy + u.images * img + u.videos * vid, copy: copy, images: u.images, videos: u.videos, imageCost: img, videoCost: vid, ownImageSlots: ownSlots };
  }

  // ── Ad quantity ─────────────────────────────────────────────────────
  // What Create can configure is exactly what the publish routes build:
  // N ad sets (Meta) / ad groups (Google Search, TikTok, Pinterest) with M
  // ads each, 1–5 per level. Performance Max (one asset group) and Demand
  // Gen (one ad group, one ad) have a fixed shape.
  var MAX_GROUPS = 5, MAX_ADS_PER_GROUP = 5;
  function _int(v) { if (v === '' || v == null || typeof v === 'boolean') return NaN; var n = Number(v); return Number.isInteger(n) ? n : NaN; }
  function validStructure(groups, ads) { var g = _int(groups), a = _int(ads); return g >= 1 && g <= MAX_GROUPS && a >= 1 && a <= MAX_ADS_PER_GROUP; }
  function structureFor(p, type) {
    p = _lower(p);
    var t = resolveType(p, type);
    var ti = typeInfo(p, t);
    if (!ti) return null;
    if (!ti.structure) return { configurable: false, unit: t === 'PERFORMANCE_MAX' ? 'assetGroup' : 'adGroup', maxGroups: 1, maxAdsPerGroup: 1 };
    return { configurable: true, unit: p === 'meta' ? 'adSet' : 'adGroup', maxGroups: MAX_GROUPS, maxAdsPerGroup: MAX_ADS_PER_GROUP };
  }
  function adCountFor(p, type, groups, ads) {
    var st = structureFor(p, type);
    if (!st || !st.configurable || !validStructure(groups, ads)) return 1;
    return _int(groups) * _int(ads);
  }

  // ── The user's own ad images ────────────────────────────────────────
  // Requirements are documentation-based (Meta, Google Ads and Pinterest
  // ad specs, Oct 2026) and kept simple: JPG/PNG up to 8 MB (the upload
  // route's limit), at least 600 × 314 px (Google's minimum landscape
  // size, which also clears Meta's and Pinterest's minimums).
  var IMAGE_TYPES = ['image/jpeg', 'image/png'];
  var IMAGE_MAX_BYTES = 8 * 1024 * 1024;
  var IMAGE_MIN = { width: 600, height: 314 };
  var SHAPES = { landscape: 1.91, square: 1, portrait: 0.8 };
  function shapeOf(w, h) { var r = w / h; for (var k in SHAPES) if (Math.abs(r - SHAPES[k]) / SHAPES[k] <= 0.01) return k; return null; }
  // Shapes the publish code needs for a Google image ad type (it centre-
  // crops to them when no uploaded image already has that shape).
  function googleShapes(type) { return type === 'PERFORMANCE_MAX' ? ['landscape', 'square'] : type === 'DEMAND_GEN' ? ['square'] : []; }
  // How many own images are useful: one per ad (reused when fewer), one per
  // Performance Max shape, or one for Demand Gen.
  function ownImageMax(p, type, adCount) {
    p = _lower(p);
    var a = assetsFor(p, resolveType(p, type), 'image');
    return a.images === 'pmax' ? 3 : a.images === 'single' ? 1 : a.images === 'per-ad' ? Math.max(1, Math.min(adCount || 1, MAX_GROUPS * MAX_ADS_PER_GROUP)) : 0;
  }
  // One file { type, bytes, width, height } → the problems that block it.
  function checkImageFile(img) {
    img = img || {};
    var errors = [];
    if (IMAGE_TYPES.indexOf(_lower(img.type)) === -1) errors.push('image_type');
    else if (!(img.bytes > 0)) errors.push('image_read');
    else if (img.bytes > IMAGE_MAX_BYTES) errors.push('image_size');
    if (!errors.length) {
      if (!(img.width > 0 && img.height > 0)) errors.push('image_read');
      else if (img.width < IMAGE_MIN.width || img.height < IMAGE_MIN.height) errors.push('image_small');
    }
    return errors.map(function (c) { return { code: c, message: IMAGE_REASONS[c] }; });
  }
  // The whole set for a platform → what the user must be told (cropping at
  // publish, platform display behaviour). Never blocks, never edits.
  function imageNotices(images, p, type) {
    p = _lower(p); type = resolveType(p, type);
    var out = [];
    var list = (images || []).filter(function (i) { return i && i.width > 0 && i.height > 0; });
    if (!list.length) return out;
    if (p === 'google') {
      var have = list.map(function (i) { return shapeOf(i.width, i.height); });
      var missing = googleShapes(type).filter(function (sh) { return have.indexOf(sh) === -1; });
      if (missing.length) out.push({ code: 'crop_google', shapes: missing, message: IMAGE_REASONS.crop_google });
    } else if (p === 'meta') {
      if (list.some(function (i) { var r = i.width / i.height; return r > 1.91 * 1.01 || r < 0.8 * 0.99; })) out.push({ code: 'meta_ratio', message: IMAGE_REASONS.meta_ratio });
    } else if (p === 'pinterest') {
      if (list.some(function (i) { return i.width / i.height > 1.01; })) out.push({ code: 'pin_wide', message: IMAGE_REASONS.pin_wide });
      if (list.some(function (i) { return i.height / i.width > 2.1; })) out.push({ code: 'pin_tall', message: IMAGE_REASONS.pin_tall });
    }
    return out;
  }

  // ── Product price ───────────────────────────────────────────────────
  var CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'NZD', 'BRL', 'MXN', 'JPY', 'INR', 'ZAR'];
  var COUNTRY_CURRENCY = { NL: 'EUR', BE: 'EUR', DE: 'EUR', AT: 'EUR', FR: 'EUR', LU: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', FI: 'EUR', IE: 'EUR', CH: 'CHF', DK: 'DKK', SE: 'SEK', NO: 'NOK', PL: 'PLN', CZ: 'CZK', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', BR: 'BRL', MX: 'MXN', JP: 'JPY', IN: 'INR', ZA: 'ZAR' };
  function currencyCode(v) { var c = _norm(v).toUpperCase(); return CURRENCIES.indexOf(c) !== -1 ? c : null; }
  function currencyDecimals(c) { return c === 'JPY' ? 0 : 2; }
  // profile.currency → business country → browser locale region. Only the
  // profile value counts as confirmed; the rest are suggestions.
  function suggestCurrency(profile, locale) {
    profile = profile || {};
    var c = currencyCode(profile.currency);
    if (c) return { code: c, source: 'profile' };
    var iso = countryIso(profile.country);
    if (iso && COUNTRY_CURRENCY[iso]) return { code: COUNTRY_CURRENCY[iso], source: 'country' };
    var m = /[-_]([A-Za-z]{2})$/.exec(_norm(locale));
    if (m && COUNTRY_CURRENCY[m[1].toUpperCase()]) return { code: COUNTRY_CURRENCY[m[1].toUpperCase()], source: 'locale' };
    return { code: 'USD', source: 'default' };
  }
  // A price the user typed: '', '29.99', '29,99', 149.95, '0'. Empty means
  // "no price" (null), never zero. Negative values, letters, more decimals
  // than the currency has, or more than 7 digits are refused.
  function parsePrice(v, currency) {
    if (v == null || (typeof v === 'string' && !v.trim())) return { ok: true, amount: null };
    var dec = currencyDecimals(currencyCode(currency) || 'EUR');
    var t = typeof v === 'number' ? (isFinite(v) ? String(v) : 'x') : _norm(v).replace(',', '.');
    var re = dec ? /^\d{1,7}(\.\d{1,2})?$/ : /^\d{1,7}$/;
    if (!re.test(t)) return { ok: false, amount: null, error: 'price_invalid' };
    return { ok: true, amount: Math.round(Number(t) * 100) / 100 };
  }
  // Does an image-generation request make sense for this ad? (backend
  // refuses before charging when it doesn't).
  // An image request is legitimate when the ad type can show images — or,
  // on TikTok, as the cover of a video ad. Google Search can't use one.
  function needsImages(p, type, fmt) {
    p = _lower(p);
    var ti = typeInfo(p, resolveType(p, type));
    if (!ti) return false;
    if (p === 'tiktok') return true;
    return ti.formats.indexOf('image') !== -1;
  }
  function needsVideo(p, type, fmt) { var a = assetsFor(_lower(p), resolveType(_lower(p), type), fmt || 'video'); return !!a.video; }
  function platformSupportsFormat(p, fmt) {
    var pi = PLATFORMS[_lower(p)];
    if (!pi) return false;
    return typeKeys(_lower(p)).some(function (k) { return pi.types[k].formats.indexOf(fmt) !== -1; });
  }

  // ── Advertising language ───────────────────────────────────────────
  var LANGUAGES = [
    { code: 'en', name: 'English', native: 'English' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands' },
    { code: 'de', name: 'German', native: 'Deutsch' },
    { code: 'fr', name: 'French', native: 'Français' },
    { code: 'es', name: 'Spanish', native: 'Español' },
    { code: 'it', name: 'Italian', native: 'Italiano' },
    { code: 'pt', name: 'Portuguese', native: 'Português' },
    { code: 'da', name: 'Danish', native: 'Dansk' },
    { code: 'sv', name: 'Swedish', native: 'Svenska' },
    { code: 'no', name: 'Norwegian', native: 'Norsk' },
    { code: 'fi', name: 'Finnish', native: 'Suomi' },
    { code: 'pl', name: 'Polish', native: 'Polski' },
  ];
  var LANG_ALIASES = { nederlands: 'nl', dutch: 'nl', flemish: 'nl', vlaams: 'nl', english: 'en', engels: 'en', german: 'de', deutsch: 'de', duits: 'de', french: 'fr', français: 'fr', francais: 'fr', frans: 'fr', spanish: 'es', español: 'es', espanol: 'es', spaans: 'es', italian: 'it', italiano: 'it', italiaans: 'it', portuguese: 'pt', português: 'pt', portugees: 'pt', danish: 'da', dansk: 'da', deens: 'da', swedish: 'sv', svenska: 'sv', zweeds: 'sv', norwegian: 'no', norsk: 'no', noors: 'no', finnish: 'fi', suomi: 'fi', fins: 'fi', polish: 'pl', polski: 'pl', pools: 'pl' };
  function langCode(v) {
    var t = _lower(v).split(/[-_]/)[0];
    if (!t) return null;
    for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === t) return t;
    return LANG_ALIASES[_lower(v)] || null;
  }
  function languageName(code) { for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].code === code) return LANGUAGES[i].name; return null; }
  // Country (ISO code or common name, as stored in the business profile)
  // → the most likely advertising language. A suggestion, never "confirmed".
  var COUNTRY_LANG = { NL: 'nl', BE: 'nl', DE: 'de', AT: 'de', CH: 'de', FR: 'fr', LU: 'fr', ES: 'es', MX: 'es', AR: 'es', CL: 'es', CO: 'es', IT: 'it', PT: 'pt', BR: 'pt', DK: 'da', SE: 'sv', NO: 'no', FI: 'fi', PL: 'pl', US: 'en', GB: 'en', IE: 'en', CA: 'en', AU: 'en', NZ: 'en' };
  var COUNTRY_NAMES = { netherlands: 'NL', 'the netherlands': 'NL', nederland: 'NL', holland: 'NL', belgium: 'BE', 'belgië': 'BE', belgie: 'BE', germany: 'DE', deutschland: 'DE', duitsland: 'DE', austria: 'AT', switzerland: 'CH', france: 'FR', frankrijk: 'FR', luxembourg: 'LU', spain: 'ES', 'españa': 'ES', spanje: 'ES', mexico: 'MX', argentina: 'AR', chile: 'CL', colombia: 'CO', italy: 'IT', italia: 'IT', 'italië': 'IT', portugal: 'PT', brazil: 'BR', brasil: 'BR', denmark: 'DK', danmark: 'DK', sweden: 'SE', sverige: 'SE', norway: 'NO', norge: 'NO', finland: 'FI', poland: 'PL', polska: 'PL', 'united states': 'US', usa: 'US', us: 'US', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', ireland: 'IE', canada: 'CA', australia: 'AU', 'new zealand': 'NZ' };
  function countryIso(v) {
    var t = _norm(v);
    if (!t) return null;
    if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
    return COUNTRY_NAMES[t.toLowerCase()] || null;
  }
  // profile: the business_profile row ({ languages: [...], country }).
  // Returns { code, source: 'profile' | 'country' | 'default', confirmed }.
  function suggestLanguage(profile) {
    profile = profile || {};
    var langs = Array.isArray(profile.languages) ? profile.languages : (profile.languages ? String(profile.languages).split(/[,;/]/) : []);
    for (var i = 0; i < langs.length; i++) { var c = langCode(langs[i]); if (c) return { code: c, source: 'profile', confirmed: true }; }
    var iso = countryIso(profile.country);
    if (iso && COUNTRY_LANG[iso]) return { code: COUNTRY_LANG[iso], source: 'country', confirmed: false, country: iso };
    return { code: 'en', source: 'default', confirmed: false };
  }

  // ── Free-text notes: spot instructions that try to change settings ──
  // Used to show a friendly notice; the backend also tells the model that
  // structured settings win. Never edits the user's text.
  function noteConflicts(notes, state) {
    var t = _lower(notes);
    if (!t) return [];
    state = state || {};
    var out = [];
    var plats = { google: /\bgoogle\b/, meta: /\b(meta|facebook|instagram)\b/, tiktok: /\btik\s?tok\b/, pinterest: /\bpinterest\b/ };
    Object.keys(plats).forEach(function (k) {
      if (k !== state.platform && plats[k].test(t) && /\b(on|for|run|publish|use|post|advertise)\b/.test(t)) out.push({ kind: 'platform', message: 'Your note mentions ' + PLATFORMS[k].label + '. The ad is made for ' + (PLATFORMS[state.platform] ? PLATFORMS[state.platform].label : 'the platform you chose') + ' — change that in step 2 if you meant another platform.' });
    });
    if (/(€|\$|£|eur\b|usd\b|budget|per day|a day|daily|lifetime)/.test(t) && /\d/.test(t)) out.push({ kind: 'budget', message: 'Budgets aren’t set here. You choose and confirm the budget in Launch before anything goes live.' });
    if (/\b(target|targeting|only (in|show)|show (it )?(only )?(in|to))\b/.test(t)) out.push({ kind: 'targeting', message: 'Countries and targeting are set in Launch. Here, describe who the ad is for and the ad will be written for them.' });
    if (/\b(video|image|picture|photo only|text only)\b/.test(t) && /\b(make|use|instead|as a|should be)\b/.test(t)) out.push({ kind: 'format', message: 'The ad format comes from step 4. Your note is used as creative direction only.' });
    return out;
  }

  return {
    VERSION: VERSION, GOALS: GOALS, GOAL_TEXT: GOAL_TEXT, FORMAT_TEXT: FORMAT_TEXT, PLATFORMS: PLATFORMS, REASONS: REASONS,
    LANGUAGES: LANGUAGES, normalizeGoal: normalizeGoal, formatFromMode: formatFromMode, modeFromFormat: modeFromFormat,
    platformInfo: platformInfo, typeInfo: typeInfo, typeKeys: typeKeys, resolveType: resolveType,
    goalOptions: goalOptions, formatOptions: formatOptions, typesForFormat: typesForFormat, objectiveOptions: objectiveOptions,
    check: check, assetsFor: assetsFor, creativeUnits: creativeUnits, estimateCredits: estimateCredits,
    MAX_GROUPS: MAX_GROUPS, MAX_ADS_PER_GROUP: MAX_ADS_PER_GROUP, validStructure: validStructure, structureFor: structureFor, adCountFor: adCountFor,
    IMAGE_TYPES: IMAGE_TYPES, IMAGE_MAX_BYTES: IMAGE_MAX_BYTES, IMAGE_MIN: IMAGE_MIN, IMAGE_REASONS: IMAGE_REASONS, shapeOf: shapeOf, googleShapes: googleShapes,
    ownImageMax: ownImageMax, checkImageFile: checkImageFile, imageNotices: imageNotices,
    CURRENCIES: CURRENCIES, currencyCode: currencyCode, currencyDecimals: currencyDecimals, suggestCurrency: suggestCurrency, parsePrice: parsePrice,
    needsImages: needsImages, needsVideo: needsVideo, platformSupportsFormat: platformSupportsFormat,
    langCode: langCode, languageName: languageName, countryIso: countryIso, suggestLanguage: suggestLanguage,
    noteConflicts: noteConflicts,
  };
}));
