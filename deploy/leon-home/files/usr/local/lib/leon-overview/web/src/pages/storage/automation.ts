import { postAction } from '../../api.js';
import { type AutomationView, EDITOR_URL, parseAutomation } from '../../contracts/storage.js';
import { type Child, h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { button } from '../../ui/button.js';
import { emptyState } from '../../ui/empty.js';
import { list, type ListRow } from '../../ui/list.js';
import { reading, readingGrid } from '../../ui/reading.js';
import { card, section } from '../../ui/section.js';
import { createSegmented } from '../../ui/segmented.js';
import { openSheet } from '../../ui/sheet.js';
import { statusDot } from '../../ui/statusDot.js';
import { showToast } from '../../ui/toast.js';
import { type LiveControls, livePage } from '../settings/livePage.js';
import { linkButton } from './linkButton.js';

const REFRESH_MS = 30_000;
type Filter = 'all' | 'failed';

/** "2026-11-20T14:03:05.000Z" reads as "2026-11-20 14:03 UTC"; anything else is shown as the server sent it. */
export function runTime(startedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})[^Z+-]*Z$/.exec(startedAt);
  return match ? `${match[1]} ${match[2]} UTC` : startedAt;
}

function workflowRows(view: AutomationView): ListRow[] {
  const editor = view.editorUrl?.replace(/\/$/, '');
  return (view.workflows ?? []).map(workflow => ({
    kind: 'value',
    title: workflow.name,
    detail: serverText(workflow.state),
    leading: { kind: 'dot', tone: workflow.isActive === true ? 'good' : workflow.isActive === false ? 'idle' : 'unknown' },
    accessories:
      editor === undefined
        ? []
        : [
            h('a', {
              className: 'link-button',
              text: t('Open'),
              attrs: { 'href': `${editor}/workflow/${workflow.id}`, 'target': '_blank', 'rel': 'noopener noreferrer', 'aria-label': t('Open {0} in the n8n editor', workflow.name) },
            }),
          ],
  }));
}

function executionRows(view: AutomationView): ListRow[] {
  return (view.executions ?? []).map(execution => ({
    kind: 'value',
    title: execution.workflowName,
    detail: execution.startedAt === null ? serverText(execution.label) : `${serverText(execution.label)} · ${runTime(execution.startedAt)}`,
    leading: { kind: 'dot', tone: execution.tone },
  }));
}

function emptyExecutions(view: AutomationView): string {
  if (view.executions === null) return t('Execution history unavailable');
  return view.failuresOnly ? t('No failures in recent executions') : t('No stored executions');
}

function openSettings(view: AutomationView, context: RouteContext, controls: LiveControls): void {
  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void submit();
  }
  const key = h('input', {
      className: 'field',
      attrs: { id: 'automation-key', type: 'password', name: 'apiKey', maxlength: '4096', autocomplete: 'off', placeholder: view.hasStoredKey ? t('Stored key kept') : '' },
    }),
    url = h('input', {
      className: 'field',
      attrs: { id: 'automation-url', type: 'text', name: 'editorUrl', inputmode: 'url', maxlength: '253', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' },
    }),
    status = h('p', { className: 'note', attrs: { role: 'status' } }),
    save = button({ label: t('Save connection'), variant: 'primary', onPress: () => void submit() }),
    sheet = openSheet({
      title: t('Connection settings'),
      content: [
        h('p', {
          className: 'note',
          text: t('Create a key in n8n under Settings → n8n API with workflow:list and execution:list access. Use the private Tailscale address if you have enabled HTTPS for n8n.'),
        }),
        h('form', { className: 'settings-form', on: { submit: onSubmit } }, [
          h('label', { className: 'field-label', text: t('Read-only API key'), attrs: { for: 'automation-key' } }),
          key,
          h('label', { className: 'field-label', text: t('Private editor URL'), attrs: { for: 'automation-url' } }),
          url,
          status,
          h('div', { className: 'buttons' }, [save, button({ label: t('Cancel'), onPress: () => sheet.close() })]),
        ]),
      ],
    });
  url.value = view.editorUrl ?? '';

  async function submit(): Promise<void> {
    const editorUrl = url.value.trim(),
      apiKey = key.value;
    const problem =
      apiKey === '' && !view.hasStoredKey ? t('Enter the n8n API key.') : editorUrl !== '' && !EDITOR_URL.test(editorUrl) ? t('The editor address must be https and end in .ts.net.') : '';
    status.textContent = problem;
    if (problem) return;
    save.disabled = true;
    try {
      const result = await controls.run(() => postAction('/api/v1/automation/settings', { apiKey, editorUrl }, context.session.actionToken));
      switch (result.outcome) {
        case 'saved':
          key.value = '';
          showToast('applied', serverText(result.message) || t('Connection saved'));
          sheet.close();
          return;
        case 'forbidden':
          status.textContent = t('Reload the page and try again.');
          showToast('refused', t('Reload the page'));
          return;
        default:
          status.textContent = serverText(result.message) || t('The connection was refused.');
          showToast('refused', serverText(result.message) || t('The connection was refused'));
      }
    } catch {
      status.textContent = t('LEÓN Home did not answer. Nothing was saved.');
      showToast('unverified', t('LEÓN Home did not confirm'));
    } finally {
      save.disabled = false;
    }
  }
}

export function renderAutomation(context: RouteContext): PageView {
  let filter: Filter = context.query.get('status') === 'failed' ? 'failed' : 'all';
  function setFilter(next: Filter, controls: LiveControls): void {
    filter = next;
    history.replaceState(history.state, '', next === 'failed' ? '/storage/automation?status=failed' : '/storage/automation');
    void controls.run(() => Promise.resolve());
  }
  return livePage({
    context,
    path: () => (filter === 'failed' ? '/api/v1/automation?status=failed' : '/api/v1/automation'),
    parse: parseAutomation,
    intervalMs: REFRESH_MS,
    observedAt: () => null,
    build(view, _state, controls) {
      const workflows = workflowRows(view),
        executions = executionRows(view),
        headline: Array<Child> = [statusDot(view.isReady ? 'good' : 'idle'), h('span', { text: view.isReady ? t('n8n is ready') : t('n8n is unavailable') })];
      return [
        section({}, [
          card([
            h('p', { className: 'status-line' }, headline),
            readingGrid([
              reading({ label: t('Workflows shown'), value: view.workflows === null ? null : String(workflows.length), state: { kind: 'current' } }),
              reading({ label: t('Recent runs'), value: view.executions === null ? null : String(executions.length), state: { kind: 'current' } }),
            ]),
            view.editorUrl === null ? null : h('div', { className: 'buttons status-actions' }, [linkButton(t('Open n8n editor'), view.editorUrl, 'primary', true)]),
          ]),
        ]),
        section({ title: t('Workflows') }, [workflows.length ? list(workflows) : emptyState({ title: view.workflows === null ? t('Workflow list unavailable') : t('No workflows found') })]),
        section({ title: t('Recent executions') }, [
          view.executions === null
            ? null
            : createSegmented<Filter>({
                label: t('Filter executions'),
                options: [
                  { value: 'all', label: t('All') },
                  { value: 'failed', label: t('Failed') },
                ],
                value: filter,
                onChange: next => setFilter(next, controls),
              }).element,
          executions.length ? list(executions) : emptyState({ title: emptyExecutions(view) }),
        ]),
        section({}, [
          list([{ kind: 'action', title: t('Connection settings'), value: view.isConnected ? t('Connected') : t('Not connected'), onSelect: () => openSettings(view, context, controls) }]),
        ]),
      ];
    },
  });
}
