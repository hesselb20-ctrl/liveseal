// LiveSeal service worker: keeps the app usable offline. Network first, cache
// as a fallback. Organisation key files are never cached: a stale copy could
// hide a revocation.
const CACHE = 'liveseal-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/.well-known/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (err) {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw err;
    }
  })());
});
