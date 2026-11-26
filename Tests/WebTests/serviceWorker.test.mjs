import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/serviceWorker.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {},
    deleted = [],
    cached = [],
    opened = [];
  const scope = {
    location: { origin: 'https://leon.test' },
    addEventListener(kind, handler) {
      handlers[kind] = handler;
    },
    async skipWaiting() {},
    clients: { async claim() {} },
  };
  const caches = {
    async open(name) {
      opened.push(name);
      return {
        match: async () => new Response('offline'),
        async addAll(paths) {
          cached.push(...paths.map(request => new URL(request.url).pathname));
        },
      };
    },
    keys: async () => ['leon-shell-old', 'leon-shell-v1', 'other-application'],
    async delete(name) {
      deleted.push(name);
      return true;
    },
    match: async () => new Response('offline'),
  };
  vm.runInNewContext(source, {
    self: scope,
    caches,
    URL,
    Response,
    Request: class extends Request {
      constructor(path, options) {
        super(new URL(path, 'https://leon.test'), options);
      }
    },
    async fetch() {
      throw new Error('offline');
    },
  });
  return { handlers, deleted, cached, opened };
}
test('offline shell caches only data-free resources and retains unrelated application caches', async () => {
  const value = worker();
  let completion;
  value.handlers.install({
    waitUntil(promise) {
      completion = promise;
    },
  });
  await completion;
  assert.deepEqual(value.cached, ['/offline', '/brand/symbol.png', '/brand/wordmark.png', '/brand/icon-512.png']);
  assert.match(value.opened[0], /^leon-shell-[a-f0-9]{16}$/);
  value.handlers.activate({
    waitUntil(promise) {
      completion = promise;
    },
  });
  await completion;
  assert.deepEqual(value.deleted, ['leon-shell-old', 'leon-shell-v1']);
});
test('private metrics and action requests are not handled by the offline cache', () => {
  const value = worker();
  for (const [method, path] of [
    ['GET', '/network-map/data'],
    ['GET', '/leon/v1/home'],
    ['GET', '/leon/v1/session'],
    ['GET', '/network-map/assets/leon.js'],
    ['GET', '/network-map/assets/unknown.js'],
    ['GET', '/network-map/assets/leon.js?other=1'],
    ['GET', '/brand/unlisted.png'],
    ['POST', '/network-map/port'],
    ['POST', '/network-map/unlock'],
  ]) {
    let intercepted = false;
    value.handlers.fetch({
      request: { method, url: `https://leon.test${path}`, mode: 'same-origin' },
      respondWith() {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
  }
});

test('worker cache revision follows every fixed asset, offline shell source and brand input', async () => {
  const web = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/', import.meta.url);
  const revision = createHash('sha256');
  for (const name of ['leon.js', 'updates.js', 'home.css', 'leon.css', 'updates.css']) revision.update(await readFile(new URL(`dist/${name}`, web)));
  revision.update(await readFile(new URL('worker/serviceWorker.ts', web)));
  revision.update(await readFile(new URL('../overview.py', web)));
  for (const name of ['symbol-web.png', 'wordmark-web.png', 'icon-512.png']) revision.update(await readFile(new URL(`../../../share/leon-home/${name}`, web)));
  const value = worker();
  let completion;
  value.handlers.install({
    waitUntil(promise) {
      completion = promise;
    },
  });
  await completion;
  assert.equal(value.opened[0], `leon-shell-${revision.digest('hex').slice(0, 16)}`);
});
