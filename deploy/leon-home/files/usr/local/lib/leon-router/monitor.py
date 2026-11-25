#!/usr/bin/env python3
"""Private router session: owner unlock over a local Unix socket, sanitized telemetry, and a
closed per-port Ethernet enable/disable operation guarded by an owner allowlist."""

import fcntl
import ipaddress
import json
import os
import pwd
import re
import select
import socket
import struct
import subprocess
import sys
import termios
import time
import urllib.error
from collections import deque
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from router_read_probe import ProbeError, Router

try:
    import modem_read_probe  # optional: only where the vault also has the ISP modem
except ImportError:
    modem_read_probe = None

STATE = Path('/var/lib/leon-router/telemetry.json')
MODEM_SHAPE = Path('/var/lib/leon-router/modem-shape.json')
MODEM_LINE = Path('/var/lib/leon-router/modem.json')
MODEM_HISTORY = 120  # a month of readings every six hours
# After a refusal the modem is left alone, across restarts, until the owner unlocks from the phone.
MODEM_REFUSED = Path('/var/lib/leon-router/modem-refused')
# Ciphertext copy of the owner's age vault (owner choice 2026-11-16); decrypted only in memory.
# The unit may move it; the independent edition keeps it in the monitor's own state directory.
VAULT = Path(os.environ.get('ROUTER_VAULT', '/etc/leon-router/network-devices.age'))
# '1' lets the phone create the vault once (router password + new phrase); never replaces one.
PHONE_SETUP = os.environ.get('ROUTER_PHONE_SETUP') == '1'
MIN_SETUP_PHRASE_BYTES = 12
# Owner opt-in 2026-11-25 (`provision.sh router-auto-unlock on`): while this key exists, the device
# entries of the last phone unlock are kept encrypted to it, never the vault phrase.
AUTO_KEY = Path('/etc/leon-router/auto-unlock.key')
AUTO_ENTRIES = Path('/var/lib/leon-router/auto-unlock.age')
AUTO_RETRY_SECONDS = (60, 900)  # first and longest wait after a failure that tested no password
MODEM_INTERVAL_SECONDS = 6 * 3600
AGE = '/usr/bin/age'
VAULT_TIMEOUT_SECONDS = 30  # scrypt (log2 N = 18) takes a few seconds on a Pi 4; bounds a stuck age
UNLOCK_SOCKET = '/run/leon-router/unlock.sock'
CONTROL_SOCKET = '/run/leon-router/control.sock'
CONTROLLABLE_PORTS = Path('/etc/leon-router/controllable-ports')
# Owner list of MACs that may never be paused (e.g. their own phone and Mac). Unreadable: refuse all.
PROTECTED_DEVICES = Path('/etc/leon-router/protected-devices')
MAX_BLOCKED = 32  # the vendor UI's MacFilterCapacity default
# Weekly pause windows set from the phone (overview state). Times are the Pi's local time.
SCHEDULES = Path('/var/lib/leon-overview/pause-schedules.json')
MAX_SCHEDULES = 64
POLL_SECONDS = 15
HISTORY_SAMPLES = 80  # 20 minutes at POLL_SECONDS
DEVICE_HISTORY_SAMPLES = 40  # 10 minutes per device keeps the state file small
MAX_PORTS = 8
VERIFY_DELAY_SECONDS = 3  # the vendor UI re-reads ethsetting after 3 s
ACTION_INTERVAL_SECONDS = 5
WRITE_TIMEOUT_SECONDS = 20  # applying ethsetting re-initialises the switch and can outlast a read
WEB_UNLOCK_INTERVAL_SECONDS = 60  # one phone attempt per minute; a wrong password is never retried
MAX_POLL_FAILURES = 3  # consecutive failed reads (45 s) before the session is treated as ended
FAILURES = (OSError, ValueError, TypeError, KeyError, ProbeError, urllib.error.URLError)


def uid_of(name):
    try:
        return pwd.getpwnam(name).pw_uid
    except KeyError:
        return None


OVERVIEW_UID = uid_of('leon-overview')
# Local account allowed to send a router entry directly; an empty name (independent edition) means
# root only. The default keeps the original single-home deployment unchanged.
OWNER_UID = uid_of(os.environ.get('ROUTER_OWNER_USER', 'leon'))


class PortRouter(Router):
    """The vendor port-settings page reads these routes and saves ethsetting as a whole."""

    READS = Router.READS | {
        '/api/ntwk/ethsetting',
        '/api/ntwk/ethnegotiation',
        '/api/app/ethportmode',
        '/api/ntwk/wlanfilterenhance',
        '/api/ntwk/wlanradio',
        # notshowpassall: the vendor page's own flag to omit Wi-Fi passwords
        '/api/ntwk/WlanGuideBasic?type=notshowpassall',
        '/api/ntwk/guest_network?type=notshowpassall',
    }
    WRITES = Router.WRITES | {'/api/ntwk/ethsetting', '/api/ntwk/wlanfilterenhance'}


WIFI_BANDS = ('2.4GHz', '5GHz', '5GHz_1', '5GHz_2', 'DC', 'wifi7-mld')


def signal_dbm(value):
    """staRssi as the vendor page shows it ("<n>dBm"; "0" means none); int or numeric string."""
    if isinstance(value, str) and re.fullmatch(r'-?\d{1,3}', value.strip()):
        value = int(value)
    return value if type(value) is int and -100 <= value < 0 else None


