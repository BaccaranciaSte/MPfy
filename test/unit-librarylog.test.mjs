// The shared library in library.log: one line per change (a batch shares one
// version and one write), checked appends cut back on a short write or a full
// disk, epochs that make a version known only where this log wrote it, the
// change index behind changesSince(), compactions that keep each key's own
// version and lose nothing synced before a power cut, the start (derived codes
// moved while stopped, the adoption written in its order before serving), the
// migration from db.json, and the compact stored form (signatures in an arena,
// strings and arrays shared, the fingerprint index in typed arrays).

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Library, normalizeTrack } from '../server/library.mjs'
import { Fingerprints } from '../server/fingerprint.mjs'
import { MediaJobs, PRIORITY } from '../server/jobs.mjs'
import { FfmpegRunner } from '../server/ffmpeg.mjs'
import { Archives } from '../server/archives.mjs'
import { HttpError } from '../server/errors.mjs'
import { DEFAULT_IO } from '../server/vjournal.mjs'
import { createMPfy } from '../server/app.mjs'
import { tmpDir, rmDir, cleanup, makeWav, fakeFfmpeg, hash24, testWhoIs, request, json, shardPath } from './helpers.mjs'

// The heap check runs in a child process with --expose-gc (this file, run alone).
if (process.env.MPFY_LIBRARY_HEAP_PROBE) {
  await heapProbe(process.env.MPFY_LIBRARY_HEAP_PROBE !== 'tracks')
  process.exit(0)
}

// --------------------------------------------------------------- helpers

function rng (seed) {
  let s = seed
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x80000000
  }
}

function idOf (rnd) {
  let s = ''
  while (s.length < 24) s += Math.floor(rnd() * 16).toString(16)
  return s
}

// A stored track as db.json holds it (its file is a placeholder of its size).
function fakeTrack (id, extra = {}) {
  return {
    id,
    title: 'Brano ' + id.slice(0, 6),
    artist: 'Riva Nord',
    album: 'Acque basse',
    albumArtist: 'Riva Nord',
    trackNo: 1,
    discNo: 1,
    year: 2020,
    duration: 200 + parseInt(id.slice(0, 2), 16),
    format: 'mp3',
    mime: 'audio/mpeg',
    size: 16,
    bitrate: 320000,
    addedAt: 1700000000000,
    coverId: null,
    fileHash: id,
    uploaders: ['owner'],
    ...extra
  }
}

function signature (rnd, d = 201) {
  const b = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) b[i] = Math.floor(rnd() * 256)
  return { d, b: 32, s: b.toString('base64') }
}

function putFile (dir, t) {
  const file = shardPath(dir, 'library', t.id + '.' + t.format)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(t.size))
  return t
}

function readLog (file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function cvOf (lib, id) {
  return lib._cv[lib.slotOf(id)]
}

// What the library holds, to compare memory with a replay.
function stateOf (lib) {
  const tracks = []
  for (const t of lib.tracks.values()) {
    const s = lib.slotOf(t.id)
    tracks.push([JSON.stringify(t), lib._cv[s], lib._code[s]])
  }
  return {
    tracks,
    covers: lib.coversSnapshot(),
    gone: [...lib._gone],
    version: lib.version,
    epoch: lib.epoch,
    epochs: JSON.stringify(lib._epochs),
    horizon: lib._horizon
  }
}

// The derived state a library reads (a fake transcoder and lyrics).
function derived () {
  const ready = new Set()
  const lyrics = new Map()
  return {
    ready,
    lyrics,
    wire (lib) {
      lib.qualitiesOf = (t) => ({ low: ready.has(t.id), normal: false, high: false })
      lib.lyricsOf = (id) => lyrics.get(id) || null
      return lib
    }
  }
}

async function openLib (dir, d = null, opts = {}) {
  const lib = new Library({ dataDir: dir, freezeTracks: true, holdStart: d !== null, ...opts })
  if (d !== null) d.wire(lib)
  await lib.open()
  if (d !== null) await lib.finishStart()
  return lib
}

// The state a fresh start on a copy of this data dir replays (nothing written there).
async function replayed (lib, d = null) {
  const copy = tmpDir('mpfy-replay-')
  try {
    fs.copyFileSync(lib.logFile, path.join(copy, 'library.log'))
    for (const sub of ['library', 'covers']) fs.cpSync(path.join(lib.dataDir, sub), path.join(copy, sub), { recursive: true })
    const again = new Library({ dataDir: copy, holdStart: true })
    if (d !== null) d.wire(again)
    await again.open()
    const state = stateOf(again)
    again.close()
    return state
  } finally {
    rmDir(copy)
  }
}

// A file system that remembers what reached the disk, file by file (a file keeps
// its identity through a rename): an fsync or fdatasync keeps the bytes the file
// had when it was asked, a rename lasts once its folder is synced, and image()
// writes the files a power cut would leave at this moment.
function powerIo () {
  const names = new Map() // path -> file { synced: Buffer|null }
  const renamed = new Map() // target -> { from, file, before } until its folder is synced
  const fds = new Map() // fd -> file
  let hook = null
  const step = (what, file) => { if (hook !== null) hook(what, file) }
  const nameOf = (file) => {
    for (const [p, f] of names) if (f === file) return p
    return null
  }
  const snap = (fd) => fs.readFileSync(nameOf(fds.get(fd)))
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
      step('write', nameOf(fds.get(fd)))
      return n
    },
    fsyncSync (fd) {
      const data = snap(fd)
      fs.fsyncSync(fd)
      fds.get(fd).synced = data
      step('sync', nameOf(fds.get(fd)))
    },
    fdatasyncSync (fd) {
      io.fsyncSync(fd)
    },
    fsync (fd, cb) {
      const file = fds.get(fd)
      const data = snap(fd)
      fs.fsync(fd, (err) => {
        // What a later sync already put on disk stays there (these files only grow).
        if (!err && (file.synced === null || data.length >= file.synced.length)) file.synced = data
        step('sync', nameOf(file))
        cb(err)
      })
    },
    fdatasync (fd, cb) {
      io.fsync(fd, cb)
    },
    renameSync (a, b) {
      a = path.resolve(a)
      b = path.resolve(b)
      fs.renameSync(a, b)
      const file = names.get(a) || { synced: null }
      renamed.set(b, { from: a, file, before: names.get(b) })
      names.set(b, file)
      names.delete(a)
      step('rename', b)
    },
    fsyncDirSync (dir) {
      for (const b of [...renamed.keys()]) if (path.dirname(b) === path.resolve(dir)) renamed.delete(b)
      step('dirsync', dir)
    }
  }
  io.onStep = (fn) => { hook = fn }
  /** The files a power cut leaves now, written into `dir` by name. */
  io.image = (dir) => {
    const files = new Map()
    for (const [p, f] of names) files.set(p, f)
    for (const [b, r] of renamed) {
      files.set(r.from, r.file)
      if (r.before === undefined) files.delete(b)
      else files.set(b, r.before)
    }
    for (const [p, f] of files) fs.writeFileSync(path.join(dir, path.basename(p)), f.synced === null ? Buffer.alloc(0) : f.synced)
  }
  return io
}

