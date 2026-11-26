import { h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { badge } from '../../ui/badge.js';
import { confirm } from '../../ui/confirm.js';
import { emptyState } from '../../ui/empty.js';
import { list } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { createSwitch } from '../../ui/switch.js';
import { switchable } from './controls.js';
import { hardwarePage } from './hardwarePage.js';

export function renderUsb(context: RouteContext): PageView {
  return hardwarePage(context, (view, io) => {
    const { usb } = view;
    if (!usb.isSupported) return [emptyState({ title: t('USB power control needs uhubctl'), detail: t('Run provision.sh hardware.') })];
    const blockedBy = usb.power === 'on' ? usb.powerOffBlockedBy : null,
      usbSwitch = createSwitch({
        label: t('USB ports'),
        checked: io.isUnavailable ? null : switchable(usb.power),
        isDisabled: io.isUnavailable || blockedBy !== null,
        async onChange(requested) {
          if (requested) return io.act('/api/v1/hardware/usb-power', { state: 'on' });
          const isConfirmed = await confirm({
            title: t('Turn off USB power?'),
            message: t('Everything plugged into the USB ports loses power. Power returns at the next restart.'),
            confirmLabel: t('Turn off'),
            tone: 'danger',
          });
          return isConfirmed ? io.act('/api/v1/hardware/usb-power', { state: 'off' }) : 'cancelled';
        },
      });
    return [
      section({ title: t('Power') }, [
        list([{ kind: 'switch', title: t('USB ports'), ...(blockedBy === null ? {} : { detail: serverText(blockedBy) }), control: usbSwitch.element }]),
        h('p', { className: 'note', text: t('All four ports switch together on a Raspberry Pi 4. Power returns at restart.') }),
      ]),
      section({ title: t('Attached devices'), meta: String(usb.devices.length) }, [
        usb.devices.length
          ? list(
              usb.devices.map(device => ({
                kind: 'value' as const,
                title: device.name,
                accessories: [...(device.isStorage ? [badge(t('Storage'))] : []), ...(device.isMounted ? [badge(t('Mounted'))] : [])],
              }))
            )
          : emptyState({ title: t('No USB devices') }),
      ]),
    ];
  });
}
