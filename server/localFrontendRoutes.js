// ════════════════════════════════════════════════════════════════
// Local development only: serve the frontend's clean URLs the way Netlify
// does in production.
//
// In production the public site is served by Netlify, which applies
// oriven-frontend/_redirects (/about → /about.html, / → /home.html, …) and
// "pretty URLs" (/blog/<post> → blog/<post>.html). In local development this
// backend serves the frontend folder with express.static, which does neither,
// so /about, /faq, /blog, /pricing, /case-studies and every other prerendered
// page answered "Not found" unless the .html file was opened directly.
//
// This middleware mirrors those two rules and nothing else:
//   • 200 rewrites from _redirects (re-read when the file changes, since
//     tools/seo/prerender.js regenerates it), except /app, /signup and /login,
//     which this backend already serves itself, and anything with a query;
//   • an extension-less path that has a matching .html file (and is not a
//     folder with its own index.html) is served from that file.
// Redirects (301/302) and the 404 catch-all are left to the existing routes.
// It is registered only when RENDER is not set; on Render it is never used.
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const OWN_ROUTES = new Set(['/app', '/signup', '/login']);

module.exports = function localFrontendRoutes(frontendDir) {
  const root = path.resolve(frontendDir);
  const redirectsFile = path.join(root, '_redirects');
  let cache = { mtime: -1, rules: new Map() };

  function rules() {
    let mtime;
    try { mtime = fs.statSync(redirectsFile).mtimeMs; } catch (_) { return new Map(); }
    if (mtime !== cache.mtime) {
      const map = new Map();
      fs.readFileSync(redirectsFile, 'utf8').split(/\r?\n/).forEach(function (line) {
        const l = line.trim();
        if (!l || l.charAt(0) === '#') return;
        const parts = l.split(/\s+/);
        const from = parts[0], to = parts[1], status = parts[2] || '';
        if (/^200!?$/.test(status) && !from.includes('*') && !to.includes('?') && /\.html$/.test(to) && !OWN_ROUTES.has(from)) map.set(from, to);
      });
      cache = { mtime: mtime, rules: map };
    }
    return cache.rules;
  }

  const inside = function (p) { return p === root || p.startsWith(root + path.sep); };
  const isFile = function (p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path;
    if (p.startsWith('/api/') || p.startsWith('/auth/')) return next();
    const qs = req.url.slice(req.url.indexOf('?') >= 0 ? req.url.indexOf('?') : req.url.length);
    const resolve = function (q) {
      if (OWN_ROUTES.has(q)) return null; // the backend serves these itself
      const target = rules().get(q);
      if (target) return target;
      if (!path.extname(q)) {
        const html = path.resolve(root, '.' + q + '.html');
        const asDirIndex = path.resolve(root, '.' + q, 'index.html');
        if (inside(html) && isFile(html) && !isFile(asDirIndex)) return q + '.html';
      }
      return null;
    };
    if (!p.endsWith('/')) { const t = resolve(p); if (t) req.url = t + qs; return next(); }
    // A trailing slash with no index.html of its own is the same page, as on
    // Netlify: /blog/ serves blog.html. (Before this router existed,
    // express.static answered /blog, a folder, with a 301 to /blog/, and
    // browsers keep that 301 cached.)
    if (p.length > 1 && !isFile(path.resolve(root, '.' + p, 'index.html'))) { const t = resolve(p.replace(/\/+$/, '')); if (t) req.url = t + qs; }
    return next();
  };
};
