import { h } from '../core/dom.js';

export type BadgeTone = 'neutral' | 'new';

export function badge(text: string, tone: BadgeTone = 'neutral'): HTMLElement {
  return h('em', { className: `badge is-${tone}`, text });
}
