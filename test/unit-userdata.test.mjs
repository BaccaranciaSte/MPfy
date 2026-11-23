// User data on the principal source: foreign track ids (tracks of another
// source) kept in playlists, likes and recents, across restarts; POST /api/played
// with "at"; custom covers (PUT/DELETE /api/cover-for/:kind/:id) and the covers map.
// The person's data as a log: a change is one line whatever the person holds, a
// person at the caps is small in the heap, a .json of the format before is
// migrated with the same answers, whatever stops the migration.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { Users } from '../server/users.mjs'
import { UserLog, Person, NODE_FS, newEpochId, listCrc } from '../server/userlog.mjs'
import { HttpError } from '../server/errors.mjs'
import { makeWav, makeMp3, fakePng, tmpDir, cleanup, request, json } from './helpers.mjs'

const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)
const FOREIGN = 'f0'.repeat(12) // a track that lives on another source
const FOREIGN2 = 'e1'.repeat(12)
const ALBUM = '0a1b2c3d4e5f6071'

// A tiny "JPEG" (magic bytes are what the server checks).
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n), Buffer.from([0xff, 0xd9])])

// A PUT that declares a body over the limit and sends only its start: the answer
// must come at once (a whole 9 MB body would be cut by the reset on Windows).
function declaredTooBig (port, urlPath, length) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: urlPath, agent: false, headers: { 'content-length': length } }, (res) => {
      res.resume()
      resolve(res.statusCode)
      req.destroy()
    })
    req.on('error', reject)
    req.write(jpeg(100))
  })
}

// Every app a test starts is closed BEFORE its data dir is removed (cleanup()).
async function start (t, dir = null) {
  const c = cleanup(t)
  if (dir === null) dir = c.dir(tmpDir())
  const app = c.close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null }))
  return { app, dir, port: app.ports.http }
}

test('foreign ids: playlists, likes and recents keep tracks of other sources, also across a restart', async (t) => {
  let { app, port, dir } = await start(t)
  const { track } = json(await request(port, 'PUT', '/api/upload/locale.wav', { body: makeWav({ freq: 300 }) }))

  const { playlist } = json(await request(port, 'POST', '/api/playlists', { body: { name: 'Mista' } }))
  let r = await request(port, 'POST', '/api/playlists/' + playlist.id + '/tracks', { body: { trackIds: [FOREIGN, track.id, FOREIGN2] } })
  assert.equal(r.status, 200)
  assert.deepEqual(json(r).playlist.trackIds, [FOREIGN, track.id, FOREIGN2])
  r = await request(port, 'PATCH', '/api/playlists/' + playlist.id, { body: { trackIds: [FOREIGN2, FOREIGN, track.id] } })
  assert.equal(r.status, 200)
  r = await request(port, 'PUT', '/api/likes/' + FOREIGN)
  assert.equal(r.status, 200)
  assert.deepEqual(json(r).likes.map((l) => l.id), [FOREIGN])
  r = await request(port, 'POST', '/api/played', { body: { trackId: FOREIGN2, context: { type: 'playlist', id: playlist.id } } })
  assert.deepEqual(json(r), { ok: true })
  // Format is still checked.
  assert.equal((await request(port, 'PUT', '/api/likes/' + 'F0'.repeat(12))).status, 400)
  assert.equal((await request(port, 'POST', '/api/played', { body: { trackId: '../x' } })).status, 400)
  assert.equal((await request(port, 'POST', '/api/playlists/' + playlist.id + '/tracks', { body: { trackIds: ['nope'] } })).status, 400)

  // Deleting the local track removes only it.
  assert.equal((await request(port, 'DELETE', '/api/tracks/' + track.id)).status, 200)
  let lib = json(await request(port, 'GET', '/api/library'))
  assert.deepEqual(lib.tracks, [])
  assert.deepEqual(lib.playlists[0].trackIds, [FOREIGN2, FOREIGN])
  assert.deepEqual(lib.likes.map((l) => l.id), [FOREIGN])
  assert.deepEqual(lib.recents.map((x) => x.trackId), [FOREIGN2])

  // Restart: nothing of it is dropped (none of these tracks is in this library).
  await app.close()
  ;({ app, port } = await start(t, dir))
  lib = json(await request(port, 'GET', '/api/library'))
  assert.deepEqual(lib.playlists[0].trackIds, [FOREIGN2, FOREIGN])
  assert.deepEqual(lib.likes.map((l) => l.id), [FOREIGN])
  assert.deepEqual(lib.recents.map((x) => x.trackId), [FOREIGN2])
})

test('played: "at" within the last 30 days is kept (offline plays), otherwise the server time; recents stay newest first', async (t) => {
  const { port } = await start(t)
  const now = Date.now()
  const play = (trackId, at) => request(port, 'POST', '/api/played', { body: at === undefined ? { trackId } : { trackId, at } })
  const T = (n) => n.toString(16).padStart(24, '0')
  assert.equal((await play(T(1))).status, 200)
  assert.equal((await play(T(2), now - 2 * 3600e3)).status, 200) // two hours ago, sent now
  assert.equal((await play(T(3), now - 3600e3)).status, 200) // one hour ago
  assert.equal((await play(T(4), now - 40 * 24 * 3600e3)).status, 200) // too old: server time
  assert.equal((await play(T(5), now + 24 * 3600e3)).status, 200) // in the future: server time
  assert.equal((await play(T(6), 'ieri')).status, 400)
  const recents = json(await request(port, 'GET', '/api/library')).recents
  assert.deepEqual(recents.map((r) => r.trackId), [T(5), T(4), T(1), T(3), T(2)])
  assert.equal(recents[3].at, Math.round(now - 3600e3))
  assert.equal(recents[4].at, Math.round(now - 2 * 3600e3))
  assert.ok(recents[0].at >= now && recents[0].at <= Date.now(), 'future time replaced by the server time')
  assert.ok(recents[1].at >= now, 'too old: replaced by the server time')
})

