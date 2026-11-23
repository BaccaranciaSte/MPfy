// People loaded when they are needed, on the source. A start reads only what each
// person's log says of itself (its versions and epochs, its playlist and cover ids);
// a request opens the person it needs and lets it go; a person nobody held for 10
// minutes leaves memory. A track removed everywhere is one line appended to the log
// of each person not loaded and a sweep in slices for each person loaded. A merge
// (the claim, set-owner --move-data) works on the tables and holds both people until
// it ends. export-compat writes the files an older MPfy reads.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMPfy } from '../server/app.mjs'
import { Users } from '../server/users.mjs'
import { UserLog, Person, newEpochId, newestFirst } from '../server/userlog.mjs'
import { HttpError } from '../server/errors.mjs'
import { exportCompat, runCommand } from '../server/index.mjs'
import { tmpDir, rmDir, cleanup, request, json, makeWav, makeProfile, device, testWhoIs } from './helpers.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const T = (n) => n.toString(16).padStart(24, '0')
const K = (n) => n.toString(16).padStart(32, '0')
const P = (n) => n.toString(16).padStart(16, '0')
const C = (n) => 'c' + n.toString(16).padStart(23, '0')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const MB = 1024 * 1024

// A person written straight as its log: `likes` likes of ids made from `seed` (one second
// apart), `lists` playlists of `perList` entries (made from `seed` too, `hold` at every
// `every`-th place when given).
function writePerson (dir, key, { likes = 0, lists = 0, perList = 0, seed = 'a', hold = null, every = 0, v = 1000 } = {}) {
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true })
  const id = (n) => seed + n.toString(16).padStart(23, '0')
  const person = new Person({ likes, ids: likes + lists * perList })
  for (let i = 0; i < likes; i++) person.likes.add(person.table.intern(id(i)), 1700000000000 + i * 1000, v)
  for (let k = 0, made = 0; k < lists; k++) {
    const pid = P(k)
    person.apply({ v, o: 'pc', p: { id: pid, name: 'Lista ' + k, description: '', trackIds: [], createdAt: 1, updatedAt: 1 } })
    const ids = []
    for (let j = 0; j < perList; j++) ids.push(hold !== null && every > 0 && j % every === 0 ? hold : id(likes + made++))
    if (ids.length > 0) person.apply({ v, o: 'pa', id: pid, pos: 0, ids, at: 1 })
  }
  const log = new UserLog({ file: path.join(dir, 'users', key + '.log'), key })
  log.writeWholeSync(person, { v, epochs: [{ id: newEpochId(), first: v, last: v }] })
  log.close()
}

// The line a child process writes its result on (the source logs to stdout too).
function resultOf (stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
  return JSON.parse(line.slice(7))
}

function loadUsers (t, dir, opts = {}) {
  const users = new Users({ dataDir: dir, ...opts })
  users.load()
  t.after(() => users.close())
  return users
}

function lastLine (file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

// A clock whose time moves only when told; its timers fire as it passes them.
function fakeClock () {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout (fn, ms) {
      timers.set(++seq, { at: now + ms, fn })
      return seq
    },
    clearTimeout (id) {
      timers.delete(id)
    },
    advance (ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, x] of timers) if (x.at <= end && (next === null || x.at < next[1].at)) next = [id, x]
        if (next === null) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    }
  }
}

async function startApp (t, dir, opts = {}) {
  return cleanup(t).close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts }))
}

const userPart = (lib) => ({ playlists: lib.playlists, likes: lib.likes, recents: lib.recents, covers: lib.covers.playlist })

// ------------------------------------------------------------------ the start

test('a start with 20 people of 100,000 likes each loads none of them: under 20 MB of heap', { timeout: 600000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const keys = []
  for (let k = 0; k < 20; k++) {
    keys.push(K(k + 1))
    writePerson(dir, K(k + 1), { likes: 100000, seed: (k % 16).toString(16) })
  }
  const script = `
    const { createMPfy } = await import(${JSON.stringify(new URL('../server/app.mjs', import.meta.url).href)})
    const gc = () => { for (let i = 0; i < 4; i++) globalThis.gc() }
    const app = await createMPfy({ dataDir: ${JSON.stringify(dir)}, port: 0, adminPort: 0, p2p: false, ffmpeg: null, fpcalc: null, sevenZip: null })
    gc()
    const heap = process.memoryUsage().heapUsed
    const keys = app.users.keys()
    const loaded = keys.filter((k) => app.users.loaded(k)).length
    const opens = app.users.opens
    const s = app.users.summary(keys[0])
    const { user, release } = await app.users.open(keys[0])
    const likes = user.p.likes.live
    release()
    await app.close()
    process.stdout.write('\\nRESULT ' + JSON.stringify({ heap, people: keys.length, loaded, opens, likes, version: s.version }) + '\\n')`
  const out = resultOf(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 1 << 24 }))
  assert.equal(out.people, 20)
  assert.equal(out.loaded, 0, 'nobody loaded at start')
  assert.equal(out.opens, 0)
  assert.equal(out.version, 1000)
  assert.equal(out.likes, 100000, 'and each is there when opened')
  assert.ok(out.heap < 20 * MB, 'heap after the start: ' + (out.heap / MB).toFixed(1) + ' MB')
})

