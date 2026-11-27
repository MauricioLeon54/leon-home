#!/usr/bin/env python3
"""LEÓN Home overview: an authenticated phone app on the tailnet.

Listens on 127.0.0.1 only; Tailscale Serve publishes it over HTTPS at `/` of the node's ts.net
name. Requests without Tailscale Serve's identity header, or from a login not in OWNER_LOGINS, get
403. A background sampler collects every 30 s (collector snapshot, Pi-hole API with the application
password, `tailscale status`, internet health, backups, Git), so pages render instantly.

Actions carry an HMAC token bound to the login; equipment operations retain their additional
target and policy checks. Nonce-authorized compiled modules refresh readings only while visible.
The Pi serves prebuilt assets without a JavaScript toolchain.
"""

import base64
import calendar
import collections
import configparser
import hashlib
import hmac
import html
import http.client
import http.server
import ipaddress
import json
import math
import mimetypes
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collector
import internet_health
import network_map
import router_telemetry
import web_assets

PORT = int(os.environ.get('OVERVIEW_PORT', '8090'))
OWNERS = {
    login.strip().lower()
    for login in os.environ.get('OWNER_LOGINS', '').split(',')
    if login.strip()
}
PIHOLE = 'http://127.0.0.1:8080'
PIHOLE_PASSWORD_FILE = os.environ.get(
    'PIHOLE_PASSWORD_FILE', '/etc/leon-overview/pihole-app-password'
)
STATE = os.path.join(os.environ.get('STATE_DIRECTORY', '/var/lib/leon-overview'), 'history.json')
BRAND = '/usr/local/share/leon-home'
BACKUPS = '/var/backups/leon-home'
GIT_ROOT = '/srv/git'
NAMES_STATUS = '/var/lib/leon-names/status.json'
TABLET_PEER_FILE = '/etc/leon-tablet/peer'
TABLET_SUMMARY_FILE = '/var/lib/leon-tablet-phone/summary.json'
ROUTER_CONTROL_SOCKET = '/run/leon-router/control.sock'
ROUTER_UNLOCK_SOCKET = '/run/leon-router/unlock.sock'
UNLOCK_OUTCOMES = frozenset(
    {'current', 'unlockFailed', 'busy', 'notConfigured', 'setupUnavailable'}
)
NETMAP_STATE = '/var/lib/leon-netmap/state.json'
KNOWN_DEVICES = '/var/lib/leon-newdevice/known.json'  # MAC -> first-known time (new-device alert)
# Names set from the phone, MAC -> display name. leon-names merges them into Pi-hole local DNS.
OWNER_NAMES = os.path.join(
    os.environ.get('STATE_DIRECTORY', '/var/lib/leon-overview'), 'device-names.json'
)
MAX_OWNER_NAMES = 256
# Weekly pause windows, MAC -> {days (Mon=0), start, end "HH:MM"}; the router monitor applies them.
PAUSE_SCHEDULES = os.path.join(
    os.environ.get('STATE_DIRECTORY', '/var/lib/leon-overview'), 'pause-schedules.json'
)
MAX_SCHEDULES = 64
HHMM = re.compile(r'([01]\d|2[0-3]):[0-5]\d')
NEW_DEVICE_SECONDS = 86400
MAC_ADDRESS = re.compile(r'[0-9a-f]{2}(:[0-9a-f]{2}){5}')
PORT_OUTCOMES = frozenset(
    {
        'applied',
        'unchanged',
        'unverified',
        'protectedPort',
        'unknownPort',
        'locked',
        'busy',
        'rejected',
        'invalid',
        'filterUnavailable',
        'protectedDevice',
        'wiredDevice',
        'filterFull',
        'unknownDevice',
    }
)
PROTECTED_DEVICES = (
    '/etc/leon-router/protected-devices'  # the monitor enforces it; the page only explains
)
SUMMARY_FRESH_SECONDS = 300
REPORT_FRESH_SECONDS = 900
SAMPLE_SECONDS = 30
TEMPERATURE_EVERY = 300
# Keep synchronized with web/src/routes.ts; /index.html is the Home alias.
APP_ROUTES = frozenset(
    {
        '/',
        '/index.html',
        '/network',
        '/network/device/:id',
        '/network-map',
        '/storage',
        '/storage/files',
        '/storage/guide',
        '/storage/movies',
        '/storage/automation',
        '/automation',
        '/settings',
        '/settings/about',
        '/settings/raspberry',
        '/settings/raspberry/lights',
        '/settings/raspberry/usb',
        '/settings/raspberry/radios',
        '/settings/raspberry/performance',
        '/settings/raspberry/power',
        '/settings/dns',
    }
)
TOKEN_SECONDS = 3600
# Optional, administrator-written: the ISP modem's private IPv4 address on one line.
MODEM_ADDRESS = '/etc/leon-overview/modem'
MODEM_LINE = '/var/lib/leon-router/modem.json'  # written by the router monitor
SPEED_TESTS = '/var/lib/leon-speedtest/history.json'  # optional; leon-speedtest.timer
SECRET = os.urandom(32)
VERSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'VERSION')
VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9 .+-]{0,39}')
UNIT_LABELS = {
    'pihole-FTL': 'Pi-hole',
    'unbound': 'Encrypted DNS',
    'tailscaled': 'Tailscale',
    'ssh': 'SSH',
    'leon-dns-firewall': 'DNS firewall',
    'leon-netmap.timer': 'Network scan',
    'leon-backup.timer': 'Encrypted backup',
    'leon-overview': 'This panel',
    'unattended-upgrades': 'Updates',
    'ntfy': 'Notifications',
    'smbd': 'File sharing',
    'leon-router': 'Router monitor',
    'leon-n8n': 'Automation',
    'leon-overview-redirect': 'Short address',
}
ASSETS = {
    '/brand/symbol.png': 'symbol-web.png',
    '/brand/wordmark.png': 'wordmark-web.png',
    '/apple-touch-icon.png': 'apple-touch-icon.png',
    '/brand/icon-512.png': 'icon-512.png',
}
MANIFEST = json.dumps(
    {
        'name': 'LEÓN Home',
        'short_name': 'LEÓN',
        'id': '/',
        'start_url': '/',
        'scope': '/',
        'display': 'standalone',
        'orientation': 'portrait',
        'lang': 'en',
        'background_color': '#0e0e0e',
        'theme_color': '#0e0e0e',
        'icons': [
            {'src': '/brand/symbol.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': '/brand/icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
        ],
    }
).encode('utf-8')
# The worker caches only the brand assets and a data-free offline page. Private readings are
# never stored on the phone: every page and JSON request still goes to the network.

_lock = threading.Lock()
_dns_action_lock = threading.Lock()
_dns_last_control = None  # monotonic verification time and its blocking/timer reading
_names_lock = threading.Lock()
_wake_lock = threading.Lock()
_wake_sent = {}
_data = {}
_temperatures = collections.deque(maxlen=288)
INTERNET_STATE = os.path.join(
    os.environ.get('STATE_DIRECTORY', '/var/lib/leon-overview'), 'internet.json'
)
_internet = collections.deque(maxlen=internet_health.MAX_SAMPLES)
INTERNET_OUTAGES = os.path.join(
    os.environ.get('STATE_DIRECTORY', '/var/lib/leon-overview'), 'internet-outages.json'
)
DAILY_FACTS = os.path.join(
    os.environ.get('STATE_DIRECTORY', '/var/lib/leon-overview'), 'daily-facts.json'
)
DAILY_FACTS_EVERY = 900


# ---------------------------------------------------------------- data sources


class PiHole:
    """One short API session with the application password; always logged out."""

    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.sid = None

    def call(self, method, path, body=None):
        # Fixed loopback Pi-hole HTTP origin and internal API paths.
        request = urllib.request.Request(  # noqa: S310
            PIHOLE + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json', **({'sid': self.sid} if self.sid else {})},
        )
        with self.opener.open(request, timeout=5) as response:
            raw = response.read(1_048_576)
            return json.loads(raw) if raw else {}

    def __enter__(self):
        with open(PIHOLE_PASSWORD_FILE, encoding='utf-8') as handle:
            password = handle.read().strip()
        self.sid = self.call('POST', '/api/auth', {'password': password})['session']['sid']
        return self

    def __exit__(self, *exc):
        try:
            self.call('DELETE', '/api/auth')
        except (OSError, ValueError):
            pass


def blocking_reading(value):
    if (
        isinstance(value, dict)
        and value.get('blocking') in ('enabled', 'disabled')
        and 'timer' in value
    ):
        timer = value['timer']
        if timer is None or (type(timer) in (int, float) and 0 <= timer <= 2_147_483_647):
            return {'blocking': value['blocking'], 'timer': timer}
    return {'blocking': None, 'timer': None}


def pihole_data():
    try:
        with PiHole() as api:
            summary = api.call('GET', '/api/stats/summary')
            history = api.call('GET', '/api/history').get('history', [])
            blocked = api.call('GET', '/api/stats/top_domains?blocked=true&count=6').get(
                'domains', []
            )
            clients = api.call('GET', '/api/stats/top_clients?count=6').get('clients', [])
            upstreams = api.call('GET', '/api/stats/upstreams').get('upstreams', [])
            blocking = api.call('GET', '/api/dns/blocking')
    except (OSError, ValueError, KeyError, TypeError):
        return None
    hours = collections.OrderedDict()
    for bucket in history[-144:]:
        hour = int(bucket.get('timestamp', 0)) // 3600
        total, block = hours.get(hour, (0, 0))
        hours[hour] = (total + int(bucket.get('total', 0)), block + int(bucket.get('blocked', 0)))
    encrypted = next(
        (u for u in upstreams if u.get('ip') == '127.0.0.1' and u.get('port') == 5335), None
    )
    return {
        'queries': summary['queries']['total'],
        'blocked': summary['queries']['blocked'],
        'percent': summary['queries']['percent_blocked'],
        'clients': summary['clients']['active'],
        'gravity': summary['gravity']['domains_being_blocked'],
        **blocking_reading(blocking),
        'hours': list(hours.items())[-24:],
        'topBlocked': [(d['domain'], d['count']) for d in blocked],
        'topClients': [
            ((c.get('name') or c['ip']).removesuffix('.home.arpa'), c['count']) for c in clients
        ],
        'upstreamMs': round(encrypted['statistics']['response'] * 1000) if encrypted else None,
    }


def tablet_peer():
    """The one tailnet host named by the owner (private file); None leaves the tablet card off."""
    try:
        with open(TABLET_PEER_FILE, encoding='utf-8') as handle:
            return handle.read(64).strip() or None
    except OSError:
        return None


def tablet_summary():
    """The Mac's last published tablet reading (validated by leon-tablet-ingest), or None."""
    try:
        with open(TABLET_SUMMARY_FILE, encoding='utf-8') as handle:
            stored = json.loads(handle.read(8192))
        return (
            stored
            if isinstance(stored.get('summary'), dict) and isinstance(stored.get('receivedAt'), int)
            else None
        )
    except (OSError, ValueError, AttributeError):
        return None


def tailnet():
    try:
        result = subprocess.run(
            # Fixed runtime tool from the service PATH; callers cannot select an executable.
            ['tailscale', 'status', '--json'],  # noqa: S607
            capture_output=True,
            timeout=4,
            check=True,
        )
        status = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    peers = []
    for peer in status.get('Peer', {}).values():
        seen = peer.get('LastSeen') or ''
        try:
            seen_at = (
                calendar.timegm(time.strptime(seen[:19], '%Y-%m-%dT%H:%M:%S'))
                if seen[:4] > '2000'
                else None
            )
        except ValueError:
            seen_at = None
        peers.append(
            {
                'name': (peer.get('DNSName') or peer.get('HostName') or '?').split('.')[0],
                'os': peer.get('OS', ''),
                'online': bool(peer.get('Online')),
                'direct': bool(peer.get('CurAddr')),
                'seen': seen_at,
            }
        )
    return sorted(peers, key=lambda p: (not p['online'], p['name']))


def backups():
    """Count archives and retain only the latest metadata; never retain the directory listing."""
    count, latest = 0, None
    try:
        with os.scandir(BACKUPS) as entries:
            for entry in entries:
                if not entry.name.endswith('.tar.gz.age'):
                    continue
                info = entry.stat()
                count += 1
                if latest is None or info.st_mtime > latest.st_mtime:
                    latest = info
        if latest is None:
            return None
        return {'count': count, 'at': latest.st_mtime, 'bytes': latest.st_size}
    except OSError:
        return None


def repositories():
    found = []
    try:
        names = sorted(name for name in os.listdir(GIT_ROOT) if name.endswith('.git'))[:12]
    except OSError:
        return None
    for name in names:
        try:
            result = subprocess.run(
                # Fixed system tool from the service PATH; executable is not supplied by a request.
                [  # noqa: S607
                    'git',
                    '-c',
                    'safe.directory=*',
                    '-C',
                    os.path.join(GIT_ROOT, name),
                    'for-each-ref',
                    '--sort=-committerdate',
                    '--count=1',
                    '--format=%(committerdate:unix)%09%(refname:short)%09%(contents:subject)',
                ],
                capture_output=True,
                text=True,
                timeout=4,
                check=True,
            )
            stamp, branch, subject = ([*result.stdout.strip().split('\t', 2), '', '', ''])[:3]
            found.append(
                {
                    'name': name.removesuffix('.git'),
                    'at': int(stamp) if stamp.isdigit() else None,
                    'branch': branch,
                    'subject': subject,
                }
            )
        except (OSError, subprocess.SubprocessError):
            found.append(
                {'name': name.removesuffix('.git'), 'at': None, 'branch': '', 'subject': ''}
            )
    return found


_names = {}


def local_name(ip):
    """Pi-hole local record for a home address, cached 10 min so the sampler does not flood the query log."""
    cached = _names.get(ip)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    try:
        name = socket.gethostbyaddr(ip)[0]
        label = name.removesuffix('.home.arpa') if name.endswith('.home.arpa') else None
    except (OSError, UnicodeError):
        label = None
    _names[ip] = (time.time(), label)
    return label


def modem_reading():
    """Ping loss and response time of the owner's modem; None when it is not configured. No login."""
    try:
        with open(MODEM_ADDRESS, encoding='utf-8') as handle:
            address = collector.private_ipv4(handle.read(64).strip())
        return {'at': int(time.time()), **collector.ping(address, 4)}
    except (OSError, ValueError):
        return None


def sample_internet(network):
    router = next((d['ip'] for d in network.get('devices', []) if d.get('role') == 'router'), None)
    try:
        internet = collector.health(router) if router else None
    except (OSError, ValueError):
        internet = None
    return internet


def sample_devices(network):
    devices = [
        {**device, 'label': local_name(device['ip'])} for device in network.get('devices', [])
    ]
    try:
        with open(NAMES_STATUS, encoding='utf-8') as handle:
            naming = json.load(handle)
    except (OSError, ValueError):
        naming = {}
    sources = {d.get('ip'): d.get('source') for d in naming.get('devices', [])}
    for device in devices:
        device['source'] = sources.get(device['ip'])
    apply_identity(devices, time.time())
    return devices, naming


def sample():
    snapshot = collector.collect()
    network = snapshot.get('network') or {}
    internet = sample_internet(network)
    devices, naming = sample_devices(network)
    return {
        'at': time.time(),
        'naming': naming,
        'snapshot': snapshot,
        'host': snapshot.get('host') or {},
        'dns': pihole_data(),
        'peers': tailnet(),
        'tabletPeer': tablet_peer(),
        'tabletSummary': tablet_summary(),
        'internet': internet,
        'modem': modem_reading(),
        'devices': devices,
        'backups': backups(),
        'repos': repositories(),
    }


def json_file(path, limit=1_000_000):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.loads(handle.read(limit))
    except (OSError, ValueError):
        return None


def mac_map(value):
    """Lower-case MAC keys only; anything else in a damaged file is ignored."""
    return (
        {
            str(key).lower(): item
            for key, item in value.items()
            if MAC_ADDRESS.fullmatch(str(key).lower())
        }
        if isinstance(value, dict)
        else {}
    )


def macs_by_ip():
    state = json_file(NETMAP_STATE, 4_000_000)
    rows = state.get('devices') if isinstance(state, dict) else None
    return {
        row['ip']: str(row.get('mac')).lower()
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict)
        and isinstance(row.get('ip'), str)
        and MAC_ADDRESS.fullmatch(str(row.get('mac')).lower())
    }


