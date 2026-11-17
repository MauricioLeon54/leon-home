import { readText } from './api.js';

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
let refreshing = false;
let controller: AbortController | null = null;
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
    if (main && current) current.replaceWith(main);
  } catch {
    /* Keep the already timestamped page when the private network is unavailable. */
  } finally {
    clearTimeout(timeout);
    controller = null;
    refreshing = false;
  }
}
setInterval(() => {
  void refreshHome();
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) controller?.abort();
});
window.addEventListener('pagehide', () => controller?.abort());
