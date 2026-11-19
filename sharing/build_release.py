#!/usr/bin/env python3
"""Build a fixed application payload, never a snapshot of the personal repository or machine."""

import argparse
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sharing'))
from leon_home.contracts import FILES, manifest, version  # noqa: E402

OVERVIEW = ROOT / 'deploy/leon-home/files/usr/local/lib/leon-overview'


def source(name):
    if name == 'app/collector.py':
        return ROOT / 'sharing/collector.py'
    if name in ('app/family.py', 'app/update_client.py', 'app/updates.html'):
        return ROOT / 'sharing' / Path(name).name
    if name.startswith('app/'):
        return OVERVIEW / name.removeprefix('app/')
    if name == 'inventory/leon-netmap':
        return ROOT / 'dist/leon-netmap/leon-netmap'
    if name == 'router/monitor.py':
        return ROOT / 'deploy/leon-home/files/usr/local/lib/leon-router/monitor.py'
    if name == 'router/router_read_probe.py':
        return ROOT / 'scripts/router_read_probe.py'
    if name == 'inventory/netmap.py':
        return ROOT / 'deploy/leon-home/files/usr/local/lib/leon-netmap/netmap.py'
    return ROOT / 'deploy/leon-home/files/usr/local/share/leon-home' / Path(name).name


def bootstrap(output):
    files = {}
    for name in ('install_home.py', 'run_updater.py', 'run_support.py', 'unbound.conf'):
        files[name] = (ROOT / 'sharing' / name).read_bytes()
    for path in (ROOT / 'sharing/leon_home').glob('*.py'):
        files['leon_home/' + path.name] = path.read_bytes()
    for path in (ROOT / 'sharing/units').glob('*'):
        if path.is_file():
            files['units/' + path.name] = path.read_bytes()
    files['motd/20-leon-home'] = (
        ROOT / 'deploy/leon-home/files/etc/update-motd.d/20-leon-home'
    ).read_bytes()
    digests = {
        name: hashlib.sha256(data).hexdigest()
        for name, data in files.items()
        if name != 'install_home.py' and name != 'leon_home/install.py' and name != 'unbound.conf'
    }
    broker_hash = hashlib.sha256(json.dumps(digests, sort_keys=True).encode()).hexdigest()
    # Fixed timestamps make bootstrap identity independent of the app release date/version.
    path = output / 'bootstrap.tar.gz'

    with (
        path.open('wb') as raw,
        gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as compressed,
        tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as target,
    ):
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            target.addfile(info, io.BytesIO(data))
    return broker_hash, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()


def build(output, release_version, sequence, notes):
    version(release_version)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    broker_hash, bootstrap_bytes, bootstrap_hash = bootstrap(output)
    archive = output / 'leon-home-arm64.tar.gz'
    entries = {}
    try:
        with (
            archive.open('wb') as raw,
            gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as compressed,
            tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as target,
        ):
            for name in sorted(FILES):
                data = source(name).read_bytes()
                entries[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = (
                    len(data),
                    0o755 if name == 'inventory/leon-netmap' else 0o644,
                    0,
                )
                target.addfile(info, io.BytesIO(data))
        value = manifest(
            {
                'schemaVersion': 1,
                'product': 'leon-home',
                'version': release_version,
                'sequence': sequence,
                'architecture': 'aarch64',
                'os': 'debian-13',
                'notes': notes,
                'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'archiveBytes': archive.stat().st_size,
                'bootstrapSha256': bootstrap_hash,
                'bootstrapBytes': bootstrap_bytes,
                'brokerSha256': broker_hash,
                'files': entries,
            }
        )
        (output / 'manifest.json').write_text(
            json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'
        )
        return value
    except BaseException:
        shutil.rmtree(output)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--sequence', type=int, required=True)
    parser.add_argument('--notes', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--signer', type=Path)
    options = parser.parse_args()
    value = build(options.output, options.version, options.sequence, options.notes)
    if options.signer:
        subprocess.run(
            [
                str(options.signer.resolve()),
                'sign',
                str(options.output / 'manifest.json'),
                str(options.output / 'manifest.sig'),
            ],
            check=True,
            timeout=120,
        )
        subprocess.run(
            [str(options.signer.resolve()), 'public', str(options.output / 'release-key.pem')],
            check=True,
            timeout=120,
        )
    print(
        f'Built LEON Home {value["version"]}: {len(value["files"])} allowlisted files. '
        + ('Signed.' if options.signer else 'Unsigned development artifact; cannot install.')
    )


if __name__ == '__main__':
    main()
