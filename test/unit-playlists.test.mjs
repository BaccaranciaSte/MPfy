import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Library } from '../server/library.mjs'
import { Users, MAX_PLAYLISTS, MAX_PLAYLIST_ENTRIES } from '../server/users.mjs'
import { HttpError } from '../server/errors.mjs'
import { tmpDir, rmDir, shardPath } from './helpers.mjs'

const T = (n) => n.toString(16).padStart(24, '0')

function fakeTrack (id, extra = {}) {
  return {
    id, title: 'Brano ' + id.slice(-2), artist: 'Artista', album: 'Album', albumArtist: 'Artista', trackNo: null,
    discNo: null, year: null, duration: 100, format: 'mp3', mime: 'audio/mpeg', size: 10, bitrate: null, addedAt: 1, coverId: null, ...extra
  }
}

// The shared library and one person's data (users/owner.json), as the source
// keeps them; `user` answers the playlist, like and recent calls.
async function setup (t, n = 5) {
  const dir = tmpDir()
  let lib = null
  const users = new Users({ dataDir: dir, debounceMs: 10, releaseCover: (id) => lib.dropCoverIfUnused(id) })
  users.load()
  lib = new Library({ dataDir: dir, debounceMs: 10, extraCoverIds: () => users.playlistCoverIds() })
  await lib.open()
  t.after(() => {
    lib.close()
    users.close()
    rmDir(dir)
  })
  for (let i = 1; i <= n; i++) lib.addTrack(fakeTrack(T(i)))
  return { lib, users, user: users.get('owner'), dir }
}

function rejects (fn, status) {
  assert.throws(fn, (err) => err instanceof HttpError && err.status === status)
}

test('playlists: create with default names, rename, describe, delete', async (t) => {
  const { user: lib } = await setup(t)
  const a = lib.createPlaylist({})
  const b = lib.createPlaylist({ name: '   ' })
  assert.equal(a.name, 'La mia playlist n. 1')
  assert.equal(b.name, 'La mia playlist n. 2')
  assert.match(a.id, /^[0-9a-f]{16}$/)
  const c = lib.createPlaylist({ name: 'Viaggio', description: 'In macchina' })
  assert.equal(c.description, 'In macchina')
  lib.updatePlaylist(c.id, { name: 'Viaggio lungo', description: '' })
  assert.equal(lib.playlists.get(c.id).name, 'Viaggio lungo')
  assert.equal(lib.playlists.get(c.id).description, '')
  rejects(() => lib.updatePlaylist(c.id, { name: '' }), 400)
  lib.deletePlaylist(a.id)
  assert.equal(lib.playlists.has(a.id), false)
  rejects(() => lib.deletePlaylist(a.id), 404)
  rejects(() => lib.deletePlaylist('../../etc'), 400)
})

test('playlists: add appends or inserts, duplicates allowed, remove by index', async (t) => {
  const { user: lib } = await setup(t)
  const p = lib.createPlaylist({ name: 'P' })
  lib.addToPlaylist(p.id, [T(1), T(2)])
  lib.addToPlaylist(p.id, [T(1)]) // the same song twice is allowed
  assert.deepEqual(p.trackIds, [T(1), T(2), T(1)])
  lib.addToPlaylist(p.id, [T(3), T(4)], 1)
  assert.deepEqual(p.trackIds, [T(1), T(3), T(4), T(2), T(1)])
  lib.addToPlaylist(p.id, [T(5)], 999) // past the end: appended
  assert.deepEqual(p.trackIds, [T(1), T(3), T(4), T(2), T(1), T(5)])

  // Remove the second T(1) only (index 4) and T(3) (index 1).
  lib.removeFromPlaylist(p.id, [4, 1, 4])
  assert.deepEqual(p.trackIds, [T(1), T(4), T(2), T(5)])

  rejects(() => lib.removeFromPlaylist(p.id, [10]), 400)
  rejects(() => lib.removeFromPlaylist(p.id, [-1]), 400)
  rejects(() => lib.removeFromPlaylist(p.id, ['0']), 400)
  rejects(() => lib.addToPlaylist(p.id, ['A'.repeat(24)]), 400) // ids are lower-case hex
  rejects(() => lib.addToPlaylist(p.id, ['zz']), 400)
  rejects(() => lib.addToPlaylist(p.id, [T(1)], -2), 400)
  assert.deepEqual(p.trackIds, [T(1), T(4), T(2), T(5)], 'failed calls change nothing')
})

