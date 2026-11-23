// What GET /api/library answers to an app that reads deltas, and what every
// change answers: the delta since the versions and epochs an app holds (or the
// whole part when the source cannot prove them), full answers written in pieces
// with backpressure, the ETag with both epochs, the version headers of the
// changes, brief likes and bulk likes, and the count of library requests from
// apps that read no deltas. The main check plays random histories (uploads,
// edits, deletes, files uploaded again, playlists made again under the same id,
// transcodes, lyrics, covers, likes, bulk likes, playlist edits, plays, merges,
// restarts, power cuts, compactions, changes made while a full answer is being
// written) and after every step holds each app's copy, built only from the
// answers it got, against a fresh full answer.

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createMPfy } from '../server/app.mjs'
import { createApiHandler } from '../server/http.mjs'
import { createAdminHandler, LegacyLibrary } from '../server/admin.mjs'
import { albumIdOf } from '../server/ids.mjs'
import {
  tmpDir, rmDir, cleanup, request, json, makeWav, makeMp3, makeProfile, device, testWhoIs, fakeFfmpeg, fakeTool, fakeJpeg, proofHeaders,
  hash24, fingerprintOf
} from './helpers.mjs'

const here = fileURLToPath(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const KEY_ORDER = ['version', 'userVersion', 'epochs', 'delta', 'tracks', 'playlists', 'likes', 'recents', 'covers', 'you', 'source']
const OLD_KEY_ORDER = ['version', 'userVersion', 'tracks', 'playlists', 'likes', 'recents', 'covers', 'you', 'source']
const HEX16 = /^[0-9a-f]{16}$/

// ------------------------------------------------------------------ probes

// A child process of this file measures a whole source holding many tracks
// (MPFY_DELTA_PROBE=loop: the longest turn of the event loop during a full
// answer; =heap: the memory while a slow reader takes one).
if (process.env.MPFY_DELTA_PROBE) {
  await probe(process.env.MPFY_DELTA_PROBE)
  process.exit(0)
}

function hex24 (n) {
  return crypto.createHash('sha256').update('t' + n).digest('hex').slice(0, 24)
}

// A stored track as a source holds it, with a fingerprint signature (what makes
// a real answer about 1 KB per track). Its file is a placeholder of its size.
function fakeTrack (id, extra = {}) {
  const s = crypto.createHash('sha512').update(id).digest()
  return {
    id,
    title: 'Brano ' + id.slice(0, 6),
    artist: 'Riva Nord',
    album: 'Acque ' + id.slice(0, 2),
    albumArtist: 'Riva Nord',
    trackNo: 1 + (parseInt(id.slice(2, 4), 16) % 12),
    discNo: 1,
    year: 2020,
    duration: 150 + parseInt(id.slice(0, 2), 16),
    format: 'mp3',
    mime: 'audio/mpeg',
    size: 16,
    bitrate: 320000,
    addedAt: 1700000000000 + parseInt(id.slice(0, 6), 16),
    coverId: null,
    fileHash: id,
    uploaders: ['owner'],
    fp: { d: 150, b: 32, s: Buffer.concat([s, s, s, s]).toString('base64') },
    fpState: 'ok',
    ...extra
  }
}

function putFile (dir, t) {
  fs.mkdirSync(path.join(dir, 'library'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'library', t.id + '.' + t.format), Buffer.alloc(t.size))
  return t
}

// Many tracks added at once (one change on a source that groups changes).
function addMany (library, tracks) {
  const add = () => {
    for (const t of tracks) library.addTrack(t)
  }
  if (typeof library.batch === 'function') library.batch(add)
  else add()
}

// The memory a source holds for its answers: the heap and what lives outside it (buffers).
function held () {
  const m = process.memoryUsage()
  return m.heapUsed + m.external
}

async function probe (kind) {
  const dir = tmpDir('mpfy-delta-probe-')
  const n = Number(process.env.MPFY_DELTA_TRACKS || 100000)
  const app = await createMPfy({ dataDir: dir, port: 0, adminPort: 0, p2p: false, ffmpeg: null, fpcalc: null, sevenZip: null })
  const out = { kind, tracks: n }
  try {
    const tracks = []
    for (let i = 0; i < n; i++) tracks.push(fakeTrack(hex24(i)))
    addMany(app.library, tracks)
    tracks.length = 0
    if (typeof app.library.flushNow === 'function') app.library.flushNow()
    await sleep(500)
    if (kind === 'loop') {
      for (const gzip of [false, true]) {
        const h = monitorEventLoopDelay({ resolution: 1 })
        await sleep(100)
        h.enable()
        const t0 = Date.now()
        const got = await readAll(app.ports.http, '/api/library', gzip)
        h.disable()
        out[gzip ? 'gzip' : 'plain'] = { maxMs: h.max / 1e6, p99Ms: h.percentile(99) / 1e6, ms: Date.now() - t0, bytes: got.bytes, status: got.status, end: got.end }
      }
    } else {
      global.gc()
      await sleep(100)
      global.gc()
      const before = held()
      let most = 0
      const reader = slowReader(app.ports.http, '/api/library', 64 * 1024)
      const until = Date.now() + 8000
      while (Date.now() < until) {
        await sleep(250)
        global.gc()
        most = Math.max(most, held() - before)
      }
      out.status = reader.status()
      out.read = reader.bytes()
      reader.stop()
      out.mostMB = most / 1048576
    }
  } finally {
    await app.close()
    rmDir(dir)
  }
  process.stdout.write('PROBE ' + JSON.stringify(out) + '\n')
}

// GET a whole answer, counting its bytes (never holding them).
function readAll (port, urlPath, gzip) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent: false, headers: gzip ? { 'accept-encoding': 'gzip' } : {} }, (res) => {
      let bytes = 0
      let last = null
      res.on('data', (c) => {
        bytes += c.length
        last = c
      })
      res.on('end', () => resolve({ status: res.statusCode, bytes, end: gzip || last === null ? null : last.subarray(-1).toString() }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// A reader that takes `rate` bytes a second, at most.
function slowReader (port, urlPath, rate) {
  let res = null
  let got = 0
  let timer = null
  const start = Date.now()
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent: false }, (r) => {
    res = r
    r.pause()
    timer = setInterval(() => {
      const allowed = Math.floor(((Date.now() - start) / 1000) * rate) - got
      if (allowed <= 0 || r.readableLength === 0) return
      const chunk = r.read(Math.min(allowed, r.readableLength))
      if (chunk !== null) got += chunk.length
    }, 50)
  })
  req.on('error', () => {})
  req.end()
  return {
    status: () => (res === null ? null : res.statusCode),
    bytes: () => got,
    stop () {
      clearInterval(timer)
      req.destroy()
    }
  }
}

function runProbe (kind, n) {
  return new Promise((resolve, reject) => {
    const args = kind === 'heap' ? ['--expose-gc', here] : [here]
    const child = spawn(process.execPath, args, { env: { ...process.env, MPFY_DELTA_PROBE: kind, MPFY_DELTA_TRACKS: String(n) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (d) => { text += d })
    child.stderr.on('data', (d) => { text += d })
    child.on('error', reject)
    child.on('close', (code) => {
      const line = text.split('\n').find((l) => l.startsWith('PROBE '))
      if (line === undefined) reject(new Error('the probe ended (exit ' + code + ') without a result:\n' + text.slice(-3000)))
      else resolve(JSON.parse(line.slice(6)))
    })
  })
}

// ---------------------------------------------------------------- helpers

async function start (t, { dir = null, ...opts } = {}) {
  const c = cleanup(t)
  const dataDir = dir || c.dir(tmpDir('mpfy-delta-'))
  const app = c.close(await createMPfy({
    dataDir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null, whoIs: testWhoIs, ...opts
  }))
  return { app, dir: dataDir, c }
}

// Until nothing runs in the background (media jobs, lyrics) and the shared version stopped moving.
async function settle (app) {
  let seen = null
  for (let i = 0; i < 500; i++) {
    await app.jobs.idle()
    await app.lyrics.idle()
    await sleep(5)
    const v = app.library.version
    if (v === seen) return
    seen = v
  }
  throw new Error('the source never settled')
}

const local = (app) => ({
  call: (method, urlPath, opts = {}) => request(app.ports.http, method, urlPath, opts)
})

function libraryPath (mode, s) {
  if (mode === 0) return '/api/library' + (s ? '?have=' + s.version : '')
  let q = '/api/library?delta=' + mode
  if (s) q += '&have=' + s.version + '&he=' + s.epochs.shared + '&uv=' + s.userVersion + '&ue=' + s.epochs.user
  return q
}

// zlib's CRC-32 of ids joined by commas, as the edits of delta=2 give it.
const crcOf = (ids) => zlib.crc32(Buffer.from(ids.join(','), 'utf8')).toString(16).padStart(8, '0')

function sortedObject (o) {
  const out = {}
  for (const k of Object.keys(o).sort()) out[k] = o[k]
  return out
}

/**
 * An app's copy of one source, built only from the answers it gets, by the rules
 * an app applies (every removed list first, then changed and added; a changed
 * item it holds keeps its place, a new one goes at the end; a like it already
 * holds is not added again). mode 0 is an app that reads no deltas (have only).
 */
class Copy {
  constructor (name, caller, mode) {
    this.name = name
    this.caller = caller
    this.mode = mode
    this.s = null
    this.edited = new Set() // playlists whose updatedAt an edit could not bring
    this.stats = { full: 0, delta: 0, notModified: 0, edits: 0, mismatches: 0 }
  }

  get who () {
    return typeof this.caller === 'function' ? this.caller() : this.caller
  }

  /** Asks with what it holds and applies the answer; true when a part came whole. */
  async sync () {
    const s = this.s
    const r = await this.who.call('GET', libraryPath(this.mode, s), { headers: s ? { 'if-none-match': s.etag } : {} })
    return this.take(r)
  }

  take (r) {
    if (r.status === 304) {
      this.stats.notModified++
      return false
    }
    assert.equal(r.status, 200, this.name + ': ' + r.body.toString().slice(0, 300))
    const a = json(r)
    assert.deepEqual(Object.keys(a), this.mode === 0 ? OLD_KEY_ORDER : KEY_ORDER, this.name + ': the key order')
    if (this.mode === 0) return this._applyOld(a, r.headers.etag)
    return this._apply(a, r.headers.etag)
  }

  _applyOld (a, etag) {
    const held = this.s
    const s = { version: a.version, userVersion: a.userVersion, etag }
    if (a.tracks === null) {
      assert.ok(held !== null, this.name + ': no tracks for an app that holds none')
      s.tracks = held.tracks
      s.covers = { track: held.covers.track, album: held.covers.album, playlist: a.covers.playlist }
    } else {
      s.tracks = a.tracks
      s.covers = a.covers
    }
    Object.assign(s, { playlists: a.playlists, likes: once(a.likes), recents: a.recents, you: a.you, source: a.source })
    this.s = s
    this.stats.full++
    return a.tracks !== null
  }

  _apply (a, etag) {
    const held = this.s
    assert.ok(HEX16.test(a.epochs.shared) && HEX16.test(a.epochs.user), this.name + ': the epochs')
    const s = held === null
      ? { tracks: [], playlists: [], likes: [], recents: [], covers: { track: {}, album: {}, playlist: {} } }
      : { ...held, covers: { ...held.covers } }
    Object.assign(s, { version: a.version, userVersion: a.userVersion, epochs: a.epochs, etag, you: a.you, source: a.source })
    let full = false

    if (!a.delta.shared) {
      if (a.tracks === null) {
        assert.ok(held !== null, this.name + ': no tracks for an app that holds none')
        assert.deepEqual(Object.keys(a.covers), ['playlist'])
      } else {
        assert.ok(Array.isArray(a.tracks))
        s.tracks = a.tracks
        s.covers.track = a.covers.track
        s.covers.album = a.covers.album
        full = true
      }
    } else {
      assert.ok(held !== null, this.name + ': a delta for an app that holds nothing')
      const gone = new Set(a.tracks.removed)
      const list = s.tracks.filter((t) => !gone.has(t.id))
      const at = new Map(list.map((t, i) => [t.id, i]))
      for (const t of a.tracks.changed) {
        if (at.has(t.id)) list[at.get(t.id)] = t
        else {
          at.set(t.id, list.length)
          list.push(t)
        }
      }
      s.tracks = list
      for (const kind of ['track', 'album']) {
        const map = { ...s.covers[kind] }
        for (const [id, e] of Object.entries(a.covers[kind])) {
          if (e === null) delete map[id]
          else map[id] = e
        }
        s.covers[kind] = map
      }
    }

    if (!a.delta.user) {
      assert.ok(Array.isArray(a.playlists) && Array.isArray(a.likes) && Array.isArray(a.recents))
      s.playlists = a.playlists
      s.likes = once(a.likes)
      s.recents = a.recents
      s.covers.playlist = a.covers.playlist
      this.edited.clear()
      full = true
    } else {
      assert.ok(held !== null, this.name + ': a delta for an app that holds nothing')
      assert.equal('edits' in a.playlists, this.mode === 2, this.name + ': edits only with delta=2')
      const gone = new Set(a.playlists.removed)
      const list = s.playlists.filter((p) => !gone.has(p.id))
      for (const id of gone) this.edited.delete(id)
      const at = new Map(list.map((p, i) => [p.id, i]))
      for (const e of a.playlists.edits || []) {
        assert.ok(!a.playlists.changed.some((p) => p.id === e.id), this.name + ': a playlist in edits and changed')
        const i = at.get(e.id)
        const ids = i === undefined ? null : list[i].trackIds.slice()
        if (ids === null || ids.length !== e.from) {
          this.stats.mismatches++
          continue
        }
        for (const op of e.ops) {
          if (op[0] === 'a') ids.splice(op[1], 0, ...op[2])
          else for (let k = op[1].length - 1; k >= 0; k--) ids.splice(op[1][k], 1)
        }
        if (ids.length !== e.to || crcOf(ids) !== e.crc) {
          this.stats.mismatches++
          continue
        }
        list[i] = { ...list[i], trackIds: ids }
        this.edited.add(e.id)
        this.stats.edits++
      }
      for (const p of a.playlists.changed) {
        this.edited.delete(p.id)
        if (at.has(p.id)) list[at.get(p.id)] = p
        else {
          at.set(p.id, list.length)
          list.push(p)
        }
      }
      s.playlists = list
      const unliked = new Set(a.likes.removed)
      const likes = s.likes.filter((l) => !unliked.has(l.id))
      const have = new Set(likes.map((l) => l.id))
      for (const l of a.likes.added) {
        if (have.has(l.id)) continue
        have.add(l.id)
        likes.unshift(l)
      }
      s.likes = likes
      if (a.recents !== null) s.recents = a.recents
      const pc = { ...s.covers.playlist }
      for (const [id, e] of Object.entries(a.covers.playlist)) {
        if (e === null) delete pc[id]
        else pc[id] = e
      }
      s.covers.playlist = pc
    }
    this.s = s
    if (full) this.stats.full++
    else this.stats.delta++
    return full
  }

  /** Where this copy differs from a fresh full answer (null: nowhere). */
  differs (fresh) {
    const s = this.s
    const pick = (x, withEpochs) => JSON.stringify([
      x.version, x.userVersion, withEpochs ? x.epochs : null, x.tracks, x.playlists, x.likes, x.recents,
      sortedObject(x.covers.track), sortedObject(x.covers.album), sortedObject(x.covers.playlist), x.you, x.source
    ])
    // An edit carries the ids, not the time of the last change: that is all it may differ in.
    const playlists = fresh.playlists.map((p) => (this.edited.has(p.id) ? { ...p, updatedAt: s.playlists.find((q) => q.id === p.id)?.updatedAt } : p))
    const want = pick({ ...fresh, playlists }, this.mode !== 0)
    const got = pick(s, this.mode !== 0)
    if (want === got) return null
    for (const k of ['version', 'userVersion', 'epochs', 'tracks', 'playlists', 'likes', 'recents', 'you', 'source']) {
      const a = JSON.stringify(k === 'playlists' ? playlists : fresh[k])
      const b = JSON.stringify(s[k])
      if (this.mode === 0 && k === 'epochs') continue
      if (a !== b) return this.name + ': ' + k + ' differs\n  fresh: ' + a.slice(0, 600) + '\n  copy:  ' + b.slice(0, 600)
    }
    return this.name + ': the covers differ\n  fresh: ' + JSON.stringify(fresh.covers).slice(0, 600) + '\n  copy:  ' + JSON.stringify(s.covers).slice(0, 600)
  }
}

// A full answer may list a like twice (it is not a snapshot): kept once, in its first place.
function once (likes) {
  const seen = new Set()
  return likes.filter((l) => !seen.has(l.id) && seen.add(l.id))
}

async function freshOf (caller) {
  const r = await caller.call('GET', '/api/library?delta=1')
  assert.equal(r.status, 200)
  const a = json(r)
  assert.deepEqual(a.delta, { shared: false, user: false })
  return a
}

// ------------------------------------------------------- what moved, only

test('after one transcode becomes ready, a delta=1 request carries that one track and nothing else', async (t) => {
  const c = cleanup(t)
  const tools = c.dir(tmpDir('mpfy-delta-tools-'))
  const ff = fakeFfmpeg(tools, { fail: '48k' })
  const { app } = await start(t, { ffmpeg: ff.command })
  await app.jobsStarted
  const ids = []
  for (let i = 0; i < 6; i++) {
    const r = await request(app.ports.http, 'PUT', '/api/upload/b' + i + '.wav', { body: makeWav({ freq: 300 + 40 * i }) })
    assert.equal(r.status, 200)
    ids.push(json(r).track.id)
  }
  assert.equal((await request(app.ports.http, 'PUT', '/api/likes/' + ids[0] + '?brief=1')).status, 200)
  await settle(app)
  const first = await request(app.ports.http, 'GET', '/api/library?delta=1')
  const held = json(first)
  assert.equal(held.tracks.length, 6)
  assert.ok(held.tracks.every((x) => x.qualities.low === false), 'the low transcodes failed at upload')

  // Past the half hour a failed transcode waits, a stream asks for one again.
  const realNow = Date.now
  Date.now = () => realNow() + 31 * 60 * 1000
  try {
    ff.control({})
    const st = await request(app.ports.http, 'GET', '/api/stream/' + ids[2] + '?q=low')
    assert.equal(st.status, 200)
    await settle(app)
    assert.equal(app.library.getTrack(ids[2]) !== null, true)
    const q = '?have=' + held.version + '&he=' + (held.epochs && held.epochs.shared) + '&uv=' + held.userVersion + '&ue=' + (held.epochs && held.epochs.user) + '&delta=1'
    const r = await request(app.ports.http, 'GET', '/api/library' + q)
    assert.equal(r.status, 200)
    const a = json(r)
    const sent = Array.isArray(a.tracks) ? a.tracks : a.tracks.changed
    assert.deepEqual(sent.map((x) => x.id), [ids[2]], 'that track only (' + sent.length + ' sent)')
    assert.equal(a.version, held.version + 1, 'one derived change, one version')
    assert.deepEqual(a.delta, { shared: true, user: true })
    assert.equal(a.tracks.changed[0].qualities.low, true)
    assert.deepEqual(a.tracks.removed, [])
    assert.deepEqual(a.covers, { track: {}, album: {}, playlist: {} })
    assert.deepEqual([a.playlists, a.likes, a.recents], [{ changed: [], removed: [] }, { added: [], removed: [] }, null], 'nothing moved in the user part: an empty delta')
    assert.ok(r.body.length < 2000, 'a small answer: ' + r.body.length + ' bytes')
  } finally {
    Date.now = realNow
  }
})

// ------------------------------------------------------------ likes at scale

test('at 100,000 likes a heart with ?brief=1 answers under 200 bytes; bulk likes stop at the cap and change nothing then', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-delta-likes-'))
  const likes = []
  for (let i = 0; i < 100000; i++) likes.push({ id: hex24(i), at: 1767225600000 - i * 1000 })
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'users', 'owner.json'), JSON.stringify({ schema: 1, version: 7, playlists: [], likes, recents: [], covers: { playlist: {} } }))
  const { app } = await start(t, { dir })
  const port = app.ports.http

  const off = await request(port, 'DELETE', '/api/likes/' + hex24(500) + '?brief=1')
  assert.equal(off.status, 200)
  assert.ok(off.body.length < 200, 'an unlike at 100,000 likes answers ' + off.body.length + ' bytes')
  assert.deepEqual(json(off), { ok: true })
  const on = await request(port, 'PUT', '/api/likes/' + hex24(500) + '?brief=1')
  assert.equal(on.status, 200)
  assert.ok(on.body.length < 200, 'a like at 100,000 likes answers ' + on.body.length + ' bytes')
  assert.deepEqual(json(on), { ok: true })
  const v = Number(on.headers['x-mpfy-user-version'])
  assert.ok(Number.isSafeInteger(v) && HEX16.test(on.headers['x-mpfy-user-epoch']))

  // Without brief: the whole list, newest first, as before (written in pieces).
  const whole = await request(port, 'PUT', '/api/likes/' + hex24(500))
  assert.equal(whole.status, 200)
  const list = json(whole).likes
  assert.equal(list.length, 100000)
  assert.equal(list[0].id, hex24(500), 'the like given again is the newest')
  assert.equal(list[1].id, hex24(0))
  assert.equal(whole.headers['x-mpfy-user-version'], String(v), 'a like already there changes nothing')

  // One more would pass the cap: refused whole, nothing written.
  const fresh = 'ab'.repeat(12)
  const over = await request(port, 'POST', '/api/likes', { body: { add: [fresh] } })
  assert.equal(over.status, 400)
  assert.deepEqual(json(over), { error: 'Troppi brani piaciuti', code: 'too_many_likes' })
  assert.equal(over.headers['x-mpfy-user-version'], undefined, 'a refusal carries no version')
  const swap = await request(port, 'POST', '/api/likes', { body: { remove: [hex24(9)], add: [fresh] } })
  assert.equal(swap.status, 200)
  assert.deepEqual(json(swap), { ok: true, added: 1, removed: 1 })
  assert.equal(Number(swap.headers['x-mpfy-user-version']), v + 1, 'the refused request moved nothing; this one one version')
  const after = json(await request(port, 'GET', '/api/library?delta=1'))
  assert.equal(after.likes.length, 100000)
  assert.equal(after.likes[0].id, fresh)
})

