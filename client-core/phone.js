// "Locale": the phone's own music as a source the core serves itself at
// /s/0000/api/..., with the source API's paths, answers, status codes and version
// headers, so the page reads it with the code it reads every source with. The host
// (Kotlin on Android) owns the files: it reads each one once and feeds the core
// its facts over IPC; the core owns the versions, the deltas, the served tracks,
// covers and lyrics, and the details and lyrics the network fills
// (phone-lookups.js). Playback never comes here: the host reads the file itself.
//
// Files, under `dir` (<statePath>.phone):
// - library.log: Locale's library log, NDJSON. The header
//     {"mpfy":"library-log","schema":1}
//   then, as the source's library log writes them (versions and epochs as there):
//     {"e":"<16 hex>","v":E}             an epoch begins (the first change of a run)
//     [v,"t:<id>",{stored},code]          a track (code: bit 3 synced lyrics, bit 4 plain)
//     [v,"t:<id>"]                        a tombstone
//     [v,"s",{"details":bool}]            the switch "Cerca i dettagli in rete"
//   A line that changes nothing a client sees (a lookup that found nothing) is
//   written at the current version, which does not move. Lines of its own, without
//   a version:
//     {"fb":["<token>",n]}               the feed's position: batch n of that token is in
//     {"fr":"<token>"} {"fe":"<token>"}  a full resend began, and ended
//     {"rk":["<id>",...]}                the ids of a batch put during an open resend (a
//                                         put of equal facts writes nothing else, and
//                                         its end drops every track not put since)
//     {"sh":{"all":[ids],"k":"<sources>"}}, {"sh":{"a":[ids],"r":[ids]}}  the songs
//                                         whose very same file a real source holds, as
//                                         the page said, for the real sources named by k
//     {"m":{...}}                        the summary, last line of every write: the
//                                         version and its epoch, the feed position, the
//                                         count, the switch, when a lookup is next due,
//                                         the shadow's sources, so a start reads only it
//   A compacted log: the header, {"ep":[[id,first,last],...]}, {"h":H}, {"S":V},
//   the switch, the shadow, the newest 10,000 tombstones, every track with its
//   own version in the library's order, the feed position, {"E":V}, the summary.
//   A batch's lines go out in one checked write at the end of its whole lines (a
//   positional write on a read-write descriptor: an append-only one cannot be cut
//   back on every system), cut back when short, before the
//   batch is applied; a write that fails changes nothing. A last line cut by a
//   crash is dropped; a line that does not parse ends the trusted part, the rest is
//   kept aside as library.log.cut-<ms>. Compacted when its dead bytes pass its live
//   bytes and 1 MB, never while a resend is open.
// - lyrics/<trackId>.json: { kind, lines | text }, written before its line names it.
// - art/<coverId>.small.jpg, .large.jpg: covers the network found (the host made
//   the JPEGs); the host's own (embedded or beside the file) are in `artDir`.
// - caa.json: the Cover Art Archive answers by release, the newest 2,000.
//
// The feed (the host's messages; put, drop, reset and end applied one at a time
// in arrival order):
//   { t: 'local', op: 'access', granted } | { op: 'progress', pending }
//   { op: 'put', token, batch, tracks } | { op: 'drop', token, batch, ids }
//   { op: 'reset', token } | { op: 'end', token, batch }
// A batch's lines and its feed position go out in one write; once that is synced
// the core answers { t: 'local-ack', token, batch }. After the start it says where
// it is: { t: 'local-hello', token, batch }.
//
// Loaded on use: a start reads the last line of the log; the whole log is read
// only when a delta, a full answer, a feed batch or a lookup needs the tracks.
// In memory then: per track its stored and served JSON, its version and place.
//
// Portable: '#fs', '#path', b4a, sodium-native.

import fs from '#fs'
import path from '#path'
import b4a from 'b4a'
import { writeFileAtomic } from './state.js'
import { etagMatches } from './http.js'
import { randomBytes } from './identity.js'
import { cleanFacts, factsHash, storedFromFacts, servedText, codeOf, shownLyrics, withDetails, sha256Hex, ID_RE } from './phone-track.js'
import { PhoneLookups, detailsDueAt, lyricsDueAt, coverOf, GENRES_V } from './phone-lookups.js'
import { missingFields, keyOf } from './phone-rules.js'

export const PHONE_ID = '0000'
export const PHONE_NAME = 'Locale'
export const ZERO_EPOCH = '0000000000000000'
// The page sends the whole set of shadowed ids in one body: at most this many.
export const MAX_SHADOWED = 100000
const HEADER = '{"mpfy":"library-log","schema":1}'
const KEEP_TOMBSTONES = 10000
const KEEP_EPOCHS = 64
const COMPACT_MIN = 1024 * 1024
const TRACK_SLICE = 250
const WRITE_SLICE = 256 * 1024
const SYNC_GAP_MS = 500
const TAIL_BYTES = 64 * 1024
const MAX_LINE = 64 * 1024 * 1024
const TOMB_BYTES = 40
const IMMUTABLE = 'private, max-age=31536000, immutable'
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/
const HEX16_RE = /^[0-9a-f]{16}$/
const NUM_RE = /^\d{1,16}$/
const COVER_SIZES = ['small', 'large']
const ART_RE = /^([0-9a-f]{24})\.(?:small|large)\.jpg$/
const LYRICS_RE = /^([0-9a-f]{24})\.json$/
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
// The person's data: the phone store answers it while it is the home; whenever
// the home is a real source it goes there, raw.
const PERSON_RE = /^\/api\/(?:playlists(?:\/|$)|likes(?:\/|$)|played$|recents$|cover-for\/playlist\/)/
// No person's data here: the zero epoch, nothing in it.
const EMPTY_USER = Object.freeze({ version: 0, epoch: ZERO_EPOCH })

const noop = () => {}

/**
 * @param {object} opts
 * @param {string} opts.dir  <statePath>.phone
 * @param {string|null} [opts.artDir]  the host's covers (read only)
 * @param {(msg: object) => void} opts.send  to the host
 * @param {object} opts.host  the core: profileId(), realSources() -> [ids], home(),
 *   forward(conn, req, fwd, rest), send(conn, status, headers, body),
 *   json(conn, status, obj, headers), pieces(conn, status, headers, iterable),
 *   readBody(conn, req, rest), log(line)
 * @param {object} [opts.person]  the phone person store (phone-person.js): holds(),
 *   summary() -> { version, epoch }, libraryPart(uv, ue, mode) (a promise),
 *   handle(conn, req, target, rest)
 */