def owner_names():
    return {
        mac: name
        for mac, name in mac_map(json_file(OWNER_NAMES)).items()
        if isinstance(name, str) and clean_name(name) == name and name
    }


def clean_name(value):
    """Display name from the phone: printable, single spaces, at most 40 characters; '' clears it."""
    return (
        ' '.join(''.join(c for c in value if c.isprintable()).split())[:40].strip()
        if isinstance(value, str)
        else None
    )


def protected_macs():
    """Same rules as the monitor: missing means none; unreadable or invalid means every device."""
    try:
        with open(PROTECTED_DEVICES, encoding='utf-8') as handle:
            words = re.sub(r'#.*', '', handle.read(8193)).lower().split()
    except FileNotFoundError:
        return frozenset()
    except (OSError, UnicodeDecodeError):
        return None
    return frozenset(words) if all(MAC_ADDRESS.fullmatch(word) for word in words) else None


def apply_identity(devices, now):
    """Attach MAC, phone name and 'new' flag. A phone name overrides the Pi registry's default; the
    baseline run of the new-device alert (its oldest entries) never counts as new."""
    macs, owned = macs_by_ip(), owner_names()
    known = {
        mac: since
        for mac, since in mac_map(json_file(KNOWN_DEVICES)).items()
        if isinstance(since, int)
    }
    baseline = min(known.values(), default=None)
    protected = protected_macs()
    schedules = pause_schedules()
    # Older router telemetry readers may provide the address without a name.
    router_names = {
        row['address']: row.get('name') for row in router_telemetry.read(now)['devices']
    }
    for device in devices:
        mac = macs.get(device['ip'])
        device['mac'] = mac
        device['protected'] = bool(mac) and (protected is None or mac in protected)
        device['pauseSchedule'] = schedules.get(mac)
        device['canRename'] = bool(mac)
        if owned.get(mac):
            device['label'] = owned[mac]
        elif not device.get('label') and router_names.get(device['ip']):
            device['label'] = router_names[
                device['ip']
            ]  # the router's name until the owner sets one
        since = known.get(mac)
        device['isNew'] = bool(
            since and baseline is not None and since > baseline and now - since < NEW_DEVICE_SECONDS
        )


def clean_schedule(value):
    """Normalized schedule or None; raises ValueError for anything malformed (same rules as the monitor)."""
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or set(value) != {'days', 'start', 'end'}
        or not isinstance(value['days'], list)
        or not all(type(day) is int and 0 <= day <= 6 for day in value['days'])
        or not value['days']
        or not all(
            isinstance(value[key], str) and HHMM.fullmatch(value[key]) for key in ('start', 'end')
        )
        or value['start'] == value['end']
    ):
        raise ValueError('Invalid schedule')
    return {'days': sorted(set(value['days'])), 'start': value['start'], 'end': value['end']}


def pause_schedules():
    schedules = {}
    for mac, entry in mac_map(json_file(PAUSE_SCHEDULES)).items():
        try:
            schedules[mac] = clean_schedule(entry)
        except ValueError:
            continue
    return schedules


def save_pause_schedule(mac, schedule):
    with _names_lock:
        schedules = pause_schedules()
        if schedule:
            schedules[mac] = schedule
        else:
            schedules.pop(mac, None)
        if len(schedules) > MAX_SCHEDULES:
            raise ValueError('Too many schedules')
        temporary = PAUSE_SCHEDULES + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as handle:
            json.dump(schedules, handle)
        os.chmod(temporary, 0o644)  # the router monitor (another user) reads it
        os.replace(temporary, PAUSE_SCHEDULES)


def save_owner_name(mac, name):
    with _names_lock:
        names = owner_names()
        if name:
            names[mac] = name
        else:
            names.pop(mac, None)
        if len(names) > MAX_OWNER_NAMES:
            raise ValueError('Too many names')
        temporary = OWNER_NAMES + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as handle:
            json.dump(names, handle, ensure_ascii=False)
        os.chmod(temporary, 0o644)  # leon-names reads it
        os.replace(temporary, OWNER_NAMES)


def load_temperatures():
    try:
        with open(STATE, encoding='utf-8') as handle:
            points = json.load(handle)
        cutoff = time.time() - 86400
        _temperatures.extend(
            (t, v)
            for t, v in points
            if isinstance(t, (int, float)) and t > cutoff and isinstance(v, (int, float))
        )
    except (OSError, ValueError, TypeError):
        pass


def record_temperature(value):
    now = time.time()
    if value is None or (_temperatures and now - _temperatures[-1][0] < TEMPERATURE_EVERY - 5):
        return
    _temperatures.append((now, value))
    try:
        temporary = STATE + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as handle:
            json.dump(list(_temperatures), handle)
        os.replace(temporary, STATE)
    except OSError:
        pass


def record_internet(data):
    row = internet_health.sample_row(data.get('internet'), data.get('at'))
    if row:
        _internet.append(row)
        if len(_internet) % 10 == 0:  # every ~5 min: bounded SD-card writes, at most 5 min lost
            try:
                internet_health.save(INTERNET_STATE, list(_internet))
            except OSError:
                pass
    data['internetHealth'] = internet_health.summary(list(_internet), time.time())
    data['internetHealth']['speedTests'] = internet_health.load_speed_tests(
        SPEED_TESTS, time.time()
    )
    data['internetHealth']['modem'] = data.get('modem')
    data['internetHealth']['modemLine'] = internet_health.load_modem_line(MODEM_LINE, time.time())
    try:
        internet_health.save_closed_outages(INTERNET_OUTAGES, data['internetHealth'])
    except OSError:
        pass
    record_daily_facts(data)


_daily_facts_at = 0


_week_blocking = (0.0, None)  # (computed at, weekly totals); the 7-day query takes seconds


def top_blocked_devices(clients):
    return [
        {'name': client_label(client), 'blocked': int(client.get('count') or 0)}
        for client in clients[:3]
    ]


def ad_block_facts(data, now):
    """Names and counts for the daily push: today's blocking and, refreshed every 6 h, the week."""
    global _week_blocking
    dns = data.get('dns') or {}
    try:
        with PiHole() as api:
            top = api.call('GET', '/api/stats/top_clients?blocked=true&count=3')['clients']
            if now - _week_blocking[0] >= 6 * 3600:
                span = f'from={int(now) - 7 * 86400}&until={int(now)}'
                summary = api.call('GET', f'/api/stats/database/summary?{span}')
                week_top = api.call(
                    'GET', f'/api/stats/database/top_clients?{span}&blocked=true&count=3'
                )['clients']
                _week_blocking = (
                    now,
                    {
                        'queries': int(summary['sum_queries']),
                        'blocked': int(summary['sum_blocked']),
                        'topDevices': top_blocked_devices(week_top),
                    },
                )
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return {
        'queries': dns.get('queries'),
        'blocked': dns.get('blocked'),
        'topDevices': top_blocked_devices(top),
        'week': _week_blocking[1],
    }


def record_daily_facts(data):
    """Every 15 min: names-only facts for the daily push, which runs as another user."""
    global _daily_facts_at
    now = time.time()
    if now - _daily_facts_at < DAILY_FACTS_EVERY:
        return
    try:
        facts = internet_health.daily_facts(
            network_map.snapshot(data, now), now
        )  # sample() attached identity
        facts['adBlock'] = ad_block_facts(data, now)
        internet_health.save_json(DAILY_FACTS, facts)
        _daily_facts_at = now
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'daily facts failed: {type(error).__name__}', file=sys.stderr, flush=True)


def own_lan_address(router):
    """The Pi's source address toward the router; a UDP connect sends nothing."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect((router, 9))
            return probe.getsockname()[0]
    except (OSError, TypeError):
        return None


def is_lan_client(address, excluded):
    try:
        return ipaddress.IPv4Address(address).is_private and address not in excluded
    except ValueError:
        return False


def dns_facts(data, now):
    """Ad-blocker alert facts: counts only. Unknown stays None and never implies a fault."""
    devices = data.get('devices') or []
    router = next((d.get('ip') for d in devices if d.get('role') == 'router'), None)
    excluded = {'127.0.0.1', router, own_lan_address(router)}
    try:
        with PiHole() as api:
            lists = api.call('GET', '/api/lists?type=block')['lists']
            # 10-minute buckets; the last seven cover a bit more than the past hour.
            history = api.call('GET', '/api/history/clients?N=0')['history'][-7:]
        asking = {
            address
            for bucket in history
            for address, queries in bucket['data'].items()
            if queries and is_lan_client(address, excluded)
        }
        failing = sum(list_state(entry) in ('cached', 'failed') for entry in lists)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {'dnsAt': None}
    dns = data.get('dns') or {}
    return {
        'dnsAt': now,
        'dnsBlocking': dns.get('blocking'),
        'dnsTimer': dns.get('timer'),
        'blocklistsFailing': failing,
        'lanDnsClients': len(asking),
        'lanDevicesOnline': sum(
            1 for d in devices if d.get('online') and is_lan_client(d.get('ip', ''), excluded)
        ),
    }


def record_monitoring_facts(data):
    """Five-minute projection for optional alerts: no names, addresses or credentials."""
    now = int(time.time())
    stored = data.get('tabletSummary') or {}
    summary = stored.get('summary') or {}
    peer = data.get('tabletPeer')
    online = (
        next(
            (item.get('online') for item in data.get('peers') or [] if item.get('name') == peer),
            None,
        )
        if peer
        else None
    )
    snapshot = data.get('snapshot') or {}
    free, total = snapshot.get('storageFreeBytes'), snapshot.get('storageTotalBytes')
    owned = owner_names()
    unnamed = sum(
        1
        for device in data.get('devices', [])[:64]
        if device.get('mac')
        and device.get('mac') not in owned
        and device.get('source') != 'registry'
    )
    if network_map.snapshot(data, now)['freshness'] != 'current':
        unnamed = None
    facts = {
        'at': now,
        'tabletOnline': online,
        'receivedAt': stored.get('receivedAt'),
        'observedAt': summary.get('observedAt'),
        'hasAdb': bool(summary.get('battery') is not None or summary.get('display') is not None),
        'storageObservedAt': data.get('at'),
        'storageFreePercent': free * 100 / total
        if type(free) is int and type(total) is int and 0 <= free <= total and total > 0
        else None,
        'unnamedDevices': unnamed,
        **dns_facts(data, now),
    }
    internet_health.save_json(
        os.path.join(os.path.dirname(DAILY_FACTS), 'monitoring-facts.json'), facts
    )


def refresh_monitoring_facts(data, started, last_at):
    """Best effort every five minutes: a failure is logged once per window and never holds back
    the phone's sample. Returns the time of the latest attempt."""
    if started - last_at < 300:
        return last_at
    try:
        record_monitoring_facts(data)
    # Optional monitoring cannot prevent publishing a successful sample; category is logged.
    except Exception as error:  # noqa: BLE001
        print(f'monitoring facts failed: {type(error).__name__}', file=sys.stderr, flush=True)
    return started


def save_internet_and_exit(signum, frame):
    """systemd stops with SIGTERM: keep the samples since the last periodic save (installs restart often)."""
    try:
        internet_health.save(INTERNET_STATE, list(_internet))
    except OSError:
        pass
    raise SystemExit(0)


