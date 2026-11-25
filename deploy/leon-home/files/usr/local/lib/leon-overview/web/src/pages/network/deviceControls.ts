import { postNetwork } from '../../api.js';
import type { Day, Device, Feedback, Schedule, Snapshot } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import { language, serverText, t } from '../../i18n/index.js';
import { feedbackFor } from '../../presentation.js';
import { parseSchedule } from '../../snapshot.js';
import { button } from '../../ui/button.js';
import { confirm } from '../../ui/confirm.js';
import { list, type ListRow } from '../../ui/list.js';
import { card } from '../../ui/section.js';
import { createSwitch } from '../../ui/switch.js';
import { showToast } from '../../ui/toast.js';
import type { LiveControls } from '../settings/livePage.js';
import { sendNetworkAction, switchOutcome } from './model.js';

const RENAME_OUTCOMES = {
  saved: ['good', t('Saved. The Pi-hole name updates in seconds. Leave empty to use the default name from the Pi.')],
  unknownDevice: ['warn', t('The scan has not found the MAC address of this device yet.')],
  forbidden: ['warn', t('Your page session expired. Reload to continue.')],
  invalid: ['warn', t('Invalid name.')],
  unavailable: ['warn', t('Could not save.')],
  network: ['warn', t('LEÓN Home could not be reached.')],
} satisfies Record<string, Feedback>;

const PAUSE_OUTCOMES = {
  applied: ['good', t('Done. The router confirmed the change.')],
  unchanged: ['good', t('Already set.')],
  unverified: ['warn', t('The result could not be confirmed. Check the state before trying again.')],
  filterUnavailable: ['warn', t('Enable blocklist mode in the router MAC filter.')],
  protectedDevice: ['warn', t('Protected device. LEÓN cannot pause it.')],
  wiredDevice: ['warn', t('This device is wired. The Wi-Fi filter cannot pause it.')],
  filterFull: ['warn', t('The router blocklist is full (32 entries).')],
  unknownDevice: ['warn', t('The router does not currently see this device.')],
  locked: ['warn', t('The router session is locked.')],
  busy: ['warn', t('Wait a few seconds between changes.')],
  rejected: ['warn', t('The router did not accept the change.')],
  forbidden: ['warn', t('Your page session expired. Reload to continue.')],
  unavailable: ['warn', t('The router monitor is not responding.')],
  invalid: ['warn', t('Invalid request.')],
  network: ['warn', t('LEÓN Home could not be reached.')],
} satisfies Record<string, Feedback>;

const SCHEDULE_OUTCOMES = {
  saved: ['good', t('Schedule saved. If the window has already started, it applies at the next start or end.')],
  cleared: ['good', t('Schedule removed. Its current state is unchanged. A paused device stays paused until resumed.')],
  protectedDevice: ['warn', t('Protected device. A schedule cannot be set.')],
  unknownDevice: ['warn', t('The scan has not found the MAC address of this device yet.')],
  invalid: ['warn', t('Choose at least one day and two different times.')],
  forbidden: ['warn', t('Your page session expired. Reload to continue.')],
  unavailable: ['warn', t('Could not save.')],
  network: ['warn', t('LEÓN Home could not be reached.')],
} satisfies Record<string, Feedback>;

const DAY_LABELS = language === 'es' ? (['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const) : (['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const),
  DAY_NAMES = [t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday'), t('Sunday')] as const;

/** Edits and outcomes that outlive repaints of the device page. */
export interface DeviceMemory {
  renameFeedback: Feedback | null;
  pauseFeedback: Feedback | null;
  scheduleFeedback: Feedback | null;
  isEditingSchedule: boolean;
  draftDays: Set<Day>;
  draftStart: string;
  draftEnd: string;
  isActing: boolean;
}
export function createDeviceMemory(): DeviceMemory {
  return { renameFeedback: null, pauseFeedback: null, scheduleFeedback: null, isEditingSchedule: false, draftDays: new Set(), draftStart: '', draftEnd: '', isActing: false };
}
export interface DeviceControlProps {
  device: Device;
  snapshot: Snapshot;
  memory: DeviceMemory;
  token: string;
  /** Readings are from an earlier scan or the last refresh failed: controls stay read-only. */
  isReadOnly: boolean;
  controls: LiveControls;
}

function feedbackNote(feedback: Feedback | null): HTMLElement | null {
  return feedback ? h('p', { className: `note is-${feedback[0]}`, attrs: { role: 'status' }, text: feedback[1] }) : null;
}
const isDay = (value: number): value is Day => value >= 0 && value <= 6;

function scheduleText(schedule: Schedule): string {
  const days = schedule.days,
    label = days.length === 7 ? t('Every day') : days.join() === '0,1,2,3,4' ? t('Mon–Fri') : days.join() === '5,6' ? t('Weekend') : days.map(day => DAY_LABELS[day]).join(' ');
  return `${label} · ${schedule.start} → ${schedule.end}${schedule.end < schedule.start ? t(' (next day)') : ''}`;
}

export function renameForm({ device, memory, token, controls, isReadOnly }: DeviceControlProps): HTMLElement | null {
  if (!device.canRename) return null;
  const input = h('input', {
      className: 'text-input',
      attrs: { 'type': 'text', 'maxlength': '40', 'autocomplete': 'off', 'enterkeyhint': 'done', 'placeholder': t('Device name'), 'aria-label': t('Device name') },
    }),
    submit = button({ label: t('Rename'), isDisabled: isReadOnly, onPress: () => {} }),
    form = h('form', { className: 'inline-form' }, [input, submit]);
  input.value = device.name === device.address ? '' : device.name;
  submit.type = 'submit';
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (memory.isActing) return;
    void controls.run(async () => {
      memory.isActing = true;
      try {
        const status = await sendNetworkAction('/api/v1/network/name', { address: device.id, name: input.value }, token);
        memory.renameFeedback = feedbackFor(RENAME_OUTCOMES, status, 'invalid');
      } finally {
        memory.isActing = false;
      }
    });
  });
  return card([form, feedbackNote(memory.renameFeedback)]);
}