// ------------------------------------------------------------- full answers

test('a full answer of 100,000 tracks never holds the event loop more than 20 ms, plain or gzipped', { timeout: 300000 }, async () => {
  const got = await runProbe('loop', 100000)
  for (const how of ['plain', 'gzip']) {
    const r = got[how]
    assert.equal(r.status, 200, how)
    assert.ok(r.bytes > 50 * 1024 * 1024 || how === 'gzip', how + ': the whole answer came (' + r.bytes + ' bytes)')
    assert.ok(r.maxMs <= 20, how + ': the longest turn of the event loop was ' + r.maxMs.toFixed(1) + ' ms')
  }
  assert.equal(got.plain.end, '}')
})

test('a full answer to a reader of 64 KB a second keeps the source within 5 MB of its memory before (backpressure)', { timeout: 300000 }, async () => {
  const got = await runProbe('heap', 100000)
  assert.equal(got.status, 200)
  assert.ok(got.read > 100 * 1024, 'the reader took ' + got.read + ' bytes')
  assert.ok(got.mostMB < 5, 'the heap and the buffers grew by ' + got.mostMB.toFixed(2) + ' MB at most')
})

// ------------------------------------------------------------ equivalence

const BIG = Number(process.env.MPFY_DELTA_BIG || 3000) // tracks enough for full answers to be streamed
const ROUNDS = Number(process.env.MPFY_DELTA_ROUNDS || 3)
const STEPS = Number(process.env.MPFY_DELTA_STEPS || 45)

