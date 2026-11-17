"""Fresh-site installer. A configured personal Pi or an existing installation is refused."""

import base64
import grp
import hashlib
import ipaddress
import json
import os
import platform
import pwd
import re
import shutil
import subprocess
import time
from pathlib import Path

from .contracts import ReleaseError, read_json
from .release import atomic_json, unpack, verify

ROOT = Path('/opt/leon-home')
CONFIG = Path('/etc/leon-home')


def run(*arguments, input_data=None, timeout=120):
    result = subprocess.run(
        arguments, input=input_data, capture_output=True, timeout=timeout, check=False
    )
    if result.returncode:
        raise ReleaseError('setupCommandFailed')
    return result.stdout.decode().strip()


def validate_key(path, fingerprint):
    if len(fingerprint) != 64 or any(char not in '0123456789abcdef' for char in fingerprint):
        raise ReleaseError('invalidConfiguration')
    der = subprocess.run(
        ['openssl', 'pkey', '-pubin', '-in', str(path), '-outform', 'DER'],
        capture_output=True,
        timeout=10,
        check=True,
    ).stdout
    if (
        len(der) != 44
        or der[:12] != bytes.fromhex('302a300506032b6570032100')
        or hashlib.sha256(der).hexdigest() != fingerprint
    ):
        raise ReleaseError('invalidSignature')


def support_key(path):
    text = Path(path).read_text().strip()
    parts = text.split()
    if len(parts) < 2 or len(text) > 512 or parts[0] != 'ssh-ed25519':
        raise ReleaseError('invalidSupportKey')
    try:
        data = base64.b64decode(parts[1], validate=True)
    except ValueError as error:
        raise ReleaseError('invalidSupportKey') from error
    if (
        len(data) != 51
        or data[:4] != (11).to_bytes(4, 'big')
        or data[4:15] != b'ssh-ed25519'
        or data[15:19] != (32).to_bytes(4, 'big')
    ):
        raise ReleaseError('invalidSupportKey')
    return parts[0] + ' ' + parts[1]


def preflight(site, bundle, key, fingerprint, resume=False):
    validate_key(key, fingerprint)
    candidate = verify(bundle, key)
    bootstrap_archive = Path(bundle) / 'bootstrap.tar.gz'
    if (
        not bootstrap_archive.is_file()
        or bootstrap_archive.stat().st_size != candidate['bootstrapBytes']
        or hashlib.sha256(bootstrap_archive.read_bytes()).hexdigest()
        != candidate['bootstrapSha256']
    ):
        raise ReleaseError('invalidRelease')
    marker = CONFIG / 'installing.json'
    existing = (
        ROOT.exists()
        or CONFIG.exists()
        or Path('/etc/leon-overview').exists()
        or Path('/etc/systemd/system/leon-overview.service').exists()
        or Path('/usr/local/share/leon-home').exists()
    )
    if existing:
        if not resume or not marker.is_file() or marker.stat().st_uid != 0:
            raise ReleaseError('existingInstallation')
        saved = read_json(marker)
        if saved != {
            'site': site.__dict__,
            'manifestSha256': hashlib.sha256(
                (Path(bundle) / 'manifest.json').read_bytes()
            ).hexdigest(),
            'keyFingerprint': fingerprint,
        }:
            raise ReleaseError('existingInstallation')
    if platform.system() != 'Linux' or platform.machine() != 'aarch64':
        raise ReleaseError('incompatible')
    os_release = platform.freedesktop_os_release()
    if os_release.get('ID') != 'debian' or os_release.get('VERSION_ID') != '13':
        raise ReleaseError('incompatible')
    for program in (
        'pihole-FTL',
        'tailscale',
        'openssl',
        'nft',
        'ip',
        'runuser',
        'sshd',
        'systemctl',
        'unbound-checkconf',
        'sudo',
        'visudo',
    ):
        if not shutil.which(program):
            raise ReleaseError('missingPrerequisite')
    if not re.search(r'\bv?6\.', run('pihole-FTL', '--version', timeout=5)):
        raise ReleaseError('incompatible')
    routes = json.loads(run('ip', '-j', '-4', 'address', 'show', 'dev', site.interface, timeout=5))
    addresses = [
        address
        for interface in routes
        for address in interface.get('addr_info', [])
        if address.get('family') == 'inet'
    ]
    if not addresses:
        raise ReleaseError('missingInterface')
    address = ipaddress.IPv4Interface(f'{addresses[0]["local"]}/{addresses[0]["prefixlen"]}')
    if (
        not any(
            address.ip in ipaddress.IPv4Network(scope)
            for scope in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
        )
        or address.network.prefixlen < 22
    ):
        raise ReleaseError('incompatibleSubnet')
    status = json.loads(run('tailscale', 'status', '--json', timeout=10))
    identity = str(status.get('Self', {}).get('UserID', ''))
    login = status.get('User', {}).get(identity, {}).get('LoginName', '').lower()
    if status.get('BackendState') != 'Running' or login != site.owner:
        raise ReleaseError('wrongTailnet')
    # No discovery or application restart is performed in plan mode.
    return candidate, address


