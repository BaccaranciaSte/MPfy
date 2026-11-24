// Static checks on the deploy notes and scripts (nothing is run on a phone here).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (name) => fs.readFileSync(new URL('../deploy/' + name, import.meta.url), 'utf8')
const readme = read('README.md')
const boot = read('mpfy-boot.sh')
const loop = read('run-mpfy.sh')
const install = read('phone-install.sh')
const push = read('push-to-phone.sh')
const check = read('tool-check.sh')
const fixtures = read('tool-fixtures.mjs')
// The old name, which must not survive anywhere (spelled in pieces so this file passes its own check).
const OLD_NAME = ['si', 'rena'].join('')

test('deploy: the code unpacked into /opt/mpfy goes back to root', () => {
  // Git Bash's tar stores the Windows uid/gid (197609) and tar running as root
  // restores it: right after the extraction the code must become root's.
  const lines = install.split('\n')
  const at = lines.findIndex((l) => /tar\s+-x/.test(l) && l.includes('$R/opt/mpfy'))
  assert.notEqual(at, -1, 'phone-install.sh unpacks the code into /opt/mpfy')
  const next = lines.slice(at + 1).find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  assert.match(next, /^chown -R 0:0 \$R\/opt\/mpfy$/, 'chown right after: ' + next)
})

