import { type DnsView, parseDns } from '../../contracts/dns.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { list } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import type { SwitchOutcome } from '../../ui/switch.js';
import { allowDomain, pauseDns, removeAllowedDomain, setDeviceFilter, setDnsBlocking } from '../home/dnsActions.js';
import { piholeSection } from '../home/pihole.js';
import { filteringSections } from './filtering.js';
import { livePage } from './livePage.js';

export function renderDns(context: RouteContext): PageView {
  let busy = false;
  return livePage<DnsView>({
    context,
    path: '/api/v1/dns',
    parse: parseDns,
    intervalMs: 30_000,
    observedAt: view => view.observedAt,
    build(view, state, controls) {
      async function run(work: () => Promise<SwitchOutcome>): Promise<SwitchOutcome> {
        if (busy) return 'cancelled';
        busy = true;
        controls.repaint();
        try {
          return await controls.run(work);
        } finally {
          busy = false;
          controls.repaint();
        }
      }
      const token = context.session.actionToken;
      return [
        piholeSection(
          view,
          { ...state, isStale: state.isStale || state.hasFailed },
          {
            isBusy: busy,
            onPause: seconds => void run(() => pauseDns(seconds, token)),
            setBlocking: enabled => run(() => setDnsBlocking(enabled, token)),
          }
        ),
        ...filteringSections(view.filtering, {
          isBusy: busy,
          allow: domain => void run(() => allowDomain(domain, token)),
          removeAllowed: domain => void run(() => removeAllowedDomain(domain, token)),
          setDeviceFilter: (address, name, paused) => void run(() => setDeviceFilter(address, name, paused, token)),
        }),
        section({}, [list([{ kind: 'navigation', title: t('Pi-hole admin'), detail: t('Lists, queries and settings'), href: view.links.piholeAdmin }])]),
      ];
    },
  });
}
