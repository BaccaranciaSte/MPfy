// Answers that must not hold the source's loop in proportion to what they touch:
// a track removed while many people are loaded, a delta of many likes, the
// comments of many people.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { Users } from '../server/users.mjs'
import { UserLog, Person, newEpochId } from '../server/userlog.mjs'
import { tmpDir, cleanup, json, makeProfile, makeCard, device, testWhoIs, makeWav } from './helpers.mjs'

const T = (n) => n.toString(16).padStart(24, '0')
const K = (n) => n.toString(16).padStart(32, '0')
const P = (n) => n.toString(16).padStart(16, '0')

// A person written straight as its log: `lists` playlists of `perList` entries, `hold` at
// every `every`-th place.
function writePerson (dir, key, { lists, perList, hold, every, seed }) {
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true })
  const id = (n) => seed + n.toString(16).padStart(23, '0')
  const v = 1000
  const person = new Person({ likes: 0, ids: lists * perList })
  for (let k = 0, made = 0; k < lists; k++) {
    const pid = P(k)
    person.apply({ v, o: 'pc', p: { id: pid, name: 'Lista ' + k, description: '', trackIds: [], createdAt: 1, updatedAt: 1 } })
    const ids = []
    for (let j = 0; j < perList; j++) ids.push(j % every === 0 ? hold : id(made++))
    person.apply({ v, o: 'pa', id: pid, pos: 0, ids, at: 1 })
  }
  const log = new UserLog({ file: path.join(dir, 'users', key + '.log'), key })
  log.writeWholeSync(person, { v, epochs: [{ id: newEpochId(), first: v, last: v }] })
  log.close()
}

test('a track removed with several people loaded: the request sweeps for one slice in all, the rest from the next turns', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  writePerson(dir, K(1), { lists: 1500, perList: 200, hold: T(1), every: 50, seed: 'a' })
  writePerson(dir, K(2), { lists: 1500, perList: 200, hold: T(1), every: 50, seed: 'b' })
  const users = new Users({ dataDir: dir, caps: { entries: Infinity } })
  users.load()
  t.after(() => users.close())
  const a = await users.open(K(1))
  const b = await users.open(K(2))
  users.removeTrackEverywhere([T(1)])
  const started = [K(1), K(2)].filter((k) => users._slots.get(k).sweep !== null)
  assert.deepEqual(started, [K(1)], 'one slice inside the call: the second person begins at a later turn')
  assert.equal(users._slots.get(K(2)).jobs.length, 1, 'its removal waits, not lost')
  await users.settled()
  for (const h of [a, b]) for (const p of h.user.playlists.values()) assert.ok(!p.trackIds.includes(T(1)), p.id)
  a.release()
  b.release()
})

test('a delta of many likes reads them while it is written, not when it is asked', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const users = new Users({ dataDir: dir })
  users.load()
  t.after(() => users.close())
  const held = await users.open('owner')
  t.after(() => held.release())
  const user = held.user
  user.like(T(9999))
  const e = user.epoch
  const u = user.version
  const ids = Array.from({ length: 3000 }, (_, i) => T(i + 1))
  user.bulkLikes({ add: ids, remove: [] })
  user.unlike(T(5))
  const table = user.p.table
  const hex = table.hex
  let read = 0
  table.hex = function (i) {
    read++
    return hex.call(this, i)
  }
  t.after(() => { table.hex = hex })
  const moved = user.changesSince(e, u)
  assert.equal(read, 0, 'no like read when the delta is asked')
  // Liked and unliked while it is written: left out (the next delta says it).
  const it = moved.likes.added[Symbol.iterator]()
  const first = it.next().value
  user.unlike(T(3000))
  const rest = [first]
  for (let r = it.next(); !r.done; r = it.next()) rest.push(r.value)
  assert.equal(read, 2998)
  assert.deepEqual(rest.map(([id]) => id), ids.filter((id) => id !== T(5) && id !== T(3000)))
  assert.deepEqual(moved.likes.removed, [T(5)])
  assert.equal(user.p.likes.walkers, 0, 'the walk is over')
})

test('the comments of people without a card: profiles.json looked at once per answer', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const app = c.close(await createMPfy({
    dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, commentsDelayMs: 20
  }))
  await app.songsStarted
  app.people.openClaim(30)
  const ownerProfile = makeProfile()
  const owner = device(app, { profile: ownerProfile })
  assert.equal((await owner.call('PUT', '/api/profile/card', { body: makeCard(ownerProfile, { name: 'Bacca', updatedAt: Date.now() - 1000 }) })).status, 200)
  const up = await owner.call('PUT', '/api/upload/brano.wav', { body: makeWav({ seconds: 1, freq: 333, tags: { title: 'Brano', artist: 'Lumen Marino' } }) })
  assert.equal(up.status, 200, up.body.toString())
  const track = json(up).track.id
  const comment = async (i) => {
    const d = device(app, { profile: makeProfile() })
    const r = await d.call('POST', '/api/comments', { body: { id: crypto.randomBytes(16).toString('hex'), at: Date.now(), trackId: track, text: 'commento ' + i } })
    assert.equal(r.status, 201, r.body.toString())
  }
  const file = path.join(dir, 'profiles.json')
  // The looks at profiles.json of one answer listing the comments.
  const looksOfList = async (n) => {
    const stat = fs.statSync
    let looks = 0
    fs.statSync = function (p, ...rest) {
      if (path.resolve(String(p)) === path.resolve(file)) looks++
      return stat.call(this, p, ...rest)
    }
    let r
    try {
      r = await owner.call('GET', '/api/comments?tracks=' + track)
    } finally {
      fs.statSync = stat
    }
    assert.equal(r.status, 200, r.body.toString())
    assert.equal(json(r).comments.length, n)
    return looks
  }
  for (let i = 0; i < 2; i++) await comment(i)
  const two = await looksOfList(2)
  for (let i = 2; i < 8; i++) await comment(i)
  const eight = await looksOfList(8)
  assert.equal(eight, two, 'the looks do not grow with the comments (' + two + ' for 2, ' + eight + ' for 8)')
})
