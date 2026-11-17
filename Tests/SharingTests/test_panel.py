import importlib.util
import json
import pathlib
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'deploy/leon-home/files/usr/local/lib/leon-overview'))
sys.path.insert(0, str(ROOT / 'sharing'))
spec = importlib.util.spec_from_file_location('collector', ROOT / 'sharing/collector.py')
collector = importlib.util.module_from_spec(spec)
sys.modules['collector'] = collector
spec.loader.exec_module(collector)
import family
from leon_home.worker import authorized


class PanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), family.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, login=None, data=None, extra=None):
        headers = {'Tailscale-User-Login': login} if login else {}
        headers.update(extra or {})
        return urllib.request.urlopen(
            urllib.request.Request(self.origin + path, headers=headers, data=data), timeout=2
        )

    def test_missing_owner_never_allows_shared_users(self):
        for owners in (set(), {'owner@example.test'}):
            with patch.object(family.overview, 'OWNERS', owners):
                for path in ('/', '/updates', '/updates/data', '/network-map'):
                    with self.assertRaises(urllib.error.HTTPError) as raised:
                        self.request(path, 'support@example.test')
                    self.assertEqual(raised.exception.code, 403)
                    raised.exception.close()

    def test_owner_page_uses_nonce_and_no_inline_handlers(self):
        with patch.object(family.overview, 'OWNERS', {'owner@example.test'}):
            with self.request('/updates', 'owner@example.test') as response:
                body = response.read().decode()
                self.assertIn('updates.js', body)
                self.assertIn('lang="en"', body)
                self.assertIn('Accept and install', body)
                self.assertNotIn('onclick=', body)
                self.assertIn("script-src 'nonce-", response.headers['Content-Security-Policy'])
                self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_home_network_offline_and_installable_manifest_use_english(self):
        sample = {'snapshot': {}, 'host': {}, 'dns': None, 'at': 1_700_000_000}
        with (
            patch.object(family.overview, 'OWNERS', {'owner@example.test'}),
            patch.object(family.overview, '_data', sample),
        ):
            for path, expected in (
                ('/', 'Home network'),
                ('/network-map', 'Interactive device map'),
                ('/offline', 'Connect Tailscale and try again.'),
            ):
                with self.subTest(path=path):
                    with self.request(path, 'owner@example.test') as response:
                        body = response.read().decode()
                        self.assertIn('lang="en"', body)
                        self.assertIn(expected, body)
            with self.request('/manifest.webmanifest', 'owner@example.test') as response:
                self.assertEqual(json.load(response)['lang'], 'en')

    def test_acceptance_requires_owner_token_same_origin_json_and_exact_version_body(self):
        with (
            patch.object(family.overview, 'OWNERS', {'owner@example.test'}),
            patch.object(
                family.update_client, 'request', return_value={'status': 'accepted'}
            ) as broker,
        ):
            token = family.overview.token('owner@example.test')
            base = {'Content-Type': 'application/json', 'X-Leon-Token': token}
            for data, extra in (
                (b'{"version":"1.1.0"}', {}),
                (b'{"version":"1.1.0"}', {**base, 'Sec-Fetch-Site': 'cross-site'}),
                (b'{"version":"1.1.0","command":"sh"}', base),
                (b'{"version":"../../x"}', base),
            ):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    self.request('/updates/apply', 'owner@example.test', data, extra)
                raised.exception.close()
            broker.assert_not_called()
            with self.request(
                '/updates/apply', 'owner@example.test', b'{"version":"1.1.0"}', base
            ) as response:
                self.assertEqual(response.status, 202)
            broker.assert_called_once_with('apply', '1.1.0')

    def test_rpc_support_role_cannot_accept_or_execute_commands(self):
        for operation, allowed in (
            ('status', True),
            ('check', True),
            ('apply', False),
            ('shell', False),
        ):
            self.assertEqual(authorized(200, 100, 200, {'operation': operation}), allowed)
        self.assertFalse(authorized(300, 100, 200, {'operation': 'status'}))
        self.assertTrue(authorized(100, 100, 200, {'operation': 'apply'}))
