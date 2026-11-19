"""Validate the private router monitor's presentation-only state."""

import ipaddress
import json
import math
import re

PATH = '/var/lib/leon-router/telemetry.json'
FRESH_SECONDS = 90
MAX_PORTS = 8


def finite(value, low=0, high=100000):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def rate_or_none(value):
    return value if finite(value) else None


def clean_history(value, now):
    samples = value.get('samples') if isinstance(value, dict) else None
    result = []
    for sample in (samples if isinstance(samples, list) else [])[-120:]:
        if (
            isinstance(sample, list)
            and len(sample) == 3
            and finite(sample[0], 1, now + 30)
            and (not result or sample[0] > result[-1][0])
        ):
            result.append([sample[0], rate_or_none(sample[1]), rate_or_none(sample[2])])
    interval = value.get('intervalSeconds') if isinstance(value, dict) else None
    return {
        'intervalSeconds': interval if type(interval) is int and 1 <= interval <= 3600 else None,
        'samples': result,
    }


def clean_device_history(value):
    return [
        [rate_or_none(pair[0]), rate_or_none(pair[1])]
        for pair in (value if isinstance(value, list) else [])[-60:]
        if isinstance(pair, list) and len(pair) == 2
    ]


def clean_ports(value):
    if not isinstance(value, list):
        return None
    ports = []
    for row in value[:MAX_PORTS]:
        if (
            not isinstance(row, dict)
            or type(row.get('port')) is not int
            or not 1 <= row['port'] <= MAX_PORTS
        ):
            continue
        if any(port['port'] == row['port'] for port in ports):
            continue
        speed = row.get('speedMbps')
        ports.append(
            {
                'port': row['port'],
                'enabled': row['enabled'] if type(row.get('enabled')) is bool else None,
                'link': row['link'] if row.get('link') in ('up', 'down') else 'unknown',
                'speedMbps': speed if type(speed) is int and 0 < speed <= 100000 else None,
                'duplex': row['duplex'] if row.get('duplex') in ('full', 'half') else None,
                'wan': row['wan'] if type(row.get('wan')) is bool else None,
            }
        )
    return sorted(ports, key=lambda port: port['port'])


BANDS = ('2.4GHz', '5GHz', '5GHz_1', '5GHz_2', 'DC', 'wifi7-mld')


def clean_text(value, limit):
    return ''.join(c for c in value[:limit] if c.isprintable()) if isinstance(value, str) else None


def clean_flags(value, pattern):
    return (
        {
            key: item
            for key, item in value.items()
            if isinstance(key, str)
            and re.fullmatch(pattern, key)
            and type(item) in (bool, int)
            and -1 <= item <= 10_000_000
        }
        if isinstance(value, dict)
        else {}
    )


def clean_wifi(value):
    """Network names, bands and on/off or time numbers only; any other field is dropped."""
    if not isinstance(value, dict):
        return None
    networks = value.get('networks')
    guest = value.get('guest')

    def count(item, high):
        return item if type(item) is int and 0 <= item <= high else None

    return {
        'networks': [
            {
                'ssid': clean_text(row.get('ssid'), 32),
                'band': clean_text(row.get('band'), 16),
                **clean_flags(row, r'WifiEnable|Channel'),
            }
            for row in (networks if isinstance(networks, list) else [])[:4]
            if isinstance(row, dict)
        ],
        'radios': clean_flags(value.get('radios'), r'Enable(2G|5G)'),
        'guest': {
            'ssid': clean_text(guest.get('ssid'), 32),
            'enabled': guest.get('enabled') is True,
            'restSeconds': count(guest.get('restSeconds'), 7 * 86400),
        }
        if isinstance(guest, dict)
        else None,
    }


def clean_filter(value):
    if not isinstance(value, dict):
        return None
    macs = value.get('blockedMacs')
    return {
        'enabled': value['enabled'] if type(value.get('enabled')) is bool else None,
        'policy': value['policy'] if value.get('policy') in ('block', 'allow') else None,
        'blockedMacs': sorted(
            {
                mac
                for mac in (macs if isinstance(macs, list) else [])[:64]
                if isinstance(mac, str)
                and len(mac) == 17
                and all(c in '0123456789abcdef:' for c in mac)
            }
        ),
    }


def clean(value, now):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1:
        return {
            'status': 'unavailable',
            'observedAt': None,
            'devices': [],
            'history': clean_history(None, now),
            'ports': None,
            'controllablePorts': [],
            'wifiFilter': None,
            'wifi': None,
        }
    observed = value.get('observedAt')
    valid_date = (
        type(observed) in (int, float) and math.isfinite(observed) and 0 < observed <= now + 30
    )
    status = value.get('status')
    if status not in ('current', 'locked', 'error'):
        status = 'unavailable'
    if status == 'current' and (not valid_date or now - observed > FRESH_SECONDS):
        status = 'stale'
    devices = []
    raw_devices = value.get('devices')
    for row in (raw_devices if isinstance(raw_devices, list) else [])[:256]:
        if not isinstance(row, dict):
            continue
        try:
            address = str(ipaddress.IPv4Address(row.get('address')))
        except (ValueError, TypeError):
            continue

        def rate(name):
            rate = row.get(name)
            return (
                rate if status == 'current' and row.get('active') is True and finite(rate) else None
            )

        connection = row.get('connection')
        signal = row.get('signalDbm')
        port = row.get('port')
        devices.append(
            {
                'address': address,
                'name': clean_text(row.get('name'), 40) or None,
                'downloadRouterMbps': rate('downloadRouterMbps'),
                'uploadRouterMbps': rate('uploadRouterMbps'),
                'connection': connection
                if connection in ('ethernet', 'wifi', 'other')
                else 'unknown',
                'port': port
                if connection == 'ethernet' and type(port) is int and 1 <= port <= MAX_PORTS
                else None,
                'band': row.get('band')
                if status == 'current' and row.get('band') in BANDS
                else None,
                'signalDbm': signal
                if status == 'current' and type(signal) is int and -100 <= signal < 0
                else None,
                'history': clean_device_history(row.get('history')),
            }
        )
    allowed = value.get('controllablePorts')
    return {
        'status': status,
        'observedAt': observed if valid_date else None,
        'devices': devices,
        # History keeps its own sample dates, so it stays meaningful after the session stops.
        'history': clean_history(value.get('history'), now),
        'ports': clean_ports(value.get('ports')) if status == 'current' else None,
        'wifiFilter': clean_filter(value.get('wifiFilter')) if status == 'current' else None,
        'wifi': clean_wifi(value.get('wifi')) if status == 'current' else None,
        'controllablePorts': sorted(
            {
                port
                for port in (allowed if isinstance(allowed, list) else [])
                if type(port) is int and 1 <= port <= MAX_PORTS
            }
        ),
    }


def read(now):
    try:
        with open(PATH, 'rb') as handle:
            raw = handle.read(262145)
        if len(raw) > 262144:
            raise ValueError('Telemetry too large')
        return clean(json.loads(raw), now)
    except (OSError, ValueError):
        return clean(None, now)
