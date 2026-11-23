// The comments and lyrics indexes (journal.mjs) under a failing disk: every
// append is checked (a short write or a full disk cuts the file back and the
// change is refused, so a line is never glued to half of another), a cut that
// fails refuses every later change until a restart, and a compaction syncs the
// lines that came while it ran into the new file before it takes the old one's
// place, so a power cut at any step loses nothing that was on disk.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Journal } from '../server/journal.mjs'
import { HttpError } from '../server/errors.mjs'
import { DEFAULT_IO } from '../server/vjournal.mjs'
import { tmpDir, rmDir, cleanup } from './helpers.mjs'

// The two indexes as their stores keep them: a comment id -> [trackId, author],
// a track id -> its lyrics entry.
const COMMENTS = {
  dir: 'comments',
  check: (id, v) => /^[0-9a-f]{32}$/.test(id) && Array.isArray(v) && v.length === 2,
  key: (i) => i.toString(16).padStart(32, '0'),
  value: (i) => ['ab'.repeat(12), 'cd'.repeat(16)]
}
const LYRICS = {
  dir: 'lyrics',
  check: (id, v) => /^[0-9a-f]{24}$/.test(id) && v !== null && typeof v === 'object',
  key: (i) => i.toString(16).padStart(24, '0'),
  value: (i) => ({ kind: i % 2 ? 'synced' : 'plain', source: 'tags', key: 'k' + i, at: 1700000000000 + i })
}

// A file system whose writes can be made short or refused, and whose cut back can fail.
function failingIo () {
  const io = {
    ...DEFAULT_IO,
    mode: null,
    writeSync (fd, buf, off, len, pos) {
      if (io.mode === 'short' || io.mode === 'broken') return fs.writeSync(fd, buf, off, Math.max(1, Math.floor(len / 2)), pos)
      if (io.mode === 'full') throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      return fs.writeSync(fd, buf, off, len, pos)
    },
    ftruncateSync (fd, size) {
      if (io.mode === 'broken') throw Object.assign(new Error('i/o error'), { code: 'EIO' })
      return fs.ftruncateSync(fd, size)
    }
  }
  return io
}

for (const index of [COMMENTS, LYRICS]) {
  test('journal (' + index.dir + '): a short write cuts the file back and refuses the change (500), a full disk refuses it (507), nothing kept; the next change appends whole', async (t) => {
    const dir = cleanup(t).dir(tmpDir())
    fs.mkdirSync(path.join(dir, index.dir))
    const file = path.join(dir, index.dir, 'index.ndjson')
    const io = failingIo()
    const j = new Journal(file, { check: index.check, io }).load()
    j.set(index.key(1), index.value(1))
    j.set(index.key(2), index.value(2))
    const size = fs.statSync(file).size
    io.mode = 'short'
    assert.throws(() => j.set(index.key(3), index.value(3)), (err) => err instanceof HttpError && err.status === 500)
    assert.equal(fs.statSync(file).size, size, 'cut back')
    assert.equal(j.has(index.key(3)), false, 'nothing kept')
    io.mode = 'full'
    assert.throws(() => j.delete(index.key(1)), (err) => err instanceof HttpError && err.status === 507 && err.code === 'disk_full')
    assert.equal(j.has(index.key(1)), true)
    assert.equal(fs.statSync(file).size, size)
    io.mode = null
    j.set(index.key(4), index.value(4))
    j.delete(index.key(2))
    assert.deepEqual([...j.map.keys()], [index.key(1), index.key(4)])
    j.close()
    const replay = new Journal(file, { check: index.check }).load()
    assert.deepEqual([...replay.map], [...j.map], 'every line whole: the replay is the map')
    assert.equal(replay.lines, 4, 'no half line, nothing skipped')
  })
}

test('journal: a cut that fails refuses every later change (500) until the next start, whose replay drops the half line', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const file = path.join(dir, 'index.ndjson')
  const io = failingIo()
  const j = new Journal(file, { check: COMMENTS.check, io }).load()
  j.set(COMMENTS.key(1), COMMENTS.value(1))
  io.mode = 'broken'
  assert.throws(() => j.set(COMMENTS.key(2), COMMENTS.value(2)), (err) => err.status === 500)
  assert.equal(j.broken, true)
  io.mode = null
  assert.throws(() => j.set(COMMENTS.key(3), COMMENTS.value(3)), (err) => err.status === 500)
  assert.deepEqual([...j.map.keys()], [COMMENTS.key(1)])
  j.close()
  assert.ok(!fs.readFileSync(file, 'utf8').endsWith('\n'), 'a half line on disk')
  const again = new Journal(file, { check: COMMENTS.check }).load()
  assert.deepEqual([...again.map.keys()], [COMMENTS.key(1)])
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'cut back to the last whole line')
  again.set(COMMENTS.key(4), COMMENTS.value(4))
  again.close()
  assert.deepEqual([...new Journal(file).load().map.keys()], [COMMENTS.key(1), COMMENTS.key(4)])
})

