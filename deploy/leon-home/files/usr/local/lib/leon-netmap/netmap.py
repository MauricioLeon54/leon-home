#!/usr/bin/env python3
"""LEÓN Home network inventory: one bounded discovery pass, run by leon-netmap.timer.

Sends one ICMP echo to every address of eth0's IPv4 subnet (/22 or smaller), then reads the
kernel neighbour table, so devices that ignore ping but answer ARP still count. Writes the state
LEÓN's collector reads (same shape as the tablet's netmap /api/state). Sends no packet beyond
ping and ARP. Silence is "not seen this pass", never proof that a device is off.

Two Python sweeps share this contract, chosen with NETMAP_PROBE (provision.sh netmap-engine):
`ping` (default, the original: one `ping` child per address, 32 at a time) and `icmp` (one
unprivileged Linux ICMP datagram socket, net.ipv4.ping_group_range, at most 32 outstanding
requests and the 1 s reply wait of `ping -W 1`). The Rust engine in rust/leon-netmap implements
the same contract; see docs/NETMAP-ENGINE.md.
"""

import errno
import fcntl
import ipaddress
import json
import os
import re
import socket
import struct
import subprocess
import time

STATE = os.path.join(os.environ.get('STATE_DIRECTORY', '/var/lib/leon-netmap'), 'state.json')
INTERFACE = os.environ.get('NETMAP_INTERFACE', 'eth0')
PROBE = os.environ.get('NETMAP_PROBE', 'ping')
PRESENCE = 48  # 4 hours of 5-minute passes
FORGET_SECONDS = 30 * 86400
MAX_DEVICES = 256
MAX_STATE_BYTES = 1_048_576  # the collector refuses larger inventories
CONCURRENCY = 32
REPLY_TIMEOUT = 1.0  # seconds per address, as `ping -W 1`
SWEEP_DEADLINE = 60.0  # whole sweep; the unit allows 90 s
ECHO_REQUEST, ECHO_REPLY = 8, 0
NEIGHBOUR_STATES = ('REACHABLE', 'DELAY', 'PROBE', 'STALE', 'PERMANENT')
PRESENT_STATES = ('REACHABLE', 'DELAY', 'PROBE')


