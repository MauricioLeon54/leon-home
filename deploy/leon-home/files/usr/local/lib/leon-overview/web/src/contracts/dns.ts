import { items, nullable, number, oneOf, record, string } from '../decode.js';
import { type HomeView, parseHome } from './home.js';

/**
 * GET /api/v1/dns — the Home view plus Pi-hole filtering details for Settings → DNS & filtering.
 * overview.py's dns_details() must produce exactly these keys. Times are Unix seconds; `filtering`
 * is null while Pi-hole does not answer.
 */
export interface DnsView extends HomeView {
  filtering: FilteringView | null;
}
export type AllowSource = 'panel' | 'selfRepair' | 'other';
export type ListState = 'ok' | 'cached' | 'failed' | 'off';
export interface FilteringView {
  recentBlocked: Array<{ domain: string; device: string; at: number; count: number }>; // ≤ 30, newest first
  allowed: Array<{ domain: string; source: AllowSource; addedAt: number | null }>; // ≤ 100
  groups: Array<{ name: string; devices: Array<string> }>; // ≤ 20, groups other than Default
  lists: Array<{ name: string; entries: number; state: ListState; updatedAt: number | null; groups: Array<string> }>; // ≤ 40
  listsUpdatedAt: number | null;
}

const MAX_UNIX_SECONDS = 4_102_444_800;
const seconds = (value: unknown): number => number(value, 0, MAX_UNIX_SECONDS);

function parseFiltering(value: unknown): FilteringView {
  const root = record(value);
  return {
    recentBlocked: items(root.recentBlocked, 30, item => {
      const row = record(item);
      return { domain: string(row.domain, 253), device: string(row.device, 100), at: seconds(row.at), count: number(row.count, 1, 1e9) };
    }),
    allowed: items(root.allowed, 100, item => {
      const row = record(item);
      return { domain: string(row.domain, 253), source: oneOf(row.source, ['panel', 'selfRepair', 'other']), addedAt: nullable(row.addedAt, seconds) };
    }),
    groups: items(root.groups, 20, item => {
      const row = record(item);
      return { name: string(row.name, 60), devices: items(row.devices, 50, device => string(device, 60)) };
    }),
    lists: items(root.lists, 40, item => {
      const row = record(item);
      return {
        name: string(row.name, 100),
        entries: number(row.entries, 0, 1e9),
        state: oneOf(row.state, ['ok', 'cached', 'failed', 'off']),
        updatedAt: nullable(row.updatedAt, seconds),
        groups: items(row.groups, 20, group => string(group, 60)),
      };
    }),
    listsUpdatedAt: nullable(root.listsUpdatedAt, seconds),
  };
}

export function parseDns(value: unknown): DnsView {
  return { ...parseHome(value), filtering: nullable(record(value).filtering, parseFiltering) };
}