function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return (s >>> 1) / 0x80000000
  }
}

// A GET whose answer is read only when asked: the first piece, then the rest.
function slowGet (app, dev, urlPath) {
  let res = null
  const chunks = []
  let first
  const started = new Promise((resolve) => { first = resolve })
  const ended = new Promise((resolve, reject) => {
    const headers = { 'x-test-client': dev.key, ...proofHeaders(dev.profile, dev.key, app.serverPublicKey) }
    const req = http.request({ host: '127.0.0.1', port: app.ports.http, path: urlPath, agent: false, localAddress: '127.0.0.2', headers }, (r) => {
      res = r
      r.once('data', (c) => {
        chunks.push(c)
        r.pause()
        r.on('data', (more) => chunks.push(more))
        first()
      })
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }))
      r.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
  return {
    started,
    finish: () => {
      res.resume()
      return ended
    }
  }
}

// The size and a hash of each log, to cut it back there later (a power cut).
function logStates (dir) {
  const files = [path.join(dir, 'library.log')]
  try {
    for (const f of fs.readdirSync(path.join(dir, 'users'))) if (f.endsWith('.log')) files.push(path.join(dir, 'users', f))
  } catch {}
  const out = new Map()
  for (const f of files) {
    try {
      const b = fs.readFileSync(f)
      out.set(f, { size: b.length, hash: crypto.createHash('sha256').update(b).digest('hex') })
    } catch {}
  }
  return out
}

async function history (t, seed) {
  const rnd = rng(seed * 7919)
  const pick = (list) => list[Math.floor(rnd() * list.length)]
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-delta-eq-'))
  const tools = c.dir(tmpDir('mpfy-delta-eq-tools-'))
  const ff = fakeFfmpeg(tools, {})
  // A slow clock (a millisecond every 20): versions run ahead of it, so a run after a
  // power cut gives again numbers the lost tail had served.
  const realNow = Date.now
  const t0 = realNow()
  Date.now = () => Date.UTC(2026, 5, 1) + Math.floor((realNow() - t0) / 20)
  const opts = { dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: ff.command, fpcalc: null, sevenZip: null, whoIs: testWhoIs, backgroundDelayMs: 1e9 }
  let app = await createMPfy(opts)
  const counts = { steps: 0, stale: 0, restarts: 0, cuts: 0, merges: 0, compactions: 0, during: 0, again: 0, remade: 0 }
  try {
    await app.jobsStarted
    app.people.openClaim(30)
    const A = device(app, { profile: makeProfile(), name: 'A' })
    const B = device(app, { profile: makeProfile(), name: 'B' })
    assert.equal(json(await A.call('GET', '/api/profile')).role, 'owner')
    assert.equal(json(await B.call('GET', '/api/profile')).role, 'member')
    const dev = { A, B }
    const callers = { A, B, local: local(app) }
    const ownerKey = () => (app.source.data.ownerProfileId === A.profile.id ? 'A' : 'B')
    const owner = () => callers[ownerKey()]
    const memberKey = () => (ownerKey() === 'A' ? 'B' : 'A')

    // A big library (full answers over 1 MB are streamed), real uploads (their
    // transcodes come later), and a long playlist (its adds and removals come as edits).
    // No fingerprint: a stored signature without its file is dropped at the next start.
    const fake = []
    for (let i = 0; i < BIG; i++) {
      const uploaders = [i % 3 === 0 ? B.profile.id : A.profile.id]
      fake.push(putFile(dir, fakeTrack(hex24(seed * 1000000 + i), { uploaders, fp: null, fpState: 'none' })))
    }
    addMany(app.library, fake)
    let freq = 200
    const uploads = new Map() // track id -> { bytes, who }
    const upload = async (who, bytes = null) => {
      const b = bytes || makeWav({ freq: (freq += 7), seconds: 1 })
      const r = await callers[who].call('PUT', '/api/upload/s' + freq + '.wav', { body: b })
      assert.ok(r.status === 200, 'upload ' + r.status + ' ' + r.body.toString().slice(0, 200))
      const id = json(r).track.id
      uploads.set(id, { bytes: b, who })
      return id
    }
    for (let i = 0; i < 3; i++) await upload('A')
    await upload('B')
    const foreign = () => crypto.randomBytes(12).toString('hex')
    const longIds = []
    for (let i = 0; i < 1100; i++) longIds.push(i % 5 === 0 ? pick(fake).id : foreign())
    const longPl = json(await A.call('POST', '/api/playlists', { body: { name: 'Lunga' } })).playlist.id
    assert.equal((await A.call('POST', '/api/playlists/' + longPl + '/tracks', { body: { trackIds: longIds } })).status, 200)
    await settle(app)

    const copies = [
      new Copy('A/delta=1', () => callers.A, 1), new Copy('A/delta=2', () => callers.A, 2), new Copy('A/old', () => callers.A, 0),
      new Copy('B/delta=1', () => callers.B, 1), new Copy('B/delta=2', () => callers.B, 2), new Copy('B/old', () => callers.B, 0),
      new Copy('local/delta=1', () => callers.local, 1)
    ]
    const whoOf = (cp) => cp.name.split('/')[0]
    const deletedPlaylists = []
    const gone = [] // real uploads deleted, to upload again
    let states = []

    const check = async (what) => {
      await settle(app)
      const fresh = {}
      for (const k of ['A', 'B', 'local']) fresh[k] = await freshOf(callers[k])
      for (const cp of copies) {
        const full = await cp.sync()
        let d = cp.differs(fresh[whoOf(cp)])
        if (d !== null) assert.fail('seed ' + seed + ', step ' + counts.steps + ' (' + what + '): ' + d)
        if (full) {
          // A new app asks again right after a whole part: nothing more may come.
          await cp.sync()
          d = cp.differs(fresh[whoOf(cp)])
          if (d !== null) assert.fail('seed ' + seed + ', step ' + counts.steps + ' (' + what + ', the delta after a whole part): ' + d)
        }
      }
    }

    const restart = async (cut) => {
      await app.close()
      if (cut) {
        // Each log back to an earlier state it still begins with: its last appends never reached the disk.
        for (const [f, now] of logStates(dir)) {
          const earlier = states.map((s) => s.get(f)).filter((x) => x !== undefined && x.size < now.size)
          if (earlier.length === 0) continue
          const to = pick(earlier)
          const head = fs.readFileSync(f).subarray(0, to.size)
          if (crypto.createHash('sha256').update(head).digest('hex') !== to.hash) continue
          fs.truncateSync(f, to.size)
        }
        counts.cuts++
      }
      // A transcode deleted while the source was stopped.
      const tdir = path.join(dir, 'transcodes')
      const made = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.ogg') || f.endsWith('.opus')) : []
      if (made.length > 0 && rnd() < 0.5) fs.rmSync(path.join(tdir, pick(made)), { force: true })
      app = await createMPfy(opts)
      await app.jobsStarted
      callers.A = A.on(app)
      callers.B = B.on(app)
      callers.local = local(app)
      counts.restarts++
    }

    const libraryIds = () => [...app.library.tracks.keys()]
    const realIds = () => [...uploads.keys()].filter((id) => app.library.getTrack(id) !== null)
    const playlistsOf = (k) => [...app.users.get(dev[k].profile.id).playlists.keys()]
    const longOwner = () => ['A', 'B'].find((k) => app.users.has(dev[k].profile.id) && app.users.get(dev[k].profile.id).playlists.has(longPl)) || null
    const ok = (r, what) => {
      assert.ok(r.status < 500, what + ' answered ' + r.status + ': ' + r.body.toString().slice(0, 200))
      return r
    }

    const ops = [
      [3, 'upload', async () => { await upload(pick(['A', 'B'])) }],
      [2, 'upload again', async () => {
        if (gone.length === 0) return
        const g = gone.splice(Math.floor(rnd() * gone.length), 1)[0]
        await upload(g.who, g.bytes)
      }],
      [2, 'deleted and uploaded again at once', async () => {
        // Between two requests of an app: the same id is gone and back, now at the end.
        const real = realIds()
        if (real.length === 0) return
        const id = pick(real)
        const u = uploads.get(id)
        ok(await owner().call('DELETE', '/api/tracks/' + id), 'delete')
        if (app.library.getTrack(id) !== null) return
        await upload(u.who, u.bytes)
        counts.again++
      }],
      [3, 'playlist made again at once', async () => {
        const order = rnd() < 0.5 ? ['A', 'B'] : ['B', 'A']
        const who = order.find((k) => playlistsOf(k).some((id) => id !== longPl))
        if (who === undefined) {
          ok(await callers[order[0]].call('POST', '/api/playlists', { body: { name: 'Prima' } }), 'create')
          return
        }
        const pls = playlistsOf(who).filter((id) => id !== longPl)
        const id = pick(pls)
        ok(await callers[who].call('DELETE', '/api/playlists/' + id), 'delete playlist')
        ok(await callers[who].call('POST', '/api/playlists', { body: { id, name: 'Di nuovo' } }), 'create')
        counts.remade++
      }],
      [4, 'edit', async () => {
        const id = pick(libraryIds())
        ok(await owner().call('PATCH', '/api/tracks/' + id, { body: { title: 'Titolo ' + Math.floor(rnd() * 1e6) } }), 'edit')
      }],
      [2, 'delete', async () => {
        const real = rnd() < 0.6 ? realIds() : []
        const id = real.length > 0 ? pick(real) : pick(libraryIds())
        const u = uploads.get(id)
        ok(await owner().call('DELETE', '/api/tracks/' + id), 'delete')
        if (u && app.library.getTrack(id) === null) gone.push(u)
      }],
      [1, 'many edits at once', async () => {
        const ids = libraryIds()
        const n = rnd() < 0.3 ? 1200 : 1 + Math.floor(rnd() * 40)
        app.library.batch(() => {
          for (let i = 0; i < n; i++) app.library.updateTrack(pick(ids), { album: 'Raccolta ' + Math.floor(rnd() * 50) })
        })
      }],
      [2, 'lyrics', async () => {
        const id = pick(libraryIds())
        if (rnd() < 0.6) ok(await owner().call('PUT', '/api/lyrics/' + id, { body: 'Una riga\nE poi un\'altra ' + Math.floor(rnd() * 100) }), 'lyrics')
        else ok(await owner().call('DELETE', '/api/lyrics/' + id), 'lyrics')
      }],
      [2, 'shared cover', async () => {
        const t = app.library.getTrack(pick(libraryIds()))
        const [kind, id] = rnd() < 0.5 ? ['track', t.id] : ['album', albumIdOf(t)]
        if (rnd() < 0.7) ok(await owner().call('PUT', '/api/cover-for/' + kind + '/' + id + '?size=' + pick(['small', 'large']), { body: fakeJpeg(Math.floor(rnd() * 1e6), 900) }), 'cover')
        else ok(await owner().call('DELETE', '/api/cover-for/' + kind + '/' + id), 'cover')
      }],
      [4, 'like', async () => {
        const who = pick(['A', 'B', 'local'])
        const id = rnd() < 0.7 ? pick(libraryIds()) : foreign()
        const brief = rnd() < 0.7 ? '?brief=1' : ''
        ok(await callers[who].call(rnd() < 0.7 ? 'PUT' : 'DELETE', '/api/likes/' + id + brief), 'like')
      }],
      [2, 'bulk likes', async () => {
        const who = pick(['A', 'B'])
        const ids = libraryIds()
        const add = []
        const remove = []
        for (let i = Math.floor(rnd() * 30); i > 0; i--) add.push(rnd() < 0.8 ? pick(ids) : foreign())
        for (let i = Math.floor(rnd() * 10); i > 0; i--) remove.push(pick(ids))
        if (add.length > 0 && rnd() < 0.5) add.push(add[0])
        if (add.length > 0 && rnd() < 0.5) remove.push(add[add.length - 1])
        ok(await callers[who].call('POST', '/api/likes', { body: { add, remove } }), 'bulk likes')
      }],
      [5, 'playlist', async () => {
        const who = pick(['A', 'B'])
        const pls = playlistsOf(who).filter((id) => id !== longPl)
        const ids = libraryIds()
        const x = rnd()
        if (pls.length === 0 || x < 0.2) {
          const reuse = deletedPlaylists.length > 0 && rnd() < 0.5 ? deletedPlaylists.pop() : undefined
          ok(await callers[who].call('POST', '/api/playlists', { body: { id: reuse, name: 'P' + Math.floor(rnd() * 1000) } }), 'create')
          return
        }
        const id = pick(pls)
        const cur = app.users.get(dev[who].profile.id).playlists.get(id).trackIds.slice()
        if (x < 0.3) ok(await callers[who].call('PATCH', '/api/playlists/' + id, { body: { name: 'Nome ' + Math.floor(rnd() * 1000) } }), 'rename')
        else if (x < 0.35) ok(await callers[who].call('PATCH', '/api/playlists/' + id, { body: { description: 'Note ' + Math.floor(rnd() * 1000) } }), 'describe')
        else if (x < 0.6) ok(await callers[who].call('POST', '/api/playlists/' + id + '/tracks', { body: { trackIds: [pick(ids), rnd() < 0.3 ? foreign() : pick(ids)], position: Math.floor(rnd() * (cur.length + 2)) } }), 'add')
        else if (x < 0.75 && cur.length > 0) {
          const i = Math.floor(rnd() * cur.length)
          ok(await callers[who].call('DELETE', '/api/playlists/' + id + '/tracks', { body: { indexes: [i], ids: [cur[i]] } }), 'remove')
        } else if (x < 0.9 && cur.length > 1) {
          const want = cur.slice().sort(() => rnd() - 0.5)
          ok(await callers[who].call('PATCH', '/api/playlists/' + id, { body: { trackIds: want, base: cur } }), 'reorder')
        } else {
          ok(await callers[who].call('DELETE', '/api/playlists/' + id), 'delete playlist')
          deletedPlaylists.push(id)
        }
      }],
      [3, 'long playlist', async () => {
        const who = longOwner()
        if (who === null) return
        const cur = app.users.get(dev[who].profile.id).playlists.get(longPl).trackIds
        if (rnd() < 0.5) ok(await callers[who].call('POST', '/api/playlists/' + longPl + '/tracks', { body: { trackIds: [foreign(), pick(libraryIds())], position: Math.floor(rnd() * cur.length) } }), 'long add')
        else {
          const idx = [Math.floor(rnd() * cur.length), Math.floor(rnd() * cur.length)].filter((v, i, a) => a.indexOf(v) === i)
          ok(await callers[who].call('DELETE', '/api/playlists/' + longPl + '/tracks', { body: { indexes: idx, ids: idx.map((i) => cur[i]) } }), 'long remove')
        }
      }],
      [3, 'play', async () => {
        ok(await callers[pick(['A', 'B', 'local'])].call('POST', '/api/played', { body: { trackId: pick(libraryIds()), context: { type: 'library' } } }), 'play')
      }],
      [2, 'playlist cover', async () => {
        const who = pick(['A', 'B'])
        const pls = playlistsOf(who)
        if (pls.length === 0) return
        const id = pick(pls)
        if (rnd() < 0.7) ok(await callers[who].call('PUT', '/api/cover-for/playlist/' + id + '?size=' + pick(['small', 'large']), { body: fakeJpeg(Math.floor(rnd() * 1e6), 800) }), 'playlist cover')
        else ok(await callers[who].call('DELETE', '/api/cover-for/playlist/' + id), 'playlist cover')
      }],
      [1, 'compaction', async () => {
        // Started, not waited for: the changes that follow land while it runs.
        const runs = [app.library.compact()]
        for (const k of ['A', 'B']) if (app.users.has(dev[k].profile.id)) runs.push(app.users.get(dev[k].profile.id).log.compact())
        ok(await owner().call('PATCH', '/api/tracks/' + pick(libraryIds()), { body: { artist: 'Durante ' + Math.floor(rnd() * 100) } }), 'edit')
        ok(await callers.A.call('PUT', '/api/likes/' + pick(libraryIds()) + '?brief=1'), 'like')
        ok(await callers.B.call('POST', '/api/played', { body: { trackId: pick(libraryIds()) } }), 'play')
        await Promise.all(runs)
        counts.compactions++
      }],
      [1, 'restart', async () => { await restart(false) }],
      [1, 'power cut', async () => { await restart(true) }],
      [1, 'merge', async () => {
        // set-owner --move-data to the other profile: the owner's data merged into it.
        const to = dev[memberKey()].profile.id
        ok(await request(app.ports.http, 'POST', '/api/admin/owner', { body: { profileId: to, moveData: true } }), 'set-owner')
        counts.merges++
      }],
      [2, 'changes during a full answer', async () => {
        const k = pick(['A', 'B'])
        const cp = copies.find((x) => x.name === k + '/delta=1')
        cp.s = null
        const slow = slowGet(app, dev[k], libraryPath(1, null))
        await slow.started
        const ids = libraryIds()
        // Tracks the walk has passed and tracks it has not reached; a like; a playlist.
        app.library.batch(() => {
          for (const id of [ids[0], ids[1], ids[ids.length - 1], ids[ids.length - 2], pick(ids)]) app.library.updateTrack(id, { title: 'Durante ' + Math.floor(rnd() * 1e6) })
        })
        ok(await callers[k].call('PUT', '/api/likes/' + pick(ids) + '?brief=1'), 'like')
        ok(await callers[k].call('POST', '/api/playlists', { body: { name: 'Durante' } }), 'create')
        const r = await slow.finish()
        cp.take(r)
        await settle(app)
        const fresh = await freshOf(callers[k])
        if (JSON.stringify(cp.s.tracks) !== JSON.stringify(fresh.tracks)) counts.stale++
        counts.during++
      }]
    ]
    const total = ops.reduce((n, o) => n + o[0], 0)

    await check('start')
    for (let step = 0; step < STEPS; step++) {
      counts.steps = step + 1
      states.push(logStates(dir))
      if (states.length > 4) states = states.slice(-4)
      let x = rnd() * total
      const op = ops.find((o) => (x -= o[0]) < 0) || ops[0]
      await op[2]()
      await check(op[1])
    }
    const stats = {}
    for (const cp of copies) stats[cp.name] = cp.stats
    return { counts, stats }
  } finally {
    Date.now = realNow
    await app.close()
  }
}

test('equivalence: every copy an app builds from its answers equals a fresh full answer after every step of random histories', { timeout: 1800000 }, async (t) => {
  const seen = { stale: 0, cuts: 0, merges: 0, edits: 0, deltas: 0, during: 0, again: 0, remade: 0 }
  for (let round = 1; round <= ROUNDS; round++) {
    const { counts, stats } = await history(t, round)
    t.diagnostic('seed ' + round + ': ' + JSON.stringify(counts) + ' ' + JSON.stringify(stats))
    seen.stale += counts.stale
    seen.cuts += counts.cuts
    seen.merges += counts.merges
    seen.during += counts.during
    seen.again += counts.again
    seen.remade += counts.remade
    for (const s of Object.values(stats)) {
      assert.equal(s.mismatches, 0, 'an edit that did not fit the copy it was made for')
      seen.edits += s.edits
      seen.deltas += s.delta
    }
  }
  t.diagnostic('in all: ' + JSON.stringify(seen))
  assert.ok(seen.deltas > 0 && seen.edits > 0, 'deltas and edits were sent: ' + JSON.stringify(seen))
  assert.ok(seen.stale > 0, 'a full answer carried a track changed after its piece went out, and the next delta brought it')
  assert.ok(seen.cuts > 0 && seen.merges > 0, 'power cuts and merges were played')
  assert.ok(seen.again > 0 && seen.remade > 0, 'a track and a playlist gone and back between two requests')
})

// --------------------------------------------- versions lost in a power cut

test('a version lost in a power cut and given again by the next run: no 304 on the old tag, and the whole part, never a delta from it', async (t) => {
  const c = cleanup(t)
  const dir = c.dir(tmpDir('mpfy-delta-cut-'))
  // A clock that stands still: each run's first version follows the last one on
  // disk, so the run after the cut gives again the numbers the lost tail had served.
  const realNow = Date.now
  const still = Date.UTC(2026, 3, 1)
  Date.now = () => still
  const opts = { dataDir: dir, port: 0, adminPort: 0, p2p: false, debounceMs: 10, ffmpeg: null, fpcalc: null, sevenZip: null }
  let app = null
  try {
    app = await createMPfy(opts)
    const ids = []
    for (let i = 0; i < 4; i++) ids.push(json(await request(app.ports.http, 'PUT', '/api/upload/c' + i + '.wav', { body: makeWav({ freq: 500 + 30 * i }) })).track.id)
    await request(app.ports.http, 'PUT', '/api/likes/' + ids[0] + '?brief=1')
    const copy = new Copy('local', local(app), 1)
    await copy.sync()
    const libLog = path.join(dir, 'library.log')
    const userLog = path.join(dir, 'users', 'owner.log')
    const kept = { lib: fs.statSync(libLog).size, user: fs.statSync(userLog).size }
    // Two changes of each part reach the app, then never the disk.
    await request(app.ports.http, 'PATCH', '/api/tracks/' + ids[1], { body: { title: 'Perso uno' } })
    await request(app.ports.http, 'PATCH', '/api/tracks/' + ids[2], { body: { title: 'Perso due' } })
    await request(app.ports.http, 'PUT', '/api/likes/' + ids[1] + '?brief=1')
    await request(app.ports.http, 'PUT', '/api/likes/' + ids[2] + '?brief=1')
    await copy.sync()
    const held = copy.s
    await app.close()
    fs.truncateSync(libLog, kept.lib)
    fs.truncateSync(userLog, kept.user)

    app = await createMPfy(opts)
    // The new run's epoch line takes the first lost number, its first change the
    // second: one change of each part, other content, the same version numbers again.
    await request(app.ports.http, 'PATCH', '/api/tracks/' + ids[3], { body: { title: 'Nuovo' } })
    await request(app.ports.http, 'PUT', '/api/likes/' + ids[3] + '?brief=1')
    const fresh = await freshOf(local(app))
    assert.equal(fresh.version, held.version, 'the shared version number is given again')
    assert.equal(fresh.userVersion, held.userVersion, 'the user version number is given again')
    assert.notEqual(fresh.epochs.shared, held.epochs.shared)
    assert.notEqual(fresh.epochs.user, held.epochs.user)

    const r = await request(app.ports.http, 'GET', libraryPath(1, held), { headers: { 'if-none-match': held.etag } })
    assert.equal(r.status, 200, 'the old tag names other epochs: never a 304')
    const a = json(r)
    assert.deepEqual(a.delta, { shared: false, user: false }, 'versions above what their epoch has on disk are not known')
    copy.take(r)
    assert.equal(copy.differs(fresh), null)
  } finally {
    Date.now = realNow
    if (app !== null) await app.close()
  }
})

// --------------------------------------------------------------- old apps

test('apps that read no deltas: today\'s answer, have, 304, HEAD, a request without have, other delta values; they are counted, and the time of the last one survives a restart', async (t) => {
  const { app, dir } = await start(t)
  let now = Date.UTC(2026, 6, 1)
  const counter = new LegacyLibrary(dir, { now: () => now })
  const ctx = {
    library: app.library, users: app.users, people: app.people, social: app.social, chat: app.chat, source: app.source,
    extraHosts: new Set(), staticFiles: null, whoIs: testWhoIs, dataDir: dir, legacyLibrary: counter
  }
  const api = http.createServer(createApiHandler(ctx))
  const admin = http.createServer(createAdminHandler({
    clients: app.clients, transport: () => null, serverPublicKey: app.serverPublicKey, jobs: app.jobs, source: app.source, fingerprints: app.fingerprints,
    sevenZip: app.sevenZip, details: app.details, lyrics: app.lyrics, comments: app.comments, extraHosts: new Set(), legacyLibrary: counter
  }))
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => admin.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => admin.close(() => api.close(resolve))))
  const port = api.address().port
  const health = async () => json(await request(admin.address().port, 'GET', '/admin/health')).legacyLibrary
  const onDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'legacy-library.json'), 'utf8'))
    } catch {
      return null
    }
  }

  assert.deepEqual(await health(), { count: 0, lastAt: null })
  for (let i = 0; i < 2; i++) assert.equal((await request(app.ports.http, 'PUT', '/api/upload/o' + i + '.wav', { body: makeWav({ freq: 700 + i * 20 }) })).status, 200)

  const old = await request(port, 'GET', '/api/library')
  assert.equal(old.status, 200)
  const a = json(old)
  assert.deepEqual(Object.keys(a), OLD_KEY_ORDER, 'no epochs, no delta')
  assert.equal(a.tracks.length, 2)
  assert.equal(old.body.toString(), JSON.stringify(a))
  assert.equal(old.headers['content-length'], String(old.body.length), 'a small answer goes whole, with its length')
  assert.match(old.headers.etag, /^W\/"owner\.\d+\.0\.[0-9a-f]{16}\.0000000000000000"$/, 'both versions and both epochs, for old apps too')
  assert.equal(old.headers['cache-control'], 'no-cache')
  assert.equal(old.headers.vary, 'Accept-Encoding')
  assert.deepEqual(await health(), { count: 1, lastAt: now })
  await counter.settled()
  assert.deepEqual(onDisk(), { lastAt: now }, 'the first one is written at once')

  // have equal to the version: no tracks, only the playlist covers.
  now += 60000
  const fresh = json(await request(port, 'GET', '/api/library?have=' + a.version))
  assert.equal(fresh.tracks, null)
  assert.deepEqual(fresh.covers, { playlist: {} })
  assert.equal((await request(port, 'GET', '/api/library?have=' + (a.version - 1))).status, 200)
  assert.equal((await request(port, 'GET', '/api/library', { headers: { 'if-none-match': old.headers.etag } })).status, 304)
  const head = await request(port, 'HEAD', '/api/library')
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers.etag, old.headers.etag)
  assert.equal(head.headers['content-type'], 'application/json; charset=utf-8')
  // Any other delta value is not a delta: today's answer.
  for (const v of ['0', '3', 'x', '']) assert.deepEqual(Object.keys(json(await request(port, 'GET', '/api/library?delta=' + v))), OLD_KEY_ORDER, 'delta=' + v)
  assert.deepEqual(await health(), { count: 9, lastAt: now }, 'every request without delta=1 or 2 counts, 304s and HEADs too')
  await counter.settled()
  assert.deepEqual(onDisk(), { lastAt: Date.UTC(2026, 6, 1) }, 'at most once an hour')

  // A request with delta is not counted.
  assert.deepEqual(Object.keys(json(await request(port, 'GET', '/api/library?delta=1'))), KEY_ORDER)
  assert.deepEqual(Object.keys(json(await request(port, 'GET', '/api/library?delta=2'))), KEY_ORDER)
  assert.equal((await health()).count, 9)

  now += 3600000
  await request(port, 'GET', '/api/library')
  await counter.settled()
  assert.deepEqual(onDisk(), { lastAt: now }, 'an hour later it is written again')
  now += 5000
  await request(port, 'HEAD', '/api/library')
  await counter.close()
  assert.deepEqual(onDisk(), { lastAt: now }, 'a graceful stop writes the time that moved')
  const again = new LegacyLibrary(dir)
  assert.deepEqual(again.view(), { count: 0, lastAt: now }, 'after a restart: the count from zero, the time kept')
})

