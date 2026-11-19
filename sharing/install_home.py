#!/usr/bin/env python3
"""Guided installation on a fresh Pi, or a non-mutating compatibility plan."""

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from leon_home.contracts import ReleaseError, Site, read_json  # noqa: E402
from leon_home.install import install, maintain, preflight, support_key, verified_bundle  # noqa: E402

MESSAGES = {
    'existingInstallation': 'This Pi already has an installation. To resume an interrupted new setup, use the exact same bundle with --resume.',
    'incompatible': 'You need 64-bit Raspberry Pi OS Lite based on Debian 13.',
    'invalidSignature': 'The signature or key fingerprint does not match. Stop setup and review the bundle with your support person.',
    'missingPrerequisite': 'A prerequisite is missing. Follow the guide to install Pi-hole v6, Tailscale, Unbound, nftables and OpenSSL.',
    'wrongTailnet': 'Tailscale must be connected with the owner account for this household, without device tags.',
    'missingInterface': 'No IPv4 address was found on the selected Ethernet interface.',
    'incompatibleSubnet': 'This network is outside the inventory limits. Ask for help before continuing.',
    'invalidSupportKey': 'The support key must be a valid Ed25519 public key.',
    'rootRequired': 'Run this setup assistant with sudo to install.',
    'invalidPassword': 'The Pi-hole application password has an invalid format.',
    'setupIncomplete': 'Maintenance needs a completed installation. Finish or resume the initial setup first.',
    'notNewer': 'This release is not newer than the installed version.',
    'recoveryNeeded': 'An update is waiting for recovery. Restart the update service and review its status first.',
    'rolledBack': 'The new version failed its health check and the previous version was restored. Nothing else changed.',
}


def maintenance(options):
    from leon_home.install import base_pending

    candidate = verified_bundle(options.bundle, options.key, options.fingerprint)
    resuming = base_pending(candidate)
    print(
        f'Verified bundle: LEÓN Home {candidate["version"]} (maintenance'
        + (', resuming the base update).' if resuming else ').')
    )
    print('Plan: switch the application with a health check, then update the privileged base.')
    if not options.apply:
        print('Checks complete. No changes were made. Add --apply to perform maintenance.')
        return
    maintain(options.bundle, options.key, options.fingerprint, Path(__file__).resolve().parent)
    print('Maintenance complete. The panel and updates restarted with the new base.')


def wizard(repository):
    print('LEÓN Home · A Raspberry Pi for your home\n')
    owner = input('Owner Tailscale account login: ').strip().lower()
    support = input('Support Tailscale login (leave empty to skip): ').strip().lower()
    hostname = input('Hostname for this Pi [leon-casa]: ').strip() or 'leon-casa'
    interface = input('Ethernet interface [eth0]: ').strip() or 'eth0'
    return {
        'schemaVersion': 1,
        'owner': owner,
        'supportLogin': support,
        'repository': repository,
        'hostname': hostname,
        'interface': interface,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--fingerprint', required=True)
    parser.add_argument('--site', type=Path)
    parser.add_argument('--repository', default='MauricioLeon54/leon-home')
    parser.add_argument('--support-key', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument(
        '--maintenance', action='store_true', help='update an existing installation (administrator)'
    )
    options = parser.parse_args()
    try:
        if options.maintenance:
            if options.site or options.support_key or options.resume:
                parser.error('--maintenance uses the installed site configuration')
            return maintenance(options)
        value = read_json(options.site) if options.site else wizard(options.repository)
        site = Site.parse(value)
        candidate, _ = preflight(
            site, options.bundle, options.key, options.fingerprint, options.resume
        )
        public = support_key(options.support_key) if options.support_key else None
        if site.support_login and public is None:
            raise ReleaseError('invalidSupportKey')
        print(f'Verified bundle: LEÓN Home {candidate["version"]}.')
        print(
            'Plan: private panel, inventory, scoped DNS and owner-approved updates.\nRouter, DHCP and other device DNS settings require separate configuration.'
        )
        if not options.apply:
            print('Checks complete. No changes were made. Add --apply when ready to install.')
            return
        if os.geteuid() != 0:
            raise ReleaseError('rootRequired')
        password = getpass.getpass('Pi-hole APPLICATION password (not displayed): ')
        install(
            site,
            value,
            options.bundle,
            options.key,
            options.fingerprint,
            Path(__file__).resolve().parent,
            password,
            public,
            options.resume,
        )
        password = ''
        print(
            'Setup complete. Open the HTTPS address of this Pi from your phone with Tailscale connected.\nContinue with the single-device DNS test and access rules in the guide.'
        )
    except ReleaseError as error:
        raise SystemExit(
            MESSAGES.get(
                error.code,
                'Setup could not finish. Keep the bundle and review the guide with your support person.',
            )
        ) from None
    except (OSError, ValueError, KeyError):
        raise SystemExit(
            'The check or installation was interrupted. Review the prerequisites and guide before retrying.'
        ) from None


if __name__ == '__main__':
    main()
