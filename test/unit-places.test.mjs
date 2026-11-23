// The places of a source's track files: 256 shards on each place, today's flat
// folders moved into them at start (crash-safe at every rename), listings that
// never block the event loop in proportion to the library, and export-compat
// putting the files back flat for an older build.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createMPfy } from '../server/app.mjs'
import { Library } from '../server/library.mjs'
import { MediaJobs } from '../server/jobs.mjs'
import { Places, PLACE_IO } from '../server/places.mjs'
import { exportCompat } from '../server/index.mjs'
import { LIBRARY_FILE_RE } from '../server/ids.mjs'
import { tmpDir, cleanup, request, json, makeWav, fakeFfmpeg, shardPath, treeFiles } from './helpers.mjs'

const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)
const hiWav = (freq) => makeWav({ seconds: 1, sampleRate: 44100, freq })
const SHARD = /^[0-9a-f]{2}$/

async function startApp (t, dataDir) {
  const c = cleanup(t)
  const fake = fakeFfmpeg(c.dir(tmpDir('mpfy-ff-')))
  const app = await createMPfy({ dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: fake.command, cardsDir: null })
  await app.jobsStarted
  return { app, fake }
}

async function upload (app, name, body) {
  const r = await request(app.ports.http, 'PUT', '/api/upload/' + encodeURIComponent(name), { body })
  assert.equal(r.status, 200, r.body.toString())
  return json(r).track
}

// Every file of the shards moved back to the top of its folder: the layout of before.
function flatten (dir) {
  for (const tree of ['library', 'transcodes']) {
    const top = path.join(dir, tree)
    for (const ab of fs.readdirSync(top).filter((n) => SHARD.test(n))) {
      for (const name of fs.readdirSync(path.join(top, ab))) fs.renameSync(path.join(top, ab, name), path.join(top, name))
      fs.rmdirSync(path.join(top, ab))
    }
  }
}

function logLines (dir) {
  return fs.readFileSync(path.join(dir, 'library.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(Array.isArray)
}

test('shards: an uploaded track is library/<first two hex>/<id>.<ext>, its transcodes transcodes/<ab>/<id>.<level>.opus', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const { app } = await startApp(t, dir)
  try {
    const wav = hiWav(500)
    const track = await upload(app, 'a.wav', wav)
    await app.jobs.idle()
    assert.ok(fs.existsSync(path.join(dir, 'library', track.id.slice(0, 2), track.id + '.wav')), 'the original in its shard')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'library')).filter((n) => !SHARD.test(n)), [], 'nothing flat in library/')
    const levels = fs.readdirSync(path.join(dir, 'transcodes', track.id.slice(0, 2)))
    assert.ok(levels.length >= 3, 'its levels in the same shard of transcodes/: ' + levels)
    assert.deepEqual(fs.readdirSync(path.join(dir, 'transcodes')).filter((n) => !SHARD.test(n)), [], 'nothing flat in transcodes/')
    assert.equal(app.library.trackPath(app.library.getTrack(track.id)), shardPath(dir, 'library', track.id + '.wav'))
  } finally {
    await app.close()
  }
})

test('shards: a data dir with flat library/ and transcodes/ starts with every track, files in their shards, nothing adopted, nothing dropped', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  let { app } = await startApp(t, dir)
  const ids = []
  let before
  try {
    for (const f of [310, 320, 330]) ids.push((await upload(app, f + '.wav', hiWav(f))).id)
    await app.jobs.idle()
    before = app.library.publicTracks().map((x) => [x.id, x.addedAt, x.qualities])
  } finally {
    await app.close()
  }
  flatten(dir)
  const lines = logLines(dir).length
  // A stray .part at the top of transcodes/ (a cut transcode of before) goes too.
  fs.writeFileSync(path.join(dir, 'transcodes', 'job-x.part'), 'x')
  ;({ app } = await startApp(t, dir))
  try {
    assert.deepEqual(app.library.publicTracks().map((x) => [x.id, x.addedAt, x.qualities]), before, 'the same tracks, dates and ready levels')
    for (const id of ids) assert.ok(fs.existsSync(shardPath(dir, 'library', id + '.wav')))
    assert.deepEqual(fs.readdirSync(path.join(dir, 'library')).filter((n) => !SHARD.test(n)), [])
    assert.deepEqual(fs.readdirSync(path.join(dir, 'transcodes')).filter((n) => !SHARD.test(n)), [], 'the .part went too')
    const added = logLines(dir).slice(lines)
    assert.ok(!added.some((l) => l.length === 2 && String(l[1]).startsWith('t:')), 'no tombstone')
    assert.ok(!added.some((l) => l[1] === 'z'), 'no reorder (nothing adopted)')
  } finally {
    await app.close()
  }
})

