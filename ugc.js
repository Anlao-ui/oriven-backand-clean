// ════════════════════════════════════════════════════════════════
// UGC — test page (page-ugc) + AI UGC Creator overlay
// ════════════════════════════════════════════════════════════════

// ── Creator presets ───────────────────────────────────────────
// 8 styles — each has a gender preference for avatar assignment and a
// background that creates visual distinctiveness for the style.
// avatarId / voiceId are seeded with known HeyGen public stock IDs and
// updated at generation time by _ucInitAvatars / _ucInitVoices.
var UC_CREATORS = [
  {
    id:         'startup_founder',
    label:      'Startup Founder',
    sub:        'Bold · Visionary · Direct',
    gender:     'male',
    background: null,
    avatarId:   'Aditya_public_1',
    voiceId:    'f38a635bee7a4d1f9b0a654a31d050d2',
  },
  {
    id:         'podcast_creator',
    label:      'Podcast Creator',
    sub:        'Conversational · Trusted · Natural',
    gender:     'female',
    background: 'minimal_dark',
    avatarId:   'Abigail_expressive_2024112501',
    voiceId:    'cef3bc4e0a84424cafcde6f2cf466c97',
  },
  {
    id:         'fitness_creator',
    label:      'Fitness Creator',
    sub:        'Energetic · Motivating · Raw',
    gender:     'male',
    background: null,
    avatarId:   'Aditya_public_1',
    voiceId:    'f38a635bee7a4d1f9b0a654a31d050d2',
  },
  {
    id:         'luxury_influencer',
    label:      'Luxury Influencer',
    sub:        'Elevated · Aspirational · Refined',
    gender:     'female',
    background: 'minimal_dark',
    avatarId:   'Abigail_expressive_2024112501',
    voiceId:    'cef3bc4e0a84424cafcde6f2cf466c97',
  },
  {
    id:         'tech_reviewer',
    label:      'Tech Reviewer',
    sub:        'Analytical · Credible · Expert',
    gender:     'male',
    background: 'white_studio',
    avatarId:   'Aditya_public_1',
    voiceId:    'f38a635bee7a4d1f9b0a654a31d050d2',
  },
  {
    id:         'street_creator',
    label:      'Street Creator',
    sub:        'Raw · Unscripted · Viral',
    gender:     'female',
    background: null,
    avatarId:   'Abigail_standing_office_front',
    voiceId:    'f8c69e517f424cafaecde32dde57096b',
  },
  {
    id:         'vacation_creator',
    label:      'Vacation Creator',
    sub:        'Relaxed · Lifestyle · Discovery',
    gender:     'female',
    background: null,
    avatarId:   'Abigail_expressive_2024112501',
    voiceId:    'cef3bc4e0a84424cafcde6f2cf466c97',
  },
  {
    id:         'office_creator',
    label:      'Office Creator',
    sub:        'Professional · Clean · Focused',
    gender:     'male',
    background: null,
    avatarId:   'Aditya_public_1',
    voiceId:    'f38a635bee7a4d1f9b0a654a31d050d2',
  },
];

var _ucSelectedCreator  = null;
var _ucSelectedBg       = null;
var _ucScriptMode       = 'ai';
var _ucVideoFormat      = 'vertical';
var _ucAdFeeling        = 'viral';
var _ucAvatarsFetched   = false;
var _ucVoicesFetched    = false;

// ── Shared helpers ────────────────────────────────────────────

function _ucEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _ucSpinRow(msg) {
  return '<div class="ugc-status-row"><div class="spin ugc-spinner"></div><span>' + _ucEsc(msg) + '</span></div>';
}

function _ucSetStatus(html) {
  var el = document.getElementById('ucStatusWrap');
  if (el) el.innerHTML = html;
}