// --------------------------------------------- the compact form, at scale

// Run before this file's top level is done (the heap probe): a function, not a const.
function bigCount () {
  return 100000
}
const BIG = bigCount()

function bigTrack (i, rnd, full) {
  const id = idOf(rnd)
  const lossless = i % 5 === 0
  const artist = 'Artista ' + (i % 8000)
  const duration = Math.round((120 + i * (300 / bigCount())) * 10) / 10
  const t = {
    id,
    title: 'Brano ' + i + ' ' + id.slice(0, 5),
    artist,
    album: 'Album ' + (i % 25000),
    albumArtist: artist,
    trackNo: 1 + (i % 14),
    discNo: 1,
    year: 1960 + (i % 64),
    duration,
    format: lossless ? 'flac' : 'mp3',
    mime: lossless ? 'audio/flac' : 'audio/mpeg',
    size: 3000000 + i,
    bitrate: lossless ? 900000 : 320000,
    lossless,
    addedAt: 1700000000000 + i * 1000,
    coverId: i % 12 === 0 ? idOf(rnd) : null,
    fileHash: id,
    codec: lossless ? 'flac' : 'mp3',
    sampleRate: 44100,
    bitDepth: lossless ? 16 : null,
    fakeLossless: lossless ? false : null,
    equivKbps: null,
    cutoffHz: lossless ? null : 19500,
    qualityV: 2,
    uploaders: ['0123456789abcdef0123456789abcdef'],
    notSame: [],
    fpState: 'none',
    tagless: [],
    edited: []
  }
  if (full) {
    Object.assign(t, { fp: signature(rnd, Math.round(duration * 10) / 10), fpState: 'ok' })
    t.lookup = { v: 1, state: 'applied', at: 1700000000000, tries: 1, fileHash: id, acoustid: crypto.randomUUID(), recording: crypto.randomUUID(), release: crypto.randomUUID(), filled: ['year'] }
  }
  return t
}

// The heap of 100,000 stored tracks (each with its signature and lookup) and their
// indexes, measured from before the library holds them to after, both after GC.
async function heapProbe (withIndex) {
  const dir = tmpDir('mpfy-heap-')
  const gc = () => { for (let i = 0; i < 4; i++) global.gc() }
  const lib = new Library({ dataDir: dir, debounceMs: 1e9 })
  await lib.open()
  const fps = new Fingerprints({ dataDir: dir, command: null, library: lib })
  const rnd = rng(11)
  gc()
  const before = process.memoryUsage()
  for (let i = 0; i < bigCount(); i++) {
    const t = lib.addTrack(bigTrack(i, rnd, true))
    if (withIndex) fps.indexAdd(t.id, t.fileHash, t.fp.d)
  }
  gc()
  const after = process.memoryUsage()
  console.log(JSON.stringify({ heapMB: (after.heapUsed - before.heapUsed) / 1048576, externalMB: (after.external - before.external) / 1048576, tracks: lib.tracks.size, indexed: fps.size }))
  lib.close()
  rmDir(dir)
}

// One library of BIG tracks for the two tests that change one track among them.
let big = null
function bigLibrary () {
  if (big === null) {
    big = (async () => {
      const dir = tmpDir('mpfy-big-')
      const lib = new Library({ dataDir: dir, debounceMs: 50 })
      await lib.open()
      const rnd = rng(5)
      let first = null
      for (let i = 0; i < BIG; i++) {
        const t = lib.addTrack(bigTrack(i, rnd, false))
        if (i === BIG / 2) first = t
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { dir, lib, middle: first }
    })()
  }
  return big
}

const statOf = (file) => {
  try {
    const st = fs.statSync(file)
    return [st.size, st.mtimeMs]
  } catch {
    return null
  }
}

test('at 100,000 tracks, an edit of one track appends one line and does not rewrite db.json', async () => {
  const { dir, lib, middle } = await bigLibrary()
  const logFile = path.join(dir, 'library.log')
  const dbBefore = statOf(path.join(dir, 'db.json'))
  const sizeBefore = statOf(logFile)
  assert.ok(sizeBefore !== null, 'the library is kept in library.log')
  const v = lib.version
  lib.updateTrack(middle.id, { title: 'Un titolo nuovo' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const added = fs.statSync(logFile).size - sizeBefore[0]
  const fd = fs.openSync(logFile, 'r')
  const tail = Buffer.alloc(added)
  fs.readSync(fd, tail, 0, added, sizeBefore[0])
  fs.closeSync(fd)
  const lines = tail.toString('utf8').split('\n')
  assert.equal(lines.length, 2, 'one whole line')
  const line = JSON.parse(lines[0])
  assert.deepEqual([line[0], line[1], line[2].title], [v + 1, 't:' + middle.id, 'Un titolo nuovo'])
  assert.equal(lib.version, v + 1)
  assert.deepEqual(statOf(path.join(dir, 'db.json')), dbBefore, 'db.json not written')
})

test('at 100,000 tracks, a transcode that becomes ready writes one d: line and moves the version by one', async (t) => {
  const { dir, lib, middle } = await bigLibrary()
  const work = cleanup(t).dir(tmpDir('mpfy-ff-'))
  const ff = fakeFfmpeg(work)
  // Its file: a real one, so the fake ffmpeg has an input.
  const wav = makeWav({ seconds: 1, sampleRate: 44100, freq: 300 })
  fs.mkdirSync(path.dirname(lib.trackPath(middle)), { recursive: true })
  fs.writeFileSync(lib.trackPath(middle), wav)
  const jobs = new MediaJobs({ library: lib, ffmpeg: new FfmpegRunner({ command: ff.command }), backgroundDelayMs: 1e9 })
  lib.qualitiesOf = (track) => jobs.qualities(track)
  await jobs.start()
  const logFile = path.join(dir, 'library.log')
  const size = fs.statSync(logFile).size
  const v = lib.version
  jobs.requestTranscode(lib.getTrack(middle.id), 'low', PRIORITY.DEMAND)
  await jobs.idle()
  jobs.close()
  assert.deepEqual(jobs.qualities(lib.getTrack(middle.id)), { low: true, normal: false, high: false })
  assert.equal(lib.version, v + 1, 'the version moved by one')
  const tail = fs.readFileSync(logFile).subarray(size).toString('utf8')
  assert.deepEqual(tail.split('\n').filter(Boolean).map((l) => JSON.parse(l)), [[v + 1, 'd:' + middle.id, 1]], 'one d: line, the low level ready')
  lib.close()
  rmDir(dir)
})

test('100,000 compact tracks and their indexes hold under 95 MB of heap', () => {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    env: { ...process.env, MPFY_LIBRARY_HEAP_PROBE: '1' },
    encoding: 'utf8',
    timeout: 300000
  })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(out.tracks, BIG)
  assert.equal(out.indexed, BIG, 'every track in the fingerprint index')
  assert.ok(out.heapMB < 95, 'heap: ' + out.heapMB.toFixed(1) + ' MB (outside it: ' + out.externalMB.toFixed(1) + ' MB)')
})

// --------------------------------------------------------- the log, lines

test('the log: a new source is a header and an epoch; a batch is one write and one version; the replay gives the same library', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const before = Date.now()
  let lib = await openLib(dir)
  const E = lib.version
  assert.ok(E >= before)
  assert.match(lib.epoch, /^[0-9a-f]{16}$/)
  assert.notEqual(lib.epoch, '0000000000000000')
  const rnd = rng(3)
  const a = putFile(dir, fakeTrack(idOf(rnd)))
  const b = putFile(dir, fakeTrack(idOf(rnd)))
  lib.addTrack(a)
  assert.equal(lib.version, E + 1)
  const w = lib.writes
  lib.batch(() => {
    lib.addTrack(b)
    lib.updateTrack(a.id, { title: 'Nuovo' })
    lib.updateTrack(a.id, { artist: 'Altro' })
  })
  assert.equal(lib.writes, w + 1, 'one write')
  assert.equal(lib.version, E + 2, 'one version')
  const lines = readLog(lib.logFile)
  assert.deepEqual(lines[0], { mpfy: 'library-log', schema: 1 })
  assert.deepEqual(lines[1], { e: lib.epoch, v: E })
  assert.deepEqual(lines.slice(2).map((l) => [l[0], l[1]]), [[E + 1, 't:' + a.id], [E + 2, 't:' + a.id], [E + 2, 't:' + b.id]], 'a key changed twice in a batch is one line; the lines in the order of the library')
  assert.equal(lines[4][2].title, 'Brano ' + b.id.slice(0, 6))
  assert.deepEqual([lines[3][2].title, lines[3][2].artist], ['Nuovo', 'Altro'])
  const state = stateOf(lib)
  lib.close()
  lib = await openLib(dir)
  assert.deepEqual(stateOf(lib), state, 'the replay is the library')
  assert.deepEqual([...lib.tracks.keys()], [a.id, b.id])
  assert.equal(lib.version, E + 2, 'a start that changes nothing keeps the version and the epoch')
  // The first change of a run opens its epoch, above every version before it.
  lib.updateTrack(b.id, { title: 'Di nuovo' })
  const tail = readLog(lib.logFile).slice(-2)
  assert.equal(tail[0].v >= E + 3, true)
  assert.match(tail[0].e, /^[0-9a-f]{16}$/)
  assert.deepEqual([tail[1][0], tail[1][1]], [tail[0].v + 1, 't:' + b.id])
  assert.equal(lib.version, tail[0].v + 1)
  lib.close()
})

