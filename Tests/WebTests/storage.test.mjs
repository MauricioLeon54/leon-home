import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const directory = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/', import.meta.url);
const policy = "default-src 'none'; style-src 'self'; script-src 'nonce-fixture' 'strict-dynamic'; connect-src 'self'; worker-src 'self'; img-src 'self' data:";
const shell = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/leon.css"></head><body><div id="app" class="app"></div><script type="module" nonce="fixture" src="/assets/leon.js"></script></body></html>`;
const session = { login: 'owner@example.test', node: 'leon-test', actionToken: 'token-fixture', features: { automation: true, storage: true, updates: false } };
const GB = 2 ** 30;

function storageView(overrides = {}) {
  return {
    drive: { name: 'Family drive', isMounted: true, totalBytes: 1024 * GB, freeBytes: 400 * GB, label: 'FAMILY', filesystem: 'exfat', isReadOnly: false, openUrl: 'smb://100.64.0.7/Family' },
    peers: [{ name: 'Grandma drive', url: 'smb://100.64.0.9/Family' }],
    connections: [
      { platform: 'Mac at home', address: 'smb://leon.local/Family', note: 'Finder → Go → Connect' },
      { platform: 'Anywhere with Tailscale', address: 'smb://100.64.0.7/Family', note: 'iPhone Files → Connect to Server' },
    ],
    isSharingSetUp: true,
    accounts: [{ drive: 'Family drive', user: 'family_nas', canWrite: true }],
    tvServerName: 'LEÓN TV',
    folders: [{ name: 'Family', path: '/srv/storage/Family', status: 'Folder present', tone: 'good' }],
    usbDrives: { isAvailable: true, volumes: [{ name: 'Backup disk', detail: '1.0 TB · exfat', isMounted: true }] },
    ...overrides,
  };
}
const file = (name, path) => ({ name, path, isDirectory: false, detail: '4.0 MB · 2026-11-20', sizeBytes: 4_000_000, modifiedAt: 1_800_000_000 });
const folder = (name, path) => ({ name, path, isDirectory: true, detail: '2026-11-20', sizeBytes: null, modifiedAt: 1_800_000_000 });

const trees = {
  '': { title: 'Drive', entries: [folder('Movies', 'Movies'), file('notes.pdf', 'notes.pdf')] },
  'Movies': {
    title: 'Movies',
    entries: [...Array.from({ length: 40 }, (_, index) => file(`film-${index}.mp4`, `Movies/film-${index}.mp4`)), file('A b&c.mp4', 'Movies/A b&c.mp4'), folder('Action', 'Movies/Action')],
  },
  'Movies/Action': { title: 'Action', entries: [file('chase.mkv', 'Movies/Action/chase.mkv')] },
};
function filesView(path, query = '') {
  const tree = trees[path];
  if (!tree) return null;
  if (query)
    return { path, query, title: 'Search results', meta: 'Partial results; refine the search', entries: [file('match.mkv', 'Movies/match.mkv')].map(entry => ({ ...entry, detail: 'Movies' })) };
  return { path, query: '', title: tree.title, meta: '', entries: tree.entries };
}

function automationView(failuresOnly) {
  return {
    isReady: true,
    isConnected: true,
    editorUrl: 'https://leon-home.tail1234.ts.net/',
    hasStoredKey: true,
    workflows: [
      { id: 'wf_1', name: 'Nightly backup', state: 'Published', isActive: true },
      { id: 'wf_2', name: 'Draft idea', state: 'Draft', isActive: false },
    ],
    executions: failuresOnly
      ? [{ workflowName: 'Nightly backup', label: 'Failed', tone: 'warn', startedAt: '2026-11-20T14:03:05.000Z' }]
      : [
          { workflowName: 'Nightly backup', label: 'Succeeded', tone: 'good', startedAt: '2026-11-21T02:00:00.000Z' },
          { workflowName: 'Nightly backup', label: 'Failed', tone: 'warn', startedAt: '2026-11-20T14:03:05.000Z' },
        ],
    failuresOnly,
  };
}

function passwordReply(handlers) {
  return handlers.password ? handlers.password() : [{ status: 'shown', message: '', password: 'synthetic pass' }];
}
function settingsReply(handlers, count) {
  return handlers.answer ? handlers.answer(count) : { status: 'saved', message: 'Connection saved' };
}

