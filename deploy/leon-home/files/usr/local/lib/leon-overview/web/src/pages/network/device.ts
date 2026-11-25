import { drawChart } from '../../charts.js';
import type { Device, Snapshot } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { artKind, drawing } from '../../deviceArt.js';
import { t } from '../../i18n/index.js';
import { date, mbps, svgNS } from '../../presentation.js';
import { parseSnapshot } from '../../snapshot.js';
import { emptyState } from '../../ui/empty.js';
import { list, type ListRow } from '../../ui/list.js';
import { card, section } from '../../ui/section.js';
import { bandName, signalText } from '../../wifi.js';
import { livePage } from '../settings/livePage.js';
import { createDeviceMemory, pauseRow, renameForm, scheduleBlock, wakeRow, wiredRow } from './deviceControls.js';
import { CONNECTION_NAMES, type NetworkState, presenceOf, scanCurrent, trafficCurrent } from './model.js';

const REFRESH_MS = 15_000;
const NOT_CURRENT = t('No current reading');

function description(presence: ReturnType<typeof presenceOf>, isScanCurrent: boolean): string {
  if (!isScanCurrent) return t('No current scan. Details are from an earlier reading.');
  return presence === 'online' ? t('Seen in the latest scan.') : presence === 'away' ? t('Not seen in the latest scan.') : t('Presence unknown.');
}

function detailRows(device: Device, state: NetworkState): Array<ListRow> {
  const presence = presenceOf(device, scanCurrent(state)),
    isCurrent = trafficCurrent(state),
    traffic = device.traffic,
    rows: Array<readonly [string, string]> = [
      [t('Address'), device.address],
      [t('Presence'), presence === 'online' ? t('Seen in the scan') : presence === 'away' ? t('Not seen in the scan') : t('Unknown')],
      [t('Last seen'), date(device.lastSeen)],
      [t('Type'), sentenceCase(device.role || device.kind) || t('Unidentified')],
      [t('Connection (router)'), traffic ? CONNECTION_NAMES[traffic.connection] : t('Unidentified')],
      [t('Download'), isCurrent && traffic ? t('{0} Mbps', mbps(traffic.downloadRouterMbps)) : NOT_CURRENT],
      [t('Upload'), isCurrent && traffic ? t('{0} Mbps', mbps(traffic.uploadRouterMbps)) : NOT_CURRENT],
    ];
  if (traffic?.port) rows.push([t('Router port'), `LAN ${traffic.port}`]);
  if (isCurrent && traffic?.band) rows.push([t('Wi-Fi band'), bandName(traffic.band)], [t('Signal'), signalText(traffic.signalDbm)]);
  if (device.isNew) rows.push([t('New device'), t('First seen in the last 24 hours')]);
  return rows.map(([title, value]) => ({ kind: 'value', title, value }));
}

/** Everything the old inspector sheet did, as a page of its own. */
export function renderDevice(context: RouteContext): PageView {
  const id = context.params.id ?? '',
    memory = createDeviceMemory();
  return livePage<Snapshot>({
    context,
    path: '/api/v1/network',
    parse: parseSnapshot,
    intervalMs: REFRESH_MS,
    observedAt: snapshot => snapshot.observedAt,
    build(snapshot, flags, controls) {
      const device = snapshot.devices.find(item => item.id === id);
      if (!device) {
        return [
          emptyState({ title: t('This device is not in the latest scan'), detail: t('It may have left the network or changed address.') }),
          section({}, [list([{ kind: 'navigation', title: t('Back to Network'), href: '/network' }])]),
        ];
      }
      context.setTitle(device.name);
      const state: NetworkState = { snapshot, hasFailed: flags.hasFailed },
        isScanCurrent = scanCurrent(state),
        presence = presenceOf(device, isScanCurrent),
        props = { device, snapshot, memory, token: context.session.actionToken, isReadOnly: flags.hasFailed, controls },
        access: Array<ListRow> = [pauseRow(props), wiredRow(props), wakeRow(props)].filter((row): row is ListRow => row !== null),
        rename = renameForm(props),
        schedule = scheduleBlock(props),
        chart = document.createElementNS(svgNS, 'svg');
      chart.setAttribute('class', 'net-chart');
      chart.setAttribute('viewBox', '0 0 300 120');
      chart.setAttribute('preserveAspectRatio', 'none');
      chart.setAttribute('aria-hidden', 'true');
      drawChart(
        chart,
        (device.traffic?.history ?? []).map(pair => [pair[0], pair[1]])
      );
      const children: Array<Child> = [
        h('div', { className: 'device-head' }, [
          h('span', { className: `device-art is-${presence}`, attrs: { 'aria-hidden': 'true' } }, [drawing(artKind(device))]),
          h('p', { className: 'note', text: description(presence, isScanCurrent) }),
        ]),
        access.length ? section({ title: t('Access') }, [list(access)]) : null,
        schedule.length ? section({}, schedule) : null,
        rename ? section({ title: t('Name') }, [rename]) : null,
        section({ title: t('Details') }, [list(detailRows(device, state))]),
        device.traffic ? section({ title: t('Traffic') }, [card([chart, h('div', { className: 'axis' }, [h('span', { text: t('Earlier') }), h('span', { text: t('now') })])])]) : null,
      ];
      return children;
    },
  });
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
