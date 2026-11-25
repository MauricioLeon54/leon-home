import { h } from '../core/dom.js';
import { t } from '../i18n/index.js';

/** Loading placeholder shaped like a heading plus `blocks` content blocks. */
export function skeleton(blocks = 3): HTMLElement {
  return h('div', { className: 'skeleton', attrs: { role: 'status' } }, [
    h('span', { className: 'sr', text: t('Loading') }),
    h('div', { className: 'skeleton-line is-title', attrs: { 'aria-hidden': 'true' } }),
    ...Array.from({ length: blocks }, () => h('div', { className: 'skeleton-line is-block', attrs: { 'aria-hidden': 'true' } })),
  ]);
}
