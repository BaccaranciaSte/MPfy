// Archives: the 7-Zip listing parser on outputs recorded from 7-Zip 26.06 (7z,
// solid 7z, encrypted files, encrypted headers, a corrupt file) and on crafted
// ones (RAR, links, absolute and .. paths); every refusal; the probe (version and
// RAR from the Codecs: section only); a fake 7zz for the kill at the 1001st
// block, the watchdog, exit codes, temp dirs, counts, the cover and nested
// archives; and yauzl on every ZIP.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { ListParser, judgeListing, judgeSizes, parseInfo, versionUsable, SevenZip, unsafePath } from '../server/sevenzip.mjs'
import { ArchiveError } from '../server/errors.mjs'
import { ZipArchive } from '../server/zip.mjs'
import { tmpDir, cleanup, json, request, makeWav, makeProfile, device, testWhoIs, fakeTool, makeZip, hash24, fakePng } from './helpers.mjs'

const body = (r) => json(r)
const MIB = 1024 * 1024
const SEVEN = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])
const RAR5 = Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1')

// ------------------------------------------------- recorded 7-Zip 26.06 output

const HEAD = '\r\n7-Zip 26.06 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-11-06\r\n\r\nScanning the drive for archives:\r\n1 file, 5248 bytes (6 KiB)\r\n\r\nListing archive: x.7z\r\n\r\n'
const PLAIN_7Z = HEAD + `--
Path = plain.7z
Type = 7z
Physical Size = 5248
Headers Size = 230
Method = LZMA2:12
Solid = -
Blocks = 3

----------
Path = Disco 1
Size = 0
Packed Size = 0
Modified = 2026-11-17 18:49:00.9902069
Attributes = D
CRC =
Encrypted = -
Method =
Block =

Path = 02 Due.flac
Size = 2000
Packed Size = 2004
Modified = 2026-11-17 18:49:01.0346070
Attributes = A
CRC = D1AFE5ED
Encrypted = -
Method = LZMA2:12
Block = 0

Path = cover.jpg
Size = 6
Packed Size = 10
Modified = 2026-11-17 18:49:01.0355751
Attributes = A
CRC = D954382A
Encrypted = -
Method = LZMA2:12
Block = 1

Path = Disco 1\\01 Uno.mp3
Size = 3000
Packed Size = 3004
Modified = 2026-11-17 18:49:01.0141548
Attributes = A
CRC = EC4241C9
Encrypted = -
Method = LZMA2:12
Block = 2

`.replace(/\n/g, '\r\n')
const SOLID_7Z = PLAIN_7Z.replace('Solid = -', 'Solid = +').replace('Packed Size = 2004', 'Packed Size = 5010').replace('Packed Size = 10\r\n', 'Packed Size = \r\n').replace('Packed Size = 3004', 'Packed Size = ')
const ENCRYPTED_7Z = SOLID_7Z.replace(/Encrypted = -\r\nMethod = LZMA2:6k|Encrypted = -\r\nMethod = LZMA2:12/g, 'Encrypted = +\r\nMethod = LZMA2:6k 7zAES:19')
const ENCRYPTED_HEADERS = '\r\n7-Zip 26.06 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-11-06\r\n\r\nScanning the drive for archives:\r\n1 file, 5311 bytes (6 KiB)\r\n\r\nListing archive: enchead.7z\r\n\r\n\r\nErrors: 1\r\n\r\nERROR: enchead.7z : Cannot open encrypted archive. Wrong password?\r\n'
const CORRUPT = '\r\n7-Zip 26.06 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-11-06\r\n\r\nListing archive: corrupt2.7z\r\n\r\n\r\nErrors: 1\r\n\r\nERROR: corrupt2.7z : corrupt2.7z\r\nOpen ERROR: Cannot open the file as [7z] archive\r\n\r\n\r\nERRORS:\r\nIs not archive\r\n'
// A RAR5 listing in the same form (Folder lines, unix attributes from a Linux rar).
const RAR = HEAD.replace('x.7z', 'album.rar') + `--
Path = album.rar
Type = Rar5
Physical Size = 6000
Solid = -
Blocks = 2
Multivolume = -
Volumes = 1

----------
Path = Album
Folder = +
Size = 0
Packed Size = 0
Attributes = D_ drwxr-xr-x
Encrypted = -

Path = Album/01 Uno.flac
Folder = -
Size = 3000
Packed Size = 2900
Attributes = A_ -rw-r--r--
Encrypted = -
Solid = -
Host OS = Unix
Method = v6:128K:m3

Path = Album/folder.png
Folder = -
Size = 300
Packed Size = 290
Attributes = A_ -rw-r--r--
Encrypted = -

`

