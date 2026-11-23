#!/system/bin/sh
# The real-tool checks on the Mi A2, run by hand as root after an install (see
# README, "The real-tool check"). Expects in /data/local/tmp/mpfy-check/:
#   test/          the repository's test folder
#   nea/           the NEA album (17 m4a and cover.jpg)
#   fixtures/      what deploy/tool-fixtures.mjs made on the PC (nea.rar,
#                  nea-enc.rar, dict1536.7z)
# Copies the installed code and the test into /home/mpfy/tool-check in the
# chroot and runs test/unit-real-tools.test.mjs there as the Termux uid, at the
# lowest priority, with ffmpeg, fpcalc and /usr/local/bin/7zz. The running server,
# its data and the fleet node are left alone.
set -e
R=/data/galeon/rootfs
C=/data/local/tmp/mpfy-check
W=/home/mpfy/tool-check
CAP=${MPFY_7Z_MEM_BYTES:-536870912}

if ! grep -q " $R/proc " /proc/mounts; then
  echo "The chroot is not mounted ($R/proc): the fleet node mounts it at boot."
  exit 1
fi
for f in test/unit-real-tools.test.mjs test/helpers.mjs nea fixtures; do
  if [ ! -e "$C/$f" ]; then
    echo "Missing $C/$f: copy it from the PC first."
    exit 1
  fi
done
for tool in ffmpeg fpcalc /usr/local/bin/7zz prlimit; do
  if ! chroot $R /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin sh -c "command -v $tool" >/dev/null; then
    echo "Missing $tool in the chroot: run deploy/push-to-phone.sh first."
    exit 1
  fi
done

U=$(stat -c %u /data/data/com.termux)
rm -rf "$R$W"
mkdir -p "$R$W/app"
cp -r $R/opt/mpfy/. "$R$W/app/"
cp -r $C/test "$R$W/app/test"
cp -r $C/nea "$R$W/nea"
cp -r $C/fixtures "$R$W/fixtures"
mkdir -p "$R$W/work"
chown -R $U:$U "$R$W"
chmod 700 "$R$W"

echo "== real-tool checks (this takes a while)"
set +e
chroot $R /usr/bin/setpriv --reuid=$U --regid=$U --groups=3003,3004 \
  /usr/bin/env -i HOME=/home/mpfy LANG=C.UTF-8 PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin \
  MPFY_REAL_TOOLS=1 MPFY_FFMPEG=ffmpeg MPFY_FPCALC=fpcalc MPFY_7Z=/usr/local/bin/7zz MPFY_7Z_MEM_BYTES=$CAP \
  MPFY_NEA_DIR=$W/nea MPFY_TOOL_FIXTURES=$W/fixtures MPFY_TOOL_WORK=$W/work \
  sh -c "cd $W/app && nice -n 19 node --test --test-concurrency=1 test/unit-real-tools.test.mjs" > "$R$W/tool-check.log" 2>&1
code=$?
set -e
grep -E '^# (tests|pass|fail)|^not ok|^# .*(BER|dB|MiB|7-Zip)' "$R$W/tool-check.log"
echo "exit $code (full log: $R$W/tool-check.log)"

echo "== the running server's tools"
chroot $R /usr/bin/curl -s http://127.0.0.1:8091/api/health
echo
rm -rf "$R$W/app" "$R$W/work" "$R$W/nea" "$R$W/fixtures"
exit $code
