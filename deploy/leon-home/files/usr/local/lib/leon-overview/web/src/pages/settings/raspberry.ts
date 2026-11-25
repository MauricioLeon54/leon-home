import type { HardwareView, LedMode, ThrottleFlags } from '../../contracts/hardware.js';
import { h } from '../../core/dom.js';
import { bytes, celsius, duration, percent, UNKNOWN } from '../../core/format.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { list, type ListRow } from '../../ui/list.js';
import { readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { metric } from '../home/context.js';
import { navRow } from './controls.js';
import { hardwarePage } from './hardwarePage.js';

type Throttling = NonNullable<HardwareView['readings']['throttling']>;

/** The worst current condition first, then what happened since boot. */
export function powerState(throttling: Throttling | null): { label: string; needsAttention: boolean } | null {
  if (throttling === null) return null;
  const { now, sinceBoot } = throttling;
  if (now.underVoltage) return { label: t('Low voltage now'), needsAttention: true };
  if (now.throttled) return { label: t('Throttled now'), needsAttention: true };
  if (now.frequencyCapped) return { label: t('Frequency capped now'), needsAttention: true };
  if (now.softTemperatureLimit) return { label: t('Temperature limit now'), needsAttention: true };
  if (sinceBoot.underVoltage) return { label: t('Low voltage since boot'), needsAttention: true };
  if (isAnySet(sinceBoot)) return { label: t('Throttled since boot'), needsAttention: true };
  return { label: t('OK'), needsAttention: false };
}
export function isAnySet(flags: ThrottleFlags): boolean {
  return flags.underVoltage || flags.frequencyCapped || flags.throttled || flags.softTemperatureLimit;
}

const MODE_TEXT = { on: t('on'), off: t('off'), auto: t('auto'), unknown: '—' } satisfies Record<LedMode, string>;
const RADIO_LABELS = { wifi: 'Wi-Fi', bluetooth: 'Bluetooth' } as const;

function lightsSummary(view: HardwareView): string | undefined {
  const mode = (name: 'ACT' | 'PWR') => MODE_TEXT[view.leds.find(led => led.name === name)?.mode ?? 'unknown'];
  return view.leds.length ? t('Activity {0} · Power {1}', mode('ACT'), mode('PWR')) : undefined;
}

export function renderRaspberry(context: RouteContext): PageView {
  return hardwarePage(context, (view, _io, state) => {
    const { readings } = view,
      power = powerState(readings.throttling),
      isHot = (readings.temperatureCelsius ?? 0) >= 70,
      radios = view.radios.map(radio => `${RADIO_LABELS[radio.kind]} ${radio.state === 'unknown' ? '—' : serverText(radio.state)}`).join(' · '),
      rows: Array<ListRow> = [
        navRow(t('Lights'), '/settings/raspberry/lights', lightsSummary(view)),
        navRow('USB', '/settings/raspberry/usb', view.usb.isSupported ? t('Power {0}', view.usb.power === 'unknown' ? '—' : serverText(view.usb.power)) : undefined),
        navRow(t('Radios'), '/settings/raspberry/radios', radios || undefined),
        navRow(t('Performance'), '/settings/raspberry/performance'),
        navRow(t('Power & services'), '/settings/raspberry/power', view.power.rebootRequired ? t('Restart needed') : undefined),
      ];
    return [
      section(view.board ? { title: view.board } : {}, [
        card([
          readingGrid(
            [
              metric(state, t('Temperature'), readings.temperatureCelsius, celsius, isHot ? 'warn' : undefined),
              metric(state, t('CPU'), readings.cpuPercent, value => percent(value)),
              metric(state, t('Free memory'), readings.memoryAvailableBytes, bytes),
              metric(state, t('Free storage'), readings.storageFreeBytes, bytes),
              metric(state, t('Uptime'), readings.uptimeSeconds, duration),
            ],
            3
          ),
          view.power.rebootRequired ? h('p', { className: 'note', text: t('Restart needed after system updates.') }) : null,
        ]),
      ]),
      section({}, [
        list([
          {
            kind: 'value',
            title: t('Power'),
            value: power?.label ?? UNKNOWN,
            leading: { kind: 'dot', tone: power === null ? 'unknown' : power.needsAttention ? 'warn' : 'good' },
          },
        ]),
      ]),
      section({}, [list(rows)]),
    ];
  });
}
