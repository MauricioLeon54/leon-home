import type { CpuProfile, HardwareView, ThrottleFlags } from '../../contracts/hardware.js';
import { h } from '../../core/dom.js';
import { UNKNOWN } from '../../core/format.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { list } from '../../ui/list.js';
import { card, section } from '../../ui/section.js';
import { createSegmented } from '../../ui/segmented.js';
import { controlGroup } from './controls.js';
import { hardwarePage } from './hardwarePage.js';

const FLAGS = [
  ['underVoltage', t('Low voltage')],
  ['frequencyCapped', t('Frequency capped')],
  ['throttled', t('Throttled')],
  ['softTemperatureLimit', t('Temperature limit')],
] as const satisfies ReadonlyArray<readonly [keyof ThrottleFlags, string]>;

function profileNote(cpu: HardwareView['cpu']): string | null {
  if (cpu.profile === 'custom') return t('Custom setting{0}. Choose a profile to replace it.', cpu.governor ? ` (${cpu.governor})` : '');
  return cpu.profile === 'unknown' ? t('The CPU profile cannot be read.') : null;
}

function flagRows(flags: ThrottleFlags) {
  return list(
    FLAGS.map(([key, label]) => ({
      kind: 'value' as const,
      title: label,
      value: flags[key] ? t('Yes') : t('No'),
      leading: { kind: 'dot' as const, tone: flags[key] ? ('warn' as const) : ('good' as const) },
    }))
  );
}

export function renderPerformance(context: RouteContext): PageView {
  return hardwarePage(context, (view, io) => {
    const { cpu } = view,
      { throttling } = view.readings,
      profile = (['balanced', 'powersave', 'performance'] as const).find(item => item === cpu.profile) ?? null,
      note = profileNote(cpu),
      segmented = createSegmented<CpuProfile>({
        label: t('CPU profile'),
        options: [
          { value: 'balanced', label: t('Balanced') },
          { value: 'powersave', label: t('Power saving') },
          { value: 'performance', label: t('Performance') },
        ],
        value: profile,
        isDisabled: io.isUnavailable,
        onChange: next => void io.act('/api/v1/hardware/cpu-profile', { profile: next }),
      });
    return [
      section({ title: t('CPU') }, [
        card([controlGroup(t('Profile'), segmented.element), note ? h('p', { className: 'note', text: note }) : null]),
        list([{ kind: 'value', title: t('Current frequency'), value: cpu.frequencyMhz === null ? UNKNOWN : `${Math.round(cpu.frequencyMhz)} MHz` }]),
      ]),
      throttling ? section({ title: t('Throttling now') }, [flagRows(throttling.now)]) : section({ title: t('Throttling') }, [h('p', { className: 'note', text: t('No reading from the firmware.') })]),
      throttling ? section({ title: t('Since boot') }, [flagRows(throttling.sinceBoot)]) : null,
    ];
  });
}