test('the log: a refused batch changes nothing; a short write and a full disk cut the file back (500, 507) and the next change appends whole; a cut that fails refuses every later change', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let mode = null
  const io = {
    ...DEFAULT_IO,
    writeSync (fd, buf, off, len, pos) {
      if (mode === 'short' || mode === 'broken') return fs.writeSync(fd, buf, off, Math.floor(len / 2), pos)
      if (mode === 'full') {
        const err = new Error('no space left on device')
        err.code = 'ENOSPC'
        throw err
      }
      return fs.writeSync(fd, buf, off, len, pos)
    },
    ftruncateSync (fd, size) {
      if (mode === 'broken') throw Object.assign(new Error('cannot'), { code: 'EIO' })
      return fs.ftruncateSync(fd, size)
    }
  }
  let lib = await openLib(dir, null, { io })
  const rnd = rng(9)
  const a = putFile(dir, fakeTrack(idOf(rnd)))
  lib.addTrack(a)
  const size = fs.statSync(lib.logFile).size
  const v = lib.version
  const state = stateOf(lib)

  mode = 'short'
  assert.throws(() => lib.updateTrack(a.id, { title: 'Mai' }), (err) => err instanceof HttpError && err.status === 500)
  assert.equal(fs.statSync(lib.logFile).size, size, 'cut back')
  assert.deepEqual(stateOf(lib), state, 'nothing applied, the version kept')
  mode = 'full'
  assert.throws(() => lib.setCustomCover('album', '0123456789abcdef', 'small', 'ab'.repeat(12)), (err) => err instanceof HttpError && err.status === 507 && err.code === 'disk_full')
  assert.throws(() => lib.addTrack(fakeTrack(idOf(rnd))), (err) => err.status === 507)
  assert.throws(() => lib.deleteTrack(a.id), (err) => err.status === 507)
  assert.ok(fs.existsSync(lib.trackPath(a)), 'a refused delete leaves the file')
  assert.deepEqual(stateOf(lib), state)
  assert.deepEqual(lib.coversSnapshot().album, {})
  mode = null
  lib.updateTrack(a.id, { title: 'Dopo' })
  assert.equal(lib.version, v + 1)
  const after = stateOf(lib)
  assert.deepEqual(await replayed(lib), after, 'the next change appended whole')

  // A cut that fails: the log refuses every change until a restart.
  mode = 'broken'
  assert.throws(() => lib.updateTrack(a.id, { title: 'Rotto' }), (err) => err.status === 500)
  mode = null
  assert.throws(() => lib.updateTrack(a.id, { title: 'Ancora' }), (err) => err.status === 500)
  assert.deepEqual(stateOf(lib), after)
  lib.close()
  lib = await openLib(dir)
  assert.deepEqual(stateOf(lib), after, 'the half line dropped at the restart')
  lib.updateTrack(a.id, { title: 'Riparte' })
  lib.close()
})

test('the log: a batch too big to undo stays in memory when the disk refuses it, under a version no restart knows, and is written with the next change under a new epoch', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let full = false
  const io = {
    ...DEFAULT_IO,
    writeSync (fd, ...rest) {
      if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      return fs.writeSync(fd, ...rest)
    }
  }
  let lib = await openLib(dir, null, { io })
  const rnd = rng(21)
  const ids = []
  lib.batch(() => {
    for (let i = 0; i < 1500; i++) ids.push(lib.addTrack(putFile(dir, fakeTrack(idOf(rnd)))).id)
  })
  const e0 = lib.epoch
  const v0 = lib.version
  full = true
  lib.replaceUploader('owner', 'a'.repeat(32)) // 1,500 tracks: kept
  assert.equal(lib.getTrack(ids[0]).uploaders[0], 'a'.repeat(32))
  assert.equal(lib.version, v0 + 1, 'shown under a version of its own')
  const shown = { epoch: lib.epoch, version: lib.version }
  full = false
  lib.updateTrack(ids[1], { title: 'Scritto' })
  assert.notEqual(lib.epoch, e0, 'a new epoch')
  assert.ok(lib.version > shown.version)
  const c = lib.changesSince(shown.epoch, shown.version)
  assert.deepEqual(c.changed.length, 1500, 'the kept changes are written again with the next one')
  const state = stateOf(lib)
  lib.close()
  lib = await openLib(dir)
  assert.equal(lib.changesSince(shown.epoch, shown.version), null, 'a version the disk never had is known by no restart')
  assert.deepEqual(stateOf(lib).tracks, state.tracks)
  assert.equal(lib.getTrack(ids[0]).uploaders[0], 'a'.repeat(32))
  assert.ok(lib.changesSince(e0, v0) !== null, 'the versions written stay known')
  lib.close()
})

