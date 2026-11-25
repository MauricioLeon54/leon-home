import type { HardwareView } from '../../contracts/hardware.js';
import { h } from '../../core/dom.js';
import { clock } from '../../core/format.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { confirm } from '../../ui/confirm.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { type HardwareIO, hardwarePage } from './hardwarePage.js';

type Service = HardwareView['services'][number];

async function restartService(io: HardwareIO, service: Service): Promise<void> {
  const isRouter = service.unit === 'leon-router',
    isConfirmed = await confirm({
      title: t('Restart {0}?', serverText(service.label)),
      message: isRouter ? t('Router readings stay locked until you unlock them again.') : t('{0} is unavailable for a few seconds.', serverText(service.label)),
      confirmLabel: t('Restart'),
    });
  if (isConfirmed) await io.act('/api/v1/hardware/restart-service', { unit: service.unit });
}

async function powerAction(io: HardwareIO, action: 'reboot' | 'shutdown'): Promise<void> {
  const isReboot = action === 'reboot',
    isConfirmed = await confirm({
      title: isReboot ? t('Restart the Pi?') : t('Shut down the Pi?'),
      message: isReboot ? t('LEÓN Home is unavailable for a minute or two while it restarts.') : t('Someone must unplug and replug the Pi to start it again.'),
      confirmLabel: isReboot ? t('Restart Pi') : t('Shut down'),
      tone: 'danger',
      phrase: io.session.node,
    });
  if (isConfirmed) await io.act('/api/v1/hardware/power', { action, confirm: io.session.node });
}

export function renderPower(context: RouteContext): PageView {
  return hardwarePage(context, (view, io) => {
    const { rebootAllowedAt, rebootRequired } = view.power,
      isWaiting = rebootAllowedAt !== null && rebootAllowedAt * 1000 > Date.now(),
      services: Array<ListRow> = view.services.map(service => ({
        kind: 'action',
        title: t('Restart {0}', serverText(service.label)),
        detail: serverText(service.state),
        isDisabled: io.isUnavailable,
        onSelect: () => void restartService(io, service),
      }));
    return [
      section({ title: t('Services') }, [list(services)]),
      section({ title: t('Power') }, [
        list([
          {
            kind: 'destructive',
            title: t('Restart Pi'),
            detail: isWaiting ? t('Available again at {0}', clock(rebootAllowedAt)) : rebootRequired ? t('Restart needed after system updates') : t('Restarts the whole Pi'),
            isDisabled: io.isUnavailable || isWaiting,
            onSelect: () => void powerAction(io, 'reboot'),
          },
          { kind: 'destructive', title: t('Shut down'), detail: t('Needs a replug to start again'), isDisabled: io.isUnavailable, onSelect: () => void powerAction(io, 'shutdown') },
        ]),
        h('p', { className: 'note', text: t('You will be asked to type {0} to confirm.', io.session.node) }),
      ]),
    ];
  });
}
