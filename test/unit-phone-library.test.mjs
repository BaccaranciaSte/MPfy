// "Locale", the phone's own music, in the core (client-core/phone.js): the feed
// from the host (batches, acks after the sync, resends), Locale's library log
// (versions, epochs, tombstones, the horizon, compaction, a start that reads one
// line, a cut line repaired), the source's answers to /api/library with and
// without deltas (a client applying them equals a fresh full answer after every
// step of random histories with restarts, resends and compactions), the served
// track (the server's buildTrack and publicTrack for the same file), lyrics,
// covers, the details switch, the home, and the core's seams (/local/sources,
// the sources event, /s/0000). Every lyric line in here is invented.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClientCore } from '../client-core/index.js'
import { PhoneSource, PHONE_ID, ZERO_EPOCH } from '../client-core/phone.js'
import { Library } from '../server/library.mjs'
import * as media from '../server/media.mjs'
import * as ids from '../server/ids.mjs'
import { lyricsFromTags } from '../server/lrc.mjs'
import { tmpDir, cleanup, request, json, waitFor } from './helpers.mjs'

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const LINES = ['Lascio il molo al buio', 'Il vento sa il mio nome', 'Torno quando il mare dorme']
const PROFILE = 'ab'.repeat(16)

// ------------------------------------------------------------------ helpers

const idOf = (n) => n.toString(16).padStart(24, '0')

/** Facts of a file as the host sends them. */
function facts (n, extra = {}) {
  return {
    id: idOf(n),
    name: 'Canzone ' + n + '.mp3',
    size: 4000000 + n,
    mtime: 1763380000000,
    addedAt: 1763380000000 + n,
    tags: { title: 'Titolo ' + n, artist: 'Lumen Marino', album: 'Ultimo traghetto', albumArtist: null, trackNo: (n % 12) + 1, discNo: 1, year: 2019 },
    format: 'mp3',
    codec: 'audio/mpeg',
    duration: 180 + n,
    bitrate: 320000,
    sampleRate: 44100,
    bitDepth: null,
    coverId: null,
    lyrics: { synced: [], texts: [], lrc: null },
    was: [],
    ...extra
  }
}

// The core's side, without a network: it answers into the connection object.
class FakeHost {
  constructor () {
    this.homeId = PHONE_ID
    this.sources = []
    this.forwards = []
    this.logs = []
  }

  profileId () { return PROFILE }
  realSources () { return this.sources }
  home () { return this.homeId }
  forward (conn, req, fwd) {
    this.forwards.push(fwd)
    conn.res = { status: 'forwarded', fwd }
  }

  send (conn, status, headers, body) { conn.res = { status, headers, body: body === null ? null : Buffer.from(body) } }
  json (conn, status, obj, headers = {}) { conn.res = { status, headers: headers || {}, body: Buffer.from(JSON.stringify(obj)) } }
  async pieces (conn, status, headers, pieces) {
    let text = ''
    for (const p of pieces) text += p
    conn.res = { status, headers, body: Buffer.from(text) }
  }

  readBody (conn, req, rest) { return Promise.resolve(rest) }
  log (line) { this.logs.push(line) }
}

// Every phone opened is stopped when its test ends (stop() twice is harmless).
const opened = new Set()
test.afterEach(async () => {
  for (const p of [...opened]) await p.stop()
  opened.clear()
})

function open (dir, { host = new FakeHost(), sent = [], files = undefined, now = undefined, lookups = { fillDelayMs: 3600000 } } = {}) {
  const phone = new PhoneSource({ dir, artDir: path.join(dir, '..', 'host-art'), send: (m) => sent.push(m), host, fs: files, now, lookups })
  opened.add(phone)
  phone.start()
  return { phone, host, sent }
}