test('custom covers: PUT both sizes, the covers map, DELETE back to automatic; files cleaned; kept across restarts', async (t) => {
  let { app, port, dir } = await start(t)
  const png = fakePng(9)
  const { track } = json(await request(port, 'PUT', '/api/upload/c.mp3', { body: makeMp3({ title: 'Con copertina', cover: png }) }))
  assert.equal(track.coverId, idOf(png))
  const { playlist } = json(await request(port, 'POST', '/api/playlists', { body: { name: 'Con foto' } }))

  const large = jpeg(2000)
  const small = jpeg(300)
  const put = (kind, id, size, data) => request(port, 'PUT', '/api/cover-for/' + kind + '/' + id + '?size=' + size, { body: data })
  let r = await put('album', ALBUM, 'large', large)
  assert.equal(r.status, 200)
  assert.deepEqual(json(r).covers, { track: {}, album: { [ALBUM]: { small: null, large: idOf(large) } }, playlist: {} })
  r = await put('album', ALBUM, 'small', small)
  assert.deepEqual(json(r).covers.album[ALBUM], { small: idOf(small), large: idOf(large) })
  assert.equal((await put('track', FOREIGN, 'large', large)).status, 200, 'a track of another source can have a cover here')
  assert.equal((await put('playlist', playlist.id, 'small', small)).status, 200)

  // Served like any cover, immutable by id, whatever ?size= says (they have no versions).
  const c = await request(port, 'GET', '/api/cover/' + idOf(small) + '?size=small')
  assert.equal(c.status, 200)
  assert.equal(c.headers['content-type'], 'image/jpeg')
  assert.match(c.headers['cache-control'], /immutable/)
  assert.ok(c.body.equals(small))
  assert.equal((await request(port, 'GET', '/api/cover/' + idOf(large) + '?size=large')).status, 200)

  const lib = json(await request(port, 'GET', '/api/library'))
  assert.deepEqual(lib.covers, {
    track: { [FOREIGN]: { small: null, large: idOf(large) } },
    album: { [ALBUM]: { small: idOf(small), large: idOf(large) } },
    playlist: { [playlist.id]: { small: idOf(small), large: null } }
  })

  // Validation, before the body is read.
  assert.equal((await put('artist', ALBUM, 'large', large)).status, 400)
  assert.equal((await put('album', 'xyz', 'large', large)).status, 400)
  assert.equal((await put('track', ALBUM, 'large', large)).status, 400, 'a track id is 24 hex')
  assert.equal((await put('album', ALBUM, 'medium', large)).status, 400)
  assert.equal((await request(port, 'PUT', '/api/cover-for/album/' + ALBUM, { body: large })).status, 400, 'size is required')
  r = await put('album', ALBUM, 'large', Buffer.from('<svg>non e una foto</svg>'))
  assert.equal(r.status, 415)
  assert.match(json(r).error, /JPEG/)
  assert.equal(await declaredTooBig(port, '/api/cover-for/album/' + ALBUM + '?size=large', 9 * 1024 * 1024), 413)

  // Restart: the map survives.
  await app.close()
  ;({ app, port } = await start(t, dir))
  assert.deepEqual(json(await request(port, 'GET', '/api/library')).covers.album[ALBUM], { small: idOf(small), large: idOf(large) })

  // Back to automatic: the album entry goes; "large" is still the foreign track's cover.
  r = await request(port, 'DELETE', '/api/cover-for/album/' + ALBUM)
  assert.equal(r.status, 200)
  assert.deepEqual(json(r).covers.album, {})
  const coverFile = (id) => path.join(dir, 'covers', id + '.jpg')
  assert.ok(fs.existsSync(coverFile(idOf(large))), 'still used by the track cover')
  assert.ok(fs.existsSync(coverFile(idOf(small))), 'still used by the playlist cover')
  // The playlist goes, and its cover with it: small is now unused.
  assert.equal((await request(port, 'DELETE', '/api/playlists/' + playlist.id)).status, 200)
  assert.deepEqual(json(await request(port, 'GET', '/api/library')).covers.playlist, {})
  assert.ok(!fs.existsSync(coverFile(idOf(small))), 'an unused custom cover is deleted')
  r = await request(port, 'DELETE', '/api/cover-for/track/' + FOREIGN)
  assert.ok(!fs.existsSync(coverFile(idOf(large))))
  // The embedded cover was never touched.
  assert.ok(fs.existsSync(path.join(dir, 'covers', idOf(png) + '.png')))
  assert.equal((await request(port, 'DELETE', '/api/cover-for/album/' + ALBUM)).status, 200, 'deleting nothing is fine')
})

test('db: an old db.json (no covers, no lossless) loads; covers whose image is gone are forgotten', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const wav = makeWav({ freq: 410 })
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'covers'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'library', idOf(wav) + '.wav'), wav)
  const present = jpeg(100)
  fs.writeFileSync(path.join(dir, 'covers', idOf(present) + '.jpg'), present)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    schema: 1,
    version: 3,
    tracks: [{ id: idOf(wav), title: 'Vecchio', artist: 'A', album: 'B', albumArtist: 'A', format: 'wav', mime: 'audio/wav', size: wav.length, addedAt: 1 }],
    playlists: [],
    likes: [{ id: FOREIGN, at: 1 }],
    recents: [],
    covers: { album: { [ALBUM]: { small: idOf(present), large: 'ab'.repeat(12) } }, bogus: { x: { small: 'y' } } }
  }))
  const { port } = await start(t, dir)
  const lib = json(await request(port, 'GET', '/api/library'))
  assert.equal(lib.tracks[0].title, 'Vecchio')
  assert.equal(lib.tracks[0].lossless, true, 'a WAV is lossless')
  assert.deepEqual(lib.tracks[0].qualities, { low: false, normal: false, high: false })
  assert.deepEqual(lib.likes.map((l) => l.id), [FOREIGN])
  assert.deepEqual(lib.covers, { track: {}, album: { [ALBUM]: { small: idOf(present), large: null } }, playlist: {} })
  // The owner's data of that db.json lives in users/owner.log; db.json stays as it was.
  assert.ok(fs.existsSync(path.join(dir, 'users', 'owner.log')))
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.json')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).schema, 1, 'db.json untouched: an older MPfy still reads it')
})

