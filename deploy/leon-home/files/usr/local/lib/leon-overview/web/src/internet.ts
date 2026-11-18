import { drawChart } from './charts.js';
import type { ViewContext } from './contracts.js';
import { $, date, text, time } from './presentation.js';
export function createInternetView({ getState }: Pick<ViewContext, 'getState'>) {
  function minutes(seconds: number) {
    const total = Math.max(1, Math.round(seconds / 60));
    return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
  }
  const CAUSES = { provider: 'Provider or modem', home: 'Home network' };
  function renderInternet() {
    const state = getState();
    if (!state) return;
    const health = state.internet,
      readings = $('#net-tiles'),
      list = $('#outages');
    readings.replaceChildren();
    list.replaceChildren();
    const current = health?.current;
    $('#net-at').textContent = current ? 'Pi, ' + time(current.at) : 'No current reading';
    const status = !current ? 'No reading' : current.state === 'up' ? 'Online' : 'Outage';
    const tone = !current ? 'unknown' : current.state === 'up' ? 'good' : 'warn';
    for (const [label, value, className] of [
      [current && current.state !== 'up' ? 'Likely cause: ' + CAUSES[current.state].toLowerCase() : 'Status', status, tone],
      [
        'Available, 24 h',
        typeof health?.availability === 'number' ? health.availability.toFixed(health.availability === 100 ? 0 : 1) + '%' : '—',
        typeof health?.availability === 'number' ? '' : 'unknown',
      ],
      ['Internet', typeof current?.internetMs === 'number' ? Math.round(current.internetMs) + ' ms' : '—', typeof current?.internetMs === 'number' ? '' : 'unknown'],
      ['Router', typeof current?.routerMs === 'number' ? current.routerMs.toFixed(1) + ' ms' : '—', typeof current?.routerMs === 'number' ? '' : 'unknown'],
    ] satisfies Array<readonly [string, string, string]>) {
      const reading = document.createElement('div');
      reading.className = 'reading ' + className;
      reading.append(text('b', value), text('span', label));
      readings.append(reading);
    }
    drawChart(
      $('#net-chart', SVGSVGElement),
      (health?.series || []).map(point => [point[1], null]),
      ['latency', 'u']
    );
    const outages = (health?.outages || []).slice().reverse();
    if (!outages.length) {
      list.append(text('li', health?.samples ? 'No outages in the last 24 hours.' : 'No history yet.', 'muted small'));
      return;
    }
    for (const outage of outages) {
      const row = document.createElement('li'),
        info = document.createElement('div');
      row.className = outage.end === null ? 'ongoing' : '';
      info.append(text('b', (outage.end === null ? 'Ongoing since ' : '') + date(outage.start)), text('small', CAUSES[outage.cause] || 'Unknown cause'));
      row.append(info, text('span', minutes(outage.seconds), 'muted small'));
      list.append(row);
    }
  }

  return { render: renderInternet };
}
