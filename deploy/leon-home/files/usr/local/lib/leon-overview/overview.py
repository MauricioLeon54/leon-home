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
import http.server
import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collector  # noqa: E402  (the LEÓN snapshot collector, copied beside this file)
import internet_health
import network_map
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
UNLOCK_OUTCOMES = frozenset({'current', 'unlockFailed', 'busy', 'notConfigured'})
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
    'unbound': 'DNS cifrado',
    'tailscaled': 'Tailscale',
    'ssh': 'SSH',
    'leon-dns-firewall': 'Firewall DNS',
    'leon-netmap.timer': 'Escaneo de red',
    'leon-backup.timer': 'Respaldo cifrado',
    'leon-overview': 'Este sitio',
    'unattended-upgrades': 'Actualizaciones',
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
        'lang': 'es',
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
    for device in devices:
        mac = macs.get(device['ip'])
        device['mac'] = mac
        device['protected'] = bool(mac) and (protected is None or mac in protected)
        device['pauseSchedule'] = schedules.get(mac)
        device['canRename'] = bool(mac)
        if owned.get(mac):
            device['label'] = owned[mac]
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
        return 'ahora'
    if seconds < 3600:
        return f'hace {int(seconds // 60)} min'
    if seconds < 86400:
        return f'hace {int(seconds // 3600)} h'
    return f'hace {int(seconds // 86400)} d'


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


def problems(data):
    host, dns, found = data.get('host', {}), data.get('dns'), []
    flags = host.get('throttledFlags')
    if flags is not None and flags & 0x1:
        found.append('Bajo voltaje')
    elif flags is not None and flags & 0xE:
        found.append('CPU limitada')
    if (host.get('temperatureCelsius') or 0) >= 70:
        found.append('Temperatura alta')
    found += [
        UNIT_LABELS.get(u['name'], u['name']) + ' detenido'
        for u in host.get('units', [])
        if u['state'] not in ('active', 'reloading')
    ]
    if host.get('failedUnits'):
        found.append(f'{host["failedUnits"]} servicios con fallo')
    if host.get('clockSynchronized') is False:
        found.append('Reloj sin sincronizar')
    if dns is None:
        found.append('Pi-hole no responde')
    if (data.get('internet') or {}).get('internetMs') is None and data.get('internet') is not None:
        found.append('Sin internet')
    return found


def tile(value, label, tone=''):
    return f'<div class="tile {tone}"><b>{e(value)}</b><span>{e(label)}</span></div>'


def row(ok, text, detail='', extra=''):
    tone = 'ok' if ok is True else ('bad' if ok is False else 'idle')
    return (
        f'<li><i class="dot {tone}"></i><span class="grow">{e(text)}</span>{extra}'
        f'{f"<small>{e(detail)}</small>" if detail else ""}</li>'
    )


OUTREACH_LABELS = {
    'ok': 'activo',
    'paused': 'en pausa',
    'idle': 'sin actividad',
    'stale': 'sin acciones recientes',
    'signed-out': 'sesión cerrada',
    'human-check': 'verificación humana',
    'rate-limited': 'limitado',
}
DISPLAY_LABELS = {'awake': 'encendida', 'asleep': 'apagada', 'dreaming': 'protector de pantalla'}


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
            'completa'
            if battery['full']
            else 'cargando'
            if battery['charging']
            else 'conectada'
            if battery['pluggedIn']
            else 'en batería'
        )
        heat = (
            f' · {battery["temperatureCelsius"]:.0f} °C'
            if battery.get('temperatureCelsius') is not None
            else ''
        )
        low = battery['percent'] < 15 and not battery['pluggedIn']
        rows.append(row(tone(not low), 'Batería', f'{battery["percent"]}% · {state}{heat}'))
    else:
        rows.append(row(None, 'Batería', 'sin lectura (ADB de la tableta no disponible)'))
    if summary.get('display'):
        rows.append(row(None, 'Pantalla', DISPLAY_LABELS[summary['display']]))
    else:
        rows.append(row(None, 'Pantalla', 'sin lectura'))
    if summary.get('storageFreePercent') is not None:
        rows.append(
            row(
                tone(summary['storageFreePercent'] >= 10),
                'Almacenamiento libre',
                f'{summary["storageFreePercent"]}%',
            )
        )
    if summary.get('memoryAvailablePercent') is not None:
        rows.append(row(None, 'Memoria disponible', f'{summary["memoryAvailablePercent"]}%'))
    outreach = summary.get('outreach')
    if outreach:
        fresh = now - outreach['checkedAt'] <= REPORT_FRESH_SECONDS
        rows.append(
            row(
                tone(fresh and not outreach['needsAttention']),
                'Outreach',
                f'{OUTREACH_LABELS[outreach["state"]]} · {outreach["actions24h"]} acciones y '
                f'{outreach["errors24h"]} errores en 24 h · {ago(outreach["checkedAt"])}',
            )
        )
    trader = summary.get('trader')
    if trader:
        fresh = now - trader['checkedAt'] <= REPORT_FRESH_SECONDS
        state = (
            'kill switch activo'
            if trader['killSwitch']
            else 'detenido por pérdida'
            if trader['halted']
            else 'activo'
        )
        change = f' · {trader["returnPct"]}%' if trader.get('returnPct') is not None else ''
        rows.append(
            row(
                tone(fresh and not trader['killSwitch'] and not trader['halted']),
                'Trader (simulado)',
                f'{state}{change} · {ago(trader["checkedAt"])}',
            )
        )
    age = (
        f'Leído por la Mac {ago(summary["observedAt"])}'
        if current
        else f'Dato obsoleto: la Mac lo leyó {ago(summary["observedAt"])}'
    )
    return ''.join(rows), age