// ------------------------------------------------------------------ the person's log

const T = (n) => n.toString(16).padStart(24, '0')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

// A person written straight as a log: `likes` likes and `entries` playlist entries in
// playlists of `perList`, every id distinct (none a track of this source).
function writePerson (dir, key, { likes = 0, entries = 0, perList = 200 } = {}) {
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true })
  const v = 1000
  const person = new Person({ likes, ids: likes + entries })
  for (let i = 0; i < likes; i++) person.likes.add(person.table.intern('a' + i.toString(16).padStart(23, '0')), 1700000000000 + i, v)
  for (let k = 0, done = 0; done < entries; k++) {
    const id = k.toString(16).padStart(16, '0')
    person.apply({ v, o: 'pc', p: { id, name: 'Playlist ' + k, description: '', trackIds: [], createdAt: 1, updatedAt: 1 } })
    const n = Math.min(perList, entries - done)
    const ids = []
    for (let j = 0; j < n; j++) ids.push('b' + (done + j).toString(16).padStart(23, '0'))
    person.apply({ v, o: 'pa', id, pos: 0, ids, at: 1 })
    done += n
  }
  const log = new UserLog({ file: path.join(dir, 'users', key + '.log'), key })
  log.writeWholeSync(person, { v, epochs: [{ id: newEpochId(), first: v, last: v }] })
  log.close()
}

function loadUsers (t, dir, opts = {}) {
  const users = new Users({ dataDir: dir, ...opts })
  users.load()
  t.after(() => users.close())
  return users
}

test('a like at 100,000 likes appends one line and does not rewrite the person\'s file', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, 'owner', { likes: 100000 - 2 })
  const file = path.join(dir, 'users', 'owner.log')
  const before = fs.readFileSync(file)
  const users = loadUsers(t, dir)
  const user = users.get('owner')
  assert.equal(user.p.likes.live, 100000 - 2)
  user.like(T(7))
  const after = fs.readFileSync(file)
  assert.ok(after.subarray(0, before.length).equals(before), 'the file as it was')
  const lines = after.subarray(before.length).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.o || 'epoch'), ['epoch', 'l'], 'the first change of a run opens its epoch in the same write')
  user.like(T(8))
  const again = fs.readFileSync(file)
  const line = JSON.stringify({ v: user.version, o: 'l', id: T(8), at: user.p.likes.atOf(user.p.table.find(T(8))) }) + '\n'
  assert.equal(again.subarray(after.length).toString('utf8'), line, 'one line')
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.json')), 'no .json written')
})

test('a like costs the same at 300,000 likes as at 1,000', (t) => {
  const time = (n) => {
    const dir = cleanup(t).dir(tmpDir())
    writePerson(dir, 'owner', { likes: n })
    // The cost of the change, whatever the cap allows.
    const user = loadUsers(t, dir, { caps: { likes: Infinity } }).get('owner')
    user.like(T(1))
    const start = performance.now()
    for (let i = 2; i < 2002; i++) user.like(T(i))
    for (let i = 2; i < 1002; i++) user.unlike(T(i))
    return performance.now() - start
  }
  const small = time(1000)
  const big = time(300000)
  assert.ok(big < Math.max(4 * small, 250), '3,000 changes: ' + Math.round(small) + ' ms at 1,000 likes, ' + Math.round(big) + ' ms at 300,000')
})

test('a person at 300,000 likes and 300,000 entries of distinct foreign ids holds under 6 MB of heap once loaded', { timeout: 300000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, 'owner', { likes: 300000, entries: 300000 })
  const script = `
    const { Users } = await import(${JSON.stringify(new URL('../server/users.mjs', import.meta.url).href)})
    const gc = () => { for (let i = 0; i < 4; i++) globalThis.gc() }
    gc()
    const h0 = process.memoryUsage().heapUsed
    const users = new Users({ dataDir: ${JSON.stringify(dir)} })
    users.load()
    // Nobody is loaded at start: the person is opened, then measured.
    const u = users.get('owner')
    globalThis.kept = users
    gc()
    const h1 = process.memoryUsage().heapUsed
    process.stdout.write(JSON.stringify({ heap: h1 - h0, likes: u.p.likes.live, entries: u.p.entries }))
    users.close()`
  const out = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 1 << 20 }))
  assert.equal(out.likes, 300000)
  assert.equal(out.entries, 300000)
  assert.ok(out.heap < 6 * 1024 * 1024, (out.heap / 1048576).toFixed(2) + ' MB')
})

