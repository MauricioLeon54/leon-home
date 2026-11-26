"""Small root broker: signed application releases only; acceptance comes from the owner UI."""

import concurrent.futures
import json
import os
import pwd
import shutil
import socket
import struct
import sys
import tempfile
import threading
from pathlib import Path

from . import activation, download, release
from .contracts import ReleaseError, Site, parse_json, read_json

CONFIG = Path('/etc/leon-home')
STATE = Path('/var/lib/leon-home-updates')
ROOT = Path('/opt/leon-home')
SOCKET = Path('/run/leon-home-updates/control.sock')


class Worker:
    def __init__(self, config=CONFIG, state=STATE, root=ROOT):
        self.config, self.state, self.root = Path(config), Path(state), Path(root)
        self.site = Site.parse(read_json(self.config / 'site.json'))
        self.key = self.config / 'release-key.pem'
        self.lock = threading.Lock()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.busy = False
        for stale in self.state.glob('download-*'):
            if stale.is_dir() and not stale.is_symlink():
                shutil.rmtree(stale)
        self.phase, self.error, self.available = 'current', None, None
        if (self.state / 'pending').exists():
            try:
                candidate = release.verify(self.state / 'pending', self.key)
                release.newer(candidate, self.installed())
                self.available = self.summary(candidate)
                self.phase = 'ready'
            except (OSError, ReleaseError):
                shutil.rmtree(self.state / 'pending')
        self.persist()

    def installed(self):
        return read_json(self.root / 'current/release.json')

    @staticmethod
    def summary(candidate):
        return {'version': candidate['version'], 'notes': candidate['notes']}

    def snapshot(self):
        with self.lock:
            return {
                'schemaVersion': 1,
                'version': self.installed()['version'],
                'phase': self.phase,
                'error': self.error,
                'available': self.available,
            }

    def persist(self):
        release.atomic_json(self.state / 'status.json', self.snapshot())

    def update(self, phase, error=None, available=None):
        with self.lock:
            self.phase, self.error, self.available = phase, error, available
        self.persist()

    def dispatch(self, request):
        if not isinstance(request, dict) or request.get('operation') not in (
            'status',
            'check',
            'apply',
        ):
            raise ReleaseError('invalidRequest')
        operation = request['operation']
        expected = {'operation', 'version'} if operation == 'apply' else {'operation'}
        if set(request) != expected:
            raise ReleaseError('invalidRequest')
        if operation == 'status':
            return self.snapshot()
        if (self.config / 'installing.json').exists():
            raise ReleaseError('setupIncomplete')
        with self.lock:
            if self.busy:
                return {'status': 'busy'}
            if operation == 'apply' and (
                not self.available or request['version'] != self.available['version']
            ):
                raise ReleaseError('invalidRequest')
            self.busy = True
        self.executor.submit(self.job, operation)
        return {'status': 'accepted'}

    def job(self, operation):
        try:
            if (self.state / 'transaction.json').exists():
                raise ReleaseError('recoveryNeeded')
            if operation == 'check':
                self.check()
            else:
                self.apply()
        except ReleaseError as error:
            self.failure(error.code)
        # Root worker boundary categorizes unexpected failures without exposing private details.
        except Exception:  # noqa: BLE001
            # No paths, raw payloads, logins or exception details cross this root boundary.
            self.failure('recoveryNeeded')
        finally:
            with self.lock:
                self.busy = False

    def failure(self, code):
        try:
            self.update('error', code, self.available)
        except OSError:
            print('leon-home update status persistence failed', file=sys.stderr, flush=True)

    def compatible(self, candidate):
        if (self.config / 'broker.sha256').read_text().strip() != candidate['brokerSha256']:
            raise ReleaseError('bootstrapUpdateNeeded')

    def check(self):
        self.update('checking', available=self.available)
        folder = Path(tempfile.mkdtemp(prefix='download-', dir=self.state))
        try:
            download.latest(self.site.repository, folder)
            candidate = release.verify(folder, self.key)
            self.compatible(candidate)
            try:
                release.newer(candidate, self.installed())
            except ReleaseError as error:
                if error.code != 'notNewer':
                    raise
                shutil.rmtree(self.state / 'pending', ignore_errors=True)
                self.update('current')
                return
            destination = self.state / 'pending'
            shutil.rmtree(destination, ignore_errors=True)
            os.replace(folder, destination)
            self.update('ready', available=self.summary(candidate))
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def apply(self):
        self.update('installing', available=self.available)
        candidate = release.verify(self.state / 'pending', self.key)
        self.compatible(candidate)
        release.newer(candidate, self.installed())
        if shutil.disk_usage(self.root).free < 3 * candidate['archiveBytes'] + 64 * 1024 * 1024:
            raise ReleaseError('notEnoughSpace')
        previous = (self.root / 'current').resolve(strict=True)
        target = self.root / 'releases' / f'{candidate["sequence"]}-{candidate["version"]}'
        if target == previous:
            raise ReleaseError('invalidRelease')
        shutil.rmtree(target, ignore_errors=True)
        release.unpack(self.state / 'pending', target, self.key)
        activation.activate(target, self.site.owner)
        # Keep this and the previous complete release for recovery; configuration is elsewhere.
        for directory in (self.root / 'releases').iterdir():
            if (
                directory.is_dir()
                and not directory.is_symlink()
                and directory not in (previous, target)
            ):
                shutil.rmtree(directory)
        shutil.rmtree(self.state / 'pending', ignore_errors=True)
        self.update('current')


def authorized(uid, panel_uid, support_uid, request):
    if type(uid) is not int or not isinstance(request, dict):
        return False
    if uid in (0, panel_uid):
        return True
    return uid == support_uid and request.get('operation') in ('status', 'check')


def serve():
    site = Site.parse(read_json(CONFIG / 'site.json'))
    activation.recover(site.owner)
    worker = Worker()
    uid = pwd.getpwnam('leon-overview').pw_uid
    try:
        support_uid = pwd.getpwnam('leon-support').pw_uid
    except KeyError:
        support_uid = None
    SOCKET.unlink(missing_ok=True)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(SOCKET))
        import grp

        os.chown(SOCKET, 0, grp.getgrnam('leon-home-control').gr_gid)
        SOCKET.chmod(0o660)
        server.listen(8)
        try:
            while True:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(2)
                    peer = struct.unpack(
                        '3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                    )[1]
                    if peer not in (0, uid, support_uid):
                        continue
                    try:
                        raw = bytearray()
                        while not raw.endswith(b'\n') and len(raw) <= 1024:
                            chunk = connection.recv(1025 - len(raw))
                            if not chunk:
                                break
                            raw.extend(chunk)
                        if not raw.endswith(b'\n') or len(raw) > 1024:
                            raise ReleaseError('invalidRequest')
                        request = parse_json(raw, 1024)
                        if not authorized(peer, uid, support_uid, request):
                            raise ReleaseError('invalidRequest')
                        result = worker.dispatch(request)
                    except (OSError, ReleaseError):
                        result = {'status': 'unavailable'}
                    try:
                        connection.sendall(json.dumps(result).encode() + b'\n')
                    except OSError:
                        pass  # A disconnected panel cannot terminate the broker or its job.
        finally:
            worker.executor.shutdown(wait=True)
            SOCKET.unlink(missing_ok=True)
