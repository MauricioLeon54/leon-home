import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const directory = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/', import.meta.url);
const policy = "default-src 'none'; style-src 'self'; script-src 'nonce-fixture' 'strict-dynamic'; connect-src 'self'; worker-src 'self'; img-src 'self' data:";
const shell = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/leon.css"></head><body><div id="app" class="app"></div><script type="module" nonce="fixture" src="/assets/leon.js"></script></body></html>`;
const session = {
  login: 'owner@example.test',
  node: 'leon-test',
  actionToken: 'token-fixture',
  version: '0.3.8',
  availableVersion: null,
  features: { automation: false, storage: true, updates: false },
};
const quiet = { underVoltage: false, frequencyCapped: false, throttled: false, softTemperatureLimit: false };

function hardwareView(overrides = {}) {
  return {
    observedAt: Math.floor(Date.now() / 1000) - 3,
    helper: 'available',
    board: 'Raspberry Pi 4 Model B Rev 1.1',
    readings: { uptimeSeconds: 90_000, temperatureCelsius: 48, cpuPercent: 7, memoryAvailableBytes: 2 ** 30, storageFreeBytes: 20 * 2 ** 30, throttling: { now: quiet, sinceBoot: quiet } },
    leds: [
      { name: 'ACT', mode: 'auto' },
      { name: 'PWR', mode: 'on' },
    ],
    ledSchedule: null,
    ethernetLeds: { configured: 'off', pendingReboot: false },
    usb: { isSupported: true, power: 'on', devices: [{ name: 'Backup drive', isStorage: true, isMounted: false }], powerOffBlockedBy: null },
    radios: [
      { kind: 'wifi', state: 'on', isHardBlocked: false, isUplink: false },
      { kind: 'bluetooth', state: 'off', isHardBlocked: false, isUplink: false },
    ],
    cpu: { profile: 'balanced', governor: 'ondemand', frequencyMhz: 1500 },
    services: [{ unit: 'pihole-FTL', label: 'Pi-hole', state: 'active' }],
    power: { rebootRequired: false, rebootAllowedAt: null },
    ...overrides,
  };
}