test('a refused request writes nothing and changes nothing; what changes nothing writes nothing', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, 'owner', { likes: 100000 - 1 })
  const users = loadUsers(t, dir)
  const user = users.get('owner')
  const p = user.createPlaylist({ name: 'P' })
  user.addToPlaylist(p.id, [T(1), T(2)])
  user.like(T(9))
  const file = users.fileOf('owner')
  const size = fs.statSync(file).size
  const version = user.version
  const view = JSON.stringify(user.p.view())
  const refused = [
    () => user.like(T(10)), // the cap
    () => user.like('nope'),
    () => user.addToPlaylist(p.id, [T(3), 'zz']),
    () => user.addToPlaylist('0'.repeat(16), [T(3)]),
    () => user.addToPlaylist(p.id, [T(3)], -1),
    () => user.updatePlaylist(p.id, { name: '' }),
    () => user.updatePlaylist(p.id, { trackIds: [T(1)], base: ['x'] }),
    () => user.removeFromPlaylist(p.id, [5]),
    () => user.removeFromPlaylist(p.id, [0], [T(1)], [0]),
    () => user.setPlaylistCover(p.id, 'medium', 'ab'.repeat(12)),
    () => user.played(T(1), { type: 'radio' }),
    () => user.bulkLikes({ add: [T(11), T(12)] }),
    () => user.bulkLikes({ add: [T(11), 'x'] }),
    () => user.bulkLikes({ add: 'x' }),
    () => user.createPlaylist({ id: p.id }),
    () => user.deletePlaylist('nope')
  ]
  for (const fn of refused) {
    assert.throws(fn, (err) => err instanceof HttpError && err.status < 500)
    assert.equal(fs.statSync(file).size, size)
    assert.equal(user.version, version)
    assert.equal(JSON.stringify(user.p.view()), view)
  }
  assert.throws(() => user.bulkLikes({ add: [T(11), T(12)] }), (err) => err.code === 'too_many_likes' && err.message === 'Troppi brani piaciuti')
  // What changes nothing writes nothing either.
  user.like(T(9))
  user.unlike(T(99))
  user.removeFromPlaylist(p.id, [1], [T(5)])
  user.clearPlaylistCover(p.id)
  assert.equal(fs.statSync(file).size, size)
  assert.equal(user.version, version)
  // The ids of a refused request never enter the person's id table.
  const n = user.p.table.n
  assert.throws(() => user.updatePlaylist(p.id, { trackIds: Array.from({ length: 20001 }, (_, i) => T(i)) }), HttpError)
  assert.throws(() => user.addToPlaylist(p.id, [T(500), 'bad']), HttpError)
  user.removeFromPlaylist(p.id, [0], [T(600)])
  assert.equal(user.p.table.n, n)
})

test('bulk likes: removes then adds in order, each as the newest at one time, one version and one line; counts; cap and shapes refused', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const users = loadUsers(t, dir)
  const user = users.get('owner')
  for (const i of [1, 2, 3]) user.like(T(i))
  const v = user.version
  const size = fs.statSync(users.fileOf('owner')).size
  const r = user.bulkLikes({ add: [T(4), T(2), T(5), T(4), T(1)], remove: [T(1), T(6), T(1)] })
  assert.deepEqual(r, { added: 3, removed: 1 })
  assert.equal(user.version, v + 1)
  const added = fs.readFileSync(users.fileOf('owner'), 'utf8').slice(size).trim().split('\n')
  assert.equal(added.length, 1)
  assert.equal(JSON.parse(added[0]).o, 'lb')
  // T(2) stays where it was; T(1) removed then added: the newest with the others of the request.
  assert.deepEqual(user.likes.map((l) => l.id), [T(1), T(5), T(4), T(3), T(2)])
  const at = user.likes[0].at
  assert.deepEqual(user.likes.slice(0, 3).map((l) => l.at), [at, at, at])
  assert.deepEqual(user.bulkLikes({ add: [T(2)] }), { added: 0, removed: 0 })
  assert.equal(user.version, v + 1, 'nothing to do: no version')
  assert.deepEqual(user.bulkLikes({}), { added: 0, removed: 0 })
  const many = Array.from({ length: 5001 }, (_, i) => T(i))
  assert.throws(() => user.bulkLikes({ add: many }), (err) => err.code === 'bad_request')
  assert.throws(() => user.bulkLikes(null), (err) => err.code === 'bad_request')
  assert.throws(() => user.bulkLikes({ remove: [1] }), (err) => err.status === 400 && err.message === 'Identificativo del brano non valido')
  const likes = user.likes
  users.close()
  assert.deepEqual(loadUsers(t, dir).get('owner').likes, likes)
})

test('the answers serialize as they always did: likes from a view, playlists from their records; the whole likes list written in slices', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const users = loadUsers(t, dir)
  const user = users.get('owner')
  user.bulkLikes({ add: Array.from({ length: 5000 }, (_, i) => T(i)) })
  user.bulkLikes({ add: Array.from({ length: 5000 }, (_, i) => T(5000 + i)) })
  user.bulkLikes({ add: Array.from({ length: 2000 }, (_, i) => T(10000 + i)) })
  const p = user.createPlaylist({ name: 'P', description: 'd' })
  user.addToPlaylist(p.id, [T(5), T(6)])
  const list = user.likes
  assert.equal(JSON.stringify({ likes: user.like(T(3)) }), JSON.stringify({ likes: list }))
  assert.equal(JSON.stringify(user.snapshot()), JSON.stringify({ playlists: [user.publicPlaylist(p)], likes: list, recents: [], playlist: {} }))
  assert.deepEqual(Object.keys(user.publicPlaylist(p)), ['id', 'name', 'description', 'trackIds', 'createdAt', 'updatedAt'])
  assert.deepEqual(user.publicPlaylist(p).trackIds, [T(5), T(6)])
  assert.equal(JSON.stringify(p), JSON.stringify(user.publicPlaylist(p)))
  // Backpressure: every third write says "wait".
  const chunks = []
  let n = 0
  const out = new EventEmitter()
  out.write = (s) => {
    chunks.push(s)
    if (++n % 3 === 0) {
      setImmediate(() => out.emit('drain'))
      return false
    }
    return true
  }
  assert.equal(await user.writeLikes(out), true)
  assert.equal(chunks.join(''), JSON.stringify(list))
  assert.ok(chunks.length >= 3, 'in slices of 5,000')
})

