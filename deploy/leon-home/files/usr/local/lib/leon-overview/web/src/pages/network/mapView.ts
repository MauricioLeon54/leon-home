import type { Device, Snapshot } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import { artKind, drawing } from '../../deviceArt.js';
import { t } from '../../i18n/index.js';
import { type Group, GROUP_NAMES, groupOf, GROUPS } from '../../mapLayout.js';
import { date, icon, mbps } from '../../presentation.js';
import { devicePath, methodNote, type NetworkMemory, type NetworkState, type Presence, presenceOf, scanCurrent, trafficCurrent } from './model.js';

const STATUS = { online: t('Online'), away: t('Not seen'), unknown: t('Unknown') } satisfies Record<Presence, string>;
const GROUP_ICONS = { wired: 'ethernet', fast: 'wifi', slow: 'wifi', wireless: 'wifi', unknown: 'unknown' } as const satisfies Record<Group, 'ethernet' | 'wifi' | 'unknown'>;

export function matches(device: Device, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || device.name.toLowerCase().includes(needle) || device.address.includes(needle);
}
function byName(left: Device, right: Device): number {
  return left.name.localeCompare(right.name, 'en', { numeric: true });
}
function flowingRate(device: Device, isCurrent: boolean): boolean {
  const traffic = device.traffic;
  return isCurrent && traffic !== null && (traffic.downloadRouterMbps ?? 0) + (traffic.uploadRouterMbps ?? 0) >= 0.05;
}

function tile(device: Device, index: number, state: NetworkState, memory: NetworkMemory): HTMLElement {
  const presence = presenceOf(device, scanCurrent(state)),
    isFlowing = flowingRate(device, trafficCurrent(state)),
    download = mbps(device.traffic?.downloadRouterMbps),
    meta = h('small', { className: `meta${isFlowing ? ' is-flowing' : ''}` }, [
      isFlowing ? h('span', { className: 'activity', attrs: { 'aria-hidden': 'true' } }, [h('i'), h('i'), h('i')]) : null,
      isFlowing ? t('↓ {0} Mbps', download) : STATUS[presence],
    ]),
    badgeText = device.isNew ? t('New') : device.paused ? t('Paused') : '',
    link = h(
      'a',
      {
        className: ['node', `is-${presence}`, device.paused ? 'is-paused' : '', memory.hasPainted ? '' : 'is-entering'].filter(Boolean).join(' '),
        attrs: {
          'href': devicePath(device.id),
          'aria-label': [device.name, STATUS[presence].toLowerCase(), device.paused ? 'paused' : '', device.isNew ? t('new device') : '', isFlowing ? t('{0} Mbps down', download) : '']
            .filter(Boolean)
            .join(', '),
        },
        dataset: { focusKey: device.id, search: `${device.name} ${device.address}`.toLowerCase() },
      },
      [
        h('span', { className: 'glyph' }, [drawing(artKind(device))]),
        h('span', { className: 'body' }, [h('b', { className: 'name', text: device.name }), meta]),
        badgeText ? h('em', { className: `badge${device.isNew ? ' is-new' : ''}`, text: badgeText }) : null,
      ]
    );
  // The ping is offset per device, so online devices never pulse in unison; first paint staggers 40 ms a tile.
  link.style.setProperty('--delay', `${(-((index * 0.7) % 2.8)).toFixed(2)}s`);
  link.style.setProperty('--stagger', `${Math.min(index * 40, 300)}ms`);
  link.addEventListener('animationend', event => {
    if (event.animationName === 'tile-enter') link.classList.remove('is-entering');
  });
  return link;
}

function hub(devices: ReadonlyArray<Device>, router: Device | undefined, state: NetworkState): HTMLElement {
  const online = devices.filter(device => device.presence === 'seen').length,
    total = devices.reduce((sum, device) => sum + (device.traffic?.downloadRouterMbps ?? 0), 0),
    summary = !devices.length
      ? t('No devices observed yet')
      : [
          scanCurrent(state) ? t('{0} of {1} online', online, devices.length) : t('{0} known', devices.length),
          trafficCurrent(state) ? t('↓ {0} Mbps now', mbps(total)) : t('No current traffic reading'),
        ].join(' · '),
    body = h('span', { className: 'body' }, [h('b', { className: 'name', text: router ? router.name : t('Home network') }), h('small', { className: 'meta', text: summary })]),
    mark = h('span', { className: 'mark' });
  // The router is a device too: it opens its own page like any other tile.
  if (!router) return h('div', { className: 'hub' }, [mark, body]);
  return h('div', { className: 'hub' }, [
    h('a', { className: 'node den', attrs: { 'href': devicePath(router.id), 'aria-label': t('{0}, router, {1}', router.name, summary) }, dataset: { focusKey: router.id } }, [mark, body]),
  ]);
}

