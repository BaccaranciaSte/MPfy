// A person's log (server/userlog.mjs) through the person's own calls (users.mjs):
// whatever happens (compactions written while changes keep coming, a crash, a
// short write, a full disk, a power cut at any step of a compaction, a broken
// line), the file replays to a true state of the person's history; versions and
// epochs tell a client's state apart from any other.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Users } from '../server/users.mjs'
import { UserLog, NODE_FS, ZERO_EPOCH, TombRing, EditRing } from '../server/userlog.mjs'
import { HttpError } from '../server/errors.mjs'
import { tmpDir, rmDir } from './helpers.mjs'

const T = (n) => n.toString(16).padStart(24, '0')
const C = (n) => 'c' + n.toString(16).padStart(23, '0')
const tick = () => new Promise((resolve) => setImmediate(resolve))
let seed = 11
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = (a) => a[Math.floor(rnd() * a.length)]

// File calls that can fail on demand and that keep, per file, how many bytes are surely on
// disk (written before an fsync), so a power cut can be played: the file cut to that length,
// or the file a rename replaced when the directory was not synced since.
class TestFs {
  constructor () {
    this.paths = new Map()
    this.synced = new Map()
    this.before = new Map()
    this.fail = null // the next write: { code } throws, { short: n } writes n bytes
    for (const k of Object.keys(NODE_FS)) if (!(k in this)) this[k] = NODE_FS[k]
  }

  openSync (p, flags, mode) {
    const fd = fs.openSync(p, flags, mode)
    const key = path.resolve(p)
    this.paths.set(fd, key)
    if (flags === 'w') this.synced.set(key, 0)
    else if (!this.synced.has(key)) this.synced.set(key, fs.fstatSync(fd).size)
    return fd
  }

  closeSync (fd) {
    this.paths.delete(fd)
    fs.closeSync(fd)
  }

  writeSync (fd, buf, off, len, pos) {
    const f = this.fail
    if (f !== null) {
      this.fail = null
      if (f.code) throw Object.assign(new Error(f.code), { code: f.code })
      return fs.writeSync(fd, buf, off, f.short, pos)
    }
    return fs.writeSync(fd, buf, off, len, pos)
  }

  _mark (fd, size) {
    const p = this.paths.get(fd)
    if (p !== undefined) this.synced.set(p, Math.max(this.synced.get(p) || 0, size))
  }

  fsyncSync (fd) {
    fs.fsyncSync(fd)
    this._mark(fd, fs.fstatSync(fd).size)
  }

  fdatasyncSync (fd) {
    fs.fdatasyncSync(fd)
    this._mark(fd, fs.fstatSync(fd).size)
  }

  fsync (fd, cb) {
    const size = fs.fstatSync(fd).size
    fs.fsync(fd, (err) => {
      if (!err) this._mark(fd, size)
      cb(err)
    })
  }

  fdatasync (fd, cb) {
    let size
    try {
      size = fs.fstatSync(fd).size
    } catch (err) {
      return process.nextTick(cb, err)
    }
    fs.fdatasync(fd, (err) => {
      if (!err) this._mark(fd, size)
      cb(err)
    })
  }

  ftruncateSync (fd, len) {
    fs.ftruncateSync(fd, len)
    const p = this.paths.get(fd)
    if (p !== undefined && this.synced.get(p) > len) this.synced.set(p, len)
  }

  renameSync (a, b) {
    const from = path.resolve(a)
    const to = path.resolve(b)
    if (fs.existsSync(to)) this.before.set(to, fs.readFileSync(to).subarray(0, this.synced.get(to) ?? Infinity))
    this.synced.set(to, this.synced.get(from) || 0)
    this.synced.delete(from)
    NODE_FS.renameSync(a, b)
  }

  fsyncDir (d) {
    this.before.clear()
    NODE_FS.fsyncDir(d)
  }

  /** What a power cut now could leave at `file`: one or two images. */
  images (file) {
    const p = path.resolve(file)
    const out = [fs.readFileSync(p).subarray(0, this.synced.get(p) ?? Infinity)]
    if (this.before.has(p)) out.push(this.before.get(p))
    return out
  }
}