test('the summary: a playlist made after the snapshot is seen after a restart, without loading the person', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { likes: 10, lists: 2, perList: 3 })
  let users = new Users({ dataDir: dir })
  users.load()
  const u = users.get(K(1))
  u.createPlaylist({ id: P(77), name: 'Dopo' })
  u.setPlaylistCover(P(77), 'small', C(5))
  u.deletePlaylist(P(1))
  users.close()
  users = loadUsers(t, dir)
  assert.equal(users.loaded(K(1)), false)
  assert.equal(users.playlistIdTaken(P(77)), true, 'a playlist of the tail')
  assert.equal(users.hasPlaylist(K(1), P(77)), true)
  assert.equal(users.hasPlaylist(K(1), P(0)), true, 'one of the snapshot')
  assert.equal(users.hasPlaylist(K(1), P(1)), false, 'one deleted in the tail')
  assert.equal(users.playlistIdTaken(P(1)), false)
  assert.ok(users.playlistCoverIds().has(C(5)), 'a cover set in the tail')
  const s = users.summary(K(1))
  assert.deepEqual(s.playlists.sort(), [P(0), P(77)])
  assert.equal(s.version, u.version)
  assert.equal(s.epoch, u.epoch)
  assert.deepEqual(s.epochs, u.log.epochs.map((e) => [e.id, e.first, e.last]))
  assert.equal(users.opens, 0, 'nobody opened')
  assert.equal(users.loaded(K(1)), false)
})

test('a 304 from the summary: after a restart the library request with the tag held loads nobody', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let app = await startApp(t, dir)
  await request(app.ports.http, 'PUT', '/api/likes/' + T(3) + '?brief=1')
  await request(app.ports.http, 'POST', '/api/playlists', { body: { name: 'Mia' } })
  for (const q of ['', '?delta=1']) {
    const first = await request(app.ports.http, 'GET', '/api/library' + q)
    assert.equal(first.status, 200)
    await app.close()
    app = await startApp(t, dir)
    assert.equal(app.users.loaded('owner'), false)
    const again = await request(app.ports.http, 'GET', '/api/library' + q, { headers: { 'if-none-match': first.headers.etag } })
    assert.equal(again.status, 304, q)
    assert.equal(again.headers.etag, first.headers.etag)
    assert.equal(again.headers['cache-control'], 'no-cache')
    assert.equal(app.users.opens, 0, 'nobody opened for it')
    assert.equal(app.users.loaded('owner'), false)
    const moved = await request(app.ports.http, 'GET', '/api/library' + q, { headers: { 'if-none-match': first.headers.etag.replace('.', '.1') } })
    assert.equal(moved.status, 200, 'another tag: the person is opened')
    assert.equal(app.users.loaded('owner'), true)
  }
})

test('a cover found missing at start: a line in the log of the person not loaded, who stays not loaded', (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { lists: 3, perList: 2 })
  let users = new Users({ dataDir: dir })
  users.load()
  const u = users.get(K(1))
  u.setPlaylistCover(P(0), 'small', C(1))
  u.setPlaylistCover(P(0), 'large', C(2))
  u.setPlaylistCover(P(2), 'large', C(3))
  u.log.compact()
  users.close()
  users = loadUsers(t, dir)
  const size = fs.statSync(users.fileOf(K(1))).size
  users.dropMissingCovers((id) => id !== C(2) && id !== C(3))
  assert.equal(users.loaded(K(1)), false)
  assert.equal(users.opens, 0)
  const added = fs.readFileSync(users.fileOf(K(1))).subarray(size).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(added.filter((l) => l.o).map((l) => [l.o, l.id, l.sizes]), [['cc', P(0), ['large']], ['cc', P(2), ['large']]])
  assert.deepEqual([...users.playlistCoverIds()], [C(1)])
  assert.deepEqual(users.get(K(1)).playlistCoversSnapshot(), { [P(0)]: { small: C(1), large: null } })
})

// ------------------------------------------------------------- open, hold, drop

