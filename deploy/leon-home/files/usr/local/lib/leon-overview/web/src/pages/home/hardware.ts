import type { HomeView } from '../../contracts/home.js';
import { h } from '../../core/dom.js';
import { bytes, celsius, percent } from '../../core/format.js';
import { serverText, t } from '../../i18n/index.js';
import { sparkline } from '../../ui/chart.js';
import { list } from '../../ui/list.js';
import { readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { type HomeContext, metric, textMetric } from './context.js';

const HOT_CELSIUS = 70;

export function piSection(view: HomeView, context: HomeContext): HTMLElement {
  const { pi } = view,
    isHot = (pi.temperatureCelsius ?? 0) >= HOT_CELSIUS,
    meta =
      [pi.temperatureCelsius === null ? '' : celsius(pi.temperatureCelsius), pi.cpuPercent === null ? '' : t('{0} CPU', percent(pi.cpuPercent)), pi.rebootRequired ? t('restart needed') : '']
        .filter(Boolean)
        .join(' · ') || t('No reading'),
    chart = sparkline(pi.temperatureHistory, t('Temperature, last 24 hours')),
    temperatures = pi.temperatureHistory.map(point => point[1]);
  return section({ title: 'Raspberry Pi', meta, tone: isHot || pi.rebootRequired ? 'warn' : undefined, link: { label: t('Settings'), href: '/settings/raspberry' } }, [
    card([
      readingGrid(
        [
          metric({ ...context, tone: isHot ? 'warn' : undefined }, t('Temperature'), pi.temperatureCelsius, celsius),
          metric(context, t('CPU'), pi.cpuPercent, value => percent(value)),
          metric(context, t('Load'), pi.load1, value => value.toFixed(2)),
          metric(context, t('Free memory'), pi.memoryAvailableBytes, bytes),
          metric(context, t('Free storage'), pi.storageFreeBytes, bytes),
          textMetric(context, t('Power'), serverText(pi.power.label), pi.power.needsAttention ? 'warn' : undefined),
        ],
        3
      ),
      h('h3', { className: 'subhead', text: t('Temperature, last 24 hours') }),
      chart ?? h('p', { className: 'note', text: t('The chart appears after a few minutes of readings.') }),
      chart ? h('div', { className: 'axis' }, [h('span', { text: t('min {0}', celsius(Math.min(...temperatures))) }), h('span', { text: t('max {0}', celsius(Math.max(...temperatures))) })]) : null,
      pi.rebootRequired ? h('p', { className: 'note', text: t('Restart needed after system updates.') }) : null,
    ]),
  ]);
}

export function servicesSection(view: HomeView): HTMLElement {
  const { services } = view,
    stopped = services.filter(service => !service.running).length;
  return section({ title: t('Services'), meta: stopped ? t('{0} stopped', stopped) : services.length ? t('All {0} running', services.length) : t('No reading'), tone: stopped ? 'warn' : undefined }, [
    list(
      services.map(service => ({
        kind: 'value',
        title: serverText(service.label),
        leading: { kind: 'dot', tone: service.running ? 'good' : 'warn' },
        ...(service.running ? {} : { value: serverText(service.state) }),
      }))
    ),
  ]);
}
