import type { Band, Device, InternetHealth, Port, RatePoint, RouterTelemetry, Schedule, Snapshot, TimedRatePoint, Traffic, Wifi, WifiNetwork } from './contracts.js';
import { address, choice, finite, integer, list, optionalBoolean, optionalList, record, string, timestamp } from './decode.js';

function ratePoint(value: unknown): RatePoint {
  const pair = list(value, 2);
  if (pair.length !== 2) throw new Error('Invalid rate sample');
  return [finite(pair[0]), finite(pair[1])];
}
function timedPoint(value: unknown, now: number): TimedRatePoint {
  const point = list(value, 3),
    at = timestamp(point[0], now);
  if (point.length !== 3 || at === null) throw new Error('Invalid timed sample');
  return [at, finite(point[1]), finite(point[2])];
}
export function parseSchedule(value: unknown): Schedule | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  const days = list(item.days, 7)
    .map(value => integer(value, 0, 6))
    .map(value => {
      switch (value) {
        case 0:
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
        case 6:
          return value;
        default:
          throw new Error('Invalid day');
      }
    });
  const start = string(item.start, 5),
    end = string(item.end, 5);
  if (!days.length || new Set(days).size !== days.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start === end) throw new Error('Invalid schedule');
  return { days, start, end };
}
function traffic(value: unknown, deviceAddress: string): Traffic | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  const bands: ReadonlyArray<Band> = ['2.4GHz', '5GHz', '5GHz_1', '5GHz_2', 'DC', 'wifi7-mld'];
  const band = bands.find(band => band === item.band) ?? null;
  const result = {
    address: item.address === undefined ? deviceAddress : address(item.address),
    downloadRouterMbps: finite(item.downloadRouterMbps),
    uploadRouterMbps: finite(item.uploadRouterMbps),
    connection: choice(item.connection, ['ethernet', 'wifi', 'other', 'unknown'], 'unknown'),
    port: Number.isInteger(item.port) ? finite(item.port, 1, 8) : null,
    band,
    signalDbm: finite(item.signalDbm, -100, -1),
    history: optionalList(item.history, 60).map(ratePoint),
  } satisfies Traffic;
  if (result.address !== deviceAddress) throw new Error('Mismatched device address');
  return result;
}
function device(value: unknown, now: number): Device {
  const item = record(value),
    ip = address(item.address),
    id = address(item.id);
  if (id !== ip) throw new Error('Mismatched device identity');
  return {
    id,
    address: ip,
    name: string(item.name),
    kind: item.kind === undefined ? '' : string(item.kind, 40),
    role: item.role === undefined ? '' : string(item.role, 40),
    presence: choice(item.presence, ['seen', 'notSeen', 'unknown'], 'unknown'),
    lastSeen: timestamp(item.lastSeen, now),
    isNew: item.isNew === true,
    canRename: item.canRename === true,
    canPause: item.canPause === true,
    canWake: item.canWake === true,
    paused: item.paused === true,
    pauseSchedule: parseSchedule(item.pauseSchedule),
    traffic: traffic(item.traffic, ip),
  };
}
function port(value: unknown): Port {
  const item = record(value);
  return {
    port: integer(item.port, 1, 8),
    enabled: optionalBoolean(item.enabled),
    wan: optionalBoolean(item.wan),
    link: choice(item.link, ['up', 'down', 'unknown'], 'unknown'),
    speedMbps: finite(item.speedMbps, 1),
    duplex: item.duplex === 'full' || item.duplex === 'half' ? item.duplex : null,
  };
}
function wifi(value: unknown): Wifi | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  const networks = optionalList(item.networks, 4).map(value => {
    const entry = record(value);
    const network: WifiNetwork = {
      ssid: entry.ssid === null || entry.ssid === undefined ? null : string(entry.ssid, 32),
      band: entry.band === null || entry.band === undefined ? null : string(entry.band, 16),
    };
    if (typeof entry.WifiEnable === 'boolean' || (typeof entry.WifiEnable === 'number' && Number.isFinite(entry.WifiEnable))) network.WifiEnable = entry.WifiEnable;
    if (typeof entry.Channel === 'boolean' || (typeof entry.Channel === 'number' && Number.isFinite(entry.Channel))) network.Channel = entry.Channel;
    return network;
  });
  const guest = item.guest === null || item.guest === undefined ? null : record(item.guest);
  return {
    networks,
    guest: guest ? { ssid: guest.ssid === null || guest.ssid === undefined ? null : string(guest.ssid, 32), enabled: guest.enabled === true, restSeconds: finite(guest.restSeconds, 0, 604800) } : null,
  };
}
function router(value: unknown, now: number): RouterTelemetry {
  const item = value === null || value === undefined ? {} : record(value),
    history = item.history === null || item.history === undefined ? {} : record(item.history);
  const ports = item.ports === null || item.ports === undefined ? null : list(item.ports, 8).map(port);
  if (ports && new Set(ports.map(port => port.port)).size !== ports.length) throw new Error('Duplicate port identity');
  return {
    status: choice(item.status, ['current', 'locked', 'error', 'stale', 'unavailable'], 'unavailable'),
    observedAt: timestamp(item.observedAt, now),
    ports,
    controllablePorts: optionalList(item.controllablePorts, 8).map(value => integer(value, 1, 8)),
    history: { samples: optionalList(history.samples, 120).map(value => timedPoint(value, now)) },
    wifi: wifi(item.wifi),
  };
}
function internet(value: unknown, now: number): InternetHealth | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  let current: InternetHealth['current'] = null;
  if (item.current !== null && item.current !== undefined) {
    const reading = record(item.current),
      at = timestamp(reading.at, now);
    if (reading.state !== 'up' && reading.state !== 'provider' && reading.state !== 'home') throw new Error('Invalid health state');
    if (at !== null)
      current = {
        at,
        state: reading.state,
        internetMs: finite(reading.internetMs),
        routerMs: finite(reading.routerMs),
        dnsMs: finite(reading.dnsMs, 0, 100_000),
        routerLossPercent: finite(reading.routerLossPercent, 0, 100),
      };
  }
  return {
    samples: integer(item.samples ?? 0, 0, 10000),
    availability: finite(item.availability, 0, 100),
    current,
    series: optionalList(item.series, 2880).map(value => {
      const point = list(value, 3),
        at = timestamp(point[0], now);
      if (point.length < 2 || at === null || (point.length === 3 && finite(point[2], 0, 100) === null)) throw new Error('Invalid health sample');
      return [at, finite(point[1])] satisfies readonly [number, number | null];
    }),
    routerLossSeries: optionalList(item.routerLossSeries, 96).map(value => finite(value, 0, 100)),
    internetLatencySeries: optionalList(item.internetLatencySeries, 96).map(value => finite(value, 0, 100_000)),
    dnsLatencySeries: optionalList(item.dnsLatencySeries, 96).map(value => finite(value, 0, 100_000)),
    outages: optionalList(item.outages, 10).map(value => {
      const outage = record(value),
        start = timestamp(outage.start, now),
        end = timestamp(outage.end, now),
        seconds = finite(outage.seconds, 0, 604800);
      if (start === null || seconds === null || (outage.end !== null && end === null) || (end !== null && end < start) || (outage.cause !== 'provider' && outage.cause !== 'home'))
        throw new Error('Invalid outage');
      return { start, end, seconds, cause: outage.cause };
    }),
  };
}
export function parseSnapshot(value: unknown, now = Date.now() / 1000): Snapshot {
  const item = record(value);
  if (item.schemaVersion !== 1) throw new Error('Unsupported snapshot version');
  const devices = list(item.devices, 64).map(value => device(value, now));
  if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error('Duplicate device identity');
  return {
    schemaVersion: 1,
    observedAt: timestamp(item.observedAt, now),
    freshness: choice(item.freshness, ['current', 'stale', 'unknown'], 'unknown'),
    freshSeconds: integer(item.freshSeconds, 1, 3600),
    devices,
    routerTelemetry: router(item.routerTelemetry, now),
    internet: internet(item.internet, now),
    actionToken: item.actionToken === undefined ? '' : string(item.actionToken, 256),
    truncated: item.truncated === true,
  };
}