test('playlists: reorder with the full new order; invalid input changes nothing', async (t) => {
  const { user: lib } = await setup(t)
  const p = lib.createPlaylist({ name: 'P' })
  lib.addToPlaylist(p.id, [T(1), T(2), T(3)])
  lib.updatePlaylist(p.id, { trackIds: [T(3), T(1), T(2), T(2)] })
  assert.deepEqual(p.trackIds, [T(3), T(1), T(2), T(2)])
  rejects(() => lib.updatePlaylist(p.id, { name: 'Nuovo', trackIds: [T(1), '../x'] }), 400)
  assert.equal(p.name, 'P', 'all or nothing')
  assert.deepEqual(p.trackIds, [T(3), T(1), T(2), T(2)])
  rejects(() => lib.updatePlaylist(p.id, { trackIds: 'nope' }), 400)
})

test("playlists: every change bumps the person's version, not the shared library's", async (t) => {
  const { lib: shared, user: lib } = await setup(t)
  const sharedVersion = shared.version
  // The first change of a run opens its epoch (its version from the clock); then one per change.
  lib.createPlaylist({ name: 'Prima' })
  const v = lib.version
  const p = lib.createPlaylist({ name: 'P' })
  lib.addToPlaylist(p.id, [T(1)])
  lib.removeFromPlaylist(p.id, [0])
  lib.deletePlaylist(p.id)
  assert.equal(lib.version, v + 4)
  assert.equal(shared.version, sharedVersion)
})

test('tracks: a file that goes leaves the playlists, likes and recents of every person, and an unused cover', async (t) => {
  const { lib, users, user, dir } = await setup(t, 0)
  const other = users.get('5'.repeat(32))
  const cover = 'c'.repeat(24)
  lib.addTrack(fakeTrack(T(1), { coverId: cover }))
  lib.addTrack(fakeTrack(T(2), { coverId: cover }))
  lib.addTrack(fakeTrack(T(3)))
  const coverFile = path.join(dir, 'covers', cover + '.jpg')
  fs.writeFileSync(coverFile, 'img')
  for (const [n, body] of [[1, 'a'], [2, 'b']]) {
    fs.mkdirSync(path.dirname(shardPath(dir, 'library', T(n) + '.mp3')), { recursive: true })
    fs.writeFileSync(shardPath(dir, 'library', T(n) + '.mp3'), body)
  }

  const p = user.createPlaylist({ name: 'P' })
  user.addToPlaylist(p.id, [T(1), T(3), T(1), T(2)])
  user.like(T(1))
  user.like(T(3))
  user.played(T(1), { type: 'playlist', id: p.id })
  other.like(T(1))
  const q = other.createPlaylist({ name: 'Q' })
  other.addToPlaylist(q.id, [T(1)])

  lib.deleteTrack(T(1))
  users.removeTrackEverywhere(T(1))
  assert.equal(lib.getTrack(T(1)), null)
  assert.deepEqual(p.trackIds, [T(3), T(2)])
  assert.deepEqual(user.likes.map((l) => l.id), [T(3)])
  assert.equal(user.recents.length, 0)
  assert.deepEqual(other.likes, [])
  assert.deepEqual(q.trackIds, [])
  assert.ok(!fs.existsSync(shardPath(dir, 'library', T(1) + '.mp3')), 'file removed')
  assert.ok(fs.existsSync(coverFile), 'cover still used by T(2)')

  lib.deleteTrack(T(2))
  assert.ok(!fs.existsSync(coverFile), 'cover removed with its last track')
  rejects(() => lib.deleteTrack(T(2)), 404)
})