/** Pause = the router's Wi-Fi blocklist. The switch shows "access allowed"; pausing asks first, resuming acts at once. */
export function pauseRow({ device, memory, token, controls, isReadOnly }: DeviceControlProps): ListRow | null {
  if (!device.canPause) return null;
  const outcome = memory.pauseFeedback,
    toggle = createSwitch({
      label: t('Network access'),
      checked: !device.paused,
      isDisabled: isReadOnly || token === '',
      onChange: allow =>
        controls.run(async () => {
          if (memory.isActing) return 'cancelled';
          if (!allow) {
            const isConfirmed = await confirm({
              title: t('Pause {0}?', device.name),
              message: t('The device will lose Wi-Fi access until you resume it. This applies to its current MAC address; a rotating private address may bypass it.'),
              confirmLabel: t('Pause'),
              tone: 'danger',
            });
            if (!isConfirmed) return 'cancelled';
          }
          memory.isActing = true;
          memory.pauseFeedback = null;
          let status: string;
          try {
            status = await sendNetworkAction('/api/v1/network/pause', { address: device.id, paused: !allow }, token);
          } finally {
            memory.isActing = false;
          }
          memory.pauseFeedback = feedbackFor(PAUSE_OUTCOMES, status, 'invalid');
          return switchOutcome(status);
        }),
    });
  return { kind: 'switch', title: t('Network access'), detail: outcome?.[1] ?? (device.paused ? t('Paused. Wi-Fi is blocked until resumed') : t('Allowed · Wi-Fi')), control: toggle.element };
}

/** A wired device cannot be paused by the Wi-Fi filter; its Internet is cut at its router port. */
export function wiredRow({ device, snapshot }: DeviceControlProps): ListRow | null {
  if (device.role === 'router' || device.traffic?.connection !== 'ethernet') return null;
  const telemetry = snapshot.routerTelemetry,
    allowed = new Set(telemetry.controllablePorts),
    ports = (telemetry.ports ?? []).filter(port => allowed.has(port.port) && port.wan !== true),
    own = device.traffic.port;
  return {
    kind: 'navigation',
    title: own ? t('Network access · LAN {0}', own) : t('Network access · Ethernet'),
    href: own ? `/network?view=ports&port=${own}` : '/network?view=ports',
    detail: own
      ? allowed.has(own)
        ? t('On LAN {0}. Switch off that port to cut its Internet; everything on it disconnects.', own)
        : t('On LAN {0}, a protected port. The Wi-Fi pause does not apply to wired devices.', own)
      : t(
          'The Wi-Fi pause does not apply to wired devices. {0}',
          ports.length
            ? t('Ports you can switch off: {0}.', ports.map(port => `LAN ${port.port}${port.enabled === false ? t(' (off)') : port.link === 'up' ? t(' (connected)') : t(' (no cable)')}`).join(', '))
            : t('No port is authorized to be switched off.')
        ),
  };
}

async function saveSchedule(props: DeviceControlProps, schedule: Schedule | null): Promise<boolean> {
  const { device, memory, token } = props;
  memory.isActing = true;
  try {
    const status = await sendNetworkAction('/api/v1/network/schedule', { address: device.id, schedule }, token);
    memory.scheduleFeedback = feedbackFor(SCHEDULE_OUTCOMES, status === 'saved' && !schedule ? 'cleared' : status, 'invalid');
    if (status === 'saved') memory.isEditingSchedule = false;
    return status === 'saved';
  } finally {
    memory.isActing = false;
  }
}

/** The drafted window, or null when it is not a valid schedule. */
function draftSchedule(days: Array<Day>, start: string, end: string): Schedule | null {
  if (start === end) return null;
  try {
    return parseSchedule({ days, start, end });
  } catch {
    return null;
  }
}

