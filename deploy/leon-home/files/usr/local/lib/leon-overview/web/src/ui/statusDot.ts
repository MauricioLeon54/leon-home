import { h } from '../core/dom.js';

/** good: current and fine · warn: needs attention · danger: failed · idle: known but inactive · unknown: no reading (hollow ring). */
export type StatusTone = 'good' | 'warn' | 'danger' | 'idle' | 'unknown';

/** Decorative: every row that shows a dot also states the meaning in text. */
export function statusDot(tone: StatusTone): HTMLElement {
  return h('i', { className: `status-dot is-${tone}`, attrs: { 'aria-hidden': 'true' } });
}