async function start(browserType, { hardware = () => hardwareView(), answer = () => ({ status: 'applied', message: 'Done' }) } = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [],
    posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  await page.clock.install();
  await page.route('https://leon.test/**', async route => {
    const request = route.request(),
      { pathname } = new URL(request.url());
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/leon/v1/session') return json(session);
    if (pathname === '/leon/v1/hardware' && request.method() === 'GET') return json(hardware());
    if (pathname.startsWith('/leon/v1/hardware/')) {
      posts.push({ path: pathname, token: request.headers()['x-leon-token'], body: request.postDataJSON() });
      return json(answer(pathname));
    }
    if (pathname.startsWith('/assets/')) {
      const name = pathname.slice('/assets/'.length);
      return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
    }
    if (pathname === '/' || pathname.startsWith('/settings')) return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: shell });
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
const pathOf = page => new URL(page.url()).pathname;

for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} Raspberry Pi page shows readings and navigation rows`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/settings/raspberry');
      await app.page.getByText('Raspberry Pi 4 Model B Rev 1.1').waitFor();
      assert.equal(await app.page.locator('.row', { hasText: 'Power' }).first().locator('.row-value').textContent(), 'OK');
      assert.match(await app.page.locator('.reading', { hasText: 'Temperature' }).textContent(), /48 °C/);
      for (const name of ['Lights', 'USB', 'Radios', 'Performance', 'Power & services']) assert.equal(await app.page.getByRole('link', { name: new RegExp(`^${name}`) }).count(), 1, name);
      assert.match(await app.page.getByRole('link', { name: /^Lights/ }).textContent(), /Activity auto · Power on/);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} the language setting switches the app to Spanish and back`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/settings');
      await app.page.getByRole('radio', { name: 'Español' }).click();
      await app.page.locator('.large-title', { hasText: 'Ajustes' }).waitFor();
      assert.equal(await app.page.evaluate(() => globalThis.document.documentElement.lang), 'es');
      await app.page.goto('https://leon.test/settings/raspberry');
      await app.page.locator('.reading', { hasText: 'Temperatura' }).waitFor();
      await app.page.goto('https://leon.test/settings/about');
      await app.page.locator('.row', { hasText: 'Versión' }).getByText('0.3.8').waitFor();
      await app.page.goto('https://leon.test/settings');
      await app.page.getByRole('radio', { name: 'English' }).click();
      await app.page.locator('.large-title', { hasText: 'Settings' }).waitFor();
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} unavailable helper shows the banner and disables controls`, async () => {
    const app = await start(browserType, { hardware: () => hardwareView({ helper: 'unavailable', leds: [], ethernetLeds: { configured: 'unknown', pendingReboot: false } }) });
    try {
      await app.page.goto('https://leon.test/settings/raspberry/lights');
      await app.page.getByText('Hardware controls are not installed on this Pi. Readings still work.').waitFor();
      for (const button of await app.page.locator('.segment').all()) assert.equal(await button.isDisabled(), true);
      // No reading: announced as a disabled mixed checkbox (ARIA switches have only on/off).
      assert.equal(await app.page.getByRole('checkbox', { name: 'Ethernet port lights' }).isDisabled(), true);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} LED segmented control posts the mode with the token`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/settings/raspberry/lights');
      await app.page.getByRole('radiogroup', { name: 'Activity light' }).getByRole('radio', { name: 'Off' }).click();
      await app.page.locator('.toast.is-applied').waitFor();
      assert.deepEqual(app.posts, [{ path: '/leon/v1/hardware/led', token: 'token-fixture', body: { name: 'ACT', mode: 'off' } }]);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  for (const status of ['refused', 'unverified']) {
    test(`${browserType.name()} a switch reverts when the answer is ${status}`, async () => {
      const app = await start(browserType, { answer: () => ({ status, message: 'Not today' }) });
      try {
        await app.page.goto('https://leon.test/settings/raspberry/lights');
        const toggle = app.page.getByRole('switch', { name: 'Ethernet port lights' });
        assert.equal(await toggle.getAttribute('aria-checked'), 'false');
        await toggle.click();
        await app.page.locator(`.toast.is-${status}`).waitFor();
        assert.equal(app.posts.length, 1);
        assert.equal(await app.page.getByRole('switch', { name: 'Ethernet port lights' }).getAttribute('aria-checked'), 'false');
        if (status === 'refused') assert.match(await app.page.locator('.toast').textContent(), /Not today/);
        else assert.match(await app.page.locator('.toast').textContent(), /did not confirm/);
        assert.deepEqual(app.errors, []);
      } finally {
        await app.close();
      }
    });
  }

  test(`${browserType.name()} pendingReboot is reported as applying after restart`, async () => {
    const app = await start(browserType, { answer: () => ({ status: 'pendingReboot', message: '' }) });
    try {
      await app.page.goto('https://leon.test/settings/raspberry/lights');
      await app.page.getByRole('switch', { name: 'Ethernet port lights' }).click();
      await app.page.locator('.toast', { hasText: 'Applies after the next restart' }).waitFor();
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} USB power cannot be turned off while blocked`, async () => {
    const app = await start(browserType, { hardware: () => hardwareView({ usb: { isSupported: true, power: 'on', devices: [], powerOffBlockedBy: 'A USB drive is mounted' } }) });
    try {
      await app.page.goto('https://leon.test/settings/raspberry/usb');
      await app.page.getByText('A USB drive is mounted').waitFor();
      const toggle = app.page.getByRole('switch', { name: 'USB ports' });
      assert.equal(await toggle.isDisabled(), true);
      await toggle.click({ force: true, timeout: 1000 }).catch(() => {});
      assert.deepEqual(app.posts, []);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} restarting the Pi needs the node name typed`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/settings/raspberry/power');
      await app.page.locator('.row.is-destructive').first().click();
      const confirmButton = app.page.locator('.sheet').getByRole('button', { name: 'Restart Pi' });
      assert.equal(await confirmButton.isDisabled(), true);
      await app.page.getByLabel('Type leon-test to confirm').fill('leon-tes');
      assert.equal(await confirmButton.isDisabled(), true);
      await app.page.getByLabel('Type leon-test to confirm').fill('leon-test');
      assert.equal(await confirmButton.isDisabled(), false);
      await confirmButton.click();
      await app.page.locator('.toast.is-applied').waitFor();
      assert.deepEqual(app.posts, [{ path: '/leon/v1/hardware/power', token: 'token-fixture', body: { action: 'reboot', confirm: 'leon-test' } }]);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} back buttons walk Lights, Raspberry Pi, Settings`, async () => {
    const app = await start(browserType);
    try {
      await app.page.goto('https://leon.test/settings/raspberry/lights');
      await app.page.getByText('Status lights').waitFor();
      assert.equal(await app.page.locator('.nav-back').textContent(), 'Raspberry Pi');
      await app.page.locator('.nav-back').click();
      await app.page.getByText('Raspberry Pi 4 Model B Rev 1.1').waitFor();
      assert.equal(pathOf(app.page), '/settings/raspberry');
      assert.equal(await app.page.locator('.nav-back').textContent(), 'Settings');
      await app.page.locator('.nav-back').click();
      await app.page.getByRole('link', { name: 'DNS & filtering' }).waitFor();
      assert.equal(pathOf(app.page), '/settings');
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });

  test(`${browserType.name()} malformed hardware JSON shows an error state`, async () => {
    const app = await start(browserType, { hardware: () => ({ helper: 'maybe' }) });
    try {
      await app.page.goto('https://leon.test/settings/raspberry');
      await app.page.getByText('LEÓN Home is not answering').waitFor();
      assert.equal(await app.page.locator('.tabbar').isVisible(), true);
      assert.deepEqual(app.errors, []);
    } finally {
      await app.close();
    }
  });
}
