import type { Device } from './contracts.js';
import { hasKey, svgNS } from './presentation.js';

// Line drawings on a 32 px grid with one stroke weight. The drawing follows the kind the owner or
// inventory declared (same vocabulary as the Mac app); names are never used to guess a device type.
const ART = {
  router: [
    'M6 18h20a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 26 26H6a2.5 2.5 0 0 1-2.5-2.5v-3A2.5 2.5 0 0 1 6 18z',
    'M8.5 22h.01M12 22h.01M20 22h3.5',
    'M10.5 18 9 11.5M21.5 18l1.5-6.5',
    'M12.5 9a5 5 0 0 1 7 0M10 6.5a8.5 8.5 0 0 1 12 0',
  ],
  phone: ['M12.5 3.5h7a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-19a3 3 0 0 1 3-3z', 'M14.5 6.5h3M14.5 25.5h3'],
  tablet: ['M8.5 4.5h15a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3h-15a3 3 0 0 1-3-3v-17a3 3 0 0 1 3-3z', 'M14.5 24.5h3'],
  laptop: ['M8 7.5h16a1.5 1.5 0 0 1 1.5 1.5v11.5h-19V9A1.5 1.5 0 0 1 8 7.5z', 'M3.5 20.5h25l-1.5 3.5h-22z', 'M14 22.2h4'],
  tv: ['M5 6.5h22a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z', 'M16 23.5v3M11.5 26.5h9'],
  speaker: ['M11 3.5h10a2.5 2.5 0 0 1 2.5 2.5v20a2.5 2.5 0 0 1-2.5 2.5H11A2.5 2.5 0 0 1 8.5 26V6A2.5 2.5 0 0 1 11 3.5z', 'M16 13.5a5 5 0 1 1 0 10a5 5 0 1 1 0-10zM16 8h.01'],
  printer: ['M10 11.5V4.5h12v7', 'M7 11.5h18a2.5 2.5 0 0 1 2.5 2.5v7.5H22.5M9.5 21.5h-5V14A2.5 2.5 0 0 1 7 11.5', 'M9.5 17.5h13v10h-13zM12.5 21h7M12.5 24h4.5'],
  camera: ['M16 4.5a8 8 0 1 1 0 16a8 8 0 1 1 0-16z', 'M16 9.5a3 3 0 1 1 0 6a3 3 0 1 1 0-6z', 'M16 20.5v4M10.5 27.5h11'],
  console: ['M10 10.5h12a6.5 6.5 0 0 1 6 8.8l-1.1 2.8a3 3 0 0 1-4.8 1.2l-2.6-2.3h-7l-2.6 2.3a3 3 0 0 1-4.8-1.2L4 19.3a6.5 6.5 0 0 1 6-8.8z', 'M10.5 14v4.5M8.25 16.25h4.5M21.5 15h.01M23.5 17.5h.01'],
  watch: ['M12 9h8a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 20 23h-8a2.5 2.5 0 0 1-2.5-2.5v-9A2.5 2.5 0 0 1 12 9z', 'M12.5 9l1-5h5l1 5M12.5 23l1 5h5l1-5', 'M16 13v3.5l2 1.5'],
  server: ['M6.5 4.5h19v9.5h-19zM6.5 18h19v9.5h-19z', 'M10.5 9.25h.01M10.5 22.75h.01M15 9.25h6.5M15 22.75h6.5'],
  iot: ['M16 3.5a7.5 7.5 0 0 1 4.5 13.5V20.5h-9V17A7.5 7.5 0 0 1 16 3.5z', 'M12.5 24h7M14 27.5h4', 'M16 20.5v-5l-2-2.5M16 15.5l2-2.5'],
  device: ['M10 10h12v12H10z', 'M13.5 6v4M18.5 6v4M13.5 22v4M18.5 22v4M6 13.5h4M6 18.5h4M22 13.5h4M22 18.5h4', 'M14 14h4v4h-4z'],
} satisfies Record<string, ReadonlyArray<string>>;
export type ArtKind = keyof typeof ART;

const KIND_ALIASES = {
  computer: 'laptop',
  laptop: 'laptop',
  desktop: 'laptop',
  phone: 'phone',
  tablet: 'tablet',
  tv: 'tv',
  speaker: 'speaker',
  printer: 'printer',
  camera: 'camera',
  console: 'console',
  watch: 'watch',
  router: 'router',
  nas: 'server',
  server: 'server',
  iot: 'iot',
} satisfies Record<string, ArtKind>;

export function artKind(device: Pick<Device, 'kind' | 'role'>): ArtKind {
  if (device.role === 'router') return 'router';
  const kind = device.kind.toLowerCase();
  return hasKey(KIND_ALIASES, kind) ? KIND_ALIASES[kind] : 'device';
}

export function drawing(kind: ArtKind, className = 'art'): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ART[kind]) {
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
