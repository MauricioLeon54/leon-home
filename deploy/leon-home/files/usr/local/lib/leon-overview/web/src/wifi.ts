import type { Device, Traffic, ViewContext } from './contracts.js';
import { t } from './i18n/index.js';
import { hasKey } from './presentation.js';
import { $, text, time } from './presentation.js';
export function bandName(band: string | null | undefined) {
  const labels = { '2.4GHz': t('2.4 GHz'), '5GHz': '5 GHz', '5GHz_1': '5 GHz (1)', '5GHz_2': '5 GHz (2)', 'DC': t('Dual band'), 'wifi7-mld': t('Wi-Fi 7 multi-link') };
  return band !== null && band !== undefined && band !== '' && hasKey(labels, band) ? labels[band] : t('Unknown');
}
function signalLevel(dbm: number | null | undefined) {
  return typeof dbm !== 'number' ? null : dbm >= -60 ? 'good' : dbm >= -70 ? 'ok' : 'weak';
}
export function signalText(dbm: number | null | undefined) {
  const level = signalLevel(dbm);
  return level ? `${dbm} dBm · ${{ good: t('good'), ok: t('fair'), weak: t('weak') }[level]}` : t('No reading');
}
function bars(dbm: number | null | undefined) {
  const level = signalLevel(dbm),
    wrap = document.createElement('span');
  wrap.className = `bars ${level ?? ''}`;
  wrap.setAttribute('aria-hidden', 'true');
  const lit = level ? { good: 3, ok: 2, weak: 1 }[level] : 0;
  for (let index = 0; index < 3; index++) {
    const bar = document.createElement('i');
    if (index < lit) bar.className = 'on';
    wrap.append(bar);
  }
  return wrap;
}

function appendGuest(wifi: NonNullable<ReturnType<ViewContext['getState']>>['routerTelemetry']['wifi'], networkRow: (name: string, detail: string, state: string, on: boolean) => void): void {
  const guest = wifi?.guest;
  if (guest) {
    const minutes = typeof guest.restSeconds === 'number' ? Math.round(guest.restSeconds / 60) : null;
    const left = minutes === null ? t('No time limit reported') : minutes >= 60 ? t('{0} h {1} min left', Math.floor(minutes / 60), minutes % 60) : t('{0} min left', minutes);
    networkRow(t('Guest network') + (Boolean(guest.ssid) ? `, ${guest.ssid}` : ''), guest.enabled ? left : t('Turned off'), guest.enabled ? t('On') : t('Off'), guest.enabled);
  }
}

function appendNetworks(state: NonNullable<ReturnType<ViewContext['getState']>>, networkRow: (name: string, detail: string, state: string, on: boolean) => void): void {
  const wifi = state.routerTelemetry.wifi;
  for (const network of wifi?.networks ?? []) {
    if (!Boolean(network.ssid)) continue;
    const band = bandName(network.band) !== t('Unknown') ? bandName(network.band) : network.band === '' ? t('Unknown band') : (network.band ?? t('Unknown band'));
    // Counted from the router's own device list (devices on that band now), not its configured limits.
    const onBand = state.devices.filter(device => (device.traffic?.band && String(device.traffic.band).startsWith(String(network.band).slice(0, 3))) ?? false).length;
    const off = network.WifiEnable === false;
    networkRow(
      `${network.ssid}, ${band}`,
      off ? t('Turned off') : `${Boolean(network.Channel) ? t('Channel ') + network.Channel : t('Automatic channel')} · ${onBand}${onBand === 1 ? t(' device') : t(' devices')}`,
      off ? t('Off') : t('On'),
      !off
    );
  }
  appendGuest(wifi, networkRow);
}

export function createWifiView({ getState, trafficCurrent }: ViewContext) {
  function renderWifi() {
    const state = getState();
    if (!state) return;
    const box = $('#wifi');
    box.replaceChildren();
    $('#wifi-at').textContent = trafficCurrent() ? `Router, ${time(state.routerTelemetry.observedAt)}` : t('No current reading');
    if (!trafficCurrent()) {
      box.append(text('p', t('No current Wi-Fi reading. Unlock the router session to see readings.'), 'muted small'));
      return;
    }
    // One row per broadcast network: name and band first, channel and current devices as detail.
    const networks = document.createElement('ul');
    networks.className = 'networks';
    const networkRow = (name: string, detail: string, state: string, on: boolean) => {
      const row = document.createElement('li'),
        info = document.createElement('div');
      info.append(text('b', name), text('small', detail));
      row.append(info, text('span', state, `state${on ? ' good' : ''}`));
      networks.append(row);
    };
    appendNetworks(state, networkRow);
    if (networks.childElementCount) box.append(networks);
    // Weakest first: the devices worth moving closer or switching band.
    const devices = state.devices.filter((device): device is Device & { traffic: Traffic } => Boolean(device.traffic?.band)).sort((a, b) => (a.traffic.signalDbm ?? 0) - (b.traffic.signalDbm ?? 0));
    if (!devices.length) {
      box.append(text('p', t('The router does not report any active Wi-Fi devices.'), 'muted small'));
      return;
    }
    const list = document.createElement('ul');
    list.className = 'wifi-list';
    for (const device of devices) {
      const row = document.createElement('li'),
        info = document.createElement('div');
      const label = text('small', `${bandName(device.traffic.band)} · ${signalText(device.traffic.signalDbm)}`);
      info.append(text('b', device.name), label);
      row.append(info, bars(device.traffic.signalDbm));
      row.setAttribute('aria-label', `${device.name}, ${label.textContent}`);
      list.append(row);
    }
    box.append(list);
  }

  return { render: renderWifi };
}