// ── Dynamic HeyGen avatar init ────────────────────────────────
// Fetches real available avatar IDs from /api/ugc-avatars and maps
// them to UC_CREATORS slots by gender so stale hardcoded IDs never
// silently fall back to HeyGen's default actor.
async function _ucInitAvatars(token) {
  if (_ucAvatarsFetched) return;
  _ucAvatarsFetched = true;
  try {
    var result = await apiFetch('/api/ugc-avatars', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!result.ok || !result.data || !result.data.avatars || !result.data.avatars.length) return;

    var avatars = result.data.avatars;
    var female  = avatars.filter(function(a) {
      var g = (a.gender || '').toLowerCase();
      var n = (a.avatar_name || '').toLowerCase();
      return g === 'female' || n.match(/female|woman|abigail|anna|susan|eva|alice|sophie|clara/);
    });
    var male = avatars.filter(function(a) {
      var g = (a.gender || '').toLowerCase();
      var n = (a.avatar_name || '').toLowerCase();
      return g === 'male' || n.match(/male|man|aditya|john|david|michael|alex|james|marcus/);
    });
    if (!female.length && !male.length) {
      avatars.forEach(function(a, i) { if (i % 2 === 0) female.push(a); else male.push(a); });
    }

    // Slot indices by gender preference:
    // male:   startup_founder(0), fitness_creator(2), tech_reviewer(4), office_creator(7)
    // female: podcast_creator(1), luxury_influencer(3), street_creator(5), vacation_creator(6)
    var maleSlots   = [0, 2, 4, 7];
    var femaleSlots = [1, 3, 5, 6];
    maleSlots.forEach(function(slot, i) {
      var a = male[i] || male[male.length - 1] || female[0];
      if (a) UC_CREATORS[slot].avatarId = a.avatar_id;
    });
    femaleSlots.forEach(function(slot, i) {
      var a = female[i] || female[female.length - 1] || male[0];
      if (a) UC_CREATORS[slot].avatarId = a.avatar_id;
    });

    console.log('[UGC] Avatars loaded:', UC_CREATORS.map(function(c){ return c.id + '=' + c.avatarId; }).join(' | '));
  } catch (err) {
    _ucAvatarsFetched = false;
    console.warn('[UGC] Avatar fetch failed, using defaults:', err.message);
  }
}

