import { boolean, items, nullable, nullableNumber, number, oneOf, record, string } from '../decode.js';

/**
 * GET /api/v1/hardware — the Raspberry Pi settings view model. Wire contract for overview.py's
 * hardware_view(): the root helper (leon-hardware) reports switchable state, the sampler reports
 * readings. Times are Unix seconds; `null`/'unknown' means unknown, never off.
 */
export type Switchable = 'on' | 'off' | 'unknown';
export type LedName = 'ACT' | 'PWR';
export type LedMode = 'on' | 'off' | 'auto' | 'unknown'; // auto: the board's normal behaviour
export type RadioKind = 'wifi' | 'bluetooth';
export type CpuProfile = 'balanced' | 'powersave' | 'performance';
export type RestartableUnit = 'pihole-FTL' | 'unbound' | 'ntfy' | 'smbd' | 'leon-router' | 'leon-n8n' | 'leon-overview-redirect';

export interface ThrottleFlags {
  underVoltage: boolean;
  frequencyCapped: boolean;
  throttled: boolean;
  softTemperatureLimit: boolean;
}

export interface HardwareView {
  observedAt: number; // when the helper state was read
  /** 'unavailable': helper not installed or not answering; every control is then read-only. */
  helper: 'available' | 'unavailable';
  board: string | null; // "Raspberry Pi 4 Model B Rev 1.1"
  readings: {
    uptimeSeconds: number | null;
    temperatureCelsius: number | null;
    cpuPercent: number | null;
    memoryAvailableBytes: number | null;
    storageFreeBytes: number | null;
    throttling: { now: ThrottleFlags; sinceBoot: ThrottleFlags } | null; // null: vcgencmd unreadable
  };
  leds: Array<{ name: LedName; mode: LedMode }>; // exactly ACT and PWR when the helper answers, else []
  ledSchedule: { start: string; end: string } | null; // HH:MM local; LEDs off between start and end
  ethernetLeds: { configured: Switchable; pendingReboot: boolean };
  usb: {
    isSupported: boolean; // uhubctl installed
    power: Switchable; // all ports together on a Pi 4
    devices: Array<{ name: string; isStorage: boolean; isMounted: boolean }>; // ≤ 16
    /** Why turning USB off is refused right now (e.g. "A USB drive is mounted"), else null. */
    powerOffBlockedBy: string | null;
  };
  radios: Array<{ kind: RadioKind; state: Switchable; isHardBlocked: boolean; isUplink: boolean }>; // ≤ 2
  cpu: { profile: CpuProfile | 'custom' | 'unknown'; governor: string | null; frequencyMhz: number | null };
  services: Array<{ unit: RestartableUnit; label: string; state: string }>; // installed allowlisted units only
  power: { rebootRequired: boolean; rebootAllowedAt: number | null }; // null: allowed now (rate limit ≤ 1 per 10 min)
}

/**
 * POST /api/v1/hardware/<action> (JSON, X-Leon-Token). Every answer is HardwareOutcome; the UI
 * refreshes the view afterwards and never reports success for anything but 'applied'.
 */
export interface HardwareActions {
  '/api/v1/hardware/led': { name: LedName; mode: Exclude<LedMode, 'unknown'> };
  '/api/v1/hardware/led-schedule': { schedule: { start: string; end: string } | null };
  '/api/v1/hardware/ethernet-leds': { state: 'on' | 'off' };
  '/api/v1/hardware/usb-power': { state: 'on' | 'off' };
  '/api/v1/hardware/radio': { kind: RadioKind; state: 'on' | 'off' };
  '/api/v1/hardware/cpu-profile': { profile: CpuProfile };
  '/api/v1/hardware/restart-service': { unit: RestartableUnit };
  '/api/v1/hardware/power': { action: 'reboot' | 'shutdown'; confirm: string }; // confirm must equal session.node
}
export type HardwareStatus = 'applied' | 'pendingReboot' | 'refused' | 'unverified' | 'unavailable' | 'invalid' | 'forbidden';
export interface HardwareOutcome {
  status: HardwareStatus;
  message: string; // human wording for the toast, ≤ 200 chars
}

