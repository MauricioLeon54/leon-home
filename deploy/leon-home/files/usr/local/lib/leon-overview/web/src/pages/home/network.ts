import type { HomeDevice, HomeView } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import { ago } from '../../core/format.js';
import { t } from '../../i18n/index.js';
import { badge } from '../../ui/badge.js';
import { emptyState } from '../../ui/empty.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';

export const VISIBLE_DEVICES = 6;
export interface NetworkActions {
  isExpanded: boolean;
  onToggle: () => void;
}

function presenceStrip(presence: ReadonlyArray<boolean>): HTMLElement {
  return h(
    'span',
    { className: 'strip', attrs: { 'aria-hidden': 'true' } },
    presence.map(isSeen => h('b', { className: isSeen ? 'on' : '' }))
  );
}

function deviceRow(device: HomeDevice): ListRow {
  return {
    kind: 'value',
    title: device.name,
    leading: { kind: 'dot', tone: 'good' },
    ...(device.detail ? { detail: device.detail } : {}),
    accessories: [
      ...(device.isNew ? [badge(t('New'), 'new')] : []),
      ...(device.isUnnamed ? [badge(t('Unnamed'))] : []),
      ...(device.isAuto ? [badge(t('Auto'))] : []),
      ...(device.presence.length ? [presenceStrip(device.presence)] : []),
    ],
  };
}

export function networkSection(view: HomeView, actions: NetworkActions): HTMLElement {
  const { devices, online, registeredNames, moves } = view.network,
    shown = actions.isExpanded ? devices : devices.slice(0, VISIBLE_DEVICES),
    hiddenCount = devices.length - VISIBLE_DEVICES,
    toggle = h('button', {
      className: 'link-button',
      text: actions.isExpanded ? t('Show fewer') : t('Show {0} more', hiddenCount),
      attrs: { 'type': 'button', 'aria-expanded': String(actions.isExpanded) },
      on: { click: actions.onToggle },
    });
  toggle.dataset.focusKey = 'network-toggle';
  return section({ title: t('Home network'), meta: t('{0} online', online), link: { label: t('Map'), href: '/network' } }, [
    devices.length ? list(shown.map(deviceRow)) : emptyState({ title: t('No inventory yet') }),
    hiddenCount > 0 ? toggle : null,
    h('p', { className: 'note', text: t('Names follow MAC addresses, even when IP addresses change. {0} registered.', registeredNames) }),
    ...[...moves].reverse().map(move => h('p', { className: 'note', text: t('{0} moved from {1} to {2}, {3}.', move.name, move.from, move.to, ago(move.at)) })),
  ]);
}

export function tailscaleSection(view: HomeView): HTMLElement {
  const peers = view.tailscale;
  if (peers === null) return section({ title: 'Tailscale', meta: t('No reading') }, [emptyState({ title: t('No data') })]);
  const onlineCount = peers.filter(peer => peer.online).length;
  return section({ title: 'Tailscale', meta: peers.length ? t('{0} of {1} online', onlineCount, peers.length) : t('No reading') }, [
    peers.length
      ? list(
          peers.map(peer => ({
            kind: 'value',
            title: peer.name,
            leading: { kind: 'dot', tone: peer.online ? 'good' : 'idle' },
            detail: peer.online ? `${peer.os} · ${peer.direct ? t('direct') : t('relay')}` : `${peer.os} · ${ago(peer.lastSeen)}`,
          }))
        )
      : emptyState({ title: t('No data') }),
  ]);
}
