// ════════════════════════════════════════════════════════════════
// Oriven Model Router
//
// Single source of truth for every AI provider and model.
// Provider: AIML API for all AI tasks (text, code, vision, image, video).
// To swap a model: edit one entry in MODELS below.
//
// Usage:  const route = routeTask('ads-copy');
// Returns: { provider, model, type, label [, endpoint] }
// ════════════════════════════════════════════════════════════════

const MODELS = {

  // ── AIML — Text & Vision ─────────────────────────────────────
  // claude-opus-4-8 via AIML proxy — used for all natural language tasks.
  aiml: {
    text:  'claude-opus-4-8',                     // copy, campaigns, brand, scripts, prompts
    code:  'Qwen3-Coder-480B-A35B-Instruct',      // web pages, HTML/CSS, structured output
    image: 'gpt-image-1',                         // all image generation via AIML proxy
    video: 'kling-video/v1.6/pro/text-to-video',  // video ads, motion graphics, UGC
  },

};

// ── Task routing table ────────────────────────────────────────
// All tasks resolve to provider: 'aiml'.
// endpoint is required for image and video tasks; omitted for text/vision.

const TASKS = {

  // ── Text & Copy ───────────────────────────────────────────────
  'text-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Text & Copy',
  },
  'ads-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Ad Copy',
  },

  // ── Web / Code ────────────────────────────────────────────────
  'web': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.code,
    label:    'Web',
  },

  // ── Email ─────────────────────────────────────────────────────
  'email': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Email',
  },

  // ── Campaigns ─────────────────────────────────────────────────
  'campaigns-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Campaign Copy',
  },

  // ── Presentations ─────────────────────────────────────────────
  'presentations': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Presentations',
  },

  // ── Posters ───────────────────────────────────────────────────
  'poster': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.code,
    label:    'Poster',
  },

  // ── Infographics ──────────────────────────────────────────────
  'infographic': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.code,
    label:    'Infographic',
  },

  // ── Brand Core & Strategy ─────────────────────────────────────
  'brand-core': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Brand Core',
  },

  // ── Image Prompt Building ─────────────────────────────────────
  'visuals-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Visual Prompt',
  },
  'logo-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Logo Prompt',
  },
  'product-shoots-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Product Shoot Prompt',
  },
  'motion-graphics-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Motion Graphics Prompt',
  },
  'video-ads-copy': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Video Ad Prompt',
  },

  // ── UGC ───────────────────────────────────────────────────────
  'ugc-script': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'UGC Script',
  },

  // ── Vision Analysis ───────────────────────────────────────────
  'vision': {
    provider: 'aiml',
    type:     'vision',
    model:    MODELS.aiml.text,
    label:    'Vision Analysis',
  },

  // ── Image Generation ──────────────────────────────────────────
  'visuals': {
    provider: 'aiml',
    type:     'image',
    model:    MODELS.aiml.image,
    endpoint: '/v1/images/generations',
    label:    'Visuals',
  },
  'logo': {
    provider: 'aiml',
    type:     'image',
    model:    MODELS.aiml.image,
    endpoint: '/v1/images/generations',
    label:    'Logo',
  },
  'product-shoots': {
    provider: 'aiml',
    type:     'image',
    model:    MODELS.aiml.image,
    endpoint: '/v1/images/generations',
    label:    'Product Shoot',
  },
  'campaigns-image': {
    provider: 'aiml',
    type:     'image',
    model:    MODELS.aiml.image,
    endpoint: '/v1/images/generations',
    label:    'Campaign Visual',
  },
  'posters-image': {
    provider: 'aiml',
    type:     'image',
    model:    MODELS.aiml.image,
    endpoint: '/v1/images/generations',
    label:    'Poster Visual',
  },

  // ── Video Generation ──────────────────────────────────────────
  'motion-graphics': {
    provider: 'aiml',
    type:     'video',
    model:    MODELS.aiml.video,
    endpoint: '/v2/video/generations',
    label:    'Motion Graphics',
  },
  'video-ads': {
    provider: 'aiml',
    type:     'video',
    model:    MODELS.aiml.video,
    endpoint: '/v2/video/generations',
    label:    'Video Ads',
  },
  'ugc-video': {
    provider: 'aiml',
    type:     'video',
    model:    MODELS.aiml.video,
    endpoint: '/v2/video/generations',
    label:    'UGC Video',
  },

};

// ── routeTask() ───────────────────────────────────────────────
function routeTask(type) {
  const task = TASKS[type];
  if (!task) {
    throw new Error(
      `[ModelRouter] Unknown task type: "${type}". ` +
      `Valid types: ${Object.keys(TASKS).join(', ')}`
    );
  }
  return {
    provider: task.provider,
    model:    task.model,
    endpoint: task.endpoint || null,
    type:     task.type,
    label:    task.label,
  };
}

// ── logSummary() ──────────────────────────────────────────────
function logSummary() {
  console.log('');
  console.log('── Model Router ──────────────────────────────────────');
  console.log('[Router] Provider             : AIML (single gateway)');
  console.log('[Router] AIML text model      :', MODELS.aiml.text);
  console.log('[Router] AIML code model      :', MODELS.aiml.code);
  console.log('[Router] AIML image model     :', MODELS.aiml.image);
  console.log('[Router] AIML video model     :', MODELS.aiml.video);
  console.log('[Router] Task count           :', Object.keys(TASKS).length, 'task types registered');
  console.log('──────────────────────────────────────────────────────');
  console.log('');
}

module.exports = { MODELS, TASKS, routeTask, logSummary };
