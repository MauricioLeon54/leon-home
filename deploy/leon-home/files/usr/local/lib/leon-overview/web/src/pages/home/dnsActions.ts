import { postAction } from '../../api.js';
import { t } from '../../i18n/index.js';
import type { SwitchOutcome } from '../../ui/switch.js';
import { showToast } from '../../ui/toast.js';
import type { PauseSeconds } from './pihole.js';

/** Shared by Home and Settings → DNS: one request, one toast; unverified is never reported as success. */
async function run(request: () => ReturnType<typeof postAction>, appliedMessage: string): Promise<SwitchOutcome> {
  try {
    const { ok, outcome, httpStatus } = await request();
    if (ok && outcome === 'applied') {
      showToast('applied', appliedMessage);
      return 'applied';
    }
    if (httpStatus < 500 && ['refused', 'forbidden', 'invalid'].includes(outcome)) {
      showToast('refused', t('Pi-hole refused the request'));
      return 'refused';
    }
  } catch {
    // The write may have reached Pi-hole before the connection failed.
  }
  showToast('unverified', t('Pi-hole did not confirm'));
  return 'unverified';
}
export const pauseDns = (seconds: PauseSeconds, token: string): Promise<SwitchOutcome> =>
  run(() => postAction('/api/v1/dns/pause', { seconds }, token), t('Blocking paused for {0} min', seconds / 60));
export const setDnsBlocking = (enabled: boolean, token: string): Promise<SwitchOutcome> =>
  run(() => postAction(enabled ? '/api/v1/dns/resume' : '/api/v1/dns/disable', {}, token), enabled ? t('Blocking on') : t('Blocking off'));
export const allowDomain = (domain: string, token: string): Promise<SwitchOutcome> => run(() => postAction('/api/v1/dns/allow', { domain }, token), t('{0} unblocked', domain));
export const removeAllowedDomain = (domain: string, token: string): Promise<SwitchOutcome> =>
  run(() => postAction('/api/v1/dns/unallow', { domain }, token), t('{0} follows the blocklists again', domain));
