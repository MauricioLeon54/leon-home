import type { Connection, ControlContext, Device, Traffic } from './contracts.js';
const CONNECTION_NAMES = { ethernet: 'Ethernet', wifi: 'Wi-Fi', other: 'Other', unknown: 'Unidentified' } satisfies Record<Connection, string>;
interface Point {
  x: number;
  y: number;
}
interface Gesture {
  pointer: number;
  id: string | null;
  start: Point;
  origin: Point;
  moved: boolean;
}
import { drawChart } from './charts.js';
import { createDeviceControls } from './deviceControls.js';
import { $, date, icon, mbps, svgNS, text } from './presentation.js';
import { bandName, signalText } from './wifi.js';
export function createMapView({ getState, scanCurrent, trafficCurrent, refresh, isRefreshing }: ControlContext & { scanCurrent: () => boolean }) {
  const map = $('.map');
  let selected: string | null = null;
  const positions = new Map<string, Point>();
  let scale = 1,
    offset = { x: 24, y: 70 },
    gesture: Gesture | null = null;
  function compact() {
    return map.clientWidth < 600;
  }
  function hubPosition() {
    return compact() ? { x: 20, y: 20 } : { x: 105, y: 80 };
  }
  function defaultPosition(index: number) {
    return compact() ? { x: 20 + (index % 2) * 200, y: 170 + Math.floor(index / 2) * 118 } : { x: 420 + (index % 4) * 220, y: 20 + Math.floor(index / 4) * 124 };
  }
  function transform() {
    $('.canvas').style.transform = `translate(${offset.x}px,${offset.y}px) scale(${scale})`;
  }
  // Same rule as the Mac app: colour = presence while discovery is current; width = log2 of current router rates, 1-5.
  function linkColor(device: Device) {
    return !scanCurrent() ? 'var(--warn)' : device.presence === 'seen' ? 'var(--good)' : device.presence === 'notSeen' ? 'var(--ash)' : 'var(--warn)';
  }
  function linkWidth(device: Device) {
    const t = device.traffic;
    if (!trafficCurrent() || !t) return 1;
    const rates = [t.downloadRouterMbps, t.uploadRouterMbps].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    return rates.length ? 1 + Math.min(4, Math.log2(1 + rates.reduce((a, b) => a + b, 0))) : 1;
  }
  function edge(position: Point, device: Device, isSelected: boolean) {
    const line = document.createElementNS(svgNS, 'path'),
      hub = hubPosition();
    line.setAttribute(
      'd',
      compact()
        ? `M${hub.x + 100} ${hub.y + 96} C${hub.x + 100} ${position.y - 30} ${position.x + 92} ${position.y - 40} ${position.x + 92} ${position.y}`
        : `M${hub.x + 200} ${hub.y + 48} C${hub.x + 265} ${hub.y + 48} ${position.x - 65} ${position.y + 48} ${position.x} ${position.y + 48}`
    );
    const width = linkWidth(device) + (isSelected ? 0.6 : 0);
    line.setAttribute('fill', 'none');
    line.style.stroke = linkColor(device);
    line.setAttribute('stroke-opacity', selected === null ? '.6' : isSelected ? '1' : '.15');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-width', width.toFixed(2));
    line.setAttribute('stroke-dasharray', `2 ${(4 + width).toFixed(2)}`);
    $('.canvas svg', SVGSVGElement).append(line);
  }
  function rateLine(traffic: Traffic | null) {
    const line = document.createElement('small');
    line.className = 'rates';
    if (!trafficCurrent() || !traffic) {
      line.textContent = 'No current traffic reading';
      return line;
    }
    line.append(text('b', '↓ ' + mbps(traffic.downloadRouterMbps), 'd'), text('b', '↑ ' + mbps(traffic.uploadRouterMbps) + ' Mbps', 'u'));
    return line;
  }
  function renderMap() {
    const state = getState();
    if (!state) return;
    const nodes = $('#nodes'),
      active = document.activeElement,
      focused = active instanceof HTMLElement ? active.dataset.id : undefined;
    nodes.replaceChildren();
    $('.canvas svg', SVGSVGElement).replaceChildren();
    const hub = document.createElement('div');
    hub.className = 'node hub';
    const hubAt = hubPosition();
    hub.style.left = hubAt.x + 'px';
    hub.style.top = hubAt.y + 'px';
    const hubTitle = document.createElement('strong');
    hubTitle.append(text('span', 'Local network'));
    hub.append(hubTitle, text('small', state.devices.length + ' devices in inventory'));
    nodes.append(hub);
    state.devices.forEach((device, index) => {
      if (!positions.has(device.id)) positions.set(device.id, defaultPosition(index));
      // Phones stack cards in tight columns, so a curve would run underneath them: there the card's
      // left stripe carries the same colour (presence) and thickness (traffic) as the link line.
      const position = positions.get(device.id) ?? defaultPosition(index);
      if (!compact()) edge(position, device, selected === device.id);
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'node' + (selected === device.id ? ' selected' : '');
      node.style.setProperty('--stripe', Math.round(2 + linkWidth(device) * 1.5) + 'px');
      node.style.setProperty('--stripe-color', linkColor(device));
      node.dataset.id = device.id;
      node.setAttribute('aria-pressed', String(selected === device.id));
      node.style.left = position.x + 'px';
      node.style.top = position.y + 'px';
      const title = document.createElement('strong');
      title.append(icon(device.traffic?.connection), text('span', device.name));
      if (device.isNew) title.append(text('em', 'New', 'badge-new'));
      if (device.paused) title.append(text('em', 'Paused', 'badge-paused'));
      const seen = scanCurrent() && device.presence === 'seen',
        presence = document.createElement('small'),
        dot = document.createElement('i');
      const known = scanCurrent() && (seen || device.presence === 'notSeen');
      dot.className = 'dot ' + (!known ? 'hollow' : seen ? 'ok' : '');
      presence.append(dot, !scanCurrent() ? 'No current reading' : !known ? 'Unknown' : seen ? 'Seen' : 'Not seen');
      node.append(title, text('small', device.address), presence, rateLine(device.traffic));
      nodes.append(node);
    });
    const empty = $('.empty');
    empty.hidden = state.devices.length > 0;
    empty.textContent = 'No devices have been observed yet. Check the inventory service.';
    $('.status').textContent = `${scanCurrent() ? 'Latest scan' : 'No current scan reading'} · ${date(getState()?.observedAt)}${getState()?.truncated ? ' · limited to 64 devices' : ''}`;
    transform();
    inspect();
    if (focused) [...nodes.querySelectorAll('button')].find(node => node.dataset.id === focused)?.focus({ preventScroll: true });
  }
  function inspect() {
    const device = getState()?.devices.find(item => item.id === selected),
      details = $('#details');
    details.replaceChildren();
    $('#inspector').classList.toggle('open', Boolean(device));
    $('#title').textContent = device ? device.name : 'Home devices';
    $('#description').textContent = device ? 'Latest observation from LEÓN Home.' : 'Select a device for details. Drag to arrange the map.';
    const chart = $('#device-chart', SVGSVGElement);
    chart.toggleAttribute('hidden', !device);
    controls.renderRename(device);
    controls.renderPause(device);
    controls.renderSchedule(device);
    if (!device) return;
    const presence = !scanCurrent() ? 'Unknown' : device.presence === 'seen' ? 'Seen in the scan' : device.presence === 'notSeen' ? 'Not seen in the scan' : 'Unknown';
    const current = trafficCurrent(),
      traffic = device.traffic;
    for (const [label, value] of [
      ['Address', device.address],
      ['Presence', presence],
      ['Last seen', date(device.lastSeen)],
      ['Tipo', device.role || device.kind || 'Unidentified'],
      ['Connection (router)', traffic ? CONNECTION_NAMES[traffic.connection] : 'Unidentified'],
      ['Ethernet port', 'No verified association'],
      ['Download', current && traffic ? mbps(traffic.downloadRouterMbps) + ' Mbps' : 'No current reading'],
      ['Upload', current && traffic ? mbps(traffic.uploadRouterMbps) + ' Mbps' : 'No current reading'],
      ...(current && traffic?.band
        ? [
            ['Wi-Fi band', bandName(traffic.band)],
            ['Signal', signalText(traffic.signalDbm)],
          ]
        : []),
      ...(device.isNew ? [['New device', 'First seen in the last 24 hours']] : []),
    ])
      details.append(text('dt', label), text('dd', value));
    drawChart(
      chart,
      (traffic?.history || []).map(pair => [pair[0], pair[1]])
    );
  }
  // The form is static markup: refreshes update it only when the selection changes and it is not being edited.
  function fit() {
    const map = $('.map');
    if (!map.clientWidth) return;
    const points = [...positions.values()];
    const width = Math.max(compact() ? 400 : 760, ...points.map(point => point.x + 205)),
      height = Math.max(280, ...points.map(point => point.y + 120));
    // Phones fit the width and scroll vertically by panning; wide screens fit everything.
    scale = Math.max(0.18, Math.min(1, (map.clientWidth - 24) / width, compact() ? 1 : (map.clientHeight - 80) / height));
    offset = { x: 12, y: 56 };
    transform();
  }
  function zoom(factor: number) {
    const map = $('.map'),
      next = Math.min(2, Math.max(0.18, scale * factor)),
      center = { x: map.clientWidth / 2, y: map.clientHeight / 2 };
    offset = { x: center.x - ((center.x - offset.x) * next) / scale, y: center.y - ((center.y - offset.y) * next) / scale };
    scale = next;
    transform();
  }
  function select(id: string | null) {
    selected = id;
    inspect();
    for (const item of document.querySelectorAll<HTMLButtonElement>('button.node')) {
      item.classList.toggle('selected', item.dataset.id === id);
      item.setAttribute('aria-pressed', String(item.dataset.id === id));
    }
  }
  map.addEventListener('pointerdown', event => {
    if (!(event.target instanceof Element) || event.target.closest('.controls') || gesture) return;
    if (!(event.target instanceof Element)) return;
    const node = event.target.closest<HTMLButtonElement>('button.node');
    const id = node?.dataset.id ?? null;
    if (id) select(id);
    gesture = { pointer: event.pointerId, id, start: { x: event.clientX, y: event.clientY }, origin: id ? { ...(positions.get(id) ?? defaultPosition(0)) } : { ...offset }, moved: false };
    map.setPointerCapture(event.pointerId);
  });
  map.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const dx = event.clientX - gesture.start.x,
      dy = event.clientY - gesture.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
    if (gesture.id) {
      positions.set(gesture.id, { x: Math.max(0, Math.min(1750, gesture.origin.x + dx / scale)), y: Math.max(0, Math.min(2050, gesture.origin.y + dy / scale)) });
      renderMap();
    } else {
      offset = { x: gesture.origin.x + dx, y: gesture.origin.y + dy };
      transform();
    }
  });
  function endGesture(event: PointerEvent) {
    if (gesture?.pointer !== event.pointerId) return;
    if (!gesture.id && !gesture.moved) select(null);
    gesture = null;
    if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
  }
  map.addEventListener('pointerup', endGesture);
  map.addEventListener('pointercancel', endGesture);
  map.addEventListener('keydown', event => {
    if (!(event.target instanceof Element)) return;
    const node = event.target.closest<HTMLButtonElement>('button.node');
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      if (node.dataset.id) select(node.dataset.id);
    }
  });
  map.addEventListener(
    'wheel',
    event => {
      event.preventDefault();
      zoom(event.deltaY > 0 ? 0.92 : 1.08);
    },
    { passive: false }
  );
  $('#in').onclick = () => zoom(1.2);
  $('#out').onclick = () => zoom(1 / 1.2);
  $('#fit').onclick = fit;
  $('#close-sheet').onclick = () => select(null);
  // Sheet: drag down from the handle or title to close; tap outside or Esc closes. Taps on the map are
  // handled by its own gesture (a tap on a device switches selection), and the confirm dialog stays inside.
  {
    const sheet = $('#inspector'),
      phone = matchMedia('(max-width:760px)');
    let drag: { pointer: number; start: number; dy: number } | null = null; // wide screens: a fixed side panel
    sheet.addEventListener('pointerdown', event => {
      if (!(event.target instanceof Element) || !phone.matches || !event.target.closest('.grab,h2,#description') || !sheet.classList.contains('open')) return;
      drag = { pointer: event.pointerId, start: event.clientY, dy: 0 };
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
      const close = drag.dy > 70;
      drag = null;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (close) select(null);
    };
    sheet.addEventListener('pointerup', endDrag);
    sheet.addEventListener('pointercancel', endDrag);
    document.addEventListener('click', event => {
      if (!phone.matches || !selected || !sheet.classList.contains('open') || (event.target instanceof Node && sheet.contains(event.target))) return;
      if (event.target instanceof Element && event.target.closest('.map,dialog')) return;
      select(null);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && selected && !$('#confirm', HTMLDialogElement).open) select(null);
    });
  }

  const controls = createDeviceControls({ getState, getSelectedID: () => selected, onInspect: inspect, refresh, isRefreshing });
  return { render: renderMap, fit, transform, select, isGesturing: () => Boolean(gesture) };
}
