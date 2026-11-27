#!/usr/bin/env python3
"""Keep a household movie folder tidy: name new uploads and add posters.

One pass, safe to repeat:
1. Organize. A video or folder at the top of the library whose name is not `Title (Year)`
   (for example `The.Movie.2019.1080p.WEBRip.x264-GRP.mkv`) is parsed and checked against TMDB.
   When TMDB confirms title and year, the video and its subtitles move to
   `Title (Year)/Title (Year)[ - 4K|CAM].ext`; otherwise the upload is listed for a person
   to name. Nothing is deleted, and every move is journaled.
2. Covers. Each `Title (Year)` folder without folder.jpg gets the TMDB poster.

Uploads changed in the last few minutes are left for a later pass, so a copy in progress is
never moved. Reads a TMDB API Read Access Token from $CREDENTIALS_DIRECTORY/tmdb-token
(systemd LoadCredential) or --token-file and never prints it. --state writes a JSON summary
for the LEÓN Home panel.
"""

import argparse
import difflib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

MOVIE_FOLDER = re.compile(r'(?P<title>.+?) \((?P<year>(19|20)\d{2})\)')
COVER_NAME = 'folder.jpg'
SEARCH_URL = 'https://api.themoviedb.org/3/search/movie'
POSTER_URL = 'https://image.tmdb.org/t/p/w342'
POSTER_PATH = re.compile(r'/[A-Za-z0-9]{8,64}\.(jpg|png)')
TIMEOUT_S = 15
MAX_JSON_BYTES = 1_000_000
MAX_POSTER_BYTES = 2_000_000
REQUEST_PAUSE_S = 0.1  # TMDB allows ~40 requests/s; stay far below.
VIDEO_EXTENSIONS = frozenset(
    {'mp4', 'm4v', 'mov', 'mkv', 'avi', 'webm', 'ts', 'wmv', 'mpg', 'mpeg'}
)
SUBTITLE_EXTENSIONS = frozenset({'srt', 'sub', 'ass', 'ssa', 'vtt'})
SETTLE_S = 15 * 60  # a copy in progress keeps changing modification times
SAMPLE_MAX_BYTES = 80_000_000
MAX_ENTRIES = 5000
MAX_REVIEW = 50
TITLE_MATCH = 0.8
# Release noise that ends a title in scene-style names.
NOISE = re.compile(
    r'\b(2160p|1080p|720p|480p|4k|uhd|hdr|web-?dl|web-?rip|webrip|bluray|blu-ray|brrip|bdrip|dvdrip|'
    r'hdrip|hdtv|x264|x265|h264|h265|hevc|aac|ac3|dts|remux|proper|repack|extended|unrated|'
    r'latino|castellano|spanish|español|dual|multi|subbed|cam|hdcam|ts|telesync)\b',
    re.IGNORECASE,
)
YEAR = re.compile(r'(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)')
FORBIDDEN = re.compile(r'[\\/:*?"<>|\x00-\x1f]')  # not allowed on exFAT/Windows


def parse_folder(name):
    """Return (title, year) for `Title (Year)` folder names, else None."""
    match = MOVIE_FOLDER.fullmatch(name)
    return (match['title'], match['year']) if match else None


def guess(name):
    """(title, year, tag) from an upload name such as `The.Movie.2019.2160p.WEB.mkv`; year may be None."""
    stem = re.sub(r'\.[A-Za-z0-9]{2,4}$', '', name)
    text = re.sub(r'\[[^\]]*\]|\{[^}]*\}', ' ', stem)  # [group] and {site} labels
    text = re.sub(
        r'^\s*(www\.)?[a-z0-9-]+\.(com|net|org|to|mx)\s*-\s*', ' ', text, flags=re.IGNORECASE
    )
    text = re.sub(r'[._]+', ' ', text)
    years = [match for match in YEAR.finditer(text) if match.start() > 0]
    year = years[-1] if years else None
    noise = NOISE.search(text)
    # With a year, everything before it is the title; noise words such as "Dual" can be real titles.
    cut = year.start() if year else (noise.start() if noise else len(text))
    title = re.sub(r'[\s(\[\-\u2013]+$', '', text[:cut]).strip(' -\u2013')
    title = re.sub(r'\s{2,}', ' ', title)
    # Release labels come after the year, so a title such as "Cat Cam" is not a cinema recording.
    labels = text[year.end() :] if year else text[cut:]
    tag = ''
    if re.search(r'\b(2160p|4k|uhd)\b', labels, re.IGNORECASE):
        tag = '4K'
    elif re.search(r'\b(cam|hdcam|telesync)\b', labels, re.IGNORECASE):
        tag = 'CAM'
    return title, (year.group(1) if year else None), tag


def comparable(text):
    folded = unicodedata.normalize('NFKD', text.casefold())
    return re.sub(
        r'[^a-z0-9]',
        '',
        ''.join(character for character in folded if not unicodedata.combining(character)),
    )