test('references under a fake clock: a person held across the idle timer is never dropped, one instance only, no change lost; nobody holds it for the whole wait: it leaves memory', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { likes: 5, lists: 1, perList: 2 })
  const clock = fakeClock()
  const users = loadUsers(t, dir, { clock, idleMs: 1000 })
  const [a, b] = await Promise.all([users.open(K(1)), users.open(K(1))])
  assert.equal(a.user, b.user, 'opens meanwhile share the replay')
  assert.equal(users.opens, 1)
  a.release()
  a.release()
  b.release()
  clock.advance(500)
  // A request holds it across an await while the timer fires.
  const held = await users.open(K(1))
  assert.equal(held.user, a.user, 'the same instance')
  clock.advance(2000)
  assert.equal(users.loaded(K(1)), true, 'held: never dropped')
  held.user.like(T(9))
  clock.advance(5000)
  assert.equal(users.loaded(K(1)), true)
  const other = await users.open(K(1))
  assert.equal(other.user, held.user)
  other.release()
  held.release()
  clock.advance(999)
  assert.equal(users.loaded(K(1)), true, 'not before the whole wait')
  clock.advance(2)
  assert.equal(users.loaded(K(1)), false, 'dropped once nobody held it for the whole wait')
  assert.equal(users.hasPlaylist(K(1), P(0)), true, 'its summary again')
  assert.throws(() => held.user.like(T(10)), (err) => err instanceof HttpError && err.status === 500, 'a dropped instance takes no change')
  const back = await users.open(K(1))
  assert.notEqual(back.user, held.user)
  assert.equal(users.opens, 2)
  assert.deepEqual(back.user.likes.map((l) => l.id).slice(0, 1), [T(9)], 'the change made while held is there')
  assert.equal(back.user.p.likes.live, 6)
  back.release()
})

test('a person dropped is read again from its log as it was, its run\'s epoch kept', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { likes: 3, lists: 2, perList: 2 })
  const clock = fakeClock()
  const users = loadUsers(t, dir, { clock, idleMs: 100 })
  const h = await users.open(K(1))
  h.user.like(T(1))
  const epoch = h.user.epoch
  const view = h.user.p.view()
  h.release()
  clock.advance(101)
  assert.equal(users.loaded(K(1)), false)
  assert.deepEqual(users.head(K(1)), { version: view && h.user.version, epoch })
  const again = await users.open(K(1))
  assert.deepEqual(again.user.p.view(), view)
  again.user.like(T(2))
  assert.equal(again.user.log.epochs.filter((e) => e.id === epoch).length, 1)
  assert.equal(again.user.epoch, epoch, 'no second epoch in one run')
  again.release()
})

// ------------------------------------------------------------- removals

test('deleting a track opens nobody who was not loaded; the one loaded sweeps it; the others get one line each and the same data at their next open', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let app = await startApp(t, dir)
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  assert.equal(json(await owner.call('GET', '/api/profile')).role, 'owner')
  let members = [0, 1, 2].map(() => device(app, { profile: makeProfile() }))
  const up = json(await owner.call('PUT', '/api/upload/uno.wav', { body: makeWav({ freq: 330 }) })).track.id
  for (const m of members) {
    const pl = json(await m.call('POST', '/api/playlists', { body: { name: 'Con' } })).playlist.id
    assert.equal((await m.call('POST', '/api/playlists/' + pl + '/tracks', { body: { trackIds: [T(1), up, T(2), up] } })).status, 200)
    assert.equal((await m.call('PUT', '/api/likes/' + up + '?brief=1')).status, 200)
    assert.equal((await m.call('POST', '/api/played', { body: { trackId: up } })).status, 200)
  }
  await app.close()
  app = await startApp(t, dir)
  const own = owner.on(app)
  members = members.map((m) => m.on(app))
  // The first member's data is read before the deletion; the others' are not.
  assert.equal((await members[0].call('GET', '/api/library')).status, 200)
  const ids = members.map((m) => m.profile.id)
  assert.deepEqual(ids.map((id) => app.users.loaded(id)), [true, false, false])
  const opens = app.users.opens
  const sizes = ids.map((id) => fs.statSync(app.users.fileOf(id)).size)
  assert.equal((await own.call('DELETE', '/api/tracks/' + up)).status, 200)
  assert.equal(app.users.opens, opens, 'nobody opened for the deletion')
  assert.deepEqual(ids.map((id) => app.users.loaded(id)), [true, false, false])
  for (const k of [1, 2]) {
    const added = fs.readFileSync(app.users.fileOf(ids[k])).subarray(sizes[k]).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(added.filter((l) => l.o).map((l) => [l.o, l.ids]), [['xu', [up]]], 'one line')
  }
  const parts = []
  for (const m of members) {
    const lib = json(await m.call('GET', '/api/library'))
    assert.deepEqual(lib.playlists[0].trackIds, [T(1), T(2)])
    assert.deepEqual(lib.likes, [])
    assert.deepEqual(lib.recents, [])
    parts.push(lib.playlists[0].updatedAt)
  }
  assert.equal(new Set(parts).size, 1, 'the same time of the removal, loaded or not: ' + parts)
})

