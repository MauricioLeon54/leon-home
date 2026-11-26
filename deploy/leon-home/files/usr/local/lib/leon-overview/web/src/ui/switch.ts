import { h } from '../core/dom.js';
import { t } from '../i18n/index.js';

export type SwitchState = 'idle' | 'pending' | 'refused' | 'unverified';
/** cancelled: the user backed out of a confirmation; nothing was requested, so no warning is shown. */
export type SwitchOutcome = 'applied' | 'refused' | 'unverified' | 'cancelled';

export interface SwitchProps {
  label: string;
  /** null: the device reported nothing; the switch shows a mixed state and cannot be toggled. */
  checked: boolean | null;
  /** Resolve with the verified outcome. A throw counts as unverified. */
  onChange: (requested: boolean) => Promise<SwitchOutcome>;
  /** Read-only: the reason belongs in the row's detail text. */
  isDisabled?: boolean;
}
export interface Switch {
  element: HTMLButtonElement;
  /** A fresh reading moves the switch; nothing else does. */
  setChecked(checked: boolean | null): void;
  state(): SwitchState;
}

/** Shows the requested position only while pending; refused and unverified outcomes revert it. */
export function createSwitch({ label, checked, onChange, isDisabled = false }: SwitchProps): Switch {
  let current = checked,
    state: SwitchState = 'idle';
  const element = h('button', { className: 'switch', attrs: { 'type': 'button', 'role': 'switch', 'aria-label': label } }, [h('span', { className: 'switch-thumb' })]);
  function paint(shown: boolean | null): void {
    // ARIA switches have only on/off states; an unavailable reading is a disabled mixed checkbox.
    element.setAttribute('role', shown === null ? 'checkbox' : 'switch');
    element.disabled = isDisabled || shown === null;
    if (shown === null) element.setAttribute('aria-description', t('No reading'));
    else element.removeAttribute('aria-description');
    element.setAttribute('aria-checked', shown === null ? 'mixed' : String(shown));
    element.dataset.state = state;
  }
  async function toggle(): Promise<void> {
    if (state === 'pending' || current === null) return;
    const requested = !current;
    state = 'pending';
    element.setAttribute('aria-busy', 'true');
    paint(requested);
    let outcome: SwitchOutcome;
    try {
      outcome = await onChange(requested);
    } catch {
      outcome = 'unverified';
    }
    element.removeAttribute('aria-busy');
    if (outcome === 'applied') current = requested;
    state = outcome === 'applied' || outcome === 'cancelled' ? 'idle' : outcome;
    paint(current);
  }
  element.addEventListener('click', () => void toggle());
  paint(current);
  return {
    element,
    setChecked(next) {
      current = next;
      if (state !== 'pending') paint(current);
    },
    state: () => state,
  };
}
