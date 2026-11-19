#!/usr/bin/env python3
"""Disposable Linux integration: real Unix permissions/signatures/app, simulated system manager.

Run only in test.Dockerfile with --network none. Commands never reach a real Pi or tailnet.
"""

import grp
import http.client
import json
import os
import pathlib
import pwd
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path('/src')
sys.path.insert(0, str(ROOT / 'sharing'))
from build_release import build  # noqa: E402
from leon_home import install  # noqa: E402
from leon_home.contracts import Site  # noqa: E402

MANAGER = '/run/test-system-manager.sock'
processes = {}
log = []


def run_as(user, group, arguments, extra=()):
    identity = pwd.getpwnam(user)
    groups = [grp.getgrnam(name).gr_gid for name in extra]
    return [
        'setpriv',
        f'--reuid={identity.pw_uid}',
        f'--regid={grp.getgrnam(group).gr_gid}',
        '--groups=' + ','.join(str(value) for value in groups),
        '--no-new-privs',
        '--bounding-set=-all',
        *arguments,
    ]


def start_panel():
    directory = pathlib.Path('/run/leon-home-http')
    directory.mkdir(exist_ok=True)
    os.chown(
        directory, pwd.getpwnam('leon-overview').pw_uid, grp.getgrnam('leon-home-health').gr_gid
    )
    directory.chmod(0o750)
    state = pathlib.Path('/var/lib/leon-overview')
    state.mkdir(exist_ok=True)
    os.chown(state, pwd.getpwnam('leon-overview').pw_uid, grp.getgrnam('leon-home-health').gr_gid)
    previous = processes.get('panel')
    if previous and previous.poll() is None:
        previous.terminate()
        previous.wait(timeout=5)
    environment = {
        **os.environ,
        'OWNER_LOGINS': 'owner@example.test',
        'STATE_DIRECTORY': str(state),
    }
    processes['panel'] = subprocess.Popen(
        run_as(
            'leon-overview',
            'leon-home-health',
            ['python3', '-I', '/opt/leon-home/current/app/family.py'],
            ('leon-overview', 'leon-home-control', 'leon-router'),
        ),
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=open('/tmp/panel.log', 'ab'),
        cwd='/',
    )


class Manager(socketserver.BaseRequestHandler):
    def handle(self):
        data = json.loads(self.request.recv(4096))
        arguments = data['arguments']
        log.append(arguments)
        output, code = '', 0
        if arguments[:2] == ['systemctl', 'show']:
            output = 'active' if 'leon-netmap.timer' in arguments else 'inactive'
        if arguments[:3] == ['systemctl', 'restart', 'leon-overview.service']:
            start_panel()
        if arguments[0] == 'systemd-run':
            command = run_as(
                'leon-netmap',
                'leon-netmap',
                ['/opt/leon-home/current/inventory/leon-netmap', '--check'],
                ('leon-netmap',),
            )
            result = subprocess.run(command, capture_output=True, timeout=10)
            code, output = result.returncode, result.stdout.decode()
        self.request.sendall(json.dumps({'code': code, 'output': output}).encode())


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(3)
        self.sock.connect('/run/leon-home-http/http.sock')


def panel_request(path, body=None, token=None):
    for _ in range(40):
        try:
            connection = UnixHTTP('localhost')
            headers = {'Tailscale-User-Login': 'owner@example.test'}
            if body is not None:
                headers.update(
                    {
                        'Content-Type': 'application/json',
                        'X-Leon-Token': token,
                        'Sec-Fetch-Site': 'same-origin',
                    }
                )
            connection.request(
                'POST' if body is not None else 'GET',
                path,
                json.dumps(body) if body is not None else None,
                headers,
            )
            response = connection.getresponse()
            value = response.read()
            assert response.status in (200, 202), (response.status, value[:100])
            connection.close()
            return json.loads(value) if path.endswith('/data') or body is not None else value
        except (OSError, http.client.HTTPException):
            time.sleep(0.1)
    raise AssertionError('Panel did not become ready')