test('deploy: names and paths', () => {
  assert.match(boot, /^#!\/system\/bin\/sh\numask 022\n/, 'umask 022 first')
  assert.match(boot, /^LOG=\/data\/galeon\/mpfy\.log$/m)
  assert.match(boot, /^SCRIPT=\/home\/mpfy\/run-mpfy\.sh$/m)
  assert.match(boot, /setpriv --reuid="\$uid" --regid="\$uid" --groups=3003,3004/)
  assert.match(boot, /nice -n 10 \/bin\/bash "\$SCRIPT"/)
  for (const line of boot.split('\n').filter((l) => /\bmount\s+-/.test(l))) assert.match(line, /"\$CARDS"/, 'the launcher mounts nothing but the cards folder: ' + line)
  assert.match(loop, /^export MPFY_DATA=\/home\/mpfy\/data$/m)
  assert.match(loop, /^export MPFY_NAME="Mi A2"$/m)
  assert.match(loop, /cd \/opt\/mpfy/)
  assert.match(readme, /\/data\/adb\/service\.d\/mpfy-boot\.sh/)
  assert.match(readme, /bash deploy\/push-to-phone\.sh/)
  assert.match(install, /npm ci --omit=dev/)
  assert.match(install, /apt-get -o APT::Sandbox::User=root install -y -q --no-install-recommends ffmpeg libchromaprint-tools"/)
  assert.doesNotMatch(install, /7zip-rar|install[^\n]* 7zip /, "Ubuntu's 7-Zip (23.01) is not installed")
  assert.match(install, /^sh \/data\/adb\/service\.d\/mpfy-boot\.sh$/m, 'started through the boot launcher')
  assert.match(push, /^export MSYS_NO_PATHCONV=1$/m)
  assert.match(push, /phone shell "su -c 'sh \/data\/local\/tmp\/mpfy\/phone-install\.sh'"/, 'the whole command runs as root')
  assert.match(readme, /node server\/index\.mjs code/)
  for (const [name, text] of [['README.md', readme], ['mpfy-boot.sh', boot], ['run-mpfy.sh', loop], ['phone-install.sh', install], ['push-to-phone.sh', push], ['tool-check.sh', check], ['tool-fixtures.mjs', fixtures]]) {
    assert.doesNotMatch(text, new RegExp(OLD_NAME + '_', 'i'), name + ' still uses the old environment variables')
    assert.doesNotMatch(text, /[\u2013\u2014]/, name + ' has an en or em dash')
  }
  assert.doesNotMatch(boot + loop + readme + install + push, new RegExp(OLD_NAME, 'i'), 'the deploy files no longer mention the old name')
})

test('deploy: shell scripts keep LF line endings', () => {
  assert.ok(!boot.includes('\r'), 'mpfy-boot.sh has CR characters')
  assert.ok(!loop.includes('\r'), 'run-mpfy.sh has CR characters')
  assert.ok(!install.includes('\r'), 'phone-install.sh has CR characters')
  assert.ok(!push.includes('\r'), 'push-to-phone.sh has CR characters')
  assert.ok(!check.includes('\r'), 'tool-check.sh has CR characters')
  assert.match(read('.gitattributes'), /\*\.sh text eol=lf/)
})

test("deploy: 7-Zip's own 7zz, 25.01 or later, its SHA-256 pinned and checked before unpacking", () => {
  const version = /^SEVENZIP_VERSION=(\d+)\.(\d+)$/m.exec(install)
  assert.ok(version, 'a pinned version')
  assert.ok(Number(version[1]) > 25 || (Number(version[1]) === 25 && Number(version[2]) >= 1), '25.01 or later')
  const tag = version[1] + version[2].padStart(2, '0')
  const url = 'SEVENZIP_URL=https://github.com/ip7z/7zip/releases/download/' + version[1] + '.' + version[2] + '/7z' + tag + '-linux-arm64.tar.xz'
  assert.ok(install.split('\n').includes(url), url)
  assert.match(install, /^SEVENZIP_SHA256=[0-9a-f]{64}$/m)
  const line = install.split('\n').find((l) => l.includes('7z.tar.xz') && l.includes('sha256sum'))
  assert.ok(line, 'the download line')
  assert.ok(line.indexOf('sha256sum -c') < line.indexOf('tar -xJf'), 'checked before unpacking')
  assert.match(line, /set -e;/, 'a failed check stops it')
  assert.ok(line.includes('install -o root -g root -m 0755 7zz /usr/local/bin/7zz'))
  assert.ok(install.includes("command -v 7zz && 7zz i | grep -q '7-Zip.* $SEVENZIP_VERSION '"), 'the "already there" test looks for 7zz')
  assert.ok(install.includes("grep -qs '^Components:.*universe'"), 'universe is checked, never edited')
})

test('deploy: the README walks the owner claim and the real-tool check', () => {
  for (const cmd of ['claim', 'profiles', 'set-owner <right profileId> --move-data', 'remove-profile <wrong profileId>']) {
    assert.ok(readme.includes('node server/index.mjs ' + cmd), cmd)
  }
  assert.ok(readme.includes('"fpcalc": true'))
  assert.ok(readme.includes('"archives": {"zip": true, "sevenZip": true, "rar": true}'))
  assert.ok(check.includes('MPFY_REAL_TOOLS=1'))
  assert.ok(check.includes('test/unit-real-tools.test.mjs'))
  assert.ok(check.includes('nice -n 19 node --test'))
  assert.ok(!check.includes('$R/opt/mpfy/test') && !/rm -rf "?\$R\/opt/.test(check), 'the installed code is only copied, never changed')
})

test('deploy: the boot launcher passes the phone\'s time zone, filtered, and logs it; the install has a tzdata step of its own', () => {
  assert.match(boot, /^TZ_NAME="\$\(getprop persist\.sys\.timezone 2>\/dev\/null\)"$/m)
  assert.ok(boot.includes("  ''|*[!A-Za-z0-9_/+-]*) TZ_NAME=UTC ;;"), 'empty or odd: UTC')
  assert.match(boot, /\/usr\/bin\/env -i HOME=\/home\/mpfy LANG=C\.UTF-8 TZ="\$TZ_NAME" PATH=/)
  assert.match(boot, /log "starting \(uid \$uid, waited \$waited s, TZ \$TZ_NAME\)"/)
  assert.ok(boot.indexOf('TZ_NAME=') < boot.indexOf('nohup chroot'))
  // tzdata: after the ffmpeg/fpcalc block (which skips apt when both are there), never inside it.
  const lines = install.split('\n')
  const tz = lines.indexOf('echo "== tzdata"')
  const ff = lines.indexOf('echo "== ffmpeg, fpcalc"')
  const seven = lines.indexOf('echo "== 7-Zip"')
  assert.ok(ff !== -1 && tz > ff && seven > tz, 'its own step, between ffmpeg/fpcalc and 7-Zip')
  const step = lines.slice(tz, seven).join('\n')
  assert.ok(step.includes('if chroot_sh "test -f /usr/share/zoneinfo/Etc/UTC"; then'))
  assert.ok(step.includes('apt-get -o APT::Sandbox::User=root update -q && nice -n 19 apt-get -o APT::Sandbox::User=root install -y -q --no-install-recommends tzdata'))
  const ffStep = lines.slice(ff, tz).join('\n')
  assert.ok(!ffStep.includes('tzdata'))
  assert.match(ffStep, /^fi$/m, 'the ffmpeg block is closed before')
})

test('deploy: the README wrapper passes TZ, lists details and acoustid-key, and has the AcoustID line', () => {
  const wrappers = readme.split('\n').filter((l) => l.includes('/usr/bin/env -i HOME=/home/mpfy'))
  assert.ok(wrappers.length > 0)
  for (const w of wrappers) assert.ok(w.includes('TZ=$(getprop persist.sys.timezone)'), w)
  assert.ok(readme.includes('`node server/index.mjs details on\\|off`'), 'the pipe escaped: one table cell')
  assert.ok(readme.includes('`node server/index.mjs acoustid-key <key>`'))
  assert.ok(readme.replace(/\n/g, ' ').includes('Track details come from AcoustID and MusicBrainz. The AcoustID key built into the source is for non-commercial use: any other use needs your own key (`node server/index.mjs acoustid-key <key>`).'))
  assert.ok(readme.includes('tzdata'))
})

test('deploy: every row of a README table has the cells of its header (a pipe inside a cell is escaped)', () => {
  const cells = (row) => row.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length
  let header = null
  let rows = 0
  for (const line of readme.split('\n')) {
    if (!line.startsWith('|')) {
      header = null
      continue
    }
    if (header === null) header = cells(line)
    else assert.equal(cells(line), header, line)
    rows++
  }
  assert.ok(rows > 15)
})

test('deploy: the memory cards are bound once into the chroot, as a slave, and the server gets group media_rw', () => {
  assert.doesNotMatch(install, /chown -R \S+ \$R\/home\/mpfy\s*$/m, 'the installer never changes owners across the cards folder')
  assert.match(install, /^chown -R \$U:\$U \$R\/home\/mpfy\/data$/m, 'the data folder keeps the server as its owner')
  const lines = boot.split('\n')
  const at = lines.findIndex((l) => l.startsWith('CARDS='))
  assert.equal(lines[at], 'CARDS="$R/home/mpfy/cards"')
  assert.equal(lines[at + 1], 'if ! mounted "$CARDS"; then', 'bound only when not mounted yet')
  assert.match(lines[at + 2], /mkdir -p "\$CARDS" && chown 0:0 "\$CARDS" && chmod 755 "\$CARDS"/, "the mount point is root's, 0755")
  const bind = lines.findIndex((l, i) => i > at && l.includes('/mnt/media_rw'))
  assert.ok(bind > at + 2 && bind < at + 8, 'the bind comes right after the mount point')
  assert.match(lines[bind], /mount -o bind \/mnt\/media_rw "\$CARDS" && mount -o rslave none "\$CARDS"/, 'the folder bound, then made a slave with a device word (toybox reads /etc/fstab for a lone folder): later cards appear, nothing goes back')
  assert.match(boot, /for d in \/mnt\/media_rw\/\*; do\n\s+if \[ -d "\$d" \] && mounted "\$d"; then mount -o bind "\$d" "\$CARDS"\/"\$\{d##\*\/\}"; fi/, 'the cards mounted already are bound one by one (toybox binds without submounts)')
  const start = lines.findIndex((l) => l.startsWith('nohup chroot'))
  assert.ok(start > at, 'bound before the loop starts')
  assert.match(lines[start], /--groups=3003,3004,1023 /, 'the server gets media_rw')
  assert.match(loop, /^export MPFY_CARDS=\/home\/mpfy\/cards$/m)
  assert.match(loop, /^export UV_THREADPOOL_SIZE=8$/m)
  assert.match(readme, /--groups=3003,3004,1023 /, 'the commands by hand get the same groups')
  assert.match(readme, /\| Music on the memory card \| `\/mnt\/media_rw\/<scheda>\/MPfy` \| `\/home\/mpfy\/cards\/<scheda>\/MPfy` \|/)
})

test('the package for the phone carries every file of web/ the source imports', () => {
  const sh = fs.readFileSync(new URL('../deploy/push-to-phone.sh', import.meta.url), 'utf8')
  const listed = new Set(sh.split('\n').find((l) => l.includes('tar --force-local -cf')).split(/\s+/))
  const wanted = new Set()
  const dir = new URL('../server/', import.meta.url)
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue
    for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/from '\.\.\/(web\/[^']+)'/g)) wanted.add(m[1])
  }
  assert.ok(wanted.size > 0)
  for (const w of wanted) assert.ok(listed.has(w), w + ' is not in the package')
})
