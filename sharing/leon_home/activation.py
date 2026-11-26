"""Switch whole app trees, with a durable rollback marker; never modify per-home configuration."""

import contextlib
import fcntl
import http.client
import os
import socket
import subprocess
import time
from pathlib import Path

from .contracts import ReleaseError, read_json
from .release import atomic_json

ROOT = Path('/opt/leon-home')
STATE = Path('/var/lib/leon-home-updates')
SOCKET = '/run/leon-home-http/http.sock'


def command(*arguments, timeout=100):
    result = subprocess.run(arguments, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise ReleaseError('activationFailed')
    return result.stdout.decode('utf-8', errors='strict').strip()


def select(target):
    temporary = ROOT / 'current.new'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(temporary, ROOT / 'current')
    descriptor = os.open(ROOT, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def healthy(owner):
    for _ in range(20):
        try:
            connection = UnixHTTP('localhost', timeout=2)
            try:
                connection.request('GET', '/network-map', headers={'Tailscale-User-Login': owner})
                response = connection.getresponse()
                if response.status == 200:
                    return True
            finally:
                connection.close()
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(1)
    return False


@contextlib.contextmanager
def paused_inventory():
    was_active = (
        command('systemctl', 'show', 'leon-netmap.timer', '-p', 'ActiveState', '--value')
        == 'active'
    )
    try:
        command('systemctl', 'stop', 'leon-netmap.timer')
        stop = time.monotonic() + 95
        while command(
            'systemctl', 'show', 'leon-netmap.service', '-p', 'ActiveState', '--value'
        ) not in ('inactive', 'failed'):
            if time.monotonic() >= stop:
                raise ReleaseError('inventoryBusy')
            time.sleep(1)
        with open('/var/lib/leon-netmap/.netmap.lock', 'rb') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ReleaseError('inventoryBusy') from error
            yield
    finally:
        if was_active:
            command('systemctl', 'start', 'leon-netmap.timer')


def activate(target, owner):
    previous = (ROOT / 'current').resolve(strict=True)
    marker = STATE / 'transaction.json'
    with paused_inventory():
        atomic_json(marker, {'previous': str(previous), 'next': str(target)})
        try:
            select(target)
            command('systemctl', 'restart', 'leon-router.service')
            command('systemctl', 'restart', 'leon-overview.service')
            command(
                'systemd-run',
                '--quiet',
                '--wait',
                '--pipe',
                '--collect',
                '--unit=leon-home-update-check-socket',
                '-p',
                'User=leon-netmap',
                '-p',
                'Group=leon-netmap',
                '-p',
                'NoNewPrivileges=yes',
                '-p',
                'CapabilityBoundingSet=',
                '-p',
                'ProtectSystem=strict',
                '-p',
                'ProtectHome=yes',
                '-p',
                'PrivateTmp=yes',
                '-p',
                'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK',
                str(ROOT / 'current/inventory/leon-netmap'),
                '--check',
                timeout=15,
            )
            if not healthy(owner):
                raise ReleaseError('activationFailed')
        # Any activation failure must roll back before returning the categorized outcome.
        except Exception:  # noqa: BLE001
            select(previous)
            command('systemctl', 'restart', 'leon-router.service')
            command('systemctl', 'restart', 'leon-overview.service')
            if not healthy(owner):
                raise ReleaseError('recoveryNeeded') from None
            marker.unlink(missing_ok=True)
            raise ReleaseError('rolledBack') from None
        marker.unlink()


def recover(owner):
    marker = STATE / 'transaction.json'
    if not marker.exists():
        return False
    transaction = read_json(marker)
    previous = Path(transaction['previous']).resolve(strict=True)
    if previous.parent != ROOT / 'releases':
        raise ReleaseError('recoveryNeeded')
    with paused_inventory():
        select(previous)
        command('systemctl', 'restart', 'leon-router.service')
        command('systemctl', 'restart', 'leon-overview.service')
        if not healthy(owner):
            raise ReleaseError('recoveryNeeded')
        marker.unlink()
    return True