function parse (text, code = 0, stderr = '') {
  const p = new ListParser()
  for (let i = 0; i < text.length; i += 97) p.push(Buffer.from(text.slice(i, i + 97))) // in pieces, like a pipe
  p.end()
  return p.result(code, stderr)
}

function refusal (fn) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof ArchiveError, 'an ArchiveError: ' + err)
    return err.code
  }
  return null
}

test('7-Zip listing: recorded 7z, solid 7z, RAR; folders told apart; the judged files and total', () => {
  const plain = parse(PLAIN_7Z)
  assert.equal(plain.type, '7z')
  assert.deepEqual(plain.entries.map((e) => [e.path, e.folder, e.size, e.packed]), [['Disco 1', true, 0, 0], ['02 Due.flac', false, 2000, 2004], ['cover.jpg', false, 6, 10], ['Disco 1\\01 Uno.mp3', false, 3000, 3004]])
  assert.deepEqual(judgeListing(plain, 5248).files.map((f) => f.name), ['02 Due.flac', 'cover.jpg', 'Disco 1\\01 Uno.mp3'])
  assert.equal(judgeListing(plain, 5248).total, 5006)
  const solid = parse(SOLID_7Z)
  assert.deepEqual(solid.entries.map((e) => e.packed), [0, 5010, null, null], 'a solid archive lists no packed size for most entries')
  assert.equal(judgeListing(solid, 5238).total, 5006)
  const rar = parse(RAR)
  assert.equal(rar.type, 'Rar5')
  assert.deepEqual(judgeListing(rar, 6000).files.map((f) => f.name), ['Album/01 Uno.flac', 'Album/folder.png'])

  // A directory attribute on an entry with bytes: 7-Zip extracts it as a file, so it is one.
  const hidden = PLAIN_7Z.replace('Path = cover.jpg\r\nSize = 6\r\nPacked Size = 10\r\nModified = 2026-11-17 18:49:01.0355751\r\nAttributes = A',
    'Path = cover.jpg\r\nSize = 20971520\r\nPacked Size = 3000\r\nModified = 2026-11-17 18:49:01.0355751\r\nAttributes = DA')
  assert.notEqual(hidden, PLAIN_7Z)
  const h = parse(hidden)
  assert.deepEqual(h.entries.map((e) => [e.path, e.folder]), [['Disco 1', true], ['02 Due.flac', false], ['cover.jpg', false], ['Disco 1\\01 Uno.mp3', false]])
  assert.equal(refusal(() => judgeListing(h, 5248)), 'archive_invalid', '20 MiB packed into 3 KB')
  // A Folder line is trusted as it is.
  const told = parse(RAR.replace('Path = Album/folder.png\nFolder = -\nSize = 300\nPacked Size = 290\nAttributes = A_', 'Path = Album/folder.png\nFolder = -\nSize = 300\nPacked Size = 290\nAttributes = D_'))
  assert.notEqual(told.entries.find((e) => e.path === 'Album/folder.png').attributes, 'A_ -rw-r--r--')
  assert.deepEqual(told.entries.map((e) => e.folder), [true, false, false])
})

