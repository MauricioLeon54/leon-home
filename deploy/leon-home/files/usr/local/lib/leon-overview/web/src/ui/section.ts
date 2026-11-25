import { type Child, h } from '../core/dom.js';

export interface SectionProps {
  title?: string;
  /** Right-aligned 13 px detail in the heading ("3 online"). */
  meta?: string;
  tone?: 'good' | 'warn' | undefined;
  link?: { label: string; href: string };
}

/** A titled group: heading row, then content. Untitled sections are plain spacing (Settings lists). */
export function section({ title, meta, tone, link }: SectionProps, children: ReadonlyArray<Child>): HTMLElement {
  const hasHead = title !== undefined || meta !== undefined || link !== undefined;
  return h('section', { className: 'group' }, [
    hasHead
      ? h('div', { className: 'group-head' }, [
          title === undefined ? null : h('h2', { className: 'group-title', text: title }),
          meta === undefined ? null : h('span', { className: `group-meta${tone ? ` is-${tone}` : ''}`, text: meta }),
          link ? h('a', { className: 'group-link', text: link.label, attrs: { href: link.href } }) : null,
        ])
      : null,
    ...children,
  ]);
}

/** A filled surface for things that are read together (readings, charts). */
export function card(children: ReadonlyArray<Child>): HTMLElement {
  return h('div', { className: 'card' }, children);
}