test('removals for a person not loaded equal the same removals swept on a loaded one, updatedAt included; 1,000 of them are applied by one walk', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  // Two people holding the same data: X loaded, Y not.
  writePerson(dir, K(1), { likes: 50, lists: 6, perList: 30, hold: T(1), every: 7 })
  fs.copyFileSync(path.join(dir, 'users', K(1) + '.log'), path.join(dir, 'users', K(2) + '.log'))
  const text = fs.readFileSync(path.join(dir, 'users', K(2) + '.log'), 'utf8').replace('"key":"' + K(1) + '"', '"key":"' + K(2) + '"')
  fs.writeFileSync(path.join(dir, 'users', K(2) + '.log'), text)
  const users = loadUsers(t, dir)
  const x = await users.open(K(1))
  x.user.like(T(1))
  x.user.played(T(1), null)
  x.user.played(T(4), null)
  // The same changes on Y, written as Y's own (it is loaded for them, then let go).
  const y0 = users.get(K(2))
  y0.like(T(1))
  y0.played(T(1), null, x.user.recents[1].at)
  y0.played(T(4), null, x.user.recents[0].at)
  users._unload(users._slots.get(K(2)), y0)
  assert.equal(users.loaded(K(2)), false)
  const gone = [[T(1)], ['a' + (3).toString(16).padStart(23, '0'), T(4)], ['a' + (60).toString(16).padStart(23, '0')]]
  for (const ids of gone) {
    users.removeTrackEverywhere(ids)
    await sleep(3)
  }
  assert.equal(users.loaded(K(2)), false)
  const y = await users.open(K(2))
  const strip = (v) => ({ ...v, rv: 0, playlists: v.playlists.map((p) => ({ ...p, pv: 0 })), likes: v.likes.map((l) => l.slice(0, 2)) })
  assert.deepEqual(strip(y.user.p.view()), strip(x.user.p.view()))
  assert.equal(y.user.p.walks, 1, 'the run of three lines: one walk')
  const times = y.user.p.view().playlists.map((p) => p.updatedAt)
  assert.ok(times.some((at) => at !== 1), 'updatedAt moved')
  x.release()
  y.release()

  // 1,000 lines for a person not loaded: one walk at its open.
  writePerson(dir, K(3), { likes: 2000, lists: 20, perList: 100 })
  const many = loadUsers(t, dir)
  for (let i = 0; i < 1000; i++) many.removeTrackEverywhere(['a' + (i * 2).toString(16).padStart(23, '0')])
  assert.equal(many.loaded(K(3)), false)
  const z = await many.open(K(3))
  assert.equal(z.user.p.walks, 1, '1,000 lines, one walk')
  assert.equal(z.user.p.likes.live, 1000)
  assert.ok(z.user.likes.every((l) => parseInt(l.id.slice(-6), 16) % 2 === 1), 'every even one gone')
  z.release()
})

test('the sweep of a loaded person runs in slices; a playlist changed meanwhile is filtered again; one line; the replay equals memory', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { lists: 2000, perList: 200, hold: T(1), every: 50 })
  const users = loadUsers(t, dir, { caps: { entries: Infinity } })
  const h = await users.open(K(1))
  const u = h.user
  const v = u.version
  const size = fs.statSync(users.fileOf(K(1))).size
  users.removeTrackEverywhere([T(1)])
  assert.equal(u.version, v, 'not swept at once: 400,000 entries')
  // Changes while the sweep runs: an add of the id to a list the walk already passed, and to one it has not.
  u.addToPlaylist(P(0), [T(1), T(2)], 0)
  u.addToPlaylist(P(1999), [T(1)], 5)
  await users.settled()
  for (const p of u.playlists.values()) assert.ok(!p.trackIds.includes(T(1)), p.id)
  assert.deepEqual(u.playlists.get(P(0)).trackIds.slice(0, 1), [T(2)])
  const lines = fs.readFileSync(users.fileOf(K(1))).subarray(size).toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.filter((l) => l.o).map((l) => l.o), ['pa', 'pa', 'x'])
  assert.equal(lines.filter((l) => l.o === 'x')[0].pl.length, 2000)
  h.release()
  const back = new UserLog({ file: users.fileOf(K(1)), key: K(1) })
  assert.equal(back.openSync(), 'ok')
  assert.deepEqual(back.person.view(), u.p.view())
  back.close()
})

// ------------------------------------------------------------- merges

// Today's merge of two people's likes (the format before): a Map filled with B's likes then
// A's, the newest time of an id kept at its first place, then a stable sort newest first.
function mergedLikesBefore (to, from) {
  const likes = new Map()
  for (const l of [...to, ...from]) {
    const prev = likes.get(l.id)
    if (!prev || l.at > prev.at) likes.set(l.id, l)
  }
  return [...likes.values()].sort((a, b) => b.at - a.at)
}

