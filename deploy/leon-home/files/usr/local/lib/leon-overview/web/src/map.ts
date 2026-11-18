import type { ControlContext, Device } from './contracts.js';
import { artKind, drawing } from './deviceArt.js';
import { createInspector, type Presence, presenceOf } from './inspector.js';
import { type Group, GROUP_NAMES, groupOf, GROUPS } from './mapLayout.js';
import { $, date, icon, mbps, text } from './presentation.js';

const STATUS = { online: 'Online', away: 'Not seen', unknown: 'Unknown' } satisfies Record<Presence, string>;
const GROUP_ICONS = { wired: 'ethernet', fast: 'wifi', slow: 'wifi', wireless: 'wifi', unknown: 'unknown' } as const satisfies Record<Group, 'ethernet' | 'wifi' | 'unknown'>;

export function matches(device: Device, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || device.name.toLowerCase().includes(needle) || device.address.includes(needle);
}
function activeRate(device: Device, current: boolean): number {
  const traffic = device.traffic;
  return current && traffic ? (traffic.downloadRouterMbps ?? 0) + (traffic.uploadRouterMbps ?? 0) : 0;
}
function byName(left: Device, right: Device): number {
  return left.name.localeCompare(right.name, 'en', { numeric: true });
}

// Topology: the router at the top, one branch per connection the router reports, devices as tiles.
// CSS lays everything out, so nothing overlaps and the page scrolls normally on a phone.
// Tiles are keyed by device and only moved when their branch or order changes, so the presence
// ping keeps its rhythm across refreshes and focus stays on the same device.
export function createMapView({ getState, scanCurrent, trafficCurrent, refresh, isRefreshing }: ControlContext & { scanCurrent: () => boolean }) {
  const map = $('.map'),
    hub = $('#hub'),
    branches = $('#nodes'),
    search = $('#device-search', HTMLInputElement);
  const tiles = new Map<string, HTMLButtonElement>(),
    branchElements = new Map<Group, HTMLElement>();
  let selected: string | null = null,
    rendered = false;

  function tile(device: Device, index: number): HTMLButtonElement {
    const existing = tiles.get(device.id);
    if (existing) return existing;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = device.id;
    // The ping is offset per device, so online devices never pulse in unison.
    button.style.setProperty('--delay', `${(-((index * 0.7) % 2.8)).toFixed(2)}s`);
    // First paint: transitions.dev stagger, 40 ms per tile and 300 ms in total at most.
    button.style.setProperty('--stagger', `${rendered ? 0 : Math.min(index * 40, 300)}ms`);
    button.classList.add('is-entering');
    tiles.set(device.id, button);
    return button;
  }
  function paint(button: HTMLButtonElement, device: Device) {
    const presence = presenceOf(device, scanCurrent()),
      rate = activeRate(device, trafficCurrent()),
      art = artKind(device),
      entering = button.classList.contains('is-entering');
    button.className = ['node', 'is-' + presence, device.id === selected ? 'selected' : '', device.paused ? 'is-paused' : '', entering ? 'is-entering' : ''].filter(Boolean).join(' ');
    button.hidden = !matches(device, search.value);
    button.setAttribute('aria-pressed', String(device.id === selected));
    if (button.dataset.art !== art) {
      button.dataset.art = art;
      const glyph = document.createElement('span'),
        body = document.createElement('span');
      glyph.className = 'glyph';
      glyph.append(drawing(art));
      body.className = 'body';
      body.append(text('b', '', 'name'), text('small', '', 'meta'));
      button.replaceChildren(glyph, body, text('em', '', 'badge'));
    }
    const [, body, badge] = button.children,
      name = body?.firstElementChild,
      meta = body?.lastElementChild,
      flowing = rate >= 0.05 && device.traffic !== null;
    if (name) name.textContent = device.name;
    if (meta instanceof HTMLElement) {
      meta.replaceChildren();
      meta.classList.toggle('is-flowing', flowing);
      if (flowing) {
        const dots = document.createElement('span');
        dots.className = 'activity';
        dots.setAttribute('aria-hidden', 'true');
        dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
        meta.append(dots, '↓ ' + mbps(device.traffic?.downloadRouterMbps) + ' Mbps');
      } else meta.append(STATUS[presence]);
    }
    if (badge instanceof HTMLElement) {
      badge.textContent = device.isNew ? 'New' : device.paused ? 'Paused' : '';
      badge.className = 'badge' + (device.isNew ? ' new' : '');
      badge.hidden = !device.isNew && !device.paused;
    }
    button.setAttribute(
      'aria-label',
      [device.name, STATUS[presence].toLowerCase(), device.paused ? 'paused' : '', device.isNew ? 'new device' : '', flowing ? `${mbps(device.traffic?.downloadRouterMbps)} Mbps down` : '']
        .filter(Boolean)
        .join(', ')
    );
  }
  function branch(group: Group): HTMLElement {
    const existing = branchElements.get(group);
    if (existing) return existing;
    const element = document.createElement('section'),
      head = document.createElement('h3'),
      list = document.createElement('div');
    element.className = 'branch';
    element.dataset.group = group;
    head.className = 'branch-head';
    head.append(icon(GROUP_ICONS[group], 'conn'), text('span', GROUP_NAMES[group], 'name'), text('span', '', 'count'));
    list.className = 'tiles';
    element.append(head, list);
    branchElements.set(group, element);
    return element;
  }
  function renderHub(devices: ReadonlyArray<Device>, router: Device | undefined) {
    const online = devices.filter(device => device.presence === 'seen').length,
      total = devices.reduce((sum, device) => sum + (device.traffic?.downloadRouterMbps ?? 0), 0);
    const summary = !devices.length
      ? 'No devices observed yet'
      : [scanCurrent() ? `${online} of ${devices.length} online` : `${devices.length} known`, trafficCurrent() ? `↓ ${mbps(total)} Mbps now` : 'No current traffic reading'].join(' · ');
    const mark = text('span', '', 'mark'),
      body = document.createElement('span');
    body.className = 'body';
    body.append(text('b', router ? router.name : 'Home network', 'name'), text('small', summary, 'meta'));
    hub.replaceChildren();
    if (!router) {
      hub.append(mark, body);
      return;
    }
    // The router is a device too: selecting it opens the inspector like any other tile.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'node den' + (router.id === selected ? ' selected' : '');
    button.dataset.id = router.id;
    button.setAttribute('aria-pressed', String(router.id === selected));
    button.setAttribute('aria-label', `${router.name}, router, ${summary}`);
    button.append(mark, body);
    hub.append(button);
  }
  function renderMap() {
    const state = getState();
    if (!state) return;
    const router = state.devices.find(device => device.role === 'router'),
      focusedID = document.activeElement instanceof HTMLElement && map.contains(document.activeElement) ? document.activeElement.dataset.id : undefined,
      query = search.value.trim();
    renderHub(state.devices, router);
    const live = new Set(state.devices.map(device => device.id));
    for (const [id, element] of tiles)
      if (!live.has(id) || id === router?.id) {
        element.remove();
        tiles.delete(id);
      }
    const members = new Map<Group, Array<Device>>();
    for (const device of state.devices) {
      if (device.id === router?.id) continue;
      const group = groupOf(device);
      members.set(group, [...(members.get(group) ?? []), device]);
    }
    let order = 0,
      previous: HTMLElement | null = null,
      visible = 0;
    for (const group of GROUPS) {
      const devices = (members.get(group) ?? []).sort(byName),
        element = branch(group),
        list = element.lastElementChild;
      if (!devices.length || !(list instanceof HTMLElement)) {
        element.remove();
        continue;
      }
      // Keep branch order without re-inserting branches that are already in place.
      if (element.parentElement !== branches || element.previousElementSibling !== previous) {
        if (previous) previous.after(element);
        else branches.prepend(element);
      }
      previous = element;
      devices.forEach((device, position) => {
        const button = tile(device, order++);
        if (list.children[position] !== button) list.insertBefore(button, list.children[position] ?? null);
        paint(button, device);
      });
      const shown = devices.filter(device => matches(device, query)).length;
      visible += shown;
      element.hidden = shown === 0;
      const count = element.querySelector('.count');
      if (count) count.textContent = shown === devices.length ? String(devices.length) : `${shown} of ${devices.length}`;
    }
    map.classList.toggle('has-selection', selected !== null);
    const empty = $('.empty');
    empty.hidden = visible > 0 || (!query && state.devices.length > 0);
    empty.textContent = query ? `No device matches “${query}”.` : 'No devices have been observed yet. Check the inventory service.';
    // The header already shows the scan time; this line only speaks when something is off.
    const status = $('.status'),
      notes = [scanCurrent() ? '' : `Earlier scan from ${date(state.observedAt)}`, state.truncated ? 'Showing the first 64 devices' : ''].filter(Boolean);
    status.textContent = notes.join('. ');
    status.hidden = notes.length === 0;
    rendered = true;
    if (focusedID) map.querySelector<HTMLElement>(`button[data-id="${CSS.escape(focusedID)}"]`)?.focus({ preventScroll: true });
    inspector.inspect();
  }
  branches.addEventListener('animationend', event => {
    if (event.target instanceof HTMLElement && event.animationName === 'tile-enter') event.target.classList.remove('is-entering');
  });
  map.addEventListener('click', event => {
    const node = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button.node') : null;
    if (node?.dataset.id) select(node.dataset.id);
  });
  search.addEventListener('input', renderMap);

  function select(id: string | null) {
    selected = id;
    renderMap();
  }
  const inspector = createInspector({ getState, scanCurrent, trafficCurrent, refresh, isRefreshing, getSelectedID: () => selected, close: () => select(null) });
  return { render: renderMap, select };
}
