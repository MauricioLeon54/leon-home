import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const directory = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/', import.meta.url);
const policy = "default-src 'none'; style-src 'self'; script-src 'nonce-fixture' 'strict-dynamic'; connect-src 'self'; worker-src 'self'; img-src 'self' data:";
const shell = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/leon.css"></head><body><div id="app" class="app"></div><script type="module" nonce="fixture" src="/assets/leon.js"></script></body></html>`;
const session = { login: 'owner@example.test', node: 'leon-test', actionToken: 'token-fixture', features: { automation: false, storage: true, updates: false } };

function snapshot(overrides = {}) {
  const now = Date.now() / 1000;
  return {
    schemaVersion: 1,
    observedAt: now,
    freshness: 'current',
    freshSeconds: 660,
    actionToken: '',
    devices: [
      {
        id: '192.168.1.1',
        address: '192.168.1.1',
        name: 'Home router',
        kind: 'router',
        role: 'router',
        presence: 'seen',
        lastSeen: now,
        canRename: false,
        canPause: false,
        canWake: false,
        paused: false,
        pauseSchedule: null,
        traffic: null,
      },
      {
        id: '192.168.1.20',
        address: '192.168.1.20',
        name: '<img src=x onerror=alert(1)>',
        kind: 'computer',
        role: '',
        presence: 'seen',
        lastSeen: now,
        canRename: true,
        canPause: true,
        canWake: true,
        paused: false,
        pauseSchedule: null,
        traffic: {
          address: '192.168.1.20',
          connection: 'wifi',
          band: '5GHz',
          signalDbm: -55,
          downloadRouterMbps: 3,
          uploadRouterMbps: 1,
          port: null,
          history: [
            [1, 0],
            [2, 1],
          ],
        },
      },
      {
        id: '192.168.1.30',
        address: '192.168.1.30',
        name: 'Desk PC',
        kind: 'computer',
        role: '',
        presence: 'notSeen',
        lastSeen: now - 5000,
        canRename: true,
        canPause: false,
        canWake: false,
        paused: false,
        pauseSchedule: null,
        traffic: { address: '192.168.1.30', connection: 'ethernet', band: null, signalDbm: null, downloadRouterMbps: 0, uploadRouterMbps: 0, port: 1, history: [] },
      },
    ],
    routerTelemetry: {
      status: 'current',
      observedAt: now,
      controllablePorts: [1],
      ports: [
        { port: 1, enabled: true, link: 'up', wan: false, speedMbps: 1000, duplex: 'full' },
        { port: 2, enabled: true, link: 'up', wan: true, speedMbps: 1000, duplex: 'full' },
      ],
      history: {
        samples: [
          [now - 15, 1, 0],
          [now, 2, 1],
        ],
      },
      wifi: { networks: [] },
    },
    internet: {
      availability: 100,
      samples: 1,
      current: { at: now, state: 'up', internetMs: 15, routerMs: 1 },
      series: [[now, 15]],
      outages: [],
      modem: { at: now, lossPercent: 0, averageMs: 1.37 },
      modemLine: {
        at: now - 60,
        isRegistered: true,
        rxDbm: -21.19,
        txDbm: 2.29,
        temperatureCelsius: 44,
        cpuPercent: 11,
        memoryPercent: 34,
        ports: [
          { port: 1, isUp: true, speedMbps: 2500 },
          { port: 2, isUp: false, speedMbps: null },
        ],
        rxHistory: [-21.4, -21.2],
      },
      speedTests: [
        { at: now - 86_400, downMbps: 290, upMbps: 200 },
        { at: now - 60, downMbps: 283.4, upMbps: null },
      ],
    },
    ...overrides,
  };
}