def run(arguments, timeout):
    try:
        return subprocess.run(
            arguments, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def subnet():
    result = run(['ip', '-4', '-o', 'addr', 'show', 'dev', INTERFACE], 3)
    match = re.search(r'inet (\S+)', result.stdout if result else '')
    if not match:
        raise SystemExit('No IPv4 address on ' + INTERFACE)
    interface = ipaddress.IPv4Interface(match.group(1))
    if not interface.network.is_private or interface.network.prefixlen < 22:
        raise SystemExit('Refusing to sweep ' + str(interface.network))
    return interface


def ping(ip):
    result = run(['ping', '-n', '-c', '1', '-W', '1', ip], 3)
    match = re.search(
        r'time=([\d.]+) ms', result.stdout if result and result.returncode == 0 else ''
    )
    return ip, float(match.group(1)) if match else None


def sweep_ping(targets):
    """Legacy sweep: one `ping` child per address, 32 at a time."""
    import concurrent.futures  # ponytail: only this mode needs threads (~45 ms import on the Pi)

    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        return dict(pool.map(ping, targets))


class IcmpSocket:
    """Linux ICMP datagram socket: the kernel sets the identifier and checksum and delivers only
    echo replies carrying this socket's identifier, without the IP header."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)

    def send(self, ip, sequence, payload):
        self.sock.sendto(struct.pack('!BBHHH', ECHO_REQUEST, 0, 0, 0, sequence) + payload, (ip, 0))

    def identifier(self):
        return self.sock.getsockname()[1]

    def receive(self, timeout):
        self.sock.settimeout(timeout)
        try:
            data, address = self.sock.recvfrom(512)
        except (socket.timeout, InterruptedError):
            return None
        return address[0], data

    def close(self):
        self.sock.close()


def echo_reply(data, sequence, payload, identifier):
    """True only for a well-formed echo reply to this pass's request `sequence`."""
    if len(data) < 8 + len(payload):
        return False
    kind, code, _, ident, seq = struct.unpack('!BBHHH', data[:8])
    return (
        kind == ECHO_REPLY
        and code == 0
        and seq == sequence
        and (identifier is None or ident == identifier)
        and data[8 : 8 + len(payload)] == payload
    )


def sweep_icmp(
    targets, transport, timeout=REPLY_TIMEOUT, window=CONCURRENCY, deadline=SWEEP_DEADLINE
):
    """One echo per target with at most `window` outstanding; returns {ip: rtt_ms or None}.

    Late, duplicate, foreign and malformed packets are ignored. Sequence numbers are target
    indexes (a /22 has 1022 hosts) and the payload is a random per-pass token, so a reply to an
    earlier pass or another address cannot mark a device present. Raises PermissionError when
    the socket may not send at all, and OSError when no request could be sent."""
    payload = os.urandom(16)
    rtts = dict.fromkeys(targets)
    pending = {}
    queue = list(enumerate(targets))[::-1]
    identifier = None
    budget = 4 * len(targets) + 64  # packets read; bounds a flood of foreign replies
    stop = time.monotonic() + deadline
    sent = 0
    while True:
        # Expire before refilling, so a slot freed by a timeout is reused at once rather than
        # idling until the next wake-up when requests went out in staggered groups.
        now = time.monotonic()
        for ip, (_, started) in list(pending.items()):
            if now - started >= timeout:
                del pending[ip]
        while queue and len(pending) < window:
            if time.monotonic() >= stop:
                raise TimeoutError('Inventory deadline exceeded')
            sequence, ip = queue.pop()
            try:
                transport.send(ip, sequence, payload)
            except OSError as error:
                if error.errno in (errno.EPERM, errno.EACCES):
                    raise PermissionError(error.errno, 'ICMP echo not permitted') from error
                continue  # unreachable now: not seen this pass
            pending[ip] = (sequence, time.monotonic())
            sent += 1
            if identifier is None:
                identifier = transport.identifier()
        now = time.monotonic()
        if not pending and not queue:
            break
        if now >= stop:
            raise TimeoutError('Inventory deadline exceeded')
        if budget <= 0:
            raise OSError('ICMP receive budget exhausted')
        if not pending:
            continue
        wait = min(started for _, started in pending.values()) + timeout - now
        try:
            reply = transport.receive(min(max(wait, 0.001), stop - now))
        except OSError:  # not a reply; the budget bounds a socket that keeps failing
            budget -= 1
            continue
        if reply is None:
            continue
        budget -= 1
        ip, data = reply
        expected = pending.get(ip)
        if expected and echo_reply(data, expected[0], payload, identifier):
            rtts[ip] = round((time.monotonic() - expected[1]) * 1000, 3)
            del pending[ip]
    if targets and not sent:
        raise OSError('No ICMP echo could be sent')
    return rtts


def neighbours():
    result = run(['ip', '-4', 'neigh', 'show', 'dev', INTERFACE], 3)
    found = {}
    for line in (result.stdout if result else '').splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1] == 'lladdr' and parts[-1] in NEIGHBOUR_STATES:
            found[parts[0]] = (parts[2].lower(), parts[-1])
    return found


def gateway():
    result = run(['ip', '-4', 'route', 'show', 'default', 'dev', INTERFACE], 3)
    match = re.search(r'default via (\S+)', result.stdout if result else '')
    return match.group(1) if match else None


def clean(item):
    """A stored device, or None when its address is unusable. Damaged fields get defaults so one
    bad entry cannot stop the pass."""
    if not isinstance(item, dict) or not isinstance(item.get('ip'), str):
        return None
    try:
        ipaddress.IPv4Address(item['ip'])
    except ValueError:
        return None
    for key in ('first_seen', 'last_seen'):
        if type(item.get(key)) is not int:
            item[key] = 0
    strip = item.get('strip')
    item['strip'] = (
        [v for v in strip if type(v) is int and v in (0, 1)] if isinstance(strip, list) else []
    )
    if not isinstance(item.get('mac', ''), str):
        del item['mac']
    if not isinstance(item.get('role', ''), str):
        item['role'] = ''
    if 'rtt_ms' in item and type(item['rtt_ms']) not in (int, float):
        item['rtt_ms'] = None
    return item


