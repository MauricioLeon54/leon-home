import { postHardware } from '../../api.js';
import { type HardwareActions, type HardwareStatus, type HardwareView, parseHardware } from '../../contracts/hardware.js';
import { type Child, h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { type SwitchOutcome } from '../../ui/switch.js';
import { showToast } from '../../ui/toast.js';
import { type HomeContext } from '../home/context.js';
import { livePage } from './livePage.js';

const REFRESH_MS = 15_000;
const STATUSES: ReadonlyArray<HardwareStatus> = ['applied', 'pendingReboot', 'refused', 'unverified', 'unavailable', 'invalid', 'forbidden'];

export interface HardwareIO {
  session: RouteContext['session'];
  isUnavailable: boolean;
  /** Post one action, toast its outcome, refresh the view; applied and pendingReboot both count as applied. */
  act<K extends keyof HardwareActions>(path: K, body: HardwareActions[K]): Promise<SwitchOutcome>;
  /** Hold repainting while a confirmation is open and an action may follow. */
  run<R>(work: () => Promise<R>): Promise<R>;
}

/** A page of Settings → Raspberry Pi: the shared view, polling and action handling. */
export function hardwarePage(context: RouteContext, build: (view: HardwareView, io: HardwareIO, state: HomeContext) => ReadonlyArray<Child>): PageView {
  return livePage({
    context,
    path: '/api/v1/hardware',
    parse: parseHardware,
    intervalMs: REFRESH_MS,
    observedAt: view => view.observedAt,
    build(view, state, controls) {
      const io: HardwareIO = {
        session: context.session,
        isUnavailable: view.helper === 'unavailable',
        run: work => controls.run(work),
        act: (path, body) =>
          controls.run(async () => {
            let status: HardwareStatus = 'unverified',
              message = '';
            try {
              const result = await postHardware(path, body, context.session.actionToken);
              status = STATUSES.find(item => item === result.outcome) ?? 'invalid';
              message = serverText(result.message);
            } catch {
              // No answer: the change may or may not have happened.
            }
            return announce(status, message);
          }),
      };
      return [
        io.isUnavailable ? h('p', { className: 'banner', attrs: { role: 'status' }, text: t('Hardware controls are not installed on this Pi. Readings still work.') }) : null,
        ...build(view, io, state),
      ];
    },
  });
}

function announce(status: HardwareStatus, message: string): SwitchOutcome {
  switch (status) {
    case 'applied':
      showToast('applied', message || t('Done'));
      return 'applied';
    case 'pendingReboot':
      showToast('applied', t('Applies after the next restart'));
      return 'applied';
    case 'unverified':
      showToast('unverified', t('The Pi did not confirm'));
      return 'unverified';
    case 'refused':
    case 'invalid':
    case 'forbidden':
    case 'unavailable':
      showToast('refused', message || t('The Pi refused the request'));
      return 'refused';
  }
}