async function ask (phone, method, target, { headers = {}, body = null } = {}) {
  const map = {}
  for (const [k, v] of Object.entries(headers)) map[k.toLowerCase()] = v
  const conn = {}
  await phone.handle(conn, { method, map }, target, body === null ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  const res = conn.res
  if (res && res.body && res.body.length > 0 && /json/.test(String((res.headers || {})['Content-Type'] || 'json'))) {
    try {
      res.data = JSON.parse(res.body.toString('utf8'))
    } catch {}
  }
  return res
}

// The feed as the host sends it, waiting for each batch to land.
async function feed (phone, ...msgs) {
  for (const m of msgs) phone.message({ t: 'local', ...m })
  await phone.settled()
}

const acks = (sent) => sent.filter((m) => m.t === 'local-ack').map((m) => m.batch)

// A client as the page applies an answer: removals first, then changes in place and additions at the end.
class Client {
  constructor () {
    this.tracks = new Map()
    this.version = null
    this.epoch = null
  }

  query () {
    return '/api/library?delta=1' + (this.version !== null ? '&have=' + this.version + '&he=' + this.epoch : '')
  }

  apply (a) {
    if (a.tracks === null) {
      // the shared part held is current
    } else if (a.delta.shared === true) {
      for (const id of a.tracks.removed) this.tracks.delete(id)
      for (const t of a.tracks.changed) this.tracks.set(t.id, t)
    } else {
      this.tracks = new Map(a.tracks.map((t) => [t.id, t]))
    }
    this.version = a.version
    this.epoch = a.epochs.shared
  }
}

async function full (phone) {
  return (await ask(phone, 'GET', '/api/library?delta=1')).data.tracks
}

// ------------------------------------------------------------------- the feed

test('the feed: each batch moves the version by one, equal facts move nothing, a drop is a tombstone; acks after the sync', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'state.json.phone')
  const { phone, sent } = open(dir)
  t.after(() => phone.stop())
  phone.hello()
  assert.deepEqual(sent[0], { t: 'local-hello', token: null, batch: 0 }, 'a new log has no feed yet')
  const v0 = phone.version
  await feed(phone, { op: 'reset', token: 'k1' })
  assert.equal(phone.version, v0, 'a reset moves no version')
  await feed(phone, { op: 'put', token: 'k1', batch: 1, tracks: [facts(1), facts(2)] })
  assert.equal(phone.version, v0 + 1)
  await feed(phone, { op: 'put', token: 'k1', batch: 2, tracks: [facts(3)] })
  assert.equal(phone.version, v0 + 2)
  await feed(phone, { op: 'end', token: 'k1', batch: 3 })
  assert.equal(phone.version, v0 + 2, 'every track was put: nothing dropped, nothing moves')
  await feed(phone, { op: 'put', token: 'k1', batch: 4, tracks: [facts(1), facts(2)] })
  assert.equal(phone.version, v0 + 2, 'a put of equal facts writes no change')
  await feed(phone, { op: 'put', token: 'k1', batch: 5, tracks: [facts(2, { size: 1 })] })
  assert.equal(phone.version, v0 + 3)
  await feed(phone, { op: 'drop', token: 'k1', batch: 6, ids: [idOf(3), idOf(99)] })
  assert.equal(phone.version, v0 + 4)
  assert.deepEqual(acks(sent), [1, 2, 3, 4, 5, 6])
  const log = fs.readFileSync(path.join(dir, 'library.log'), 'utf8')
  assert.ok(log.includes('[' + (v0 + 4) + ',"t:' + idOf(3) + '"]'), 'the tombstone line')
  assert.equal(phone.entry().tracks, 2)
  // Again after an ack lost: the same batch is acked, nothing applied twice.
  await feed(phone, { op: 'put', token: 'k1', batch: 5, tracks: [facts(2, { size: 2 })] })
  assert.equal(phone.version, v0 + 4)
  assert.deepEqual(acks(sent).slice(-1), [5])
  // Another token, without a reset: not this feed.
  await feed(phone, { op: 'put', token: 'k2', batch: 7, tracks: [facts(9)] })
  assert.equal(phone.version, v0 + 4)
  assert.equal(acks(sent).length, 7)
})

test('no ack before the sync: a log whose fdatasync fails acks nothing, and the batch sent again lands', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  let failing = true
  const files = { ...fs, fdatasync: (fd, cb) => (failing ? setImmediate(() => cb(Object.assign(new Error('EIO'), { code: 'EIO' }))) : fs.fdatasync(fd, cb)) }
  const { phone, sent } = open(dir, { files })
  t.after(() => phone.stop())
  await feed(phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: [facts(1)] })
  assert.deepEqual(acks(sent), [], 'no ack while the sync fails')
  failing = false
  await feed(phone, { op: 'put', token: 'k', batch: 1, tracks: [facts(1)] })
  assert.deepEqual(acks(sent), [1], 'sent again: synced, acked')
})

test('a resend: at its end every track not put since its reset is dropped; a crash in between keeps the ids put so far', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  let o = open(dir)
  await feed(o.phone, { op: 'reset', token: 'a' }, { op: 'put', token: 'a', batch: 1, tracks: [1, 2, 3, 4].map((n) => facts(n)) }, { op: 'end', token: 'a', batch: 2 })
  // The host lost its database: a new token, the files it has now are 1, 2 and 5.
  await feed(o.phone, { op: 'reset', token: 'b' }, { op: 'put', token: 'b', batch: 1, tracks: [facts(1)] })
  await o.phone.stop()
  // Restarted between the reset and its end: the core says where it is.
  o = open(dir)
  t.after(() => o.phone.stop())
  o.phone.hello()
  assert.deepEqual(o.sent[0], { t: 'local-hello', token: 'b', batch: 1 })
  await feed(o.phone, { op: 'put', token: 'b', batch: 2, tracks: [facts(2), facts(5)] }, { op: 'end', token: 'b', batch: 3 })
  assert.deepEqual((await full(o.phone)).map((x) => x.id), [idOf(1), idOf(2), idOf(5)], 'the ids put before the restart stayed, 3 and 4 dropped')
  assert.deepEqual(acks(o.sent), [2, 3])
  // An end acked again after its ack was lost drops nothing more.
  await feed(o.phone, { op: 'end', token: 'b', batch: 3 })
  assert.equal((await full(o.phone)).length, 3)
})

