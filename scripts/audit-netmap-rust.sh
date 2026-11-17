#!/bin/sh
# Audits rust/leon-netmap/Cargo.lock against the RustSec advisory database inside the development
# container (cargo-audit is cached in a named volume, never installed on the host or the Pi).
# Rerun before every leon-netmap rebuild and at least monthly while the Rust engine is deployed.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
version=0.23.0
docker build --quiet --tag leon-netmap-dev --file "$root/rust/leon-netmap/dev.Dockerfile" \
  "$root/rust/leon-netmap" >/dev/null
docker run --rm \
  --volume "$root/rust/leon-netmap:/crate:ro" \
  --volume leon-netmap-cargo:/usr/local/cargo/registry \
  --volume leon-netmap-tools:/tools \
  leon-netmap-dev sh -euc "
    [ -x /tools/bin/cargo-audit ] && /tools/bin/cargo-audit --version | grep -q ' $version\$' ||
      cargo install --quiet --locked --root /tools cargo-audit --version $version
    cd /crate && /tools/bin/cargo-audit audit --file Cargo.lock --deny warnings
  "
