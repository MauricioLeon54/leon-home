# Development-only Linux ARM64 environment for leon-netmap: release builds for the Pi
# (Debian trixie, glibc 2.41, aarch64-unknown-linux-gnu built natively on an ARM64 Docker host),
# Linux tests and the synthetic benchmark. Nothing here is installed on the Pi.
# rust:1.99.0-slim-trixie, pinned by digest.
FROM rust@sha256:2752b332db73fdbb7dc576f06c82ed1f312005784ef913d7e04a28f5f55dc581
RUN apt-get update \
    && apt-get install --no-install-recommends -y iproute2 iputils-ping python3 strace binutils file \
    && rm -rf /var/lib/apt/lists/* \
    && rustup component add clippy rustfmt \
    && groupadd --system --gid 985 leon-netmap \
    && useradd --system --uid 997 --gid 985 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin leon-netmap