// -------------------------------------------------------------- the answers

test('/api/library: the full answer, tracks null when have is current, 304 by ETag, deltas since a version, the full part for an epoch or version it cannot prove', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  const { phone } = open(dir)
  t.after(() => phone.stop())
  await feed(phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: [1, 2, 3, 4, 5].map((n) => facts(n)) }, { op: 'end', token: 'k', batch: 2 })
  // Today's answer, without delta.
  let r = await ask(phone, 'GET', '/api/library')
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.data), ['version', 'userVersion', 'tracks', 'playlists', 'likes', 'recents', 'covers', 'you', 'source'])
  assert.equal(r.data.tracks.length, 5)
  assert.deepEqual(r.data.covers, { track: {}, album: {}, playlist: {} })
  assert.deepEqual(r.data.source, { name: 'Locale', named: true, details: true, social: 0 })
  assert.equal(r.data.you, null)
  assert.equal(r.headers.ETag, 'W/"' + PROFILE + '.' + phone.version + '.0.' + phone.epoch.id + '.' + ZERO_EPOCH + '"')
  assert.equal(r.headers['Cache-Control'], 'no-cache')
  assert.equal(r.headers.Vary, 'Accept-Encoding')
  assert.equal(r.headers['Content-Encoding'], undefined, 'never gzip')
  const tag = r.headers.ETag
  r = await ask(phone, 'GET', '/api/library?have=' + phone.version)
  assert.equal(r.data.tracks, null)
  assert.deepEqual(r.data.covers, { playlist: {} })
  r = await ask(phone, 'GET', '/api/library?delta=1', { headers: { 'If-None-Match': tag } })
  assert.equal(r.status, 304)
  assert.equal(r.body, null)
  r = await ask(phone, 'HEAD', '/api/library?delta=1')
  assert.equal(r.status, 200)
  // A delta answer.
  r = await ask(phone, 'GET', '/api/library?delta=1')
  const a = r.data
  assert.deepEqual(Object.keys(a), ['version', 'userVersion', 'epochs', 'delta', 'tracks', 'playlists', 'likes', 'recents', 'covers', 'you', 'source'])
  assert.deepEqual(a.delta, { shared: false, user: false })
  assert.deepEqual(a.epochs, { shared: phone.epoch.id, user: ZERO_EPOCH })
  r = await ask(phone, 'GET', '/api/library?delta=1&have=' + a.version + '&he=' + a.epochs.shared)
  assert.equal(r.data.tracks, null)
  assert.deepEqual(r.data.delta, { shared: false, user: false })
  assert.deepEqual(r.data.covers, { playlist: {} })
  await feed(phone, { op: 'put', token: 'k', batch: 3, tracks: [facts(2, { size: 5 }), facts(6)] }, { op: 'drop', token: 'k', batch: 4, ids: [idOf(4)] })
  r = await ask(phone, 'GET', '/api/library?delta=2&have=' + a.version + '&he=' + a.epochs.shared + '&uv=0&ue=' + ZERO_EPOCH)
  assert.deepEqual(r.data.delta, { shared: true, user: false })
  assert.deepEqual(r.data.tracks.changed.map((x) => x.id), [idOf(2), idOf(6)], 'only the moved tracks, in the library\'s order')
  assert.deepEqual(r.data.tracks.removed, [idOf(4)])
  assert.deepEqual(r.data.covers, { track: {}, album: {}, playlist: {} })
  // What it cannot prove: another epoch, a version outside the range, malformed values.
  for (const q of ['&have=' + a.version + '&he=' + 'f'.repeat(16), '&have=' + (phone.version + 5) + '&he=' + a.epochs.shared, '&have=x&he=' + a.epochs.shared, '&have=' + a.version + '&he=ZZ']) {
    r = await ask(phone, 'GET', '/api/library?delta=1' + q)
    assert.equal(r.status, 200)
    assert.equal(r.data.delta.shared, false, q)
    assert.equal(r.data.tracks.length, 5, q)
  }
  // More than half the tracks moved: the full part.
  await feed(phone, { op: 'put', token: 'k', batch: 5, tracks: [1, 2, 3, 5].map((n) => facts(n, { size: 9 })) })
  r = await ask(phone, 'GET', '/api/library?delta=1&have=' + (phone.version - 1) + '&he=' + phone.epoch.id)
  assert.equal(r.data.delta.shared, false)
})

