import type { HomeView } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import { count } from '../../core/format.js';
import { t } from '../../i18n/index.js';
import { button } from '../../ui/button.js';
import { barChart } from '../../ui/chart.js';
import { emptyState } from '../../ui/empty.js';
import { list } from '../../ui/list.js';
import { readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { type HomeContext, textMetric } from './context.js';

export type PauseSeconds = 300 | 1800;
export interface PiHoleActions {
  isBusy: boolean;
  onPause: (seconds: PauseSeconds) => void;
  onResume: () => void;
}

function stateText(pihole: NonNullable<HomeView['pihole']>): string {
  if (pihole.blocking === 'enabled') return t('Blocking on');
  return pihole.pausedSecondsLeft ? t('Paused · {0} min left', Math.floor(pihole.pausedSecondsLeft / 60)) : t('Blocking paused');
}

function controls(pihole: NonNullable<HomeView['pihole']>, actions: PiHoleActions): HTMLElement {
  const buttons =
    pihole.blocking === 'enabled'
      ? [
          button({ label: t('Pause 5 min'), isDisabled: actions.isBusy, onPress: () => actions.onPause(300) }),
          button({ label: t('Pause 30 min'), isDisabled: actions.isBusy, onPress: () => actions.onPause(1800) }),
        ]
      : [button({ label: t('Resume blocking'), variant: 'primary', isDisabled: actions.isBusy, onPress: actions.onResume })];
  for (const element of buttons) element.dataset.focusKey = `pihole-${element.textContent ?? ''}`;
  return h('div', { className: 'buttons' }, buttons);
}

function topList(title: string, rows: ReadonlyArray<{ name: string; count: number }>): HTMLElement {
  return h('div', {}, [h('h3', { className: 'subhead', text: title }), list(rows.map(row => ({ kind: 'value', title: row.name, value: count(row.count) })))]);
}

export function piholeSection(view: HomeView, context: HomeContext, actions: PiHoleActions): HTMLElement {
  const { pihole } = view;
  if (!pihole) {
    return section({ title: 'Pi-hole', meta: t('No reading'), tone: 'warn' }, [emptyState({ title: t('Pi-hole did not answer'), detail: t('Its blocking state is unknown until it does.') })]);
  }
  return section({ title: 'Pi-hole', meta: stateText(pihole), tone: pihole.blocking === 'enabled' ? 'good' : 'warn' }, [
    card([
      readingGrid(
        [
          textMetric(context, t('Blocked today'), `${pihole.percentBlocked.toFixed(1)}%`),
          textMetric(context, t('Queries'), count(pihole.queries)),
          textMetric(context, t('Blocked'), count(pihole.blocked)),
        ],
        3
      ),
      pihole.hours.length === 0
        ? null
        : h('div', { className: 'chart-block' }, [
            h('div', { className: 'legend' }, [
              h('span', {}, [h('i', { className: 'swatch is-total' }), t('Queries')]),
              h('span', {}, [h('i', { className: 'swatch is-blocked' }), t('Blocked')]),
              h('span', { className: 'legend-span', text: t('Last 24 hours') }),
            ]),
            barChart(pihole.hours, t('Queries per hour')),
          ]),
      controls(pihole, actions),
      h('p', { className: 'note', text: t('{0} domains on blocklists, {1} active clients', count(pihole.domainsOnBlocklists), count(pihole.activeClients)) }),
    ]),
    pihole.topBlocked.length === 0 ? null : topList(t('Most blocked domains'), pihole.topBlocked),
    pihole.topClients.length === 0 ? null : topList(t('Most active clients'), pihole.topClients),
  ]);
}