def tablet_card(peers, name, observed_at, stored=None, now=None):
    """Reachability of the configured tablet plus the Mac's last reading of it. Unknown stays unknown."""
    now = now or time.time()
    detail_rows, age = tablet_summary_rows(stored, now)
    if not name and not detail_rows:
        return ''
    peer = next((p for p in peers or [] if p['name'] == name), None)
    if not name:
        line = ''
    elif peers is None:
        line = row(None, 'Tableta', 'sin datos de Tailscale')
    elif peer is None:
        line = row(None, 'Tableta', 'no aparece en la tailnet')
    elif peer['online']:
        line = row(
            True, 'Tableta', 'en línea · ' + ('conexión directa' if peer['direct'] else 'por relay')
        )
    else:
        line = row(False, 'Tableta', f'fuera de línea · visto {ago(peer["seen"])}')
    summary_note = (
        (
            f'<p class="muted small note">{e(age)}. Si la Mac duerme o LEÓN Labs está cerrada, estos datos '
            f'envejecen.</p>'
        )
        if detail_rows
        else (
            '<p class="muted small note">Batería, pantalla y servicios aparecen cuando la Mac publica una lectura.</p>'
        )
    )
    return (
        f'<section class="card"><h3>Tableta</h3><ul>{line}{detail_rows}</ul>'
        f'<p class="muted small note">Alcance por Tailscale, leído {e(ago(observed_at))}. Aviso al teléfono tras '
        f'10 min fuera de línea.</p>{summary_note}</section>'
    )


def donut(percent):
    circumference = 2 * 3.14159 * 42
    filled = max(0.0, min(100.0, percent or 0)) / 100 * circumference
    return (
        f'<svg class="donut" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42"/>'
        f'<circle class="arc" cx="50" cy="50" r="42" stroke-dasharray="{filled:.1f} {circumference:.1f}"/></svg>'
    )


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
            f'<g><title>{label} · {total} consultas, {blocked} bloqueadas</title>'
            f'<rect class="total" x="{x}" y="{height - h_total:.1f}" width="{width}" height="{h_total:.1f}" rx="2"/>'
            f'<rect class="blocked" x="{x}" y="{height - h_block:.1f}" width="{width}" height="{h_block:.1f}" rx="2"/></g>'
        )
    first = time.strftime('%H:00', time.localtime(hours[0][0] * 3600))
    return (
        f'<svg class="bars" viewBox="0 0 {len(hours) * (width + gap) - gap} {height}" preserveAspectRatio="none" '
        f'aria-label="Consultas por hora">{"".join(parts)}</svg>'
        f'<div class="axis"><span>{first}</span><span>ahora</span></div>'
    )


def sparkline(points):
    if len(points) < 2:
        return '<p class="muted small">La gráfica aparece tras unos minutos de lecturas.</p>'
    values = [v for _, v in points]
    low, high = min(values) - 1, max(values) + 1
    start, span = points[0][0], (points[-1][0] - points[0][0]) or 1
    coords = ' '.join(
        f'{(t - start) / span * 300:.1f},{60 - (v - low) / (high - low) * 56 - 2:.1f}'
        for t, v in points
    )
    return (
        f'<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-label="Temperatura">'
        f'<polyline points="{coords}"/></svg>'
        f'<div class="axis"><span>mín {min(values):.0f} °C</span><span>máx {max(values):.0f} °C</span></div>'
    )


