# MPfy source on a rooted Android phone

The source server runs in an Ubuntu arm64 chroot on the phone, already set up at `/data/galeon/rootfs`
with its `/proc` and `/dev` mounted at boot by the chroot's own boot script (MPfy only waits for
those mounts). It runs in its own directories, as its own process, at low priority (`nice -n 10`,
and every ffmpeg, fpcalc and 7-Zip job at `nice -n 19`), under the Termux uid, on ports 8091 (API)
and 8092 (admin health), both bound to 127.0.0.1. It shares nothing with other services in the same
chroot: no files, no ports, no mounts but `/home/mpfy/cards`. Without such a chroot, use the Termux
way at the end of this file.

| What | Where (outside the chroot) | Inside the chroot |
|---|---|---|
| Code (server, transport, node_modules) | `/data/galeon/rootfs/opt/mpfy` | `/opt/mpfy` |
| Data (library, covers, transcodes, library.log (the library; a db.json is kept only for older code), keys.json, pairing.json, clients.json, and the people: source.json, profiles.json, users/ (one `<key>.log` per person), recovery/, social/ (one file per person; an older social.json is split into it at start), chat/, comments/, lyrics/) | `/data/galeon/rootfs/home/mpfy/data` | `/home/mpfy/data` |
| Restart loop | `/data/galeon/rootfs/home/mpfy/run-mpfy.sh` | `/home/mpfy/run-mpfy.sh` |
| Music on the memory card | `/mnt/media_rw/<scheda>/MPfy` | `/home/mpfy/cards/<scheda>/MPfy` |
| Boot launcher | `/data/adb/service.d/mpfy-boot.sh` | |
| Log | `/data/galeon/mpfy.log` (rotated at boot above 5 MB) | |
| 7-Zip | `/data/galeon/rootfs/usr/local/bin/7zz` | `/usr/local/bin/7zz` |

The loop sets `MPFY_DATA=/home/mpfy/data` and `MPFY_NAME="Mi A2"`. The name is used only at the very
first start: after that the source keeps its own name in `source.json`, and only its owner renames
it, from the app.

## Install and update

From the PC, in Git Bash, at the repository root, with the Mi A2 on USB (USB debugging on and
`adb` in the PATH, or `ADB=/path/to/adb.exe` in front):

```sh
bash deploy/push-to-phone.sh
```

With another phone plugged in too, name the source phone by its serial from `adb devices`: `MPFY_PHONE=<serial> bash deploy/push-to-phone.sh`.
The same command installs the first time and updates afterwards. It packs `server/`, `transport/`
and the package files, copies them with the scripts to `/data/local/tmp/mpfy/`, and runs
`deploy/phone-install.sh` there as root, which:

0. when the incoming code is older than the installed one (or keeps no logs), stops the server
   and runs `export-compat` with the INSTALLED code, so the older one finds today's data; if that
   fails nothing is replaced and the installed server starts again;
1. unpacks the code into `/opt/mpfy` and makes it root's (Git Bash's tar records the Windows uid);
2. runs `npm ci --omit=dev` in the chroot (npm is in `/opt/node22/bin`; the native modules, among
   them `sodium-native`, ship prebuilt `linux-arm64` binaries, nothing is compiled);
3. installs ffmpeg and fpcalc with apt when one is missing (`ffmpeg libchromaprint-tools`). Both are
   in universe: the chroot's `/etc/apt/sources.list.d/ubuntu.sources` must say
   `Components: main universe multiverse`, and the script stops with a message if universe is
   missing. apt downloads as its `_apt` user, and on Android only the inet group may open sockets,
   so these two commands use `-o APT::Sandbox::User=root` ("Temporary failure resolving"
   otherwise);
4. installs `tzdata` when the chroot has no `/usr/share/zoneinfo/Etc/UTC` (its own step, even when
   ffmpeg and fpcalc are already there): the log lines carry the phone's local time, and bash's
   `date` needs the zone files for that;
