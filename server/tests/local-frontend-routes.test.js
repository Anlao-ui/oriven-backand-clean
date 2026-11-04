// ════════════════════════════════════════════════════════════════
// Local development routing of the public website (localFrontendRoutes.js).
//
// Regression for "/blog shows Not found" in local development: express.static
// answered /blog (a folder in oriven-frontend) with a 301 to /blog/, browsers
// cached it, and /blog/ had no index.html → "Not found". The router now
// mirrors Netlify: _redirects 200 rewrites, extension-less pages
// (/blog/<post>, /solutions/<page>) and trailing-slash forms.
//
// Builds the same chain as server.js (router → express.static → the local
// 404 fallback) on its own port, against the real oriven-frontend folder.
// Also checks that server.js registers the router before express.static and
// only outside Render. No Supabase, no network, no real users.
//
// RUN: node tests/local-frontend-routes.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const express = require('express');

const FRONTEND = process.env.FRONTEND_DIR || path.resolve(__dirname, '..', '..', '..', 'oriven-frontend');
const PORT = 5596, BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS — ' + name); } else { fail++; console.log('FAIL — ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 400) : '')); } }

if (!fs.existsSync(path.join(FRONTEND, '_redirects'))) { console.log('SKIP — oriven-frontend not found next to the backend (set FRONTEND_DIR)'); process.exit(0); }

const app = express();
app.use(require('../localFrontendRoutes')(FRONTEND));
app.use(express.static(FRONTEND));
// The backend's own routes (stand-ins with a marker, so we can see they were reached untouched).
app.get('/signup', (q, s) => s.send('OWN:signup'));
app.get('/login', (q, s) => s.send('OWN:login'));
app.get('/app', (q, s) => s.send('OWN:app'));
app.get('/api/ping', (q, s) => s.json({ ok: true, url: q.url }));
// Same fallback as server.js in local development.
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(404).json({ error: 'Route not found' });
  res.sendFile(path.resolve(FRONTEND, req.path === '/' ? 'index.html' : req.path.replace(/^\//, '')), (err) => { if (err) res.status(404).send('Not found'); });
});

const title = (t) => (t.match(/<title>([^<]*)/) || [])[1] || t.slice(0, 40);

(async () => {
  const srv = app.listen(PORT);
  await new Promise((r) => srv.once('listening', r));
  const get = async (u, opts) => { const r = await fetch(BASE + u, Object.assign({ redirect: 'manual' }, opts)); return { status: r.status, location: r.headers.get('location'), body: await r.text() }; };

  // A. Blog (the reported failure)
  for (const u of ['/blog', '/blog/', '/blog.html', '/blog?ref=nav']) {
    const r = await get(u);
    check(`${u} → 200 Blog index (no redirect, no "Not found")`, r.status === 200 && /OrivenAI Blog/.test(title(r.body)), { status: r.status, location: r.location, title: title(r.body) });
  }
  for (const slug of ['oriven-ai-is-now-live', 'what-you-can-do-with-oriven', 'why-we-built-oriven']) {
    const r = await get('/blog/' + slug);
    check(`/blog/${slug} → 200 article`, r.status === 200 && /OrivenAI Blog/.test(title(r.body)) && r.body.includes(`/blog/${slug}"`), { status: r.status, title: title(r.body) });
  }

  // B. Every prerendered route from _redirects, with and without a trailing slash
  const rules = fs.readFileSync(path.join(FRONTEND, '_redirects'), 'utf8').split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p[2] && /^200!?$/.test(p[2]) && /\.html$/.test(p[1]) && !['/app', '/signup', '/login'].includes(p[0]));
  const bad = [];
  for (const [from, to] of rules) {
    const expect = title(fs.readFileSync(path.join(FRONTEND, to.replace(/^\//, '')), 'utf8'));
    for (const u of from === '/' ? ['/'] : [from, from + '/']) { const r = await get(u); if (r.status !== 200 || title(r.body) !== expect) bad.push(`${u} ${r.status} ${title(r.body)}`); }
  }
  check(`all ${rules.length} prerendered routes serve their own page, with and without a trailing slash`, rules.length > 20 && bad.length === 0, bad);

  // C. The five solution pages (extension-less, like blog posts)
  for (const slug of ['connected-workflow', 'research-before-creation', 'plan-to-content', 'advertising-campaigns', 'structured-automation']) {
    const file = path.join(FRONTEND, 'solutions', slug + '.html');
    const r = await get('/solutions/' + slug);
    check(`/solutions/${slug} → 200, its own page`, fs.existsSync(file) && r.status === 200 && title(r.body) === title(fs.readFileSync(file, 'utf8')), { status: r.status, title: title(r.body) });
  }
  const sol = await get('/solutions'); const solSlash = await get('/solutions/');
  check('/solutions and /solutions/ still serve the Solutions overview (not the folder)', sol.status === 200 && solSlash.status === 200 && /Solutions/.test(title(sol.body)) && title(sol.body) === title(solSlash.body), [title(sol.body), title(solSlash.body)]);

  // D. Nothing else changes
  const own = await Promise.all(['/signup', '/login', '/app'].map((u) => get(u)));
  check('/signup, /login and /app reach the backend’s own routes, untouched', own.every((r, i) => r.body === 'OWN:' + ['signup', 'login', 'app'][i]), own.map((r) => r.body.slice(0, 20)));
  const api = await get('/api/ping?x=1'); const api404 = await get('/api/blog');
  check('/api routes are not rewritten (and /api/blog stays an API 404)', api.status === 200 && JSON.parse(api.body).url === '/api/ping?x=1' && api404.status === 404 && /Route not found/.test(api404.body), [api.status, api404.status]);
  const learn = await get('/learn'); const learnSlash = await get('/learn/');
  check('folders with their own index.html keep working (/learn → /learn/, /learn/ → hub)', learn.status === 301 && /\/learn\/$/.test(learn.location) && learnSlash.status === 200 && /Learn/.test(title(learnSlash.body)), [learn.status, learn.location, learnSlash.status]);
  const missing = await get('/does-not-exist'); const trav = await get('/..%2f..%2fserver%2fserver.js'); const post = await get('/blog', { method: 'POST' });
  check('unknown paths 404; no path traversal; non-GET untouched', missing.status === 404 && trav.status === 404 && post.status === 404, [missing.status, trav.status, post.status]);

  // E. server.js wiring
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const iRouter = src.indexOf("app.use(require('./localFrontendRoutes')(LOCAL_FRONTEND_DIR))"), iStatic = src.indexOf('app.use(express.static(LOCAL_FRONTEND_DIR))');
  check('server.js: router registered before express.static, and only when RENDER is not set', iRouter > 0 && iStatic > iRouter && /if \(!process\.env\.RENDER\) app\.use\(require\('\.\/localFrontendRoutes'\)/.test(src));

  srv.close();
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
