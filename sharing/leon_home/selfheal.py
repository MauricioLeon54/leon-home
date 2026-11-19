#!/usr/bin/env python3
"""LEÓN Home self-repair, every 2 minutes as root. Needs no other computer.

Observes the local DNS chain, the home network link and Tailscale, and repairs only what this Pi
owns, with bounded escalation: restart Unbound or Pi-hole FTL, restart networking, restart
tailscaled and, as a last resort for a dead link, one reboot at most every 6 hours. An Internet
or router outage outside the Pi is recorded and never acted on beyond that. Never changes the
router, DHCP, client DNS, Tailscale settings or routes.
"""

import json
import os
import shutil
import socket
import struct
import subprocess
import time

STATE_DIR = os.environ.get('STATE_DIRECTORY', '/var/lib/leon-home-selfheal')
STATE_FILE = os.path.join(STATE_DIR, 'state.json')
EVENTS_FILE = os.path.join(STATE_DIR, 'events.jsonl')
NOTIFY = '/usr/local/bin/leon-notify'
MAX_EVENTS = 300

DNS_COOLDOWN = 600
LINK_RESTART_AFTER = 240
LINK_COOLDOWN = 900
REBOOT_AFTER = 1800
REBOOT_MIN_UPTIME = 3600
REBOOT_COOLDOWN = 6 * 3600
TAILSCALE_RESTART_AFTER = 360
TAILSCALE_COOLDOWN = 1200
# Login and approval states need a person; restarting the daemon cannot fix them.
TAILSCALE_PERSON_STATES = {'NeedsLogin', 'NeedsMachineAuth'}


def decide(state, seen, now, uptime):
    """Pure policy. `seen` holds booleans internet, link, unbound, pihole and tailscale (None when
    unknown) plus the Tailscale backend state. Returns (new_state, actions, events)."""
    state = dict(state)
    last = dict(state.get('last', {}))
    actions, events = [], []

    def since(key, failing):
        """Seconds the problem has lasted, or None while healthy."""
        if not failing:
            if state.get(key):
                events.append(f'{key[:-5]} recovered after {int((now - state[key]) // 60)} min')
            state[key] = None
            return None
        state[key] = state.get(key) or now
        return now - state[key]

    def ready(action, cooldown):
        return now - last.get(action, 0) >= cooldown

    # The link is fine whenever the Internet answers; otherwise the router decides it.
    link_down = since('linkSince', not seen['internet'] and not seen['link'])
    if link_down is not None:
        state['dnsSince'] = state['tailscaleSince'] = None
        if (
            link_down >= REBOOT_AFTER
            and state.get('linkRestarted')
            and uptime >= REBOOT_MIN_UPTIME
            and ready('reboot', REBOOT_COOLDOWN)
        ):
            actions.append('reboot')
        elif link_down >= LINK_RESTART_AFTER and ready('network', LINK_COOLDOWN):
            actions.append('network')
            state['linkRestarted'] = True
    else:
        state['linkRestarted'] = False

    # DNS and Tailscale depend on the Internet; without it nothing local is wrong.
    if seen['internet']:
        dns_down = since('dnsSince', not (seen['unbound'] and seen['pihole']))
        if dns_down is not None and ready('dns', DNS_COOLDOWN):
            # Pi-hole forwards to Unbound, so a dead Unbound is repaired first.
            actions.append('pihole' if seen['unbound'] else 'unbound')
        tailscale_bad = seen['tailscale'] is False
        if tailscale_bad and seen.get('backend') in TAILSCALE_PERSON_STATES:
            if state.get('tailscaleNeedsPerson') != seen['backend']:
                events.append(f'Tailscale needs its owner: {seen["backend"]}')
            state['tailscaleNeedsPerson'] = seen['backend']
            tailscale_bad = False
        else:
            state['tailscaleNeedsPerson'] = None
        tailscale_down = since('tailscaleSince', tailscale_bad)
        if (tailscale_down or 0) >= TAILSCALE_RESTART_AFTER and ready(
            'tailscale', TAILSCALE_COOLDOWN
        ):
            actions.append('tailscale')
    for action in actions:
        last['dns' if action in ('unbound', 'pihole') else action] = now
    state['last'] = last
    return state, actions, events


def dns_answers(port, name='cloudflare.com'):
    question = b''.join(bytes([len(part)]) + part.encode() for part in name.split('.'))
    query = struct.pack('>HHHHHH', 0x4C45, 0x0100, 1, 0, 0, 0) + question + b'\0\0\1\0\1'
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(2)
            client.sendto(query, ('127.0.0.1', port))
            reply = client.recv(512)
    except OSError:
        return False
    return len(reply) >= 12 and reply[:2] == query[:2] and reply[3] & 0x0F == 0 and reply[7] > 0