test('7-Zip listing: refusals (encrypted, exits, type, links, paths, counts, sizes, both ratios)', () => {
  assert.equal(refusal(() => judgeListing(parse(ENCRYPTED_7Z), 5281)), 'archive_encrypted', 'Encrypted = +')
  assert.equal(refusal(() => judgeListing(parse(ENCRYPTED_HEADERS, 2), 5311)), 'archive_encrypted', 'encrypted headers: the text')
  assert.equal(refusal(() => judgeListing(parse(HEAD, 2, 'ERROR: x.7z : Wrong password'), 9)), 'archive_encrypted', 'the text on stderr')
  assert.equal(refusal(() => judgeListing(parse(CORRUPT, 2), 3006)), 'archive_invalid', 'a corrupt archive is never "encrypted"')
  assert.equal(refusal(() => judgeListing(parse(PLAIN_7Z, 8), 5248)), 'archive_too_big', 'exit 8: out of memory under the cap')
  assert.equal(refusal(() => judgeListing(parse(PLAIN_7Z, 1), 5248)), 'archive_invalid')
  assert.equal(refusal(() => judgeListing(parse(PLAIN_7Z.replace('Type = 7z', 'Type = zip')), 5248)), 'unsupported_archive')
  const entry = (lines) => PLAIN_7Z.replace('Path = cover.jpg\r\n', lines.join('\r\n') + '\r\n')
  for (const [what, text] of [
    ['a symbolic link', entry(['Path = link', 'Symbolic Link = ../../etc/passwd'])],
    ['a hard link', entry(['Path = hard', 'Hard Link = 02 Due.flac'])],
    ['a unix link mode', PLAIN_7Z.replace('Attributes = A\r\nCRC = D954382A', 'Attributes = A_ lrwxrwxrwx\r\nCRC = D954382A')],
    ['an absolute path', PLAIN_7Z.replace('Path = cover.jpg', 'Path = /etc/cover.jpg')],
    ['a drive path', PLAIN_7Z.replace('Path = cover.jpg', 'Path = C:\\cover.jpg')],
    ['a backslash root', PLAIN_7Z.replace('Path = cover.jpg', 'Path = \\cover.jpg')],
    ['a .. component', PLAIN_7Z.replace('Path = cover.jpg', 'Path = Disco 1\\..\\..\\cover.jpg')]
  ]) assert.equal(refusal(() => judgeListing(parse(text), 5248)), 'archive_invalid', what)
  assert.equal(unsafePath('a..b/c'), false, 'two dots inside a name are fine')
  assert.equal(unsafePath('ok/..'), true)

  const files = (n, size, packed) => Array.from({ length: n }, (_, i) => ({ name: 'f' + i, size, packed }))
  assert.equal(refusal(() => judgeSizes(files(1001, 10, 10), 1e6)), 'archive_too_big', '1001 files')
  assert.equal(refusal(() => judgeSizes(files(1, 600 * MIB + 1, 600 * MIB), 600 * MIB)), 'archive_too_big', 'a file over 600 MiB')
  assert.equal(refusal(() => judgeSizes(files(12, 550 * MIB, 550 * MIB), 7e9)), 'archive_too_big', 'over 6 GiB in all')
  assert.equal(refusal(() => judgeSizes(files(1, 20 * MIB, 300 * 1024), 25 * MIB)), 'archive_invalid', 'one big entry over 50:1')
  assert.equal(refusal(() => judgeSizes(files(150, MIB, 1000), 150 * 1000 + 5000)), 'archive_invalid', 'many small zero entries: the total ratio on a non-solid archive')
  assert.equal(judgeSizes(files(150, MIB, 1000), 4 * MIB).total, 150 * MIB, 'the same total at 37:1 passes')
  assert.equal(judgeSizes(files(8, 5 * MIB, null), 41 * MIB).total, 40 * MIB, 'unknown packed sizes are skipped (solid)')
})

test('probe: the version on the first line, 25.01 or later; RAR only from the Codecs: section', async (t) => {
  const info = parseInfo('\r\n7-Zip 26.06 (x64) : Copyright\r\n\r\nFormats:\r\n 0 ...F  Rar5     rar r00       R a r ! 1A 07 01 00\r\n\r\nCodecs:\r\n 0   D     40305 Rar5\r\n\r\nHashers:\r\n')
  assert.deepEqual(info, { version: [26, 6], text: '26.06', rar: true }, 'the version as printed: 26.06, never 26.6')
  assert.equal(parseInfo('\n7-Zip (z) 25.01 (arm64) : x\n\nCodecs:\n 0 ED 21 LZMA2\n').rar, false)
  assert.equal(parseInfo('\n7-Zip 23.01 (arm64) : x\nFormats:\n 0 F Rar5 rar\nCodecs:\n 0 ED 21 LZMA2\n').rar, false, 'Rar5 in Formats: is not enough')
  assert.equal(versionUsable([23, 1]), false)
  assert.equal(versionUsable([25, 0]), false)
  assert.equal(versionUsable([25, 1]), true)
  assert.equal(versionUsable([26, 0]), true)

  const work = cleanup(t).dir(tmpDir('mpfy-7z-'))
  const old = fakeTool(work, '7zz', { version: '23.01' })
  const z = new SevenZip({ command: old.command })
  assert.equal(await z.probe(), false)
  // A source with that 7-Zip refuses 7z and RAR sessions at creation.
  const dir = cleanup(t).dir(tmpDir())
  const app = cleanup(t).close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, ffmpeg: null, fpcalc: null, sevenZip: old.command, whoIs: testWhoIs }))
  for (const name of ['a.7z', 'a.rar']) {
    const r = await req(app, 'POST', '/api/uploads', { name, size: 100, lastModified: 1, headHash: 'a'.repeat(64) })
    assert.equal(r.status, 415, name)
  }
  assert.deepEqual(body(await req(app, 'GET', '/api/health')).archives, { zip: true, sevenZip: false, rar: false })

  const noRar = fakeTool(work + '', '7zz', { version: '25.01', rar: false, rarInFormats: true })
  const z2 = new SevenZip({ command: noRar.command })
  assert.equal(await z2.probe(), true)
  assert.deepEqual([z2.supports('7z'), z2.supports('rar'), z2.version], [true, false, '25.01'])
})

