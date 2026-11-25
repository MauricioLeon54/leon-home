import type { HomeView } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import { ago, bytes } from '../../core/format.js';
import { serverText, t } from '../../i18n/index.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { type StatusTone } from '../../ui/statusDot.js';

export function backupsSection(view: HomeView): HTMLElement {
  const { latest, isFresh, repositories } = view.backups,
    rows: Array<ListRow> = [
      {
        kind: 'value',
        title: t('Encrypted backup'),
        leading: { kind: 'dot', tone: latest && isFresh ? 'good' : 'warn' },
        detail: latest ? t('{0} · {1} · {2} copies', ago(latest.at), bytes(latest.bytes), latest.count) : t('no backups'),
      },
      ...repositories.map((repository): ListRow => ({ kind: 'value', title: repository.name, leading: { kind: 'dot', tone: 'good' }, detail: `${repository.branch} · ${ago(repository.at)}` })),
    ];
  return section({ title: t('Backups and source'), meta: latest ? t('Last backup {0}', ago(latest.at)) : t('No backups'), tone: isFresh ? undefined : 'warn' }, [list(rows)]);
}

const TABLET_TONES = { good: 'good', warn: 'warn', unknown: 'unknown' } satisfies Record<'good' | 'warn' | 'unknown', StatusTone>;

/** The tablet keeps its server-side wording; absent when nothing is configured and nothing was read. */
export function tabletSection(view: HomeView): HTMLElement | null {
  const { tablet } = view;
  if (!tablet) return null;
  return section({ title: t('Tablet'), meta: serverText(tablet.summary), tone: tablet.tone === 'unknown' ? undefined : tablet.tone }, [
    list(tablet.rows.map((row): ListRow => ({ kind: 'value', title: serverText(row.label), detail: serverText(row.detail), leading: { kind: 'dot', tone: TABLET_TONES[row.tone] } }))),
    ...tablet.notes.map(note => h('p', { className: 'note', text: serverText(note) })),
  ]);
}

export function linksSection(view: HomeView): HTMLElement {
  const { piholeAdmin, routerSettings } = view.links;
  return section({}, [
    list([
      { kind: 'navigation', title: t('Pi-hole admin'), href: piholeAdmin },
      ...(routerSettings ? [{ kind: 'navigation', title: t('Router settings'), href: routerSettings } satisfies ListRow] : []),
    ]),
  ]);
}
