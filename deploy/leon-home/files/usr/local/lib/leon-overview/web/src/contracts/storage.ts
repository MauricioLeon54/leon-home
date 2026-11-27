import { boolean, integer, items, nullable, nullableNumber, number, oneOf, optionalBoolean, optionalList, record, string } from '../decode.js';

/**
 * Storage tab wire contracts. overview.py's storage_view(), files_view() and automation_view()
 * must produce exactly these keys, keeping today's limits and wording (render_storage,
 * render_files, render_automation). Sizes are bytes; `null` means unknown.
 */
export type Tone = 'good' | 'warn' | 'unknown';

/** GET /api/v1/storage */
export interface StorageView {
  drive: {
    name: string; // storage.json name, volume label, or "My drive"
    isMounted: boolean;
    totalBytes: number | null;
    freeBytes: number | null;
    label: string | null;
    filesystem: string | null;
    isReadOnly: boolean | null; // host mount state; null unknown
    openUrl: string | null; // smb://<tailnet or home IPv4>/<share>
    canEject: boolean; // mounted USB disk and the root eject service is installed
  };
  peers: Array<{ name: string; url: string }>; // ≤ 4, smb:// URLs validated by PEER_URL
  connections: Array<{ platform: string; address: string; note: string }>; // ≤ 5; empty: sharing not set up
  isSharingSetUp: boolean;
  accounts: Array<{ drive: string; user: string; canWrite: boolean }>; // ≤ 8; drive is a drive name above; never a password
  tvServerName: string | null; // DLNA friendly name when minidlna is active
  folders: Array<{ name: string; path: string; status: string; tone: Tone }>; // ≤ 9
  usbDrives: { isAvailable: boolean; volumes: Array<{ name: string; detail: string; isMounted: boolean }> }; // ≤ 24
}

/** POST /api/v1/storage/password (JSON) → {status: 'shown', password} or {status, message} */
export interface StoragePasswordRequest {
  drive: string;
  user: string;
}

/** POST /api/v1/storage/eject ({}) → {status, message}; message is server English (≤ 200). */
export type EjectOutcome = 'ejected' | 'busy' | 'notMounted' | 'unavailable' | 'failed';

/** GET /api/v1/storage/files?path=<relative>&q=<search> (404 JSON {status:'unavailable'} when the folder is unavailable) */
export interface FilesView {
  path: string; // normalized relative path, '' is the drive root
  query: string; // trimmed, ≤ 80
  title: string; // folder name, "Drive", or "Search results"
  meta: string; // "First 500 items" / "Partial results; refine the search" / ''
  entries: Array<{
    name: string;
    path: string; // relative path for /storage/files (folders) or /storage/download (files)
    isDirectory: boolean;
    detail: string; // "4.0 MB · 2026-11-20", modified date, or parent folder for search hits
    sizeBytes: number | null;
    modifiedAt: number | null;
  }>; // ≤ 500 listing, ≤ 200 search
}

/** GET /api/v1/automation?status=failed */
export interface AutomationView {
  isReady: boolean; // n8n readiness
  isConnected: boolean; // API key works for workflows or executions
  editorUrl: string | null; // https://<host>.ts.net[:port]/ only (N8N_EDITOR)
  hasStoredKey: boolean; // never the key itself
  workflows: Array<{ id: string; name: string; state: 'Published' | 'Draft' | 'Unknown'; isActive: boolean | null }> | null; // ≤ 12; null unavailable
  executions: Array<{ workflowName: string; label: string; tone: Tone; startedAt: string | null }> | null; // ≤ 12; null unavailable
  failuresOnly: boolean;
}

/** POST /api/v1/automation/settings (JSON) → {status: 'saved'|'invalid'|'refused'|'forbidden', message} */
export interface AutomationSettingsRequest {
  apiKey: string; // '' keeps the stored key
  editorUrl: string; // '' clears it
}

/** GET /api/v1/movies: the drive's movie library, sorted by title on the server. */
export interface MoviesView {
  isAvailable: boolean; // false when the drive or the movie folder is not mounted
  folder: string; // library folder name on the drive, e.g. "PELICULAS"
  movies: Array<{
    id: string; // movie folder name, "Coco (2017)"; never contains '/'
    title: string;
    year: number | null;
    posterUrl: string | null; // /storage/poster?movie=<encoded id> (342×513 JPEG)
    videoUrl: string | null; // /storage/movie-video?movie=<encoded id>; the server picks inline or attachment
    canPlayInline: boolean; // mp4/m4v/mov play in Safari; anything else downloads
    sizeBytes: number | null;
    addedAt: number | null; // unix seconds
  }>; // ≤ 2000
  review: Array<{ name: string; reason: string; suggestion: string | null }>; // ≤ 50 uploads the organizer could not name; reason is server wording
  lastRun: { at: number; renamed: number; covers: number } | null; // last automatic organizer pass
}
export type Movie = MoviesView['movies'][number];

