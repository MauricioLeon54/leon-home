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

function filtering(allowed = []) {
  const now = Math.floor(Date.now() / 1000);
  return {
    recentBlocked: [{ domain: 'ads.example.test', device: 'tv', at: now - 60, count: 3 }],
    allowed,
    groups: [{ name: 'TV', devices: ['Samsung TV'] }],
    lists: [
      { name: 'EasyList', entries: 51_631, state: 'ok', updatedAt: now - 3600, groups: ['Default'] },
      { name: 'Samsung trackers', entries: 201, state: 'cached', updatedAt: now - 3600, groups: ['TV'] },
    ],
    listsUpdatedAt: now - 3600,
  };
}

async function start(browserType, answer) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [],
    posts = [],
    state = { allowed: [] };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  await page.route('https://leon.test/**', async route => {
    const request = route.request(),
      { pathname } = new URL(request.url());
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/leon/v1/session') return json(session);
    if (pathname === '/leon/v1/dns') return json({ ...homeView(), filtering: filtering(state.allowed) });
    if (pathname === '/leon/v1/dns/allow' || pathname === '/leon/v1/dns/unallow') {
      posts.push({ path: pathname, token: request.headers()['x-leon-token'], body: request.postDataJSON() });
      const status = answer(pathname);
      if (status === 'applied') state.allowed = pathname.endsWith('/allow') ? [{ domain: request.postDataJSON().domain, source: 'panel', addedAt: null }] : [];
      return json({ status });
    }
    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
    }
    if (pathname.startsWith('/settings')) return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: shell });
    return route.fulfill({ status: 404 });
  });
  return {
    page,
    errors,
    posts,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} DNS page unblocks a recent domain and blocks it again after confirming`, async () => {
    const app = await start(browserType, () => 'applied');
    try {
      await app.page.goto('https://leon.test/settings/dns');
      await app.page.getByText('Samsung TV').waitFor();
      assert.equal(await app.page.getByText('1 need attention').count(), 1);
      await app.page.getByRole('button', { name: /ads\.example\.test/ }).click();
      await app.page.getByRole('button', { name: 'Unblock', exact: true }).last().click();
      await app.page.getByText('Allowed from LEÓN').waitFor();
      await app.page.getByRole('button', { name: /ads\.example\.test.*Block again/ }).click();
      await app.page.getByRole('button', { name: 'Block again', exact: true }).click();
      await app.page.getByText('No unblocked sites').waitFor();
      assert.deepEqual(app.posts, [
        { path: '/leon/v1/dns/allow', token: 'token-fixture', body: { domain: 'ads.example.test' } },
        { path: '/leon/v1/dns/unallow', token: 'token-fixture', body: { domain: 'ads.example.test' } },
      ]);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} a pasted address unblocks only its host and an unconfirmed change says so`, async () => {
    const app = await start(browserType, () => 'unverified');
    try {
      await app.page.goto('https://leon.test/settings/dns');
      await app.page.getByLabel('Site to unblock').fill(' https://Shop.Example.test:443/cart?x=1 ');
      await app.page.getByLabel('Site to unblock').press('Enter');
      await app.page.getByRole('button', { name: 'Unblock', exact: true }).last().click();
      await app.page.locator('.toast.is-unverified').waitFor();
      assert.deepEqual(
        app.posts.map(post => post.body),
        [{ domain: 'shop.example.test' }]
      );
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });
}