test('deltas over a restart, a compaction and a cut line; the horizon of dropped tombstones; a start reads the last line only', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  let o = open(dir)
  await feed(o.phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: [1, 2, 3, 4].map((n) => facts(n)) }, { op: 'end', token: 'k', batch: 2 })
  const a = (await ask(o.phone, 'GET', '/api/library?delta=1')).data
  await o.phone.stop()
  // A start: only the end of the log is read.
  const reads = { whole: 0, bytes: 0 }
  const spy = { ...fs, readFileSync: (f, ...rest) => { if (String(f).endsWith('library.log')) reads.whole++; return fs.readFileSync(f, ...rest) }, readSync: (fd, buf, ...rest) => { const n = fs.readSync(fd, buf, ...rest); reads.bytes += n; return n } }
  o = open(dir, { files: spy })
  assert.equal(o.phone.loaded, false)
  assert.equal(o.phone.version, a.version)
  assert.equal(o.phone.entry().tracks, 4)
  let r = await ask(o.phone, 'GET', '/api/library?delta=1&have=' + a.version + '&he=' + a.epochs.shared)
  assert.equal(r.data.tracks, null)
  assert.equal(reads.whole, 0, 'a client that is current costs no read of the log')
  assert.ok(reads.bytes <= 64 * 1024, 'the start read ' + reads.bytes + ' bytes')
  // A change after the restart: a delta across the restart, a new epoch for it.
  await feed(o.phone, { op: 'put', token: 'k', batch: 3, tracks: [facts(5)] })
  assert.notEqual(o.phone.epoch.id, a.epochs.shared, 'the run that changed the log opened its own epoch')
  r = await ask(o.phone, 'GET', '/api/library?delta=1&have=' + a.version + '&he=' + a.epochs.shared)
  assert.equal(r.data.delta.shared, true, 'no full part after a restart')
  assert.deepEqual(r.data.tracks.changed.map((x) => x.id), [idOf(5)])
  const b = r.data
  // Compaction keeps versions, epochs and the order.
  await o.phone._enqueue(() => o.phone._compact())
  const text = fs.readFileSync(path.join(dir, 'library.log'), 'utf8')
  assert.match(text.split('\n')[1], /^\{"ep":/)
  r = await ask(o.phone, 'GET', '/api/library?delta=1&have=' + a.version + '&he=' + a.epochs.shared)
  assert.deepEqual(r.data.tracks.changed.map((x) => x.id), [idOf(5)])
  await o.phone.stop()
  // A last line cut by a crash: dropped at the next read, the log works.
  fs.appendFileSync(path.join(dir, 'library.log'), '[' + (b.version + 1) + ',"t:' + idOf(7) + '",{"id":')
  o = open(dir)
  t.after(() => o.phone.stop())
  assert.equal(o.phone.loaded, true, 'a log whose last line is not its summary is read whole')
  r = await ask(o.phone, 'GET', '/api/library?delta=1&have=' + b.version + '&he=' + b.epochs.shared)
  assert.equal(r.data.tracks, null, 'the cut line is gone, the version where it was')
  assert.deepEqual((await full(o.phone)).map((x) => x.id), [1, 2, 3, 4, 5].map(idOf))
  assert.ok(fs.readFileSync(path.join(dir, 'library.log'), 'utf8').endsWith('}\n'))
})

test('the horizon: a client older than the tombstones kept gets the full part', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  const { phone } = open(dir)
  t.after(() => phone.stop())
  await feed(phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: [facts(1), facts(2)] }, { op: 'end', token: 'k', batch: 2 })
  const a = (await ask(phone, 'GET', '/api/library?delta=1')).data
  await feed(phone, { op: 'drop', token: 'k', batch: 3, ids: [idOf(2)] })
  // Pretend the tombstones of up to now were dropped (as past the 10,000 kept).
  phone._horizon = phone.version
  let r = await ask(phone, 'GET', '/api/library?delta=1&have=' + a.version + '&he=' + a.epochs.shared)
  assert.equal(r.data.delta.shared, false)
  r = await ask(phone, 'GET', '/api/library?delta=1&have=' + phone.version + '&he=' + phone.epoch.id)
  assert.equal(r.data.tracks, null)
})

