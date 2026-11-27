#!/usr/bin/env python3
"""Turn Gerbera's default configuration into a LEÓN movie server configuration.

Usage: gerbera --create-config | python3 dlna_config.py --name "LEÓN Películas" \
           --library /srv/leon-storage/PELICULAS > /etc/gerbera/config.xml

TVs see one "Películas" folder with every video and its folder.jpg poster at full size
(upnp:albumArtURI, which VLC reads). The web UI, thumbnails and empty audio/photo folders
are off. Each edit must match Gerbera's default exactly once, so a changed default fails
loudly instead of producing a half-applied configuration.
"""

import argparse
import re
import sys
import uuid
from xml.sax.saxutils import escape, quoteattr

INTERFACE = re.compile(r'[a-z][a-z0-9]{0,14}')
LIBRARY = re.compile(r'/srv/[A-Za-z0-9 _./()-]+')
VISIBLE_BOXES = {'Video/videoRoot': 'Películas', 'Video/allVideo': 'Todas las películas'}
IMAGE_EXTENSIONS = ('jpg', 'jpeg', 'png')


def replace_once(text, old, new):
    count = text.count(old)
    if count != 1:
        raise ValueError(f'expected one {old!r} in the Gerbera default, found {count}')
    return text.replace(old, new)


def box(match):
    tag = match.group(0)
    key = re.search(r'key="([^"]+)"', tag)[1]
    if key in VISIBLE_BOXES:
        return re.sub(r'title="[^"]*"', f'title={quoteattr(VISIBLE_BOXES[key])}', tag)
    return tag.replace('<box ', '<box enabled="false" ', 1)


def configuration(default, name, library, interface, port, udn, scan):
    start = default.find('<?xml')
    if start < 0:
        raise ValueError('input is not a Gerbera configuration')
    # `gerbera --create-config` prints a log line before the XML on stdout.
    text = replace_once(default[start:], '<ui enabled="yes"', '<ui enabled="no"')
    text = replace_once(
        text,
        '<name>Gerbera</name>',
        f'<name>{escape(name)}</name><port>{port}</port><interface>{interface}</interface>',
    )
    text = re.sub(r'<udn>uuid:[0-9a-f-]+</udn>', f'<udn>uuid:{udn}</udn>', text, count=1)
    text = re.sub(r'<home>[^<]*</home>', '<home>/var/lib/gerbera</home>', text, count=1)
    text = replace_once(text, '<webroot>', '<pc-directory upnp-hide="yes"/><webroot>')
    text = replace_once(text, '<containers enabled="yes">', '<containers enabled="no">')
    text = replace_once(
        text, '<ffmpegthumbnailer enabled="yes">', '<ffmpegthumbnailer enabled="no">'
    )
    # The JavaScript layout creates folders only for imported media; the built-in one always
    # shows empty Audio and Photos folders.
    text = replace_once(text, '<virtual-layout type="builtin"', '<virtual-layout type="js"')
    mode = 'mode="inotify"' if scan == 'inotify' else 'mode="timed" interval="86400"'
    text = replace_once(
        text,
        '<import hidden-files="no">',
        '<import hidden-files="no">'
        f'<autoscan use-inotify="{"yes" if scan == "inotify" else "no"}"><directory location={quoteattr(library)} {mode} recursive="yes" hidden-files="no"/></autoscan>'
        '<resources case-sensitive="no"><fanart><add-file name="folder.jpg"/><add-file name="poster.jpg"/></fanart>'
        '<container><add-file name="folder.jpg"/></container></resources>',
    )
    ignored = ''.join(f'<add-file name="{extension}"/>' for extension in IMAGE_EXTENSIONS)
    text = replace_once(
        text, '<mappings>', f'<mappings><ignore-extensions>{ignored}</ignore-extensions>'
    )
    text, boxes = re.subn(r'<box [^>]*/>', box, text)
    if not boxes or any(f'key="{key}"' not in text for key in VISIBLE_BOXES):
        raise ValueError('Gerbera default has no built-in video layout boxes')
    return text


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--name', required=True, help='server name shown on TVs')
    parser.add_argument('--library', required=True, help='movie folder below /srv')
    parser.add_argument('--interface', default='eth0', help='home network interface')
    parser.add_argument('--port', type=int, default=8200)
    parser.add_argument(
        '--udn',
        type=uuid.UUID,
        default=None,
        help='keep the existing server identity when regenerating',
    )
    parser.add_argument(
        '--scan',
        choices=('inotify', 'timed'),
        default='inotify',
        help='timed (daily) for network mounts',
    )
    args = parser.parse_args()
    if not 0 < len(args.name) <= 64 or any(ord(character) < 32 for character in args.name):
        parser.error('Use a short, single-line --name.')
    if not LIBRARY.fullmatch(args.library) or '..' in args.library.split('/'):
        parser.error('Use a folder below /srv for --library.')
    if not INTERFACE.fullmatch(args.interface):
        parser.error('Use an interface name such as eth0.')
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged --port.')
    try:
        sys.stdout.write(
            configuration(
                sys.stdin.read(),
                args.name,
                args.library,
                args.interface,
                args.port,
                args.udn or uuid.uuid4(),
                args.scan,
            )
        )
    except ValueError as error:
        sys.exit(f'dlna_config: {error}')


if __name__ == '__main__':
    main()
