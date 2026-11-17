import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromium, webkit } from 'playwright';

const root = new URL('../../', import.meta.url);
const body = await readFile(new URL('sharing/updates.html', root), 'utf8');
const directory = new URL('deploy/leon-home/files/usr/local/lib/leon-overview/web/dist/', root);
for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} family update requires explicit acceptance and renders release notes as text`, async () => {
    const browser = await browserType.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const mutations = [],
      errors = [];
    const state = {
      schemaVersion: 1,
      version: '1.0.0',
      phase: 'ready',
      error: null,
      actionToken: 'fixture-token',
      available: { version: '1.1.0', notes: ['<img src=x onerror=alert(1)>', 'Mejoras de estabilidad.'] },
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://leon.test/**', async route => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (request.method() === 'POST') {
        mutations.push({ path, body: request.postDataJSON(), token: request.headers()['x-leon-token'] });
        state.phase = 'current';
        state.version = '1.1.0';
        state.available = null;
        return route.fulfill({ status: 202, json: { status: 'accepted' } });
      }
      if (path === '/updates/data') return route.fulfill({ json: state });
      if (path === '/updates')
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'nonce-fixture' 'strict-dynamic'; style-src 'self'; connect-src 'self'; img-src 'self'" },
          body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/network-map/assets/home.css"><link rel="stylesheet" href="/network-map/assets/updates.css"></head><body>${body}<script type="module" nonce="fixture" src="/network-map/assets/updates.js"></script></body></html>`,
        });
      const name = path.slice('/network-map/assets/'.length);
      if (path.startsWith('/network-map/assets/') && ['home.css', 'updates.css', 'updates.js'].includes(name))
        return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(name, directory)) });
      if (path === '/brand/symbol.png') return route.fulfill({ contentType: 'image/png', body: await readFile(new URL('Sources/LeonLabs/Resources/Brand/symbol.png', root)) });
      return route.fulfill({ status: 404 });
    });
    try {
      await page.goto('https://leon.test/updates');
      await page.getByText('Hay una actualización', { exact: true }).waitFor();
      assert.equal(await page.locator('#release-notes img').count(), 0);
      await page.getByRole('button', { name: 'Aceptar e instalar' }).click();
      await page.getByRole('button', { name: 'Más tarde' }).click();
      assert.deepEqual(mutations, []);
      await page.screenshot({ path: `test-results/updates-${browserType.name()}-390.png`, fullPage: true });
      assert.equal(await page.locator('html').evaluate(element => element.scrollWidth <= element.ownerDocument.defaultView.innerWidth), true);
      await page.getByRole('button', { name: 'Aceptar e instalar' }).click();
      await page.getByRole('button', { name: 'Instalar ahora' }).click();
      await page.getByText('Todo está actualizado', { exact: true }).waitFor();
      assert.deepEqual(mutations, [{ path: '/updates/apply', body: { version: '1.1.0' }, token: 'fixture-token' }]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
    }
  });
}