def load():
    try:
        with open(STATE, 'rb') as handle:
            raw = handle.read(MAX_STATE_BYTES + 1)
        state = json.loads(raw) if len(raw) <= MAX_STATE_BYTES else {}
        items = state.get('devices', []) if isinstance(state, dict) else []
        devices = (clean(item) for item in (items if isinstance(items, list) else []))
        return {item['ip']: item for item in devices if item is not None}
    except (OSError, ValueError):
        return {}


def merge(devices, rtts, arp, router, now):
    """Fold one pass into the stored devices; returns them sorted by address, forgotten ones
    dropped. Presence strips keep the last PRESENCE passes; rtt_ms is kept while unseen."""
    for ip in set(devices) | {ip for ip, rtt in rtts.items() if rtt is not None} | set(arp):
        seen = rtts.get(ip) is not None or arp.get(ip, (None, ''))[1] in PRESENT_STATES
        item = devices.get(ip, {'ip': ip, 'first_seen': now, 'last_seen': 0, 'strip': []})
        if arp.get(ip):
            item['mac'] = arp[ip][0]
        item['online'] = 1 if seen else 0
        item['strip'] = (item.get('strip', []) + [1 if seen else 0])[-PRESENCE:]
        if seen:
            item['last_seen'] = now
            item['rtt_ms'] = rtts.get(ip)
        item['role'] = 'router' if ip == router else item.get('role', '')
        devices[ip] = item
    kept = [item for item in devices.values() if now - item.get('last_seen', 0) <= FORGET_SECONDS]
    kept.sort(key=lambda item: ipaddress.IPv4Address(item['ip']))
    return kept


def inventory(kept, now, duration_ms, network):
    return {
        'devices': kept[:MAX_DEVICES],
        'lastScan': {
            'ts': now,
            'durationMs': duration_ms,
            'subnet': str(network),
            'online': sum(item['online'] for item in kept),
        },
    }


class StateDurabilityError(OSError):
    """The new state is visible, but syncing its directory failed after replacement."""


def write_state(state):
    """Replace STATE atomically; pre-rename failures keep the previous file."""
    data = json.dumps(state).encode()
    if len(data) > MAX_STATE_BYTES:
        raise SystemExit('Inventory exceeds the collector limit; state kept')
    temporary = STATE + '.tmp'
    try:
        with open(temporary, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, STATE)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    try:
        folder = os.open(os.path.dirname(STATE) or '.', os.O_RDONLY)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
    except OSError as error:
        raise StateDurabilityError('State replaced but directory sync failed') from error


def exclusive_pass():
    """Held for the whole pass: a manual run cannot overlap the timer's."""
    try:
        handle = open(os.path.join(os.path.dirname(STATE) or '.', '.netmap.lock'), 'a')
    except OSError as error:
        raise SystemExit(f'Inventory lock unavailable ({type(error).__name__})') from None
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise SystemExit('Another inventory pass is running') from None
    return handle


def sweep(targets):
    if PROBE == 'ping':
        return sweep_ping(targets)
    if PROBE != 'icmp':
        raise SystemExit('NETMAP_PROBE must be icmp or ping')
    transport = IcmpSocket()
    try:
        return sweep_icmp(targets, transport)
    finally:
        transport.close()


def main():
    lock = exclusive_pass()
    try:
        interface = subnet()
        own = str(interface.ip)
        targets = [str(host) for host in interface.network.hosts() if str(host) != own]
        started = time.time()
        try:
            rtts = sweep(targets)
        except OSError as error:
            raise SystemExit(f'ICMP sweep failed ({type(error).__name__}); state kept') from None
        arp = neighbours()
        router = gateway()
        now = int(time.time())
        kept = merge(load(), rtts, arp, router, now)
        duration_ms = int((time.time() - started) * 1000)
        try:
            write_state(inventory(kept, now, duration_ms, interface.network))
        except StateDurabilityError:
            raise SystemExit(
                'State replaced but directory sync failed; durability unknown'
            ) from None
        except OSError as error:
            raise SystemExit(f'State write failed ({type(error).__name__}); state kept') from None
    finally:
        lock.close()


if __name__ == '__main__':
    main()
