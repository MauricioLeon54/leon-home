#!/bin/sh
# Builds and checks the leon-netmap Rust engine for the Pi (aarch64-unknown-linux-gnu, Debian
# trixie/glibc 2.41) inside the pinned development container. Needs Docker on an ARM64 host
# (Colima on Apple silicon builds natively; no cross-linker or sysroot is involved).
# Output: dist/leon-netmap/leon-netmap, leon-netmap.sha256 and leon-netmap.crates (the compiled
# crates, which the Pi's weekly advisory check queries). Nothing is installed anywhere.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
crate="$root/rust/leon-netmap"
out="$root/dist/leon-netmap"
image=leon-netmap-dev

if [ "$(docker version --format '{{.Server.Arch}}')" != arm64 ]; then
  echo "An ARM64 Docker host is required (e.g. colima start)" >&2
  exit 1
fi
docker build --quiet --tag "$image" --file "$crate/dev.Dockerfile" "$crate" >/dev/null
mkdir -p "$out"
rm -f "$out/leon-netmap" "$out/leon-netmap.sha256" "$out/leon-netmap.crates"

# The source is mounted read-only; registry and target caches live in named volumes. Path
# prefixes are remapped so the binary carries no build-host paths. Independent builds still
# need hash comparison: apt packages and other build inputs are not snapshot-pinned.
docker run --rm \
  --sysctl 'net.ipv4.ping_group_range=0 2147483647' \
  --volume "$root:/src:ro" \
  --volume "$out:/out" \
  --volume leon-netmap-cargo:/usr/local/cargo/registry \
  --volume leon-netmap-target:/target \
  --env CARGO_TARGET_DIR=/target \
  --env RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo" \
  --workdir /src/rust/leon-netmap \
  "$image" sh -euc '
    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked
    # Repeat real socket tests under the service identity with all capabilities dropped.
    test_binary=$(cargo test --locked --test linux_icmp --no-run --message-format=json |
      python3 -c '\''import json, sys
paths = [item["executable"] for line in sys.stdin if (item := json.loads(line)).get("reason") == "compiler-artifact" and item.get("target", {}).get("name") == "linux_icmp" and item.get("executable")]
if len(paths) != 1:
    raise SystemExit("expected one Linux socket test binary")
print(paths[0])'\'')
    setpriv --reuid=997 --regid=985 --clear-groups --no-new-privs --bounding-set=-all "$test_binary"
    cargo build --locked --release
    binary=/target/release/leon-netmap
    file "$binary" | grep -q "ELF 64-bit LSB pie executable, ARM aarch64" ||
      { echo "unexpected binary format: $(file -b "$binary")" >&2; exit 1; }
    newest=$(objdump -T "$binary" | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1)
    [ "$(printf "%s\nGLIBC_2.41\n" "$newest" | sort -V | tail -1)" = GLIBC_2.41 ] ||
      { echo "needs $newest; the Pi has glibc 2.41" >&2; exit 1; }
    install -m 0755 "$binary" /out/leon-netmap
    cargo tree --locked --edges normal --prefix none --format "{p}" |
      sed -n "s/^\([a-z0-9_-]*\) v\([0-9][^ ]*\)\( (\*)\)\{0,1\}$/\1 \2/p" |
      grep -v "^leon-netmap " | sort -u > /out/leon-netmap.crates
    [ -s /out/leon-netmap.crates ] || { echo "empty crate list" >&2; exit 1; }
    cd /out && sha256sum leon-netmap leon-netmap.crates > leon-netmap.sha256
    echo "built $(stat -c %s leon-netmap) bytes, newest symbol $newest, $(wc -l < leon-netmap.crates) crates"
    cat leon-netmap.sha256
  '
