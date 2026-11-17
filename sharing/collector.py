"""Linux-only family collector. Shared read-only helpers preserve the snapshot v1 contract.

This independent distribution deliberately excludes desktop, Android, outreach and trading
operations. The helper subset is extracted from the shared collector and checked for parity.
"""

import concurrent.futures
import ipaddress
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import time

MAX_NETWORK_BYTES = 1_048_576
HOST_UNITS = (
    'pihole-FTL',
    'unbound',
    'tailscaled',
    'ssh',
    'leon-home-dns',
    'leon-netmap.timer',
    'leon-overview',
    'leon-home-updates',
    'leon-home-update-check.timer',
)
UNIT_STATES = ('active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating')


def command(arguments, timeout=2, limit=4096):
    try:
        result = subprocess.run(arguments, capture_output=True, timeout=timeout, check=False)
        if result.returncode == 0:
            return result.stdout[:limit].decode('utf-8', errors='replace').strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def read_text(path):
    try:
        with open(path, encoding='utf-8') as source:
            return source.read(16384)
    except OSError:
        return None


def normalize_network(state):
    if not isinstance(state, dict) or not isinstance(state.get('devices'), list):
        raise ValueError('Invalid network state')
    devices = []
    for item in state['devices'][:256]:
        if not isinstance(item, dict):
            continue
        try:
            ip = str(ipaddress.IPv4Address(item.get('ip', '')))
        except ipaddress.AddressValueError:
            continue
        label = item.get('label') if isinstance(item.get('label'), dict) else {}

        def text(value):
            return ''.join(c for c in str(value or '')[:100] if c.isprintable())

        def integers(values, limit, low, high):
            return [
                v
                for v in (values if isinstance(values, list) else [])[:limit]
                if isinstance(v, int) and not isinstance(v, bool) and low <= v <= high
            ]

        rtt = item.get('rtt_ms')
        first = item.get('first_seen')
        devices.append(
            {
                'ip': ip,
                'name': text(label.get('name') or item.get('name') or item.get('host') or ip),
                'kind': text(label.get('kind') or item.get('kind') or 'device'),
                'brand': text(label.get('brand') or item.get('brand')),
                'online': item.get('online') == 1,
                'lastSeen': item.get('last_seen') or 0,
                'host': text(item.get('host')),
                'model': text(label.get('model') or item.get('model')),
                'role': text(item.get('role')),
                'ports': integers(item.get('ports'), 32, 1, 65535),
                'services': [
                    text(v) for v in (item.get('services') or [])[:16] if isinstance(v, str)
                ]
                if isinstance(item.get('services'), list)
                else [],
                'rttMs': float(rtt) if isinstance(rtt, (int, float)) and 0 <= rtt < 60000 else None,
                'firstSeen': first if isinstance(first, int) and first > 0 else None,
                'presence': integers(item.get('strip'), 48, 0, 1),
            }
        )
    scan = state.get('lastScan')
    scan_at = scan.get('ts') if isinstance(scan, dict) else None
    now = time.time()
    age = (
        max(0, now - scan_at)
        if isinstance(scan_at, (int, float)) and 0 < scan_at <= now + 30
        else None
    )
    return {'devices': devices, 'scanAgeSeconds': age}


def parse_units(text):
    units, block = [], {}
    for line in (text or '').splitlines() + ['']:
        if '=' in line:
            key, value = line.split('=', 1)
            block[key] = value
        elif block:
            name = block.get('Id', '').removesuffix('.service')
            if (
                block.get('LoadState') == 'loaded'
                and name in HOST_UNITS
                and block.get('ActiveState') in UNIT_STATES
            ):
                units.append({'name': name, 'state': block['ActiveState']})
            block = {}
    return units


def cpu_times():
    fields = (read_text('/proc/stat') or '').split('\n', 1)[0].split()
    if len(fields) < 5 or fields[0] != 'cpu':
        return None
    values = [int(value) for value in fields[1:9]]
    return sum(values), values[3] + (values[4] if len(values) > 4 else 0)