function setup (t, { key = 'owner', fsx = NODE_FS, logLimits = {} } = {}) {
  const dir = tmpDir()
  const users = new Users({ dataDir: dir, fsx, logLimits })
  users.load()
  t.after(async () => {
    users.close()
    await users.settled()
    rmDir(dir)
  })
  return { dir, users, user: users.get(key), file: users.fileOf(key) }
}

// A log read again from its file, as a restart reads it.
function replay (file, key = 'owner') {
  const log = new UserLog({ file, key })
  const status = log.openSync()
  const out = status === 'ok' ? { version: log.version, epochs: log.epochs.map((e) => ({ ...e })), view: log.person.view(), log } : { status }
  log.close()
  return out
}

function replayBytes (bytes, key = 'owner') {
  const dir = tmpDir()
  try {
    fs.mkdirSync(path.join(dir, 'users'))
    const file = path.join(dir, 'users', key + '.log')
    fs.writeFileSync(file, bytes)
    const r = replay(file, key)
    r.cuts = fs.readdirSync(path.join(dir, 'users')).filter((n) => n.includes('.cut-'))
    return r
  } finally {
    rmDir(dir)
  }
}

const IDS = Array.from({ length: 40 }, (_, i) => T(i + 1))

// One random change through the person's calls; refusals are part of the history too.
function randomChange (users, user) {
  const pls = [...user.playlists.keys()]
  const pl = pls.length > 0 ? pick(pls) : null
  const x = rnd()
  try {
    if (x < 0.07 || pl === null) user.createPlaylist({ name: 'P' + Math.floor(rnd() * 100) })
    else if (x < 0.25) {
      const len = user.playlists.get(pl).trackIds.length
      user.addToPlaylist(pl, [pick(IDS), pick(IDS)], Math.floor(rnd() * (len + 2)))
    } else if (x < 0.35) {
      const cur = user.playlists.get(pl).trackIds
      if (cur.length > 0) {
        const i = Math.floor(rnd() * cur.length)
        user.removeFromPlaylist(pl, [i], [cur[i]], rnd() < 0.5 ? [1] : undefined)
      }
    } else if (x < 0.41) {
      const cur = user.playlists.get(pl).trackIds
      const want = cur.slice().reverse()
      user.updatePlaylist(pl, rnd() < 0.5 ? { trackIds: want, base: cur, name: 'N' + Math.floor(rnd() * 9) } : { description: 'd' + Math.floor(rnd() * 9) })
    } else if (x < 0.44) user.deletePlaylist(pl)
    else if (x < 0.56) user.like(pick(IDS))
    else if (x < 0.62) user.unlike(pick(IDS))
    else if (x < 0.66) user.bulkLikes({ add: [pick(IDS), pick(IDS), pick(IDS)], remove: [pick(IDS)] })
    else if (x < 0.80) user.played(pick(IDS), { type: 'album', id: 'a' + Math.floor(rnd() * 3) }, Date.now() - Math.floor(rnd() * 100000))
    else if (x < 0.84) users.removeTrackEverywhere([pick(IDS)])
    else if (x < 0.90) user.setPlaylistCover(pl, rnd() < 0.5 ? 'small' : 'large', C(Math.floor(rnd() * 20)))
    else if (x < 0.93) user.clearPlaylistCover(pl)
    else if (x < 0.96) user.dropMissingCovers((id) => id.charCodeAt(23) % 3 !== 0)
    else user.updatePlaylist(pl, { name: 'R' + Math.floor(rnd() * 9) })
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err
  }
}

function assertSame (file, user, what) {
  const back = replay(file)
  assert.equal(back.version, user.version, what + ': version')
  assert.deepEqual(back.epochs, user.log.epochs, what + ': epochs')
  assert.deepEqual(back.view, user.p.view(), what)
}

