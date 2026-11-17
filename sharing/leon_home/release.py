"""Verify an Ed25519 release before safely unpacking its fixed application-only file set."""

import gzip
import hashlib
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

from .contracts import FILES, MAX_ARCHIVE, MAX_MANIFEST, ReleaseError, manifest, read_json


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(65_536), b''):
            result.update(chunk)
    return result.hexdigest()


def verify(folder, public_key):
    folder = Path(folder)
    paths = [folder / name for name in ('manifest.json', 'manifest.sig', 'leon-home-arm64.tar.gz')]
    if any(path.is_symlink() or not path.is_file() for path in paths):
        raise ReleaseError('invalidRelease')
    document, signature, archive = paths
    if (
        document.stat().st_size > MAX_MANIFEST
        or signature.stat().st_size != 64
        or archive.stat().st_size > MAX_ARCHIVE
    ):
        raise ReleaseError('invalidRelease')
    try:
        result = subprocess.run(
            [
                'openssl',
                'pkeyutl',
                '-verify',
                '-pubin',
                '-inkey',
                str(public_key),
                '-sigfile',
                str(signature),
                '-rawin',
                '-in',
                str(document),
            ],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ReleaseError('signatureUnavailable') from error
    if result.returncode:
        raise ReleaseError('invalidSignature')
    value = manifest(read_json(document))
    if archive.stat().st_size != value['archiveBytes'] or digest(archive) != value['archiveSha256']:
        raise ReleaseError('invalidRelease')
    return value


def unpack(folder, destination, public_key):
    """The destination must not exist; never follow links or use tarfile.extractall."""
    value = verify(folder, public_key)
    destination = Path(destination)
    destination.mkdir(mode=0o755)
    seen = set()
    try:
        tar_path = destination / '.payload.tar'
        maximum = (
            sum(entry['bytes'] for entry in value['files'].values()) + len(FILES) * 1024 + 10240
        )
        total = 0
        with (
            gzip.open(Path(folder) / 'leon-home-arm64.tar.gz', 'rb') as source,
            tar_path.open('xb') as output,
        ):
            while chunk := source.read(65_536):
                total += len(chunk)
                if total > maximum:
                    raise ReleaseError('invalidRelease')
                output.write(chunk)
        with tarfile.open(tar_path, 'r|') as archive:
            for member in archive:
                if not member.isfile() or member.name not in FILES or member.name in seen:
                    raise ReleaseError('invalidRelease')
                entry = value['files'][member.name]
                if member.size != entry['bytes']:
                    raise ReleaseError('invalidRelease')
                seen.add(member.name)
                target = destination / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ReleaseError('invalidRelease')
                with source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 65_536)
                    output.flush()
                    os.fsync(output.fileno())
                if digest(target) != entry['sha256']:
                    raise ReleaseError('invalidRelease')
                target.chmod(0o755 if member.name == 'inventory/leon-netmap' else 0o644)
                with target.open('rb') as handle:
                    os.fsync(handle.fileno())
        if seen != FILES:
            raise ReleaseError('invalidRelease')
        tar_path.unlink()
        atomic_json(destination / 'release.json', value, 0o644)
        directories = sorted(
            (path for path in destination.rglob('*') if path.is_dir()),
            key=lambda path: len(path.parts),
            reverse=True,
        )
        for path in directories + [destination, destination.parent]:
            path.chmod(0o755)
            descriptor = os.open(path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except BaseException:
        shutil.rmtree(destination)
        raise
    return value


def newer(candidate, installed):
    from .contracts import version

    if candidate['sequence'] <= installed['sequence'] or version(candidate['version']) <= version(
        installed['version']
    ):
        raise ReleaseError('notNewer')


def atomic_json(path, value, mode=0o600):
    import json

    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(mode)
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
