import { h } from '../core/dom.js';

export interface Banner {
  element: HTMLElement;
  show(message: string): void;
  hide(): void;
}

/** Connection notice: earlier readings stay visible, the banner says how old they are. */
export function createBanner(): Banner {
  const element = h('p', { className: 'banner', attrs: { role: 'status' } });
  element.hidden = true;
  return {
    element,
    show(message) {
      element.textContent = message;
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
      element.textContent = '';
    },
  };
}