test('a client applying the answers equals a fresh full answer after every step of random histories, with restarts, resends and compactions', async (t) => {
  const base = cleanup(t).dir(tmpDir('mpfy-phone-'))
  let seed = 4242
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let run = 0; run < 6; run++) {
    const dir = path.join(base, 'run' + run)
    let o = open(dir)
    let token = 't' + run
    let batch = 0
    const live = new Map() // id -> facts the host holds
    const clients = [new Client(), new Client()]
    await feed(o.phone, { op: 'reset', token })
    for (let step = 0; step < 60; step++) {
      const x = rnd()
      if (x < 0.4) {
        const list = []
        for (let i = 0; i < 1 + Math.floor(rnd() * 6); i++) {
          const n = 1 + Math.floor(rnd() * 30)
          const F = facts(n, rnd() < 0.5 ? { size: Math.floor(rnd() * 3) } : {})
          live.set(F.id, F)
          list.push(F)
        }
        await feed(o.phone, { op: 'put', token, batch: ++batch, tracks: list })
      } else if (x < 0.6 && live.size > 0) {
        const gone = [...live.keys()].filter(() => rnd() < 0.3)
        for (const id of gone) live.delete(id)
        await feed(o.phone, { op: 'drop', token, batch: ++batch, ids: gone })
      } else if (x < 0.7) {
        // A full resend with a new token: what the host still has, some changed.
        token = 't' + run + '-' + step
        batch = 0
        for (const id of [...live.keys()]) if (rnd() < 0.2) live.delete(id)
        const all = [...live.values()]
        await feed(o.phone, { op: 'reset', token })
        for (let i = 0; i < all.length; i += 4) await feed(o.phone, { op: 'put', token, batch: ++batch, tracks: all.slice(i, i + 4) })
        if (rnd() < 0.3) {
          // A crash before the end: the core starts again from its log.
          await o.phone.stop()
          o = open(dir)
        }
        await feed(o.phone, { op: 'end', token, batch: ++batch })
      } else if (x < 0.8) {
        await o.phone.stop()
        o = open(dir)
      } else if (x < 0.9) {
        await o.phone._enqueue(() => o.phone._compact())
      }
      const c = clients[step % 2]
      const r = await ask(o.phone, 'GET', c.query())
      c.apply(r.data)
      const want = await full(o.phone)
      assert.deepEqual([...c.tracks.values()], want, 'run ' + run + ' step ' + step)
      assert.deepEqual(want.map((tr) => tr.id).sort(), [...live.keys()].sort(), 'what the host has, run ' + run + ' step ' + step)
    }
    await o.phone.stop()
  }
})

// ----------------------------------------------------------------- the track

test('the served track equals the server\'s buildTrack and publicTrack for the same file', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  const { phone } = open(dir)
  t.after(() => phone.stop())
  const list = [
    facts(1),
    facts(2, { format: 'flac', codec: 'audio/flac', bitDepth: 24, sampleRate: 96000, tags: { title: null, artist: null, album: null, albumArtist: null, trackNo: null, discNo: null, year: null }, name: '07 - Artista - Titolo.flac', coverId: 'c'.repeat(24) }),
    facts(3, { format: 'm4a', codec: 'audio/alac', bitDepth: 16, tags: { title: '  Spazi\t', artist: 'A', album: 'B', albumArtist: 'C', trackNo: 0, discNo: -1, year: 1.5 } }),
    facts(4, { format: 'ogg', codec: 'audio/vorbis', duration: 61.23456, lyrics: { synced: [[{ t: 1000, text: LINES[0] }, { t: 2000, text: LINES[1] }]], texts: [], lrc: null } })
  ]
  await feed(phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: list }, { op: 'end', token: 'k', batch: 2 })
  const served = await full(phone)
  const stub = { qualitiesOf: () => ({ low: false, normal: false, high: false }), lyricsOf: (id) => (id === idOf(4) ? 'synced' : null) }
  for (const F of list) {
    const metadata = {
      common: { title: F.tags.title ?? undefined, artist: F.tags.artist ?? undefined, album: F.tags.album ?? undefined, albumartist: F.tags.albumArtist ?? undefined, track: { no: F.tags.trackNo }, disk: { no: F.tags.discNo }, year: F.tags.year ?? undefined },
      format: { duration: F.duration, bitrate: F.bitrate, sampleRate: F.sampleRate, bitsPerSample: F.bitDepth ?? undefined, codec: F.codec }
    }
    const built = media.buildTrack({ id: F.id, format: F.format, metadata, size: F.size, fallbackTitle: ids.titleFromFileName(ids.cleanUploadName(F.name), F.id), coverId: F.coverId, addedAt: F.addedAt })
    const want = Library.prototype.publicTrack.call(stub, { ...built, fileHash: F.id, uploaders: ['owner'] }, null)
    assert.deepEqual(served.find((x) => x.id === F.id), want, F.name)
  }
})

test('a file whose bytes changed in place: the new track carries the old id as `was`', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  const { phone } = open(dir)
  t.after(() => phone.stop())
  await feed(phone, { op: 'reset', token: 'k' }, { op: 'put', token: 'k', batch: 1, tracks: [facts(1)] })
  await feed(phone, { op: 'put', token: 'k', batch: 2, tracks: [facts(2, { was: [idOf(1), 'zz', idOf(2)] })] }, { op: 'drop', token: 'k', batch: 3, ids: [idOf(1)] })
  const [x] = await full(phone)
  assert.equal(x.id, idOf(2))
  assert.deepEqual(x.was, [idOf(1)], 'its own id and a malformed one left out')
  assert.deepEqual(Object.keys(x).slice(-3), ['mine', 'others', 'was'])
})

// ---------------------------------------------------------------- the lyrics

