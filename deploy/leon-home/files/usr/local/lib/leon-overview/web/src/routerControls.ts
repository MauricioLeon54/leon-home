import { postAction } from './api.js';
import type { ControlContext, Feedback, Port } from './contracts.js';
import { closeDialog, openDialog, swapText } from './motion.js';
import { $, feedbackFor, speed, text, time } from './presentation.js';
export function createRouterControls({ getState, trafficCurrent, refresh, isRefreshing }: ControlContext) {
  let selectedPort: number | null = null,
    acting = false;
  let outcome: string | null = null,
    outcomePort: number | null = null;
  let pending: { port: number; enabled: boolean } | null = null;
  const OUTCOMES = {
    applied: ['good', 'Done. The router confirmed the change.'],
    unchanged: ['good', 'The port was already set.'],
    unverified: ['warn', 'The result is unconfirmed. The port may have changed. Check before trying again.'],
    protectedPort: ['warn', 'Protected port. Disabling it is not authorized.'],
    unknownPort: ['warn', 'The router does not report this port.'],
    locked: ['warn', 'The router session is locked. Ask your support person to unlock it.'],
    busy: ['warn', 'Wait a few seconds between actions.'],
    rejected: ['warn', 'The router rejected the change. It was not applied.'],
    invalid: ['warn', 'Invalid request. The change was not applied.'],
    forbidden: ['warn', 'Your session expired or access is denied. Reload the page.'],
    unavailable: ['warn', 'The router monitor is unavailable. The change was not applied.'],
    network: ['warn', 'No response. The change may have been applied. Check before trying again.'],
  } satisfies Record<string, Feedback>;
  function portProtected(port: Port) {
    return port.wan === true || !(getState()?.routerTelemetry.controllablePorts || []).includes(port.port);
  }
  function renderPorts() {
    const ports = getState()?.routerTelemetry?.ports,
      panel = $('#panel'),
      detail = $('#port-detail');
    panel.replaceChildren();
    $('#ports-at').textContent = trafficCurrent() && ports ? 'Router, ' + time(getState()?.routerTelemetry.observedAt) : 'No current reading';
    if (!trafficCurrent() || !ports) {
      panel.append(text('p', 'No current port reading. Unlock the router session to see readings.', 'muted small'));
      detail.replaceChildren();
      return;
    }
    for (const port of ports) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.className = 'port' + (port.enabled === false ? ' off' : '') + (selectedPort === port.port ? ' selected' : '');
      button.setAttribute('aria-selected', String(selectedPort === port.port));
      const leds = document.createElement('span'),
        link = document.createElement('i'),
        activity = document.createElement('i');
      leds.className = 'leds';
      link.className = 'led ' + (port.link === 'up' ? 'on' : port.link === 'unknown' ? 'unknown' : '');
      activity.className = 'led ' + (port.enabled === false ? 'amber' : port.link === 'up' ? 'on' : '');
      leds.append(link, activity);
      const jack = document.createElement('span');
      jack.className = 'jack';
      button.append(
        leds,
        jack,
        text('b', port.wan ? 'WAN' : 'LAN ' + port.port),
        text('small', port.enabled === false ? 'Disabled' : port.link === 'up' ? speed(port.speedMbps) : port.link === 'down' ? 'No cable' : 'Unknown')
      );
      button.addEventListener('click', () => {
        selectedPort = port.port;
        outcome = null;
        renderPorts();
      });
      panel.append(button);
    }
    const port = ports.find(item => item.port === selectedPort);
    detail.replaceChildren();
    if (!port) {
      detail.append(switchList(ports));
      return;
    }
    const tiles = document.createElement('div');
    tiles.className = 'readings port-facts';
    for (const [label, value] of [
      ['Link', port.link === 'up' ? 'Connected' : port.link === 'down' ? 'No link' : 'Unknown'],
      ['Speed', port.link === 'up' ? speed(port.speedMbps) : '—'],
      ['Duplex', port.duplex === 'full' ? 'Full' : port.duplex === 'half' ? 'Half' : '—'],
      ['Status', port.enabled === true ? 'Enabled' : port.enabled === false ? 'Disabled' : 'Unknown'],
    ]) {
      const tile = document.createElement('div');
      tile.className = 'reading' + (value === 'Unknown' || value === '—' ? ' unknown' : '');
      tile.append(text('b', value), text('span', label));
      tiles.append(tile);
    }
    detail.append(tiles, switchList(ports));
  }
  // One switch per port. While a change is pending it shows the requested position; afterwards only the
  // router's re-read moves it. Disabling asks first; enabling a known port is always allowed and acts at once.
  function switchList(ports: Array<Port>) {
    const list = document.createElement('ul');
    list.className = 'switches';
    for (const port of ports) {
      const row = document.createElement('li');
      row.className = selectedPort === port.port ? 'selected' : '';
      const isPending = pending?.port === port.port ? pending : null,
        locked = port.enabled !== false && portProtected(port);
      const info = document.createElement('div');
      info.className = 'info';
      info.addEventListener('click', () => {
        selectedPort = port.port;
        outcome = null;
        renderPorts();
      });
      const note = isPending
        ? ['Applying…', '']
        : outcomePort === port.port && outcome
          ? feedbackFor(OUTCOMES, outcome, 'invalid')
          : [
              port.wan
                ? 'WAN port · always protected'
                : locked
                  ? 'Protected · not in the allowed list'
                  : port.enabled === false
                    ? 'Disabled'
                    : port.link === 'up'
                      ? 'Enabled · ' + speed(port.speedMbps)
                      : port.enabled === true
                        ? 'Enabled · no cable'
                        : 'Unknown state',
              '',
            ];
      info.append(text('b', port.wan ? 'WAN' : 'LAN ' + port.port), text('small', note[0], note[1]));
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'switch';
      toggle.setAttribute('role', 'switch');
      toggle.checked = isPending ? isPending.enabled : port.enabled === true;
      toggle.setAttribute('aria-label', (port.wan ? 'WAN' : 'Port ' + port.port) + ' enabled');
      if (isPending) toggle.setAttribute('aria-busy', 'true');
      toggle.disabled = acting || !(getState()?.actionToken ?? '') || (locked && port.enabled === true);
      toggle.addEventListener('change', () => {
        const enabling = toggle.checked;
        toggle.checked = !enabling;
        selectedPort = port.port;
        if (enabling) void applyPort(port.port, true);
        else confirmPort(port, false);
      });
      row.append(info, toggle);
      list.append(row);
    }
    return list;
  }
  function confirmPort(port: Port, enabling: boolean) {
    const dialog = $('#confirm', HTMLDialogElement);
    $('#confirm-title').textContent = (enabling ? 'Enable' : 'Disable') + ' port ' + port.port + '?';
    $('#confirm-text').textContent = enabling
      ? 'The router will restore the Ethernet link on this port.'
      : port.link === 'up'
        ? 'A connected device will lose its wired connection until you enable the port again. Power stays on.'
        : 'The port has no link now. A device connected here will have no network until the port is enabled.';
    const ok = $('#confirm-ok', HTMLButtonElement);
    ok.textContent = enabling ? 'Enable' : 'Disable';
    ok.className = enabling ? 'primary' : 'danger';
    ok.onclick = () => {
      closeDialog(dialog);
      void applyPort(port.port, enabling);
    };
    $('#confirm-cancel', HTMLButtonElement).onclick = () => closeDialog(dialog);
    openDialog(dialog);
  }
  const UNLOCK_OUTCOMES = {
    current: ['good', 'Ready. The router session is active.'],
    unlockFailed: ['warn', 'Incorrect passphrase or no router response. Try again in one minute.'],
    busy: ['warn', 'Wait one minute between attempts.'],
    notConfigured: ['warn', 'The Pi does not have an encrypted vault copy yet.'],
    forbidden: ['warn', 'Your page session expired. Reload to continue.'],
    unavailable: ['warn', 'The router monitor is not responding.'],
    invalid: ['warn', 'Invalid passphrase.'],
    network: ['warn', 'LEÓN Home could not be reached.'],
  } satisfies Record<string, Feedback>;
  // One attempt per submit, never retried; the password field is cleared whatever the outcome.
  $('#unlock-form', HTMLFormElement).addEventListener('submit', event => {
    void unlock(event);
  });
  async function unlock(event: Event): Promise<void> {
    event.preventDefault();
    const field = $('#unlock-password', HTMLInputElement),
      button = $('#unlock-submit', HTMLButtonElement),
      status = $('#unlock-status');
    if (!getState()?.actionToken || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Decrypting…';
    let result;
    try {
      const reply = await postAction('/network-map/unlock', { phrase: field.value }, getState()?.actionToken ?? '');
      result = reply.httpStatus === 403 ? 'forbidden' : reply.httpStatus === 503 ? 'unavailable' : reply.outcome;
    } catch (error) {
      result = 'network';
    } finally {
      field.value = '';
      button.disabled = false;
      button.textContent = 'Unlock';
    }
    const [tone, message] = feedbackFor(UNLOCK_OUTCOMES, result, 'unlockFailed');
    swapText(status, message, 'small ' + tone);
    await refresh();
  }
  async function applyPort(number: number, enabled: boolean): Promise<void> {
    if (acting) return;
    acting = true;
    outcome = null;
    pending = { port: number, enabled };
    outcomePort = number;
    renderPorts();
    try {
      const reply = await postAction('/network-map/port', { port: number, enabled }, getState()?.actionToken ?? '');
      outcome = reply.httpStatus === 403 ? 'forbidden' : reply.httpStatus === 503 ? 'unavailable' : reply.ok ? reply.outcome : 'invalid';
    } catch (error) {
      outcome = 'network';
    } finally {
      // never retried: the router may already have applied it
      acting = false;
    }
    // Wait out an in-flight poll (bounded by its 8 s abort) so the switch settles on a post-change reading.
    while (isRefreshing()) await new Promise(resolve => setTimeout(resolve, 100));
    await refresh();
    pending = null;
    renderPorts();
  }

  return { render: renderPorts, isActing: () => acting };
}
