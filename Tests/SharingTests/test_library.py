import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'sharing/storage/library.py'
spec = importlib.util.spec_from_file_location('library', SCRIPT)
library = importlib.util.module_from_spec(spec)
spec.loader.exec_module(library)

TMDB = {
    ('Coco', '2017'): [{'title': 'Coco', 'original_title': 'Coco', 'release_date': '2017-10-27'}],
    ('Inside Out', '2015'): [
        {'title': 'Intensamente', 'original_title': 'Inside Out', 'release_date': '2015-06-17'}
    ],
    ('The Movie', '2019'): [
        {'title': 'Another Film', 'original_title': 'Another Film', 'release_date': '2019-01-01'}
    ],
}


def fake_search(title, year, token, language):
    return {'results': TMDB.get((title, year), [])}


class GuessTests(unittest.TestCase):
    def test_scene_names(self):
        self.assertEqual(
            library.guess('The.Movie.2019.1080p.WEBRip.x264-GRP.mkv'), ('The Movie', '2019', '')
        )
        self.assertEqual(
            library.guess('Spider-Man.Across.the.Spider-Verse.2023.2160p.WEB-DL.mkv'),
            ('Spider-Man Across the Spider-Verse', '2023', '4K'),
        )
        self.assertEqual(library.guess('[YTS.MX] Coco (2017) [1080p].mp4'), ('Coco', '2017', ''))
        self.assertEqual(
            library.guess('www.hackstore.net - Intensamente 2015 Latino.mkv'),
            ('Intensamente', '2015', ''),
        )
        self.assertEqual(library.guess('1917.2019.1080p.mkv'), ('1917', '2019', ''))
        self.assertEqual(library.guess('Oppenheimer.2023.CAM.mp4'), ('Oppenheimer', '2023', 'CAM'))
        self.assertEqual(library.guess('Video de la boda.mp4'), ('Video de la boda', None, ''))

    def test_confirm_needs_same_year_and_similar_title(self):
        payload = {
            'results': [
                {
                    'title': 'Intensamente',
                    'original_title': 'Inside Out',
                    'release_date': '2015-06-17',
                }
            ]
        }
        self.assertEqual(library.confirm('Inside Out', '2015', payload), ('Intensamente', '2015'))
        self.assertEqual(library.confirm('intensamente', '2015', payload), ('Intensamente', '2015'))
        self.assertIsNone(library.confirm('Inside Out', '2016', payload))
        self.assertIsNone(library.confirm('Outside In Again', '2015', payload))
        self.assertEqual(
            library.safe_name('Mission: Impossible / Part 1?'), 'Mission - Impossible Part 1'
        )


class OrganizerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(__import__('shutil').rmtree, self.root)
        self.journal = self.root / 'moves.jsonl'
        self.movies = self.root / 'PELICULAS'
        self.movies.mkdir()

    def make(self, relative, age_s=3600, data=b'video'):
        path = self.movies / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        old = time.time() - age_s
        os.utime(path, (old, old))
        os.utime(path.parent, (old, old))
        return path

    def run_pass(self):
        organizer = library.Organizer(self.movies, 'token', 'es-MX', self.journal)
        with patch.object(library, 'search', side_effect=fake_search):
            organizer.run(time.time())
        return organizer

    def test_moves_confirmed_loose_video_with_subtitle(self):
        self.make('Coco.2017.1080p.WEB.mp4')
        self.make('Coco.2017.1080p.WEB.srt')
        organizer = self.run_pass()
        self.assertEqual(organizer.renamed, ['Coco (2017)'])
        self.assertTrue((self.movies / 'Coco (2017)/Coco (2017).mp4').is_file())
        self.assertTrue((self.movies / 'Coco (2017)/Coco (2017).srt').is_file())
        self.assertEqual(len(self.journal.read_text().splitlines()), 2)
        self.assertEqual(self.run_pass().renamed, [], 'a second pass changes nothing')

    def test_folder_upload_uses_tmdb_title_and_keeps_other_files(self):
        self.make('Inside.Out.2015.2160p/Inside.Out.2015.2160p.mkv')
        self.make('Inside.Out.2015.2160p/info.nfo')
        self.run_pass()
        self.assertTrue(
            (self.movies / 'Intensamente (2015)/Intensamente (2015) - 4K.mkv').is_file()
        )
        self.assertTrue((self.movies / 'Inside.Out.2015.2160p/info.nfo').is_file())

    def test_leaves_copies_in_progress_and_unconfirmed_names(self):
        self.make('Coco.2017.mp4', age_s=10)
        self.make('The.Movie.2019.mkv')
        self.make('Video de la boda.mp4')
        self.make('Coco (2018)/Coco (2018).mp4')
        organizer = self.run_pass()
        self.assertEqual(organizer.renamed, [])
        self.assertTrue((self.movies / 'Coco.2017.mp4').is_file())
        reasons = {item['name']: item['reason'] for item in organizer.review}
        self.assertEqual(set(reasons), {'The.Movie.2019.mkv', 'Video de la boda.mp4'})
        self.assertIn('no year', reasons['Video de la boda.mp4'])

    def test_never_overwrites_an_existing_movie(self):
        self.make('Coco (2017)/Coco (2017).mp4', data=b'original')
        self.make('Coco.2017.WEB.mp4', data=b'new')
        organizer = self.run_pass()
        self.assertEqual((self.movies / 'Coco (2017)/Coco (2017).mp4').read_bytes(), b'original')
        self.assertEqual(organizer.review[0]['reason'], 'This movie is already in the library.')

    def test_state_file_is_world_readable_json(self):
        state = self.root / 'library.json'
        library.write_state(state, {'at': 1, 'renamed': 0, 'covers': 0, 'review': []})
        self.assertEqual(json.loads(state.read_text())['at'], 1)
        self.assertEqual(state.stat().st_mode & 0o777, 0o644)


if __name__ == '__main__':
    unittest.main()
