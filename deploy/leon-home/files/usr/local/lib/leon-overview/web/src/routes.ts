import type { Route } from './core/router.js';
import { t } from './i18n/index.js';
import { renderHome } from './pages/home.js';
import { renderDevice } from './pages/network/device.js';
import { renderNetwork } from './pages/network/index.js';
import { renderAbout } from './pages/settings/about.js';
import { renderDns } from './pages/settings/dns.js';
import { renderSettings } from './pages/settings/index.js';
import { renderLights } from './pages/settings/lights.js';
import { renderPerformance } from './pages/settings/performance.js';
import { renderPower } from './pages/settings/power.js';
import { renderRadios } from './pages/settings/radios.js';
import { renderRaspberry } from './pages/settings/raspberry.js';
import { renderUsb } from './pages/settings/usb.js';
import { renderAutomation } from './pages/storage/automation.js';
import { renderFiles } from './pages/storage/files.js';
import { renderGuide } from './pages/storage/guide.js';
import { renderStorage } from './pages/storage/index.js';

/** Every in-app page. overview.py serves the shell for exactly these paths (APP_ROUTES). */
export const ROUTES: ReadonlyArray<Route> = [
  { pattern: '/', tab: 'home', title: t('Home'), parent: null, render: renderHome },
  { pattern: '/network', tab: 'network', title: t('Network'), parent: null, render: renderNetwork },
  { pattern: '/network/device/:id', tab: 'network', title: t('Device'), parent: '/network', render: renderDevice },
  { pattern: '/storage', tab: 'storage', title: t('Storage'), parent: null, render: renderStorage },
  { pattern: '/storage/files', tab: 'storage', title: t('Files'), parent: '/storage', render: renderFiles },
  { pattern: '/storage/guide', tab: 'storage', title: t('How to connect'), parent: '/storage', render: renderGuide },
  { pattern: '/storage/automation', tab: 'storage', title: t('Automation'), parent: '/storage', render: renderAutomation },
  { pattern: '/settings', tab: 'settings', title: t('Settings'), parent: null, render: renderSettings },
  { pattern: '/settings/about', tab: 'settings', title: t('About'), parent: '/settings', render: renderAbout },
  { pattern: '/settings/raspberry', tab: 'settings', title: 'Raspberry Pi', parent: '/settings', render: renderRaspberry },
  { pattern: '/settings/dns', tab: 'settings', title: t('DNS & filtering'), parent: '/settings', render: renderDns },
  { pattern: '/settings/raspberry/lights', tab: 'settings', title: t('Lights'), parent: '/settings/raspberry', render: renderLights },
  { pattern: '/settings/raspberry/usb', tab: 'settings', title: 'USB', parent: '/settings/raspberry', render: renderUsb },
  { pattern: '/settings/raspberry/radios', tab: 'settings', title: t('Radios'), parent: '/settings/raspberry', render: renderRadios },
  { pattern: '/settings/raspberry/performance', tab: 'settings', title: t('Performance'), parent: '/settings/raspberry', render: renderPerformance },
  { pattern: '/settings/raspberry/power', tab: 'settings', title: t('Power & services'), parent: '/settings/raspberry', render: renderPower },
];

const NETWORK_VIEWS = new Set(['map', 'traffic', 'ports']);
/** Bookmarked server-page URLs (and their #view hashes) open the matching app page. */
export function legacyTarget(url: URL): string | null {
  if (url.pathname === '/network-map') {
    const view = url.hash.slice(1);
    return NETWORK_VIEWS.has(view) && view !== 'map' ? `/network?view=${view}` : '/network';
  }
  if (url.pathname === '/automation') return '/storage/automation' + url.search;
  if (url.pathname === '/index.html') return '/';
  return null;
}
