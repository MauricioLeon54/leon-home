#!/usr/bin/env python3
"""LEÓN Home overview: a server-rendered status page for the owner's phone on the tailnet.

Listens on 127.0.0.1 only; Tailscale Serve publishes it over HTTPS at `/` of the node's ts.net
name. Requests without Tailscale Serve's identity header, or from a login not in OWNER_LOGINS, get
403. A background sampler collects every 30 s (collector snapshot, Pi-hole API with the application
password, `tailscale status`, internet health, backups, Git), so pages render instantly.

Actions carry an HMAC token bound to the login; equipment operations retain their additional
target and policy checks. Values are escaped; nonce-authorized compiled modules refresh the
page only while visible. The Pi serves prebuilt assets without a JavaScript toolchain.
"""

import base64
import calendar
import collections
import hashlib
import hmac
import html
import http.client
import http.server
import ipaddress
import json
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
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collector  # noqa: E402  (the LEÓN snapshot collector, copied beside this file)
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
    {'current', 'unlockFailed', 'busy', 'notConfigured', 'alreadyConfigured', 'setupUnavailable'}
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
PAUSE_CHOICES = {'300': '5 min', '1800': '30 min'}
TOKEN_SECONDS = 3600
SECRET = os.urandom(32)
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
_names_lock = threading.Lock()
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
        request = urllib.request.Request(
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
        'blocking': blocking.get('blocking'),
        'timer': blocking.get('timer'),
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
            ['tailscale', 'status', '--json'], capture_output=True, timeout=4, check=True
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
    try:
        files = [
            os.path.join(BACKUPS, name)
            for name in os.listdir(BACKUPS)
            if name.endswith('.tar.gz.age')
        ]
        latest = max(files, key=os.path.getmtime)
        return {
            'count': len(files),
            'at': os.path.getmtime(latest),
            'bytes': os.path.getsize(latest),
        }
    except (OSError, ValueError):
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
                [
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
            stamp, branch, subject = (result.stdout.strip().split('\t', 2) + ['', '', ''])[:3]
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


def sample():
    snapshot = collector.collect()
    network = snapshot.get('network') or {}
    router = next((d['ip'] for d in network.get('devices', []) if d.get('role') == 'router'), None)
    try:
        internet = collector.health(router) if router else None
    except (OSError, ValueError):
        internet = None
    devices = []
    for device in network.get('devices', []):
        devices.append({**device, 'label': local_name(device['ip'])})
    try:
        with open(NAMES_STATUS, encoding='utf-8') as handle:
            naming = json.load(handle)
    except (OSError, ValueError):
        naming = {}
    sources = {d.get('ip'): d.get('source') for d in naming.get('devices', [])}
    for device in devices:
        device['source'] = sources.get(device['ip'])
    apply_identity(devices, time.time())
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
    try:
        internet_health.save_closed_outages(INTERNET_OUTAGES, data['internetHealth'])
    except OSError:
        pass
    record_daily_facts(data)


_daily_facts_at = 0


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
        internet_health.save_json(DAILY_FACTS, facts)
        _daily_facts_at = now
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'daily facts failed: {type(error).__name__}', file=sys.stderr, flush=True)


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
    while True:
        started = time.time()
        try:
            data = sample()
            record_temperature(data['host'].get('temperatureCelsius'))
            record_internet(data)
            with _lock:
                _data.clear()
                _data.update(data)
        except Exception as error:  # keep the last good sample; report once per failure
            print(f'sample failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
        time.sleep(max(5, SAMPLE_SECONDS - (time.time() - started)))


# ---------------------------------------------------------------- actions


def token(login, now=None):
    stamp = str(int(now or time.time()))
    mac = hmac.new(SECRET, f'{login}|{stamp}'.encode(), hashlib.sha256).hexdigest()
    return f'{stamp}.{mac}'


def token_valid(login, value):
    stamp, _, mac = (value or '').partition('.')
    if not stamp.isdigit() or abs(time.time() - int(stamp)) > TOKEN_SECONDS:
        return False
    expected = hmac.new(SECRET, f'{login}|{stamp}'.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, mac)


def set_blocking(enabled, seconds=None):
    with PiHole() as api:
        state = api.call('POST', '/api/dns/blocking', {'blocking': enabled, 'timer': seconds})
    with _lock:
        if _data.get('dns'):
            _data['dns'] = {
                **_data['dns'],
                'blocking': state.get('blocking'),
                'timer': state.get('timer'),
            }


# ---------------------------------------------------------------- rendering

e = html.escape


def ago(stamp):
    if not stamp:
        return '—'
    seconds = max(0, time.time() - stamp)
    if seconds < 90:
        return 'now'
    if seconds < 3600:
        return f'{int(seconds // 60)} min ago'
    if seconds < 86400:
        return f'{int(seconds // 3600)} h ago'
    return f'{int(seconds // 86400)} d ago'


def duration(seconds):
    if seconds is None:
        return '—'
    days, rest = divmod(int(seconds), 86400)
    return f'{days} d {rest // 3600} h' if days else f'{rest // 3600} h {rest % 3600 // 60} min'


def size(value):
    if value is None:
        return '—'
    for unit, scale in (('GB', 1 << 30), ('MB', 1 << 20), ('KB', 1 << 10)):
        if value >= scale:
            return f'{value / scale:.1f} {unit}'
    return f'{value} B'


def number(value):
    return f'{value:,}'.replace(',', ' ') if isinstance(value, int) else '—'


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


def reading(value, label, tone=''):
    return f'<div class="reading {tone}"><b>{e(value)}</b><span>{e(label)}</span></div>'


CHEVRON = (
    '<span class="t-acc-chevron" aria-hidden="true">'
    '<svg viewBox="0 0 16 16"><path d="M4 6.5 8 10.5 12 6.5"/></svg></span>'
)


def disclosure(key, title, summary, body, tone='', nested=False):
    """Collapsed detail; home.ts opens it and keeps it open across refreshes."""
    return (
        f'<section class="{"t-acc nested" if nested else "section t-acc"}" id="{key}" data-open="false">'
        f'<button type="button" class="t-acc-head{" quiet" if nested else ""}" aria-expanded="false" '
        f'aria-controls="{key}-panel"><span class="title">{e(title)}</span>'
        f'<span class="summary {tone}">{e(summary)}</span>{CHEVRON}</button>'
        f'<div class="t-acc-panel" id="{key}-panel" inert><div class="t-acc-panel-inner">'
        f'<div class="t-acc-body">{body}</div></div></div></section>'
    )


def section_head(title, meta='', tone='', link=''):
    meta_html = f'<span class="meta {tone}">{e(meta)}</span>' if meta else ''
    return f'<div class="section-head"><h2>{e(title)}</h2>{meta_html}{link}</div>'


def panel(key, title, meta, body, tone=''):
    """A visible section: its head carries the summary, its body the readings."""
    return f'<section class="section" id="{key}">{section_head(title, meta, tone)}{body}</section>'


def row(ok, text, detail='', extra=''):
    tone = 'ok' if ok is True else ('bad' if ok is False else 'idle')
    return (
        f'<li><i class="dot {tone}"></i><span class="grow">{e(text)}</span>{extra}'
        f'{f"<small>{e(detail)}</small>" if detail else ""}</li>'
    )


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


def tablet_summary_rows(stored, now):
    """Rows for the Mac's published tablet reading. Everything older than the Mac's cadence is dimmed."""
    if not stored:
        return '', ''
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
        rows.append(row(tone(not low), 'Battery', f'{battery["percent"]}% · {state}{heat}'))
    else:
        rows.append(row(None, 'Battery', 'no reading (tablet ADB unavailable)'))
    if summary.get('display'):
        rows.append(row(None, 'Display', DISPLAY_LABELS[summary['display']]))
    else:
        rows.append(row(None, 'Display', 'no reading'))
    if summary.get('storageFreePercent') is not None:
        rows.append(
            row(
                tone(summary['storageFreePercent'] >= 10),
                'Free storage',
                f'{summary["storageFreePercent"]}%',
            )
        )
    if summary.get('memoryAvailablePercent') is not None:
        rows.append(row(None, 'Available memory', f'{summary["memoryAvailablePercent"]}%'))
    outreach = summary.get('outreach')
    if outreach:
        fresh = now - outreach['checkedAt'] <= REPORT_FRESH_SECONDS
        rows.append(
            row(
                tone(fresh and not outreach['needsAttention']),
                'Outreach',
                f'{OUTREACH_LABELS[outreach["state"]]} · {outreach["actions24h"]} actions and '
                f'{outreach["errors24h"]} errors in 24 h · {ago(outreach["checkedAt"])}',
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
            row(
                tone(fresh and not trader['killSwitch'] and not trader['halted']),
                'Trader (simulated)',
                f'{state}{change} · {ago(trader["checkedAt"])}',
            )
        )
    age = (
        f'Read by the Mac {ago(summary["observedAt"])}'
        if current
        else f'Stale reading: last read by the Mac {ago(summary["observedAt"])}'
    )
    return ''.join(rows), age


def tablet_card(peers, name, observed_at, stored=None, now=None):
    """Reachability of the configured tablet plus the Mac's last reading of it. Unknown stays unknown."""
    now = now or time.time()
    detail_rows, age = tablet_summary_rows(stored, now)
    if not name and not detail_rows:
        return ''
    peer = next((p for p in peers or [] if p['name'] == name), None)
    summary, tone = 'Last reading only', ''
    if not name:
        line = ''
    elif peers is None:
        line = row(None, 'Tablet', 'no Tailscale data')
        summary = 'Unknown'
    elif peer is None:
        line = row(None, 'Tablet', 'not in the tailnet')
        summary, tone = 'Not in the tailnet', 'warn'
    elif peer['online']:
        line = row(
            True, 'Tablet', 'online · ' + ('direct connection' if peer['direct'] else 'via relay')
        )
        summary = 'Online'
    else:
        line = row(False, 'Tablet', f'offline · last seen {ago(peer["seen"])}')
        summary, tone = f'Offline since {ago(peer["seen"])}', 'warn'
    summary_note = (
        (
            f'<p class="note">{e(age)}. These readings become stale if the Mac sleeps or LEÓN Labs is closed.</p>'
        )
        if detail_rows
        else (
            '<p class="note">Battery, display and services appear when the Mac publishes a reading.</p>'
        )
    )
    body = (
        f'<ul class="rows">{line}{detail_rows}</ul>'
        f'<p class="note">Reachability over Tailscale, read {e(ago(observed_at))}. Phone notification after '
        f'10 minutes offline.</p>{summary_note}'
    )
    return panel('tablet', 'Tablet', summary, body, tone)


def bars(hours):
    if not hours:
        return ''
    peak = max(total for _, (total, _) in hours) or 1
    width, gap, height = 10, 3, 64
    parts = []
    for index, (hour, (total, blocked)) in enumerate(hours):
        x = index * (width + gap)
        h_total = max(1.5, total / peak * height)
        h_block = blocked / peak * height
        label = time.strftime('%H:00', time.localtime(hour * 3600))
        parts.append(
            f'<g><title>{label} · {total} queries, {blocked} blocked</title>'
            f'<rect class="total" x="{x}" y="{height - h_total:.1f}" width="{width}" height="{h_total:.1f}" rx="2"/>'
            f'<rect class="blocked" x="{x}" y="{height - h_block:.1f}" width="{width}" height="{h_block:.1f}" rx="2"/></g>'
        )
    first = time.strftime('%H:00', time.localtime(hours[0][0] * 3600))
    return (
        f'<svg class="bars" viewBox="0 0 {len(hours) * (width + gap) - gap} {height}" preserveAspectRatio="none" '
        f'aria-label="Queries per hour">{"".join(parts)}</svg>'
        f'<div class="axis"><span>{first}</span><span>now</span></div>'
    )


def sparkline(points):
    if len(points) < 2:
        return '<p class="muted small">The chart appears after a few minutes of readings.</p>'
    values = [v for _, v in points]
    low, high = min(values) - 1, max(values) + 1
    start, span = points[0][0], (points[-1][0] - points[0][0]) or 1
    coords = ' '.join(
        f'{(t - start) / span * 300:.1f},{60 - (v - low) / (high - low) * 56 - 2:.1f}'
        for t, v in points
    )
    return (
        f'<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-label="Temperature">'
        f'<polyline points="{coords}"/></svg>'
        f'<div class="axis"><span>min {min(values):.0f} °C</span><span>max {max(values):.0f} °C</span></div>'
    )


def strip(presence):
    cells = ''.join(f'<b class="{"on" if p else ""}"></b>' for p in (presence or [])[-16:])
    return f'<span class="strip" aria-hidden="true">{cells}</span>' if cells else ''


def device_rows(devices, baseline):
    now = time.time()
    return ''.join(
        row(
            True,
            d.get('label') or d['ip'],
            d['ip'] if d.get('label') else (ms(d.get('rttMs')) if d.get('rttMs') else ''),
            (
                '<em class="badge new">New</em>'
                if (d.get('firstSeen') or 0) > baseline + 86400 and now - d['firstSeen'] < 86400
                else ''
            )
            + ('<em class="badge">Unnamed</em>' if d.get('source') == 'unknown' else '')
            + ('<em class="badge">Auto</em>' if d.get('source') == 'mdns' else '')
            + strip(d.get('presence')),
        )
        for d in devices
    )


def router_link(devices):
    for device in devices or []:
        if not isinstance(device, dict) or device.get('role') != 'router':
            continue
        try:
            address = ipaddress.IPv4Address(device.get('ip', ''))
        except (ValueError, TypeError):
            continue
        if address.is_private:
            return (
                f'<a href="http://{address}/">Router settings<span aria-hidden="true">›</span></a>'
            )
    return ''


STORAGE_LINK = '<a href="/storage">Storage<span aria-hidden="true">›</span></a>'


AUTOMATION_LINK = '<a href="/automation">Automation<span aria-hidden="true">›</span></a>'


def render(data, login, nonce, *, show_automation=True):
    panel_links = STORAGE_LINK + (AUTOMATION_LINK if show_automation else '')
    if not data:
        return page(
            '<section class="overview"><h1 class="status-line"><i class="dot idle"></i>Preparing readings…</h1>'
            '<p class="facts">The first sample takes a few seconds.</p></section>'
            '<nav class="section links" aria-label="Other panels">' + panel_links + '</nav>',
            nonce,
        )
    snapshot, host, dns = data.get('snapshot') or {}, data.get('host') or {}, data.get('dns')
    issues = problems(data)
    units = host.get('units', [])
    running = sum(u['state'] in ('active', 'reloading') for u in units)
    temperature = host.get('temperatureCelsius')

    # 1. What is happening: one sentence, then only the issues that need attention.
    headline = (
        'Everything is running'
        if not issues
        else (
            'One thing needs attention'
            if len(issues) == 1
            else f'{len(issues)} things need attention'
        )
    )
    facts = [
        f'Up {duration(snapshot.get("uptimeSeconds"))}' if snapshot.get('uptimeSeconds') else '',
        f'{running} of {len(units)} services running' if units else '',
        f'{temperature:.0f} °C' if temperature is not None else '',
    ]
    overview_html = (
        f'<section class="overview{" attention" if issues else ""}">'
        f'<h1 class="status-line"><i class="dot {"bad" if issues else "ok"}"></i>{e(headline)}</h1>'
        + (
            '<ul class="rows issues">' + ''.join(row(False, issue) for issue in issues) + '</ul>'
            if issues
            else ''
        )
        + '<p class="facts">'
        + ''.join(f'<span>{e(fact)}</span>' for fact in facts if fact)
        + '</p>'
        + (
            '<nav class="automation-actions home-shortcuts" aria-label="Quick access">'
            '<a class="automation-action" href="/automation">Automation</a>'
            '<a class="automation-action" href="/storage">Storage</a></nav>'
            if show_automation
            else ''
        )
        + '</section>'
    )

    internet = data.get('internet') or {}
    router = internet.get('router') or {}
    router_ms = router.get('averageMs') if isinstance(router, dict) else None
    offline = bool(internet) and internet.get('internetMs') is None

    def measured(value, label, missing='unknown'):
        return reading(ms(value), label, '' if value is not None else missing)

    net_html = (
        '<section class="section" id="internet">'
        + section_head(
            'Internet',
            'No connection' if offline else ('Connected' if internet else 'No reading'),
            'warn' if offline else ('good' if internet else ''),
        )
        + '<div class="readings">'
        + (
            reading('Offline', 'Internet', 'warn')
            if offline
            else measured(internet.get('internetMs'), 'Internet')
        )
        + measured(router_ms, 'Router')
        + measured(internet.get('dnsMs'), 'Router DNS')
        + measured(dns.get('upstreamMs') if dns else None, 'Encrypted DNS')
        + '</div><p class="note">Round-trip times measured by the Pi.</p></section>'
    )

    # 2. What I can do: Pi-hole is the one control on this page.
    if dns:
        paused = dns.get('blocking') != 'enabled'
        timer = dns.get('timer')
        state = (
            'Blocking on'
            if not paused
            else f'Paused · {int(timer // 60)} min left'
            if timer
            else 'Blocking paused'
        )
        controls = (
            ''.join(
                f'<form method="post" action="/action/pause"><input type="hidden" name="t" value="{e(token(login))}">'
                f'<input type="hidden" name="s" value="{seconds}"><button>Pause {label}</button></form>'
                for seconds, label in PAUSE_CHOICES.items()
            )
            if not paused
            else (
                f'<form method="post" action="/action/resume"><input type="hidden" name="t" value="{e(token(login))}">'
                f'<button class="primary">Resume blocking</button></form>'
            )
        )
        tops = (
            '<div class="columns"><div><h3>Most blocked domains</h3><ul class="rows">'
            + ''.join(row(None, domain, number(count)) for domain, count in dns['topBlocked'])
            + '</ul></div><div><h3>Most active clients</h3><ul class="rows">'
            + ''.join(row(True, name, number(count)) for name, count in dns['topClients'])
            + '</ul></div></div>'
        )
        dns_html = (
            '<section class="section" id="pihole">'
            + section_head('Pi-hole', state, 'warn' if paused else 'good')
            + '<div class="readings three">'
            + reading(f'{dns["percent"]:.1f}%', 'Blocked today')
            + reading(number(dns['queries']), 'Queries')
            + reading(number(dns['blocked']), 'Blocked')
            + '</div><div class="chart-block"><div class="legend"><span><i class="sw total"></i>Queries</span>'
            '<span><i class="sw blocked"></i>Blocked</span><span class="span">Last 24 hours</span></div>'
            + bars(dns['hours'])
            + f'</div><div class="control"><div class="buttons">{controls}</div>'
            f'<p class="small muted">{number(dns["gravity"])} domains on blocklists, '
            f'{dns["clients"]} active clients</p></div>' + tops + '</section>'
        )
    else:
        dns_html = (
            '<section class="section" id="pihole">'
            + section_head('Pi-hole', 'No reading', 'warn')
            + '<p class="note">Pi-hole did not answer. Its blocking state is unknown until it does.</p></section>'
        )

    devices = data.get('devices', [])
    online = [d for d in devices if d.get('online')]
    baseline = min((d.get('firstSeen') or time.time() for d in devices), default=time.time())
    shown, rest = online[:6], online[6:40]
    naming = data.get('naming') or {}
    moves = [m for m in naming.get('moves', []) if time.time() - m.get('at', 0) < 7 * 86400][-3:]
    move_text = ''.join(
        f'<p class="note">{e(m["name"])} moved from {e(m["from"])} to {e(m["to"])}, {e(ago(m["at"]))}.</p>'
        for m in reversed(moves)
    )
    home_html = (
        '<section class="section" id="home-network">'
        + section_head(
            'Home network',
            f'{len(online)} online',
            link='<a class="head-link" href="/network-map#map">Map</a>',
        )
        + f'<ul class="rows">{device_rows(shown, baseline) or row(None, "No inventory yet")}</ul>'
        + (
            disclosure(
                'home-network-all',
                f'Show {len(rest)} more',
                '',
                f'<ul class="rows">{device_rows(rest, baseline)}</ul>',
                nested=True,
            )
            if rest
            else ''
        )
        + f'<p class="note">Names follow MAC addresses, even when IP addresses change. '
        f'{naming.get("registered", 0)} registered.</p>{move_text}</section>'
    )

    # 3. Health of the Pi and its services, then the rest of the home; long lists stay collapsed.
    hot = (temperature or 0) >= 70
    power, power_warning = power_reading(host)
    pi_html = panel(
        'pi',
        'Raspberry Pi',
        ' · '.join(
            part
            for part in (
                f'{temperature:.0f} °C' if temperature is not None else '',
                f'{host["cpuPercent"]:.0f}% CPU' if host.get('cpuPercent') is not None else '',
                'restart needed' if host.get('rebootRequired') else '',
            )
            if part
        )
        or 'No reading',
        '<div class="readings six">'
        + reading(
            f'{temperature:.0f} °C' if temperature is not None else '—',
            'Temperature',
            'warn' if hot else '',
        )
        + reading(
            f'{host["cpuPercent"]:.0f}%' if host.get('cpuPercent') is not None else '—', 'CPU'
        )
        + reading(f'{host["load1"]:.2f}' if host.get('load1') is not None else '—', 'Load')
        + reading(size(snapshot.get('memoryAvailableBytes')), 'Free memory')
        + reading(size(snapshot.get('storageFreeBytes')), 'Free storage')
        + reading(power, 'Power', 'warn' if power_warning else '')
        + '</div><h3>Temperature, last 24 hours</h3>'
        + sparkline(list(_temperatures))
        + (
            '<p class="note">Restart needed after system updates.</p>'
            if host.get('rebootRequired')
            else ''
        ),
        'warn' if hot or host.get('rebootRequired') else '',
    )
    stopped = len(units) - running
    services_html = panel(
        'services',
        'Services',
        f'{stopped} stopped'
        if stopped
        else (f'All {len(units)} running' if units else 'No reading'),
        '<ul class="rows services">'
        + ''.join(
            row(
                u['state'] in ('active', 'reloading'),
                UNIT_LABELS.get(u['name'], u['name']),
                'running' if u['state'] in ('active', 'reloading') else u['state'],
            )
            for u in units
        )
        + '</ul>',
        'warn' if stopped else '',
    )

    peers = data.get('peers') or []
    peer_rows = ''.join(
        row(
            p['online'],
            p['name'],
            (p['os'] + (' · direct' if p['direct'] else ' · relay'))
            if p['online']
            else f'{p["os"]} · {ago(p["seen"])}',
        )
        for p in peers
    )
    tail_html = panel(
        'tailscale',
        'Tailscale',
        f'{sum(p["online"] for p in peers)} of {len(peers)} online' if peers else 'No reading',
        f'<ul class="rows">{peer_rows or row(None, "No data")}</ul>',
    )

    backup = data.get('backups')
    repos = data.get('repos') or []
    backup_fresh = bool(backup) and (time.time() - backup['at']) < 36 * 3600
    backup_row = (
        row(
            backup_fresh,
            'Encrypted backup',
            f'{ago(backup["at"])} · {size(backup["bytes"])} · {backup["count"]} copies',
        )
        if backup
        else row(False, 'Encrypted backup', 'no backups')
    )
    repo_rows = ''.join(row(True, r['name'], f'{r["branch"]} · {ago(r["at"])}') for r in repos)
    safe_html = panel(
        'backups',
        'Backups and source',
        f'Last backup {ago(backup["at"])}' if backup else 'No backups',
        f'<ul class="rows">{backup_row}{repo_rows}</ul>',
        '' if backup_fresh else 'warn',
    )

    links = (
        '<nav class="section links" aria-label="Other panels">'
        + ('' if show_automation else STORAGE_LINK)
        + '<a href="/admin/">Pi-hole admin<span aria-hidden="true">›</span></a>'
        + router_link(data.get('devices'))
        + '</nav>'
    )

    body = (
        overview_html
        + net_html
        + dns_html
        + f'<div class="pair">{pi_html}{services_html}</div>'
        + home_html
        + f'<div class="pair">{tail_html}{safe_html}</div>'
        + tablet_card(
            data.get('peers'), data.get('tabletPeer'), data.get('at'), data.get('tabletSummary')
        )
        + links
        + '<footer>Private to your Tailscale account.</footer>'
    )
    return page(body, nonce, data.get('at'))


TABS = (
    ('home', '/', 'Home', 'M3 11 12 4l9 7v9h-6v-6H9v6H3z'),
    (
        'map',
        '/network-map#map',
        'Network',
        'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM5 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm14 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 9v3m0 0-5 4m5-4 5 4',
    ),
    ('traffic', '/network-map#traffic', 'Traffic', 'M3 17l5-6 4 3 6-8 3 3M3 21h18'),
    ('ports', '/network-map#ports', 'Ports', 'M4 6h16v12H4zM8 10h2v4H8zm6 0h2v4h-2z'),
)


def tab_bar(active):
    """Shared bottom navigation; network-map.html carries the same markup for its views."""
    current = ' aria-current="page"'
    links = ''.join(
        f'<a href="{href}" data-tab="{key}"{current if key == active else ""}>'
        f'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="{icon}"/></svg><span>{label}</span></a>'
        for key, href, label, icon in TABS
    )
    return f'<nav class="tabbar" aria-label="Sections">{links}</nav>'


OFFLINE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0e0e0e">
<title>LEÓN Home</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0e0e0e;color:#eeeae3;
font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px}img{width:64px;height:64px}p{color:#a39e94;max-width:300px}
a{display:inline-block;margin-top:12px;color:#111;background:#eeeae3;border-radius:999px;padding:10px 18px;text-decoration:none}</style></head>
<body><div><img src="/brand/symbol.png" alt=""><h1>Offline</h1><p>LEÓN Home is unreachable. Connect Tailscale and try again.
Readings are not stored on this phone.</p><a href="/">Try again</a></div></body></html>""".encode(
    'utf-8'
)


def port_action(port, enabled):
    return router_action({'port': port, 'enabled': enabled})


def device_action(mac, blocked):
    return router_action({'device': mac, 'blocked': blocked})


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
    password it asks the monitor to create the vault instead. Never logged or kept."""
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


def usb_storage_rows():
    try:
        result = subprocess.run(
            [
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
        return row(None, 'USB inventory unavailable')

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
            rows.append(row(bool(mounts) or None, name, ' · '.join(filter(None, details))))
            if len(rows) == 24:
                return ''.join(rows)
    return ''.join(rows) or row(None, 'No USB storage detected')


def storage_destination_rows(mounted, show_automation):
    destinations = [('Library', 'library'), ('Exchange', 'exchange')]
    if show_automation:
        destinations.append(('n8n data', 'n8n'))

    rows = []
    for name, directory in destinations:
        path = os.path.join(STORAGE_MOUNT, directory)
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
        rows.append(row(ready, name, f'{path} · {status}'))
    return ''.join(rows)


def render_storage(*, show_automation=True):
    mounted = os.path.ismount(STORAGE_MOUNT)
    if mounted:
        try:
            usage = shutil.disk_usage(STORAGE_MOUNT)
            share = row(True, 'Mounted', f'{size(usage.free)} free of {size(usage.total)}')
        except OSError:
            share = row(None, 'Capacity unavailable')
    else:
        share = row(None, 'Volume not mounted')
    content = (
        panel('nas', 'Shared storage', '', f'<ul class="rows">{share}</ul>')
        + panel(
            'destinations',
            'Storage destinations',
            '',
            f'<ul class="rows">{storage_destination_rows(mounted, show_automation)}</ul>',
        )
        + panel('usb', 'USB drives', '', f'<ul class="rows">{usb_storage_rows()}</ul>')
        + '<nav class="section links" aria-label="Storage navigation">'
        + ('<a href="/storage/files">Browse files</a>' if mounted else '')
        + '<a href="/storage">Refresh storage</a><a href="/">Back to Home</a></nav>'
    )
    return page(content, None, time.time(), section='Storage')


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


def file_link(relative, *, directory):
    query = urllib.parse.urlencode({'path': relative})
    return f'/storage/files?{query}' if directory else f'/storage/download?{query}'


def entry_row(relative, name, is_directory, detail):
    href = e(file_link(relative, directory=is_directory))
    label = f'{name}/' if is_directory else name
    return (
        f'<li><i class="dot {"ok" if is_directory else "idle"}"></i>'
        f'<a class="grow entry" href="{href}"><span>{e(label)}</span>'
        f'<small>{e(detail)}</small></a></li>'
    )


def directory_rows(target, relative):
    try:
        with os.scandir(target) as entries:
            listed = []
            for entry in entries:
                if visible(entry.name) and not entry.is_symlink():
                    listed.append(entry)
                if len(listed) > MAX_LISTED:
                    break
    except OSError:
        return row(None, 'Folder unavailable'), False
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
        rows.append(entry_row(child, entry.name, is_directory, detail))
    return ''.join(rows) or row(None, 'Empty folder'), truncated


def search_rows(target, relative, query):
    """Bounded case-insensitive name search below the current folder."""
    needle = query.casefold()
    deadline = time.monotonic() + SEARCH_LIMITS['seconds']
    rows, visited, complete = [], 0, True
    pending = collections.deque([(target, relative, 0)])
    while pending:
        folder, prefix, depth = pending.popleft()
        try:
            with os.scandir(folder) as entries:
                children = [
                    item for item in entries if visible(item.name) and not item.is_symlink()
                ]
        except OSError:
            continue
        for entry in sorted(children, key=lambda item: item.name.casefold()):
            visited += 1
            if (
                len(rows) >= SEARCH_LIMITS['results']
                or visited > SEARCH_LIMITS['visited']
                or time.monotonic() > deadline
            ):
                return ''.join(rows), False
            child = f'{prefix}/{entry.name}' if prefix else entry.name
            try:
                is_directory = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if needle in entry.name.casefold():
                rows.append(entry_row(child, entry.name, is_directory, prefix or 'Top folder'))
            if is_directory:
                if depth + 1 < SEARCH_LIMITS['depth']:
                    pending.append((entry.path, child, depth + 1))
                else:
                    complete = False
    return ''.join(rows), complete


def breadcrumbs(relative):
    links = ['<a href="/storage/files">Drive</a>']
    parts = relative.split('/') if relative else []
    for index, part in enumerate(parts):
        link = e(file_link('/'.join(parts[: index + 1]), directory=True))
        links.append(f'<a href="{link}">{e(part)}</a>')
    return (
        '<nav class="section crumbs" aria-label="Folder path">'
        + '<span aria-hidden="true">›</span>'.join(links)
        + '</nav>'
    )


def render_files(relative, query=''):
    resolved = storage_path(relative)
    if resolved is None or not os.path.isdir(resolved[0]):
        body = panel(
            'files',
            'Files',
            '',
            f'<ul class="rows">{row(None, "Folder unavailable or drive not mounted")}</ul>',
        )
        return page(body + breadcrumbs(''), None, time.time(), section='Files'), 404
    target, relative = resolved
    query = query.strip()[:80]
    search = (
        '<form class="section" method="get" action="/storage/files" role="search">'
        f'<input type="hidden" name="path" value="{e(relative)}">'
        f'<input type="search" name="q" value="{e(query)}" maxlength="80" '
        'placeholder="Search this folder" aria-label="Search this folder" enterkeyhint="search">'
        '</form>'
    )
    if query:
        rows, complete = search_rows(target, relative, query)
        title = 'Search results'
        meta = '' if complete else 'Partial results; refine the search'
        rows = rows or row(None, 'No matching names')
    else:
        rows, truncated = directory_rows(target, relative)
        title = relative.rsplit('/', 1)[-1] if relative else 'Drive'
        meta = f'First {MAX_LISTED} items' if truncated else ''
    body = (
        breadcrumbs(relative)
        + search
        + panel('files', title, meta, f'<ul class="rows">{rows}</ul>')
        + '<nav class="section links" aria-label="Storage navigation">'
        '<a href="/storage">Storage</a><a href="/">Back to Home</a></nav>'
    )
    return page(body, None, time.time(), section='Files'), 200


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


def automation_setup(config, login, *, opened=False, message=''):
    if not login:
        return ''
    editor = config.get('editorUrl')
    editor = editor if isinstance(editor, str) and N8N_EDITOR.fullmatch(editor) else ''
    stored_key = config.get('apiKey')
    key_required = (
        '' if isinstance(stored_key, str) and N8N_KEY.fullmatch(stored_key) else ' required'
    )
    return (
        f'<details class="section automation-setup" id="automation-settings"{" open" if opened else ""}>'
        '<summary>Connection settings</summary>'
        '<p class="note">Create a key in n8n under Settings → n8n API with workflow:list and '
        'execution:list access. Use the private Tailscale address if you have enabled HTTPS for n8n.</p>'
        + (f'<p class="note" role="status">{e(message)}</p>' if message else '')
        + '<form class="automation-form" method="post" action="/automation/settings">'
        f'<input type="hidden" name="t" value="{e(token(login))}">'
        '<label for="automation-key">Read-only API key</label>'
        f'<input id="automation-key" type="password" name="apiKey" maxlength="4096" autocomplete="off"{key_required}>'
        '<label for="automation-url">Private editor URL</label>'
        f'<input id="automation-url" type="text" name="editorUrl" inputmode="url" maxlength="253" value="{e(editor)}">'
        '<button class="primary">Save connection</button></form></details>'
    )


def render_automation(login=None, *, failures_only=False, message=''):
    response = n8n_get('/healthz/readiness')
    ready = isinstance(response, dict) and response.get('status') == 'ok'
    config = n8n_panel_config()
    workflows, executions = n8n_data(config) if ready else (None, None)
    editor_url = config.get('editorUrl')
    editor_ready = isinstance(editor_url, str) and N8N_EDITOR.fullmatch(editor_url)
    editor_link = (
        f'<a class="automation-action primary" href="{e(editor_url)}">Open n8n editor</a>'
        if editor_ready
        else ''
    )
    headline = 'n8n is ready' if ready else 'n8n is unavailable'
    status = 'ok' if ready else 'idle'
    workflow_names = {}
    workflow_items = []
    for workflow in workflows or []:
        workflow_id = workflow.get('id')
        if not isinstance(workflow_id, str) or not N8N_ID.fullmatch(workflow_id):
            continue
        name = clean_name(workflow.get('name')) or 'Workflow'
        workflow_names[workflow_id] = name
        active = workflow.get('active')
        state = (
            {True: 'Published', False: 'Draft'}.get(active, 'Unknown')
            if type(active) is bool
            else 'Unknown'
        )
        link = (
            f'<a class="head-link" href="{e(editor_url.rstrip("/"))}/workflow/{workflow_id}">Open</a>'
            if editor_ready
            else ''
        )
        workflow_items.append(row(active is True or None, name, state, extra=link))

    execution_items = []
    for execution in executions or []:
        raw_status = clean_name(execution.get('status'))
        if failures_only and raw_status not in ('error', 'crashed'):
            continue
        label, tone = EXECUTION_STATES.get(raw_status, ('Unknown', None))
        execution_workflow = clean_name(execution.get('workflowId'))
        name = workflow_names.get(execution_workflow, 'Workflow execution')
        started = clean_name(execution.get('startedAt'))
        time_label = re.sub(
            r'T|Z$', lambda match: ' ' if match[0] == 'T' else ' UTC', started or ''
        )
        execution_items.append(row(tone, name, f'{label} · {time_label}' if started else label))
    connected = workflows is not None or executions is not None
    setup_link = (
        '<a class="head-link" href="#automation-settings">Connect</a>' if not connected else ''
    )
    filters = ''
    if executions is not None:
        selected_all = '' if failures_only else ' aria-current="true"'
        selected_failed = ' aria-current="true"' if failures_only else ''
        filters = (
            '<nav class="automation-filters" aria-label="Filter executions">'
            f'<a href="/automation#executions"{selected_all}>All</a>'
            f'<a href="/automation?status=failed#executions"{selected_failed}>Failed</a></nav>'
        )
    overview_html = (
        f'<section class="overview automation-overview" id="automation-service">'
        f'<h1 class="status-line"><i class="dot {status}"></i>{headline}</h1>'
        '<dl class="automation-metrics">'
        f'<div><dt>Workflows shown</dt><dd>{len(workflow_items) if workflows is not None else "—"}</dd></div>'
        f'<div><dt>Recent runs</dt><dd>{len(executions) if executions is not None else "—"}</dd></div>'
        '</dl><nav class="automation-actions" aria-label="Automation actions">'
        + editor_link
        + '<a class="automation-action" href="/automation">Refresh</a>'
        '<a class="automation-action" href="/storage">Storage</a></nav></section>'
    )
    empty_workflows = 'No workflows found' if workflows is not None else 'Workflow list unavailable'
    empty_executions = (
        'No stored executions' if executions is not None else 'Execution history unavailable'
    )
    if failures_only and executions is not None:
        empty_executions = 'No failures in recent executions'
    runs = ''.join(execution_items) or row(None, empty_executions)
    work = ''.join(workflow_items) or row(None, empty_workflows)
    content = (
        overview_html
        + '<div class="pair">'
        + '<section class="section automation-list" id="workflows">'
        + section_head('Workflows', link=setup_link)
        + f'<ul class="rows">{work}</ul></section>'
        + panel('executions', 'Recent executions', '', filters + f'<ul class="rows">{runs}</ul>')
        + '</div>'
        + automation_setup(config, login, opened=not connected or bool(message), message=message)
    )
    return page(content, None, time.time(), section='Automation')


def page(body, nonce, updated=None, *, section='Home'):
    navigation = tab_bar('home' if section == 'Home' else '')
    module = (
        f'<script type="module" nonce="{nonce}" src="/network-map/assets/home.js"></script>'
        if nonce
        else ''
    )
    stamp = (
        f'<time class="updated" datetime="{e(time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(updated)))}">'
        f'Updated {e(time.strftime("%H:%M", time.localtime(updated)))}</time>'
        if updated
        else ''
    )
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e0e0e"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="LEÓN Home"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/brand/symbol.png"><link rel="manifest" href="/manifest.webmanifest"><title>LEÓN Home</title><link rel="stylesheet" href="/network-map/assets/home.css"></head><body>
<p class="connection" id="connection" role="status" hidden></p><main>
<header><img class="symbol" src="/brand/symbol.png" alt=""><img class="word" src="/brand/wordmark.png" alt="LEÓN">
<span class="sub">{e(section)}</span>{stamp}</header>{body}</main>{navigation}{module}</body></html>""".encode(
        'utf-8'
    )


# ---------------------------------------------------------------- HTTP


class Handler(http.server.BaseHTTPRequestHandler):
    storage_automation = True

    server_version = 'leon-overview'
    sys_version = ''

    def owner(self):
        login = (self.headers.get('Tailscale-User-Login') or '').strip().lower()
        return login if login and login in OWNERS else None

    def do_GET(self):
        login = self.owner()
        if not login:
            return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
        path = self.path.split('?', 1)[0]
        if path == '/automation' and self.storage_automation:
            query = (
                urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=10)
                if len(self.path) <= 256 and self.path.count('&') < 10
                else {}
            )
            return self.reply(
                200,
                render_automation(login, failures_only=query.get('status') == ['failed']),
                'text/html; charset=utf-8',
            )
        if path in ('/storage/files', '/storage/download'):
            query = (
                urllib.parse.parse_qs(self.path.partition('?')[2], max_num_fields=2)
                if len(self.path) <= 4096
                else {}
            )
            relative = (query.get('path') or [''])[0]
            if path == '/storage/download':
                return self.download(relative)
            body, status = render_files(relative, (query.get('q') or [''])[0])
            return self.reply(status, body, 'text/html; charset=utf-8')
        if path == '/storage':
            return self.reply(
                200,
                render_storage(show_automation=self.storage_automation),
                'text/html; charset=utf-8',
            )
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
        if path in ('/network-map', '/network-map/data'):
            # Unlike legacy overview access, map access always requires an explicit owner.
            if login not in OWNERS:
                return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
            with _lock:
                data = dict(_data)
            if path.endswith('/data'):
                body = json.dumps(
                    {**network_map.snapshot(data), 'actionToken': token(login)}, allow_nan=False
                ).encode('utf-8')
                return self.reply(200, body, 'application/json; charset=utf-8')
            nonce = base64.b64encode(os.urandom(12)).decode()
            try:
                with open(
                    os.path.join(os.path.dirname(__file__), 'network-map.html'), encoding='utf-8'
                ) as handle:
                    template = handle.read(128_001)
                if len(template) > 128_000:
                    raise ValueError('Map template too large')
            except (OSError, ValueError):
                return self.reply(503, b'Map unavailable', 'text/plain; charset=utf-8')
            return self.reply(
                200,
                template.replace('__NONCE__', nonce).encode('utf-8'),
                'text/html; charset=utf-8',
                nonce=nonce,
            )
        if path not in ('/', '/index.html'):
            return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        with _lock:
            data = dict(_data)
        nonce = base64.b64encode(os.urandom(12)).decode()
        self.reply(200, render(data, login, nonce), 'text/html; charset=utf-8', nonce=nonce)

    def do_POST(self):
        login = self.owner()
        if not login:
            return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
        if self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin'):
            return self.reply(403, b'Cross-site request refused', 'text/plain; charset=utf-8')
        if self.path == '/automation/settings' and self.storage_automation:
            return self.automation_settings(login)
        length = int(self.headers.get('Content-Length') or 0)
        if length > 2048:
            return self.reply(413, b'Too large', 'text/plain; charset=utf-8')
        if self.path == '/network-map/port':
            return self.port(login, length)
        if self.path == '/network-map/unlock':
            return self.unlock(login, length)
        if self.path == '/network-map/name':
            return self.rename(login, length)
        if self.path == '/network-map/pause':
            return self.pause(login, length)
        if self.path == '/network-map/schedule':
            return self.schedule(login, length)
        form = urllib.parse.parse_qs(self.rfile.read(length).decode('utf-8', 'replace'))
        if not token_valid(login, (form.get('t') or [''])[0]):
            return self.reply(403, b'Expired form. Reload the page.', 'text/plain; charset=utf-8')
        try:
            if self.path == '/action/pause' and (form.get('s') or [''])[0] in PAUSE_CHOICES:
                set_blocking(False, int(form['s'][0]))
            elif self.path == '/action/resume':
                set_blocking(True)
            else:
                return self.reply(404, b'Not found', 'text/plain; charset=utf-8')
        except (OSError, ValueError, KeyError, TypeError):
            return self.reply(
                502, b'Pi-hole did not accept the change.', 'text/plain; charset=utf-8'
            )
        print(f'action {self.path} by owner', file=sys.stderr, flush=True)
        self.send_response(303)
        self.send_header('Location', '/')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def automation_settings(self, login):
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if (
                not 1 <= length <= 8192
                or self.headers.get('Transfer-Encoding')
                or self.headers.get('Content-Type', '').split(';', 1)[0]
                != 'application/x-www-form-urlencoded'
            ):
                raise ValueError
            form = urllib.parse.parse_qs(
                self.rfile.read(length).decode(), keep_blank_values=True, max_num_fields=3
            )
            if set(form) != {'t', 'apiKey', 'editorUrl'} or any(len(v) != 1 for v in form.values()):
                raise ValueError
        except (ValueError, UnicodeError):
            return self.reply(400, b'Invalid connection settings', 'text/plain')
        if not token_valid(login, form['t'][0]):
            return self.reply(403, b'Expired form. Reload the page.', 'text/plain')

        config = n8n_panel_config()
        key = form['apiKey'][0].strip() or config.get('apiKey')
        editor = form['editorUrl'][0].strip()
        if not isinstance(key, str) or not N8N_KEY.fullmatch(key):
            message = 'Enter an n8n API key.'
        elif editor and (len(editor) > 253 or not N8N_EDITOR.fullmatch(editor)):
            message = 'Use the HTTPS address ending in ts.net for the editor.'
        elif (
            n8n_rows(n8n_get('/api/v1/workflows?limit=1', key)) is None
            or n8n_rows(n8n_get('/api/v1/executions?limit=1&includeData=false', key)) is None
        ):
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
                message = 'Could not save the connection on this Pi.'
            else:
                self.send_response(303)
                self.send_header('Location', '/automation')
                self.send_header('Content-Length', '0')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                return
        return self.reply(
            400, render_automation(login, message=message), 'text/html; charset=utf-8'
        )

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
                or set(request) not in ({'phrase'}, {'phrase', 'password'})
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

    def download(self, relative):
        resolved = storage_path(relative)
        try:
            if resolved is None:
                raise FileNotFoundError(relative)
            handle = open(resolved[0], 'rb')  # noqa: SIM115  (closed below)
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
            name = os.path.basename(resolved[0])
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
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