test('the log: a crash cut at every byte of the last line gives the library as it was before that change', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  const rnd = rng(4)
  const a = putFile(dir, fakeTrack(idOf(rnd), { title: 'x' }))
  lib.addTrack(a)
  lib.setCustomCover('album', '0123456789abcdef', 'small', 'ab'.repeat(12))
  fs.writeFileSync(path.join(dir, 'covers', 'ab'.repeat(12) + '.jpg'), 'jpg')
  lib.updateTrack(a.id, { title: 'prima' })
  const before = stateOf(lib)
  const at = fs.statSync(lib.logFile).size
  lib.updateTrack(a.id, { title: 'dopo' })
  const whole = fs.readFileSync(lib.logFile)
  lib.close()
  for (let cut = at; cut < whole.length; cut++) {
    const copy = tmpDir('mpfy-cut-')
    try {
      fs.mkdirSync(path.join(copy, 'library'))
      fs.mkdirSync(path.join(copy, 'covers'))
      fs.copyFileSync(lib.trackPath(a), path.join(copy, 'library', path.basename(lib.trackPath(a))))
      fs.copyFileSync(path.join(dir, 'covers', 'ab'.repeat(12) + '.jpg'), path.join(copy, 'covers', 'ab'.repeat(12) + '.jpg'))
      fs.writeFileSync(path.join(copy, 'library.log'), whole.subarray(0, cut))
      const again = new Library({ dataDir: copy })
      await again.open()
      assert.deepEqual(stateOf(again), before, 'cut at byte ' + (cut - at))
      assert.equal(fs.statSync(path.join(copy, 'library.log')).size, at, 'cut back to the last whole line')
      again.close()
    } finally {
      rmDir(copy)
    }
  }
})

test('the log: a line that does not parse or breaks the sequence of versions ends what is trusted; the rest is kept aside and nothing is thrown', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let lib = await openLib(dir)
  const rnd = rng(5)
  const a = putFile(dir, fakeTrack(idOf(rnd)))
  lib.addTrack(a)
  lib.updateTrack(a.id, { title: 'uno' })
  const state = stateOf(lib)
  lib.updateTrack(a.id, { title: 'due' })
  lib.updateTrack(a.id, { title: 'tre' })
  lib.close()
  const lines = fs.readFileSync(lib.logFile, 'utf8').split('\n')
  // The line of "due" broken; with a version two ahead; with a key nobody knows.
  for (const bad of ['{"garbage', lines[4].replace(/^\[(\d+)/, (m, v) => '[' + (Number(v) + 2)), lines[4].replace('"t:', '"q:')]) {
    const copy = lines.slice()
    copy[4] = bad
    fs.writeFileSync(lib.logFile, copy.join('\n'))
    for (const name of fs.readdirSync(dir)) if (name.includes('.cut-')) fs.unlinkSync(path.join(dir, name))
    lib = await openLib(dir)
    assert.deepEqual(stateOf(lib), state, bad.slice(0, 20))
    const cut = fs.readdirSync(dir).filter((n) => n.startsWith('library.log.cut-'))
    assert.equal(cut.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, cut[0]), 'utf8'), copy.slice(4).join('\n'), 'the rest kept aside')
    lib.close()
  }
})

test('the log: a .tmp left by a cut rewrite is deleted at the start, the library intact', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let lib = await openLib(dir)
  const a = putFile(dir, fakeTrack(idOf(rng(6))))
  lib.addTrack(a)
  const state = stateOf(lib)
  lib.close()
  fs.writeFileSync(lib.logFile + '.tmp', '{"mpfy":"library-log","schema":1}\n{"ep":[[')
  lib = await openLib(dir)
  assert.ok(!fs.existsSync(lib.logFile + '.tmp'))
  assert.deepEqual(stateOf(lib), state)
  lib.close()
})

// ------------------------------------------------ versions, epochs, deltas

test('changesSince: changed in the library order, removed, an id made again in both, covers, unknown epochs and versions', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  const first = lib.version
  const rnd = rng(7)
  const [a, b, c] = [0, 1, 2].map(() => putFile(dir, fakeTrack(idOf(rnd))))
  lib.addTrack(a)
  lib.addTrack(b)
  lib.addTrack(c)
  const e = lib.epoch
  const v = lib.version
  assert.deepEqual(lib.changesSince(e, v), { version: v, epoch: e, changed: [], removed: [], covers: { track: [], album: [] } })
  lib.updateTrack(c.id, { title: 'C' })
  lib.updateTrack(a.id, { title: 'A' })
  lib.deleteTrack(b.id)
  lib.setCustomCover('track', a.id, 'large', 'cd'.repeat(12))
  lib.setCustomCover('album', '0123456789abcdef', 'small', 'cd'.repeat(12))
  lib.clearCustomCover('album', '0123456789abcdef')
  let d = lib.changesSince(e, v)
  assert.deepEqual(d.changed, [a.id, c.id], 'in the library order, not the order of the changes')
  assert.deepEqual(d.removed, [b.id])
  assert.deepEqual(d.covers, { track: [a.id], album: ['0123456789abcdef'] })
  // b uploaded again (the same bytes, the same id): removed, then changed at the end.
  lib.addTrack(putFile(dir, fakeTrack(b.id)))
  d = lib.changesSince(e, v)
  assert.deepEqual(d.changed, [a.id, c.id, b.id])
  assert.deepEqual(d.removed, [b.id])
  assert.deepEqual([...lib.tracks.keys()], [a.id, c.id, b.id])
  const now = lib.version
  assert.deepEqual(lib.changesSince(e, now).changed, [])
  assert.equal(lib.changesSince(e, now + 1), null, 'a version not written yet')
  assert.equal(lib.changesSince('0123456789abcdef', v), null, 'another epoch')
  assert.equal(lib.changesSince('0000000000000000', 0), null, 'the zero epoch')
  assert.equal(lib.changesSince(e, first - 1), null, 'below the first version of its epoch')
  assert.deepEqual(lib.changesSince(e, first).changed, [a.id, c.id, b.id], 'its first version is known')
  assert.equal(lib.changesSince(e, String(v)), null)
  assert.equal(lib.changesSince('ABCDEF0123456789', v), null)
  lib.close()
})

