import { postAction, readJson } from './api.js';
import { choice, record, string } from './decode.js';
import { serverText, t } from './i18n/index.js';
import { bindDialog, closeDialog, openDialog, swapText } from './motion.js';
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
  current: t('Everything is up to date'),
  checking: t('Checking for updates…'),
  ready: t('An update is available'),
  installing: t('Installing update…'),
  error: t('Maintenance needs attention'),
} satisfies Record<Phase, string>;
const ERRORS: Readonly<Record<string, string>> = {
  bootstrapUpdateNeeded: t('A maintenance update needs assistance to install. Your current version remains available.'),
  networkUnavailable: t('Updates could not be checked. Check the Internet connection on your Pi and try again.'),
  invalidSignature: t('This update could not be verified. Your current version is preserved. Ask for help before continuing.'),
  invalidRelease: t('This update is incomplete. Your current version is preserved.'),
  incompatible: t('This update is incompatible with your Pi. Ask your support person to review it.'),
  notEnoughSpace: t('The Pi needs more free space. Ask for help freeing space, then try again.'),
  rolledBack: t('The update did not finish successfully. The previous version was restored and the panel is available.'),
  recoveryNeeded: t('This update needs maintenance help. Pi-hole is maintained separately.'),
  inventoryBusy: t('The Pi is finishing another task. Try again shortly.'),
};
// The page arrives in English; its fixed texts are the keys.
for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = serverText((element.textContent ?? '').replaceAll(/\s+/g, ' ').trim());
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
  $('#release-status').textContent = state.phase === 'installing' ? t('Your Pi is working') : 'LEÓN Home';
  $('.release').dataset.phase = state.phase;
  swapText($('#release-title'), TITLES[state.phase], '');
  $('#release-version').textContent = state.available ? t('Installed version: {0} · Available: {1}', state.version, state.available.version) : t('Installed version: {0}', state.version);
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
    ? (ERRORS[state.error] ?? t('The update service is unavailable. Try again or ask your support person for help.'))
    : t('Pi-hole keeps running while the panel updates.');
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
    $('#release-status').textContent = t('Waiting for your Pi…');
    $('.release').dataset.phase = 'checking';
    $('#release-message').textContent = t('The panel may be restarting. Keep Tailscale connected; we will check again.');
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
    if (!response?.ok) $('#release-message').textContent = t('The task could not start. Reload the page and try again.');
  } catch {
    $('#release-message').textContent = t('Your Pi could not be reached. Check Tailscale and try again.');
  } finally {
    busy = false;
  }
  await refresh();
}
$('#release-check', HTMLButtonElement).addEventListener('click', () => {
  void act('/updates/check');
});
const dialog = $('#release-confirm', HTMLDialogElement);
bindDialog(dialog);
$('#release-apply', HTMLButtonElement).addEventListener('click', () => openDialog(dialog));
$('#release-confirm-no', HTMLButtonElement).addEventListener('click', () => closeDialog(dialog));
$('#release-confirm-yes', HTMLButtonElement).addEventListener('click', () => {
  closeDialog(dialog);
  void act('/updates/apply');
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  void refresh();
}, 5000);
void refresh();
