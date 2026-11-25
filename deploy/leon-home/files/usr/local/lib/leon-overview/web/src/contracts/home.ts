import { address, boolean, items, list, nullable, nullableNumber, number, oneOf, record, string } from '../decode.js';

/**
 * GET /api/v1/home — the Home tab view model. This file is the wire contract: overview.py's
 * home_view() must produce exactly these keys. Times are Unix seconds. `null` means unknown,
 * never zero or off. Lists carry the server-side maximum noted beside them.
 */
export type Tone = 'good' | 'warn' | 'unknown';

export interface HomeView {
  observedAt: number | null; // sampler time; null while the first sample is pending
  status: {
    issues: Array<string>; // ≤ 32, already worded ("Pi-hole is unavailable")
    uptimeSeconds: number | null;
    servicesRunning: number | null;
    servicesTotal: number | null;
    temperatureCelsius: number | null;
  };
  internet: {
    state: 'connected' | 'offline' | 'unknown';
    internetMs: number | null;
    routerMs: number | null;
    routerDnsMs: number | null;
    encryptedDnsMs: number | null;
  };
  pihole: PiHoleView | null; // null: Pi-hole did not answer
  pi: {
    temperatureCelsius: number | null;
    cpuPercent: number | null;
    load1: number | null;
    memoryAvailableBytes: number | null;
    storageFreeBytes: number | null;
    power: { label: string; needsAttention: boolean }; // "OK", "Low voltage", "Throttled earlier", "Unknown"
    rebootRequired: boolean;
    temperatureHistory: Array<readonly [number, number]>; // ≤ 300 [time, °C]
  };
  services: Array<{ name: string; label: string; running: boolean; state: string }>; // ≤ 64
  network: {
    online: number;
    devices: Array<HomeDevice>; // ≤ 40, online only
    registeredNames: number;
    moves: Array<{ name: string; from: string; to: string; at: number }>; // ≤ 3, last 7 days
  };
  tailscale: Array<{ name: string; os: string; online: boolean; direct: boolean; lastSeen: number | null }> | null; // ≤ 64; null: no reading
  backups: {
    latest: { at: number; bytes: number; count: number } | null;
    isFresh: boolean; // latest within 36 h
    repositories: Array<{ name: string; branch: string; at: number }>; // ≤ 32
  };
  tablet: TabletView | null; // null: no tablet configured and no reading
  links: { piholeAdmin: string; routerSettings: string | null }; // routerSettings: http://<private IPv4>/
}

export interface PiHoleView {
  blocking: 'enabled' | 'paused';
  pausedSecondsLeft: number | null;
  percentBlocked: number;
  queries: number;
  blocked: number;
  domainsOnBlocklists: number;
  activeClients: number;
  hours: Array<{ hourStart: number; total: number; blocked: number }>; // ≤ 24
  topBlocked: Array<{ name: string; count: number }>; // ≤ 6
  topClients: Array<{ name: string; count: number }>; // ≤ 6
}

export interface HomeDevice {
  name: string; // label or IP
  address: string;
  detail: string; // IP when named, else round-trip time, else ''
  isNew: boolean;
  isUnnamed: boolean;
  isAuto: boolean; // name came from mDNS
  presence: Array<boolean>; // ≤ 16 recent scans, oldest first
}

/** The tablet card keeps its server-side wording; the client only lays it out. */
export interface TabletView {
  summary: string;
  tone: Tone;
  rows: Array<{ tone: Tone; label: string; detail: string }>; // ≤ 12
  notes: Array<string>; // ≤ 3
}

// Parsing: unknown in, HomeView out. Every list is bounded, malformed shapes throw, and a
// null or missing number stays null (unknown); a wrong type is rejected, never coerced.

const MAX_UNIX_SECONDS = 4_102_444_800;
const unixSeconds = (value: unknown, now: number): number => number(value, 1, now + 30);
const tone = (value: unknown): Tone => oneOf(value, ['good', 'warn', 'unknown']);

