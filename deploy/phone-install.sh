#!/system/bin/sh
# Installs or updates the MPfy source on the Mi A2. Runs on the phone as root, from
# /data/local/tmp/mpfy/ (push-to-phone.sh copies everything there and starts it).
# Safe to run again: music, keys and paired devices in /home/mpfy/data are never touched.
set -e
umask 022
R=/data/galeon/rootfs
T=/data/local/tmp/mpfy
SERVER="node --max-old-space-size=160 server/index.mjs"
# 7-Zip's own build for 7z and RAR archives (the www.7-zip.org download page links
# it on GitHub). Ubuntu's 7zip is 23.01, too old to open members' archives.
SEVENZIP_VERSION=26.06
SEVENZIP_URL=https://github.com/ip7z/7zip/releases/download/26.06/7z2606-linux-arm64.tar.xz
SEVENZIP_SHA256=edcc408aacce77da5223728f2eceb5e9f6dc713b8a9df934ad21e2a7f7560627

chroot_sh() {
  chroot $R /usr/bin/env -i HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/node22/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin sh -c "$1"
}

if ! grep -q " $R/proc " /proc/mounts; then
  echo "The chroot is not mounted ($R/proc): the fleet node mounts it at boot."
  exit 1
fi

# The "version" of a package.json.
version_of() {
  sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

# True when version $1 is lower than version $2 (numbers between dots).
version_lower() {
  a=$1
  b=$2
  while [ -n "$a$b" ]; do
    x=${a%%.*}
    y=${b%%.*}
    case "$a" in *.*) a=${a#*.} ;; *) a= ;; esac
    case "$b" in *.*) b=${b#*.} ;; *) b= ;; esac
    x=$(echo "$x" | tr -cd 0-9)
    y=$(echo "$y" | tr -cd 0-9)
    [ "${x:-0}" -lt "${y:-0}" ] && return 0
    [ "${x:-0}" -gt "${y:-0}" ] && return 1
  done
  return 1
}

echo "== data for an older version"
# Going back to an older MPfy (a lower version than the one installed, or code that
# keeps no logs): the code installed now writes db.json and users/*.json from its
# logs, with the server stopped, so the older one finds today's data. If that
# fails nothing is replaced and the installed server starts again.
rm -rf $T/incoming
mkdir -p $T/incoming
tar -xf $T/mpfy.tar -C $T/incoming
if [ -f $R/opt/mpfy/server/userlog.mjs ] && { [ ! -f $T/incoming/server/userlog.mjs ] || version_lower "$(version_of $T/incoming/package.json)" "$(version_of $R/opt/mpfy/package.json)"; }; then
  pkill -f /home/mpfy/run-mpfy.sh || true
  pkill -f "$SERVER" || true
  sleep 2
  U=$(stat -c %u /data/data/com.termux)
  if ! chroot $R /usr/bin/setpriv --reuid="$U" --regid="$U" --groups=3003,3004 \
    /usr/bin/env -i HOME=/home/mpfy LANG=C.UTF-8 MPFY_DATA=/home/mpfy/data PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin \
    sh -c "cd /opt/mpfy && node --max-old-space-size=160 server/index.mjs export-compat"; then
    echo "export-compat failed: nothing was replaced, the installed server starts again."
    sh /data/adb/service.d/mpfy-boot.sh
    exit 1
  fi
else
  echo "not needed"
fi

echo "== code"
mkdir -p $R/opt/mpfy
tar -xf $T/mpfy.tar -C $R/opt/mpfy
# tar from Git Bash records the Windows uid: the code belongs to root.
chown -R 0:0 $R/opt/mpfy

echo "== dependencies"
chroot_sh "cd /opt/mpfy && nice -n 19 npm ci --omit=dev --no-audit --no-fund --loglevel=error"

echo "== ffmpeg, fpcalc"
if chroot_sh "command -v ffmpeg && command -v fpcalc" >/dev/null 2>&1; then
  echo "already there"
else
  # Both packages live in universe.
  if ! chroot_sh "grep -qs '^Components:.*universe' /etc/apt/sources.list.d/ubuntu.sources"; then
    echo "The chroot's apt sources lack universe: Components in /etc/apt/sources.list.d/ubuntu.sources must list main universe multiverse."
    exit 1
  fi
  # apt downloads as the _apt user, and on Android only the inet group may use the
  # network: download as root for these two commands.
  chroot_sh "nice -n 19 apt-get -o APT::Sandbox::User=root update -q && nice -n 19 apt-get -o APT::Sandbox::User=root install -y -q --no-install-recommends ffmpeg libchromaprint-tools"
fi

echo "== tzdata"
# Local time in the log lines: bash's date needs the zone files (Node has its own).
if chroot_sh "test -f /usr/share/zoneinfo/Etc/UTC"; then
  echo "already there"
else
  chroot_sh "nice -n 19 apt-get -o APT::Sandbox::User=root update -q && nice -n 19 apt-get -o APT::Sandbox::User=root install -y -q --no-install-recommends tzdata"
fi

echo "== 7-Zip"
if chroot_sh "command -v 7zz && 7zz i | grep -q '7-Zip.* $SEVENZIP_VERSION '" >/dev/null 2>&1; then
  echo "already there"
else
  # Checked against the pinned SHA-256 before anything is unpacked.
  chroot_sh "set -e; d=\$(mktemp -d); cd \$d; curl -fsSL -o 7z.tar.xz $SEVENZIP_URL; echo '$SEVENZIP_SHA256  7z.tar.xz' | sha256sum -c -; tar -xJf 7z.tar.xz 7zz; install -o root -g root -m 0755 7zz /usr/local/bin/7zz; cd /; rm -rf \$d"
  chroot_sh "7zz i | head -n 3"
fi

echo "== home"
U=$(stat -c %u /data/data/com.termux)
mkdir -p $R/home/mpfy/data
# Never recursive over the whole home: home/mpfy/cards is a bind of Android's own card folder,
# which must stay root's (and a card's files cannot change owner).
chown $U:$U $R/home/mpfy
chown -R $U:$U $R/home/mpfy/data
chmod 700 $R/home/mpfy $R/home/mpfy/data

echo "== scripts"
cp $T/run-mpfy.sh $R/home/mpfy/run-mpfy.sh
chown root:root $R/home/mpfy/run-mpfy.sh
chmod 755 $R/home/mpfy/run-mpfy.sh
cp $T/mpfy-boot.sh /data/adb/service.d/mpfy-boot.sh
chown root:root /data/adb/service.d/mpfy-boot.sh
chmod 755 /data/adb/service.d/mpfy-boot.sh

echo "== start"
# The loop reads run-mpfy.sh once: stop it with the server, then start both again.
pkill -f /home/mpfy/run-mpfy.sh || true
pkill -f "$SERVER" || true
sleep 2
sh /data/adb/service.d/mpfy-boot.sh
sleep 15
tail -n 6 /data/galeon/mpfy.log
rm -rf $T
