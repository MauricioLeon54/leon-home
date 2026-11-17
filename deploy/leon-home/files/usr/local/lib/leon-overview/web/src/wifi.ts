import type { Device, Traffic, ViewContext } from './contracts.js';
import { hasKey } from './presentation.js';
import { $, text, time } from './presentation.js';
export function bandName(band: string | null | undefined) {
  const labels = { '2.4GHz': '2.4 GHz', '5GHz': '5 GHz', '5GHz_1': '5 GHz (1)', '5GHz_2': '5 GHz (2)', 'DC': 'Dual band', 'wifi7-mld': 'Wi-Fi 7 multi-link' };
  return band && hasKey(labels, band) ? labels[band] : 'Unknown';
}
function signalLevel(dbm: number | null | undefined) {
  return typeof dbm !== 'number' ? null : dbm >= -60 ? 'good' : dbm >= -70 ? 'ok' : 'weak';
}
export function signalText(dbm: number | null | undefined) {
  const level = signalLevel(dbm);
  return level ? `${dbm} dBm · ${{ good: 'good', ok: 'fair', weak: 'weak' }[level]}` : 'No reading';
}
function bars(dbm: number | null | undefined) {
  const level = signalLevel(dbm),
    wrap = document.createElement('span');
  wrap.className = 'bars ' + (level || '');
  wrap.setAttribute('aria-hidden', 'true');
  const lit = level ? { good: 3, ok: 2, weak: 1 }[level] : 0;
  for (let index = 0; index < 3; index++) {
    const bar = document.createElement('i');
    if (index < lit) bar.className = 'on';
    wrap.append(bar);
  }
  return wrap;
}

export function createWifiView({ getState, trafficCurrent }: ViewContext) {
  function renderWifi() {
    const state = getState();
    if (!state) return;
    const box = $('#wifi'),
      wifi = state.routerTelemetry.wifi;
    box.replaceChildren();
    $('#wifi-at').textContent = trafficCurrent() ? 'Router ' + time(state.routerTelemetry.observedAt) : 'No current reading';
    if (!trafficCurrent()) {
      box.append(text('p', 'No current Wi-Fi reading. Unlock the router session to see readings.', 'muted small'));
      return;
    }
    const networks = document.createElement('div');
    networks.className = 'networks';
    for (const network of wifi?.networks || []) {
      if (!network.ssid) continue;
      const parts = [network.ssid, bandName(network.band) !== 'Unknown' ? bandName(network.band) : network.band || 'unknown band'];
      // Counted from the router's own device list (devices on that band now), not its configured limits.
      const onBand = state.devices.filter(device => device.traffic?.band && String(device.traffic.band).startsWith(String(network.band).slice(0, 3))).length;
      if (network.WifiEnable === false) parts.push('off');
      else {
        parts.push(network.Channel ? 'channel ' + network.Channel : 'auto channel');
        parts.push(onBand + (onBand === 1 ? ' device' : ' devices'));
      }
      networks.append(text('span', parts.join(' · '), 'chip'));
    }
    const guest = wifi?.guest;
    if (guest) {
      const minutes = typeof guest.restSeconds === 'number' ? Math.round(guest.restSeconds / 60) : null;
      const left = minutes === null ? '' : minutes >= 60 ? ` · remaining ${Math.floor(minutes / 60)} h ${minutes % 60} min` : ` · remaining ${minutes} min`;
      networks.append(text('span', `Guests${guest.ssid ? ' (' + guest.ssid + ')' : ''} · ` + (guest.enabled ? `active${left}` : 'off'), 'chip'));
    }
    if (networks.childElementCount) box.append(networks);
    // Weakest first: the devices worth moving closer or switching band.
    const devices = state.devices.filter((device): device is Device & { traffic: Traffic } => Boolean(device.traffic?.band)).sort((a, b) => (a.traffic.signalDbm ?? 0) - (b.traffic.signalDbm ?? 0));
    if (!devices.length) {
      box.append(text('p', 'The router does not report any active Wi-Fi devices.', 'muted small'));
      return;
    }
    const list = document.createElement('ul');
    list.className = 'wifi-list';
    for (const device of devices) {
      const row = document.createElement('li'),
        info = document.createElement('div');
      const label = text('small', bandName(device.traffic.band) + ' · ' + signalText(device.traffic.signalDbm));
      info.append(text('b', device.name), label);
      row.append(info, bars(device.traffic.signalDbm));
      row.setAttribute('aria-label', device.name + ', ' + label.textContent);
      list.append(row);
    }
    box.append(list);
  }

  return { render: renderWifi };
}
