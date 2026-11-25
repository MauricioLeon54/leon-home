import { h } from '../core/dom.js';
import { t } from '../i18n/index.js';
import { button } from './button.js';
import { openSheet, type Sheet } from './sheet.js';

export interface ConfirmProps {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  /** When set, the action stays disabled until the user types exactly this text (e.g. the node name). */
  phrase?: string;
}

/** Resolves true only when the user confirms; dismissing the sheet resolves false. */
export function confirm({ title, message, confirmLabel, tone = 'default', phrase }: ConfirmProps): Promise<boolean> {
  return new Promise(resolve => {
    let isSettled = false,
      sheet: Sheet | null = null;
    function settle(answer: boolean): void {
      if (isSettled) return;
      isSettled = true;
      resolve(answer);
      sheet?.close();
    }
    const confirmButton = button({ label: confirmLabel, variant: tone === 'danger' ? 'danger' : 'primary', isDisabled: phrase !== undefined, onPress: () => settle(true) }),
      input =
        phrase === undefined
          ? null
          : h('input', {
              className: 'confirm-input',
              attrs: { 'type': 'text', 'autocomplete': 'off', 'autocapitalize': 'off', 'spellcheck': 'false', 'aria-label': t('Type {0} to confirm', phrase) },
              on: {
                input: () => {
                  confirmButton.disabled = input?.value.trim() !== phrase;
                },
                keydown: event => {
                  if (event.key === 'Enter' && !confirmButton.disabled) settle(true);
                },
              },
            });
    sheet = openSheet({
      title,
      onClosed: () => settle(false),
      content: [
        h('p', { className: 'confirm-message', text: message }),
        phrase === undefined ? null : h('p', { className: 'confirm-phrase', text: t('Type {0} to confirm.', phrase) }),
        input,
        h('div', { className: 'confirm-actions' }, [confirmButton, button({ label: t('Cancel'), onPress: () => settle(false) })]),
      ],
    });
  });
}
