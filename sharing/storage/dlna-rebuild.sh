#!/bin/sh
# Rebuild the Gerbera index after the movie library changed, so new names and posters appear.
# A rebuild restarts the server, so while a TV is streaming it waits for the next pass.
set -eu
changed=/run/leon-storage-library/changed
pending=/var/lib/leon-storage/rebuild-pending
[ -e "$changed" ] && touch "$pending"
[ -e "$pending" ] || exit 0
systemctl -q is-active gerbera || exit 0
port=$(sed -n 's#.*<port>\([0-9]*\)</port>.*#\1#p' /etc/gerbera/config.xml | head -n 1)
if [ -n "$(ss -Htn state established "( sport = :${port:-8200} )" 2>/dev/null)" ]; then
  echo "a TV is streaming; index rebuild postponed"
  exit 0
fi
systemctl stop gerbera
rm -f /var/lib/gerbera/gerbera.db /var/lib/gerbera/gerbera.db-journal
systemctl start gerbera
rm -f "$pending"
echo "index rebuilt"
