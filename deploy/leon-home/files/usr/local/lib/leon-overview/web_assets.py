"""Fixed, bounded asset manifest for the authenticated network web app."""

from pathlib import Path

DIRECTORY = Path(__file__).with_name('web') / 'dist'
MAX_BYTES = 128_000
ASSETS = {
    '/network-map/assets/' + name: (
        name,
        'text/css' if name.endswith('.css') else 'text/javascript',
    )
    for name in ('app.js', 'home.js', 'network-map.css', 'home.css', 'updates.js', 'updates.css')
}


def read(path):
    asset = ASSETS.get(path)
    if asset is None:
        return None
    filename, content_type = asset
    try:
        with (DIRECTORY / filename).open('rb') as handle:
            body = handle.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            return None
    except OSError:
        return None
    return body, content_type + '; charset=utf-8'


def read_worker():
    try:
        with (DIRECTORY / 'serviceWorker.js').open('rb') as handle:
            body = handle.read(MAX_BYTES + 1)
        return body if len(body) <= MAX_BYTES else None
    except OSError:
        return None
