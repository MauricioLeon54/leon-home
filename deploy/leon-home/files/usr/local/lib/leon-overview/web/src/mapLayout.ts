import type { Device } from './contracts.js';

/** Branches follow the connection type the router reports; nothing is inferred from names. */
export type Group = 'wired' | 'fast' | 'slow' | 'wireless' | 'unknown';
export const GROUPS: ReadonlyArray<Group> = ['wired', 'fast', 'slow', 'wireless', 'unknown'];
export const GROUP_NAMES = {
  wired: 'Ethernet',
  fast: 'Wi-Fi 5 GHz',
  slow: 'Wi-Fi 2.4 GHz',
  wireless: 'Wi-Fi',
  unknown: 'Connection not reported',
} satisfies Record<Group, string>;

export function groupOf(device: Device): Group {
  const traffic = device.traffic;
  if (!traffic) return 'unknown';
  switch (traffic.connection) {
    case 'ethernet':
      return 'wired';
    case 'wifi':
      return traffic.band === '2.4GHz' ? 'slow' : traffic.band === null || traffic.band === 'DC' ? 'wireless' : 'fast';
    case 'other':
    case 'unknown':
      return 'unknown';
  }
}