def confirm(title, year, payload):
    """The TMDB result that matches the guessed title and year, as (title, year), else None."""
    results = payload.get('results') if isinstance(payload, dict) else None
    if not isinstance(results, list) or not title:
        return None
    wanted = comparable(title)
    for result in results[:5]:
        if not isinstance(result, dict):
            continue
        released = str(result.get('release_date') or '')[:4]
        if released != year:
            continue
        names = [result.get(key) for key in ('title', 'original_title')]
        if any(
            isinstance(name, str)
            and difflib.SequenceMatcher(None, wanted, comparable(name)).ratio() >= TITLE_MATCH
            for name in names
        ):
            canonical = result.get('title') or result.get('original_title')
            return safe_name(canonical), released
    return None


def safe_name(title):
    # "Up: Una aventura de altura" → "Up - Una aventura de altura"; ':' is not allowed on exFAT.
    name = re.sub(r'\s*:\s*', ' - ', title)
    name = re.sub(r'\s{2,}', ' ', FORBIDDEN.sub(' ', name)).strip(' .-')
    return name[:120]


def pick_poster_path(payload):
    """First result's poster path from a TMDB search response, validated, else None."""
    results = payload.get('results') if isinstance(payload, dict) else None
    if not isinstance(results, list):
        return None
    for result in results[:3]:
        path = result.get('poster_path') if isinstance(result, dict) else None
        if isinstance(path, str) and POSTER_PATH.fullmatch(path):
            return path
    return None