function req (app, method, url, b = null) {
  return request(app.ports.http, method, url, { body: b })
}

// A source with a fake 7zz; the owner's device uploads.
async function start (t, control = {}, opts = {}) {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const work = c.dir(tmpDir('mpfy-7z-'))
  const seven = fakeTool(work, '7zz', control)
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: seven.command, whoIs: testWhoIs,
    archiveWatch: { watchEvery: 50 }, ...opts
  }))
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  assert.equal(body(await owner.call('GET', '/api/profile')).role, 'owner')
  return { app, dir, work, seven, owner }
}

async function uploadArchive (app, dev, name, bytes) {
  const r = await dev.call('PUT', '/api/upload/' + name, { body: bytes })
  assert.equal(r.status, 202, r.body.toString())
  const id = body(r).archive.id
  await app.archives.idle()
  return body(await dev.call('GET', '/api/archives/' + id))
}

test('7z through a fake 7zz: imports in listing order, counts, the cover (a 17 MiB cover.jpg is not), nested archives ignored, temp dirs removed', async (t) => {
  const { app, dir, work, seven, owner } = await start(t)
  const songs = [1, 2, 3].map((i) => makeWav({ seconds: 1, freq: 300 + i * 50, tags: { title: 'Brano ' + i, album: 'Disco', artist: 'NEA' } }))
  const files = songs.map((s, i) => {
    const f = path.join(work, 'song' + i + '.wav')
    fs.writeFileSync(f, s)
    return f
  })
  const bigCover = path.join(work, 'cover-grande.jpg')
  fs.writeFileSync(bigCover, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(17 * MIB)]))
  const png = fakePng(42)
  const smallCover = path.join(work, 'front.png')
  fs.writeFileSync(smallCover, png)
  const noise = path.join(work, 'finto.mp3')
  fs.writeFileSync(noise, 'not audio at all')
  // Already in the library: a duplicate inside the archive.
  assert.equal(body(await owner.call('PUT', '/api/upload/gia.wav', { body: songs[2] })).outcome, 'added')
  const listed = [
    { path: 'Disco/01 Uno.wav', size: songs[0].length, packed: songs[0].length },
    { path: 'Disco/cover.jpg', size: 17 * MIB + 4, packed: 17 * MIB },
    { path: 'Disco/02 Due.wav', size: songs[1].length, packed: songs[1].length },
    { path: 'Disco/front.png', size: png.length, packed: png.length },
    { path: 'Disco/finto.mp3', size: 16, packed: 16 },
    { path: 'Disco/dentro.zip', size: 30, packed: 30 },
    { path: 'Disco/03 Tre.wav', size: songs[2].length, packed: songs[2].length },
    { path: 'Disco/note.txt', size: 5, packed: 5 }
  ]
  seven.control({
    entries: listed,
    files: [
      { name: '01 Uno.wav', from: files[0] }, { name: 'cover.jpg', from: bigCover }, { name: '02 Due.wav', from: files[1] },
      { name: 'front.png', from: smallCover }, { name: 'finto.mp3', from: noise }, { name: 'dentro.zip', text: 'PK\u0003\u0004 nested' },
      { name: '03 Tre.wav', from: files[2] }, { name: 'note.txt', text: 'ciao' }
    ]
  })
  const reads = t.mock.method(fs, 'readFileSync')
  const st = await uploadArchive(app, owner, 'Disco.7z', Buffer.concat([SEVEN, Buffer.alloc(200)]))
  assert.ok(!reads.mock.calls.some((c) => String(c.arguments[0]).endsWith('cover.jpg')), 'a cover over 16 MiB is never read (lstat first)')
  assert.deepEqual([st.state, st.total, st.done, st.added, st.replaced, st.duplicates, st.ignored], ['done', 4, 4, 2, 0, 1, 2])
  assert.equal(st.error, null)
  assert.equal(st.coverId, hash24(png), 'the 17 MiB cover.jpg is skipped, front.png taken')
  const titles = st.trackIds.map((id) => app.library.getTrack(id).title)
  assert.deepEqual(titles, ['Brano 1', 'Brano 2', 'Brano 3'], 'listing order')
  assert.equal(app.library.getTrack(st.trackIds[0]).coverId, hash24(png), 'the archive cover on its tracks without one')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'tmp/x-<id> and tmp/a-<id> removed')
  const calls = seven.calls()
  assert.deepEqual(calls.map((c) => c.args[0]), ['i', 'l', 'e'], 'probed at start, listed, then extracted')
  assert.deepEqual(calls[1].args.slice(0, 5), ['l', '-slt', '-sccUTF-8', '-pmpfy', '--'])
  const extract = calls.find((c) => c.args[0] === 'e').args
  assert.deepEqual(extract.slice(0, 8), ['e', '-y', '-aou', '-bd', '-bso0', '-bsp0', '-sccUTF-8', '-pmpfy'])
  assert.ok(extract.includes('--'))
})