// Parsing: unknown in, typed view out. Lists are bounded, URLs and paths are pattern-checked, sizes stay null when unknown.
const SMB_URL = /^smb:\/\/[A-Za-z0-9.-]{1,253}(\/[A-Za-z0-9 _.-]{1,80})?$/;
export const EDITOR_URL = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:[0-9]{1,5})?\/?$/;
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TONES: ReadonlyArray<Tone> = ['good', 'warn', 'unknown'];
const MAX_BYTES = 2 ** 60;
const MAX_UNIX = 4_102_444_800;
const POSTER_URL = /^\/storage\/poster\?movie=[^&#]{1,800}$/;
const MOVIE_ID = /^[^/]{1,255}$/;
const VIDEO_URL = /^\/storage\/movie-video\?movie=[^&#]{1,800}$/;

function matching(value: unknown, pattern: RegExp, maximum: number): string {
  const text = string(value, maximum);
  if (!pattern.test(text)) throw new Error('Invalid value');
  return text;
}
function relativePath(value: unknown): string {
  const text = string(value, 1024);
  if (text.split('/').includes('..')) throw new Error('Invalid path');
  return text;
}

export function parseStorage(value: unknown): StorageView {
  const root = record(value),
    drive = record(root.drive),
    usb = record(root.usbDrives);
  return {
    drive: {
      name: string(drive.name, 120),
      isMounted: boolean(drive.isMounted),
      totalBytes: nullableNumber(drive.totalBytes, 0, MAX_BYTES),
      freeBytes: nullableNumber(drive.freeBytes, 0, MAX_BYTES),
      label: nullable(drive.label, item => string(item, 120)),
      filesystem: nullable(drive.filesystem, item => string(item, 40)),
      isReadOnly: optionalBoolean(drive.isReadOnly),
      openUrl: nullable(drive.openUrl, item => matching(item, SMB_URL, 400)),
      canEject: boolean(drive.canEject),
    },
    peers: items(root.peers, 4, item => {
      const peer = record(item);
      return { name: string(peer.name, 120), url: matching(peer.url, SMB_URL, 400) };
    }),
    connections: items(root.connections, 5, item => {
      const connection = record(item);
      return { platform: string(connection.platform, 60), address: string(connection.address, 400), note: string(connection.note, 100) };
    }),
    isSharingSetUp: boolean(root.isSharingSetUp),
    accounts: optionalList(root.accounts, 8).map(item => {
      const account = record(item);
      return { drive: string(account.drive, 40), user: string(account.user, 32), canWrite: boolean(account.canWrite) };
    }),
    tvServerName: nullable(root.tvServerName, item => string(item, 120)),
    folders: items(root.folders, 9, item => {
      const folder = record(item);
      return { name: string(folder.name, 120), path: string(folder.path, 400), status: string(folder.status, 100), tone: oneOf(folder.tone, TONES) };
    }),
    usbDrives: {
      isAvailable: boolean(usb.isAvailable),
      volumes: items(usb.volumes, 24, item => {
        const volume = record(item);
        return { name: string(volume.name, 120), detail: string(volume.detail, 300), isMounted: boolean(volume.isMounted) };
      }),
    },
  };
}

export function parseFiles(value: unknown): FilesView {
  const root = record(value),
    query = string(root.query, 80);
  return {
    path: relativePath(root.path),
    query,
    title: string(root.title, 255),
    meta: string(root.meta, 100),
    entries: items(root.entries, query === '' ? 500 : 200, item => {
      const entry = record(item);
      return {
        name: string(entry.name, 255),
        path: relativePath(entry.path),
        isDirectory: boolean(entry.isDirectory),
        detail: string(entry.detail, 1100),
        sizeBytes: nullableNumber(entry.sizeBytes, 0, MAX_BYTES),
        modifiedAt: nullableNumber(entry.modifiedAt, 0, MAX_UNIX),
      };
    }),
  };
}

export function parseAutomation(value: unknown): AutomationView {
  const root = record(value);
  return {
    isReady: boolean(root.isReady),
    isConnected: boolean(root.isConnected),
    editorUrl: nullable(root.editorUrl, item => matching(item, EDITOR_URL, 300)),
    hasStoredKey: boolean(root.hasStoredKey),
    workflows: nullable(root.workflows, list =>
      items(list, 12, item => {
        const workflow = record(item);
        return {
          id: matching(workflow.id, WORKFLOW_ID, 80),
          name: string(workflow.name, 120),
          state: oneOf(workflow.state, ['Published', 'Draft', 'Unknown']),
          isActive: optionalBoolean(workflow.isActive),
        };
      })
    ),
    executions: nullable(root.executions, list =>
      items(list, 12, item => {
        const execution = record(item);
        return {
          workflowName: string(execution.workflowName, 120),
          label: string(execution.label, 40),
          tone: oneOf(execution.tone, TONES),
          startedAt: nullable(execution.startedAt, text => string(text, 40)),
        };
      })
    ),
    failuresOnly: boolean(root.failuresOnly),
  };
}

export function parseMovies(value: unknown): MoviesView {
  const root = record(value);
  return {
    isAvailable: boolean(root.isAvailable),
    folder: string(root.folder, 120),
    movies: items(root.movies, 2000, item => {
      const movie = record(item);
      return {
        id: matching(movie.id, MOVIE_ID, 255),
        title: string(movie.title, 255),
        year: nullable(movie.year, year => integer(year, 1888, 2100)),
        posterUrl: nullable(movie.posterUrl, url => matching(url, POSTER_URL, 820)),
        videoUrl: nullable(movie.videoUrl, url => matching(url, VIDEO_URL, 830)),
        canPlayInline: boolean(movie.canPlayInline),
        sizeBytes: nullableNumber(movie.sizeBytes, 0, MAX_BYTES),
        addedAt: nullableNumber(movie.addedAt, 0, MAX_UNIX),
      };
    }),
    review: items(root.review, 50, item => {
      const entry = record(item);
      return { name: string(entry.name, 255), reason: string(entry.reason, 200), suggestion: nullable(entry.suggestion, text => string(text, 255)) };
    }),
    lastRun: nullable(root.lastRun, item => {
      const run = record(item);
      return { at: number(run.at, 0, MAX_UNIX), renamed: integer(run.renamed, 0, 100_000), covers: integer(run.covers, 0, 100_000) };
    }),
  };
}
