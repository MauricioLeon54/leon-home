import type { RadioKind } from '../../contracts/hardware.js';
import { h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { t } from '../../i18n/index.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { createSwitch } from '../../ui/switch.js';
import { switchable } from './controls.js';
import { hardwarePage } from './hardwarePage.js';

const LABELS = { wifi: 'Wi-Fi', bluetooth: 'Bluetooth' } satisfies Record<RadioKind, string>;

export function renderRadios(context: RouteContext): PageView {
  return hardwarePage(context, (view, io) => {
    const rows = view.radios.map((radio): ListRow => {
      const reason = radio.isHardBlocked ? t('Blocked by a hardware switch') : radio.isUplink && radio.state === 'on' ? t('The Pi is connected through Wi-Fi') : undefined,
        control = createSwitch({
          label: LABELS[radio.kind],
          checked: io.isUnavailable ? null : switchable(radio.state),
          isDisabled: io.isUnavailable || reason !== undefined,
          onChange: requested => io.act('/api/v1/hardware/radio', { kind: radio.kind, state: requested ? 'on' : 'off' }),
        });
      return { kind: 'switch', title: LABELS[radio.kind], ...(reason === undefined ? {} : { detail: reason }), control: control.element };
    });
    return [section({}, [list(rows), h('p', { className: 'note', text: t('The Pi uses Ethernet; radios it doesn’t use can stay off.') })])];
  });
}
