import { readGetJson } from '../../api.js';
import { type Movie, type MoviesView, parseMovies } from '../../contracts/storage.js';
import { append, type Child, h } from '../../core/dom.js';
import { ago, bytes } from '../../core/format.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { emptyState } from '../../ui/empty.js';
import { section } from '../../ui/section.js';
import { openSheet, type Sheet } from '../../ui/sheet.js';
import { skeleton } from '../../ui/skeleton.js';
import { linkButton } from './linkButton.js';

const SEARCH_DEBOUNCE_MS = 300;
const MAX_QUERY = 80;
const FEATURED_COUNT = 12;
// 2000 movies with long names and paths stay well under this; the default 1 MiB does not.
const MAX_RESPONSE_BYTES = 4 * 1_048_576;

function movieLabel(movie: Movie): string {
  return movie.year === null ? movie.title : `${movie.title} (${movie.year})`;
}
/** Case- and accent-insensitive, so "pelicula" finds "Película". */
function searchKey(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function placeholder(movie: Movie): HTMLElement {
  return h('div', { className: 'poster-placeholder', attrs: { 'aria-hidden': 'true' } }, [
    h('span', { className: 'poster-placeholder-title', text: movie.title }),
    movie.year === null ? null : h('span', { className: 'poster-placeholder-year', text: String(movie.year) }),
  ]);
}
/** A fixed 2:3 box: the poster when there is one, else (or when it fails to load) a titled placeholder. */
function poster(movie: Movie, isEager = false): HTMLElement {
  if (movie.posterUrl === null) return h('div', { className: 'poster' }, [placeholder(movie)]);
  const image = h('img', { attrs: { src: movie.posterUrl, alt: '', loading: isEager ? 'eager' : 'lazy', decoding: 'async', width: '342', height: '513' } });
  image.addEventListener('error', () => image.replaceWith(placeholder(movie)), { once: true });
  return h('div', { className: 'poster' }, [image]);
}

function openDetail(movie: Movie): Sheet {
  const facts = [movie.year === null ? null : String(movie.year), movie.sizeBytes === null ? null : bytes(movie.sizeBytes)].filter(Boolean).join(' · ');
  let action: Array<Child>;
  if (movie.videoUrl === null) action = [h('p', { className: 'note', text: t('No video file in this folder yet.') })];
  else if (movie.canPlayInline) action = [h('div', { className: 'buttons' }, [linkButton(t('Play'), movie.videoUrl, 'primary')])];
  else
    action = [
      h('div', { className: 'buttons' }, [linkButton(t('Download movie'), movie.videoUrl, 'primary')]),
      h('p', { className: 'note', text: t('This format does not play in the browser. Open the download in VLC or a similar app.') }),
    ];
  return openSheet({
    title: movie.title,
    content: [h('div', { className: 'movie-detail' }, [poster(movie, true), facts ? h('p', { className: 'movie-detail-facts', text: facts }) : null, ...action])],
  });
}

/** Swipeable row of the newest movies; CSS scroll-snap does the gesture, this only tracks the centred poster. */
function featured(movies: ReadonlyArray<Movie>, onSelect: (movie: Movie) => void): HTMLElement {
  const slides = movies.map(movie =>
      h('li', { className: 'movie-slide' }, [
        h('button', { className: 'movie-button', attrs: { 'type': 'button', 'aria-label': movieLabel(movie) }, on: { click: () => onSelect(movie) } }, [poster(movie, true)]),
      ])
    ),
    rail = h('ul', { className: 'movie-rail', attrs: { 'aria-label': t('Recently added') } }, slides),
    title = h('p', { className: 'movie-rail-title' }),
    year = h('span', { className: 'movie-rail-year' }),
    counter = h('span', { className: 'movie-rail-counter' });
  let active = -1,
    frame = 0;
  function select(index: number): void {
    const movie = movies[index];
    if (index === active || movie === undefined) return;
    slides[active]?.classList.remove('is-active');
    slides[index]?.classList.add('is-active');
    active = index;
    title.textContent = movie.title;
    year.textContent = movie.year === null ? '' : String(movie.year);
    counter.textContent = `${index + 1} / ${movies.length}`;
  }
  function track(): void {
    frame = 0;
    const [first, second] = slides,
      stride = first && second ? second.offsetLeft - first.offsetLeft : 0;
    if (stride > 0) select(Math.min(slides.length - 1, Math.max(0, Math.round(rail.scrollLeft / stride))));
  }
  rail.addEventListener(
    'scroll',
    () => {
      if (frame === 0) frame = requestAnimationFrame(track);
    },
    { passive: true }
  );
  select(0);
  return h('div', { className: 'movie-featured' }, [rail, h('div', { className: 'movie-rail-caption' }, [h('div', { className: 'movie-rail-name' }, [title, year]), counter])]);
}

interface Grid {
  element: HTMLElement;
  /** Shows only the titles that contain the query; returns how many are shown. */
  filter(query: string): number;
}
/** Every card is built once into one fragment; search only toggles `hidden`, so images never reload. */
function grid(movies: ReadonlyArray<Movie>, onSelect: (movie: Movie) => void): Grid {
  const fragment = document.createDocumentFragment(),
    cards = movies.map(movie => {
      const card = h('li', { className: 'movie-card' }, [
        h('button', { className: 'movie-button', attrs: { 'type': 'button', 'aria-label': movieLabel(movie) }, on: { click: () => onSelect(movie) } }, [
          poster(movie),
          h('span', { className: 'movie-card-title', text: movie.title }),
          movie.year === null ? null : h('span', { className: 'movie-card-year', text: String(movie.year) }),
        ]),
      ]);
      fragment.append(card);
      return { card, key: searchKey(movie.title) };
    }),
    element = h('ul', { className: 'movie-grid' });
  element.append(fragment);
  return {
    element,
    filter(query) {
      const needle = searchKey(query);
      let shown = 0;
      for (const { card, key } of cards) {
        const isShown = key.includes(needle);
        card.hidden = !isShown;
        if (isShown) shown++;
      }
      return shown;
    },
  };
}

function reviewSection(review: MoviesView['review']): HTMLElement {
  return section({ title: t('Need a name'), meta: String(review.length) }, [
    h(
      'ul',
      { className: 'list' },
      review.map(entry =>
        h('li', { className: 'list-item' }, [
          h('div', { className: 'row' }, [
            h('span', { className: 'row-body' }, [
              h('span', { className: 'row-title movie-review-name', text: entry.name }),
              h('span', { className: 'row-detail', text: serverText(entry.reason) }),
              entry.suggestion === null ? null : h('span', { className: 'row-detail', text: t('Suggested: {0}', entry.suggestion) }),
            ]),
          ]),
        ])
      )
    ),
    h('p', { className: 'note', text: t('LEÓN renames uploads automatically when it is sure of the movie. These need a person to name them.') }),
  ]);
}

function lastRunLine(lastRun: NonNullable<MoviesView['lastRun']>): HTMLElement {
  return h('p', { className: 'movie-meta', text: t('Organized automatically · {0} renamed, {1} covers · {2}', lastRun.renamed, lastRun.covers, ago(lastRun.at)) });
}

function newestFirst(movies: ReadonlyArray<Movie>): Array<Movie> {
  return [...movies].sort((left, right) => (right.addedAt ?? 0) - (left.addedAt ?? 0)).slice(0, FEATURED_COUNT);
}

export function renderMovies(context: RouteContext): PageView {
  let pending: AbortController | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    sheet: Sheet | null = null,
    current: Grid | null = null,
    hasAnswer = false;

  const body = h('div', { className: 'movies' }, [skeleton(3)]),
    count = h('p', { className: 'movie-count', attrs: { 'role': 'status', 'aria-live': 'polite' } }),
    noMatch = emptyState({ title: t('No matching movies') }),
    input = h('input', {
      className: 'field',
      attrs: {
        'type': 'search',
        'name': 'q',
        'maxlength': String(MAX_QUERY),
        'placeholder': t('Search movies'),
        'aria-label': t('Search movies'),
        'enterkeyhint': 'search',
        'autocomplete': 'off',
      },
    }),
    form = h('form', { className: 'files-search', attrs: { role: 'search' }, on: { submit: event => event.preventDefault() } }, [input]),
    refresh = h('button', { className: 'link-button', text: t('Refresh'), attrs: { type: 'button' }, on: { click: () => void load() } });
  context.setTrailing(refresh);

  function select(movie: Movie): void {
    sheet = openDetail(movie);
  }
  function applySearch(): void {
    clearTimeout(timer);
    if (current === null) return;
    const query = input.value.trim().slice(0, MAX_QUERY),
      shown = current.filter(query);
    noMatch.hidden = shown > 0;
    count.textContent = query === '' ? t('{0} movies', shown) : t('{0} of {1} movies', shown, current.element.childElementCount);
  }

  async function load(): Promise<void> {
    if (document.hidden) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    try {
      const view = parseMovies(await readGetJson('/leon/v1/movies', AbortSignal.any([context.signal, controller.signal]), MAX_RESPONSE_BYTES));
      if (controller.signal.aborted) return;
      body.replaceChildren();
      append(body, show(view));
      hasAnswer = true;
      applySearch();
    } catch {
      if (controller.signal.aborted || context.signal.aborted) return;
      current = null;
      hasAnswer = true;
      body.replaceChildren(emptyState({ title: t('LEÓN Home is not answering'), detail: t('Check that this phone is connected to Tailscale, then tap Refresh.') }));
    } finally {
      if (pending === controller) pending = null;
    }
  }
  function show(view: MoviesView): Array<Child> {
    current = null;
    if (!view.isAvailable) return [emptyState({ title: t('Drive not connected'), detail: t('Connect the drive to LEÓN Home to see your movies.') })];
    const review = view.review.length ? reviewSection(view.review) : null,
      meta = view.lastRun === null ? null : lastRunLine(view.lastRun);
    if (view.movies.length === 0) return [emptyState({ title: t('No movies yet'), detail: t('Add one folder per movie to {0} on the drive.', view.folder) }), meta, review];
    current = grid(view.movies, select);
    return [featured(newestFirst(view.movies), select), meta, section({ title: t('All movies') }, [form, count, current.element, noMatch]), review];
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
  });
  function onVisibility(): void {
    // A read cut short by hiding the page is retried; a shown library waits for Refresh (no polling).
    if (document.hidden) pending?.abort();
    else if (!hasAnswer) void load();
  }
  document.addEventListener('visibilitychange', onVisibility);
  void load();
  return {
    element: h('div', { className: 'page' }, [body]),
    dispose() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      pending?.abort();
      sheet?.close();
    },
  };
}
