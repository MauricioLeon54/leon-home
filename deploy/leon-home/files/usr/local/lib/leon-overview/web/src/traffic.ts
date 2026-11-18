import { drawChart } from './charts.js';
import type { Device, Traffic, ViewContext } from './contracts.js';
import { $, icon, mbps, svgNS, text, time } from './presentation.js';
export function createTrafficView({ getState, trafficCurrent, select }: ViewContext & { select: (id: string) => void }) {
  function renderTraffic() {
    const state = getState();
    if (!state) return;
    const router = state.routerTelemetry,
      samples = router.history?.samples || [],
      latest = samples[samples.length - 1],
      current = trafficCurrent();
    for (const [id, index] of [
      ['#total-down', 1],
      ['#total-up', 2],
    ] satisfies Array<readonly [string, 1 | 2]>) {
      const element = $(id);
      element.replaceChildren();
      if (current && latest && typeof latest[index] === 'number') element.append(mbps(latest[index]), text('small', ' Mbps'));
      else element.textContent = '—';
    }
    $('#traffic-at').textContent = current ? 'Router, ' + time(router.observedAt) : 'No current reading';
    drawChart(
      $('#total-chart', SVGSVGElement),
      samples.map(sample => [sample[1], sample[2]])
    );
    $('#axis-start').textContent = samples.length ? time(samples[0]?.[0]) : '';
    const rows = state.devices
      .filter((device): device is Device & { traffic: Traffic } => device.traffic !== null)
      .sort((left, right) => (right.traffic.downloadRouterMbps ?? -1) - (left.traffic.downloadRouterMbps ?? -1));
    const top = Math.max(1, ...rows.map(device => device.traffic.downloadRouterMbps || 0)),
      list = $('#device-list');
    list.replaceChildren();
    $('#device-count').textContent = rows.length ? rows.length + (rows.length === 1 ? ' device' : ' devices') : '';
    if (!rows.length) {
      list.append(text('li', current ? 'No device is reporting traffic right now.' : 'No current router reading. Unlock the router session to see traffic by device.', 'muted small empty-row'));
      return;
    }
    for (const device of rows) {
      const item = document.createElement('li'),
        badge = document.createElement('span'),
        name = document.createElement('div');
      badge.className = 'icon';
      badge.append(icon(device.traffic.connection, 'k'));
      name.className = 'name';
      name.append(device.name, text('small', device.address));
      if (current) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.width = Math.max(2, ((device.traffic.downloadRouterMbps || 0) / top) * 100) + '%';
        name.append(bar);
      }
      const spark = document.createElementNS(svgNS, 'svg');
      spark.setAttribute('class', 'chart spark');
      spark.setAttribute('viewBox', '0 0 300 120');
      spark.setAttribute('preserveAspectRatio', 'none');
      spark.setAttribute('aria-hidden', 'true');
      drawChart(spark, device.traffic.history || []);
      const numbers = document.createElement('div');
      numbers.className = 'num';
      numbers.append(text('span', current ? '↓ ' + mbps(device.traffic.downloadRouterMbps) : '—', 'd'), text('span', current ? '↑ ' + mbps(device.traffic.uploadRouterMbps) : '', 'u'));
      item.append(badge, name, spark, numbers);
      item.addEventListener('click', () => {
        select(device.id);
        location.hash = 'map';
      });
      list.append(item);
    }
  }

  return { render: renderTraffic };
}
