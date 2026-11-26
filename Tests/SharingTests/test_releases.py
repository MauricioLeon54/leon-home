import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'sharing'))
from leon_home import activation, download, release
from leon_home.contracts import FILES, ReleaseError, Site, manifest
from leon_home.install import preflight, support_key
from leon_home.worker import Worker

SITE = {
    'schemaVersion': 1,
    'owner': 'owner@example.test',
    'supportLogin': 'support@example.test',
    'repository': 'example/leon-home',
    'interface': 'eth0',
    'hostname': 'leon-test',
}


class WebReleaseContractTests(unittest.TestCase):
    def test_family_release_contains_only_current_web_assets(self):
        self.assertEqual(
            {
                name.removeprefix('app/web/dist/')
                for name in FILES
                if name.startswith('app/web/dist/')
            },
            {'leon.js', 'leon.css', 'serviceWorker.js', 'home.css', 'updates.js', 'updates.css'},
        )
        self.assertNotIn('app/network-map.html', FILES)

    def test_activation_accepts_network_map_shell_response(self):
        connection = Mock()
        connection.getresponse.return_value.status = 200
        with patch.object(activation, 'UnixHTTP', return_value=connection):
            self.assertTrue(activation.healthy(SITE['owner']))
        connection.request.assert_called_once_with(
            'GET', '/network-map', headers={'Tailscale-User-Login': SITE['owner']}
        )
        connection.close.assert_called_once_with()


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = pathlib.Path(self.folder.name).resolve()
        self.key, self.public = self.root / 'private.pem', self.root / 'public.pem'
        for command in (
            ['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(self.key)],
            ['openssl', 'pkey', '-in', str(self.key), '-pubout', '-out', str(self.public)],
        ):
            subprocess.run(command, capture_output=True, check=True, timeout=10)
        self.key.chmod(0o600)
        der = subprocess.run(
            # Fixed tool in the developer test PATH; no caller chooses the executable.
            ['openssl', 'pkey', '-pubin', '-in', str(self.public), '-outform', 'DER'],  # noqa: S607
            capture_output=True,
            check=True,
        ).stdout
        self.fingerprint = hashlib.sha256(der).hexdigest()

    def bundle(self, version='1.0.0', sequence=1, members=None):
        folder = self.root / ('bundle-' + version)
        folder.mkdir()
        members = members or dict.fromkeys(FILES, b'fixture')
        with tarfile.open(
            folder / 'leon-home-arm64.tar.gz', 'w:gz', format=tarfile.USTAR_FORMAT
        ) as archive:
            for name, data in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        archive = (folder / 'leon-home-arm64.tar.gz').read_bytes()
        value = {
            'schemaVersion': 1,
            'product': 'leon-home',
            'version': version,
            'sequence': sequence,
            'architecture': 'aarch64',
            'os': 'debian-13',
            'notes': ['A test improvement.'],
            'archiveSha256': hashlib.sha256(archive).hexdigest(),
            'archiveBytes': len(archive),
            'bootstrapSha256': hashlib.sha256(b'bootstrap').hexdigest(),
            'bootstrapBytes': 9,
            'brokerSha256': '1' * 64,
            'files': {
                name: {
                    'sha256': hashlib.sha256(members.get(name, b'fixture')).hexdigest(),
                    'bytes': len(members.get(name, b'fixture')),
                }
                for name in FILES
            },
        }
        (folder / 'bootstrap.tar.gz').write_bytes(b'bootstrap')
        self.sign(folder, value)
        return folder, value

    def sign(self, folder, value):
        (folder / 'manifest.json').write_text(json.dumps(value))
        subprocess.run(
            # Fixed tool in the developer test PATH; no caller chooses the executable.
            [  # noqa: S607
                'openssl',
                'pkeyutl',
                '-sign',
                '-inkey',
                str(self.key),
                '-rawin',
                '-in',
                str(folder / 'manifest.json'),
                '-out',
                str(folder / 'manifest.sig'),
            ],
            capture_output=True,
            check=True,
            timeout=10,
        )


class ArchiveTests(ReleaseFixture):
    def test_signed_complete_release_unpacks_to_owned_regular_files(self):
        folder, value = self.bundle()
        destination = self.root / 'release'
        self.assertEqual(release.unpack(folder, destination, self.public), value)
        self.assertEqual(
            {
                str(path.relative_to(destination))
                for path in destination.rglob('*')
                if path.is_file()
            },
            FILES | {'release.json'},
        )
        self.assertEqual((destination / 'inventory/leon-netmap').stat().st_mode & 0o777, 0o755)

    def test_release_is_readable_by_services_with_restrictive_broker_umask(self):
        folder, _ = self.bundle()
        destination = self.root / 'release'
        previous = os.umask(0o077)
        try:
            release.unpack(folder, destination, self.public)
        finally:
            os.umask(previous)
        for path in [destination, *destination.rglob('*')]:
            if path.is_dir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)
            else:
                self.assertTrue(path.stat().st_mode & 0o004)

    def test_tampered_manifest_or_archive_is_rejected(self):
        folder, _ = self.bundle()
        (folder / 'manifest.json').write_bytes((folder / 'manifest.json').read_bytes() + b' ')
        with self.assertRaises(ReleaseError):
            release.verify(folder, self.public)

    def test_missing_or_extra_tar_members_cannot_write_outside_release(self):
        for index, members in enumerate(
            ({'../outside': b'bad'}, dict.fromkeys(list(FILES)[:-1], b'fixture'))
        ):
            with self.subTest(index=index):
                folder, _ = self.bundle(f'1.0.{index}', index + 1, members)
                destination = self.root / f'release-{index}'
                with self.assertRaises(ReleaseError):
                    release.unpack(folder, destination, self.public)
                self.assertFalse(destination.exists())
                self.assertFalse((self.root / 'outside').exists())

    def test_tar_links_and_duplicate_members_are_rejected(self):
        folder, value = self.bundle()
        for link in (True, False):
            with self.subTest(link=link):
                path = folder / 'leon-home-arm64.tar.gz'
                with tarfile.open(path, 'w:gz', format=tarfile.USTAR_FORMAT) as archive:
                    name = next(iter(FILES))
                    for _ in range(2):
                        info = tarfile.TarInfo(name)
                        if link:
                            info.type, info.linkname = tarfile.SYMTYPE, '/etc/shadow'
                            archive.addfile(info)
                        else:
                            info.size = 7
                            archive.addfile(info, io.BytesIO(b'fixture'))
                value['archiveBytes'] = path.stat().st_size
                value['archiveSha256'] = release.digest(path)
                self.sign(folder, value)
                with self.assertRaises(ReleaseError):
                    release.unpack(folder, self.root / 'unpacked', self.public)

    def test_downgrades_and_replays_are_refused(self):
        _, current = self.bundle('1.0.0', 5)
        for version, sequence in (('1.0.0', 5), ('0.9.0', 6), ('2.0.0', 4)):
            value = {**current, 'version': version, 'sequence': sequence}
            with self.assertRaises(ReleaseError):
                release.newer(value, current)

    def test_manifest_limits_unknown_keys_and_private_config_paths_fail_closed(self):
        _, current = self.bundle()
        for change in (
            {'schemaVersion': True},
            {'sequence': True},
            {'notes': ['x' * 241]},
            {'extra': 'no'},
            {'architecture': 'x86_64'},
            {
                'files': {
                    **current['files'],
                    '/etc/leon-home/site.json': {'bytes': 1, 'sha256': '0' * 64},
                }
            },
        ):
            with self.subTest(change=list(change)), self.assertRaises(ReleaseError):
                manifest({**current, **change})

    def test_site_rejects_shell_text_and_ambiguous_owner(self):
        for change in (
            {'owner': 'owner; command'},
            {'interface': 'eth0\n'},
            {'hostname': '../root'},
            {'supportLogin': SITE['owner']},
            {'schemaVersion': True},
            {'repository': 'https://example.test/x'},
        ):
            with self.assertRaises(ReleaseError):
                Site.parse({**SITE, **change})

    def test_only_github_https_downloads_are_permitted(self):
        for url in (
            'http://github.com/x',
            'https://127.0.0.1/x',
            'https://github.com.evil.test/x',
            'https://user' + '@github.com/x',
            'https://github.com:8443/x',
            'https://github.com:invalid/x',
            'https://[invalid/x',
        ):
            with self.assertRaises(ReleaseError):
                download.allowed(url)


