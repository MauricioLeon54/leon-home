#!/usr/bin/env python3
"""Forced OpenSSH command: state, update checks and two service restarts; no shell."""

import json
import os
import socket
import subprocess

operation = os.environ.get('SSH_ORIGINAL_COMMAND', '').strip()
restarts = {
    'restart-panel': 'leon-overview.service',
    'restart-updates': 'leon-home-updates.service',
}
if operation in restarts:
    result = subprocess.run(
        ['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', restarts[operation]],
        capture_output=True,
        timeout=30,
        check=False,
    )
    raise SystemExit(0 if result.returncode == 0 else 'Support restart unavailable.')
commands = {'status': 'status', 'check-updates': 'check'}
if operation not in commands:
    raise SystemExit(
        'LEON Home support: use status, check-updates, restart-panel or restart-updates.'
    )
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(4)
    connection.connect('/run/leon-home-updates/control.sock')
    connection.sendall(json.dumps({'operation': commands[operation]}).encode() + b'\n')
    raw = bytearray()
    while not raw.endswith(b'\n'):
        chunk = connection.recv(4096)
        if not chunk or len(raw) + len(chunk) > 8192:
            raise SystemExit('Support service unavailable.')
        raw.extend(chunk)
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise SystemExit('Support service unavailable.')
    print(json.dumps(value, ensure_ascii=False))