test('a merge: the likes in the order of the format before, equal times included; plays, playlists and covers as before', async (t) => {
  let seed = 7
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let round = 0; round < 25; round++) {
    const dir = cleanup(t).dir(tmpDir())
    fs.mkdirSync(path.join(dir, 'users'))
    const person = (n) => {
      const ids = new Set()
      const likes = []
      for (let i = 0; i < n; i++) {
        const id = T(Math.floor(rnd() * 60))
        if (ids.has(id)) continue
        ids.add(id)
        likes.push({ id, at: 1000 + Math.floor(rnd() * 6) * 10 })
      }
      const recents = []
      for (let i = 0; i < 8; i++) recents.push({ trackId: T(Math.floor(rnd() * 10)), at: 5000 - Math.floor(rnd() * 4) * 100, context: { type: 'library' } })
      recents.sort((a, b) => b.at - a.at)
      const playlists = []
      for (let i = 0; i < 3; i++) playlists.push({ id: P(Math.floor(rnd() * 5)), name: 'L', description: '', trackIds: [T(i)], createdAt: 1, updatedAt: 2 })
      return { schema: 1, version: 3, playlists, likes, recents, covers: { playlist: { [P(Math.floor(rnd() * 5))]: { small: C(round), large: null } } } }
    }
    const a = person(40)
    const b = person(40)
    fs.writeFileSync(path.join(dir, 'users', K(1) + '.json'), JSON.stringify(b))
    fs.writeFileSync(path.join(dir, 'users', K(2) + '.json'), JSON.stringify(a))
    const users = loadUsers(t, dir)
    const before = { to: users.get(K(1))._data(), from: users.get(K(2))._data() }
    assert.equal(await users.merge(K(2), K(1)), true)
    const to = users.get(K(1))
    assert.deepEqual(to.likes, mergedLikesBefore(before.to.likes, before.from.likes), 'round ' + round)
    const plays = new Map()
    for (const r of [...before.to.recents, ...before.from.recents]) plays.set(r.trackId + '|' + r.at + '|' + JSON.stringify(r.context), r)
    assert.deepEqual(to.recents, [...plays.values()].sort((x, y) => y.at - x.at).slice(0, 1000))
    const pls = [...before.to.playlists]
    for (const p of before.from.playlists) if (!pls.some((q) => q.id === p.id)) pls.push(p)
    assert.deepEqual([...to.playlists.values()].map((p) => to.publicPlaylist(p)), pls)
    const covers = { ...before.to.covers.playlist }
    for (const [id, e] of Object.entries(before.from.covers.playlist)) if (!(id in covers)) covers[id] = e
    assert.deepEqual(to.playlistCoversSnapshot(), covers)
    assert.equal(users.has(K(2)), false)
    assert.ok(!fs.existsSync(users.fileOf(K(2))) && !fs.existsSync(users.jsonOf(K(2))), 'A\'s files gone')
    users.close()
    // And from the log: the compaction holds the merged state.
    const back = loadUsers(t, dir)
    assert.deepEqual(back.get(K(1))._data().likes, to.likes)
  }
  // The order on the tables, with no comparator, against a stable sort: any times, and two runs
  // already newest first (each person's likes, as they usually are), merged in one pass.
  for (let n = 0; n < 400; n++) {
    const k = 1 + Math.floor(rnd() * 300)
    const split = Math.floor(rnd() * (k + 1))
    const at = new Float64Array(k)
    for (let j = 0; j < k; j++) at[j] = rnd() < 0.1 ? -0 : Math.floor(rnd() * 9) * (rnd() < 0.5 ? 1 : 0.5)
    if (n % 2 === 1) {
      at.subarray(0, split).sort().reverse()
      at.subarray(split, k).sort().reverse()
    }
    const want = Array.from({ length: k }, (_, j) => j).sort((x, y) => at[y] - at[x] || x - y)
    assert.deepEqual(Array.from(newestFirst(at, k)), want)
    assert.deepEqual(Array.from(newestFirst(at, k, split)), want, 'split at ' + split)
  }
})

test('after a merge in which A changed after B\'s last change, the likes B gets later are all in changesSince', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const users = loadUsers(t, dir)
  const to = users.get(K(1))
  to.like(T(1))
  to.like(T(2))
  await sleep(30)
  // A's epoch opens later: its versions are above B's.
  const from = users.get(K(2))
  for (let i = 10; i < 20; i++) from.like(T(i))
  assert.ok(from.version > to.version + 5)
  assert.equal(await users.merge(K(2), K(1)), true)
  const v = to.version
  const e = to.epoch
  to.like(T(30))
  to.like(T(31))
  const moved = to.changesSince(e, v)
  assert.notEqual(moved, null)
  assert.deepEqual([...moved.likes.added].map(([id]) => id), [T(30), T(31)])
  assert.equal(to.changesSince(e, v - 1), null, 'nothing before the merge is known')
})

test('a request of A sent during the merge of A into B waits for it and then finds A empty; a change of A made then is kept', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const app = await startApp(t, dir)
  app.people.openClaim(30)
  const A = device(app, { profile: makeProfile() })
  const B = device(app, { profile: makeProfile() })
  assert.equal(json(await A.call('GET', '/api/profile')).role, 'owner')
  const pl = json(await A.call('POST', '/api/playlists', { body: { name: 'Di A' } })).playlist.id
  await A.call('PUT', '/api/likes/' + T(1) + '?brief=1')
  await B.call('PUT', '/api/likes/' + T(2) + '?brief=1')
  let open
  const gate = new Promise((resolve) => { open = resolve })
  let reached
  const atGate = new Promise((resolve) => { reached = resolve })
  app.users.hooks = { merged: () => { reached(); return gate } }
  const moved = request(app.ports.http, 'POST', '/api/admin/owner', { body: { profileId: B.profile.id, moveData: true } })
  await atGate
  let answered = false
  const during = A.call('GET', '/api/library').then((r) => { answered = true; return r })
  const like = A.call('PUT', '/api/likes/' + T(5) + '?brief=1')
  await sleep(150)
  assert.equal(answered, false, 'A\'s request waits for the merge')
  open()
  assert.equal((await moved).status, 200)
  const lib = json(await during)
  // Empty, as the merge before left it (the like sent meanwhile may be in it already).
  assert.deepEqual({ ...userPart(lib), likes: lib.likes.filter((l) => l.id !== T(5)) }, { playlists: [], likes: [], recents: [], covers: {} }, 'A found empty')
  assert.equal((await like).status, 200)
  const b = json(await B.call('GET', '/api/library'))
  assert.deepEqual(b.playlists.map((p) => p.id), [pl])
  assert.deepEqual(b.likes.map((l) => l.id).sort(), [T(1), T(2)])
  assert.deepEqual(json(await A.call('GET', '/api/library')).likes.map((l) => l.id), [T(5)], 'A\'s change after it is kept')
})