def printable(value, limit=32):
    return ''.join(c for c in value[:limit] if c.isprintable()) if isinstance(value, str) else None


def scalars(value, pattern):
    """Only bool/int fields whose names match: no strings, so no keys or passwords can pass."""
    return (
        {
            key: item
            for key, item in value.items()
            if isinstance(key, str) and re.fullmatch(pattern, key) and type(item) in (bool, int)
        }
        if isinstance(value, dict)
        else {}
    )


def normalize_wifi(basic, radio, guest):
    """Allowlisted Wi-Fi facts. Live shapes (2026-11-16): WlanGuideBasic is {WifiConfig: [band…]};
    guest_network is one entry per band with EnableFrequency and RestTime as a string."""
    bands = basic.get('WifiConfig') if isinstance(basic, dict) else basic
    guests = [
        row for row in (guest if isinstance(guest, list) else [])[:4] if isinstance(row, dict)
    ]
    rest = [
        int(row['RestTime'])
        for row in guests
        if isinstance(row.get('RestTime'), str) and row['RestTime'].isdigit()
    ]
    return {
        'networks': [
            {
                'ssid': printable(band.get('WifiSsid')),
                'band': printable(band.get('FrequencyBand'), 16),
                **scalars(band, r'WifiEnable|Channel'),
            }  # Channel 0 = automatic
            for band in (bands if isinstance(bands, list) else [])[:4]
            if isinstance(band, dict)
        ],
        'radios': scalars(radio, r'Enable(2G|5G)'),
        'guest': {
            'ssid': next(
                (printable(row.get('WifiSsid')) for row in guests if row.get('WifiSsid')), None
            ),
            'enabled': any(row.get('EnableFrequency') is True for row in guests),
            # WifiAccessNum / X_AssociateDeviceNum are configured limits (64, 128), not live counts.
            'restSeconds': max(rest) if rest else None,
        }
        if guests
        else None,
    }


def ethernet_port(value):
    """LAN port number from HostInfo Layer2Interface (for example LAN4 or ...Config.4); None otherwise."""
    match = re.fullmatch(r'[A-Za-z_. ]{0,64}?(\d{1,2})', value) if isinstance(value, str) else None
    number = int(match.group(1)) if match else None
    return number if number is not None and 1 <= number <= MAX_PORTS else None


def normalize(rows):
    if not isinstance(rows, list):
        raise ProbeError('invalidInventory')
    result = []
    for row in rows[:256]:
        if not isinstance(row, dict):
            continue
        try:
            address = str(ipaddress.IPv4Address(row.get('IPAddress')))
        except (ValueError, TypeError):
            continue

        def rate(key):
            value = row.get(key)
            # Match the inspected vendor UI: raw * 8 Kbps, / 1024 for its Mbps label.
            return value * 8 / 1024 if type(value) is int and 0 <= value <= 12800000 else None

        interface = row.get('InterfaceType')
        # ActualName is the name set in the vendor app; HostName is the device's own DHCP name.
        name = ' '.join((printable(row.get('ActualName'), 40) or '').split()) or ' '.join(
            (printable(row.get('HostName'), 40) or '').split()
        )
        connection = (
            'ethernet' if interface == 'LAN' else 'wifi' if interface in WIFI_BANDS else 'other'
        )
        result.append(
            {
                'address': address,
                'name': name or None,
                'active': row.get('Active46') is True,
                'connection': connection,
                'port': ethernet_port(row.get('Layer2Interface'))
                if connection == 'ethernet'
                else None,
                'downloadRouterMbps': rate('DownRate'),
                'uploadRouterMbps': rate('UpRate'),
                'band': interface if interface in WIFI_BANDS else None,
                'signalDbm': signal_dbm(row.get('staRssi')) if connection == 'wifi' else None,
            }
        )
    return result


def port_number(value, index):
    match = re.fullmatch(r'\D{0,8}(\d{1,2})', str(value)) if isinstance(value, (str, int)) else None
    number = int(match.group(1)) if match else index + 1
    return number if 1 <= number <= MAX_PORTS else None


def whole_number(value):
    """The vendor UI compares PortName/Speed loosely, so the firmware may send ints or digit strings."""
    if type(value) is int:
        return value
    return int(value) if isinstance(value, str) and value.isdigit() and len(value) <= 6 else None


def normalize_ports(setting, negotiation, mode):
    """Administrative state comes from ethsetting; negotiated speed from ethnegotiation."""
    entries = setting.get('ethInfoList') if isinstance(setting, dict) else None
    if not isinstance(entries, list):
        raise ProbeError('invalidPorts')
    links = {}
    rows = negotiation.get('ethintflist') if isinstance(negotiation, dict) else None
    for row in (rows if isinstance(rows, list) else [])[:MAX_PORTS]:
        number = whole_number(row.get('PortName')) if isinstance(row, dict) else None
        if number is not None:
            links[number] = row
    wan = None
    if isinstance(mode, dict) and mode.get('Mode') == 'fixed' and type(mode.get('WanIndex')) is int:
        wan = mode['WanIndex']
    ports = []
    for index, entry in enumerate(entries[:MAX_PORTS]):
        number = port_number(entry.get('Port'), index) if isinstance(entry, dict) else None
        if number is None or any(port['port'] == number for port in ports):
            continue
        status = entry.get('Status')
        link = 'up' if status == 'Up' else 'down' if isinstance(status, str) else 'unknown'
        speed = whole_number((links.get(number) or {}).get('Speed'))
        duplex = entry.get('Duplex')
        ports.append(
            {
                'port': number,
                'enabled': entry['Enable']
                if type(entry.get('Enable')) is bool
                else entry['Enable'] == 1
                if type(entry.get('Enable')) is int
                else None,
                'link': link,
                'speedMbps': speed
                if link == 'up' and speed is not None and 0 < speed <= 100000
                else None,
                'duplex': duplex.lower() if duplex in ('Full', 'Half') else None,
                'wan': None if wan is None else number == wan,
            }
        )
    return ports


