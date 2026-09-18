/* ============================================================
   SERVICE WORKER — offline shell caching (v26)
   ------------------------------------------------------------
   v26 changes:
     • Cache name bumped from v25 → v26 (forces fresh files)
     • Network-first strategy (always tries server before cache)
     • Query-string cache buster on install
   ============================================================ */
const CACHE_NAME = 'aero-shell-v27';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './media-viewer.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url + '?v=27').catch((err) => console.warn('[SW] cache miss:', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API calls, uploads, or cross-origin requests
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;

  // ⚡ NETWORK-FIRST: Always try server first, fall back to cache offline
  const isShell = SHELL_ASSETS.some((a) =>
    url.pathname.endsWith(a.replace('./', '/')) || url.pathname === '/'
  );

  if (isShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
  }
});