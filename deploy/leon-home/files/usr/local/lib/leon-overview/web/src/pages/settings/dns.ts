import { type HomeView, parseHome } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { emptyState } from '../../ui/empty.js';
import { list } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { pauseDns, resumeDns } from '../home/dnsActions.js';
import { piholeSection } from '../home/pihole.js';
import { livePage } from './livePage.js';

export function renderDns(context: RouteContext): PageView {
  const token = () => context.session.actionToken;
  return livePage<HomeView>({
    context,
    path: '/api/v1/home',
    parse: parseHome,
    intervalMs: 30_000,
    observedAt: view => view.observedAt,
    build(view, state, controls) {
      const run = (work: () => Promise<void>) => void controls.run(work);
      return [
        view.pihole
          ? piholeSection(view, state, { isBusy: false, onPause: seconds => run(() => pauseDns(seconds, token())), onResume: () => run(() => resumeDns(token())) })
          : emptyState({ title: t('Pi-hole did not answer'), detail: t('Its blocking state is unknown until it does.') }),
        section({}, [
          list([{ kind: 'navigation', title: t('Pi-hole admin'), detail: t('Lists, queries and settings'), href: view.links.piholeAdmin }]),
          h('p', { className: 'note', text: t('Pausing blocking is temporary; it resumes by itself.') }),
        ]),
      ];
    },
  });
}