export class PhoneSource {
  constructor ({ dir, artDir = null, send = noop, host, fs: files = fs, now = Date.now, lookups = {}, person = null }) {
    this.dir = dir
    this.artDir = artDir
    this._send = send
    this._host = host
    this._fs = files
    this._now = now
    this._person = person
    this._file = path.join(dir, 'library.log')
    this._lookupOpts = lookups
    this.lookups = null

    this.version = 0
    this.epoch = null // { id, first }: the epoch of `version`
    this.details = true
    this.loaded = false
    this._fd = -1
    this._size = 0
    this._broken = false
    this._opened = false // this run opened its epoch
    this._count = 0
    this._q = 0 // when a lookup is next due (Infinity: none without a change)
    this._feed = { token: null, batch: 0 }
    this._reset = null // { token, ids } while a full resend is open
    this._shadow = { key: null, ids: new Set() }
    this._sv = null // the version of the last change of the switch

    this._tracks = new Map() // id -> rec, in the library's order
    this._seq = 0
    this._tombs = [] // [v, id], oldest first
    this._horizon = 0
    this._epochs = [] // { id, first, last }
    this._live = 0 // bytes of the lines a compaction keeps
    this._art = new Map() // a network cover's id -> tracks that show it

    this._access = null
    this._pending = 0
    this._chain = Promise.resolve()
    this._syncTimer = null
    this._lastSync = 0
    this._compacting = false
    this._lastSourcesKey = null
    this._closed = false
  }

  // ------------------------------------------------------------- lifecycle

  /** The log opened: its last line read, or a new one made, or read whole to repair it. */
  start () {
    const f = this._fs
    for (const d of [this.dir, path.join(this.dir, 'lyrics'), path.join(this.dir, 'art')]) f.mkdirSync(d, { recursive: true })
    let size = -1
    try {
      size = f.statSync(this._file).size
    } catch {}
    if (size <= 0) this._create()
    this._fd = f.openSync(this._file, 'r+')
    if (size > 0 && !this._readTail(size)) this._load()
    this._lastSourcesKey = this._sourcesKey()
    this.lookups = new PhoneLookups({ phone: this, send: (msg) => this._send(msg), log: (l) => this._log(l), now: this._now, ...this._lookupOpts })
    this.lookups.start()
  }

  /** Where the feed is, for the host (once, after the start). */
  hello () {
    this._send({ t: 'local-hello', token: this._feed.token, batch: this._feed.batch })
  }

  async stop () {
    this._closed = true
    if (this.lookups !== null) this.lookups.stop()
    try {
      await this._chain
    } catch {}
    clearTimeout(this._syncTimer)
    this._syncTimer = null
    if (this._fd !== -1) {
      try {
        this._fs.fsyncSync(this._fd)
      } catch {}
      try {
        this._fs.closeSync(this._fd)
      } catch {}
      this._fd = -1
    }
  }

  _log (line) {
    if (this._host && typeof this._host.log === 'function') this._host.log('locale: ' + line)
  }

  // ------------------------------------------------------------- the entry

  get state () {
    if (this._access === false) return 'off'
    return this._access === null || this._pending > 0 ? 'scanning' : 'ready'
  }

  /** The phone entry of GET /local/sources. */
  entry () {
    return {
      id: PHONE_ID,
      name: PHONE_NAME,
      state: this.state,
      tracks: this._count,
      v: this.version + '.' + this._user().version,
      home: this._host.home() === PHONE_ID,
      details: this.details,
      shadowed: this.shadowKnown()
    }
  }

  // The person's part: the phone store while it is the home, else none.
  _user () {
    if (this._person === null || this._host.home() !== PHONE_ID) return EMPTY_USER
    return this._person.summary()
  }

  /** Whether the phone store holds the person's data (the core's home rule). */
  personHolds () {
    return this._person !== null && typeof this._person.holds === 'function' && this._person.holds()
  }

  /** The real sources changed: the shadow set may stand for others now. */
  sourcesChanged () {
    const key = this._sourcesKey()
    if (key === this._lastSourcesKey) return
    this._lastSourcesKey = key
    if (this.lookups !== null && this.shadowKnown()) this.lookups.sourcesChanged()
  }

  // --------------------------------------------------------------- the feed

  /** A { t: 'local' | 'net-reply', ... } from the host. */
  message (msg) {
    if (msg === null || typeof msg !== 'object' || this._closed) return
    if (msg.t === 'net-reply') {
      if (this.lookups !== null) this.lookups.netReply(msg)
      return
    }
    if (msg.t !== 'local') return
    if (msg.op === 'access') {
      this._access = msg.granted === true
      return
    }
    if (msg.op === 'progress') {
      this._pending = Number.isSafeInteger(msg.pending) && msg.pending > 0 ? msg.pending : 0
      return
    }
    const run = { put: () => this._put(msg), drop: () => this._drop(msg), reset: () => this._resetBegin(msg), end: () => this._end(msg) }[msg.op]
    if (run !== undefined) this._enqueue(run)
  }

  // One at a time, in arrival order.
  _enqueue (fn) {
    const run = this._chain.then(() => (this._closed ? null : fn()))
    this._chain = run.catch((err) => this._log('change not made: ' + ((err && err.message) || err)))
    return run
  }

  /** Every change asked until now has landed (tests). */
  settled () {
    return this._chain
  }

  _sameFeed (msg) {
    return typeof msg.token === 'string' && msg.token === this._feed.token && Number.isSafeInteger(msg.batch) && msg.batch >= 0
  }

  _ack (msg) {
    this._send({ t: 'local-ack', token: msg.token, batch: msg.batch })
  }

  async _put (msg) {
    if (!this._sameFeed(msg)) return
    if (msg.batch <= this._feed.batch) return this._ack(msg)
    this._ensureLoaded()
    const changes = new Map() // id -> { stored, text, old }
    const seen = []
    for (const raw of Array.isArray(msg.tracks) ? msg.tracks : []) {
      const F = cleanFacts(raw)
      if (F === null) {
        this._log('a track whose facts cannot be read is left out')
        continue
      }
      seen.push(F.id)
      const fh = factsHash(F)
      const old = this._tracks.get(F.id)
      if (old !== undefined && old.fh === fh) {
        changes.delete(F.id)
        continue
      }
      const prev = old !== undefined ? JSON.parse(old.stored) : null
      const built = storedFromFacts(F, fh, prev)
      changes.set(F.id, { stored: built.stored, text: built.text, old: old || null })
    }
    for (const [id, c] of changes) if (c.text !== null) await this._writeLyrics(id, c.text)
    const { v, epoch } = this._versionFor(changes.size > 0)
    const lines = []
    const recs = []
    for (const [id, c] of changes) {
      const rec = this._recOf(id, c.stored, v)
      lines.push(rec.line)
      recs.push(rec)
    }
    if (this._reset !== null) lines.push(JSON.stringify({ rk: seen }))
    lines.push(JSON.stringify({ fb: [msg.token, msg.batch] }))
    this._commit({ v, epoch, lines, puts: recs, feed: { token: msg.token, batch: msg.batch } })
    if (this._reset !== null) for (const id of seen) this._reset.ids.add(id)
    for (const [id, c] of changes) if (c.old !== null && c.old.shown !== null && shownLyrics(c.stored) === null) this._removeLyrics(id)
    // Acked once it is on the disk: a sync that fails leaves the batch to be sent again.
    await this._syncNow()
    this._feed = { token: msg.token, batch: msg.batch }
    this._ack(msg)
    for (const rec of recs) this.lookups.request(rec.id, rec)
    this._compactMaybe()
  }

