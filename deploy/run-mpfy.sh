#!/bin/bash
# MPfy restart loop, inside the chroot as the Termux uid (started by mpfy-boot.sh).
# Lives at /home/mpfy/run-mpfy.sh in the chroot. Code in /opt/mpfy, data in
# /home/mpfy/data. Any exit of the server (crash, kill, update) restarts it after 10 s.

umask 077

export MPFY_DATA=/home/mpfy/data
export MPFY_NAME="Mi A2"
export MPFY_PORT=8091
export MPFY_ADMIN_PORT=8092
# The memory cards, bound by mpfy-boot.sh (the server finds them there).
export MPFY_CARDS=/home/mpfy/cards
# Card calls are limited to 2 at a time: 8 threads leave the rest for internal memory.
export UV_THREADPOOL_SIZE=8

stamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

if ! cd /opt/mpfy; then
  echo "$(stamp) run-mpfy: /opt/mpfy missing, nothing to run"
  exit 1
fi
mkdir -p "$MPFY_DATA"

while true; do
  echo "$(stamp) run-mpfy: starting the server"
  # A small heap is plenty (the library index is a few MB; ffmpeg runs as its own
  # process) and leaves the phone's memory to the fleet node.
  node --max-old-space-size=160 server/index.mjs
  code=$?
  echo "$(stamp) run-mpfy: server exited with code $code, restarting in 10 s"
  sleep 10
done