test('7z refusals end the archive "failed" with the code; the listing killed at the 1001st block; the watchdog kills an extractor that writes past the total; exits 8 and 2; temp dirs removed', { timeout: 120000 }, async (t) => {
  const { app, dir, seven, owner } = await start(t)
  const cases = [
    [{ slowBlocks: 1500 }, 'archive_too_big'],
    [{ entries: [{ path: 'a.wav', size: 1000, packed: 1000, encrypted: true }] }, 'archive_encrypted'],
    [{ entries: [{ path: '../a.wav', size: 1000, packed: 1000 }] }, 'archive_invalid'],
    [{ entries: [{ path: 'a.wav', size: 1000, packed: 1000 }], listExit: 2, listStderr: 'ERROR: Is not archive' }, 'archive_invalid'],
    [{ entries: [{ path: 'a.wav', size: 1000, packed: 1000 }], listExit: 8 }, 'archive_too_big'],
    [{ entries: [{ path: 'a.wav', size: 1000, packed: 1000 }], extractExit: 8, files: [] }, 'archive_too_big'],
    [{ entries: [{ path: 'a.wav', size: 1000, packed: 1000 }], extractExit: 2, files: [] }, 'archive_invalid'],
    [{ entries: [{ path: 'a.wav', size: 100000, packed: 100000 }], grow: true }, 'archive_invalid']
  ]
  for (const [i, [control, code]] of cases.entries()) {
    seven.control(control)
    const before = seven.calls().length
    const st = await uploadArchive(app, owner, 'x.7z', Buffer.concat([SEVEN, Buffer.alloc(100, i)]))
    assert.equal(st.state, 'failed', JSON.stringify(control).slice(0, 60))
    assert.equal(st.code, code, JSON.stringify(control).slice(0, 60))
    assert.equal(typeof st.error, 'string')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'temp dirs removed: ' + code)
    // A killed fake never logs its end: the listing of 1500 blocks; the growing
    // extractor after a listing that ended.
    if (control.slowBlocks) assert.equal(seven.calls().length, before, 'the listing was killed')
    if (control.grow) assert.deepEqual(seven.calls().slice(before).map((c) => c.args[0]), ['l'], 'the extractor was killed')
  }
})

