import type { Feedback, RouterTelemetry } from '../../contracts.js';
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
  notConfigured: ['warn', t('Ask your support person to connect the router.')],
  setupUnavailable: ['warn', t('Ask your support person to connect the router.')],
  forbidden: ['warn', t('Your page session expired. Reload to continue.')],
  unavailable: ['warn', t('The router monitor is not responding.')],
  invalid: ['warn', t('Invalid request.')],
  network: ['warn', t('LEÓN Home could not be reached.')],
} satisfies Record<string, Feedback>;

/** Survives repaints: the last outcome shown and whether the "router changed" form is open. */
export interface UnlockState {
  feedback: Feedback | null;
  isOpen: boolean;
}
export interface UnlockProps {
  state: UnlockState;
  unlockBy: RouterTelemetry['unlockBy'];
  isReconnecting: boolean;
  explanation: string;
  token: string;
  /** Runs the submit under the page's action hold, then refreshes. */
  run: <R>(work: () => Promise<R>) => Promise<R>;
}

/** The locked-router section. One attempt per submit, never retried; the field is cleared whatever the outcome. */
export function unlockSection({ state, unlockBy, isReconnecting, explanation, token, run }: UnlockProps): HTMLElement {
  const isPhrase = unlockBy === 'phrase',
    label = isPhrase ? t('LEÓN vault passphrase') : t('Router administrator password'),
    submitLabel = isPhrase ? t('Unlock') : t('Connect router'),
    secret = h('input', {
      className: 'text-input',
      attrs: { 'type': 'password', 'autocomplete': 'current-password', 'maxlength': '1024', 'placeholder': label, 'aria-label': label, 'enterkeyhint': 'go' },
    }),
    status = h('p', {
      className: `note${state.feedback ? ` is-${state.feedback[0]}` : ''}`,
      attrs: { role: 'status' },
      text:
        state.feedback?.[1] ??
        (isPhrase
          ? t('Use the passphrase for this installation. Ask your support person to configure router monitoring.')
          : t('It is the password you use to open the router settings. LEÓN never shows it.')),
    }),
    submit = button({ label: submitLabel, variant: 'primary', onPress() {} });
  secret.required = true;
  submit.type = 'submit';
  // A hidden username lets the password manager offer the saved entry.
  const username = h('input', {
    className: 'sr',
    attrs: { 'type': 'text', 'name': 'username', 'autocomplete': 'username', 'value': isPhrase ? 'leon-vault' : 'leon-router', 'readonly': '', 'tabindex': '-1', 'aria-hidden': 'true' },
  });
  async function attempt(): Promise<void> {
    const body = isPhrase ? { phrase: secret.value } : { password: secret.value };
    const result = await sendNetworkAction('/api/v1/network/unlock', body, token);
    secret.value = '';
    state.feedback =
      result === 'unlockFailed' && !isPhrase
        ? ['warn', t('The router did not accept that password or did not respond. Check it and try again in one minute.')]
        : feedbackFor(OUTCOMES, result, 'unlockFailed');
  }
  const form = h('form', { className: 'unlock-form', attrs: { autocomplete: 'on' } }, [username, secret, submit] satisfies Array<Child>);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = t('Connecting…');
    void run(attempt);
  });
  const group = (title: string, children: Array<Child>): HTMLElement =>
    h('section', { className: 'group unlock' }, [h('div', { className: 'group-head' }, [h('h2', { className: 'group-title', text: title })]), card(children)]);
  if (isReconnecting) {
    const changed = h('details', {}, [h('summary', { text: t('The router or its password changed') }), form, status]);
    changed.open = state.isOpen;
    changed.addEventListener('toggle', () => {
      state.isOpen = changed.open;
    });
    return group(t('Reconnecting to your router'), [h('p', { className: 'note', text: t('LEÓN is reconnecting by itself. You do not need to do anything.') }), changed]);
  }
  return group(isPhrase ? t('Router readings are locked') : t('Connect your router'), [h('p', { className: 'note', text: explanation }), form, status]);
}
