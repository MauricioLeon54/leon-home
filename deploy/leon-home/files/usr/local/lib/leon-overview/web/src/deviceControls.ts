import { postAction } from './api.js';
import type { ControlContext, Device, Feedback, Schedule } from './contracts.js';
import { $, feedbackFor } from './presentation.js';
import { parseSchedule } from './snapshot.js';
export function createDeviceControls({
  getState,
  getSelectedID,
  onInspect,
  refresh,
  isRefreshing,
}: Pick<ControlContext, 'getState' | 'refresh' | 'isRefreshing'> & { getSelectedID: () => string | null; onInspect: () => void }) {
  function renameForm(device: Device | undefined) {
    const form = $('#rename', HTMLFormElement),
      input = $('#rename-input', HTMLInputElement);
    form.hidden = !device?.canRename;
    if (!device || document.activeElement === input || form.dataset.id === device.id) return;
    form.dataset.id = device.id;
    input.value = device.name === device.address ? '' : device.name;
    $('#rename-status').textContent = '';
  }
  const RENAME_OUTCOMES = {
    saved: ['good', 'Saved. The Pi-hole name updates in seconds. Leave empty to use the default name from the Pi.'],
    unknownDevice: ['warn', 'The scan has not found the MAC address of this device yet.'],
    forbidden: ['warn', 'Your page session expired. Reload to continue.'],
    invalid: ['warn', 'Invalid name.'],
    unavailable: ['warn', 'Could not save.'],
    network: ['warn', 'LEÓN Home could not be reached.'],
  } satisfies Record<string, Feedback>;
  $('#rename', HTMLFormElement).addEventListener('submit', event => {
    void rename(event);
  });
  async function rename(event: Event): Promise<void> {
    event.preventDefault();
    const form = $('#rename', HTMLFormElement),
      button = $('#rename-submit', HTMLButtonElement),
      status = $('#rename-status');
    if (!getState()?.actionToken || button.disabled || !form.dataset.id) return;
    button.disabled = true;
    let result;
    try {
      const reply = await postAction('/network-map/name', { address: form.dataset.id ?? '', name: $('#rename-input', HTMLInputElement).value }, getState()?.actionToken ?? '');
      result = reply.httpStatus === 403 ? 'forbidden' : reply.outcome;
    } catch (error) {
      result = 'network';
    } finally {
      button.disabled = false;
    }
    const [tone, message] = feedbackFor(RENAME_OUTCOMES, result, 'invalid');
    status.textContent = message;
    status.className = 'small ' + tone;
    $('#rename-input', HTMLInputElement).blur();
    await refresh();
  }
  // Pause = the router's Wi-Fi blocklist. The switch shows "access allowed"; pausing asks first,
  // resuming acts at once. While pending it shows the requested position until the router re-read.
  let pausePending: { id: string; paused: boolean } | null = null;
  let pauseOutcome: { id: string; status: string } | null = null;
  const PAUSE_OUTCOMES = {
    applied: ['good', 'Done. The router confirmed the change.'],
    unchanged: ['good', 'Already set.'],
    unverified: ['warn', 'The result could not be confirmed. Check the state before trying again.'],
    filterUnavailable: ['warn', 'Enable blocklist mode in the router MAC filter.'],
    protectedDevice: ['warn', 'Protected device. LEÓN cannot pause it.'],
    wiredDevice: ['warn', 'This device is wired. The Wi-Fi filter cannot pause it.'],
    filterFull: ['warn', 'The router blocklist is full (32 entries).'],
    unknownDevice: ['warn', 'The router does not currently see this device.'],
    locked: ['warn', 'The router session is locked.'],
    busy: ['warn', 'Wait a few seconds between changes.'],
    rejected: ['warn', 'The router did not accept the change.'],
    forbidden: ['warn', 'Your page session expired. Reload to continue.'],
    unavailable: ['warn', 'The router monitor is not responding.'],
    invalid: ['warn', 'Invalid request.'],
    network: ['warn', 'LEÓN Home could not be reached.'],
  } satisfies Record<string, Feedback>;
  function renderPause(device: Device | undefined) {
    const row = $('#pause-row'),
      toggle = $('#pause-switch', HTMLInputElement),
      note = $('#pause-note');
    row.hidden = !device?.canPause;
    if (!device) return;
    const pending = pausePending?.id === device.id ? pausePending : null;
    toggle.checked = pending ? !pending.paused : !device.paused;
    if (pending) toggle.setAttribute('aria-busy', 'true');
    else toggle.removeAttribute('aria-busy');
    toggle.disabled = Boolean(pausePending) || !getState()?.actionToken;
    const outcome = pauseOutcome?.id === device.id ? feedbackFor(PAUSE_OUTCOMES, pauseOutcome.status, 'invalid') : null;
    note.textContent = pending ? 'Applying…' : outcome ? outcome[1] : device.paused ? 'Paused. Wi-Fi is blocked until resumed' : 'Allowed · Wi-Fi';
    note.className = pending ? '' : outcome ? outcome[0] : '';
  }
  $('#pause-switch', HTMLInputElement).addEventListener('change', () => {
    const toggle = $('#pause-switch', HTMLInputElement),
      device = getState()?.devices.find(item => item.id === getSelectedID());
    const allow = toggle.checked;
    toggle.checked = !allow;
    if (!device) return;
    if (allow) {
      void applyPause(device.id, false);
      return;
    }
    const dialog = $('#confirm', HTMLDialogElement);
    $('#confirm-title').textContent = 'Pause ' + device.name + '?';
    $('#confirm-text').textContent = 'The device will lose Wi-Fi access until you resume it. This applies to its current MAC address; a rotating private address may bypass it.';
    const ok = $('#confirm-ok', HTMLButtonElement);
    ok.textContent = 'Pause';
    ok.className = 'danger';
    ok.onclick = () => {
      dialog.close();
      void applyPause(device.id, true);
    };
    $('#confirm-cancel', HTMLButtonElement).onclick = () => dialog.close();
    dialog.showModal();
  });
  async function applyPause(id: string, paused: boolean): Promise<void> {
    if (pausePending) return;
    pausePending = { id, paused };
    pauseOutcome = null;
    onInspect();
    let status;
    try {
      const reply = await postAction('/network-map/pause', { address: id, paused }, getState()?.actionToken ?? '');
      status = reply.httpStatus === 403 ? 'forbidden' : reply.httpStatus === 503 ? 'unavailable' : reply.outcome;
    } catch (error) {
      status = 'network';
    } // never retried: the router may already have applied it
    pauseOutcome = { id, status };
    while (isRefreshing()) await new Promise(resolve => setTimeout(resolve, 100));
    await refresh();
    pausePending = null;
    onInspect();
  }
  // Weekly pause window, opt-in per device: off by default; nothing applies until "Save schedule".
  // Days are Monday-first like the Pi (Mon=0); times are the Pi's local time. Static markup, so refreshes
  // never discard an edit in progress.
  const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const,
    DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  let schedEditing: string | null = null;
  for (const [index, label] of DAY_LABELS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.day = String(index);
    button.setAttribute('aria-label', DAY_NAMES[index] ?? 'day');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true')));
    $('#sched-days').append(button);
  }
  function scheduleText(schedule: Schedule) {
    const days = schedule.days;
    const label = days.length === 7 ? 'Every day' : days.join() === '0,1,2,3,4' ? 'Mon–Fri' : days.join() === '5,6' ? 'Weekend' : days.map(day => DAY_LABELS[day]).join(' ');
    return `${label} · ${schedule.start} → ${schedule.end}${schedule.end < schedule.start ? ' (next day)' : ''}`;
  }
  function fillEditor(schedule: Schedule | null) {
    for (const button of $('#sched-days').querySelectorAll<HTMLButtonElement>('button'))
      button.setAttribute('aria-pressed', String(Boolean(schedule?.days.some(day => day === Number(button.dataset.day)))));
    $('#sched-start', HTMLInputElement).value = schedule?.start || '';
    $('#sched-end', HTMLInputElement).value = schedule?.end || '';
  }
  function renderSchedule(device: Device | undefined) {
    const box = $('#schedule');
    box.hidden = !device || !(device.canPause || device.pauseSchedule);
    if (!device || box.hidden) {
      if (!device) schedEditing = null;
      return;
    }
    if (box.dataset.id !== device.id) {
      box.dataset.id = device.id;
      schedEditing = null;
      $('#sched-status').textContent = '';
    }
    const saved = device.pauseSchedule,
      editing = schedEditing === device.id,
      summary = $('#sched-summary');
    $('#sched-switch', HTMLInputElement).checked = Boolean(saved) || editing;
    $('#sched-editor').hidden = !editing;
    $('#sched-edit').hidden = !saved || editing;
    summary.className = saved && !editing ? 'good' : '';
    summary.textContent = editing
      ? 'Choose days and times in the local time on the Pi. Nothing applies until you save.'
      : saved
        ? `Active: ${scheduleText(saved)}. Pauses at the start and resumes at the end.`
        : 'Disabled. LEÓN will not pause this device on a schedule.';
  }
  function selectedDevice() {
    return getState()?.devices.find(item => item.id === getSelectedID());
  }
  function startEditing(device: Device) {
    schedEditing = device.id;
    fillEditor(device.pauseSchedule);
    $('#sched-status').textContent = '';
    renderSchedule(device);
  }
  const SCHEDULE_OUTCOMES = {
    saved: ['good', 'Schedule saved. If the window has already started, it applies at the next start or end.'],
    cleared: ['good', 'Schedule removed. Its current state is unchanged. A paused device stays paused until resumed.'],
    protectedDevice: ['warn', 'Protected device. A schedule cannot be set.'],
    unknownDevice: ['warn', 'The scan has not found the MAC address of this device yet.'],
    invalid: ['warn', 'Choose at least one day and two different times.'],
    forbidden: ['warn', 'Your page session expired. Reload to continue.'],
    unavailable: ['warn', 'Could not save.'],
    network: ['warn', 'LEÓN Home could not be reached.'],
  } satisfies Record<string, Feedback>;
  function scheduleStatus(result: string) {
    const [tone, message] = feedbackFor(SCHEDULE_OUTCOMES, result, 'invalid');
    const status = $('#sched-status');
    status.textContent = message;
    status.className = 'small ' + tone;
  }
  async function saveSchedule(schedule: Schedule | null): Promise<boolean> {
    const box = $('#schedule');
    if (!getState()?.actionToken || !box.dataset.id) return false;
    for (const control of box.querySelectorAll('button,input')) {
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = true;
    }
    let result;
    try {
      const reply = await postAction('/network-map/schedule', { address: box.dataset.id ?? '', schedule }, getState()?.actionToken ?? '');
      result = reply.httpStatus === 403 ? 'forbidden' : reply.outcome;
    } catch (error) {
      result = 'network';
    } finally {
      for (const control of box.querySelectorAll('button,input')) {
        if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = false;
      }
    }
    scheduleStatus(result === 'saved' && !schedule ? 'cleared' : result);
    if (result === 'saved') schedEditing = null;
    await refresh();
    return result === 'saved';
  }
  $('#sched-switch', HTMLInputElement).addEventListener('change', () => {
    const device = selectedDevice();
    if (!device) return;
    if ($('#sched-switch', HTMLInputElement).checked) {
      startEditing(device);
      return;
    }
    if (device.pauseSchedule) {
      void saveSchedule(null);
      return;
    }
    schedEditing = null;
    renderSchedule(device);
  });
  $('#sched-edit').addEventListener('click', () => {
    const device = selectedDevice();
    if (device) startEditing(device);
  });
  $('#sched-cancel').addEventListener('click', () => {
    schedEditing = null;
    $('#sched-status').textContent = '';
    const device = selectedDevice();
    if (device) renderSchedule(device);
  });
  $('#sched-save').addEventListener('click', () => {
    const days = [...$('#sched-days').querySelectorAll<HTMLButtonElement>('button')].filter(button => button.getAttribute('aria-pressed') === 'true').map(button => Number(button.dataset.day));
    const start = $('#sched-start', HTMLInputElement).value,
      end = $('#sched-end', HTMLInputElement).value;
    if (!days.length || !/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end) || start === end) {
      scheduleStatus('invalid');
      return;
    }
    try {
      const schedule = parseSchedule({ days, start, end });
      if (schedule) void saveSchedule(schedule);
    } catch {
      scheduleStatus('invalid');
    }
  });

  return { renderRename: renameForm, renderPause, renderSchedule };
}
