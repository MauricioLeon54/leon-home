import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location(
    'router_monitor', ROOT / 'deploy/leon-home/files/usr/local/lib/leon-router/monitor.py'
)
monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitor)
AGE = shutil.which('age')


def route_table(gateway_hex, flags='0003'):
    return (
        'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n'
        'eth0\t0003A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\n'
        f'eth0\t00000000\t{gateway_hex}\t{flags}\t0\t0\t100\t00000000\n'
    )


class GatewayTests(unittest.TestCase):
    def read(self, text):
        with tempfile.NamedTemporaryFile('w', delete=False) as handle:
            handle.write(text)
        self.addCleanup(os.unlink, handle.name)
        return monitor.default_gateway(handle.name)

    def test_reads_the_little_endian_default_gateway(self):
        self.assertEqual(self.read(route_table('0103A8C0')), '192.168.3.1')

    def test_ignores_a_default_route_without_a_gateway_flag(self):
        with self.assertRaises(monitor.ProbeError):
            self.read(route_table('0103A8C0', flags='0001'))


@unittest.skipUnless(AGE, 'age is not installed')
class VaultTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory)
        self.vault = Path(directory) / 'router.age'
        patcher = mock.patch.object(monitor, 'AGE', AGE)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_encrypts_once_and_decrypts_with_the_same_phrase(self):
        document = {'schemaVersion': 1, 'devices': {'router': {'origin': 'http://192.168.3.1'}}}
        monitor.encrypt_vault('correct horse battery', document, self.vault)
        self.assertEqual(self.vault.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(b'192.168.3.1', self.vault.read_bytes())
        self.assertEqual(monitor.decrypt_vault('correct horse battery', self.vault), document)
        with self.assertRaises(monitor.ProbeError):
            monitor.decrypt_vault('wrong phrase here', self.vault)

    def test_never_replaces_an_existing_vault(self):
        monitor.encrypt_vault('correct horse battery', {'a': 1}, self.vault)
        with self.assertRaises(FileExistsError):
            monitor.encrypt_vault('another phrase value', {'b': 2}, self.vault)
        self.assertEqual(monitor.decrypt_vault('correct horse battery', self.vault), {'a': 1})

    def test_missing_vault_is_not_configured(self):
        with self.assertRaisesRegex(monitor.ProbeError, 'notConfigured'):
            monitor.decrypt_vault('correct horse battery', self.vault)


class ReceiveTests(unittest.TestCase):
    def ask(self, request, uid):
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        with right:
            right.sendall(json.dumps(request).encode())
            right.shutdown(socket.SHUT_WR)
            return monitor.receive(left, uid)

    def test_refuses_unknown_peers(self):
        with mock.patch.object(monitor, 'OWNER_UID', None):
            with self.assertRaisesRegex(monitor.ProbeError, 'unauthorizedOwner'):
                self.ask({'phrase': 'x'}, 4242)

    def test_phone_setup_is_off_unless_the_unit_enables_it(self):
        with (
            mock.patch.object(monitor, 'OVERVIEW_UID', 4242),
            mock.patch.object(monitor, 'PHONE_SETUP', False),
        ):
            with self.assertRaisesRegex(monitor.ProbeError, 'setupUnavailable'):
                self.ask({'phrase': 'a long enough phrase', 'password': 'router'}, 4242)

    def test_phone_setup_requires_a_long_phrase(self):
        with (
            mock.patch.object(monitor, 'OVERVIEW_UID', 4242),
            mock.patch.object(monitor, 'PHONE_SETUP', True),
        ):
            with self.assertRaisesRegex(monitor.ProbeError, 'invalidCredentials'):
                self.ask({'phrase': 'short', 'password': 'router'}, 4242)

    def test_phone_setup_refuses_when_a_vault_exists(self):
        with tempfile.NamedTemporaryFile() as existing:
            with (
                mock.patch.object(monitor, 'OVERVIEW_UID', 4242),
                mock.patch.object(monitor, 'PHONE_SETUP', True),
                mock.patch.object(monitor, 'VAULT', Path(existing.name)),
            ):
                with self.assertRaisesRegex(monitor.ProbeError, 'alreadyConfigured'):
                    self.ask({'phrase': 'a long enough phrase', 'password': 'router'}, 4242)

    def test_phone_setup_logs_in_before_writing_the_vault(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory)
        vault = Path(directory) / 'router.age'
        with (
            mock.patch.object(monitor, 'OVERVIEW_UID', 4242),
            mock.patch.object(monitor, 'PHONE_SETUP', True),
            mock.patch.object(monitor, 'VAULT', vault),
            mock.patch.object(monitor, 'default_gateway', return_value='192.168.3.1'),
            mock.patch.object(
                monitor.PortRouter,
                'login',
                side_effect=monitor.ProbeError('authenticationRejected'),
            ),
        ):
            with self.assertRaisesRegex(monitor.ProbeError, 'authenticationRejected'):
                self.ask({'phrase': 'a long enough phrase', 'password': 'wrong'}, 4242)
        self.assertFalse(vault.exists())

    def test_rejects_extra_fields_and_line_breaks(self):
        with mock.patch.object(monitor, 'OVERVIEW_UID', 4242):
            for request in ({'phrase': 'x', 'origin': 'http://10.0.0.1'}, {'phrase': 'a\nb'}):
                with self.assertRaisesRegex(monitor.ProbeError, 'invalidCredentials'):
                    self.ask(request, 4242)


class HostTests(unittest.TestCase):
    def test_prefers_the_vendor_app_name_and_falls_back_to_the_dhcp_name(self):
        rows = monitor.normalize(
            [
                {
                    'IPAddress': '192.168.3.80',
                    'ActualName': '  Living\nroom  TV ',
                    'HostName': 'BRAVIA',
                },
                {'IPAddress': '192.168.3.81', 'ActualName': '', 'HostName': 'android-box'},
                {'IPAddress': '192.168.3.82'},
            ]
        )
        self.assertEqual([row['name'] for row in rows], ['Livingroom TV', 'android-box', None])


if __name__ == '__main__':
    unittest.main()