5. installs 7-Zip's own `7zz` (26.06, from the 7-Zip download page) when it is missing or older:
   the archive is checked against the SHA-256 pinned in the script before anything is unpacked,
   and `7zz` goes to `/usr/local/bin` (root's, 0755). It opens 7z and RAR on its own. Ubuntu's
   `7zip` (23.01) is not used: it has bugs a crafted archive can exploit;
6. makes `/home/mpfy` and its `data/` the Termux uid's, mode 0700;
7. puts `run-mpfy.sh` (root's, the Termux uid can run it but not change it) and the boot
   launcher `mpfy-boot.sh` in place;
8. stops the loop and the server if they run, starts them again through the launcher (Magisk
   does the same at boot) and shows the end of the log: `MPfy "Mi A2" listening`, the server
   public key, the tools found (fpcalc, 7-Zip with RAR) and, once the DHT answers, `P2P ready`.

Check the tools afterwards, from the phone itself:

```sh
chroot /data/galeon/rootfs /usr/bin/curl -s http://127.0.0.1:8091/api/health
```

It must say `"fpcalc": true` and `"archives": {"zip": true, "sevenZip": true, "rar": true}`.
Without ffmpeg the server still works, serving originals only (`"ffmpeg": false`); without fpcalc it
finds duplicates by file hash only; without 7-Zip it refuses 7z and RAR archives (ZIP always works).
A tool installed later is used after a restart. Music, keys, people and paired devices in
`/home/mpfy/data` are never touched by an update.

Commands by hand, from Git Bash: put the whole phone command in double quotes,
`adb shell "su -c '...'"`. With `adb shell su -c '... && ...'` only the first command runs as
root. Also `export MSYS_NO_PATHCONV=1`, or Git Bash rewrites `/data/...` arguments into Windows
paths.

## The commands on the phone

Every command runs as the Termux uid like the server (so the files it may create keep the right
owner), from a root shell on the phone (`adb shell`, then `su`), with this wrapper:

```sh
U=$(stat -c %u /data/data/com.termux)
chroot /data/galeon/rootfs /usr/bin/setpriv --reuid=$U --regid=$U --groups=3003,3004,1023 /usr/bin/env -i HOME=/home/mpfy TZ=$(getprop persist.sys.timezone) PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin MPFY_DATA=/home/mpfy/data sh -c 'cd /opt/mpfy && node server/index.mjs code'
```

Replace `code` with the command:

| Command | Does |
|---|---|
| `node server/index.mjs code` | prints the pairing code (works while the server runs); with no owner yet, it also opens the owner window for 30 minutes |
| `node server/index.mjs rotate-code` | makes a new code; the old one stops admitting at once; paired devices keep working |
| `node server/index.mjs clients` | lists the paired devices (key, name, date, connected); `legacy` marks a device paired before profiles, which acts as the owner |
| `node server/index.mjs revoke <publicKey>` | removes a device and closes its connections |
| `node server/index.mjs profiles` | lists the people: profile id, name, owner or member, and the name and date of each of their devices |
| `node server/index.mjs claim [minutes]` | opens the owner window (30 minutes, at most 1440): the first new profile that adds the source in that time becomes its owner |
| `node server/index.mjs set-owner <profileId> [--move-data]` | makes that profile the owner; with `--move-data` the previous owner's playlists, likes and tracks move to it |
| `node server/index.mjs remove-profile <profileId>` | removes a person: devices, playlists, likes, recovery; their tracks stay |
| `node server/index.mjs details on\|off` | turns the track details from the network on or off (the owner can do it from the app too) |
| `node server/index.mjs card` | lists the memory cards found and the one in use, with its state |
| `node server/index.mjs card use [<scheda>]` | puts the music on that card: the new music goes there, the music already here moves there in the background (the card is never formatted; with the server stopped, at its next start) |
| `node server/index.mjs card off` | brings the music back to internal memory, then stops using the card (refused while internal memory lacks room) |
| `node server/index.mjs card forget [--yes]` | for a card that broke or was lost: its tracks leave the library, the files on the card stay |
| `node server/index.mjs export-compat` | with the server stopped, writes `db.json` and every `users/<key>.json` from the logs, for an older MPfy; `phone-install.sh` runs it by itself before installing older code |
| `node server/index.mjs acoustid-key <key>` | uses your own AcoustID key on this source; `acoustid-key --default` goes back to the built-in one |

The commands ask the running server (127.0.0.1:8091) first, so changes apply at once; with the
server stopped they edit the files, and the server finishes them (moving data) at its next start.

## The pairing code and the owner

Each source has ONE permanent pairing code (`MPFY-XXXX-XXXX-...`), made at first start and kept in
`pairing.json`. Type it in the app, or start the app with it:
`adb shell am start -n com.baccarancia.mpfy/.MainActivity --es code "MPFY-..."` (on the phone that
runs the app). The code works any number of times, for any device, until it is changed. Any
paired device can also show it (Impostazioni, Fonti musicali, Mostra codice): the code is how
another person joins the source too.

Each person has a profile. The owner touches everything on the source; the others (members) touch
only their own things: their devices, playlists, likes, and the tracks they uploaded. A source gets
its owner only in one of two ways, never by itself:

- a device paired before profiles (a `legacy` key in `clients`) adds the source in the new app: its
  profile becomes the owner, and the playlists and likes from before become its own;
- a new profile adds the source while the owner window is open (`claim`, or `code` while there is no
  owner). The window is opened only on the source itself, by whoever deploys it, and closes at the
  first claim.

### First start with profiles

After the update, once the PC test client is revoked, no device is left. In this order:

1. Run `node server/index.mjs claim` (with the wrapper above). It says how many minutes the window
   stays open.
2. Within 30 minutes, on the owner's phone with the new app: add the source FIRST (Inizia, the name,
   the code, then "Dai un nome a questa fonte").
3. Run `node server/index.mjs profiles`: that profile must show as `proprietario` before any other
   device pairs or adds the source.
4. Only then a PC test with client-node, bringing the owner's profile with its code ("Ho già un
   profilo") or as a member.

A wrong profile claimed first: `node server/index.mjs set-owner <right profileId> --move-data`,
then `node server/index.mjs remove-profile <wrong profileId>`. The owner's device already added as
a member: `set-owner <its profileId>` (`profiles` shows the names and devices to find it). Every
pre-profiles device lost while their keys are still listed: `revoke` them, run `claim`, add the
source from the new phone.

## Track details from the network

When a track arrives without a title, artist, album or cover in its tags, the source looks it up:
its fingerprint goes to AcoustID, the match to MusicBrainz, the cover comes from the Cover Art
Archive. Only what is missing gets filled, never a tag the file has and never something somebody
edited by hand. What leaves the phone: the fingerprint and the track length, MusicBrainz ids, and
for a track AcoustID doesn't know, its title and artist as a search (only when the name looks like a
real title, never "traccia02"). Never a profile, a device, a path or the source's name. It is on by
default; the owner turns it off in the app (Impostazioni, Fonti musicali, the source, "Cerca i
dettagli in rete") or with `node server/index.mjs details off`. The first start after the update
also looks up the tracks already there, a few seconds each, in the background.

Track details come from AcoustID and MusicBrainz. The AcoustID key built into the source is for
non-commercial use: any other use needs your own key (`node server/index.mjs acoustid-key <key>`).

## Lyrics

A track's lyrics come from its own tags first (read at upload; for the tracks already there, once,
in the background after the update), then from an .lrc file beside it in an uploaded folder or
archive, or put on it from the app. With the same "Cerca i dettagli in rete" switch on, a track
still without them is looked up on LRCLIB: one request every 1.5 s at most, carrying only its
title, artist, album and length, with a plain `MPfy/<version>` as the client name. Never a
profile, a device, a path or the source's name. A miss is asked again after 30 days, or when the
title, artist, album or length change. The lyrics live in `lyrics/`: `index.ndjson` gets one short
line per change (it is rewritten whole only when its old lines outnumber the live ones) and each
text is a file of its own. Comments are in `comments/`, one file per track that has any.

