import { type Snapshot } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { time } from '../../presentation.js';
import { parseSnapshot } from '../../snapshot.js';
import { createSegmented } from '../../ui/segmented.js';
import { statusDot, type StatusTone } from '../../ui/statusDot.js';
import { livePage } from '../settings/livePage.js';
import { mapView } from './mapView.js';
import { createMemory, type NetworkState, scanCurrent, trafficCurrent } from './model.js';
import { portsView } from './portsView.js';
import { trafficView } from './trafficView.js';
import { unlockSection } from './unlock.js';

const REFRESH_MS = 15_000;
type View = 'map' | 'traffic' | 'ports';
const VIEWS: ReadonlyArray<View> = ['map', 'traffic', 'ports'];

function chip(tone: StatusTone, label: string): HTMLElement {
  return h('span', { className: 'chip' }, [statusDot(tone), label]);
}

/** Scan freshness and router state, worded as the map has always worded them. */
function statusRow(snapshot: Snapshot, state: NetworkState): HTMLElement {
  const scan = scanCurrent(state),
    status = snapshot.routerTelemetry.status,
    isLive = trafficCurrent(state);
  return h('div', { className: 'net-status', attrs: { 'aria-label': t('Reading status') } }, [
    chip(
      scan ? 'good' : 'warn',
      state.hasFailed
        ? t('Offline · previous readings')
        : scan
          ? t('Scan {0}', time(snapshot.observedAt))
          : Boolean(snapshot.observedAt)
            ? t('Earlier scan {0}', time(snapshot.observedAt))
            : t('No scan yet')
    ),
    chip(isLive ? 'good' : 'warn', isLive ? t('Router live') : status === 'locked' ? t('Router locked') : status === 'error' ? t('Session ended') : t('No router reading')),
  ]);
}

/** Network tab: Map, Traffic and Ports share one snapshot; the view lives in ?view= (replaceState). */
export function renderNetwork(context: RouteContext): PageView {
  const requested = context.query.get('view'),
    requestedPort = Number(context.query.get('port')),
    memory = createMemory(Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 8 ? requestedPort : null);
  let view: View = VIEWS.find(item => item === requested) ?? (memory.selectedPort !== null ? 'ports' : 'map');
  let canReuse = false;
  return livePage<Snapshot>({
    context,
    path: '/api/v1/network',
    parse: parseSnapshot,
    intervalMs: REFRESH_MS,
    reuseReadOnlyDOM: () => canReuse && view !== 'ports',
    observedAt: snapshot => snapshot.observedAt,
    build(snapshot, flags, controls) {
      const state: NetworkState = { snapshot, hasFailed: flags.hasFailed },
        token = context.session.actionToken,
        routerStatus = snapshot.routerTelemetry.status,
        isLocked = (routerStatus === 'locked' || routerStatus === 'error') && !state.hasFailed,
        segmented = createSegmented<View>({
          label: t('Network views'),
          options: [
            { value: 'map', label: t('Map') },
            { value: 'traffic', label: t('Traffic') },
            { value: 'ports', label: t('Ports') },
          ],
          value: view,
          onChange(next) {
            view = next;
            history.replaceState(history.state, '', next === 'map' ? '/network' : `/network?view=${next}`);
            controls.repaint();
          },
        }),
        content: Array<Child> = view === 'map' ? mapView(snapshot, state, memory) : view === 'traffic' ? trafficView(snapshot, state, memory) : portsView({ snapshot, state, memory, token, controls });
      for (const segment of segmented.element.querySelectorAll('button')) segment.dataset.focusKey = `network-view-${segment.textContent}`;
      canReuse = routerStatus === 'current';
      memory.hasPainted = true;
      return [
        h('div', { className: 'net-controls' }, [segmented.element, statusRow(snapshot, state)]),
        isLocked
          ? unlockSection({
              state: memory.unlock,
              unlockBy: snapshot.routerTelemetry.unlockBy,
              isReconnecting: snapshot.routerTelemetry.isReconnecting,
              token,
              run: work => controls.run(work),
              explanation:
                snapshot.routerTelemetry.unlockBy === 'password'
                  ? t('Type the router password once. LEÓN remembers it on this Pi and reconnects by itself.')
                  : routerStatus === 'error'
                    ? t('The router session stopped responding. LEÓN does not retry passwords. Unlock it again.')
                    : t('The router session starts locked after the Pi or monitor restarts. The inventory map remains available.'),
            })
          : null,
        h('div', { className: 'net-view', dataset: { view } }, content.length ? content : []),
      ];
    },
  });
}
