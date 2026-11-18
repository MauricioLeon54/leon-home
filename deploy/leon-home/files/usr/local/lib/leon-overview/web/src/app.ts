import { readJson } from './api.js';
import type { Snapshot } from './contracts.js';
import { createInternetView } from './internet.js';
import { createMapView } from './map.js';
import { bindDialog, bindDisclosures } from './motion.js';
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
const network = createMapView({ getState, scanCurrent, trafficCurrent, refresh, isRefreshing });
const traffic = createTrafficView({ getState, trafficCurrent, select: network.select });
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
  chip(
    $('#scan-chip'),
    scanCurrent() ? 'ok' : 'warn',
    failed ? 'Offline · previous readings' : scanCurrent() ? 'Scan ' + time(state.observedAt) : state.observedAt ? 'Earlier scan ' + time(state.observedAt) : 'No scan yet'
  );
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
let shown: View | null = null;
function show(requested: string) {
  const view = VIEWS.find(view => view === requested) ?? 'map';
  for (const name of VIEWS) $('#view-' + name).classList.toggle('active', name === view);
  // Only a user's section change animates; the first paint and data refreshes stay still.
  if (shown !== null && shown !== view) {
    const section = $('#view-' + view);
    section.classList.remove('entering');
    void section.offsetWidth;
    section.classList.add('entering');
    window.scrollTo({ top: 0 });
  }
  shown = view;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.tabbar a')) link.toggleAttribute('aria-current', link.dataset.tab === view);
  $('#heading').textContent = TITLES[view];
  document.title = TITLES[view] + ' · LEÓN Home';
}
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
function render() {
  updateChips();
  if (!state) return;
  network.render();
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
    state = value;
    failed = false;
    render();
  } catch (error) {
    failed = true;
    if (state) render();
    else {
      updateChips();
      const status = $('.status');
      status.textContent = 'The map could not load. Check Tailscale.';
      status.hidden = false;
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
setInterval(() => {
  if (!document.hidden && !ports.isActing()) void refresh();
}, REFRESH_MS);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
for (const view of VIEWS) $('#view-' + view).addEventListener('animationend', event => (event.currentTarget instanceof HTMLElement ? event.currentTarget.classList.remove('entering') : undefined));
bindDisclosures();
bindDialog($('#confirm', HTMLDialogElement));
show(location.hash.slice(1));
void refresh();
