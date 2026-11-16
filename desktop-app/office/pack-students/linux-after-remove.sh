#!/bin/bash
# generated for AeroGyan for Students — on remove / purge only (an upgrade keeps the launchers)
case "$1" in remove|purge|0)
  rm -f /usr/share/applications/tech.aerogyan.pack.students.*.desktop
  rm -f '/usr/bin/aerogyan-pack-students'
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true ;;
esac
exit 0