test('changesSince: a version older than the ring is answered by one scan, the same answer', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  const rnd = rng(8)
  const ids = []
  lib.batch(() => {
    for (let i = 0; i < 400; i++) ids.push(lib.addTrack(fakeTrack(idOf(rnd))).id)
  })
  const e = lib.epoch
  const v = lib.version
  lib.updateTrack(ids[10], { title: 'dieci' })
  const v1 = lib.version
  lib.updateTrack(ids[5], { title: 'cinque' })
  const fromRing = lib.changesSince(e, v)
  assert.deepEqual(fromRing.changed, [ids[5], ids[10]])
  // 65,536 more changes push v and v1 out of the ring.
  for (let round = 0; round < 165; round++) {
    lib.batch(() => {
      for (let i = 0; i < 400; i++) if (i !== 5 && i !== 10) lib.updateTrack(ids[i], { title: 'r' + round })
    })
  }
  assert.ok(lib._ringFloor > v1, 'out of the ring')
  const scanned = lib.changesSince(e, v1)
  assert.deepEqual(scanned.changed, ids.filter((id) => id !== ids[10]), 'every track changed after it, in the library order')
  const last = lib.version
  lib.updateTrack(ids[7], { title: 'ultimo' })
  assert.deepEqual(lib.changesSince(e, last).changed, [ids[7]], 'a recent version from the ring')
  lib.close()
})

test('epochs: a tail lost by a power cut makes its versions unknown, even when the next epoch takes the same numbers again', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const realNow = Date.now
  t.after(() => { Date.now = realNow })
  const clock = 1767225600000
  Date.now = () => clock
  let lib = await openLib(dir)
  const rnd = rng(10)
  const a = putFile(dir, fakeTrack(idOf(rnd)))
  lib.addTrack(a)
  lib.updateTrack(a.id, { title: 'sul disco' })
  const e1 = lib.epoch
  const kept = lib.version
  lib.flush()
  const synced = fs.statSync(lib.logFile).size
  lib.updateTrack(a.id, { title: 'perso 1' })
  lib.updateTrack(a.id, { title: 'perso 2' })
  const lost = lib.version
  lib.close()
  // The power cut: what was not synced is gone.
  fs.truncateSync(lib.logFile, synced)
  lib = await openLib(dir)
  assert.equal(lib.version, kept)
  lib.updateTrack(a.id, { title: 'nuovo' })
  assert.equal(lib.version, lost, 'the same number again (the clock stood still)')
  assert.notEqual(lib.epoch, e1)
  assert.equal(lib.changesSince(e1, lost), null, 'a version that was lost is not known')
  assert.equal(lib.changesSince(e1, kept + 1), null)
  assert.deepEqual(lib.changesSince(e1, kept).changed, [a.id], 'the version on disk is')
  assert.deepEqual(lib.changesSince(lib.epoch, lost).changed, [])
  lib.close()
})

test('sourceChanged: an owner change is a reset (z), a name or a switch is not (s); bump() without an id is a reset; no bump() is left but the one http.mjs answers with', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  lib.addTrack(fakeTrack(idOf(rng(11))))
  let e = lib.epoch
  let v = lib.version
  lib.sourceChanged({ ownerMoved: false })
  assert.equal(lib.version, v + 1)
  assert.deepEqual(readLog(lib.logFile).pop(), [v + 1, 's'])
  assert.deepEqual(lib.changesSince(e, v).changed, [], 'a delta crosses it')
  v = lib.version
  lib.sourceChanged({ ownerMoved: true })
  assert.deepEqual(readLog(lib.logFile).pop(), [v + 1, 'z'])
  assert.equal(lib.changesSince(e, v), null, 'no delta crosses a reset')
  assert.ok(lib.changesSince(e, v + 1) !== null)
  e = lib.epoch
  v = lib.version
  lib.bump()
  assert.deepEqual(readLog(lib.logFile).pop(), [v + 1, 'z'])
  assert.equal(lib.changesSince(e, v), null)
  lib.close()
  // Every other change site names what changed.
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server')
  const left = []
  for (const name of fs.readdirSync(server)) {
    if (!name.endsWith('.mjs')) continue
    const text = fs.readFileSync(path.join(server, name), 'utf8')
    for (const m of text.matchAll(/\.(bump|touch)\(\)/g)) left.push(name + ': ' + text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index)).trim())
  }
  const allowed = ['http.mjs: if (stamp !== sourceSeen) library.bump()']
  for (const l of left) assert.ok(allowed.includes(l), 'a change with no id: ' + l)
})

// ------------------------------------------------------------ compaction

test('compaction: each key keeps its own version, the horizon moves only past the tombstones dropped, and the replay is the library', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let lib = await openLib(dir)
  const rnd = rng(12)
  const keep = []
  for (let i = 0; i < 5; i++) keep.push(lib.addTrack(putFile(dir, fakeTrack(idOf(rnd)))).id)
  const e = lib.epoch
  const mid = lib.version
  lib.updateTrack(keep[2], { title: 'dopo' })
  // 10,005 tracks made and deleted in two batches: the oldest 5 tombstones drop out.
  const gone = []
  lib.batch(() => {
    for (let i = 0; i < 10005; i++) gone.push(lib.addTrack(fakeTrack(idOf(rnd))).id)
  })
  lib.batch(() => {
    for (const id of gone.slice(0, 5)) lib.deleteTrack(id)
  })
  const firstDeletes = lib.version
  lib.batch(() => {
    for (const id of gone.slice(5)) lib.deleteTrack(id)
  })
  assert.equal(lib._horizon, firstDeletes, 'past the tombstones dropped')
  assert.equal(lib.changesSince(e, mid), null, 'below the horizon')
  const d = lib.changesSince(e, firstDeletes)
  assert.equal(d.removed.length, 10000)
  const versions = keep.map((id) => cvOf(lib, id))
  const state = stateOf(lib)
  const size = fs.statSync(lib.logFile).size
  await lib.compact()
  assert.equal(lib.compactions, 1)
  assert.ok(fs.statSync(lib.logFile).size < size / 4, 'smaller')
  assert.deepEqual(keep.map((id) => cvOf(lib, id)), versions)
  assert.deepEqual(stateOf(lib), state)
  lib.close()
  lib = await openLib(dir)
  assert.deepEqual(stateOf(lib), state, 'the replay of the compacted log is the library')
  assert.deepEqual(keep.map((id) => cvOf(lib, id)), versions, 'each key with its own version')
  assert.equal(lib._horizon, firstDeletes, 'the same horizon')
  assert.deepEqual(lib.changesSince(e, firstDeletes).removed.length, 10000, 'the tombstones kept')
  assert.equal(lib.changesSince(e, firstDeletes).changed.length, 0)
  lib.updateTrack(keep[0], { title: 'dopo la compattazione' })
  assert.deepEqual(lib.changesSince(e, firstDeletes).changed, [keep[0]])
  lib.close()
})