// ---------------------------------------------------------- version headers

// Two files of one recording, the second one parked as "maybe" (the fake fpcalc's prints).
function pairFor (seed) {
  const mp3 = makeMp3({ frames: 120, title: seed })
  const wav = makeWav({ seconds: 3, sampleRate: 8000, freq: 200 + (parseInt(hash24(Buffer.from(seed)).slice(0, 4), 16) % 900) })
  const prints = {
    [hash24(mp3)]: { duration: 3.13, fingerprint: fingerprintOf(seed) },
    [hash24(wav)]: { duration: 3.0, fingerprint: fingerprintOf(seed, { flip: 5 }) },
    ['tail:' + hash24(mp3)]: { duration: 3.13, fingerprint: fingerprintOf(seed + '-coda') },
    ['tail:' + hash24(wav)]: { duration: 3.0, fingerprint: fingerprintOf(seed + '-coda', { flip: 2 }) }
  }
  const pcm = { [hash24(mp3)]: { seed, cutoffHz: 16000 }, [hash24(wav)]: { seed } }
  return { mp3, wav, prints, pcm }
}

test('every 2xx of a change carries the version it made (the person\'s or the shared one), a refusal none; DELETE /api/tracks only the shared one', async (t) => {
  const c = cleanup(t)
  const work = c.dir(tmpDir('mpfy-delta-hdr-tools-'))
  const p = pairFor('intestazioni')
  const fpcalc = fakeTool(work, 'fpcalc', { prints: p.prints })
  const ff = fakeFfmpeg(work, { pcm: { seed: 'one version' }, pcmFor: p.pcm })
  const { app } = await start(t, { ffmpeg: ff.command, fpcalc: fpcalc.command })
  await app.jobsStarted
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile(), name: 'Bacca' })
  assert.equal(json(await owner.call('GET', '/api/profile')).role, 'owner')
  const sara = device(app, { profile: makeProfile(), name: 'Sara' })
  await sara.call('GET', '/api/profile')

  // What the library says now, for that device.
  const now = async (dev) => {
    await settle(app)
    return json(await dev.call('GET', '/api/library?delta=1'))
  }
  const userChange = async (dev, method, urlPath, body = null) => {
    const r = await dev.call(method, urlPath, { body })
    assert.ok(r.status >= 200 && r.status < 300, method + ' ' + urlPath + ' ' + r.status + ' ' + r.body.toString().slice(0, 200))
    const lib = await now(dev)
    assert.equal(r.headers['x-mpfy-user-version'], String(lib.userVersion), method + ' ' + urlPath)
    assert.equal(r.headers['x-mpfy-user-epoch'], lib.epochs.user, method + ' ' + urlPath)
    assert.equal(r.headers['x-mpfy-version'], undefined, method + ' ' + urlPath + ': no shared version')
    return r
  }
  const sharedChange = async (dev, method, urlPath, body = null, check = true) => {
    const r = await dev.call(method, urlPath, { body })
    assert.ok(r.status >= 200 && r.status < 300, method + ' ' + urlPath + ' ' + r.status + ' ' + r.body.toString().slice(0, 200))
    if (check) {
      const lib = await now(dev)
      assert.ok(Number(r.headers['x-mpfy-version']) <= lib.version && Number(r.headers['x-mpfy-version']) > 0, method + ' ' + urlPath)
      assert.equal(r.headers['x-mpfy-epoch'], lib.epochs.shared, method + ' ' + urlPath)
    }
    assert.equal(r.headers['x-mpfy-user-version'], undefined, method + ' ' + urlPath + ': no user version')
    return r
  }

  const up = json(await sharedChange(owner, 'PUT', '/api/upload/a.mp3', p.mp3))
  const id = up.track.id
  const before = await now(owner)
  const edited = await sharedChange(owner, 'PATCH', '/api/tracks/' + id, { title: 'Nuovo' })
  assert.equal(Number(edited.headers['x-mpfy-version']), before.version + 1, 'the version of that change')
  await sharedChange(owner, 'PUT', '/api/lyrics/' + id, 'Una riga\nE poi un\'altra')
  await sharedChange(owner, 'DELETE', '/api/lyrics/' + id)
  await sharedChange(owner, 'PUT', '/api/cover-for/track/' + id + '?size=small', fakeJpeg(1, 900))
  await sharedChange(owner, 'DELETE', '/api/cover-for/track/' + id)
  const album = albumIdOf(app.library.getTrack(id))
  await sharedChange(owner, 'PUT', '/api/cover-for/album/' + album + '?size=large', fakeJpeg(2, 900))
  await sharedChange(owner, 'DELETE', '/api/cover-for/album/' + album)

  // A session: the piece that finishes it carries the version, an earlier piece not.
  const wav = makeWav({ seconds: 1, freq: 640 })
  const s = json(await sara.call('POST', '/api/uploads', { body: { name: 'b.wav', size: wav.length, lastModified: 1, headHash: crypto.createHash('sha256').update(wav.subarray(0, 65536)).digest('hex') } }))
  const half = Math.floor(wav.length / 2)
  const part = await sara.call('PUT', '/api/uploads/' + s.id + '?offset=0', { body: wav.subarray(0, half) })
  assert.equal(part.status, 200)
  assert.equal(part.headers['x-mpfy-version'], undefined, 'a piece that does not finish the upload')
  const last = await sharedChange(sara, 'PUT', '/api/uploads/' + s.id + '?offset=' + half, wav.subarray(half))
  assert.equal(json(last).done, true)
  // A file parked as "maybe", then the answer to it.
  const maybe = json(await sharedChange(sara, 'PUT', '/api/upload/a.wav', p.wav))
  assert.equal(maybe.outcome, 'maybe')
  await sharedChange(sara, 'POST', '/api/pending/' + maybe.pending.id, { keep: 'both' })
  // A member's own track: its delete carries the shared version only.
  const mine = json(await sharedChange(sara, 'PUT', '/api/upload/c.wav', makeWav({ freq: 820 }))).track.id
  await sharedChange(sara, 'DELETE', '/api/tracks/' + mine)
  await sharedChange(owner, 'DELETE', '/api/tracks/' + json(last).result.track.id)

  // The person's changes.
  const pl = json(await userChange(owner, 'POST', '/api/playlists', { name: 'Prova' })).playlist.id
  await userChange(owner, 'PATCH', '/api/playlists/' + pl, { name: 'Prova due' })
  await userChange(owner, 'POST', '/api/playlists/' + pl + '/tracks', { trackIds: [id, id] })
  await userChange(owner, 'DELETE', '/api/playlists/' + pl + '/tracks', { indexes: [1], ids: [id] })
  await userChange(owner, 'PUT', '/api/cover-for/playlist/' + pl + '?size=small', fakeJpeg(3, 900))
  await userChange(owner, 'DELETE', '/api/cover-for/playlist/' + pl)
  await userChange(owner, 'PUT', '/api/likes/' + id)
  await userChange(owner, 'PUT', '/api/likes/' + id + '?brief=1')
  await userChange(owner, 'DELETE', '/api/likes/' + id + '?brief=1')
  await userChange(owner, 'DELETE', '/api/likes/' + id)
  await userChange(owner, 'POST', '/api/likes', { add: [id] })
  await userChange(owner, 'POST', '/api/played', { trackId: id })
  await userChange(owner, 'DELETE', '/api/playlists/' + pl)
  // A change that changes nothing carries the current version.
  const same = await userChange(owner, 'PUT', '/api/likes/' + id + '?brief=1')
  const again = await userChange(owner, 'PUT', '/api/likes/' + id + '?brief=1')
  assert.equal(again.headers['x-mpfy-user-version'], same.headers['x-mpfy-user-version'])

  // Refusals carry neither.
  for (const [dev, method, urlPath, body] of [
    [owner, 'PATCH', '/api/playlists/' + pl, { name: 'x' }],
    [owner, 'PUT', '/api/likes/zz?brief=1', null],
    [owner, 'POST', '/api/likes', { add: ['zz'] }],
    [owner, 'POST', '/api/played', { trackId: 'zz' }],
    [sara, 'PATCH', '/api/tracks/' + id, { title: 'non mia' }],
    [owner, 'DELETE', '/api/tracks/' + 'ab'.repeat(12), null],
    [owner, 'PUT', '/api/lyrics/' + 'ab'.repeat(12), 'testo']
  ]) {
    const r = await dev.call(method, urlPath, { body })
    assert.ok(r.status >= 400, method + ' ' + urlPath + ' refused')
    for (const h of ['x-mpfy-version', 'x-mpfy-epoch', 'x-mpfy-user-version', 'x-mpfy-user-epoch']) assert.equal(r.headers[h], undefined, method + ' ' + urlPath + ' ' + h)
  }
})