// Parsing: unknown in, HardwareView out. Lists are bounded and closed sets are checked; a missing
// reading stays null (unknown), a malformed shape throws.
const SWITCHABLE: ReadonlyArray<Switchable> = ['on', 'off', 'unknown'];
const UNITS: ReadonlyArray<RestartableUnit> = ['pihole-FTL', 'unbound', 'ntfy', 'smbd', 'leon-router', 'leon-n8n', 'leon-overview-redirect'];
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseFlags(value: unknown): ThrottleFlags {
  const root = record(value);
  return { underVoltage: boolean(root.underVoltage), frequencyCapped: boolean(root.frequencyCapped), throttled: boolean(root.throttled), softTemperatureLimit: boolean(root.softTemperatureLimit) };
}
function parseClockTime(value: unknown): string {
  const text = string(value, 5);
  if (!CLOCK_TIME.test(text)) throw new Error('Invalid time');
  return text;
}

export function parseHardware(value: unknown): HardwareView {
  const root = record(value),
    readings = record(root.readings),
    ethernet = record(root.ethernetLeds),
    usb = record(root.usb),
    cpu = record(root.cpu),
    power = record(root.power);
  return {
    observedAt: number(root.observedAt, 1, Date.now() / 1000 + 30),
    helper: oneOf(root.helper, ['available', 'unavailable']),
    board: nullable(root.board, item => string(item, 100)),
    readings: {
      uptimeSeconds: nullableNumber(readings.uptimeSeconds, 0, 1e9),
      temperatureCelsius: nullableNumber(readings.temperatureCelsius, -50, 200),
      cpuPercent: nullableNumber(readings.cpuPercent, 0, 100),
      memoryAvailableBytes: nullableNumber(readings.memoryAvailableBytes, 0, 2 ** 50),
      storageFreeBytes: nullableNumber(readings.storageFreeBytes, 0, 2 ** 60),
      throttling: nullable(readings.throttling, item => {
        const throttling = record(item);
        return { now: parseFlags(throttling.now), sinceBoot: parseFlags(throttling.sinceBoot) };
      }),
    },
    leds: items(root.leds, 2, item => {
      const led = record(item);
      return { name: oneOf(led.name, ['ACT', 'PWR']), mode: oneOf(led.mode, ['on', 'off', 'auto', 'unknown']) };
    }),
    ledSchedule: nullable(root.ledSchedule, item => {
      const schedule = record(item);
      return { start: parseClockTime(schedule.start), end: parseClockTime(schedule.end) };
    }),
    ethernetLeds: { configured: oneOf(ethernet.configured, SWITCHABLE), pendingReboot: boolean(ethernet.pendingReboot) },
    usb: {
      isSupported: boolean(usb.isSupported),
      power: oneOf(usb.power, SWITCHABLE),
      devices: items(usb.devices, 16, item => {
        const device = record(item);
        return { name: string(device.name, 100), isStorage: boolean(device.isStorage), isMounted: boolean(device.isMounted) };
      }),
      powerOffBlockedBy: nullable(usb.powerOffBlockedBy, item => string(item, 200)),
    },
    radios: items(root.radios, 2, item => {
      const radio = record(item);
      return { kind: oneOf(radio.kind, ['wifi', 'bluetooth']), state: oneOf(radio.state, SWITCHABLE), isHardBlocked: boolean(radio.isHardBlocked), isUplink: boolean(radio.isUplink) };
    }),
    cpu: {
      profile: oneOf(cpu.profile, ['balanced', 'powersave', 'performance', 'custom', 'unknown']),
      governor: nullable(cpu.governor, item => string(item, 40)),
      frequencyMhz: nullableNumber(cpu.frequencyMhz, 0, 10_000),
    },
    services: items(root.services, UNITS.length, item => {
      const service = record(item);
      return { unit: oneOf(service.unit, UNITS), label: string(service.label, 100), state: string(service.state, 40) };
    }),
    power: { rebootRequired: boolean(power.rebootRequired), rebootAllowedAt: nullable(power.rebootAllowedAt, item => number(item, 1, 4_102_444_800)) },
  };
}