test('compaction: changes made while it runs are in the new file; a power cut at any step, during and right after it, loses nothing that was on disk', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const io = powerIo()
  const lib = await openLib(dir, null, { io, syncEveryMs: 0 })
  const rnd = rng(13)
  const ids = []
  // About 350 KB of tracks, so the rewrite takes more than one slice.
  lib.batch(() => {
    for (let i = 0; i < 250; i++) ids.push(lib.addTrack(putFile(dir, fakeTrack(idOf(rnd), { title: 'x'.repeat(1200) }))).id)
  })
  const states = new Map()
  const remember = () => states.set(lib.version, stateOf(lib))
  remember()
  lib.flush()
  const synced = lib.version
  const images = []
  let injected = false
  io.onStep((what, file) => {
    if (what === 'write' && file === lib.logFile + '.tmp' && !injected) {
      injected = true
      // A change to a track the rewrite already wrote, synced at once.
      setImmediate(() => {
        lib.updateTrack(ids[0], { title: 'durante' })
        remember()
        lib.flush()
        lib.updateTrack(ids[249], { title: 'durante 2' })
        remember()
      })
    }
    const img = tmpDir('mpfy-power-')
    io.image(img)
    images.push({ img, what })
  })
  await lib.compact()
  io.onStep(null)
  lib.updateTrack(ids[1], { title: 'dopo' })
  remember()
  assert.equal(lib.compactions, 1)
  assert.ok(injected)
  const final = stateOf(lib)
  lib.close()
  try {
    assert.ok(images.length > 5, images.length + ' steps')
    // Each image a true state, and never behind one an earlier power cut would have left.
    let floor = synced
    for (const { img, what } of images) {
      fs.mkdirSync(path.join(img, 'library'))
      for (const id of ids) putFile(img, fakeTrack(id, { title: 'x'.repeat(1200) }))
      const again = new Library({ dataDir: img, holdStart: true })
      await again.open()
      const s = stateOf(again)
      again.close()
      assert.ok(s.version >= floor, 'after "' + what + '": version ' + s.version + ', on disk before it ' + floor)
      assert.deepEqual(s.tracks, states.get(s.version).tracks, 'after "' + what + '": a true state of the library')
      floor = s.version
    }
    assert.ok(floor >= synced + 1, 'the change synced during the rewrite is in the new file')
    assert.deepEqual(stateOf(await openLib(dir)).tracks, final.tracks)
  } finally {
    for (const { img } of images) rmDir(img)
  }
})

// ------------------------------------------------------------- the start

test('the start: a transcode deleted while the source was stopped is in changesSince(epoch, the version before the stop)', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir())
  const work = c.dir(tmpDir('mpfy-ff-'))
  const ff = fakeFfmpeg(work)
  const start = async () => c.close(await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, ffmpeg: ff.command, fpcalc: null, sevenZip: null, whoIs: testWhoIs, backgroundDelayMs: 1e9 }))
  let app = await start()
  const wav = makeWav({ seconds: 2, sampleRate: 44100, freq: 333 })
  const id = json(await request(app.ports.http, 'PUT', '/api/upload/a.wav', { body: wav })).track.id
  await app.jobs.idle()
  assert.deepEqual(app.library.publicTrack(app.library.getTrack(id)).qualities, { low: true, normal: true, high: true })
  const e = app.library.epoch
  const v = app.library.version
  await app.close()
  fs.unlinkSync(shardPath(dir, 'transcodes', id + '.normal.opus'))
  app = await start()
  const d = app.library.changesSince(e, v)
  assert.ok(d !== null, 'a restart is not a reason for a full answer')
  assert.deepEqual(d.changed, [id])
  assert.deepEqual(app.library.publicTrack(app.library.getTrack(id)).qualities, { low: true, normal: false, high: true })
  const line = readLog(app.library.logFile).filter(Array.isArray).pop()
  assert.deepEqual(line, [app.library.version, 'd:' + id, 5])
})

test('the start: adopted files reorder the library, and the log is written in that order before anything is served', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let lib = await openLib(dir)
  const rnd = rng(14)
  const a = putFile(dir, fakeTrack(idOf(rnd), { addedAt: 1000 }))
  const b = putFile(dir, fakeTrack(idOf(rnd), { addedAt: 3000 }))
  lib.addTrack(a)
  lib.addTrack(b)
  const e = lib.epoch
  const v = lib.version
  lib.close()
  // A file the log does not know (a crash right after its upload), dated between them.
  const wav = makeWav({ freq: 777 })
  const x = hash24(wav)
  fs.writeFileSync(path.join(dir, 'library', x + '.wav'), wav)
  fs.utimesSync(path.join(dir, 'library', x + '.wav'), new Date(2000), new Date(2000))
  lib = await openLib(dir)
  const served = [...lib.tracks.keys()]
  assert.deepEqual(served, [a.id, x, b.id])
  assert.equal(lib.changesSince(e, v), null, 'no delta crosses the new order')
  lib.close()
  lib = await openLib(dir)
  assert.deepEqual([...lib.tracks.keys()], served, 'the same order after a restart')
  assert.equal(lib.compactions, 0)
  lib.close()
})

test('the start: db.json is read once into the log (one epoch nobody holds) and left as it is; a db.json an older MPfy wrote after it is read again, the log kept aside', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const rnd = rng(15)
  const a = putFile(dir, fakeTrack(idOf(rnd), { fp: signature(rnd), fpState: 'ok', notSame: ['f0'.repeat(12)] }))
  const b = putFile(dir, fakeTrack(idOf(rnd), { title: 'Secondo' }))
  fs.mkdirSync(path.join(dir, 'covers'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'covers', 'cd'.repeat(12) + '.jpg'), 'jpg')
  const db = { schema: 3, version: 42, extra: { keep: 1 }, tracks: [a, b], covers: { track: { [a.id]: { small: 'cd'.repeat(12), large: null } }, album: {} } }
  const dbText = JSON.stringify(db)
  fs.writeFileSync(path.join(dir, 'db.json'), dbText)
  const before = Date.now()
  let lib = await openLib(dir)
  assert.ok(lib.version >= Math.max(43, before))
  assert.deepEqual(lib.publicTracks(), [a, b].map((t) => lib.publicTrack(normalizeTrack(t))), 'the tracks as db.json holds them')
  assert.equal(lib.getTrack(a.id).fp.s, a.fp.s, 'the signature read back from the arena')
  assert.deepEqual(lib.coversSnapshot().track, db.covers.track)
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), dbText, 'db.json untouched')
  const lines = readLog(lib.logFile)
  const st = fs.statSync(path.join(dir, 'db.json'))
  const hash = crypto.createHash('sha256').update(dbText).digest('hex')
  assert.deepEqual(lines[0], { mpfy: 'library-log', schema: 1, from: { size: st.size, mtimeMs: st.mtimeMs, hash } })
  assert.deepEqual(lines[1], { ep: [[lib.epoch, lib.version, lib.version]] })
  assert.deepEqual(lines.slice(2, 4), [{ h: 0 }, { S: lib.version }])
  assert.ok(lines.slice(4, -1).every((l) => l[0] === lib.version), 'every line stamped with the epoch')
  assert.deepEqual(lines.at(-1), { E: lib.version })
  const e1 = lib.epoch
  const v1 = lib.version
  lib.updateTrack(b.id, { title: 'Cambiato' })
  const state = stateOf(lib)
  lib.close()
  lib = await openLib(dir)
  assert.deepEqual(stateOf(lib), state, 'the log is the truth from now on')
  assert.ok(lib.changesSince(e1, v1) !== null)
  lib.close()
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.replaced-')).length, 0)
  // An older MPfy ran and wrote db.json: it is newer than the log.
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ ...db, tracks: [{ ...a, title: 'Scritto dalla vecchia' }, b] }))
  lib = await openLib(dir)
  assert.equal(lib.getTrack(a.id).title, 'Scritto dalla vecchia')
  assert.equal(lib.getTrack(b.id).title, 'Secondo', 'what only the log had is in the kept log')
  const aside = fs.readdirSync(dir).filter((n) => n.startsWith('library.log.replaced-'))
  assert.equal(aside.length, 1, 'the log kept aside, never deleted')
  assert.ok(fs.readFileSync(path.join(dir, aside[0]), 'utf8').includes('Cambiato'))
  assert.equal(lib.changesSince(e1, v1), null, 'the old epoch is unknown')
  lib.close()
})

