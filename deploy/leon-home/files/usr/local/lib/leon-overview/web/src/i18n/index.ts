import { es } from './es.js';

/** English is the source text and the key; every other language must translate every key. */
export type MessageKey = keyof typeof es;
export const LANGUAGES = { en: 'English', es: 'Español' } as const;
export type Language = keyof typeof LANGUAGES;
const CATALOGS: Record<Exclude<Language, 'en'>, Record<MessageKey, string>> = { es };
const STORAGE_KEY = 'leon.language';
const DATE_LOCALES = { en: 'en-US', es: 'es-MX' } satisfies Record<Language, string>;

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value);
}
/** The choice saved on this device, else the device's own language. */
function detect(): Language {
  try {
    const saved: unknown = globalThis.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    /* storage is unavailable (private window or tests): use the device's language */
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Non-browser test environments may omit navigator or its language.
  return globalThis.navigator?.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}
// Read once, before any page module builds its texts; changing it reloads the app.
export const language: Language = detect();
export const dateLocale = DATE_LOCALES[language];
if (typeof document !== 'undefined') document.documentElement.lang = language;

/** False when this device cannot remember the choice. */
export function setLanguage(next: Language): boolean {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    return false;
  }
  location.reload();
  return true;
}

function fill(template: string, values: ReadonlyArray<string | number>): string {
  return template.replace(/\{(\d)\}/g, (token, index: string) => String(values[Number(index)] ?? token));
}

/** A fixed text. `{0}`, `{1}`… take the values in order; a translation may reorder them. */
export function t(key: MessageKey, ...values: ReadonlyArray<string | number>): string {
  return fill(language === 'en' ? key : CATALOGS[language][key], values);
}

/** Texts the Pi fills with a value. Listed explicitly so names and other data are never mistaken for wording. */
const SERVER_TEMPLATES: ReadonlyArray<MessageKey> = [
  'Stale reading: last read by the Mac {0}',
  'Read by the Mac {0}',
  '{0}. These readings become stale if the Mac sleeps or LEÓN Labs is closed.',
  'Reachability over Tailscale, read {0}. Phone notification after 10 minutes offline.',
  '{0} actions and {1} errors in 24 h',
  'Offline since {0}',
  'last seen {0}',
  'First {0} items',
  '{0} failed services',
  '{0} stopped',
  '{0} min ago',
  '{0} h ago',
  '{0} d ago',
];
const PATTERNS = SERVER_TEMPLATES.map(key => ({ key, pattern: new RegExp(`^${key.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replaceAll(/\{\d\}/g, '(.+?)')}$`, 'u') }));

/** A text written by the Pi. Known wording is translated; anything else (names, data) stays as sent. */
export function serverText(text: string): string {
  if (language === 'en') return text;
  const catalog = CATALOGS[language];
  if (isMessageKey(text)) return catalog[text];
  // Whole sentences first: some of them contain the separator.
  for (const { key, pattern } of PATTERNS) {
    const found = text.includes(' · ') && !key.includes('. ') ? null : pattern.exec(text);
    if (found) return fill(catalog[key], found.slice(1).map(serverText));
  }
  return text.includes(' · ') ? text.split(' · ').map(serverText).join(' · ') : text;
}

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(es, value);
}
