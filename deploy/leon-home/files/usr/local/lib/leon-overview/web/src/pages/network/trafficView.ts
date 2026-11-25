import { drawChart } from '../../charts.js';
import type { Device, InternetHealth, Snapshot, Traffic } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import { date, icon, mbps, svgNS, time } from '../../presentation.js';
import { reading, readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { devicePath, methodNote, type NetworkMemory, type NetworkState, trafficCurrent } from './model.js';

const CAUSES = { provider: t('Provider or modem'), home: t('Home network') };

function minutes(seconds: number): string {
  const total = Math.max(1, Math.round(seconds / 60));
  return total >= 60 ? t('{0} h {1} min', Math.floor(total / 60), total % 60) : t('{0} min', total);
}
function chart(className: string, label: string | null): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', `net-chart ${className}`);
  svg.setAttribute('viewBox', '0 0 300 120');
  svg.setAttribute('preserveAspectRatio', 'none');
  if (label) svg.setAttribute('aria-label', label);
  else svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** CSSOM, not a style attribute: the page CSP forbids inline styles. */
function rateBar(percent: number): HTMLElement {
  const bar = h('div', { className: 'bar' });
  bar.style.width = `${Math.max(2, percent)}%`;
  return bar;
}

function totals(snapshot: Snapshot, state: NetworkState): Array<Child> {
  const router = snapshot.routerTelemetry,
    samples = router.history.samples,
    latest = samples[samples.length - 1],
    isCurrent = trafficCurrent(state),
    figure = (index: 1 | 2, label: string, kind: 'd' | 'u') =>
      h('div', { className: 'total' }, [
        h('span', {}, [h('i', { className: `swatch is-${kind}` }), label]),
        h('b', {}, isCurrent && latest && typeof latest[index] === 'number' ? [mbps(latest[index]), h('small', { text: ' Mbps' })] : ['—']),
      ]),
    svg = chart('', t('Traffic over the last few minutes'));
  drawChart(
    svg,
    samples.map(sample => [sample[1], sample[2]])
  );
  return [
    section({ title: t('Right now'), meta: isCurrent ? t('Router, {0}', time(router.observedAt)) : t('No current reading') }, [
      card([
        h('div', { className: 'totals' }, [figure(1, t('Download'), 'd'), figure(2, t('Upload'), 'u')]),
        svg,
        h('div', { className: 'axis' }, [h('span', { text: samples.length ? time(samples[0]?.[0]) : '' }), h('span', { text: t('now') })]),
        h('p', { className: 'note', text: t('Sum of the rates the router reports for active devices. This is not a speed test.') }),
      ]),
    ]),
  ];
}

function deviceRows(snapshot: Snapshot, state: NetworkState): HTMLElement {
  const isCurrent = trafficCurrent(state),
    rows = snapshot.devices
      .filter((device): device is Device & { traffic: Traffic } => device.traffic !== null)
      .sort((left, right) => (right.traffic.downloadRouterMbps ?? -1) - (left.traffic.downloadRouterMbps ?? -1)),
    top = Math.max(1, ...rows.map(device => device.traffic.downloadRouterMbps || 0)),
    meta = rows.length ? `${rows.length} ${rows.length === 1 ? t('device') : t('devices')}` : undefined;
  const items = rows.map(device => {
    const spark = chart('spark', null);
    drawChart(spark, device.traffic.history);
    return h('li', { className: 'list-item' }, [
      h('a', { className: 'traffic-row', attrs: { href: devicePath(device.id) }, dataset: { focusKey: device.id } }, [
        h('span', { className: 'icon-badge' }, [icon(device.traffic.connection, 'k')]),
        h('div', { className: 'name' }, [device.name, h('small', { text: device.address }), isCurrent ? rateBar(((device.traffic.downloadRouterMbps || 0) / top) * 100) : null]),
        spark,
        h('div', { className: 'num' }, [
          h('span', { className: 'd', text: isCurrent ? `↓ ${mbps(device.traffic.downloadRouterMbps)}` : '—' }),
          h('span', { className: 'u', text: isCurrent ? `↑ ${mbps(device.traffic.uploadRouterMbps)}` : '' }),
        ]),
      ]),
    ]);
  });
  return section({ title: t('By device'), ...(meta ? { meta } : {}) }, [
    rows.length
      ? h('ul', { className: 'list traffic-list' }, items)
      : h('p', { className: 'note', text: isCurrent ? t('No device is reporting traffic right now.') : t('No current router reading. Unlock the router session to see traffic by device.') }),
  ]);
}

function outageRows(health: InternetHealth | null): HTMLElement {
  const outages = [...(health?.outages ?? [])].reverse();
  if (!outages.length) return h('p', { className: 'note', text: health?.samples ? t('No outages in the last 24 hours.') : t('No history yet.') });
  return h(
    'ul',
    { className: 'list' },
    outages.map(outage =>
      h('li', { className: 'list-item' }, [
        h('div', { className: 'row' }, [
          h('span', { className: 'row-body' }, [
            h('span', { className: 'row-title', text: (outage.end === null ? t('Ongoing since ') : '') + date(outage.start) }),
            h('span', { className: 'row-detail', text: CAUSES[outage.cause] }),
          ]),
          h('span', { className: 'row-value', text: minutes(outage.seconds) }),
        ]),
      ])
    )
  );
}

function internetSection(snapshot: Snapshot, memory: NetworkMemory): HTMLElement {
  const health = snapshot.internet,
    current = health?.current,
    state = current ? { kind: 'current' as const } : { kind: 'unknown' as const },
    availability = typeof health?.availability === 'number' ? `${health.availability.toFixed(health.availability === 100 ? 0 : 1)}%` : null,
    internetMs = typeof current?.internetMs === 'number' ? `${Math.round(current.internetMs)} ms` : null,
    routerMs = typeof current?.routerMs === 'number' ? `${current.routerMs.toFixed(1)} ms` : null,
    routerLoss = typeof current?.routerLossPercent === 'number' ? `${current.routerLossPercent}%` : null,
    status = !current ? null : current.state === 'up' ? t('Online') : t('Outage'),
    dnsMs = typeof current?.dnsMs === 'number' ? `${Math.round(current.dnsMs)} ms` : null;
  const latencyHistory = (title: string, values: Array<number | null>): Array<Child> => {
    const svg = chart('latency', title);
    drawChart(
      svg,
      values.map(value => [value, null]),
      ['latency', 'u']
    );
    return [
      h('h3', { className: 'subhead', text: title }),
      card([
        values.some(value => value !== null) ? svg : h('p', { className: 'note', text: t('Waiting for latency readings.') }),
        h('div', { className: 'axis' }, [h('span', { text: t('24 h ago') }), h('span', { text: t('now') })]),
        h('p', { className: 'note', text: t('Average response time in ms per 15 minutes. Gaps mean no successful reading.') }),
      ]),
    ];
  };
  const lossSeries = health?.routerLossSeries ?? [],
    lossChart = chart('latency', t('Router ping loss over 24 hours, from 0 to 100 percent'));
  drawChart(
    lossChart,
    lossSeries.map(value => [value, null]),
    ['latency', 'u'],
    100
  );
  return section({ title: t('Internet'), meta: current ? t('Pi, {0}', time(current.at)) : t('No current reading') }, [
    card([
      readingGrid([
        reading({
          label: current && current.state !== 'up' ? t('Likely cause: {0}', CAUSES[current.state].toLowerCase()) : t('Status'),
          value: status,
          state: current?.state === 'up' ? { kind: 'current', tone: 'good' } : current ? { kind: 'current', tone: 'warn' } : state,
        }),
        reading({ label: t('Available, 24 h'), value: availability, state: { kind: 'current' } }),
        reading({ label: t('Internet'), value: internetMs, state: { kind: 'current' } }),
        reading({ label: t('Router DNS'), value: dnsMs, state }),
        reading({ label: t('Router'), value: routerMs, state }),
        reading({ label: t('Router ping loss'), value: routerLoss, state }),
      ]),
    ]),
    ...latencyHistory(t('Internet TCP latency · 24 h'), health?.internetLatencySeries ?? []),
    ...latencyHistory(t('Router DNS latency · 24 h'), health?.dnsLatencySeries ?? []),
    h('h3', { className: 'subhead', text: t('Router ping loss · 24 h') }),
    card([
      lossSeries.some(value => value !== null) ? lossChart : h('p', { className: 'note', text: t('Waiting for router ping readings.') }),
      h('p', { className: 'note', text: t('Average loss between the Pi and the router per 15 minutes. Gaps mean no readings.') }),
    ]),
    h('h3', { className: 'subhead', text: t('Outages') }),
    outageRows(health),
    methodNote(
      memory,
      'outages',
      t('How outages are measured'),
      t(
        'Every 30 seconds, the Pi measures router ping, Internet TCP connectivity to 1.1.1.1 and 9.9.9.9 without application data, and router DNS. Two or more consecutive failures count as an outage. If the router responds, the likely cause is the provider or modem; otherwise, the home network. Gaps without measurements do not count as outages.'
      )
    ),
  ]);
}

export function trafficView(snapshot: Snapshot, state: NetworkState, memory: NetworkMemory): Array<Child> {
  return [...totals(snapshot, state), deviceRows(snapshot, state), internetSection(snapshot, memory)];
}
