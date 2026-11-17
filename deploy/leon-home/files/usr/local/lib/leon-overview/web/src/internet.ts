import { drawChart } from './charts.js';
import type { ViewContext } from './contracts.js';
import { $, date, text, time } from './presentation.js';
export function createInternetView({ getState }: Pick<ViewContext, 'getState'>) {
  function minutes(seconds: number) {
    const total = Math.max(1, Math.round(seconds / 60));
    return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
  }
  const CAUSES = { provider: 'provider or modem', home: 'home network' };
  function renderInternet() {
    const state = getState();
    if (!state) return;
    const health = state.internet,
      tiles = $('#net-tiles'),
      list = $('#outages');
    tiles.replaceChildren();
    list.replaceChildren();
    const current = health?.current;
    $('#net-at').textContent = current ? 'Pi ' + time(current.at) : 'No current reading';
    const status = !current ? 'No reading' : current.state === 'up' ? 'Online' : 'Outage: ' + CAUSES[current.state];
    const tone = !current ? '' : current.state === 'up' ? 'good' : 'warn';
    for (const [label, value, className] of [
      ['Status', status, tone],
      ['Availability over 24 h', typeof health?.availability === 'number' ? health.availability.toFixed(health.availability === 100 ? 0 : 1) + ' %' : '—', ''],
      ['Internet', typeof current?.internetMs === 'number' ? Math.round(current.internetMs) + ' ms' : '—', ''],
      ['Router', typeof current?.routerMs === 'number' ? current.routerMs.toFixed(1) + ' ms' : '—', ''],
    ] satisfies Array<readonly [string, string, string]>) {
      const tile = document.createElement('div');
      tile.className = 'tile ' + className;
      tile.append(text('b', value), text('span', label));
      tiles.append(tile);
    }
    drawChart(
      $('#net-chart', SVGSVGElement),
      (health?.series || []).map(point => [point[1], null])
    );
    const outages = (health?.outages || []).slice().reverse();
    if (!outages.length) {
      list.append(text('p', health?.samples ? 'No outages in the last 24 hours.' : 'No history yet.', 'muted small'));
      return;
    }
    for (const outage of outages) {
      const row = document.createElement('li'),
        info = document.createElement('div');
      info.append(text('b', (outage.end === null ? 'Ongoing · ' : '') + date(outage.start)), text('small', minutes(outage.seconds) + ' · ' + (CAUSES[outage.cause] || 'unknown cause')));
      row.append(info, text('span', outage.cause === 'provider' ? 'Provider' : 'Home', 'badge-paused'));
      list.append(row);
    }
  }

  return { render: renderInternet };
}
