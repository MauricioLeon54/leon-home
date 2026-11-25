import { readStoragePassword } from '../../api.js';
import { parseStorage, type StorageView } from '../../contracts/storage.js';
import { type Child, h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { emptyState } from '../../ui/empty.js';
import { card, section } from '../../ui/section.js';
import { createSegmented } from '../../ui/segmented.js';
import { showToast } from '../../ui/toast.js';
import { type LiveControls, livePage } from '../settings/livePage.js';
import { copyButton } from './copyButton.js';

const REFRESH_MS = 30_000;
const PASSWORD_VISIBLE_MS = 60_000;
type Device = 'iphone' | 'mac' | 'windows' | 'tv';
type Account = StorageView['accounts'][number];
interface Drive {
  name: string;
  url: string | null;
  windowsHome: string | null;
  windowsAway: string | null;
}

/** smb://host/Share as the address Windows File Explorer understands. */
export function windowsAddress(url: string): string {
  return url.replace(/^smb:/, '').replaceAll('/', '\\');
}

function drivesOf(view: StorageView): Drive[] {
  const home = view.connections.find(({ platform }) => platform === 'Windows at home'),
    away = view.connections.find(({ platform }) => platform === 'Windows away from home'),
    own: Drive[] = view.isSharingSetUp ? [{ name: view.drive.name, url: view.drive.openUrl, windowsHome: home?.address ?? null, windowsAway: away?.address ?? null }] : [];
  return [...own, ...view.peers.map(({ name, url }) => ({ name, url, windowsHome: null, windowsAway: windowsAddress(url) }))];
}

function valueRow(label: string, value: string, copyLabel: string, isCode = true): HTMLElement {
  return h('div', { className: 'row guide-value' }, [
    h('span', { className: 'row-body' }, [h('span', { className: 'row-detail', text: label }), h(isCode ? 'code' : 'span', { className: isCode ? 'address' : 'row-title', text: value })]),
    copyButton(value, copyLabel, t('{0} copied', label)),
  ]);
}

function steps(items: ReadonlyArray<string>): HTMLElement {
  return h(
    'ol',
    { className: 'guide-steps' },
    items.map(text => h('li', { text }))
  );
}

function addressesFor(drive: Drive, device: Device): Array<[label: string, value: string]> {
  if (device !== 'windows') return drive.url === null ? [] : [[t('Address'), drive.url]];
  const rows: Array<[string, string]> = [];
  if (drive.windowsHome !== null) rows.push([t('Address at home'), drive.windowsHome]);
  if (drive.windowsAway !== null) rows.push([drive.windowsHome === null ? t('Address') : t('Address away from home'), drive.windowsAway]);
  return rows;
}

const CONNECT_STEPS: Record<Exclude<Device, 'tv'>, ReadonlyArray<string>> = {
  iphone: [
    t('Turn on Tailscale.'),
    t('Open the Files app and tap Browse.'),
    t('Tap the ••• button at the top, then Connect to Server.'),
    t('Paste the address below and tap Connect.'),
    t('Choose Registered User. Enter the user and password below, then tap Next.'),
    t('Open a movie. If it does not play, install the free VLC app and open it there.'),
  ],
  mac: [
    t('Turn on Tailscale.'),
    t('Open Finder and press Command + K.'),
    t('Paste the address below and click Connect.'),
    t('Choose Registered User. Enter the user and password below.'),
    t('Open a movie. If it does not play, install the free VLC or IINA app and open it there.'),
  ],
  windows: [
    t('Away from home, or for another home’s drive, turn on Tailscale first.'),
    t('Press the Windows key + E.'),
    t('Paste the address below in the bar at the top and press Enter.'),
    t('Enter the user and password below. Tick “Remember my credentials”.'),
    t('Open a movie. If it does not play, install the free VLC app and open it there.'),
  ],
};

export function renderGuide(context: RouteContext): PageView {
  let device: Device = 'iphone';
  const shown = new Map<string, string>(), // passwords on screen, in memory only
    timers = new Set<ReturnType<typeof setTimeout>>();

  async function reveal(account: Account, key: string, controls: LiveControls): Promise<void> {
    try {
      const result = await readStoragePassword({ drive: account.drive, user: account.user }, context.session.actionToken);
      if (context.signal.aborted) return;
      if ('reason' in result) {
        showToast('refused', serverText(result.reason));
        return;
      }
      shown.set(key, result.password);
      const timer = setTimeout(() => {
        timers.delete(timer);
        hide(key, controls);
      }, PASSWORD_VISIBLE_MS);
      timers.add(timer);
      controls.repaint();
    } catch {
      showToast('unverified', t('LEÓN Home did not answer'));
    }
  }
  function hide(key: string, controls: LiveControls): void {
    if (shown.delete(key)) controls.repaint();
  }

  function signIn(account: Account, controls: LiveControls): ReadonlyArray<HTMLElement> {
    const key = `${account.drive}\n${account.user}`,
      password = shown.get(key);
    return [
      valueRow(t('User'), account.user, t('Copy the user for {0}', account.drive)),
      password === undefined
        ? h('div', { className: 'row guide-value' }, [
            h('span', { className: 'row-body' }, [h('span', { className: 'row-detail', text: t('Password') }), h('span', { text: '••••••••' })]),
            h('button', {
              className: 'copy-button',
              text: t('Show'),
              attrs: { 'type': 'button', 'aria-label': t('Show the password for {0}', account.drive) },
              dataset: { focusKey: `show-${key}` },
              on: { click: () => void reveal(account, key, controls) },
            }),
          ])
        : valueRow(t('Password · hides after 1 minute'), password, t('Copy the password for {0}', account.drive)),
    ];
  }

  function driveCard(drive: Drive, view: StorageView, selected: Exclude<Device, 'tv'>, controls: LiveControls): HTMLElement {
    const accounts = view.accounts.filter(account => account.drive === drive.name),
      addresses = addressesFor(drive, selected);
    return card([
      h('h3', { className: 'drive-name', text: drive.name }),
      addresses.length === 0 ? h('p', { className: 'note', text: t('No address is available right now. Try again in a minute.') }) : null,
      ...addresses.map(([label, value]) => valueRow(label, value, t('Copy the address for {0}', drive.name))),
      ...accounts.flatMap(account => [
        h('p', { className: 'note', text: account.canWrite ? t('You can watch, add and delete files.') : t('You can watch. You cannot change anything.') }),
        ...signIn(account, controls),
      ]),
      accounts.length === 0 ? h('p', { className: 'note', text: t('Ask the person who set up LEÓN Home for your user and password.') }) : null,
    ]);
  }

  function tvGuide(view: StorageView): Child {
    if (view.tvServerName === null) return emptyState({ title: t('The TV library is not running'), detail: t('Check that the drive is connected to the Pi.') });
    return section({ title: t('Watch on the TV') }, [
      card([
        steps([
          t('Use a TV on your home network. Nothing to install and no password.'),
          t('On the TV, open Sources, Inputs or the media player app.'),
          t('Choose “{0}”.', view.tvServerName),
          t('Choose a movie. New movies can take up to 20 minutes to appear.'),
        ]),
        h('p', { className: 'note', text: t('If the TV list is empty, turn the TV off and on. If a movie has no sound, watch it with VLC on a phone or computer.') }),
      ]),
    ]);
  }

  const view = livePage({
    context,
    path: '/api/v1/storage',
    parse: parseStorage,
    intervalMs: REFRESH_MS,
    observedAt: () => null,
    build(data, _state, controls) {
      const drives = drivesOf(data),
        picker = createSegmented<Device>({
          label: t('Device'),
          options: [
            { value: 'iphone', label: 'iPhone' },
            { value: 'mac', label: 'Mac' },
            { value: 'windows', label: 'Windows' },
            { value: 'tv', label: t('TV') },
          ],
          value: device,
          onChange: next => {
            device = next;
            controls.repaint();
          },
        }).element,
        canAddFiles = data.accounts.some(account => account.canWrite);
      if (device === 'tv') return [section({}, [picker]), tvGuide(data)];
      const selected = device;
      return [
        section({}, [picker]),
        drives.length === 0
          ? emptyState({ title: t('No drives are shared yet') })
          : section(selected === 'iphone' ? { title: t('Steps'), meta: t('Also for iPad') } : { title: t('Steps') }, [
              card([steps(CONNECT_STEPS[selected])]),
              ...drives.map(drive => driveCard(drive, data, selected, controls)),
            ]),
        canAddFiles
          ? section({ title: t('Add a movie') }, [
              card([
                steps([
                  t('Connect using the steps above.'),
                  t('Open the folder where the other movies are. The TV only shows that folder.'),
                  t('Make a folder named with the title and year, for example Coco (2017).'),
                  t('Copy the movie into that folder and wait until the copy finishes.'),
                ]),
                h('p', { className: 'note', text: t('Deleting a file here deletes it for everyone. There is no trash to recover it from.') }),
              ]),
            ])
          : null,
        data.isSharingSetUp
          ? section({ title: t('Take care of the drive') }, [
              card([
                h('p', { text: t('Never unplug the drive or the Pi while it is on. Doing so can damage the movies.') }),
                h('p', { className: 'note', text: t('To move or unplug it, first ask the person who set up LEÓN Home.') }),
              ]),
            ])
          : null,
      ];
    },
  });
  return {
    element: view.element,
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      shown.clear();
      view.dispose?.();
    },
  };
}