def sampler():
    load_temperatures()
    _internet.extend(internet_health.load(INTERNET_STATE, time.time()))
    monitoring_at = expiry_at = 0
    while True:
        started = time.time()
        sampling_since = time.monotonic()
        try:
            data = sample()
            record_temperature(data['host'].get('temperatureCelsius'))
            record_internet(data)
            monitoring_at = refresh_monitoring_facts(data, started, monitoring_at)
            if started - expiry_at >= 60:
                expire_device_filters(started)
                expiry_at = started
            with _lock:
                if data['dns'] and _dns_last_control and _dns_last_control[0] >= sampling_since:
                    data['dns'].update(_dns_last_control[1])
                _data.clear()
                _data.update(data)
        # Optional monitoring cannot prevent publishing a successful sample; category is logged.
        except Exception as error:  # noqa: BLE001
            print(f'sample failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
        time.sleep(max(5, SAMPLE_SECONDS - (time.time() - started)))


# ---------------------------------------------------------------- actions


def token(login, now=None):
    stamp = str(int(now or time.time()))
    mac = hmac.new(SECRET, f'{login}|{stamp}'.encode(), hashlib.sha256).hexdigest()
    return f'{stamp}.{mac}'


def token_valid(login, value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,12}\.[0-9a-f]{64}', value):
        return False
    stamp, _, mac = value.partition('.')
    if not stamp.isdigit() or abs(time.time() - int(stamp)) > TOKEN_SECONDS:
        return False
    expected = hmac.new(SECRET, f'{login}|{stamp}'.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, mac)


def set_blocking(enabled, seconds=None):
    with PiHole() as api:
        api.call('POST', '/api/dns/blocking', {'blocking': enabled, 'timer': seconds})
        try:
            return blocking_reading(api.call('GET', '/api/dns/blocking'))
        except (OSError, ValueError, KeyError, TypeError):
            # The POST completed. A lost readback leaves the resulting mode unknown.
            return blocking_reading(None)


def apply_blocking(enabled, seconds):
    """Serialize changes, verify the timer as well as the mode, and publish the reading."""
    global _dns_last_control
    if not _dns_action_lock.acquire(blocking=False):
        return 409, {'status': 'refused', 'message': 'Another DNS change is in progress.'}
    try:
        try:
            reading = set_blocking(enabled, seconds)
        except (OSError, ValueError, KeyError, TypeError):
            return 503, {
                'status': 'unavailable',
                'message': 'Pi-hole did not acknowledge the change.',
            }
        with _lock:
            _dns_last_control = time.monotonic(), reading
            if _data.get('dns') is not None:
                _data['dns'] = {**_data['dns'], **reading}
        expected = 'enabled' if enabled else 'disabled'
        timer = reading['timer']
        timer_matches = (
            timer is None if seconds is None else timer is not None and 0 < timer <= seconds
        )
        if reading['blocking'] == expected and timer_matches:
            return 200, {'status': 'applied', 'message': 'Pi-hole confirmed the setting.'}
        return 200, {'status': 'unverified', 'message': 'Pi-hole did not confirm the change.'}
    finally:
        _dns_action_lock.release()


# Allowlist entries the panel or self-repair created; anything else was added in Pi-hole itself.
PANEL_ALLOW_COMMENT = 'Allowed from the LEÓN panel'
SELF_REPAIR_ALLOW_COMMENT = 'LEÓN self-repair: essential domain'
BLOCKED_STATUSES = frozenset(
    ('GRAVITY', 'REGEX', 'DENYLIST', 'GRAVITY_CNAME', 'REGEX_CNAME', 'DENYLIST_CNAME')
)
DOMAIN_PATTERN = re.compile(
    r'(?=.{1,253}\Z)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z'
)


def client_label(client):
    if not isinstance(client, dict):
        return ''
    return str(client.get('name') or client.get('ip') or '')[:100].removesuffix('.home.arpa')


def list_label(entry):
    comment = str(entry.get('comment') or '')
    if comment and not comment.startswith('Migrated from'):
        return comment.split(': ', 1)[-1][:100]
    return str(entry.get('address', '')).removeprefix('https://').removeprefix('http://')[:100]


def list_state(entry):
    # Pi-hole list status: 1 updated, 2 unchanged, 3 download failed (cached copy), 4 failed.
    if not entry.get('enabled'):
        return 'off'
    if entry.get('status') in (1, 2) and int(entry.get('number') or 0) > 0:
        return 'ok'
    return 'cached' if entry.get('status') == 3 else 'failed'


def recent_blocked(queries, limit=30):
    """Unique blocked domains, newest first, with the device that asked last."""
    recent = {}
    for row in queries:
        domain, at = row.get('domain'), row.get('time')
        if row.get('status') not in BLOCKED_STATUSES or not isinstance(domain, str):
            continue
        if type(at) not in (int, float) or not DOMAIN_PATTERN.match(domain):
            continue
        entry = recent.setdefault(domain, {'domain': domain, 'device': '', 'at': 0, 'count': 0})
        entry['count'] += 1
        if at > entry['at']:
            entry['at'], entry['device'] = at, client_label(row.get('client'))
    return sorted(recent.values(), key=lambda entry: -entry['at'])[:limit]


def dns_details():
    """The filtering page: recent blocks, allowlist, device groups and list health; None if down."""
    try:
        with PiHole() as api:
            queries = api.call('GET', '/api/queries?length=400&upstream=blocklist')['queries']
            allowed = api.call('GET', '/api/domains/allow/exact')['domains']
            lists = api.call('GET', '/api/lists?type=block')['lists']
            groups = api.call('GET', '/api/groups')['groups']
            clients = api.call('GET', '/api/clients')['clients']
            gravity = api.call('GET', '/api/stats/summary')['gravity']
            activity = api.call('GET', '/api/history/clients?N=0')['clients']
        names = {group['id']: str(group['name'])[:60] for group in groups}
        sources = {PANEL_ALLOW_COMMENT: 'panel', SELF_REPAIR_ALLOW_COMMENT: 'selfRepair'}
        return {
            'recentBlocked': recent_blocked(queries),
            'allowed': [
                {
                    'domain': entry['domain'],
                    'source': sources.get(entry.get('comment'), 'other'),
                    'addedAt': entry.get('date_added') or None,
                }
                for entry in allowed
                if DOMAIN_PATTERN.match(str(entry.get('domain', '')))
            ][:100],
            'groups': [
                {
                    'name': names[group_id],
                    'devices': sorted(
                        str(
                            client.get('comment')
                            or client_label({'name': client.get('name')})
                            or client.get('client')
                        )[:60]
                        for client in clients
                        if group_id in client.get('groups', [])
                    )[:50],
                }
                for group_id in sorted(names)
                if group_id != 0
            ][:20],
            'lists': [
                {
                    'name': list_label(entry),
                    'entries': int(entry.get('number') or 0),
                    'state': list_state(entry),
                    'updatedAt': entry.get('date_updated') or None,
                    'groups': [names[g] for g in entry.get('groups', []) if g in names][:20],
                }
                for entry in lists
            ][:40],
            'listsUpdatedAt': gravity.get('last_update') or None,
            'devices': filter_devices(activity, clients, time.time()),
        }
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


# A device's filter pause is a Pi-hole client entry for its IP in a group without lists. Pi-hole
# matches an IP entry before a MAC one, so removing the entry restores the device's usual groups.
BYPASS_GROUP = 'LEÓN filter paused'
BYPASS_PREFIX = 'LEÓN filter paused until '
BYPASS_SECONDS = 1800
BYPASS_UNTIL = re.compile(r'\((\d{9,11})\)\Z')


def bypass_until(entry):
    """The pause end of a client entry this panel created, else None (an owner's own entry)."""
    comment = str(entry.get('comment') or '')
    match = BYPASS_UNTIL.search(comment) if comment.startswith(BYPASS_PREFIX) else None
    return int(match.group(1)) if match else None


def is_filter_device(address):
    try:
        parsed = ipaddress.IPv4Address(address)
    except ValueError:
        return False
    return parsed.is_private or parsed in ipaddress.IPv4Network('100.64.0.0/10')


def device_filter_path(address):
    return '/api/clients/' + urllib.parse.quote(address, safe='')


def first_entry(api, path, key):
    """The one item at a Pi-hole path, or None when it does not exist (empty or 404)."""
    try:
        return (api.call('GET', path).get(key) or [None])[0]
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def bypass_group(api):
    path = '/api/groups/' + urllib.parse.quote(BYPASS_GROUP, safe='')
    group = first_entry(api, path, 'groups')
    if group is None:
        comment = 'Devices whose filtering is paused from the LEÓN panel; no lists.'
        api.call('POST', '/api/groups', {'name': BYPASS_GROUP, 'comment': comment, 'enabled': True})
        group = first_entry(api, path, 'groups')
    return group['id']


def set_device_filter(address, paused, now=None):
    """Pause one device's filtering for BYPASS_SECONDS, or resume it; verified by readback."""
    if not _dns_action_lock.acquire(blocking=False):
        return 409, {'status': 'refused', 'message': 'Another DNS change is in progress.'}
    path = device_filter_path(address)
    try:
        with PiHole() as api:
            current = first_entry(api, path, 'clients')
            if current is not None and bypass_until(current) is None:
                return 200, {
                    'status': 'refused',
                    'message': 'This device has its own Pi-hole rule; change it in Pi-hole.',
                }
            if paused:
                until = int(now or time.time()) + BYPASS_SECONDS
                stamp = time.strftime('%H:%M', time.localtime(until))
                entry = {
                    'comment': f'{BYPASS_PREFIX}{stamp} ({until})',
                    'groups': [bypass_group(api)],
                }
                if current is None:
                    api.call('POST', '/api/clients', {'client': address, **entry})
                else:
                    api.call('PUT', path, entry)
            elif current is not None:
                api.call('DELETE', path)
            after = first_entry(api, path, 'clients')
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return 503, {'status': 'unavailable', 'message': 'Pi-hole did not acknowledge the change.'}
    finally:
        _dns_action_lock.release()
    if (after is not None and bypass_until(after) is not None) == paused:
        return 200, {'status': 'applied', 'message': 'Pi-hole confirmed the change.'}
    return 200, {'status': 'unverified', 'message': 'Pi-hole did not confirm the change.'}


def expire_device_filters(now):
    """Remove expired pauses this panel created. Best effort; the next minute retries."""
    try:
        with PiHole() as api:
            for entry in api.call('GET', '/api/clients')['clients']:
                until = bypass_until(entry)
                if until is not None and until <= now:
                    api.call('DELETE', device_filter_path(str(entry['client'])))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'filter pause expiry failed: {type(error).__name__}', file=sys.stderr, flush=True)


def filter_devices(clients, entries, now):
    """The 20 busiest Pi-hole clients of the last day, with any pause this panel set."""
    paused = {str(e.get('client')): bypass_until(e) for e in entries if bypass_until(e)}
    owned = {str(e.get('client')) for e in entries if bypass_until(e) is None}
    rows = [
        {
            'address': address,
            'name': client_label({'name': value.get('name'), 'ip': address}),
            'queries': int(value.get('total') or 0),
            'pausedUntil': paused.get(address) if (paused.get(address) or 0) > now else None,
            'canPause': address not in owned,
        }
        for address, value in clients.items()
        if is_filter_device(address) and isinstance(value, dict)
    ]
    rows.sort(key=lambda row: (row['pausedUntil'] is None, -row['queries']))
    return rows[:20]


def change_allowlist(domain, allow):
    """Add or remove one exact allow entry, then read it back; unverified is never success."""
    if not _dns_action_lock.acquire(blocking=False):
        return 409, {'status': 'refused', 'message': 'Another DNS change is in progress.'}
    path = '/api/domains/allow/exact/' + urllib.parse.quote(domain, safe='')
    try:
        with PiHole() as api:
            try:
                if allow:
                    api.call(
                        'POST',
                        '/api/domains/allow/exact',
                        {'domain': domain, 'comment': PANEL_ALLOW_COMMENT},
                    )
                else:
                    api.call('DELETE', path)
            except urllib.error.HTTPError as error:
                # Adding an existing entry or removing a missing one leaves the wanted state.
                if error.code not in ((400, 409) if allow else (404,)):
                    raise
            present = bool(api.call('GET', path).get('domains'))
    except (OSError, ValueError, KeyError, TypeError):
        return 503, {'status': 'unavailable', 'message': 'Pi-hole did not acknowledge the change.'}
    finally:
        _dns_action_lock.release()
    if present == allow:
        return 200, {'status': 'applied', 'message': 'Pi-hole confirmed the change.'}
    return 200, {'status': 'unverified', 'message': 'Pi-hole did not confirm the change.'}


# ---------------------------------------------------------------- presentation data


def ago(stamp, *, now=None):
    if not stamp:
        return '—'
    seconds = max(0, (time.time() if now is None else now) - stamp)
    if seconds < 90:
        return 'now'
    if seconds < 3600:
        return f'{int(seconds // 60)} min ago'
    if seconds < 86400:
        return f'{int(seconds // 3600)} h ago'
    return f'{int(seconds // 86400)} d ago'


def size(value):
    if value is None:
        return '—'
    for unit, scale in (('GB', 1 << 30), ('MB', 1 << 20), ('KB', 1 << 10)):
        if value >= scale:
            return f'{value / scale:.1f} {unit}'
    return f'{value} B'


def ms(value):
    if value is None:
        return '—'
    return f'{value:.1f} ms' if value < 10 else f'{value:.0f} ms'


def power_reading(host):
    """(text, needs attention) from vcgencmd flags when readable, else the rpi_volt alarm."""
    flags = host.get('throttledFlags')
    if flags is not None:
        if flags & 0x1:
            return 'Low voltage', True
        if flags & 0xE:
            return 'Throttled', True
        if flags & 0x10000:
            return 'Low earlier', True  # since boot; the supply is fine now
        if flags & 0xE0000:
            return 'Throttled earlier', True
        return 'OK', False
    under = host.get('underVoltageNow')
    if under is None:
        return 'Unknown', False
    return ('Low voltage', True) if under else ('OK', False)


def problems(data):
    host, dns, found = data.get('host', {}), data.get('dns'), []
    flags = host.get('throttledFlags')
    if (flags is not None and flags & 0x1) or (flags is None and host.get('underVoltageNow')):
        found.append('Low voltage')
    elif flags is not None and flags & 0xE:
        found.append('CPU throttled')
    if (host.get('temperatureCelsius') or 0) >= 70:
        found.append('High temperature')
    found += [
        UNIT_LABELS.get(u['name'], u['name']) + ' stopped'
        for u in host.get('units', [])
        if u['state'] not in ('active', 'reloading')
    ]
    if host.get('failedUnits'):
        found.append(f'{host["failedUnits"]} failed services')
    if host.get('clockSynchronized') is False:
        found.append('Clock not synchronized')
    if dns is None:
        found.append('Pi-hole is unavailable')
    if (data.get('internet') or {}).get('internetMs') is None and data.get('internet') is not None:
        found.append('No Internet')
    return found


OUTREACH_LABELS = {
    'ok': 'active',
    'paused': 'paused',
    'idle': 'idle',
    'stale': 'no recent actions',
    'signed-out': 'signed out',
    'human-check': 'human verification',
    'rate-limited': 'limited',
}
DISPLAY_LABELS = {'awake': 'on', 'asleep': 'off', 'dreaming': 'screen saver'}


def tablet_row(ok, label, detail=''):
    return {
        'tone': 'good' if ok is True else ('warn' if ok is False else 'unknown'),
        'label': label,
        'detail': detail,
    }


def tablet_summary_entries(stored, now):
    """Rows for the Mac's published tablet reading. Everything older than the Mac's cadence is dimmed."""
    if not stored:
        return [], ''
    summary = stored['summary']
    current = now - summary.get('observedAt', 0) <= SUMMARY_FRESH_SECONDS

    def tone(ok):
        return ok if current else None

    rows = []
    battery = summary.get('battery')
    if battery:
        state = (
            'full'
            if battery['full']
            else 'charging'
            if battery['charging']
            else 'plugged in'
            if battery['pluggedIn']
            else 'on battery'
        )
        heat = (
            f' · {battery["temperatureCelsius"]:.0f} °C'
            if battery.get('temperatureCelsius') is not None
            else ''
        )
        low = battery['percent'] < 15 and not battery['pluggedIn']
        rows.append(tablet_row(tone(not low), 'Battery', f'{battery["percent"]}% · {state}{heat}'))
    else:
        rows.append(tablet_row(None, 'Battery', 'no reading (tablet ADB unavailable)'))
    if summary.get('display'):
        rows.append(tablet_row(None, 'Display', DISPLAY_LABELS[summary['display']]))
    else:
        rows.append(tablet_row(None, 'Display', 'no reading'))
    if summary.get('storageFreePercent') is not None:
        rows.append(
            tablet_row(
                tone(summary['storageFreePercent'] >= 10),
                'Free storage',
                f'{summary["storageFreePercent"]}%',
            )
        )
    if summary.get('memoryAvailablePercent') is not None:
        rows.append(tablet_row(None, 'Available memory', f'{summary["memoryAvailablePercent"]}%'))
    outreach = summary.get('outreach')
    if outreach:
        fresh = now - outreach['checkedAt'] <= REPORT_FRESH_SECONDS
        rows.append(
            tablet_row(
                tone(fresh and not outreach['needsAttention']),
                'Outreach',
                f'{OUTREACH_LABELS[outreach["state"]]} · {outreach["actions24h"]} actions and '
                f'{outreach["errors24h"]} errors in 24 h · {ago(outreach["checkedAt"], now=now)}',
            )
        )
    trader = summary.get('trader')
    if trader:
        fresh = now - trader['checkedAt'] <= REPORT_FRESH_SECONDS
        state = (
            'kill switch active'
            if trader['killSwitch']
            else 'halted after loss'
            if trader['halted']
            else 'active'
        )
        change = f' · {trader["returnPct"]}%' if trader.get('returnPct') is not None else ''
        rows.append(
            tablet_row(
                tone(fresh and not trader['killSwitch'] and not trader['halted']),
                'Trader (simulated)',
                f'{state}{change} · {ago(trader["checkedAt"], now=now)}',
            )
        )
    age = (
        f'Read by the Mac {ago(summary["observedAt"], now=now)}'
        if current
        else f'Stale reading: last read by the Mac {ago(summary["observedAt"], now=now)}'
    )
    return rows, age