// ------------------------------------------------------------ bulk likes

test('POST /api/likes: removes then adds in order, each the newest; a liked id stays; twice counts once; in both lists it becomes the newest; one version; refusals change nothing', async (t) => {
  const { app } = await start(t)
  app.people.openClaim(30)
  const owner = device(app, { profile: makeProfile() })
  await owner.call('GET', '/api/profile')
  const T = (n) => n.toString(16).padStart(24, '0')
  const likes = async () => json(await owner.call('GET', '/api/library?delta=1')).likes.map((l) => l.id)
  const bulk = (body) => owner.call('POST', '/api/likes', { body })

  let r = await bulk({ add: [T(1), T(2), T(3)] })
  assert.deepEqual(json(r), { ok: true, added: 3, removed: 0 })
  assert.deepEqual(await likes(), [T(3), T(2), T(1)], 'in the given order, each the newest')
  const v = Number(r.headers['x-mpfy-user-version'])
  r = await bulk({ add: [T(4), T(2), T(5), T(5)] })
  assert.deepEqual(json(r), { ok: true, added: 2, removed: 0 }, 'a liked id stays, one given twice counts once')
  assert.equal(Number(r.headers['x-mpfy-user-version']), v + 1, 'one version for the request')
  assert.deepEqual(await likes(), [T(5), T(4), T(3), T(2), T(1)])
  r = await bulk({ remove: [T(1), T(3), T(9)], add: [T(3)] })
  assert.deepEqual(json(r), { ok: true, added: 1, removed: 2 }, 'only what was there is removed')
  assert.deepEqual(await likes(), [T(3), T(5), T(4), T(2)], 'in both lists: removed, then added as the newest')
  const lib = json(await owner.call('GET', '/api/library?delta=1'))
  const at = lib.likes[0].at
  assert.equal(lib.likes.find((l) => l.id === T(5)).at, lib.likes.find((l) => l.id === T(4)).at, 'the request\'s time for each like it added')
  assert.ok(at >= lib.likes[1].at)
  r = await bulk({})
  assert.deepEqual(json(r), { ok: true, added: 0, removed: 0 })
  assert.equal(Number(r.headers['x-mpfy-user-version']), lib.userVersion, 'nothing to do: the current version')

  for (const [body, error, code] of [
    [{ add: [T(7), 'nonvalido'] }, 'Identificativo del brano non valido', undefined],
    [{ remove: ['x'] }, 'Identificativo del brano non valido', undefined],
    [[T(7)], 'Richiesta non valida', 'bad_request'],
    [{ add: T(7) }, 'Richiesta non valida', 'bad_request'],
    [{ add: Array.from({ length: 5001 }, (_, i) => T(100 + i)) }, 'Richiesta non valida', 'bad_request'],
    [{ add: Array.from({ length: 3000 }, (_, i) => T(100 + i)), remove: Array.from({ length: 2001 }, (_, i) => T(9000 + i)) }, 'Richiesta non valida', 'bad_request'],
    ['{"add": [', 'Richiesta non valida', 'bad_request']
  ]) {
    const res = await bulk(body)
    assert.equal(res.status, 400)
    assert.deepEqual(json(res), code ? { error, code } : { error })
  }
  assert.deepEqual(await likes(), [T(3), T(5), T(4), T(2)], 'nothing done by a refusal')
  assert.equal(json(await owner.call('GET', '/api/library?delta=1')).userVersion, lib.userVersion)
  assert.equal((await bulk({ add: Array.from({ length: 5000 }, (_, i) => T(100 + i)) })).status, 200, '5,000 ids in one request')
})

