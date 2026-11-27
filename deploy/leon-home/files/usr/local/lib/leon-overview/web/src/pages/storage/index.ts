import { postAction } from '../../api.js';
import { parseStorage, type StorageView } from '../../contracts/storage.js';
import { type Child, h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { button } from '../../ui/button.js';
import { confirm } from '../../ui/confirm.js';
import { emptyState } from '../../ui/empty.js';
import { list, type ListRow } from '../../ui/list.js';
import { card, section } from '../../ui/section.js';
import { statusDot } from '../../ui/statusDot.js';
import { type LiveControls, livePage } from '../settings/livePage.js';
import { copyButton } from './copyButton.js';
import { linkButton } from './linkButton.js';

const REFRESH_MS = 30_000;

/** Whole terabytes and gigabytes read as rounded numerals ("412 GB free of 1 TB"); small sizes keep one decimal. */
export function capacity(value: number): string {
  const units = [
    ['TB', 2 ** 40],
    ['GB', 2 ** 30],
    ['MB', 2 ** 20],
  ] as const;
  for (const [unit, scale] of units) {
    if (value < scale) continue;
    const amount = value / scale;
    return `${amount >= 100 || Number.isInteger(amount) ? Math.round(amount) : amount.toFixed(1)} ${unit}`;
  }
  return `${Math.round(value / 1024)} KB`;
}

function meter(used: number, total: number): HTMLElement {
  const percentUsed = Math.min(100, Math.max(0, Math.round((100 * used) / total))),
    fill = h('i', { className: 'meter-fill' });
  fill.style.setProperty('--used', String(percentUsed));
  return h(
    'div',
    {
      className: `meter${percentUsed >= 90 ? ' is-full' : ''}`,
      attrs: { 'role': 'meter', 'aria-label': t('Space used'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percentUsed), 'aria-valuetext': t('{0}% used', percentUsed) },
    },
    [fill]
  );
}

function driveFacts({ drive }: StorageView): string {
  const access = drive.isReadOnly === null ? null : drive.isReadOnly ? t('Read-only') : t('Read and write');
  return [drive.label, drive.filesystem, access].filter(Boolean).join(' · ');
}

/** Page-local eject progress; the drive card shows it until the page is left. */
type EjectState = { kind: 'idle' } | { kind: 'ejecting' } | { kind: 'ejected' | 'busy' | 'failed'; message: string };

function ejectNotice(state: EjectState): HTMLElement | null {
  switch (state.kind) {
    case 'idle':
    case 'ejecting':
      return null;
    case 'ejected':
      return h('div', { className: 'eject-notice', attrs: { role: 'status' } }, [
        h('p', { className: 'status-line' }, [statusDot('good'), t('Safe to unplug')]),
        h('p', { className: 'note', text: state.message }),
      ]);
    case 'busy':
      return h('p', { className: 'note eject-notice is-warn', attrs: { role: 'status' }, text: state.message });
    case 'failed':
      return h('p', { className: 'note eject-notice is-danger', attrs: { role: 'alert' }, text: state.message });
  }
}

function myDrive(view: StorageView, eject: { state: EjectState; onEject: () => void }): HTMLElement {
  const { drive } = view,
    space = drive.totalBytes !== null && drive.totalBytes > 0 && drive.freeBytes !== null ? { total: drive.totalBytes, free: drive.freeBytes } : null,
    facts = driveFacts(view);
  return card([
    h('p', { className: 'drive-kind', text: drive.isMounted ? t('This LEÓN Home') : t('This LEÓN Home · drive not connected') }),
    h('h2', { className: 'drive-name', text: drive.name }),
    space ? meter(space.total - space.free, space.total) : null,
    space ? h('p', { className: 'drive-space' }, [h('b', { text: capacity(space.free) }), t(' free of {0}', capacity(space.total))]) : null,
    facts ? h('p', { className: 'drive-facts', text: facts }) : null,
    drive.isMounted || drive.openUrl !== null
      ? h('div', { className: 'buttons drive-actions' }, [
          drive.isMounted ? linkButton(t('Browse files'), '/storage/files', 'primary') : null,
          drive.openUrl === null ? null : linkButton(t('Open in Files or Finder'), drive.openUrl),
          drive.canEject || eject.state.kind === 'ejecting'
            ? button({ label: eject.state.kind === 'ejecting' ? t('Ejecting…') : t('Eject'), isDisabled: eject.state.kind === 'ejecting', onPress: eject.onEject })
            : null,
        ])
      : null,
    ejectNotice(eject.state),
  ]);
}

function peerDrive(peer: StorageView['peers'][number]): HTMLElement {
  return card([
    h('p', { className: 'drive-kind', text: t('Another LEÓN Home · over Tailscale') }),
    h('h2', { className: 'drive-name', text: peer.name }),
    h('div', { className: 'buttons drive-actions' }, [linkButton(t('Open in Files or Finder'), peer.url)]),
  ]);
}

/** Same markup and classes as ui/list rows, with the address in monospace and a copy button. */
function connectionList(connections: StorageView['connections']): HTMLElement {
  return h(
    'ul',
    { className: 'list' },
    connections.map(({ platform, address, note }) =>
      h('li', { className: 'list-item' }, [
        h('div', { className: 'row' }, [
          statusDot('good'),
          h('span', { className: 'row-body' }, [
            h('span', { className: 'row-title', text: serverText(platform) }),
            h('code', { className: 'row-detail address', text: address }),
            h('span', { className: 'row-detail', text: serverText(note) }),
          ]),
          copyButton(address, t('Copy the {0} address', serverText(platform)), t('Address copied')),
        ]),
      ])
    )
  );
}

function connectSection(view: StorageView): HTMLElement {
  const body: Array<Child> = [];
  if (!view.isSharingSetUp) body.push(emptyState({ title: t('Network sharing is not set up on this Pi') }));
  else if (view.connections.length === 0) body.push(emptyState({ title: t('No addresses available yet'), detail: t('This Pi is not on the home network or Tailscale.') }));
  else body.push(connectionList(view.connections), h('p', { className: 'note', text: t('Sign in with your own storage account. Open “How to connect” above for the steps.') }));
  return section({ title: t('Connect from other devices') }, body);
}

function folderRows(view: StorageView): HTMLElement {
  if (view.folders.length === 0) return emptyState({ title: t('No shared folders configured') });
  return list(view.folders.map(folder => ({ kind: 'value', title: folder.name, detail: `${folder.path} · ${serverText(folder.status)}`, leading: { kind: 'dot', tone: folder.tone } })));
}

function usbSection({ usbDrives }: StorageView): HTMLElement {
  if (!usbDrives.isAvailable) return section({ title: t('USB drives') }, [emptyState({ title: t('USB inventory unavailable') })]);
  if (usbDrives.volumes.length === 0) return section({ title: t('USB drives') }, [emptyState({ title: t('No USB drives connected') })]);
  return section({ title: t('USB drives') }, [
    list(usbDrives.volumes.map(volume => ({ kind: 'value', title: volume.name, detail: volume.detail, leading: { kind: 'dot', tone: volume.isMounted ? 'good' : 'idle' } }))),
  ]);
}

/** 'notMounted', 'unavailable', 'failed' and anything unexpected read as a failure with the server's sentence. */
function ejectKind(outcome: string): 'ejected' | 'busy' | 'failed' {
  return outcome === 'ejected' || outcome === 'busy' ? outcome : 'failed';
}

export function renderStorage(context: RouteContext): PageView {
  let eject: EjectState = { kind: 'idle' };
  async function ejectDrive(controls: LiveControls): Promise<void> {
    const isConfirmed = await confirm({
      title: t('Eject the drive?'),
      message: t('TVs and shared folders stop until the drive is connected again. Unplug it only after LEÓN says it is safe.'),
      confirmLabel: t('Eject'),
    });
    if (!isConfirmed) return;
    eject = { kind: 'ejecting' };
    controls.repaint();
    // run() holds repaints until the POST ends, then refreshes the storage view (the drive then reads as not connected).
    await controls.run(async () => {
      try {
        const result = await postAction('/api/v1/storage/eject', {}, context.session.actionToken);
        eject = { kind: ejectKind(result.outcome), message: result.message ? serverText(result.message) : t('The drive could not be ejected.') };
      } catch {
        eject = { kind: 'failed', message: t('LEÓN Home did not answer. Check the drive before unplugging it.') };
      }
    });
  }
  return livePage({
    context,
    path: '/api/v1/storage',
    parse: parseStorage,
    intervalMs: REFRESH_MS,
    observedAt: () => null,
    build(view, _state, controls) {
      const automation: Array<ListRow> = context.session.features.automation
        ? [{ kind: 'navigation', title: t('Automation'), detail: t('n8n workflows and recent runs'), href: '/storage/automation' }]
        : [];
      return [
        section({}, [myDrive(view, { state: eject, onEject: () => void ejectDrive(controls) }), ...view.peers.map(peerDrive)]),
        section({}, [
          list([
            { kind: 'navigation', title: t('Movies'), detail: t('Browse your movie library by poster'), href: '/storage/movies' },
            { kind: 'navigation', title: t('How to connect'), detail: t('Step by step for iPhone, Mac, Windows and TV'), href: '/storage/guide' },
          ]),
        ]),
        connectSection(view),
        view.tvServerName === null
          ? null
          : section({ title: t('Watch on the TV') }, [
              list([{ kind: 'value', title: view.tvServerName, detail: t('Open the TV media app or VLC → Local network'), leading: { kind: 'dot', tone: 'good' } }]),
            ]),
        section({ title: t('Shared folders') }, [folderRows(view)]),
        usbSection(view),
        automation.length ? section({}, [list(automation)]) : null,
      ];
    },
  });
}
