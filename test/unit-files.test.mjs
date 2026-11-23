// Files someone holds open, as Windows sees them. A file a Node stream reads (a
// listener) can be renamed away but not renamed over, and deleting it leaves its
// name taken until the stream closes; a file a program such as ffmpeg holds can
// be neither renamed nor deleted. So a track's file and its transcodes are moved
// aside before they go, a job reading a track stops before the track is deleted,
// a deleted track's file that cannot go yet is never taken back at a restart,
// and the failures of a replaced file do not block the new one. On Linux the same
// tests pass for the plain reason that open files never block anything there.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { Library } from '../server/library.mjs'
import { MediaJobs } from '../server/jobs.mjs'
import { HttpError } from '../server/errors.mjs'
import { tmpDir, cleanup, json, makeWav, noise, hash24, makeProfile, device, testWhoIs, waitFor, shardPath, treeFiles } from './helpers.mjs'

const WINDOWS = process.platform === 'win32'
const windowsOnly = WINDOWS ? false : 'a lock that keeps others from renaming or deleting a file exists on Windows only'
// libuv's UV_FS_O_EXLOCK (Windows): opened with no sharing, as ffmpeg's handle
// keeps others from renaming or deleting its input.
const EXCLUSIVE = WINDOWS ? 0x10000000 : 0

/** Open `file` the way a program like ffmpeg holds it on Windows, until release(). */
function holdOpen (file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | EXCLUSIVE)
  let open = true
  return {
    release () {
      if (open) fs.closeSync(fd)
      open = false
    }
  }
}

/** A listener: a stream of `file` paused after its first chunk, like a paused player. */
function listen (file) {
  const stream = fs.createReadStream(file, { highWaterMark: 1024 })
  const chunks = []
  const closed = new Promise((resolve) => stream.once('close', resolve))
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.once('data', (chunk) => {
      stream.pause()
      chunks.push(chunk)
      resolve({
        /** Read on to the end: everything the listener got. */
        async rest () {
          stream.on('data', (c) => chunks.push(c))
          stream.resume()
          await closed
          return Buffer.concat(chunks)
        }
      })
    })
  })
}

/**
 * ffmpeg as a test double in this process: a transcode holds its input the way
 * ffmpeg does (see holdOpen) while it runs, and writes `size` bytes of Ogg.
 * hold: it runs until release() or until it is stopped. slowStop: being stopped,
 * it still waits for release(). fail: a transcode fails. busy: how many are holding.
 */
function heldFfmpeg ({ hold = false, size = 1 << 20 } = {}) {
  const waiting = new Set()
  const ff = {
    hold,
    slowStop: false,
    fail: false,
    size,
    busy: 0,
    transcodes: 0,
    release () {
      for (const resolve of [...waiting]) resolve()
      waiting.clear()
    },
    async probe () {
      return { ok: true, opus: true }
    },
    commandLine (args) {
      return 'ffmpeg ' + args.join(' ')
    },
    close () {
      ff.release()
    },
    // The quality analysis: no answer here (inconclusive).
    async stream () {
      throw new Error('no decoder in this test')
    },
    async run (args, { signal = null } = {}) {
      if (!args.includes('libopus')) throw new Error('only transcodes in this test')
      ff.transcodes++
      if (ff.fail) throw new Error('encoder failed')
      const input = holdOpen(args[args.indexOf('-i') + 1])
      ff.busy++
      try {
        if (ff.hold) {
          await new Promise((resolve, reject) => {
            const stop = () => {
              if (!ff.slowStop) {
                waiting.delete(done)
                reject(new Error('stopped'))
              }
            }
            const done = () => {
              if (signal) signal.removeEventListener('abort', stop)
              if (signal && signal.aborted) reject(new Error('stopped'))
              else resolve()
            }
            waiting.add(done)
            if (signal) {
              if (signal.aborted) stop()
              else signal.addEventListener('abort', stop, { once: true })
            }
          })
        }
      } finally {
        ff.busy--
        input.release()
      }
      fs.writeFileSync(args[args.length - 1], Buffer.concat([Buffer.from('OggS'), Buffer.alloc(ff.size - 4, 7)]))
    }
  }
  return ff
}

