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
  --version 0.1.2 --sequence 3 \
  --notes 'Describe the actual improvement for the person using the panel.' \
  --output dist/leon-home/0.1.2 \
  --signer .build/LeonReleaseSigner
```

These version numbers illustrate a release after 0.1.1. Increase both values for every release.
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
