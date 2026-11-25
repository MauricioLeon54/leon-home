import { drawChart } from '../../charts.js';
import type { Device, InternetHealth, Snapshot, Traffic } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import { date, icon, mbps, speed, svgNS, time } from '../../presentation.js';
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

const MODEM_FRESH_SECONDS = 120;
/** Answers the first question of an outage: is the modem itself alive? */
function modemSection(health: InternetHealth | null): HTMLElement | null {
  const modem = health?.modem;
  if (!modem) return null;
  const isFresh = Date.now() / 1000 - modem.at <= MODEM_FRESH_SECONDS,
    state = isFresh ? { kind: 'current' as const } : { kind: 'earlier' as const, at: modem.at },
    answers = modem.lossPercent < 100;
  return section({ title: t('Modem'), meta: isFresh ? t('Pi, {0}', time(modem.at)) : t('No current reading') }, [
    card([
      readingGrid([
        reading({ label: t('Status'), value: answers ? t('Online') : t('Not answering'), state: isFresh ? { kind: 'current', tone: answers ? 'good' : 'warn' } : state }),
        reading({ label: t('Response'), value: modem.averageMs === null ? null : `${modem.averageMs.toFixed(1)} ms`, state }),
        reading({ label: t('Ping loss'), value: `${modem.lossPercent}%`, state }),
      ]),
      h('p', { className: 'note', text: t('If the modem answers but there is no Internet, the cause is usually the provider.') }),
    ]),
  ]);
}

const LINE_FRESH_SECONDS = 13 * 3600; // two missed readings
// GPON class B+ receivers work from −27 to −8 dBm; below −25 little margin is left.
const SIGNAL_RANGE = { low: -25, high: -8 } as const;
const HOT_MODEM_CELSIUS = 75;

function fiberSection(health: InternetHealth | null): HTMLElement | null {
  const line = health?.modemLine;
  if (!line) return null;
  const state = Date.now() / 1000 - line.at > LINE_FRESH_SECONDS ? { kind: 'earlier' as const, at: line.at } : { kind: 'current' as const },
    toned = (isGood: boolean) => (state.kind === 'current' ? { kind: 'current' as const, tone: isGood ? ('good' as const) : ('warn' as const) } : state),
    isSignalGood = line.rxDbm !== null && line.rxDbm >= SIGNAL_RANGE.low && line.rxDbm <= SIGNAL_RANGE.high,
    isHot = line.temperatureCelsius !== null && line.temperatureCelsius >= HOT_MODEM_CELSIUS,
    history = line.rxHistory.filter((value): value is number => value !== null),
    // Plotted as margin above the limit, so a falling line means a weaker signal.
    svg = chart('latency', t('Fiber signal history'));
  drawChart(
    svg,
    line.rxHistory.map(value => [value === null ? null : Math.max(0, value + 30), null]),
    ['latency', 'u'],
    25
  );
  const verdict = line.rxDbm === null ? null : isSignalGood ? t('The fiber signal is normal.') : t('The fiber signal is out of its normal range. Ask your provider to check the line.');
  return section({ title: t('Fiber'), meta: date(line.at) }, [
    card([
      readingGrid([
        reading({ label: t('Provider line'), value: line.isRegistered === null ? null : line.isRegistered ? t('Connected') : t('Not connected'), state: toned(line.isRegistered === true) }),
        reading({ label: t('Fiber signal'), value: line.rxDbm === null ? null : `${line.rxDbm.toFixed(1)} dBm`, state: toned(isSignalGood) }),
        reading({ label: t('Signal sent'), value: line.txDbm === null ? null : `${line.txDbm.toFixed(1)} dBm`, state }),
        reading({ label: t('Temperature'), value: line.temperatureCelsius === null ? null : `${Math.round(line.temperatureCelsius)} °C`, state: isHot ? toned(false) : state }),
        reading({ label: t('Modem CPU'), value: line.cpuPercent === null ? null : `${Math.round(line.cpuPercent)}%`, state }),
        reading({ label: t('Modem memory'), value: line.memoryPercent === null ? null : `${Math.round(line.memoryPercent)}%`, state }),
      ]),
      verdict === null ? null : h('p', { className: 'note', text: verdict }),
      history.length > 1 ? svg : null,
      h('p', { className: 'note', text: t('Normal is between −25 and −8 dBm; closer to zero is stronger. Read from the modem every 6 hours.') }),
    ]),
    line.ports.length
      ? h(
          'ul',
          { className: 'list' },
          line.ports.map(port =>
            h('li', { className: 'list-item' }, [
              h('div', { className: 'row' }, [
                h('span', { className: 'row-body' }, [h('span', { className: 'row-title', text: t('Modem port {0}', port.port) })]),
                h('span', { className: 'row-value', text: !port.isUp ? t('No cable') : port.speedMbps === null ? t('Connected') : speed(port.speedMbps) }),
              ]),
            ])
          )
        )
      : null,
  ]);
}

const DAY_SECONDS = 86_400;
/** Shown only where the daily test is installed and has run. */
function speedSection(health: InternetHealth | null): HTMLElement | null {
  const tests = health?.speedTests ?? [],
    latest = tests[tests.length - 1];
  if (!latest) return null;
  // Two missed days: the result is kept but marked as an earlier one.
  const state = Date.now() / 1000 - latest.at > 2 * DAY_SECONDS ? { kind: 'earlier' as const, at: latest.at } : { kind: 'current' as const },
    figure = (value: number | null) => (value === null ? null : `${Math.round(value)} Mbps`),
    svg = chart('', t('Daily download and upload speed'));
  drawChart(
    svg,
    tests.map(test => [test.downMbps, test.upMbps])
  );
  return section({ title: t('Speed test'), meta: date(latest.at) }, [
    card([
      readingGrid([reading({ label: t('Download'), value: figure(latest.downMbps), state }), reading({ label: t('Upload'), value: figure(latest.upMbps), state })]),
      latest.downMbps === null || latest.upMbps === null ? h('p', { className: 'note', text: t('Part of the last test could not finish.') }) : null,
      tests.length > 1 ? svg : null,
      tests.length > 1 ? h('div', { className: 'axis' }, [h('span', { text: date(tests[0]?.at) }), h('span', { text: date(latest.at) })]) : null,
      h('p', { className: 'note', text: t('Measured once a day, before 5 a.m., by the Pi over its cable. Wi-Fi can be slower.') }),
    ]),
  ]);
}

export function trafficView(snapshot: Snapshot, state: NetworkState, memory: NetworkMemory): Array<Child> {
  return [
    ...totals(snapshot, state),
    speedSection(snapshot.internet),
    modemSection(snapshot.internet),
    fiberSection(snapshot.internet),
    deviceRows(snapshot, state),
    internetSection(snapshot, memory),
  ];
}
