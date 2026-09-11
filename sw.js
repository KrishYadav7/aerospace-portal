/* ============================================================
   SERVICE WORKER — offline shell caching
   ============================================================ */
const CACHE_NAME = 'aero-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('Cache miss:', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/') || url.hostname.includes('razorpay')) return;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request).then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()));
        }).catch(() => {});
        return cached;
      }
      return fetch(request)
        .then((res) => {
          if (res.ok && (url.origin === location.origin || url.hostname.includes('cdnjs') || url.hostname.includes('fonts.g'))) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});