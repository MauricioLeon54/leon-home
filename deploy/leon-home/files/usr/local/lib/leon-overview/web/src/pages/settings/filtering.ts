import type { AllowSource, FilteringView, ListState } from '../../contracts/dns.js';
import { h } from '../../core/dom.js';
import { ago, clock, count } from '../../core/format.js';
import { t } from '../../i18n/index.js';
import { button } from '../../ui/button.js';
import { confirm } from '../../ui/confirm.js';
import { emptyState } from '../../ui/empty.js';
import { list, type ListRow } from '../../ui/list.js';
import { card, section } from '../../ui/section.js';
import type { StatusTone } from '../../ui/statusDot.js';

export interface FilteringActions {
  isBusy: boolean;
  allow: (domain: string) => void;
  removeAllowed: (domain: string) => void;
  setDeviceFilter: (address: string, name: string, paused: boolean) => void;
}

const SOURCE_TEXT = {
  panel: () => t('Allowed from LEÓN'),
  selfRepair: () => t('Allowed by self-repair (essential)'),
  other: () => t('Allowed in Pi-hole'),
} satisfies Record<AllowSource, () => string>;
const LIST_TONE = { ok: 'good', cached: 'warn', failed: 'danger', off: 'idle' } satisfies Record<ListState, StatusTone>;
const LIST_TEXT = {
  ok: () => t('Up to date'),
  cached: () => t('Download failed, using the saved copy'),
  failed: () => t('Not loaded'),
  off: () => t('Off'),
} satisfies Record<ListState, () => string>;