async function newLibrary (t, { dir = null, goneRetryMs } = {}) {
  const c = cleanup(t)
  const dataDir = dir || c.dir(tmpDir('mpfy-files-'))
  const lib = new Library({ dataDir, debounceMs: 10, ...(goneRetryMs ? { goneRetryMs } : {}) })
  await lib.open()
  c.close(lib)
  return lib
}

/** A track whose file is `bytes` (its id is their hash). */
function addFile (lib, bytes, format = 'wav') {
  const id = hash24(bytes)
  const track = { id, format, title: 'Brano ' + id.slice(0, 4), size: bytes.length, fileHash: id, addedAt: Date.now(), uploaders: ['owner'] }
  const file = lib.places.internal.libraryPath(id + '.' + format)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return lib.addTrack(track)
}

/** `bytes` as an upload in tmp/, ready to replace a track's file. */
function upload (lib, bytes) {
  const file = path.join(lib.tmpDir, 'up-' + hash24(bytes).slice(0, 16) + '.part')
  fs.writeFileSync(file, bytes)
  return file
}

// What library.log holds (the last line of each key wins), in db.json's shape.
const dbOf = (lib) => {
  lib.flushNow()
  const tracks = new Map()
  let gone = []
  for (const line of fs.readFileSync(lib.logFile, 'utf8').split('\n')) {
    if (!line.startsWith('[')) continue
    const [, key, value] = JSON.parse(line)
    if (key.startsWith('t:')) {
      if (value === undefined) tracks.delete(key.slice(2))
      else tracks.set(key.slice(2), value)
    } else if (key === 'g') {
      gone = value
    }
  }
  return { tracks: [...tracks.values()], ...(gone.length > 0 ? { gone } : {}) }
}
const libraryFiles = (lib) => treeFiles(lib.dataDir, 'library')
const tmpFiles = (lib) => fs.readdirSync(lib.tmpDir).sort()
const wavOf = (freq) => makeWav({ seconds: 1, sampleRate: 44100, freq }) // 705.6 kbps: every level is made

async function newJobs (t, lib, ff, opts = {}) {
  const jobs = new MediaJobs({ library: lib, ffmpeg: ff, ...opts })
  lib.qualitiesOf = (track) => jobs.qualities(track)
  await jobs.start()
  cleanup(t).close(jobs)
  return jobs
}

// ------------------------------------------------------------ the original

test('replace: a file being streamed steps aside, the better one takes its name, the listener reads the old one to its end', async (t) => {
  const lib = await newLibrary(t)
  const old = noise('the old file', 1 << 20)
  const track = addFile(lib, old, 'mp3')
  const file = lib.trackPath(track)
  const listener = await listen(file)
  const better = noise('the better file', 1 << 20)
  const { track: now } = lib.replaceFile(track.id, upload(lib, better), { fileHash: hash24(better), size: better.length }, {})
  assert.equal(now.fileHash, hash24(better))
  assert.ok(fs.readFileSync(file).equals(better), 'the better file under the name of the track')
  assert.equal(dbOf(lib).tracks[0].fileHash, hash24(better), 'the log names it')
  assert.ok((await listener.rest()).equals(old), 'the listener got the old file to its end')
  assert.deepEqual(tmpFiles(lib), [], 'nothing left aside once the listener is gone')
  assert.deepEqual(libraryFiles(lib), [track.id + '.mp3'])
})