// ------------------------------------------------------------ delta answers

test('delta answers: the key order, epochs always, the shared part null when it did not move, an unchanged user part an empty delta, more than half the tracks moved is the whole part, malformed values are not known', async (t) => {
  const { app } = await start(t)
  const port = app.ports.http
  const get = async (q, headers = {}) => request(port, 'GET', '/api/library' + q, { headers })
  const ids = []
  for (let i = 0; i < 4; i++) ids.push(json(await request(port, 'PUT', '/api/upload/d' + i + '.wav', { body: makeWav({ freq: 900 + 20 * i }) })).track.id)
  await request(port, 'PUT', '/api/likes/' + ids[0] + '?brief=1')
  const pl = json(await request(port, 'POST', '/api/playlists', { body: { name: 'Una' } })).playlist

  const first = await get('?delta=1')
  const a = json(first)
  assert.deepEqual(Object.keys(a), KEY_ORDER)
  assert.deepEqual(a.delta, { shared: false, user: false }, 'nothing held: the whole parts')
  assert.equal(first.body.toString(), JSON.stringify(a))
  assert.equal(first.headers.etag, 'W/"owner.' + a.version + '.' + a.userVersion + '.' + a.epochs.shared + '.' + a.epochs.user + '"')
  assert.deepEqual(Object.keys(a.covers), ['track', 'album', 'playlist'])
  const q = (x, extra = '') => '?delta=1&have=' + x.version + '&he=' + x.epochs.shared + '&uv=' + x.userVersion + '&ue=' + x.epochs.user + extra

  // Nothing moved: a 304 with the tag; without it, null tracks and an empty user delta.
  assert.equal((await get(q(a), { 'if-none-match': first.headers.etag })).status, 304)
  const same = json(await get(q(a)))
  assert.deepEqual(same.delta, { shared: false, user: true })
  assert.equal(same.tracks, null)
  assert.deepEqual(same.covers, { playlist: {} })
  assert.deepEqual([same.playlists, same.likes, same.recents], [{ changed: [], removed: [] }, { added: [], removed: [] }, null])
  const head = await request(port, 'HEAD', '/api/library' + q(a))
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers.etag, first.headers.etag)

  // One track and the playlist moved.
  await request(port, 'PATCH', '/api/tracks/' + ids[1], { body: { title: 'Cambiato' } })
  await request(port, 'PATCH', '/api/playlists/' + pl.id, { body: { name: 'Due' } })
  await request(port, 'POST', '/api/played', { body: { trackId: ids[2] } })
  const one = json(await get(q(a)))
  assert.deepEqual(one.delta, { shared: true, user: true })
  assert.deepEqual(one.tracks.changed.map((x) => x.title), ['Cambiato'])
  assert.deepEqual(one.playlists.changed.map((x) => x.name), ['Due'])
  assert.equal('edits' in one.playlists, false, 'edits only with delta=2')
  assert.equal(one.recents.length, 1, 'the plays moved: the newest 50')
  assert.deepEqual(json(await get(q(a).replace('delta=1', 'delta=2'))).playlists.edits, [], 'delta=2 has edits (none here)')

  // More than half the tracks: the whole part.
  for (const id of ids.slice(0, 3)) await request(port, 'PATCH', '/api/tracks/' + id, { body: { album: 'Altro' } })
  const most = json(await get(q(a)))
  assert.equal(most.delta.shared, false)
  assert.equal(most.tracks.length, 4)
  assert.deepEqual(Object.keys(most.covers), ['track', 'album', 'playlist'])

  // Malformed values are not known: that part whole, never an error.
  const b = json(await get('?delta=1'))
  const held = { have: b.version, he: b.epochs.shared, uv: b.userVersion, ue: b.epochs.user }
  for (const [k, bad] of [['have', 'abc'], ['have', '-1'], ['have', '99999999999999999'], ['have', '1.5'], ['have', ''], ['he', 'XYZ'],
    ['he', '0'.repeat(17)], ['he', 'ABCDEF0123456789'], ['uv', 'abc'], ['uv', '1e3'], ['ue', 'zz'], ['ue', '']]) {
    const qs = Object.entries({ ...held, [k]: bad }).map(([n, v]) => n + '=' + encodeURIComponent(v)).join('&')
    const r = await get('?delta=1&' + qs)
    assert.equal(r.status, 200, k + '=' + bad)
    const x = json(r)
    if (k === 'have' || k === 'he') assert.ok(x.delta.shared === false && Array.isArray(x.tracks) && x.delta.user === true, k + '=' + bad + ': the whole shared part')
    else assert.ok(x.delta.user === false && x.tracks === null, k + '=' + bad + ': the whole user part')
  }
  const other = json(await get('?delta=1&have=' + a.version + '&he=' + '1'.repeat(16) + '&uv=' + a.userVersion + '&ue=' + '2'.repeat(16)))
  assert.deepEqual(other.delta, { shared: false, user: false }, 'epochs this source never had')
  assert.ok(Array.isArray(other.tracks))

  // gzip on a delta answer as on any other.
  const z = await get(q(a), { 'accept-encoding': 'gzip' })
  assert.equal(z.headers['content-encoding'], 'gzip')
  assert.deepEqual(JSON.parse(zlib.gunzipSync(z.body).toString()), json(await get(q(a))))
})