// A file system that remembers what reached the disk, file by file (a file keeps
// its identity through a rename): an fsync keeps the bytes the file had when it
// was asked, a rename lasts once its folder is synced, and image() writes the
// files a power cut would leave at this moment.
function powerIo () {
  const names = new Map()
  const renamed = new Map()
  const fds = new Map()
  let hook = null
  const nameOf = (file) => {
    for (const [p, f] of names) if (f === file) return p
    return null
  }
  const step = (what, file) => { if (hook !== null) hook(what, nameOf(file)) }
  const io = {
    ...DEFAULT_IO,
    openSync (p, flags, mode) {
      const fd = fs.openSync(p, flags, mode)
      const abs = path.resolve(p)
      if (!names.has(abs)) names.set(abs, { synced: null })
      fds.set(fd, names.get(abs))
      return fd
    },
    closeSync (fd) {
      fds.delete(fd)
      fs.closeSync(fd)
    },
    writeSync (fd, ...rest) {
      const n = fs.writeSync(fd, ...rest)
      step('write', fds.get(fd))
      return n
    },
    fsyncSync (fd) {
      const file = fds.get(fd)
      const data = fs.readFileSync(nameOf(file))
      fs.fsyncSync(fd)
      if (file.synced === null || data.length >= file.synced.length) file.synced = data
      step('sync', file)
    },
    fsync (fd, cb) {
      const file = fds.get(fd)
      const data = fs.readFileSync(nameOf(file))
      fs.fsync(fd, (err) => {
        if (!err && (file.synced === null || data.length >= file.synced.length)) file.synced = data
        step('sync', file)
        cb(err)
      })
    },
    renameSync (a, b) {
      a = path.resolve(a)
      b = path.resolve(b)
      fs.renameSync(a, b)
      const file = names.get(a) || { synced: null }
      renamed.set(b, { from: a, file, before: names.get(b) })
      names.set(b, file)
      names.delete(a)
      step('rename', file)
    },
    fsyncDirSync (dir) {
      for (const b of [...renamed.keys()]) if (path.dirname(b) === path.resolve(dir)) renamed.delete(b)
      step('dirsync', null)
    }
  }
  io.onStep = (fn) => { hook = fn }
  io.image = (dir) => {
    const files = new Map(names)
    for (const [b, r] of renamed) {
      files.set(r.from, r.file)
      if (r.before === undefined) files.delete(b)
      else files.set(b, r.before)
    }
    for (const [p, f] of files) fs.writeFileSync(path.join(dir, path.basename(p)), f.synced === null ? Buffer.alloc(0) : f.synced)
  }
  return io
}

// The newest change a file's text holds (every value carries its change number).
function newestIn (buf) {
  let n = 0
  if (buf === null) return 0
  for (const line of buf.toString('utf8').split('\n')) {
    try {
      const v = JSON.parse(line)
      if (Array.isArray(v) && v.length === 2) n = Math.max(n, v[1].n)
    } catch {}
  }
  return n
}

test('journal: a compaction writes and syncs the changes made while it runs into the new file before it takes the old one\'s place; a power cut at any step leaves a true map with nothing on disk lost', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const file = path.join(dir, 'index.ndjson')
  const io = powerIo()
  const j = new Journal(file, { minDead: 10, batchLines: 4, io }).load()
  // Every change numbered; the map after each one remembered.
  let n = 0
  const states = [new Map()]
  const set = (key) => {
    n++
    j.set(key, { n })
    states[n] = new Map(j.map)
  }
  for (let i = 0; i < 40; i++) set('k' + i)
  j.close() // synced
  const live = new Journal(file, { minDead: 10, batchLines: 4, io }).load()
  // The same changes go on through the journal opened again.
  const again = (key) => {
    n++
    live.set(key, { n })
    states[n] = new Map(live.map)
  }
  const gone = (key) => {
    n++
    live.delete(key)
    states[n] = new Map(live.map)
  }
  for (let i = 0; i < 40; i++) again('k' + (i % 20)) // dead lines: 40, live 40
  assert.equal(live.compactions, 0)
  const images = []
  let injected = 0
  io.onStep((what, name) => {
    if (what === 'write' && name === file + '.tmp' && injected === 0) {
      injected = 1
      // Changes while the walk runs: a key it already wrote, one it has not reached, a delete.
      setImmediate(() => {
        again('k0')
        again('k39')
        gone('k1')
        again('nuova')
      })
    }
    if (what === 'sync' && name === file + '.tmp' && injected === 1) {
      injected = 2
      again('k2') // while the new file is synced: in the next round or the last step
    }
    const img = tmpDir('mpfy-jpower-')
    io.image(img)
    images.push({ img, what })
  })
  again('k20') // one more dead line than live ones: the rewrite starts
  await live.settled()
  io.onStep(null)
  assert.equal(live.compactions, 1)
  assert.equal(injected, 2)
  again('dopo')
  const final = new Map(live.map)
  live.close()
  try {
    assert.ok(images.length > 8, images.length + ' steps')
    // Each image a true map, and never behind one an earlier power cut would have left.
    let floor = 40
    for (const { img, what } of images) {
      const got = new Journal(path.join(img, 'index.ndjson')).load()
      let match = -1
      for (let k = floor; k < states.length; k++) {
        if (states[k] !== undefined && JSON.stringify([...got.map]) === JSON.stringify([...states[k]])) match = k
      }
      assert.ok(match >= floor, 'after "' + what + '": a true map holding every change on disk (' + floor + '), got ' + newestIn(fs.readFileSync(path.join(img, 'index.ndjson'))))
      floor = match
    }
    assert.ok(floor > 80, 'the changes made during the rewrite reached the disk: ' + floor)
    assert.deepEqual([...new Journal(file).load().map], [...final])
    for (const k of ['k0', 'k39', 'nuova', 'k2']) assert.ok(final.has(k))
    assert.equal(final.has('k1'), false)
  } finally {
    for (const { img } of images) rmDir(img)
  }
})