test('replace: a file a program holds stays where it is, and the caller is told to try again', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t)
  const old = noise('held', 4096)
  const track = addFile(lib, old, 'mp3')
  const better = noise('better', 4096)
  const tmp = upload(lib, better)
  const held = holdOpen(lib.trackPath(track))
  t.after(() => held.release())
  assert.throws(() => lib.replaceFile(track.id, tmp, { fileHash: hash24(better), size: better.length }, {}),
    (err) => err instanceof HttpError && err.status === 409)
  held.release()
  assert.equal(lib.getTrack(track.id).fileHash, track.fileHash, 'the track is as it was')
  assert.ok(fs.readFileSync(lib.trackPath(track)).equals(old))
  assert.deepEqual(tmpFiles(lib), [path.basename(tmp)], 'the upload is still the caller\'s')
  assert.equal(dbOf(lib).tracks[0].fileHash, track.fileHash)
})

test('replace: when the new file cannot take its place, the old one goes back under its name', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t)
  const old = noise('kept', 4096)
  const track = addFile(lib, old, 'mp3')
  const better = noise('locked upload', 4096)
  const tmp = upload(lib, better)
  const held = holdOpen(tmp)
  t.after(() => held.release())
  assert.throws(() => lib.replaceFile(track.id, tmp, { fileHash: hash24(better), size: better.length }, {}),
    (err) => err instanceof HttpError && err.status === 409)
  held.release()
  assert.ok(fs.readFileSync(lib.trackPath(track)).equals(old), 'the track still has its file')
  assert.equal(lib.getTrack(track.id).fileHash, track.fileHash)
  assert.deepEqual(tmpFiles(lib), [path.basename(tmp)], 'nothing else left in tmp/')
})

test('replace: clients see a new version of the library at once', async (t) => {
  const lib = await newLibrary(t)
  const track = addFile(lib, noise('listed before', 4096), 'mp3')
  const before = lib.version
  const better = makeWav({ seconds: 1, freq: 530 })
  lib.replaceFile(track.id, upload(lib, better), { format: 'wav', fileHash: hash24(better), size: better.length }, {})
  assert.ok(lib.version > before, 'the list names the new file, not the old one')
})

test('replace with another format: a held old file goes as soon as it can', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t, { goneRetryMs: 30 })
  const old = noise('old mp3', 4096)
  const track = addFile(lib, old, 'mp3')
  const better = makeWav({ seconds: 1, freq: 500 })
  const held = holdOpen(lib.trackPath(track))
  t.after(() => held.release())
  const { track: now } = lib.replaceFile(track.id, upload(lib, better), { format: 'wav', fileHash: hash24(better), size: better.length }, {})
  assert.equal(now.format, 'wav')
  assert.ok(fs.readFileSync(lib.trackPath(now)).equals(better))
  assert.deepEqual(libraryFiles(lib), [track.id + '.mp3', track.id + '.wav'], 'the held file is still there')
  assert.deepEqual(dbOf(lib).gone, [track.id + '.mp3'], 'the log says it must go')
  held.release()
  await waitFor(() => libraryFiles(lib).length === 1, { what: 'the old file gone' })
  assert.deepEqual(libraryFiles(lib), [track.id + '.wav'])
  await waitFor(() => dbOf(lib).gone === undefined, { what: 'the log without it' })
  assert.deepEqual(tmpFiles(lib), [])
})

test('replace with another format, then delete, then restart while the old file is still held: nothing comes back', { skip: windowsOnly }, async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-files-'))
  let lib = new Library({ dataDir: dir, debounceMs: 10 })
  await lib.open()
  const track = addFile(lib, noise('old mp3, held', 4096), 'mp3')
  const better = makeWav({ seconds: 1, freq: 520 })
  const held = holdOpen(lib.trackPath(track))
  t.after(() => held.release())
  lib.replaceFile(track.id, upload(lib, better), { format: 'wav', fileHash: hash24(better), size: better.length }, {})
  lib.deleteTrack(track.id)
  assert.deepEqual(libraryFiles(lib), [track.id + '.mp3'])
  lib.close()
  lib = new Library({ dataDir: dir, debounceMs: 10 })
  assert.equal((await lib.open()).adopted, 0)
  assert.equal(lib.getTrack(track.id), null, 'the old file of a deleted track is not adopted')
  lib.close()
  held.release()
  lib = c.close(new Library({ dataDir: dir, debounceMs: 10 }))
  await lib.open()
  assert.equal(lib.getTrack(track.id), null)
  assert.deepEqual(libraryFiles(lib), [])
})