def write(path, data, mode=0o644, group=None):
    path = Path(path)
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)
    os.chown(path, 0, grp.getgrnam(group).gr_gid if group else 0)


def account(name, login=False):
    try:
        return pwd.getpwnam(name)
    except KeyError:
        options = (
            ['useradd', '--user-group', '--create-home']
            if login
            else ['useradd', '--user-group', '--system', '--no-create-home']
        )
        run(*options, '--shell', '/bin/sh' if login else '/usr/sbin/nologin', name)
        return pwd.getpwnam(name)


def install(
    site,
    site_value,
    bundle,
    key,
    fingerprint,
    bootstrap,
    app_password,
    support_public=None,
    resume=False,
):
    candidate, address = preflight(site, bundle, key, fingerprint, resume)
    if os.geteuid() != 0:
        raise ReleaseError('rootRequired')
    if not 8 <= len(app_password) <= 256 or any(ord(char) < 32 for char in app_password):
        raise ReleaseError('invalidPassword')
    if site.support_login and support_public is None:
        raise ReleaseError('invalidSupportKey')
    if resume:
        for unit in (
            'leon-home-update-check.timer',
            'leon-home-updates.service',
            'leon-netmap.timer',
            'leon-overview.service',
        ):
            subprocess.run(
                ['systemctl', 'stop', unit], capture_output=True, timeout=100, check=False
            )
        stop = time.monotonic() + 95
        while run(
            'systemctl', 'show', 'leon-netmap.service', '-p', 'ActiveState', '--value'
        ) not in ('inactive', 'failed'):
            if time.monotonic() >= stop:
                raise ReleaseError('inventoryBusy')
            time.sleep(1)
    CONFIG.mkdir(mode=0o755, exist_ok=True)
    atomic_json(
        CONFIG / 'installing.json',
        {
            'site': site.__dict__,
            'manifestSha256': hashlib.sha256(
                (Path(bundle) / 'manifest.json').read_bytes()
            ).hexdigest(),
            'keyFingerprint': fingerprint,
        },
    )
    ROOT.mkdir(mode=0o755, exist_ok=True)
    (ROOT / 'releases').mkdir(mode=0o755, exist_ok=True)
    atomic_json(CONFIG / 'site.json', site_value)
    write(CONFIG / 'release-key.pem', Path(key).read_bytes())
    write(CONFIG / 'broker.sha256', candidate['brokerSha256'] + '\n')
    for group in ('leon-home-control', 'leon-home-health'):
        try:
            grp.getgrnam(group)
        except KeyError:
            run('groupadd', '--system', group)
    account('leon-overview')
    inventory_user = account('leon-netmap')
    inventory_state = Path('/var/lib/leon-netmap')
    inventory_state.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.chown(inventory_state, inventory_user.pw_uid, inventory_user.pw_gid)
    inventory_lock = inventory_state / '.netmap.lock'
    if not inventory_lock.exists():
        inventory_lock.touch(mode=0o644)
        os.chown(inventory_lock, inventory_user.pw_uid, inventory_user.pw_gid)
    run('usermod', '-aG', 'leon-home-control', 'leon-overview')
    if site.support_login:
        support = account('leon-support', login=True)
        run('usermod', '-aG', 'leon-home-control', 'leon-support')
        directory = Path(support.pw_dir) / '.ssh'
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chown(directory, support.pw_uid, support.pw_gid)
        authorized = directory / 'authorized_keys'
        authorized.write_text(
            'restrict,command="/usr/local/bin/leon-home-support" ' + support_public + '\n'
        )
        authorized.chmod(0o600)
        os.chown(authorized, support.pw_uid, support.pw_gid)
        write(
            '/usr/local/bin/leon-home-support',
            '#!/bin/sh\nexec /usr/bin/python3 -I /usr/local/lib/leon-home/runtime/run_support.py\n',
            0o755,
        )
        write(
            '/etc/ssh/sshd_config.d/80-leon-support.conf',
            'Match User leon-support\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  AllowTcpForwarding no\n  AllowAgentForwarding no\n  X11Forwarding no\n  PermitTTY no\nMatch all\n',
        )
        write(
            '/etc/sudoers.d/leon-home-support',
            'leon-support ALL=(root) NOPASSWD: /usr/bin/systemctl restart leon-overview.service, /usr/bin/systemctl restart leon-home-updates.service\n',
            0o440,
        )
        run('visudo', '-cf', '/etc/sudoers.d/leon-home-support', timeout=5)
        run('sshd', '-t', timeout=5)
        run('systemctl', 'reload', 'ssh')
    target = ROOT / 'releases' / f'{candidate["sequence"]}-{candidate["version"]}'
    if target.exists():
        shutil.rmtree(target)
    unpack(bundle, target, key)
    (ROOT / 'current').unlink(missing_ok=True)
    (ROOT / 'current').symlink_to(target, target_is_directory=True)
    runtime = Path('/usr/local/lib/leon-home/runtime')
    runtime.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        Path(bootstrap) / 'leon_home',
        runtime / 'leon_home',
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'),
    )
    for name in ('run_updater.py', 'run_support.py'):
        shutil.copyfile(Path(bootstrap) / name, runtime / name)
    write(CONFIG / 'overview.env', f'OWNER_LOGINS={site.owner}\n', 0o640, 'leon-overview')
    write(CONFIG / 'inventory.env', f'NETMAP_INTERFACE={site.interface}\n')
    write('/etc/leon-overview/pihole-app-password', app_password + '\n', 0o640, 'leon-overview')
    for path in (Path('/var/lib/leon-home-updates'),):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in (
        'leon-overview.service',
        'leon-netmap.service',
        'leon-home-updates.service',
        'leon-home-update-check.service',
        'leon-home-update-check.timer',
    ):
        write(Path('/etc/systemd/system') / name, (Path(bootstrap) / 'units' / name).read_bytes())
    write(
        '/etc/systemd/system/leon-netmap.timer',
        '[Unit]\nDescription=LEÓN Home inventory every five minutes\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\nAccuracySec=30s\n[Install]\nWantedBy=timers.target\n',
    )
    # Only a new dedicated DNS table is replaced; never flush Tailscale's tables/ruleset.
    rules = f'''add table inet leon_home_dns
flush table inet leon_home_dns
table inet leon_home_dns {{
 chain input {{ type filter hook input priority -10; policy accept;
  iifname "lo" udp dport 53 accept
  iifname "lo" tcp dport 53 accept
  iifname "{site.interface}" ip saddr {address.network} udp dport 53 accept
  iifname "{site.interface}" ip saddr {address.network} tcp dport 53 accept
  iifname "tailscale0" udp dport 53 accept
  iifname "tailscale0" tcp dport 53 accept
  udp dport 53 drop
  tcp dport 53 drop
 }}
}}
'''
    write(CONFIG / 'dns.nft', rules)
    run('nft', '--check', '--file', str(CONFIG / 'dns.nft'))
    write(
        '/etc/systemd/system/leon-home-dns.service',
        '[Unit]\nDescription=LEÓN Home DNS ingress scope\nBefore=pihole-FTL.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/nft -f /etc/leon-home/dns.nft\n[Install]\nWantedBy=multi-user.target\n',
    )
    write(
        '/etc/systemd/system/pihole-FTL.service.d/80-leon-home.conf',
        '[Unit]\nRequires=leon-home-dns.service\nAfter=leon-home-dns.service\n',
    )
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'leon-home-dns.service')
    write(
        '/etc/unbound/unbound.conf.d/leon-home.conf',
        (Path(bootstrap) / 'unbound.conf').read_bytes(),
    )
    run('unbound-checkconf')
    run('systemctl', 'enable', '--now', 'unbound')
    run('pihole-FTL', '--config', 'dns.upstreams', '["127.0.0.1#5335"]')
    run('pihole-FTL', '--config', 'webserver.port', '127.0.0.1:8080o')
    run('pihole-FTL', '--config', 'dns.interface', site.interface)
    run('pihole-FTL', '--config', 'dns.listeningMode', 'SINGLE')
    run('pihole-FTL', '--config', 'misc.dnsmasq_lines', '["interface=tailscale0"]')
    run('systemctl', 'restart', 'pihole-FTL')
    run('hostnamectl', 'set-hostname', site.hostname)
    run('tailscale', 'set', '--accept-dns=false', '--hostname', site.hostname)
    run(
        'systemctl',
        'enable',
        '--now',
        'leon-overview.service',
        'leon-netmap.timer',
        'leon-home-updates.service',
        'leon-home-update-check.timer',
    )
    # Brand reads follow the current release; only generic public images are present.
    brand = Path('/usr/local/share/leon-home')
    if brand.is_symlink() and brand.readlink() == ROOT / 'current/brand':
        brand.unlink()
    if brand.exists():
        raise ReleaseError('existingInstallation')
    brand.parent.mkdir(parents=True, exist_ok=True)
    brand.symlink_to(ROOT / 'current/brand', target_is_directory=True)
    run(
        'tailscale',
        'serve',
        '--bg',
        '--set-path',
        '/admin',
        'http://127.0.0.1:8080/admin',
        timeout=90,
    )
    run('tailscale', 'serve', '--bg', '--set-path', '/api', 'http://127.0.0.1:8080/api', timeout=90)
    run('tailscale', 'serve', '--bg', 'unix:/run/leon-home-http/http.sock', timeout=90)
    (CONFIG / 'installing.json').unlink()
    return candidate
