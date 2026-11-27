#!/bin/sh
# Safely eject the household USB drive when the LEÓN Home panel asks (leon-storage-eject.path).
# Stops everything bound to the mount (Gerbera, Samba, the movie library), unmounts it and
# powers the disk down, then answers the panel in EJECT_RESULT. Runs as root.
set -u
MOUNT=/srv/leon-storage
UNIT='srv-leon\x2dstorage.mount'
RESULT=/var/lib/leon-overview/eject-result

answer() {
  printf '{"status":"%s","message":"%s"}\n' "$1" "$2" >"$RESULT.part"
  chmod 0644 "$RESULT.part"
  mv -f "$RESULT.part" "$RESULT"
  echo "eject: $1"
}

if ! findmnt -rn "$MOUNT" >/dev/null; then
  answer notMounted 'The drive is not connected.'
  exit 0
fi
disk=$(lsblk -no PKNAME "$(findmnt -rno SOURCE "$MOUNT")" | head -n 1)
if [ -z "$disk" ] || [ "$(lsblk -dno TRAN "/dev/$disk")" != usb ]; then
  answer unavailable 'Ejecting is not set up on this LEÓN Home.'
  exit 0
fi
systemctl stop leon-storage-library.path leon-storage-library.service 2>/dev/null || true
sync
# Stopping the mount first stops the units bound to it (BindsTo=).
if ! systemctl stop "$UNIT" || findmnt -rn "$MOUNT" >/dev/null; then
  systemctl start "$UNIT" gerbera.service smbd.service leon-storage-library.path 2>/dev/null || true
  answer busy 'Something is still using the drive. Close it on the other devices and try again.'
  exit 0
fi
if ! echo 1 >"/sys/block/$disk/device/delete"; then
  answer failed 'The drive could not be ejected.'
  exit 0
fi
answer ejected 'The drive was ejected. You can unplug it now.'