test('tracks: metadata edit', async (t) => {
  const { lib } = await setup(t)
  const tr = lib.updateTrack(T(1), { title: '  Nuovo titolo ', artist: 'Altro', album: '' })
  assert.equal(tr.title, 'Nuovo titolo')
  assert.equal(tr.artist, 'Altro')
  assert.equal(tr.albumArtist, 'Altro', 'albumArtist follows when it was the artist')
  assert.equal(tr.album, 'Album sconosciuto')
  rejects(() => lib.updateTrack(T(1), { title: '' }), 400)
  rejects(() => lib.updateTrack(T(1), { title: 5 }), 400)
  rejects(() => lib.updateTrack(T(99), { title: 'x' }), 404)
})

test('likes and recents', async (t) => {
  const { user: lib } = await setup(t)
  lib.like(T(1))
  lib.like(T(2))
  lib.like(T(1)) // already liked: no change
  assert.deepEqual(lib.likes.map((l) => l.id), [T(2), T(1)], 'newest first')
  lib.unlike(T(2))
  lib.unlike(T(4)) // not liked: fine
  assert.deepEqual(lib.likes.map((l) => l.id), [T(1)])
  rejects(() => lib.like('nope'), 400)
  lib.like(T(99)) // a track of another source: kept
  assert.deepEqual(lib.likes.map((l) => l.id), [T(99), T(1)])
  lib.unlike(T(99))

  for (let i = 0; i < 60; i++) lib.played(T(1 + (i % 5)), { type: 'album', id: 'x' })
  assert.equal(lib.recents.length, 60, 'the history keeps them all (up to 1,000)')
  assert.equal(lib.snapshot().recents.length, 50, 'the library serves the newest 50')
  assert.equal(lib.recents[0].trackId, T(5), 'newest first')
  lib.played(T(2))
  assert.deepEqual(lib.recents[0].context, { type: 'library' })
  rejects(() => lib.played(T(2), { type: 'radio' }), 400)
  rejects(() => lib.played(T(2), { type: 'album', id: 7 }), 400)
})

test('playlists: one person has at most 10000 playlists and 100000 entries in all; at the caps the file is a few MB and loads back', async (t) => {
  assert.equal(MAX_PLAYLISTS, 10000)
  assert.equal(MAX_PLAYLIST_ENTRIES, 100000)
  const { user, users, dir } = await setup(t)
  const lists = []
  // Each one is made in memory; the file is written once, after the debounce.
  for (let i = 0; i < MAX_PLAYLISTS; i++) lists.push(user.createPlaylist({ name: 'P' + i }))
  rejects(() => user.createPlaylist({ name: 'Una di troppo' }), 400)
  assert.equal(user.playlists.size, MAX_PLAYLISTS)
  user.deletePlaylist(lists.pop().id)
  user.createPlaylist({ name: 'Di nuovo' })

  const full = Array.from({ length: 20000 }, (_, i) => T(1 + (i % 5)))
  for (let i = 0; i < MAX_PLAYLIST_ENTRIES / 20000; i++) user.addToPlaylist(lists[i].id, full)
  rejects(() => user.addToPlaylist(lists[5].id, [T(1)]), 400)
  rejects(() => user.updatePlaylist(lists[5].id, { trackIds: [T(1)] }), 400)
  // Replacing a full playlist with a list of the same length is fine.
  user.updatePlaylist(lists[0].id, { trackIds: full.slice().reverse() })
  user.removeFromPlaylist(lists[0].id, [0])
  user.addToPlaylist(lists[5].id, [T(2)])
  assert.equal([...user.playlists.values()].reduce((n, p) => n + p.trackIds.length, 0), MAX_PLAYLIST_ENTRIES)
  users.flush()
  await users.settled()
  // The log holds its snapshot (about 4 MB here) and at most about as much again of changes.
  assert.ok(fs.statSync(path.join(dir, 'users', 'owner.log')).size < 12 * 1024 * 1024)
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.json')))
  const again = new Users({ dataDir: dir, debounceMs: 10 })
  again.load()
  const back = again.get('owner')
  const entries = [...back.playlists.values()].reduce((n, p) => n + p.trackIds.length, 0)
  again.close()
  assert.equal(back.playlists.size, MAX_PLAYLISTS)
  assert.equal(entries, MAX_PLAYLIST_ENTRIES)
})

