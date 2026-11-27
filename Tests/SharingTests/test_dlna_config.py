import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'sharing/storage/dlna_config.py'
DEFAULT = (ROOT / 'Tests/Fixtures/gerbera/default-2.4.xml').read_text(encoding='utf-8')
NS = {'g': 'http://mediatomb.cc/config/2'}
UDN = '2ac662cd-6a54-4f3e-8ee3-ac0210f189ea'


def render(*extra, default=DEFAULT):
    args = [
        sys.executable,
        str(SCRIPT),
        '--name',
        'LEÓN Películas',
        '--library',
        '/srv/leon-storage/PELICULAS',
        '--udn',
        UDN,
        *extra,
    ]
    return subprocess.run(args, input=default, capture_output=True, text=True, check=False)


class DlnaConfigurationTests(unittest.TestCase):
    def test_movie_server(self):
        result = render()
        self.assertEqual(result.returncode, 0, result.stderr)
        root = ET.fromstring(result.stdout)
        server = root.find('g:server', NS)
        self.assertEqual(server.find('g:name', NS).text, 'LEÓN Películas')
        self.assertEqual(server.find('g:port', NS).text, '8200')
        self.assertEqual(server.find('g:interface', NS).text, 'eth0')
        self.assertEqual(server.find('g:udn', NS).text, f'uuid:{UDN}')
        self.assertEqual(server.find('g:home', NS).text, '/var/lib/gerbera')
        self.assertEqual(server.find('g:ui', NS).get('enabled'), 'no')
        self.assertEqual(server.find('g:pc-directory', NS).get('upnp-hide'), 'yes')
        self.assertEqual(root.find('g:import/g:scripting/g:virtual-layout', NS).get('type'), 'js')
        directory = root.find('g:import/g:autoscan/g:directory', NS)
        self.assertEqual(directory.get('location'), '/srv/leon-storage/PELICULAS')
        self.assertEqual(directory.get('mode'), 'inotify')
        fanart = [
            node.get('name')
            for node in root.findall('g:import/g:resources/g:fanart/g:add-file', NS)
        ]
        self.assertEqual(fanart, ['folder.jpg', 'poster.jpg'])
        visible = {
            box.get('key'): box.get('title')
            for box in root.iter(f'{{{NS["g"]}}}box')
            if box.get('enabled') != 'false'
        }
        self.assertEqual(
            visible, {'Video/videoRoot': 'Películas', 'Video/allVideo': 'Todas las películas'}
        )

    def test_network_library_scans_daily(self):
        result = render('--scan', 'timed')
        directory = ET.fromstring(result.stdout).find('g:import/g:autoscan/g:directory', NS)
        self.assertEqual((directory.get('mode'), directory.get('interval')), ('timed', '86400'))

    def test_rejects_unsafe_values(self):
        self.assertNotEqual(render('--interface', 'eth0;x').returncode, 0)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--name', 'x', '--library', '/etc'],
            input=DEFAULT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--name', 'x', '--library', '/srv/../etc'],
            input=DEFAULT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_changed_default_fails_instead_of_half_applying(self):
        result = render(default=DEFAULT.replace('<ui enabled="yes"', '<ui enabled="maybe"'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
