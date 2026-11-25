import { h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { languageSection } from './languageSection.js';

/** Phase 2 adds Raspberry Pi, DNS and devices here; only pages that exist are listed. */
export function renderSettings(context: RouteContext): PageView {
  const network: Array<ListRow> = [
    { kind: 'navigation', title: t('Router & ports'), href: '/network?view=ports' },
    { kind: 'navigation', title: t('Drives & sharing'), href: '/storage' },
    ...(context.session.features.automation ? [{ kind: 'navigation', title: t('Automation'), href: '/storage/automation' } satisfies ListRow] : []),
  ];
  return {
    element: h('div', { className: 'page' }, [
      section({}, [
        list([
          { kind: 'navigation', title: 'Raspberry Pi', href: '/settings/raspberry' },
          { kind: 'navigation', title: t('DNS & filtering'), href: '/settings/dns' },
        ]),
      ]),
      section({}, [list(network)]),
      languageSection(),
      section({}, [list([{ kind: 'navigation', title: t('Pi-hole admin'), detail: t('Opens the Pi-hole console'), href: '/admin/' }])]),
      section({}, [
        list([
          ...(context.session.features.updates
            ? [
                {
                  kind: 'navigation',
                  title: t('Updates'),
                  href: '/updates',
                  ...(context.session.availableVersion === null ? {} : { value: t('{0} available', context.session.availableVersion) }),
                } satisfies ListRow,
              ]
            : []),
          { kind: 'navigation', title: t('About'), href: '/settings/about', ...(context.session.version === null ? {} : { value: context.session.version }) },
        ]),
      ]),
    ]),
  };
}