def healthy(check, *arguments):
    for attempt in range(3):
        if check(*arguments):
            return True
        if attempt < 2:
            time.sleep(5)
    return False


def tcp_answers(host, port):
    try:
        with socket.create_connection((host, port), timeout=3):
            return True
    except OSError:
        return False


def gateway():
    try:
        with open('/proc/net/route', encoding='ascii') as routes:
            for line in routes.readlines()[1:]:
                fields = line.split()
                if fields[1] == '00000000' and int(fields[3], 16) & 2:
                    return socket.inet_ntoa(struct.pack('<L', int(fields[2], 16)))
    except (OSError, ValueError, IndexError):
        pass
    return None


def run(*command, timeout=60):
    try:
        return subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None


def observe(state):
    internet = tcp_answers('1.1.1.1', 443) or tcp_answers('9.9.9.9', 443)
    router = gateway() or state.get('gateway')
    link = internet
    if not internet and router:
        ping = run('ping', '-c', '1', '-W', '2', router, timeout=5)
        link = (ping is not None and ping.returncode == 0) or tcp_answers(router, 80)
    seen = {'internet': internet, 'link': link, 'gateway': router}
    seen['unbound'] = healthy(dns_answers, 5335)
    seen['pihole'] = healthy(dns_answers, 53)
    result = run('tailscale', 'status', '--json', timeout=10)
    try:
        status = json.loads(result.stdout)
        seen['backend'] = status.get('BackendState')
        seen['tailscale'] = seen['backend'] == 'Running' and bool(status['Self'].get('Online'))
    except (AttributeError, TypeError, ValueError, KeyError):
        seen['backend'], seen['tailscale'] = None, None
    return seen


def repair(action):
    if action == 'unbound':
        run('systemctl', 'reset-failed', 'unbound.service')
        run('systemctl', 'restart', 'unbound.service')
    elif action == 'pihole':
        run('systemctl', 'reset-failed', 'pihole-FTL.service')
        run('systemctl', 'restart', 'pihole-FTL.service')
    elif action == 'tailscale':
        run('systemctl', 'restart', 'tailscaled.service')
    elif action == 'network':
        if shutil.which('nmcli'):
            run('nmcli', 'networking', 'off')
            time.sleep(3)
            run('nmcli', 'networking', 'on')
        else:
            run('systemctl', 'restart', 'systemd-networkd.service')
    elif action == 'reboot':
        run('systemctl', 'reboot')


DESCRIPTIONS = {
    'unbound': 'Unbound stopped answering; restarted it',
    'pihole': 'Pi-hole FTL stopped answering; restarted it',
    'network': 'Home network link down; restarted networking',
    'tailscale': 'Tailscale disconnected while the Internet works; restarted tailscaled',
    'reboot': 'Home network link still down after a network restart; rebooting',
}


def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as handle:
            value = json.load(handle)
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError):
        return default


def write_state(state):
    temporary = STATE_FILE + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        json.dump(state, handle)
    os.replace(temporary, STATE_FILE)


def record(texts, now):
    try:
        with open(EVENTS_FILE, encoding='utf-8') as handle:
            lines = handle.readlines()
    except OSError:
        lines = []
    lines += [json.dumps({'at': int(now), 'event': text}) + '\n' for text in texts]
    temporary = EVENTS_FILE + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        handle.writelines(lines[-MAX_EVENTS:])
    os.replace(temporary, EVENTS_FILE)


def deliver(state):
    """Sends pending events once the Pi can reach its notifier; kept until delivered."""
    pending = state.get('pending') or []
    if not pending or not os.access(NOTIFY, os.X_OK):
        state['pending'] = []
        return
    result = run(NOTIFY, '-p', 'default', '-t', 'LEÓN Home: self-repair', '\n'.join(pending[-10:]))
    if result is not None and result.returncode == 0:
        state['pending'] = []


def main():
    now = time.time()
    with open('/proc/uptime', encoding='ascii') as handle:
        uptime = float(handle.read().split()[0])
    state = read_json(STATE_FILE, {})
    seen = observe(state)
    state, actions, events = decide(state, seen, now, uptime)
    if seen['gateway']:
        state['gateway'] = seen['gateway']
    texts = events + [DESCRIPTIONS[action] for action in actions]
    for text in texts:
        print(text, flush=True)
    if texts:
        record(texts, now)
        state['pending'] = (state.get('pending') or []) + texts
    # Persist before acting so a reboot or a killed run keeps its cooldowns.
    write_state(state)
    for action in actions:
        repair(action)
    if seen['internet']:
        deliver(state)
        write_state(state)


if __name__ == '__main__':
    main()
