import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Library } from '../server/library.mjs'
import { readAudio } from '../server/media.mjs'
import { makeWav, makeMp3, tmpDir, rmDir, shardPath } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)

function readLog (dir) {
  return fs.readFileSync(path.join(dir, 'library.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function putFile (dir, buf, ext = 'wav') {
  const id = idOf(buf)
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'library', id + '.' + ext), buf)
  return id
}

// A shared change to the library: a custom album cover (no file needed).
const albumOf = (i) => '0a1b2c3d4e5f60' + i.toString(16).padStart(2, '0')
const COVER = 'ab'.repeat(12)

function fakeTrack (id, extra = {}) {
  return {
    id, title: 't' + id.slice(0, 4), artist: 'a', album: 'b', albumArtist: 'a', trackNo: null, discNo: null,
    year: null, duration: 1, format: 'wav', mime: 'audio/wav', size: 10, bitrate: null, addedAt: 1, coverId: null, ...extra
  }
}

test('db: a fresh library makes library.log in one write (its header and its epoch), without temp files left; db.json is never written', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const lib = new Library({ dataDir: dir })
  const before = Date.now()
  const r = await lib.open()
  assert.equal(r.status, 'missing')
  assert.ok(lib.version >= before, 'each run starts its versions from the clock')
  const v0 = lib.version
  assert.deepEqual(readLog(dir), [{ mpfy: 'library-log', schema: 1 }, { e: lib.epoch, v: v0 }])
  lib.setCustomCover('album', albumOf(1), 'small', COVER)
  assert.deepEqual(readLog(dir)[2], [v0 + 1, 'c:album:' + albumOf(1), { small: COVER, large: null }], 'one line, at once')
  assert.equal(lib.version, v0 + 1)
  assert.ok(!fs.existsSync(path.join(dir, 'library.log.tmp')))
  assert.ok(!fs.existsSync(path.join(dir, 'db.json')), 'db.json is never written')
  lib.close()
})

test('db: every change is one append at once; the changes of one batch share one version and one write; a restart reads them back', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const lib = new Library({ dataDir: dir })
  await lib.open()
  fs.writeFileSync(path.join(dir, 'covers', COVER + '.jpg'), 'jpg') // a cover whose image is there stays at a restart
  const base = lib.writes
  const v = lib.version
  for (let i = 0; i < 20; i++) lib.setCustomCover('album', albumOf(i), 'large', COVER)
  assert.equal(lib.writes, base + 20, 'each change written at once')
  assert.equal(lib.version, v + 20)
  lib.batch(() => {
    for (let i = 20; i < 40; i++) lib.setCustomCover('album', albumOf(i), 'large', COVER)
  })
  assert.equal(lib.writes, base + 21, 'a batch is one write')
  assert.equal(lib.version, v + 21, 'and one version')
  assert.equal(readLog(dir).filter((l) => Array.isArray(l) && l[0] === v + 21).length, 20)
  lib.close()
  const again = new Library({ dataDir: dir })
  await again.open()
  assert.equal(Object.keys(again.coversSnapshot().album).length, 40)
  assert.equal(again.version, v + 21, 'a start that changes nothing keeps the version')
  assert.equal(again.epoch, lib.epoch)
  again.close()
})

test('db: nothing writes after close, and the log leaves no timer behind', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
  const before = timers()
  const lib = new Library({ dataDir: dir })
  await lib.open()
  lib.setCustomCover('album', albumOf(1), 'small', COVER)
  lib.setCustomCover('album', albumOf(2), 'small', COVER) // its sync waits for the first one
  lib.close()
  const size = fs.statSync(path.join(dir, 'library.log')).size
  assert.equal(timers(), before, 'no timer left')
  lib.setCustomCover('album', albumOf(3), 'small', COVER)
  lib.flush()
  assert.equal(fs.statSync(path.join(dir, 'library.log')).size, size, 'nothing written after close')
  assert.equal(timers(), before, 'nor armed by a change after close')
})

test('db: a corrupt db.json is set aside and the library rebuilt from the files', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const wav = makeWav({ freq: 330, tags: { title: 'Onda', artist: 'Mare', album: 'Costa' } })
  const id = putFile(dir, wav)
  fs.writeFileSync(path.join(dir, 'db.json'), '{"version": 7, "tracks": [ {"id": broken')

  const lib = new Library({ dataDir: dir })
  const r = await lib.open()
  assert.equal(r.status, 'corrupt')
  assert.ok(r.corruptFile && fs.existsSync(r.corruptFile), 'corrupt copy kept')
  assert.match(path.basename(r.corruptFile), /^db\.json\.corrupt-\d+$/)
  assert.equal(fs.readFileSync(r.corruptFile, 'utf8'), '{"version": 7, "tracks": [ {"id": broken')
  const track = lib.getTrack(id)
  assert.ok(track, 'track rebuilt')
  assert.equal(track.title, 'Onda')
  assert.equal(track.artist, 'Mare')
  assert.equal(track.album, 'Costa')
  assert.equal(track.format, 'wav')
  assert.equal(track.size, wav.length)
  assert.ok(lib.version > 1e12, 'a rebuilt library gets a fresh version')
  assert.deepEqual(readLog(dir).filter((l) => Array.isArray(l) && l[1].startsWith('t:')).map((l) => l[1]), ['t:' + id], 'the rebuilt library is written at once')
  lib.close()
})