test('export: db.json as an older MPfy reads it, then the log knows it and a start reads no db.json again', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let lib = await openLib(dir)
  const rnd = rng(16)
  const a = putFile(dir, fakeTrack(idOf(rnd), { fp: signature(rnd), fpState: 'ok' }))
  lib.addTrack(a)
  lib.setCustomCover('album', '0123456789abcdef', 'small', 'cd'.repeat(12))
  fs.writeFileSync(path.join(dir, 'covers', 'cd'.repeat(12) + '.jpg'), 'jpg')
  await lib.exportCompat()
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'))
  assert.deepEqual(Object.keys(db), ['schema', 'version', 'tracks', 'covers'])
  assert.equal(db.schema, 3)
  assert.equal(db.version, lib.version)
  assert.deepEqual(db.tracks, [JSON.parse(JSON.stringify(lib.getTrack(a.id)))])
  assert.equal(db.tracks[0].fp.s, a.fp.s)
  assert.deepEqual(db.covers, { track: {}, album: { '0123456789abcdef': { small: 'cd'.repeat(12), large: null } } })
  const st = fs.statSync(path.join(dir, 'db.json'))
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'db.json'))).digest('hex')
  assert.deepEqual(readLog(lib.logFile).pop(), { xp: { size: st.size, mtimeMs: st.mtimeMs, hash } })
  const state = stateOf(lib)
  lib.close()
  lib = await openLib(dir)
  assert.deepEqual(stateOf(lib), state)
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.replaced-')).length, 0)
  lib.close()
})

// ----------------------------------------------------- random histories

test('replay equals memory after random histories: batches, compactions while changes come, ids made again, covers, derived codes, restarts and an adoption', async (t) => {
  for (let round = 0; round < 6; round++) {
    const dir = tmpDir('mpfy-hist-')
    try {
      const rnd = rng(100 + round)
      const d = derived()
      let lib = await openLib(dir, d)
      const live = new Set()
      const dead = []
      const cover = (n) => {
        const id = (n % 7).toString(16).repeat(24)
        fs.writeFileSync(path.join(dir, 'covers', id + '.jpg'), 'jpg')
        return id
      }
      const pick = () => [...live][Math.floor(rnd() * live.size)]
      const op = () => {
        const r = rnd()
        if (r < 0.2 || live.size < 3) {
          const t = lib.addTrack(putFile(dir, fakeTrack(idOf(rnd), rnd() < 0.5 ? { fp: signature(rnd), fpState: 'ok' } : {})))
          live.add(t.id)
        } else if (r < 0.35) {
          const id = pick()
          lib.updateTrack(id, { title: 'T' + Math.floor(rnd() * 1000) })
        } else if (r < 0.45) {
          const t = lib.getTrack(pick())
          lib.setTrack({ ...t, fp: rnd() < 0.7 ? signature(rnd, t.duration) : null, fpState: 'ok' })
        } else if (r < 0.55) {
          const id = pick()
          lib.deleteTrack(id)
          live.delete(id)
          dead.push(id)
        } else if (r < 0.62 && dead.length > 0) {
          const id = dead.splice(Math.floor(rnd() * dead.length), 1)[0]
          lib.addTrack(putFile(dir, fakeTrack(id, { title: 'di nuovo' })))
          live.add(id)
        } else if (r < 0.7) {
          const id = pick()
          if (rnd() < 0.7) lib.setCustomCover('track', id, rnd() < 0.5 ? 'small' : 'large', cover(Math.floor(rnd() * 100)))
          else lib.clearCustomCover('track', id)
        } else if (r < 0.8) {
          const id = pick()
          if (d.ready.has(id)) d.ready.delete(id)
          else d.ready.add(id)
          if (rnd() < 0.5) d.lyrics.set(id, rnd() < 0.5 ? 'synced' : 'plain')
          lib.derivedChanged([id])
        } else if (r < 0.85) {
          lib.addUploader(pick(), 'b'.repeat(32))
        } else if (r < 0.9) {
          lib.markNotSame(pick(), pick())
        } else {
          lib.sourceChanged({ ownerMoved: rnd() < 0.3 })
        }
      }
      for (let step = 0; step < 160; step++) {
        const r = rnd()
        if (r < 0.15) {
          lib.batch(() => {
            for (let i = 0; i < 2 + Math.floor(rnd() * 6); i++) op()
          })
        } else if (r < 0.2) {
          // A rewrite with changes coming while it runs.
          const running = lib.compact()
          for (let i = 0; i < 5; i++) op()
          await new Promise((resolve) => setImmediate(resolve))
          op()
          await running
        } else if (r < 0.24) {
          const state = stateOf(lib)
          lib.close()
          if (rnd() < 0.5) {
            // A file the log does not know: adopted at the start, by its date.
            const wav = makeWav({ freq: 100 + round * 1000 + step })
            fs.writeFileSync(path.join(dir, 'library', hash24(wav) + '.wav'), wav)
            fs.utimesSync(path.join(dir, 'library', hash24(wav) + '.wav'), new Date(100000 - step * 10), new Date(100000 - step * 10))
            live.add(hash24(wav))
            lib = await openLib(dir, d)
            assert.equal([...lib.tracks.keys()][0], hash24(wav), 'the adopted file first, by its date')
          } else {
            lib = await openLib(dir, d)
            assert.deepEqual(stateOf(lib), state, 'round ' + round + ', step ' + step + ': a restart')
          }
        } else {
          op()
        }
        if (step % 20 === 19) assert.deepEqual(await replayed(lib, d), stateOf(lib), 'round ' + round + ', step ' + step)
      }
      assert.deepEqual(await replayed(lib, d), stateOf(lib), 'round ' + round + ', at the end')
      lib.close()
    } finally {
      rmDir(dir)
    }
  }
})

// --------------------------------------------- the stored form, frozen

