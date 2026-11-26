import type { HomeView } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import { clock, count, duration, milliseconds } from '../../core/format.js';
import { serverText, t } from '../../i18n/index.js';
import { list } from '../../ui/list.js';
import { readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { type HomeContext, metric, textMetric } from './context.js';

function headline(issueCount: number): string {
  if (issueCount === 0) return t('Everything is running');
  return issueCount === 1 ? t('One thing needs attention') : t('{0} things need attention', issueCount);
}

/** The one large moment: a sentence, only the issues, then three quiet facts. */
export function statusSection(view: HomeView, context: HomeContext): HTMLElement {
  const { status } = view,
    hasIssues = status.issues.length > 0,
    facts = [
      Boolean(status.uptimeSeconds) ? t('Up {0}', duration(status.uptimeSeconds)) : null,
      Boolean(status.servicesTotal) ? t('{0} of {1} services running', count(status.servicesRunning), count(status.servicesTotal)) : null,
      status.temperatureCelsius === null ? null : `${Math.round(status.temperatureCelsius)} °C`,
      context.observedAt === null ? null : `${context.isStale ? t('Earlier') : t('Updated')} ${clock(context.observedAt)}`,
    ].filter((fact): fact is string => fact !== null);
  return h('section', { className: `status${hasIssues ? ' has-issues' : ''}${context.isStale ? ' is-stale' : ''}` }, [
    h('p', { className: 'status-line', attrs: { 'role': 'heading', 'aria-level': '2' } }, [
      h('i', { className: `status-dot is-${hasIssues ? 'warn' : 'good'}`, attrs: { 'aria-hidden': 'true' } }),
      headline(status.issues.length),
    ]),
    hasIssues ? list(status.issues.map(issue => ({ kind: 'value', title: serverText(issue), leading: { kind: 'dot', tone: 'warn' } }))) : null,
    h(
      'p',
      { className: 'facts' },
      facts.map(fact => h('span', { text: fact }))
    ),
  ]);
}

export function internetSection(view: HomeView, context: HomeContext): HTMLElement {
  const { internet } = view,
    isOffline = internet.state === 'offline',
    meta = isOffline ? t('No connection') : internet.state === 'connected' ? t('Connected') : t('No reading');
  return section({ title: t('Internet'), meta, tone: isOffline ? 'warn' : internet.state === 'connected' ? 'good' : undefined }, [
    card([
      readingGrid([
        isOffline ? textMetric(context, t('Internet'), t('Offline'), 'warn') : metric(context, t('Internet'), internet.internetMs, milliseconds),
        metric(context, t('Router'), internet.routerMs, milliseconds),
        metric(context, t('Router DNS'), internet.routerDnsMs, milliseconds),
        metric(context, t('Encrypted DNS'), internet.encryptedDnsMs, milliseconds),
      ]),
      h('p', { className: 'note', text: t('Round-trip times measured by the Pi.') }),
    ]),
  ]);
}
