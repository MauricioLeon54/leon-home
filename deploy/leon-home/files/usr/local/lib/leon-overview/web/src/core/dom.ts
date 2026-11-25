/** Typed element builder. Text is always assigned as text; data never becomes markup. */
export type Child = Node | string | null | undefined | false;
export interface Props {
  className?: string;
  text?: string;
  attrs?: Readonly<Record<string, string>>;
  dataset?: Readonly<Record<string, string>>;
  on?: { readonly [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: ReadonlyArray<Child> = []): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.className) element.className = props.className;
  if (props.text !== undefined) element.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  for (const [name, value] of Object.entries(props.dataset ?? {})) element.dataset[name] = value;
  for (const [type, listener] of Object.entries(props.on ?? {})) if (listener) element.addEventListener(type, listener as EventListener);
  append(element, children);
  return element;
}

export function append(parent: Element, children: ReadonlyArray<Child>): void {
  for (const child of children) if (child !== null && child !== undefined && child !== false) parent.append(child);
}

const SVG = 'http://www.w3.org/2000/svg';
/** A single-path 24×24 stroke icon; path data comes from code constants only. */
export function icon(path: string, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

export const ICONS = {
  home: 'M3 11 12 4l9 7v9h-6v-6H9v6H3z',
  network: 'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM5 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm14 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 9v3m0 0-5 4m5-4 5 4',
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  settings:
    'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm7.4 4.5 1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-1.6.9L15 20h-4l-.5-1.7a7 7 0 0 1-1.6-.9l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-1.8L5 10.5l2-3.4 1.9.7a7 7 0 0 1 1.6-.9L11 5h4l.5 1.9a7 7 0 0 1 1.6.9l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 1.8z',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
} as const;