  async _drop (msg) {
    if (!this._sameFeed(msg)) return
    if (msg.batch <= this._feed.batch) return this._ack(msg)
    this._ensureLoaded()
    const ids = [...new Set((Array.isArray(msg.ids) ? msg.ids : []).filter((id) => typeof id === 'string' && this._tracks.has(id)))]
    await this._tombstone(ids, [JSON.stringify({ fb: [msg.token, msg.batch] })], { token: msg.token, batch: msg.batch })
    this._ack(msg)
    this._compactMaybe()
  }

  _resetBegin (msg) {
    if (typeof msg.token !== 'string' || !TOKEN_RE.test(msg.token)) return
    const feed = { token: msg.token, batch: 0 }
    this._commit({ v: this.version, epoch: null, lines: [JSON.stringify({ fr: msg.token })], feed })
    this._feed = feed
    this._reset = { token: msg.token, ids: new Set() }
  }

  async _end (msg) {
    if (!this._sameFeed(msg)) return
    if (msg.batch <= this._feed.batch) return this._ack(msg)
    this._ensureLoaded()
    const ids = this._reset === null ? [] : [...this._tracks.keys()].filter((id) => !this._reset.ids.has(id))
    const tail = []
    if (this._reset !== null) tail.push(JSON.stringify({ fe: msg.token }))
    tail.push(JSON.stringify({ fb: [msg.token, msg.batch] }))
    await this._tombstone(ids, tail, { token: msg.token, batch: msg.batch }, () => { this._reset = null })
    this._ack(msg)
    this._compactMaybe()
  }

  // Tombstones for these ids (and `tail` lines), synced; the feed moves to `feed`.
  async _tombstone (ids, tail, feed, applied = noop) {
    const { v, epoch } = this._versionFor(ids.length > 0)
    const gone = ids.map((id) => this._tracks.get(id))
    this._commit({ v, epoch, lines: [...ids.map((id) => JSON.stringify([v, 't:' + id])), ...tail], drops: ids, feed })
    applied()
    for (const rec of gone) if (rec.shown !== null) this._removeLyrics(rec.id)
    await this._syncNow()
    this._feed = feed
  }

  // ------------------------------------------------------------ the records

  // A track as held in memory: its stored and served JSON, its version, what the
  // lookups need, and (when `line`) its log line.
  _recOf (id, stored, v, { line = true } = {}) {
    const code = codeOf(stored)
    const text = JSON.stringify(stored)
    const out = {
      id,
      v,
      seq: 0,
      stored: text,
      served: servedText(stored),
      fh: stored.fh,
      code,
      shown: shownLyrics(stored),
      // The genres lookup is the instance's option (off in tests that count requests).
      dd: this._lookupOpts && this._lookupOpts.genres === false ? detailsDueAt(stored, { genres: false }) : detailsDueAt(stored),
      ld: lyricsDueAt(stored),
      cover: stored.filled && typeof stored.filled.cover === 'string' ? stored.filled.cover : null,
      len: 0,
      line: null
    }
    if (line) {
      out.line = trackLine(v, id, text, code)
      out.len = b4a.byteLength(out.line, 'utf8') + 1
    }
    return out
  }

  _setRec (rec) {
    const old = this._tracks.get(rec.id)
    if (old !== undefined) {
      rec.seq = old.seq
      this._live -= old.len
    } else {
      rec.seq = ++this._seq
    }
    this._tracks.set(rec.id, rec)
    this._live += rec.len
    rec.line = null
    this._artUse(rec.cover, 1)
    if (old !== undefined) this._artUse(old.cover, -1)
  }

  _dropRec (id, v) {
    const old = this._tracks.get(id)
    if (old === undefined) return
    this._tracks.delete(id)
    this._live -= old.len
    this._artUse(old.cover, -1)
    this._tombs.push([v, id])
    this._live += TOMB_BYTES
    if (this._tombs.length > KEEP_TOMBSTONES) {
      this._horizon = Math.max(this._horizon, this._tombs.shift()[0])
      this._live -= TOMB_BYTES
    }
  }

  _artUse (coverId, n) {
    if (coverId === null) return
    const c = (this._art.get(coverId) || 0) + n
    if (c > 0) {
      this._art.set(coverId, c)
    } else {
      this._art.delete(coverId)
      this.dropCover(coverId)
    }
  }

  // ------------------------------------------------------------- the writes

  // The version of a batch: one more than the last, opening this run's epoch at
  // its first move (E = max(last + 1, now), the change E + 1).
  _versionFor (moves) {
    if (!moves) return { v: this.version, epoch: null }
    if (this._opened) return { v: this.version + 1, epoch: null }
    const E = Math.max(this.version + 1, this._now())
    return { v: E + 1, epoch: { id: newEpochId(), first: E, last: E } }
  }

  /**
   * One batch: its lines and the summary in one checked write, and only then
   * applied. Throws, changing nothing, when the write fails.
   */
  _commit ({ v, epoch, lines, puts = [], drops = [], feed = null, details = null, shadow = null }) {
    if (this._broken) throw new Error('the log could not be cut back after a failed write')
    const after = {
      v,
      epoch: epoch !== null ? { id: epoch.id, first: epoch.first } : this.epoch,
      feed: feed || this._feed,
      count: this._countAfter(puts, drops),
      details: details !== null ? details : this.details,
      q: this._dueAfter(puts, drops, shadow),
      shadow: shadow !== null ? shadow : this._shadow
    }
    const head = epoch !== null ? JSON.stringify({ e: epoch.id, v: epoch.first }) + '\n' : ''
    this._append(head + (lines.length > 0 ? lines.join('\n') + '\n' : '') + summaryLine(after) + '\n')
    // Applied: nothing below throws.
    if (epoch !== null) {
      this._epochs.push(epoch)
      this._opened = true
      this.epoch = after.epoch
    }
    if (this._epochs.length > 0) this._epochs[this._epochs.length - 1].last = v
    this.version = v
    for (const rec of puts) this._setRec(rec)
    for (const id of drops) this._dropRec(id, v)
    if (details !== null) {
      this.details = details
      this._sv = v
    }
    if (shadow !== null) this._shadow = shadow
    this._count = after.count
    this._q = after.q
  }

  _countAfter (puts, drops) {
    if (!this.loaded) return this._count
    let n = this._tracks.size
    for (const rec of puts) if (!this._tracks.has(rec.id)) n++
    for (const id of drops) if (this._tracks.has(id)) n--
    return n
  }

  // When a lookup is next due once this batch is in (Infinity: never without a change).
  _dueAfter (puts, drops, shadow) {
    if (!this.loaded) return this._q
    const sh = shadow !== null ? shadow : this._shadow
    const skip = this._realSources().length > 0 && sh.key === this._sourcesKey() ? sh.ids : null
    const changed = new Set(drops)
    for (const rec of puts) changed.add(rec.id)
    let q = Infinity
    const take = (rec) => {
      if (skip !== null && skip.has(rec.id)) return
      if (rec.dd < q) q = rec.dd
      if (rec.ld < q) q = rec.ld
    }
    for (const [id, rec] of this._tracks) if (!changed.has(id)) take(rec)
    for (const rec of puts) take(rec)
    return q
  }

