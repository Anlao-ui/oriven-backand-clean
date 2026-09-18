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
    // GPT Image 2.5 Sunburst (production image model) — identifier
    // confirmed directly from AIML API's own "All Model IDs" documentation
    // (docs.aimlapi.com/api-references/model-database and the model's own
    // doc page, docs.aimlapi.com/api-references/image-models/openai/
    // gpt-image-2.5-sunburst), NOT guessed from the Playground display
    // name. Generation: POST /v1/images/generations, same endpoint/auth/
    // OpenAI-compatible body shape already used below. Edit (image-to-
    // image): POST /v1/images/edits, same as the previous model. Verified
    // supported sizes are exactly {auto, 1024x1024, 1024x1536, 1536x1024}
    // — identical to the three values _RATIO_TO_SIZE below already
    // produces for 1:1/16:9/9:16, so no aspect-ratio mapping changed.
    // Verified n must be 1 for generation, matching every existing caller
    // (none ever requests more than one image).
    image: 'openai/gpt-image-2.5-sunburst',       // all image generation via AIML proxy
    video: 'kling-video/v1.6/pro/text-to-video',  // video ads, motion graphics, UGC

    // GPT-6 Astra (configuration-ready, NOT active) — confirmed identifier
    // per AIML API docs is 'openai/gpt-6-astra' via this same
    // /v1/chat/completions endpoint (providers/aimlProvider.js). As of the
    // last connectivity test, every model on this AIML account — including
    // the working 'claude-opus-4-8' above and Astra itself — returned
    // HTTP 403 { kind: 'err_insufficent_credits' }: an AIML account
    // billing/balance issue, not a model-permission or availability issue
    // specific to Astra. Do NOT point 'text' at this until a live
    // provider.generateText(..., { model: MODELS.aiml.astra }) call has
    // actually succeeded — swap TASKS.chat / TASKS['research-query']
    // below to use MODELS.aiml.astra once that's confirmed; no other
    // code changes are needed to activate it.
    astra: 'openai/gpt-6-astra',

    // Real web search (Research Production Sprint) — verified against
    // AIMLAPI's own documentation (docs.aimlapi.com/capabilities/
    // web-search), NOT live-tested (this account currently has zero
    // funds — every AIML call 403s regardless of model or endpoint, and
    // no live/paid testing is in scope for this change). Their
    // documented list of web-search-capable models is: gpt-4o-search-
    // preview, gpt-4o-mini-search-preview, perplexity/sonar,
    // perplexity/sonar-pro, alibaba/qwen3.6-{flash,plus,max-preview},
    // moonshot/kimi-k2-{preview,0905-preview} — openai/gpt-6-astra is
    // confirmed NOT on that list, despite Astra supporting web search
    // natively on OpenAI's own platform; AIMLAPI's proxy for this model
    // does not expose it. perplexity/sonar is chosen here because
    // Perplexity's sonar models are natively grounded (no `tools` array
    // needed — a plain chat completion returns real `citations` +
    // `search_results` with title/url/date, confirmed via AIMLAPI's own
    // documented example request/response), matching this codebase's
    // existing plain-fetch, no-SDK Chat Completions pattern with zero
    // new request-shape complexity.
    webSearch: 'perplexity/sonar',
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
  'chat': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text, // swap to MODELS.aiml.astra once a live Astra call succeeds (see MODELS.aiml.astra comment)
    label:    'Oriven Chat',
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
  'competitor-intel': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Competitor Intelligence',
  },
  'daily-brief': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Daily Brief',
  },
  'research-query': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text, // swap to MODELS.aiml.astra once a live Astra call succeeds (see MODELS.aiml.astra comment)
    label:    'Advertising Research',
  },
  // Real web search stage (Research Production Sprint) — the ONLY task
  // routed to a genuinely web-search-capable model (see MODELS.aiml.
  // webSearch comment). Kept separate from 'research-query' above
  // (which stays the text-only synthesis/mapping stage) because they are
  // different models with different jobs, not because this needed a new
  // provider abstraction.
  'research-web-search': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.webSearch,
    label:    'Research Web Search',
  },
  'opportunities': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Opportunities',
  },
  'market-research': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Market Research',
  },
  'website-monitor': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Website Monitor',
  },
  'home-briefing': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Home Briefing',
  },
  'forecast': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Forecast',
  },
  'website-intel': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Website Intelligence',
  },
  'business-insights': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Business Insights',
  },
  'business-reflection': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Business Reflection',
  },
  'creative-variations': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Creative Variations',
  },
  'creative-improve': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Creative Improve',
  },
  'creative-score': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Creative Score',
  },
  'autopilot-recommendation': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Autopilot Recommendation',
  },
  'autopilot-brief': {
    provider: 'aiml',
    type:     'text',
    model:    MODELS.aiml.text,
    label:    'Autopilot Daily Brief',
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
