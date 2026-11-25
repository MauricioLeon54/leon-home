# Updates and recovery

## Install an application update

From Home, open **Updates**. The Pi checks published releases periodically; you can also choose
**Check for updates**.

When a compatible release is available, you will see its version and release notes. Choose
**Accept and install**, review the confirmation and select **Install now**. Keep the Pi powered
on. The panel may restart briefly and will reconnect. Pi-hole is maintained separately and is
not restarted to update LEÓN.

The Pi verifies the signature and contents before activating a release. It keeps the previous
version and restores it if the new version fails health checks. The panel tells you when
maintenance help is needed. Do not unplug the Pi to troubleshoot an update.

A **maintenance update** needs assistance. The privileged signature verifier, operating system,
Pi-hole and Tailscale are maintained separately from normal panel updates. Changing the signing
key or supported operating system also requires an explicit administrative maintenance step.

Release 0.3.6 adds **Storage** to Home: USB drives, mount status, free space and a read-only
**Browse files** view of the shared drive with search, downloads and in-place playback of MP4
videos. It is a normal application update. Setting up the drive itself stays an optional
administrator step described in the [storage guide](STORAGE.md).

## Perform a maintenance update

Release 0.3.5 adds weekly cleanup of obsolete downloaded APT package archives using the
operating system's existing APT timers. It does not uninstall packages, clear DNS caches,
delete household data or run speed tests. No additional always-running service is added.
The existing `apt-daily-upgrade.timer` must remain enabled: its service runs APT cleanup.
Inspect both built-in timers with `systemctl status apt-daily.timer apt-daily-upgrade.timer`.
Check the effective policy with
`apt-config shell interval APT::Periodic::AutocleanInterval` (expected: `interval='7'`).
Cleanup starts on the next eligible scheduled run, rather than forcing a cleanup during
installation. Removing `/etc/apt/apt.conf.d/80-leon-home-cleanup` restores the system's
previous policy. Application rollback alone does not revert this base configuration.

Existing installations need administrator maintenance for this release; the phone's normal
application update cannot install system policy. Fresh installations receive it automatically.
This is disk maintenance, not a remedy for provider outages, packet loss or Wi-Fi congestion.

The Pi repairs itself without any other computer. Every 2 minutes `leon-home-selfheal.timer` checks
Unbound, Pi-hole, the Internet, the router and Tailscale. It restarts a DNS service that stopped
answering, restarts networking when neither the router nor the Internet answers, restarts Tailscale
when it is disconnected while the Internet works and, as a last resort for a dead network link,
reboots at most once every 6 hours. An Internet outage outside the house is only recorded. Events
are kept in `/var/lib/leon-home-selfheal/events.jsonl`. Tailscale, Unbound and Pi-hole also restart
automatically if they ever stop. The base also replaces the SSH login screen with the LEÓN
symbol, wordmark and a live health summary, and silences the kernel line and Debian's static
notice. This base arrives with a maintenance update.

An administrator performs it on the Pi with the owner's authorization. Download the five release
files into a new directory and verify them as described in the installation guide. Then extract
the verified `bootstrap.tar.gz` into another new directory, install any new prerequisites from
the release notes and run the assistant from that directory:

```sh
sudo python3 -I install_home.py --maintenance \
  --bundle /path/to/bundle \
  --key /path/to/bundle/release-key.pem \
  --fingerprint VERIFIED_FINGERPRINT
```

The key must be identical to the installed `/etc/leon-home/release-key.pem`; maintenance never
changes trust. Without `--apply` it only verifies the signature and checks that the release is
newer. With `--apply` it switches the application through the normal health check, keeps the
previous version and only then updates the privileged base, its services and its compatibility
identifier. If the new version fails its health check, the previous one is restored and the
base is unchanged. If maintenance is interrupted after the switch, run the same command again;
it completes the base update without reinstalling the application.

## Publish a release

The public distribution contains generic application code. Per-household configuration, secrets
and personal lab history stay outside releases. The initial target is Raspberry Pi 4, ARM64 and
Debian 13. Build on a development computer, not the deployed Pi.

1. Make the change and run local and CI checks. Review compatibility and dependencies.
2. Build browser assets and the ARM64 executable. Review the public payload.
3. Choose a higher version and sequence number. Write clear release notes in English.
4. Build the bundle and sign its manifest with the local signing tool. The private key stays in
   the Mac login Keychain; publish only the public key and its fingerprint. Keep signing material,
   passwords, inventories and site configuration out of GitHub.
5. Publish a stable GitHub release containing `manifest.json`, `manifest.sig`,
   `leon-home-arm64.tar.gz`, `bootstrap.tar.gz` and `release-key.pem`. Drafts and prereleases are
   not offered as stable updates.
6. Each Pi checks releases from its configured repository. Downloading does not install them.
   Support can run `check-updates`; the owner accepts installation in the panel.

The signed manifest authenticates the application and bootstrap archives. The updater activates
only the fixed application file set in a new version directory. It preserves configuration,
keys and system files, and rejects downgrades, repeated sequences, extra paths, links and
incompatible contents. After a successful update it retains the active and previous versions.

Changing the privileged base changes its compatibility identifier and requires maintenance.
Do not bypass that check. Include signing-key recovery in the maintainer's plan: losing the key
requires re-establishing trust separately with each installation.

## Build and sign on the maintainer's Mac

Reuse the existing key from the Keychain. Do not create a new key for an update. Initial creation
uses the signer's `init` operation once; later releases use the existing key through the builder:

```sh
mkdir -p .build
swiftc sharing/sign_release.swift -o .build/LeonReleaseSigner
pnpm check
pnpm build:netmap
python3 sharing/build_release.py \
  --version 0.3.6 --sequence 10 \
  --notes 'Describe the actual improvement for the person using the panel.' \
  --output dist/leon-home/0.3.6 \
  --signer .build/LeonReleaseSigner
```

The command uses example release values. Before building, set the version and sequence for the
intended release, increasing both from the previous published release. Match the output directory
to the selected version.
The output directory must be new; the builder refuses to overwrite it. Publish its five files
only after verifying tests, signatures and correspondence with reviewed source. If the Keychain
is locked, unlock it and use the original key rather than initializing a replacement.

## Recover from an interrupted update

If activation fails, the updater restores the previous version link and restarts the panel.
A durable transaction marker allows recovery when the update service restarts after an
interrupted activation. Household data lives outside version directories and is not rolled back.

If the update service cannot start, keep the existing panel and DNS available where possible
and use a separately authorized administrative session to investigate. The local previous
version does not replace an external backup. Keep household data out of public diagnostic logs.
