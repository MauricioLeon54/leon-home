import { h, icon, ICONS } from '../core/dom.js';
import { t } from '../i18n/index.js';

export type Tab = 'home' | 'network' | 'storage' | 'settings';
export const TABS: ReadonlyArray<Tab> = ['home', 'network', 'storage', 'settings'];

export interface TabDefinition {
  label: string;
  root: string;
  icon: string;
}
export const TAB_DEFINITIONS = {
  home: { label: t('Home'), root: '/', icon: ICONS.home },
  network: { label: t('Network'), root: '/network', icon: ICONS.network },
  storage: { label: t('Storage'), root: '/storage', icon: ICONS.storage },
  settings: { label: t('Settings'), root: '/settings', icon: ICONS.settings },
} satisfies Record<Tab, TabDefinition>;

export interface TabBar {
  element: HTMLElement;
  setActive(tab: Tab): void;
}

export function createTabBar(onSelect: (tab: Tab) => void): TabBar {
  const links = new Map<Tab, HTMLAnchorElement>();
  for (const tab of TABS) {
    const definition = TAB_DEFINITIONS[tab];
    const link = h('a', { attrs: { href: definition.root }, dataset: { tab } }, [icon(definition.icon), h('span', { text: definition.label })]);
    link.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      onSelect(tab);
    });
    links.set(tab, link);
  }
  return {
    element: h('nav', { className: 'tabbar', attrs: { 'aria-label': t('Sections') } }, [...links.values()]),
    setActive(active) {
      for (const [tab, link] of links) {
        if (tab === active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
  };
}
