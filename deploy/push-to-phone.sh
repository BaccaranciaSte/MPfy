#!/bin/bash
# From the PC (Git Bash), with the phone on USB and USB debugging on:
#   bash deploy/push-to-phone.sh
# Sends the source code to the phone and installs or updates it there.
# With more than one phone attached: MPFY_PHONE=<serial from "adb devices"> bash deploy/push-to-phone.sh
set -e
cd "$(dirname "$0")/.."
# Git Bash turns /data/... into C:/Program Files/Git/data/...: not for adb.
export MSYS_NO_PATHCONV=1
ADB="${ADB:-adb}"
phone() { "$ADB" ${MPFY_PHONE:+-s "$MPFY_PHONE"} "$@"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# --force-local: a path like C:/... is a file, not a remote host.
tar --force-local -cf "$tmp/mpfy.tar" package.json package-lock.json server transport web/js/genres.js web/js/loudness.js
# adb on Windows wants a Windows path for the archive (cygpath exists only in Git Bash).
archive="$tmp/mpfy.tar"
if command -v cygpath >/dev/null; then archive=$(cygpath -m "$archive"); fi
phone shell "rm -rf /data/local/tmp/mpfy && mkdir -p /data/local/tmp/mpfy"
phone push "$archive" deploy/phone-install.sh deploy/run-mpfy.sh deploy/mpfy-boot.sh /data/local/tmp/mpfy/ >/dev/null
# The whole command in double quotes: otherwise only its first word runs as root.
phone shell "su -c 'sh /data/local/tmp/mpfy/phone-install.sh'"