test('changes since a version: playlists changed, made again and removed, likes, plays, covers; long playlists as their edits', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const users = loadUsers(t, dir)
  const user = users.get('owner')
  const long = user.createPlaylist({ name: 'Lunga' })
  user.addToPlaylist(long.id, Array.from({ length: 1500 }, (_, i) => T(i % 700)))
  const short = user.createPlaylist({ name: 'Corta' })
  const gone = user.createPlaylist({ name: 'Via' })
  user.setPlaylistCover(gone.id, 'small', 'ab'.repeat(12))
  user.like(T(1))
  user.like(T(2))
  const e = user.epoch
  const u = user.version
  // The added likes come as an iterable read while the answer is written.
  const listed = (l) => ({ ...l, added: [...l.added] })
  const none = user.changesSince(e, u, { edits: true })
  assert.deepEqual({ ...none, likes: listed(none.likes) }, {
    version: u, epoch: e, playlists: { changed: [], removed: [], edits: new Map() }, likes: { added: [], removed: [] }, recents: false, covers: []
  })
  user.addToPlaylist(long.id, [T(900), T(901)], 3)
  user.removeFromPlaylist(long.id, [0, 10], [T(0), T(10)])
  user.updatePlaylist(short.id, { name: 'Corta 2' })
  user.deletePlaylist(gone.id)
  user.createPlaylist({ id: gone.id, name: 'Di nuovo' })
  user.unlike(T(1))
  user.like(T(3))
  user.played(T(3))
  const c = user.changesSince(e, u, { edits: true })
  assert.deepEqual(c.playlists.changed, [short.id, gone.id], 'in Map order; made again: changed and removed')
  assert.deepEqual(c.playlists.removed, [gone.id])
  const ed = c.playlists.edits.get(long.id)
  // T(10) moved to 12 with the add: removed where it is now.
  assert.deepEqual(ed.ops, [['a', 3, [T(900), T(901)]], ['r', [0, 12]]])
  assert.deepEqual([ed.from, ed.to], [1500, 1500])
  assert.equal(ed.crc, listCrc(user.playlists.get(long.id).trackIds))
  assert.deepEqual(listed(c.likes), { added: [[T(3), user.likes[0].at]], removed: [T(1)] })
  assert.equal(c.recents, true)
  assert.deepEqual(c.covers, [gone.id])
  // Without edits the long playlist is a changed one; a rename makes it one too.
  assert.deepEqual(user.changesSince(e, u).playlists.changed, [long.id, short.id, gone.id])
  user.updatePlaylist(long.id, { name: 'Rinominata' })
  assert.equal(user.changesSince(e, u, { edits: true }).playlists.edits.size, 0)
  // More than 32 edits: the whole playlist.
  const v2 = user.version
  for (let i = 0; i < 33; i++) user.addToPlaylist(long.id, [T(i)])
  assert.deepEqual(user.changesSince(e, v2, { edits: true }).playlists.changed, [long.id])
  assert.equal(listCrc([]), '00000000')
  assert.equal(listCrc(['a']), 'e8b7be43')
  assert.equal(listCrc(['136a75f36a9c9493fc4187b8', 'f0f0f0f0f0f0f0f0f0f0f0f0', '136a75f36a9c9493fc4187b8']), '242a06cb')
  // After a restart the same answers, from the log.
  const before = user.changesSince(e, v2, { edits: true })
  const likes = listed(user.changesSince(e, u).likes)
  users.close()
  const back = loadUsers(t, dir).get('owner')
  assert.deepEqual(back.changesSince(e, v2, { edits: true }).playlists.changed, before.playlists.changed)
  assert.deepEqual(listed(back.changesSince(e, u).likes), likes)
})

test('the playlist rules of the source are the page\'s file, byte for byte', () => {
  const page = new URL('../web/js/userops.js', import.meta.url)
  const source = new URL('../server/userops.mjs', import.meta.url)
  assert.ok(fs.readFileSync(source).equals(fs.readFileSync(page)), 'server/userops.mjs differs from web/js/userops.js')
})

