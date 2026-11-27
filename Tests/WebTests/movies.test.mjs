import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMovies } from '../../.build/web-modules/contracts/storage.js';

const movie = (title, year, overrides = {}) => ({
  id: `${title} (${year})`,
  title,
  year,
  posterUrl: `/storage/poster?movie=${encodeURIComponent(`${title} (${year})`)}`,
  videoUrl: `/storage/movie-video?movie=${encodeURIComponent(`${title} (${year})`)}`,
  canPlayInline: true,
  sizeBytes: 1_500_000_000,
  addedAt: 1_800_000_000,
  ...overrides,
});
function moviesView(overrides = {}) {
  return {
    isAvailable: true,
    folder: 'PELICULAS',
    movies: [movie('Coco', 2017), movie('Up', 2009, { posterUrl: null, videoUrl: null, canPlayInline: false, sizeBytes: null, addedAt: null, year: null })],
    review: [{ name: 'coco.final.mkv', reason: 'More than one movie matches this name.', suggestion: 'Coco (2017)' }],
    lastRun: { at: 1_800_000_000, renamed: 2, covers: 3 },
    ...overrides,
  };
}

test('movies accept the server sample and keep unknown values as null', () => {
  const view = parseMovies(moviesView());
  assert.equal(view.movies[0].posterUrl, '/storage/poster?movie=Coco%20(2017)');
  assert.deepEqual(view.movies[1], { id: 'Up (2009)', title: 'Up', year: null, posterUrl: null, videoUrl: null, canPlayInline: false, sizeBytes: null, addedAt: null });
  assert.equal(view.review[0].suggestion, 'Coco (2017)');
  assert.deepEqual(parseMovies(moviesView({ isAvailable: false, movies: [], review: [], lastRun: null })).lastRun, null);
});

test('movies reject unsafe links, paths and identifiers', () => {
  for (const posterUrl of ['https://example.test/poster.jpg', '/storage/poster?movie=a&path=b', '/storage/download?path=x', '/storage/poster?movie=']) {
    assert.throws(() => parseMovies(moviesView({ movies: [movie('Coco', 2017, { posterUrl })] })), posterUrl);
  }
  for (const videoUrl of ['/storage/download?path=PELICULAS/Coco.mp4', '/storage/movie-video?movie=a&path=..', 'https://example.test/movie.mp4']) {
    assert.throws(() => parseMovies(moviesView({ movies: [movie('Coco', 2017, { videoUrl })] })), videoUrl);
  }
  assert.throws(() => parseMovies(moviesView({ movies: [movie('Coco', 2017, { id: 'a/b' })] })));
  assert.throws(() => parseMovies(moviesView({ movies: [movie('Coco', 1700)] })));
});

test('movies reject oversized lists and texts', () => {
  assert.throws(() => parseMovies(moviesView({ movies: Array.from({ length: 2001 }, (_, index) => movie(`Film ${index}`, 2000)) })));
  assert.equal(parseMovies(moviesView({ movies: Array.from({ length: 2000 }, (_, index) => movie(`Film ${index}`, 2000)) })).movies.length, 2000);
  assert.throws(() => parseMovies(moviesView({ review: Array.from({ length: 51 }, () => ({ name: 'x', reason: 'y', suggestion: null })) })));
  assert.throws(() => parseMovies(moviesView({ review: [{ name: 'x', reason: 'y'.repeat(201), suggestion: null }] })));
});
