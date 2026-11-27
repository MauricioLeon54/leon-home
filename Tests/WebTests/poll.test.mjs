import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../../.build/web-modules/core/poll.js', import.meta.url), 'utf8')).replaceAll('export ', '');
function fixture(load = async () => 1) {
  const document = new EventTarget();
  document.hidden = false;
  document.visibilityState = 'visible';
  const timers = new Map();
  const data = [],
    failures = [];
  let timerId = 0;
  const context = vm.createContext({
    document,
    AbortController,
    Error,
    Date,
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(source, context);
  const poller = context.poll({ load, intervalMs: 1000, onData: value => data.push(value), onFailure: error => failures.push(error) });
  return {
    poller,
    data,
    failures,
    timers,
    hidden(value) {
      document.hidden = value;
      document.visibilityState = value ? 'hidden' : 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    tick() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
  };
}
const flush = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};

test('an action gets a new reading when a pre-action poll is still in flight', async () => {
  const loads = [];
  const app = fixture(() => new Promise(resolve => loads.push(resolve)));
  const first = app.poller.refreshAfterPending();
  const second = app.poller.refreshAfterPending();
  assert.equal(loads.length, 1);
  loads[0]('enabled');
  await flush();
  assert.equal(loads.length, 2);
  loads[1]('disabled');
  await Promise.all([first, second]);
  assert.deepEqual(app.data, ['enabled', 'disabled']);
  app.poller.stop();
});

test('hidden pollers have no scheduled work and resume immediately', async () => {
  let reads = 0;
  const app = fixture(async () => ++reads);
  await flush();
  assert.equal(reads, 1);
  assert.equal(app.timers.size, 1);
  app.hidden(true);
  assert.equal(app.timers.size, 0);
  app.tick();
  await app.poller.refresh();
  assert.equal(reads, 1);
  app.hidden(false);
  await flush();
  assert.equal(reads, 2);
  app.poller.stop();
  assert.equal(app.timers.size, 0);
});

test('rapid hide/show waits for a cancelled load, ignores its data and starts exactly one replacement', async () => {
  const loads = [];
  const app = fixture(signal => new Promise(resolve => loads.push({ signal, resolve })));
  await app.poller.refresh();
  assert.equal(loads.length, 1);
  app.hidden(true);
  assert.equal(loads[0].signal.aborted, true);
  app.hidden(false);
  app.hidden(false);
  assert.equal(loads.length, 1);
  loads[0].resolve('discard');
  await flush();
  assert.equal(loads.length, 2);
  assert.deepEqual(app.data, []);
  loads[1].resolve('fresh');
  await flush();
  assert.deepEqual(app.data, ['fresh']);
  assert.deepEqual(app.failures, []);
  app.poller.stop();
});

test('stop prevents a pending visibility resume and ignores late failures', async () => {
  let fail;
  const app = fixture(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })
  );
  app.hidden(true);
  app.hidden(false);
  app.poller.stop();
  fail(new Error('late failure'));
  await flush();
  assert.deepEqual(app.failures, []);
  assert.equal(app.timers.size, 0);
});
