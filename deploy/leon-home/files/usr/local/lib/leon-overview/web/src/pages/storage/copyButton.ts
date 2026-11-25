import { h } from '../../core/dom.js';
import { t } from '../../i18n/index.js';
import { showToast } from '../../ui/toast.js';

async function copy(text: string, confirmation: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast('applied', confirmation);
  } catch {
    showToast('refused', t('Could not copy'));
  }
}

/** Copies in the tap itself: iOS refuses clipboard writes that wait for the network first. */
export function copyButton(text: string, label: string, confirmation: string): HTMLButtonElement {
  return h('button', { className: 'copy-button', text: t('Copy'), attrs: { 'type': 'button', 'aria-label': label }, on: { click: () => void copy(text, confirmation) } });
}
