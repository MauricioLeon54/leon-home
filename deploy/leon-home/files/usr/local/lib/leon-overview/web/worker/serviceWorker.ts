export {};
declare const self: ServiceWorkerGlobalScope;
declare const __LEON_ASSET_VERSION__: string;
const CACHE = `leon-shell-${__LEON_ASSET_VERSION__}`;
// Only public files: the compiled app assets are owner-only, and one refused file would stop the
// whole install, leaving an outdated worker in charge.
const SHELL = ['/offline', '/brand/symbol.png', '/brand/wordmark.png', '/brand/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' }))))
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
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(CACHE)).match('/offline')) ?? Response.error()));
    return;
  }
  if (!url.search && SHELL.includes(url.pathname)) event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request)) ?? fetch(request)));
});
