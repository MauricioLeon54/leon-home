import type { NetworkActions } from '../../api.js';
import { postNetwork } from '../../api.js';
import type { Connection, Device, Snapshot } from '../../contracts.js';
import { h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import type { SwitchOutcome } from '../../ui/switch.js';
import type { UnlockState } from './unlock.js';

const ROUTER_FRESH_SECONDS = 90;

/** What the page knows: the last good snapshot and whether the latest refresh failed. */
export interface NetworkState {
  snapshot: Snapshot;
  hasFailed: boolean;
}
export type Presence = 'online' | 'away' | 'unknown';

export function scanCurrent({ snapshot, hasFailed }: NetworkState): boolean {
  return !hasFailed && snapshot.observedAt !== null && snapshot.freshness === 'current' && Date.now() / 1000 - snapshot.observedAt <= snapshot.freshSeconds;
}
export function trafficCurrent({ snapshot, hasFailed }: NetworkState): boolean {
  const router = snapshot.routerTelemetry;
  return !hasFailed && router.status === 'current' && typeof router.observedAt === 'number' && Date.now() / 1000 - router.observedAt <= ROUTER_FRESH_SECONDS;
}
/** Presence is only claimed while the scan is current; otherwise it is unknown, never "offline". */
export function presenceOf(device: Device, isScanCurrent: boolean): Presence {
  if (!isScanCurrent) return 'unknown';
  return device.presence === 'seen' ? 'online' : device.presence === 'notSeen' ? 'away' : 'unknown';
}
export const CONNECTION_NAMES = { ethernet: 'Ethernet', wifi: 'Wi-Fi', other: t('Other'), unknown: t('Unidentified') } satisfies Record<Connection, string>;
export const devicePath = (id: string): string => `/network/device/${encodeURIComponent(id)}`;

/** One action, never retried (the router may already have applied it). Status 403/503 override the body. */
export async function sendNetworkAction<K extends keyof NetworkActions>(path: K, body: NetworkActions[K], token: string, options: { requireOk?: boolean } = {}): Promise<string> {
  try {
    const reply = await postNetwork(path, body, token);
    if (reply.httpStatus === 403) return 'forbidden';
    if (reply.httpStatus === 503) return 'unavailable';
    return options.requireOk && !reply.ok ? 'invalid' : reply.outcome;
  } catch {
    return 'network';
  }
}

/** Maps a router/device outcome to the switch's three honest states. */
export function switchOutcome(status: string): SwitchOutcome {
  if (status === 'applied' || status === 'unchanged') return 'applied';
  return status === 'unverified' || status === 'network' ? 'unverified' : 'refused';
}

/** Page-local state that must survive the rebuild after every refresh. */
export interface NetworkMemory {
  query: string;
  hasPainted: boolean;
  openNotes: Set<string>;
  selectedPort: number | null;
  portOutcome: { port: number; status: string } | null;
  isActing: boolean;
  unlock: UnlockState;
}
export function createMemory(selectedPort: number | null): NetworkMemory {
  return { query: '', hasPainted: false, openNotes: new Set(), selectedPort, portOutcome: null, isActing: false, unlock: { isConnecting: false, feedback: null } };
}

/** A collapsible method note whose open state outlives refreshes. */
export function methodNote(memory: NetworkMemory, id: string, title: string, text: string): HTMLElement {
  const details = h('details', { className: 'method' }, [h('summary', { text: title }), h('p', { className: 'note', text })]);
  details.open = memory.openNotes.has(id);
  details.addEventListener('toggle', () => (details.open ? memory.openNotes.add(id) : memory.openNotes.delete(id)));
  return details;
}
