import { dateLocale, t } from '../i18n/index.js';
/** Display wording shared by every page. Unknown values render as an em dash, never as zero. */
export const UNKNOWN = '—';

export function ago(seconds: number | null, now = Date.now() / 1000): string {
  if (seconds === null) return UNKNOWN;
  const delta = Math.max(0, now - seconds);
  if (delta < 90) return t('just now');
  if (delta < 3600) return t('{0} min ago', Math.round(delta / 60));
  if (delta < 172_800) return t('{0} h ago', Math.round(delta / 3600));
  return t('{0} days ago', Math.round(delta / 86_400));
}

export function duration(seconds: number | null): string {
  if (seconds === null) return UNKNOWN;
  const days = Math.floor(seconds / 86_400),
    hours = Math.floor((seconds % 86_400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} d ${hours} h` : t('{0} h {1} min', hours, minutes);
}

export function bytes(value: number | null): string {
  if (value === null) return UNKNOWN;
  for (const [unit, scale] of [
    ['GB', 2 ** 30],
    ['MB', 2 ** 20],
    ['KB', 2 ** 10],
  ] as const)
    if (value >= scale) return `${(value / scale).toFixed(1)} ${unit}`;
  return `${value} B`;
}

export function milliseconds(value: number | null): string {
  if (value === null) return UNKNOWN;
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
}

export function count(value: number | null): string {
  return value === null ? UNKNOWN : Math.round(value).toLocaleString('en-US').replaceAll(',', ' ');
}

export function percent(value: number | null, digits = 0): string {
  return value === null ? UNKNOWN : `${value.toFixed(digits)}%`;
}

export function celsius(value: number | null): string {
  return value === null ? UNKNOWN : `${Math.round(value)} °C`;
}

export function clock(seconds: number | null): string {
  if (seconds === null) return UNKNOWN;
  return new Date(seconds * 1000).toLocaleTimeString(dateLocale, { hour: 'numeric', minute: '2-digit' });
}

/** Legacy display predicates omit zero and NaN as well as absent readings. */
export function isNonzeroNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Boolean(value);
}