test('the claim with the owner\'s data not loaded: merged, the owner\'s devices take one whole user part, then deltas', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let app = await startApp(t, dir)
  const local = () => ({ call: (method, urlPath, opts = {}) => request(app.ports.http, method, urlPath, opts) })
  const pl = json(await local().call('POST', '/api/playlists', { body: { name: 'Prima' } })).playlist.id
  await local().call('PUT', '/api/likes/' + T(1) + '?brief=1')
  await local().call('POST', '/api/played', { body: { trackId: T(1) } })
  const held = json(await local().call('GET', '/api/library?delta=1'))
  await app.close()
  app = await startApp(t, dir)
  assert.equal(app.users.has('owner'), true)
  assert.equal(app.users.loaded('owner'), false, 'the owner\'s data not loaded')
  app.people.openClaim(30)
  const P1 = device(app, { profile: makeProfile() })
  // The claim happens while this request is resolved; its person waits for the merge.
  const first = json(await P1.call('GET', '/api/library?delta=1'))
  assert.equal(app.source.data.ownerProfileId, P1.profile.id)
  assert.deepEqual(first.playlists.map((p) => p.id), [pl])
  assert.deepEqual(first.likes.map((l) => l.id), [T(1)])
  assert.equal(app.users.has('owner'), false)
  assert.ok(!fs.existsSync(app.users.fileOf('owner')), 'owner.log gone')
  assert.ok(app.users.summary(P1.profile.id).horizon > held.userVersion, 'the horizon moved past every version before the merge')
  // The local device held the owner's versions: one whole user part, then deltas.
  const q = (s) => '/api/library?delta=1&have=' + s.version + '&he=' + s.epochs.shared + '&uv=' + s.userVersion + '&ue=' + s.epochs.user
  const whole = json(await local().call('GET', q(held)))
  assert.equal(whole.delta.user, false)
  assert.deepEqual(whole.playlists.map((p) => p.id), [pl])
  const next = json(await local().call('GET', q(whole)))
  assert.equal(next.delta.user, true)
  assert.deepEqual(next.playlists, { changed: [], removed: [] })
  const again = json(await P1.call('GET', q(first)))
  assert.equal(again.delta.user, true)
})

test('set-owner --move-data: the new owner\'s devices holding its own versions take one whole user part, then deltas; the old owner is empty', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const app = await startApp(t, dir)
  app.people.openClaim(30)
  const A = device(app, { profile: makeProfile() })
  const B = device(app, { profile: makeProfile() })
  assert.equal(json(await A.call('GET', '/api/profile')).role, 'owner')
  const pa = json(await A.call('POST', '/api/playlists', { body: { name: 'Di A' } })).playlist.id
  await A.call('PUT', '/api/likes/' + T(1) + '?brief=1')
  const pb = json(await B.call('POST', '/api/playlists', { body: { name: 'Di B' } })).playlist.id
  await B.call('PUT', '/api/likes/' + T(2) + '?brief=1')
  const held = json(await B.call('GET', '/api/library?delta=1'))
  const q = (s) => '/api/library?delta=1&have=' + s.version + '&he=' + s.epochs.shared + '&uv=' + s.userVersion + '&ue=' + s.epochs.user
  assert.equal(json(await B.call('GET', q(held))).delta.user, true, 'B\'s versions known before')
  assert.equal((await request(app.ports.http, 'POST', '/api/admin/owner', { body: { profileId: B.profile.id, moveData: true } })).status, 200)
  const whole = json(await B.call('GET', q(held)))
  assert.equal(whole.delta.user, false, 'one whole user part')
  assert.deepEqual(whole.playlists.map((p) => p.id), [pb, pa])
  assert.deepEqual(whole.likes.map((l) => l.id).sort(), [T(1), T(2)])
  assert.equal(json(await B.call('GET', q(whole))).delta.user, true, 'then deltas')
  const a = json(await A.call('GET', '/api/library'))
  assert.deepEqual(userPart(a), { playlists: [], likes: [], recents: [], covers: {} })
})