// Fetches real HeyGen voice IDs and maps by gender to UC_CREATORS slots.
async function _ucInitVoices(token) {
  if (_ucVoicesFetched) return;
  _ucVoicesFetched = true;
  try {
    var result = await apiFetch('/api/ugc-voices', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!result.ok || !result.data || !result.data.voices || !result.data.voices.length) return;

    var voices = result.data.voices;
    var female = voices.filter(function(v) { return (v.gender || '').toLowerCase() === 'female'; });
    var male   = voices.filter(function(v) { return (v.gender || '').toLowerCase() === 'male';   });
    if (!female.length && !male.length) {
      voices.forEach(function(v, i) { if (i % 2 === 0) female.push(v); else male.push(v); });
    }

    var maleSlots   = [0, 2, 4, 7];
    var femaleSlots = [1, 3, 5, 6];
    maleSlots.forEach(function(slot, i) {
      var v = male[i] || male[male.length - 1] || female[0];
      if (v) UC_CREATORS[slot].voiceId = v.voice_id;
    });
    femaleSlots.forEach(function(slot, i) {
      var v = female[i] || female[female.length - 1] || male[0];
      if (v) UC_CREATORS[slot].voiceId = v.voice_id;
    });

    console.log('[UGC] Voices loaded:', UC_CREATORS.map(function(c){ return c.id + '=' + c.voiceId.slice(0,8); }).join(' | '));
  } catch (err) {
    _ucVoicesFetched = false;
    console.warn('[UGC] Voice fetch failed, using defaults:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// TEST PAGE — page-ugc (for manual script → video testing)
// ════════════════════════════════════════════════════════════════

var _ugcPollTimer = null;
var _ugcActiveId  = null;
var _ugcLoaded    = false;

function ugcInit() {
  if (_ugcLoaded) return;
  _ugcLoaded = true;
  // Populate test page selects from the same creator presets
  var avatarSel = document.getElementById('ugcAvatarSel');
  var voiceSel  = document.getElementById('ugcVoiceSel');
  if (avatarSel) {
    avatarSel.innerHTML = UC_CREATORS.map(function(c) {
      return '<option value="' + _ucEsc(c.avatarId) + '">' + _ucEsc(c.label) + ' (' + _ucEsc(c.sub) + ')</option>';
    }).join('');
  }
  if (voiceSel) {
    voiceSel.innerHTML = UC_CREATORS.map(function(c) {
      return '<option value="' + _ucEsc(c.voiceId) + '">' + _ucEsc(c.label) + ' voice</option>';
    }).join('');
  }
}

async function ugcGenerate() {
  var script   = (document.getElementById('ugcScript')    || {}).value || '';
  var avatarId = (document.getElementById('ugcAvatarSel') || {}).value || '';
  var voiceId  = (document.getElementById('ugcVoiceSel')  || {}).value || '';
  var btn      = document.getElementById('ugcGenBtn');
  var resultEl = document.getElementById('ugcResult');
  var statusEl = document.getElementById('ugcStatus');
  var videoEl  = document.getElementById('ugcVideo');

  if (!script.trim()) { if (typeof toast === 'function') toast('Please enter a script', 'warn'); return; }
  if (!avatarId)       { if (typeof toast === 'function') toast('Please select an avatar', 'warn'); return; }
  if (!voiceId)        { if (typeof toast === 'function') toast('Please select a voice',   'warn'); return; }

  if (_ugcPollTimer) { clearInterval(_ugcPollTimer); _ugcPollTimer = null; }
  _ugcActiveId = null;
  if (videoEl)  { videoEl.style.display = 'none'; videoEl.src = ''; }
  if (resultEl)  resultEl.style.display = 'block';
  if (statusEl)  statusEl.innerHTML = _ucSpinRow('Starting generation…');
  if (btn)      { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    var s = await SB.auth.getSession();
    var token = s.data && s.data.session && s.data.session.access_token;
    if (!token) { if (typeof toast === 'function') toast('Please sign in', 'warn'); return; }

    var result = await apiFetch('/api/generate-ugc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({ script: script.trim(), avatarId: avatarId, voiceId: voiceId })
    });

    if (!result.ok) throw new Error(result.data.error || 'Generation failed');

    _ugcActiveId = result.data.videoId;
    if (statusEl) statusEl.innerHTML = _ucSpinRow('Processing… videos typically take 2–4 minutes.');
    _ugcPollTimer = setInterval(function() { _ugcCheckStatus(); }, 8000);
  } catch (err) {
    console.error('[UGC] Generate error:', err.message);
    if (statusEl) statusEl.innerHTML = '<div class="ugc-status-err">Failed: ' + _ucEsc(err.message) + '</div>';
    if (btn)      { btn.disabled = false; btn.textContent = 'Generate UGC Video'; }
  }
}

async function _ugcCheckStatus() {
  if (!_ugcActiveId) return;
  var s = await SB.auth.getSession();
  var token = s.data && s.data.session && s.data.session.access_token;
  if (!token) return;

  var statusEl = document.getElementById('ugcStatus');
  var videoEl  = document.getElementById('ugcVideo');
  var btn      = document.getElementById('ugcGenBtn');
  try {
    var result = await apiFetch('/api/ugc-video-status/' + encodeURIComponent(_ugcActiveId), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!result.ok) return;
    var d = result.data;
    if (d.status === 'completed' && d.videoUrl) {
      clearInterval(_ugcPollTimer); _ugcPollTimer = null;
      if (statusEl) statusEl.innerHTML = '<div class="ugc-status-ok">Video ready</div>';
      if (videoEl)  { videoEl.src = d.videoUrl; videoEl.style.display = 'block'; }
      if (btn)      { btn.disabled = false; btn.textContent = 'Generate UGC Video'; }
      if (typeof toast === 'function') toast('UGC video is ready!');
    } else if (d.status === 'failed') {
      clearInterval(_ugcPollTimer); _ugcPollTimer = null;
      var errMsg = (d.error && (d.error.message || String(d.error))) || 'Generation failed';
      if (statusEl) statusEl.innerHTML = '<div class="ugc-status-err">Failed: ' + _ucEsc(errMsg) + '</div>';
      if (btn)      { btn.disabled = false; btn.textContent = 'Generate UGC Video'; }
      if (typeof toast === 'function') toast('Video generation failed', 'err');
    }
  } catch (err) { console.error('[UGC] Poll error:', err.message); }
}

// ════════════════════════════════════════════════════════════════
// CREATOR OVERLAY — AI UGC Creator (opened from Create section)
// ════════════════════════════════════════════════════════════════

var _ucPollTimer = null;
var _ucActiveId  = null;

function openUGCCreator() {
  // Entry point is now openAIFlow('ugc') via the guided flow system.
  // This function is kept for the test page (page-ugc) only.
  if (typeof openAIFlow === 'function') { openAIFlow('ugc'); return; }
}

function closeUGCCreator() {
  var overlay = document.getElementById('ucOverlay');
  if (!overlay) return;
  if (_ucPollTimer) { clearInterval(_ucPollTimer); _ucPollTimer = null; }
  overlay.style.transition = 'opacity 0.22s ease';
  overlay.style.opacity    = '0';
  setTimeout(function() { overlay.style.display = 'none'; }, 230);
}

function ucToggleScriptMode(mode) {
  _ucScriptMode = mode;
  var aiBtn     = document.getElementById('ucScriptModeAI');
  var customBtn = document.getElementById('ucScriptModeCustom');
  var wrap      = document.getElementById('ucCustomScriptWrap');
  if (aiBtn)     aiBtn.classList.toggle('uc-script-opt-active',     mode === 'ai');
  if (customBtn) customBtn.classList.toggle('uc-script-opt-active', mode === 'custom');
  if (wrap)      wrap.style.display = mode === 'custom' ? '' : 'none';
}

function ucSelectBg(bgId) {
  _ucSelectedBg = bgId;
  document.querySelectorAll('.uc-bg-pill').forEach(function(btn) {
    btn.classList.toggle('uc-bg-pill-active', btn.id === 'ucBg-' + bgId);
  });
}

function ucSelectCreator(id) {
  _ucSelectedCreator = null;
  UC_CREATORS.forEach(function(c) {
    var btn = document.getElementById('ucCreator-' + c.id);
    if (c.id === id) {
      _ucSelectedCreator = c;
      if (btn) btn.classList.add('uc-creator-active');
    } else {
      if (btn) btn.classList.remove('uc-creator-active');
    }
  });
}

function ucGoToStep(n) {
  [1, 2].forEach(function(i) {
    var el = document.getElementById('ucStep' + i);
    if (el) el.style.display = (i === n) ? '' : 'none';
  });
  var fill = document.getElementById('ucProgressFill');
  if (fill) fill.style.width = n === 1 ? '0%' : '100%';
}

async function ucGenerate() {
  var product      = (document.getElementById('ucProduct')      || {}).value || '';
  var niche        = (document.getElementById('ucNiche')         || {}).value || '';
  var audience     = (document.getElementById('ucAudience')      || {}).value || '';
  var goal         = (document.getElementById('ucGoal')          || {}).value || 'awareness';
  var tone         = (document.getElementById('ucTone')          || {}).value || 'natural';
  var customScript = (document.getElementById('ucCustomScript')  || {}).value || '';
  var btn          = document.getElementById('ucGenerateBtn');

  if (!product.trim()) {
    if (typeof toast === 'function') toast('Please enter a product name', 'warn');
    var p = document.getElementById('ucProduct'); if (p) p.focus();
    return;
  }
  if (!_ucSelectedCreator) {
    if (typeof toast === 'function') toast('Please select a creator', 'warn');
    return;
  }
  if (_ucScriptMode === 'custom' && !customScript.trim()) {
    if (typeof toast === 'function') toast('Please paste your script or switch to AI generation', 'warn');
    var ta = document.getElementById('ucCustomScript'); if (ta) ta.focus();
    return;
  }

  if (_ucPollTimer) { clearInterval(_ucPollTimer); _ucPollTimer = null; }
  _ucActiveId = null;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<div class="spin" style="width:13px;height:13px;border-width:2px;margin:0 4px 0 0;display:inline-block;vertical-align:middle"></div>Creating…';
  }

  var brandName = (typeof S !== 'undefined' && S && S.brandCore && S.brandCore.name) || '';
  var brandDesc = (typeof S !== 'undefined' && S && S.brandCore && (S.brandCore.desc || S.brandCore.positioning)) || '';

  ucGoToStep(2);
  var statusMsg = _ucScriptMode === 'custom'
    ? 'Sending your script to HeyGen…'
    : 'Writing your UGC ad script with AI…';
  _ucSetStatus(_ucSpinRow(statusMsg));
  var retryRow = document.getElementById('ucRetryRow');
  var newRow   = document.getElementById('ucNewRow');
  if (retryRow) retryRow.style.display = 'none';
  if (newRow)   newRow.style.display   = 'none';

  try {
    var s = await SB.auth.getSession();
    var token = s.data && s.data.session && s.data.session.access_token;
    if (!token) {
      if (typeof toast === 'function') toast('Please sign in to generate videos', 'warn');
      ucGoToStep(1);
      return;
    }

    var result = await apiFetch('/api/generate-ugc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({
        product:      product.trim(),
        niche:        niche.trim(),
        audience:     audience.trim(),
        goal:         goal,
        tone:         tone,
        background:   _ucSelectedBg || null,
        customScript: _ucScriptMode === 'custom' ? customScript.trim() : null,
        avatarId:     _ucSelectedCreator.avatarId,
        voiceId:      _ucSelectedCreator.voiceId,
        brandName:    brandName,
        brandDesc:    brandDesc,
      })
    });

    if (!result.ok) throw new Error(result.data.error || 'Video generation failed');

    _ucActiveId = result.data.videoId;
    _ucSetStatus(_ucSpinRow('Submitted to HeyGen — creating your video. This typically takes 2–4 minutes.'));
    _ucPollTimer = setInterval(function() { _ucPollVideoStatus(); }, 8000);

  } catch (err) {
    console.error('[UC] Generate error:', err.message);
    _ucSetStatus('<div class="ugc-status-err">Generation failed: ' + _ucEsc(err.message) + '</div>');
    if (retryRow) retryRow.style.display = '';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Generate Video <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
    }
  }
}