test('lyrics: synced tags over plain ones, an .lrc only when the tags have no synced lyrics; the answer, its ETag and 304; 404 no_lyrics', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  const { phone } = open(dir)
  t.after(() => phone.stop())
  const synced = [[{ t: 1000, text: LINES[0] }, { t: 4000, text: LINES[1] }]]
  const lrc = '[00:02.00]' + LINES[2] + '\n[00:05.00]' + LINES[0] + '\n'
  await feed(phone, { op: 'reset', token: 'k' }, {
    op: 'put',
    token: 'k',
    batch: 1,
    tracks: [
      facts(1, { lyrics: { synced, texts: [LINES.join('\n')], lrc } }), // synced tags win over the .lrc and the plain text
      facts(2, { lyrics: { synced: [], texts: [LINES.join('\n')], lrc } }), // plain tags: the .lrc beside wins
      facts(3, { lyrics: { synced: [], texts: [LINES.join('\n')], lrc: null } }), // plain tags
      facts(4, { lyrics: { synced: [], texts: [], lrc: 'non sono righe con un tempo' } }), // an .lrc of plain text
      facts(5)
    ]
  })
  const tracks = await full(phone)
  assert.deepEqual(tracks.map((x) => x.lyrics), ['synced', 'synced', 'plain', 'plain', undefined])
  let r = await ask(phone, 'GET', '/api/lyrics/' + idOf(1))
  assert.deepEqual(r.data, { trackId: idOf(1), kind: 'synced', lines: [{ t: 1000, text: LINES[0] }, { t: 4000, text: LINES[1] }], from: 'tag' })
  assert.match(r.headers.ETag, /^"y[0-9a-f]{16}"$/)
  assert.equal(r.headers['Cache-Control'], 'no-cache')
  const tag = r.headers.ETag
  r = await ask(phone, 'GET', '/api/lyrics/' + idOf(1), { headers: { 'If-None-Match': tag } })
  assert.equal(r.status, 304)
  r = await ask(phone, 'GET', '/api/lyrics/' + idOf(2))
  assert.deepEqual(r.data, { trackId: idOf(2), kind: 'synced', lines: [{ t: 2000, text: LINES[2] }, { t: 5000, text: LINES[0] }], from: 'lrc' })
  r = await ask(phone, 'GET', '/api/lyrics/' + idOf(3))
  assert.deepEqual(r.data, { trackId: idOf(3), kind: 'plain', text: LINES.join('\n'), from: 'tag' })
  // The same rule as a source's: the tags of the very same text read by the server.
  assert.deepEqual(lyricsFromTags({ native: { 'ID3v2.4': [{ id: 'USLT', value: { text: LINES.join('\n') } }] }, common: {} }), { kind: 'plain', text: LINES.join('\n') })
  r = await ask(phone, 'GET', '/api/lyrics/' + idOf(4))
  assert.equal(r.data.from, 'lrc')
  for (const id of [idOf(5), idOf(99), 'nope']) {
    r = await ask(phone, 'GET', '/api/lyrics/' + id)
    assert.equal(r.status, 404)
    assert.deepEqual(r.data, { error: 'Testo non trovato', code: 'no_lyrics' })
  }
  // The file loses its lyrics: they go, the flag too; a dropped track takes its text away.
  await feed(phone, { op: 'put', token: 'k', batch: 2, tracks: [facts(3)] }, { op: 'drop', token: 'k', batch: 3, ids: [idOf(1)] })
  assert.equal((await ask(phone, 'GET', '/api/lyrics/' + idOf(3))).status, 404)
  assert.equal(fs.existsSync(path.join(dir, 'lyrics', idOf(3) + '.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'lyrics', idOf(1) + '.json')), false)
  assert.equal(fs.existsSync(path.join(dir, 'lyrics', idOf(2) + '.json')), true)
})

// ---------------------------------------------------------------- the covers

test('covers: the core\'s art, then the host\'s, then a person cover; the ETag and the cache of a source; 304, 404, 400', async (t) => {
  const base = cleanup(t).dir(tmpDir('mpfy-phone-'))
  const dir = path.join(base, 'p')
  const { phone } = open(dir)
  t.after(() => phone.stop())
  const hostArt = path.join(base, 'host-art')
  fs.mkdirSync(hostArt, { recursive: true })
  const jpeg = (s) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(s), Buffer.from([0xff, 0xd9])])
  const a = 'a'.repeat(24)
  const b = 'b'.repeat(24)
  fs.writeFileSync(path.join(dir, 'art', a + '.small.jpg'), jpeg('core small'))
  fs.writeFileSync(path.join(hostArt, a + '.small.jpg'), jpeg('host small'))
  fs.writeFileSync(path.join(hostArt, b + '.large.jpg'), jpeg('host large'))
  let r = await ask(phone, 'GET', '/api/cover/' + a + '?size=small')
  assert.equal(r.status, 200)
  assert.ok(r.body.equals(jpeg('core small')))
  assert.equal(r.headers.ETag, '"' + a + '.small"')
  assert.equal(r.headers['Content-Type'], 'image/jpeg')
  assert.equal(r.headers['Cache-Control'], 'private, max-age=31536000, immutable')
  r = await ask(phone, 'GET', '/api/cover/' + b + '?size=large')
  assert.ok(r.body.equals(jpeg('host large')))
  r = await ask(phone, 'GET', '/api/cover/' + b + '?size=large', { headers: { 'If-None-Match': '"' + b + '.large"' } })
  assert.equal(r.status, 304)
  assert.equal((await ask(phone, 'GET', '/api/cover/' + b + '?size=small')).status, 404)
  // xl, the sources' size for Now Playing: the phone has no such version, so its large one.
  r = await ask(phone, 'GET', '/api/cover/' + b + '?size=xl')
  assert.deepEqual([r.status, r.headers.ETag, r.body.equals(jpeg('host large'))], [200, '"' + b + '.large"', true])
  assert.equal((await ask(phone, 'GET', '/api/cover/' + b + '?size=huge')).status, 400)
  assert.equal((await ask(phone, 'GET', '/api/cover/xyz?size=small')).status, 404)
})