function editor(props: DeviceControlProps): HTMLElement {
  const { memory, controls, isReadOnly } = props,
    chips = DAY_NAMES.map((name, index) => {
      const day = index,
        chipButton = h('button', {
          className: 'day-chip',
          text: DAY_LABELS[index] ?? '',
          attrs: { 'type': 'button', 'aria-label': name, 'aria-pressed': String(isDay(day) && memory.draftDays.has(day)) },
        });
      chipButton.disabled = isReadOnly;
      chipButton.addEventListener('click', () => {
        if (!isDay(day)) return;
        if (memory.draftDays.has(day)) memory.draftDays.delete(day);
        else memory.draftDays.add(day);
        chipButton.setAttribute('aria-pressed', String(memory.draftDays.has(day)));
      });
      return chipButton;
    }),
    start = h('input', { className: 'time-input', attrs: { type: 'time' } }),
    end = h('input', { className: 'time-input', attrs: { type: 'time' } });
  start.value = memory.draftStart;
  end.value = memory.draftEnd;
  start.addEventListener('change', () => (memory.draftStart = start.value));
  end.addEventListener('change', () => (memory.draftEnd = end.value));
  const save = button({
      label: t('Save schedule'),
      variant: 'primary',
      isDisabled: isReadOnly,
      onPress: () => {
        memory.draftStart = start.value;
        memory.draftEnd = end.value;
        const days = [...memory.draftDays].sort();
        const schedule = draftSchedule(days, start.value, end.value);
        if (!schedule) {
          memory.scheduleFeedback = SCHEDULE_OUTCOMES.invalid;
          controls.repaint();
          return;
        }
        const valid = schedule;
        void controls.run(() => saveSchedule(props, valid));
      },
    }),
    cancel = button({
      label: t('Cancel'),
      onPress: () => {
        memory.isEditingSchedule = false;
        memory.scheduleFeedback = null;
        controls.repaint();
      },
    });
  return card([
    h('div', { className: 'day-chips', attrs: { 'role': 'group', 'aria-label': t('Days') } }, chips),
    h('div', { className: 'time-fields' }, [
      h('label', { className: 'time-field' }, [h('span', { text: t('From') }), start]),
      h('label', { className: 'time-field' }, [h('span', { text: t('Until') }), end]),
    ]),
    h('div', { className: 'buttons' }, [save, cancel]),
  ]);
}

/** Weekly pause window, opt-in per device. Days are Monday-first like the Pi (Mon=0); times are the Pi's local time. */
export function scheduleBlock(props: DeviceControlProps): Array<Child> {
  const { device, memory, controls, isReadOnly } = props;
  if (!(device.canPause || device.pauseSchedule)) return [];
  const saved = device.pauseSchedule,
    toggle = createSwitch({
      label: t('Scheduled pause'),
      checked: saved !== null || memory.isEditingSchedule,
      isDisabled: isReadOnly,
      onChange: async requested => {
        if (requested) {
          startEditing(props);
          controls.repaint();
          return 'cancelled';
        }
        if (saved) return controls.run(async () => ((await saveSchedule(props, null)) ? 'applied' : 'refused'));
        memory.isEditingSchedule = false;
        controls.repaint();
        return 'cancelled';
      },
    }),
    detail = memory.isEditingSchedule
      ? t('Choose days and times in the local time on the Pi. Nothing applies until you save.')
      : saved
        ? t('Active: {0}. Pauses at the start and resumes at the end.', scheduleText(saved))
        : t('Disabled. LEÓN will not pause this device on a schedule.'),
    editLink = saved && !memory.isEditingSchedule ? button({ label: t('Edit schedule'), onPress: () => (startEditing(props), controls.repaint()) }) : null;
  return [
    list([{ kind: 'switch', title: t('Scheduled pause'), detail, control: toggle.element }]),
    editLink ? h('div', { className: 'buttons spaced' }, [editLink]) : null,
    memory.isEditingSchedule ? editor(props) : null,
    feedbackNote(memory.scheduleFeedback),
  ];
}

function startEditing({ device, memory }: DeviceControlProps): void {
  memory.isEditingSchedule = true;
  memory.draftDays = new Set(device.pauseSchedule?.days ?? []);
  memory.draftStart = device.pauseSchedule?.start ?? '';
  memory.draftEnd = device.pauseSchedule?.end ?? '';
  memory.scheduleFeedback = null;
}

/** Wake-on-LAN: a magic packet cannot confirm the device woke, so only "sent" is ever claimed. */
export function wakeRow({ device, token, controls, isReadOnly }: DeviceControlProps): ListRow | null {
  if (!device.canWake) return null;
  return {
    kind: 'action',
    title: t('Wake'),
    detail: t('Sends a Wake-on-LAN packet. The device may take a minute to appear.'),
    isDisabled: isReadOnly || token === '',
    onSelect: () => {
      void controls.run(async () => {
        try {
          const reply = await postNetwork('/api/v1/network/wake', { address: device.id }, token);
          if (reply.outcome === 'sent') showToast('applied', serverText(reply.message) || t('Wake signal sent. Check back in a minute.'));
          else showToast('refused', serverText(reply.message) || t('The wake signal could not be sent.'));
        } catch {
          showToast('refused', t('LEÓN Home could not be reached.'));
        }
      });
    },
  };
}