/** Applies the search to tiles and branches without rebuilding, so typing never loses focus. */
export function applyFilter(root: HTMLElement, query: string, total: number): void {
  const needle = query.trim().toLowerCase();
  let visible = 0;
  for (const branch of root.querySelectorAll<HTMLElement>('.branch')) {
    const tiles = [...branch.querySelectorAll<HTMLElement>('.node')];
    let shown = 0;
    for (const element of tiles) {
      const isMatch = !needle || (element.dataset.search ?? '').includes(needle);
      element.hidden = !isMatch;
      if (isMatch) shown++;
    }
    visible += shown;
    branch.hidden = shown === 0;
    const count = branch.querySelector('.count');
    if (count) count.textContent = shown === tiles.length ? String(tiles.length) : t('{0} of {1}', shown, tiles.length);
  }
  const empty = root.querySelector<HTMLElement>('.map-empty');
  if (empty) {
    empty.hidden = visible > 0 || (!needle && total > 0);
    empty.textContent = needle ? t('No device matches “{0}”.', query.trim()) : t('No devices have been observed yet. Check the inventory service.');
  }
}

/** Topology: the router at the top, one branch per connection it reports, devices as tiles. */
export function mapView(snapshot: Snapshot, state: NetworkState, memory: NetworkMemory): Array<Child> {
  const router = snapshot.devices.find(device => device.role === 'router'),
    groups = new Map<Group, Array<Device>>();
  for (const device of snapshot.devices) {
    if (device.id === router?.id) continue;
    const group = groupOf(device);
    groups.set(group, [...(groups.get(group) ?? []), device]);
  }
  let order = 0;
  const branches = GROUPS.flatMap(group => {
    const devices = [...(groups.get(group) ?? [])].sort(byName);
    if (!devices.length) return [];
    return [
      h('section', { className: 'branch', dataset: { group } }, [
        h('h3', { className: 'branch-head' }, [
          icon(GROUP_ICONS[group], 'conn'),
          h('span', { className: 'name', text: GROUP_NAMES[group] }),
          h('span', { className: 'count', text: String(devices.length) }),
        ]),
        h(
          'div',
          { className: 'tiles' },
          devices.map(device => tile(device, order++, state, memory))
        ),
      ]),
    ];
  });
  const notes = [
      scanCurrent(state) ? '' : snapshot.observedAt === null ? t('No scan has finished yet') : t('Earlier scan from {0}', date(snapshot.observedAt)),
      snapshot.truncated ? t('Showing the first 64 devices') : '',
    ].filter(Boolean),
    search = h('input', {
      className: 'text-input search',
      attrs: { 'type': 'search', 'placeholder': t('Find a device'), 'aria-label': t('Find a device'), 'autocomplete': 'off', 'enterkeyhint': 'search' },
    });
  search.value = memory.query;
  const root = h('div', { className: 'map' }, [
    h('div', { className: 'map-toolbar' }, [
      search,
      h('ul', { className: 'map-legend', attrs: { 'aria-label': t('Legend') } }, [
        h('li', {}, [h('i', { className: 'key online' }), t('Online')]),
        h('li', {}, [h('i', { className: 'key away' }), t('Not seen')]),
        h('li', {}, [h('i', { className: 'key unknown' }), t('Unknown')]),
      ]),
    ]),
    notes.length ? h('p', { className: 'map-note', attrs: { role: 'status' }, text: notes.join('. ') }) : null,
    hub(snapshot.devices, router, state),
    h('div', { className: 'branches' }, branches),
    h('p', { className: 'map-empty', attrs: { role: 'status' } }),
    methodNote(
      memory,
      'map',
      t('How to read the map'),
      t(
        'Branches group devices by the connection the router reports. A green dot means the device was seen in the latest scan, a grey dot that it was not, and a ring that its presence is unknown. Moving dots next to a rate mean the router reports traffic right now. Branches do not show physical cables. Drawings follow the device type set for each device, never its name.'
      )
    ),
  ]);
  search.addEventListener('input', () => {
    memory.query = search.value;
    applyFilter(root, memory.query, snapshot.devices.length);
  });
  applyFilter(root, memory.query, snapshot.devices.length);
  return [root];
}