test('replay: 40 rounds of 400 random changes, batches, compactions started at random and running while changes come, merges; every replay equals memory', async (t) => {
  let replays = 0
  let compactions = 0
  let spanned = 0
  for (let round = 0; round < 40; round++) {
    const { users, user, file } = setup(t, { logLimits: { compactMin: 4096, sliceBytes: 64 + Math.floor(rnd() * 512), keepRoundBytes: 256 } })
    for (let step = 0; step < 400; step++) {
      const compacting = user.log.compaction !== null
      randomChange(users, user)
      if (compacting && user.log.compaction !== null) spanned++
      if (rnd() < 0.03) user.log.compact()
      if (rnd() < 0.01) {
        // Another person's data merged in, waited for: B compacted with it, A's log gone.
        const other = users.get(crypto.randomBytes(16).toString('hex'))
        for (let k = 0; k < 5; k++) randomChange(users, other)
        await users.merge(other.key, 'owner')
      }
      if (rnd() < 0.6) await tick()
      if (step % 25 === 24) {
        assertSame(file, user, 'round ' + round + ' step ' + step)
        replays++
      }
    }
    await user.log.settled()
    compactions += user.log.compactions
    assertSame(file, user, 'round ' + round + ' at its end')
    replays++
  }
  assert.ok(compactions > 20, compactions + ' compactions')
  assert.ok(spanned > 100, spanned + ' changes made while a compaction ran')
  assert.ok(replays >= 640)
})

test('replay: a change made while a compaction writes its snapshot is in the list once, before or after its object was written', async (t) => {
  for (const when of ['after its line', 'before its line']) {
    const { user, file } = setup(t, { logLimits: { compactMin: 1e12, sliceBytes: 1 } })
    const a = user.createPlaylist({ name: 'A' })
    const b = user.createPlaylist({ name: 'B' })
    user.addToPlaylist(a.id, [T(1)])
    user.addToPlaylist(b.id, [T(2)])
    // Each line is a slice of its own: when compact() returns, the line of A is written and
    // the walk waits for its next turn; B's line is made after this change.
    const done = user.log.compact()
    user.addToPlaylist(when === 'after its line' ? a.id : b.id, [T(3)])
    await done
    assert.equal(user.log.compactions, 1)
    assertSame(file, user, when)
    assert.deepEqual(replay(file).view.playlists.map((p) => p.trackIds), user.p.view().playlists.map((p) => p.trackIds))
  }
})

test('replay: a like taken back and given again while a snapshot is written keeps its place before the likes that followed it', async (t) => {
  const { user, file } = setup(t, { logLimits: { compactMin: 1e12, sliceBytes: 1 } })
  for (let i = 1; i <= 2500; i++) user.like(T(i))
  const done = user.log.compact()
  // One turn: the first chunk of likes (with T(1)) is written, the rest is not.
  await tick()
  user.unlike(T(1))
  user.like(T(1))
  user.like(T(9999))
  user.unlike(T(2400))
  await done
  assert.equal(user.log.compactions, 1)
  const ids = user.likes.map((l) => l.id)
  assert.deepEqual(ids.slice(0, 3), [T(9999), T(1), T(2500)])
  assertSame(file, user, 'after the compaction')
  assert.deepEqual(replay(file).view.likes.map((l) => l[0]), user.p.view().likes.map((l) => l[0]))
})

test('crash: a last line cut at any byte replays to the state before that change, the file cut back to its whole lines', (t) => {
  const { user, file } = setup(t)
  const p = user.createPlaylist({ name: 'P' })
  user.addToPlaylist(p.id, [T(1), T(2)])
  user.like(T(1))
  const before = replay(file)
  const whole = fs.readFileSync(file)
  user.addToPlaylist(p.id, [T(3), T(4), T(5)], 1)
  const after = fs.readFileSync(file)
  assert.ok(after.length > whole.length)
  for (let cut = whole.length; cut < after.length; cut++) {
    const r = replayBytes(after.subarray(0, cut))
    assert.equal(r.version, before.version, 'cut at ' + cut)
    assert.deepEqual(r.view, before.view, 'cut at ' + cut)
    assert.deepEqual(r.cuts, [], 'a line cut short is not a damaged log')
  }
  const r = replayBytes(after)
  assert.deepEqual(r.view.playlists[0].trackIds, [T(1), T(3), T(4), T(5), T(2)])
})

