import assert from 'node:assert/strict';
import test from 'node:test';

import { artKind } from '../../.build/web-modules/deviceArt.js';
import { matches } from '../../.build/web-modules/map.js';
import { groupOf } from '../../.build/web-modules/mapLayout.js';

function device({ connection = 'wifi', band = '5GHz', name = 'Device', address = '192.168.1.9' } = {}) {
  return { id: address, address, name, kind: '', role: '', presence: 'seen', traffic: connection ? { connection, band, downloadRouterMbps: 0, uploadRouterMbps: 0, history: [] } : null };
}

test('branches follow the connection the router reports', () => {
  assert.deepEqual(
    [device({ connection: 'ethernet', band: null }), device({ band: '2.4GHz' }), device(), device({ band: 'DC' }), device({ connection: null }), device({ connection: 'other' })].map(groupOf),
    ['wired', 'slow', 'fast', 'wireless', 'unknown', 'unknown']
  );
});

test('search matches names and addresses, ignoring case and spaces', () => {
  const lamp = device({ name: 'Kitchen Lamp', address: '192.168.1.40' });
  assert.equal(matches(lamp, '  lamp '), true);
  assert.equal(matches(lamp, '1.40'), true);
  assert.equal(matches(lamp, 'tv'), false);
  assert.equal(matches(lamp, ''), true);
});

test('drawings follow the declared kind, never the name', () => {
  assert.equal(artKind({ kind: '', role: '', name: 'iPhone' }), 'device');
  assert.equal(artKind({ kind: 'Phone', role: '' }), 'phone');
  assert.equal(artKind({ kind: 'computer', role: '' }), 'laptop');
  assert.equal(artKind({ kind: 'tv', role: 'router' }), 'router');
});