MAC_TEXT = re.compile(r'[0-9a-f]{2}(:[0-9a-f]{2}){5}')
MAX_FILTERED = 64


def shape(value, depth=0):
    """Field names and types only, for one-time format logging; never values, MACs or names."""
    if depth > 3:
        return '…'
    if isinstance(value, dict):
        return (
            '{'
            + ','.join(
                f'{key}:{shape(item, depth + 1)}' for key, item in sorted(value.items())[:32]
            )
            + '}'
        )
    if isinstance(value, list):
        return f'[{len(value)}x' + (shape(value[0], depth + 1) if value else '') + ']'
    return type(value).__name__


def normalize_filter(value):
    """Wi-Fi MAC filter as the vendor device page reads it: one entry per band with
    MACAddressControlEnabled, MacFilterPolicy (0 blocklist, 1 allowlist) and BMACAddresses."""
    bands = value if isinstance(value, list) else None
    if not bands or not all(isinstance(band, dict) for band in bands[:4]):
        raise ProbeError('invalidFilter')

    def flag(band):
        raw = band.get('MACAddressControlEnabled')
        return raw if type(raw) is bool else raw == 1 if type(raw) is int else None

    enabled = {flag(band) for band in bands[:4]}
    policies = {band.get('MacFilterPolicy') for band in bands[:4]}
    blocked = set()
    for band in bands[:4]:
        for entry in (
            band.get('BMACAddresses') if isinstance(band.get('BMACAddresses'), list) else []
        )[:MAX_FILTERED]:
            mac = str(entry.get('MACAddress', '')).lower() if isinstance(entry, dict) else ''
            if MAC_TEXT.fullmatch(mac):
                blocked.add(mac)
    policy = policies.pop() if len(policies) == 1 else None
    return {
        'enabled': enabled.pop() if len(enabled) == 1 else None,
        'policy': {0: 'block', 1: 'allow'}.get(policy) if type(policy) is int else None,
        'blockedMacs': sorted(blocked)[:MAX_FILTERED],
    }


def controllable_ports():
    """Owner allowlist of ports that may be disabled. Missing or invalid means none."""
    try:
        # UTF-8: the provisioned comment says LEÓN; ports themselves are validated as ASCII digits.
        with open(CONTROLLABLE_PORTS, encoding='utf-8') as handle:
            raw = handle.read(257)
    except (OSError, UnicodeDecodeError):
        return frozenset()
    if len(raw) > 256:
        return frozenset()
    words = re.sub(r'#.*', '', raw).split()
    if not all(word.isdigit() and 1 <= int(word) <= MAX_PORTS for word in words):
        return frozenset()
    return frozenset(int(word) for word in words)


def rounded(value):
    return None if value is None else round(value, 2)


class History:
    """Bounded in-memory history; lost on restart, which the client shows as a gap."""

    def __init__(self):
        self.totals = deque(maxlen=HISTORY_SAMPLES)
        self.devices = {}

    def record(self, observed_at, rows):
        active = [row for row in rows if row['active']]

        def total(key):
            values = [row[key] for row in active if row[key] is not None]
            return rounded(sum(values)) if values else None

        self.totals.append(
            [round(observed_at), total('downloadRouterMbps'), total('uploadRouterMbps')]
        )
        current = {row['address']: row for row in active}
        for address in current.keys() - self.devices.keys():
            if len(self.devices) < 256:
                self.devices[address] = deque(maxlen=DEVICE_HISTORY_SAMPLES)
        for address, samples in list(self.devices.items()):
            row = current.get(address)
            samples.append(
                [rounded(row['downloadRouterMbps']), rounded(row['uploadRouterMbps'])]
                if row
                else [None, None]
            )
            if all(sample == [None, None] for sample in samples):
                del self.devices[address]

    def attach(self, rows):
        for row in rows:
            row['history'] = list(self.devices.get(row['address'], ()))
        return {'intervalSeconds': POLL_SECONDS, 'samples': list(self.totals)}