test('users: a file too big to parse is set aside at start, the others load', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  fs.mkdirSync(path.join(dir, 'users'))
  const big = 'a'.repeat(32)
  const fine = 'b'.repeat(32)
  const huge = { schema: 1, version: 1, playlists: [{ id: '0123456789abcdef', name: 'Enorme', trackIds: Array(5000).fill(T(1)) }], likes: [], recents: [] }
  fs.writeFileSync(path.join(dir, 'users', big + '.json'), JSON.stringify(huge))
  fs.writeFileSync(path.join(dir, 'users', fine + '.json'), JSON.stringify({ schema: 1, version: 1, playlists: [], likes: [{ id: T(2), at: 1 }], recents: [] }))
  const users = new Users({ dataDir: dir, debounceMs: 10, maxFileBytes: 64 * 1024 })
  users.load()
  t.after(() => users.close())
  assert.deepEqual(users.keys(), [fine])
  assert.deepEqual(users.get(fine).likes.map((l) => l.id), [T(2)])
  const names = fs.readdirSync(path.join(dir, 'users'))
  assert.ok(!names.includes(big + '.json'))
  assert.ok(names.some((n) => n.startsWith(big + '.json.toobig-')), 'kept aside: ' + names)
})

test('users: a merge cut after B was written runs again without doubling anything', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  const B = 'b'.repeat(32)
  fs.mkdirSync(path.join(dir, 'users'))
  const ownerData = {
    schema: 1, version: 1,
    playlists: [{ id: '0123456789abcdef', name: 'Vecchia', description: '', trackIds: [T(1)], createdAt: 1, updatedAt: 1 }],
    likes: [{ id: T(1), at: 10 }],
    recents: [{ trackId: T(1), at: 100, context: { type: 'library' } }, { trackId: T(2), at: 90, context: { type: 'album', id: 'x' } }],
    covers: { playlist: {} }
  }
  fs.writeFileSync(path.join(dir, 'users', 'owner.json'), JSON.stringify(ownerData))
  fs.writeFileSync(path.join(dir, 'users', B + '.json'), JSON.stringify({ schema: 1, version: 1, playlists: [], likes: [], recents: [{ trackId: T(3), at: 200, context: { type: 'library' } }], covers: { playlist: {} } }))
  let users = new Users({ dataDir: dir, debounceMs: 10 })
  users.load()
  await users.merge('owner', B)
  const once = users.get(B)._data()
  users.close()
  // The crash: B written, A not deleted yet.
  fs.writeFileSync(path.join(dir, 'users', 'owner.json'), JSON.stringify(ownerData))
  users = new Users({ dataDir: dir, debounceMs: 10 })
  users.load()
  await users.merge('owner', B)
  const twice = users.get(B)._data()
  users.close()
  assert.deepEqual(twice.recents.map((r) => r.trackId + '@' + r.at), [T(3) + '@200', T(1) + '@100', T(2) + '@90'])
  assert.deepEqual([twice.playlists, twice.likes, twice.recents], [once.playlists, once.likes, once.recents])
  assert.ok(!fs.existsSync(path.join(dir, 'users', 'owner.json')))
})