// A library of `n` tracks with their files, written by the library itself.
async function smallLibrary (dir, n = 4) {
  const lib = new Library({ dataDir: dir })
  await lib.open()
  const ids = []
  for (let i = 0; i < n; i++) {
    const wav = makeWav({ freq: 200 + i * 37 })
    const id = idOf(wav)
    const file = shardPath(dir, 'library', id + '.wav')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, wav)
    lib.addTrack({ id, format: 'wav', title: 'Brano ' + i, size: wav.length, fileHash: id, addedAt: 1000 + i, uploaders: ['owner'] })
    ids.push(id)
  }
  lib.close()
  return ids
}

test('shards: a start cut after each single migration rename ends, at the next start, with every file in its shard and every track kept', async (t) => {
  const c = cleanup(t)
  const base = c.dir(tmpDir())
  const ids = await smallLibrary(base, 4)
  flatten(base)
  for (let n = 0; n < ids.length; n++) {
    const dir = c.dir(tmpDir('mpfy-cut-'))
    fs.cpSync(base, dir, { recursive: true })
    // The process dies at the (n + 1)th change of the migration.
    let calls = 0
    const cut = (fn) => (...a) => {
      if (calls++ >= n) throw Object.assign(new Error('cut'), { code: 'ECUT' })
      return fn(...a)
    }
    const places = new Places({ dataDir: dir, cardsDir: null, io: { renameSync: cut(PLACE_IO.renameSync), unlinkSync: cut(PLACE_IO.unlinkSync), writeFileSync: cut((f, b) => fs.writeFileSync(f, b)) } })
    await assert.rejects(places.migrateFlat(places.internal), /cut/)
    places.close()
    const lib = new Library({ dataDir: dir })
    await lib.open()
    try {
      assert.deepEqual([...lib.tracks.keys()].sort(), [...ids].sort(), 'cut after ' + n + ' change(s): every track kept')
      for (const id of ids) assert.ok(fs.existsSync(shardPath(dir, 'library', id + '.wav')), 'cut after ' + n + ': ' + id + ' in its shard')
      assert.deepEqual(fs.readdirSync(path.join(dir, 'library')).filter((x) => !SHARD.test(x)), [])
    } finally {
      lib.close()
    }
  }
})

test('shards: a flat file with a shard twin of another size is kept and never adopted; of the same size it goes', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const [a, b] = await smallLibrary(dir, 2)
  fs.writeFileSync(path.join(dir, 'library', a + '.wav'), Buffer.from('another file, another size'))
  fs.copyFileSync(shardPath(dir, 'library', b + '.wav'), path.join(dir, 'library', b + '.wav'))
  const lib = new Library({ dataDir: dir })
  await lib.open()
  try {
    assert.equal(lib.tracks.size, 2, 'nothing adopted')
    assert.ok(fs.existsSync(path.join(dir, 'library', a + '.wav')), 'the twin of another size stays where it is')
    assert.ok(fs.statSync(shardPath(dir, 'library', a + '.wav')).size > 100, 'the shard copy is the track')
    assert.ok(!fs.existsSync(path.join(dir, 'library', b + '.wav')), 'the twin of the same size went')
  } finally {
    lib.close()
  }
})

