// ════════════════════════════════════════════════════════════════
// Local development only: always the latest frontend at localhost:5500.
//
//   • Every response from this backend is sent with Cache-Control: no-store
//     in development, so the browser never shows an older copy of a file.
//   • Live reload: the frontend folder is watched; when a file changes, open
//     pages reload (a stylesheet-only change swaps the CSS without a reload).
//     Pages also reload when the backend restarts (npm run dev).
//     The script goes first in <head>, so it keeps working in /demo-app too.
//     A small script is injected into HTML pages here, in memory — the
//     frontend files themselves are not changed and production (Netlify for
//     the frontend, Render for this backend) never runs this module.
//   • GET /__dev/info tells which folder, branch and commit is being served.
//
// Registered in server.js only when RENDER is not set and NODE_ENV is not
// 'production'. Set ORIVEN_LIVE_RELOAD=0 to switch the reload off.
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IGNORE = /(^|[\\/])(\.git|node_modules|tests[\\/]_shots|\.vscode)([\\/]|$)/;

function gitInfo(dir) {
  const run = (args) => { try { return execFileSync('git', ['-C', dir].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; } };
  return { branch: run(['branch', '--show-current']) || '(no git)', commit: run(['log', '-1', '--format=%h %s']).slice(0, 90), changedFiles: run(['status', '--short']).split('\n').filter(Boolean).length };
}

const CLIENT = `(function () {
  if (window.__orvLiveReload) return; window.__orvLiveReload = true;
  var lost = false, NativeES = window.EventSource; // captured before any page script (the demo replaces EventSource)
  function connect() {
    var es = new NativeES('/__dev/live-reload');
    es.addEventListener('css', function () {
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function (l) {
        try { var u = new URL(l.href, location.href); if (u.origin !== location.origin) return; u.searchParams.set('v', Date.now()); l.href = u.toString(); } catch (_) {}
      });
    });
    es.addEventListener('reload', function () { location.reload(); });
    es.onopen = function () { if (lost) location.reload(); };
    es.onerror = function () { lost = true; };
  }
  connect();
})();`;

module.exports = function devLiveReload(app, frontendDir) {
  const root = path.resolve(frontendDir);
  const enabled = process.env.ORIVEN_LIVE_RELOAD !== '0';
  const clients = new Set();

  // 1. Never cache in development
  app.use(function (req, res, next) { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/__dev/info', function (req, res) {
    res.json(Object.assign({ frontendDir: root, backendDir: path.resolve(__dirname, '..'), liveReload: enabled, frontend: gitInfo(root), backend: gitInfo(path.resolve(__dirname, '..')) }));
  });
  if (!enabled) return;

  app.get('/__dev/live-reload.js', function (req, res) { res.type('application/javascript').send(CLIENT); });
  app.get('/__dev/live-reload', function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    clients.add(res);
    const ping = setInterval(function () { res.write(': ping\n\n'); }, 25000);
    req.on('close', function () { clearInterval(ping); clients.delete(res); });
  });

  // 2. Watch the frontend folder (recursive watching is supported on Windows and macOS)
  let timer = null, cssOnly = true;
  try {
    const watcher = fs.watch(root, { recursive: true }, function (event, file) {
      if (!file || IGNORE.test(file)) return;
      // Windows also reports the folder that holds a changed file; that is not a change of its own
      if (!path.extname(file)) { try { if (fs.statSync(path.join(root, file)).isDirectory()) return; } catch (_) {} }
      if (path.extname(file) !== '.css') cssOnly = false;
      clearTimeout(timer);
      timer = setTimeout(function () {
        const ev = cssOnly ? 'css' : 'reload'; cssOnly = true;
        clients.forEach(function (c) { c.write('event: ' + ev + '\ndata: ' + Date.now() + '\n\n'); });
      }, 120);
    });
    watcher.unref(); // never keeps the process alive (tests, scripts)
    process.once('exit', function () { try { watcher.close(); } catch (_) {} });
  } catch (e) {
    console.warn('[dev] live reload: could not watch ' + root + ' (' + e.message + ') — refresh the page by hand.');
  }

  // 3. Inject the client into HTML responses (in memory; files are untouched)
  const TAG = '<script src="/__dev/live-reload.js"></script>';
  app.use(function (req, res, next) {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/__dev/')) return next();
    const write = res.write, end = res.end, chunks = [];
    let html = null;
    const isHtml = function () { if (html === null) html = /text\/html/i.test(String(res.getHeader('Content-Type') || '')); return html; };
    res.write = function (chunk, enc, cb) {
      if (!isHtml()) return write.call(res, chunk, enc, cb);
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      if (!isHtml()) return end.call(res, chunk, enc, cb);
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      let body = Buffer.concat(chunks).toString('utf8');
      // first thing in <head>, so it runs before any page script
      if (body && body.indexOf('/__dev/live-reload.js') < 0) body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, function (m) { return m + TAG; }) : TAG + body;
      const buf = Buffer.from(body, 'utf8');
      if (!res.headersSent) { res.removeHeader('ETag'); res.setHeader('Content-Length', buf.length); }
      return end.call(res, req.method === 'HEAD' ? undefined : buf, typeof enc === 'function' ? enc : cb);
    };
    next();
  });
};
