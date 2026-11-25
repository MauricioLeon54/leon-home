import type { Feedback } from '../../contracts.js';
import { type Child, h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import { feedbackFor } from '../../presentation.js';
import { button } from '../../ui/button.js';
import { card } from '../../ui/section.js';
import { sendNetworkAction } from './model.js';

const OUTCOMES = {
  current: ['good', t('Ready. The router session is active.')],
  unlockFailed: ['warn', t('Incorrect passphrase or no router response. Try again in one minute.')],
  busy: ['warn', t('Wait one minute between attempts.')],
  notConfigured: ['warn', t('Connect your router once: choose a new passphrase, repeat it and enter the router administrator password.')],
  alreadyConfigured: ['warn', t('This Pi already has a router vault. Unlock it with its passphrase.')],
  setupUnavailable: ['warn', t('Ask your support person to connect the router.')],
  mismatch: ['warn', t('The two passphrases do not match.')],
  weak: ['warn', t('Use a passphrase of at least 12 characters.')],
  forbidden: ['warn', t('Your page session expired. Reload to continue.')],
  unavailable: ['warn', t('The router monitor is not responding.')],
  invalid: ['warn', t('Invalid passphrase.')],
  network: ['warn', t('LEÓN Home could not be reached.')],
} satisfies Record<string, Feedback>;

/** Survives repaints: whether the form is in connect-router mode and the last outcome shown. */
export interface UnlockState {
  isConnecting: boolean;
  feedback: Feedback | null;
}
export interface UnlockProps {
  state: UnlockState;
  explanation: string;
  token: string;
  /** Runs the submit under the page's action hold, then refreshes. */
  run: <R>(work: () => Promise<R>) => Promise<R>;
}

function passwordInput(label: string, autocomplete: string, isHidden: boolean): HTMLInputElement {
  const input = h('input', { attrs: { 'type': 'password', autocomplete, 'maxlength': '1024', 'placeholder': label, 'aria-label': label, 'enterkeyhint': 'go' }, className: 'text-input' });
  input.hidden = isHidden;
  input.required = !isHidden;
  return input;
}

/** The locked-router section. One attempt per submit, never retried; every password field is cleared whatever the outcome. */
export function unlockSection({ state, explanation, token, run }: UnlockProps): HTMLElement {
  const isSetup = state.isConnecting,
    passphrase = passwordInput(isSetup ? t('New LEÓN vault passphrase') : t('LEÓN vault passphrase'), 'current-password', false),
    repeat = passwordInput(t('Repeat the new passphrase'), 'new-password', !isSetup),
    routerPassword = passwordInput(t('Router administrator password'), 'off', !isSetup),
    status = h('p', {
      className: `note${state.feedback ? ` is-${state.feedback[0]}` : ''}`,
      attrs: { role: 'status' },
      text: state.feedback?.[1] ?? t('Use the passphrase for this installation. Ask your support person to configure router monitoring.'),
    }),
    submit = button({ label: isSetup ? t('Connect router') : t('Unlock'), variant: 'primary', onPress: () => {} });
  submit.type = 'submit';
  // A hidden username lets the password manager offer the saved passphrase.
  const username = h('input', {
    className: 'sr',
    attrs: { 'type': 'text', 'name': 'username', 'autocomplete': 'username', 'value': 'leon-vault', 'readonly': '', 'tabindex': '-1', 'aria-hidden': 'true' },
  });
  async function attempt(): Promise<void> {
    let result: string;
    if (isSetup && passphrase.value !== repeat.value) result = 'mismatch';
    else if (isSetup && new TextEncoder().encode(passphrase.value).length < 12) result = 'weak';
    else {
      const body = isSetup ? { phrase: passphrase.value, password: routerPassword.value } : { phrase: passphrase.value };
      result = await sendNetworkAction('/api/v1/network/unlock', body, token);
    }
    passphrase.value = repeat.value = routerPassword.value = '';
    state.isConnecting = result === 'notConfigured' || (isSetup && result !== 'current' && result !== 'alreadyConfigured');
    state.feedback = feedbackFor(OUTCOMES, result, 'unlockFailed');
  }
  const form = h('form', { className: 'unlock-form', attrs: { autocomplete: 'on' } }, [username, passphrase, repeat, routerPassword, submit] satisfies Array<Child>);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = isSetup ? t('Connecting…') : t('Decrypting…');
    void run(attempt);
  });
  return h('section', { className: 'group unlock' }, [
    h('div', { className: 'group-head' }, [h('h2', { className: 'group-title', text: t('Router readings are locked') })]),
    card([h('p', { className: 'note', text: explanation }), form, status]),
  ]);
}
