#!/bin/sh
# Disposable ARM64 integration; no household devices or credentials are used.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
[ "$(docker version --format '{{.Server.Arch}}')" = arm64 ] || {
  echo 'An ARM64 Docker host is required.' >&2
  exit 1
}
[ -f "$root/dist/leon-netmap/leon-netmap" ] || {
  echo 'Run pnpm build:netmap first.' >&2
  exit 1
}
docker build --quiet -t leon-netmap-dev -f "$root/rust/leon-netmap/dev.Dockerfile" "$root/rust/leon-netmap" >/dev/null
docker build --quiet -t leon-home-install-test -f "$root/sharing/test.Dockerfile" "$root" >/dev/null
docker run --rm --network none --cap-add NET_ADMIN --volume "$root:/src:ro" \
  leon-home-install-test python3 -I /src/sharing/test_linux.py
