import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/serviceWorker.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {},
    deleted = [],
    cached = [];
  const scope = {
    location: { origin: 'https://leon.test' },
    addEventListener: (kind, handler) => {
      handlers[kind] = handler;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async () => ({
      addAll: async paths => {
        cached.push(...paths);
      },
    }),
    keys: async () => ['leon-shell-old', 'leon-shell-v1', 'other-application'],
    delete: async name => {
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
    fetch: async () => {
      throw new Error('offline');
    },
  });
  return { handlers, deleted, cached };
}
test('offline shell caches only data-free resources and retains unrelated application caches', async () => {
  const value = worker();
  let completion;
  value.handlers.install({
    waitUntil: promise => {
      completion = promise;
    },
  });
  await completion;
  assert.deepEqual(value.cached, ['/offline', '/brand/symbol.png', '/brand/wordmark.png', '/brand/icon-512.png']);
  value.handlers.activate({
    waitUntil: promise => {
      completion = promise;
    },
  });
  await completion;
  assert.deepEqual(value.deleted, ['leon-shell-old']);
});
test('private metrics and action requests are not handled by the offline cache', () => {
  const value = worker();
  for (const [method, path] of [
    ['GET', '/network-map/data'],
    ['POST', '/network-map/port'],
    ['POST', '/network-map/unlock'],
  ]) {
    let intercepted = false;
    value.handlers.fetch({
      request: { method, url: 'https://leon.test' + path, mode: 'same-origin' },
      respondWith: () => {
        intercepted = true;
      },
    });
    assert.equal(intercepted, false);
  }
});
