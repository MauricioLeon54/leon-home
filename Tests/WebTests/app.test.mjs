import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const directory = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/', import.meta.url);
const policy = "default-src 'none'; style-src 'self'; script-src 'nonce-fixture' 'strict-dynamic'; connect-src 'self'; worker-src 'self'; img-src 'self' data:";
const shell = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/leon.css"></head><body><div id="app" class="app"></div><script type="module" nonce="fixture" src="/assets/leon.js"></script></body></html>`;
const session = { login: 'owner@example.test', node: 'leon-test', actionToken: 'token-fixture', features: { automation: false, storage: true } };

function homeView(overrides = {}) {
  return {
    observedAt: Math.floor(Date.now() / 1000) - 5,
    status: { issues: [], uptimeSeconds: 90_000, servicesRunning: 4, servicesTotal: 4, temperatureCelsius: 48 },
    internet: { state: 'connected', internetMs: 12.4, routerMs: 1.2, routerDnsMs: null, encryptedDnsMs: 31 },
    pihole: {
      blocking: 'enabled',
      pausedSecondsLeft: null,
      percentBlocked: 18.4,
      queries: 12_345,
      blocked: 2271,
      domainsOnBlocklists: 100_000,
      activeClients: 5,
      hours: [{ hourStart: Math.floor(Date.now() / 3_600_000) * 3600, total: 120, blocked: 20 }],
      topBlocked: [{ name: 'ads.example.test', count: 99 }],
      topClients: [{ name: 'phone.example.test', count: 400 }],
    },
    pi: {
      temperatureCelsius: 48,
      cpuPercent: 7,
      load1: 0.12,
      memoryAvailableBytes: 2 ** 30,
      storageFreeBytes: 20 * 2 ** 30,
      power: { label: 'OK', needsAttention: false },
      rebootRequired: false,
      temperatureHistory: [],
    },
    services: [{ name: 'pihole-FTL', label: 'Pi-hole', running: true, state: 'active' }],
    network: {
      online: 1,
      devices: [{ name: 'Laptop', address: '192.168.1.20', detail: '192.168.1.20', isNew: true, isUnnamed: false, isAuto: false, presence: [true, false, true] }],
      registeredNames: 1,
      moves: [],
    },
    tailscale: [],
    backups: { latest: null, isFresh: false, repositories: [] },
    tablet: null,
    links: { piholeAdmin: '/admin/', routerSettings: null },
    ...overrides,
  };
}

async function start(browserType, { home, onPause } = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  const state = { homeResponses: 0, home: home ?? (() => ({ status: 200, body: homeView() })) };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  await page.clock.install();
  await page.route('https://leon.test/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/leon/v1/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(session) });
    if (pathname === '/leon/v1/home') {
      const reply = state.home(++state.homeResponses);
      return route.fulfill({ status: reply.status, contentType: 'application/json', body: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) });
    }
    if (pathname === '/leon/v1/dns/pause') {
      onPause?.(request);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'applied' }) });
    }
    if (pathname === '/assets/leon.js' || pathname === '/assets/leon.css') {
      const name = pathname.slice('/assets/'.length);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
    }
    if (['/', '/settings', '/settings/about'].includes(pathname)) return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: shell });
    return route.fulfill({ status: 404 });
  });
  return {
    page,
    errors,
    state,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} shell boots with Home readings and em dashes for unknown values`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/');
      await app.page.getByText('Everything is running').waitFor();
      assert.equal(await app.page.locator('.large-title').textContent(), 'Home');
      const internet = app.page.locator('.reading', { hasText: 'Internet' }).first();
      assert.match(await internet.textContent(), /12 ms/);
      const routerDns = app.page.locator('.reading', { hasText: 'Router DNS' });
      assert.equal(await routerDns.locator('.reading-value').textContent(), '—');
      assert.equal(await app.page.locator('.tabbar a[aria-current="page"]').textContent(), 'Home');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} Settings pushes About with a labelled back button and the active tab pops to root`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/settings');
      await app.page.getByRole('link', { name: 'About' }).click();
      await app.page.getByText('Private to your Tailscale account.').waitFor();
      assert.equal(new URL(app.page.url()).pathname, '/settings/about');
      assert.equal(await app.page.locator('.nav-back').textContent(), 'Settings');
      await app.page.locator('.nav-back').click();
      await app.page.getByRole('link', { name: 'Router & ports' }).waitFor();
      assert.equal(new URL(app.page.url()).pathname, '/settings');
      assert.equal(await app.page.locator('.nav-back').isHidden(), true);
      await app.page.getByRole('link', { name: 'About' }).click();
      await app.page.getByText('owner@example.test').waitFor();
      await app.page.locator('.tabbar a[data-tab="settings"]').click();
      await app.page.getByRole('link', { name: 'Router & ports' }).waitFor();
      assert.equal(new URL(app.page.url()).pathname, '/settings');
      assert.equal(await app.page.getByRole('link', { name: 'Automation' }).count(), 0);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} a failed refresh keeps earlier readings and shows the stale banner after 90 s`, async () => {
    const app = await start(browserType, { home: count => (count === 1 ? { status: 200, body: homeView() } : { status: 503, body: 'Unavailable' }) });
    try {
      await app.page.goto('https://leon.test/');
      await app.page.getByText('Everything is running').waitFor();
      await app.page.clock.runFor(30_001);
      await app.page.clock.runFor(30_001);
      assert.equal(await app.page.locator('.banner').isHidden(), true);
      await app.page.clock.runFor(30_001);
      await app.page.clock.runFor(30_001);
      await app.page.locator('.banner:not([hidden])').waitFor();
      assert.match(await app.page.locator('.banner').textContent(), /not answering/);
      assert.match(await app.page.locator('.reading', { hasText: 'Internet' }).first().textContent(), /12 ms/);
      assert.match(await app.page.locator('.reading', { hasText: 'Internet' }).first().textContent(), /Earlier/);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} pausing Pi-hole posts the token and confirms with a toast`, async () => {
    let posted;
    const app = await start(browserType, { onPause: request => (posted = { token: request.headers()['x-leon-token'], body: request.postDataJSON() }) });
    try {
      await app.page.goto('https://leon.test/');
      await app.page.getByRole('button', { name: 'Pause 5 min' }).click();
      await app.page.locator('.toast.is-applied', { hasText: 'Blocking paused for 5 min' }).waitFor();
      assert.deepEqual(posted, { token: 'token-fixture', body: { seconds: 300 } });
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} malformed Home JSON leaves the shell running`, async () => {
    const app = await start(browserType, { home: () => ({ status: 200, body: { status: 'not a view' } }) });
    try {
      await app.page.goto('https://leon.test/');
      await app.page.getByText('LEÓN Home is not answering').first().waitFor();
      assert.equal(await app.page.locator('.tabbar').isVisible(), true);
      assert.equal(await app.page.locator('.large-title').textContent(), 'Home');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });
}
