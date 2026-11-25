import { h, icon, ICONS } from '../core/dom.js';
import { t } from '../i18n/index.js';

export interface NavBarState {
  title: string;
  back: { label: string; onBack: () => void } | null;
  trailing: HTMLElement | null;
}

export interface NavBar {
  element: HTMLElement;
  /** The large title placed at the top of the page content; it collapses into the bar on scroll. */
  largeTitle: HTMLElement;
  update(state: NavBarState): void;
}

/** iOS-style bar: compact title appears once the large title scrolls under it. */
export function createNavBar(): NavBar {
  const backLabel = h('span'),
    back = h('button', { className: 'nav-back', attrs: { type: 'button' } }, [icon(ICONS.back), backLabel]),
    compact = h('h1', { className: 'nav-title', attrs: { 'aria-hidden': 'true' } }),
    trailing = h('div', { className: 'nav-trailing' }),
    element = h('header', { className: 'navbar' }, [h('div', { className: 'nav-leading' }, [back]), compact, trailing]),
    largeTitle = h('h1', { className: 'large-title' });
  let onBack: (() => void) | null = null;
  back.addEventListener('click', () => onBack?.());

  const observer = new IntersectionObserver(([entry]) => element.classList.toggle('is-condensed', entry ? !entry.isIntersecting : false), {
    rootMargin: '-56px 0px 0px 0px',
  });
  observer.observe(largeTitle);

  return {
    element,
    largeTitle,
    update(state) {
      compact.textContent = state.title;
      largeTitle.textContent = state.title;
      document.title = state.title === t('Home') ? 'LEÓN Home' : `${state.title} · LEÓN Home`;
      back.hidden = state.back === null;
      backLabel.textContent = state.back?.label ?? '';
      back.setAttribute('aria-label', state.back ? t('Back to {0}', state.back.label) : t('Back'));
      onBack = state.back?.onBack ?? null;
      trailing.replaceChildren(...(state.trailing ? [state.trailing] : []));
    },
  };
}