def strip(presence):
    cells = ''.join(f'<b class="{"on" if p else ""}"></b>' for p in (presence or [])[-16:])
    return f'<span class="strip" aria-hidden="true">{cells}</span>' if cells else ''


def render(data, login, nonce):
    if not data:
        return page(
            '<section class="card hero"><h2>Preparando lecturas…</h2>'
            '<p class="muted">La primera muestra tarda unos segundos.</p></section>',
            nonce,
        )
    snapshot, host, dns = data['snapshot'], data['host'], data.get('dns')
    issues = problems(data)
    units = host.get('units', [])
    running = sum(u['state'] in ('active', 'reloading') for u in units)
    temperature = host.get('temperatureCelsius')
    flags = host.get('throttledFlags')
    headline = 'Todo funciona' if not issues else ' · '.join(issues)
    hero = (
        f'<section class="card hero {"ok" if not issues else "bad"}">'
        f'<div class="status"><i class="dot {"ok" if not issues else "bad"} pulse"></i>'
        f'<h2>{e(headline)}</h2></div>'
        f'<p class="muted">Encendida {e(duration(snapshot.get("uptimeSeconds")))} · '
        f'{running}/{len(units)} servicios · {e(f"{temperature:.0f} °C" if temperature is not None else "—")}</p></section>'
    )

    internet = data.get('internet') or {}
    router = internet.get('router') or {}
    net_card = (
        '<section class="card"><h3>Internet</h3><div class="tiles four">'
        + tile(ms(router.get('averageMs') if isinstance(router, dict) else None), 'Router')
        + tile(
            ms(internet.get('internetMs')),
            'Internet',
            '' if internet.get('internetMs') is not None else 'warn',
        )
        + tile(ms(internet.get('dnsMs')), 'DNS del router')
        + tile(ms(dns.get('upstreamMs') if dns else None), 'DNS cifrado')
        + '</div></section>'
    )

    if dns:
        paused = dns.get('blocking') != 'enabled'
        timer = dns.get('timer')
        state = (
            'Bloqueo activo'
            if not paused
            else f'Bloqueo en pausa{f" · {int(timer // 60)} min restantes" if timer else ""}'
        )
        controls = (
            ''.join(
                f'<form method="post" action="/action/pause"><input type="hidden" name="t" value="{e(token(login))}">'
                f'<input type="hidden" name="s" value="{seconds}"><button>Pausar {label}</button></form>'
                for seconds, label in PAUSE_CHOICES.items()
            )
            if not paused
            else (
                f'<form method="post" action="/action/resume"><input type="hidden" name="t" value="{e(token(login))}">'
                f'<button class="primary">Reanudar bloqueo</button></form>'
            )
        )
        dns_card = (
            f'<section class="card"><h3>DNS · Pi-hole</h3>'
            f'<div class="split"><div class="ring">{donut(dns["percent"])}'
            f'<div><b>{dns["percent"]:.1f}%</b><span>bloqueado hoy</span></div></div>'
            f'<div class="tiles two">{tile(number(dns["queries"]), "Consultas")}'
            f'{tile(number(dns["blocked"]), "Bloqueadas")}{tile(number(dns["gravity"]), "Dominios en listas")}'
            f'{tile(str(dns["clients"]), "Clientes activos")}</div></div>'
            f'<h4>Últimas 24 horas <span class="legend"><i class="sw total"></i>consultas'
            f'<i class="sw blocked"></i>bloqueadas</span></h4>{bars(dns["hours"])}'
            f'<div class="control"><span class="{"warnText" if paused else "goodText"}">{e(state)}</span>'
            f'<div class="buttons">{controls}</div></div></section>'
        )
        lists = (
            '<div class="grid2">'
            '<section class="card"><h3>Más bloqueados</h3><ul>'
            + ''.join(row(None, domain, number(count)) for domain, count in dns['topBlocked'])
            + '</ul></section><section class="card"><h3>Quién consulta más</h3><ul>'
            + ''.join(row(True, name, number(count)) for name, count in dns['topClients'])
            + '</ul></section></div>'
        )
    else:
        dns_card, lists = (
            '<section class="card"><h3>DNS · Pi-hole</h3><p class="muted">Sin datos de Pi-hole.</p></section>',
            '',
        )

    power = 'OK' if flags == 0 else ('Revisar' if flags else '—')
    pi_card = (
        '<section class="card"><h3>Raspberry Pi</h3><div class="tiles three">'
        + tile(
            f'{temperature:.0f} °C' if temperature is not None else '—',
            'Temperatura',
            'warn' if (temperature or 0) >= 70 else '',
        )
        + tile(f'{host["cpuPercent"]:.0f}%' if host.get('cpuPercent') is not None else '—', 'CPU')
        + tile(f'{host["load1"]:.2f}' if host.get('load1') is not None else '—', 'Carga')
        + tile(size(snapshot.get('memoryAvailableBytes')), 'RAM libre')
        + tile(size(snapshot.get('storageFreeBytes')), 'Disco libre')
        + tile(power, 'Alimentación', '' if flags in (0, None) else 'warn')
        + '</div><h4>Temperatura · 24 h</h4>'
        + sparkline(list(_temperatures))
        + (
            '<p class="muted small">Reinicio pendiente por actualizaciones.</p>'
            if host.get('rebootRequired')
            else ''
        )
        + '</section>'
    )

    unit_card = (
        '<section class="card"><h3>Servicios</h3><ul>'
        + ''.join(
            row(
                u['state'] in ('active', 'reloading'),
                UNIT_LABELS.get(u['name'], u['name']),
                'activo' if u['state'] in ('active', 'reloading') else u['state'],
            )
            for u in units
        )
        + '</ul></section>'
    )

    devices = data.get('devices', [])
    online = [d for d in devices if d.get('online')]
    baseline = min((d.get('firstSeen') or time.time() for d in devices), default=time.time())
    device_rows = ''.join(
        row(
            True,
            d.get('label') or d['ip'],
            d['ip'] if d.get('label') else (ms(d.get('rttMs')) if d.get('rttMs') else ''),
            (
                '<em class="badge">nuevo</em>'
                if (d.get('firstSeen') or 0) > baseline + 86400
                and time.time() - d['firstSeen'] < 86400
                else ''
            )
            + ('<em class="badge soft">sin nombre</em>' if d.get('source') == 'unknown' else '')
            + ('<em class="badge soft">auto</em>' if d.get('source') == 'mdns' else '')
            + strip(d.get('presence')),
        )
        for d in online[:40]
    )
    naming = data.get('naming') or {}
    moves = [m for m in naming.get('moves', []) if time.time() - m.get('at', 0) < 7 * 86400][-3:]
    move_text = ''.join(
        f'<p class="muted small">{e(m["name"])} cambió de {e(m["from"])} a {e(m["to"])} · '
        f'{e(ago(m["at"]))}</p>'
        for m in reversed(moves)
    )
    home_card = (
        f'<section class="card"><h3>Red de casa <span class="count">{len(online)} en línea</span></h3>'
        f'<ul>{device_rows or row(None, "Sin inventario")}</ul>'
        f'<p class="muted small note">Nombres por dirección física: siguen al equipo aunque cambie de IP · '
        f'{naming.get("registered", 0)} registrados</p>{move_text}</section>'
    )

    peers = data.get('peers') or []
    peer_rows = ''.join(
        row(
            p['online'],
            p['name'],
            (p['os'] + (' · directo' if p['direct'] else ' · relay'))
            if p['online']
            else f'{p["os"]} · {ago(p["seen"])}',
        )
        for p in peers
    )
    tail_card = (
        f'<section class="card"><h3>Tailscale <span class="count">{sum(p["online"] for p in peers)}'
        f'/{len(peers)}</span></h3><ul>{peer_rows or row(None, "Sin datos")}</ul></section>'
    )

    backup = data.get('backups')
    repos = data.get('repos') or []
    backup_row = (
        row(
            (time.time() - backup['at']) < 36 * 3600,
            'Respaldo cifrado',
            f'{ago(backup["at"])} · {size(backup["bytes"])} · {backup["count"]} copias',
        )
        if backup
        else row(False, 'Respaldo cifrado', 'sin copias')
    )
    repo_rows = ''.join(row(True, r['name'], f'{r["branch"]} · {ago(r["at"])}') for r in repos)
    safe_card = f'<section class="card"><h3>Respaldos y código</h3><ul>{backup_row}{repo_rows}</ul></section>'

    router_link = ''
    for device in data.get('devices') or []:
        if not isinstance(device, dict) or device.get('role') != 'router':
            continue
        try:
            address = ipaddress.IPv4Address(device.get('ip', ''))
        except (ValueError, TypeError):
            continue
        if address.is_private:
            router_link = f'<a href="http://{address}/">Router<span>›</span></a>'
            break
    links = (
        '<section class="card"><h3>Accesos</h3><div class="links">'
        '<a href="/admin/">Panel de Pi-hole<span>›</span></a>' + router_link + '</div></section>'
    )

    body = (
        hero
        + net_card
        + dns_card
        + lists
        + '<div class="grid2">'
        + pi_card
        + unit_card
        + '</div>'
        + tablet_card(
            data.get('peers'), data.get('tabletPeer'), data.get('at'), data.get('tabletSummary')
        )
        + home_card
        + '<div class="grid2">'
        + tail_card
        + safe_card
        + '</div>'
        + links
        + f'<footer>Actualizado {e(time.strftime("%H:%M:%S", time.localtime(data["at"])))} · '
        f'solo tu cuenta de Tailscale</footer>'
    )
    return page(body, nonce)


