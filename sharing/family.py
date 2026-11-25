#!/usr/bin/env python3
"""Phone-only family edition, behind a restricted Unix socket owned by the panel service."""

import base64
import json
import os
import signal
import socketserver
import sys
import threading
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import overview  # noqa: E402
import update_client  # noqa: E402

SOCKET = '/run/leon-home-http/http.sock'
BODY = Path(__file__).with_name('updates.html').read_text(encoding='utf-8')


class Handler(overview.Handler):
    storage_automation = False
    signed_updates = True

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def owner(self):
        # Empty policy is never an invitation to every tailnet/shared user.
        login = (self.headers.get('Tailscale-User-Login') or '').strip().lower()
        return login if login and login in overview.OWNERS else None

    def versions(self):
        try:
            state = update_client.request('status')
            available = state.get('available')
            found = (state.get('version'), available.get('version') if available else None)
        except (AttributeError, OSError, ValueError):
            return None, None
        return tuple(
            value if isinstance(value, str) and overview.VERSION.fullmatch(value) else None
            for value in found
        )

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path not in ('/updates', '/updates/data'):
            return super().do_GET()
        login = self.owner()
        if not login:
            return self.reply(403, b'Forbidden', 'text/plain; charset=utf-8')
        if path == '/updates/data':
            try:
                state = update_client.request('status')
            except (OSError, ValueError):
                return self.reply(503, b'{"status":"unavailable"}', 'application/json')
            body = json.dumps(
                {**state, 'actionToken': overview.token(login)}, allow_nan=False
            ).encode()
            return self.reply(200, body, 'application/json; charset=utf-8')
        nonce = base64.b64encode(os.urandom(12)).decode()
        page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Updates · LEÓN Home</title><link rel="stylesheet" href="/network-map/assets/home.css"><link rel="stylesheet" href="/network-map/assets/updates.css"></head>
<body>{BODY}<script type="module" nonce="{nonce}" src="/network-map/assets/updates.js"></script></body></html>'''
        return self.reply(200, page.encode(), 'text/html; charset=utf-8', nonce=nonce)

    def do_POST(self):
        if self.path not in ('/updates/check', '/updates/apply'):
            return super().do_POST()
        login = self.owner()
        if not login or self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin'):
            return self.reply(403, b'Forbidden', 'text/plain')
        if (
            not overview.token_valid(login, self.headers.get('X-Leon-Token', ''))
            or self.headers.get('Content-Type') != 'application/json'
        ):
            return self.reply(403, b'Forbidden', 'text/plain')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 256 or self.headers.get('Transfer-Encoding'):
                raise ValueError('Invalid body')
            body = json.loads(self.rfile.read(length))
            expected = {'version'} if self.path.endswith('apply') else set()
            if not isinstance(body, dict) or set(body) != expected:
                raise ValueError('Invalid body')
            selected = body.get('version')
            if expected and (
                not isinstance(selected, str)
                or not overview.re.fullmatch(r'\d{1,4}\.\d{1,4}\.\d{1,4}', selected)
            ):
                raise ValueError('Invalid version')
        except (ValueError, UnicodeError):
            return self.reply(400, b'{"status":"invalid"}', 'application/json')
        try:
            result = update_client.request('apply' if expected else 'check', selected)
        except (OSError, ValueError):
            return self.reply(503, b'{"status":"unavailable"}', 'application/json')
        return self.reply(202, json.dumps(result).encode(), 'application/json')


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False
    permits = threading.BoundedSemaphore(16)

    def process_request(self, request, client_address):
        if not self.permits.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.permits.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.permits.release()

    def server_bind(self):
        super().server_bind()
        self.server_name, self.server_port = 'localhost', 0


if __name__ == '__main__':
    if not overview.OWNERS:
        raise SystemExit('Configure the panel owner before starting LEÓN Home.')
    signal.signal(signal.SIGTERM, overview.save_internet_and_exit)
    threading.Thread(target=overview.sampler, daemon=True).start()
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as server:
        os.chmod(SOCKET, 0o660)
        server.serve_forever()