def read_state(router, history):
    raw_hosts = router.request('/api/system/HostInfo')
    if not getattr(router, 'hosts_shape_logged', False) and isinstance(raw_hosts, list):
        fields = sorted(
            {str(key)[:40] for row in raw_hosts[:256] if isinstance(row, dict) for key in row}
        )
        print(f'HostInfo fields {",".join(fields[:96])}', file=sys.stderr, flush=True)  # names only
        # Interface labels of wired rows (such as LAN4) carry no device identity.
        wired = sorted(
            {
                printable(row.get('Layer2Interface'), 64) or '-'
                for row in raw_hosts[:256]
                if isinstance(row, dict) and row.get('InterfaceType') == 'LAN'
            }
        )
        print(f'HostInfo wired interfaces {",".join(wired[:16])}', file=sys.stderr, flush=True)
        router.hosts_shape_logged = True
    rows = normalize(raw_hosts)
    observed_at = time.time()
    try:
        ports = normalize_ports(
            router.request('/api/ntwk/ethsetting'),
            router.request('/api/ntwk/ethnegotiation'),
            router.request('/api/app/ethportmode'),
        )
    except FAILURES:
        ports = None  # device traffic remains useful when this firmware lacks port routes
    try:
        raw_wifi = [
            router.request(path)
            for path in (
                '/api/ntwk/WlanGuideBasic?type=notshowpassall',
                '/api/ntwk/wlanradio',
                '/api/ntwk/guest_network?type=notshowpassall',
            )
        ]
        if not getattr(router, 'wifi_shape_logged', False):
            print(
                'wifi shapes ' + ' | '.join(shape(value) for value in raw_wifi),
                file=sys.stderr,
                flush=True,
            )
            router.wifi_shape_logged = True
        wifi = normalize_wifi(*raw_wifi)
    except FAILURES:
        wifi = None
    try:
        raw_filter = router.request('/api/ntwk/wlanfilterenhance')
        if not getattr(router, 'filter_shape_logged', False):
            print(f'wlanfilterenhance shape {shape(raw_filter)}', file=sys.stderr, flush=True)
            router.filter_shape_logged = True
        wifi_filter = normalize_filter(raw_filter)
    except FAILURES:
        wifi_filter = None
    history.record(observed_at, rows)
    return {
        'status': 'current',
        'observedAt': observed_at,
        'devices': rows,
        'history': history.attach(rows),
        'ports': ports,
        'wifiFilter': wifi_filter,
        'wifi': wifi,
        'controllablePorts': sorted(controllable_ports()),
    }


def save(state):
    raw = json.dumps({'schemaVersion': 1, **state}, allow_nan=False).encode()
    if len(raw) > 262144:
        raise ProbeError('stateTooLarge')
    temporary = STATE.with_suffix('.new')
    with open(temporary, 'wb') as handle:
        os.fchmod(handle.fileno(), 0o640)
        handle.write(raw)
    temporary.replace(STATE)


