/* ============================================================
   SERVICE WORKER — v45
   ------------------------------------------------------------
   KEY RULE: NEVER cache app code (app.js, styles.css, media-viewer.js,
   sw.js, index.html). Those files carry a version query (?v=45) that
   changes on every deploy, and they MUST always come from the network.
   Only truly static assets (manifest, images) go in the cache.
   ============================================================ */
const CACHE_NAME = 'aero-shell-v45';

/* ONLY these go into the offline cache — they never change silently */
const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  './passport.jpg'
];

/* Files that must ALWAYS be fetched fresh from the network */
const NEVER_CACHE_PATTERNS = [
  /\/$/,
  /\/index\.html$/,
  /\/app\.js$/,
  /\/styles\.css$/,
  /\/media-viewer\.js$/,
  /\/sw\.js$/
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] cache miss:', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;

  const isAppCode = NEVER_CACHE_PATTERNS.some((re) => re.test(url.pathname));
  if (isAppCode) {
    event.respondWith(
      fetch(req)
        .catch(() => caches.match('./index.html').then((c) => c || Response.error()))
    );
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