test('delete: a file being streamed leaves its name at once', async (t) => {
  const lib = await newLibrary(t)
  const bytes = noise('streamed', 1 << 20)
  const track = addFile(lib, bytes, 'mp3')
  const listener = await listen(lib.trackPath(track))
  lib.deleteTrack(track.id)
  assert.deepEqual(libraryFiles(lib), [], 'library/ no longer lists it while the listener reads')
  assert.ok((await listener.rest()).equals(bytes), 'the listener got it to its end')
  assert.deepEqual(tmpFiles(lib), [])
  assert.equal(dbOf(lib).gone, undefined)
})

test('delete: a file a program holds goes as soon as it can, and no restart takes it back meanwhile', { skip: windowsOnly }, async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-files-'))
  let lib = new Library({ dataDir: dir, debounceMs: 10 })
  await lib.open()
  const bytes = makeWav({ seconds: 1, freq: 640 })
  const track = addFile(lib, bytes)
  const name = track.id + '.wav'
  const held = holdOpen(lib.trackPath(track))
  t.after(() => held.release())
  lib.deleteTrack(track.id)
  assert.equal(lib.getTrack(track.id), null)
  assert.deepEqual(libraryFiles(lib), [name], 'held: still there')
  assert.deepEqual(dbOf(lib).gone, [name], 'the log says so at once')
  lib.close()

  // A restart while it is still held: not adopted, still to go.
  lib = new Library({ dataDir: dir, debounceMs: 10 })
  const opened = await lib.open()
  assert.equal(opened.adopted, 0)
  assert.equal(lib.getTrack(track.id), null)
  assert.deepEqual(dbOf(lib).gone, [name])
  lib.close()

  held.release()
  lib = c.close(new Library({ dataDir: dir, debounceMs: 10 }))
  assert.equal((await lib.open()).adopted, 0)
  assert.equal(lib.getTrack(track.id), null)
  assert.deepEqual(libraryFiles(lib), [], 'gone at the start after it was let go')
  assert.equal(dbOf(lib).gone, undefined)
})

test('delete: while the server runs, a held file goes once it is let go', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t, { goneRetryMs: 30 })
  const bytes = noise('held while running', 4096)
  const track = addFile(lib, bytes, 'mp3')
  const held = holdOpen(lib.trackPath(track))
  t.after(() => held.release())
  lib.deleteTrack(track.id)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(libraryFiles(lib), [track.id + '.mp3'], 'still held')
  held.release()
  await waitFor(() => libraryFiles(lib).length === 0, { what: 'the file gone' })
  await waitFor(() => dbOf(lib).gone === undefined, { what: 'the log without it' })
})

test('delete then the same bytes again: the new track keeps its file', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t, { goneRetryMs: 30 })
  const bytes = noise('again', 4096)
  const track = addFile(lib, bytes, 'mp3')
  const held = holdOpen(lib.trackPath(track))
  lib.deleteTrack(track.id)
  held.release()
  // Uploaded again before the retry: the same name is a track's file again.
  const again = addFile(lib, bytes, 'mp3')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(libraryFiles(lib), [again.id + '.mp3'])
  assert.ok(lib.getTrack(again.id))
  assert.equal(dbOf(lib).gone, undefined)
  lib.close()
  const reopened = await newLibrary(t, { dir: lib.dataDir })
  assert.ok(reopened.getTrack(again.id), 'still there after a restart')
})

