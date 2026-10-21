/* My Workboard service worker: lets the installed app open offline.
   Network-first for the app shell (so new deploys show up immediately),
   falling back to the cached copy when there is no connection. API calls
   are never cached. Bump CACHE_VERSION when the shell file list changes. */

const CACHE_VERSION = 'workboard-v3.0.0';
const SHELL = [
  '/',
  '/styles.css',
  '/js/core.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/sheets.js',
  '/js/main.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const cacheKey = request.mode === 'navigate' ? '/' : request;
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(cacheKey, copy));
        }
        return response;
      })
      .catch(() => caches.match(cacheKey).then(cached => cached || caches.match('/')))
  );
});
