/* ============================================================
   AEROGYAN OFFICE — one app's service worker  (2026-11-11)
   ------------------------------------------------------------
   Served as /apps/<slug>/sw.js (scope /apps/<slug>/) for every app in
   office/apps.json — the same file, so everything here comes from
   self.registration.scope. docs/office-apps-design.md §4.7.

   • the app page and every same-origin .js / .css: NETWORK FIRST —
     a kept copy is used only when the network fails (offline)
   • /apps/icons/ and /vendor/ (fonts, icons, libraries): cache first
   • /api/ and /uploads/ are never touched
   • never opened online yet and offline → a small offline page
   • a new version posts SW_UPDATED like /sw.js (index.html reloads
     when nothing is being edited) — not on the very first install
   Caches are named aero-oa-<slug>-… (/sw.js leaves them alone).
   ============================================================ */
const VERSION = 'v1';
const SCOPE = self.registration.scope;                       // https://host/apps/sheets/
const SCOPE_PATH = new URL(SCOPE).pathname;                  // /apps/sheets/
const SLUG = (SCOPE_PATH.match(/^\/apps\/([a-z0-9-]+)\/$/) || [])[1] || 'app';
const PREFIX = 'aero-oa-' + SLUG + '-';
const APP_CACHE = PREFIX + 'app-' + VERSION;                 // the app page + its scripts / styles (offline copy)
const STATIC_CACHE = PREFIX + 'static-' + VERSION;           // icons, fonts, /vendor/
const CDN_CACHE = PREFIX + 'cdn-' + VERSION;                 // Google Fonts
const CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

const sameOrigin = (u) => u.origin === self.location.origin;
const isVersioned = (u) => /[?&]v=/.test(u.search);

/* a script / style with a ?v=<hash> never changes: keep one copy per file (older hashes go) */
async function keep(cache, req, res) {
  try {
    const u = new URL(req.url || req, self.location.origin);
    if (isVersioned(u)) {
      if (await cache.match(u.pathname + u.search)) return;
      const old = await cache.keys();
      await Promise.all(old.filter((k) => { const ku = new URL(k.url); return ku.pathname === u.pathname && ku.search !== u.search; }).map((k) => cache.delete(k)));
      await cache.put(u.pathname + u.search, res);
    } else await cache.put(req, res);
  } catch (e) {}
}

/* install: the app page, every script / stylesheet it names (also the lazily loaded tool files),
   the fonts those stylesheets use, and the app's icon — so it opens offline after one visit */
async function warm() {
  const app = await caches.open(APP_CACHE), stat = await caches.open(STATIC_CACHE);
  let html = '';
  try {
    const res = await fetch(SCOPE_PATH, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;
    html = await res.clone().text();
    await app.put(SCOPE_PATH, res);
  } catch (e) { return; }
  const urls = new Set();
  const re = /(?:src|href)=["'](\/[A-Za-z0-9_./-]+\.(?:js|css|svg|png|webmanifest)(?:\?[^"'#\s]*)?)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const u = new URL(m[1], self.location.origin);
    if (!u.pathname.startsWith('/api/') && !u.pathname.startsWith('/uploads/') && !/\/sw\.js$/.test(u.pathname)) urls.add(u.pathname + u.search);
  }
  const css = [];
  await Promise.all([...urls].map(async (p) => {
    try {
      const r = await fetch(p, { credentials: 'same-origin' });
      if (!r.ok) return;
      const vendor = p.startsWith('/vendor/') || p.startsWith('/apps/icons/');
      if (/\.css(\?|$)/.test(p)) css.push([p, await r.clone().text()]);
      await keep(vendor ? stat : app, p, r);
    } catch (e) {}
  }));
  /* fonts named by those stylesheets (Font Awesome, KaTeX …) */
  const fonts = new Set();
  css.forEach(([base, text]) => {
    const fr = /url\(\s*["']?([^"')]+\.(?:woff2|woff|ttf)(?:\?[^"')]*)?)["']?\s*\)/g;
    let f;
    while ((f = fr.exec(text))) { try { const u = new URL(f[1], self.location.origin + base); if (sameOrigin(u)) fonts.add(u.pathname + u.search); } catch (e) {} }
  });
  await Promise.all([...fonts].slice(0, 40).map((p) => fetch(p).then((r) => (r.ok ? stat.put(p, r) : null)).catch(() => null)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(warm());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const mine = new Set([APP_CACHE, STATIC_CACHE, CDN_CACHE]);
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter((k) => k.indexOf(PREFIX) === 0 && !mine.has(k));
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    /* an update (an older version of this app's worker was here): tell the open windows */
    if (old.length) {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.postMessage({ type: 'SW_UPDATED', cache: APP_CACHE }); } catch (e) {} });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function offlinePage() {
  const name = 'AeroGyan ' + SLUG.charAt(0).toUpperCase() + SLUG.slice(1);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${name} — offline</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7fb;color:#1f2937;padding:24px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e5e7eb}.c{background:#181b22!important;border-color:#2a2f3a!important}}
.c{max-width:380px;text-align:center;background:#fff;border:1px solid #e5e7eb;border-radius:22px;padding:28px 24px}
img{width:72px;height:72px;border-radius:18px}h1{font-size:20px;margin:14px 0 6px}p{margin:0 0 18px;color:#6b7280}
button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:11px 20px;background:#4f46e5;color:#fff;cursor:pointer}button:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}
</style></head><body><main class="c"><img src="/apps/icons/${SLUG}/icon.svg" alt="" onerror="this.remove()"><h1>You are offline</h1>
<p>${name} needs the internet the first time it opens. Connect and try again — after that it opens without a connection.</p>
<button type="button" onclick="location.reload()">Try again</button></main></body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* the app page: network first; offline → the kept page → the offline page */
async function page(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(SCOPE_PATH, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    return (await cache.match(SCOPE_PATH)) || offlinePage();
  }
}
/* scripts / styles / the manifest: network first, the kept copy only offline */
async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') keep(cache, req, res.clone());
    return res;
  } catch (e) {
    const u = new URL(req.url);
    return (await cache.match(u.pathname + u.search)) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}
/* icons, /vendor/: the kept copy at once */
async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req) || await cache.match(new URL(req.url).pathname + new URL(req.url).search);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) { return Response.error(); }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!sameOrigin(url)) {
    if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/uploads/') || p === SCOPE_PATH + 'sw.js') return;
  if (req.mode === 'navigate') {
    if (p === SCOPE_PATH || p === SCOPE_PATH + 'index.html') event.respondWith(page(req));
    return;
  }
  if (p.startsWith('/apps/icons/') || p.startsWith('/vendor/')) { event.respondWith(cacheFirst(req, STATIC_CACHE)); return; }
  if (/\.(js|css|webmanifest)$/.test(p) || p === '/apps/catalog.json') { event.respondWith(networkFirst(req)); return; }
});