async function start(browserType, { data = () => snapshot(), answer = () => ({ status: 'applied' }) } = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [],
    posts = [],
    state = { responses: 0, data, token: session.actionToken };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(() => {
    globalThis.pollTicks = 0;
    const interval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) =>
      interval(() => {
        globalThis.pollTicks++;
        callback(...args);
      }, delay);
    globalThis.setHidden = hidden => {
      Object.defineProperty(globalThis.document, 'hidden', { configurable: true, value: hidden });
      Object.defineProperty(globalThis.document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await page.clock.install();
  await page.route('https://leon.test/**', async route => {
    const request = route.request(),
      { pathname } = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/leon/v1/session') return json({ ...session, actionToken: state.token });
    if (pathname === '/leon/v1/network' && request.method() === 'GET') {
      const reply = state.data(++state.responses);
      return reply === null ? route.fulfill({ status: 503, body: 'Unavailable' }) : json(reply);
    }
    if (pathname.startsWith('/leon/v1/network/')) {
      posts.push({ path: pathname, token: request.headers()['x-leon-token'], body: request.postDataJSON() });
      if (request.headers()['x-leon-token'] !== state.token) return json({ status: 'forbidden' }, 403);
      return json(answer(pathname));
    }
    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
    }
    if (pathname === '/' || pathname.startsWith('/network') || pathname === '/network-map' || pathname.startsWith('/settings'))
      return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: shell });
    return route.fulfill({ status: 404 });
  });
  return {
    page,
    requests,
    errors,
    posts,
    state,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
const url = page => new URL(page.url());

function appTest(browserType, name, verify, options) {
  test(name, async () => {
    const app = await start(browserType, options);
    try {
      await verify(app);
    } finally {
      await app.close();
    }
  });
}

for (const browserType of [chromium, webkit]) {
  appTest(browserType, `${browserType.name()} map renders device nodes safely and filters by search`, async app => {
    await app.page.goto('https://leon.test/network');
    await app.page.locator('a.node').first().waitFor();
    assert.equal(await app.page.locator('.tiles a.node').count(), 2);
    assert.equal(await app.page.locator('.net-view img').count(), 0);
    assert.equal(await app.page.locator('.tiles a.node', { hasText: '<img src=x onerror=alert(1)>' }).count(), 1);
    assert.equal(await app.page.locator('.nav-back').isHidden(), true);
    await app.page.getByLabel('Find a device').fill('nothing here');
    assert.equal(await app.page.locator('.tiles a.node:visible').count(), 0);
    await app.page.getByText('No device matches “nothing here”.').waitFor();
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} segmented control switches views and updates the URL`, async app => {
    await app.page.goto('https://leon.test/network');
    await app.page.getByRole('radio', { name: 'Traffic' }).click();
    await app.page.getByText('Right now').waitFor();
    assert.equal(url(app.page).search, '?view=traffic');
    assert.equal(await app.page.locator('.traffic-row').count(), 2);
    const modem = app.page.locator('.group', { has: app.page.getByRole('heading', { name: 'Modem', exact: true }) });
    assert.equal(await modem.locator('.reading', { hasText: 'Response' }).locator('.reading-value').textContent(), '1.4 ms');
    const fiber = app.page.locator('.group', { has: app.page.getByRole('heading', { name: 'Fiber', exact: true }) });
    assert.equal(await fiber.locator('.reading', { hasText: 'Fiber signal' }).locator('.reading-value').textContent(), '-21.2 dBm');
    assert.equal(await fiber.locator('.row', { hasText: 'Modem port 1' }).locator('.row-value').textContent(), '2.5 Gbps');
    assert.equal(await fiber.getByText('The fiber signal is normal.').count(), 1);
    const speed = app.page.locator('.group', { hasText: 'Speed test' });
    assert.equal(await speed.locator('.reading', { hasText: 'Download' }).locator('.reading-value').textContent(), '283 Mbps');
    assert.equal(await speed.locator('.reading', { hasText: 'Upload' }).locator('.reading-value').textContent(), '—');
    assert.equal(await speed.getByText('Part of the last test could not finish.').count(), 1);
    await app.page.getByRole('radio', { name: 'Ports' }).click();
    await app.page.getByText('Ethernet ports').waitFor();
    assert.equal(url(app.page).search, '?view=ports');
    await app.page.getByRole('radio', { name: 'Map' }).click();
    await app.page.locator('a.node').first().waitFor();
    assert.equal(url(app.page).pathname + url(app.page).search, '/network');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} legacy network-map#ports lands on Ports`, async app => {
    await app.page.goto('https://leon.test/network-map#ports');
    await app.page.getByText('Ethernet ports').waitFor();
    assert.equal(url(app.page).pathname + url(app.page).search, '/network?view=ports');
    assert.equal(await app.page.getByRole('radio', { name: 'Ports' }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} a device opens its own page with a back button`, async app => {
    await app.page.goto('https://leon.test/network');
    await app.page.locator('.tiles a.node', { hasText: 'Desk PC' }).click();
    await app.page.getByText('Not seen in the latest scan.').waitFor();
    assert.equal(url(app.page).pathname, '/network/device/192.168.1.30');
    assert.equal(await app.page.locator('.large-title').textContent(), 'Desk PC');
    assert.equal(await app.page.locator('.nav-back').textContent(), 'Network');
    await app.page.locator('.nav-back').click();
    await app.page.locator('.tiles a.node').first().waitFor();
    assert.equal(url(app.page).pathname, '/network');
    assert.deepEqual(app.errors, []);
  });

  appTest(
    browserType,
    `${browserType.name()} renaming a device posts the name with the token`,
    async app => {
      await app.page.goto('https://leon.test/network/device/192.168.1.30');
      await app.page.getByLabel('Device name').fill('Office PC');
      await app.page.getByRole('button', { name: 'Rename' }).click();
      await app.page.getByText(/Saved\. The Pi-hole name updates/).waitFor();
      assert.deepEqual(app.posts, [{ path: '/leon/v1/network/name', token: 'token-fixture', body: { address: '192.168.1.30', name: 'Office PC' } }]);
      assert.deepEqual(app.errors, []);
    },
    { answer: () => ({ status: 'saved' }) }
  );

  appTest(
    browserType,
    `${browserType.name()} the pause switch reverts when the router rejects the change`,
    async app => {
      await app.page.goto('https://leon.test/network/device/192.168.1.20');
      const toggle = () => app.page.getByRole('switch', { name: 'Network access' });
      assert.equal(await toggle().getAttribute('aria-checked'), 'true');
      await toggle().click();
      await app.page.locator('.sheet').getByRole('button', { name: 'Pause' }).click();
      await app.page.getByText('The router did not accept the change.').waitFor();
      assert.equal(await toggle().getAttribute('aria-checked'), 'true');
      assert.deepEqual(app.posts, [{ path: '/leon/v1/network/pause', token: 'token-fixture', body: { address: '192.168.1.20', paused: true } }]);
      assert.deepEqual(app.errors, []);
    },
    { answer: () => ({ status: 'rejected' }) }
  );

  appTest(
    browserType,
    `${browserType.name()} Wake appears only when the device can be woken and never claims it woke`,
    async app => {
      await app.page.goto('https://leon.test/network/device/192.168.1.30');
      await app.page.getByText('Desk PC').first().waitFor();
      assert.equal(await app.page.getByRole('button', { name: /^Wake/ }).count(), 0);
      await app.page.goto('https://leon.test/network/device/192.168.1.20');
      await app.page.getByRole('button', { name: /^Wake/ }).click();
      await app.page.locator('.toast.is-applied', { hasText: 'Wake signal sent.' }).waitFor();
      assert.deepEqual(app.posts, [{ path: '/leon/v1/network/wake', token: 'token-fixture', body: { address: '192.168.1.20' } }]);
      assert.deepEqual(app.errors, []);
    },
    { answer: () => ({ status: 'sent', message: 'Wake signal sent.' }) }
  );

  appTest(browserType, `${browserType.name()} an unknown device shows an empty state with a way back`, async app => {
    await app.page.goto('https://leon.test/network/device/192.168.1.99');
    await app.page.getByText('This device is not in the latest scan').waitFor();
    await app.page.getByRole('link', { name: /Back to Network/ }).click();
    await app.page.locator('.tiles a.node').first().waitFor();
    assert.equal(url(app.page).pathname, '/network');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} port switches confirm before disabling and keep the WAN protected`, async app => {
    await app.page.goto('https://leon.test/network?view=ports');
    await app.page.getByRole('switch', { name: 'Port 1 enabled' }).waitFor();
    assert.equal(await app.page.getByRole('switch', { name: 'WAN enabled' }).isDisabled(), true);
    await app.page.getByRole('switch', { name: 'Port 1 enabled' }).click();
    await app.page.locator('.sheet').getByRole('button', { name: 'Cancel' }).click();
    await app.page.locator('.sheet').waitFor({ state: 'detached' });
    assert.deepEqual(app.posts, []);
    await app.page.getByRole('switch', { name: 'Port 1 enabled' }).click();
    await app.page.locator('.sheet').getByRole('button', { name: 'Disable' }).click();
    await app.page.locator('.sheet').waitFor({ state: 'detached' });
    assert.deepEqual(app.posts, [{ path: '/leon/v1/network/port', token: 'token-fixture', body: { port: 1, enabled: false } }]);
    assert.deepEqual(app.errors, []);
  });

  test(`${browserType.name()} an action refused after the panel restarted is retried once with a new token`, async () => {
    const locked = snapshot({ routerTelemetry: { ...snapshot().routerTelemetry, status: 'locked', ports: null } });
    const app = await start(browserType, { data: () => locked, answer: () => ({ status: 'current' }) });
    try {
      await app.page.goto('https://leon.test/network');
      await app.page.locator('.unlock').waitFor();
      app.state.token = 'token-after-restart';
      await app.page.getByLabel('LEÓN vault passphrase', { exact: true }).fill('correct horse battery');
      await app.page.getByRole('button', { name: 'Unlock' }).click();
      await app.page.getByText('Ready. The router session is active.').waitFor();
      assert.deepEqual(
        app.posts.map(post => post.token),
        ['token-fixture', 'token-after-restart']
      );
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  appTest(
    browserType,
    `${browserType.name()} a locked router shows the unlock form and clears the passphrase after one attempt`,
    async app => {
      await app.page.goto('https://leon.test/network');
      await app.page.getByText('Router readings are locked').waitFor();
      assert.equal(await app.page.getByText('Router locked').count(), 1);
      await app.page.getByLabel('LEÓN vault passphrase').fill('correct horse battery');
      await app.page.getByRole('button', { name: 'Unlock' }).click();
      await app.page.getByText(/Incorrect passphrase/).waitFor();
      assert.deepEqual(app.posts, [{ path: '/leon/v1/network/unlock', token: 'token-fixture', body: { phrase: 'correct horse battery' } }]);
      assert.equal(await app.page.getByLabel('LEÓN vault passphrase').inputValue(), '');
      assert.deepEqual(app.errors, []);
    },
    { data: () => snapshot({ routerTelemetry: { ...snapshot().routerTelemetry, status: 'locked', ports: null } }), answer: () => ({ status: 'unlockFailed' }) }
  );

  appTest(
    browserType,
    `${browserType.name()} an edition without phrases asks once for the router password`,
    async app => {
      await app.page.goto('https://leon.test/network');
      await app.page.getByText('Connect your router').waitFor();
      assert.equal(await app.page.locator('.unlock input[type=password]').count(), 1);
      await app.page.getByLabel('Router administrator password').fill('router-secret');
      await app.page.getByRole('button', { name: 'Connect router' }).click();
      await app.page.getByText(/The router did not accept that password/).waitFor();
      assert.deepEqual(app.posts, [{ path: '/leon/v1/network/unlock', token: 'token-fixture', body: { password: 'router-secret' } }]);
      assert.equal(await app.page.getByLabel('Router administrator password').inputValue(), '');
      assert.deepEqual(app.errors, []);
    },
    {
      data: () => snapshot({ routerTelemetry: { ...snapshot().routerTelemetry, status: 'locked', unlockBy: 'password', ports: null } }),
      answer: () => ({ status: 'unlockFailed' }),
    }
  );

  appTest(
    browserType,
    `${browserType.name()} a Pi that reconnects by itself asks for nothing`,
    async app => {
      await app.page.goto('https://leon.test/network');
      await app.page.getByText('You do not need to do anything.').waitFor();
      assert.equal(await app.page.getByLabel('Router administrator password').isVisible(), false);
      await app.page.getByText('The router or its password changed').click();
      assert.equal(await app.page.getByLabel('Router administrator password').isVisible(), true);
      assert.deepEqual(app.errors, []);
    },
    { data: () => snapshot({ routerTelemetry: { ...snapshot().routerTelemetry, status: 'locked', unlockBy: 'password', isReconnecting: true, ports: null } }) }
  );

  appTest(
    browserType,
    `${browserType.name()} failed refreshes keep the map and show the stale banner after 90 s`,
    async app => {
      await app.page.goto('https://leon.test/network');
      await app.page.locator('a.node').first().waitFor();
      await app.page.clock.runFor(15_001);
      await app.page.getByText('Offline · previous readings').waitFor();
      assert.equal(await app.page.locator('.banner').isHidden(), true);
      for (let attempt = 0; attempt < 7; attempt++) await app.page.clock.runFor(15_001);
      await app.page.locator('.banner:not([hidden])').waitFor();
      assert.equal(await app.page.locator('.tiles a.node').count(), 2);
      assert.deepEqual(app.errors, []);
    },
    { data: count => (count === 1 ? snapshot() : null) }
  );

  appTest(
    browserType,
    `${browserType.name()} malformed network JSON shows an error state`,
    async app => {
      await app.page.goto('https://leon.test/network');
      await app.page.getByText('LEÓN Home is not answering').waitFor();
      assert.equal(await app.page.locator('.tabbar').isVisible(), true);
      assert.deepEqual(app.errors, []);
    },
    { data: () => ({ schemaVersion: 2 }) }
  );
}

for (const browserType of [chromium, webkit]) {
  appTest(browserType, `${browserType.name()} measures network requests and hidden work`, async app => {
    await app.page.goto('https://leon.test/network');
    await app.page.locator('a.node').first().waitFor();
    const initial = [...app.requests];
    await app.page.clock.runFor(15001);
    await app.page.locator('a.node').first().waitFor();
    const refresh = app.requests.slice(initial.length);
    await app.page.evaluate(() => globalThis.setHidden(true));
    const before = app.requests.length;
    const ticks = await app.page.evaluate(() => globalThis.pollTicks);
    await app.page.clock.runFor(120_001);
    const hiddenTicks = (await app.page.evaluate(() => globalThis.pollTicks)) - ticks;
    console.log(JSON.stringify({ measurement: 'network', browser: browserType.name(), initial, refresh, hiddenRequests: app.requests.length - before, hiddenTicks }));
    assert.equal(app.requests.length - before, 0);
    assert.equal(hiddenTicks, 0);
    const resumed = app.page.waitForResponse(response => response.url().endsWith('/leon/v1/network'));
    await app.page.evaluate(() => globalThis.setHidden(false));
    await resumed;
    assert.deepEqual(app.errors, []);
  });
}

for (const browserType of [chromium, webkit]) {
  for (const view of ['map', 'traffic']) {
    test(`${browserType.name()} ${view} refresh retains attached device nodes and keyboard focus`, async () => {
      const app = await start(browserType);
      try {
        await app.page.goto(`https://leon.test/network?view=${view}`);
        const selector = view === 'map' ? '.tiles a.node' : '.traffic-row';
        await app.page.locator(selector).first().waitFor();
        await app.page.locator(selector).first().focus();
        const before = await app.page.locator(selector).first().elementHandle();
        const refreshed = app.page.waitForResponse(response => response.url().endsWith('/leon/v1/network'));
        await app.page.clock.runFor(15_001);
        await refreshed;
        assert.equal(await before.evaluate(element => element.isConnected && element === globalThis.document.activeElement), true);
        assert.deepEqual(app.errors, []);
      } finally {
        await app.close();
      }
    });
  }
}