def host_health():
    """systemd host readings (0.10): temperature, power, load, units. None on Android/Termux."""
    if not os.path.isdir('/run/systemd/system'):
        return None
    first = cpu_times()
    time.sleep(0.25)
    second = cpu_times()
    cpu = None
    if first and second and second[0] > first[0]:
        cpu = round(100 * (1 - (second[1] - first[1]) / (second[0] - first[0])), 1)
    temperature = read_text('/sys/class/thermal/thermal_zone0/temp')
    try:
        temperature = round(int(temperature) / 1000, 1) if temperature else None
    except ValueError:
        temperature = None
    throttled = command(['vcgencmd', 'get_throttled'])
    flags = None
    if throttled and throttled.startswith('throttled=0x'):
        try:
            flags = int(throttled.split('=', 1)[1], 16) & 0xFFFFF
        except ValueError:
            flags = None
    synced = command(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'])
    failed = command(['systemctl', 'list-units', '--state=failed', '--no-legend', '--plain'])
    units = parse_units(
        command(
            ['systemctl', 'show', '-p', 'Id,LoadState,ActiveState']
            + [name if '.' in name else name + '.service' for name in HOST_UNITS],
            timeout=3,
        )
    )
    return {
        'temperatureCelsius': temperature
        if temperature is not None and -40 <= temperature <= 125
        else None,
        'cpuPercent': cpu if cpu is not None and 0 <= cpu <= 100 else None,
        'load1': round(os.getloadavg()[0], 2),
        'throttledFlags': flags,
        'clockSynchronized': {'yes': True, 'no': False}.get(synced),
        'rebootRequired': os.path.exists('/run/reboot-required'),
        'failedUnits': None
        if failed is None
        else min(len([line for line in failed.splitlines() if line.strip()]), 999),
        'units': units,
    }


def private_ipv4(value):
    address = ipaddress.IPv4Address(value)
    if (
        not address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
    ):
        raise ValueError('Target must be a private home address')
    return str(address)


def dns_name(name):
    return (
        b''.join(bytes([len(part)]) + part.encode('ascii') for part in name.split('.') if part)
        + b'\0'
    )


def tcp_probe(ip, port, timeout=0.7):
    started = time.time()
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return round((time.time() - started) * 1000, 1)
    except OSError:
        return None


def ping(ip, count=3):
    text = (
        command(
            [
                '/system/bin/ping' if os.path.exists('/system/bin/ping') else 'ping',
                '-c',
                str(count),
                '-W',
                '1',
                '-i',
                '0.3',
                ip,
            ],
            timeout=count + 3,
        )
        or ''
    )
    loss = re.search(r'(\d+(?:\.\d+)?)% packet loss', text)
    average = re.search(r'= [\d.]+/([\d.]+)/', text)
    return {
        'lossPercent': float(loss.group(1)) if loss else 100.0,
        'averageMs': float(average.group(1)) if average else None,
    }


def dns_lookup_ms(server, name='example.com'):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    started = time.time()
    try:
        sock.sendto(
            struct.pack('>HHHHHH', 0x4C45, 0x0100, 1, 0, 0, 0)
            + dns_name(name)
            + struct.pack('>HH', 1, 1),
            (server, 53),
        )
        sock.recv(512)
        return round((time.time() - started) * 1000, 1)
    except OSError:
        return None
    finally:
        sock.close()


def health(gateway):
    """Home connection quality from the node: router, Internet (TCP only, no payload) and DNS."""
    gateway = private_ipv4(gateway)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        router = pool.submit(ping, gateway, 4)
        cloudflare = pool.submit(tcp_probe, '1.1.1.1', 443, 3)
        quad9 = pool.submit(tcp_probe, '9.9.9.9', 443, 3)
        lookup = pool.submit(dns_lookup_ms, gateway)
        internet = [value for value in (cloudflare.result(), quad9.result()) if value is not None]
        return {
            'checkedAt': time.time(),
            'router': router.result(),
            'internetMs': min(internet) if internet else None,
            'dnsMs': lookup.result(),
        }


def network_snapshot():
    try:
        with open('/var/lib/leon-netmap/state.json', 'rb') as handle:
            raw = handle.read(MAX_NETWORK_BYTES + 1)
        if len(raw) > MAX_NETWORK_BYTES:
            return None
        return normalize_network(json.loads(raw))
    except (OSError, ValueError):
        return None


def collect():
    memory = {}
    for line in (read_text('/proc/meminfo') or '').splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ('MemTotal:', 'MemAvailable:'):
            try:
                memory[parts[0][:-1]] = int(parts[1]) * 1024
            except ValueError:
                pass
    usage = shutil.disk_usage('/')
    uptime = read_text('/proc/uptime')
    return {
        'schemaVersion': 1,
        'bootID': (read_text('/proc/sys/kernel/random/boot_id') or '').strip(),
        'uptimeSeconds': float(uptime.split()[0]) if uptime else None,
        'memoryTotalBytes': memory.get('MemTotal'),
        'memoryAvailableBytes': memory.get('MemAvailable'),
        'storageTotalBytes': usage.total,
        'storageFreeBytes': usage.free,
        'properties': {},
        'services': [],
        'network': network_snapshot(),
        'host': host_health(),
    }
