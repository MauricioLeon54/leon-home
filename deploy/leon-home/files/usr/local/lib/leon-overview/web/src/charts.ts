import type { RatePoint } from './contracts.js';
import { svgNS } from './presentation.js';
export function splitSeries(points: ReadonlyArray<RatePoint>, index: 0 | 1, width: number, height: number, max: number): Array<Array<readonly [number, number]>> {
  // Null readings split the line: a gap is shown instead of an invented zero.
  const segments: Array<Array<readonly [number, number]>> = [];
  let current: Array<readonly [number, number]> = [];
  points.forEach((point, position) => {
    const value = point[index];
    if (typeof value !== 'number') {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push([points.length < 2 ? width : (position * width) / (points.length - 1), height - (value / max) * (height - 8)]);
  });
  if (current.length) segments.push(current);
  return segments;
}
/** Series classes carry meaning: 'd'/'u' are download/upload; latency uses its own neutral class. */
export function drawChart(svg: SVGSVGElement, points: ReadonlyArray<RatePoint>, kinds: readonly [string, string] = ['d', 'u'], fixedMax?: number): void {
  svg.replaceChildren();
  const width = 300,
    height = 120;
  for (const y of [30, 60, 90]) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(0));
    line.setAttribute('x2', String(width));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('class', 'grid');
    svg.append(line);
  }
  const max = fixedMax ?? Math.max(1, ...points.flatMap(point => [point[0], point[1]]).filter(value => typeof value === 'number')) * 1.15;
  for (const [index, kind] of [
    [0, kinds[0]],
    [1, kinds[1]],
  ] satisfies Array<readonly [0 | 1, string]>)
    for (const segment of splitSeries(points, index, width, height, max)) {
      const first = segment[0],
        last = segment[segment.length - 1];
      if (!first || !last) continue;
      const path = segment.map((point, position) => (position ? 'L' : 'M') + point[0].toFixed(1) + ' ' + point[1].toFixed(1)).join('');
      const area = document.createElementNS(svgNS, 'path');
      area.setAttribute('class', 'area ' + kind);
      area.setAttribute('d', path + `L${last[0].toFixed(1)} ${height}L${first[0].toFixed(1)} ${height}Z`);
      const line = document.createElementNS(svgNS, 'path');
      line.setAttribute('class', 'line ' + kind);
      line.setAttribute('d', segment.length > 1 ? path : path + 'h1');
      svg.append(area, line);
    }
}