## Health

From the phone itself (the admin port is never forwarded):

```sh
chroot /data/galeon/rootfs /usr/bin/curl -s http://127.0.0.1:8092/admin/health
```

It also shows the 7-Zip version, the fingerprints still to make and the lookups (`details`: queued,
applied, nothing found, ambiguous, failed, and whether AcoustID took the key), the lyrics (`lyrics`:
queued, waiting for a later try, tags still to read, tracks with an entry, tracks showing lyrics) and
how many comments the source holds.

## The real-tool check

The same checks the PC runs with the real ffmpeg, fpcalc and 7-Zip on the NEA album, run on the
phone by hand after an install. On the PC, once (Git Bash, at the repository root):

```sh
node deploy/tool-fixtures.mjs --nea "<album folder>" --out .logs/fixtures --7z <7z> --rar <rar>
mkdir -p .logs/check && cp -r test deploy/tool-check.sh .logs/check/ && cp -r "<album folder>" .logs/check/nea && cp -r .logs/fixtures .logs/check/fixtures
adb push .logs/check /data/local/tmp/mpfy-check
adb shell "su -c 'sh /data/local/tmp/mpfy-check/tool-check.sh'"
```

`tool-fixtures.mjs` makes what the phone cannot: the album as RAR (it needs a `rar` command) and a 7z
whose header asks for a 1536 MiB dictionary. `tool-check.sh` copies the installed code and the test
into `/home/mpfy/tool-check`, runs `test/unit-real-tools.test.mjs` there as the Termux uid at
`nice -n 19` (the running server and anything else on the phone are left alone; it takes a while), keeps the
log in `/home/mpfy/tool-check/tool-check.log`, and prints `/api/health`. It checks that the
legit archives fit under `MPFY_7Z_MEM_BYTES` (the memory cap 7-Zip runs under, default 512 MiB) and
that the 1536 MiB dictionary is refused under it.