def tablet_view(data, now):
    """Keep the tablet card's wording and freshness rules in one presentation model."""
    peers, name = data.get('peers'), data.get('tabletPeer')
    detail_rows, age = tablet_summary_entries(data.get('tabletSummary'), now)
    if not name and not detail_rows:
        return None
    peer = next((peer for peer in peers or [] if peer['name'] == name), None)
    summary, tone, rows = 'Last reading only', 'unknown', []
    if not name:
        pass
    elif peers is None:
        rows.append(tablet_row(None, 'Tablet', 'no Tailscale data'))
        summary = 'Unknown'
    elif peer is None:
        rows.append(tablet_row(None, 'Tablet', 'not in the tailnet'))
        summary, tone = 'Not in the tailnet', 'warn'
    elif peer['online']:
        rows.append(
            tablet_row(
                True,
                'Tablet',
                'online · ' + ('direct connection' if peer['direct'] else 'via relay'),
            )
        )
        summary, tone = 'Online', 'good'
    else:
        rows.append(
            tablet_row(False, 'Tablet', f'offline · last seen {ago(peer["seen"], now=now)}')
        )
        summary, tone = f'Offline since {ago(peer["seen"], now=now)}', 'warn'
    note = (
        f'{age}. These readings become stale if the Mac sleeps or LEÓN Labs is closed.'
        if detail_rows
        else 'Battery, display and services appear when the Mac publishes a reading.'
    )
    return {
        'summary': summary,
        'tone': tone,
        'rows': (rows + detail_rows)[:12],
        'notes': [
            f'Reachability over Tailscale, read {ago(data.get("at"), now=now)}. Phone notification after 10 minutes offline.',
            note,
        ][:3],
    }


def router_link(devices):
    for device in devices or []:
        if not isinstance(device, dict) or device.get('role') != 'router':
            continue
        try:
            address = ipaddress.IPv4Address(device.get('ip', ''))
        except (ValueError, TypeError):
            continue
        if address.is_private:
            return f'http://{address}/'
    return None


def home_view(data, *, now=None):
    """The bounded HomeView wire contract, from the same sampler snapshot as the map."""
    now = time.time() if now is None else now
    snapshot, host = data.get('snapshot') or {}, data.get('host') or {}
    dns, internet = data.get('dns'), data.get('internet') or {}
    router = internet.get('router') or {}
    router_ms = router.get('averageMs') if isinstance(router, dict) else None
    units = host.get('units', [])
    devices = data.get('devices', [])
    online = [device for device in devices if device.get('online')]
    baseline = min((device.get('firstSeen') or now for device in devices), default=now)
    naming = data.get('naming') or {}
    moves = [move for move in naming.get('moves', []) if now - move.get('at', 0) < 7 * 86400][-3:]
    power, attention = power_reading(host)
    backup, peers = data.get('backups'), data.get('peers')
    return {
        'observedAt': data.get('at'),
        'status': {
            'issues': problems(data)[:32],
            'uptimeSeconds': snapshot.get('uptimeSeconds'),
            'servicesRunning': sum(unit['state'] in ('active', 'reloading') for unit in units)
            if units
            else None,
            'servicesTotal': len(units) if units else None,
            'temperatureCelsius': host.get('temperatureCelsius'),
        },
        'internet': {
            'state': ('offline' if internet.get('internetMs') is None else 'connected')
            if internet
            else 'unknown',
            'internetMs': internet.get('internetMs'),
            'routerMs': router_ms,
            'routerDnsMs': internet.get('dnsMs'),
            'encryptedDnsMs': dns.get('upstreamMs') if dns else None,
        },
        'pihole': {
            'blocking': 'enabled' if dns.get('blocking') == 'enabled' else 'paused',
            'pausedSecondsLeft': dns.get('timer'),
            'percentBlocked': dns['percent'],
            'queries': dns['queries'],
            'blocked': dns['blocked'],
            'domainsOnBlocklists': dns['gravity'],
            'activeClients': dns['clients'],
            'hours': [
                {'hourStart': hour * 3600, 'total': total, 'blocked': blocked}
                for hour, (total, blocked) in dns['hours'][-24:]
            ],
            'topBlocked': [{'name': name, 'count': count} for name, count in dns['topBlocked'][:6]],
            'topClients': [{'name': name, 'count': count} for name, count in dns['topClients'][:6]],
        }
        if dns and dns.get('blocking') in ('enabled', 'disabled')
        else None,
        'pi': {
            'temperatureCelsius': host.get('temperatureCelsius'),
            'cpuPercent': host.get('cpuPercent'),
            'load1': host.get('load1'),
            'memoryAvailableBytes': snapshot.get('memoryAvailableBytes'),
            'storageFreeBytes': snapshot.get('storageFreeBytes'),
            'power': {'label': power, 'needsAttention': attention},
            'rebootRequired': bool(host.get('rebootRequired')),
            'temperatureHistory': [list(point) for point in list(_temperatures)[-300:]],
        },
        'services': [
            {
                'name': unit['name'],
                'label': UNIT_LABELS.get(unit['name'], unit['name']),
                'running': unit['state'] in ('active', 'reloading'),
                'state': unit['state'],
            }
            for unit in units[:64]
        ],
        'network': {
            'online': len(online),
            'devices': [
                {
                    'name': device.get('label') or device['ip'],
                    'address': device['ip'],
                    'detail': device['ip']
                    if device.get('label')
                    else (ms(device.get('rttMs')) if device.get('rttMs') else ''),
                    'isNew': (device.get('firstSeen') or 0) > baseline + 86400
                    and now - device['firstSeen'] < 86400,
                    'isUnnamed': device.get('source') == 'unknown',
                    'isAuto': device.get('source') == 'mdns',
                    'presence': [bool(value) for value in (device.get('presence') or [])[-16:]],
                }
                for device in online[:40]
            ],
            'registeredNames': naming.get('registered', 0),
            'moves': [
                {key: move[key] for key in ('name', 'from', 'to', 'at')} for move in reversed(moves)
            ],
        },
        'tailscale': [
            {
                'name': peer['name'],
                'os': peer['os'],
                'online': peer['online'],
                'direct': peer['direct'],
                'lastSeen': peer.get('seen'),
            }
            for peer in peers[:64]
        ]
        if peers is not None
        else None,
        'backups': {
            'latest': {key: backup[key] for key in ('at', 'bytes', 'count')} if backup else None,
            'isFresh': bool(backup) and now - backup['at'] < 36 * 3600,
            'repositories': [
                {key: repo[key] for key in ('name', 'branch', 'at')}
                for repo in (data.get('repos') or [])[:32]
            ],
        },
        'tablet': tablet_view(data, now),
        'links': {'piholeAdmin': '/admin/', 'routerSettings': router_link(devices)},
    }


def installed_version():
    """The version written beside this file when the panel was deployed; None when unknown."""
    try:
        with open(VERSION_FILE, encoding='utf-8') as handle:
            value = handle.read(41).strip()
    except (OSError, ValueError):
        return None
    return value if VERSION.fullmatch(value) else None


def session_view(login, *, automation, updates, version=None, available=None):
    return {
        'login': login,
        'node': socket.gethostname().split('.')[0],
        'actionToken': token(login),
        'version': version,
        'availableVersion': available,
        'features': {'automation': automation, 'storage': True, 'updates': updates},
    }


