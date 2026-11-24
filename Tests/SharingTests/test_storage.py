import subprocess
import sys
import unittest
from configparser import ConfigParser
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'sharing/storage/configure.py'


class StorageConfigurationTests(unittest.TestCase):
    def render(self, guest, *extra):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                '--owner',
                'nas_owner',
                '--guest',
                guest,
                *extra,
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_share_access(self):
        result = self.render('nas_guest')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = ConfigParser()
        config.read_string(result.stdout)
        self.assertEqual(config['global']['interfaces'], '127.0.0.1')
        self.assertTrue(config['global'].getboolean('bind interfaces only'))
        self.assertEqual(config['Library']['valid users'], 'nas_owner nas_guest')
        self.assertEqual(config['Library']['write list'], 'nas_owner')
        self.assertTrue(config['Library'].getboolean('read only'))
        self.assertEqual(config['Exchange']['valid users'], 'nas_owner nas_guest')
        self.assertFalse(config['Exchange'].getboolean('read only'))

    def test_rejects_duplicate_users_and_configuration_injection(self):
        for guest in ('nas_owner', 'root', 'nas_guest\n[homes]', 'guest other'):
            with self.subTest(guest=guest):
                result = self.render(guest)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')

    def test_read_only_volume_root_without_exchange(self):
        result = self.render(
            'nas_guest', '--library-path', '/srv/leon-storage', '--without-exchange'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = ConfigParser(interpolation=None)
        config.read_string(result.stdout)
        self.assertEqual(config['Library']['path'], '/srv/leon-storage')
        self.assertNotIn('Exchange', config)
        self.assertIn('System Volume Information', config['global']['veto files'])

    def test_rejects_library_outside_storage(self):
        for path in (
            '/',
            '/srv/leon-storage/../etc',
            '/srv/leon-storagex',
            '/srv/leon-storage/a\n[homes]',
            '/srv/leon-storage//x',
        ):
            with self.subTest(path=path):
                self.assertEqual(self.render('nas_guest', '--library-path', path).returncode, 2)