test('two people of 300,000 likes merged under --max-old-space-size=160 raise the heap by under 10 MB at any step', { timeout: 600000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { likes: 300000, seed: 'a' })
  writePerson(dir, K(2), { likes: 300000, seed: 'b' })
  const script = `
    const { Users } = await import(${JSON.stringify(new URL('../server/users.mjs', import.meta.url).href)})
    const gc = () => { for (let i = 0; i < 3; i++) globalThis.gc() }
    const users = new Users({ dataDir: ${JSON.stringify(dir)}, caps: { likes: Infinity } })
    users.load()
    const a = await users.open(${JSON.stringify(K(1))})
    const b = await users.open(${JSON.stringify(K(2))})
    a.release()
    b.release()
    gc()
    const base = process.memoryUsage().heapUsed
    let most = 0
    const steps = []
    const sample = (name) => {
      gc()
      const d = process.memoryUsage().heapUsed - base
      most = Math.max(most, d)
      if (name) steps.push([name, Math.round(d / 1024)])
    }
    users.hooks = { mergeStep: sample, merged: () => sample('merged') }
    let running = true
    const sampler = (async () => { while (running) { await new Promise((resolve) => setImmediate(resolve)); sample() } })()
    const t0 = performance.now()
    const done = await users.merge(${JSON.stringify(K(2))}, ${JSON.stringify(K(1))})
    const ms = performance.now() - t0
    running = false
    await sampler
    sample('end')
    const likes = users.get(${JSON.stringify(K(1))}).p.likes.live
    users.close()
    process.stdout.write('\\nRESULT ' + JSON.stringify({ done, most, likes, ms, steps }) + '\\n')`
  const out = resultOf(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=160', '--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 1 << 24 }))
  t.diagnostic(JSON.stringify(out))
  assert.equal(out.done, true)
  assert.equal(out.likes, 600000)
  assert.ok(out.most < 10 * MB, 'the heap rose by ' + (out.most / MB).toFixed(1) + ' MB')
})

// ------------------------------------------------------------- export-compat, downgrades

test('export-compat: each .json byte for byte as the format before writes it; the log knows it after; refused while the server runs', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  fs.mkdirSync(path.join(dir, 'users'))
  const old = {
    schema: 1,
    version: 4,
    tema: { scuro: true },
    playlists: [{ id: P(1), name: 'Una', description: 'x', trackIds: [T(1), T(2), T(1)], createdAt: 1, updatedAt: 2, colore: 'blu' }],
    likes: Array.from({ length: 12000 }, (_, i) => ({ id: T(i + 1), at: 1700000000000 - i })),
    recents: [{ trackId: T(3), at: 10, context: { type: 'album', id: 'a1' } }],
    covers: { playlist: { [P(1)]: { small: C(1), large: C(2) } }, altro: 1 }
  }
  fs.writeFileSync(path.join(dir, 'users', 'owner.json'), JSON.stringify(old))
  const app = await startApp(t, dir)
  assert.equal((await request(app.ports.http, 'PUT', '/api/likes/' + T(99999) + '?brief=1')).status, 200)
  await assert.rejects(runCommand(['export-compat'], { dataDir: dir, port: app.ports.http }), /server e' acceso/)
  await app.close()
  const done = await exportCompat(dir)
  assert.deepEqual(done, { library: true, people: 1 })
  const users = loadUsers(t, dir)
  assert.equal(users.loaded('owner'), false)
  const written = fs.readFileSync(users.jsonOf('owner'), 'utf8')
  const u = users.get('owner')
  assert.equal(written, JSON.stringify(u._data()), 'byte for byte')
  assert.equal(JSON.parse(written).likes[0].id, T(99999))
  assert.ok(!fs.readdirSync(path.join(dir, 'users')).some((n) => n.includes('.replaced-')), 'the log stays the truth')
  assert.ok(fs.existsSync(path.join(dir, 'db.json')))
  assert.equal(lastLine(users.fileOf('owner')).xp.size, Buffer.byteLength(written))
})

test('the phone install runs export-compat with the installed code before replacing it when it goes back to an older version, and stops if it fails', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'phone-install.sh'), 'utf8')
  const lines = sh.split('\n')
  const exportAt = lines.findIndex((l) => l.includes('server/index.mjs export-compat'))
  const replaceAt = lines.findIndex((l) => /tar\s+-x/.test(l) && l.includes('$R/opt/mpfy'))
  assert.ok(exportAt !== -1 && replaceAt !== -1 && exportAt < replaceAt, 'before the code is replaced')
  assert.ok(lines[exportAt].includes('cd /opt/mpfy'), 'the installed code runs it')
  const step = lines.slice(lines.indexOf('echo "== data for an older version"'), replaceAt).join('\n')
  assert.match(step, /version_lower "\$\(version_of \$T\/incoming\/package\.json\)" "\$\(version_of \$R\/opt\/mpfy\/package\.json\)"/)
  assert.match(step, /\[ ! -f \$T\/incoming\/server\/userlog\.mjs \]/, 'or code that keeps no logs')
  assert.match(step, /if ! chroot \$R \/usr\/bin\/setpriv --reuid="\$U"/, 'as the server\'s own user')
  assert.match(step, /\n {4}exit 1\n/, 'a failed export stops it')
  assert.match(step, /pkill -f "\$SERVER"/, 'the server stopped first')
  // The version comparison, run by a shell when there is one.
  const shell = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' })
  if (shell.status !== 0) return
  const fn = sh.slice(sh.indexOf('version_lower() {'), sh.indexOf('\n}\n', sh.indexOf('version_lower() {')) + 3)
  for (const [a, b, lower] of [['2.4.1', '2.5.0', true], ['2.5.0', '2.4.1', false], ['2.4.1', '2.4.1', false], ['2.4', '2.4.1', true], ['10.0.0', '9.9.9', false], ['0.1.0', '0.2.0', true]]) {
    const r = spawnSync('sh', ['-c', fn + 'version_lower "$1" "$2" && echo yes || echo no', 'sh', a, b], { encoding: 'utf8' })
    assert.equal(r.stdout.trim(), lower ? 'yes' : 'no', a + ' < ' + b)
  }
})