TABS = (
    ('home', '/', 'Inicio', 'M3 11 12 4l9 7v9h-6v-6H9v6H3z'),
    (
        'map',
        '/network-map#map',
        'Red',
        'M12 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM5 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm14 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 9v3m0 0-5 4m5-4 5 4',
    ),
    ('traffic', '/network-map#traffic', 'Tráfico', 'M3 17l5-6 4 3 6-8 3 3M3 21h18'),
    ('ports', '/network-map#ports', 'Puertos', 'M4 6h16v12H4zM8 10h2v4H8zm6 0h2v4h-2z'),
)


def tab_bar(active):
    """Shared bottom navigation; network-map.html carries the same markup for its views."""
    current = ' aria-current="page"'
    links = ''.join(
        f'<a href="{href}" data-tab="{key}"{current if key == active else ""}>'
        f'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="{icon}"/></svg><span>{label}</span></a>'
        for key, href, label, icon in TABS
    )
    return f'<nav class="tabbar" aria-label="Secciones">{links}</nav>'


OFFLINE = """<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0e0e0e">
<title>LEÓN Home</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0e0e0e;color:#eeeae3;
font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px}img{width:64px;height:64px}p{color:#a39e94;max-width:300px}
a{display:inline-block;margin-top:12px;color:#111;background:#eeeae3;border-radius:999px;padding:10px 18px;text-decoration:none}</style></head>
<body><div><img src="/brand/symbol.png" alt=""><h1>Sin conexión</h1><p>No se alcanza LEÓN Home. Conecta Tailscale y vuelve a intentar.
No se guardan lecturas en este teléfono.</p><a href="/">Reintentar</a></div></body></html>""".encode(
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


def router_unlock(phrase):
    """Forward the owner's vault phrase once; the monitor decrypts its vault copy. Never logged or kept."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(60)  # vault scrypt on the Pi (~8 s), router login and first reads
        connection.connect(ROUTER_UNLOCK_SOCKET)
        try:
            connection.sendall(json.dumps({'phrase': phrase}).encode())
            connection.shutdown(socket.SHUT_WR)
            raw = connection.recv(257)
            status = json.loads(raw).get('status') if len(raw) <= 256 else None
        except (OSError, ValueError, AttributeError):
            return 'unlockFailed'
    return status if status in UNLOCK_OUTCOMES else 'unlockFailed'


def page(body, nonce):
    return f'''<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e0e0e"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="LEÓN Home"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/brand/symbol.png"><link rel="manifest" href="/manifest.webmanifest"><title>LEÓN Home</title><link rel="stylesheet" href="/network-map/assets/home.css"></head><body><main>
<header><img class="symbol" src="/brand/symbol.png" alt=""><img class="word" src="/brand/wordmark.png" alt="LEÓN">
<span class="sub">Home</span></header>{body}</main>{tab_bar('home')}<script type="module" nonce="{nonce}" src="/network-map/assets/home.js"></script></body></html>'''.encode(
        'utf-8'
    )


# ---------------------------------------------------------------- HTTP


class Handler(http.server.BaseHTTPRequestHandler):
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
                or set(request) != {'phrase'}
                or not isinstance(request['phrase'], str)
                or not 1 <= len(request['phrase'].encode()) <= 1024
            ):
                raise ValueError('Invalid unlock request')
        except ValueError:
            return self.reply(400, b'{"status":"invalid"}', 'application/json; charset=utf-8')
        try:
            outcome = router_unlock(request['phrase'])
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

    def log_message(self, fmt, *args):
        pass  # no access log: request paths and logins stay out of the journal


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, save_internet_and_exit)
    threading.Thread(target=sampler, daemon=True).start()
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
