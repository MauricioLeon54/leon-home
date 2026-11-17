import { postAction } from './api.js';
import type { ControlContext, Feedback, Port } from './contracts.js';
import { $, feedbackFor, speed, text, time } from './presentation.js';
export function createRouterControls({ getState, trafficCurrent, refresh, isRefreshing }: ControlContext) {
  let selectedPort: number | null = null,
    acting = false;
  let outcome: string | null = null,
    outcomePort: number | null = null;
  let pending: { port: number; enabled: boolean } | null = null;
  const OUTCOMES = {
    applied: ['good', 'Hecho: el router confirma el cambio.'],
    unchanged: ['good', 'El puerto ya estaba así.'],
    unverified: ['warn', 'No se pudo confirmar: el puerto puede haber cambiado o no. Revisa antes de repetir.'],
    protectedPort: ['warn', 'Puerto protegido: no está autorizado para desactivarse.'],
    unknownPort: ['warn', 'El router no informa ese puerto.'],
    locked: ['warn', 'La sesión del router está bloqueada: desbloquéala desde la Mac.'],
    busy: ['warn', 'Espera unos segundos entre acciones.'],
    rejected: ['warn', 'El router rechazó el cambio. No se aplicó.'],
    invalid: ['warn', 'Solicitud no válida. No se aplicó.'],
    forbidden: ['warn', 'Sesión expirada o sin permiso. Recarga la página.'],
    unavailable: ['warn', 'El monitor del router no responde. No se aplicó.'],
    network: ['warn', 'Sin respuesta: el cambio puede haberse aplicado o no. Revisa antes de repetir.'],
  } satisfies Record<string, Feedback>;
  function portProtected(port: Port) {
    return port.wan === true || !(getState()?.routerTelemetry.controllablePorts || []).includes(port.port);
  }
  function renderPorts() {
    const ports = getState()?.routerTelemetry?.ports,
      panel = $('#panel'),
      detail = $('#port-detail');
    panel.replaceChildren();
    $('#ports-at').textContent = trafficCurrent() && ports ? 'Router ' + time(getState()?.routerTelemetry.observedAt) : 'Sin lectura actual';
    if (!trafficCurrent() || !ports) {
      panel.append(text('p', 'Sin lectura actual de los puertos. Requiere la sesión del router desbloqueada.', 'muted small'));
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
        text('small', port.enabled === false ? 'Desactivado' : port.link === 'up' ? speed(port.speedMbps) : port.link === 'down' ? 'Sin cable' : 'Desconocido')
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
    tiles.className = 'detail';
    for (const [label, value] of [
      ['Enlace', port.link === 'up' ? 'Conectado' : port.link === 'down' ? 'Sin enlace' : 'Desconocido'],
      ['Velocidad', port.link === 'up' ? speed(port.speedMbps) : '—'],
      ['Dúplex', port.duplex === 'full' ? 'Completo' : port.duplex === 'half' ? 'Medio' : '—'],
      ['Estado', port.enabled === true ? 'Activado' : port.enabled === false ? 'Desactivado' : 'Desconocido'],
    ]) {
      const tile = document.createElement('div');
      tile.className = 'tile';
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
        ? ['Aplicando…', '']
        : outcomePort === port.port && outcome
          ? feedbackFor(OUTCOMES, outcome, 'invalid')
          : [
              port.wan
                ? 'Puerto WAN · protegido siempre'
                : locked
                  ? 'Protegido · no está en la lista autorizada'
                  : port.enabled === false
                    ? 'Desactivado'
                    : port.link === 'up'
                      ? 'Activado · ' + speed(port.speedMbps)
                      : port.enabled === true
                        ? 'Activado · sin cable'
                        : 'Estado desconocido',
              '',
            ];
      info.append(text('b', port.wan ? 'WAN' : 'LAN ' + port.port), text('small', note[0], note[1]));
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'switch';
      toggle.setAttribute('role', 'switch');
      toggle.checked = isPending ? isPending.enabled : port.enabled === true;
      toggle.setAttribute('aria-label', (port.wan ? 'WAN' : 'Puerto ' + port.port) + ' activado');
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
    $('#confirm-title').textContent = (enabling ? 'Activar' : 'Desactivar') + ' el puerto ' + port.port + '?';
    $('#confirm-text').textContent = enabling
      ? 'El router restablecerá el enlace Ethernet de este puerto.'
      : port.link === 'up'
        ? 'Hay un equipo conectado: perderá la red cableada hasta que vuelvas a activar el puerto. La energía no se corta.'
        : 'El puerto no tiene enlace ahora. Si conectas un equipo, no tendrá red hasta activarlo.';
    const ok = $('#confirm-ok', HTMLButtonElement);
    ok.textContent = enabling ? 'Activar' : 'Desactivar';
    ok.className = enabling ? 'primary' : 'danger';
    ok.onclick = () => {
      dialog.close();
      void applyPort(port.port, enabling);
    };
    $('#confirm-cancel', HTMLButtonElement).onclick = () => dialog.close();
    dialog.showModal();
  }
  const UNLOCK_OUTCOMES = {
    current: ['good', 'Listo: sesión del router activa.'],
    unlockFailed: ['warn', 'Frase incorrecta o el router no respondió. Puedes intentarlo de nuevo en un minuto.'],
    busy: ['warn', 'Espera un minuto entre intentos.'],
    notConfigured: ['warn', 'La Pi aún no tiene la copia cifrada de la bóveda.'],
    forbidden: ['warn', 'Sesión de la página caducada. Recarga.'],
    unavailable: ['warn', 'El monitor del router no responde.'],
    invalid: ['warn', 'Frase no válida.'],
    network: ['warn', 'Sin conexión con LEÓN Home.'],
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
    button.textContent = 'Descifrando…';
    let result;
    try {
      const reply = await postAction('/network-map/unlock', { phrase: field.value }, getState()?.actionToken ?? '');
      result = reply.httpStatus === 403 ? 'forbidden' : reply.httpStatus === 503 ? 'unavailable' : reply.outcome;
    } catch (error) {
      result = 'network';
    } finally {
      field.value = '';
      button.disabled = false;
      button.textContent = 'Desbloquear';
    }
    const [tone, message] = feedbackFor(UNLOCK_OUTCOMES, result, 'unlockFailed');
    status.textContent = message;
    status.className = 'small ' + tone;
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