// ------------------------------------------------------ the switch, the routes

test('PATCH /api/admin/source { details }: an s line with the version headers; the switch survives a restart; any other field 400', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  let o = open(dir)
  const v0 = o.phone.version
  let r = await ask(o.phone, 'PATCH', '/api/admin/source', { body: { details: false } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { source: { name: 'Locale', named: true, details: false } })
  assert.equal(r.headers['X-MPfy-Version'], String(v0 + 1))
  assert.equal(r.headers['X-MPfy-Epoch'], o.phone.epoch.id)
  assert.ok(fs.readFileSync(path.join(dir, 'library.log'), 'utf8').includes('[' + (v0 + 1) + ',"s",{"details":false}]'))
  r = await ask(o.phone, 'PATCH', '/api/admin/source', { body: { details: false } })
  assert.equal(r.headers['X-MPfy-Version'], String(v0 + 1), 'the same value moves nothing')
  for (const body of [{ details: 'no' }, { name: 'Altro' }, { details: true, name: 'x' }, {}, 'non json']) {
    r = await ask(o.phone, 'PATCH', '/api/admin/source', { body })
    assert.equal(r.status, 400)
    assert.deepEqual(r.data, { error: 'Richiesta non valida', code: 'bad_request' })
  }
  await o.phone.stop()
  o = open(dir)
  t.after(() => o.phone.stop())
  assert.equal(o.phone.details, false)
  assert.equal(o.phone.entry().details, false)
  assert.equal((await ask(o.phone, 'GET', '/api/library?delta=1')).data.source.details, false)
  await o.phone._enqueue(() => o.phone._compact())
  await o.phone.stop()
  o = open(dir)
  assert.equal(o.phone.details, false, 'kept by a compaction')
})

test('routes Locale does not have answer 404; the person\'s data goes to a real home, raw', async (t) => {
  const dir = path.join(cleanup(t).dir(tmpDir('mpfy-phone-')), 'p')
  const { phone, host } = open(dir)
  t.after(() => phone.stop())
  for (const [m, p] of [['GET', '/api/stream/' + idOf(1)], ['GET', '/api/fingerprint/' + idOf(1)], ['GET', '/api/people'], ['PATCH', '/api/tracks/' + idOf(1)], ['PUT', '/api/lyrics/' + idOf(1)], ['GET', '/api/chat/conversations'], ['DELETE', '/api/cover-for/track/' + idOf(1)]]) {
    assert.equal((await ask(phone, m, p)).status, 404, m + ' ' + p)
  }
  // The home is the phone store and there is none yet: nothing answers the person's routes.
  assert.equal((await ask(phone, 'PUT', '/api/likes/' + idOf(1))).status, 404)
  assert.deepEqual(host.forwards, [])
  // A real home: forwarded there as it came.
  host.homeId = 'abcd1234'
  for (const [m, p] of [['PUT', '/api/likes/' + idOf(1)], ['POST', '/api/likes'], ['GET', '/api/playlists'], ['POST', '/api/played'], ['GET', '/api/recents?limit=5'], ['PUT', '/api/cover-for/playlist/0123456789abcdef?size=large']]) {
    const r = await ask(phone, m, p)
    assert.equal(r.status, 'forwarded', p)
    assert.deepEqual(r.fwd, { id: 'abcd1234', target: p })
  }
})

// ------------------------------------------------------------ the core's seams

