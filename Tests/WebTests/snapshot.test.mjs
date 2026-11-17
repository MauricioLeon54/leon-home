import assert from 'node:assert/strict';
import test from 'node:test';

import { readJson } from '../../.build/web-modules/api.js';
import { parseSchedule, parseSnapshot } from '../../.build/web-modules/snapshot.js';

const NOW = 1_800_000_000;
function fixture() {
  return {
    schemaVersion: 1,
    observedAt: NOW,
    freshness: 'current',
    freshSeconds: 660,
    actionToken: 'synthetic-token',
    devices: [
      {
        id: '192.168.1.2',
        address: '192.168.1.2',
        name: 'Synthetic device',
        presence: 'seen',
        lastSeen: NOW,
        traffic: { address: '192.168.1.2', connection: 'wifi', downloadRouterMbps: 0, uploadRouterMbps: null, history: [[0, null]] },
      },
    ],
    routerTelemetry: {
      status: 'current',
      observedAt: NOW,
      ports: [{ port: 1, enabled: true, wan: false, link: 'up', speedMbps: 1000 }],
      controllablePorts: [1],
      history: { samples: [[NOW, 0, null]] },
    },
    internet: { samples: 1, availability: 100, current: { at: NOW, state: 'up', internetMs: 15, routerMs: 1 }, series: [[NOW, 15, 100]], outages: [] },
  };
}

test('snapshot accepts actual server three-column health history and preserves real zero rates', () => {
  const result = parseSnapshot(fixture(), NOW);
  assert.deepEqual(result.internet.series, [[NOW, 15]]);
  assert.equal(result.devices[0].traffic.downloadRouterMbps, 0);
  assert.equal(result.devices[0].traffic.uploadRouterMbps, null);
});
test('unknown metadata and secret fields never enter the presentation model', () => {
  const value = fixture();
  value.password = 'secret-value';
  value.devices[0].hardwareAddress = 'private-value';
  value.routerTelemetry.cookie = 'session-value';
  const result = JSON.stringify(parseSnapshot(value, NOW));
  for (const secret of ['secret-value', 'private-value', 'session-value']) assert.equal(result.includes(secret), false);
});
test('malformed identities, duplicates and oversized arrays are rejected before rendering', () => {
  for (const mutate of [
    value => {
      value.schemaVersion = 2;
    },
    value => {
      value.devices[0].id = '8.8.8.8';
    },
    value => {
      value.devices[0].address = 'not-an-ip';
    },
    value => {
      value.devices.push({ ...value.devices[0] });
    },
    value => {
      value.devices = Array.from({ length: 65 }, () => ({ ...value.devices[0] }));
    },
    value => {
      value.routerTelemetry.ports.push({ ...value.routerTelemetry.ports[0] });
    },
    value => {
      value.routerTelemetry.ports[0].enabled = 'true';
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => parseSnapshot(value, NOW));
  }
});
test('invalid dates and metrics remain unavailable instead of turning into a current zero', () => {
  const value = fixture();
  value.observedAt = NOW + 1000;
  value.devices[0].traffic.downloadRouterMbps = -1;
  value.devices[0].traffic.uploadRouterMbps = Infinity;
  const result = parseSnapshot(value, NOW);
  assert.equal(result.observedAt, null);
  assert.equal(result.devices[0].traffic.downloadRouterMbps, null);
  assert.equal(result.devices[0].traffic.uploadRouterMbps, null);
});
test('Unicode name bounds match server code points rather than UTF-16 code units', () => {
  const value = fixture();
  value.devices[0].name = '🦁'.repeat(100);
  assert.equal(parseSnapshot(value, NOW).devices[0].name, value.devices[0].name);
  value.devices[0].name += '🦁';
  assert.throws(() => parseSnapshot(value, NOW));
  value.devices[0].name = 'invalid\u0007name';
  assert.throws(() => parseSnapshot(value, NOW));
});
test('weekly schedules preserve overnight windows and reject ambiguous or malformed inputs', () => {
  assert.deepEqual(parseSchedule({ days: [0, 6], start: '22:30', end: '07:00' }), { days: [0, 6], start: '22:30', end: '07:00' });
  for (const value of [
    { days: [7], start: '22:00', end: '07:00' },
    { days: [0, 0], start: '22:00', end: '07:00' },
    { days: [], start: '22:00', end: '07:00' },
    { days: [0], start: '25:00', end: '07:00' },
    { days: [0], start: '07:00', end: '07:00' },
  ])
    assert.throws(() => parseSchedule(value));
});
test('unknown health states cannot be presented as a home outage', () => {
  const value = fixture();
  value.internet.current.state = 'unexpected';
  assert.throws(() => parseSnapshot(value, NOW));
});
test('response readers reject oversized streams and invalid JSON', async () => {
  await assert.rejects(readJson(new Response('x'.repeat(2000)), 1024), /limit/);
  await assert.rejects(readJson(new Response('{invalid}')));
  assert.deepEqual(await readJson(new Response('{"ok":true}')), { ok: true });
});
