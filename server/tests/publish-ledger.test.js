// ════════════════════════════════════════════════════════════════
// Publish ledger + Launch checklist — unit tests (no network, no DB).
//   • services/publishLedger.js state machine on the in-memory store, and
//     the Supabase adapter's queries/error mapping on a fake client
//   • services/campaignSpec.js sectionOf/checklist: every issue lands in a
//     section, platform-relevant sections only, TikTok video rules.
// RUN: node tests/publish-ledger.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const PL = require('../services/publishLedger');
const S = require('../services/campaignSpec');
let pass = 0, fail = 0;
const check = (name, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + name + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 500))); };

(async () => {
  try {
    console.log('\nA. Ledger state machine');
    let t = Date.parse('2026-10-18T10:00:00Z');
    const store = PL.memoryStore();
    const L = PL.createLedger({ store, now: () => t });
    const base = { userId: 'u1', platform: 'meta', campId: 'c1', campaignName: 'Linen', accountId: 'act_1' };
    let a = await L.begin(Object.assign({ opId: 'a' }, base));
    check('first claim succeeds and records publishing', a.ok && a.op.state === 'publishing' && a.op.op_id === 'a');
    let b = await L.begin(Object.assign({ opId: 'b' }, base));
    check('second claim while in flight → PUBLISH_IN_PROGRESS', !b.ok && b.code === 'PUBLISH_IN_PROGRESS');
    t += PL.STALE_MS + 1000;
    b = await L.begin(Object.assign({ opId: 'b' }, base));
    check('claim after the attempt went stale → RESULT_UNCONFIRMED (and stored)', !b.ok && b.code === 'RESULT_UNCONFIRMED' && store.rows[0].state === 'unconfirmed');
    await L.resolve(b.op, { state: 'failed', error: 'checked: not created' });
    const c1 = L.begin(Object.assign({ opId: 'c' }, base)), c2 = L.begin(Object.assign({ opId: 'd' }, base));
    const both = await Promise.all([c1, c2]);
    check('two racing claims after a failure → exactly one wins', both.filter((x) => x.ok).length === 1, both.map((x) => x.code || 'ok'));
    const won = both.find((x) => x.ok);
    await L.succeed(won.op, { campaignId: 99, accountId: 'act_1', ids: { accountName: 'Main' } });
    b = await L.begin(Object.assign({ opId: 'e' }, base));
    check('claim after success → ALREADY_PUBLISHED with ids', !b.ok && b.code === 'ALREADY_PUBLISHED' && b.op.external_campaign_id === '99');
    const v = L.view(b.op);
    check('view exposes state, ids and account name only', v.state === 'published' && v.campaignId === '99' && v.accountName === 'Main' && !('user_id' in v));
    check('view of nothing → none', L.view(null).state === 'none');
    const other = await L.begin(Object.assign({}, base, { userId: 'u2', opId: 'z' }));
    check('another user’s claim on the same campaign id is independent', other.ok);

    console.log('\nB. Supabase adapter');
    const q = []; let mode = 'ok';
    const db = { from: (tbl) => { const s = { tbl, ops: [] }; const api = {
      select: (x) => { s.ops.push('select'); return api; }, insert: (r) => { s.ops.push('insert'); s.row = r; return api; }, update: (p) => { s.ops.push('update'); s.patch = p; return api; },
      eq: (k, v) => { s.ops.push('eq:' + k); return api; }, in: (k, v) => { s.ops.push('in:' + k + '=' + v.join('|')); return api; },
      maybeSingle: async () => { q.push(s); if (mode === 'missing') return { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }; if (mode === 'dup') return { data: null, error: { code: '23505' } }; return { data: s.row ? Object.assign({ id: 'x' }, s.row) : (s.patch ? Object.assign({ id: 'x' }, s.patch) : null), error: null }; } }; return api; } };
    const st = PL.supabaseStore(db);
    await st.get('u1', 'meta', 'c1');
    check('get filters by user, platform and campaign', q[0].tbl === 'publish_operations' && ['eq:user_id', 'eq:platform', 'eq:client_ref_id'].every((x) => q[0].ops.includes(x)));
    mode = 'dup';
    const ins = await st.insert({ user_id: 'u1' });
    check('unique violation → conflict (not an error)', ins.row === null);
    mode = 'ok';
    await st.updateIf('x', ['publishing', 'unconfirmed'], { state: 'published', skip: undefined });
    const up = q[q.length - 1];
    check('conditional update: by id AND allowed current states; undefined fields dropped', up.ops.includes('eq:id') && up.ops.includes('in:state=publishing|unconfirmed') && !('skip' in up.patch));
    mode = 'missing';
    let threw = null; try { await st.get('u1', 'meta', 'c1'); } catch (e) { threw = e; }
    check('missing table → LedgerUnavailable naming the migration', threw instanceof PL.LedgerUnavailable && /2026-10-publish-operations/.test(threw.message));

    console.log('\nC. Launch checklist (campaignSpec)');
    const known = ['targeting.countries', 'budget.amount', 'tracking.destinationUrl', 'tracking.pixelId', 'tracking.conversion', 'tracking.conversionTagId', 'campaign.specialAdCategories', 'compliance.dsa', 'identity.pageId', 'identity.tiktok', 'campaign.objective', 'campaign.goal', 'campaignType', 'compat.format', 'creative.image', 'creative.video', 'assets.headlines', 'assets.descriptions', 'assets.logo', 'adGroups[0].keywords', 'adGroups[1].ads[0].primaryText', 'assets.sitelinks', 'pin.title'];
    const map = Object.fromEntries(known.map((f) => [f, S.sectionOf(f)]));
    check('every known field maps to a real section (none to other)', Object.values(map).every((s) => s !== 'other'), map);
    check('unknown field → other (never dropped)', S.sectionOf('something.new') === 'other' && S.sectionOf('') === 'other');
    check('destination vs tracking; compliance before campaign', map['tracking.destinationUrl'] === 'destination' && map['tracking.pixelId'] === 'tracking' && map['campaign.specialAdCategories'] === 'compliance' && map['campaign.objective'] === 'campaign');
    check('ad-group copy and keywords split correctly', map['adGroups[1].ads[0].primaryText'] === 'copy' && map['adGroups[0].keywords'] === 'keywords');
    const prof = { country: 'Netherlands', company_name: 'Linnen & Co', logo_url: 'https://cdn.example/logo.png' };
    const tt = { campaignName: 'T', strategy: { goal: 'Traffic', landingPageUrl: 'https://shop.example/a' }, tiktokAds: { budget: 30 }, concepts: [{ angle: 'a', hook: 'h', adCopy: { primaryText: 'p' } }], videoAssets: [{ ref: 'a', videoUrl: 'https://cdn.example/v.mp4' }] };
    const ttCtx = { profile: prof, options: { connected: true, currency: 'EUR', identityId: 'i1', identityType: 'TT_USER', identityName: 'linnen' } };
    let spec = S.buildSpec(tt, 'tiktok', ttCtx), iss = S.validate(spec, ttCtx), cl = S.checklist(spec, iss);
    check('TikTok video without an image → publishable, creative passes with the cover-frame note', !S.hasErrors(iss) && cl.find((s) => s.key === 'creative').status === 'pass' && cl.find((s) => s.key === 'creative').notes.length === 1);
    check('TikTok sections: no compliance, no keywords; identity present', !cl.some((s) => s.key === 'compliance' || s.key === 'keywords') && cl.some((s) => s.key === 'identity'));
    spec = S.buildSpec(Object.assign({}, tt, { videoAssets: [], videoJobs: [{ ref: 'a', videoId: 'v9' }] }), 'tiktok', ttCtx); iss = S.validate(spec, ttCtx);
    check('TikTok video still generating → blocked with "still being generated"', iss.some((i) => i.code === 'video_pending') && !iss.some((i) => i.code === 'tiktok_video'));
    spec = S.buildSpec(Object.assign({}, tt, { videoAssets: [{ videoUrl: 'blob:abc' }] }), 'tiktok', ttCtx); iss = S.validate(spec, ttCtx);
    check('TikTok video not stored online → blocked', iss.some((i) => i.code === 'video_not_online'));
    spec = S.buildSpec(Object.assign({}, tt, { tiktokAds: { budget: 15 } }), 'tiktok', Object.assign({}, ttCtx, { options: Object.assign({}, ttCtx.options, { currency: 'CHF' }) })); iss = S.validate(spec, ttCtx);
    check('TikTok budget 15 CHF → warning (currency-specific minimum), not a block', !iss.some((i) => i.code === 'tiktok_budget_min') && iss.some((i) => i.code === 'tiktok_budget_currency'));
    const gs = { campaignName: 'G', strategy: { goal: 'Traffic', landingPageUrl: 'https://shop.example', budgetRecommendation: { amount: 20 } }, googleAds: { campaignType: 'SEARCH', headlines: ['Linen', 'Shirts', 'Europe'], descriptions: ['Light linen.', 'Free returns.'], keywords: [] } };
    const gCtx = { profile: prof, options: { connected: true, currency: 'EUR', conversionActions: 1 } };
    spec = S.buildSpec(gs, 'google', gCtx); iss = S.validate(spec, gCtx); cl = S.checklist(spec, iss);
    check('Google Search without keywords → keywords section blocked; creative says text-only', cl.find((s) => s.key === 'keywords').status === 'blocked' && /Text ads/.test(cl.find((s) => s.key === 'creative').summary));
    spec = S.buildSpec(Object.assign({}, gs, { strategy: Object.assign({}, gs.strategy, { budgetRecommendation: 25 }), googleAds: Object.assign({}, gs.googleAds, { keywords: ['linen'] }) }), 'google', gCtx); iss = S.validate(spec, gCtx);
    check('Google numeric budget is a suggestion, not a confirmed budget', iss.some((i) => i.code === 'budget_unconfirmed'));
    check('format label: Google Search = Text ads, TikTok = Video', S.formatLabel(S.buildSpec(gs, 'google', gCtx)) === 'Text ads' && S.formatLabel(S.buildSpec(tt, 'tiktok', ttCtx)) === 'Video');
    const pin = { campaignName: 'P', strategy: { goal: 'Traffic', landingPageUrl: 'https://shop.example' }, pinterestAds: { budget: 10, title: 'Linen', creativeType: 'video' }, visualConcepts: [{ generatedImageUrl: 'https://cdn.example/a.png' }] };
    const pCtx = { profile: prof, options: { connected: true, currency: 'EUR', conversionTags: [] } };
    spec = S.buildSpec(pin, 'pinterest', pCtx); iss = S.validate(spec, pCtx);
    check('Pinterest set to video without a video → warning that it publishes as an image Pin', iss.some((i) => i.code === 'pin_video_missing' && i.level === 'warning') && !S.hasErrors(iss));
    spec = S.buildSpec(Object.assign({}, pin, { videoJobs: [{ ref: 'x', videoId: 'v' }] }), 'pinterest', pCtx); iss = S.validate(spec, pCtx);
    check('Pinterest video still generating → blocked', iss.some((i) => i.code === 'video_pending'));
    const meta = { campaignName: 'M', strategy: { goal: 'Traffic', landingPageUrl: 'https://shop.example' }, metaAds: { budget: 20, objective: 'Engagement' }, visualConcepts: [{ generatedImageUrl: 'https://cdn.example/a.png' }], spec: { overrides: { specialAdCategories: [] } } };
    const mCtx = { profile: prof, options: { connected: true, currency: 'EUR', pageId: 'pg', pixels: [] } };
    spec = S.buildSpec(meta, 'meta', mCtx); iss = S.validate(spec, mCtx); cl = S.checklist(spec, iss);
    check('Meta legacy objective warning is kept in the Campaign section', cl.find((s) => s.key === 'campaign').warnings.some((w) => w.code === 'objective_unsupported'));
    check('Meta sections include compliance + identity; no keywords', cl.some((s) => s.key === 'compliance') && cl.some((s) => s.key === 'identity') && !cl.some((s) => s.key === 'keywords'));
    const fake = S.checklist(spec, iss.concat([{ level: 'error', field: 'brand.new.thing', code: 'x', message: 'New rule' }]));
    check('an error with an unknown field adds a blocked "Other settings" section', fake.some((s) => s.key === 'other' && s.status === 'blocked' && s.errors[0].message === 'New rule'));
  } catch (e) { console.log('CRASH', e && e.stack || e); fail++; }
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
