import { type Child, h } from '../../core/dom.js';
import { getView, HttpError } from '../../core/http.js';
import { poll, STALE_AFTER_MS } from '../../core/poll.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { createBanner } from '../../ui/banner.js';
import { emptyState } from '../../ui/empty.js';
import { skeleton } from '../../ui/skeleton.js';

export interface LiveControls {
  /** Wrap an action: the page keeps its controls (and any pending switch) untouched until it finishes, then refreshes. */
  run<R>(work: () => Promise<R>): Promise<R>;
  /** Rebuild from the last view now (after a page-local state change such as a segmented control). */
  repaint(): void;
}
export interface LivePageOptions<T> {
  context: RouteContext;
  /** A function lets a page change the query between polls (a filter). */
  path: string | (() => string);
  parse: (value: unknown) => T;
  intervalMs: number;
  observedAt: (view: T) => number | null;
  build: (view: T, state: { isStale: boolean; observedAt: number | null; hasFailed: boolean }, controls: LiveControls) => ReadonlyArray<Child>;
}

/** Skeleton, polling, stale banner and failure state for a settings page; repaints only when no action or edit is in flight. */
export function livePage<T>({ path, parse, intervalMs, observedAt, build }: LivePageOptions<T>): PageView {
  const banner = createBanner(),
    content = h('div', { className: 'settings-page' }, [skeleton(3)]),
    element = h('div', { className: 'page' }, [banner.element, content]);
  let view: T | null = null,
    isStale = false,
    hasFailed = false,
    busy = 0;

  function paint(): void {
    if (view === null || busy > 0) return;
    const active = document.activeElement;
    // Never rebuild under a field being edited; the next poll or action repaints.
    if (active instanceof HTMLInputElement && content.contains(active)) return;
    const focusKey = active instanceof HTMLElement && content.contains(active) ? active.dataset.focusKey : undefined;
    content.replaceChildren(
      ...build(view, { isStale, hasFailed, observedAt: observedAt(view) }, controls).filter((child): child is Node | string => child !== null && child !== undefined && child !== false)
    );
    if (focusKey) content.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }
  const controls: LiveControls = {
    repaint: paint,
    async run(work) {
      busy++;
      try {
        return await work();
      } finally {
        busy--;
        await poller.refresh();
        paint();
      }
    },
  };
  const poller = poll({
    intervalMs,
    load: signal => getView(typeof path === 'function' ? path() : path, parse, signal),
    onData(next) {
      view = next;
      isStale = false;
      hasFailed = false;
      banner.hide();
      paint();
    },
    onFailure(error, lastSuccessMs) {
      if (view === null || lastSuccessMs === null) {
        const isForbidden = error instanceof HttpError && error.kind === 'forbidden';
        content.replaceChildren(
          emptyState({
            title: isForbidden ? t('Not signed in') : t('LEÓN Home is not answering'),
            detail: isForbidden ? t('Open this page from a device signed in to your Tailscale account.') : t('Check that this phone is connected to Tailscale. It will try again shortly.'),
          })
        );
        return;
      }
      // Any failed refresh marks readings as earlier; the banner waits for 90 s.
      hasFailed = true;
      const ageMs = Date.now() - lastSuccessMs;
      if (ageMs <= STALE_AFTER_MS) {
        paint();
        return;
      }
      isStale = true;
      banner.show(t('LEÓN Home is not answering. These readings are from {0} min ago.', Math.max(1, Math.round(ageMs / 60_000))));
      paint();
    },
  });
  return { element, dispose: () => poller.stop() };
}