test('a growing fake extractor nobody kills stops by itself and says so in its call log', (t) => {
  // It runs detached: a test killed mid-way (or a broken watchdog) must not leave
  // it filling the disk for hours.
  const work = cleanup(t).dir(tmpDir('mpfy-7z-'))
  const seven = fakeTool(work, '7zz', { grow: true, growMax: 2 * MIB })
  const out = path.join(work, 'x')
  fs.mkdirSync(out)
  const r = spawnSync(process.execPath, [seven.command, 'e', '-o' + out, '--', path.join(work, 'a.7z')], { timeout: 30000 })
  assert.equal(r.status, 3, 'it exits by itself')
  assert.equal(fs.statSync(path.join(out, 'grande.bin')).size, 2 * MIB)
  const calls = seven.calls()
  assert.deepEqual(calls.map((c) => [c.args[0], c.capped]), [['e', 2 * MIB]], 'the stop is logged, so a broken watchdog still fails its test')
})

test("the disk rule applies to an archive's listed total", async (t) => {
  // 1 MB free and a floor 3000 bytes under it: the archive itself fits, its 5000 listed bytes do not.
  const statfs = async () => ({ bavail: 1000000, bsize: 1, blocks: 1e9 })
  const { app, owner } = await start(t, { entries: [{ path: 'a.wav', size: 5000, packed: 5000 }] }, { statfs, minFreeBytes: 1000000 - 3000 })
  const st = await uploadArchive(app, owner, 'pieno.7z', Buffer.concat([SEVEN, Buffer.alloc(77)]))
  assert.deepEqual([st.state, st.code, st.error], ['failed', 'disk_full', 'Spazio su disco esaurito sulla fonte'])
})

test('a restart marks an archive cut mid-way failed "archive_interrupted" and empties tmp/', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  fs.mkdirSync(path.join(dir, 'archives'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tmp', 'x-cccccccccccccccc'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tmp', 'x-cccccccccccccccc', '0.bin'), 'x')
  fs.writeFileSync(path.join(dir, 'tmp', 'a-cccccccccccccccc.zip'), 'x')
  fs.writeFileSync(path.join(dir, 'archives', 'cccccccccccccccc.json'), JSON.stringify({ id: 'cccccccccccccccc', name: 'a.zip', state: 'extracting', total: 3, done: 1, pending: [], trackIds: [], profileId: 'owner', createdAt: Date.now() }))
  const app = c.close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, ffmpeg: null, fpcalc: null, sevenZip: null }))
  const st = body(await req(app, 'GET', '/api/archives/cccccccccccccccc'))
  assert.deepEqual([st.state, st.code, st.error], ['failed', 'archive_interrupted', 'Caricamento interrotto'])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
})

test('ZIP through yauzl, with or without 7-Zip: encrypted, symlink, overlapping entries, an unknown method, over 1000 entries refused before any extraction; an album extracts', async (t) => {
  const wavs = [makeWav({ freq: 520, tags: { title: 'Zip uno' } }), makeWav({ freq: 530, tags: { title: 'Zip due' } })]
  const album = makeZip([
    { name: 'Album/', dir: true },
    { name: 'Album/01.wav', data: wavs[0], method: 8 },
    { name: 'Album/02.wav', data: wavs[1] },
    { name: 'Album/folder.png', data: fakePng(7) },
    { name: 'Album/info.nfo', data: 'x' }
  ])
  const work = cleanup(t).dir(tmpDir('mpfy-zip-'))
  const check = async (buf) => {
    const f = path.join(work, 'z-' + Math.random().toString(16).slice(2) + '.zip')
    fs.writeFileSync(f, buf)
    const z = new ZipArchive(f)
    try {
      await z.check()
      return 'ok'
    } catch (err) {
      return err.code
    } finally {
      z.close()
    }
  }
  assert.equal(await check(album), 'ok')
  assert.equal(await check(makeZip([{ name: 'a.wav', data: wavs[0], encrypted: true }])), 'archive_encrypted')
  assert.equal(await check(makeZip([{ name: 'a.wav', data: wavs[0] }, { name: 'link', data: '../../etc/passwd', symlink: true }])), 'archive_invalid')
  assert.equal(await check(makeZip([{ name: 'a.wav', data: wavs[0] }, { name: 'b.wav', data: wavs[1] }], { overlap: true })), 'archive_invalid', 'two records on one local header')
  assert.equal(await check(makeZip([{ name: 'a.wav', data: wavs[0], method: 12 }])), 'archive_invalid', 'bzip2: yauzl cannot read it')
  assert.equal(await check(makeZip([{ name: '../a.wav', data: wavs[0] }])), 'archive_invalid', 'yauzl\'s own name check')
  assert.equal(await check(makeZip(Array.from({ length: 1001 }, (_, i) => ({ name: 'f' + i + '.txt', data: 'x' })))), 'archive_too_big')
  const bomb = makeZip([{ name: 'zeri.wav', data: Buffer.alloc(12 * MIB), method: 8 }])
  assert.equal(await check(bomb), 'archive_invalid', 'one 12 MiB entry packed over 50:1')

  for (const sevenZip of [null, fakeTool(work, '7zz').command]) {
    const c = cleanup(t)
    const dir = c.dir(tmpDir())
    const app = c.close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip, whoIs: testWhoIs }))
    const owner = device(app, { profile: makeProfile() })
    const st = await uploadArchive(app, owner, 'Album.zip', album)
    assert.deepEqual([st.state, st.total, st.added, st.ignored, st.coverId], ['done', 2, 2, 0, hash24(fakePng(7))], 'with 7-Zip: ' + !!sevenZip)
    assert.deepEqual(st.trackIds.map((id) => app.library.getTrack(id).title), ['Zip uno', 'Zip due'])
    for (const [buf, code] of [[makeZip([{ name: 'a.wav', data: wavs[0], encrypted: true }]), 'archive_encrypted'], [bomb, 'archive_invalid']]) {
      const failed = await uploadArchive(app, owner, 'x.zip', buf)
      assert.deepEqual([failed.state, failed.code], ['failed', code])
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
    assert.equal(body(await owner.call('GET', '/api/health')).archives.zip, true)
    // An "already there" album: the summary has no new track, only duplicates.
    const again = await uploadArchive(app, owner, 'Album.zip', album)
    assert.deepEqual([again.state, again.added, again.replaced, again.duplicates], ['done', 0, 0, 2], 'an album already there: duplicates only')
  }
})