  _append (text) {
    const buf = b4a.from(text, 'utf8')
    let n = -1
    try {
      n = this._fs.writeSync(this._fd, buf, 0, buf.byteLength, this._size)
    } catch (err) {
      this._cutBack()
      throw err
    }
    if (n !== buf.byteLength) {
      this._cutBack()
      throw new Error('short write to the library log')
    }
    this._size += buf.byteLength
    this._scheduleSync()
  }

  _cutBack () {
    try {
      this._fs.ftruncateSync(this._fd, this._size)
    } catch {
      this._broken = true
    }
  }

  // An fdatasync now, awaited (a feed batch is acked only after it).
  _syncNow () {
    clearTimeout(this._syncTimer)
    this._syncTimer = null
    const fd = this._fd
    return new Promise((resolve, reject) => {
      this._fs.fdatasync(fd, (err) => {
        this._lastSync = this._now()
        if (err) reject(err)
        else resolve()
      })
    })
  }

  // After any other change: one fdatasync at most every 500 ms, never awaited.
  _scheduleSync () {
    if (this._syncTimer !== null) return
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null
      if (this._fd === -1) return
      this._fs.fdatasync(this._fd, () => { this._lastSync = this._now() })
    }, Math.max(0, this._lastSync + SYNC_GAP_MS - this._now()))
  }

  // A new log: the header and this run's epoch in one write.
  _create () {
    const E = Math.max(1, this._now())
    const epoch = { id: newEpochId(), first: E, last: E }
    this.version = E
    this.epoch = { id: epoch.id, first: E }
    this._epochs = [epoch]
    this._opened = true
    this._q = Infinity
    this.loaded = true
    const after = { v: E, epoch: this.epoch, feed: this._feed, count: 0, details: true, q: Infinity, shadow: this._shadow }
    const bytes = b4a.from(HEADER + '\n' + JSON.stringify({ e: epoch.id, v: E }) + '\n' + summaryLine(after) + '\n', 'utf8')
    this._fs.writeFileSync(this._file, bytes)
    this._size = bytes.byteLength
    this._live = this._size
  }

  // ---------------------------------------------------------------- reading

  // The last line, when it is a summary: what a start needs. false: read it whole.
  _readTail (size) {
    const f = this._fs
    const n = Math.min(size, TAIL_BYTES)
    const buf = b4a.alloc(n)
    const fd = f.openSync(this._file, 'r')
    try {
      f.readSync(fd, buf, 0, n, size - n)
    } finally {
      f.closeSync(fd)
    }
    if (buf[n - 1] !== 10) return false
    const start = buf.lastIndexOf(10, n - 2) + 1
    if (start === 0 && n < size) return false
    let m
    try {
      m = JSON.parse(b4a.toString(buf.subarray(start, n - 1), 'utf8')).m
    } catch {
      return false
    }
    if (!validSummary(m)) return false
    this._size = size
    this.version = m.v
    this.epoch = { id: m.e[0], first: m.e[1] }
    this._feed = { token: m.fb[0], batch: m.fb[1] }
    this._count = m.n
    this.details = m.d
    this._q = m.q === null ? Infinity : m.q
    this._shadow = { key: m.sk, ids: new Set() } // the ids come with the whole log
    return true
  }

  /** The whole log read, once: the tracks, tombstones, epochs, the open resend. */
  ensureLoaded () {
    if (!this.loaded) this._load()
  }

  _ensureLoaded () {
    this.ensureLoaded()
  }

  _load () {
    const f = this._fs
    const bytes = f.readFileSync(this._file)
    let end = bytes.byteLength
    // A last line without its newline was cut by a crash: dropped.
    if (end > 0 && bytes[end - 1] !== 10) end = bytes.lastIndexOf(10, end - 1) + 1
    const st = {
      tracks: new Map(), seq: 0, tombs: [], horizon: 0, epochs: [], version: 0, live: 0,
      feed: { token: null, batch: 0 }, reset: null, details: true, sv: null, shadow: { key: null, ids: new Set() },
      compacted: false, last: null
    }
    let at = 0
    let first = true
    let cutAt = -1
    while (at < end) {
      const nl = bytes.indexOf(10, at)
      const raw = bytes.subarray(at, nl)
      const lineStart = at
      at = nl + 1
      if (first) {
        first = false
        if (b4a.toString(raw, 'utf8') !== HEADER) {
          cutAt = -2
          break
        }
        st.live += raw.byteLength + 1
        continue
      }
      if (raw.byteLength > MAX_LINE || !this._replay(st, raw)) {
        cutAt = lineStart
        break
      }
    }
    if (cutAt === -2) {
      // Not a log of ours: kept aside, and a new one begins.
      this._closeFd()
      const aside = this._file + '.corrupt-' + this._now()
      f.renameSync(this._file, aside)
      this._log('the library log could not be read, kept aside as ' + path.basename(aside))
      this._create()
      this._fd = f.openSync(this._file, 'r+')
      return
    }
    const cut = cutAt >= 0 ? cutAt : end
    if (cut < bytes.byteLength) {
      if (cutAt >= 0) {
        const aside = this._file + '.cut-' + this._now()
        try {
          f.writeFileSync(aside, bytes.subarray(cut))
        } catch {}
        this._log('the library log is cut at byte ' + cut + ', the rest kept aside as ' + path.basename(aside))
      }
      f.ftruncateSync(this._fd, cut)
    }
    this._tracks = st.tracks
    this._seq = st.seq
    this._tombs = st.tombs
    this._horizon = st.horizon
    this._epochs = st.epochs
    this.version = st.version
    const last = st.epochs.length > 0 ? st.epochs[st.epochs.length - 1] : null
    this.epoch = last !== null ? { id: last.id, first: last.first } : { id: ZERO_EPOCH, first: 0 }
    this._feed = st.feed
    this._reset = st.reset
    this.details = st.details
    this._sv = st.sv
    this._shadow = st.shadow
    this._size = cut
    this._live = st.live
    this._count = st.tracks.size
    this._art = new Map()
    for (const rec of st.tracks.values()) if (rec.cover !== null) this._art.set(rec.cover, (this._art.get(rec.cover) || 0) + 1)
    this.loaded = true
    this._q = this._dueAfter([], [], null)
    this._sweep()
    // Repaired, or its summary is stale: the summary is the last line once more.
    if (cut !== bytes.byteLength || st.last !== 'm') this._commit({ v: this.version, epoch: null, lines: [] })
    this._compactMaybe()
  }

  _closeFd () {
    if (this._fd === -1) return
    try {
      this._fs.closeSync(this._fd)
    } catch {}
    this._fd = -1
  }

  // One line of the log into `st`; false: it ends the trusted part.
  _replay (st, raw) {
    let x
    try {
      x = JSON.parse(b4a.toString(raw, 'utf8'))
    } catch {
      return false
    }
    const bytes = raw.byteLength + 1
    if (Array.isArray(x)) {
      const v = x[0]
      if (!Number.isSafeInteger(v) || typeof x[1] !== 'string') return false
      if (!st.compacted) {
        // Each change the previous one's version or one more (after an epoch line, its E).
        if (st.version !== 0 && v !== st.version && v !== st.version + 1) return false
        st.version = v
        if (st.epochs.length > 0) st.epochs[st.epochs.length - 1].last = v
      }
      const key = x[1]
      if (key.startsWith('t:') && ID_RE.test(key.slice(2))) {
        const id = key.slice(2)
        const old = st.tracks.get(id)
        if (x.length === 2) {
          // In a compacted part the lines carry their own versions: a tombstone older
          // than the track never removes it.
          if (old !== undefined && !(st.compacted && old.v > v)) {
            st.tracks.delete(id)
            st.live -= old.len
          }
          st.tombs.push([v, id])
          st.live += TOMB_BYTES
          if (st.tombs.length > KEEP_TOMBSTONES) {
            st.horizon = Math.max(st.horizon, st.tombs.shift()[0])
            st.live -= TOMB_BYTES
          }
        } else {
          if (x[2] === null || typeof x[2] !== 'object' || Array.isArray(x[2])) return false
          const rec = this._recOf(id, x[2], v, { line: false })
          rec.len = bytes
          if (old !== undefined) {
            rec.seq = old.seq
            st.live -= old.len
          } else {
            rec.seq = ++st.seq
          }
          st.tracks.set(id, rec)
          st.live += bytes
        }
      } else if (key.startsWith('d:')) {
        const rec = st.tracks.get(key.slice(2))
        if (rec !== undefined) rec.v = v
      } else if (key === 's') {
        if (x[2] !== null && typeof x[2] === 'object' && typeof x[2].details === 'boolean') st.details = x[2].details
        st.sv = v
      } else {
        return false
      }
      st.last = 'c'
      return true
    }
    if (x === null || typeof x !== 'object') return false
    if (typeof x.e === 'string' && Number.isSafeInteger(x.v)) {
      if (!st.compacted && st.version !== 0 && x.v <= st.version) return false
      st.epochs.push({ id: x.e, first: x.v, last: x.v })
      st.version = x.v
      st.last = 'e'
      return true
    }
    if (x.m !== undefined) {
      st.last = 'm'
      return true
    }
    st.last = 'x'
    if (Array.isArray(x.fb)) {
      st.feed = { token: typeof x.fb[0] === 'string' ? x.fb[0] : null, batch: Number.isSafeInteger(x.fb[1]) ? x.fb[1] : 0 }
    } else if (typeof x.fr === 'string') {
      st.reset = { token: x.fr, ids: new Set() }
      st.feed = { token: x.fr, batch: 0 }
    } else if (typeof x.fe === 'string') {
      st.reset = null
    } else if (Array.isArray(x.rk)) {
      if (st.reset !== null) for (const id of x.rk) st.reset.ids.add(id)
    } else if (x.sh !== undefined) {
      if (x.sh === null) {
        st.shadow = { key: null, ids: new Set() }
      } else if (Array.isArray(x.sh.all)) {
        st.shadow = { key: typeof x.sh.k === 'string' ? x.sh.k : null, ids: new Set(x.sh.all) }
      } else {
        for (const id of Array.isArray(x.sh.r) ? x.sh.r : []) st.shadow.ids.delete(id)
        for (const id of Array.isArray(x.sh.a) ? x.sh.a : []) st.shadow.ids.add(id)
      }
    } else if (Array.isArray(x.ep)) {
      st.epochs = x.ep.filter((e) => Array.isArray(e) && typeof e[0] === 'string').map((e) => ({ id: e[0], first: e[1], last: e[2] }))
      st.live += bytes
    } else if (Number.isSafeInteger(x.h)) {
      st.horizon = x.h
    } else if (Number.isSafeInteger(x.S)) {
      st.compacted = true
    } else if (Number.isSafeInteger(x.E)) {
      st.compacted = false
      st.version = x.E
      if (st.epochs.length > 0) st.epochs[st.epochs.length - 1].last = x.E
    } else {
      return false
    }
    return true
  }

  // Files no track names: lyrics of tracks gone, network covers nobody shows.
  _sweep () {
    const f = this._fs
    for (const [dir, re, keep] of [
      [path.join(this.dir, 'lyrics'), LYRICS_RE, (id) => { const r = this._tracks.get(id); return r !== undefined && r.shown !== null }],
      [path.join(this.dir, 'art'), ART_RE, (id) => this._art.has(id)]
    ]) {
      let names = []
      try {
        names = f.readdirSync(dir)
      } catch {}
      for (const name of names) {
        const m = re.exec(name)
        if ((m !== null && keep(m[1])) || (m === null && !name.endsWith('.tmp'))) continue
        try {
          f.unlinkSync(path.join(dir, name))
        } catch {}
      }
    }
  }

  // ------------------------------------------------------------- compaction

  _compactMaybe () {
    if (!this.loaded || this._compacting || this._reset !== null || this._closed) return
    const dead = this._size - this._live
    if (dead <= Math.max(this._live, COMPACT_MIN)) return
    this._compacting = true
    this._enqueue(() => this._compact()).catch(noop).finally(() => { this._compacting = false })
  }

  /** The log written again from what it holds (tests call it directly). */
  async _compact () {
    if (this._reset !== null || this._closed) return
    let H = this._horizon
    let epochs = this._epochs.filter((e) => e.last >= H)
    while (epochs.length > KEEP_EPOCHS) H = Math.max(H, epochs.shift().last)
    epochs = epochs.map((e) => ({ ...e }))
    const V = this.version
    const head = [HEADER, JSON.stringify({ ep: epochs.map((e) => [e.id, e.first, e.last]) }), JSON.stringify({ h: H }), JSON.stringify({ S: V })]
    if (this._sv !== null) head.push(JSON.stringify([this._sv, 's', { details: this.details }]))
    if (this._shadow.key !== null || this._shadow.ids.size > 0) head.push(JSON.stringify({ sh: { all: [...this._shadow.ids], k: this._shadow.key } }))
    const tmp = this._file + '.tmp'
    const f = this._fs
    let fd = f.openSync(tmp, 'w')
    let size = 0
    let live = 0
    try {
      let chunk = head.join('\n') + '\n'
      live += b4a.byteLength(chunk, 'utf8')
      const flush = async (force) => {
        if (chunk.length < WRITE_SLICE && !force) return
        const buf = b4a.from(chunk, 'utf8')
        let off = 0
        while (off < buf.byteLength) off += f.writeSync(fd, buf, off, buf.byteLength - off)
        size += buf.byteLength
        chunk = ''
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      // The tombstones first: a track made again after its tombstone comes after it.
      for (const [v, id] of this._tombs) chunk += JSON.stringify([v, 't:' + id]) + '\n'
      for (const rec of this._tracks.values()) {
        chunk += trackLine(rec.v, rec.id, rec.stored, rec.code) + '\n'
        await flush(false)
      }
      chunk += JSON.stringify({ fb: [this._feed.token, this._feed.batch] }) + '\n' + JSON.stringify({ E: V }) + '\n'
      const after = { v: V, epoch: this.epoch, feed: this._feed, count: this._tracks.size, details: this.details, q: this._q, shadow: this._shadow }
      chunk += summaryLine(after) + '\n'
      await flush(true)
      f.fsyncSync(fd)
    } catch (err) {
      try {
        f.closeSync(fd)
      } catch {}
      try {
        f.unlinkSync(tmp)
      } catch {}
      this._log('compaction given up: ' + ((err && err.message) || err))
      return
    }
    f.closeSync(fd)
    fd = -1
    if (this._closed) {
      try {
        f.unlinkSync(tmp)
      } catch {}
      return
    }
    // The live file is closed for the rename (Windows refuses it on an open file).
    this._closeFd()
    let renamed = false
    for (let attempt = 0; attempt < 8 && !renamed; attempt++) {
      try {
        f.renameSync(tmp, this._file)
        renamed = true
      } catch (err) {
        if (!(err && RETRY_CODES.has(err.code))) break
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
    this._fd = f.openSync(this._file, 'r+')
    if (!renamed) {
      try {
        f.unlinkSync(tmp)
      } catch {}
      this._log('compaction given up: the log could not be replaced')
      return
    }
    syncDir(f, this.dir)
    for (const rec of this._tracks.values()) live += rec.len
    live += this._tombs.length * TOMB_BYTES
    this._size = size
    this._live = live
    this._horizon = H
    this._epochs = epochs
  }

  // --------------------------------------------------------- the shadow set

  _realSources () {
    return this._host.realSources()
  }

  _sourcesKey () {
    return this._realSources().slice().sort().join(',')
  }

  /** Whether the page has said which songs the real sources hold (always, with none). */
  shadowKnown () {
    return this._realSources().length === 0 || this._shadow.key === this._sourcesKey()
  }

  /** A song whose very same file a real source holds: never looked up here. */
  isShadowed (id) {
    if (this._realSources().length === 0 || this._shadow.key !== this._sourcesKey()) return false
    this._ensureLoaded()
    return this._shadow.ids.has(id)
  }

  /**
   * PUT /local/phone/shadowed: { all } (the whole set, after a start or whenever
   * the entry says `shadowed: false`), or { add, remove } (what moved).
   */
  shadowed (body) {
    const ids = (v) => v === undefined ? [] : Array.isArray(v) && v.length <= MAX_SHADOWED && v.every((id) => typeof id === 'string' && ID_RE.test(id)) ? v : null
    const keys = Object.keys(body)
    const all = body.all === undefined ? null : ids(body.all)
    const add = ids(body.add)
    const remove = ids(body.remove)
    if (keys.some((k) => k !== 'all' && k !== 'add' && k !== 'remove') || keys.length === 0 || add === null || remove === null ||
        (body.all !== undefined && all === null) || (all !== null && (body.add !== undefined || body.remove !== undefined))) {
      return Promise.reject(Object.assign(new Error('bad'), { badRequest: true }))
    }
    return this._enqueue(() => {
      this._ensureLoaded()
      const key = this._sourcesKey()
      const wasKnown = this.shadowKnown()
      const cur = this._shadow.ids
      let state
      let removed
      let line
      if (all !== null) {
        const next = new Set(all)
        removed = [...cur].filter((id) => !next.has(id))
        const same = removed.length === 0 && next.size === cur.size && key === this._shadow.key
        if (same) return { ok: true, shadowed: next.size }
        state = { key, ids: next }
        line = { sh: { all: [...next], k: key } }
      } else {
        const next = new Set(cur)
        const r = remove.filter((id) => next.delete(id))
        const a = add.filter((id) => !next.has(id) && (next.add(id), true))
        if (a.length === 0 && r.length === 0) return { ok: true, shadowed: next.size }
        removed = r.filter((id) => !next.has(id))
        state = { key: this._shadow.key, ids: next }
        line = { sh: { a, r } }
      }
      this._commit({ v: this.version, epoch: null, lines: [JSON.stringify(line)], shadow: state })
      if (this.lookups !== null) this.lookups.shadowChanged({ known: !wasKnown && this.shadowKnown(), removed })
      return { ok: true, shadowed: state.ids.size }
    })
  }

  // ------------------------------------------------------ for the lookups

  * dueIds () {
    for (const rec of this._tracks.values()) yield rec
  }

  dueOf (id) {
    return this._tracks.get(id) || null
  }

  trackOf (id) {
    this._ensureLoaded()
    const rec = this._tracks.get(id)
    return rec === undefined ? null : JSON.parse(rec.stored)
  }

  /** When a lookup is next due, from the summary when the log is not read (null: none). */
  summaryDue () {
    return this._q === Infinity ? null : this._q
  }

  /** A details lookup is over: what it found among what is still missing, its state. */
  applyDetails (id, { fileHash, album, result, tries, at }) {
    return this._enqueue(() => {
      this._ensureLoaded()
      const rec = this._tracks.get(id)
      const t = rec === undefined ? null : JSON.parse(rec.stored)
      if (t === null || t.fileHash !== fileHash || t.album !== album) {
        if (result.coverId) this.dropCover(result.coverId)
        return
      }
      const values = result.values ? { ...result.values, cover: result.coverId || null } : null
      const missing = values === null ? [] : missingFields(t, values)
      const { next, found } = withDetails(t, { state: result.state, recording: result.recording || null, release: result.release || null, values: result.values || null, coverId: result.coverId || null, tries, at }, missing)
      this._update(rec, next)
      if (result.coverId && !found.includes('cover')) this.dropCover(result.coverId)
    })
  }

  /** A genres lookup is over (server/details.mjs _runGenres): a failed try keeps what the last answer gave. */
  applyGenres (id, { fileHash, state, genres, tries, at }) {
    return this._enqueue(() => {
      this._ensureLoaded()
      const rec = this._tracks.get(id)
      const t = rec === undefined ? null : JSON.parse(rec.stored)
      if (t === null || t.fileHash !== fileHash) return
      const last = t.genreLookup && t.genreLookup.fileHash === fileHash && Array.isArray(t.genreLookup.genres) ? t.genreLookup.genres : []
      const genreLookup = { v: 1, gv: GENRES_V, state, at, tries, fileHash, genres: state === 'failed' && last.length > 0 ? last : genres }
      this._update(rec, { ...t, genreLookup })
    })
  }

  /** An LRCLIB lookup is over (server/lyrics.mjs _finish). */
  applyLyrics (id, { key, state, found, at }) {
    return this._enqueue(async () => {
      this._ensureLoaded()
      const rec = this._tracks.get(id)
      if (rec === undefined) return
      const t = JSON.parse(rec.stored)
      const e = t.lyr
      if (e === null || e.from === 'tag' || e.from === 'lrc') return
      if (keyOf(t) !== key) {
        this.lookups.request(id, rec)
        return
      }
      let lyr
      let text
      if (state === 'found') {
        lyr = { kind: found.kind, from: 'lrclib', key, lookup: { state, at, tries: 1 } }
        text = found.kind === 'instrumental' ? null : found
      } else if (state === 'none') {
        lyr = { kind: null, from: null, key, lookup: { state, at, tries: 1 } }
        text = null
      } else {
        const tries = e.lookup !== null && e.lookup.state === 'failed' && e.key === key ? e.lookup.tries + 1 : 1
        lyr = { kind: e.kind, from: e.from, key, lookup: { state: 'failed', at, tries } }
        text = undefined
      }
      if (text) await this._writeLyrics(id, text)
      const had = rec.shown
      const next = this._update(rec, { ...t, lyr })
      if (had !== null && next.shown === null) this._removeLyrics(id)
    })
  }

  // A track's stored fields changed by a lookup: one line; the version moves only
  // when what clients see moved.
  _update (rec, next) {
    const probe = this._recOf(rec.id, next, this.version, { line: false })
    const moves = probe.served !== rec.served
    const { v, epoch } = this._versionFor(moves)
    const out = this._recOf(rec.id, next, v)
    this._commit({ v, epoch, lines: [out.line], puts: [out] })
    this.lookups.request(out.id, out)
    this._compactMaybe()
    return out
  }

  coverExists (coverId) {
    try {
      return this._fs.statSync(path.join(this.dir, 'art', coverId + '.large.jpg')).isFile()
    } catch {
      return false
    }
  }

  /** The two sizes of a cover the host made, kept in the art folder: its id, or null. */
  async writeCover (cover) {
    const c = coverOf(cover)
    if (c === null) return null
    const base = path.join(this.dir, 'art', c.coverId)
    await writeFileAtomic(base + '.small.jpg', c.small)
    await writeFileAtomic(base + '.large.jpg', c.large)
    return c.coverId
  }

  /** A network cover no track shows any more: its files go. */
  dropCover (coverId) {
    if (this._art.has(coverId)) return
    for (const size of COVER_SIZES) {
      try {
        this._fs.unlinkSync(path.join(this.dir, 'art', coverId + '.' + size + '.jpg'))
      } catch {}
    }
  }

  readCaa () {
    const map = new Map()
    try {
      const data = JSON.parse(b4a.toString(this._fs.readFileSync(path.join(this.dir, 'caa.json')), 'utf8'))
      for (const [id, e] of Object.entries(data && data.caa ? data.caa : {})) {
        if (!/^[0-9a-f-]{36}$/.test(id) || !e || !Number.isFinite(e.at)) continue
        map.set(id, { coverId: typeof e.coverId === 'string' && ID_RE.test(e.coverId) ? e.coverId : null, at: e.at })
      }
    } catch {}
    return map
  }

  writeCaa (map) {
    writeFileAtomic(path.join(this.dir, 'caa.json'), b4a.from(JSON.stringify({ schema: 1, caa: Object.fromEntries(map) }), 'utf8'))
      .catch((err) => this._log('caa.json not written: ' + ((err && err.message) || err)))
  }

  /** The network changed (the host's `network`): a lookup held by a metered network goes on. */
  networkChanged () {
    if (this.lookups !== null) this.lookups.networkChanged()
  }

  async _writeLyrics (id, text) {
    const body = text.kind === 'synced' ? { kind: 'synced', lines: text.lines } : { kind: 'plain', text: text.text }
    await writeFileAtomic(path.join(this.dir, 'lyrics', id + '.json'), b4a.from(JSON.stringify(body), 'utf8'))
  }

  _removeLyrics (id) {
    try {
      this._fs.unlinkSync(path.join(this.dir, 'lyrics', id + '.json'))
    } catch {}
  }

  // ----------------------------------------------------------- the routes

  /** /s/0000/<target>: answered here, never forwarded (the person's data aside). */
  async handle (conn, req, target, rest) {
    const q = target.indexOf('?')
    const p = q === -1 ? target : target.slice(0, q)
    const query = parseQuery(q === -1 ? '' : target.slice(q + 1))
    const read = req.method === 'GET' || req.method === 'HEAD'
    if (PERSON_RE.test(p)) return this._personRoute(conn, req, target, rest)
    if (p === '/api/library' && read) return this._library(conn, req, query)
    let m = /^\/api\/cover\/([^/]+)$/.exec(p)
    if (m !== null && read) return this._cover(conn, req, m[1], query)
    m = /^\/api\/lyrics\/([^/]+)$/.exec(p)
    if (m !== null && read) return this._lyrics(conn, req, m[1])
    if (p === '/api/admin/source' && req.method === 'PATCH') return this._patchSource(conn, req, rest)
    if (p.startsWith('/api/stream/')) return this._error(conn, 404, 'Brano non trovato')
    return this._error(conn, 404, 'Risorsa non trovata')
  }

  _error (conn, status, message, code = null) {
    const body = { error: message }
    if (code !== null) body.code = code
    return this._host.json(conn, status, body)
  }

  _personRoute (conn, req, target, rest) {
    const home = this._host.home()
    if (home !== null && home !== PHONE_ID) return this._host.forward(conn, req, { id: home, target }, rest)
    if (this._person !== null) return this._person.handle(conn, req, target, rest)
    return this._error(conn, 404, 'Risorsa non trovata')
  }

  // GET and HEAD /api/library: the source's answer, with or without deltas.
  async _library (conn, req, query) {
    const user = this._user()
    const tag = 'W/"' + (this._host.profileId() || 'owner') + '.' + this.version + '.' + user.version + '.' + this.epoch.id + '.' + user.epoch + '"'
    const common = { ETag: tag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' }
    if (etagMatches(req.map['if-none-match'], tag)) return this._host.send(conn, 304, common, null)
    const mode = query.get('delta') === '1' ? 1 : query.get('delta') === '2' ? 2 : 0
    const source = { name: PHONE_NAME, named: true, details: this.details, social: 0 }
    const version = this.version
    let tracks = 'full' // null: the client's are current; { changed, removed }: a delta
    let head
    if (mode === 0) {
      if (query.get('have') === String(version)) tracks = null
      const u = await this._userPart(null, null, 0)
      head = {
        version,
        userVersion: u.version,
        tracks: null,
        playlists: u.playlists,
        likes: u.likes,
        recents: u.recents,
        covers: tracks === null ? { playlist: u.covers } : { track: {}, album: {}, playlist: u.covers },
        you: null,
        source
      }
    } else {
      const have = numberOf(query.get('have'))
      const he = hexOf(query.get('he'))
      if (have !== null && have === version && he === this.epoch.id) {
        tracks = null
      } else {
        this._ensureLoaded()
        const d = this._changesSince(he, have)
        if (d !== null && d.changed.length <= this._tracks.size / 2) tracks = d
      }
      const u = await this._userPart(numberOf(query.get('uv')), hexOf(query.get('ue')), mode)
      const covers = tracks === null ? {} : { track: {}, album: {} }
      covers.playlist = u.covers
      head = {
        version,
        userVersion: u.version,
        epochs: { shared: this.epoch.id, user: u.epoch },
        delta: { shared: tracks !== null && tracks !== 'full', user: u.delta },
        tracks: null,
        playlists: u.playlists,
        likes: u.likes,
        recents: u.recents,
        covers,
        you: null,
        source
      }
    }
    if (tracks === 'full') this._ensureLoaded()
    const json = JSON.stringify(head)
    const at = json.indexOf('"tracks":null') + '"tracks":'.length
    const headers = { ...common, 'Content-Type': 'application/json; charset=utf-8' }
    return this._host.pieces(conn, 200, headers, this._libraryPieces(json.slice(0, at), tracks, json.slice(at + 4)))
  }

  * _libraryPieces (before, tracks, after) {
    yield before
    if (tracks === null) {
      yield 'null'
    } else if (tracks === 'full') {
      yield '['
      yield * this._slices(this._tracks.values())
      yield ']'
    } else {
      yield '{"changed":['
      yield * this._slices(tracks.changed)
      yield '],"removed":' + JSON.stringify(tracks.removed) + '}'
    }
    yield after
  }

  * _slices (recs) {
    let text = ''
    let n = 0
    for (const rec of recs) {
      text += (n === 0 ? '' : ',') + rec.served
      if (++n % TRACK_SLICE === 0) {
        yield text
        text = ''
      }
    }
    if (text !== '') yield text
  }

  // The person's part of the answer: the phone store's (while it is the home), else none.
  _userPart (uv, ue, mode) {
    if (this._person !== null && this._host.home() === PHONE_ID) return this._person.libraryPart(uv, ue, mode)
    return { version: 0, epoch: ZERO_EPOCH, delta: false, playlists: [], likes: [], recents: [], covers: {} }
  }

  /**
   * What changed since (he, have): null when this log cannot prove the client's
   * state (an epoch not its own, a version outside its range, below the horizon).
   */
  _changesSince (he, have) {
    if (he === null || have === null || have < this._horizon) return null
    const ep = this._epochs.find((e) => e.id === he)
    if (ep === undefined || have < ep.first || have > ep.last) return null
    const changed = []
    for (const rec of this._tracks.values()) if (rec.v > have) changed.push(rec)
    const removed = new Set()
    for (let i = this._tombs.length - 1; i >= 0 && this._tombs[i][0] > have; i--) removed.add(this._tombs[i][1])
    return { changed, removed: [...removed].reverse() }
  }

  async _cover (conn, req, coverId, query) {
    const size = query.has('size') ? query.get('size') : null
    if (size !== null && !COVER_SIZES.includes(size)) return this._error(conn, 400, 'Dimensione non valida')
    if (!ID_RE.test(coverId)) return this._error(conn, 404, 'Copertina non trovata')
    const s = size || 'large'
    const files = [[path.join(this.dir, 'art', coverId + '.' + s + '.jpg'), coverId + '.' + s]]
    if (this.artDir !== null) files.push([path.join(this.artDir, coverId + '.' + s + '.jpg'), coverId + '.' + s])
    files.push([path.join(this.dir, 'person-covers', coverId + '.jpg'), coverId])
    for (const [file, name] of files) {
      let data
      try {
        data = await this._fs.promises.readFile(file)
      } catch {
        continue
      }
      const tag = '"' + name + '"'
      const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': IMMUTABLE, ETag: tag }
      if (etagMatches(req.map['if-none-match'], tag)) return this._host.send(conn, 304, headers, null)
      return this._host.send(conn, 200, { ...headers, 'Content-Length': data.byteLength }, data)
    }
    return this._error(conn, 404, 'Copertina non trovata')
  }

  async _lyrics (conn, req, trackId) {
    const none = () => this._error(conn, 404, 'Testo non trovato', 'no_lyrics')
    if (!ID_RE.test(trackId)) return none()
    this._ensureLoaded()
    const rec = this._tracks.get(trackId)
    if (rec === undefined || rec.shown === null) return none()
    const lyr = JSON.parse(rec.stored).lyr
    let bytes
    let text
    try {
      bytes = await this._fs.promises.readFile(path.join(this.dir, 'lyrics', trackId + '.json'))
      text = JSON.parse(b4a.toString(bytes, 'utf8'))
    } catch {
      return none()
    }
    const body = { trackId, kind: lyr.kind }
    if (lyr.kind === 'synced' && text && Array.isArray(text.lines)) body.lines = text.lines
    else if (lyr.kind === 'plain' && text && typeof text.text === 'string') body.text = text.text
    else return none()
    body.from = lyr.from
    const tag = '"y' + sha256Hex(b4a.concat([bytes, b4a.from(String(lyr.from), 'utf8')])).slice(0, 16) + '"'
    const headers = { ETag: tag, 'Cache-Control': 'no-cache' }
    if (etagMatches(req.map['if-none-match'], tag)) return this._host.send(conn, 304, headers, null)
    return this._host.json(conn, 200, body, headers)
  }

  // PATCH /api/admin/source { details }: the switch of the phone's music.
  async _patchSource (conn, req, rest) {
    const raw = await this._host.readBody(conn, req, rest)
    if (raw === null) return
    let body = null
    try {
      body = JSON.parse(b4a.toString(raw, 'utf8'))
    } catch {}
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.details !== 'boolean') {
      return this._error(conn, 400, 'Richiesta non valida', 'bad_request')
    }
    try {
      await this._enqueue(() => {
        if (body.details === this.details) return
        const { v, epoch } = this._versionFor(true)
        this._commit({ v, epoch, lines: [JSON.stringify([v, 's', { details: body.details }])], details: body.details })
        this.lookups.switchChanged(body.details)
      })
    } catch {
      return this._error(conn, 500, 'Errore interno del server')
    }
    return this._host.json(conn, 200, { source: { name: PHONE_NAME, named: true, details: this.details } }, {
      'X-MPfy-Version': String(this.version),
      'X-MPfy-Epoch': this.epoch.id
    })
  }
}

function trackLine (v, id, storedText, code) {
  return '[' + v + ',"t:' + id + '",' + storedText + (code !== 0 ? ',' + code : '') + ']'
}

function newEpochId () {
  for (;;) {
    const id = b4a.toString(randomBytes(8), 'hex')
    if (id !== ZERO_EPOCH) return id
  }
}

function summaryLine (s) {
  return JSON.stringify({
    m: {
      v: s.v,
      e: [s.epoch.id, s.epoch.first],
      fb: [s.feed.token, s.feed.batch],
      n: s.count,
      d: s.details,
      q: s.q === Infinity ? null : s.q,
      sk: s.shadow.key
    }
  })
}

function validSummary (m) {
  return m !== null && typeof m === 'object' && Number.isSafeInteger(m.v) &&
    Array.isArray(m.e) && typeof m.e[0] === 'string' && HEX16_RE.test(m.e[0]) && Number.isSafeInteger(m.e[1]) &&
    Array.isArray(m.fb) && (m.fb[0] === null || typeof m.fb[0] === 'string') && Number.isSafeInteger(m.fb[1]) &&
    Number.isSafeInteger(m.n) && typeof m.d === 'boolean' && (m.q === null || Number.isFinite(m.q)) &&
    (m.sk === null || typeof m.sk === 'string')
}

// A query string (without '?') as a Map, the first value of each name.
function parseQuery (q) {
  const out = new Map()
  for (const part of q.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const k = decode(eq === -1 ? part : part.slice(0, eq))
    if (!out.has(k)) out.set(k, decode(eq === -1 ? '' : part.slice(eq + 1)))
  }
  return out
}

function decode (s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

// Malformed values are never an error: they are not known.
function numberOf (v) {
  return typeof v === 'string' && NUM_RE.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null
}

function hexOf (v) {
  return typeof v === 'string' && HEX16_RE.test(v) ? v : null
}

function syncDir (f, dir) {
  let fd = -1
  try {
    fd = f.openSync(dir, 'r')
    f.fsyncSync(fd)
  } catch {
  } finally {
    if (fd !== -1) {
      try {
        f.closeSync(fd)
      } catch {}
    }
  }
}
