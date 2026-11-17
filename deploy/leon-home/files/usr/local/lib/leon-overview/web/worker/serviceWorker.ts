export {};
declare const self: ServiceWorkerGlobalScope;
const CACHE = 'leon-shell-v1';
const SHELL = ['/offline', '/brand/symbol.png', '/brand/wordmark.png', '/brand/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Other applications on this private origin do not belong to this worker.
      for (const key of keys) if (key.startsWith('leon-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/offline')) ?? Response.error()));
    return;
  }
  if (url.pathname.startsWith('/brand/')) event.respondWith(caches.match(request).then(hit => hit ?? fetch(request)));
});
