import type { HardwareView, LedName } from '../../contracts/hardware.js';
import { h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { badge } from '../../ui/badge.js';
import { button } from '../../ui/button.js';
import { list } from '../../ui/list.js';
import { card, section } from '../../ui/section.js';
import { createSegmented } from '../../ui/segmented.js';
import { createSwitch } from '../../ui/switch.js';
import { controlGroup, switchable, timeField } from './controls.js';
import { type HardwareIO, hardwarePage } from './hardwarePage.js';

type LightChoice = 'auto' | 'on' | 'off';
const DEFAULT_SCHEDULE = { start: '22:00', end: '07:00' };

function ledControl(view: HardwareView, io: HardwareIO, name: LedName, label: string): HTMLElement {
  const mode = view.leds.find(led => led.name === name)?.mode,
    segmented = createSegmented<LightChoice>({
      label,
      options: [
        { value: 'auto', label: t('Auto') },
        { value: 'on', label: t('On') },
        { value: 'off', label: t('Off') },
      ],
      value: mode === undefined || mode === 'unknown' ? null : mode,
      isDisabled: io.isUnavailable || mode === undefined,
      onChange: next => void io.act('/api/v1/hardware/led', { name, mode: next }),
    });
  return controlGroup(label, segmented.element);
}

function nightSchedule(view: HardwareView, io: HardwareIO): Array<HTMLElement> {
  const schedule = view.ledSchedule,
    start = timeField(t('From'), (schedule ?? DEFAULT_SCHEDULE).start),
    end = timeField(t('Until'), (schedule ?? DEFAULT_SCHEDULE).end),
    save = (): Promise<'applied' | 'refused' | 'unverified' | 'cancelled'> => io.act('/api/v1/hardware/led-schedule', { schedule: { start: start.input.value, end: end.input.value } }),
    toggle = createSwitch({
      label: t('Night schedule'),
      checked: io.isUnavailable ? null : schedule !== null,
      isDisabled: io.isUnavailable,
      onChange: requested => (requested ? save() : io.act('/api/v1/hardware/led-schedule', { schedule: null })),
    }),
    saveButton = button({ label: t('Save times'), isDisabled: io.isUnavailable || schedule === null, onPress: () => void save() });
  return [
    list([{ kind: 'switch', title: t('Night schedule'), detail: t('Lights are off between these times'), control: toggle.element }]),
    card([h('div', { className: 'time-fields' }, [start.element, end.element]), h('div', { className: 'buttons' }, [saveButton])]),
  ];
}

export function renderLights(context: RouteContext): PageView {
  return hardwarePage(context, (view, io) => {
    const ethernet = createSwitch({
      label: t('Ethernet port lights'),
      checked: io.isUnavailable ? null : switchable(view.ethernetLeds.configured),
      isDisabled: io.isUnavailable,
      onChange: requested => io.act('/api/v1/hardware/ethernet-leds', { state: requested ? 'on' : 'off' }),
    });
    return [
      section({ title: t('Status lights') }, [card([ledControl(view, io, 'ACT', t('Activity light')), ledControl(view, io, 'PWR', t('Power light'))])]),
      section({ title: t('Ethernet port') }, [
        list([
          {
            kind: 'switch',
            title: t('Port lights'),
            detail: t('Applies after the next restart'),
            control: ethernet.element,
            accessories: view.ethernetLeds.pendingReboot ? [badge(t('Restart pending'))] : [],
          },
        ]),
      ]),
      section({}, nightSchedule(view, io)),
    ];
  });
}