test('a short write and a full disk: the file cut back, nothing applied, 507; the next change appends whole', (t) => {
  const tfs = new TestFs()
  const { user, file } = setup(t, { fsx: tfs })
  const p = user.createPlaylist({ name: 'P' })
  user.like(T(1))
  for (const fail of [{ short: 7 }, { code: 'ENOSPC' }, { code: 'EIO' }]) {
    const size = fs.statSync(file).size
    const version = user.version
    const view = user.p.view()
    tfs.fail = fail
    assert.throws(() => user.addToPlaylist(p.id, [T(2), T(3)]), (err) => err instanceof HttpError && err.status === (fail.code === 'EIO' ? 500 : 507) && (fail.code === 'EIO' || err.code === 'disk_full'))
    assert.equal(fs.statSync(file).size, size, 'cut back')
    assert.equal(user.version, version)
    assert.deepEqual(user.p.view(), view, 'nothing applied')
    tfs.fail = fail
    assert.throws(() => user.like(T(9)), HttpError)
    assert.deepEqual(user.likes.map((l) => l.id), [T(1)])
    user.addToPlaylist(p.id, [T(4)])
    assertSame(file, user, 'after ' + JSON.stringify(fail))
  }
  assert.deepEqual(user.playlists.get(p.id).trackIds, [T(4), T(4), T(4)])
})

test('a write that cannot be cut back breaks the log: every later change refused with 500 until a restart', (t) => {
  const tfs = new TestFs()
  const { user, file, dir } = setup(t, { fsx: tfs })
  user.like(T(1))
  tfs.ftruncateSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }
  const open = tfs.openSync.bind(tfs)
  tfs.openSync = (p, flags, mode) => {
    if (flags === 'r+') throw Object.assign(new Error('EIO'), { code: 'EIO' })
    return open(p, flags, mode)
  }
  tfs.fail = { short: 3 }
  assert.throws(() => user.like(T(2)), HttpError)
  assert.throws(() => user.like(T(3)), (err) => err.status === 500)
  assert.equal(user.log.broken, true)
  user.close()
  // At the next start the half line is dropped.
  const again = new Users({ dataDir: dir })
  again.load()
  assert.deepEqual(again.get('owner').likes.map((l) => l.id), [T(1)])
  again.get('owner').like(T(4))
  assert.deepEqual(again.get('owner').likes.map((l) => l.id), [T(4), T(1)])
  again.close()
  assert.ok(fs.existsSync(file))
})

test('power cut during and right after a compaction: at every step the file left replays to a true state, after the rename at the snapshot\'s version or later', async (t) => {
  for (let round = 0; round < 6; round++) {
    const tfs = new TestFs()
    const { users, user, file } = setup(t, { fsx: tfs, logLimits: { compactMin: 1e12, sliceBytes: 128, keepRoundBytes: round % 2 === 0 ? 64 * 1024 : 256 } })
    const history = new Map()
    const note = () => history.set(user.version, user.p.view())
    note()
    const lists = []
    for (let i = 0; i < 6; i++) {
      lists.push(user.createPlaylist({ name: 'L' + i }).id)
      note()
      user.addToPlaylist(lists[i], IDS.slice(i, i + 8))
      note()
    }
    for (let i = 0; i < 30; i++) {
      randomChange(users, user)
      note()
    }
    let checked = 0
    let renamed = false
    let failed = null
    // A failure inside a step is kept: the compaction would only log it.
    const check = (step) => (log) => {
      try {
        look(step, log)
      } catch (err) {
        if (failed === null) failed = err
        throw err
      }
    }
    const look = (step, log) => {
      if (step === 'afterRename') renamed = true
      tfs.images(file).forEach((img, i) => {
        const r = replayBytes(img)
        assert.ok(history.has(r.version), step + ': version ' + r.version + ' was a version of the history')
        assert.deepEqual(r.view, history.get(r.version), step + ': a true state')
        // The new file (the first image); the second is the old one a rename not synced leaves.
        if (renamed && i === 0) assert.ok(r.version >= log.compaction.ve, step + ': at the snapshot\'s version or later')
        checked++
      })
    }
    user.log.hooks = {}
    for (const step of ['snapshotSynced', 'roundSynced', 'beforeRename', 'afterRename', 'afterDirSync']) user.log.hooks[step] = check(step)
    const done = user.log.compact()
    let during = 0
    while (user.log.compaction !== null) {
      // The first playlist's line is written first: changes to it after that line are only in
      // the lines kept for the new file.
      const first = user.playlists.keys().next().value
      if (first !== undefined) user.addToPlaylist(first, [pick(IDS)])
      note()
      randomChange(users, user)
      note()
      during++
      await tick()
    }
    await done
    user.log.hooks = null
    if (failed !== null) throw failed
    assert.equal(user.log.compactions, 1)
    assert.ok(during > 2, 'changes came during the compaction')
    // Right after: a few changes, then the power cut.
    for (let i = 0; i < 5; i++) {
      randomChange(users, user)
      note()
    }
    for (const img of tfs.images(file)) {
      const r = replayBytes(img)
      assert.deepEqual(r.view, history.get(r.version), 'right after')
    }
    assert.ok(checked >= 5)
    assertSame(file, user, 'the live file')
  }
})

