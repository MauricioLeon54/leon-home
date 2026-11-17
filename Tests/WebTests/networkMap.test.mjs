import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const directory = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/', import.meta.url);
const assetNames = new Set(['app.js', 'home.js', 'network-map.css', 'home.css']);
const policy = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'nonce-fixture' 'strict-dynamic'; connect-src 'self'; worker-src 'self'; manifest-src 'self'";

function snapshot() {
  const now = Date.now() / 1000;
  return {
    schemaVersion: 1,
    observedAt: now,
    freshness: 'current',
    freshSeconds: 660,
    actionToken: 'synthetic-test-token',
    devices: [
      {
        id: '192.168.1.2',
        address: '192.168.1.2',
        name: '<img src=x onerror=alert(1)>',
        presence: 'seen',
        lastSeen: now,
        canRename: true,
        canPause: true,
        paused: false,
        pauseSchedule: null,
        traffic: {
          connection: 'wifi',
          band: '2.4GHz',
          signalDbm: -55,
          downloadRouterMbps: 1,
          uploadRouterMbps: 0,
          history: [
            [1, 0],
            [null, null],
            [2, 1],
          ],
        },
      },
    ],
    routerTelemetry: {
      status: 'current',
      observedAt: now,
      controllablePorts: [1],
      ports: [
        { port: 1, enabled: true, link: 'down', wan: false },
        { port: 2, enabled: true, link: 'up', wan: true, speedMbps: 1000 },
      ],
      history: {
        samples: [
          [now - 15, 1, 0],
          [now, 2, 1],
        ],
      },
      wifi: { networks: [] },
    },
    internet: { availability: 100, samples: 1, current: { at: now, state: 'up', internetMs: 15, routerMs: 1 }, series: [[now, 15]], outages: [] },
  };
}

async function withPage(browserType, viewport, run) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage();
  const data = snapshot(),
    mutations = [],
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://leon.test/**', async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      mutations.push({ path, body: request.postDataJSON() });
      return route.fulfill({ json: { status: 'applied' } });
    }
    if (path === '/brand/symbol.png') {
      return route.fulfill({ contentType: 'image/png', body: await readFile(new URL('../../Sources/LeonLabs/Resources/Brand/symbol.png', import.meta.url)) });
    }
    if (path === '/network-map/data') return route.fulfill({ json: data, headers: { 'Cache-Control': 'no-store' } });
    if (path === '/network-map') {
      const body = (await readFile(new URL('network-map.html', directory), 'utf8')).replaceAll('__NONCE__', 'fixture');
      return route.fulfill({ contentType: 'text/html', body, headers: { 'Content-Security-Policy': policy } });
    }
    const name = path.slice('/network-map/assets/'.length);
    if (path.startsWith('/network-map/assets/') && assetNames.has(name)) {
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('web/dist/' + name, directory)) });
    }
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto('https://leon.test/network-map');
    await page.locator('button.node').waitFor();
    await run({ page, data, mutations });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
  }
}

for (const browserType of [chromium, webkit]) {
  for (const viewport of [
    { width: 1400, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${browserType.name()} modular map renders safely and keeps protected controls at ${viewport.width}px`, async () => {
      await withPage(browserType, viewport, async ({ page, mutations }) => {
        await page.locator('button.node').click();
        assert.equal(await page.locator('#title').textContent(), '<img src=x onerror=alert(1)>');
        assert.equal(await page.locator('#nodes img').count(), 0);
        assert.match(await page.locator('#details').innerText(), /1 Mbps/);
        assert.match(await page.locator('#details').innerText(), /0 Mbps/);
        await page.locator('#inspector.open').waitFor();
        await page.screenshot({ animations: 'disabled', path: `test-results/network-${browserType.name()}-${viewport.width}.png`, fullPage: true });
        const before = await page.locator('.canvas').getAttribute('style');
        if (await page.locator('#close-sheet').isVisible()) await page.locator('#close-sheet').click();
        await page.locator('#in').click();
        assert.notEqual(await page.locator('.canvas').getAttribute('style'), before);
        await page.locator('a[data-tab=traffic]').click();
        await page.locator('#view-traffic.active').waitFor();
        assert.equal(await page.locator('#device-list li').count(), 1);
        await page.locator('a[data-tab=ports]').click();
        await page.locator('#view-ports.active').waitFor();
        assert.equal(await page.getByRole('switch', { name: 'WAN activado' }).isDisabled(), true);
        await page.getByRole('switch', { name: 'Puerto 1 activado' }).click();
        await page.locator('#confirm[open]').waitFor();
        await page.locator('#confirm-cancel').click();
        assert.deepEqual(mutations, []);
        assert.equal(await page.locator('html').evaluate(element => element.scrollWidth <= element.ownerDocument.defaultView.innerWidth), true);
      });
    });
  }

  test(`${browserType.name()} locked router hides current rates without automatic mutation`, async () => {
    await withPage(browserType, { width: 1100, height: 850 }, async ({ page, data, mutations }) => {
      data.routerTelemetry.status = 'locked';
      await page.reload();
      await page.locator('#locked:visible').waitFor();
      await page.locator('button.node').click();
      assert.match(await page.locator('#details').innerText(), /Sin lectura actual/);
      assert.deepEqual(mutations, []);
    });
  });

  test(`${browserType.name()} malformed refresh keeps old inventory visibly stale and disables controls`, async () => {
    await withPage(browserType, { width: 1100, height: 850 }, async ({ page, data, mutations }) => {
      data.devices[0].id = 'invalid';
      await page.locator('html').evaluate(element => element.ownerDocument.dispatchEvent(new Event('visibilitychange')));
      await page.getByText('Sin conexión · datos anteriores', { exact: true }).waitFor();
      assert.equal(await page.locator('button.node').count(), 1);
      await page.locator('a[data-tab=ports]').click();
      assert.equal(await page.locator('#view-ports [role=switch]:not(:disabled)').count(), 0);
      assert.deepEqual(mutations, []);
    });
  });
}
