// ════════════════════════════════════════════════════════════════
// Progress facts — what the user has really done in OrivenAI, counted per
// verification key of services/planCatalog.js. Progress marks a verified
// task done only from these (never because a page was opened):
//   integration:            an ad account is connected (ever)
//   research:<type>         finished Research reports of that type
//   table:<table>           saved audiences / competitors / products
//   assets:<match>          content saved since the plan began:
//                             copy, image, video, variations (Creative
//                             Testing sets), picked (chosen variations),
//                             comparison (saved campaign comparisons)
//   campaigns:built         campaigns built in OrivenAI since the plan began
//   campaigns:published     ... that an ad platform confirmed (published/active)
//   automations:            automation rules created since the plan began
// Read-only. A table that doesn't exist (or a failed read) counts as 0 —
// a task then simply isn't completed yet.
// ════════════════════════════════════════════════════════════════
const AD_PROVIDERS = ['google_ads', 'meta_ads', 'tiktok_ads', 'pinterest_ads'];
const IMAGE_KINDS = ['image', 'poster', 'infographic', 'logo', 'product_shoot', 'product_photo', 'ad_image', 'lifestyle'];

function classifyAsset(a) {
  const kind = String((a && a.kind) || ''), route = String((a && a.source_route) || '');
  if (kind === 'research' || kind === 'audience_profile') return null; // research counts by type; a profile belongs to its audience
  if (kind === 'comparison') return 'comparison';
  if (route === '/api/creative/testing/pick') return 'picked';
  if (route === '/api/creative/variations') return 'variations';
  if (kind === 'video' || /video/.test(kind)) return 'video';
  if (IMAGE_KINDS.includes(kind) || /image|photo|poster|logo|infographic/.test(kind)) return 'image';
  return 'copy';
}

async function _rows(q) {
  try { const { data, error } = await q; return error ? [] : (data || []); }
  catch (_) { return []; }
}

// facts: { '<verifyKey>': count }. since: ISO time the plan began (results
// from before don't count for the plan's own creative/campaign work).
async function collect(db, userId, sinceIso) {
  const since = sinceIso || '1970-01-01T00:00:00Z';
  const f = {};
  const add = (k, n) => { f[k] = (f[k] || 0) + (n || 1); };
  const [integrations, assets, campaigns, rules, products, audiences, competitors] = await Promise.all([
    _rows(db.from('integrations').select('provider').eq('user_id', userId)),
    _rows(db.from('creative_assets').select('kind, source_route, status, archived, created_at, content').eq('user_id', userId).gte('created_at', since).limit(1000)),
    _rows(db.from('campaigns').select('status, source, created_at').eq('user_id', userId).gte('created_at', since).limit(500)),
    _rows(db.from('automation_rules').select('id, created_at').eq('user_id', userId).gte('created_at', since).limit(500)),
    _rows(db.from('business_products').select('id').eq('user_id', userId)),
    _rows(db.from('business_audiences').select('id').eq('user_id', userId)),
    _rows(db.from('business_competitors').select('id').eq('user_id', userId)),
  ]);
  if (integrations.some((r) => AD_PROVIDERS.includes(r.provider))) add('integration:');
  assets.forEach((a) => {
    if (a.archived) return;
    if (a.kind === 'research') {
      const t = a.content && a.content.type;
      if (a.status === 'ready' && t) add('research:' + t);
      return;
    }
    const c = classifyAsset(a);
    if (c) add('assets:' + c);
  });
  campaigns.forEach((c) => {
    if (c.source === 'platform_imported') return; // built elsewhere, not in OrivenAI
    add('campaigns:built');
    if (c.status === 'published' || c.status === 'active') add('campaigns:published');
  });
  if (rules.length) add('automations:', rules.length);
  if (products.length) add('table:business_products', products.length);
  if (audiences.length) add('table:business_audiences', audiences.length);
  if (competitors.length) add('table:business_competitors', competitors.length);
  return f;
}

module.exports = { collect, classifyAsset, AD_PROVIDERS };
