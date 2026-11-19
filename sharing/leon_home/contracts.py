"""Closed configuration and release contracts; no per-home values belong in artifacts."""

import json
import re
from dataclasses import dataclass
from pathlib import Path

VERSION = re.compile(r'(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})')
REPOSITORY = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}')
LOGIN = re.compile(r'[a-z0-9][a-z0-9._+@-]{2,253}')
HASH = re.compile(r'[0-9a-f]{64}')
MAX_MANIFEST = 65_536
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_UNPACKED = 64 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
FILES = frozenset(
    [
        'app/' + name
        for name in (
            'collector.py',
            'overview.py',
            'network_map.py',
            'router_telemetry.py',
            'internet_health.py',
            'web_assets.py',
            'network-map.html',
            'family.py',
            'update_client.py',
            'updates.html',
        )
    ]
    + [
        'app/web/dist/' + name
        for name in (
            'app.js',
            'home.js',
            'serviceWorker.js',
            'updates.js',
            'network-map.css',
            'home.css',
            'updates.css',
        )
    ]
    + ['inventory/leon-netmap', 'inventory/netmap.py']
    + ['router/monitor.py', 'router/router_read_probe.py']
    + [
        'brand/' + name
        for name in ('symbol-web.png', 'wordmark-web.png', 'apple-touch-icon.png', 'icon-512.png')
    ]
)


class ReleaseError(Exception):
    """A stable, non-sensitive failure code suitable for the private panel."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def read_json(path, maximum=MAX_MANIFEST):
    with Path(path).open('rb') as handle:
        raw = handle.read(maximum + 1)
    return parse_json(raw, maximum)


def parse_json(raw, maximum=MAX_MANIFEST):
    if len(raw) > maximum:
        raise ReleaseError('invalidRelease')
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise ReleaseError('invalidRelease') from error


def version(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ReleaseError('invalidRelease')
    return tuple(int(part) for part in value.split('.'))


@dataclass(frozen=True)
class Site:
    owner: str
    repository: str
    interface: str
    hostname: str
    support_login: str

    @classmethod
    def parse(cls, value):
        keys = {'schemaVersion', 'owner', 'repository', 'interface', 'hostname', 'supportLogin'}
        if (
            not isinstance(value, dict)
            or set(value) != keys
            or type(value['schemaVersion']) is not int
            or value['schemaVersion'] != 1
        ):
            raise ReleaseError('invalidConfiguration')
        owner, support = value['owner'], value['supportLogin']
        if not isinstance(owner, str) or not LOGIN.fullmatch(owner):
            raise ReleaseError('invalidConfiguration')
        if not isinstance(support, str) or (
            support and (not LOGIN.fullmatch(support) or support == owner)
        ):
            raise ReleaseError('invalidConfiguration')
        if not isinstance(value['repository'], str) or not REPOSITORY.fullmatch(
            value['repository']
        ):
            raise ReleaseError('invalidConfiguration')
        if not isinstance(value['interface'], str) or not re.fullmatch(
            r'[A-Za-z0-9_.-]{1,15}', value['interface']
        ):
            raise ReleaseError('invalidConfiguration')
        if not isinstance(value['hostname'], str) or not re.fullmatch(
            r'[a-z][a-z0-9-]{0,61}[a-z0-9]', value['hostname']
        ):
            raise ReleaseError('invalidConfiguration')
        return cls(owner, value['repository'], value['interface'], value['hostname'], support)


def manifest(value):
    keys = {
        'schemaVersion',
        'product',
        'version',
        'sequence',
        'architecture',
        'os',
        'notes',
        'archiveSha256',
        'archiveBytes',
        'bootstrapSha256',
        'bootstrapBytes',
        'brokerSha256',
        'files',
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise ReleaseError('invalidRelease')
    version(value['version'])
    if (
        type(value['schemaVersion']) is not int
        or value['schemaVersion'] != 1
        or value['product'] != 'leon-home'
        or value['architecture'] != 'aarch64'
        or value['os'] != 'debian-13'
    ):
        raise ReleaseError('incompatible')
    if type(value['sequence']) is not int or not 1 <= value['sequence'] <= 2_147_483_647:
        raise ReleaseError('invalidRelease')
    if type(value['archiveBytes']) is not int or not 1 <= value['archiveBytes'] <= MAX_ARCHIVE:
        raise ReleaseError('invalidRelease')
    if not isinstance(value['archiveSha256'], str) or not HASH.fullmatch(value['archiveSha256']):
        raise ReleaseError('invalidRelease')
    notes = value['notes']
    if not isinstance(notes, list) or not 1 <= len(notes) <= 12:
        raise ReleaseError('invalidRelease')
    if any(
        not isinstance(note, str)
        or not 1 <= len(note) <= 240
        or any(ord(char) < 32 for char in note)
        for note in notes
    ):
        raise ReleaseError('invalidRelease')
    for key in ('bootstrapSha256', 'brokerSha256'):
        if not isinstance(value[key], str) or not HASH.fullmatch(value[key]):
            raise ReleaseError('invalidRelease')
    if (
        type(value['bootstrapBytes']) is not int
        or not 1 <= value['bootstrapBytes'] <= 4 * 1024 * 1024
    ):
        raise ReleaseError('invalidRelease')
    entries = value['files']
    if not isinstance(entries, dict) or set(entries) != FILES:
        raise ReleaseError('invalidRelease')
    total = 0
    for entry in entries.values():
        if not isinstance(entry, dict) or set(entry) != {'sha256', 'bytes'}:
            raise ReleaseError('invalidRelease')
        if not isinstance(entry['sha256'], str) or not HASH.fullmatch(entry['sha256']):
            raise ReleaseError('invalidRelease')
        if type(entry['bytes']) is not int or not 0 < entry['bytes'] <= MAX_FILE:
            raise ReleaseError('invalidRelease')
        total += entry['bytes']
    if total > MAX_UNPACKED:
        raise ReleaseError('invalidRelease')
    return value
