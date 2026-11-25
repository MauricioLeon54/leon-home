import { type Child, h, icon, ICONS } from '../core/dom.js';
import { statusDot, type StatusTone } from './statusDot.js';

export type Leading = { kind: 'dot'; tone: StatusTone } | { kind: 'icon'; path: string };

interface RowBase {
  title: string;
  detail?: string;
  /** Trailing text, right-aligned, Ash. */
  value?: string;
  leading?: Leading;
  /** Badges or small indicators between the text and the value. */
  accessories?: ReadonlyArray<HTMLElement>;
}
/** navigation is an <a href> so the router (or the browser, for external pages) handles it; link is the same without the chevron (a file or external target). */
export type ListRow =
  | (RowBase & { kind: 'navigation'; href: string })
  | (RowBase & { kind: 'link'; href: string })
  | (RowBase & { kind: 'value' })
  | (RowBase & { kind: 'switch'; control: HTMLElement })
  | (RowBase & { kind: 'action'; onSelect: () => void; isDisabled?: boolean })
  | (RowBase & { kind: 'destructive'; onSelect: () => void; isDisabled?: boolean });

function contents(row: ListRow): Array<Child> {
  const leading = row.leading ? (row.leading.kind === 'dot' ? statusDot(row.leading.tone) : icon(row.leading.path, 'icon row-icon')) : null;
  return [
    leading,
    h('span', { className: 'row-body' }, [h('span', { className: 'row-title', text: row.title }), row.detail === undefined ? null : h('span', { className: 'row-detail', text: row.detail })]),
    ...(row.accessories ?? []),
    row.value === undefined ? null : h('span', { className: 'row-value', text: row.value }),
    row.kind === 'navigation' ? icon(ICONS.chevron, 'icon row-chevron') : null,
    row.kind === 'switch' ? row.control : null,
  ];
}

function item(row: ListRow): HTMLElement {
  switch (row.kind) {
    case 'navigation':
    case 'link':
      return h('a', { className: 'row', attrs: { href: row.href } }, contents(row));
    case 'value':
    case 'switch':
      return h('div', { className: 'row' }, contents(row));
    case 'action': {
      const element = h('button', { className: 'row', attrs: { type: 'button' }, on: { click: row.onSelect } }, contents(row));
      element.disabled = row.isDisabled ?? false;
      return element;
    }
    case 'destructive': {
      const element = h('button', { className: 'row is-destructive', attrs: { type: 'button' }, on: { click: row.onSelect } }, contents(row));
      element.disabled = row.isDisabled ?? false;
      return element;
    }
  }
}

/** iOS-style inset grouped list on the surface colour, with inset hairlines. */
export function list(rows: ReadonlyArray<ListRow>): HTMLElement {
  return h(
    'ul',
    { className: 'list' },
    rows.map(row => h('li', { className: 'list-item' }, [item(row)]))
  );
}
