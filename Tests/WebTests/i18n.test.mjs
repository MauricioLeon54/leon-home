import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const modules = new URL('../../.build/web-modules/', import.meta.url);
const source = new URL('../../deploy/leon-home/files/usr/local/lib/leon-overview/web/src/', import.meta.url);

async function load(saved, deviceLanguage = 'en-US') {
  const previous = { storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => saved }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { language: deviceLanguage }, configurable: true });
  try {
    return await import(new URL(`i18n/index.js?${saved}-${deviceLanguage}`, modules));
  } finally {
    for (const [name, descriptor] of [
      ['localStorage', previous.storage],
      ['navigator', previous.navigator],
    ])
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  }
}

test('the saved language wins, then the device language, then English', async () => {
  assert.equal((await load(null, 'es-MX')).language, 'es');
  assert.equal((await load('en', 'es-MX')).language, 'en');
  assert.equal((await load('es')).language, 'es');
  assert.equal((await load('fr', 'fr-FR')).language, 'en');
});

test('translations keep exactly the placeholders of their key', async () => {
  const { es } = await import(new URL('i18n/es.js', modules));
  const slots = text => [...text.matchAll(/\{\d\}/g)].map(match => match[0]).sort();
  for (const [key, value] of Object.entries(es)) {
    assert.deepEqual(slots(value), slots(key), key);
    assert.ok(value.trim(), key);
  }
});

test('texts are filled, and server wording is translated without touching data', async () => {
  const spanish = await load('es'),
    english = await load('en');
  assert.equal(spanish.t('{0} of {1} online', 3, 5), '3 de 5 en línea');
  assert.equal(english.t('{0} of {1} online', 3, 5), '3 of 5 online');
  assert.equal(spanish.t('Pause {0}?', '$& {1}'), '¿Pausar $& {1}?');
  assert.equal(spanish.serverText('Low voltage'), 'Bajo voltaje');
  assert.equal(spanish.serverText('Encrypted DNS stopped'), 'DNS cifrado sin funcionar');
  assert.equal(spanish.serverText('2 failed services'), '2 servicios con falla');
  assert.equal(spanish.serverText('offline · last seen 3 h ago'), 'sin conexión · vista por última vez hace 3 h');
  assert.equal(
    spanish.serverText('Read by the Mac 2 min ago. These readings become stale if the Mac sleeps or LEÓN Labs is closed.'),
    'Leído por la Mac hace 2 min. Estas lecturas envejecen si la Mac duerme o LEÓN Labs está cerrado.'
  );
  assert.equal(spanish.serverText('Grandma’s phone'), 'Grandma’s phone');
  assert.equal(english.serverText('Low voltage'), 'Low voltage');
});

test('every page of the updates page has a translation', async () => {
  const { es } = await import(new URL('i18n/es.js', modules));
  const html = await readFile(new URL('../../sharing/updates.html', import.meta.url), 'utf8');
  const texts = [...html.matchAll(/data-i18n[^>]*>([^<]+)</g)].map(match => match[1].replaceAll(/\s+/g, ' ').trim());
  assert.ok(texts.length >= 10);
  for (const text of texts) assert.ok(Object.hasOwn(es, text), text);
});

test('visible texts are written through t()', async () => {
  const same = new Set(['Pi-hole', 'Tailscale', 'Raspberry Pi', 'USB', 'LEÓN Home', 'CPU', 'Bluetooth', 'Wi-Fi', 'Ethernet', 'Mac', 'Windows', 'ACT', 'PWR', 'iPhone', ' Mbps']);
  const found = [];
  for (const name of await readdir(new URL('pages/', source), { recursive: true })) {
    if (!name.endsWith('.ts')) continue;
    const text = await readFile(new URL(`pages/${name}`, source), 'utf8');
    for (const match of text.matchAll(/\b(?:text|title|label|detail|meta|message|placeholder|confirmLabel|'aria-label'): '([^']*[A-Za-z]{2}[^']*)'/g))
      if (!same.has(match[1])) found.push(`${name}: ${match[1]}`);
  }
  assert.deepEqual(found, []);
});
