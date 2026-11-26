import { parseSession } from './contracts/session.js';
import { h } from './core/dom.js';
import { getView, HttpError } from './core/http.js';
import { poll } from './core/poll.js';
import { startRouter } from './core/router.js';
import { t } from './i18n/index.js';
import { legacyTarget, ROUTES } from './routes.js';

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});

const root = document.getElementById('app');

function bootFailure(error: unknown): HTMLElement {
  const forbidden = error instanceof HttpError && error.kind === 'forbidden';
  return h('section', { className: 'boot-failure', attrs: { role: 'alert' } }, [
    h('h1', { text: forbidden ? t('Not signed in') : t('LEÓN Home is not answering') }),
    h('p', {
      text: forbidden ? t('Open this page from a device signed in to your Tailscale account.') : t('Check that this phone is connected to Tailscale, then try again.'),
    }),
    h('button', { className: 'button primary', text: t('Try again'), attrs: { type: 'button' }, on: { click: () => location.reload() } }),
  ]);
}

// Action tokens expire after an hour on the server; an app left open renews its own well before.
const TOKEN_RENEW_MS = 20 * 60_000;

if (root)
  getView('/api/v1/session', parseSession)
    .then(session => {
      startRouter(root, ROUTES, session, legacyTarget);
      poll({
        intervalMs: TOKEN_RENEW_MS,
        load: signal => getView('/api/v1/session', parseSession, signal),
        onData(renewed) {
          session.actionToken = renewed.actionToken;
        },
        onFailure() {}, // the next action reports its own refusal if the token lapsed
        loadImmediately: false,
      });
    })
    .catch((error: unknown) => root.replaceChildren(bootFailure(error)));
