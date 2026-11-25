import type { Session } from '../contracts/session.js';
import { createNavBar } from '../ui/navBar.js';
import { createTabBar, type Tab, TAB_DEFINITIONS, TABS } from '../ui/tabBar.js';
import { h } from './dom.js';

export interface RouteContext {
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  session: Session;
  /** Aborted when the page is left; pass it to every read the page starts. */
  signal: AbortSignal;
  navigate: (path: string) => void;
  /** Replace the route's static title once data names the page (e.g. a device name). */
  setTitle: (title: string) => void;
  setTrailing: (element: HTMLElement | null) => void;
}
export interface PageView {
  element: HTMLElement;
  dispose?: () => void;
}
export interface Route {
  pattern: string; // "/settings/raspberry" or "/network/device/:id"
  tab: Tab;
  title: string;
  /** Pattern of the page "Back" returns to; null on a tab root. */
  parent: string | null;
  render: (context: RouteContext) => PageView;
}

interface Match {
  route: Route;
  params: Record<string, string>;
}
interface HistoryState {
  leon: true;
  depth: number; // in-app entries before this one; 0 means Back must navigate to the parent
}
type Direction = 'push' | 'pop' | 'tab' | 'none';

function match(routes: ReadonlyArray<Route>, pathname: string): Match | null {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1);
  for (const route of routes) {
    const pattern = route.pattern === '/' ? [] : route.pattern.split('/').slice(1);
    if (pattern.length !== (pathname === '/' ? 0 : parts.length)) continue;
    const params: Record<string, string> = {};
    const isMatch = pattern.every((segment, index) => {
      const value = parts[index] ?? '';
      if (segment.startsWith(':')) {
        if (!value || value.length > 128) return false;
        params[segment.slice(1)] = decodeURIComponent(value);
        return true;
      }
      return segment === value;
    });
    if (isMatch) return { route, params };
  }
  return null;
}

function currentState(): HistoryState | null {
  const state: unknown = history.state;
  return typeof state === 'object' && state !== null && 'leon' in state && 'depth' in state && typeof state.depth === 'number' ? { leon: true, depth: state.depth } : null;
}

export interface Router {
  navigate(path: string, options?: { replace?: boolean }): void;
}

/** History API router: one shell, per-tab stacks, scroll memory and native-feeling transitions. */
export function startRouter(root: HTMLElement, routes: ReadonlyArray<Route>, session: Session, legacyTarget: (url: URL) => string | null = () => null): Router {
  const navBar = createNavBar(),
    content = h('main', { className: 'view', attrs: { id: 'view', tabindex: '-1' } }),
    tabBar = createTabBar(selectTab),
    lastPathByTab = new Map<Tab, string>(),
    scrollByPath = new Map<string, number>();
  root.replaceChildren(navBar.element, content, tabBar.element);
  let current: { path: string; match: Match; view: PageView; controller: AbortController } | null = null;

  function pathOf(url: URL): string {
    return url.pathname + url.search;
  }
  function render(url: URL, direction: Direction): void {
    const found = match(routes, url.pathname);
    if (!found) {
      // Not an app page (a legacy server page or an unknown path): let the server answer.
      location.assign(pathOf(url));
      return;
    }
    if (current) {
      scrollByPath.set(current.path, window.scrollY);
      current.controller.abort();
      current.view.dispose?.();
    }
    const controller = new AbortController(),
      { route, params } = found,
      path = pathOf(url);
    const parent = route.parent ? match(routes, route.parent) : null;
    const context: RouteContext = {
      params,
      query: url.searchParams,
      session,
      signal: controller.signal,
      navigate: target => navigate(target),
      setTitle: title => navBar.update({ title, back: backFor(parent), trailing: null }),
      setTrailing: trailing => navBar.update({ title: navBar.largeTitle.textContent ?? route.title, back: backFor(parent), trailing }),
    };
    const swap = () => {
      navBar.update({ title: route.title, back: backFor(parent), trailing: null });
      const view = route.render(context);
      content.replaceChildren(navBar.largeTitle, view.element);
      current = { path, match: found, view, controller };
      lastPathByTab.set(route.tab, path);
      tabBar.setActive(route.tab);
      window.scrollTo(0, direction === 'push' ? 0 : (scrollByPath.get(path) ?? 0));
    };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (direction === 'none' || reduced || !document.startViewTransition) {
      swap();
      return;
    }
    document.documentElement.dataset.navigation = direction;
    const transition = document.startViewTransition(swap);
    void transition.finished.finally(() => delete document.documentElement.dataset.navigation);
  }
  function backFor(parent: Match | null): { label: string; onBack: () => void } | null {
    if (!parent) return null;
    return {
      label: parent.route.title,
      onBack: () => {
        if ((currentState()?.depth ?? 0) > 0) history.back();
        else navigate(parent.route.pattern, { replace: true, direction: 'pop' });
      },
    };
  }
  function navigate(target: string, options: { replace?: boolean; direction?: Direction } = {}): void {
    const url = new URL(target, location.origin);
    if (url.origin !== location.origin) return;
    if (!match(routes, url.pathname)) {
      location.assign(pathOf(url));
      return;
    }
    const depth = currentState()?.depth ?? 0;
    if (options.replace) history.replaceState({ leon: true, depth } satisfies HistoryState, '', pathOf(url));
    else history.pushState({ leon: true, depth: depth + 1 } satisfies HistoryState, '', pathOf(url));
    render(url, options.direction ?? 'push');
  }
  function selectTab(tab: Tab): void {
    const definition = TAB_DEFINITIONS[tab];
    // Tapping the active tab pops it to its root; another tab resumes where it was left.
    const isActive = current?.match.route.tab === tab;
    const target = isActive ? definition.root : (lastPathByTab.get(tab) ?? definition.root);
    if (current && pathOf(new URL(location.href)) === target) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    navigate(target, { direction: isActive ? 'pop' : 'tab' });
  }

  // Same-origin links to app pages stay in the app; everything else navigates normally.
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !match(routes, url.pathname)) return;
    event.preventDefault();
    navigate(pathOf(url));
  });
  window.addEventListener('popstate', () => render(new URL(location.href), 'pop'));

  const legacy = legacyTarget(new URL(location.href));
  if (legacy) history.replaceState({ leon: true, depth: 0 } satisfies HistoryState, '', legacy);
  else if (!currentState()) history.replaceState({ leon: true, depth: 0 } satisfies HistoryState, '', location.href);
  for (const tab of TABS) lastPathByTab.set(tab, TAB_DEFINITIONS[tab].root);
  render(new URL(location.href), 'none');
  return { navigate: (path, options) => navigate(path, options ?? {}) };
}