test('the core: /local/sources carries the phone, the sources event its home, /s/0000 answered by the core; without phone music none of it', async (t) => {
  const c = cleanup(t)
  const base = c.dir(tmpDir('mpfy-phone-core-'))
  const dht = { on () {}, off () {} }
  // Without phone music: today's core.
  const plain = createClientCore({ statePath: path.join(base, 'plain.json'), webRoot: WEB, port: 0, dht, onEvent: () => {} })
  const p1 = (await plain.start()).port
  let r = await request(p1, 'GET', '/local/sources')
  assert.deepEqual(json(r), { sources: [] })
  r = await request(p1, 'GET', '/s/0000/api/library')
  assert.equal(r.status, 404)
  assert.equal(json(r).error, 'Fonte sconosciuta')
  await plain.stop()

  const events = []
  const sent = []
  const core = createClientCore({ statePath: path.join(base, 'state.json'), webRoot: WEB, port: 0, dht, onEvent: (e) => events.push(e), phone: { dir: path.join(base, 'state.json.phone'), send: (m) => sent.push(m), lookups: { fillDelayMs: 3600000 } } })
  const { port } = await core.start()
  t.after(() => core.stop())
  await waitFor(() => sent.find((m) => m.t === 'local-hello'), { what: 'the hello' })
  assert.deepEqual(events.find((e) => e.type === 'sources'), { type: 'sources', sources: [], home: PHONE_ID })
  r = await request(port, 'GET', '/local/sources')
  const entry = json(r).phone
  assert.deepEqual(Object.keys(entry), ['id', 'name', 'state', 'tracks', 'v', 'home', 'details', 'shadowed'])
  assert.deepEqual([entry.id, entry.name, entry.state, entry.tracks, entry.home, entry.details, entry.shadowed], ['0000', 'Locale', 'scanning', 0, true, true, true])
  core.phoneMessage({ t: 'local', op: 'access', granted: false })
  assert.equal(json(await request(port, 'GET', '/local/sources')).phone.state, 'off')
  core.phoneMessage({ t: 'local', op: 'access', granted: true })
  core.phoneMessage({ t: 'local', op: 'progress', pending: 12 })
  assert.equal(json(await request(port, 'GET', '/local/sources')).phone.state, 'scanning')
  core.phoneMessage({ t: 'local', op: 'progress', pending: 0 })
  core.phoneMessage({ t: 'local', op: 'reset', token: 'k' })
  core.phoneMessage({ t: 'local', op: 'put', token: 'k', batch: 1, tracks: [facts(1), facts(2)] })
  await waitFor(() => sent.find((m) => m.t === 'local-ack'), { what: 'the ack' })
  const after = json(await request(port, 'GET', '/local/sources')).phone
  assert.equal(after.state, 'ready')
  assert.equal(after.tracks, 2)
  assert.notEqual(after.v, entry.v, 'the version moved')
  r = await request(port, 'GET', '/s/0000/api/library?delta=1')
  assert.equal(r.status, 200)
  assert.equal(r.headers['transfer-encoding'], 'chunked')
  assert.equal(r.headers['content-encoding'], undefined)
  assert.equal(json(r).tracks.length, 2)
  r = await request(port, 'HEAD', '/s/0000/api/library?delta=1')
  assert.equal(r.status, 200)
  assert.equal(r.body.length, 0)
  r = await request(port, 'GET', '/s/0000/api/lyrics/' + idOf(1))
  assert.equal(r.status, 404)
  assert.equal(json(r).code, 'no_lyrics')
})

test('the core: the shadow set from the page (whole set and changes, a bad body 400), and none without phone music', async (t) => {
  const c = cleanup(t)
  const base = c.dir(tmpDir('mpfy-phone-core-'))
  const core = createClientCore({ statePath: path.join(base, 'state.json'), webRoot: WEB, port: 0, dht: { on () {}, off () {} }, phone: { dir: path.join(base, 'state.json.phone'), send: () => {}, lookups: { fillDelayMs: 3600000 } } })
  const { port } = await core.start()
  t.after(() => core.stop())
  let r = await request(port, 'PUT', '/local/phone/shadowed', { body: JSON.stringify({ all: [idOf(1), idOf(2)] }), headers: { 'Content-Type': 'application/json' } })
  assert.equal(r.status, 200, r.body.toString())
  assert.deepEqual(json(r), { ok: true, shadowed: 2 })
  r = await request(port, 'PUT', '/local/phone/shadowed', { body: JSON.stringify({ add: [idOf(3)], remove: [idOf(1)] }), headers: { 'Content-Type': 'application/json' } })
  assert.deepEqual(json(r), { ok: true, shadowed: 2 })
  for (const body of [{}, { all: ['x'] }, { add: 'a' }, { all: [], add: [] }, { other: [] }]) {
    r = await request(port, 'PUT', '/local/phone/shadowed', { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.equal(json(r).code, 'bad_request')
  }
  // The whole set of a large library fits in one body.
  const many = Array.from({ length: 20000 }, (_, i) => idOf(i + 10))
  r = await request(port, 'PUT', '/local/phone/shadowed', { body: JSON.stringify({ all: many }), headers: { 'Content-Type': 'application/json' } })
  assert.deepEqual(json(r), { ok: true, shadowed: 20000 })
})
