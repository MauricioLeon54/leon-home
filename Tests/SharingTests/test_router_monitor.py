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


class ModemTests(unittest.TestCase):
    ENTRY = {'origin': 'http://192.168.100.1', 'username': 'u', 'password': 'modem-secret'}

    def test_unlock_hands_over_the_modem_entry_of_the_same_vault(self):
        router = {'origin': 'http://192.168.1.1', 'username': '', 'password': 'router-secret'}
        document = {'devices': {'router': router, 'modem': self.ENTRY}}
        with (
            mock.patch.object(monitor, 'OWNER_UID', None),
            mock.patch.object(monitor, 'OVERVIEW_UID', 77),
            mock.patch.object(monitor, 'decrypt_vault', return_value=document),
            mock.patch.object(monitor.PortRouter, 'login') as login,
        ):
            left, right = socket.socketpair()
            with left, right:
                right.sendall(b'{"phrase":"a phrase"}')
                right.shutdown(socket.SHUT_WR)
                opened = monitor.receive(left, 77)
        login.assert_called_once_with('admin', 'router-secret')
        self.assertEqual(opened.entries, {'router': router, 'modem': self.ENTRY})

    def test_the_modem_is_read_once_and_only_the_report_is_saved(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'modem-shape.json'
            probe = mock.Mock()
            probe.probe.return_value = {'pages': {}, 'loggedOut': True}
            probe.line_summary.return_value = {'rxDbm': -21.2}
            line = Path(folder) / 'modem.json'
            with (
                mock.patch.object(monitor, 'MODEM_SHAPE', path),
                mock.patch.object(monitor, 'MODEM_LINE', line),
                mock.patch.object(monitor, 'MODEM_REFUSED', Path(folder) / 'refused'),
                mock.patch.object(monitor, 'modem_read_probe', probe),
                mock.patch('sys.stderr') as stderr,
            ):
                monitor.read_modem(self.ENTRY, False)
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)
                self.assertNotIn('modem-secret', path.read_text() + str(stderr.mock_calls))
                monitor.read_modem(self.ENTRY, False)
                saved = json.loads(line.read_text())
                self.assertEqual([row[1] for row in saved['history']], [-21.2, -21.2])
                probe.probe.reset_mock()
                path.unlink()
                probe.probe.side_effect = monitor.ProbeError('authenticationRejected')
                monitor.read_modem(self.ENTRY, False)
                monitor.read_modem(self.ENTRY, False)  # refused: left alone, also after a restart
                self.assertEqual(probe.probe.call_count, 1)
                monitor.read_modem(self.ENTRY, True)  # the owner unlocked again
                monitor.read_modem(None, True)
            self.assertEqual(probe.probe.call_count, 2)
            self.assertFalse(path.exists())

    def test_installations_without_the_modem_module_do_nothing(self):
        with mock.patch.object(monitor, 'modem_read_probe', None):
            monitor.read_modem(self.ENTRY, True)


class AutoUnlockTests(unittest.TestCase):
    ENTRIES = {
        'router': {'origin': 'http://192.168.1.1', 'username': '', 'password': 'router-secret'},
        'modem': None,
    }

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.key = Path(folder.name) / 'auto.key'
        self.saved = Path(folder.name) / 'auto.age'
        for name, value in (('AUTO_KEY', self.key), ('AUTO_ENTRIES', self.saved)):
            active = mock.patch.object(monitor, name, value)
            active.start()
            self.addCleanup(active.stop)
        active = mock.patch('sys.stderr')
        self.stderr = active.start()
        self.addCleanup(active.stop)

    def test_nothing_is_saved_unless_the_owner_enabled_it(self):
        monitor.remember(self.ENTRIES)
        self.assertFalse(self.saved.exists())
        self.assertIsNone(monitor.remembered())

    @unittest.skipUnless(AGE and shutil.which('age-keygen'), 'age is not installed')
    def test_entries_are_encrypted_at_rest_and_removed_key_disables_it(self):
        monitor.subprocess.run(
            ['age-keygen', '-o', str(self.key)], capture_output=True, check=True, timeout=10
        )
        with mock.patch.object(monitor, 'AGE', AGE):
            monitor.remember(self.ENTRIES)
            self.assertEqual(self.saved.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(b'router-secret', self.saved.read_bytes())
            self.assertEqual(monitor.remembered(), self.ENTRIES)
            self.assertNotIn('router-secret', str(self.stderr.mock_calls))
            self.key.unlink()
            self.assertIsNone(monitor.remembered())

    def attempt(self, auto, now, failure=None):
        with (
            mock.patch.object(monitor, 'remembered', return_value=self.ENTRIES),
            mock.patch.object(monitor.PortRouter, 'login', side_effect=failure) as login,
        ):
            return auto.attempt(now), login.call_count

    def test_a_rejected_password_is_tried_once(self):
        auto = monitor.AutoUnlock()
        rejected = monitor.ProbeError('authenticationRejected')
        self.assertEqual(self.attempt(auto, 100, rejected), (None, 1))
        self.assertEqual(self.attempt(auto, 10**6, rejected), (None, 0))
        auto.reset()  # a phone unlock
        self.assertEqual(self.attempt(auto, 10**6, rejected), (None, 1))

    def test_a_router_still_starting_is_not_a_rejection(self):
        auto = monitor.AutoUnlock()
        self.attempt(auto, 0, monitor.ProbeError('invalidSession'))
        self.assertFalse(auto.is_stopped)
        self.assertIsNotNone(self.attempt(auto, 60)[0])

    def test_an_unreachable_router_is_retried_with_longer_waits(self):
        auto, now, waits = monitor.AutoUnlock(), 0, []
        for _ in range(6):
            self.assertEqual(self.attempt(auto, now, OSError('down')), (None, 1))
            self.assertEqual(self.attempt(auto, now + 1, OSError('down')), (None, 0))
            waits.append(auto.next_at - now)
            now = auto.next_at
        self.assertEqual(waits, [60, 120, 240, 480, 900, 900])
        router, _ = self.attempt(auto, now)
        self.assertEqual(router.entries, self.ENTRIES)


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

    def test_reads_the_lan_port_of_wired_devices_only(self):
        rows = monitor.normalize(
            [
                {'IPAddress': '192.168.3.80', 'InterfaceType': 'LAN', 'Layer2Interface': 'LAN4'},
                {'IPAddress': '192.168.3.81', 'InterfaceType': '5GHz', 'Layer2Interface': 'SSID2'},
                {'IPAddress': '192.168.3.82', 'InterfaceType': 'LAN', 'Layer2Interface': 'eth0'},
                {'IPAddress': '192.168.3.83', 'InterfaceType': 'LAN', 'Layer2Interface': 'LAN14'},
            ]
        )
        self.assertEqual([row['port'] for row in rows], [4, None, None, None])


if __name__ == '__main__':
    unittest.main()