test('ZIP names: decoded as yauzl would (UTF-8 by the flag, else code page 437), too long or with a backslash refused; comments never read', async (t) => {
  const work = cleanup(t).dir(tmpDir('mpfy-zip-'))
  const wav = makeWav({ freq: 541 })
  const names = async (buf) => {
    const f = path.join(work, 'z-' + Math.random().toString(16).slice(2) + '.zip')
    fs.writeFileSync(f, buf)
    const z = new ZipArchive(f)
    try {
      return (await z.check()).names
    } catch (err) {
      return err.code
    } finally {
      z.close()
    }
  }
  assert.deepEqual(await names(makeZip([{ name: 'Album/01 Caff\u00e8.wav', data: wav }])), ['Album/01 Caff\u00e8.wav'])
  const cp437 = Buffer.concat([Buffer.from('Album/Caf', 'latin1'), Buffer.from([0x82]), Buffer.from('.wav', 'latin1')])
  assert.deepEqual(await names(makeZip([{ name: '', rawName: cp437, data: wav }])), ['Album/Caf\u00e9.wav'])
  assert.equal(await names(makeZip([{ name: 'Album\\01.wav', data: wav }])), 'archive_invalid', 'a backslash, as strictFileNames')
  assert.equal(await names(makeZip([{ name: 'a'.repeat(1021) + '.wav', data: wav }])), 'archive_invalid', 'a name over 1024 bytes')
  assert.deepEqual(await names(makeZip([{ name: 'a'.repeat(1020) + '.wav', data: wav }])), ['a'.repeat(1020) + '.wav'])

  // 100 entries with a 64 KB comment each: under a small heap the check still runs.
  const entries = Array.from({ length: 100 }, (_, i) => ({ name: '', rawName: Buffer.from('f' + i + '.txt'), data: 'x', comment: Buffer.alloc(65535, 0xb0) }))
  const file = path.join(work, 'commenti.zip')
  fs.writeFileSync(file, makeZip(entries))
  const code = "const { ZipArchive } = await import(process.argv[1]); const z = new ZipArchive(process.argv[2]); const r = await z.check(); z.close(); console.log('names ' + r.names.length)"
  const run = spawnSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', code, new URL('../server/zip.mjs', import.meta.url).href, file], { encoding: 'utf8' })
  t.diagnostic('exit ' + run.status + ' ' + run.stdout.trim() + ' ' + run.stderr.split('\n').find((l) => /heap|Error/.test(l) || false))
  assert.equal(run.status, 0)
  assert.equal(run.stdout.trim(), 'names 100')
})
