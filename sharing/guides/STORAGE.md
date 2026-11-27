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

Optionally add `"movies": "/srv/…/PELICULAS"` to show another folder below `/srv` in
**Storage → Movies**, for example another home's movie share mounted read-only. Without it the
page shows `PELICULAS` on this Pi's drive.

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

Smart TVs cannot join Tailscale, so they cannot use the Samba share. Gerbera publishes a
read-only video folder to the home network over DLNA without transcoding. Files must already
use formats the TV plays, such as H.264 or H.265 with AAC or AC3 audio. TVs see one
**Películas** folder with every video and, when the movie folder has a `folder.jpg`, its
full-size poster (`upnp:albumArtURI`, which VLC also reads) and the LEÓN icon.

1. Mask `gerbera.service`, then install the `gerbera` package, so it never starts with its
   default configuration.
2. Generate the configuration from the project checkout and install it as root, mode `0644`
   (the panel reads the server name from it):

   ```sh
   candidate=$(mktemp)
   gerbera --create-config 2>/dev/null |
     python3 sharing/storage/dlna_config.py --name 'LEÓN Películas' \
       --library /srv/leon-storage/VIDEO_FOLDER --interface eth0 > "$candidate"
   sudo install -o root -g root -m 0644 "$candidate" /etc/gerbera/config.xml
   ```

   When regenerating, pass the existing `--udn` from `/etc/gerbera/config.xml` so TVs keep the
   same server. Use `--scan timed` for a network mount. Tailscale grants keep port 8200 closed to
   other tailnet devices.

3. Install `sharing/storage/dlna-icons/*` to `/usr/local/share/leon-dlna/icons/`,
   `sharing/storage/dlna-js/leon-video.js` to `/usr/local/share/leon-dlna/js/` (it keeps every
   video in one list; Gerbera 2.4 otherwise adds a "Year" folder of file dates) and
   `sharing/storage/gerbera-storage.conf` as
   `/etc/systemd/system/gerbera.service.d/10-leon-storage.conf`. So that connecting the drive
   starts the server, link `/usr/lib/systemd/system/gerbera.service` (and `smbd.service`) into
   `/etc/systemd/system/srv-leon\x2dstorage.mount.wants/`; `systemctl add-wants` refuses the
   generated fstab mount unit. Then reload systemd, unmask, enable and start `gerbera.service`.
   Disable `minidlna.service` if it served the same folder.
4. On the TV, open the media player app or VLC → Local network and select the server.
   VLC shows embedded MKV subtitles and plays DTS audio more reliably than built-in players.
   A changed file name or new poster appears after the next index rebuild.

### Movie library: names, posters and the phone

`sharing/storage/library.py` keeps `PELICULAS` (one folder per movie, `Title (Year)`) tidy:

- **Names.** A video or folder added at the top of the library with another name, such as
  `The.Movie.2019.2160p.WEB-DL.x265-GRP.mkv`, is parsed and checked against
  [TMDB](https://www.themoviedb.org/). When TMDB confirms the title and year, the video and its
  subtitles move to `Title (Year)/Title (Year)[ - 4K|CAM].ext` with TMDB's Spanish title.
  Otherwise the upload stays where it is and **Storage → Movies → Need a name** lists it with a
  suggestion. Nothing is deleted or overwritten; every move is written to
  `/var/lib/leon-storage/moves.jsonl`. Uploads changed in the last 15 minutes are left alone,
  so a copy in progress is never moved.
- **Posters.** Each `Title (Year)` folder without `folder.jpg` gets the TMDB poster. Gerbera,
  Kodi, Finder, Windows and the phone show it. Put another image there as `folder.jpg` to
  replace a wrong one; existing posters are never overwritten.
- **Phone.** **Storage → Movies** shows every movie by poster, with recently added ones in a
  swipeable row, search, and Play or Download.

This product uses the TMDB API but is not endorsed or certified by TMDB.

1. Create a free TMDB account and copy its **API Read Access Token**. Store it as
   `/etc/leon-storage/tmdb-token`, owned by root, mode `0600`. Keep it out of Git.
2. Install `library.py` and `dlna-rebuild.sh` to `/usr/local/lib/leon-storage/` (root, `0644`),
   and `leon-storage-library.service`, `.timer` and `.path` to `/etc/systemd/system/`. In the
   service, set `User=` to the drive's owner account, the `uid=` in its exFAT fstab entry.
3. Try it on a few folders first:
   `sudo -u OWNER python3 -I /usr/local/lib/leon-storage/library.py /srv/leon-storage/PELICULAS --token-file TOKEN_COPY --limit 3`.
   Use a copy of the token the owner account can read, then delete the copy.
4. `sudo systemctl daemon-reload && sudo systemctl enable --now leon-storage-library.path leon-storage-library.timer`
   and `sudo systemctl enable leon-storage-library.service`. A pass runs when the drive is
   connected, when something is added to `PELICULAS`, and every hour. After a pass that renamed
   or added posters, the Gerbera index is rebuilt (the TV list is empty for a minute or two);
   while a TV is streaming, the rebuild waits for a later pass.

### Eject the drive from the phone

With the eject service installed, the drive card shows **Eject** for a USB drive. It stops
Gerbera, Samba and the movie library service, unmounts the drive and powers the disk down; the
panel then says it is safe to unplug. If something still uses the drive, nothing is unplugged
and everything starts again. Connecting the drive again mounts it and starts the services.

Install `sharing/storage/eject.sh` to `/usr/local/lib/leon-storage/` (root, `0644`) and
`leon-storage-eject.path` and `.service` to `/etc/systemd/system/`, then
`sudo systemctl daemon-reload && sudo systemctl enable --now leon-storage-eject.path`. The panel
only creates a request file in its own state directory; the root service does the work.

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
