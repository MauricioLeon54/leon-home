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

    def encrypt(self, phrase, document):
        arguments = ['--encrypt', '--passphrase', '--output', str(self.vault)]
        monitor.run_age(arguments, phrase, 2, json.dumps(document).encode())

    def test_decrypts_with_the_same_phrase_only(self):
        document = {'schemaVersion': 1, 'devices': {'router': {'origin': 'http://192.168.3.1'}}}
        self.encrypt('correct horse battery', document)
        self.assertNotIn(b'192.168.3.1', self.vault.read_bytes())
        self.assertEqual(monitor.decrypt_vault('correct horse battery', self.vault), document)
        with self.assertRaises(monitor.ProbeError):
            monitor.decrypt_vault('wrong phrase here', self.vault)

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
        with (
            mock.patch.object(monitor, 'OWNER_UID', None),
            self.assertRaisesRegex(monitor.ProbeError, 'unauthorizedOwner'),
        ):
            self.ask({'phrase': 'x'}, 4242)

    def test_phone_setup_is_off_unless_the_unit_enables_it(self):
        with (
            mock.patch.object(monitor, 'OVERVIEW_UID', 4242),
            mock.patch.object(monitor, 'PHONE_SETUP', False),
            self.assertRaisesRegex(monitor.ProbeError, 'setupUnavailable'),
        ):
            self.ask({'password': 'router'}, 4242)

    def connect(self, folder, **login):
        with (
            mock.patch.object(monitor, 'OVERVIEW_UID', 4242),
            mock.patch.object(monitor, 'PHONE_SETUP', True),
            mock.patch.object(monitor, 'VAULT', Path(folder) / 'router.age'),
            mock.patch.object(monitor, 'AUTO_KEY', Path(folder) / 'auto.key'),
            mock.patch.object(monitor, 'AUTO_ENTRIES', Path(folder) / 'auto.age'),
            mock.patch.object(monitor, 'AGE', AGE),
            mock.patch.object(monitor, 'AGE_KEYGEN', shutil.which('age-keygen')),
            mock.patch.object(monitor, 'default_gateway', return_value='192.168.3.1'),
            mock.patch.object(monitor.PortRouter, 'login', **login),
            mock.patch('sys.stderr'),
        ):
            router = self.ask({'password': 'router-secret'}, 4242)
            monitor.remember(router.entries)
            return monitor.remembered(), monitor.access(monitor.AutoUnlock())['isReconnecting']

    @unittest.skipUnless(AGE and shutil.which('age-keygen'), 'age is not installed')
    def test_the_router_password_alone_connects_and_is_remembered_encrypted(self):
        with tempfile.TemporaryDirectory() as folder:
            legacy = Path(folder) / 'router.age'
            legacy.write_bytes(b'legacy ciphertext')
            entries, is_reconnecting = self.connect(folder)
            self.assertEqual(entries['router']['origin'], 'http://192.168.3.1')
            self.assertTrue(is_reconnecting)
            self.assertEqual((Path(folder) / 'auto.key').stat().st_mode & 0o777, 0o400)
            self.assertNotIn(b'router-secret', (Path(folder) / 'auto.age').read_bytes())
            self.connect(folder)  # a second connection keeps the key
            self.assertEqual(legacy.read_bytes(), b'legacy ciphertext')

    def test_a_refused_password_leaves_nothing_behind(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(monitor.ProbeError, 'authenticationRejected'):
                self.connect(folder, side_effect=monitor.ProbeError('authenticationRejected'))
            self.assertEqual(os.listdir(folder), [])

    def test_successful_login_survives_save_or_key_failure(self):
        for failure in ('remember', 'key'):
            router = mock.Mock()
            with (
                mock.patch.object(monitor, 'PHONE_SETUP', True),
                mock.patch.object(monitor, 'default_gateway', return_value='192.168.1.1'),
                mock.patch.object(monitor, 'open_session', return_value=router) as login,
                mock.patch.object(
                    monitor,
                    'create_auto_key',
                    side_effect=OSError('private') if failure == 'key' else None,
                ),
                mock.patch.object(monitor, 'remember', return_value=False) as remember,
                mock.patch('sys.stderr') as stderr,
            ):
                self.assertIs(monitor.connect_router('synthetic-secret'), router)
                self.assertFalse(router.saved)
                login.assert_called_once()
                self.assertLessEqual(remember.call_count, 1)
                router.logout.assert_not_called()
                self.assertNotIn('synthetic-secret', str(stderr.mock_calls))
            with mock.patch.object(monitor, 'read_state', return_value={'status': 'current'}):
                kept, state, failures = monitor.poll(router, {}, None, 0)
            self.assertIs(kept, router)
            self.assertEqual(state, {'status': 'current', 'saved': False})
            self.assertEqual(failures, 0)

    def test_rejects_extra_fields_and_line_breaks(self):
        with mock.patch.object(monitor, 'OVERVIEW_UID', 4242):
            for request in (
                {'phrase': 'x', 'origin': 'http://10.0.0.1'},
                {'phrase': 'x', 'password': 'y'},
                {'phrase': 'a\nb'},
                {'password': ''},
            ):
                with self.assertRaisesRegex(monitor.ProbeError, 'invalidCredentials'):
                    self.ask(request, 4242)


class UnlockLoopTests(unittest.TestCase):
    def test_unsaved_session_is_kept_and_does_not_consume_phone_window(self):
        unlock, control = mock.Mock(), mock.Mock()
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        unlock.accept.return_value = (connection, None)
        control.accept.return_value = (connection, None)
        router = mock.Mock(entries=None, saved=False)
        current = {'status': 'current', 'saved': False}
        # A synthetic control read ends the first session. The next phone unlock is still
        # inside the same clock window and must reach receive(), rather than answer busy.
        with (
            mock.patch.object(monitor, 'listen', side_effect=[unlock, control]),
            mock.patch.object(
                monitor.select,
                'select',
                side_effect=[
                    ([unlock], [], []),
                    ([control], [], []),
                    ([unlock], [], []),
                    StopIteration,
                ],
            ),
            mock.patch.object(monitor.time, 'monotonic', return_value=1000),
            mock.patch.object(monitor, 'OVERVIEW_UID', 77),
            mock.patch.object(monitor, 'peer_uid', return_value=77),
            mock.patch.object(monitor, 'receive', return_value=router) as receive,
            mock.patch.object(monitor, 'read_state', side_effect=lambda *_: dict(current)),
            mock.patch.object(monitor, 'poll', side_effect=[(None, {'status': 'error'}, 3)]),
            mock.patch.object(monitor, 'save') as save,
            mock.patch.object(monitor, 'load_schedules', return_value={}),
            mock.patch.object(monitor, 'read_request', return_value={'port': 2, 'enabled': True}),
            mock.patch.object(monitor, 'set_port', return_value='applied'),
            mock.patch.object(monitor, 'read_modem'),
            mock.patch.object(monitor, 'remembered', return_value=None),
            mock.patch.object(monitor.AutoUnlock, 'attempt', return_value=None),
            mock.patch.object(monitor, 'access', return_value={}),
            mock.patch('sys.stderr'),
            self.assertRaises(StopIteration),
        ):
            monitor.main()
        self.assertEqual(receive.call_count, 2)
        replies = [json.loads(call.args[0]) for call in connection.sendall.call_args_list]
        self.assertEqual(replies[0], {'status': 'current', 'saved': False})
        self.assertEqual(replies[2], {'status': 'current', 'saved': False})
        self.assertIn(mock.call(current, mock.ANY), save.call_args_list)
        router.logout.assert_not_called()


class MonitorPhaseTests(unittest.TestCase):
    def setUp(self):
        with (
            mock.patch.object(monitor, 'listen'),
            mock.patch.object(monitor, 'save'),
            mock.patch.object(monitor, 'load_schedules', return_value={}),
        ):
            self.session = monitor.RouterMonitor()

    def test_failed_poll_keeps_schedule_baseline_and_saves_error(self):
        self.session.router = mock.Mock()
        self.session.schedule_last = {'device': True}
        error = {'status': 'error'}
        with (
            mock.patch.object(monitor, 'poll', return_value=(None, error, 3)),
            mock.patch.object(monitor, 'run_schedules') as schedules,
            mock.patch.object(monitor, 'save') as save,
            mock.patch.object(monitor.time, 'monotonic', return_value=100),
        ):
            self.session.refresh_telemetry()
        schedules.assert_not_called()
        self.assertEqual(self.session.schedule_last, {'device': True})
        self.assertIsNone(self.session.router)
        self.assertEqual(self.session.poll_failures, 3)
        self.assertEqual(self.session.next_poll, 100 + monitor.POLL_SECONDS)
        save.assert_called_once_with(error, self.session.auto)

    def test_reconnection_drops_credentials_and_publishes_before_next_poll(self):
        candidate = mock.Mock(entries={'router': {'password': 'synthetic-secret'}})
        current = {'status': 'current'}
        with (
            mock.patch.object(self.session.auto, 'attempt', return_value=candidate),
            mock.patch.object(monitor, 'poll', return_value=(candidate, current, 0)) as poll,
            mock.patch.object(monitor, 'save') as save,
            mock.patch.object(monitor.time, 'monotonic', return_value=100),
        ):
            self.session.reconnect()
        self.assertIsNone(candidate.entries)
        self.assertIs(self.session.router, candidate)
        self.assertEqual(poll.call_args.args[-1], 0)
        save.assert_called_once_with(current, self.session.auto)
        self.assertEqual(self.session.next_poll, 100 + monitor.POLL_SECONDS)

    def test_current_poll_applies_schedules_before_publishing(self):
        router = mock.Mock()
        current = {'status': 'current'}
        with (
            mock.patch.object(monitor, 'poll', return_value=(router, current, 0)),
            mock.patch.object(monitor, 'run_schedules', return_value={'device': True}) as schedules,
            mock.patch.object(monitor, 'save') as save,
        ):
            self.session.refresh_telemetry()
        schedules.assert_called_once_with(router, {})
        self.assertEqual(self.session.schedule_last, {'device': True})
        save.assert_called_once_with(current, self.session.auto)


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

    @unittest.skipUnless(AGE and shutil.which('age-keygen'), 'age is not installed')
    def test_restart_reconnects_but_never_repeats_a_refused_saved_password(self):
        monitor.subprocess.run(
            ['age-keygen', '-o', str(self.key)], capture_output=True, check=True, timeout=10
        )
        legacy = self.key.parent / 'router.age'
        legacy.write_bytes(b'legacy ciphertext stays untouched')
        with mock.patch.object(monitor, 'AGE', AGE):
            self.assertTrue(monitor.remember(self.ENTRIES))
            with mock.patch.object(monitor.PortRouter, 'login') as login:
                self.assertIsNotNone(monitor.AutoUnlock().attempt(0))
                self.assertIsNotNone(monitor.AutoUnlock().attempt(0))
                self.assertEqual(login.call_count, 2)
            with mock.patch.object(
                monitor.PortRouter,
                'login',
                side_effect=monitor.ProbeError('authenticationRejected'),
            ) as login:
                self.assertIsNone(monitor.AutoUnlock().attempt(0))
                self.assertIsNone(monitor.AutoUnlock().attempt(0))
                login.assert_called_once()
            self.assertFalse(self.saved.exists())
            self.assertTrue(self.key.exists())
            self.assertEqual(legacy.read_bytes(), b'legacy ciphertext stays untouched')

    def test_corrupt_missing_or_oversized_entries_never_attempt_login(self):
        self.key.write_bytes(b'not an age key')
        with (
            mock.patch.object(monitor, 'AGE', AGE or '/missing-age'),
            mock.patch.object(monitor.PortRouter, 'login') as login,
        ):
            for contents in (None, b'broken ciphertext', b'x' * 65537):
                if contents is not None:
                    self.saved.write_bytes(contents)
                auto = monitor.AutoUnlock()
                self.assertIsNone(auto.attempt(0))
                self.assertFalse(monitor.access(auto)['isReconnecting'])
            login.assert_not_called()

    def test_telemetry_always_identifies_password_mode_and_current_is_not_reconnecting(self):
        self.key.touch()
        self.saved.touch()
        state = self.key.parent / 'telemetry.json'
        with (
            mock.patch.object(monitor, 'STATE', state),
            mock.patch.object(monitor, 'PHONE_SETUP', True),
        ):
            auto = monitor.AutoUnlock()
            for status, reconnecting in (('locked', True), ('current', False), ('error', True)):
                monitor.save({'status': status, 'observedAt': 123}, auto)
                result = json.loads(state.read_text())
                self.assertEqual(result['unlockBy'], 'password')
                self.assertEqual(result['isReconnecting'], reconnecting)
                self.assertEqual(result['observedAt'], 123)

    def test_the_phone_is_asked_only_when_the_pi_cannot_reconnect(self):
        auto = monitor.AutoUnlock()
        asks = {'unlockBy': 'phrase', 'isReconnecting': False}
        self.assertEqual(monitor.access(auto), asks)
        self.key.touch()
        self.saved.touch()
        self.assertTrue(monitor.access(auto)['isReconnecting'])
        self.attempt(auto, 0, OSError('router is restarting'))
        self.assertTrue(monitor.access(auto)['isReconnecting'])
        with mock.patch.object(monitor, 'remembered', return_value=None):
            auto.attempt(10**6)
        self.assertEqual(monitor.access(auto), asks)
        self.attempt(auto, 10**7, monitor.ProbeError('authenticationRejected'))
        with mock.patch.object(monitor, 'PHONE_SETUP', True):
            self.assertEqual(monitor.access(auto), {**asks, 'unlockBy': 'password'})

    def test_a_router_still_starting_is_not_a_rejection(self):
        auto = monitor.AutoUnlock()
        self.attempt(auto, 0, monitor.ProbeError('invalidSession'))
        self.assertFalse(auto.is_stopped)
        self.assertIsNotNone(self.attempt(auto, 60)[0])

    def test_a_refusal_before_the_password_is_judged_keeps_the_saved_entry(self):
        self.key.touch()
        self.saved.touch()
        auto = monitor.AutoUnlock()
        self.attempt(auto, 0, monitor.ProbeError('loginUnavailable'))  # e.g. another login open
        self.assertFalse(auto.is_stopped)
        self.assertTrue(self.saved.exists())
        self.assertIsNotNone(self.attempt(auto, 60)[0])
        auto = monitor.AutoUnlock()
        self.attempt(auto, 0, monitor.ProbeError('invalidChallenge'))
        self.assertTrue(auto.is_stopped)  # not retried now, but tried again after a restart
        self.assertTrue(self.saved.exists())
        self.attempt(monitor.AutoUnlock(), 0, monitor.ProbeError('invalidServerProof'))
        self.assertFalse(self.saved.exists())

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
