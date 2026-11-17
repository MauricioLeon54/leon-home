import { drawChart } from './charts.js';
import type { ViewContext } from './contracts.js';
import { $, date, text, time } from './presentation.js';
export function createInternetView({ getState }: Pick<ViewContext, 'getState'>) {
  function minutes(seconds: number) {
    const total = Math.max(1, Math.round(seconds / 60));
    return total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
  }
  const CAUSES = { provider: 'proveedor o módem', home: 'red de casa' };
  function renderInternet() {
    const state = getState();
    if (!state) return;
    const health = state.internet,
      tiles = $('#net-tiles'),
      list = $('#outages');
    tiles.replaceChildren();
    list.replaceChildren();
    const current = health?.current;
    $('#net-at').textContent = current ? 'Pi ' + time(current.at) : 'Sin lectura actual';
    const status = !current ? 'Sin lectura' : current.state === 'up' ? 'En línea' : 'Caída: ' + CAUSES[current.state];
    const tone = !current ? '' : current.state === 'up' ? 'good' : 'warn';
    for (const [label, value, className] of [
      ['Estado', status, tone],
      ['Disponible 24 h', typeof health?.availability === 'number' ? health.availability.toFixed(health.availability === 100 ? 0 : 1) + ' %' : '—', ''],
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
      list.append(text('p', health?.samples ? 'Sin caídas en las últimas 24 h.' : 'Aún no hay historial.', 'muted small'));
      return;
    }
    for (const outage of outages) {
      const row = document.createElement('li'),
        info = document.createElement('div');
      info.append(text('b', (outage.end === null ? 'En curso · ' : '') + date(outage.start)), text('small', minutes(outage.seconds) + ' · ' + (CAUSES[outage.cause] || 'causa desconocida')));
      row.append(info, text('span', outage.cause === 'provider' ? 'Proveedor' : 'Casa', 'badge-paused'));
      list.append(row);
    }
  }

  return { render: renderInternet };
}