// The source as it was at 2.4.1 (its server/ from git), to read what export-compat wrote.
function oldServer (t) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' })
  if (top.status !== 0 || spawnSync('git', ['cat-file', '-e', '96a1914^{commit}'], { cwd: ROOT }).status !== 0) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpfy-old-'))
  t.after(() => rmDir(dir))
  const tar = path.join(dir, 'server.tar')
  if (spawnSync('git', ['archive', '-o', tar, '96a1914', 'server', 'package.json'], { cwd: top.stdout.trim() }).status !== 0) return null
  if (spawnSync('tar', ['-xf', 'server.tar'], { cwd: dir }).status !== 0) return null
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction')
  return (name) => pathToFileURL(path.join(dir, 'server', name)).href
}

test('downgrade: after export-compat the format before reads today\'s data and makes a change; the next start migrates it and keeps the newer log aside; without the export, the same with nothing deleted', async (t) => {
  const old = oldServer(t)
  if (old === null) {
    t.skip('no git checkout with 2.4.1 here')
    return
  }
  const { Users: OldUsers } = await import(old('users.mjs'))
  const { Library: OldLibrary } = await import(old('library.mjs'))
  for (const exported of [true, false]) {
    const dir = cleanup(t).dir(tmpDir())
    let app = await startApp(t, dir)
    const port = () => app.ports.http
    const track = json(await request(port(), 'PUT', '/api/upload/due.wav', { body: makeWav({ freq: 410 }) })).track
    const pl = json(await request(port(), 'POST', '/api/playlists', { body: { name: 'Nuova' } })).playlist.id
    await request(port(), 'POST', '/api/playlists/' + pl + '/tracks', { body: { trackIds: [track.id, T(7)] } })
    await request(port(), 'PUT', '/api/likes/' + T(8) + '?brief=1')
    const before = json(await request(port(), 'GET', '/api/library'))
    await app.close()
    if (exported) await exportCompat(dir)
    // The format before reads the data dir and makes a change.
    const ou = new OldUsers({ dataDir: dir })
    ou.load()
    if (exported) {
      assert.deepEqual(ou.get('owner').likes, before.likes, 'the likes of today')
      assert.deepEqual(ou.get('owner').playlistCoversSnapshot(), before.covers.playlist)
      assert.deepEqual([...ou.get('owner').playlists.values()], before.playlists)
      const ol = new OldLibrary({ dataDir: dir })
      await ol.open()
      assert.deepEqual([...ol.tracks.keys()], before.tracks.map((x) => x.id), 'the tracks of today')
      ol.updateTrack(track.id, { title: 'Titolo di prima' })
      ol.flushNow()
      ol.close()
    } else {
      assert.equal(ou.has('owner'), false, 'a person made since the upgrade: the format before has no file for it')
    }
    ou.get('owner').like(T(9))
    ou.get('owner').flushNow()
    ou.close()
    // The next start of today's code.
    app = await startApp(t, dir)
    const after = json(await request(app.ports.http, 'GET', '/api/library'))
    const kept = fs.readdirSync(path.join(dir, 'users')).filter((n) => n.startsWith('owner.log.replaced-'))
    assert.equal(kept.length, 1, 'the newer log kept aside')
    assert.match(fs.readFileSync(path.join(dir, 'users', kept[0]), 'utf8'), new RegExp(T(8)), 'with what was made since the upgrade')
    if (exported) {
      assert.deepEqual(after.likes.map((l) => l.id), [T(9), T(8)], 'the change of the format before and today\'s data')
      assert.deepEqual(after.playlists.map((p) => p.id), [pl])
      assert.equal(after.tracks.find((x) => x.id === track.id).title, 'Titolo di prima', 'the library\'s change too')
      assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('library.log.replaced-')).length, 1, 'the newer library log kept aside')
    } else {
      assert.deepEqual(after.likes.map((l) => l.id), [T(9)], 'what the format before saw')
    }
    await app.close()
  }
})
