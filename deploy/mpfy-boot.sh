#!/system/bin/sh
umask 022
# MPfy launcher for the Mi A2 Lite: /data/adb/service.d/mpfy-boot.sh (Magisk, root, at boot).
#
# It waits (at most 10 minutes) for the chroot mounts that the fleet node's own boot
# script makes (/data/galeon/rootfs/proc and /dev). It never mounts anything itself:
# the node owns the chroot, MPfy only uses it. Then it starts the restart loop
# /home/mpfy/run-mpfy.sh inside the chroot as the Termux uid, low priority, with an
# empty environment (plus the phone's time zone, so the log lines carry local
# time), appending everything to /data/galeon/mpfy.log.

R=/data/galeon/rootfs
LOG=/data/galeon/mpfy.log
SCRIPT=/home/mpfy/run-mpfy.sh
MAX_WAIT=600

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') mpfy-boot: $*" >> "$LOG"
}

mounted() {
  grep -q " $1 " /proc/mounts
}

termux_uid() {
  # /data/data is credential-encrypted storage: before the first unlock its names
  # are not readable, the device-encrypted twin is. Same uid either way.
  stat -c %u /data/data/com.termux 2>/dev/null || stat -c %u /data/user_de/0/com.termux 2>/dev/null
}

# Keep the log from growing across months of uptime: rotate at boot.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv -f "$LOG" "$LOG.1"
fi

# One launcher at a time (a second one while the first is still waiting would start
# two loops). /dev is a tmpfs, so a stale lock never survives a reboot.
LOCK=/dev/.mpfy-boot.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another launcher is already waiting, nothing to do"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Started again by hand while the loop runs? Nothing to do.
if pgrep -f "$SCRIPT" >/dev/null 2>&1; then
  log "already running, nothing to do"
  exit 0
fi

waited=0
uid=""
while :; do
  if mounted "$R/proc" && mounted "$R/dev"; then
    uid="$(termux_uid)"
    case "$uid" in
      ''|*[!0-9]*) uid="" ;;
    esac
    if [ -n "$uid" ] && [ "$uid" -ge 10000 ]; then
      break
    fi
  fi
  if [ "$waited" -ge "$MAX_WAIT" ]; then
    log "chroot mounts or Termux uid not ready after $MAX_WAIT s, giving up (proc: $(mounted "$R/proc" && echo ok || echo missing), dev: $(mounted "$R/dev" && echo ok || echo missing), uid: '${uid}')"
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

# The phone's time zone for the server and the loop. Anything odd becomes UTC.
TZ_NAME="$(getprop persist.sys.timezone 2>/dev/null)"
case "$TZ_NAME" in
  ''|*[!A-Za-z0-9_/+-]*) TZ_NAME=UTC ;;
esac

if [ ! -x "$R/usr/bin/setpriv" ] || [ ! -f "$R$SCRIPT" ]; then
  log "missing $R/usr/bin/setpriv or $R$SCRIPT, not starting"
  exit 1
fi

# The memory cards: Android's raw mounts, bound once into the chroot as a slave
# (cards inserted later appear by themselves, nothing goes back). The mount point
# is root's: with nothing bound the server cannot create anything in it. The
# server gets group media_rw (1023) to read and write the card it is given.
CARDS="$R/home/mpfy/cards"
if ! mounted "$CARDS"; then
  mkdir -p "$CARDS" && chown 0:0 "$CARDS" && chmod 755 "$CARDS"
  # Toybox binds a folder without what is mounted inside it, and needs a device word before the
  # folder to change the propagation (with one argument it looks the folder up in /etc/fstab).
  # So the cards mounted already are bound one by one; a card inserted later reaches the folder
  # through the slave.
  if mount -o bind /mnt/media_rw "$CARDS" && mount -o rslave none "$CARDS"; then
    for d in /mnt/media_rw/*; do
      if [ -d "$d" ] && mounted "$d"; then mount -o bind "$d" "$CARDS"/"${d##*/}"; fi
    done
    log "cards folder bound"
  else
    log "cards folder not bound: the source runs without a card"
  fi
fi

log "starting (uid $uid, waited $waited s, TZ $TZ_NAME)"
nohup chroot "$R" /usr/bin/setpriv --reuid="$uid" --regid="$uid" --groups=3003,3004,1023 \
  /usr/bin/env -i HOME=/home/mpfy LANG=C.UTF-8 TZ="$TZ_NAME" PATH=/usr/local/bin:/usr/bin:/bin \
  nice -n 10 /bin/bash "$SCRIPT" >> "$LOG" 2>&1 < /dev/null &
exit 0
