// A data dir from before profiles is brought up to date at the first start: the owner's
// playlists, likes, recents and playlist covers move to users/owner.json, track
// and album covers stay shared (in library.log; db.json is left as it was, for an
// older app), every track is the owner's, every admitted key legacy. Each step can
// be cut and run again. And the reconcile of library/ when one id has several files.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { Users } from '../server/users.mjs'
import { tmpDir, cleanup, request, json, makeWav, makeMp3, makeProfile, device, deviceKey, testWhoIs, hash24, treeFiles } from './helpers.mjs'

const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n), Buffer.from([0xff, 0xd9])])
const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
const PL = '0123456789abcdef'
const ALBUM = '0a1b2c3d4e5f6071'
const FOREIGN = 'f0'.repeat(12)

async function start (t, dir) {
  return cleanup(t).close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, backgroundDelayMs: 600000 }))
}

// A data dir as the server before profiles leaves it.
function olderDir (dir) {
  const wav = makeWav({ freq: 330, tags: { title: 'Onda', artist: 'Mare', album: 'Costa' } })
  const id = hash24(wav)
  const covers = { pl: jpeg(80), album: jpeg(90), track: jpeg(70) }
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'covers'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'library', id + '.wav'), wav)
  for (const img of Object.values(covers)) fs.writeFileSync(path.join(dir, 'covers', hash24(img) + '.jpg'), img)
  const key = deviceKey()
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify([{ publicKey: key, name: 'Telefono di Bacca', addedAt: 5 }]))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    schema: 2,
    version: 42,
    tracks: [{ id, title: 'Onda', artist: 'Mare', album: 'Costa', albumArtist: 'Mare', trackNo: null, discNo: null, year: null, duration: 1, format: 'wav', mime: 'audio/wav', size: wav.length, bitrate: 128000, lossless: true, addedAt: 3, coverId: null }],
    playlists: [{ id: PL, name: 'In auto', description: '', trackIds: [id, FOREIGN], createdAt: 1, updatedAt: 2 }],
    likes: [{ id: FOREIGN, at: 9 }, { id, at: 8 }],
    recents: [{ trackId: id, at: 7, context: { type: 'playlist', id: PL } }],
    covers: {
      track: { [id]: { small: null, large: hash24(covers.track) } },
      album: { [ALBUM]: { small: hash24(covers.album), large: null } },
      playlist: { [PL]: { small: hash24(covers.pl), large: hash24(covers.pl) } }
    }
  }))
  return { id, key, covers, wav }
}

// The library as library.log holds it: the last line of each key wins.
function loggedLibrary (dir) {
  const tracks = new Map()
  const covers = { track: {}, album: {} }
  for (const line of fs.readFileSync(path.join(dir, 'library.log'), 'utf8').split('\n')) {
    if (!line.startsWith('[')) continue
    const [, key, value] = JSON.parse(line)
    if (key.startsWith('t:')) {
      if (value === undefined) tracks.delete(key.slice(2))
      else tracks.set(key.slice(2), value)
    } else if (key.startsWith('c:')) {
      const [, kind, cid] = key.split(':')
      if (value === undefined) delete covers[kind][cid]
      else covers[kind][cid] = value
    }
  }
  return { tracks: [...tracks.values()], covers }
}

// A person's data as its log holds it (read by a Users of its own, as a start would).
function personOf (dir, key) {
  const users = new Users({ dataDir: dir })
  users.load()
  const data = users.has(key) ? users.get(key)._data() : null
  users.close()
  return data
}

// The background jobs wait 10 min (start): what is checked is the library as migrated, before the
// tags job reads the files again.
function checkMigrated (dir, { id, key, covers }) {
  // db.json stays as the older app wrote it (it still finds its data there); the
  // library lives in library.log.
  assert.equal(readJson(dir, 'db.json').schema, 2, 'db.json left as it was')
  const db = loggedLibrary(dir)
  assert.deepEqual(db.covers, { track: { [id]: { small: null, large: hash24(covers.track) } }, album: { [ALBUM]: { small: hash24(covers.album), large: null } } }, 'shared covers stay')
  const t = db.tracks[0]
  assert.deepEqual([t.uploaders, t.fileHash, t.fp, t.fpState], [['owner'], id, null, 'none'])
  assert.equal(t.codec, 'wav')
  assert.equal(t.qualityV, 0, 'every file waits for its quality analysis')
  assert.equal(t.tagless, null, 'and for its tags to be read again')
  const owner = personOf(dir, 'owner')
  assert.deepEqual(owner.playlists.map((p) => [p.id, p.trackIds]), [[PL, [id, FOREIGN]]])
  assert.deepEqual(owner.likes.map((l) => l.id), [FOREIGN, id])
  assert.deepEqual(owner.recents.map((r) => r.trackId), [id])
  assert.deepEqual(owner.covers.playlist, { [PL]: { small: hash24(covers.pl), large: hash24(covers.pl) } })
  for (const img of Object.values(covers)) assert.ok(fs.existsSync(path.join(dir, 'covers', hash24(img) + '.jpg')), 'every cover file kept')
  const source = readJson(dir, 'source.json')
  assert.equal(source.ownerProfileId, null)
  assert.ok(source.migratedAt > 0)
  assert.equal(readJson(dir, 'clients.json')[0].legacy, true)
  assert.equal(readJson(dir, 'clients.json')[0].publicKey, key)
}