test('playlists: an order made from an older list (base) keeps what changed on the list since', async (t) => {
  const { user } = await setup(t, 9)
  const [a, b, c, d, x, y, u, v, w] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(T)
  const p = user.createPlaylist({ name: 'P' })
  const set = (ids) => user.updatePlaylist(p.id, { trackIds: ids })
  const edit = (want, base) => user.updatePlaylist(p.id, { trackIds: want, base }).trackIds

  // Another device added d after this one read [a, b, c]; this one moves c to the top.
  set([a, b, c, d])
  assert.deepEqual(edit([c, a, b], [a, b, c]), [c, a, b, d], 'a song added meanwhile is kept, at the end')
  // A song inserted before b stays before b.
  set([a, x, b, c])
  assert.deepEqual(edit([c, a, b], [a, b, c]), [c, a, x, b])
  // A song removed meanwhile does not come back.
  set([a, c, d])
  assert.deepEqual(edit([d, a, b, c], [a, b, c, d]), [d, a, c])
  // What the edit removed goes, what was added meanwhile stays.
  set([a, b, c, d, x])
  assert.deepEqual(edit([a, c, d], [a, b, c, d]), [a, c, d, x])
  // The same id twice: matched by count.
  set([a, b, a, c])
  assert.deepEqual(edit([a, a, b], [a, b, a]), [a, a, b, c])
  // A base equal to the list: the order asked, as it is.
  set([a, b, c])
  assert.deepEqual(edit([b, c, a], [a, b, c]), [b, c, a])
  // Without base: the whole list, as before.
  set([a, b, c, d])
  assert.deepEqual(user.updatePlaylist(p.id, { trackIds: [c, a, b] }).trackIds, [c, a, b])

  // Two removals made one after the other on one device end the same in either arrival order.
  for (const order of [[0, 1], [1, 0]]) {
    set([w, u, v, x])
    const reqs = [{ want: [w, v, x], base: [w, u, v, x] }, { want: [w, x], base: [w, v, x] }]
    for (const i of order) edit(reqs[i].want, reqs[i].base)
    assert.deepEqual(p.trackIds, [w, x], 'order ' + order)
  }
  // Two songs swapped for their copies (x for y, then u for v) while both swaps travel.
  for (const order of [[0, 1], [1, 0]]) {
    set([x, a, u])
    const reqs = [{ want: [y, a, u], base: [x, a, u] }, { want: [y, a, v], base: [y, a, u] }]
    for (const i of order) edit(reqs[i].want, reqs[i].base)
    assert.deepEqual(p.trackIds, [y, a, v], 'swaps, order ' + order)
  }

  set([a, b])
  rejects(() => user.updatePlaylist(p.id, { trackIds: [b, a], base: 'nope' }), 400)
  rejects(() => user.updatePlaylist(p.id, { trackIds: [b, a], base: ['../x'] }), 400)
  assert.deepEqual(p.trackIds, [a, b], 'a refused base changes nothing')
})

test('playlists: a removal with the ids seen removes that song, where it is now, or nothing', async (t) => {
  const { user } = await setup(t, 6)
  const [a, b, c, d, u, v] = [1, 2, 3, 4, 5, 6].map(T)
  const p = user.createPlaylist({ name: 'P' })
  const set = (ids) => user.updatePlaylist(p.id, { trackIds: ids })

  // Two devices see [a, b, c, d]; one removes a, the other (not refreshed) removes c at 2.
  set([a, b, c, d])
  user.removeFromPlaylist(p.id, [0], [a])
  user.removeFromPlaylist(p.id, [2], [c])
  assert.deepEqual(p.trackIds, [b, d], 'c went, d stayed')

  // A song already gone: nothing else is removed, and nothing changes.
  const version = user.version
  user.removeFromPlaylist(p.id, [1], [c])
  assert.deepEqual(p.trackIds, [b, d])
  assert.equal(user.version, version, 'no change, no new version')

  // A position past the end of a shorter list: the song at its nearest place.
  set([a, b, c])
  user.removeFromPlaylist(p.id, [7], [a])
  assert.deepEqual(p.trackIds, [b, c])

  // Duplicates: two removals of u, made one after the other, in either arrival order.
  for (const order of [[0, 1], [1, 0]]) {
    set([u, v, u])
    const reqs = [{ index: 0, id: u }, { index: 1, id: u }]
    for (const i of order) user.removeFromPlaylist(p.id, [reqs[i].index], [reqs[i].id])
    assert.deepEqual(p.trackIds, [v], 'order ' + order)
  }
  // Two positions of one request never take the same place.
  set([u, v, u])
  user.removeFromPlaylist(p.id, [0, 0], [u, u])
  assert.deepEqual(p.trackIds, [v])

  set([a, b, c])
  rejects(() => user.removeFromPlaylist(p.id, [0, 1], [a]), 400)
  rejects(() => user.removeFromPlaylist(p.id, [0], 'a'), 400)
  rejects(() => user.removeFromPlaylist(p.id, [0, 1], [a, 'zz']), 400)
  rejects(() => user.removeFromPlaylist(p.id, [-1], [a]), 400)
  assert.deepEqual(p.trackIds, [a, b, c], 'refused removals change nothing')
  // Without ids, positions as before.
  user.removeFromPlaylist(p.id, [1])
  assert.deepEqual(p.trackIds, [a, c])
})

