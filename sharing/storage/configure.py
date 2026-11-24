#!/usr/bin/env python3
"""Print the Samba configuration for one LEÓN Home NAS."""

import argparse
import re

ACCOUNT = re.compile(r'[a-z_][a-z0-9_-]{0,30}')
STORAGE_ROOT = '/srv/leon-storage'
# Folders that Windows and macOS create on removable volumes.
SYSTEM_FOLDERS = '/$RECYCLE.BIN/System Volume Information/.Spotlight-V100/.Trashes/.fseventsd/.TemporaryItems/$TXRAJNL.DAT/'


def account(value):
    if not ACCOUNT.fullmatch(value) or value in ('root', 'nobody'):
        raise argparse.ArgumentTypeError('Use a dedicated Linux account name.')
    return value


def library_path(value):
    parts = value.split('/')
    if (
        not (value == STORAGE_ROOT or value.startswith(STORAGE_ROOT + '/'))
        or '..' in parts
        or '' in parts[1:]
        or not re.fullmatch(r'[A-Za-z0-9 _./-]+', value)
    ):
        raise argparse.ArgumentTypeError(f'Use {STORAGE_ROOT} or a folder below it.')
    return value


EXCHANGE = """
[Exchange]
    path = /srv/leon-storage/exchange
    valid users = {owner} {guest}
    read only = no
    force group = +leon-nas
    create mask = 0660
    force create mode = 0660
    directory mask = 02770
    force directory mode = 02770
    follow symlinks = no
"""


def configuration(owner, guest, library=STORAGE_ROOT + '/library', exchange=True):
    shares = f"""[global]
    server role = standalone server
    interfaces = 127.0.0.1
    bind interfaces only = yes
    smb ports = 445
    disable netbios = yes
    server min protocol = SMB2_02
    map to guest = Never
    load printers = no
    disable spoolss = yes
    veto files = {SYSTEM_FOLDERS}

[Library]
    path = {library}
    valid users = {owner} {guest}
    read only = yes
    write list = {owner}
    create mask = 0644
    directory mask = 0755
    follow symlinks = no
"""
    return shares + EXCHANGE.format(owner=owner, guest=guest) if exchange else shares


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True, type=account)
    parser.add_argument('--guest', required=True, type=account)
    parser.add_argument(
        '--library-path',
        default=STORAGE_ROOT + '/library',
        type=library_path,
        help='Library folder, for example the root of an existing volume.',
    )
    parser.add_argument(
        '--without-exchange',
        action='store_true',
        help='Omit Exchange, for example while the volume is mounted read-only.',
    )
    args = parser.parse_args()
    if args.owner == args.guest:
        parser.error('Owner and guest must use separate accounts.')
    print(
        configuration(args.owner, args.guest, args.library_path, not args.without_exchange), end=''
    )


if __name__ == '__main__':
    main()
