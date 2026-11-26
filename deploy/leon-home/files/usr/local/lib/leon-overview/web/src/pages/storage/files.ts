import { readGetJson, ReadStatusError } from '../../api.js';
import { type FilesView, parseFiles } from '../../contracts/storage.js';
import { h } from '../../core/dom.js';
import type { PageView, RouteContext } from '../../core/router.js';
import { serverText, t } from '../../i18n/index.js';
import { emptyState } from '../../ui/empty.js';
import { list, type ListRow } from '../../ui/list.js';
import { section } from '../../ui/section.js';
import { skeleton } from '../../ui/skeleton.js';

const SEARCH_DEBOUNCE_MS = 300;
const MAX_QUERY = 80;

const GLYPHS = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  audio: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9a1 1 0 1 1 0 .01',
  pdf: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h7M9 17h7',
  other: 'M6 3h8l5 5v13H6zM14 3v5h5',
} as const;
type FileClass = Exclude<keyof typeof GLYPHS, 'folder'>;

const EXTENSION_CLASSES: Readonly<Record<string, FileClass>> = {
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  webm: 'video',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  heic: 'image',
  webp: 'image',
  pdf: 'pdf',
};
export function fileClass(name: string): FileClass {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? EXTENSION_CLASSES[name.slice(dot + 1).toLowerCase()] : undefined) ?? 'other';
}

// Back must repaint a folder at once so the router can restore its scroll position; the load that follows refreshes it.
const CACHE_LIMIT = 20;
const viewCache = new Map<string, FilesView>();
function remember(key: string, view: FilesView): void {
  viewCache.delete(key);
  viewCache.set(key, view);
  for (const oldest of viewCache.keys()) {
    if (viewCache.size <= CACHE_LIMIT) break;
    viewCache.delete(oldest);
  }
}

function filesUrl(path: string, query: string): string {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (query) params.set('q', query);
  const text = params.toString();
  return text ? `/storage/files?${text}` : '/storage/files';
}

/** 'unavailable' is the server's 404 answer for a missing folder or an unmounted drive. */
async function loadFiles(path: string, query: string, signal: AbortSignal): Promise<FilesView | 'unavailable'> {
  try {
    return parseFiles(await readGetJson(`/leon/v1/storage/files?${new URLSearchParams({ path, q: query })}`, signal));
  } catch (error: unknown) {
    if (error instanceof ReadStatusError && error.status === 404) return 'unavailable';
    throw error;
  }
}

function entryRow(entry: FilesView['entries'][number]): ListRow {
  return entry.isDirectory
    ? { kind: 'navigation', title: entry.name, detail: entry.detail === 'Top folder' ? t('Top folder') : entry.detail, href: filesUrl(entry.path, ''), leading: { kind: 'icon', path: GLYPHS.folder } }
    : {
        kind: 'link',
        title: entry.name,
        detail: entry.detail === 'Top folder' ? t('Top folder') : entry.detail,
        href: `/storage/download?path=${encodeURIComponent(entry.path)}`,
        leading: { kind: 'icon', path: GLYPHS[fileClass(entry.name)] },
      };
}

export function renderFiles(context: RouteContext): PageView {
  const path = context.query.get('path') ?? '',
    lastSegment = path.split('/').pop() ?? '',
    folderName = lastSegment === '' ? t('Drive') : lastSegment;
  let query = (context.query.get('q') ?? '').trim().slice(0, MAX_QUERY),
    pending: AbortController | null = null,
    pendingKey = '',
    timer: ReturnType<typeof setTimeout> | undefined;

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    search();
  }
  const results = h('div', { className: 'files-results' }, [skeleton(3)]),
    input = h('input', {
      className: 'field',
      attrs: {
        'type': 'search',
        'name': 'q',
        'maxlength': String(MAX_QUERY),
        'placeholder': t('Search this folder'),
        'aria-label': t('Search this folder'),
        'enterkeyhint': 'search',
        'autocomplete': 'off',
      },
    }),
    form = h('form', { className: 'files-search', attrs: { role: 'search' }, on: { submit: onSubmit } }, [input]),
    refresh = h('button', { className: 'link-button', text: t('Refresh'), attrs: { type: 'button' }, on: { click: () => void load() } });
  input.value = query;

  context.setTitle(folderName);
  context.setTrailing(refresh);

  function cacheKey(): string {
    return `${path}\0${query}`;
  }
  function search(): void {
    clearTimeout(timer);
    const next = input.value.trim().slice(0, MAX_QUERY);
    if (next === query) return;
    query = next;
    history.replaceState(history.state, '', filesUrl(path, query));
    void load();
  }

  async function load(): Promise<void> {
    if (document.hidden || (pending !== null && !pending.signal.aborted && pendingKey === cacheKey())) return;
    pending?.abort();
    const current = new AbortController();
    pending = current;
    pendingKey = cacheKey();
    try {
      const view = await loadFiles(path, query, AbortSignal.any([context.signal, current.signal]));
      if (current.signal.aborted) return;
      if (view !== 'unavailable') remember(cacheKey(), view);
      results.replaceChildren(...(view === 'unavailable' ? unavailable() : show(view)));
    } catch {
      if (current.signal.aborted || context.signal.aborted) return;
      results.replaceChildren(emptyState({ title: t('LEÓN Home is not answering'), detail: t('Check that this phone is connected to Tailscale, then tap Refresh.') }));
    } finally {
      if (pending === current) pending = null;
    }
  }
  function unavailable(): Array<Node> {
    form.hidden = true;
    return [emptyState({ title: t('Folder unavailable or drive not mounted') })];
  }
  function show(view: FilesView): Array<Node> {
    form.hidden = false;
    const title = view.query ? { title: serverText(view.title) } : {},
      meta = view.meta ? { meta: serverText(view.meta) } : {};
    return [section({ ...title, ...meta }, [view.entries.length ? list(view.entries.map(entryRow)) : emptyState({ title: view.query ? t('No matching names') : t('Empty folder') })])];
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, SEARCH_DEBOUNCE_MS);
  });
  function onVisibility(): void {
    if (document.hidden) {
      clearTimeout(timer);
      pending?.abort();
    } else if (input.value.trim().slice(0, MAX_QUERY) !== query)
      search(); // keep a query typed just before hiding
    else void load();
  }
  document.addEventListener('visibilitychange', onVisibility);
  const cached = viewCache.get(cacheKey());
  if (cached) results.replaceChildren(...show(cached));
  void load();
  return {
    element: h('div', { className: 'page' }, [form, results]),
    dispose() {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      pending?.abort();
    },
  };
}