def peer_uid(connection):
    _, uid, _ = struct.unpack(
        '3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    return uid


def read_request(connection, limit):
    connection.settimeout(5)
    chunks = bytearray()
    while len(chunks) <= limit:
        chunk = connection.recv(min(4096, limit + 1 - len(chunks)))
        if not chunk:
            break
        chunks.extend(chunk)
    if len(chunks) > limit:
        raise ProbeError('inputTooLarge')
    return json.loads(chunks)


def run_age(arguments, phrase, prompts, data=b'', timeout=VAULT_TIMEOUT_SECONDS):
    """Run the age binary, not custom crypto. age reads passphrases only from a terminal, so it gets
    a private pseudo-terminal; data and output use pipes and stay in memory. The phrase is typed
    once per passphrase prompt (decrypt asks once, encrypt asks again to confirm)."""
    deadline = time.monotonic() + timeout
    master, slave = os.openpty()
    process = None

    def own_terminal():  # the monitor is single-threaded, so preexec_fn is safe here
        os.setsid()
        fcntl.ioctl(2, termios.TIOCSCTTY, 0)

    try:
        process = subprocess.Popen(
            [AGE, *arguments],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=slave,
            preexec_fn=own_terminal,
            close_fds=True,
        )
        os.close(slave)
        slave = None
        process.stdin.write(data)  # small and bounded: it fits the pipe buffer
        process.stdin.close()
        shown, typed = b'', 0
        # age prints a prompt and then turns echo off to read; its terminal output is drained
        # throughout, or age blocks writing to it.
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise ProbeError('vaultTimeout')
            if select.select([master], [], [], 0.05)[0]:
                try:
                    shown = (shown + os.read(master, 1024))[-4096:]
                except OSError:
                    pass  # the child closed its terminal
            if (
                typed < prompts
                and shown.lower().count(b'passphrase') > typed
                and not termios.tcgetattr(master)[3] & termios.ECHO
            ):
                os.write(master, phrase.encode() + b'\r')
                typed += 1
        raw = process.stdout.read(32769)
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
        os.close(master)
        if slave is not None:
            os.close(slave)
    if process.returncode != 0 or len(raw) > 32768:
        raise ProbeError('vaultRejected')
    return raw


def decrypt_vault(phrase, path=VAULT):
    if not os.path.isfile(path):
        raise ProbeError('notConfigured')
    raw = run_age(['--decrypt', str(path)], phrase, 1)
    if not raw:
        raise ProbeError('vaultRejected')
    return json.loads(raw)


def encrypt_vault(phrase, document, path=VAULT):
    """Write a new vault once with a passphrase recipient; an existing vault is never replaced."""
    path = Path(path)
    temporary = path.with_name(path.name + '.new')
    temporary.unlink(missing_ok=True)
    try:
        run_age(
            ['--encrypt', '--passphrase', '--output', str(temporary)],
            phrase,
            2,
            json.dumps(document).encode(),
        )
        os.chmod(temporary, 0o600)
        os.link(temporary, path)  # fails if a vault appeared meanwhile
    finally:
        temporary.unlink(missing_ok=True)


def default_gateway(route_table='/proc/net/route'):
    """The IPv4 default gateway; Router() then refuses anything outside private ranges."""
    with open(route_table, encoding='ascii') as handle:
        for line in handle.read(16384).splitlines()[1:64]:
            fields = line.split()
            if len(fields) >= 4 and fields[1] == '00000000' and int(fields[3], 16) & 2:
                return str(ipaddress.IPv4Address(struct.pack('<I', int(fields[2], 16))))
    raise ProbeError('noGateway')


def connect_router(password, phrase):
    """Phone setup: log in to the default gateway first, then keep that entry in a new vault."""
    if not PHONE_SETUP:
        raise ProbeError('setupUnavailable')
    if os.path.exists(VAULT):
        raise ProbeError('alreadyConfigured')
    device = {'origin': 'http://' + default_gateway(), 'username': '', 'password': password}
    router = PortRouter(device['origin'])
    router.login('admin', password)
    encrypt_vault(phrase, {'schemaVersion': 1, 'devices': {'router': device}})
    return router


def receive(connection, uid):
    """Owner/root send the router entry over SSH. The overview (phone unlock) may send only the
    vault phrase; the router entry then comes from the Pi's ciphertext copy of the vault. With
    phone setup enabled it may instead send the router password and a new phrase once."""
    modem = None
    if uid is not None and uid in (0, OWNER_UID):
        device = read_request(connection, 32768)
    elif uid is not None and uid == OVERVIEW_UID:
        request = read_request(connection, 4096)
        if (
            not isinstance(request, dict)
            or set(request) not in ({'phrase'}, {'phrase', 'password'})
            or not all(isinstance(value, str) for value in request.values())
            or not 1 <= len(request['phrase'].encode()) <= 1024
            or any(c in value for value in request.values() for c in '\r\n\x00')
        ):
            raise ProbeError('invalidCredentials')
        if 'password' in request:
            if (
                len(request['phrase'].encode()) < MIN_SETUP_PHRASE_BYTES
                or not 1 <= len(request['password'].encode()) <= 1024
            ):
                raise ProbeError('invalidCredentials')
            return connect_router(request['password'], request['phrase'])
        document = decrypt_vault(request['phrase'])
        devices = document.get('devices') if isinstance(document, dict) else None
        device = devices.get('router') if isinstance(devices, dict) else None
        modem = devices.get('modem') if isinstance(devices, dict) else None
    else:
        raise ProbeError('unauthorizedOwner')
    router = open_session(device)
    if uid == OVERVIEW_UID:
        router.entries = {'router': device, 'modem': modem}  # main() takes them once
    return router


def open_session(device):
    if (
        not isinstance(device, dict)
        or set(device) != {'origin', 'username', 'password'}
        or not all(isinstance(value, str) for value in device.values())
        or len(device['username'].encode()) > 128
        or not 1 <= len(device['password'].encode()) <= 1024
    ):
        raise ProbeError('invalidCredentials')
    router = PortRouter(device['origin'])
    router.login(device['username'] or 'admin', device['password'])
    return router


def remember(entries):
    """Keep the entries for automatic unlock, only while the owner's key exists."""
    if not AUTO_KEY.is_file():
        return
    temporary = AUTO_ENTRIES.with_suffix('.new')
    try:
        result = subprocess.run(
            [AGE, '--encrypt', '--identity', str(AUTO_KEY)],
            input=json.dumps(entries).encode(),
            capture_output=True,
            timeout=15,
            check=True,
        )
        with open(temporary, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(result.stdout)
        temporary.replace(AUTO_ENTRIES)
        outcome = 'saved'
    except (OSError, subprocess.SubprocessError) as error:
        outcome = type(error).__name__  # never the arguments or output
    print(f'automatic unlock {outcome}', file=sys.stderr, flush=True)


def remembered():
    """The saved entries, or None when automatic unlock is off or nothing was saved yet."""
    if not AUTO_KEY.is_file() or not AUTO_ENTRIES.is_file():
        return None
    try:
        result = subprocess.run(
            [AGE, '--decrypt', '--identity', str(AUTO_KEY), str(AUTO_ENTRIES)],
            capture_output=True,
            timeout=15,
            check=True,
        )
        entries = json.loads(result.stdout[:32769])
        return entries if isinstance(entries, dict) else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


class AutoUnlock:
    """Opens the router session from the saved entries. A rejected password stops it until the next
    phone unlock or restart, so a changed password can never lock the router by repetition."""

    def __init__(self):
        self.next_at = 0
        self.wait = AUTO_RETRY_SECONDS[0]
        self.is_stopped = False

    def reset(self):
        self.__init__()

    def attempt(self, now):
        if self.is_stopped or now < self.next_at:
            return None
        self.next_at = now + self.wait
        entries = remembered()
        if entries is None:
            return None  # off or not saved; looked at again later, no login is made
        try:
            router = open_session(entries.get('router'))
            router.entries = entries
            self.reset()
            outcome = 'opened'
        except ProbeError as error:
            router, outcome = None, str(error)
            if outcome == 'invalidSession':
                self.wait = min(self.wait * 2, AUTO_RETRY_SECONDS[1])  # login page not ready yet
            else:
                self.is_stopped = True  # the password may have been tested: never repeat it
        except FAILURES as error:
            router, outcome = None, type(error).__name__  # unreachable router: try again later
            self.wait = min(self.wait * 2, AUTO_RETRY_SECONDS[1])
        print(f'automatic unlock {outcome}', file=sys.stderr, flush=True)
        return router


def write_json(path, value):
    temporary = path.with_suffix('.new')
    with open(temporary, 'w', encoding='utf-8') as handle:
        os.fchmod(handle.fileno(), 0o640)
        json.dump(value, handle)
    temporary.replace(path)


def read_modem(device, is_owner_present):
    """One modem login with the vault's own entry, right after an owner unlock: never retried and the
    credentials are not kept. Saves only the probe's redacted report."""
    if modem_read_probe is None or not isinstance(device, dict):
        return
    if is_owner_present:
        MODEM_REFUSED.unlink(missing_ok=True)
    elif MODEM_REFUSED.exists():
        return
    try:
        report = modem_read_probe.probe(device['origin'], device['username'], device['password'])
        report['observedAt'] = int(time.time())
        write_json(MODEM_SHAPE, report)
        line = {'at': report['observedAt'], **modem_read_probe.line_summary(report)}
        try:
            history = json.loads(MODEM_LINE.read_text(encoding='utf-8'))['history']
        except (OSError, ValueError, KeyError, TypeError):
            history = []
        history = [*history, [line['at'], line['rxDbm']]] if isinstance(history, list) else []
        write_json(MODEM_LINE, {**line, 'history': history[-MODEM_HISTORY:]})
        outcome = 'read' if report['loggedOut'] else 'read, logout not confirmed'
    except ProbeError as error:
        outcome = str(error)
        MODEM_REFUSED.touch(mode=0o600)
    except FAILURES as error:
        outcome = type(error).__name__
    print(f'modem outcome={outcome}', file=sys.stderr, flush=True)


def parse_action(value):
    """('port', number, enabled) or ('device', mac, blocked); anything else is invalid."""
    if (
        isinstance(value, dict)
        and set(value) == {'port', 'enabled'}
        and type(value['port']) is int
        and 1 <= value['port'] <= MAX_PORTS
        and type(value['enabled']) is bool
    ):
        return 'port', value['port'], value['enabled']
    if (
        isinstance(value, dict)
        and set(value) == {'device', 'blocked'}
        and isinstance(value['device'], str)
        and MAC_TEXT.fullmatch(value['device'])
        and type(value['blocked']) is bool
    ):
        return 'device', value['device'], value['blocked']
    raise ProbeError('invalidAction')


def load_schedules(path=SCHEDULES):
    """MAC -> (weekdays Mon=0, start minute, end minute). Invalid entries are skipped; missing: none."""
    try:
        with open(path, encoding='utf-8') as handle:
            value = json.loads(handle.read(65537))
    except (OSError, ValueError):
        return {}
    schedules = {}
    for mac, entry in value.items() if isinstance(value, dict) else []:
        try:
            days = frozenset(entry['days'])
            start, end = (
                int(entry[key][:2]) * 60 + int(entry[key][3:]) for key in ('start', 'end')
            )
            valid = (
                MAC_TEXT.fullmatch(mac)
                and days
                and all(type(day) is int and 0 <= day <= 6 for day in days)
                and all(
                    re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', entry[key]) for key in ('start', 'end')
                )
                and start != end
            )
        except (TypeError, KeyError, ValueError, AttributeError):
            continue
        if valid and len(schedules) < MAX_SCHEDULES:
            schedules[mac] = (days, start, end)
    return schedules


def inside_window(schedule, weekday, minute):
    """Days name the day a window starts; an end at or before the start runs past midnight."""
    days, start, end = schedule
    if start < end:
        return weekday in days and start <= minute < end
    return (weekday in days and minute >= start) or ((weekday - 1) % 7 in days and minute < end)


def schedule_actions(schedules, last, weekday, minute):
    """Act only on window edges. Returns (new_last, [(mac, blocked)]). A schedule seen for the first
    time is recorded without acting, so starting the monitor or saving a schedule mid-window does not
    override a manual choice; removed schedules are forgotten."""
    current = {mac: inside_window(schedule, weekday, minute) for mac, schedule in schedules.items()}
    actions = [
        (mac, blocked)
        for mac, blocked in sorted(current.items())
        if mac in last and last[mac] != blocked
    ]
    return current, actions


def local_week_minute():
    now = time.localtime()
    return now.tm_wday, now.tm_hour * 60 + now.tm_min


def run_schedules(router, last):
    """Apply window edges with the live session; each edge is attempted once, never retried."""
    last, actions = schedule_actions(load_schedules(), last, *local_week_minute())
    for mac, blocked in actions:
        try:
            outcome = set_block(router, mac, blocked)
        except FAILURES:
            outcome = 'unverified'
        print(
            f'schedule blocked={blocked} outcome={outcome}', file=sys.stderr, flush=True
        )  # no MAC in logs
    return last


def protected_devices():
    """MACs that may never be paused, or None when the file is unreadable or invalid (refuse all)."""
    try:
        with open(PROTECTED_DEVICES, encoding='utf-8') as handle:
            raw = handle.read(8193)
    except FileNotFoundError:
        return frozenset()
    except (OSError, UnicodeDecodeError):
        return None
    words = [word.lower() for word in re.sub(r'#.*', '', raw).split()]
    if len(raw) > 8192 or not all(MAC_TEXT.fullmatch(word) for word in words):
        return None
    return frozenset(words)


def set_block(router, mac, blocked, sleep=time.sleep):
    """Add or remove one MAC on the router's Wi-Fi blocklist the way the vendor device page does, then
    re-read. Never enables the filter or changes its policy. Returns an outcome; never retries."""
    raw = router.request('/api/ntwk/wlanfilterenhance')
    current = normalize_filter(raw)
    if len(raw) != 2 or current['enabled'] is not True or current['policy'] != 'block':
        return 'filterUnavailable'  # only the owner may switch the filter on or change its mode
    if (mac in current['blockedMacs']) == blocked:
        return 'unchanged'
    entries = [entry for entry in raw[0].get('BMACAddresses') or [] if isinstance(entry, dict)]
    if blocked:
        protected = protected_devices()
        if protected is None or mac in protected:
            return 'protectedDevice'
        hosts = router.request('/api/system/HostInfo')
        host = next(
            (
                row
                for row in (hosts if isinstance(hosts, list) else [])[:256]
                if isinstance(row, dict) and str(row.get('MACAddress', '')).lower() == mac
            ),
            None,
        )
        if host is None or not MAC_TEXT.fullmatch(str(host['MACAddress']).lower()):
            return 'unknownDevice'
        if host.get('InterfaceType') == 'LAN':
            return 'wiredDevice'  # a Wi-Fi blocklist cannot pause it; never imply otherwise
        if len(entries) >= MAX_BLOCKED:
            return 'filterFull'
        name = (
            host.get('ActualName')
            or host.get('HostName')
            or str(host['MACAddress']).replace(':', '-')
        )
        # The router's own MAC spelling, as its page compares strings exactly.
        entries = entries + [{'HostName': str(name)[:64], 'MACAddress': host['MACAddress']}]
    else:
        entries = [entry for entry in entries if str(entry.get('MACAddress', '')).lower() != mac]
    allowed = [
        entry
        for entry in raw[0].get('WMACAddresses') or []
        if isinstance(entry, dict) and str(entry.get('MACAddress', '')).lower() != mac
    ]
    # ponytail: both bands get band 0's lists, as the vendor page leaves them identical in practice.
    payload = {}
    for key, band in zip(('config2g', 'config5g'), raw):
        payload[key] = {
            **{
                name: value
                for name, value in band.items()
                if name not in ('BMACAddresses', 'WMACAddresses')
            },
            'BMacFilters': entries,
            'WMacFilters': allowed,
        }
    try:
        router.refresh_csrf()
    except FAILURES:
        return 'rejected'
    result = router.request('/api/ntwk/wlanfilterenhance', payload, timeout=WRITE_TIMEOUT_SECONDS)
    if not isinstance(result, dict) or result.get('errcode', result.get('err')) != 0:
        return 'rejected'
    sleep(VERIFY_DELAY_SECONDS)
    verified = normalize_filter(router.request('/api/ntwk/wlanfilterenhance'))
    return 'applied' if (mac in verified['blockedMacs']) == blocked else 'unverified'


def set_port(router, port, enabled, sleep=time.sleep):
    """One closed operation: change only Enable for one verified port, then re-read it.
    Returns applied, unchanged, unverified or a refusal reason. Never retries."""
    setting = router.request('/api/ntwk/ethsetting')
    ports = normalize_ports(setting, {}, router.request('/api/app/ethportmode'))
    target = next((item for item in ports if item['port'] == port), None)
    if target is None or target['enabled'] is None:
        return 'unknownPort'
    if target['enabled'] == enabled:
        return 'unchanged'
    if not enabled and (port not in controllable_ports() or target['wan'] is True):
        return 'protectedPort'
    # A reply lost to a timeout leaves a rotated token unseen; a stale token makes the router end
    # the session. Nothing has been written yet, so a failure here is a plain refusal.
    try:
        router.refresh_csrf()
    except FAILURES:
        return 'rejected'
    entries = setting['ethInfoList']
    index = next(
        index
        for index, entry in enumerate(entries[:MAX_PORTS])
        if isinstance(entry, dict) and port_number(entry.get('Port'), index) == port
    )
    original = entries[index]['Enable']
    changed = {
        **setting,
        'ethInfoList': [
            {**entry, 'Enable': (enabled if type(original) is bool else int(enabled))}
            if position == index
            else entry
            for position, entry in enumerate(entries)
        ],
    }
    result = router.request('/api/ntwk/ethsetting', changed, timeout=WRITE_TIMEOUT_SECONDS)
    if not isinstance(result, dict) or result.get('errcode', result.get('err')) != 0:
        return 'rejected'
    sleep(VERIFY_DELAY_SECONDS)
    verified = normalize_ports(router.request('/api/ntwk/ethsetting'), {}, {})
    return (
        'applied'
        if any(item['port'] == port and item['enabled'] == enabled for item in verified)
        else 'unverified'
    )


def poll(router, state, history, failures):
    """One scheduled read. Returns (router or None when the session ended, state, failures)."""
    try:
        return router, read_state(router, history), 0
    except FAILURES:
        # One slow or dropped read must not end the session; the overview ages the last
        # reading to stale meanwhile. Reads never resend the password.
        failures += 1
        print(f'router read failed ({failures}/{MAX_POLL_FAILURES})', file=sys.stderr, flush=True)
        if failures >= MAX_POLL_FAILURES:
            return None, {**state, 'status': 'error'}, failures
        return router, state, failures


def listen(path):
    Path(path).unlink(missing_ok=True)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    os.chmod(path, 0o660)  # the unit's group admits the overview; peer UIDs are checked too
    listener.listen(1)
    return listener


def main():
    history = History()
    state = {'status': 'locked', 'observedAt': None, 'devices': []}
    save(state)
    unlock, control = listen(UNLOCK_SOCKET), listen(CONTROL_SOCKET)
    router = None
    next_poll = 0
    poll_failures = 0
    last_web_unlock = -WEB_UNLOCK_INTERVAL_SECONDS
    # Baseline at start, independent of the session: a window that opens while locked is applied on unlock.
    schedule_last = schedule_actions(load_schedules(), {}, *local_week_minute())[0]
    last_action = 0
    auto, next_modem = AutoUnlock(), 0
    while True:
        ready, _, _ = select.select([unlock, control], [], [], 1)
        if unlock in ready:
            connection, _ = unlock.accept()
            with connection:
                status, uid = 'unlockFailed', None
                try:
                    uid = peer_uid(connection)
                    if uid == OVERVIEW_UID and router is not None:
                        status = 'current'  # a phone attempt never replaces a working session
                    elif (
                        uid == OVERVIEW_UID
                        and time.monotonic() - last_web_unlock < WEB_UNLOCK_INTERVAL_SECONDS
                    ):
                        status = 'busy'
                    else:
                        if uid == OVERVIEW_UID:
                            last_web_unlock = time.monotonic()
                        candidate = receive(connection, uid)
                        state = read_state(candidate, history)
                        router, poll_failures = candidate, 0
                        save(state)
                        next_poll = time.monotonic() + POLL_SECONDS
                        status = 'current'
                except ProbeError as error:
                    if str(error) == 'notConfigured' and uid == OVERVIEW_UID:
                        # No vault: no password was tried, so the phone keeps its one attempt.
                        # Reaching this point means the previous attempt is already outside the window.
                        last_web_unlock = -WEB_UNLOCK_INTERVAL_SECONDS
                    # Do not retry a failed password or replace a working session.
                    status = (
                        str(error)
                        if str(error) in ('notConfigured', 'alreadyConfigured', 'setupUnavailable')
                        else 'unlockFailed'
                    )
                except FAILURES:
                    pass
                if uid == OVERVIEW_UID:
                    print(f'phone unlock outcome={status}', file=sys.stderr, flush=True)
                try:
                    connection.sendall(json.dumps({'status': status}).encode())
                except OSError:
                    pass  # the requester may have closed its bounded unlock request
            entries = getattr(router, 'entries', None)
            if entries is not None:
                router.entries = None
                remember(entries)
                auto.reset()
                read_modem(entries.get('modem'), is_owner_present=True)
                next_modem = time.monotonic() + MODEM_INTERVAL_SECONDS
                entries = None
        if control in ready:
            connection, _ = control.accept()
            with connection:
                try:
                    if peer_uid(connection) not in (0, OWNER_UID, OVERVIEW_UID):
                        raise ProbeError('unauthorizedClient')
                    kind, target, value = parse_action(read_request(connection, 256))
                    if router is None:
                        outcome = 'locked'
                    elif time.monotonic() - last_action < ACTION_INTERVAL_SECONDS:
                        outcome = 'busy'
                    else:
                        last_action = time.monotonic()
                        try:
                            outcome = (set_port if kind == 'port' else set_block)(
                                router, target, value
                            )
                        except FAILURES:
                            outcome = 'unverified'  # the write may have happened; never repeat it
                        # A paused device is logged without its MAC.
                        print(
                            f'port {target} enabled={value} outcome={outcome}'
                            if kind == 'port'
                            else f'device blocked={value} outcome={outcome}',
                            file=sys.stderr,
                            flush=True,
                        )
                        # Save a post-change reading before answering: the page reloads on the reply,
                        # and an older file would show the switch snapping back.
                        router, state, poll_failures = poll(router, state, history, poll_failures)
                        save(state)
                        next_poll = time.monotonic() + POLL_SECONDS
                    connection.sendall(json.dumps({'status': outcome}).encode())
                except FAILURES:
                    try:
                        connection.sendall(b'{"status":"invalid"}')
                    except OSError:
                        pass
        if router is None:
            candidate = auto.attempt(time.monotonic())
            if candidate is not None:
                candidate.entries = None  # already saved; not kept in memory
                router, state, poll_failures = poll(candidate, state, history, 0)
                save(state)
                next_poll = time.monotonic() + POLL_SECONDS
        if router is not None and time.monotonic() >= next_modem:
            # With automatic unlock the modem is read every few hours; without it, once per unlock.
            next_modem = time.monotonic() + MODEM_INTERVAL_SECONDS
            read_modem((remembered() or {}).get('modem'), is_owner_present=False)
        if router is not None and time.monotonic() >= next_poll:
            router, state, poll_failures = poll(router, state, history, poll_failures)
            if (
                router is not None
            ):  # while locked the baseline stays put, so unlock applies missed edges
                schedule_last = run_schedules(router, schedule_last)
            save(state)
            next_poll = time.monotonic() + POLL_SECONDS


if __name__ == '__main__':
    main()