// ── ucStartOver — close result overlay and restart the guided flow ──
function ucStartOver() {
  closeUGCCreator();
  setTimeout(function() {
    if (typeof openAIFlow === 'function') openAIFlow('ugc');
  }, 260);
}

// ── ucGenerateFromFlow — called by _cfDispatchUGC() with flow answers ──
async function ucGenerateFromFlow(answers) {
  var creatorStyle = (answers.ucCreatorStyle && answers.ucCreatorStyle.val) || '';
  var adFeeling    = _ucAdFeeling || 'viral';
  var customScript = (_ucScriptMode === 'custom' && answers.ucCustomScript && answers.ucCustomScript.val)
    ? answers.ucCustomScript.val.trim()
    : null;

  var retryRow = document.getElementById('ucRetryRow');
  var newRow   = document.getElementById('ucNewRow');
  if (retryRow) retryRow.style.display = 'none';
  if (newRow)   newRow.style.display   = 'none';

  var statusMsg = _ucScriptMode === 'custom'
    ? 'Sending your script to HeyGen…'
    : 'Writing your UGC ad script with AI…';
  _ucSetStatus(_ucSpinRow(statusMsg));

  try {
    var brandName = (typeof S !== 'undefined' && S && S.brandCore && S.brandCore.name) || '';
    var brandDesc = (typeof S !== 'undefined' && S && S.brandCore && (S.brandCore.desc || S.brandCore.positioning)) || '';

    var s = await SB.auth.getSession();
    var token = s.data && s.data.session && s.data.session.access_token;
    if (!token) {
      _ucSetStatus('<div class="ugc-status-err">Please sign in to generate videos.</div>');
      if (retryRow) retryRow.style.display = '';
      return;
    }

    // Refresh HeyGen avatar + voice IDs — updates UC_CREATORS in-place so
    // stale hardcoded IDs never silently fall back to HeyGen's default actor.
    await Promise.all([_ucInitAvatars(token), _ucInitVoices(token)]);

    if (!_ucSelectedCreator) {
      _ucSetStatus('<div class="ugc-status-err">No creator selected — please try again.</div>');
      if (retryRow) retryRow.style.display = '';
      return;
    }

    console.log('[UGC] Sending → creatorStyle:', creatorStyle,
      '| adFeeling:', adFeeling,
      '| avatarId:', _ucSelectedCreator.avatarId,
      '| voiceId:', _ucSelectedCreator.voiceId,
      '| background:', _ucSelectedBg,
      '| format:', _ucVideoFormat);

    var result = await apiFetch('/api/generate-ugc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({
        creatorStyle: creatorStyle,
        adFeeling:    adFeeling,
        background:   _ucSelectedBg   || null,
        format:       _ucVideoFormat  || 'vertical',
        customScript: customScript,
        avatarId:     _ucSelectedCreator.avatarId,
        voiceId:      _ucSelectedCreator.voiceId,
        brandName:    brandName,
        brandDesc:    brandDesc,
      })
    });

    if (!result.ok) throw new Error(result.data.error || 'Video generation failed');

    _ucActiveId = result.data.videoId;
    _ucSetStatus(_ucSpinRow('Submitted to HeyGen — creating your video. This typically takes 2–4 minutes.'));
    _ucPollTimer = setInterval(function() { _ucPollVideoStatus(); }, 8000);

  } catch (err) {
    console.error('[UC] Generate error:', err.message);
    _ucSetStatus('<div class="ugc-status-err">Generation failed: ' + _ucEsc(err.message) + '</div>');
    if (retryRow) retryRow.style.display = '';
  }
}

