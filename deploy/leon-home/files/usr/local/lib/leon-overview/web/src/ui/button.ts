import { h } from '../core/dom.js';

export type ButtonVariant = 'plain' | 'primary' | 'danger';
export interface ButtonProps {
  label: string;
  variant?: ButtonVariant;
  isDisabled?: boolean;
  onPress: () => void;
}

/** A 44 px pill. One primary action per decision. */
export function button({ label, variant = 'plain', isDisabled = false, onPress }: ButtonProps): HTMLButtonElement {
  const element = h('button', { className: `btn is-${variant}`, text: label, attrs: { type: 'button' }, on: { click: onPress } });
  element.disabled = isDisabled;
  return element;
}
