import { type HomeView, parseHome } from '../contracts/home.js';
import { h } from '../core/dom.js';
import { getView, HttpError } from '../core/http.js';
import { poll, STALE_AFTER_MS } from '../core/poll.js';
import type { PageView, RouteContext } from '../core/router.js';
import { t } from '../i18n/index.js';
import { createBanner } from '../ui/banner.js';
import { emptyState } from '../ui/empty.js';
import { skeleton } from '../ui/skeleton.js';
import { type HomeContext } from './home/context.js';
import { pauseDns, resumeDns } from './home/dnsActions.js';
import { homeSections } from './home/layout.js';
import { type PauseSeconds } from './home/pihole.js';

const REFRESH_MS = 30_000;

interface HomeState {
  view: HomeView | null;
  isStale: boolean;
  isDevicesExpanded: boolean;
  isPiHoleBusy: boolean;
}

/** The Home tab: polls the view model, keeps the last good reading, and rebuilds without losing UI state. */
export function renderHome(context: RouteContext): PageView {
  const banner = createBanner(),
    content = h('div', { className: 'home' }, [skeleton(4)]),
    element = h('div', { className: 'page' }, [banner.element, content]),
    state: HomeState = { view: null, isStale: false, isDevicesExpanded: false, isPiHoleBusy: false };

  function paint(children: ReadonlyArray<HTMLElement>): void {
    const active = document.activeElement,
      focusKey = active instanceof HTMLElement && content.contains(active) ? active.dataset.focusKey : undefined;
    content.replaceChildren(...children);
    if (focusKey) content.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }
  function build(): void {
    if (!state.view) return;
    const homeContext: HomeContext = { isStale: state.isStale, observedAt: state.view.observedAt };
    paint(
      homeSections(state.view, homeContext, {
        pihole: { isBusy: state.isPiHoleBusy, onPause: seconds => void pauseBlocking(seconds), onResume: () => void resumeBlocking() },
        network: {
          isExpanded: state.isDevicesExpanded,
          onToggle: () => {
            state.isDevicesExpanded = !state.isDevicesExpanded;
            build();
          },
        },
      })
    );
  }
  async function runDnsAction(request: () => Promise<void>): Promise<void> {
    state.isPiHoleBusy = true;
    build();
    await request();
    state.isPiHoleBusy = false;
    build();
    await poller.refresh();
  }
  const pauseBlocking = (seconds: PauseSeconds) => runDnsAction(() => pauseDns(seconds, context.session.actionToken));
  const resumeBlocking = () => runDnsAction(() => resumeDns(context.session.actionToken));

  const poller = poll({
    intervalMs: REFRESH_MS,
    load: signal => getView('/api/v1/home', parseHome, signal),
    onData(view) {
      state.view = view;
      state.isStale = false;
      banner.hide();
      build();
    },
    onFailure(error, lastSuccessMs) {
      if (!state.view || lastSuccessMs === null) {
        const isForbidden = error instanceof HttpError && error.kind === 'forbidden';
        paint([
          emptyState({
            title: isForbidden ? t('Not signed in') : t('LEÓN Home is not answering'),
            detail: isForbidden ? t('Open this page from a device signed in to your Tailscale account.') : t('Check that this phone is connected to Tailscale. It will try again shortly.'),
          }),
        ]);
        return;
      }
      const ageMs = Date.now() - lastSuccessMs;
      if (ageMs <= STALE_AFTER_MS) return;
      state.isStale = true;
      banner.show(t('LEÓN Home is not answering. These readings are from {0} min ago.', Math.max(1, Math.round(ageMs / 60_000))));
      build();
    },
  });
  return { element, dispose: () => poller.stop() };
}
