<p align="center">
  <img src="docs/assets/readme-header.png" alt="LEÓN Home — Your home network, in view." width="100%" />
</p>

<p align="center">
  <a href="sharing/guides/INSTALL.md">Installation</a> &nbsp; · &nbsp;
  <a href="https://github.com/MauricioLeon54/leon-home/releases/latest">Download</a> &nbsp; · &nbsp;
  <a href="sharing/guides/TAILSCALE.md">Remote support</a> &nbsp; · &nbsp;
  <a href="sharing/guides/UPDATES.md">Updates and recovery</a>
</p>

<p align="center">
  <a href="https://github.com/MauricioLeon54/leon-home/actions/workflows/checks.yml">
    <img src="https://github.com/MauricioLeon54/leon-home/actions/workflows/checks.yml/badge.svg" alt="Build and verification status" />
  </a>
</p>

# LEÓN Home

A private home network dashboard for Raspberry Pi. See your devices, check Pi-hole filtering
and keep an eye on your Pi from your phone, at home or away.

Each household owns its Tailscale account, configuration and credentials. Setup is guided;
everyday use happens in the browser. No Mac app is required.

## A clear view of home

| Capability             | What you get                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Private dashboard      | Phone access through Tailscale Serve without public port forwarding.                                |
| DNS filtering          | Pi-hole statistics and controls with encrypted upstream DNS through Unbound.                        |
| Network inventory      | An interactive map with observation times and a prebuilt Rust discovery engine.                     |
| Owner-approved updates | Signed releases, explicit installation approval, health checks and a previous version for recovery. |
| Scoped support         | Access to one Pi through a dedicated SSH key and a small set of maintenance commands.               |

The map represents observed devices, not guaranteed physical wiring. Traffic readings and port
controls depend on verified router capabilities and are unavailable until configured for that
installation. Pi-hole filters DNS; it does not block every advertisement or secure all browsing.

## Start with one Pi

The initial target is a **Raspberry Pi 4 with 2 GB RAM**, Ethernet and **64-bit Raspberry Pi OS
Lite based on Debian 13**, with Pi-hole v6 and Tailscale.

1. Prepare the Pi and its owner's Tailscale account.
2. Verify the signed release and run guided setup with your support person.
3. Open the private panel on your phone and test DNS on one device before expanding its use.

Follow the [installation guide](sharing/guides/INSTALL.md) for prerequisites, signature
verification and recovery steps. Setup refuses to overwrite an existing LEÓN installation.

## Updates on your terms

When a compatible release is available, open **Updates** to review the changes and choose
**Accept and install**. Downloading an update never accepts it on your behalf.

Application updates preserve household configuration and retain the previous version. The
operating system, Pi-hole, Tailscale and privileged updater base have separate maintenance
procedures. A previous version is not a replacement for an external backup.

Read [updates and recovery](sharing/guides/UPDATES.md) and
[sharing one Pi for support](sharing/guides/TAILSCALE.md).

## Development

Use Node.js 24+, pnpm 12.15.0, Python 3.13+ and the Rust toolchain pinned in
`rust/leon-netmap/rust-toolchain.toml`. Development tools run on your computer, not the deployed Pi.

```sh
pnpm install --frozen-lockfile --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
pnpm exec playwright install chromium webkit
pnpm check
pnpm build:netmap
./sharing/test-linux.sh
```

The ARM64 build and disposable installation tests require an ARM64 Docker host. Local and CI
checks cover strict TypeScript, ESLint, Prettier, Ruff, Rust, browser behavior, signatures and
owner authorization. Installation tests use real Unix service identities with simulated system
management and external Pi-hole/Tailscale commands. Real hardware, account enrollment, DNS and
power recovery are verified during guided setup.

Releases are signed with the maintainer's local key; tests generate temporary keys. See the
[maintainer guide](sharing/guides/UPDATES.md) before publishing.

This is the independent household distribution. Personal lab history, device inventories and
household credentials are excluded. `PUBLIC-EXPORT.json` records the reviewed initial export;
it is not a live source manifest. See [brand guidelines](docs/BRAND.md) for the visual identity.