async function _ucPollVideoStatus() {
  if (!_ucActiveId) return;
  var s = await SB.auth.getSession();
  var token = s.data && s.data.session && s.data.session.access_token;
  if (!token) return;

  try {
    var result = await apiFetch('/api/ugc-video-status/' + encodeURIComponent(_ucActiveId), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!result.ok) return;
    var d = result.data;

    if (d.status === 'completed' && d.videoUrl) {
      clearInterval(_ucPollTimer); _ucPollTimer = null;
      _ucSetStatus(
        '<div class="ugc-status-ok">'
        + '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><path d="M2 8l4 4 8-8"/></svg>'
        + 'Your video is ready</div>'
      );

      var videoEl   = document.getElementById('ucVideoEl');
      var videoWrap = document.getElementById('ucVideoWrap');
      var videoFrame= document.getElementById('ucVideoFrame');
      var newRow    = document.getElementById('ucNewRow');

      if (videoEl)    videoEl.src = d.videoUrl;
      if (videoFrame) videoFrame.className = 'uc-video-frame uc-fmt-' + (_ucVideoFormat || 'vertical');
      if (videoWrap)  videoWrap.style.display = '';
      if (newRow)     newRow.style.display    = '';

      if (typeof toast === 'function') toast('Your UGC video is ready!');

    } else if (d.status === 'failed') {
      clearInterval(_ucPollTimer); _ucPollTimer = null;
      var errMsg = (d.error && (d.error.message || String(d.error))) || 'Generation failed';
      _ucSetStatus('<div class="ugc-status-err">HeyGen failed: ' + _ucEsc(errMsg) + '</div>');

      var retryRow = document.getElementById('ucRetryRow');
      if (retryRow) retryRow.style.display = '';
      if (typeof toast === 'function') toast('Video generation failed', 'err');
    }
    // else: still processing — keep polling
  } catch (err) {
    console.error('[UC] Poll error:', err.message);
  }
}
