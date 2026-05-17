// ════════════════════════════════════════════════════════════════
// UGC — test page (page-ugc) + AI UGC Creator overlay
// ════════════════════════════════════════════════════════════════

// ── Creator presets ───────────────────────────────────────────
// Hardcoded for stable MVP. avatarId / voiceId are confirmed
// valid HeyGen public stock IDs (tested against live API).
var UC_CREATORS = [
  {
    id:       'lifestyle',
    label:    'Lifestyle',
    sub:      'Female · Expressive',
    avatarId: 'Abigail_expressive_2024112501',
    voiceId:  'cef3bc4e0a84424cafcde6f2cf466c97',
  },
  {
    id:       'professional',
    label:    'Professional',
    sub:      'Male · Confident',
    avatarId: 'Aditya_public_1',
    voiceId:  'f38a635bee7a4d1f9b0a654a31d050d2',
  },
  {
    id:       'studio',
    label:    'Studio',
    sub:      'Female · Polished',
    avatarId: 'Abigail_standing_office_front',
    voiceId:  'f8c69e517f424cafaecde32dde57096b',
  },
];

var _ucSelectedCreator = null;
var _ucSelectedBg      = null;
var _ucScriptMode      = 'ai';

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
  var product      = (answers.ucProduct      && answers.ucProduct.val)      || '';
  var niche        = (answers.ucNiche         && answers.ucNiche.val)         || '';
  var audience     = (answers.ucAudience      && answers.ucAudience.val)      || '';
  var goal         = (answers.ucGoal          && answers.ucGoal.val)          || 'awareness';
  var tone         = (answers.ucTone          && answers.ucTone.val)          || 'natural';
  var customScript = (_ucScriptMode === 'custom' && answers.ucCustomScript && answers.ucCustomScript.val)
    ? answers.ucCustomScript.val.trim()
    : null;

  var retryRow = document.getElementById('ucRetryRow');
  var newRow   = document.getElementById('ucNewRow');
  if (retryRow) retryRow.style.display = 'none';
  if (newRow)   newRow.style.display   = 'none';

  if (!product.trim()) {
    _ucSetStatus('<div class="ugc-status-err">No product provided — please try again.</div>');
    if (retryRow) retryRow.style.display = '';
    return;
  }
  if (!_ucSelectedCreator) {
    _ucSetStatus('<div class="ugc-status-err">No creator selected — please try again.</div>');
    if (retryRow) retryRow.style.display = '';
    return;
  }

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

    var result = await apiFetch('/api/generate-ugc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body:    JSON.stringify({
        product:      product,
        niche:        niche,
        audience:     audience,
        goal:         goal,
        tone:         tone,
        background:   _ucSelectedBg   || null,
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
      _ucSetStatus('<div class="ugc-status-ok">Your video is ready</div>');

      var videoEl     = document.getElementById('ucVideoEl');
      var downloadBtn = document.getElementById('ucDownloadBtn');
      var videoWrap   = document.getElementById('ucVideoWrap');
      var newRow      = document.getElementById('ucNewRow');

      if (videoEl)     videoEl.src = d.videoUrl;
      if (downloadBtn) downloadBtn.href = d.videoUrl;
      if (videoWrap)   videoWrap.style.display = '';
      if (newRow)      newRow.style.display    = '';

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
