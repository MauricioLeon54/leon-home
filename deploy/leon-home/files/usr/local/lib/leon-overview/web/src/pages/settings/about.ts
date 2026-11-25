import { h } from '../../core/dom.js';
import { UNKNOWN } from '../../core/format.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';

export function renderAbout({ session }: RouteContext): PageView {
  const update: Array<ListRow> =
    session.availableVersion === null ? [] : [{ kind: 'navigation', title: t('An update is available'), value: session.availableVersion, href: '/updates', leading: { kind: 'dot', tone: 'warn' } }];
  return {
    element: h('div', { className: 'page' }, [
      section({}, [
        list([
          { kind: 'value', title: t('Version'), value: session.version ?? UNKNOWN },
          ...update,
          { kind: 'value', title: t('Node'), value: session.node },
          { kind: 'value', title: t('Signed in as'), value: session.login },
        ]),
        h('p', { className: 'note', text: t('Private to your Tailscale account.') }),
      ]),
    ]),
  };
}