test('migration: the owner\'s data moves to users/owner.json, shared covers stay, clients become legacy; the older app keeps its data', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const p2 = olderDir(dir)
  const app = await start(t, dir)
  checkMigrated(dir, p2)
  // Local and the legacy key act as the owner and see the data from before.
  for (const call of [(m, u) => request(app.ports.http, m, u), device(app, { key: p2.key, admit: false }).call]) {
    const lib = json(await call('GET', '/api/library'))
    assert.deepEqual(lib.playlists.map((p) => p.name), ['In auto'])
    assert.deepEqual(lib.covers.playlist[PL], { small: hash24(p2.covers.pl), large: hash24(p2.covers.pl) })
    assert.equal(lib.covers.album[ALBUM].small, hash24(p2.covers.album))
    assert.equal(lib.tracks[0].mine, true, 'the older tracks are the owner\'s')
  }
  // Another start changes nothing.
  await app.close()
  const before = personOf(dir, 'owner')
  await start(t, dir)
  checkMigrated(dir, p2)
  assert.equal(personOf(dir, 'owner').playlists[0].name, before.playlists[0].name)
})

test('migration: cut after step 1, cut after users/owner.json, cut in the owner move: each finishes at the next start', async (t) => {
  // After step 1: source.json written and the clients legacy, db.json still schema 2.
  const a = cleanup(t).dir(tmpDir())
  const p2a = olderDir(a)
  fs.writeFileSync(path.join(a, 'source.json'), JSON.stringify({ schema: 1, name: 'Mi A2', named: false, ownerProfileId: null, claimUntil: 0, migratedAt: 123 }))
  const clients = readJson(a, 'clients.json')
  clients[0].legacy = true
  fs.writeFileSync(path.join(a, 'clients.json'), JSON.stringify(clients))
  await start(t, a)
  checkMigrated(a, p2a)
  assert.equal(readJson(a, 'source.json').migratedAt, 123, 'step 1 is not done twice')

  // After users/owner.json was written but before db.json became schema 3.
  const b = cleanup(t).dir(tmpDir())
  const p2b = olderDir(b)
  fs.writeFileSync(path.join(b, 'source.json'), JSON.stringify({ schema: 1, name: 'Mi A2', named: false, ownerProfileId: null, claimUntil: 0, migratedAt: 123 }))
  fs.mkdirSync(path.join(b, 'users'))
  const ownerFile = { schema: 1, version: 5, playlists: [{ id: PL, name: 'In auto', description: '', trackIds: [p2b.id, FOREIGN], createdAt: 1, updatedAt: 2 }], likes: [{ id: FOREIGN, at: 9 }, { id: p2b.id, at: 8 }], recents: [{ trackId: p2b.id, at: 7, context: { type: 'playlist', id: PL } }], covers: { playlist: { [PL]: { small: hash24(p2b.covers.pl), large: hash24(p2b.covers.pl) } } } }
  fs.writeFileSync(path.join(b, 'users', 'owner.json'), JSON.stringify(ownerFile))
  fs.writeFileSync(path.join(b, 'clients.json'), JSON.stringify(readJson(b, 'clients.json').map((c) => ({ ...c, legacy: true }))))
  await start(t, b)
  checkMigrated(b, p2b)

  // The owner was set, but users/owner.json not moved yet (cut in step 3).
  const c = cleanup(t).dir(tmpDir())
  const p2c = olderDir(c)
  const first = await start(t, c)
  await first.close()
  const p = makeProfile()
  fs.writeFileSync(path.join(c, 'profiles.json'), JSON.stringify({ schema: 1, profiles: [{ profileId: p.id, signPublicKey: p.signPublicKey.toString('hex'), name: 'Bacca', nameUpdatedAt: 1, createdAt: 1, lastSeenAt: 1, removedAt: null }] }))
  const src = readJson(c, 'source.json')
  fs.writeFileSync(path.join(c, 'source.json'), JSON.stringify({ ...src, ownerProfileId: p.id }))
  const app = await start(t, c)
  assert.ok(!fs.existsSync(path.join(c, 'users', 'owner.log')))
  assert.ok(!fs.existsSync(path.join(c, 'users', 'owner.json')))
  assert.deepEqual(app.users.get(p.id).playlists.get(PL).id, PL)
  assert.deepEqual(app.library.getTrack(p2c.id).uploaders, [p.id], '"owner" replaced in uploaders')
})

test('reconcile: two files for one id keep the one db.json names; an unknown id keeps its newest file and gets its file hash', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let app = await start(t, dir)
  const mp3 = makeMp3({ frames: 60, title: 'Doppio' })
  const up = json(await request(app.ports.http, 'PUT', '/api/upload/d.mp3', { body: mp3 })).track
  await app.close()
  // A replacement cut before db.json named the new file: an extra .wav under the same id.
  fs.writeFileSync(path.join(dir, 'library', up.id + '.wav'), makeWav({ freq: 999 }))
  // An id db.json does not know, with two files: the newer one stays.
  const lone = 'cd'.repeat(12)
  fs.writeFileSync(path.join(dir, 'library', lone + '.mp3'), makeMp3({ frames: 50 }))
  const newer = makeWav({ freq: 1111 })
  fs.writeFileSync(path.join(dir, 'library', lone + '.wav'), newer)
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(path.join(dir, 'library', lone + '.mp3'), old, old)
  app = await start(t, dir)
  assert.deepEqual(treeFiles(dir, 'library').sort(), [lone + '.wav', up.id + '.mp3'].sort())
  assert.equal(app.library.getTrack(up.id).format, 'mp3')
  const adopted = app.library.getTrack(lone)
  assert.equal(adopted.format, 'wav')
  assert.equal(adopted.fileHash, hash24(newer), 'hashed again')
  assert.deepEqual(adopted.uploaders, [])
})
