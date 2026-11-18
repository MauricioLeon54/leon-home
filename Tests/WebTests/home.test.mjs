import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const directory = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/', import.meta.url);
const policy = "default-src 'none'; style-src 'self'; script-src 'nonce-fixture' 'strict-dynamic'; connect-src 'self'; worker-src 'self'";
for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} typed home refresh replaces main and preserves readings on failure`, async () => {
    const browser = await browserType.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    let requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.route('https://leon.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') {
        requests++;
        if (requests > 2) return route.fulfill({ status: 503, body: 'Unavailable' });
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': policy },
          body: `<html><head><link rel="stylesheet" href="/network-map/assets/home.css"></head><body><main>Reading ${requests}</main><script type="module" nonce="fixture" src="/network-map/assets/home.js"></script></body></html>`,
        });
      }
      const name = path.slice('/network-map/assets/'.length);
      if (path.startsWith('/network-map/assets/') && ['home.js', 'home.css'].includes(name)) {
        return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
      }
      return route.fulfill({ status: 404 });
    });
    try {
      await page.goto('https://leon.test/');
      await page.clock.runFor(30001);
      await page.getByText('Reading 2', { exact: true }).waitFor();
      const failedRequest = page.waitForResponse(response => response.url() === 'https://leon.test/' && response.status() === 503);
      await page.clock.runFor(30001);
      await failedRequest;
      assert.equal(await page.locator('main').textContent(), 'Reading 2');
      assert.equal(requests, 3);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}

for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} home refresh keeps open sections and labels unreachable readings`, async () => {
    const browser = await browserType.launch();
    const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    let requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    const section = reading =>
      `<main><section class="section t-acc" id="services" data-open="false"><button type="button" class="t-acc-head" aria-expanded="false" aria-controls="services-panel">Services</button><div class="t-acc-panel" id="services-panel" inert><div class="t-acc-panel-inner"><p>${reading}</p></div></div></section></main>`;
    await page.route('https://leon.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') {
        requests++;
        if (requests > 2) return route.fulfill({ status: 503, body: 'Unavailable' });
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': policy },
          body: `<html><head><link rel="stylesheet" href="/network-map/assets/home.css"></head><body><p class="connection" id="connection" role="status" hidden></p>${section('Reading ' + requests)}<script type="module" nonce="fixture" src="/network-map/assets/home.js"></script></body></html>`,
        });
      }
      const name = path.slice('/network-map/assets/'.length);
      if (path.startsWith('/network-map/assets/') && ['home.js', 'home.css'].includes(name)) {
        return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
      }
      return route.fulfill({ status: 404 });
    });
    try {
      await page.goto('https://leon.test/');
      await page.getByRole('button', { name: 'Services' }).click();
      assert.equal(await page.locator('#services').getAttribute('data-open'), 'true');
      await page.clock.runFor(30001);
      await page.getByText('Reading 2', { exact: true }).waitFor();
      assert.equal(await page.locator('#services').getAttribute('data-open'), 'true');
      assert.equal(await page.locator('#services-panel').getAttribute('inert'), null);
      assert.equal(await page.getByRole('button', { name: 'Services' }).getAttribute('aria-expanded'), 'true');
      for (let attempt = 0; attempt < 4; attempt++) await page.clock.runFor(30001);
      await page.locator('#connection:visible').waitFor();
      assert.match(await page.locator('#connection').textContent(), /not answering/);
      assert.equal(await page.getByText('Reading 2', { exact: true }).isVisible(), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