test('delete: a track whose file a program holds leaves the list at once, with a new version', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t)
  const track = addFile(lib, noise('held, listed', 4096), 'mp3')
  const held = holdOpen(lib.trackPath(track))
  t.after(() => held.release())
  const before = lib.version
  lib.deleteTrack(track.id)
  assert.deepEqual(libraryFiles(lib), [track.id + '.mp3'], 'held: still there')
  assert.ok(lib.version > before, 'clients see a new version')
  held.release()
})

test('a restart after a replacement cut between its renames: the file db.json names goes back', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-files-'))
  let lib = new Library({ dataDir: dir, debounceMs: 10 })
  await lib.open()
  const a = makeWav({ seconds: 1, freq: 300 })
  const b = makeWav({ seconds: 1, freq: 310 })
  const kept = addFile(lib, a)
  const deleted = addFile(lib, b)
  lib.deleteTrack(deleted.id)
  lib.close()
  // As a replacement leaves them: each file moved aside, named after the file it was.
  const aside = (track, rnd) => path.join(dir, 'tmp', 'was-' + track.fileHash + '-' + rnd + '-' + track.id + '.wav')
  fs.renameSync(shardPath(dir, 'library', kept.id + '.wav'), aside(kept, '0a0b0c0d'))
  fs.writeFileSync(aside(deleted, '01020304'), b) // a track deleted since: never back
  fs.writeFileSync(path.join(dir, 'tmp', 'was-' + 'f'.repeat(24) + '-0a0b0c0d-' + kept.id + '.wav'), b) // another file of it: not this one

  lib = c.close(new Library({ dataDir: dir, debounceMs: 10 }))
  const opened = await lib.open()
  assert.equal(opened.dropped, 0)
  assert.equal(opened.adopted, 0)
  assert.ok(lib.getTrack(kept.id), 'the track is still there')
  assert.ok(fs.readFileSync(lib.trackPath(kept)).equals(a), 'with its own file')
  assert.equal(lib.getTrack(deleted.id), null)
  assert.deepEqual(libraryFiles(lib), [kept.id + '.wav'])
  assert.deepEqual(tmpFiles(lib), [])
})

// ------------------------------------------------------------- transcodes

test('transcodes: a failure of the old file does not block the levels of the new one', async (t) => {
  const lib = await newLibrary(t)
  const ff = heldFfmpeg({ size: 8192 })
  const jobs = await newJobs(t, lib, ff)
  ff.fail = true
  const track = addFile(lib, wavOf(220))
  jobs.onUpload(track)
  await jobs.idle()
  assert.equal(jobs.stats.failed, 3, 'high, normal, low failed')
  ff.fail = false
  const better = wavOf(230)
  const { track: now } = lib.replaceFile(track.id, upload(lib, better), { fileHash: hash24(better), size: better.length }, {})
  jobs.onFileReplaced(now)
  await jobs.idle()
  assert.deepEqual(jobs.qualities(lib.getTrack(track.id)), { low: true, normal: true, high: true }, 'made at once')
})

test('transcodes: one being streamed when its file is replaced steps aside, and the new one takes its name at once', async (t) => {
  const lib = await newLibrary(t)
  const ff = heldFfmpeg()
  const jobs = await newJobs(t, lib, ff)
  const track = addFile(lib, wavOf(240))
  jobs.onUpload(track)
  await jobs.idle()
  const normal = jobs.transcodePath(track.id, 'normal')
  const before = fs.readFileSync(normal)
  const listener = await listen(normal)
  const better = wavOf(250)
  const { track: now } = lib.replaceFile(track.id, upload(lib, better), { fileHash: hash24(better), size: better.length }, {})
  jobs.onFileReplaced(now)
  await jobs.idle()
  assert.equal(jobs.stats.failed, 0)
  assert.deepEqual(jobs.qualities(lib.getTrack(track.id)), { low: true, normal: true, high: true })
  assert.deepEqual([...jobs._failedAt.keys()], [])
  assert.ok((await listener.rest()).equals(before), 'the listener read the old one to its end')
  assert.deepEqual(tmpFiles(lib), [])
})