// The largest gap of a 1 ms interval while `fn` runs.
async function largestGap (fn) {
  let last = performance.now()
  let worst = 0
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
  }, 1)
  try {
    await fn()
  } finally {
    clearInterval(timer)
  }
  return Math.max(worst, performance.now() - last)
}

test('shards: the event loop never stalls over 50 ms while 20,000 transcodes are scanned, nor while a log of 20,000 tracks is read with their files', { timeout: 600000 }, async (t) => {
  const dir = cleanup(t).dir(tmpDir('mpfy-many-'))
  const N = 20000
  const ids = []
  const lib = new Library({ dataDir: dir })
  await lib.open()
  lib.batch(() => {
    for (let i = 0; i < N; i++) {
      const id = crypto.createHash('sha256').update('t' + i).digest('hex').slice(0, 24)
      ids.push(id)
      lib.addTrack({ id, format: 'mp3', title: 'Brano ' + i, size: 1, fileHash: id, addedAt: 1000 + i, uploaders: ['owner'] })
    }
  })
  lib.close()
  for (const id of ids) {
    const f = shardPath(dir, 'library', id + '.mp3')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, 'x')
    const tr = shardPath(dir, 'transcodes', id + '.low.opus')
    fs.mkdirSync(path.dirname(tr), { recursive: true })
    fs.writeFileSync(tr, 'x')
  }
  // The scan of the transcodes, with a library stub that knows every id.
  const places = new Places({ dataDir: dir, cardsDir: null })
  await places.open()
  const known = new Map(ids.map((id) => [id, { id, bitrate: 320000, size: 1 }]))
  const stub = { places, transcodesDir: path.join(dir, 'transcodes'), tmpDir: path.join(dir, 'tmp'), getTrack: (id) => known.get(id) || null, tracks: known, embeddedCoverIds: () => [], originalReady: () => true, derivedChanged: () => {} }
  const jobs = new MediaJobs({ library: stub, ffmpeg: null, backgroundDelayMs: 1e9 })
  const scanGap = await largestGap(() => jobs.start())
  jobs.close()
  places.close()
  assert.equal(jobs._ready.size, N, 'every transcode known')
  assert.ok(scanGap <= 50, 'scan: the loop stalled ' + Math.round(scanGap) + ' ms')
  // The start of the library: its log, then the files listed and their sizes compared.
  const again = new Library({ dataDir: dir })
  const openGap = await largestGap(() => again.open())
  try {
    assert.equal(again.tracks.size, N)
    assert.ok(openGap <= 50, 'start: the loop stalled ' + Math.round(openGap) + ' ms')
  } finally {
    again.close()
  }
})

test('shards: export-compat moves the files back flat, and the folder rule of an older build sees every one', async (t) => {
  const dir = cleanup(t).dir(tmpDir())
  const { app } = await startApp(t, dir)
  let ids
  try {
    ids = [(await upload(app, 'a.wav', hiWav(410))).id, (await upload(app, 'b.wav', hiWav(420))).id]
    await app.jobs.idle()
  } finally {
    await app.close()
  }
  await exportCompat(dir)
  // The names an older build adopts from library/ (its own reconcile: one readdir, flat names).
  const older = fs.readdirSync(path.join(dir, 'library')).filter((n) => LIBRARY_FILE_RE.test(n)).map((n) => n.slice(0, 24))
  assert.deepEqual(older.sort(), ids.sort())
  assert.deepEqual(fs.readdirSync(path.join(dir, 'library')).filter((n) => SHARD.test(n)), [], 'no shard left')
  assert.ok(fs.readdirSync(path.join(dir, 'transcodes')).some((n) => n.startsWith(ids[0]) && n.endsWith('.opus')), 'transcodes flat too')
  assert.deepEqual(treeFiles(dir, 'library').sort(), ids.map((id) => id + '.wav').sort())
})
