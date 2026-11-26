"""Bounded public GitHub downloads with a fixed source and an explicit redirect allowlist."""

import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .contracts import MAX_ARCHIVE, MAX_MANIFEST, ReleaseError

HOSTS = frozenset(
    {
        'api.github.com',
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
    }
)
ASSETS = {'manifest.json': MAX_MANIFEST, 'manifest.sig': 64, 'leon-home-arm64.tar.gz': MAX_ARCHIVE}


def allowed(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise ReleaseError('invalidSource') from error
    if (
        parsed.scheme != 'https'
        or parsed.hostname not in HOSTS
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        raise ReleaseError('invalidSource')
    return url


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        allowed(url)
        return super().redirect_request(request, fp, code, message, headers, url)


def fetch(url, target, maximum):
    allowed(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects())
    # allowed() enforces HTTPS and the release host allowlist, including redirects.
    request = urllib.request.Request(  # noqa: S310
        url, headers={'User-Agent': 'LEON-Home-Updater/1', 'Accept': 'application/vnd.github+json'}
    )
    start = time.monotonic()
    try:
        with opener.open(request, timeout=15) as response, Path(target).open('xb') as output:
            total = 0
            while chunk := response.read(65_536):
                total += len(chunk)
                if total > maximum or time.monotonic() - start > 90:
                    raise ReleaseError('invalidRelease')
                output.write(chunk)
    except (OSError, ValueError, urllib.error.URLError, socket.timeout) as error:
        raise ReleaseError('networkUnavailable') from error


def latest(repository, folder):
    folder = Path(folder)
    response = folder / 'github.json'
    fetch(f'https://api.github.com/repos/{repository}/releases/latest', response, 131072)
    try:
        value = json.loads(response.read_bytes())
    except (ValueError, UnicodeError) as error:
        raise ReleaseError('invalidRelease') from error
    if (
        not isinstance(value, dict)
        or value.get('draft') is not False
        or value.get('prerelease') is not False
    ):
        raise ReleaseError('invalidRelease')
    assets = value.get('assets')
    if not isinstance(assets, list) or len(assets) > 16:
        raise ReleaseError('invalidRelease')
    selected = {}
    for item in assets:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get('name'), str)
            or item['name'] not in ASSETS
        ):
            continue
        name, url = item['name'], item.get('browser_download_url')
        if (
            name in selected
            or not isinstance(url, str)
            or not url.startswith(f'https://github.com/{repository}/releases/download/')
        ):
            raise ReleaseError('invalidSource')
        selected[name] = url
    if set(selected) != set(ASSETS):
        raise ReleaseError('invalidRelease')
    for name, maximum in ASSETS.items():
        fetch(selected[name], folder / name, maximum)