def main():
    assert (
        sys.platform == 'linux'
        and os.geteuid() == 0
        and not pathlib.Path('/etc/leon-home').exists()
    )
    os.environ['PATH'] = '/test-bin:/usr/sbin:/usr/bin:/sbin:/bin'
    pathlib.Path('/test-bin').mkdir()
    proxy = """#!/usr/bin/python3
import json,os,socket,sys
name=os.path.basename(sys.argv[0]); args=sys.argv[1:]
if name=='tailscale':
 print(json.dumps({'BackendState':'Running','Self':{'UserID':1},'User':{'1':{'LoginName':'owner@example.test'}}}) if args[:1]==['status'] else '')
 sys.exit(0)
if name=='pihole-FTL':
 print('v6.0.0' if args==['--version'] else '')
 sys.exit(0)
if name=='hostnamectl': sys.exit(0)
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
 s.connect('/run/test-system-manager.sock'); s.sendall(json.dumps({'arguments':[name]+args}).encode()); r=json.loads(s.recv(4096)); print(r['output']); sys.exit(r['code'])
"""
    for name in ('systemctl', 'systemd-run', 'pihole-FTL', 'tailscale', 'hostnamectl'):
        path = pathlib.Path('/test-bin') / name
        path.write_text(proxy)
        path.chmod(0o755)
    subprocess.run(['ip', 'link', 'add', 'eth0', 'type', 'dummy'], check=True)
    subprocess.run(['ip', 'address', 'add', '10.77.0.2/24', 'dev', 'eth0'], check=True)
    subprocess.run(['ip', 'link', 'set', 'eth0', 'up'], check=True)
    manager = socketserver.ThreadingUnixStreamServer(MANAGER, Manager)
    os.chmod(MANAGER, 0o600)
    threading.Thread(target=manager.serve_forever, daemon=True).start()
    work = pathlib.Path(tempfile.mkdtemp())
    key, public = work / 'private.pem', work / 'public.pem'
    subprocess.run(
        ['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(public)],
        check=True,
        capture_output=True,
    )

    def bundle(version, sequence):
        path = work / version
        build(path, version, sequence, ['Integration test.'])
        subprocess.run(
            [
                'openssl',
                'pkeyutl',
                '-sign',
                '-inkey',
                str(key),
                '-rawin',
                '-in',
                str(path / 'manifest.json'),
                '-out',
                str(path / 'manifest.sig'),
            ],
            check=True,
            capture_output=True,
        )
        return path

    first, second, third = bundle('0.1.0', 1), bundle('0.2.0', 2), bundle('0.3.0', 3)
    der = subprocess.run(
        ['openssl', 'pkey', '-pubin', '-in', str(public), '-outform', 'DER'],
        check=True,
        capture_output=True,
    ).stdout
    import hashlib

    fingerprint = hashlib.sha256(der).hexdigest()
    site = {
        'schemaVersion': 1,
        'owner': 'owner@example.test',
        'supportLogin': 'support@example.test',
        'hostname': 'leon-test',
        'interface': 'eth0',
        'repository': 'example/leon-home',
    }
    # This key is synthetic public data; no private support credential is installed.
    encoded = (
        __import__('base64')
        .b64encode(
            (11).to_bytes(4, 'big') + b'ssh-ed25519' + (32).to_bytes(4, 'big') + bytes(range(32))
        )
        .decode()
    )
    # Do not publish this temporary installation or its signing keys; the container is discarded.
    install.install(
        Site.parse(site),
        site,
        first,
        public,
        fingerprint,
        ROOT / 'sharing',
        'test-application-password',
        'ssh-ed25519 ' + encoded,
    )
    pathlib.Path('/run/leon-home-updates').mkdir(exist_ok=True)
    pending = pathlib.Path('/var/lib/leon-home-updates/pending')
    shutil.copytree(second, pending)
    start_panel()
    broker = subprocess.Popen(
        run_as(
            'root',
            'root',
            ['python3', '-I', '/usr/local/lib/leon-home/runtime/run_updater.py'],
            ('leon-home-health', 'leon-home-control'),
        ),
        cwd='/',
        stdout=subprocess.DEVNULL,
        stderr=open('/tmp/broker.log', 'wb'),
    )
    processes['broker'] = broker
    try:
        data = panel_request('/updates/data')
        assert data['available']['version'] == '0.2.0', data
        # The support group can reach the broker, but cannot send the owner acceptance operation.
        probe = 'import socket; s=socket.socket(socket.AF_UNIX);s.connect(\'/run/leon-home-updates/control.sock\');s.sendall(b\'{"operation":"apply","version":"0.2.0"}\\n\');print(s.recv(1024).decode())'
        result = subprocess.run(
            run_as(
                'leon-support',
                'leon-support',
                ['python3', '-I', '-c', probe],
                ('leon-home-control',),
            ),
            capture_output=True,
            check=True,
        )
        assert b'unavailable' in result.stdout
        deny = "import socket; s=socket.socket(socket.AF_UNIX);s.connect('/run/leon-home-http/http.sock')"
        result = subprocess.run(
            run_as(
                'leon-support',
                'leon-support',
                ['python3', '-I', '-c', deny],
                ('leon-home-control',),
            ),
            capture_output=True,
        )
        assert result.returncode != 0, 'Support could spoof private panel identity'
        original = pathlib.Path('/etc/leon-home/site.json').read_bytes()
        secret = pathlib.Path('/etc/leon-overview/pihole-app-password').read_bytes()
        panel_request('/updates/apply', {'version': '0.2.0'}, data['actionToken'])
        for _ in range(200):
            state = panel_request('/updates/data')
            if state['phase'] not in ('ready', 'installing'):
                break
            time.sleep(0.1)
        assert state['phase'] == 'current' and state['version'] == '0.2.0', state
        assert pathlib.Path('/etc/leon-home/site.json').read_bytes() == original
        assert pathlib.Path('/etc/leon-overview/pihole-app-password').read_bytes() == secret
        assert not pathlib.Path('/var/lib/leon-home-updates/transaction.json').exists()
        assert pathlib.Path('/opt/leon-home/releases/1-0.1.0').is_dir()
        print(
            'Linux fresh install and real signature, Unix permission isolation, owner acceptance and app activation passed.'
        )
        maintenance(third, public, fingerprint)
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        manager.shutdown()
        manager.server_close()


def maintenance(bundle, public, fingerprint):
    """Administrator maintenance to a newer release, then the real router monitor's local gates."""
    secret = pathlib.Path('/etc/leon-overview/pihole-app-password').read_bytes()
    install.maintain(bundle, public, fingerprint, ROOT / 'sharing')
    assert pathlib.Path('/opt/leon-home/current').resolve().name == '3-0.3.0'
    assert sorted(path.name for path in pathlib.Path('/opt/leon-home/releases').iterdir()) == [
        '2-0.2.0',
        '3-0.3.0',
    ]
    assert pathlib.Path('/etc/systemd/system/leon-router.service').is_file()
    assert pathlib.Path('/etc/leon-overview/pihole-app-password').read_bytes() == secret
    assert any(
        command[:3] == ['systemctl', 'enable', '--now'] and 'leon-router.service' in command
        for command in log
    )
    router = pwd.getpwnam('leon-router')
    for directory in ('/run/leon-router', '/var/lib/leon-router'):
        path = pathlib.Path(directory)
        path.mkdir(exist_ok=True)
        os.chown(path, router.pw_uid, router.pw_gid)
        path.chmod(0o750)
    processes['router'] = subprocess.Popen(
        run_as(
            'leon-router',
            'leon-router',
            ['python3', '-I', '/opt/leon-home/current/router/monitor.py'],
            ('leon-router',),
        ),
        env={
            **os.environ,
            'ROUTER_OWNER_USER': '',
            'ROUTER_VAULT': '/var/lib/leon-router/router.age',
            'ROUTER_PHONE_SETUP': '1',
        },
        cwd='/',
        stdout=subprocess.DEVNULL,
        stderr=open('/tmp/router.log', 'wb'),
    )
    for _ in range(50):
        if pathlib.Path('/run/leon-router/unlock.sock').exists():
            break
        time.sleep(0.1)
    token = panel_request('/updates/data')['actionToken']  # the panel restarted with a new key
    reply = panel_request('/network-map/unlock', {'phrase': 'any phrase'}, token)
    assert reply == {'status': 'notConfigured'}, reply
    # Without a vault no password is tried, so the phone keeps its attempt for the setup.
    reply = panel_request('/network-map/unlock', {'phrase': 'any phrase'}, token)
    assert reply == {'status': 'notConfigured'}, reply
    # One real phone attempt per minute, setup included; nothing is written without a router login.
    setup = {'phrase': 'a new long passphrase', 'password': 'router password'}
    reply = panel_request('/network-map/unlock', setup, token)
    assert reply == {'status': 'unlockFailed'}, reply  # the container has no network gateway
    reply = panel_request('/network-map/unlock', setup, token)
    assert reply == {'status': 'busy'}, reply
    assert not pathlib.Path('/var/lib/leon-router/router.age').exists()
    reach = (
        "import socket; s=socket.socket(socket.AF_UNIX);s.connect('/run/leon-router/unlock.sock')"
    )
    result = subprocess.run(
        run_as(
            'leon-support', 'leon-support', ['python3', '-I', '-c', reach], ('leon-home-control',)
        ),
        capture_output=True,
    )
    assert result.returncode != 0, 'Support reached the router monitor'
    print('Linux maintenance, router monitor isolation and phone setup gates passed.')


if __name__ == '__main__':
    main()
