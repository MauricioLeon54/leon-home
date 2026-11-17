import { postAction, readJson } from './api.js';
import { choice, record, string } from './decode.js';
import { $ } from './presentation.js';

type Phase = 'current' | 'checking' | 'ready' | 'installing' | 'error';
interface State {
  version: string;
  phase: Phase;
  error: string | null;
  available: { version: string; notes: Array<string> } | null;
  actionToken: string;
}
const TITLES = {
  current: 'Todo está actualizado',
  checking: 'Buscando mejoras…',
  ready: 'Hay una actualización',
  installing: 'Instalando la actualización…',
  error: 'Necesitamos revisar algo',
} satisfies Record<Phase, string>;
const ERRORS: Readonly<Record<string, string>> = {
  bootstrapUpdateNeeded: 'Hay una actualización de mantenimiento que necesita ayuda para instalarse. Tu versión actual sigue disponible.',
  networkUnavailable: 'No pudimos consultar las actualizaciones. Comprueba que tu Raspberry tiene Internet e inténtalo de nuevo.',
  invalidSignature: 'No se pudo verificar esta actualización. Conservamos la versión actual; pide ayuda antes de continuar.',
  invalidRelease: 'La actualización no está completa. Conservamos tu versión actual.',
  incompatible: 'Esta actualización no es compatible con tu Raspberry. Pide ayuda para revisarlo.',
  notEnoughSpace: 'Falta espacio en la Raspberry. Pide ayuda para liberar espacio y vuelve a intentarlo.',
  rolledBack: 'La actualización no terminó bien. Recuperamos la versión anterior y puedes seguir usando el panel.',
  recoveryNeeded: 'La actualización necesita ayuda de mantenimiento. Pi-hole se administra por separado.',
  inventoryBusy: 'La Raspberry está terminando otra tarea. Vuelve a intentarlo en un momento.',
};
let state: State | null = null;
let busy = false;
function parse(value: unknown): State {
  const item = record(value);
  if (item.schemaVersion !== 1) throw new Error('Invalid update status');
  const phase = choice(item.phase, ['current', 'checking', 'ready', 'installing', 'error'], 'error');
  let available: State['available'] = null;
  if (item.available !== null) {
    const candidate = record(item.available);
    if (!Array.isArray(candidate.notes) || candidate.notes.length > 12) throw new Error('Invalid release notes');
    const notes: Array<unknown> = candidate.notes;
    available = { version: string(candidate.version, 32), notes: notes.map(value => string(value, 240)) };
  }
  return { version: string(item.version, 32), phase, error: item.error === null ? null : string(item.error, 64), available, actionToken: string(item.actionToken, 256) };
}
function render() {
  if (!state) return;
  $('#release-status').textContent = state.phase === 'installing' ? 'La Raspberry está trabajando' : 'LEÓN Home';
  $('#release-title').textContent = TITLES[state.phase];
  $('#release-version').textContent = 'Versión instalada: ' + state.version + (state.available ? ' · Disponible: ' + state.available.version : '');
  const notes = $('#release-notes');
  notes.replaceChildren();
  for (const note of state.available?.notes ?? []) {
    const entry = document.createElement('li');
    entry.textContent = note;
    notes.append(entry);
  }
  const working = busy || state.phase === 'checking' || state.phase === 'installing';
  $('#release-check', HTMLButtonElement).disabled = working;
  const apply = $('#release-apply', HTMLButtonElement);
  apply.hidden = !state.available || state.phase === 'installing';
  apply.disabled = working;
  $('#release-message').textContent = state.error
    ? (ERRORS[state.error] ?? 'El servicio de actualizaciones no está disponible. Vuelve a intentarlo o pide ayuda.')
    : 'Pi-hole seguirá funcionando mientras se actualiza el panel.';
}
async function refresh(): Promise<void> {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const response = await fetch('/updates/data', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Unavailable');
    state = parse(await readJson(response, 8192));
  } catch {
    $('#release-apply', HTMLButtonElement).disabled = true;
    $('#release-check', HTMLButtonElement).disabled = false;
    $('#release-status').textContent = 'Esperando a tu Raspberry…';
    $('#release-message').textContent = 'El panel puede estar reiniciándose. Mantén Tailscale conectado; volveremos a comprobarlo.';
    return;
  } finally {
    busy = false;
  }
  render();
}
async function act(path: '/updates/check' | '/updates/apply'): Promise<void> {
  if (busy || !state) return;
  busy = true;
  render();
  try {
    const response =
      path === '/updates/check'
        ? await postAction('/updates/check', {}, state.actionToken)
        : state.available
          ? await postAction('/updates/apply', { version: state.available.version }, state.actionToken)
          : null;
    if (!response?.ok) $('#release-message').textContent = 'No pudimos iniciar la tarea. Recarga la página y vuelve a intentarlo.';
  } catch {
    $('#release-message').textContent = 'No pudimos conectar con tu Raspberry. Comprueba Tailscale y vuelve a intentarlo.';
  } finally {
    busy = false;
  }
  await refresh();
}
$('#release-check', HTMLButtonElement).addEventListener('click', () => {
  void act('/updates/check');
});
const dialog = $('#release-confirm', HTMLDialogElement);
$('#release-apply', HTMLButtonElement).addEventListener('click', () => dialog.showModal());
$('#release-confirm-no', HTMLButtonElement).addEventListener('click', () => dialog.close());
$('#release-confirm-yes', HTMLButtonElement).addEventListener('click', () => {
  dialog.close();
  void act('/updates/apply');
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  void refresh();
}, 5000);
void refresh();
