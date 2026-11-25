import { h } from '../core/dom.js';

export function emptyState({ title, detail }: { title: string; detail?: string }): HTMLElement {
  return h('div', { className: 'empty' }, [h('p', { className: 'empty-title', text: title }), detail === undefined ? null : h('p', { className: 'empty-detail', text: detail })]);
}
