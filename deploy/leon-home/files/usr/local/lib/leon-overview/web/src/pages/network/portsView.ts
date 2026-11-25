import type { Port, Snapshot } from '../../contracts.js';
import type { Feedback } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import { feedbackFor, speed, time } from '../../presentation.js';
import { confirm } from '../../ui/confirm.js';
import { list, type ListRow } from '../../ui/list.js';
import { reading, readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { createSwitch } from '../../ui/switch.js';
import { bandName, signalText } from '../../wifi.js';
import type { LiveControls } from '../settings/livePage.js';
import { methodNote, type NetworkMemory, type NetworkState, sendNetworkAction, switchOutcome, trafficCurrent } from './model.js';

const OUTCOMES = {
  applied: ['good', t('Done. The router confirmed the change.')],
  unchanged: ['good', t('The port was already set.')],
  unverified: ['warn', t('The result is unconfirmed. The port may have changed. Check before trying again.')],
  protectedPort: ['warn', t('Protected port. Disabling it is not authorized.')],
  unknownPort: ['warn', t('The router does not report this port.')],
  locked: ['warn', t('The router session is locked. Ask your support person to unlock it.')],
  busy: ['warn', t('Wait a few seconds between actions.')],
  rejected: ['warn', t('The router rejected the change. It was not applied.')],
  invalid: ['warn', t('Invalid request. The change was not applied.')],
  forbidden: ['warn', t('Your session expired or access is denied. Reload the page.')],
  unavailable: ['warn', t('The router monitor is unavailable. The change was not applied.')],
  network: ['warn', t('No response. The change may have been applied. Check before trying again.')],
} satisfies Record<string, Feedback>;

export interface PortsProps {
  snapshot: Snapshot;
  state: NetworkState;
  memory: NetworkMemory;
  token: string;
  controls: LiveControls;
}

function portLabel(port: Port): string {
  return port.wan ? 'WAN' : `LAN ${port.port}`;
}
function isProtected(port: Port, snapshot: Snapshot): boolean {
  return port.wan === true || !snapshot.routerTelemetry.controllablePorts.includes(port.port);
}

/** The router's hardware-looking panel; selecting a port only changes which one the facts describe. */
function panel(ports: ReadonlyArray<Port>, { memory, controls }: PortsProps): HTMLElement {
  const buttons = ports.map(port => {
    const button = h(
      'button',
      {
        className: `port${port.enabled === false ? ' off' : ''}${memory.selectedPort === port.port ? ' selected' : ''}`,
        attrs: { 'type': 'button', 'role': 'option', 'aria-selected': String(memory.selectedPort === port.port) },
        dataset: { focusKey: `port-${port.port}` },
      },
      [
        h('span', { className: 'leds' }, [
          h('i', { className: `led ${port.link === 'up' ? 'on' : port.link === 'unknown' ? 'unknown' : ''}` }),
          h('i', { className: `led ${port.enabled === false ? 'amber' : port.link === 'up' ? 'on' : ''}` }),
        ]),
        h('span', { className: 'jack' }),
        h('b', { text: portLabel(port) }),
        h('small', { text: port.enabled === false ? t('Disabled') : port.link === 'up' ? speed(port.speedMbps) : port.link === 'down' ? t('No cable') : t('Unknown') }),
      ]
    );
    button.addEventListener('click', () => {
      memory.selectedPort = port.port;
      memory.portOutcome = null;
      controls.repaint();
    });
    return button;
  });
  return h('div', { className: 'port-panel', attrs: { 'role': 'listbox', 'aria-label': t('Router ports') } }, buttons);
}

function facts(port: Port, state: NetworkState): HTMLElement {
  const known = (value: string): string | null => (value === 'Unknown' || value === '—' ? null : value);
  return readingGrid(
    [
      [t('Link'), port.link === 'up' ? t('Connected') : port.link === 'down' ? t('No link') : t('Unknown')],
      [t('Speed'), port.link === 'up' ? speed(port.speedMbps) : '—'],
      [t('Duplex'), port.duplex === 'full' ? t('Full') : port.duplex === 'half' ? t('Half') : '—'],
      [t('Status'), port.enabled === true ? t('Enabled') : port.enabled === false ? t('Disabled') : t('Unknown')],
    ].map(([label, value]) => reading({ label: label ?? '', value: known(value ?? ''), state: trafficCurrent(state) ? { kind: 'current' } : { kind: 'unknown' } }))
  );
}

async function setPort(port: Port, enabled: boolean, props: PortsProps): Promise<'applied' | 'refused' | 'unverified' | 'cancelled'> {
  const { memory, token } = props;
  if (memory.isActing) return 'cancelled';
  memory.selectedPort = port.port;
  if (!enabled) {
    const isConfirmed = await confirm({
      title: t('Disable port {0}?', port.port),
      message:
        port.link === 'up'
          ? t('A connected device will lose its wired connection until you enable the port again. Power stays on.')
          : t('The port has no link now. A device connected here will have no network until the port is enabled.'),
      confirmLabel: t('Disable'),
      tone: 'danger',
    });
    if (!isConfirmed) return 'cancelled';
  }
  memory.isActing = true;
  memory.portOutcome = null;
  let status: string;
  try {
    status = await sendNetworkAction('/api/v1/network/port', { port: port.port, enabled }, token, { requireOk: true });
  } finally {
    memory.isActing = false;
  }
  memory.portOutcome = { port: port.port, status };
  return switchOutcome(status);
}

/** One switch per port. While pending it shows the requested position; afterwards only the router's re-read moves it. */
function switches(ports: ReadonlyArray<Port>, props: PortsProps): HTMLElement {
  const { snapshot, memory, state } = props,
    rows = ports.map((port): ListRow => {
      const locked = port.enabled !== false && isProtected(port, snapshot),
        outcome = memory.portOutcome?.port === port.port ? feedbackFor(OUTCOMES, memory.portOutcome.status, 'invalid') : null,
        detail =
          outcome?.[1] ??
          (port.wan
            ? t('WAN port · always protected')
            : locked
              ? t('Protected · not in the allowed list')
              : port.enabled === false
                ? t('Disabled')
                : port.link === 'up'
                  ? t('Enabled · {0}', speed(port.speedMbps))
                  : port.enabled === true
                    ? t('Enabled · no cable')
                    : t('Unknown state')),
        toggle = createSwitch({
          label: t('{0} enabled', port.wan ? 'WAN' : t('Port {0}', port.port)),
          checked: port.enabled,
          isDisabled: state.hasFailed || props.token === '' || locked,
          onChange: requested => props.controls.run(() => setPort(port, requested, props)),
        });
      return { kind: 'switch', title: portLabel(port), detail, control: toggle.element };
    });
  return list(rows);
}

function wifiSection(snapshot: Snapshot, state: NetworkState): HTMLElement {
  const isCurrent = trafficCurrent(state),
    wifi = snapshot.routerTelemetry.wifi,
    meta = isCurrent ? t('Router, {0}', time(snapshot.routerTelemetry.observedAt)) : t('No current reading');
  if (!isCurrent) return section({ title: 'Wi-Fi', meta }, [h('p', { className: 'note', text: t('No current Wi-Fi reading. Unlock the router session to see readings.') })]);
  const networks: Array<ListRow> = [];
  for (const network of wifi?.networks ?? []) {
    if (!network.ssid) continue;
    const band = bandName(network.band) !== t('Unknown') ? bandName(network.band) : network.band || t('Unknown band'),
      // Counted from the router's own device list (devices on that band now), not its configured limits.
      onBand = snapshot.devices.filter(device => device.traffic?.band && String(device.traffic.band).startsWith(String(network.band).slice(0, 3))).length,
      isOff = network.WifiEnable === false;
    networks.push({
      kind: 'value',
      title: `${network.ssid}, ${band}`,
      detail: isOff ? t('Turned off') : `${network.Channel ? t('Channel {0}', String(network.Channel)) : t('Automatic channel')} · ${onBand} ${onBand === 1 ? t('device') : t('devices')}`,
      value: isOff ? t('Off') : t('On'),
      leading: { kind: 'dot', tone: isOff ? 'idle' : 'good' },
    });
  }
  const guest = wifi?.guest;
  if (guest) {
    const minutes = typeof guest.restSeconds === 'number' ? Math.round(guest.restSeconds / 60) : null,
      left = minutes === null ? t('No time limit reported') : minutes >= 60 ? t('{0} h {1} min left', Math.floor(minutes / 60), minutes % 60) : t('{0} min left', minutes);
    networks.push({
      kind: 'value',
      title: t('Guest network{0}', guest.ssid ? `, ${guest.ssid}` : ''),
      detail: guest.enabled ? left : t('Turned off'),
      value: guest.enabled ? t('On') : t('Off'),
      leading: { kind: 'dot', tone: guest.enabled ? 'good' : 'idle' },
    });
  }
  // Weakest first: the devices worth moving closer or switching band.
  const weak = snapshot.devices.filter(device => device.traffic?.band).sort((a, b) => (a.traffic?.signalDbm ?? 0) - (b.traffic?.signalDbm ?? 0)),
    signals = weak.map((device): ListRow => {
      const dbm = device.traffic?.signalDbm,
        level = typeof dbm !== 'number' ? '' : dbm >= -60 ? 'good' : dbm >= -70 ? 'ok' : 'weak',
        lit = level === 'good' ? 3 : level === 'ok' ? 2 : level === 'weak' ? 1 : 0;
      return {
        kind: 'value',
        title: device.name,
        detail: `${bandName(device.traffic?.band)} · ${signalText(dbm)}`,
        accessories: [
          h(
            'span',
            { className: `signal ${level}`, attrs: { 'aria-hidden': 'true' } },
            [0, 1, 2].map(index => h('i', { className: index < lit ? 'on' : '' }))
          ),
        ],
      };
    });
  const children: Array<Child> = [];
  if (networks.length) children.push(list(networks));
  children.push(signals.length ? h('div', { className: 'spaced' }, [list(signals)]) : h('p', { className: 'note', text: t('The router does not report any active Wi-Fi devices.') }));
  children.push(h('p', { className: 'note', text: t('Band and signal strength reported by the router at the access point. Weak: below −70 dBm.') }));
  return section({ title: 'Wi-Fi', meta }, children);
}

export function portsView(props: PortsProps): Array<Child> {
  const { snapshot, state, memory } = props,
    ports = snapshot.routerTelemetry.ports,
    isCurrent = trafficCurrent(state),
    selected = ports?.find(port => port.port === memory.selectedPort),
    body: Array<Child> =
      !isCurrent || !ports
        ? [h('p', { className: 'note', text: t('No current port reading. Unlock the router session to see readings.') })]
        : [panel(ports, props), selected ? card([facts(selected, state)]) : null, h('div', { className: 'spaced' }, [switches(ports, props)])];
  return [
    section({ title: t('Ethernet ports'), meta: isCurrent && ports ? t('Router, {0}', time(snapshot.routerTelemetry.observedAt)) : t('No current reading') }, [
      ...body,
      methodNote(
        memory,
        'ports',
        t('How port control works'),
        t(
          'Disabling a port disconnects its Ethernet link without cutting power to the connected device. Only ports authorized on the Pi (/etc/leon-router/controllable-ports) can be disabled. The WAN port and other ports stay protected to preserve access. Enabling a port is always allowed. LEÓN verifies the result with a fresh router reading and never retries an action automatically.'
        )
      ),
    ]),
    wifiSection(snapshot, state),
  ];
}
