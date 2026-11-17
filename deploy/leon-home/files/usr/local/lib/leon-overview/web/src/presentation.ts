import type { Connection, Feedback } from './contracts.js';

type ElementConstructor<T extends Element> = new () => T;
export function $(selector: string): HTMLElement;
export function $<T extends Element>(selector: string, constructor: ElementConstructor<T>): T;
export function $(selector: string, constructor: ElementConstructor<Element> = HTMLElement): Element {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Missing or invalid UI element: ${selector}`);
  return element;
}
export const svgNS = 'http://www.w3.org/2000/svg';
const KIND_ICONS = {
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  ethernet: 'M5 4h14v11h-4v5H9v-5H5zM9 8v3m3-3v3m3-3v3',
  unknown: 'M4 5h16v10H4zM9 19h6m-3-4v4',
};
export function hasKey<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}
export function feedbackFor<K extends string>(table: Record<K, Feedback>, status: string, fallback: K): Feedback {
  return hasKey(table, status) ? table[status] : table[fallback];
}
export function text<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, value: string | number | null | undefined, className?: string): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  element.textContent = value === null || value === undefined ? '' : String(value);
  if (className) element.className = className;
  return element;
}
export function icon(kind: Connection | undefined, className?: string): SVGSVGElement {
  const svg = document.createElementNS(svgNS, 'svg'),
    path = document.createElementNS(svgNS, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className || 'kind');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', kind && hasKey(KIND_ICONS, kind) ? KIND_ICONS[kind] : KIND_ICONS.unknown);
  svg.append(path);
  return svg;
}
export function date(value: number | null | undefined): string {
  return typeof value === 'number' ? new Date(value * 1000).toLocaleString('en') : 'No observation';
}
export function time(value: number | null | undefined): string {
  return typeof value === 'number' ? new Date(value * 1000).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }) : '—';
}
export function mbps(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('en', { maximumFractionDigits: value < 10 ? 2 : 1 }) : '—';
}
export function speed(value: number | null | undefined): string {
  return typeof value !== 'number' ? '—' : value >= 1000 ? (value / 1000).toLocaleString('en') + ' Gbps' : value + ' Mbps';
}
