// ════════════════════════════════════════════════════════════════
// My Content (Create → My Content) data path, against the REAL server.js:
// the asset library routes it reads (GET/PATCH/DELETE /api/creative/assets)
// are owner-only, and a finished video's stable link is written onto its
// asset record (the record is created with only the job id).
//
// Faked: Supabase (in memory, tests/helpers/mockServer.js) and the AIML
// provider (AIML_BASE_OVERRIDE). No network, no paid AI calls, no real users.
//
// RUN: node tests/my-content.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { boot, reporter } = require('./helpers/mockServer');
const AIML = 'http://aiml.mock.invalid';
const H = boot({ port: 5634, env: { AIML_BASE_OVERRIDE: AIML } });
const { check, log, done } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FUTURE = new Date(Date.now() + 20 * 864e5).toISOString();
function user(id) {
  H.rows('profiles').push({ id, subscription_status: 'paid', access_expires_at: FUTURE, access_plan: 'monthly', created_at: '2026-01-01T00:00:00Z', credits_balance: 500, onboarding_completed: true, preferences: {} });
  H.TOKENS['tok_' + id] = { id, email: id + '@example.invalid', created_at: '2026-01-01T00:00:00Z' };
  return 'tok_' + id;
}
const VIDEO = { status: 'processing' };
H.net.handler = async (u) => {
  if (!u.startsWith(AIML)) return null;
  if (/\/v2\/video\/generations/.test(u)) {
    const body = VIDEO.status === 'completed' ? { status: 'completed', video: { url: 'https://cdn.provider.example/video/abc.mp4' } } : { status: VIDEO.status };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

(async () => {
  const quiet = await H.start();
  const { call } = H;
  const videoJobs = require(path.join(H.SERVER_DIR, 'services', 'videoJobs'));
  const A = user('mcA'), B = user('mcB');
  const rows = () => H.rows('creative_assets');
  const t = (d) => new Date(Date.now() - d * 60e3).toISOString();
  rows().push(
    { id: 'a-img', user_id: 'mcA', kind: 'image', title: 'Candle on a shelf', content: { url: 'https://store.example/generated/mcA/1.png' }, source_route: '/api/generate-image', archived: false, favorite: false, created_at: t(5) },
    { id: 'a-ad', user_id: 'mcA', kind: 'ad', platform: 'meta', title: 'Spring candles', content: { campaignName: 'Spring candles', metaAds: { headline: 'Hand-poured in Utrecht', primaryText: 'Natural soy wax.' } }, source_route: '/api/ai/create-ad', archived: false, favorite: false, created_at: t(4) },
    { id: 'a-vid', user_id: 'mcA', kind: 'video', title: 'Candle reel', content: { generationId: 'gen-123', prompt: 'slow pour' }, source_route: '/api/video-ads/generate', archived: false, favorite: false, created_at: t(3) },
    { id: 'a-res', user_id: 'mcA', kind: 'research', title: 'Saved research', content: {}, archived: false, created_at: t(2) },
    { id: 'b-img', user_id: 'mcB', kind: 'image', title: 'B-PRIVATE-IMAGE', content: { url: 'https://store.example/generated/mcB/1.png' }, source_route: '/api/generate-image', archived: false, favorite: false, created_at: t(1) },
  );

  log('\n1. Reading the library');
  let r = await call('GET', '/api/creative/assets', A);
  const ids = (r.body.assets || []).map((x) => x.id);
  check('1.1 the account sees its own content — image, ad creative, video; not saved research (order: the database sorts; My Content sorts too)', r.status === 200 && JSON.stringify(ids.slice().sort()) === '["a-ad","a-img","a-vid"]', ids);
  check('1.2 another account’s content never appears', !JSON.stringify(r.body).includes('B-PRIVATE-IMAGE'));
  r = await call('GET', '/api/creative/assets', null);
  check('1.3 not signed in → 401', r.status === 401);
  r = await call('GET', '/api/creative/assets', B);
  check('1.4 the other account sees only its own', JSON.stringify((r.body.assets || []).map((x) => x.id)) === '["b-img"]');

  log('\n2. Actions');
  r = await call('PATCH', '/api/creative/assets/b-img', A, { favorite: true });
  check('2.1 favouriting someone else’s item changes nothing', !rows().find((x) => x.id === 'b-img').favorite);
  r = await call('PATCH', '/api/creative/assets/a-img', A, { favorite: true });
  check('2.2 favouriting your own item is saved', r.status === 200 && rows().find((x) => x.id === 'a-img').favorite === true);
  r = await call('DELETE', '/api/creative/assets/b-img', A);
  check('2.3 deleting someone else’s item removes nothing', !!rows().find((x) => x.id === 'b-img'));
  r = await call('DELETE', '/api/creative/assets/a-res', A);
  check('2.4 the library delete can’t remove saved research (that has its own archive)', !!rows().find((x) => x.id === 'a-res'));
  r = await call('DELETE', '/api/creative/assets/a-img', A);
  check('2.5 deleting your own item removes it from the library', r.status === 200 && !rows().find((x) => x.id === 'a-img') && !(await call('GET', '/api/creative/assets', A)).body.assets.some((x) => x.id === 'a-img'));

  log('\n3. Videos get their link');
  videoJobs.record('gen-123', 'mcA');
  r = await call('GET', '/api/video-ads/status/gen-123', B);
  check('3.1 another account can’t read the job', r.status === 404 || r.status === 403, r.status);
  r = await call('GET', '/api/video-ads/status/gen-123', A);
  await sleep(100);
  check('3.2 while rendering: status "processing", the record has no link yet', r.status === 200 && r.body.status === 'processing' && !rows().find((x) => x.id === 'a-vid').content.url, r.body);
  VIDEO.status = 'completed';
  r = await call('GET', '/api/video-ads/status/gen-123', A);
  for (let i = 0; i < 40 && !rows().find((x) => x.id === 'a-vid').content.url; i++) await sleep(25);
  const vid = rows().find((x) => x.id === 'a-vid');
  check('3.3 finished: the link is written onto the account’s video record (job id and prompt kept)', r.body.status === 'completed' && vid.content.url === r.body.videoUrl && vid.content.generationId === 'gen-123' && vid.content.prompt === 'slow pour', vid.content);
  r = await call('GET', '/api/creative/assets', A);
  check('3.4 …so My Content gets it on the next load (and after signing in again)', (r.body.assets || []).find((x) => x.id === 'a-vid').content.url === vid.content.url);
  const before = JSON.stringify(vid);
  await call('GET', '/api/video-ads/status/gen-123', A); await sleep(80);
  check('3.5 asking again changes nothing (written once)', JSON.stringify(rows().find((x) => x.id === 'a-vid')) === before);
  check('3.6 no credits changed by reading, favouriting, deleting or the video link', H.rows('profiles').every((p) => p.credits_balance === 500));

  check('Z. no unexpected outbound network calls', H.net.blocked.length === 0, H.net.blocked);
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { console.error(e); process.exit(1); });