test('the stored tracks are frozen in tests: every library method and the archive cover build new objects', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  assert.equal(lib.freezeTracks, true)
  const rnd = rng(17)
  const a = lib.addTrack(putFile(dir, fakeTrack(idOf(rnd), { tagless: ['cover', 'year'], fp: signature(rnd), fpState: 'ok' })))
  const b = lib.addTrack(putFile(dir, fakeTrack(idOf(rnd))))
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.uploaders) && Object.isFrozen(a.fp))
  assert.throws(() => { a.title = 'x' }, TypeError)
  lib.updateTrack(a.id, { title: 'Nuovo', artist: 'Altro' })
  lib.addUploader(a.id, 'c'.repeat(32))
  lib.removeUploader(a.id, 'c'.repeat(32))
  lib.markNotSame(a.id, b.id)
  lib.replaceUploader('owner', 'd'.repeat(32))
  lib.dropUploaderEverywhere('d'.repeat(32))
  lib.fillEmpty(b.id, { title: 'Pieno', artist: 'Riva', album: 'Acque', albumArtist: 'Riva', year: 1999, tagless: [] })
  lib.setTrack({ ...lib.getTrack(a.id), fpState: 'failed', fp: null })
  // The archive's cover, as archives.mjs gives it.
  const coverId = 'ef'.repeat(12)
  fs.writeFileSync(path.join(dir, 'covers', coverId + '.jpg'), 'jpg')
  const sizes = []
  const archives = new Archives({ dataDir: dir, library: lib, disk: null, sevenZip: null, pipeline: () => null, jobs: { requestCoverSizes: (id) => sizes.push(id) } })
  const size = fs.statSync(lib.logFile).size
  const v = lib.version
  archives._applyCover({ id: '0011223344556677', coverId, trackIds: [a.id, b.id] })
  assert.equal(lib.getTrack(a.id).coverId, coverId)
  assert.deepEqual(lib.getTrack(a.id).tagless, ['year'], 'the cover is no longer missing')
  assert.equal(lib.getTrack(b.id).coverId, coverId)
  assert.deepEqual(sizes, [coverId])
  assert.equal(lib.version, v + 1, 'one batch')
  const lines = fs.readFileSync(lib.logFile).subarray(size).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => [l[0], l[1], l[2].coverId]), [[v + 1, 't:' + a.id, coverId], [v + 1, 't:' + b.id, coverId]])
  assert.deepEqual(await replayed(lib), stateOf(lib))
  lib.deleteTrack(b.id)
  lib.close()
})

test('the signature lives in an arena by slot: a copy kept across a delete loses it, the answers give it back as base64', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  const rnd = rng(18)
  const sig = signature(rnd)
  const a = lib.addTrack(putFile(dir, fakeTrack(idOf(rnd), { fp: sig, fpState: 'ok' })))
  assert.equal(a.fp.s, sig.s)
  assert.deepEqual(Object.keys(a.fp), ['d', 'b'], 'the bytes are not on the object')
  assert.deepEqual(lib.publicTrack(a).fp, sig)
  assert.equal(JSON.stringify(lib.publicTrack(a)).includes(sig.s), true)
  const copy = { ...lib.getTrack(a.id) }
  lib.deleteTrack(a.id)
  // Another track takes the slot and its own signature.
  const other = signature(rnd)
  const b = lib.addTrack(putFile(dir, fakeTrack(idOf(rnd), { fp: other, fpState: 'ok' })))
  assert.equal(lib.slotOf(b.id), 0)
  assert.equal(b.fp.s, other.s)
  const back = lib.addTrack({ ...copy })
  assert.equal(back.fp, null, 'the copy whose track left the library loses its signature')
  assert.equal(back.fpState, 'none', 'made again')
  assert.equal(lib.getTrack(b.id).fp.s, other.s)
  // Strings and small arrays are shared.
  const c = lib.addTrack(putFile(dir, fakeTrack(idOf(rnd))))
  assert.equal(c.uploaders, lib.getTrack(b.id).uploaders)
  assert.equal(c.notSame, lib.getTrack(b.id).notSame)
  lib.close()
})

// ------------------------------------------------------- the full answer

test('writeTracks: every track as the caller sees it, in slices, waiting for a slow reader', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  const rnd = rng(19)
  lib.batch(() => {
    for (let i = 0; i < 1100; i++) lib.addTrack(fakeTrack(idOf(rnd), { uploaders: [i % 2 ? 'owner' : 'e'.repeat(32)], fp: signature(rnd), fpState: 'ok' }))
  })
  const chunks = []
  let waited = 0
  const out = new Writable({
    highWaterMark: 16 * 1024,
    write (chunk, enc, cb) {
      chunks.push(chunk)
      waited++
      setTimeout(cb, 2)
    }
  })
  const viewer = new Set(['owner'])
  const n = await lib.writeTracks(out, viewer)
  assert.equal(n, 1100)
  assert.ok(chunks.length >= 5, chunks.length + ' slices')
  assert.ok(waited > 0)
  const text = Buffer.concat(chunks).toString('utf8')
  assert.equal(text, JSON.stringify(lib.publicTracks(viewer)))
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(lib.writeTracks(new Writable({ write (c, e, cb) { cb() } }), viewer, { signal: aborted.signal }), { name: 'AbortError' })
  lib.close()
})

// ---------------------------------------------------- the fingerprint index

test('the fingerprint index: durations and slots in typed arrays, candidates as before, an entry going with its track', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const lib = await openLib(dir)
  const fps = new Fingerprints({ dataDir: dir, command: null, library: lib })
  lib.onSlotFree = (slot) => fps.dropSlot(slot)
  const rnd = rng(20)
  const durs = [200, 201.5, 199, 201.5, 210, 195.25, 203]
  const ids = durs.map((d) => lib.addTrack(fakeTrack(idOf(rnd), { duration: d })).id)
  durs.forEach((d, i) => fps.indexAdd(ids[i], ids[i], d))
  assert.equal(fps.size, 7)
  assert.deepEqual(fps.candidates(200, 3).map((c) => [c.trackId, c.duration]), [
    [ids[2], 199], [ids[0], 200], [ids[1], 201.5], [ids[3], 201.5], [ids[6], 203]
  ], 'by duration; equal durations in the order they came')
  assert.deepEqual(fps.candidates(200, 3)[0], { trackId: ids[2], fileHash: ids[2], duration: 199 })
  fps.indexAdd(ids[1], ids[1], 196)
  assert.deepEqual(fps.candidates(200, 4).map((c) => c.trackId), [ids[1], ids[2], ids[0], ids[3], ids[6]], 'added again: moved')
  lib.deleteTrack(ids[2])
  assert.equal(fps.size, 6, 'its slot freed: its entry gone')
  fps.indexRemove(ids[2])
  assert.equal(fps.size, 6)
  fps.indexRemove(ids[0])
  assert.deepEqual(fps.candidates(200, 4).map((c) => c.trackId), [ids[1], ids[3], ids[6]])
  // A track taking the freed slot is not the gone one.
  const freed = 2
  const n = lib.addTrack(fakeTrack(idOf(rnd), { duration: 199 }))
  assert.equal(lib.slotOf(n.id), freed)
  assert.deepEqual(fps.candidates(200, 4).map((c) => c.trackId), [ids[1], ids[3], ids[6]])
  fps.indexAdd(n.id, n.id, 199)
  assert.deepEqual(fps.candidates(200, 4).map((c) => c.trackId), [ids[1], n.id, ids[3], ids[6]])
  lib.close()
})
