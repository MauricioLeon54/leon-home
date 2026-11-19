/** Presentation DTOs only. Credentials and hardware addresses stay server-side. */
export type RatePoint = readonly [number | null, number | null];
export type TimedRatePoint = readonly [number, number | null, number | null];
export type Connection = 'ethernet' | 'wifi' | 'other' | 'unknown';
export type Band = '2.4GHz' | '5GHz' | '5GHz_1' | '5GHz_2' | 'DC' | 'wifi7-mld';
export type Day = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface Schedule {
  days: Array<Day>;
  start: string;
  end: string;
}
export interface Traffic {
  address: string;
  downloadRouterMbps: number | null;
  uploadRouterMbps: number | null;
  connection: Connection;
  // Router LAN port of a wired device, as the router reports it.
  port: number | null;
  band: Band | null;
  signalDbm: number | null;
  history: Array<RatePoint>;
}
export interface Device {
  id: string;
  address: string;
  name: string;
  kind: string;
  role: string;
  presence: 'seen' | 'notSeen' | 'unknown';
  lastSeen: number | null;
  isNew: boolean;
  canRename: boolean;
  paused: boolean;
  canPause: boolean;
  pauseSchedule: Schedule | null;
  traffic: Traffic | null;
}
export interface Port {
  port: number;
  enabled: boolean | null;
  link: 'up' | 'down' | 'unknown';
  speedMbps: number | null;
  duplex: 'full' | 'half' | null;
  wan: boolean | null;
}
export interface WifiNetwork {
  ssid: string | null;
  band: string | null;
  WifiEnable?: boolean | number;
  Channel?: number | boolean;
}
export interface Wifi {
  networks: Array<WifiNetwork>;
  guest: { ssid: string | null; enabled: boolean; restSeconds: number | null } | null;
}
export interface RouterTelemetry {
  status: 'current' | 'locked' | 'error' | 'stale' | 'unavailable';
  observedAt: number | null;
  ports: Array<Port> | null;
  controllablePorts: Array<number>;
  history: { samples: Array<TimedRatePoint> };
  wifi: Wifi | null;
}
export type OutageCause = 'provider' | 'home';
export interface InternetHealth {
  samples: number;
  availability: number | null;
  current: { at: number; state: 'up' | OutageCause; internetMs: number | null; routerMs: number | null } | null;
  series: Array<readonly [number, number | null]>;
  outages: Array<{ start: number; end: number | null; seconds: number; cause: OutageCause }>;
}
export interface Snapshot {
  schemaVersion: 1;
  observedAt: number | null;
  freshness: 'current' | 'stale' | 'unknown';
  freshSeconds: number;
  devices: Array<Device>;
  routerTelemetry: RouterTelemetry;
  internet: InternetHealth | null;
  truncated: boolean;
  actionToken: string;
}
export interface ViewContext {
  getState: () => Snapshot | null;
  trafficCurrent: () => boolean;
}
export interface ControlContext extends ViewContext {
  refresh: () => Promise<void>;
  isRefreshing: () => boolean;
}
export type Feedback = readonly ['good' | 'warn', string];
