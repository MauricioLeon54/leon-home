import { postAction } from '../../api.js';
import { t } from '../../i18n/index.js';
import { showToast } from '../../ui/toast.js';
import type { PauseSeconds } from './pihole.js';

/** Shared by Home and Settings → DNS: one request, one toast; unverified is never reported as success. */
async function run(request: () => ReturnType<typeof postAction>, appliedMessage: string): Promise<void> {
  try {
    const { outcome } = await request();
    if (outcome === 'applied') showToast('applied', appliedMessage);
    else if (outcome === 'unverified') showToast('unverified', t('Pi-hole did not confirm'));
    else showToast('refused', t('Pi-hole refused the request'));
  } catch {
    // No answer means the request may or may not have been applied.
    showToast('unverified', t('Pi-hole did not confirm'));
  }
}
export const pauseDns = (seconds: PauseSeconds, token: string): Promise<void> => run(() => postAction('/api/v1/dns/pause', { seconds }, token), t('Blocking paused for {0} min', seconds / 60));
export const resumeDns = (token: string): Promise<void> => run(() => postAction('/api/v1/dns/resume', {}, token), t('Blocking resumed'));
