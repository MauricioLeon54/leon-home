import { readText } from './api.js';
import { bindDisclosures, setDisclosure } from './motion.js';

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
bindDisclosures();
let refreshing = false;
let controller: AbortController | null = null;
const STALE_AFTER_MS = 90_000;
let lastSuccess = Date.now();

// A refresh swaps <main>; open sections, focus and scroll position must survive it.
function carryOver(current: HTMLElement, next: HTMLElement): void {
  for (const item of current.querySelectorAll('.t-acc[data-open="true"][id]')) {
    const match = next.querySelector('#' + CSS.escape(item.id));
    if (match) setDisclosure(match, true);
  }
}
function restoreFocus(next: HTMLElement, id: string | undefined): void {
  if (!id) return;
  const match = next.querySelector('#' + CSS.escape(id));
  const head = match?.querySelector(':scope > .t-acc-head');
  if (head instanceof HTMLElement) head.focus({ preventScroll: true });
}
function showConnection(): void {
  const notice = document.getElementById('connection'),
    main = document.querySelector('main');
  const stale = Date.now() - lastSuccess > STALE_AFTER_MS;
  main?.classList.toggle('is-stale', stale);
  if (!notice) return;
  notice.hidden = !stale;
  const minutes = Math.round((Date.now() - lastSuccess) / 60_000);
  notice.textContent = stale ? `LEÓN Home is not answering. These readings are from ${minutes} min ago.` : '';
}
async function refreshHome(): Promise<void> {
  if (document.visibilityState !== 'visible' || refreshing) return;
  refreshing = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 8000);
  try {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    if (!response.ok) return;
    const documentValue = new DOMParser().parseFromString(await readText(response), 'text/html');
    const main = documentValue.querySelector('main'),
      current = document.querySelector('main');
    if (main && current) {
      const focused = document.activeElement?.closest('.t-acc[id]')?.id;
      carryOver(current, main);
      current.replaceWith(main);
      restoreFocus(main, focused);
    }
    lastSuccess = Date.now();
  } catch {
    /* Keep the already timestamped page when the private network is unavailable. */
  } finally {
    clearTimeout(timeout);
    controller = null;
    refreshing = false;
    showConnection();
  }
}
setInterval(() => {
  void refreshHome();
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) controller?.abort();
});
window.addEventListener('pagehide', () => controller?.abort());