test('a line that does not parse or breaks the version sequence in the middle: the trusted part ends there, the rest kept aside, nothing thrown', (t) => {
  for (const broken of ['{"v":1,"o":"l"', '{"v":99999999999999,"o":"u","id":"' + T(1) + '"}', '{"v":"x","o":"l","id":"' + T(1) + '","at":1}', '{"v":1,"o":"what","id":1}', '[1,2]']) {
    const { user, file, dir } = setup(t)
    user.like(T(1))
    user.like(T(2))
    const before = replay(file)
    const good = fs.readFileSync(file)
    user.like(T(3))
    user.like(T(4))
    const after = fs.readFileSync(file)
    user.close()
    const rest = after.subarray(good.length)
    fs.writeFileSync(file, Buffer.concat([good, Buffer.from(broken + '\n'), rest]))
    const users = new Users({ dataDir: dir })
    assert.doesNotThrow(() => users.load())
    const u = users.get('owner')
    assert.equal(u.version, before.version, broken)
    assert.deepEqual(u.likes.map((l) => l.id), [T(2), T(1)])
    const cut = fs.readdirSync(path.join(dir, 'users')).filter((n) => n.startsWith('owner.log.cut-'))
    assert.equal(cut.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'users', cut[0])), Buffer.concat([Buffer.from(broken + '\n'), rest]), 'the rest kept')
    assert.equal(fs.statSync(file).size, good.length, 'the file cut there')
    u.like(T(5))
    users.close()
    assert.deepEqual(replay(file).view.likes.map((l) => l[0]), [T(1), T(2), T(5)])
  }
})

test('a .tmp left by a compaction cut short is deleted at start, the log intact; a log naming another key is set aside', (t) => {
  const { users, user, file, dir } = setup(t)
  user.like(T(1))
  const p = user.createPlaylist({ name: 'P' })
  user.addToPlaylist(p.id, [T(2)])
  const view = user.p.view()
  users.close()
  fs.writeFileSync(file + '.tmp', '{"mpfy":"user-log","schema":2,"key":"owner","snap":"000000000000"}\n{"S":{"v":1}}\n{"P":')
  const other = 'a'.repeat(32)
  fs.copyFileSync(file, path.join(dir, 'users', other + '.log'))
  const again = new Users({ dataDir: dir })
  again.load()
  const names = fs.readdirSync(path.join(dir, 'users'))
  assert.ok(!names.includes('owner.log.tmp'))
  assert.deepEqual(again.get('owner').p.view(), view)
  assert.equal(again.has(other), false, 'never served')
  assert.ok(names.some((n) => n.startsWith(other + '.log.wrong-')))
  again.close()
})

