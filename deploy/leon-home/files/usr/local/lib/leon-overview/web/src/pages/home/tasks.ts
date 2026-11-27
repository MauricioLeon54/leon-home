import type { HomeView, SetupTask } from '../../contracts/home.js';
import { t } from '../../i18n/index.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';

function taskRow(task: SetupTask): ListRow {
  switch (task.kind) {
    case 'connectRouter':
      return {
        kind: 'navigation',
        leading: { kind: 'dot', tone: 'warn' },
        title: t('Connect your router'),
        detail: t('Enter the router administrator password once. LEÓN then reconnects by itself and shows device names, ports and pauses.'),
        href: '/network',
      };
    case 'nameDevices':
      return {
        kind: 'navigation',
        leading: { kind: 'dot', tone: 'idle' },
        title: task.count === 1 ? t('Name 1 device') : t('Name {0} devices', task.count),
        detail: t('Give each device used today a name you recognize, so pauses and alerts are clear.'),
        href: '/network',
      };
  }
}

/** First steps left for the owner; absent once the installation is complete. */
export function tasksSection(view: HomeView): HTMLElement | null {
  if (view.tasks.length === 0) return null;
  const meta = view.tasks.length === 1 ? t('1 to do') : t('{0} to do', view.tasks.length);
  return section({ title: t('Pending'), meta, tone: 'warn' }, [list(view.tasks.map(taskRow))]);
}
