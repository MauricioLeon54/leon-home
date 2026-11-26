import assert from 'node:assert/strict';
import test from 'node:test';

import { readGetJson } from '../../.build/web-modules/api.js';

test('concurrent endpoint readers share transport and keep independent parsers/limits', async context => {
  let calls = 0,
    respond;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Promise(resolve => {
      respond = resolve;
    });
  });
  const first = readGetJson('/api/v1/home');
  const second = readGetJson('/leon/v1/home', undefined, 2);
  const limited = assert.rejects(second, /exceeds limit/);
  assert.equal(calls, 1);
  respond(new Response('{"value":0}'));
  assert.deepEqual(await first, { value: 0 });
  await limited;
  const next = readGetJson('/api/v1/home');
  assert.equal(calls, 2);
  respond(new Response('{"value":1}'));
  await next;
});

test('one reader cancelling does not cancel another; the last reader aborts the transport', async context => {
  let transport, respond;
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    transport = options.signal;
    return new Promise(resolve => {
      respond = resolve;
    });
  });
  const cancelled = new AbortController();
  const first = readGetJson('/api/v1/network', cancelled.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = readGetJson('/api/v1/network');
  cancelled.abort();
  await rejected;
  assert.equal(transport.aborted, false);
  respond(new Response('{"value":false}'));
  assert.deepEqual(await second, { value: false });
  const last = new AbortController();
  const pending = readGetJson('/api/v1/network', last.signal);
  const aborted = assert.rejects(pending, { name: 'AbortError' });
  last.abort();
  await aborted;
  assert.equal(transport.aborted, true);
  respond(new Response('{}'));
});

test('already cancelled readers never fetch and failed reads are evicted', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('offline');
  });
  await assert.rejects(readGetJson('/api/v1/home', AbortSignal.abort()));
  assert.equal(calls, 0);
  await assert.rejects(readGetJson('/api/v1/home'), /offline/);
  await assert.rejects(readGetJson('/api/v1/home'), /offline/);
  assert.equal(calls, 2);
});