def is_image(data):
    return data.startswith((b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n'))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def fetch(url, limit, token=None):
    """GET a fixed HTTPS TMDB URL without redirects; the token goes only to the API host."""
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    request = urllib.request.Request(url, headers=headers)  # noqa: S310 - fixed https origins above
    with OPENER.open(request, timeout=TIMEOUT_S) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('response too large')
    return data


def search(title, year, token, language):
    query = urllib.parse.urlencode(
        {'query': title, 'year': year, 'language': language, 'include_adult': 'false'}
    )
    payload = json.loads(fetch(f'{SEARCH_URL}?{query}', MAX_JSON_BYTES, token))
    time.sleep(REQUEST_PAUSE_S)
    return payload


def extension(path):
    return path.suffix[1:].lower()


def videos_in(entry):
    if entry.is_file():
        return [entry] if extension(entry) in VIDEO_EXTENSIONS else []
    found = [
        path
        for path in entry.iterdir()
        if path.is_file() and extension(path) in VIDEO_EXTENSIONS and not path.name.startswith('.')
    ]
    return [
        path
        for path in found
        if not ('sample' in path.name.casefold() and path.stat().st_size < SAMPLE_MAX_BYTES)
    ]


def is_settled(entry, now):
    paths = [entry] + (list(entry.iterdir()) if entry.is_dir() else [])
    return all(now - path.stat().st_mtime >= SETTLE_S for path in paths)


class Organizer:
    def __init__(self, library, token, language, journal, *, dry_run=False):
        self.library, self.token, self.language, self.journal = library, token, language, journal
        self.dry_run = dry_run
        self.renamed, self.review = [], []

    def note(self, name, reason, suggestion=None):
        if len(self.review) < MAX_REVIEW:
            self.review.append({'name': name, 'reason': reason, 'suggestion': suggestion})

    def run(self, now):
        entries = sorted(path for path in self.library.iterdir() if not path.name.startswith('.'))[
            :MAX_ENTRIES
        ]
        for entry in entries:
            if entry.is_dir() and parse_folder(entry.name):
                continue
            if entry.is_symlink() or not (entry.is_dir() or extension(entry) in VIDEO_EXTENSIONS):
                continue
            videos = videos_in(entry)
            if not videos:
                continue
            if not is_settled(entry, now):
                continue
            self.organize(entry, videos)

    def organize(self, entry, videos):
        if len(videos) > 1:
            return self.note(entry.name, 'Several videos in one upload; name them one by one.')
        video = videos[0]
        title, year, tag = guess(entry.name if entry.is_dir() else video.name)
        if not year and entry.is_dir():
            title, year, tag = guess(video.name)
        if not year:
            return self.note(entry.name, 'The name has no year.')
        if not self.token:
            return self.note(
                entry.name,
                'TMDB is not set up, so the title cannot be confirmed.',
                f'{title} ({year})',
            )
        try:
            match = confirm(title, year, search(title, year, self.token, self.language))
        except (OSError, ValueError) as error:
            print(f'organize lookup failed: {entry.name}: {type(error).__name__}', file=sys.stderr)
            return None  # transient; try again next pass
        if not match:
            return self.note(
                entry.name, 'TMDB has no movie with this title and year.', f'{title} ({year})'
            )
        name = f'{match[0]} ({match[1]})'
        folder = self.library / name
        base = f'{name} - {tag}' if tag else name
        target = folder / f'{base}.{extension(video)}'
        if target.exists():
            return self.note(entry.name, 'This movie is already in the library.', name)
        if self.dry_run:
            self.renamed.append(f'{entry.name} -> {target.relative_to(self.library)}')
            return None
        self.move(entry, video, folder, base, target)
        return None

    def move(self, entry, video, folder, base, target):
        folder.mkdir(exist_ok=True)
        moves = [(video, target)]
        subtitles = (
            [
                path
                for path in video.parent.iterdir()
                if path.is_file() and extension(path) in SUBTITLE_EXTENSIONS
            ]
            if entry.is_dir()
            else [
                path
                for path in self.library.iterdir()
                if path.is_file()
                and extension(path) in SUBTITLE_EXTENSIONS
                and path.stem.startswith(video.stem)
            ]
        )
        for index, subtitle in enumerate(sorted(subtitles)):
            suffix = '' if index == 0 else f'.{index + 1}'
            destination = folder / f'{base}{suffix}.{extension(subtitle)}'
            if not destination.exists():
                moves.append((subtitle, destination))
        for source, destination in moves:
            os.rename(source, destination)  # same volume; never copies or overwrites
            self.log(source, destination)
        if entry.is_dir() and not any(entry.iterdir()):
            entry.rmdir()
        self.renamed.append(folder.name)

    def log(self, source, destination):
        if self.journal:
            with self.journal.open('a', encoding='utf-8') as handle:
                handle.write(
                    json.dumps(
                        {'at': int(time.time()), 'from': str(source), 'to': str(destination)},
                        ensure_ascii=False,
                    )
                    + '\n'
                )


def add_covers(library, token, language, limit):
    added, unmatched, failed = 0, [], 0
    for folder in sorted(
        path for path in library.iterdir() if path.is_dir() and not path.name.startswith('.')
    ):
        if added >= limit:
            break
        if (folder / COVER_NAME).exists():
            continue
        parsed = parse_folder(folder.name)
        if not parsed:
            continue
        try:
            poster = pick_poster_path(search(*parsed, token, language))
            if not poster and ' - ' in parsed[0]:
                # "Saga - Subtitle (Year)": the saga name and year usually find the one movie.
                saga = parsed[0].split(' - ', 1)[0]
                poster = pick_poster_path(search(saga, parsed[1], token, language))
            if not poster:
                unmatched.append(folder.name)
                continue
            data = fetch(POSTER_URL + poster, MAX_POSTER_BYTES)
            if not is_image(data):
                raise ValueError('not an image')
            temporary = folder / f'.{COVER_NAME}.part'
            temporary.write_bytes(data)
            os.replace(temporary, folder / COVER_NAME)
            added += 1
        except (
            OSError,
            ValueError,
        ) as error:  # URLError/HTTPError are OSError; JSON errors are ValueError.
            failed += 1
            print(f'cover failed: {folder.name}: {type(error).__name__}: {error}', file=sys.stderr)
    for name in unmatched:
        print(f'no cover found: {name}')
    return added, failed


def read_token(path):
    token = Path(path).read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'[A-Za-z0-9._-]{20,1000}', token):
        sys.exit('TMDB token file is empty or malformed.')
    return token


def write_state(path, state):
    temporary = path.with_name(f'.{path.name}.part')
    temporary.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('library', type=Path, help='folder that holds one folder per movie')
    parser.add_argument('--token-file', help='default: $CREDENTIALS_DIRECTORY/tmdb-token')
    parser.add_argument('--language', default='es-MX')
    parser.add_argument(
        '--limit', type=int, default=500, help='maximum posters to download this run'
    )
    parser.add_argument('--no-organize', action='store_true', help='only add posters')
    parser.add_argument(
        '--dry-run', action='store_true', help='print planned names; change nothing'
    )
    parser.add_argument(
        '--state', type=Path, help='JSON summary for the panel; the journal of moves sits beside it'
    )
    parser.add_argument('--changed-flag', type=Path, help='file to create when the library changed')
    args = parser.parse_args()

    credentials = os.environ.get('CREDENTIALS_DIRECTORY')
    token_file = args.token_file or (credentials and os.path.join(credentials, 'tmdb-token'))
    if not token_file:
        sys.exit('No TMDB token: pass --token-file or run under systemd LoadCredential.')
    token = read_token(token_file)
    if not args.library.is_dir():
        sys.exit(f'{args.library} is not a folder (is the drive mounted?).')

    journal = args.state.with_name('moves.jsonl') if args.state else None
    organizer = Organizer(args.library, token, args.language, journal, dry_run=args.dry_run)
    if not args.no_organize:
        organizer.run(time.time())
    if args.dry_run:
        for line in organizer.renamed:
            print(f'would organize: {line}')
        for item in organizer.review:
            print(f'needs a name: {item["name"]}: {item["reason"]} {item["suggestion"] or ""}')
        return 0
    added, failed = add_covers(args.library, token, args.language, args.limit)

    for name in organizer.renamed:
        print(f'organized: {name}')
    for item in organizer.review:
        print(f'needs a name: {item["name"]}: {item["reason"]}')
    print(
        f'renamed={len(organizer.renamed)} review={len(organizer.review)} covers added={added} failed={failed}'
    )
    if args.state:
        write_state(
            args.state,
            {
                'at': int(time.time()),
                'renamed': len(organizer.renamed),
                'covers': added,
                'review': organizer.review,
            },
        )
    if (added or organizer.renamed) and args.changed_flag:
        args.changed_flag.touch()
    return 1 if failed and not added else 0


if __name__ == '__main__':
    sys.exit(main())