async function start(browserType, handlers = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [],
    requests = [],
    posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  await page.addInitScript(() => {
    globalThis.copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => void globalThis.copied.push(text) }, configurable: true });
  });
  await page.clock.install();
  await page.route('https://leon.test/**', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      { pathname } = url;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (pathname === '/leon/v1/session') return json(session);
    if (pathname.startsWith('/leon/v1/')) requests.push(pathname + url.search);
    if (pathname === '/leon/v1/storage') return json(handlers.storage ? handlers.storage() : storageView());
    if (pathname === '/leon/v1/storage/files') {
      const view = filesView(url.searchParams.get('path') ?? '', url.searchParams.get('q') ?? '');
      return view ? json(view) : json({ status: 'unavailable' }, 404);
    }
    if (pathname === '/leon/v1/automation') return json(automationView(url.searchParams.get('status') === 'failed'));
    if (pathname === '/leon/v1/storage/password') {
      posts.push({ token: request.headers()['x-leon-token'], body: request.postDataJSON() });
      return json(...passwordReply(handlers));
    }
    if (pathname === '/leon/v1/automation/settings') {
      posts.push({ token: request.headers()['x-leon-token'], contentType: request.headers()['content-type'], body: request.postDataJSON() });
      return json(settingsReply(handlers, posts.length));
    }
    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
    }
    if (pathname.startsWith('/storage')) return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: shell });
    return route.fulfill({ status: 404 });
  });
  return {
    page,
    errors,
    requests,
    posts,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
const locationOf = page => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const title = page => page.locator('.large-title').textContent();

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
  appTest(browserType, `${browserType.name()} storage page shows the drive meter, connections and folders`, async app => {
    await app.page.goto('https://leon.test/storage');
    await app.page.getByText('Family drive').waitFor();
    const meter = app.page.getByRole('meter', { name: 'Space used' });
    assert.equal(await meter.getAttribute('aria-valuenow'), '61');
    assert.equal(await app.page.locator('.drive-space').textContent(), '400 GB free of 1 TB');
    assert.equal(await app.page.locator('.drive-facts').textContent(), 'FAMILY · exfat · Read and write');
    assert.equal(await app.page.getByRole('link', { name: 'Browse files' }).getAttribute('href'), '/storage/files');
    assert.equal(await app.page.getByRole('link', { name: 'Open in Files or Finder' }).first().getAttribute('href'), 'smb://100.64.0.7/Family');
    assert.equal(await app.page.getByText('Grandma drive').count(), 1);
    assert.equal(await app.page.locator('code.address').count(), 2);
    assert.equal(await app.page.getByText('LEÓN TV').count(), 1);
    assert.match(await app.page.locator('.row', { hasText: 'Family' }).filter({ hasText: 'Folder present' }).first().textContent(), /\/srv\/storage\/Family · Folder present/);
    assert.equal(await app.page.getByText('Backup disk').count(), 1);
    assert.equal(await app.page.getByRole('link', { name: /^Automation/ }).getAttribute('href'), '/storage/automation');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} copy buttons write the address and confirm with a toast`, async app => {
    await app.page.goto('https://leon.test/storage');
    await app.page.getByRole('button', { name: 'Copy the Anywhere with Tailscale address' }).click();
    await app.page.locator('.toast.is-applied', { hasText: 'Address copied' }).waitFor();
    assert.deepEqual(await app.page.evaluate(() => globalThis.copied), ['smb://100.64.0.7/Family']);
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} the guide shows steps per device and a password only on request`, async app => {
    await app.page.goto('https://leon.test/storage');
    await app.page.getByRole('link', { name: /^How to connect/ }).click();
    await app.page.getByText('Connect to Server').first().waitFor();
    assert.equal(locationOf(app.page), '/storage/guide');
    assert.equal(await app.page.getByText('synthetic pass').count(), 0);
    assert.equal(await app.page.getByText('You can watch, add and delete files.').count(), 1);
    assert.equal(await app.page.getByText('Ask the person who set up LEÓN Home for your user and password.').count(), 1);
    await app.page.getByRole('button', { name: 'Show the password for Family drive' }).click();
    await app.page.getByText('synthetic pass').waitFor();
    assert.deepEqual(app.posts, [{ token: 'token-fixture', body: { drive: 'Family drive', user: 'family_nas' } }]);
    await app.page.getByRole('button', { name: 'Copy the password for Family drive' }).click();
    assert.deepEqual(await app.page.evaluate(() => globalThis.copied), ['synthetic pass']);
    await app.page.clock.runFor(61_000);
    await app.page.getByRole('button', { name: 'Show the password for Family drive' }).waitFor();
    assert.equal(await app.page.getByText('synthetic pass').count(), 0);
    await app.page.getByRole('radio', { name: 'Windows' }).click();
    await app.page.getByText(String.raw`\\100.64.0.9\Family`).waitFor();
    await app.page.getByRole('radio', { name: 'TV' }).click();
    await app.page.getByText('Choose “LEÓN TV”.').waitFor();
    assert.equal(await app.page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
    assert.deepEqual(app.errors, []);
  });

  appTest(
    browserType,
    `${browserType.name()} an older server without accounts still opens the guide`,
    async app => {
      await app.page.goto('https://leon.test/storage/guide');
      await app.page.getByText('Ask the person who set up LEÓN Home for your user and password.').first().waitFor();
      assert.equal(await app.page.getByText('Add a movie').count(), 0);
      assert.deepEqual(app.errors, []);
    },
    { storage: () => storageView({ accounts: undefined }) }
  );

  test(`${browserType.name()} unknown capacity shows no meter and a missing drive hides browsing`, async () => {
    const view = storageView({
      drive: { name: 'My drive', isMounted: false, totalBytes: null, freeBytes: null, label: null, filesystem: null, isReadOnly: null, openUrl: null },
      isSharingSetUp: false,
      connections: [],
      peers: [],
      tvServerName: null,
    });
    const app = await start(browserType, { storage: () => view });
    try {
      await app.page.goto('https://leon.test/storage');
      await app.page.getByText('This LEÓN Home · drive not connected').waitFor();
      assert.equal(await app.page.getByRole('meter').count(), 0);
      assert.equal(await app.page.getByRole('link', { name: 'Browse files' }).count(), 0);
      await app.page.getByText('Network sharing is not set up on this Pi').waitFor();
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  appTest(
    browserType,
    `${browserType.name()} malformed storage JSON shows an error state`,
    async app => {
      await app.page.goto('https://leon.test/storage');
      await app.page.getByText('LEÓN Home is not answering').waitFor();
      assert.equal(await app.page.locator('.tabbar').isVisible(), true);
      assert.deepEqual(app.errors, []);
    },
    { storage: () => ({ drive: 'nope' }) }
  );

  appTest(
    browserType,
    `${browserType.name()} a peer URL outside the smb:// pattern is rejected`,
    async app => {
      await app.page.goto('https://leon.test/storage');
      await app.page.getByText('LEÓN Home is not answering').waitFor();
      assert.deepEqual(app.errors, []);
    },
    { storage: () => storageView({ peers: [{ name: 'Evil', url: 'javascript:alert(1)' }] }) }
  );

  appTest(browserType, `${browserType.name()} folders push as pages and Back restores titles and scroll`, async app => {
    await app.page.goto('https://leon.test/storage/files');
    await app.page.getByRole('link', { name: /^Movies/ }).click();
    await app.page.getByRole('link', { name: /^Action/ }).waitFor();
    assert.equal(locationOf(app.page), '/storage/files?path=Movies');
    assert.equal(await title(app.page), 'Movies');
    await app.page.evaluate(() => globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight));
    const scrolled = await app.page.evaluate(() => globalThis.scrollY);
    assert.ok(scrolled > 500);
    await app.page.getByRole('link', { name: /^Action/ }).click();
    await app.page.getByText('chase.mkv').waitFor();
    assert.equal(locationOf(app.page), '/storage/files?path=Movies%2FAction');
    assert.equal(await title(app.page), 'Action');
    await app.page.locator('.nav-back').click();
    await app.page.getByRole('link', { name: /^Action/ }).waitFor();
    assert.equal(await title(app.page), 'Movies');
    assert.equal(await app.page.evaluate(() => globalThis.scrollY), scrolled);
    await app.page.locator('.nav-back').click();
    await app.page.getByText('notes.pdf').waitFor();
    assert.equal(await title(app.page), 'Drive');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} search updates the URL, shows partial results and survives a reload`, async app => {
    await app.page.goto('https://leon.test/storage/files?path=Movies');
    await app.page.getByRole('link', { name: /^Action/ }).waitFor();
    await app.page.getByRole('searchbox', { name: 'Search this folder' }).fill('mkv');
    await app.page.clock.fastForward(400);
    await app.page.getByText('Partial results; refine the search').waitFor();
    assert.equal(locationOf(app.page), '/storage/files?path=Movies&q=mkv');
    assert.ok(app.requests.includes('/leon/v1/storage/files?path=Movies&q=mkv'));
    assert.equal(await app.page.locator('.group-title').textContent(), 'Search results');
    assert.match(await app.page.locator('.row', { hasText: 'match.mkv' }).textContent(), /Movies/);
    await app.page.reload();
    await app.page.getByText('Partial results; refine the search').waitFor();
    assert.equal(await app.page.getByRole('searchbox').inputValue(), 'mkv');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} a missing folder shows the unavailable state`, async app => {
    await app.page.goto('https://leon.test/storage/files?path=Gone');
    await app.page.getByText('Folder unavailable or drive not mounted').waitFor();
    assert.equal(await app.page.getByRole('searchbox').isVisible(), false);
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} file rows link to the download route with an encoded path`, async app => {
    await app.page.goto('https://leon.test/storage/files?path=Movies');
    const link = app.page.getByRole('link', { name: /^A b&c\.mp4/ });
    assert.equal(await link.getAttribute('href'), '/storage/download?path=Movies%2FA%20b%26c.mp4');
    assert.equal(await app.page.getByRole('link', { name: /^Action/ }).getAttribute('href'), '/storage/files?path=Movies%2FAction');
    assert.deepEqual(app.errors, []);
  });

  appTest(browserType, `${browserType.name()} the Failed filter refetches with status=failed and updates the URL`, async app => {
    await app.page.goto('https://leon.test/storage/automation');
    await app.page.getByText('n8n is ready').waitFor();
    assert.equal(await app.page.getByRole('link', { name: 'Open n8n editor' }).getAttribute('href'), 'https://leon-home.tail1234.ts.net/');
    assert.equal(await app.page.getByRole('link', { name: 'Open Nightly backup in the n8n editor' }).getAttribute('href'), 'https://leon-home.tail1234.ts.net/workflow/wf_1');
    assert.equal(await app.page.locator('.reading', { hasText: 'Recent runs' }).locator('.reading-value').textContent(), '2');
    await app.page.getByRole('radio', { name: 'Failed' }).click();
    await app.page.locator('.reading', { hasText: 'Recent runs' }).locator('.reading-value', { hasText: /^1$/ }).waitFor();
    await app.page.getByText('Failed · 2026-11-20 14:03 UTC').waitFor();
    assert.equal(await app.page.locator('.reading', { hasText: 'Recent runs' }).locator('.reading-value').textContent(), '1');
    assert.equal(locationOf(app.page), '/storage/automation?status=failed');
    assert.ok(app.requests.includes('/leon/v1/automation?status=failed'));
    assert.equal(await app.page.getByRole('radio', { name: 'Failed' }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(app.errors, []);
  });

  appTest(
    browserType,
    `${browserType.name()} connection settings post with the token, stay open when refused and never echo the key`,
    async app => {
      await app.page.goto('https://leon.test/storage/automation');
      await app.page.getByRole('button', { name: /^Connection settings/ }).click();
      const sheet = app.page.locator('.sheet');
      assert.equal(await sheet.getByLabel('Read-only API key').getAttribute('placeholder'), 'Stored key kept');
      assert.equal(await sheet.getByLabel('Read-only API key').inputValue(), '');
      assert.equal(await sheet.getByLabel('Private editor URL').inputValue(), 'https://leon-home.tail1234.ts.net/');
      await sheet.getByLabel('Read-only API key').fill('secret-key_1');
      await sheet.getByRole('button', { name: 'Save connection' }).click();
      await app.page.locator('.toast.is-refused', { hasText: 'n8n rejected that key' }).waitFor();
      assert.equal(await sheet.isVisible(), true);
      assert.deepEqual(app.posts[0], { token: 'token-fixture', contentType: 'application/json', body: { apiKey: 'secret-key_1', editorUrl: 'https://leon-home.tail1234.ts.net/' } });
      await sheet.getByRole('button', { name: 'Save connection' }).click();
      await app.page.locator('.toast.is-applied', { hasText: 'Connection saved' }).waitFor();
      await app.page.clock.fastForward(500);
      await sheet.waitFor({ state: 'detached' });
      assert.equal(app.posts.length, 2);
      assert.equal(await app.page.locator('input[type=password]').count(), 0);
      assert.deepEqual(app.errors, []);
    },
    { answer: count => (count === 1 ? { status: 'refused', message: 'n8n rejected that key' } : { status: 'saved', message: 'Connection saved' }) }
  );

  appTest(
    browserType,
    `${browserType.name()} a forbidden answer asks for a reload`,
    async app => {
      await app.page.goto('https://leon.test/storage/automation');
      await app.page.getByRole('button', { name: /^Connection settings/ }).click();
      await app.page.locator('.sheet').getByRole('button', { name: 'Save connection' }).click();
      await app.page.locator('.toast.is-refused', { hasText: 'Reload the page' }).waitFor();
      assert.equal(await app.page.locator('.sheet').isVisible(), true);
      assert.deepEqual(app.errors, []);
    },
    { answer: () => ({ status: 'forbidden', message: '' }) }
  );
}
