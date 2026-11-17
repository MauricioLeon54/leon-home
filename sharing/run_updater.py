#!/usr/bin/env python3
"""Immutable bootstrap entrypoint; updates cannot replace the root broker itself."""

import json
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from leon_home.worker import SOCKET, serve  # noqa: E402

if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(SOCKET))
            connection.sendall(b'{"operation":"check"}\n')
            response = json.loads(connection.recv(1024))
            if response.get('status') not in ('accepted', 'busy'):
                raise SystemExit('Update check unavailable')
    elif not sys.argv[1:]:
        serve()
    else:
        raise SystemExit('Usage: run_updater.py [--check]')
