import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'sharing'))
from leon_home import install
from leon_home.contracts import ReleaseError

CANDIDATE = {'sequence': 4, 'version': '0.3.0', 'brokerSha256': 'b' * 64}


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = pathlib.Path(folder.name)
        self.root, self.config = base / 'opt', base / 'etc'
        (self.root / 'releases/3-0.2.0').mkdir(parents=True)
        (self.root / 'current').symlink_to(self.root / 'releases/3-0.2.0')
        self.config.mkdir()
        (self.config / 'broker.sha256').write_text('a' * 64 + '\n')
        (self.config / 'release-key.pem').write_bytes(b'trusted')
        self.installed({'sequence': 3, 'version': '0.2.0'})
        for name, value in (('ROOT', self.root), ('CONFIG', self.config)):
            patcher = patch.object(install, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def installed(self, value):
        (self.root / 'current/release.json').write_text(json.dumps(value))

    def test_a_newer_release_is_a_full_maintenance(self):
        self.assertFalse(install.base_pending(CANDIDATE))

    def test_the_same_release_with_an_old_base_resumes(self):
        self.installed({'sequence': 4, 'version': '0.3.0'})
        self.assertTrue(install.base_pending(CANDIDATE))

    def test_the_same_release_with_a_finished_base_is_refused(self):
        self.installed({'sequence': 4, 'version': '0.3.0'})
        (self.config / 'broker.sha256').write_text('b' * 64 + '\n')
        with self.assertRaisesRegex(ReleaseError, 'notNewer'):
            install.base_pending(CANDIDATE)

    def test_an_older_release_is_refused(self):
        self.installed({'sequence': 5, 'version': '0.4.0'})
        with self.assertRaisesRegex(ReleaseError, 'notNewer'):
            install.base_pending(CANDIDATE)

    def test_never_rotates_the_trusted_key(self):
        other = self.config / 'other.pem'
        other.write_bytes(b'untrusted')
        with patch.object(install.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ReleaseError, 'invalidSignature'):
                install.maintain(self.root, other, 'f' * 64, self.root)

    def test_refuses_an_unfinished_initial_setup(self):
        (self.config / 'installing.json').write_text('{}')
        with patch.object(install.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ReleaseError, 'setupIncomplete'):
                install.maintain(self.root, self.config / 'release-key.pem', 'f' * 64, self.root)

    def test_requires_root(self):
        with patch.object(install.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(ReleaseError, 'rootRequired'):
                install.maintain(self.root, self.config / 'release-key.pem', 'f' * 64, self.root)


if __name__ == '__main__':
    unittest.main()