// Every person the histories of fixtures-library.mjs leave in users/ (and two odd ones), as
// MPfy 2.4.1 wrote them; sha: the sha256 of each answer MPfy 2.4.1 gives for it.
const PERSONS = [
  {
    name: 'owner/restart/owner',
    key: 'owner',
    data: {"schema":1,"version":1767225602032,"playlists":[{"id":"0123456789abcdef","name":"La mia playlist n. 1","description":"","trackIds":["136a75f36a9c9493fc4187b8","f012e680d3cd79dedf26add6","c73a7aa55112aa2cace4759d","e1e1e1e1e1e1e1e1e1e1e1e1"],"createdAt":1767227497000,"updatedAt":1767227539000},{"id":"1111111111111111","name":"Viaggio lungo","description":"","trackIds":["f012e680d3cd79dedf26add6","f0f0f0f0f0f0f0f0f0f0f0f0"],"createdAt":1767227498000,"updatedAt":1767227539000}],"likes":[{"id":"f0f0f0f0f0f0f0f0f0f0f0f0","at":1767227489000},{"id":"136a75f36a9c9493fc4187b8","at":1767227487000}],"recents":[{"trackId":"f012e680d3cd79dedf26add6","at":1767227533000,"context":{"type":"search"}},{"trackId":"f012e680d3cd79dedf26add6","at":1767227529000,"context":{"type":"library"}},{"trackId":"136a75f36a9c9493fc4187b8","at":1767227528000,"context":{"type":"playlist","id":"0123456789abcdef"}},{"trackId":"f0f0f0f0f0f0f0f0f0f0f0f0","at":1767220330000,"context":{"type":"liked"}},{"trackId":"c73a7aa55112aa2cace4759d","at":1767216731000,"context":{"type":"album","id":"65635b422fc84691"}}],"covers":{"playlist":{"1111111111111111":{"small":"041bb61b8d0044023c543f37","large":"62b8dc9f1c604ec5385dc4ca"}}}},
    sha: {
      snapshot: '6f7eb65492385c92594bf5cdd7d872b9852c0deab0726c15ae8f9c319b70b2f4',
      covers: 'c040b4dcd5a69275e24d5e3a28d09db67188473e3835db9d12d48bafa51fad23',
      recents: '815dc6cdab7d10c908c26e3c62a9f550007b3047cc954381e30537980c45fb26',
      older: '815dc6cdab7d10c908c26e3c62a9f550007b3047cc954381e30537980c45fb26',
      data: 'e3d3129fdd36a5acf1ddc968c64aeba7d173779a7fb314d71b366619b745f135'
    }
  },
  {
    name: 'owner/end/owner',
    key: 'owner',
    data: {"schema":1,"version":1767227541002,"playlists":[{"id":"0123456789abcdef","name":"La mia playlist n. 1","description":"","trackIds":["136a75f36a9c9493fc4187b8","f012e680d3cd79dedf26add6","c73a7aa55112aa2cace4759d","e1e1e1e1e1e1e1e1e1e1e1e1"],"createdAt":1767227497000,"updatedAt":1767227539000},{"id":"1111111111111111","name":"Viaggio lungo","description":"","trackIds":["f012e680d3cd79dedf26add6","f0f0f0f0f0f0f0f0f0f0f0f0"],"createdAt":1767227498000,"updatedAt":1767227539000}],"likes":[{"id":"f012e680d3cd79dedf26add6","at":1767227545000},{"id":"f0f0f0f0f0f0f0f0f0f0f0f0","at":1767227489000},{"id":"136a75f36a9c9493fc4187b8","at":1767227487000}],"recents":[{"trackId":"c73a7aa55112aa2cace4759d","at":1767227546000,"context":{"type":"artist","id":"le-boe"}},{"trackId":"f012e680d3cd79dedf26add6","at":1767227533000,"context":{"type":"search"}},{"trackId":"f012e680d3cd79dedf26add6","at":1767227529000,"context":{"type":"library"}},{"trackId":"136a75f36a9c9493fc4187b8","at":1767227528000,"context":{"type":"playlist","id":"0123456789abcdef"}},{"trackId":"f0f0f0f0f0f0f0f0f0f0f0f0","at":1767220330000,"context":{"type":"liked"}},{"trackId":"c73a7aa55112aa2cace4759d","at":1767216731000,"context":{"type":"album","id":"65635b422fc84691"}}],"covers":{"playlist":{"1111111111111111":{"small":"041bb61b8d0044023c543f37","large":"62b8dc9f1c604ec5385dc4ca"}}}},
    sha: {
      snapshot: '263e85425b7ceefe2ae716637d6d39e3e32a3fc17dd4b396166d5282a4af3f75',
      covers: 'c040b4dcd5a69275e24d5e3a28d09db67188473e3835db9d12d48bafa51fad23',
      recents: '9aa4af093d9555989b6d7b63e3e06af1944bb582a60fbd5fe9edd4dc953cb70e',
      older: '346e9dd86fcbf5275a327db499079991926a3f75e3777f03ebfd5ab107a80759',
      data: '3c0bc5acb28faee36f6a9215faec185be1f948c81358625141f2209f38325e70'
    }
  },
  {
    name: 'people/restart/965f7fa305b34d115bae9d09edb32200',
    key: '965f7fa305b34d115bae9d09edb32200',
    data: {"schema":1,"version":1767225614007,"playlists":[{"id":"4444444444444444","name":"Di Sara","description":"","trackIds":["29c053b382f0696d7894f228"],"createdAt":1767225620000,"updatedAt":1767225633000}],"likes":[{"id":"29c053b382f0696d7894f228","at":1767225624000}],"recents":[],"covers":{"playlist":{"4444444444444444":{"small":"8b88e56b0155d655f780a99b","large":null}}}},
    sha: {
      snapshot: '3ed323fe49a2d5771262450d854f7642607f526a28983d725b67977570c42ee1',
      covers: 'a0431839c50a270a26be957a37b93144cf116a06f1d9dbc59ccecb62ff95f317',
      recents: '346e9dd86fcbf5275a327db499079991926a3f75e3777f03ebfd5ab107a80759',
      older: '346e9dd86fcbf5275a327db499079991926a3f75e3777f03ebfd5ab107a80759',
      data: '276f9fbde35f9282ce54fb574b55e5739297b1f558f89862a5efcd8d264078ba'
    }
  },
  {
    name: 'people/restart/d478a190f197e2305143eea4379b7a41',
    key: 'd478a190f197e2305143eea4379b7a41',
    data: {"schema":1,"version":1767225609004,"playlists":[{"id":"3333333333333333","name":"Spiaggia","description":"","trackIds":["29c053b382f0696d7894f228","f0f0f0f0f0f0f0f0f0f0f0f0"],"createdAt":1767225603000,"updatedAt":1767225604000}],"likes":[],"recents":[{"trackId":"29c053b382f0696d7894f228","at":1767225606000,"context":{"type":"library"}}],"covers":{"playlist":{}}},
    sha: {
      snapshot: '59a450f106a63b22a08864d0dec1711c4de43576a4faa297fbd50788cce891e7',
      covers: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      recents: '0839d0b508a7654c40adbb6405e5fdac642393e440acb7f9c4896f18033d065c',
      older: '0839d0b508a7654c40adbb6405e5fdac642393e440acb7f9c4896f18033d065c',
      data: 'cf28d54c9c955559257db7edb75746e7394010aaaba604c7c268ea96f9a78c27'
    }
  },
  {
    name: 'people/restart/965f7fa305b34d115bae9d09edb32200',
    key: '965f7fa305b34d115bae9d09edb32200',
    data: {"schema":1,"version":1767225637001,"playlists":[{"id":"4444444444444444","name":"Di Sara","description":"","trackIds":["29c053b382f0696d7894f228"],"createdAt":1767225620000,"updatedAt":1767225633000},{"id":"3333333333333333","name":"Spiaggia","description":"","trackIds":["29c053b382f0696d7894f228","f0f0f0f0f0f0f0f0f0f0f0f0"],"createdAt":1767225603000,"updatedAt":1767225604000}],"likes":[{"id":"29c053b382f0696d7894f228","at":1767225624000}],"recents":[{"trackId":"29c053b382f0696d7894f228","at":1767225606000,"context":{"type":"library"}}],"covers":{"playlist":{"4444444444444444":{"small":"8b88e56b0155d655f780a99b","large":null}}}},
    sha: {
      snapshot: '0df6ebcf7cf2f2c800f2c5581be0cd22dd6c3ee39ea42d85b9c748182053e35d',
      covers: 'a0431839c50a270a26be957a37b93144cf116a06f1d9dbc59ccecb62ff95f317',
      recents: '0839d0b508a7654c40adbb6405e5fdac642393e440acb7f9c4896f18033d065c',
      older: '0839d0b508a7654c40adbb6405e5fdac642393e440acb7f9c4896f18033d065c',
      data: '466d6fc84267d38becbcb73db6c8e76af1238060cfc8d1bdf1b2330e92f3fbfa'
    }
  },
  {
    name: 'older-dir/restart/8bd4d8d27c80b22892cfc4c340102cfe',
    key: '8bd4d8d27c80b22892cfc4c340102cfe',
    data: {"schema":1,"version":1767225609001,"playlists":[{"id":"5555555555555555","name":"In auto","description":"Le solite","trackIds":["2b639f985d31ac3156bdef63","f0f0f0f0f0f0f0f0f0f0f0f0","2b639f985d31ac3156bdef63","e1e1e1e1e1e1e1e1e1e1e1e1"],"createdAt":1766620800000,"updatedAt":1767225607000},{"id":"0123456789abcdef","name":"Vuota","description":"","trackIds":[],"createdAt":1766793600000,"updatedAt":1766793600000,"color":"blu"}],"likes":[{"id":"e1e1e1e1e1e1e1e1e1e1e1e1","at":1767225605000},{"id":"f0f0f0f0f0f0f0f0f0f0f0f0","at":1766880000000},{"id":"2b639f985d31ac3156bdef63","at":1766793600000}],"recents":[{"trackId":"2b639f985d31ac3156bdef63","at":1767052800000,"context":{"type":"playlist","id":"5555555555555555"}},{"trackId":"e1e1e1e1e1e1e1e1e1e1e1e1","at":1766966400000,"context":{"type":"library"}}],"covers":{"playlist":{"5555555555555555":{"small":"a1756ed131dedadee07351ba","large":"a1756ed131dedadee07351ba"}}}},
    sha: {
      snapshot: '6e552dba05c1d40d7f3c793e24357be9f4b55354ed0f562d1c1bc7e3291e41ce',
      covers: 'c0ef3f476a1f8bbdf36ce69ed0560eb49ff3a22b7fb18aab710c47153db70e14',
      recents: '85dd555c28a2175d547d5bf9f60200a6ce55d4e57e1beccc29d8512387d0cc23',
      older: '85dd555c28a2175d547d5bf9f60200a6ce55d4e57e1beccc29d8512387d0cc23',
      data: '94109aa3d6c685a8d4f0db03507a45e84b3d7a94e651ee3aa9c12e2f3f802c0e'
    }
  },
  {
    name: 'odd/fields',
    key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    data: {"schema":1,"version":"x","mine":{"a":1},"zeta":[1,2],"playlists":[{"id":"0123456789abcdef","trackIds":["000000000000000000000001","bad","000000000000000000000002","000000000000000000000001"],"extra":"kept","createdAt":"5"},{"id":"0123456789abcdef","name":"dup"},{"id":"BAD","name":"x"},null,{"name":"first","id":"fedcba9876543210","description":7,"trackIds":"no","updatedAt":3,"createdAt":2}],"likes":[{"id":"000000000000000000000003","at":9},{"id":"000000000000000000000003","at":10},{"id":"nope"},{"id":"000000000000000000000004"},null],"recents":[{"trackId":"000000000000000000000005","at":4,"context":{"type":"radio"}},{"trackId":"000000000000000000000006","at":3,"context":{"type":"album","id":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}},{"trackId":"bad"}],"covers":{"odd":{"x":1},"playlist":{"0123456789abcdef":{"small":"zz","large":"abababababababababababab"},"fedcba9876543210":{"small":null,"large":null},"bad":{"small":"abababababababababababab"}}}},
    sha: {
      snapshot: '078639fdd1e7311839f833192a2ed7660488938a0e711219cd97902ce2de091b',
      covers: '215351e66810d36001bb2ab89a176ae894df3f7048bdcd741066cc4f6c29dd9f',
      recents: '45275ea86f3dbfa61962a16901f9827907318cd606391647b7c1f1ac6b2460ab',
      older: '45275ea86f3dbfa61962a16901f9827907318cd606391647b7c1f1ac6b2460ab',
      data: '2518f75189afceee4a439c930d9a9a6645379c11330664fffd9e321dbff0f603'
    }
  },
  {
    name: 'odd/caps',
    key: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    data: null,
    sha: {
      snapshot: '75f0e103a7d0627a59421fb964458482f6115d7d5906f30630d578acc31db92b',
      covers: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      recents: '2a9cf64ba48d1f0e0d936bceb4e5b907e9f1cd9a27aa41ac2e765c639269a2a0',
      older: '15ad2995b8b0b51c260d712ec82f197d60e5341ef40531a7f17d5df64a2f1ee9',
      data: 'a5127e017dbaf73b752903cb12034f521703726fc409be81e7ac8807e6879c8a'
    }
  }
]

