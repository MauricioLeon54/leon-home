# Optional household storage

Each Pi can serve its own USB drive over SMB. Use the household's existing Raspberry Pi OS
installation and Tailscale identity. An administrator sets up storage locally. The normal LEÓN
application update preserves this configuration. In Home, open **Storage** to see USB
drives, mount status and available space on the shared volume. **Browse files** lists, searches
and downloads files on the mounted volume for the panel owner. It is read-only, hides system
folders and symbolic links, and shows nothing when the drive is not mounted. Safari plays MP4
and MOV videos in place; other formats download, for example to open in VLC.

## Name the drive and link other homes

**Drives** in the panel shows this Pi's drive, how to connect from each kind of device and
the drives of other LEÓN Home installations you can reach. Addresses come from the installed
Samba configuration and Tailscale. To choose the drive's name and add other homes, an
administrator writes `/etc/leon-overview/storage.json` (root-owned, mode `0644`):

```json
{
  "name": "Edgar's drive",
  "peers": [{ "name": "Mau's drive", "url": "smb://100.64.0.10/Library" }]
}
```

Use at most four peers with `smb://` addresses. Invalid entries are ignored. A peer link opens
the other home's share in Files or Finder; its owner must grant you TCP 445 on that Pi.

## Show sign-ins in the guide

**Storage → How to connect** gives plain steps for iPhone, Mac, Windows and the TV. It can also show
the user and password of each drive, so nobody has to send them in a message. An administrator
writes `/etc/leon-overview/storage-accounts.json` as root, group `leon-overview`, mode `0640`:

```json
{
  "accounts": [
    { "drive": "Edgar's drive", "user": "nas_owner", "password": "...", "canWrite": true },
    { "drive": "Mau's drive", "user": "nas_guest", "password": "...", "canWrite": false }
  ]
}
```

`drive` must match the drive's own name or a peer's name in `storage.json`. `canWrite` only changes
the explanation; Samba decides what an account can do. Add only accounts the panel's owner may use.
The panel refuses the file if other users can read it. It sends a password only when the owner taps
Show, hides it after a minute and never logs it. The file stores passwords as plain text: anyone with
administrator access to the Pi can read them, and the owner's signed-in Tailscale devices can show
them. Keep the file out of Git. To stop showing a password, delete its entry.

## Prepare the disk

1. Connect one drive and inspect it with `lsblk -f`. Confirm the filesystem, UUID, available
   capacity and power requirements. Copy important files to another disk before changing the setup.
2. Use a filesystem with Linux ownership and permissions for this configuration, such as ext4.
   Keep existing disks intact. If a disk uses a different filesystem and its ownership semantics
   are unclear, inspect it read-only and use a separate Linux-formatted drive for the pilot.
3. Create the empty root-owned mountpoint `/srv/leon-storage`. Add a local `/etc/fstab` entry
   for the verified UUID. For an existing ext4 volume, the entry has this form:

   ```fstab
   UUID=YOUR_DISK_UUID /srv/leon-storage ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2
   ```

4. Run `sudo systemctl daemon-reload`, mount the volume and verify its source and target with
   `findmnt --mountpoint /srv/leon-storage`. Create the share directories on the mounted volume.

### Existing exFAT or NTFS drive with data

A drive that also moves between Windows, macOS or Android computers can stay in its format.
Start read-only: mount it with `ro` and fixed ownership, because these filesystems have no
Linux permissions. Use the numeric IDs of the owner account and the `leon-nas` group:

```fstab
UUID=YOUR_DISK_UUID /srv/leon-storage exfat ro,nofail,noexec,nodev,nosuid,uid=OWNER_UID,gid=LEON_NAS_GID,fmask=0133,dmask=0022,x-systemd.device-timeout=10s 0 0
```

Generate the Samba configuration with `--library-path /srv/leon-storage --without-exchange` so
the whole volume becomes the read-only Library, and install the Samba drop-in without its
`ConditionPathIsReadWrite` line. Do not enable writes before the Pi reports no under-voltage
(`sudo vcgencmd get_throttled` returns `throttled=0x0` after the drive has been under load):
exFAT has no journal, and a brownout during a write can damage the volume.

## Set up accounts and permissions

Choose two dedicated Linux accounts with nologin shells and no administrative group membership.
Use distinct names for the owner and guest. Add both to a local `leon-nas` group.
Create `/srv/leon-storage/library` owned by the owner with mode `0755`. Inside that directory,
the owner needs write access and the guest needs read access to published files.
Create `/srv/leon-storage/exchange` with group `leon-nas` and mode `2770`.
Keep private folders outside those two shares. Files in Exchange can be changed or deleted by
either participant.