test('playlists: a song in the list twice keeps a copy when two devices remove the same one', async (t) => {
  const { user } = await setup(t, 5)
  const [a, b, c, x, y] = [1, 2, 3, 4, 5].map(T)
  const p = user.createPlaylist({ name: 'P' })
  const set = (ids) => user.updatePlaylist(p.id, { trackIds: ids })
  const edit = (want, base) => user.updatePlaylist(p.id, { trackIds: want, base }).trackIds

  // Removals, with how many copies of the song each device saw. Both see [a, b, a]; one removes
  // the first a; the other, not refreshed, removes the first a too.
  set([a, b, a])
  user.removeFromPlaylist(p.id, [0], [a], [2])
  user.removeFromPlaylist(p.id, [0], [a], [2])
  assert.deepEqual(p.trackIds, [b, a], 'the other copy stays')
  // Copies side by side: the copy now at the position is not taken for the one already gone.
  set([a, a, b])
  user.removeFromPlaylist(p.id, [0], [a], [2])
  user.removeFromPlaylist(p.id, [0], [a], [2])
  assert.deepEqual(p.trackIds, [a, b])
  // Both copies asked by the device behind: the one still there goes.
  set([a, b, a, c])
  user.removeFromPlaylist(p.id, [0], [a], [2])
  user.removeFromPlaylist(p.id, [0, 2], [a, a], [2, 2])
  assert.deepEqual(p.trackIds, [b, c])
  // A copy added since does not hold a removal back.
  set([a, b, a])
  user.addToPlaylist(p.id, [a])
  user.removeFromPlaylist(p.id, [2], [a], [2])
  assert.deepEqual(p.trackIds, [a, b, a])
  // One device, two removals in order: both copies go.
  set([a, b, a])
  user.removeFromPlaylist(p.id, [0], [a], [2])
  user.removeFromPlaylist(p.id, [1], [a], [1])
  assert.deepEqual(p.trackIds, [b])

  set([a, b])
  rejects(() => user.removeFromPlaylist(p.id, [0], [a], [0]), 400)
  rejects(() => user.removeFromPlaylist(p.id, [0], [a], ['1']), 400)
  rejects(() => user.removeFromPlaylist(p.id, [0], [a], [1, 1]), 400)
  rejects(() => user.removeFromPlaylist(p.id, [0], [a], 1), 400)
  rejects(() => user.removeFromPlaylist(p.id, [0], null, [1]), 400)
  assert.deepEqual(p.trackIds, [a, b], 'refused removals change nothing')

  // Edits. Both see [a, b, a]; one removes the first a; the other's edit, made from [a, b, a],
  // removes the first a too.
  set([b, a])
  assert.deepEqual(edit([b, a], [a, b, a]), [b, a], 'an edit: the other copy stays')
  // A song swapped for its copy y here and on another device (or the same swap sent twice): y once.
  set([y, b])
  assert.deepEqual(edit([y, b], [x, b]), [y, b], 'swapped on both')
  set([x, b])
  edit([y, b], [x, b])
  assert.deepEqual(edit([y, b], [x, b]), [y, b], 'the same swap twice')
  // Changes that differ still add up: a copy added elsewhere and one removed here.
  set([a, b, a])
  assert.deepEqual(edit([b], [a, b]), [b, a])
  // y already in the list once: the swap makes it twice, as asked.
  set([x, b, y])
  assert.deepEqual(edit([y, b, y], [x, b, y]), [y, b, y])
})