function parsePiHole(value: unknown): PiHoleView {
  const root = record(value);
  return {
    blocking: oneOf(root.blocking, ['enabled', 'paused']),
    pausedSecondsLeft: nullableNumber(root.pausedSecondsLeft, 0, 86_400),
    percentBlocked: number(root.percentBlocked, 0, 100),
    queries: number(root.queries, 0, 1e12),
    blocked: number(root.blocked, 0, 1e12),
    domainsOnBlocklists: number(root.domainsOnBlocklists, 0, 1e12),
    activeClients: number(root.activeClients, 0, 1e9),
    hours: items(root.hours, 24, item => {
      const hour = record(item);
      return { hourStart: number(hour.hourStart, 0, MAX_UNIX_SECONDS), total: number(hour.total, 0, 1e12), blocked: number(hour.blocked, 0, 1e12) };
    }),
    topBlocked: items(root.topBlocked, 6, parseCount),
    topClients: items(root.topClients, 6, parseCount),
  };
}
function parseCount(value: unknown): { name: string; count: number } {
  const root = record(value);
  return { name: string(root.name, 253), count: number(root.count, 0, 1e12) };
}
function parseDevice(value: unknown): HomeDevice {
  const root = record(value);
  return {
    name: string(root.name, 100),
    address: address(root.address),
    detail: string(root.detail, 100),
    isNew: boolean(root.isNew),
    isUnnamed: boolean(root.isUnnamed),
    isAuto: boolean(root.isAuto),
    presence: items(root.presence, 16, boolean),
  };
}
function parseTablet(value: unknown): TabletView {
  const root = record(value);
  return {
    summary: string(root.summary, 200),
    tone: tone(root.tone),
    rows: items(root.rows, 12, item => {
      const row = record(item);
      return { tone: tone(row.tone), label: string(row.label, 100), detail: string(row.detail, 200) };
    }),
    notes: items(root.notes, 3, note => string(note, 300)),
  };
}
/** Links are rendered as hrefs, so only the two exact shapes the server produces are accepted. */
function parseLinks(value: unknown): HomeView['links'] {
  const root = record(value),
    piholeAdmin = string(root.piholeAdmin, 200),
    routerSettings = nullable(root.routerSettings, item => string(item, 40));
  if (!/^\/(?!\/)[\w./-]*$/.test(piholeAdmin)) throw new Error('Invalid Pi-hole link');
  if (routerSettings !== null) {
    const match = /^http:\/\/([\d.]+)\/$/.exec(routerSettings);
    address(match?.[1]);
  }
  return { piholeAdmin, routerSettings };
}

export function parseHome(value: unknown): HomeView {
  const root = record(value),
    now = Date.now() / 1000,
    status = record(root.status),
    internet = record(root.internet),
    pi = record(root.pi),
    power = record(pi.power),
    network = record(root.network),
    backups = record(root.backups);
  return {
    observedAt: nullable(root.observedAt, item => unixSeconds(item, now)),
    status: {
      issues: items(status.issues, 32, issue => string(issue, 300)),
      uptimeSeconds: nullableNumber(status.uptimeSeconds, 0, 1e9),
      servicesRunning: nullableNumber(status.servicesRunning, 0, 1000),
      servicesTotal: nullableNumber(status.servicesTotal, 0, 1000),
      temperatureCelsius: nullableNumber(status.temperatureCelsius, -50, 200),
    },
    internet: {
      state: oneOf(internet.state, ['connected', 'offline', 'unknown']),
      internetMs: nullableNumber(internet.internetMs, 0, 100_000),
      routerMs: nullableNumber(internet.routerMs, 0, 100_000),
      routerDnsMs: nullableNumber(internet.routerDnsMs, 0, 100_000),
      encryptedDnsMs: nullableNumber(internet.encryptedDnsMs, 0, 100_000),
    },
    pihole: nullable(root.pihole, parsePiHole),
    pi: {
      temperatureCelsius: nullableNumber(pi.temperatureCelsius, -50, 200),
      cpuPercent: nullableNumber(pi.cpuPercent, 0, 100),
      load1: nullableNumber(pi.load1, 0, 10_000),
      memoryAvailableBytes: nullableNumber(pi.memoryAvailableBytes, 0, 2 ** 50),
      storageFreeBytes: nullableNumber(pi.storageFreeBytes, 0, 2 ** 60),
      power: { label: string(power.label, 40), needsAttention: boolean(power.needsAttention) },
      rebootRequired: boolean(pi.rebootRequired),
      temperatureHistory: items(pi.temperatureHistory, 300, item => {
        const point = list(item, 2);
        return [number(point[0], 0, MAX_UNIX_SECONDS), number(point[1], -50, 200)] as const;
      }),
    },
    services: items(root.services, 64, item => {
      const service = record(item);
      return { name: string(service.name, 100), label: string(service.label, 100), running: boolean(service.running), state: string(service.state, 40) };
    }),
    network: {
      online: number(network.online, 0, 100_000),
      devices: items(network.devices, 40, parseDevice),
      registeredNames: number(network.registeredNames, 0, 100_000),
      moves: items(network.moves, 3, item => {
        const move = record(item);
        return { name: string(move.name, 100), from: string(move.from, 100), to: string(move.to, 100), at: unixSeconds(move.at, now) };
      }),
    },
    tailscale: nullable(root.tailscale, peers =>
      items(peers, 64, item => {
        const peer = record(item);
        return {
          name: string(peer.name, 100),
          os: string(peer.os, 40),
          online: boolean(peer.online),
          direct: boolean(peer.direct),
          lastSeen: nullable(peer.lastSeen, seen => unixSeconds(seen, now)),
        };
      })
    ),
    backups: {
      latest: nullable(backups.latest, item => {
        const latest = record(item);
        return { at: unixSeconds(latest.at, now), bytes: number(latest.bytes, 0, 2 ** 60), count: number(latest.count, 0, 100_000) };
      }),
      isFresh: boolean(backups.isFresh),
      repositories: items(backups.repositories, 32, item => {
        const repository = record(item);
        return { name: string(repository.name, 100), branch: string(repository.branch, 100), at: unixSeconds(repository.at, now) };
      }),
    },
    tablet: nullable(root.tablet, parseTablet),
    links: parseLinks(root.links),
  };
}
