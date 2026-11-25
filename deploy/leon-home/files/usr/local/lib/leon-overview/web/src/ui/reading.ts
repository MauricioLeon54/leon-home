import { h } from '../core/dom.js';
import { clock, UNKNOWN } from '../core/format.js';
import { t } from '../i18n/index.js';

export type ReadingState = { kind: 'current'; tone?: 'good' | 'warn' | undefined } | { kind: 'earlier'; at: number | null } | { kind: 'unknown' };

export interface ReadingProps {
  label: string;
  /** null renders an em dash, never zero. */
  value: string | null;
  state: ReadingState;
}

/** A metric: current (Bone), earlier (Ash, labelled with its time) or unknown (Ash em dash). */
export function reading({ label, value, state }: ReadingProps): HTMLElement {
  const kind = value === null ? 'unknown' : state.kind,
    tone = state.kind === 'current' && state.tone ? ` is-${state.tone}` : '';
  return h('div', { className: `reading is-${kind}${tone}` }, [
    h('b', { className: 'reading-value', text: value ?? UNKNOWN }),
    h('span', { className: 'reading-label', text: label }),
    state.kind === 'earlier' && value !== null ? h('span', { className: 'reading-note', text: state.at === null ? t('Earlier reading') : t('Earlier {0}', clock(state.at)) }) : null,
  ]);
}

export function readingGrid(readings: ReadonlyArray<HTMLElement>, columns: 2 | 3 = 2): HTMLElement {
  return h('div', { className: `readings is-${columns}` }, readings);
}