test('transcodes: a name a program still holds at the end of a transcode is not a failure; it is made again later', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t)
  const ff = heldFfmpeg({ size: 8192 })
  const jobs = await newJobs(t, lib, ff, { busyRetryMs: 400 })
  const track = addFile(lib, wavOf(260))
  jobs.onUpload(track)
  await jobs.idle()
  const held = holdOpen(jobs.transcodePath(track.id, 'normal'))
  t.after(() => held.release())
  const better = wavOf(270)
  const { track: now } = lib.replaceFile(track.id, upload(lib, better), { fileHash: hash24(better), size: better.length }, {})
  jobs.onFileReplaced(now)
  await jobs.idle()
  assert.equal(jobs.stats.failed, 0, 'not a failure')
  assert.deepEqual([...jobs._failedAt.keys()], [], 'not blocked')
  assert.deepEqual(jobs.qualities(lib.getTrack(track.id)), { low: true, normal: false, high: true })
  held.release()
  await waitFor(() => jobs.qualities(lib.getTrack(track.id)).normal, { what: 'normal made again' })
  await jobs.idle()
  assert.equal(jobs.stats.failed, 0)
  assert.match(fs.readFileSync(jobs.transcodePath(track.id, 'normal'), 'latin1').slice(0, 4), /^OggS$/)
})

test('transcodes: a name held for good is, after a few tries, a failure like any other', { skip: windowsOnly }, async (t) => {
  const lib = await newLibrary(t)
  const ff = heldFfmpeg({ size: 8192 })
  const jobs = await newJobs(t, lib, ff, { busyRetryMs: 10 })
  const track = addFile(lib, wavOf(265))
  jobs.onUpload(track)
  await jobs.idle()
  const held = holdOpen(jobs.transcodePath(track.id, 'low'))
  t.after(() => held.release())
  const before = ff.transcodes
  const better = wavOf(275)
  const { track: now } = lib.replaceFile(track.id, upload(lib, better), { fileHash: hash24(better), size: better.length }, {})
  jobs.onFileReplaced(now)
  await waitFor(() => jobs.stats.failed === 1, { what: 'the failure', timeout: 20000 })
  await jobs.idle()
  assert.deepEqual([...jobs._failedAt.keys()], ['t:' + track.id + '.low'])
  assert.equal(ff.transcodes - before, 6, 'high and normal once, low the first time and three times again')
})

test('transcodes: one evicted while streamed leaves its name at once and is made again while the listener still reads', async (t) => {
  const lib = await newLibrary(t)
  const ff = heldFfmpeg()
  const jobs = await newJobs(t, lib, ff)
  const a = addFile(lib, wavOf(280))
  jobs.onUpload(a)
  await jobs.idle()
  const high = jobs.transcodePath(a.id, 'high') // the least recently used: made first
  const listener = await listen(high)
  jobs.capBytes = 3.5 * (1 << 20)
  const b = addFile(lib, wavOf(290))
  jobs.requestTranscode(b, 'low')
  await jobs.idle()
  assert.equal(jobs.qualities(lib.getTrack(a.id)).high, false, 'evicted')
  jobs.requestTranscode(lib.getTrack(a.id), 'high')
  await jobs.idle()
  assert.equal(jobs.qualities(lib.getTrack(a.id)).high, true, 'made again while the listener reads the evicted one')
  assert.equal(jobs.stats.failed, 0)
  await listener.rest()
  assert.deepEqual(tmpFiles(lib), [])
})

// ---------------------------------------------------------- the whole app

