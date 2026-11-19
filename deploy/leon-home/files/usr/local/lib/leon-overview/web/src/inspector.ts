import { drawChart } from './charts.js';
import type { Connection, ControlContext, Device } from './contracts.js';
import { artKind, drawing } from './deviceArt.js';
import { createDeviceControls } from './deviceControls.js';
import { $, date, mbps, text } from './presentation.js';
import { bandName, signalText } from './wifi.js';

const CONNECTION_NAMES = { ethernet: 'Ethernet', wifi: 'Wi-Fi', other: 'Other', unknown: 'Unidentified' } satisfies Record<Connection, string>;
export type Presence = 'online' | 'away' | 'unknown';
/** Presence is only claimed while the scan is current; otherwise it is unknown, never “offline”. */
export function presenceOf(device: Device, scanCurrent: boolean): Presence {
  if (!scanCurrent) return 'unknown';
  return device.presence === 'seen' ? 'online' : device.presence === 'notSeen' ? 'away' : 'unknown';
}

interface InspectorContext extends ControlContext {
  scanCurrent: () => boolean;
  getSelectedID: () => string | null;
  close: () => void;
}
// Side panel on wide screens; bottom sheet on phones (drag the handle or title down, tap outside or Esc).
export function createInspector({ getState, scanCurrent, trafficCurrent, refresh, isRefreshing, getSelectedID, close }: InspectorContext) {
  function inspect() {
    const device = getState()?.devices.find(item => item.id === getSelectedID()),
      details = $('#details'),
      art = $('#inspector-art');
    details.replaceChildren();
    art.replaceChildren();
    $('#inspector').classList.toggle('open', Boolean(device));
    $('#title').textContent = device ? device.name : 'Home devices';
    const presence = device ? presenceOf(device, scanCurrent()) : 'unknown';
    $('#description').textContent = device
      ? !scanCurrent()
        ? 'No current scan. Details are from an earlier reading.'
        : presence === 'online'
          ? 'Seen in the latest scan.'
          : presence === 'away'
            ? 'Not seen in the latest scan.'
            : 'Presence unknown.'
      : 'Select a device for details.';
    art.hidden = !device;
    if (device) {
      art.className = 'inspector-art is-' + presence;
      art.append(drawing(artKind(device)));
    }
    const chart = $('#device-chart', SVGSVGElement);
    chart.toggleAttribute('hidden', !device);
    controls.renderRename(device);
    controls.renderPause(device);
    controls.renderWired(device);
    controls.renderSchedule(device);
    if (!device) return;
    const current = trafficCurrent(),
      traffic = device.traffic;
    const rows: Array<readonly [string, string]> = [
      ['Address', device.address],
      ['Presence', presence === 'online' ? 'Seen in the scan' : presence === 'away' ? 'Not seen in the scan' : 'Unknown'],
      ['Last seen', date(device.lastSeen)],
      ['Type', device.role || device.kind || 'Unidentified'],
      ['Connection (router)', traffic ? CONNECTION_NAMES[traffic.connection] : 'Unidentified'],
      ['Download', current && traffic ? mbps(traffic.downloadRouterMbps) + ' Mbps' : 'No current reading'],
      ['Upload', current && traffic ? mbps(traffic.uploadRouterMbps) + ' Mbps' : 'No current reading'],
    ];
    if (traffic?.port) rows.push(['Router port', 'LAN ' + traffic.port]);
    if (current && traffic?.band) rows.push(['Wi-Fi band', bandName(traffic.band)], ['Signal', signalText(traffic.signalDbm)]);
    if (device.isNew) rows.push(['New device', 'First seen in the last 24 hours']);
    for (const [label, value] of rows) {
      const unknown = /^(Unknown|Unidentified|No current reading|No observation)$/.test(value);
      details.append(text('dt', label), text('dd', value, unknown ? 'unknown' : undefined));
    }
    drawChart(
      chart,
      (traffic?.history || []).map(pair => [pair[0], pair[1]])
    );
  }

  $('#close-sheet').onclick = close;
  const sheet = $('#inspector'),
    phone = matchMedia('(max-width:760px)');
  let drag: { pointer: number; start: number; dy: number; fromHandle: boolean } | null = null;
  sheet.addEventListener('pointerdown', event => {
    if (!(event.target instanceof Element) || !phone.matches || !event.target.closest('.grab,h2,#description') || !sheet.classList.contains('open')) return;
    drag = { pointer: event.pointerId, start: event.clientY, dy: 0, fromHandle: Boolean(event.target.closest('.grab')) };
    sheet.classList.add('dragging');
    sheet.setPointerCapture(event.pointerId);
  });
  sheet.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.dy = Math.max(0, event.clientY - drag.start);
    sheet.style.transform = `translateY(${drag.dy}px)`;
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    // Pointer capture retargets the click to the sheet, so a tap on the handle closes here.
    const shouldClose = drag.dy > 70 || (drag.fromHandle && drag.dy < 6);
    drag = null;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    if (shouldClose) close();
  };
  sheet.addEventListener('pointerup', endDrag);
  sheet.addEventListener('pointercancel', endDrag);
  document.addEventListener('click', event => {
    if (!phone.matches || !getSelectedID() || !sheet.classList.contains('open') || (event.target instanceof Node && sheet.contains(event.target))) return;
    if (event.target instanceof Element && event.target.closest('.map,.map-toolbar,dialog')) return;
    close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && getSelectedID() && !$('#confirm', HTMLDialogElement).open) close();
  });

  const controls = createDeviceControls({ getState, getSelectedID, onInspect: inspect, refresh, isRefreshing });
  return { inspect };
}
