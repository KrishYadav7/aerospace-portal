/* ============================================================
   SERVICE WORKER — v149
   ------------------------------------------------------------
   KEY RULE: app code is NEVER served from a cache while the network
   works. app.js, styles.css, notes.js, index.html, /app … always come
   from the network first, exactly as before.
   ⭐ 2026-10-14 — offline: each successful network copy is also kept,
   and used ONLY when the network fails — so with no connection the
   app still starts and "My Notes" opens (the notebooks themselves are
   kept by notes.js in IndexedDB). Fonts and icons from the CDNs are
   kept the same way. /api/ and /uploads/ are never cached here.
   ============================================================ */
const CACHE_NAME = 'aero-shell-v149';
const APP_CACHE  = 'aero-app-v149';        // last good copy of the app code (offline only)
const CDN_CACHE  = 'aero-cdn-v1';          // fonts & icons

/* ONLY these go into the offline cache — they never change silently */
const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  './favicon.svg',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

/* App code: always fetched fresh from the network; the cached copy is the offline fallback */
const NETWORK_FIRST_PATTERNS = [
  /\/$/,
  /\/app$/,
  /\/index\.html$/,
  /\/landing\.html$/,
  /\.js$/,
  /\.css$/,
  /\/manifest\.json$/
];
const CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

/* the app page and every script / stylesheet it names (incl. the lazily loaded
   notes files) are copied at install, so the app opens offline even before
   those files were ever used */
async function warmAppCache() {
  try {
    const res = await fetch('/app', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;
    const html = await res.clone().text();
    const cache = await caches.open(APP_CACHE);
    await cache.put('/app', res);
    const urls = new Set();
    const re = /(?:src|href)=["'](\/?[A-Za-z0-9_./-]+\.(?:js|css)(?:\?[^"'#\s]*)?)["']/g;
    let m;
    while ((m = re.exec(html))) {
      const u = new URL(m[1], self.location.origin);
      if (u.origin === self.location.origin && !u.pathname.startsWith('/api/') && u.pathname !== '/sw.js') urls.add(u.pathname + u.search);
    }
    await Promise.all(Array.from(urls).map((u) =>
      fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? cache.put(u, r) : null)).catch(() => null)));
  } catch (e) { /* offline at install — the next online visit fills it */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] cache miss:', url, err))
        )
      )
    ),
    warmAppCache()
  ]));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const keep = new Set([CACHE_NAME, APP_CACHE, CDN_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          /* keep the on-device PDF page cache (media-viewer.js) */
          keys.filter((k) => !keep.has(k) && k.indexOf('aero-pdf-pages') !== 0).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        /* Notify every open tab that the SW was just updated.
           The client-side listener decides whether to reload. */
        clients.forEach((c) => {
          try { c.postMessage({ type: 'SW_UPDATED', cache: CACHE_NAME }); } catch (e) {}
        });
      })
  );
});

/* Allow the page to force-activate a waiting SW immediately */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* network first; a good answer is kept; the kept copy is used only when the network fails */
async function networkFirst(req, isPage) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      const key = isPage ? new URL(req.url).pathname : req;
      /* a versioned file (…?v=hash) never changes — write it once, not on every visit */
      if (!isPage && /[?&]v=/.test(req.url)) cache.match(key).then((h) => { if (!h) cache.put(key, copy).catch(() => {}); });
      else cache.put(key, copy).catch(() => {});
    }
    return res;
  } catch (err) {
    const url = new URL(req.url);
    const hit = await cache.match(isPage ? url.pathname : req) ||
                await cache.match(req, { ignoreSearch: true });           // an older ?v= of the same file
    if (hit) return hit;
    if (isPage) {
      const app = await cache.match('/app') || await caches.match('./index.html');
      if (app) return app;
    }
    return Response.error();
  }
}

/* fonts & icons: the kept copy at once, refreshed in the background */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || (await fresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (CDN_HOSTS.includes(url.hostname)) event.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;
  if (url.pathname === '/sw.js') return;

  const isPage = req.mode === 'navigate';
  if (isPage || NETWORK_FIRST_PATTERNS.some((re) => re.test(url.pathname))) {
    event.respondWith(networkFirst(req, isPage));
    return;
  }

  const isShellAsset = SHELL_ASSETS.some((a) => {
    const p = (a === './' || a === './index.html') ? '/' : a.replace(/^\.\//, '/');
    return url.pathname === p;
  });

  if (isShellAsset) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
      )
    );
    return;
  }
});
