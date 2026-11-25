import type { HomeView } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import { emptyState } from '../../ui/empty.js';
import { type HomeContext } from './context.js';
import { piSection, servicesSection } from './hardware.js';
import { type NetworkActions, networkSection, tailscaleSection } from './network.js';
import { backupsSection, linksSection, tabletSection } from './other.js';
import { type PiHoleActions, piholeSection } from './pihole.js';
import { internetSection, statusSection } from './status.js';

export interface HomeActions {
  pihole: PiHoleActions;
  network: NetworkActions;
}

/** Order matters: status, then what is happening, what I can do, then the rest of the home. */
export function homeSections(view: HomeView, context: HomeContext, actions: HomeActions): Array<HTMLElement> {
  if (view.observedAt === null) {
    return [emptyState({ title: t('Preparing readings…'), detail: t('The first sample takes a few seconds.') }), linksSection(view)];
  }
  const tablet = tabletSection(view);
  return [
    statusSection(view, context),
    internetSection(view, context),
    piholeSection(view, context, actions.pihole),
    h('div', { className: 'pair' }, [piSection(view, context), servicesSection(view)]),
    networkSection(view, actions.network),
    h('div', { className: 'pair' }, [tailscaleSection(view), backupsSection(view)]),
    ...(tablet ? [tablet] : []),
    linksSection(view),
  ];
}