test('epochs: the first change after a restart opens one; a version lost in a power cut is not known even when a later epoch reuses its number; another person\'s versions never are', (t) => {
  const { users, user, file, dir } = setup(t)
  assert.equal(user.version, 0)
  assert.equal(user.epoch, ZERO_EPOCH)
  assert.equal(user.changesSince(ZERO_EPOCH, 0), null, 'the zero epoch: the whole user part')
  user.like(T(1))
  const e1 = user.epoch
  assert.notEqual(e1, ZERO_EPOCH)
  const lines = () => fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(JSON.parse(lines().at(-2)), { e: e1, v: user.version - 1 }, 'the epoch line goes with the first change')
  assert.notEqual(user.changesSince(e1, user.version), null)
  assert.equal(user.changesSince(ZERO_EPOCH, 0), null)
  user.like(T(2))
  const synced = fs.readFileSync(file)
  const vSynced = user.version
  user.like(T(3))
  user.like(T(4))
  const vLost = user.version
  assert.notEqual(user.changesSince(e1, vLost), null)
  users.close()
  // A power cut: the last two lines never reached the disk.
  fs.writeFileSync(file, synced)
  // A clock that gives nothing: the next epoch starts right after the last version on disk.
  const log = new UserLog({ file, key: 'owner', now: () => 0 })
  assert.equal(log.openSync(), 'ok')
  assert.equal(log.version, vSynced)
  assert.equal(log.known(e1, vSynced), true)
  assert.equal(log.known(e1, vLost), false, 'above the epoch\'s last version on disk')
  for (let k = 0; k < 4; k++) log.commit([{ o: 'l', id: T(10 + k), at: 1 }], (r) => log.person.apply(r))
  const e2 = log.epoch
  assert.notEqual(e2, e1)
  assert.ok(log.version >= vLost, 'the number is reused')
  assert.equal(log.known(e1, vLost), false, 'still not known')
  assert.equal(log.known(e2, vLost), true)
  assert.equal(log.known(e2, vSynced), false, 'below the epoch\'s first version')
  assert.equal(log.known(e1.replace(/./, (c) => (c === '0' ? '1' : '0')), vSynced), false, 'another epoch id')
  assert.equal(log.known(ZERO_EPOCH, 0), false)
  assert.equal(log.known(e1, 1.5), false)
  log.close()
  // Another person's versions.
  const users2 = new Users({ dataDir: dir })
  users2.load()
  const owner = users2.get('owner')
  const other = users2.get('b'.repeat(32))
  other.like(T(1))
  assert.equal(owner.changesSince(other.epoch, other.version), null)
  assert.equal(other.changesSince(owner.epoch, owner.version), null)
  assert.notEqual(owner.changesSince(owner.epoch, owner.version), null)
  users2.close()
})

test('epochs: a migrated log begins with an epoch nobody holds; a merge moves the horizon past every version before it', async (t) => {
  const dir = tmpDir()
  t.after(() => rmDir(dir))
  fs.mkdirSync(path.join(dir, 'users'))
  fs.writeFileSync(path.join(dir, 'users', 'owner.json'), JSON.stringify({ schema: 1, version: 7, playlists: [], likes: [{ id: T(1), at: 5 }], recents: [] }))
  const users = new Users({ dataDir: dir })
  users.load()
  const owner = users.get('owner')
  const header = JSON.parse(fs.readFileSync(users.fileOf('owner'), 'utf8').split('\n')[0])
  const st = fs.statSync(path.join(dir, 'users', 'owner.json'))
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'users', 'owner.json'))).digest('hex')
  assert.deepEqual(header.from, { size: st.size, mtimeMs: st.mtimeMs, hash })
  assert.equal(owner.log.epochs.length, 1)
  const [e] = owner.log.epochs
  assert.deepEqual([e.first, e.last], [owner.version, owner.version])
  assert.ok(owner.version >= 8)
  assert.equal(owner.changesSince(ZERO_EPOCH, 7), null)
  assert.equal(owner.changesSince(e.id, 7), null)
  assert.notEqual(owner.changesSince(e.id, owner.version), null, 'once served, known')
  owner.like(T(2))
  assert.equal(owner.log.epochs.length, 1, 'the migration\'s epoch is this run\'s')
  const held = owner.version
  await new Promise((resolve) => setTimeout(resolve, 5))
  const b = users.get('b'.repeat(32))
  b.like(T(3))
  await users.merge(b.key, 'owner')
  assert.equal(owner.changesSince(owner.epoch, held), null, 'a merge: one whole user part')
  assert.notEqual(owner.changesSince(owner.epoch, owner.version), null)
  assert.deepEqual(owner.likes.map((l) => l.id), [T(3), T(2), T(1)])
  users.close()
  const back = replay(users.fileOf('owner'))
  assert.deepEqual(back.view, owner.p.view())
})

