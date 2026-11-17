"""Unprivileged panel-to-broker protocol. No shell, URLs, commands or file paths are accepted."""

import json
import socket

SOCKET = '/run/leon-home-updates/control.sock'


def request(operation, version=None):
    body = {'operation': operation}
    if operation == 'apply':
        body['version'] = version
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(3)
        connection.connect(SOCKET)
        connection.sendall(json.dumps(body).encode() + b'\n')
        raw = bytearray()
        while not raw.endswith(b'\n'):
            chunk = connection.recv(4096)
            if not chunk:
                raise OSError('Update broker unavailable')
            raw.extend(chunk)
            if len(raw) > 8192:
                raise OSError('Update broker response too large')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise OSError('Update broker response invalid')
    return value