test('db: wrong top-level shape counts as corrupt too', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  fs.writeFileSync(path.join(dir, 'db.json'), '[1,2,3]')
  const lib = new Library({ dataDir: dir })
  const r = await lib.open()
  assert.equal(r.status, 'corrupt')
  lib.close()
})

test('db: missing db.json with files present rescans them', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const id1 = putFile(dir, makeWav({ freq: 200 }))
  const id2 = putFile(dir, makeWav({ freq: 300 }))
  const lib = new Library({ dataDir: dir })
  const r = await lib.open()
  assert.equal(r.status, 'missing')
  assert.equal(r.adopted, 2)
  assert.ok(lib.getTrack(id1) && lib.getTrack(id2))
  assert.equal(lib.getTrack(id1).title, id1, 'no tags and no original name: the id is the title')
  assert.equal(lib.getTrack(id1).artist, 'Artista sconosciuto')
  assert.equal(lib.getTrack(id1).album, 'Album sconosciuto')
  lib.close()
})

test('db: reconcile drops tracks whose file is gone (user data keeps their ids) and adopts unknown files; tmp is emptied', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const keep = putFile(dir, makeWav({ freq: 500 }))
  const orphan = putFile(dir, makeWav({ freq: 600 }))
  const gone = 'a'.repeat(24)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    schema: 1,
    version: 5,
    tracks: [fakeTrack(keep), fakeTrack(gone)],
    playlists: [{ id: '0123456789abcdef', name: 'P', description: '', trackIds: [keep, gone, keep], createdAt: 1, updatedAt: 1 }],
    likes: [{ id: gone, at: 2 }, { id: keep, at: 1 }],
    recents: [{ trackId: gone, at: 3, context: { type: 'library' } }]
  }))
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tmp', 'up-dead.part'), 'leftover')

  const lib = new Library({ dataDir: dir })
  const r = await lib.open()
  assert.equal(r.status, 'ok')
  assert.equal(r.dropped, 1)
  assert.equal(r.adopted, 1)
  assert.ok(lib.getTrack(keep))
  assert.ok(lib.getTrack(orphan))
  assert.equal(lib.getTrack(gone), null)
  // The id may be a track of another source: the user data (handed over to
  // users/owner.json at start) keeps it.
  assert.deepEqual(lib.legacyUserData.playlists[0].trackIds, [keep, gone, keep])
  assert.deepEqual(lib.legacyUserData.likes.map((l) => l.id), [gone, keep])
  assert.deepEqual(lib.legacyUserData.recents.map((r) => r.trackId), [gone])
  assert.equal(lib.getTrack(keep).size, fs.statSync(shardPath(dir, 'library', keep + '.wav')).size, 'a file that is not the one db.json describes is read again')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [])
  assert.ok(lib.version > 5, 'never reuse a version an earlier run may have served')
  lib.close()
})

test('db: the rescan honours duration: false (no whole-file read), uploads still get the exact duration', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  // 40 CBR frames (about 1.04 s), no Xing header, then 100 KB that are not frames.
  // An exact duration walks the whole file and finds 40 frames; the quick read
  // stops after a few frames and estimates from the size (far more).
  const mp3 = Buffer.concat([makeMp3({ frames: 40 }), Buffer.alloc(100000)])
  const id = putFile(dir, mp3, 'mp3')
  const file = path.join(dir, 'library', id + '.mp3')
  const exact = (await readAudio(file, 'id3', { duration: true })).metadata.format.duration
  const quick = (await readAudio(file, 'id3', { duration: false })).metadata.format.duration
  assert.ok(Math.abs(exact - 1.045) < 0.01, 'exact: ' + exact)
  assert.ok(quick > 5, 'estimated from the size: ' + quick)

  fs.writeFileSync(path.join(dir, 'db.json'), 'not json')
  const lib = new Library({ dataDir: dir })
  const r = await lib.open()
  assert.equal(r.status, 'corrupt')
  assert.equal(lib.getTrack(id).duration, Math.round(quick * 1000) / 1000, 'the rescan used the quick read')
  lib.close()
})
