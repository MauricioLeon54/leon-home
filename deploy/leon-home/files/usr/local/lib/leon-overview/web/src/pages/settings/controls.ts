import type { Switchable } from '../../contracts/hardware.js';
import { h } from '../../core/dom.js';
import type { ListRow } from '../../ui/list.js';

/** A labelled control (segmented, inputs) inside a card. */
export function controlGroup(label: string, control: HTMLElement): HTMLElement {
  return h('div', { className: 'control' }, [h('p', { className: 'control-label', text: label }), control]);
}

/** unknown stays unknown: the switch shows a mixed state, never off. */
export function switchable(value: Switchable): boolean | null {
  return value === 'unknown' ? null : value === 'on';
}

export function timeField(label: string, value: string): { element: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { className: 'time-input', attrs: { type: 'time', required: '' } });
  input.value = value;
  return { input, element: h('label', { className: 'time-field' }, [h('span', { text: label }), input]) };
}

export function navRow(title: string, href: string, detail?: string): ListRow {
  return detail === undefined ? { kind: 'navigation', title, href } : { kind: 'navigation', title, href, detail };
}