function oddCaps () {
  const many = []
  for (let i = 0; i < 1100; i++) many.push({ trackId: T(i), at: 100000 - i, context: { type: 'library' } })
  return {
    schema: 1,
    version: 3,
    playlists: [{ id: '1111111111111111', name: 'Lunga', description: '', trackIds: Array.from({ length: 20050 }, (_, i) => T(i % 300)), createdAt: 1, updatedAt: 2 }],
    likes: Array.from({ length: 3000 }, (_, i) => ({ id: T(i), at: 50000 - (i % 7) })),
    recents: many,
    covers: { playlist: {} }
  }
}

function answersOf (u) {
  const data = u._data()
  delete data.version
  return {
    snapshot: sha(JSON.stringify(u.snapshot())),
    covers: sha(JSON.stringify(u.playlistCoversSnapshot())),
    recents: sha(JSON.stringify(u.recentsPage(null, 200))),
    older: sha(JSON.stringify(u.recentsPage(u.recents.length > 5 ? u.recents[5].at : null, 200))),
    data: sha(JSON.stringify(data))
  }
}

// File calls that, from the k-th change on disk, all fail: the process stopped there.
function stopAt (k) {
  let n = 0
  const step = (fn) => (...args) => {
    if (n++ >= k) throw Object.assign(new Error('stopped'), { code: 'EIO' })
    return fn(...args)
  }
  const fsx = { ...NODE_FS }
  for (const name of ['writeSync', 'fsyncSync', 'fdatasyncSync', 'closeSync', 'renameSync', 'fsyncDir', 'unlinkSync', 'ftruncateSync']) fsx[name] = step(NODE_FS[name])
  fsx.openSync = (p, flags, mode) => (flags === 'r' ? NODE_FS.openSync(p, flags, mode) : step(NODE_FS.openSync)(p, flags, mode))
  fsx.steps = () => n
  return fsx
}