## Configure Samba

These steps target a Pi without existing Samba shares. If Samba is already in use, review its
configuration and service dependencies before changing them.

1. Before installing the Debian `samba` package on a new NAS, mask `smbd.service` and
   `nmbd.service` so the packaged defaults do not start listening during installation.
2. Set separate Samba passwords interactively with `sudo smbpasswd -a ACCOUNT` for each user.
3. From the project checkout, generate a candidate with:

   ```sh
   candidate=$(mktemp)
   python3 sharing/storage/configure.py --owner nas_owner --guest nas_guest > "$candidate"
   testparm -s "$candidate"
   ```

   Save a copy of the existing `/etc/samba/smb.conf`. Install the validated candidate there as
   root, then install `sharing/storage/smbd-storage.conf` into
   `/etc/systemd/system/smbd.service.d/10-leon-storage.conf`. The drop-in connects Samba's
   lifetime to the USB mount. If the disk is missing, Samba stays stopped.

4. In Tailscale, share this Pi with the other household's account. Review effective grants and
   allow the guest only TCP 445 on this Pi. Apply equivalent restrictions on the other Pi if both
   homes share storage. Use TCP 445 over Tailscale without router port forwarding.
5. Reload systemd, unmask `smbd.service`, then enable and start it. Keep `nmbd.service` masked.
6. Forward TCP 445 to Samba's loopback listener using Tailscale Serve.

   ```sh
   sudo tailscale serve --bg --tcp=445 tcp://127.0.0.1:445
   tailscale serve status
   ```

   Connect over Tailscale using `smb://PI_TAILSCALE_ADDRESS` in Finder or iOS Files.

## Play videos on a TV in the home

Smart TVs cannot join Tailscale, so they cannot use the Samba share. `minidlna` publishes a
read-only video folder to the home network over DLNA without transcoding. Files must already
use formats the TV plays, such as H.264 or H.265 with AAC or AC3 audio.

1. Mask `minidlna.service` before installing the `minidlna` package.
2. In `/etc/minidlna.conf`, set `media_dir=V,/srv/leon-storage/VIDEO_FOLDER`,
   `network_interface=` to the Pi's wired or Wi-Fi interface on the home network, `inotify=yes`
   and a `friendly_name`. Tailscale grants keep port 8200 closed to other tailnet devices.
3. Add a drop-in for `minidlna.service` with `BindsTo=srv-leon\x2dstorage.mount`, the matching
   `After=` and `ConditionPathIsMountPoint=/srv/leon-storage`, then unmask, enable and start it.
4. Check `http://PI_LAN_ADDRESS:8200/` for the indexed file count. Files reported as
   "Unsuccessful getting details" in `journalctl -u minidlna` are usually damaged or incomplete.
5. On the TV, open the media player app or VLC → Local network and select the server.
   VLC shows embedded MKV subtitles and plays DTS audio more reliably than built-in players.

## Serve computers at home without Tailscale

A household computer without Tailscale can use the home address. Add the Pi's reserved
address with its prefix, for example `--lan 192.168.1.20/24`, when generating the Samba
configuration. Samba then also listens on that address and accepts only that home network.
Anyone on the home Wi-Fi can attempt to sign in, so keep strong Samba passwords and never
forward port 445 on the router.

- macOS and Windows 10 or later find the Pi by its multicast DNS name, for example
  `smb://HOSTNAME.local/Library` or `\\HOSTNAME.local\Library`.
- To show a friendly name in the Finder sidebar, add an Avahi service file under
  `/etc/avahi/services/` that advertises `_smb._tcp` on port 445. The generated configuration
  keeps Samba's own announcement off so the share appears once.
- An optional Pi-hole local DNS record, such as `disco.home.arpa`, works for devices that use
  the Pi for DNS. Devices that use another resolver, including Tailscale DNS, will not see it.

## Verify before relying on storage

- Test over both home Wi-Fi and a connection outside the home. Verify guest reads in Library,
  failed guest writes there, and two-way writes in Exchange. Check that other services on the Pi
  stay inaccessible to the guest. Try a video from the intended player.
- With a clean unmount and the disk disconnected, verify that Samba stops and LEÓN and DNS
  still respond. Reconnect the disk, remount, then start Samba. Repeat with a cold boot including
  the disk and confirm that Samba listens on loopback and the share works through Tailscale Serve.
- Keep an independent copy of irreplaceable files. To disable storage, stop and disable Samba
  and turn off the forwarder with `sudo tailscale serve --tcp=445 off`. Revoke the other household's grant. Existing files stay on the disk.