## An install from before the rename

An older install used other paths and other script names. Stop its loop and remove its launcher
from `/data/adb/service.d/` before starting this one (never two servers on 8091). To keep the
server identity and the devices already paired, copy its `keys.json` and `clients.json` into
`/data/galeon/rootfs/home/mpfy/data/` before the first start, then run step 5 again (owner and
modes). Its one-time pairing codes no longer exist: the permanent code replaces them.

## Updating

`bash deploy/push-to-phone.sh` again (see above). The first start of a version with profiles moves
the data by itself: the playlists, likes and recents from before become the owner's, and every
device paired before acts as the owner until the owner claims (see above).

## Removing

```sh
adb shell "su -c 'rm /data/adb/service.d/mpfy-boot.sh; pkill -f /home/mpfy/run-mpfy.sh; pkill -f \"server/index.mjs\"'"
adb shell "su -c 'rm -r /data/galeon/rootfs/opt/mpfy /data/galeon/rootfs/usr/local/bin/7zz'"
# the music and the keys: only if you really mean it
# adb shell "su -c 'rm -r /data/galeon/rootfs/home/mpfy'"
```

## The memory card

The music can live on the phone's memory card as Android mounts it (FAT32 or exFAT, never
formatted). The boot launcher binds `/mnt/media_rw` at `/home/mpfy/cards` once, as a slave
(a card inserted later appears by itself), and starts the server with group `media_rw` (1023);
`run-mpfy.sh` sets `MPFY_CARDS=/home/mpfy/cards` and `UV_THREADPOOL_SIZE=8`. The server only
offers the cards it finds: the owner chooses one in the app (source settings, "Scheda di
memoria") or with `card use`. Everything but the track files stays in internal memory. A card
taken out leaves its tracks in the library, not playable until it comes back with the same ids.
Before going back to an older MPfy, bring the music back with `card off` (`export-compat`
refuses while a card is used).

## A source without root (Termux)

The server runs in Termux itself, data in Termux's home, with no chroot and no boot script of
ours. The card folder is `/storage/<scheda>/Android/data/com.termux/files/MPfy`, which exists
once `termux-setup-storage` ran; the server finds it by itself (`MPFY_CARDS` unset). Uninstalling
Termux deletes that folder with the music in it. Ejecting the card kills the server, so it needs
a restart loop:

```sh
export MPFY_DATA=$HOME/mpfy-data UV_THREADPOOL_SIZE=8
cd $HOME/mpfy
while true; do node --max-old-space-size=160 server/index.mjs; sleep 10; done
```

## Notes

- `keys.json` is the server identity: keep a copy. Losing it means pairing every device again.
  A damaged `keys.json` stops the server (it never makes a new identity on its own).
- A damaged `pairing.json` is set aside as `pairing.json.corrupt-<ms>` and a new code is made:
  only the code changes.
- The library lives in `library.log`, an append-only log (each person's data in `users/<key>.log`
  the same way). A line broken in the middle ends the part that is trusted: what follows is kept
  as `<log>.cut-<ms>`. A `library.log` with no valid first line is set aside as
  `library.log.corrupt-<ms>` and the library is read again from `db.json` or, without one,
  rebuilt from the files in `library/` (tags re-read; its custom covers are lost; each person's
  playlists and likes live in `users/` and stay).
- A log knows the `db.json` (or `users/<key>.json`) it came from by size and modification time.
  When an older MPfy has written that file since, the log is kept aside as
  `<log>.replaced-<ms>` (never deleted) and the file read again. So a backup must be restored
  with its modification times kept, or the `.json` files deleted once the logs are trusted.
- `transcodes/` holds the Opus versions (low 48, normal 96, high 160 kbps), made one at a time in
  the background after each upload; it is capped at `MPFY_TRANSCODE_CAP_GB` (default 10), least
  recently streamed first out. Deleting it is always safe: originals are never touched.
- Uploads and background jobs keep a floor of free space on `/data`, which Android and every other
  app share: the larger of 2 GiB and 5% of the volume, or `MPFY_MIN_FREE_BYTES`. Below it uploads
  are refused ("Spazio esaurito") and transcodes wait.
- Running the server on a PC for development: `MPFY_P2P=0 MPFY_DATA=./data node server/index.mjs`,
  then `http://127.0.0.1:8091/api/health` (add `MPFY_WEB=../web` to serve a UI; `MPFY_FPCALC`,
  `MPFY_7Z` and `MPFY_FFMPEG` point at the tools).
