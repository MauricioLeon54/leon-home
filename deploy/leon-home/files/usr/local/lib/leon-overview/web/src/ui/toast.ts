import { h } from '../core/dom.js';

/** applied: verified · refused: the device said no · unverified: no confirmation, so never claim success. */
export type ToastTone = 'applied' | 'refused' | 'unverified';

const DISMISS_AFTER_MS = 4500;
let region: HTMLElement | null = null,
  timer: ReturnType<typeof setTimeout> | undefined;

function liveRegion(): HTMLElement {
  if (region?.isConnected === true) return region;
  region = h('div', { className: 'toast-region', attrs: { 'role': 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
  document.body.append(region);
  return region;
}

/** One toast at a time, in the one live region. */
export function showToast(tone: ToastTone, message: string): void {
  clearTimeout(timer);
  liveRegion().replaceChildren(h('div', { className: `toast is-${tone}` }, [h('i', { className: 'toast-mark', attrs: { 'aria-hidden': 'true' } }), h('span', { text: message })]));
  timer = setTimeout(() => region?.replaceChildren(), DISMISS_AFTER_MS);
}