OFFLINE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0e0e0e">
<title>LEÓN Home</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0e0e0e;color:#eeeae3;
font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px}img{width:64px;height:64px}p{color:#a39e94;max-width:300px}
a{display:inline-block;margin-top:12px;color:#111;background:#eeeae3;border-radius:999px;padding:10px 18px;text-decoration:none}</style></head>
<body><div><img src="/brand/symbol.png" alt=""><h1>Offline · Sin conexión</h1><p>LEÓN Home is unreachable. Connect Tailscale and try again.
Readings are not stored on this phone.</p><p lang="es">No se puede contactar a LEÓN Home. Conecta Tailscale y reintenta.</p><a href="/">Try again · Reintentar</a></div></body></html>""".encode()


def port_action(port, enabled):
    return router_action({'port': port, 'enabled': enabled})


def device_action(mac, blocked):
    return router_action({'device': mac, 'blocked': blocked})


HARDWARE_SOCKET = '/run/leon-hardware/control.sock'
HARDWARE_MAX_REPLY = 32768
HARDWARE_UNITS = frozenset(
    {'pihole-FTL', 'unbound', 'ntfy', 'smbd', 'leon-router', 'leon-n8n', 'leon-overview-redirect'}
)
HARDWARE_ACTIONS = {
    'led': ('led', {'name': ('ACT', 'PWR'), 'mode': ('on', 'off', 'auto')}),
    'led-schedule': ('ledSchedule', {'schedule': None}),
    'ethernet-leds': ('ethernetLeds', {'state': ('on', 'off')}),
    'usb-power': ('usbPower', {'state': ('on', 'off')}),
    'radio': ('radio', {'kind': ('wifi', 'bluetooth'), 'state': ('on', 'off')}),
    'cpu-profile': ('cpuProfile', {'profile': ('balanced', 'powersave', 'performance')}),
    'restart-service': ('restartService', {'unit': HARDWARE_UNITS}),
    'power': ('power', {'action': ('reboot', 'shutdown'), 'confirm': None}),
}
HARDWARE_STATUSES = frozenset({'applied', 'pendingReboot', 'refused', 'unverified', 'invalid'})


def hardware_request(action, body):
    """Defense in depth: independent closed HTTP validation before privileged transport."""
    if action not in HARDWARE_ACTIONS or not isinstance(body, dict):
        raise ValueError('Invalid action')
    command, fields = HARDWARE_ACTIONS[action]
    if set(body) != set(fields):
        raise ValueError('Invalid fields')
    for field, choices in fields.items():
        value = body[field]
        if field == 'schedule':
            if value is not None and (
                not isinstance(value, dict)
                or set(value) != {'start', 'end'}
                or not all(
                    isinstance(part, str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', part)
                    for part in value.values()
                )
            ):
                raise ValueError('Invalid schedule')
        elif not isinstance(value, str) or (
            not 0 < len(value) <= 63 if field == 'confirm' else value not in choices
        ):
            raise ValueError('Invalid value')
    return {'request': command, **body}


def hardware_action(request):
    """A failed connect is unavailable; after sending, missing evidence is unverified."""
    fallback = {'status': 'unverified', 'message': 'Hardware response could not be verified.'}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(30)
        try:
            connection.connect(HARDWARE_SOCKET)
        except OSError:
            return {'status': 'unavailable', 'message': 'Hardware helper is unavailable.'}
        try:
            connection.sendall(json.dumps(request, allow_nan=False).encode())
            connection.shutdown(socket.SHUT_WR)
            raw = bytearray()
            deadline = time.monotonic() + 30
            while len(raw) <= HARDWARE_MAX_REPLY:
                connection.settimeout(max(0.001, deadline - time.monotonic()))
                if time.monotonic() >= deadline:
                    return fallback
                chunk = connection.recv(min(4096, HARDWARE_MAX_REPLY + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            if len(raw) > HARDWARE_MAX_REPLY:
                return fallback
            reply = json.loads(raw)
            if not isinstance(reply, dict) or set(reply) != {'status', 'message', 'state'}:
                return fallback
            if (
                not isinstance(reply['status'], str)
                or reply['status'] not in HARDWARE_STATUSES
                or not isinstance(reply['message'], str)
            ):
                return fallback
            if not valid_hardware_state(reply['state']):
                return fallback
            return {**reply, 'message': reply['message'][:200]}
        except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
            return fallback


def valid_hardware_state(state):
    """Check the root service boundary before merging private presentation data."""

    if isinstance(state, dict) and 'usbPowerNote' in state:
        if state['usbPowerNote'] != 'power returns on at restart':
            return False
        state = {key: value for key, value in state.items() if key != 'usbPowerNote'}

    def switch(value):
        return value in ('on', 'off', 'unknown')

    def number(value):
        return type(value) in (int, float) and math.isfinite(value) and value >= 0

    def nullable_number(value):
        return value is None or number(value)

    def text(value):
        return isinstance(value, str) and len(value) <= 200

    def record(value, fields):
        return (
            isinstance(value, dict)
            and set(value) == set(fields)
            and all(check(value[key]) for key, check in fields.items())
        )

    def rows(value, maximum, check):
        return (
            isinstance(value, list) and len(value) <= maximum and all(check(row) for row in value)
        )

    try:
        return record(
            state,
            {
                'observedAt': number,
                'leds': lambda value: (
                    rows(
                        value,
                        2,
                        lambda row: record(
                            row,
                            {
                                'name': lambda name: name in ('ACT', 'PWR'),
                                'mode': lambda mode: mode in ('on', 'off', 'auto', 'unknown'),
                            },
                        ),
                    )
                    and {row['name'] for row in value} == {'ACT', 'PWR'}
                ),
                'ledSchedule': lambda value: (
                    value is None
                    or record(
                        value,
                        {
                            'start': lambda part: (
                                isinstance(part, str)
                                and bool(re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', part))
                            ),
                            'end': lambda part: (
                                isinstance(part, str)
                                and bool(re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', part))
                            ),
                        },
                    )
                ),
                'ethernetLeds': lambda value: record(
                    value, {'configured': switch, 'pendingReboot': lambda part: type(part) is bool}
                ),
                'usb': lambda value: record(
                    value,
                    {
                        'isSupported': lambda part: type(part) is bool,
                        'power': switch,
                        'devices': lambda devices: rows(
                            devices,
                            16,
                            lambda row: record(
                                row,
                                {
                                    'name': text,
                                    'isStorage': lambda part: type(part) is bool,
                                    'isMounted': lambda part: type(part) is bool,
                                },
                            ),
                        ),
                        'powerOffBlockedBy': lambda part: part is None or text(part),
                    },
                ),
                'radios': lambda value: rows(
                    value,
                    2,
                    lambda row: record(
                        row,
                        {
                            'kind': lambda part: part in ('wifi', 'bluetooth'),
                            'state': switch,
                            'isHardBlocked': lambda part: type(part) is bool,
                            'isUplink': lambda part: type(part) is bool,
                        },
                    ),
                ),
                'cpu': lambda value: record(
                    value,
                    {
                        'profile': lambda part: (
                            part in ('balanced', 'powersave', 'performance', 'custom', 'unknown')
                        ),
                        'governor': lambda part: part is None or text(part),
                        'frequencyMhz': nullable_number,
                    },
                ),
                'services': lambda value: rows(
                    value,
                    len(HARDWARE_UNITS),
                    lambda row: record(
                        row,
                        {'unit': lambda part: part in HARDWARE_UNITS, 'label': text, 'state': text},
                    ),
                ),
                'power': lambda value: record(value, {'rebootAllowedAt': nullable_number}),
            },
        )
    except (TypeError, ValueError, OverflowError):
        return False


def hardware_view(data, *, helper_reply=None, now=None):
    now = time.time() if now is None else now
    reply = hardware_action({'request': 'state'}) if helper_reply is None else helper_reply
    state = reply.get('state') if reply.get('status') == 'applied' else None
    available = valid_hardware_state(state)
    host, snapshot = data.get('host') or {}, data.get('snapshot') or {}
    flags = host.get('throttledFlags')
    names = ('underVoltage', 'frequencyCapped', 'throttled', 'softTemperatureLimit')
    throttling = (
        None
        if type(flags) is not int
        else {
            period: {
                name: bool(flags & (1 << (index + offset))) for index, name in enumerate(names)
            }
            for period, offset in (('now', 0), ('sinceBoot', 16))
        }
    )
    board = None
    try:
        with open('/proc/device-tree/model', 'rb') as stream:
            raw = stream.read(257)
        if len(raw) <= 256:
            board = raw.decode('utf-8').strip('\x00\n') or None
    except (OSError, UnicodeError):
        pass
    fallback = {
        'observedAt': now,
        'leds': [],
        'ledSchedule': None,
        'ethernetLeds': {'configured': 'unknown', 'pendingReboot': False},
        'usb': {'isSupported': False, 'power': 'unknown', 'devices': [], 'powerOffBlockedBy': None},
        'radios': [],
        'cpu': {'profile': 'unknown', 'governor': None, 'frequencyMhz': None},
        'services': [
            {
                'unit': row['name'],
                'label': UNIT_LABELS.get(row['name'], row['name']),
                'state': row.get('state', 'unknown'),
            }
            for row in host.get('units', [])
            if row.get('name') in HARDWARE_UNITS
        ][: len(HARDWARE_UNITS)],
        'power': {'rebootAllowedAt': None},
    }
    controls = {key: state[key] for key in fallback} if available else fallback
    controls['services'] = [
        {**row, 'label': UNIT_LABELS.get(row['unit'], row['unit'])} for row in controls['services']
    ]
    return {
        **controls,
        'helper': 'available' if available else 'unavailable',
        'board': board,
        'readings': {
            'uptimeSeconds': snapshot.get('uptimeSeconds'),
            'temperatureCelsius': host.get('temperatureCelsius'),
            'cpuPercent': host.get('cpuPercent'),
            'memoryAvailableBytes': snapshot.get('memoryAvailableBytes'),
            'storageFreeBytes': snapshot.get('storageFreeBytes'),
            'throttling': throttling,
        },
        'power': {**controls['power'], 'rebootRequired': bool(host.get('rebootRequired'))},
    }


def router_action(request):
    """Forward one closed request to the monitor; its answer is the only success signal."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        # Monitor worst case: token + two reads (6 s each), 20 s write, 3 s wait, verify read (6 s),
        # then a full post-change reading (5 reads) saved before it answers.
        connection.settimeout(90)
        connection.connect(ROUTER_CONTROL_SOCKET)  # failing here means nothing was sent
        try:
            connection.sendall(json.dumps(request).encode())
            connection.shutdown(socket.SHUT_WR)
            raw = connection.recv(257)
            status = json.loads(raw).get('status') if len(raw) <= 256 else None
        except (OSError, ValueError, AttributeError):
            return 'unverified'  # the monitor may still apply a request it already received
    return status if status in PORT_OUTCOMES else 'unverified'


def router_unlock(request):
    """Forward the owner's vault phrase once; the monitor decrypts its vault copy. With a router
    password the monitor connects and keeps it on this Pi. Never logged or kept here."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(60)  # vault scrypt on the Pi (~8 s), router login and first reads
        connection.connect(ROUTER_UNLOCK_SOCKET)
        try:
            connection.sendall(json.dumps(request).encode())
            connection.shutdown(socket.SHUT_WR)
            raw = connection.recv(257)
            status = json.loads(raw).get('status') if len(raw) <= 256 else None
        except (OSError, ValueError, AttributeError):
            return 'unlockFailed'
    return status if status in UNLOCK_OUTCOMES else 'unlockFailed'


STORAGE_MOUNT = '/srv/leon-storage'


def usb_storage_view():
    try:
        result = subprocess.run(
            # Fixed system tool from the service PATH; executable is not supplied by a request.
            [  # noqa: S607
                'lsblk',
                '--json',
                '--bytes',
                '--output',
                'NAME,TYPE,TRAN,MODEL,SIZE,FSTYPE,MOUNTPOINTS',
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
        devices = json.loads(result.stdout)['blockdevices']
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return {'isAvailable': False, 'volumes': []}

    rows = []
    for disk in devices:
        if disk.get('type') != 'disk' or disk.get('tran') != 'usb':
            continue
        volumes = [disk, *disk.get('children', [])]
        for volume in volumes:
            mounts = [mount for mount in volume.get('mountpoints') or [] if mount]
            if volume is disk:
                name = (disk.get('model') or '').strip() or disk['name']
            else:
                name = volume['name']
            details = [size(volume.get('size')), volume.get('fstype'), ', '.join(mounts)]
            rows.append(
                {
                    'name': name,
                    'detail': ' · '.join(filter(None, details)),
                    'isMounted': bool(mounts),
                }
            )
            if len(rows) == 24:
                return {'isAvailable': True, 'volumes': rows}
    return {'isAvailable': True, 'volumes': rows}


def storage_is_usb():
    """Whether STORAGE_MOUNT is a partition of a USB disk (the only kind the panel can eject)."""
    try:
        result = subprocess.run(
            # Fixed system tool from the service PATH; executable is not supplied by a request.
            ['lsblk', '--json', '--output', 'TYPE,TRAN,MOUNTPOINTS'],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
        devices = json.loads(result.stdout)['blockdevices']
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return False
    return any(
        disk.get('type') == 'disk'
        and disk.get('tran') == 'usb'
        and any(
            STORAGE_MOUNT in (volume.get('mountpoints') or [])
            for volume in [disk, *disk.get('children', [])]
        )
        for disk in devices
    )


SAMBA_CONFIG = '/etc/samba/smb.conf'
MINIDLNA_CONFIG = '/etc/minidlna.conf'
GERBERA_CONFIG = '/etc/gerbera/config.xml'
GERBERA_NAME = re.compile(r'<name>([^<]{1,200})</name>')
# Optional, administrator-written: {"name": "...", "peers": [{"name": "...", "url": "smb://..."}]}
STORAGE_SETTINGS = '/etc/leon-overview/storage.json'
DRIVE_NAME = re.compile(r'[^\x00-\x1f\x7f]{1,40}')
# storage.json "movies": a movie library below /srv, e.g. another home's share mounted read-only.
MOVIES_PATH = re.compile(r'/srv(/[A-Za-z0-9 _.()-]{1,80}){1,4}')
PEER_URL = re.compile(r'smb://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9 _.-]{1,80})?')
SHARE_NAME = re.compile(r'[A-Za-z0-9 _.-]{1,40}')
# Optional, administrator-written, root:leon-overview 0640. Only accounts the panel owner may use:
# {"accounts": [{"drive": "...", "user": "...", "password": "...", "canWrite": false}]}
STORAGE_ACCOUNTS = '/etc/leon-overview/storage-accounts.json'
ACCOUNT_USER = re.compile(r'[a-z_][a-z0-9_-]{0,31}')
ACCOUNT_PASSWORD = re.compile(r'[^\x00-\x1f\x7f]{1,128}')


def storage_settings():
    """Validated drive name and peer drives; malformed entries are ignored, never rendered."""
    try:
        with open(STORAGE_SETTINGS, encoding='utf-8') as handle:
            value = json.loads(handle.read(8193)[:8192])
    except (OSError, ValueError):
        return {'name': None, 'peers': []}
    if not isinstance(value, dict):
        return {'name': None, 'peers': []}
    name = value.get('name')
    peers = [
        {'name': peer['name'], 'url': peer['url']}
        for peer in (value.get('peers') if isinstance(value.get('peers'), list) else [])[:4]
        if isinstance(peer, dict)
        and isinstance(peer.get('name'), str)
        and DRIVE_NAME.fullmatch(peer['name'])
        and isinstance(peer.get('url'), str)
        and PEER_URL.fullmatch(peer['url'])
    ]
    movies = value.get('movies')
    return {
        'name': name if isinstance(name, str) and DRIVE_NAME.fullmatch(name) else None,
        'peers': peers,
        'movies': movies
        if isinstance(movies, str)
        and MOVIES_PATH.fullmatch(movies)
        and '..' not in movies.split('/')
        else None,
    }


def storage_accounts():
    """Validated sign-ins for the drives; a file other users can read is refused."""
    try:
        with open(STORAGE_ACCOUNTS, encoding='utf-8') as handle:
            if os.fstat(handle.fileno()).st_mode & 0o007:
                print('storage accounts ignored: file is open to other users', file=sys.stderr)
                return []
            value = json.loads(handle.read(8193)[:8192])
    except (OSError, ValueError, RecursionError):
        return []
    rows = value.get('accounts') if isinstance(value, dict) else None
    return [
        {
            'drive': row['drive'],
            'user': row['user'],
            'password': row['password'],
            'canWrite': row.get('canWrite') is True,
        }
        for row in (rows if isinstance(rows, list) else [])[:8]
        if isinstance(row, dict)
        and isinstance(row.get('drive'), str)
        and DRIVE_NAME.fullmatch(row['drive'])
        and isinstance(row.get('user'), str)
        and ACCOUNT_USER.fullmatch(row['user'])
        and isinstance(row.get('password'), str)
        and ACCOUNT_PASSWORD.fullmatch(row['password'])
    ]


def samba_shares():
    """(shares as (name, path), home address or None) from the installed Samba configuration."""
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        with open(SAMBA_CONFIG, encoding='utf-8') as handle:
            parser.read_string(handle.read(65_536))
    except (OSError, ValueError, configparser.Error):
        return None, None
    shares = [
        (name, parser[name]['path'])
        for name in parser.sections()
        if name.lower() not in ('global', 'homes', 'printers', 'print$')
        and SHARE_NAME.fullmatch(name)
        and parser[name].get('path', '').startswith(STORAGE_MOUNT)
    ][:8]
    home = None
    for item in parser['global'].get('interfaces', '').split() if 'global' in parser else []:
        try:
            address = ipaddress.ip_interface(item).ip
        except ValueError:
            continue
        if address.version == 4 and address.is_private and not address.is_loopback:
            home = str(address)
    return shares, home


def tailscale_address():
    try:
        result = subprocess.run(
            # Fixed runtime tool from the service PATH; callers cannot select an executable.
            ['tailscale', 'ip', '-4'],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
        return str(ipaddress.IPv4Address(result.stdout.split()[0]))
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def minidlna_name(text):
    names = [
        line.partition('=')[2].strip()
        for line in text.splitlines()
        if line.startswith('friendly_name=')
    ]
    return names[-1] if names else ''


def gerbera_name(text):
    # The first <name> in Gerbera's configuration is the server's own name.
    match = GERBERA_NAME.search(text)
    return html.unescape(match[1]).strip() if match else ''


def tv_server_name():
    """The DLNA name TVs show, when a media server is configured and running."""
    for service, path, parse in (
        ('gerbera', GERBERA_CONFIG, gerbera_name),
        ('minidlna', MINIDLNA_CONFIG, minidlna_name),
    ):
        try:
            with open(path, encoding='utf-8') as handle:
                text = handle.read(65_536)
            active = subprocess.run(
                # Fixed runtime tool and service name; callers cannot select an executable.
                ['systemctl', 'is-active', '--quiet', service],  # noqa: S607
                timeout=2,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if active.returncode == 0:
            return parse(text)[:60] or 'Media server'
    return None


HOST_MOUNTS = '/proc/1/mountinfo'


def host_read_only():
    """Whether the host mounted the volume read-only, or None if unknown.

    The panel's own sandbox sees /srv read-only, so its statvfs cannot answer this.
    """
    try:
        with open(HOST_MOUNTS, encoding='utf-8') as handle:
            lines = handle.read(1_048_576).splitlines()
    except OSError:
        return None
    for line in lines:
        fields = line.split(' ')
        if len(fields) > 6 and fields[4] == STORAGE_MOUNT and ' - ' in line:
            super_options = line.rsplit(' - ', 1)[1].split(' ')[-1]
            options = set(fields[5].split(',')) | set(super_options.split(','))
            return 'ro' in options
    return None


def mounted_volume():
    """Label, filesystem and read-only state of the managed volume, or None when unmounted."""
    if not os.path.ismount(STORAGE_MOUNT):
        return None
    try:
        usage = shutil.disk_usage(STORAGE_MOUNT)
    except OSError:
        return None
    label = filesystem = None
    try:
        result = subprocess.run(
            # Fixed system tool from the service PATH; executable is not supplied by a request.
            ['findmnt', '--json', '--output', 'LABEL,FSTYPE', '--mountpoint', STORAGE_MOUNT],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )
        found = json.loads(result.stdout)['filesystems'][0]
        label, filesystem = found.get('label'), found.get('fstype')
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        pass
    return {
        'total': usage.total,
        'free': usage.free,
        'label': label,
        'filesystem': filesystem,
        'readOnly': host_read_only(),
    }


def storage_destinations(mounted, show_automation, shares):
    destinations = [(name, path) for name, path in shares or []]
    if show_automation:
        destinations.append(('n8n data', os.path.join(STORAGE_MOUNT, 'n8n')))

    rows = []
    for name, path in destinations:
        ready = None
        status = 'Volume not mounted'
        if mounted:
            try:
                ready = stat.S_ISDIR(os.stat(path, follow_symlinks=False).st_mode)
                status = 'Folder present' if ready else 'Expected a directory'
            except FileNotFoundError:
                status = 'Folder not created'
            except OSError:
                status = 'Folder status unavailable'
        rows.append(
            {
                'name': name,
                'path': path,
                'status': status,
                'tone': 'good' if ready is True else 'warn' if ready is False else 'unknown',
            }
        )
    return rows[:9]


def storage_view(*, show_automation=True):
    settings = storage_settings()
    volume = mounted_volume()
    shares, home = samba_shares()
    tailnet_address = tailscale_address() if shares else None
    first = shares[0][0] if shares else None
    open_url = None
    if isinstance(first, str) and SHARE_NAME.fullmatch(first):
        for candidate in (tailnet_address, home):
            try:
                address = (
                    str(ipaddress.IPv4Address(candidate)) if isinstance(candidate, str) else None
                )
            except ValueError:
                continue
            if address:
                open_url = f'smb://{address}/{first}'
                break
    connections = []
    if first:
        local = socket.gethostname().split('.')[0] + '.local'
        if home:
            connections.extend(
                [
                    {
                        'platform': 'Mac at home',
                        'address': f'smb://{local}/{first}',
                        'note': 'Finder → Go → Connect',
                    },
                    {
                        'platform': 'Windows at home',
                        'address': '\\\\' + home + '\\' + first,
                        'note': 'On your home network, paste this into the File Explorer address bar.',
                    },
                    {
                        'platform': 'Any device at home',
                        'address': f'smb://{home}/{first}',
                        'note': 'Home Wi-Fi',
                    },
                ]
            )
        if tailnet_address:
            connections.append(
                {
                    'platform': 'Windows away from home',
                    'address': '\\\\' + tailnet_address + '\\' + first,
                    'note': 'Connect Tailscale on the PC, then paste this into the File Explorer address bar.',
                }
            )
            connections.append(
                {
                    'platform': 'Anywhere with Tailscale',
                    'address': f'smb://{tailnet_address}/{first}',
                    'note': 'iPhone Files → Connect to Server',
                }
            )
    return {
        'drive': {
            'name': settings['name'] or (volume or {}).get('label') or 'My drive',
            'isMounted': volume is not None,
            'totalBytes': (volume or {}).get('total'),
            'freeBytes': (volume or {}).get('free'),
            'label': (volume or {}).get('label'),
            'filesystem': (volume or {}).get('filesystem'),
            'isReadOnly': (volume or {}).get('readOnly'),
            'openUrl': open_url,
            'canEject': volume is not None and os.path.isfile(EJECT_SERVICE) and storage_is_usb(),
        },
        'peers': settings['peers'],
        'connections': connections[:5],
        'isSharingSetUp': bool(shares),
        'accounts': [
            {key: account[key] for key in ('drive', 'user', 'canWrite')}
            for account in storage_accounts()
        ],
        'tvServerName': tv_server_name(),
        'folders': storage_destinations(bool(volume), show_automation, shares),
        'usbDrives': usb_storage_view(),
    }


# Read-only file browser over the mounted shared volume. Never falls back to the system disk.
HIDDEN_ENTRIES = frozenset(
    {
        '$RECYCLE.BIN',
        'System Volume Information',
        '$TXRAJNL.DAT',
        'lost+found',
    }
)
MAX_LISTED = 500
SEARCH_LIMITS = {'results': 200, 'visited': 20_000, 'depth': 8, 'seconds': 3.0}
# Types Safari can show or play in place; everything else downloads.
INLINE_TYPES = frozenset(
    {
        'video/mp4',
        'video/quicktime',
        'video/x-m4v',
        'audio/mpeg',
        'audio/mp4',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/heic',
        'application/pdf',
    }
)
RANGE = re.compile(r'bytes=(\d{0,15})-(\d{0,15})')
# Movie library: one `Title (Year)` folder per movie inside MOVIE_FOLDER, posters as folder.jpg
# (sharing/storage/library.py names uploads and adds posters, and writes LIBRARY_STATE).
MOVIE_FOLDER = 'PELICULAS'
MOVIE_NAME = re.compile(r'(.+?) \(((?:18|19|20)\d{2})\)')
MOVIE_VIDEOS = frozenset({'mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'ts', 'wmv', 'mpg', 'mpeg'})
INLINE_VIDEOS = frozenset({'mp4', 'm4v', 'mov'})
MAX_MOVIES = 2000
MAX_MOVIE_FILES = 100
MAX_POSTER_BYTES = 2_000_000
MOVIE_SCAN_SECONDS = 6  # the phone gives up after 8 s
MOVIE_LOCAL_CACHE_SECONDS = 30
MOVIE_NETWORK_CACHE_SECONDS = 600
# Root eject service (sharing/storage/eject.sh, started by leon-storage-eject.path): the panel
# creates EJECT_REQUEST in its own state directory and the service answers in EJECT_RESULT.
EJECT_SERVICE = '/usr/local/lib/leon-storage/eject.sh'
EJECT_REQUEST = '/var/lib/leon-overview/eject-request'
EJECT_RESULT = '/var/lib/leon-overview/eject-result'
EJECT_SECONDS = 45
EJECT_STATUSES = frozenset({'ejected', 'busy', 'notMounted', 'unavailable', 'failed'})
LIBRARY_STATE = '/var/lib/leon-storage/library.json'
CHUNK = 1 << 20


def visible(name):
    return not name.startswith('.') and name not in HIDDEN_ENTRIES


def storage_path(relative):
    """Resolve a client path inside the mounted volume, or None. Symlinks never escape it."""
    if not os.path.ismount(STORAGE_MOUNT) or len(relative) > 1024 or '\0' in relative:
        return None
    parts = [part for part in relative.split('/') if part]
    if any(part in ('.', '..') or not visible(part) for part in parts):
        return None
    root = os.path.realpath(STORAGE_MOUNT)
    target = os.path.realpath(os.path.join(root, *parts))
    if os.path.commonpath([root, target]) != root:
        return None
    return target, '/'.join(parts)


def directory_entries(target, relative):
    try:
        with os.scandir(target) as entries:
            listed = []
            for entry in entries:
                if visible(entry.name) and not entry.is_symlink():
                    listed.append(entry)
                if len(listed) > MAX_LISTED:
                    break
    except OSError:
        raise FileNotFoundError(target) from None
    truncated = len(listed) > MAX_LISTED
    rows = []
    for entry in sorted(
        listed[:MAX_LISTED], key=lambda item: (not item.is_dir(), item.name.casefold())
    ):
        child = f'{relative}/{entry.name}' if relative else entry.name
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        is_directory = stat.S_ISDIR(info.st_mode)
        if not is_directory and not stat.S_ISREG(info.st_mode):
            continue
        modified = time.strftime('%Y-%m-%d', time.localtime(info.st_mtime))
        detail = modified if is_directory else f'{size(info.st_size)} · {modified}'
        rows.append(file_entry(child, entry.name, is_directory, detail, info))
    return rows, truncated


def search_entries(target, relative, query):
    """Bounded case-insensitive name search below the current folder."""
    needle = query.casefold()
    deadline = time.monotonic() + SEARCH_LIMITS['seconds']
    rows, visited, complete = [], 0, True
    scanned = 0
    pending = collections.deque([(target, relative, 0)])
    while pending:
        folder, prefix, depth = pending.popleft()
        try:
            with os.scandir(folder) as entries:
                children = []
                for item in entries:
                    scanned += 1
                    if time.monotonic() > deadline or scanned > SEARCH_LIMITS['visited']:
                        complete = False
                        break
                    if visible(item.name) and not item.is_symlink():
                        children.append(item)
        except OSError:
            if folder == target:
                raise
            continue
        for entry in sorted(children, key=lambda item: item.name.casefold()):
            visited += 1
            if (
                len(rows) >= SEARCH_LIMITS['results']
                or visited > SEARCH_LIMITS['visited']
                or time.monotonic() > deadline
            ):
                return rows, False
            child = f'{prefix}/{entry.name}' if prefix else entry.name
            try:
                info = entry.stat(follow_symlinks=False)
                is_directory = stat.S_ISDIR(info.st_mode)
                if not is_directory and not stat.S_ISREG(info.st_mode):
                    continue
            except OSError:
                continue
            if needle in entry.name.casefold():
                rows.append(
                    file_entry(child, entry.name, is_directory, prefix or 'Top folder', info)
                )
            if is_directory:
                if depth + 1 < SEARCH_LIMITS['depth']:
                    pending.append((entry.path, child, depth + 1))
                else:
                    complete = False
    return rows, complete


def file_entry(path, name, is_directory, detail, info):
    return {
        'name': name,
        'path': path,
        'isDirectory': is_directory,
        'detail': detail,
        'sizeBytes': None if is_directory else info.st_size,
        'modifiedAt': info.st_mtime,
    }


def movie_row(entry):
    """One movie folder as the app shows it, or None when it is not a `Title (Year)` folder."""
    match = MOVIE_NAME.fullmatch(entry.name)
    if not match or entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
        return None
    has_poster, best = False, None
    try:
        with os.scandir(entry.path) as files:
            for index, item in enumerate(files):
                if index >= MAX_MOVIE_FILES:
                    break
                if item.is_symlink() or not item.is_file(follow_symlinks=False):
                    continue
                if item.name == 'folder.jpg':
                    has_poster = True
                elif visible(item.name) and item.name.rpartition('.')[2].lower() in MOVIE_VIDEOS:
                    length = item.stat(follow_symlinks=False).st_size
                    if best is None or length > best[1]:
                        best = (item.name, length)
        added = entry.stat(follow_symlinks=False).st_mtime
    except OSError:
        return None
    movie_id = urllib.parse.quote(entry.name, safe='')
    return {
        'id': entry.name,
        'title': match[1],
        'year': int(match[2]),
        'posterUrl': f'/storage/poster?movie={movie_id}' if has_poster else None,
        'videoUrl': f'/storage/movie-video?movie={movie_id}' if best else None,
        'canPlayInline': bool(best) and best[0].rpartition('.')[2].lower() in INLINE_VIDEOS,
        'sizeBytes': best[1] if best else None,
        'addedAt': added,
    }


def library_state():
    """The organizer's last pass: ({at, renamed, covers} | None, review rows), bounded and type-checked."""
    try:
        with open(LIBRARY_STATE, encoding='utf-8') as handle:
            state = json.loads(handle.read(262_144))
    except (OSError, ValueError):
        return None, []
    if not isinstance(state, dict):
        return None, []
    counts = [state.get(key) for key in ('at', 'renamed', 'covers')]
    last_run = (
        dict(zip(('at', 'renamed', 'covers'), counts, strict=True))
        if all(
            isinstance(value, int) and not isinstance(value, bool) and value >= 0
            for value in counts
        )
        else None
    )
    review = []
    for item in state.get('review') if isinstance(state.get('review'), list) else []:
        if len(review) >= 50:
            break
        if (
            not isinstance(item, dict)
            or not isinstance(item.get('name'), str)
            or not isinstance(item.get('reason'), str)
        ):
            continue
        suggestion = item.get('suggestion')
        review.append(
            {
                'name': item['name'][:255],
                'reason': item['reason'][:200],
                'suggestion': suggestion[:255] if isinstance(suggestion, str) else None,
            }
        )
    return last_run, review


def movie_library():
    """The movie folder: storage.json "movies", else MOVIE_FOLDER on this Pi's drive."""
    return storage_settings().get('movies') or os.path.join(STORAGE_MOUNT, MOVIE_FOLDER)


def scan_movies(root):
    """Movie rows of a library folder, or None when it is not available."""
    if root.startswith(STORAGE_MOUNT + '/') and not os.path.ismount(STORAGE_MOUNT):
        return None
    if os.path.islink(root) or not os.path.isdir(root):
        return None
    movies = []
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if len(movies) >= MAX_MOVIES:
                    break
                row = visible(entry.name) and movie_row(entry)
                if row:
                    movies.append(row)
    except OSError:
        return None
    movies.sort(key=lambda movie: (sort_key(movie['title']), movie['year']))
    return movies


_movie_scan = threading.Lock()
_movie_cache = {}  # library root -> (monotonic time, movie rows or None)


def is_local_library(root):
    return root.startswith(STORAGE_MOUNT + '/')


def refresh_movies(root):
    """Scan one library into the cache; a scan already in progress (possibly stuck) is not repeated."""
    if not _movie_scan.acquire(blocking=False):
        return
    try:
        _movie_cache[root] = (time.monotonic(), scan_movies(root))
    finally:
        _movie_scan.release()


def keep_movies_warm():
    """Background refresh, so a slow network library answers from cache instead of making the phone wait."""
    while True:
        refresh_movies(movie_library())
        time.sleep(MOVIE_NETWORK_CACHE_SECONDS - 60)


def movies_view():
    """The library for the app. Results are cached (a network library takes seconds to list),
    and a library that stops answering never blocks the panel longer than MOVIE_SCAN_SECONDS."""
    root = movie_library()
    last_run, review = library_state()
    if is_local_library(root) and not os.path.ismount(STORAGE_MOUNT):
        cached = (0, None)
    else:
        cached = _movie_cache.get(root)
        maximum_age = (
            MOVIE_LOCAL_CACHE_SECONDS if is_local_library(root) else MOVIE_NETWORK_CACHE_SECONDS
        )
        if cached is None or time.monotonic() - cached[0] > maximum_age:
            worker = threading.Thread(target=refresh_movies, args=(root,), daemon=True)
            worker.start()
            # Without a cached list, wait for this scan or for the warm-up scan already running.
            deadline = time.monotonic() + MOVIE_SCAN_SECONDS
            while cached is None and root not in _movie_cache and time.monotonic() < deadline:
                time.sleep(0.1)
            cached = _movie_cache.get(root, cached)
    movies = cached[1] if cached else None
    return {
        'isAvailable': movies is not None,
        'folder': os.path.basename(root),
        'movies': movies or [],
        'review': review if movies is not None else [],
        'lastRun': last_run,
    }


def sort_key(title):
    """Alphabetical order that ignores case and accents (Á sorts with A)."""
    folded = unicodedata.normalize('NFKD', title.casefold())
    return ''.join(character for character in folded if not unicodedata.combining(character))


def eject_drive():
    """Ask the root eject service to stop the drive's services, unmount and power it off."""
    if not os.path.isfile(EJECT_SERVICE):
        return {'status': 'unavailable', 'message': 'Ejecting is not set up on this LEÓN Home.'}
    if not os.path.ismount(STORAGE_MOUNT):
        return {'status': 'notMounted', 'message': 'The drive is not connected.'}
    request, result = EJECT_REQUEST, EJECT_RESULT
    try:
        os.remove(result)
    except FileNotFoundError:
        pass
    except OSError:
        return {'status': 'failed', 'message': 'The drive could not be ejected.'}
    try:
        os.close(os.open(request, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640))
    except FileExistsError:
        return {'status': 'busy', 'message': 'The drive is already being ejected.'}
    except OSError:
        return {'status': 'failed', 'message': 'The drive could not be ejected.'}
    deadline = time.monotonic() + EJECT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(0.5)
        try:
            with open(result, encoding='utf-8') as handle:
                answer = json.loads(handle.read(1024))
        except (OSError, ValueError):
            continue
        if (
            isinstance(answer, dict)
            and answer.get('status') in EJECT_STATUSES
            and isinstance(answer.get('message'), str)
        ):
            return {'status': answer['status'], 'message': answer['message'][:200]}
    return {'status': 'failed', 'message': 'The drive could not be ejected.'}


def movie_folder(movie_id):
    """The real path of one `Title (Year)` folder inside the movie library, or None."""
    if (
        len(movie_id) > 255
        or '/' in movie_id
        or not visible(movie_id)
        or not MOVIE_NAME.fullmatch(movie_id)
    ):
        return None
    root = os.path.realpath(movie_library())
    if root.startswith(STORAGE_MOUNT + '/') and not os.path.ismount(STORAGE_MOUNT):
        return None
    folder = os.path.realpath(os.path.join(root, movie_id))
    if os.path.dirname(folder) != root or not os.path.isdir(folder):
        return None
    return folder


def poster_path(movie_id):
    """The folder.jpg of one movie folder inside the movie library, or None."""
    folder = movie_folder(movie_id)
    path = folder and os.path.join(folder, 'folder.jpg')
    return path if path and os.path.isfile(path) and not os.path.islink(path) else None


def movie_video_path(movie_id):
    """The largest video file of one movie folder, or None."""
    folder = movie_folder(movie_id)
    if folder is None:
        return None
    best = None
    try:
        with os.scandir(folder) as files:
            for index, item in enumerate(files):
                if index >= MAX_MOVIE_FILES:
                    break
                if (
                    item.is_file(follow_symlinks=False)
                    and visible(item.name)
                    and item.name.rpartition('.')[2].lower() in MOVIE_VIDEOS
                ):
                    length = item.stat(follow_symlinks=False).st_size
                    if best is None or length > best[1]:
                        best = (item.path, length)
    except OSError:
        return None
    return best[0] if best else None


def files_view(relative, query=''):
    resolved = storage_path(relative)
    if resolved is None or not os.path.isdir(resolved[0]):
        raise FileNotFoundError('Folder unavailable or drive not mounted')
    target, relative = resolved
    candidate = STORAGE_MOUNT
    for part in relative.split('/') if relative else []:
        candidate = os.path.join(candidate, part)
        if os.path.islink(candidate):
            raise FileNotFoundError('Folder unavailable or drive not mounted')
    query = query.strip()[:80]
    if query:
        entries, complete = search_entries(target, relative, query)
        title, meta = 'Search results', '' if complete else 'Partial results; refine the search'
    else:
        entries, truncated = directory_entries(target, relative)
        title = relative.rsplit('/', 1)[-1] if relative else 'Drive'
        meta = f'First {MAX_LISTED} items' if truncated else ''
    return {'path': relative, 'query': query, 'title': title, 'meta': meta, 'entries': entries}


def byte_range(header, length):
    """(start, end) for one satisfiable range, None for the whole file, False if unsatisfiable."""
    if not header:
        return None
    match = RANGE.fullmatch(header.strip())
    if not match or not (match[1] or match[2]) or length == 0:
        return False
    if match[1]:
        start = int(match[1])
        end = min(int(match[2]), length - 1) if match[2] else length - 1
    else:
        start, end = max(length - int(match[2]), 0), length - 1
    return (start, end) if start <= end and start < length else False


N8N_PANEL_CONFIG = '/etc/leon-overview/n8n-panel.json'
N8N_PANEL_STATE = os.path.join(os.path.dirname(STATE), 'n8n-panel.json')
N8N_KEY = re.compile(r'[A-Za-z0-9_.-]{1,4096}')
N8N_ID = re.compile(r'[A-Za-z0-9_-]{1,80}')
N8N_EDITOR = re.compile(r'https://[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?::[0-9]{1,5})?/?')
EXECUTION_STATES = {
    'success': ('Succeeded', True),
    'error': ('Failed', False),
    'crashed': ('Crashed', False),
    'running': ('Running', None),
    'waiting': ('Waiting', None),
    'canceled': ('Canceled', None),
    'new': ('Queued', None),
}


def n8n_get(path, api_key=None):
    connection = http.client.HTTPConnection('127.0.0.1', 5678, timeout=2)
    try:
        headers = {'X-N8N-API-KEY': api_key} if api_key else {}
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        if response.status != 200:
            return None
        raw = response.read(131_073)
        return json.loads(raw) if len(raw) <= 131_072 else None
    except (ValueError, OSError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def n8n_panel_config():
    config = {}
    for path in (N8N_PANEL_CONFIG, N8N_PANEL_STATE):
        values = json_file(path, 8192)
        if isinstance(values, dict):
            config.update(values)
    return config


def n8n_rows(response):
    if not isinstance(response, dict) or not isinstance(response.get('data'), list):
        return None
    return [item for item in response['data'][:12] if isinstance(item, dict)]


def n8n_data(config):
    key = config.get('apiKey')
    if not isinstance(key, str) or not N8N_KEY.fullmatch(key):
        return None, None
    workflows = n8n_rows(n8n_get('/api/v1/workflows?limit=12', key))
    workflow_id = config.get('workflowId')
    if workflows is None and isinstance(workflow_id, str) and N8N_ID.fullmatch(workflow_id):
        workflow = n8n_get(f'/api/v1/workflows/{workflow_id}', key)
        workflows = [{**workflow, 'id': workflow_id}] if isinstance(workflow, dict) else None
        if workflows is not None:
            recent = n8n_get(
                f'/api/v1/executions?workflowId={workflow_id}&limit=12&includeData=false', key
            )
            return workflows, n8n_rows(recent)
    recent = n8n_get('/api/v1/executions?limit=12&includeData=false', key)
    return workflows, n8n_rows(recent)


def save_automation_settings(api_key, editor_url):
    status = 'invalid'
    config = n8n_panel_config()
    key = api_key.strip() or config.get('apiKey')
    editor = editor_url.strip()
    if not isinstance(key, str) or not N8N_KEY.fullmatch(key):
        message = 'Enter an n8n API key.'
    elif editor and (len(editor) > 253 or not N8N_EDITOR.fullmatch(editor)):
        message = 'Use the HTTPS address ending in ts.net for the editor.'
    elif (
        n8n_rows(n8n_get('/api/v1/workflows?limit=1', key)) is None
        or n8n_rows(n8n_get('/api/v1/executions?limit=1&includeData=false', key)) is None
    ):
        status = 'refused'
        message = 'Check that n8n is running and the key can list workflows and executions.'
    else:
        try:
            with tempfile.NamedTemporaryFile(
                mode='w', dir=os.path.dirname(N8N_PANEL_STATE), delete=False
            ) as draft:
                try:
                    json.dump({'apiKey': key, 'editorUrl': editor}, draft)
                    draft.flush()
                    os.fsync(draft.fileno())
                    os.replace(draft.name, N8N_PANEL_STATE)
                finally:
                    if os.path.exists(draft.name):
                        os.unlink(draft.name)
        except OSError:
            status = 'refused'
            message = 'Could not save the connection on this Pi.'
        else:
            return {'status': 'saved', 'message': 'Connection saved.'}
    return {'status': status, 'message': message}


def automation_view(*, failures_only=False):
    response = n8n_get('/healthz/readiness')
    ready = isinstance(response, dict) and response.get('status') == 'ok'
    config = n8n_panel_config()
    workflows, executions = n8n_data(config) if ready else (None, None)
    editor = config.get('editorUrl')
    key = config.get('apiKey')
    names, workflow_items, execution_items = {}, [], []
    for workflow in (workflows or [])[:12]:
        workflow_id = workflow.get('id')
        if not isinstance(workflow_id, str) or not N8N_ID.fullmatch(workflow_id):
            continue
        name = clean_name(workflow.get('name')) or 'Workflow'
        names[workflow_id] = name
        active = workflow.get('active')
        active = active if type(active) is bool else None
        workflow_items.append(
            {
                'id': workflow_id,
                'name': name,
                'state': {True: 'Published', False: 'Draft', None: 'Unknown'}[active],
                'isActive': active,
            }
        )
    for execution in (executions or [])[:12]:
        raw_status = clean_name(execution.get('status'))
        if failures_only and raw_status not in ('error', 'crashed'):
            continue
        label, tone = EXECUTION_STATES.get(raw_status, ('Unknown', None))
        execution_items.append(
            {
                'workflowName': names.get(
                    clean_name(execution.get('workflowId')), 'Workflow execution'
                ),
                'label': label,
                'tone': 'good' if tone is True else 'warn' if tone is False else 'unknown',
                'startedAt': clean_name(execution.get('startedAt')) or None,
            }
        )
    return {
        'isReady': ready,
        'isConnected': workflows is not None or executions is not None,
        'editorUrl': editor
        if isinstance(editor, str) and len(editor) <= 253 and N8N_EDITOR.fullmatch(editor)
        else None,
        'hasStoredKey': isinstance(key, str) and bool(N8N_KEY.fullmatch(key)),
        'workflows': workflow_items if workflows is not None else None,
        'executions': execution_items if executions is not None else None,
        'failuresOnly': failures_only,
    }


def app_shell(nonce):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e0e0e"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="LEÓN Home"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/brand/symbol.png"><link rel="manifest" href="/manifest.webmanifest"><title>LEÓN Home</title><link rel="stylesheet" href="/network-map/assets/leon.css"><meta name="color-scheme" content="dark"></head><body><div id="app" class="app"><noscript><p class="boot-failure">LEÓN Home needs JavaScript.</p></noscript></div><script type="module" nonce="{nonce}" src="/network-map/assets/leon.js"></script></body></html>""".encode()


# ---------------------------------------------------------------- HTTP


class Handler(http.server.BaseHTTPRequestHandler):
    storage_automation = True
    signed_updates = False  # the family edition serves /updates

    server_version = 'leon-overview'
    sys_version = ''

    def owner(self):
        login = (self.headers.get('Tailscale-User-Login') or '').strip().lower()
        return login if login and login in OWNERS else None

    def versions(self):
        """(installed, available update); the family edition asks its signed updater."""
        return installed_version(), None

    def use_own_api_path(self):
        """The app calls /leon/v1 because Tailscale Serve sends /api to Pi-hole; /api/v1 is the same API."""
        if self.path.startswith('/leon/v1/'):
            self.path = '/api/v1/' + self.path.removeprefix('/leon/v1/')

    def do_GET(self):
        self.use_own_api_path()
        login = self.owner()
        if not login:
            if self.path.startswith('/api/v1/'):
                return self.reply_json(
                    403, {'status': 'forbidden', 'message': 'Owner access is required.'}
                )
            return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
        path = self.path.split('?', 1)[0]
        if (
            path in ('/automation', '/storage/automation', '/api/v1/automation')
            and not self.storage_automation
        ):
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        if path in (
            '/api/v1/storage',
            '/storage/download',
            '/api/v1/storage/files',
            '/api/v1/automation',
            '/api/v1/movies',
            '/storage/poster',
            '/storage/movie-video',
        ):
            return self.storage_get(path)
        if (
            path in ('/manifest.webmanifest', '/sw.js', '/offline')
            or path in ASSETS
            or path.startswith('/network-map/assets/')
        ):
            return self.web_resource(path, login)
        if path in ('/network-map/data', '/api/v1/network'):
            with _lock:
                data = dict(_data)
            return self.reply_json(200, {**network_map.snapshot(data), 'actionToken': token(login)})
        if path == '/api/v1/session':
            version, available = self.versions()
            return self.reply_json(
                200,
                session_view(
                    login,
                    automation=self.storage_automation,
                    updates=self.signed_updates,
                    version=version,
                    available=available,
                ),
            )
        if path == '/api/v1/home':
            with _lock:
                view = home_view(_data)
            return self.reply_json(200, view)
        if path == '/api/v1/dns':
            with _lock:
                view = home_view(_data)
            return self.reply_json(200, {**view, 'filtering': dns_details()})
        if path == '/api/v1/hardware':
            with _lock:
                data = dict(_data)
            return self.reply_json(200, hardware_view(data))
        route = path
        if path.startswith('/network/device/'):
            try:
                segment = path.removeprefix('/network/device/')
                ipaddress.IPv4Address(segment)
            except ValueError:
                return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
            route = '/network/device/:id'
        if route not in APP_ROUTES:
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        nonce = base64.b64encode(os.urandom(12)).decode()
        return self.reply(200, app_shell(nonce), 'text/html; charset=utf-8', nonce=nonce)

    def storage_get(self, path):
        """Serve bounded storage and automation queries after owner and edition checks."""
        if path == '/api/v1/storage':
            return self.reply_json(200, storage_view(show_automation=self.storage_automation))
        if path == '/storage/download':
            query = (
                urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=2)
                if len(self.path) <= 4096
                else {}
            )
            relative = (query.get('path') or [''])[0]
            return self.download(relative)
        if path == '/api/v1/storage/files':
            try:
                query = (
                    urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=2)
                    if len(self.path) <= 4096
                    else {}
                )
            except ValueError:
                return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid file query.'})
            relative = (query.get('path') or [''])[0]
            try:
                view = files_view(relative, (query.get('q') or [''])[0])
            except OSError:
                return self.reply_json(
                    404,
                    {'status': 'unavailable', 'message': 'Folder unavailable or drive not mounted'},
                )
            return self.reply_json(200, view)
        if path == '/api/v1/movies':
            return self.reply_json(200, movies_view())
        if path == '/storage/poster':
            query = (
                urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=2)
                if len(self.path) <= 2048
                else {}
            )
            return self.poster((query.get('movie') or [''])[0])
        if path == '/storage/movie-video':
            query = (
                urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=2)
                if len(self.path) <= 2048
                else {}
            )
            return self.send_file(movie_video_path((query.get('movie') or [''])[0]))
        if path == '/api/v1/automation':
            query = (
                urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=10)
                if len(self.path) <= 256 and self.path.count('&') < 10
                else {}
            )
            return self.reply_json(
                200, automation_view(failures_only=query.get('status') == ['failed'])
            )
        return None

    def web_resource(self, path, login):
        """Serve only fixed app resources after owner authorization."""
        if path == '/manifest.webmanifest':
            return self.reply(
                200, MANIFEST, 'application/manifest+json', cache='public, max-age=3600'
            )
        if path == '/sw.js':
            worker = web_assets.read_worker()
            if worker is None:
                return self.reply(503, b'Web build unavailable', 'text/plain; charset=utf-8')
            return self.reply(200, worker, 'text/javascript; charset=utf-8', cache='no-cache')
        if path == '/offline':
            return self.reply(200, OFFLINE, 'text/html; charset=utf-8', cache='no-cache')
        if path in ASSETS:
            try:
                with open(os.path.join(BRAND, ASSETS[path]), 'rb') as handle:
                    return self.reply(
                        200, handle.read(2_000_000), 'image/png', cache='public, max-age=86400'
                    )
            except OSError:
                return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        if path.startswith('/network-map/assets/'):
            if login not in OWNERS:
                return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
            asset = web_assets.read(path)
            if asset is None:
                return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
            body, content_type = asset
            return self.reply(200, body, content_type)
        return None

    def do_POST(self):
        self.use_own_api_path()
        login = self.owner()
        if not login:
            if self.path.startswith('/api/v1/'):
                return self.reply_json(
                    403, {'status': 'forbidden', 'message': 'Owner access is required.'}
                )
            return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
        if self.path.startswith('/api/v1/hardware/'):
            return self.hardware_control(login)
        guarded = self.path.startswith(('/api/v1/network/', '/api/v1/dns/')) or self.path in (
            '/api/v1/automation/settings',
            '/api/v1/storage/password',
            '/api/v1/storage/eject',
        )
        if guarded and (
            self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin')
            or not self.same_origin()
            or not token_valid(login, self.headers.get('X-Leon-Token'))
        ):
            return self.reply_json(
                403, {'status': 'forbidden', 'message': 'Reload the page and try again.'}
            )
        if self.path == '/api/v1/automation/settings':
            if not self.storage_automation:
                return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
            return self.automation_settings_json(login)
        if self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin'):
            return self.reply(403, b'Cross-site request refused', 'text/plain; charset=utf-8')
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length < 0 or self.headers.get('Transfer-Encoding'):
                raise ValueError
        except ValueError:
            return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid body length.'})
        if length > 2048:
            if self.path.startswith('/api/v1/network/'):
                return self.reply_json(
                    413, {'status': 'invalid', 'message': 'Request is too large.'}
                )
            return self.reply(413, b'Too large', 'text/plain; charset=utf-8')
        return self.dispatch_control(login, length)

    def dispatch_control(self, login, length):
        """Dispatch an already bounded owner request; action methods retain their own guards."""
        if self.path == '/api/v1/network/wake':
            return self.wake(login, length)
        if self.path == '/api/v1/storage/password':
            return self.storage_password(length)
        if self.path == '/api/v1/storage/eject':
            self.rfile.read(length)
            answer = eject_drive()
            return self.reply_json(200 if answer['status'] == 'ejected' else 409, answer)
        if self.path in ('/api/v1/dns/pause', '/api/v1/dns/resume', '/api/v1/dns/disable'):
            return self.dns_blocking(length)
        if self.path in ('/api/v1/dns/allow', '/api/v1/dns/unallow'):
            return self.dns_allowlist(length)
        if self.path == '/api/v1/dns/device-filter':
            return self.dns_device_filter(length)
        # /network-map/port remains for the Mac app. The other /network-map/* actions
        # are deprecated aliases of /api/v1/network/* until external clients migrate.
        if self.path in ('/network-map/port', '/api/v1/network/port'):
            return self.port(login, length)
        if self.path in ('/network-map/unlock', '/api/v1/network/unlock'):
            return self.unlock(login, length)
        if self.path in ('/network-map/name', '/api/v1/network/name'):
            return self.rename(login, length)
        if self.path in ('/network-map/pause', '/api/v1/network/pause'):
            return self.pause(login, length)
        if self.path in ('/network-map/schedule', '/api/v1/network/schedule'):
            return self.schedule(login, length)
        return self.reply(404, b'Not found', 'text/plain; charset=utf-8')

    def same_origin(self):
        """A browser request's Origin names this panel. Tailscale Serve proxying to a unix socket
        sends Host: localhost and the visited name in X-Forwarded-Host, so either one matches."""
        origin = self.headers.get('Origin')
        if origin is None:
            return True
        hosts = (self.headers.get('Host'), self.headers.get('X-Forwarded-Host'))
        return any(origin in (f'http://{host}', f'https://{host}') for host in hosts if host)

    def hardware_control(self, login):
        if not self.same_origin():
            return self.reply_json(
                403, {'status': 'forbidden', 'message': 'Cross-site request refused.'}
            )
        if self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin') or not token_valid(
            login, self.headers.get('X-Leon-Token')
        ):
            return self.reply_json(
                403, {'status': 'forbidden', 'message': 'Reload the page and try again.'}
            )
        action = self.path.removeprefix('/api/v1/hardware/')
        if action not in HARDWARE_ACTIONS:
            return self.reply_json(
                404, {'status': 'invalid', 'message': 'Unknown hardware action.'}
            )
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length < 0 or self.headers.get('Transfer-Encoding'):
                raise ValueError
            if length > 1024:
                return self.reply_json(
                    413, {'status': 'invalid', 'message': 'Hardware request is too large.'}
                )
            if (self.headers.get('Content-Type') or '').split(';', 1)[
                0
            ].strip() != 'application/json':
                raise ValueError
            request = hardware_request(action, json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(
                400, {'status': 'invalid', 'message': 'Invalid hardware request.'}
            )
        if action == 'power' and request['confirm'] != socket.gethostname().split('.')[0]:
            return self.reply_json(
                200, {'status': 'refused', 'message': 'The node name does not match.'}
            )
        outcome = hardware_action(request)
        return self.reply_json(
            503 if outcome['status'] == 'unavailable' else 200,
            {'status': outcome['status'], 'message': outcome['message'][:200]},
        )

    def reply_json(self, status, value):
        return self.reply(
            status,
            json.dumps(value, allow_nan=False).encode('utf-8'),
            'application/json; charset=utf-8',
        )

    def dns_blocking(self, length):
        pause = self.path == '/api/v1/dns/pause'
        try:
            content_type = (self.headers.get('Content-Type') or '').split(';', 1)[0].strip()
            if content_type != 'application/json':
                raise ValueError
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict) or set(request) != ({'seconds'} if pause else set()):
                raise ValueError
            if pause and (
                type(request['seconds']) is not int or request['seconds'] not in (300, 1800)
            ):
                raise ValueError
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid DNS request.'})
        return self.reply_json(
            *apply_blocking(self.path == '/api/v1/dns/resume', request.get('seconds'))
        )

    def dns_allowlist(self, length):
        try:
            content_type = (self.headers.get('Content-Type') or '').split(';', 1)[0].strip()
            if content_type != 'application/json':
                raise ValueError
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict) or set(request) != {'domain'}:
                raise ValueError
            domain = request['domain']
            if not isinstance(domain, str) or not DOMAIN_PATTERN.match(domain):
                raise ValueError
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid domain.'})
        return self.reply_json(*change_allowlist(domain, self.path == '/api/v1/dns/allow'))

    def dns_device_filter(self, length):
        try:
            content_type = (self.headers.get('Content-Type') or '').split(';', 1)[0].strip()
            if content_type != 'application/json':
                raise ValueError
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict) or set(request) != {'address', 'paused'}:
                raise ValueError
            address, paused = request['address'], request['paused']
            if type(paused) is not bool or not isinstance(address, str):
                raise ValueError
            if not is_filter_device(address) or str(ipaddress.IPv4Address(address)) != address:
                raise ValueError
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid device.'})
        return self.reply_json(*set_device_filter(address, paused))

    def automation_settings_json(self, login):
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if (
                not 1 <= length <= 8192
                or self.headers.get('Transfer-Encoding')
                or self.headers.get('Content-Type', '').split(';', 1)[0].strip()
                != 'application/json'
            ):
                raise ValueError
            request = json.loads(self.rfile.read(length))
            if (
                not isinstance(request, dict)
                or set(request) != {'apiKey', 'editorUrl'}
                or not all(isinstance(value, str) for value in request.values())
            ):
                raise ValueError
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(
                400, {'status': 'invalid', 'message': 'Invalid connection settings'}
            )
        outcome = save_automation_settings(request['apiKey'], request['editorUrl'])
        return self.reply_json(200 if outcome['status'] == 'saved' else 400, outcome)

    def storage_password(self, length):
        """One stored drive password, only on the owner's request (gated above); never logged."""
        try:
            if (self.headers.get('Content-Type') or '').split(';', 1)[
                0
            ].strip() != 'application/json':
                raise ValueError
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict) or set(request) != {'drive', 'user'}:
                raise ValueError
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid request.'})
        for account in storage_accounts():
            if account['drive'] == request['drive'] and account['user'] == request['user']:
                print('storage password shown to owner', file=sys.stderr, flush=True)
                return self.reply_json(
                    200, {'status': 'shown', 'message': '', 'password': account['password']}
                )
        return self.reply_json(
            404, {'status': 'unavailable', 'message': 'This password is not saved on this Pi.'}
        )

    def wake(self, login, length):
        try:
            if (self.headers.get('Content-Type') or '').split(';', 1)[
                0
            ].strip() != 'application/json':
                raise ValueError
            request = json.loads(self.rfile.read(length))
            if (
                not isinstance(request, dict)
                or set(request) != {'address'}
                or not isinstance(request['address'], str)
            ):
                raise ValueError
            address = str(ipaddress.IPv4Address(request['address']))
        except (ValueError, UnicodeError, RecursionError):
            return self.reply_json(400, {'status': 'invalid', 'message': 'Invalid wake request.'})
        mac = macs_by_ip().get(address)
        protected = protected_macs()
        with _lock:
            device = next(
                (dict(item) for item in _data.get('devices', []) if item.get('ip') == address), None
            )
        if device is None or mac is None:
            return self.reply_json(
                409, {'status': 'refused', 'message': 'Wake is unavailable for this device.'}
            )
        device.update(mac=mac, protected=protected is None or mac in protected)
        if not network_map.can_wake(device, network_map.local_macs()):
            return self.reply_json(
                409, {'status': 'refused', 'message': 'Wake is unavailable for this device.'}
            )
        now = time.monotonic()
        # Reserve before sending so concurrent requests cannot both pass the limit.
        with _wake_lock:
            for key, stamp in list(_wake_sent.items()):
                if now - stamp >= 10:
                    del _wake_sent[key]
            limited = mac in _wake_sent or len(_wake_sent) >= 256
            if not limited:
                _wake_sent[mac] = now
        if limited:
            return self.reply_json(
                429,
                {
                    'status': 'refused',
                    'message': 'Wait 10 seconds before sending another wake signal.',
                },
            )
        try:
            packet = b'\xff' * 6 + bytes.fromhex(mac.replace(':', '')) * 16
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
                connection.settimeout(2)
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                if connection.sendto(packet, ('255.255.255.255', 9)) != len(packet):
                    raise OSError('Incomplete wake packet')
        except OSError:
            outcome = {'status': 'unavailable', 'message': 'Could not send the wake signal.'}
        else:
            outcome = {
                'status': 'sent',
                'message': 'Wake signal sent. The device appears online once it starts.',
            }
        print(f'wake signal outcome={outcome["status"]} by owner', file=sys.stderr, flush=True)
        return self.reply_json(200 if outcome['status'] == 'sent' else 503, outcome)

    def port(self, login, length):
        # JSON plus a custom header cannot be sent cross-site without CORS preflight, which
        # this server never grants; the HMAC token binds the request to this owner session.
        if (
            login not in OWNERS
            or not token_valid(login, self.headers.get('X-Leon-Token'))
            or (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json'
        ):
            return self.reply(403, b'{"status":"forbidden"}', 'application/json; charset=utf-8')
        try:
            request = json.loads(self.rfile.read(length))
            if (
                not isinstance(request, dict)
                or set(request) != {'port', 'enabled'}
                or type(request['port']) is not int
                or not 1 <= request['port'] <= 8
                or type(request['enabled']) is not bool
            ):
                raise ValueError('Invalid port request')
        except ValueError:
            return self.reply(400, b'{"status":"invalid"}', 'application/json; charset=utf-8')
        try:
            outcome = port_action(request['port'], request['enabled'])
        except (OSError, ValueError):
            return self.reply(503, b'{"status":"unavailable"}', 'application/json; charset=utf-8')
        print(
            f'port action {request["port"]} enabled={request["enabled"]} outcome={outcome} by owner',
            file=sys.stderr,
            flush=True,
        )
        return self.reply(
            200, json.dumps({'status': outcome}).encode(), 'application/json; charset=utf-8'
        )

    def unlock(self, login, length):
        # Same owner, token and JSON gates as port actions. The body is never logged.
        if (
            login not in OWNERS
            or not token_valid(login, self.headers.get('X-Leon-Token'))
            or (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json'
        ):
            return self.reply(403, b'{"status":"forbidden"}', 'application/json; charset=utf-8')
        try:
            request = json.loads(self.rfile.read(length))
            if (
                not isinstance(request, dict)
                or set(request) not in ({'phrase'}, {'password'})
                or not all(isinstance(value, str) for value in request.values())
                or not all(1 <= len(value.encode()) <= 1024 for value in request.values())
            ):
                raise ValueError('Invalid unlock request')
        except ValueError:
            return self.reply(400, b'{"status":"invalid"}', 'application/json; charset=utf-8')
        try:
            outcome = router_unlock(request)
        except (OSError, ValueError):
            return self.reply(503, b'{"status":"unavailable"}', 'application/json; charset=utf-8')
        print(f'phone unlock outcome={outcome} by owner', file=sys.stderr, flush=True)
        return self.reply(
            200, json.dumps({'status': outcome}).encode(), 'application/json; charset=utf-8'
        )

    def pause(self, login, length):
        """Pause or resume one Wi-Fi device by address; the MAC is resolved here, the monitor enforces the rest."""
        if (
            login not in OWNERS
            or not token_valid(login, self.headers.get('X-Leon-Token'))
            or (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json'
        ):
            return self.reply(403, b'{"status":"forbidden"}', 'application/json; charset=utf-8')
        try:
            request = json.loads(self.rfile.read(length))
            if (
                not isinstance(request, dict)
                or set(request) != {'address', 'paused'}
                or type(request['paused']) is not bool
            ):
                raise ValueError('Invalid pause request')
            address = str(ipaddress.IPv4Address(request['address']))
        except (ValueError, TypeError):
            return self.reply(400, b'{"status":"invalid"}', 'application/json; charset=utf-8')
        mac = macs_by_ip().get(address)
        if not mac:
            return self.reply(404, b'{"status":"unknownDevice"}', 'application/json; charset=utf-8')
        try:
            outcome = device_action(mac, request['paused'])
        except (OSError, ValueError):
            return self.reply(503, b'{"status":"unavailable"}', 'application/json; charset=utf-8')
        print(
            f'device paused={request["paused"]} outcome={outcome} by owner',
            file=sys.stderr,
            flush=True,
        )
        return self.reply(
            200, json.dumps({'status': outcome}).encode(), 'application/json; charset=utf-8'
        )

    def schedule(self, login, length):
        """Set or clear one device's weekly pause window; the router monitor applies its edges."""
        if (
            login not in OWNERS
            or not token_valid(login, self.headers.get('X-Leon-Token'))
            or (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json'
        ):
            return self.reply(403, b'{"status":"forbidden"}', 'application/json; charset=utf-8')
        try:
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict) or set(request) != {'address', 'schedule'}:
                raise ValueError('Invalid schedule request')
            address = str(ipaddress.IPv4Address(request['address']))
            schedule = clean_schedule(request['schedule'])
        except (ValueError, TypeError):
            return self.reply(400, b'{"status":"invalid"}', 'application/json; charset=utf-8')
        mac = macs_by_ip().get(address)
        if not mac:
            return self.reply(404, b'{"status":"unknownDevice"}', 'application/json; charset=utf-8')
        protected = protected_macs()
        if schedule and (protected is None or mac in protected):
            return self.reply(
                409, b'{"status":"protectedDevice"}', 'application/json; charset=utf-8'
            )
        try:
            save_pause_schedule(mac, schedule)
        except (OSError, ValueError):
            return self.reply(503, b'{"status":"unavailable"}', 'application/json; charset=utf-8')
        with _lock:
            for device in _data.get('devices') or []:
                if device.get('mac') == mac:
                    device['pauseSchedule'] = schedule
        print(
            f'pause schedule {"set" if schedule else "cleared"} by owner',
            file=sys.stderr,
            flush=True,
        )
        return self.reply(200, b'{"status":"saved"}', 'application/json; charset=utf-8')

    def rename(self, login, length):
        """Name one device by address; the server resolves its MAC, so the client never sends one."""
        if (
            login not in OWNERS
            or not token_valid(login, self.headers.get('X-Leon-Token'))
            or (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json'
        ):
            return self.reply(403, b'{"status":"forbidden"}', 'application/json; charset=utf-8')
        try:
            request = json.loads(self.rfile.read(length))
            if (
                not isinstance(request, dict)
                or set(request) != {'address', 'name'}
                or not isinstance(request['name'], str)
            ):
                raise ValueError('Invalid name request')
            address = str(ipaddress.IPv4Address(request['address']))
            name = clean_name(request['name'])
        except (ValueError, TypeError):
            return self.reply(400, b'{"status":"invalid"}', 'application/json; charset=utf-8')
        mac = macs_by_ip().get(address)
        if not mac:
            return self.reply(404, b'{"status":"unknownDevice"}', 'application/json; charset=utf-8')
        try:
            save_owner_name(mac, name)
        except (OSError, ValueError):
            return self.reply(503, b'{"status":"unavailable"}', 'application/json; charset=utf-8')
        with _lock:  # show it now instead of after the next 30 s sample
            for device in _data.get('devices') or []:
                if device.get('mac') == mac:
                    device['label'] = name or None
        _names.pop(address, None)
        print(f'device {"named" if name else "name cleared"} by owner', file=sys.stderr, flush=True)
        return self.reply(200, b'{"status":"saved"}', 'application/json; charset=utf-8')

    def reply(self, status, body, content_type, nonce=None, cache='no-store'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        script = (
            f"script-src 'nonce-{nonce}' 'strict-dynamic'; connect-src 'self'; " if nonce else ''
        )
        if content_type.startswith('text/javascript'):
            script = "connect-src 'self'; "  # the service worker caches same-origin brand assets
        self.send_header(
            'Content-Security-Policy',
            f"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; manifest-src 'self'; worker-src 'self'; {script}"
            "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        )
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(body)

    def poster(self, movie_id):
        """A movie poster, cacheable by the phone so browsing does not re-download every image."""
        path = poster_path(movie_id)
        try:
            if path is None:
                raise FileNotFoundError(movie_id)
            with open(path, 'rb') as handle:
                data = handle.read(MAX_POSTER_BYTES + 1)
        except OSError:
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        if len(data) > MAX_POSTER_BYTES or not data.startswith(b'\xff\xd8\xff'):
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'private, max-age=86400')
        self.send_header('Content-Security-Policy', "default-src 'none'; sandbox")
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        self.wfile.write(data)
        return None

    def download(self, relative):
        resolved = storage_path(relative)
        return self.send_file(resolved[0] if resolved else None)

    def send_file(self, path):
        """Serve one already-resolved file with Range support, inline only for safe types."""
        try:
            if path is None:
                raise FileNotFoundError(path)
            handle = open(path, 'rb')
        except OSError:
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        with handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
            length = info.st_size
            selected = byte_range(self.headers.get('Range'), length)
            if selected is False:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{length}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            start, end = selected or (0, length - 1)
            name = os.path.basename(path)
            content_type = mimetypes.guess_type(name)[0] or 'application/octet-stream'
            disposition = 'inline' if content_type in INLINE_TYPES else 'attachment'
            if disposition == 'attachment':
                content_type = 'application/octet-stream'
            self.send_response(206 if selected else 200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(max(end - start + 1, 0)))
            self.send_header('Accept-Ranges', 'bytes')
            if selected:
                self.send_header('Content-Range', f'bytes {start}-{end}/{length}')
            self.send_header(
                'Content-Disposition',
                f"{disposition}; filename*=UTF-8''{urllib.parse.quote(name)}",
            )
            self.send_header('Cache-Control', 'private, no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; sandbox")
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            handle.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = handle.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True  # the player stopped or seeked; normal for video
        return None

    def log_message(self, fmt, *args):
        pass  # no access log: request paths and logins stay out of the journal


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, save_internet_and_exit)
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=keep_movies_warm, daemon=True).start()
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