test('migration: every fixture person answers byte for byte as before, after the migration, after a restart, and after a stop at any step of it', (t) => {
  for (const person of PERSONS) {
    const text = JSON.stringify(person.data || oddCaps())
    const fresh = () => {
      const dir = cleanup(t).dir(tmpDir())
      fs.mkdirSync(path.join(dir, 'users'))
      fs.writeFileSync(path.join(dir, 'users', person.key + '.json'), text)
      return dir
    }
    const dir = fresh()
    const users = new Users({ dataDir: dir })
    users.load()
    assert.deepEqual(answersOf(users.get(person.key)), person.sha, person.name + ': migrated')
    users.close()
    assert.equal(fs.readFileSync(path.join(dir, 'users', person.key + '.json'), 'utf8'), text, 'the .json untouched')
    const again = new Users({ dataDir: dir })
    again.load()
    assert.deepEqual(answersOf(again.get(person.key)), person.sha, person.name + ': from the log')
    again.close()
    // The process stopped at each step of the migration, then started again.
    const counting = stopAt(Infinity)
    const probe = new Users({ dataDir: fresh(), fsx: counting })
    probe.load()
    probe.close()
    const steps = counting.steps()
    assert.ok(steps >= 6, steps + ' steps')
    for (let k = 0; k < steps; k++) {
      const d = fresh()
      const stopped = new Users({ dataDir: d, fsx: stopAt(k) })
      stopped.load()
      const next = new Users({ dataDir: d })
      next.load()
      assert.deepEqual(answersOf(next.get(person.key)), person.sha, person.name + ': stopped at step ' + k)
      next.close()
    }
  }
})

test('migration: a .json an older MPfy wrote after the log was made sends the log aside, kept, and is migrated again', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir, 'users'))
  const jsonFile = path.join(dir, 'users', 'owner.json')
  fs.writeFileSync(jsonFile, JSON.stringify({ schema: 1, version: 2, playlists: [], likes: [{ id: T(1), at: 1 }], recents: [] }))
  let users = new Users({ dataDir: dir })
  users.load()
  users.get('owner').like(T(2))
  users.close()
  // The downgrade: the older MPfy writes its .json (it never saw T(2)) and likes T(3).
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.writeFileSync(jsonFile, JSON.stringify({ schema: 1, version: 9, playlists: [], likes: [{ id: T(3), at: 3 }, { id: T(1), at: 1 }], recents: [] }))
  users = new Users({ dataDir: dir })
  users.load()
  assert.deepEqual(users.get('owner').likes.map((l) => l.id), [T(3), T(1)])
  const kept = fs.readdirSync(path.join(dir, 'users')).filter((n) => n.startsWith('owner.log.replaced-'))
  assert.equal(kept.length, 1, 'the newer log kept')
  assert.match(fs.readFileSync(path.join(dir, 'users', kept[0]), 'utf8'), new RegExp(T(2)))
  // And the log is the truth from now on.
  users.get('owner').like(T(4))
  users.close()
  const back = new Users({ dataDir: dir })
  back.load()
  assert.deepEqual(back.get('owner').likes.map((l) => l.id), [T(4), T(3), T(1)])
  back.close()
})
