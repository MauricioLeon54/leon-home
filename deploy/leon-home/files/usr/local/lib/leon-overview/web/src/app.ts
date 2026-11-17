import { readJson } from './api.js';
import type { Snapshot } from './contracts.js';
import { createInternetView } from './internet.js';
import { createMapView } from './map.js';
import { $, time } from './presentation.js';
import { createRouterControls } from './routerControls.js';
import { parseSnapshot } from './snapshot.js';
import { createTrafficView } from './traffic.js';
import { createWifiView } from './wifi.js';

const ROUTER_FRESH_SECONDS = 90,
  REFRESH_MS = 15000;
type View = 'map' | 'traffic' | 'ports';
const VIEWS: ReadonlyArray<View> = ['map', 'traffic', 'ports'];
const TITLES = { map: 'Network', traffic: 'Traffic', ports: 'Ports' } satisfies Record<View, string>;
let state: Snapshot | null = null;
let failed = false,
  busy = false;
let controller: AbortController | null = null;
const getState = () => state,
  isRefreshing = () => busy;
const canvas = createMapView({ getState, scanCurrent, trafficCurrent, refresh, isRefreshing });
const traffic = createTrafficView({ getState, trafficCurrent, select: canvas.select });
const ports = createRouterControls({ getState, trafficCurrent, refresh, isRefreshing });
const wifi = createWifiView({ getState, trafficCurrent });
const internet = createInternetView({ getState });
// ---------------------------------------------------------------- freshness
function scanCurrent() {
  return !failed && state !== null && state.observedAt !== null && state.freshness === 'current' && Date.now() / 1000 - state.observedAt <= state.freshSeconds;
}
function trafficCurrent() {
  const router = state?.routerTelemetry;
  return !failed && router?.status === 'current' && typeof router.observedAt === 'number' && Date.now() / 1000 - router.observedAt <= ROUTER_FRESH_SECONDS;
}
function chip(element: HTMLElement, tone: string, label: string) {
  element.replaceChildren();
  const dot = document.createElement('i');
  dot.className = 'dot ' + tone;
  element.append(dot, label);
}
function updateChips() {
  if (!state) {
    chip($('#scan-chip'), 'warn', failed ? 'Offline' : 'Loading…');
    return;
  }
  chip($('#scan-chip'), scanCurrent() ? 'ok' : 'warn', failed ? 'Offline · previous readings' : scanCurrent() ? 'Scan ' + time(state.observedAt) : state.observedAt ? 'Stale scan' : 'Unknown scan');
  const status = state.routerTelemetry?.status;
  chip($('#router-chip'), trafficCurrent() ? 'ok' : 'warn', trafficCurrent() ? 'Router live' : status === 'locked' ? 'Router locked' : status === 'error' ? 'Session ended' : 'No router reading');
  const locked = status === 'locked' || status === 'error';
  $('#locked').hidden = !locked || failed;
  $('#locked-text').textContent =
    status === 'error'
      ? 'The router session stopped responding. LEÓN does not retry passwords. Unlock it again.'
      : 'The router session starts locked after the Pi or monitor restarts. The inventory map remains available.';
}

// ---------------------------------------------------------------- views
function show(requested: string) {
  const view = VIEWS.find(view => view === requested) ?? 'map';
  for (const name of VIEWS) $('#view-' + name).classList.toggle('active', name === view);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.tabbar a')) link.toggleAttribute('aria-current', link.dataset.tab === view);
  $('#heading').textContent = TITLES[view];
  document.title = TITLES[view] + ' · LEÓN Home';
  if (view === 'map' && state) requestAnimationFrame(canvas.fit);
}
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
function render() {
  updateChips();
  if (!state) return;
  canvas.render();
  traffic.render();
  ports.render();
  wifi.render();
  internet.render();
}
async function refresh() {
  if (busy) return;
  busy = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 8000);
  try {
    const response = await fetch('/network-map/data', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw Error('Unavailable');
    const value = parseSnapshot(await readJson(response));
    const first = state === null;
    state = value;
    failed = false;
    render();
    if (first) canvas.fit();
  } catch (error) {
    failed = true;
    if (state) render();
    else {
      updateChips();
      $('.status').textContent = 'The map could not load. Check Tailscale.';
    }
  } finally {
    clearTimeout(timeout);
    controller = null;
    busy = false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) controller?.abort();
  else void refresh();
});
window.addEventListener('pagehide', () => controller?.abort());
window.addEventListener('resize', () => {
  if (location.hash.slice(1) !== 'traffic') canvas.fit();
});
setInterval(() => {
  if (!document.hidden && !canvas.isGesturing() && !ports.isActing()) void refresh();
}, REFRESH_MS);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
show(location.hash.slice(1));
canvas.transform();
void refresh();
