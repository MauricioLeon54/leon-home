import { h } from '../core/dom.js';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}
export interface SegmentedProps<T extends string> {
  label: string;
  options: ReadonlyArray<SegmentOption<T>>;
  /** null: the device reports something outside the options; none is selected. */
  value: T | null;
  isDisabled?: boolean;
  onChange: (value: T) => void;
}
export interface Segmented<T extends string> {
  element: HTMLElement;
  setValue(value: T | null): void;
}

/** A radio group drawn as an iOS segmented control; arrow keys move the selection. */
export function createSegmented<T extends string>({ label, options, value, onChange, isDisabled = false }: SegmentedProps<T>): Segmented<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  let selected: T | null = value;
  function paint(): void {
    for (const [option, element] of buttons) {
      element.setAttribute('aria-checked', String(option === selected));
      element.tabIndex = option === (selected ?? options[0]?.value) ? 0 : -1;
    }
  }
  function select(next: T, shouldFocus: boolean): void {
    if (next === selected) return;
    selected = next;
    paint();
    if (shouldFocus) buttons.get(next)?.focus();
    onChange(next);
  }
  for (const [index, option] of options.entries()) {
    const element = h('button', { className: 'segment', text: option.label, attrs: { type: 'button', role: 'radio' } });
    element.addEventListener('click', () => select(option.value, false));
    element.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = options[(index + step + options.length) % options.length];
      if (next) select(next.value, true);
    });
    element.disabled = isDisabled;
    buttons.set(option.value, element);
  }
  paint();
  return {
    element: h('div', { className: 'segmented', attrs: { 'role': 'radiogroup', 'aria-label': label } }, [...buttons.values()]),
    setValue(next: T | null) {
      selected = next;
      paint();
    },
  };
}