async function startApp (t, { dir = null, ff } = {}) {
  const c = cleanup(t)
  const dataDir = dir || c.dir(tmpDir('mpfy-files-'))
  const app = await createMPfy({ dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: ff, fpcalc: null, sevenZip: null, whoIs: testWhoIs })
  await app.jobsStarted
  return { app, dir: dataDir }
}

async function people (app) {
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(json(await owner.call('GET', '/api/profile')).role, 'owner')
  return { owner, sara: device(app, { profile: makeProfile(), name: 'Sara' }), luca: device(app, { profile: makeProfile(), name: 'Luca' }) }
}

test('delete: the job reading the file stops first, and the deleted track never comes back at the next start', async (t) => {
  const ff = heldFfmpeg({ hold: true })
  const { app, dir } = await startApp(t, { ff })
  let id
  try {
    const { owner } = await people(app)
    id = json(await owner.call('PUT', '/api/upload/a.wav', { body: wavOf(300) })).track.id
    await waitFor(() => ff.busy > 0, { what: 'a transcode reading the file' })
    const del = await owner.call('DELETE', '/api/tracks/' + id)
    assert.equal(del.status, 200, del.body.toString())
    assert.deepEqual(json(del), { ok: true, deleted: true })
    assert.deepEqual(treeFiles(dir, 'library'), [], 'gone at once')
  } finally {
    ff.release()
    await app.jobs.idle()
    await app.close()
  }

  const again = (await startApp(t, { dir, ff: heldFfmpeg() })).app
  try {
    assert.equal(again.library.getTrack(id), null, 'not back')
    assert.deepEqual(treeFiles(dir, 'library'), [])
  } finally {
    await again.close()
  }
})

test('delete by its last uploader: someone who makes it theirs while its job stops keeps it, and the job runs again', async (t) => {
  const ff = heldFfmpeg({ hold: true })
  const { app } = await startApp(t, { ff })
  cleanup(t).close(app)
  const { sara, luca } = await people(app)
  const wav = wavOf(310)
  const id = json(await sara.call('PUT', '/api/upload/a.wav', { body: wav })).track.id
  await waitFor(() => ff.busy > 0, { what: 'a transcode reading the file' })
  ff.slowStop = true
  const del = sara.call('DELETE', '/api/tracks/' + id)
  await waitFor(() => app.jobs._running !== null && app.jobs._running.stop.signal.aborted, { what: 'the job asked to stop' })
  assert.equal(json(await luca.call('PUT', '/api/upload/b.wav', { body: wav })).outcome, 'duplicate')
  ff.hold = false
  ff.release()
  assert.deepEqual(json(await del), { ok: true, deleted: false })
  assert.deepEqual(app.library.getTrack(id).uploaders, [luca.profile.id])
  await app.jobs.idle()
  assert.deepEqual(app.jobs.qualities(app.library.getTrack(id)), { low: true, normal: true, high: true }, 'the stopped level too')
})

test('delete: a track whose file a program still holds is no longer in /api/library', { skip: windowsOnly }, async (t) => {
  // No ffmpeg: no transcode is ever ready, so nothing else moves the version.
  const { app } = await startApp(t, { ff: null })
  cleanup(t).close(app)
  const { owner } = await people(app)
  const id = json(await owner.call('PUT', '/api/upload/a.wav', { body: wavOf(320) })).track.id
  const listed = await owner.call('GET', '/api/library')
  assert.deepEqual(json(listed).tracks.map((x) => x.id), [id])
  const held = holdOpen(app.library.trackPath(app.library.getTrack(id)))
  try {
    assert.deepEqual(json(await owner.call('DELETE', '/api/tracks/' + id)), { ok: true, deleted: true })
    const after = await owner.call('GET', '/api/library', { headers: { 'if-none-match': listed.headers.etag } })
    assert.equal(after.status, 200, 'a new version, not 304')
    assert.deepEqual(json(after).tracks, [])
  } finally {
    held.release()
  }
})