test('removals for a person not loaded: xu lines, opening the run\'s epoch in the same write, equal to the same removals made on the loaded person, updatedAt included', (t) => {
  const { users, user, file, dir } = setup(t)
  const lists = []
  for (let i = 0; i < 4; i++) {
    lists.push(user.createPlaylist({ name: 'P' + i }).id)
    user.addToPlaylist(lists[i], i === 0 ? [T(1), T(2), T(1), T(9)] : [T(1), T(2 + i), T(1)])
  }
  user.like(T(1))
  user.like(T(3))
  user.like(T(9))
  user.played(T(1), null)
  user.played(T(9), null)
  users.close()
  const copy = path.join(dir, 'users', 'copy.log')
  fs.copyFileSync(file, copy)
  const at = [Date.now() + 1000, Date.now() + 3000, Date.now() + 5000]
  const gone = [[T(1)], [T(3), T(4)], [T(9)]]
  // Loaded: the person's own removal, one change each.
  const loaded = new Users({ dataDir: dir })
  loaded.load()
  const u = loaded.get('owner')
  gone.forEach((ids, k) => u.removeTracks(ids, at[k]))
  const want = u.p.view()
  loaded.close()
  // Not loaded: xu lines appended to the same history, then the open.
  const log = new UserLog({ file: copy, key: 'owner' })
  assert.equal(log.openSync(), 'ok')
  log.unload()
  const v0 = log.version
  gone.forEach((ids, k) => log.appendRemoval(ids, at[k]))
  const text = fs.readFileSync(copy, 'utf8').trim().split('\n').slice(-4).map((l) => JSON.parse(l))
  assert.equal(text[0].e, log.epoch, 'the run\'s epoch opened with the first one')
  assert.ok(text[0].v > v0)
  assert.deepEqual(text.slice(1).map((r) => [r.o, r.v]), [['xu', text[0].v + 1], ['xu', text[0].v + 2], ['xu', text[0].v + 3]])
  const back = new UserLog({ file: copy, key: 'owner' })
  assert.equal(back.openSync(), 'ok')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'users')).filter((n) => n.includes('.cut-')), [], 'nothing cut')
  assert.equal(back.version, log.version)
  const got = back.person.view()
  const strip = (v) => ({ ...v, rv: 0, playlists: v.playlists.map((p) => ({ ...p, pv: 0 })), likes: v.likes.map((l) => l.slice(0, 2)) })
  assert.deepEqual(strip(got), strip(want))
  // The newest time among the removals that took something from each playlist.
  assert.deepEqual(got.playlists.map((p) => p.updatedAt), [at[2], at[1], at[1], at[0]])
  assert.deepEqual(got.playlists.map((p) => p.trackIds), [[T(2)], [], [], [T(5)]])
  back.close()
})

test('the removals and the playlist edits kept: grown as they come, the oldest dropped past their limits with the horizon raised', () => {
  const ring = new TombRing(100)
  assert.equal(ring.cap, 0, 'nothing held before the first removal')
  for (let v = 1; v <= 150; v++) ring.push(v % 3 === 0 ? 'l' : v % 3 === 1 ? 'p' : 'c', v % 3 === 0 ? T(v) : v.toString(16).padStart(16, '0'), v)
  assert.equal(ring.count, 100)
  assert.equal(ring.horizon, 50)
  assert.deepEqual([...ring.since(140)].map((e) => e[2]), [141, 142, 143, 144, 145, 146, 147, 148, 149, 150])
  assert.deepEqual([...ring.since(147)].map((e) => e.slice(0, 2)), [['p', (148).toString(16).padStart(16, '0')], ['c', (149).toString(16).padStart(16, '0')], ['l', T(150)]])
  assert.equal([...ring.since()].length, 100)
  const ops = new EditRing(8, 40)
  const pid = (n) => n.toString(16).padStart(16, '0')
  for (let v = 1; v <= 6; v++) ops.push(1, pid(v % 2), v, [v, v, v], v)
  assert.equal(ops.horizon, 0)
  assert.deepEqual([...ops.after(4).get(pid(1))].map((o) => [o.kind, o.pos, [...o.ints]]), [[1, 5, [5, 5, 5]]])
  // Integers past the pool: the oldest ops go.
  ops.push(2, pid(1), 0, Array.from({ length: 30 }, (_, i) => i), 7)
  assert.ok(ops.horizon >= 3)
  assert.deepEqual([...ops.after(6).get(pid(1))].map((o) => o.ints.length), [30])
  for (let v = 8; v <= 20; v++) ops.push(1, pid(2), 0, [v], v)
  assert.equal(ops.count, 8)
  assert.equal(ops.horizon, 12)
  assert.deepEqual([...ops.after(12).get(pid(2))].map((o) => o.ints[0]), [13, 14, 15, 16, 17, 18, 19, 20])
  // An op larger than everything kept: nothing older can be told any more.
  ops.push(2, pid(3), 0, Array.from({ length: 41 }, (_, i) => i), 21)
  assert.equal(ops.count, 0)
  assert.equal(ops.horizon, 21)
})
