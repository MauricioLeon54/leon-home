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
    saved: ['good', 'Guardado. El nombre en la red (Pi-hole) se actualiza en segundos. Vacío vuelve al nombre de la Pi.'],
    unknownDevice: ['warn', 'El escaneo aún no tiene la dirección física de este equipo.'],
    forbidden: ['warn', 'Sesión de la página caducada. Recarga.'],
    invalid: ['warn', 'Nombre no válido.'],
    unavailable: ['warn', 'No se pudo guardar.'],
    network: ['warn', 'Sin conexión con LEÓN Home.'],
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
    applied: ['good', 'Hecho: el router confirma el cambio.'],
    unchanged: ['good', 'Ya estaba así.'],
    unverified: ['warn', 'No se pudo confirmar. Revisa el estado antes de repetir.'],
    filterUnavailable: ['warn', 'Activa "Lista negra" en el filtro MAC del router.'],
    protectedDevice: ['warn', 'Equipo protegido: no se puede pausar desde LEÓN.'],
    wiredDevice: ['warn', 'Está por cable: el filtro Wi-Fi no lo pausa.'],
    filterFull: ['warn', 'La lista del router está llena (32).'],
    unknownDevice: ['warn', 'El router no ve este equipo ahora.'],
    locked: ['warn', 'Sesión del router bloqueada.'],
    busy: ['warn', 'Espera unos segundos entre cambios.'],
    rejected: ['warn', 'El router no aceptó el cambio.'],
    forbidden: ['warn', 'Sesión de la página caducada. Recarga.'],
    unavailable: ['warn', 'El monitor del router no responde.'],
    invalid: ['warn', 'Solicitud no válida.'],
    network: ['warn', 'Sin conexión con LEÓN Home.'],
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
    note.textContent = pending ? 'Aplicando…' : outcome ? outcome[1] : device.paused ? 'Pausado: sin Wi-Fi hasta reanudar' : 'Permitido · Wi-Fi';
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
    $('#confirm-title').textContent = '¿Pausar ' + device.name + '?';
    $('#confirm-text').textContent =
      'Se desconecta del Wi-Fi y no podrá volver a unirse hasta que lo reanudes. Se aplica a su dirección física actual: un equipo con dirección privada rotativa podría volver con otra.';
    const ok = $('#confirm-ok', HTMLButtonElement);
    ok.textContent = 'Pausar';
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
  // Weekly pause window, opt-in per device: off by default; nothing applies until "Guardar horario".
  // Days are Monday-first like the Pi (Mon=0); times are the Pi's local time. Static markup, so refreshes
  // never discard an edit in progress.
  const DAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'] as const,
    DAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  let schedEditing: string | null = null;
  for (const [index, label] of DAY_LABELS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.day = String(index);
    button.setAttribute('aria-label', DAY_NAMES[index] ?? 'día');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true')));
    $('#sched-days').append(button);
  }
  function scheduleText(schedule: Schedule) {
    const days = schedule.days;
    const label = days.length === 7 ? 'Todos los días' : days.join() === '0,1,2,3,4' ? 'L–V' : days.join() === '5,6' ? 'Fin de semana' : days.map(day => DAY_LABELS[day]).join(' ');
    return `${label} · ${schedule.start} → ${schedule.end}${schedule.end < schedule.start ? ' (día siguiente)' : ''}`;
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
      ? 'Elige días y horas (hora de la Pi). Nada se aplica hasta guardar.'
      : saved
        ? `Activa: ${scheduleText(saved)}. Pausa al empezar y reanuda al terminar.`
        : 'Desactivada: LEÓN no pausa este equipo por horario.';
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
    saved: ['good', 'Horario guardado. Si ya está dentro del horario, se aplica desde el próximo inicio o fin.'],
    cleared: ['good', 'Horario quitado. Su estado actual no cambia: si está pausado, sigue así hasta que lo reanudes.'],
    protectedDevice: ['warn', 'Equipo protegido: no se puede programar.'],
    unknownDevice: ['warn', 'El escaneo aún no tiene la dirección física de este equipo.'],
    invalid: ['warn', 'Elige al menos un día y dos horas distintas.'],
    forbidden: ['warn', 'Sesión de la página caducada. Recarga.'],
    unavailable: ['warn', 'No se pudo guardar.'],
    network: ['warn', 'Sin conexión con LEÓN Home.'],
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