/** Accepts a pasted address ("https://Site.com/page") and keeps only its host name. */
export function domainFrom(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split(/[/?#]/)[0]
      ?.replace(/:\d+$/, '')
      .replace(/\.$/, '') ?? ''
  );
}

async function confirmAllow(domain: string, actions: FilteringActions): Promise<void> {
  const isConfirmed = await confirm({
    title: t('Unblock {0}?', domain),
    message: t('Every device on the network will reach this site. You can block it again from this page.'),
    confirmLabel: t('Unblock'),
  });
  if (isConfirmed) actions.allow(domain);
}

async function confirmRemove(domain: string, source: AllowSource, actions: FilteringActions): Promise<void> {
  const isConfirmed = await confirm({
    title: t('Block {0} again?', domain),
    message: source === 'selfRepair' ? t('Self-repair allowed this essential domain. It will allow it again if a blocklist still blocks it.') : t('It will follow the blocklists again.'),
    confirmLabel: t('Block again'),
    tone: 'danger',
  });
  if (isConfirmed) actions.removeAllowed(domain);
}

function unblockForm(actions: FilteringActions): HTMLElement {
  const input = h('input', {
      className: 'text-input',
      attrs: {
        'type': 'text',
        'inputmode': 'url',
        'maxlength': '300',
        'autocomplete': 'off',
        'autocapitalize': 'off',
        'spellcheck': 'false',
        'enterkeyhint': 'done',
        'placeholder': t('example.com'),
        'aria-label': t('Site to unblock'),
      },
    }),
    submit = button({ label: t('Unblock'), isDisabled: actions.isBusy, onPress() {} }),
    form = h('form', { className: 'inline-form' }, [input, submit]);
  submit.type = 'submit';
  form.addEventListener('submit', event => {
    event.preventDefault();
    const domain = domainFrom(input.value);
    if (domain !== '' && !actions.isBusy) void confirmAllow(domain, actions);
  });
  return card([form, h('p', { className: 'note', text: t('If a site or app stops working, unblock it here or from the recent list below.') })]);
}

function deviceRows(filtering: FilteringView, actions: FilteringActions): Array<ListRow> {
  return filtering.devices.map(device => {
    const isPaused = device.pausedUntil !== null;
    if (!device.canPause) return { kind: 'value', title: device.name, detail: t('Has its own Pi-hole rule'), value: count(device.queries) };
    return {
      kind: 'action',
      leading: { kind: 'dot', tone: isPaused ? 'warn' : 'good' },
      title: device.name,
      detail: isPaused ? t('Filtering paused until {0}', clock(device.pausedUntil)) : t('{0} requests today', count(device.queries)),
      value: isPaused ? t('Resume') : t('Pause 30 min'),
      isDisabled: actions.isBusy,
      onSelect: () => void confirmDeviceFilter(device.address, device.name, !isPaused, actions),
    };
  });
}

async function confirmDeviceFilter(address: string, name: string, paused: boolean, actions: FilteringActions): Promise<void> {
  const isConfirmed =
    !paused ||
    (await confirm({
      title: t('Pause filtering for {0}?', name),
      message: t('Ads and trackers reach only this device for 30 minutes. Filtering then returns by itself.'),
      confirmLabel: t('Pause 30 min'),
    }));
  if (isConfirmed) actions.setDeviceFilter(address, name, paused);
}

export function filteringSections(filtering: FilteringView | null, actions: FilteringActions): Array<HTMLElement> {
  if (filtering === null)
    return [section({ title: t('Filtering'), meta: t('No reading'), tone: 'warn' }, [emptyState({ title: t('Pi-hole did not answer'), detail: t('Lists and recent blocks appear when it does.') })])];
  const recentRows: Array<ListRow> = filtering.recentBlocked.map(row => ({
    kind: 'action',
    title: row.domain,
    detail: [row.device, ago(row.at), row.count > 1 ? t('{0} times', count(row.count)) : ''].filter(part => part !== '').join(' · '),
    value: t('Unblock'),
    isDisabled: actions.isBusy,
    onSelect: () => void confirmAllow(row.domain, actions),
  }));
  const allowedRows: Array<ListRow> = filtering.allowed.map(row => ({
    kind: 'action',
    title: row.domain,
    detail: [SOURCE_TEXT[row.source](), row.addedAt === null ? '' : ago(row.addedAt)].filter(part => part !== '').join(' · '),
    value: t('Block again'),
    isDisabled: actions.isBusy,
    onSelect: () => void confirmRemove(row.domain, row.source, actions),
  }));
  const failing = filtering.lists.filter(row => row.state === 'cached' || row.state === 'failed').length;
  return [
    section({ title: t('Unblock a site') }, [unblockForm(actions)]),
    section({ title: t('Recently blocked'), meta: t('Tap to unblock') }, [
      recentRows.length === 0 ? emptyState({ title: t('Nothing blocked recently'), detail: t('Blocked requests appear here as devices make them.') }) : list(recentRows),
    ]),
    section({ title: t('Unblocked sites'), meta: count(allowedRows.length) }, [
      allowedRows.length === 0 ? emptyState({ title: t('No unblocked sites'), detail: t('Every request follows the blocklists.') }) : list(allowedRows),
    ]),
    filtering.devices.length === 0
      ? null
      : section({ title: t('Pause filtering for a device') }, [
          list(deviceRows(filtering, actions)),
          h('p', { className: 'note', text: t('Use it when an app or game misbehaves on one device; the rest of the home stays filtered.') }),
        ]),
    filtering.groups.length === 0
      ? null
      : section({ title: t('Device filters') }, [
          list(
            filtering.groups.map(group => ({
              kind: 'value',
              title: group.name,
              detail: group.devices.length === 0 ? t('No devices') : group.devices.join(', '),
              value: count(group.devices.length),
            }))
          ),
          h('p', { className: 'note', text: t('These devices get extra lists on top of the ones for everyone.') }),
        ]),
    section({ title: t('Blocklists'), meta: failing === 0 ? t('All loaded') : t('{0} need attention', failing), tone: failing === 0 ? 'good' : 'warn' }, [
      list(
        filtering.lists.map(row => ({
          kind: 'value',
          leading: { kind: 'dot', tone: LIST_TONE[row.state] },
          title: row.name,
          detail: [LIST_TEXT[row.state](), row.groups.length === 1 && row.groups[0] === 'Default' ? '' : row.groups.join(', ')].filter(part => part !== '').join(' · '),
          value: count(row.entries),
        }))
      ),
      h('p', { className: 'note', text: t('Lists update automatically every week. Last update: {0}.', ago(filtering.listsUpdatedAt)) }),
    ]),
  ].filter((element): element is HTMLElement => element !== null);
}
