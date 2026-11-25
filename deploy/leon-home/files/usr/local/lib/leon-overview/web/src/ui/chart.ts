import { dateLocale, t } from '../i18n/index.js';
/** Small SVG charts built with createElementNS; numbers only, no markup from data. */
const SVG = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Readonly<Record<string, string>>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

export interface HourBar {
  hourStart: number; // Unix seconds
  total: number;
  blocked: number;
}

/** Queries per hour with the blocked share overlaid. */
export function barChart(hours: ReadonlyArray<HourBar>, label: string): SVGSVGElement {
  const width = 10,
    gap = 3,
    height = 64,
    peak = Math.max(1, ...hours.map(hour => hour.total)),
    svg = svgElement('svg', {
      'viewBox': `0 0 ${Math.max(1, hours.length * (width + gap) - gap)} ${height}`,
      'preserveAspectRatio': 'none',
      'class': 'chart-bars',
      'role': 'img',
      'aria-label': label,
    });
  for (const [index, hour] of hours.entries()) {
    const x = index * (width + gap),
      totalHeight = Math.max(1.5, (hour.total / peak) * height),
      blockedHeight = (hour.blocked / peak) * height,
      group = svgElement('g', {}),
      time = new Date(hour.hourStart * 1000).toLocaleTimeString(dateLocale, { hour: 'numeric' }),
      title = svgElement('title', {});
    title.textContent = t('{0} · {1} queries, {2} blocked', time, hour.total, hour.blocked);
    group.append(
      title,
      svgElement('rect', { class: 'total', x: String(x), y: (height - totalHeight).toFixed(1), width: String(width), height: totalHeight.toFixed(1), rx: '2' }),
      svgElement('rect', { class: 'blocked', x: String(x), y: (height - blockedHeight).toFixed(1), width: String(width), height: blockedHeight.toFixed(1), rx: '2' })
    );
    svg.append(group);
  }
  return svg;
}

/** A single line scaled to its own range; null when there are too few points to draw. */
export function sparkline(points: ReadonlyArray<readonly [number, number]>, label: string): SVGSVGElement | null {
  const first = points[0],
    last = points[points.length - 1];
  if (!first || !last || points.length < 2) return null;
  const values = points.map(point => point[1]),
    low = Math.min(...values) - 1,
    high = Math.max(...values) + 1,
    span = last[0] - first[0] || 1,
    coordinates = points.map(([time, value]) => `${(((time - first[0]) / span) * 300).toFixed(1)},${(60 - ((value - low) / (high - low)) * 56 - 2).toFixed(1)}`).join(' '),
    svg = svgElement('svg', { 'viewBox': '0 0 300 60', 'preserveAspectRatio': 'none', 'class': 'chart-spark', 'role': 'img', 'aria-label': label });
  svg.append(svgElement('polyline', { points: coordinates }));
  return svg;
}
