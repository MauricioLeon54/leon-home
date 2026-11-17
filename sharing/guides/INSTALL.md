# Install LEÓN Home

Set up your first Raspberry Pi with help from your support person. After installation, use
LEÓN Home from your phone. The Pi does not need the Mac app, Docker, Node.js or a Rust compiler.

## Before you begin

You need a Raspberry Pi 4 with 2 GB RAM, a suitable 5 V / 3 A power supply, Ethernet, a reliable
microSD card and **64-bit Raspberry Pi OS Lite based on Debian 13**. Store your recovery
credentials in your own password manager. A display is optional when SSH is prepared with
Raspberry Pi Imager.

Use your own Tailscale account and protect its sign-in. Each household has its own identity,
keys, configuration and backups; do not clone another household's installation.

Your support person prepares the signed application bundle, bootstrap archive, signing public
key and its fingerprint, confirmed through an independent channel. Support also needs a dedicated
SSH key. Only its **public** part goes on the Pi; the private key stays with your support person.

## Prepare the system

1. Write Raspberry Pi OS Lite to the microSD card with Imager. Choose a hostname, enable SSH
   with a key and create a recovery account with a strong password. Keep a local recovery path
   and verify key access before disabling any other access method.
2. Connect Ethernet and power. Reserve the Pi's address in your router's DHCP settings without
   changing the DNS offered to other devices. Verify the SSH host fingerprint on the device or
   through trusted setup material. Do not automatically accept an unknown fingerprint.
3. Update the system and install prerequisites from its package repositories:
   `sudo apt update`, then `sudo apt install python3 openssl nftables unbound dns-root-data openssh-server sudo`.
4. Install **Pi-hole v6** using the [official procedure](https://docs.pi-hole.net/main/basic-install/).
   Download and review its installer before running it. Keep your administrator password.
   Create an application password in Pi-hole for LEÓN statistics; enter it locally, never in chat.
5. Install [Tailscale for Raspberry Pi](https://tailscale.com/download/linux). Sign in with this
   household's owner account and confirm the Pi appears in that account. Leave exit nodes,
   subnet routes and Funnel disabled. Enable HTTPS for the private panel when Tailscale asks.

LEÓN setup binds the Pi-hole web interface to loopback, configures encrypted upstream DNS
through Unbound and limits incoming DNS to the LAN and Tailscale. Configuring DNS on other
devices and editing Tailscale access policy are separate steps.

## Verify the release before running it

Download these five files from the [release page](https://github.com/MauricioLeon54/leon-home/releases/latest):

- `manifest.json`
- `manifest.sig`
- `leon-home-arm64.tar.gz`
- `bootstrap.tar.gz`
- `release-key.pem`

Confirm the public key's SHA-256 fingerprint directly with your support person through an
independent channel. The initial bundle establishes trust for later releases. Before extracting
or executing the bootstrap, verify the public key fingerprint and manifest signature, then
compare the bootstrap hash with the **verified manifest**. A hash next to a download does not
replace a signature verified with a trusted key.

```sh
openssl pkey -pubin -in release-key.pem -outform DER | sha256sum
openssl pkeyutl -verify -pubin -inkey release-key.pem -sigfile manifest.sig -rawin -in manifest.json
sha256sum bootstrap.tar.gz
```

The first result must match the fingerprint confirmed by support. The final result must match
`bootstrapSha256` in the signed manifest. Only then extract `bootstrap.tar.gz` into a new
directory and open that directory.

## Run the setup assistant

The signed bundle and extracted bootstrap live in separate directories. Replace these example
paths and the fingerprint with your verified installation values:

```sh
sudo python3 -I install_home.py \
  --bundle /path/to/bundle \
  --key /path/to/bundle/release-key.pem \
  --fingerprint VERIFIED_FINGERPRINT \
  --support-key /path/to/support-public-key.pub
```

Without `--apply`, the assistant only checks compatibility and makes no changes. It asks for the
owner's Tailscale login, support login, hostname and Ethernet interface. Use the same values when
adding `--apply` to install. The Pi-hole application password is entered locally without being
displayed and stays on this Pi.

To omit support access, leave its login empty and omit `--support-key`.

Setup refuses an existing LEÓN installation. If a new installation is interrupted, keep the
same bundle, fingerprint and site values; the operator can resume with `--resume --apply`.
Do not delete another installation's files to bypass these checks. An interrupted initial setup
needs operator review.

## Open the panel and try DNS

1. Connect Tailscale on your phone. Open **your Pi's** HTTPS address shown by
   `tailscale serve status`. Add it to your home screen from Safari or your browser.
2. Check Home and Network. The first reading takes a moment. Traffic measurements and port
   controls depend on your router and stay unavailable until its capabilities are verified.
3. Test DNS on one device at home. Set its manual DNS to the Pi's reserved LAN address, then
   check browsing and filtering. To revert, restore automatic DNS.
4. For filtering outside home, set your Pi's Tailscale IP as a DNS server in **your tailnet** and
   enable Override DNS. Your phone must use Tailscale DNS with Exit Node set to None. This
   shared DNS preference can also affect other devices in your tailnet.
5. Turn off Wi-Fi and check a website and the panel over mobile data. If your home loses power
   or Internet, disable Tailscale DNS or disconnect Tailscale temporarily. Explain and test the
   DNS recovery path before changing DNS for the whole household.

Pi-hole filters DNS; it does not block every advertisement or replace safe browsing. Applications
with their own DNS, encrypted DNS and router-advertised IPv6 DNS can bypass filtering. Whole-home
DNS changes require a separate configuration appropriate to your router.

## Support and recovery

Follow [Tailscale and support](TAILSCALE.md) to share only this Pi, restrict ports and verify the
SSH host key. Default support commands are limited; support cannot accept updates for the owner.

Keep a Pi-hole Teleporter export in your own secure storage with your credentials and recovery
material. A previous local application version helps recover from a failed update but does not
protect against a damaged microSD card. Reliable power, an SSD or UPS, and an external backup
address different failure modes.