test('a large answer is streamed (no length, gzip as asked) and equals the same answer built whole; a reader gone midway stops it', async (t) => {
  const { app, dir } = await start(t)
  const tracks = []
  for (let i = 0; i < 4000; i++) tracks.push(putFile(dir, fakeTrack(hex24(7000000 + i))))
  addMany(app.library, tracks)
  const port = app.ports.http
  const plain = await request(port, 'GET', '/api/library')
  assert.equal(plain.status, 200)
  assert.equal(plain.headers['content-length'], undefined, 'streamed')
  assert.equal(plain.headers['transfer-encoding'], 'chunked')
  const a = json(plain)
  assert.equal(a.tracks.length, 4000)
  assert.equal(plain.body.toString(), JSON.stringify(a), 'the same bytes JSON.stringify gives')
  assert.deepEqual(a.tracks.map((x) => x.id), [...app.library.tracks.keys()], 'in the library\'s order')
  const z = await request(port, 'GET', '/api/library', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(z.headers['content-encoding'], 'gzip')
  assert.equal(zlib.gunzipSync(z.body).toString(), plain.body.toString())
  // A whole-likes answer over the size is streamed the same way.
  const likes = await request(port, 'POST', '/api/likes', { body: { add: tracks.slice(0, 5000).map((x) => x.id) } })
  assert.equal(likes.status, 200)
  for (let i = 0; i < 4; i++) await request(port, 'POST', '/api/likes', { body: { add: Array.from({ length: 5000 }, (_, k) => hex24(9000000 + i * 5000 + k)) } })
  const whole = await request(port, 'PUT', '/api/likes/' + tracks[0].id)
  assert.equal(whole.headers['content-length'], undefined)
  assert.equal(json(whole).likes.length, 24000)
  assert.equal(whole.body.toString(), JSON.stringify(json(whole)))

  // A reader that goes away: the source stops writing and keeps serving.
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/library', agent: false }, (res) => {
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.end()
  })
  await sleep(100)
  assert.equal((await request(port, 'GET', '/api/library?delta=1')).status, 200)
})