class ActivationTests(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.app = self.root / 'app'
        self.state = self.root / 'state'
        self.state.mkdir()
        self.previous = self.app / 'releases/1-1.0.0'
        self.next = self.app / 'releases/2-1.1.0'
        self.previous.mkdir(parents=True)
        self.next.mkdir()
        (self.app / 'current').symlink_to(self.previous)
        for name, value in (('ROOT', self.app), ('STATE', self.state)):
            patcher = patch.object(activation, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_failed_health_check_restores_previous_tree_and_removes_transaction(self):
        import contextlib

        with (
            patch.object(activation, 'paused_inventory', side_effect=contextlib.nullcontext),
            patch.object(activation, 'command') as command,
            patch.object(activation, 'healthy', side_effect=[False, True]),
            self.assertRaises(ReleaseError) as error,
        ):
            activation.activate(self.next, SITE['owner'])
        self.assertEqual(
            command.call_args_list.count(
                unittest.mock.call('systemctl', 'restart', 'leon-router.service')
            ),
            2,
        )
        self.assertEqual(error.exception.code, 'rolledBack')
        self.assertEqual((self.app / 'current').resolve(), self.previous)
        self.assertFalse((self.state / 'transaction.json').exists())

    def test_successful_activation_restarts_router_before_overview(self):
        import contextlib

        with (
            patch.object(activation, 'paused_inventory', side_effect=contextlib.nullcontext),
            patch.object(activation, 'command') as command,
            patch.object(activation, 'healthy', return_value=True),
        ):
            activation.activate(self.next, SITE['owner'])
        self.assertEqual(
            command.call_args_list[:2],
            [
                unittest.mock.call('systemctl', 'restart', 'leon-router.service'),
                unittest.mock.call('systemctl', 'restart', 'leon-overview.service'),
            ],
        )

    def test_interrupted_activation_is_recovered_on_restart(self):
        import contextlib

        release.atomic_json(
            self.state / 'transaction.json',
            {'previous': str(self.previous), 'next': str(self.next)},
        )
        activation.select(self.next)
        with (
            patch.object(activation, 'paused_inventory', side_effect=contextlib.nullcontext),
            patch.object(activation, 'command'),
            patch.object(activation, 'healthy', return_value=True),
        ):
            self.assertTrue(activation.recover(SITE['owner']))
        self.assertEqual((self.app / 'current').resolve(), self.previous)


class InstallerTests(ReleaseFixture):
    def test_plan_validates_identity_and_scope_without_writing(self):
        from leon_home import install

        folder, _ = self.bundle()
        target = self.root / 'opt'
        config = self.root / 'etc'

        def read_only(*arguments, **kwargs):
            if arguments == ('pihole-FTL', '--version'):
                return 'v6.0.0'
            if arguments[0] == 'ip':
                return json.dumps(
                    [{'addr_info': [{'family': 'inet', 'local': '10.50.0.2', 'prefixlen': 24}]}]
                )
            if arguments == ('tailscale', 'status', '--json'):
                return json.dumps(
                    {
                        'BackendState': 'Running',
                        'Self': {'UserID': 1},
                        'User': {'1': {'LoginName': SITE['owner']}},
                    }
                )
            self.fail('Plan attempted a mutating command')
            return None

        with (
            patch.multiple(install, ROOT=target, CONFIG=config, run=read_only),
            patch.object(install.platform, 'system', return_value='Linux'),
            patch.object(install.platform, 'machine', return_value='aarch64'),
            patch.object(
                install.platform,
                'freedesktop_os_release',
                return_value={'ID': 'debian', 'VERSION_ID': '13'},
            ),
            patch.object(install.shutil, 'which', return_value='/bin/mock'),
        ):
            preflight(Site.parse(SITE), folder, self.public, self.fingerprint)
        self.assertFalse(target.exists())
        self.assertFalse(config.exists())

    def test_support_key_is_public_ed25519_only(self):
        key = self.root / 'support'
        key.write_text('command="bad" ssh-rsa ignored')
        with self.assertRaises(ReleaseError):
            support_key(key)


class WorkerTests(ReleaseFixture):
    def test_client_cannot_supply_commands_or_arbitrary_release_paths(self):
        config = self.root / 'config'
        state = self.root / 'state'
        app = self.root / 'app'
        for folder in (config, state, app / 'current'):
            folder.mkdir(parents=True)
        (config / 'site.json').write_text(json.dumps(SITE))
        shutil.copyfile(self.public, config / 'release-key.pem')
        (app / 'current/release.json').write_text(json.dumps({'version': '1.0.0', 'sequence': 1}))
        worker = Worker(config, state, app)
        self.addCleanup(worker.executor.shutdown)
        for value in (
            {'operation': 'shell'},
            # Invalid-path string fixture only; no temporary file is created.
            {'operation': 'apply', 'version': '/tmp/anything'},  # noqa: S108
            {'operation': 'status', 'command': 'id'},
        ):
            with self.assertRaises(ReleaseError):
                worker.dispatch(value)
        self.assertEqual(worker.snapshot()['phase'], 'current')
