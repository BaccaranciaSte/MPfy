// One person's data on disk: users/<key>.log, an append-only file of JSON lines.
//
//   {"mpfy":"user-log","schema":2,"key":"<key>","snap":"<12 digits>","from":{...}}   the header
//   {"S":{"v":Vs}}                                       a snapshot begins
//   {"P":{...},"s":Vl,"pv":Vp}  {"L":[...],"s":Vl}  {"R":[...],"s":Vl,"rv":Vr}
//   {"C":{...},"s":Vl}  {"T":[...]}  {"X":{...},"CX":{...}}                the objects
//   {"E":Ve,"sum":{"ep":[...],"h":H,"pl":[...],"pc":[...],"n":[...]}}      it is complete
//   {"e":"<16 hex>","v":E}     an epoch begins (a run of the source that changed the log)
//   {"v":V,"o":"<op>",...}     a change, as it was resolved: a replay runs no rule again
//   {"xp":{"size":S,"mtimeMs":M}}   the .json the log knows was written by export-compat
//
// A change costs one checked append of its lines; the snapshot is written again in
// the background when the changes after it outweigh it, while changes keep coming:
// each snapshot line carries the version it was made at (its stamp), and a change
// at or below the stamp of its object is skipped at replay. A snapshot reaches the
// log's name only by a rename of a finished, synced file, and the lines appended
// while it was written are synced into it before that rename, so a power cut at any
// moment leaves a file that replays to a true state.
//
// In memory (Person) a person is compact: its ids in an id table outside the heap,
// likes by slot in typed arrays, playlist entries as arrays of small integers.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { HttpError, apiError } from './errors.mjs'
import { isTrackId, isPlaylistId, isCoverId, COVER_SIZES } from './ids.mjs'
import { IdTable, Likes } from './idtable.mjs'
import { renameSyncRetry, fsyncDirSync, unlinkQuiet, logError } from './util.mjs'
import { HASH_RE } from './dbjson.mjs'

export const ZERO_EPOCH = '0000000000000000'
export const MAX_HISTORY = 1000
export const MAX_TOMBS = 10000
export const MAX_EPOCHS = 64
export const MAX_EDIT_OPS = 4096
export const MAX_EDIT_IDS = 65536
export const MAX_EDIT_OPS_PER_LIST = 32
export const MIN_EDIT_LENGTH = 1000
const MAX_LINE = 64 * 1024 * 1024
const READ_CHUNK = 1024 * 1024
const SLICE_BYTES = 256 * 1024
const KEEP_ROUND_BYTES = 64 * 1024
const SYNC_EVERY_MS = 500
const COMPACT_MIN = 1024 * 1024
const COMPACT_OPEN_MIN = 256 * 1024
const LIKES_CHUNK = 1000
const COVERS_CHUNK = 1000
const REPLAY_SLICE_MS = 5
const EPOCH_RE = /^[0-9a-f]{16}$/
const INTERNAL = 'Errore interno del server'

/** The file system calls a log makes (tests put a layer of their own in between). */
export const NODE_FS = {
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  readSync: fs.readSync,
  writeSync: fs.writeSync,
  fstatSync: fs.fstatSync,
  statSync: fs.statSync,
  ftruncateSync: fs.ftruncateSync,
  fsyncSync: fs.fsyncSync,
  fdatasyncSync: fs.fdatasyncSync,
  fsync: fs.fsync,
  fdatasync: fs.fdatasync,
  renameSync: renameSyncRetry,
  unlinkSync: fs.unlinkSync,
  fsyncDir: fsyncDirSync
}

export function newEpochId () {
  for (;;) {
    const id = crypto.randomBytes(8).toString('hex')
    if (id !== ZERO_EPOCH) return id
  }
}

export function isEpochId (s) {
  return typeof s === 'string' && EPOCH_RE.test(s) && s !== ZERO_EPOCH
}

const num = (x) => JSON.stringify(x)

/** The list without the positions in `drop` (a Set), as a new array. */
function dropPositions (list, drop) {
  const out = []
  for (let i = 0; i < list.length; i++) if (!drop.has(i)) out.push(list[i])
  return out
}

/** The list with `ids` inserted at `pos` (clamped to its length), as a new array. */
function insertAt (list, pos, ids) {
  const at = Math.min(pos, list.length)
  return list.slice(0, at).concat(ids, list.slice(at))
}
/**
 * The places 0..k-1 of `at` ordered newest first, equal times keeping their order, made
 * without a comparator. When 0..split-1 and split..k-1 are each newest first already (two
 * people's likes, as they usually are), one pass merges the two runs. Otherwise the distinct
 * times are sorted by the typed array's own sort, each place counted under its time's rank,
 * then laid out from the newest rank down.
 */
export function newestFirst (at, k, split = -1) {
  if (split >= 0 && split <= k && newestFirstRun(at, 0, split) && newestFirstRun(at, split, k)) {
    const order = new Int32Array(k)
    let a = 0
    let b = split
    let o = 0
    while (a < split && b < k) order[o++] = at[a] >= at[b] ? a++ : b++
    while (a < split) order[o++] = a++
    while (b < k) order[o++] = b++
    return order
  }
  const times = Float64Array.from(at.subarray(0, k)).sort()
  let m = 0
  for (let j = 0; j < k; j++) if (m === 0 || times[j] !== times[m - 1]) times[m++] = times[j]
  const rank = new Int32Array(k)
  const count = new Int32Array(m)
  for (let j = 0; j < k; j++) {
    const x = at[j]
    let lo = 0
    let hi = m - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (times[mid] < x) lo = mid + 1
      else hi = mid
    }
    rank[j] = lo
    count[lo]++
  }
  const start = new Int32Array(m)
  for (let g = m - 1, pos = 0; g >= 0; g--) {
    start[g] = pos
    pos += count[g]
  }
  const order = new Int32Array(k)
  for (let j = 0; j < k; j++) order[start[rank[j]]++] = j
  return order
}

function newestFirstRun (at, from, to) {
  for (let j = from + 1; j < to; j++) if (at[j] > at[j - 1]) return false
  return true
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const isTime = (x) => typeof x === 'number' && Number.isFinite(x)
const isIdList = (a) => Array.isArray(a) && a.every(isTrackId)
const isPosList = (a) => Array.isArray(a) && a.every((i) => Number.isSafeInteger(i) && i >= 0)

// ------------------------------------------------------------------ playlists

// A playlist as kept: the fields as served, in their stored order, but its entries
// are id indexes under IDS; `trackIds` is an accessor that gives them as 24 hex,
// so the object serializes (and reads) exactly as the playlist is served.
export const IDS = Symbol('trackIndexes')
const PV = Symbol('version')
const NE = Symbol('lastNonEditVersion')
const TABLE = Symbol('idTable')

function trackIdsOf () {
  const t = this[TABLE]
  const a = this[IDS]
  const out = new Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = t.hex(a[i])
  return out
}

const TRACK_IDS = { get: trackIdsOf, enumerable: true, configurable: true }

function put (o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
  else o[k] = v
}

function makeRecord (src, table, ids, v) {
  const p = {}
  let placed = false
  for (const k of Object.keys(src)) {
    if (k === 'trackIds') {
      Object.defineProperty(p, 'trackIds', TRACK_IDS)
      placed = true
    } else put(p, k, src[k])
  }
  if (!placed) Object.defineProperty(p, 'trackIds', TRACK_IDS)
  p[IDS] = ids
  p[TABLE] = table
  p[PV] = v
  p[NE] = v
  return p
}

/** A playlist as it leaves the person: a plain object, trackIds as 24 hex, its fields in order. */
export function publicPlaylist (p) {
  const out = {}
  for (const k of Object.keys(p)) put(out, k, p[k])
  return out
}

// ------------------------------------------------------------------ removals kept

const KIND = { p: 1, l: 2, c: 3 }
const KIND_NAME = ['', 'p', 'l', 'c']
const KIND_BYTES = [0, 8, 12, 8]

/** The newest removals (deleted playlists, unliked ids, cleared covers) with their versions. */
export class TombRing {
  constructor (size = MAX_TOMBS) {
    this.size = size
    // Arrays grown as removals come (most people make few), up to `size` entries.
    this.cap = 0
    this.kind = new Uint8Array(0)
    this.ids = Buffer.alloc(0)
    this.v = new Float64Array(0)
    this.head = 0
    this.count = 0
    // The newest version dropped from the ring: a delta cannot reach below it.
    this.horizon = 0
  }

  _grow () {
    const cap = Math.min(this.size, Math.max(64, this.cap * 2))
    const kind = new Uint8Array(cap)
    const ids = Buffer.alloc(cap * 12)
    const v = new Float64Array(cap)
    for (let j = 0; j < this.count; j++) {
      const i = this._at(j)
      kind[j] = this.kind[i]
      this.ids.copy(ids, j * 12, i * 12, i * 12 + 12)
      v[j] = this.v[i]
    }
    this.kind = kind
    this.ids = ids
    this.v = v
    this.cap = cap
    this.head = this.count % cap
  }

  push (kind, hex, v) {
    if (this.count === this.cap && this.cap < this.size) this._grow()
    if (this.count === this.cap) this.horizon = Math.max(this.horizon, this.v[this.head])
    else this.count++
    const k = KIND[kind]
    this.kind[this.head] = k
    this.ids.write(hex, this.head * 12, KIND_BYTES[k], 'hex')
    this.v[this.head] = v
    this.head = (this.head + 1) % this.cap
  }

  _at (j) {
    return (this.head - this.count + j + this.cap) % this.cap
  }

  /** The removals after version u, oldest first: [kind, hex, v]. */
  * since (u = -Infinity) {
    let lo = 0
    let hi = this.count
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.v[this._at(mid)] > u) hi = mid
      else lo = mid + 1
    }
    for (let j = lo; j < this.count; j++) {
      const i = this._at(j)
      const k = this.kind[i]
      yield [KIND_NAME[k], this.ids.toString('hex', i * 12, i * 12 + KIND_BYTES[k]), this.v[i]]
    }
  }

  line () {
    return '{"T":' + JSON.stringify([...this.since()]) + '}\n'
  }
}

// ------------------------------------------------------------------ playlist edits kept

/**
 * The newest resolved adds and removals of playlist entries (for answers that send a
 * long playlist as its edits): per op the playlist id, the kind, the position, the
 * version and its integers (id indexes for an add, positions for a removal), all in
 * typed arrays grown as ops come, up to `maxOps` ops and `maxInts` integers. `horizon`:
 * the newest version of an op no longer kept.
 */
export class EditRing {
  constructor (maxOps = MAX_EDIT_OPS, maxInts = MAX_EDIT_IDS) {
    this.maxOps = maxOps
    this.maxInts = maxInts
    this.cap = 0
    this.pool = new Int32Array(0)
    this.pid = Buffer.alloc(0)
    this.kind = new Uint8Array(0)
    this.pos = new Int32Array(0)
    this.v = new Float64Array(0)
    this.off = new Int32Array(0)
    this.cnt = new Int32Array(0)
    this.first = 0
    this.count = 0
    this.head = 0 // where the next op's integers go; the live ones are [off of the first, head)
    this.horizon = 0
  }

  clear (v) {
    this.first = 0
    this.count = 0
    this.head = 0
    this.horizon = Math.max(this.horizon, v)
  }

  _slot (j) {
    return (this.first + j) % this.cap
  }

  _growOps () {
    const cap = Math.min(this.maxOps, Math.max(16, this.cap * 2))
    const pid = Buffer.alloc(cap * 8)
    const kind = new Uint8Array(cap)
    const pos = new Int32Array(cap)
    const v = new Float64Array(cap)
    const off = new Int32Array(cap)
    const cnt = new Int32Array(cap)
    for (let j = 0; j < this.count; j++) {
      const s = this._slot(j)
      this.pid.copy(pid, j * 8, s * 8, s * 8 + 8)
      kind[j] = this.kind[s]
      pos[j] = this.pos[s]
      v[j] = this.v[s]
      off[j] = this.off[s]
      cnt[j] = this.cnt[s]
    }
    Object.assign(this, { pid, kind, pos, v, off, cnt, cap, first: 0 })
  }

  _evict () {
    this.horizon = Math.max(this.horizon, this.v[this.first])
    this.first = (this.first + 1) % this.cap
    this.count--
    if (this.count === 0) this.head = 0
  }

  _live () {
    return this.count > 0 ? this.head - this.off[this.first] : 0
  }

  /** kind: 1 add, 2 removal. */
  push (kind, pidHex, pos, ints, v) {
    const k = ints.length
    if (k > this.maxInts) {
      this.clear(v)
      return
    }
    if (this.count === this.cap && this.cap < this.maxOps) this._growOps()
    while (this.count === this.cap) this._evict()
    if (this.head + k > this.pool.length) {
      // Room: a bigger pool while it may grow, else the oldest ops go; the live integers are
      // moved to the start.
      let size = this.pool.length
      while (size < this.maxInts && this._live() + k > size) size = Math.min(this.maxInts, Math.max(256, size * 2))
      while (this.count > 0 && this._live() + k > size) this._evict()
      const base = this.count > 0 ? this.off[this.first] : this.head
      const pool = size === this.pool.length ? this.pool : new Int32Array(size)
      if (pool !== this.pool) pool.set(this.pool.subarray(base, this.head))
      else if (base > 0) pool.copyWithin(0, base, this.head)
      for (let j = 0; j < this.count; j++) this.off[this._slot(j)] -= base
      this.head -= base
      this.pool = pool
    }
    const slot = this._slot(this.count)
    this.pid.write(pidHex, slot * 8, 8, 'hex')
    this.kind[slot] = kind
    this.pos[slot] = pos
    this.v[slot] = v
    this.off[slot] = this.head
    this.cnt[slot] = k
    for (let j = 0; j < k; j++) this.pool[this.head + j] = ints[j]
    this.head += k
    this.count++
  }

  /** The ops after version u, by playlist id, oldest first: { kind, pos, ints }. */
  after (u) {
    const out = new Map()
    for (let j = 0; j < this.count; j++) {
      const s = this._slot(j)
      if (this.v[s] <= u) continue
      const id = this.pid.toString('hex', s * 8, s * 8 + 8)
      if (!out.has(id)) out.set(id, [])
      out.get(id).push({ kind: this.kind[s], pos: this.pos[s], ints: this.pool.slice(this.off[s], this.off[s] + this.cnt[s]) })
    }
    return out
  }
}

// ------------------------------------------------------------------ CRC-32

let crcTable = null
function crc32 (text) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(text) >>> 0
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  const buf = Buffer.from(text, 'utf8')
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** The crc of a list's ids joined by ",", as 8 lowercase hex. */
export function listCrc (hexIds) {
  return crc32(hexIds.join(',')).toString(16).padStart(8, '0')
}

// ------------------------------------------------------------------ the person

function normalizeContext (c) {
  if (!c || typeof c !== 'object' || typeof c.type !== 'string') return { type: 'library' }
  const out = { type: c.type }
  if (typeof c.id === 'string') out.id = c.id.slice(0, 200)
  return out
}

/** One person's data in memory, in its compact form. */
export class Person {
  /** @param {{ likes?: number, ids?: number }} [sizes]  the counts the tables start sized for */
  constructor ({ likes = 0, ids = 0 } = {}) {
    this.table = new IdTable(Math.ceil(ids * 1.125))
    this.likes = new Likes(this.table, Math.ceil(likes * 1.125))
    this.playlists = new Map() // id -> playlist (see makeRecord)
    this.entries = 0
    this.recents = [] // newest first, at most MAX_HISTORY
    this.rv = 0
    this.covers = new Map() // playlist id -> { small, large }
    this.coverV = new Map() // playlist id -> version of its last change
    this.extra = {}
    this.coversExtra = {}
    this.tombs = new TombRing()
    this.edits = new EditRing()
    this.baseHorizon = 0
    this.walks = 0 // walks of the playlists made for removals written while not loaded (checks)
  }

  /** Below this version no delta can be given. */
  get horizon () {
    return Math.max(this.tombs.horizon, this.baseHorizon)
  }

  /**
   * The person a `.json` of today's format holds, read exactly as the source always read it,
   * every version stamped `v`.
   */
  static fromJson (data, v) {
    const person = new Person()
    if (!(data && typeof data === 'object' && !Array.isArray(data))) return person
    const { schema, version, playlists, likes, recents, covers, ...extra } = data
    person.extra = extra
    const t = person.table
    for (const p of Array.isArray(playlists) ? playlists : []) {
      if (!p || !isPlaylistId(p.id) || person.playlists.has(p.id)) continue
      const norm = {
        ...p,
        name: typeof p.name === 'string' ? p.name : '',
        description: typeof p.description === 'string' ? p.description : '',
        trackIds: [],
        createdAt: Number(p.createdAt) || 0,
        updatedAt: Number(p.updatedAt) || 0
      }
      const ids = (Array.isArray(p.trackIds) ? p.trackIds.filter(isTrackId).slice(0, 20000) : []).map((id) => t.intern(id))
      person.playlists.set(p.id, makeRecord(norm, t, ids, v))
      person.entries += ids.length
    }
    const seen = new Set()
    const kept = []
    for (const l of Array.isArray(likes) ? likes : []) {
      if (!l || !isTrackId(l.id) || seen.has(l.id)) continue
      seen.add(l.id)
      kept.push([l.id, Number(l.at) || 0])
    }
    for (let k = kept.length - 1; k >= 0; k--) person.likes.add(t.intern(kept[k][0]), kept[k][1], v)
    for (const r of Array.isArray(recents) ? recents : []) {
      if (!r || !isTrackId(r.trackId)) continue
      person.recents.push({ trackId: r.trackId, at: Number(r.at) || 0, context: normalizeTypedContext(r.context) })
      if (person.recents.length >= MAX_HISTORY) break
    }
    person.rv = v
    const c = covers && typeof covers === 'object' ? covers : {}
    const { playlist, ...coversExtra } = c
    person.coversExtra = coversExtra
    for (const [id, entry] of Object.entries(playlist && typeof playlist === 'object' ? playlist : {})) {
      if (!isPlaylistId(id) || !entry || typeof entry !== 'object') continue
      const small = isCoverId(entry.small) ? entry.small : null
      const large = isCoverId(entry.large) ? entry.large : null
      if (small !== null || large !== null) {
        person.covers.set(id, { small, large })
        person.coverV.set(id, v)
      }
    }
    return person
  }

  /** The likes as served: newest first, { id, at }. */
  likesList () {
    const out = []
    const l = this.likes
    for (let s = l.n - 1; s >= 0; s--) {
      if (!Number.isNaN(l.at[s])) out.push({ id: this.table.hex(l.idx[s]), at: l.at[s] })
    }
    return out
  }

  coversObject () {
    const o = {}
    for (const [id, e] of this.covers) o[id] = { small: e.small, large: e.large }
    return o
  }

  _skip (ctx, key, v) {
    if (ctx === null) return false
    const s = ctx.stamps.get(key)
    return s !== undefined && v <= s
  }

  _tomb (ctx, kind, hex, v) {
    if (ctx === null || v > ctx.tombsUpTo) this.tombs.push(kind, hex, v)
  }

  _ints (hexIds) {
    const out = new Array(hexIds.length)
    for (let i = 0; i < hexIds.length; i++) out[i] = this.table.intern(hexIds[i])
    return out
  }

  /**
   * Apply one change line. `ctx` (a replay) holds the stamps of the snapshot's objects and the
   * version its removals were kept at; null for a change made now. `pre`: the entries of a
   * pu or pa already as id indexes; for an x, the new arrays a sweep made (playlist id ->
   * array). Never throws on a valid line.
   */
  apply (r, ctx = null, pre = null) {
    const v = r.v
    switch (r.o) {
      case 'pc': {
        const id = r.p.id
        if (this._skip(ctx, 'p:' + id, v)) return this._touched(id, v)
        const old = this.playlists.get(id)
        if (old !== undefined) {
          this.entries -= old[IDS].length
          this.playlists.delete(id)
        }
        this.playlists.set(id, makeRecord(r.p, this.table, [], v))
        return
      }
      case 'pu': {
        const p = this.playlists.get(r.id)
        if (p === undefined) return
        if (this._skip(ctx, 'p:' + r.id, v)) return this._touched(r.id, v)
        if (r.name !== undefined) p.name = r.name
        if (r.description !== undefined) p.description = r.description
        if (r.trackIds !== undefined) {
          const ids = pre || this._ints(r.trackIds)
          this.entries += ids.length - p[IDS].length
          p[IDS] = ids
        }
        p.updatedAt = r.at
        p[PV] = v
        p[NE] = v
        return
      }
      case 'pa': {
        const p = this.playlists.get(r.id)
        if (p === undefined) return
        const ids = pre || this._ints(r.ids)
        this.edits.push(1, r.id, r.pos, ids, v)
        if (this._skip(ctx, 'p:' + r.id, v)) return
        p[IDS] = insertAt(p[IDS], r.pos, ids)
        this.entries += ids.length
        p.updatedAt = r.at
        p[PV] = v
        return
      }
      case 'pr': {
        const p = this.playlists.get(r.id)
        if (p === undefined) return
        this.edits.push(2, r.id, 0, r.idx, v)
        if (this._skip(ctx, 'p:' + r.id, v)) return
        const next = dropPositions(p[IDS], new Set(r.idx))
        this.entries -= p[IDS].length - next.length
        p[IDS] = next
        p.updatedAt = r.at
        p[PV] = v
        return
      }
      case 'pd': {
        const p = this.playlists.get(r.id)
        if (p !== undefined) {
          if (this._skip(ctx, 'p:' + r.id, v)) this._touched(r.id, v)
          else {
            this.playlists.delete(r.id)
            this.entries -= p[IDS].length
            this._tomb(ctx, 'p', r.id, v)
          }
        }
        if (this.covers.has(r.id) && !this._skip(ctx, 'c:' + r.id, v)) {
          this.covers.delete(r.id)
          this.coverV.delete(r.id)
          this._tomb(ctx, 'c', r.id, v)
        }
        return
      }
      case 'l':
        this.likes.add(this.table.intern(r.id), r.at, v)
        return
      case 'u':
        this._unlike(r.id, ctx, v)
        return
      case 'lb':
        for (const id of r.rm) this._unlike(id, ctx, v)
        for (const [id, at] of r.add) this.likes.add(this.table.intern(id), at, v)
        return
      case 'r': {
        if (this._skip(ctx, 'r', v)) return
        const at = r.r.at
        let i = 0
        while (i < this.recents.length && this.recents[i].at > at) i++
        if (i >= MAX_HISTORY) return
        this.recents.splice(i, 0, { trackId: r.r.trackId, at, context: r.r.context })
        if (this.recents.length > MAX_HISTORY) this.recents.length = MAX_HISTORY
        this.rv = v
        return
      }
      case 'cs': {
        if (this._skip(ctx, 'c:' + r.id, v)) return
        const entry = this.covers.get(r.id) || { small: null, large: null }
        entry[r.size] = r.cover
        this.covers.set(r.id, entry)
        this.coverV.set(r.id, v)
        return
      }
      case 'cc': {
        if (this._skip(ctx, 'c:' + r.id, v)) return
        const entry = this.covers.get(r.id)
        if (entry === undefined) return
        for (const size of r.sizes || COVER_SIZES) entry[size] = null
        if (entry.small === null && entry.large === null) {
          this.covers.delete(r.id)
          this.coverV.delete(r.id)
          this._tomb(ctx, 'c', r.id, v)
        } else this.coverV.set(r.id, v)
        return
      }
      case 'x': {
        for (const [pid, positions] of r.pl) {
          const p = this.playlists.get(pid)
          if (p === undefined) continue
          if (this._skip(ctx, 'p:' + pid, v)) {
            this._touched(pid, v)
            continue
          }
          const next = pre !== null && pre.has(pid) ? pre.get(pid) : dropPositions(p[IDS], new Set(positions))
          this.entries -= p[IDS].length - next.length
          p[IDS] = next
          p.updatedAt = r.at
          p[PV] = v
          p[NE] = v
        }
        this._dropLikesAndPlays(r.ids, ctx, v)
        return
      }
      case 'xu':
        return this.applyRemovals([r], ctx)
      case 'z':
        this.baseHorizon = Math.max(this.baseHorizon, v)
    }
  }

  // A change a snapshot line already holds: only what a delta needs to know of it.
  _touched (id, v) {
    const p = this.playlists.get(id)
    if (p !== undefined && p[NE] < v) p[NE] = v
  }

  // An unlike at version v. At replay the like held may be one made after it (written by a
  // snapshot that was walking while it came): its own version (lv) is its stamp, and an unlike
  // at or below it is skipped, so the like stays where the snapshot put it.
  _unlike (hex, ctx, v) {
    const i = this.table.find(hex)
    if (ctx !== null && this.likes.has(i) && this.likes.lvOf(i) >= v) return
    if (this.likes.remove(i)) this._tomb(ctx, 'l', hex, v)
  }

  _dropLikesAndPlays (hexIds, ctx, v) {
    const gone = new Set(hexIds)
    for (const id of gone) this._unlike(id, ctx, v)
    if (this._skip(ctx, 'r', v)) return
    const kept = this.recents.filter((x) => !gone.has(x.trackId))
    if (kept.length !== this.recents.length) {
      this.recents = kept
      this.rv = v
    }
  }

  /**
   * A run of removals written for a person not loaded (`xu` lines), applied by one walk with
   * the version of the run's last line: a playlist that lost an entry takes as `updatedAt` the
   * newest time among the lines whose ids it lost.
   */
  applyRemovals (lines, ctx = null) {
    if (lines.length === 0) return
    const v = lines[lines.length - 1].v
    const newest = new Map() // id index -> newest time of a line naming it
    const hex = []
    for (const r of lines) {
      for (const id of r.ids) {
        hex.push(id)
        const i = this.table.find(id)
        if (i < 0) continue
        const t = newest.get(i)
        if (t === undefined || r.at > t) newest.set(i, r.at)
      }
    }
    if (newest.size > 0) {
      this.walks++
      for (const [pid, p] of this.playlists) {
        if (this._skip(ctx, 'p:' + pid, v)) {
          this._touched(pid, v)
          continue
        }
        const cur = p[IDS]
        let at = null
        let next = null
        for (let k = 0; k < cur.length; k++) {
          const t = newest.get(cur[k])
          if (t === undefined) {
            if (next !== null) next.push(cur[k])
            continue
          }
          if (next === null) next = cur.slice(0, k)
          if (at === null || t > at) at = t
        }
        if (next === null) continue
        this.entries -= cur.length - next.length
        p[IDS] = next
        p.updatedAt = at
        p[PV] = v
        p[NE] = v
      }
    }
    this._dropLikesAndPlays(hex, ctx, v)
  }

  /** One object line of a snapshot, at replay. False when the line is not one. */
  loadLine (r, stamps) {
    if (isObj(r.P)) {
      if (!isPlaylistId(r.P.id) || !isIdList(r.P.trackIds)) return false
      const id = r.P.id
      const old = this.playlists.get(id)
      // A second line for an id: the playlist was made again while the snapshot was written.
      if (old !== undefined) {
        this.entries -= old[IDS].length
        this.playlists.delete(id)
      }
      const ids = this._ints(r.P.trackIds)
      const p = makeRecord(r.P, this.table, ids, num0(r.pv))
      p[NE] = 0
      this.playlists.set(id, p)
      this.entries += ids.length
      stamps.set('p:' + id, num0(r.s))
      return true
    }
    if (Array.isArray(r.L)) {
      for (const e of r.L) {
        if (!Array.isArray(e) || !isTrackId(e[0])) return false
        const i = this.table.intern(e[0])
        // An id met again: unliked and liked again while the snapshot was written; the later
        // slot is the like that holds.
        this.likes.remove(i)
        this.likes.add(i, num0(e[1]), num0(e[2]))
      }
      return true
    }
    if (Array.isArray(r.R)) {
      this.recents = r.R.filter((x) => isObj(x) && isTrackId(x.trackId)).slice(0, MAX_HISTORY)
      this.rv = num0(r.rv)
      stamps.set('r', num0(r.s))
      return true
    }
    if (isObj(r.C)) {
      for (const [id, e] of Object.entries(r.C)) {
        if (!isPlaylistId(id) || !isObj(e)) return false
        this.covers.set(id, { small: isCoverId(e.small) ? e.small : null, large: isCoverId(e.large) ? e.large : null })
        this.coverV.set(id, num0(e.v))
        stamps.set('c:' + id, num0(r.s))
      }
      return true
    }
    if (Array.isArray(r.T)) {
      for (const e of r.T) {
        if (!Array.isArray(e) || !(e[0] in KIND) || typeof e[1] !== 'string') return false
        this.tombs.push(e[0], e[1], num0(e[2]))
      }
      return true
    }
    if (isObj(r.X) || isObj(r.CX)) {
      this.extra = isObj(r.X) ? r.X : {}
      this.coversExtra = isObj(r.CX) ? r.CX : {}
      return true
    }
    return false
  }

  /**
   * The object lines of a snapshot made from the live state, each when it is reached;
   * `stamp()` gives the version of that moment. Changes may come between two lines.
   */
  * bodyLines (stamp) {
    for (const p of this.playlists.values()) yield '{"P":' + JSON.stringify(p) + ',"s":' + stamp() + ',"pv":' + p[PV] + '}\n'
    const l = this.likes
    l.walkers++
    try {
      let s = 0
      while (s < l.n) {
        const parts = []
        for (; s < l.n && parts.length < LIKES_CHUNK; s++) {
          if (Number.isNaN(l.at[s])) continue
          parts.push('["' + this.table.hex(l.idx[s]) + '",' + num(l.at[s]) + ',' + num(l.lv[s]) + ']')
        }
        if (parts.length > 0) yield '{"L":[' + parts.join(',') + '],"s":' + stamp() + '}\n'
      }
    } finally {
      l.walkers--
    }
    yield '{"R":' + JSON.stringify(this.recents) + ',"s":' + stamp() + ',"rv":' + this.rv + '}\n'
    let chunk = []
    for (const [id, e] of this.covers) {
      chunk.push(JSON.stringify(id) + ':{"small":' + JSON.stringify(e.small) + ',"large":' + JSON.stringify(e.large) + ',"v":' + (this.coverV.get(id) || 0) + '}')
      if (chunk.length === COVERS_CHUNK) {
        yield '{"C":{' + chunk.join(',') + '},"s":' + stamp() + '}\n'
        chunk = []
      }
    }
    if (chunk.length > 0) yield '{"C":{' + chunk.join(',') + '},"s":' + stamp() + '}\n'
  }

  /**
   * Another person's playlist added at the end (a merge): its ids interned here (`map`, when
   * given, holds them already: the other table's index -> this one's).
   */
  copyPlaylist (p, srcTable, map = null) {
    const src = p[IDS]
    const ids = new Array(src.length)
    for (let k = 0; k < src.length; k++) ids[k] = this._internFrom(srcTable, src[k], map)
    const copy = makeRecord(p, this.table, ids, p[PV])
    this.playlists.set(copy.id, copy)
    this.entries += ids.length
    return copy
  }

  _internFrom (srcTable, i, map) {
    return map !== null && i < map.length ? map[i] : this.table.intern(srcTable.hex(i))
  }

  /**
   * The ids of another table interned in this person's, a slice at a time (a merge, before it
   * changes anything: an index never moves, so nothing of this person changes meanwhile).
   * Resolves with the map: the other table's index -> this one's (null when given up).
   */
  async internAhead (srcTable, { sliceMs = 5, live = () => true } = {}) {
    const n = srcTable.n
    const map = new Int32Array(n)
    let t0 = performance.now()
    for (let i = 0; i < n; i++) {
      map[i] = this.table.intern(srcTable.hex(i))
      if ((i & 255) === 255 && performance.now() - t0 > sliceMs) {
        await new Promise((resolve) => setImmediate(resolve))
        if (!live()) return null
        t0 = performance.now()
      }
    }
    return map
  }

  /** The image ids the playlist covers name. */
  coverIds () {
    const ids = []
    for (const e of this.covers.values()) {
      if (e.small) ids.push(e.small)
      if (e.large) ids.push(e.large)
    }
    return ids
  }

  /**
   * Every version this person holds set to v (a merge; the horizon moves with the reset line
   * written at v).
   */
  stampAll (v) {
    for (const p of this.playlists.values()) {
      p[PV] = v
      p[NE] = v
    }
    const l = this.likes
    for (let s = 0; s < l.n; s++) l.lv[s] = v
    this.rv = v
    for (const id of this.covers.keys()) this.coverV.set(id, v)
    this.edits.clear(v)
  }

  /**
   * Another person's data joined into this one at version v (a merge), with the result the
   * format before gave: its playlists this one lacks appended in its order; likes united, an
   * id in both keeping the newest time, ordered newest first with equal times in the order of
   * a Map filled with this person's likes newest first and then the other's (a duplicate keeps
   * the place of its first appearance); plays united by track, time and context, newest first,
   * cut at 1,000; its cover entries this one lacks. Everything then stamped v. The likes are
   * merged on the tables (no object per like); `map` holds the other's ids interned here ahead
   * (internAhead), any it lacks is interned now; `probe(step)`, when given, is called between
   * the steps (checks).
   */
  mergeFrom (src, v, probe = null, map = null) {
    const step = (name) => {
      if (probe !== null) probe(name)
    }
    for (const [id, p] of src.playlists) if (!this.playlists.has(id)) this.copyPlaylist(p, src.table, map)
    step('playlists')
    const t = this.table
    const tl = this.likes
    const fl = src.likes
    const n = tl.live + fl.live
    const at = new Float64Array(n)
    const idx = new Int32Array(n)
    let k = 0
    for (let s = tl.n - 1; s >= 0; s--) {
      if (Number.isNaN(tl.at[s])) continue
      at[k] = tl.at[s]
      idx[k] = tl.idx[s]
      k++
    }
    const mine = k
    // Where each id of the table stands in that order (the other's ids are interned here:
    // indexes only grow).
    const place = new Int32Array(t.n + fl.live).fill(-1)
    for (let j = 0; j < k; j++) place[idx[j]] = j
    for (let s = fl.n - 1; s >= 0; s--) {
      if (Number.isNaN(fl.at[s])) continue
      const i = this._internFrom(src.table, fl.idx[s], map)
      const j = place[i]
      if (j >= 0) {
        if (fl.at[s] > at[j]) at[j] = fl.at[s]
        continue
      }
      at[k] = fl.at[s]
      idx[k] = i
      place[i] = k
      k++
    }
    step('likes united')
    const order = newestFirst(at, k, mine)
    step('likes sorted')
    const oldestIdx = new Int32Array(k)
    const oldestAt = new Float64Array(k)
    for (let j = 0; j < k; j++) {
      const o = order[k - 1 - j]
      oldestIdx[j] = idx[o]
      oldestAt[j] = at[o]
    }
    this.likes.replaceAll(oldestIdx, oldestAt, v)
    step('likes')
    // A merge cut before the other person's log went runs again: a play already here stays once.
    const plays = new Map()
    for (const r of [...this.recents, ...src.recents]) plays.set(r.trackId + '|' + r.at + '|' + JSON.stringify(r.context), r)
    this.recents = [...plays.values()].sort((a, b) => b.at - a.at).slice(0, MAX_HISTORY)
    for (const [id, entry] of src.covers) {
      if (!this.covers.has(id)) this.covers.set(id, { small: entry.small, large: entry.large })
    }
    this.stampAll(v)
    step('done')
  }

  /**
   * What moved after version u: playlists changed (Map order) and removed, likes added
   * (oldest first, an iterable of [id, at] made as it is read: see likesAfter) and removed,
   * whether the plays moved, the covers moved. With `edits`, a long playlist whose only
   * changes since u are a few kept adds and removals comes as its ops.
   */
  changes (u, { edits = false } = {}) {
    const removed = new Set()
    const unliked = new Set()
    const coversGone = new Set()
    for (const [kind, id] of this.tombs.since(u)) {
      if (kind === 'p') removed.add(id)
      else if (kind === 'l') unliked.add(id)
      else coversGone.add(id)
    }
    const ops = edits && this.edits.horizon <= u ? this.edits.after(u) : null
    const changed = []
    const edited = new Map()
    for (const [id, p] of this.playlists) {
      if (p[PV] <= u) continue
      const e = ops !== null && p[NE] <= u ? this._editsOf(p, ops.get(id)) : null
      if (e !== null) edited.set(id, e)
      else changed.push(id)
    }
    const added = likesAfter(this, u)
    const covers = []
    for (const [id, cv] of this.coverV) if (cv > u) covers.push(id)
    for (const id of coversGone) if (!this.coverV.has(id) || this.coverV.get(id) <= u) covers.push(id)
    return {
      playlists: { changed, removed: [...removed], edits: edited },
      likes: { added, removed: [...unliked] },
      recents: this.rv > u,
      covers
    }
  }

  _editsOf (p, list) {
    const len = p[IDS].length
    if (list === undefined || list.length === 0 || list.length > MAX_EDIT_OPS_PER_LIST || len <= MIN_EDIT_LENGTH) return null
    let from = len
    for (const op of list) from += op.kind === 1 ? -op.ints.length : op.ints.length
    const t = this.table
    const ops = list.map((op) => op.kind === 1
      ? ['a', op.pos, Array.from(op.ints, (i) => t.hex(i))]
      : ['r', Array.from(op.ints)])
    const ids = new Array(len)
    for (let k = 0; k < len; k++) ids[k] = t.hex(p[IDS][k])
    return { from, to: len, ops, crc: listCrc(ids) }
  }

  /** The whole state with every version, for checks. */
  view () {
    const l = this.likes
    const likes = []
    for (let s = 0; s < l.n; s++) if (!Number.isNaN(l.at[s])) likes.push([this.table.hex(l.idx[s]), l.at[s], l.lv[s]])
    return {
      playlists: [...this.playlists.values()].map((p) => ({ ...publicPlaylist(p), pv: p[PV] })),
      entries: this.entries,
      likes,
      recents: this.recents.map((r) => ({ ...r, context: { ...r.context } })),
      rv: this.rv,
      covers: [...this.covers].map(([id, e]) => [id, e.small, e.large, this.coverV.get(id)]),
      extra: this.extra,
      coversExtra: this.coversExtra
    }
  }
}

// The likes added after version u, oldest first, as [id, at] pairs made one at a time while
// they are written (a delta of 100,000 likes is never built at once). The walk reads the slots
// of its start: none is repacked meanwhile; a like removed meanwhile is left out (its removal
// has a later version), and arrays grown or replaced meanwhile are not the ones read.
function likesAfter (p, u) {
  return {
    * [Symbol.iterator] () {
      const l = p.likes
      const table = p.table
      const n = l.n
      const idx = l.idx
      const at = l.at
      l.walkers++
      try {
        for (let s = l.firstAfter(u); s < n; s++) {
          if (!Number.isNaN(at[s])) yield [table.hex(idx[s]), at[s]]
        }
      } finally {
        l.walkers--
      }
    }
  }
}

function normalizeTypedContext (c) {
  const types = ['playlist', 'album', 'artist', 'liked', 'library', 'search']
  if (!c || typeof c !== 'object' || !types.includes(c.type)) return { type: 'library' }
  return normalizeContext(c)
}

function num0 (x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

// ------------------------------------------------------------------ lines on disk

/** A change line that may be replayed (a line that is not one ends the trusted part). */
function validChange (r) {
  if (!Number.isSafeInteger(r.v) || r.v < 1) return false
  switch (r.o) {
    case 'pc': return isObj(r.p) && isPlaylistId(r.p.id)
    case 'pu': return isPlaylistId(r.id) && (r.name === undefined || typeof r.name === 'string') &&
      (r.description === undefined || typeof r.description === 'string') && (r.trackIds === undefined || isIdList(r.trackIds)) && isTime(r.at)
    case 'pa': return isPlaylistId(r.id) && Number.isSafeInteger(r.pos) && r.pos >= 0 && isIdList(r.ids) && isTime(r.at)
    case 'pr': return isPlaylistId(r.id) && isPosList(r.idx) && isTime(r.at)
    case 'pd': return isPlaylistId(r.id)
    case 'l': return isTrackId(r.id) && isTime(r.at)
    case 'u': return isTrackId(r.id)
    case 'lb': return Array.isArray(r.add) && r.add.every((a) => Array.isArray(a) && isTrackId(a[0]) && isTime(a[1])) && isIdList(r.rm)
    case 'r': return isObj(r.r) && isTrackId(r.r.trackId) && isTime(r.r.at) && isObj(r.r.context)
    case 'cs': return isPlaylistId(r.id) && COVER_SIZES.includes(r.size) && isCoverId(r.cover)
    case 'cc': return isPlaylistId(r.id) && (r.sizes === undefined || (Array.isArray(r.sizes) && r.sizes.every((s) => COVER_SIZES.includes(s))))
    case 'x': return isIdList(r.ids) && Array.isArray(r.pl) && r.pl.every((e) => Array.isArray(e) && isPlaylistId(e[0]) && isPosList(e[1])) && isTime(r.at)
    case 'xu': return isIdList(r.ids) && isTime(r.at)
    case 'z': return true
  }
  return false
}

export function headerLine (key, from) {
  const h = { mpfy: 'user-log', schema: 2, key, snap: '000000000000' }
  if (from) h.from = validStat(from)
  return JSON.stringify(h) + '\n'
}

function snapDigitsAt (header) {
  return Buffer.byteLength(header.slice(0, header.indexOf('"snap":"') + 8))
}

// The stat of the .json a log knows, with the hash of its bytes when known.
function validStat (x) {
  if (!isObj(x) || !Number.isFinite(x.size) || !Number.isFinite(x.mtimeMs)) return null
  const out = { size: x.size, mtimeMs: x.mtimeMs }
  if (typeof x.hash === 'string' && HASH_RE.test(x.hash)) out.hash = x.hash
  return out
}

/** The lines of a file, read in chunks, never the whole file at once. */
class LineReader {
  constructor (fsx, fd, pos = 0) {
    this.fsx = fsx
    this.fd = fd
    this.pos = pos
    this.start = pos
    this.buf = Buffer.allocUnsafe(READ_CHUNK)
    this.data = this.buf.subarray(0, 0)
    this.i = 0
    this.eof = false
    this.partial = -1 // offset of a last line with no newline
    this.tooLong = -1 // offset of a line longer than MAX_LINE
  }

  /** { buf, start, end } (buf valid until the next call), or null at the end. */
  next () {
    let parts = null
    let bytes = 0
    const start = this.start
    for (;;) {
      if (this.i >= this.data.length) {
        if (this.eof) break
        const n = this.fsx.readSync(this.fd, this.buf, 0, READ_CHUNK, this.pos)
        if (n === 0) {
          this.eof = true
          break
        }
        this.pos += n
        this.data = this.buf.subarray(0, n)
        this.i = 0
      }
      const nl = this.data.indexOf(10, this.i)
      if (nl === -1) {
        const piece = Buffer.from(this.data.subarray(this.i))
        if (parts === null) parts = []
        parts.push(piece)
        bytes += piece.length
        this.i = this.data.length
        if (bytes > MAX_LINE) {
          this.tooLong = start
          return null
        }
        continue
      }
      const piece = this.data.subarray(this.i, nl)
      this.i = nl + 1
      const line = parts === null ? piece : Buffer.concat([...parts, piece])
      if (line.length > MAX_LINE) {
        this.tooLong = start
        return null
      }
      this.start = start + line.length + 1
      return { buf: line, start, end: this.start }
    }
    if (parts !== null) this.partial = start
    return null
  }
}

function parseLine (buf) {
  try {
    const r = JSON.parse(buf.toString('utf8'))
    return isObj(r) ? r : null
  } catch {
    return null
  }
}

// The first bytes of the lines the summary reads without parsing every line.
const CHANGE_START = Buffer.from('{"v":')
const EPOCH_START = Buffer.from('{"e":')
const EXPORT_START = Buffer.from('{"xp":')
const END_START = Buffer.from('{"E":')
const COVERS_START = Buffer.from('{"C":')
const OP_START = Buffer.from(',"o":"')
const KNOWN_OPS = new Set(['pc', 'pu', 'pa', 'pr', 'pd', 'l', 'u', 'lb', 'r', 'cs', 'cc', 'x', 'xu', 'z'])
// The changes that move what the summary holds: the playlist ids, the cover ids, the horizon.
const SUMMARY_OPS = new Set(['pc', 'pd', 'cs', 'cc', 'z'])

const startsWith = (buf, head) => buf.length >= head.length && buf.compare(head, 0, head.length, 0, head.length) === 0

// The version and the op of a change line, read from its first bytes (every change line is
// written as {"v":V,"o":"<op>",...}); null when they are not there.
function changeHead (buf) {
  let i = CHANGE_START.length
  let v = 0
  while (i < buf.length && buf[i] >= 48 && buf[i] <= 57 && i < CHANGE_START.length + 17) v = v * 10 + (buf[i++] - 48)
  if (i === CHANGE_START.length || !Number.isSafeInteger(v) || v < 1) return null
  if (buf.length < i + OP_START.length || buf.compare(OP_START, 0, OP_START.length, i, i + OP_START.length) !== 0) return null
  i += OP_START.length
  const at = buf.indexOf(34, i)
  if (at === -1 || at - i > 4) return null
  return { v, op: buf.toString('latin1', i, at) }
}

const validEnd = (r) => r !== null && Number.isSafeInteger(r.E) && isObj(r.sum)

export function diskError (err) {
  return err && err.code === 'ENOSPC' ? apiError('disk_full') : new HttpError(500, INTERNAL)
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** A file written in slices, every write checked. */
class SliceWriter {
  constructor (fsx, fd) {
    this.fsx = fsx
    this.fd = fd
    this.offset = 0
    this.parts = []
    this.bytes = 0
  }

  push (s) {
    this.parts.push(s)
    this.bytes += Buffer.byteLength(s)
  }

  flush () {
    if (this.parts.length === 0) return
    const buf = Buffer.from(this.parts.join(''), 'utf8')
    this.parts = []
    this.bytes = 0
    const n = this.fsx.writeSync(this.fd, buf, 0, buf.length)
    if (n !== buf.length) throw Object.assign(new Error('short write'), { code: 'ENOSPC' })
    this.offset += buf.length
  }
}

// ------------------------------------------------------------------ the log

export class UserLog {
  /**
   * @param {object} opts
   * @param {string} opts.file
   * @param {string} opts.key
   * @param {object} [opts.fsx]  file system calls (NODE_FS)
   * @param {() => number} [opts.now]  the clock epochs start from
   * @param {object} [opts.hooks]  called at the steps of a compaction's end (checks)
   * @param {object} [opts.limits]  compactMin, compactOpenMin, sliceBytes, keepRoundBytes (checks)
   */
  constructor ({ file, key, fsx = NODE_FS, now = () => Date.now(), hooks = null, limits = {} }) {
    this.file = file
    this.key = key
    this.dir = path.dirname(file)
    this.fsx = fsx
    this.now = now
    this.hooks = hooks
    this.compactMin = limits.compactMin ?? COMPACT_MIN
    this.compactOpenMin = limits.compactOpenMin ?? COMPACT_OPEN_MIN
    this.sliceBytes = limits.sliceBytes ?? SLICE_BYTES
    this.keepRoundBytes = limits.keepRoundBytes ?? KEEP_ROUND_BYTES
    this.person = null
    this.exists = false
    this.fd = null
    this.size = 0 // bytes of whole lines
    this.snapBytes = 0
    this.tailBytes = 0
    this.version = 0
    this.epochs = [] // { id, first, last }, oldest first
    this.runEpoch = null // the epoch this process opened (kept while the person is not loaded)
    this.from = null // the stat of the .json this log knows
    this.broken = false
    this.closed = false
    this.compaction = null
    this._compacted = null
    this.kept = null
    this.keptBytes = 0
    this.compactions = 0
    this._sync = { busy: false, again: false, timer: null, last: 0, hold: false, idle: [] }
  }

  /** The epoch of the current version (the zero epoch while the person has no log). */
  get epoch () {
    return this.epochs.length > 0 ? this.epochs[this.epochs.length - 1].id : ZERO_EPOCH
  }

  get horizon () {
    return this.person !== null ? this.person.horizon : 0
  }

  /** Whether a client holding (epoch, u) holds a true state of this log, so a delta can follow. */
  known (epoch, u) {
    if (!isEpochId(epoch) || !Number.isSafeInteger(u)) return false
    const e = this.epochs.find((x) => x.id === epoch)
    if (e === undefined) return false
    return e.first <= u && u <= e.last && u >= this.horizon
  }

  _hook (name) {
    if (this.hooks !== null && typeof this.hooks[name] === 'function') this.hooks[name](this)
  }

  // ---------------------------------------------------------------- the header

  /** The header of the file: { key, snap, from }, null when unreadable, undefined when missing. */
  readHeader () {
    let fd
    try {
      fd = this.fsx.openSync(this.file, 'r')
    } catch (err) {
      if (err.code === 'ENOENT') return undefined
      throw err
    }
    try {
      const line = new LineReader(this.fsx, fd).next()
      const h = line === null ? null : parseLine(line.buf)
      if (h === null || h.mpfy !== 'user-log' || h.schema !== 2 || typeof h.key !== 'string' || typeof h.snap !== 'string') return null
      return { key: h.key, snap: Number(h.snap), from: validStat(h.from) }
    } finally {
      this.fsx.closeSync(fd)
    }
  }

  /** The file set aside under another name (`<file>.<tag>-<ms>`). */
  setAside (tag) {
    this._closeFd()
    const aside = this.file + '.' + tag + '-' + Date.now()
    try {
      this.fsx.renameSync(this.file, aside)
    } catch (err) {
      logError(path.basename(this.file) + ' not set aside: ' + err.message)
      return null
    }
    this.exists = false
    return aside
  }

  // ---------------------------------------------------------------- the summary

  /**
   * What a reader needs of the person without its content, read without loading it (a start):
   * the header, the snapshot's first line and its end (whose summary holds the epochs, the
   * horizon, the playlist ids and the cover ids), then the tail, where only the lines that
   * move those are parsed and every other change gives its version from its first bytes. The
   * tail is checked as a replay checks it and cut where it would be cut (the rest kept aside),
   * so a line appended later never follows a broken one. Sets the log's version, epochs, sizes
   * and the .json it knows. { status: 'ok', playlists: Set, covers: Set, horizon, n }, or
   * 'missing', 'wrong', 'damaged' (both set aside).
   */
  scan () {
    let fd
    try {
      fd = this.fsx.openSync(this.file, 'r')
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'missing' }
      throw err
    }
    let out
    try {
      out = this._scan(fd)
    } finally {
      try {
        this.fsx.closeSync(fd)
      } catch {}
    }
    if (out.status === 'wrong') {
      const aside = this.setAside('wrong')
      logError(path.basename(this.file) + ' names the key ' + JSON.stringify(out.key) + ', moved to ' + path.basename(aside || '?'))
      return out
    }
    if (out.status === 'damaged') {
      const aside = this.setAside('cut')
      logError(path.basename(this.file) + ': ' + out.reason + ', the whole file moved to ' + path.basename(aside || '?'))
      return out
    }
    if (out.cut >= 0) this._cut(out.cut, out.end, out.reason)
    else if (out.partial >= 0) {
      try {
        this._truncate(out.partial)
        logError(path.basename(this.file) + ': a last line cut short dropped')
      } catch (err) {
        logError(path.basename(this.file) + ': a last line cut short not dropped: ' + err.message)
      }
    }
    this.exists = true
    this.closed = false
    return out
  }

  _scan (fd) {
    const fsx = this.fsx
    const damaged = (reason) => ({ status: 'damaged', reason })
    const end = fsx.fstatSync(fd).size
    const reader = new LineReader(fsx, fd)
    const first = reader.next()
    const h = first === null ? null : parseLine(first.buf)
    if (h === null || h.mpfy !== 'user-log' || h.schema !== 2 || typeof h.snap !== 'string') return damaged('unreadable header')
    if (h.key !== this.key) return { status: 'wrong', key: h.key }
    let from = validStat(h.from)
    const sLine = reader.next()
    const s = sLine === null ? null : parseLine(sLine.buf)
    if (s === null || !isObj(s.S) || !Number.isSafeInteger(s.S.v)) return damaged('no snapshot')
    const vs = s.S.v
    const snapStart = sLine.start
    // The snapshot's end, where the header says it is; else found by the first bytes of its lines.
    let e = null
    let tailAt = 0
    const snapAt = Number(h.snap)
    if (snapAt > snapStart) {
      const line = new LineReader(fsx, fd, snapAt).next()
      const r = line === null ? null : parseLine(line.buf)
      if (validEnd(r)) {
        e = r
        tailAt = line.end
      }
    }
    while (e === null) {
      const line = reader.next()
      if (line === null) return damaged('a snapshot without its end')
      if (!startsWith(line.buf, END_START)) continue
      const r = parseLine(line.buf)
      if (!validEnd(r)) return damaged('a snapshot end that does not parse')
      e = r
      tailAt = line.end
    }
    const sum = e.sum
    const epochs = []
    for (const x of Array.isArray(sum.ep) ? sum.ep : []) {
      if (Array.isArray(x) && isEpochId(x[0]) && Number.isSafeInteger(x[1]) && Number.isSafeInteger(x[2])) epochs.push({ id: x[0], first: x[1], last: x[2] })
    }
    let horizon = num0(sum.h)
    const playlists = new Set((Array.isArray(sum.pl) ? sum.pl : []).filter(isPlaylistId))
    const covers = new Set((Array.isArray(sum.pc) ? sum.pc : []).filter(isCoverId))
    const n = Array.isArray(sum.n) ? [num0(sum.n[0]), num0(sum.n[1]), num0(sum.n[2])] : [0, 0, 0]
    // The tail, its versions checked as a replay checks them.
    const tail = new LineReader(fsx, fd, tailAt)
    let cut = -1
    let reason = ''
    let tailV = vs
    let expect = vs + 1
    let prev = null
    let wholeEnd = tailAt
    let current = null
    for (const x of epochs) if (x.first <= vs) current = x
    for (;;) {
      const line = tail.next()
      if (line === null) {
        if (tail.tooLong >= 0) {
          cut = tail.tooLong
          reason = 'a line longer than ' + MAX_LINE + ' bytes'
        }
        break
      }
      const b = line.buf
      if (startsWith(b, CHANGE_START)) {
        const head = changeHead(b)
        if (head === null || !KNOWN_OPS.has(head.op)) {
          cut = line.start
          reason = head === null ? 'a line that does not parse' : 'an unknown line'
          break
        }
        if (prev === null ? head.v !== expect : head.v !== prev && head.v !== prev + 1) {
          cut = line.start
          reason = 'a version out of sequence'
          break
        }
        if (SUMMARY_OPS.has(head.op)) {
          const r = parseLine(b)
          if (r === null || r.v !== head.v || r.o !== head.op || !validChange(r)) {
            cut = line.start
            reason = 'an unknown line'
            break
          }
          if (r.o === 'pc') playlists.add(r.p.id)
          else if (r.o === 'pd') playlists.delete(r.id)
          else if (r.o === 'cs') covers.add(r.cover)
          else if (r.o === 'z') horizon = Math.max(horizon, r.v)
          // A cleared cover stays listed: a superset never lets a file in use go.
        }
        prev = head.v
        tailV = head.v
        if (current !== null && current.last < head.v) current.last = head.v
      } else if (startsWith(b, EPOCH_START)) {
        const r = parseLine(b)
        if (r === null || !isEpochId(r.e) || !Number.isSafeInteger(r.v) || r.v <= tailV) {
          cut = line.start
          reason = 'an epoch out of sequence'
          break
        }
        current = epochs.find((x) => x.id === r.e)
        if (current === undefined) {
          current = { id: r.e, first: r.v, last: r.v }
          epochs.push(current)
        }
        tailV = r.v
        expect = r.v + 1
        prev = null
      } else if (startsWith(b, EXPORT_START)) {
        const r = parseLine(b)
        if (r === null) {
          cut = line.start
          reason = 'a line that does not parse'
          break
        }
        const st = validStat(r.xp)
        if (st !== null) from = st
      } else {
        cut = line.start
        reason = 'an unknown line'
        break
      }
      wholeEnd = line.end
    }
    this.from = from
    this.epochs = epochs
    this.version = Math.max(e.E, tailV)
    this.snapBytes = tailAt - snapStart
    this.size = cut >= 0 ? cut : wholeEnd
    this.tailBytes = this.size - tailAt
    return { status: 'ok', cut, end, reason, partial: cut < 0 ? tail.partial : -1, playlists, covers, horizon, n }
  }

  /**
   * The playlist covers the log holds now, read without loading the person (a cover found
   * missing at start): playlist id -> { small, large }. The snapshot's cover lines and the
   * tail's cover changes are applied as a replay applies them; nothing else is parsed.
   */
  coverEntries () {
    const fd = this.fsx.openSync(this.file, 'r')
    const out = new Map()
    const stamps = new Map()
    try {
      const reader = new LineReader(this.fsx, fd)
      reader.next()
      let inSnapshot = true
      for (;;) {
        const line = reader.next()
        if (line === null) break
        const b = line.buf
        if (inSnapshot) {
          if (startsWith(b, END_START)) inSnapshot = false
          else if (startsWith(b, COVERS_START)) {
            const r = parseLine(b)
            if (r === null || !isObj(r.C)) continue
            for (const [id, x] of Object.entries(r.C)) {
              if (!isPlaylistId(id) || !isObj(x)) continue
              out.set(id, { small: isCoverId(x.small) ? x.small : null, large: isCoverId(x.large) ? x.large : null })
              stamps.set(id, num0(r.s))
            }
          }
          continue
        }
        if (!startsWith(b, CHANGE_START)) continue
        const head = changeHead(b)
        if (head === null || (head.op !== 'cs' && head.op !== 'cc' && head.op !== 'pd')) continue
        const r = parseLine(b)
        if (r === null || !validChange(r)) continue
        const s = stamps.get(r.id)
        if (s !== undefined && r.v <= s) continue
        if (r.o === 'pd') out.delete(r.id)
        else if (r.o === 'cs') {
          const x = out.get(r.id) || { small: null, large: null }
          x[r.size] = r.cover
          out.set(r.id, x)
        } else {
          const x = out.get(r.id)
          if (x === undefined) continue
          for (const size of r.sizes || COVER_SIZES) x[size] = null
          if (x.small === null && x.large === null) out.delete(r.id)
        }
      }
    } finally {
      this.fsx.closeSync(fd)
    }
    return out
  }

  // ---------------------------------------------------------------- replay

  /** Read the file into a new Person, synchronously. 'ok', 'missing', 'wrong' or 'damaged'. */
  openSync (opts = {}) {
    const steps = this._replay()
    let r = steps.next()
    while (!r.done) r = steps.next()
    return this._opened(r.value, opts)
  }

  /** The same, yielding to the event loop every few milliseconds of work. */
  async open (opts = {}) {
    const steps = this._replay()
    let r = steps.next()
    while (!r.done) {
      await tick()
      r = steps.next()
    }
    return this._opened(r.value, { compactOnOpen: true, ...opts })
  }

  /**
   * The replay driven from outside: step() does a few milliseconds of it, finish() the rest at
   * once, stop() gives it up (its file closed). Once `done`, `status` is what openSync() gives
   * before its last step (_opened), which the caller makes.
   */
  opener () {
    const steps = this._replay()
    const st = {
      done: false,
      status: null,
      step () {
        if (st.done) return
        let r
        try {
          r = steps.next()
        } catch (err) {
          st.done = true
          st.status = 'failed'
          throw err
        }
        if (r.done) {
          st.done = true
          st.status = r.value
        }
      },
      finish () {
        while (!st.done) st.step()
      },
      stop () {
        if (st.done) return
        st.done = true
        st.status = 'stopped'
        steps.return()
      }
    }
    return st
  }

  _opened (status, { compactOnOpen = false } = {}) {
    if (status !== 'ok') return status
    this.exists = true
    this.closed = false
    this._closeFd()
    this.fd = this.fsx.openSync(this.file, 'a', 0o600)
    if (compactOnOpen && this.tailBytes > Math.max(this.compactOpenMin, this.snapBytes / 4)) this.compact()
    return 'ok'
  }

  * _replay () {
    const fsx = this.fsx
    let fd
    try {
      fd = fsx.openSync(this.file, 'r')
    } catch (err) {
      if (err.code === 'ENOENT') return 'missing'
      throw err
    }
    let out
    try {
      out = yield * this._read(fd)
    } finally {
      try {
        fsx.closeSync(fd)
      } catch {}
    }
    // The file is closed before it is set aside or cut (Windows renames no open file).
    if (out.status === 'wrong') {
      const aside = this.setAside('wrong')
      logError(path.basename(this.file) + ' names the key ' + JSON.stringify(out.key) + ', moved to ' + path.basename(aside || '?'))
      return 'wrong'
    }
    if (out.status === 'damaged') {
      this.person = null
      const aside = this.setAside('cut')
      logError(path.basename(this.file) + ': ' + out.reason + ', the whole file moved to ' + path.basename(aside || '?'))
      return 'damaged'
    }
    if (out.cut >= 0) this._cut(out.cut, out.end, out.reason)
    else if (out.partial >= 0) {
      // A last line cut short by a crash: dropped.
      this._truncate(out.partial)
      logError(path.basename(this.file) + ': a last line cut short dropped')
    }
    return 'ok'
  }

  * _read (fd) {
    const fsx = this.fsx
    const damaged = (reason) => ({ status: 'damaged', reason })
    const end = fsx.fstatSync(fd).size
    const reader = new LineReader(fsx, fd)
    const first = reader.next()
    const h = first === null ? null : parseLine(first.buf)
    if (h === null || h.mpfy !== 'user-log' || h.schema !== 2 || typeof h.snap !== 'string') return damaged('unreadable header')
    if (h.key !== this.key) return { status: 'wrong', key: h.key }
    this.from = validStat(h.from)
    // The tables sized from the counts of the summary, read where the header says it is.
    let sizes = {}
    const snapAt = Number(h.snap)
    if (snapAt > 0) {
      const e = new LineReader(fsx, fd, snapAt).next()
      const r = e === null ? null : parseLine(e.buf)
      if (r !== null && r.E !== undefined && isObj(r.sum) && Array.isArray(r.sum.n)) sizes = { likes: num0(r.sum.n[0]), ids: num0(r.sum.n[1]) }
    }
    const person = new Person(sizes)
    // The snapshot: from S to E.
    const sLine = reader.next()
    const s = sLine === null ? null : parseLine(sLine.buf)
    if (s === null || !isObj(s.S) || !Number.isSafeInteger(s.S.v)) return damaged('no snapshot')
    const vs = s.S.v
    const snapStart = sLine.start
    const stamps = new Map()
    let ve = 0
    let sum = null
    let wholeEnd = 0
    let t0 = performance.now()
    for (;;) {
      const line = reader.next()
      if (line === null) return damaged('a snapshot without its end')
      const r = parseLine(line.buf)
      if (r === null) return damaged('a snapshot line that does not parse')
      if (r.E !== undefined) {
        if (!Number.isSafeInteger(r.E) || !isObj(r.sum)) return damaged('a snapshot end that does not parse')
        ve = r.E
        sum = r.sum
        this.snapBytes = line.end - snapStart
        wholeEnd = line.end
        break
      }
      if (!person.loadLine(r, stamps)) return damaged('an unknown snapshot line')
      if (performance.now() - t0 > REPLAY_SLICE_MS) {
        yield
        t0 = performance.now()
      }
    }
    // The epochs kept and their ranges, the horizon.
    this.epochs = []
    for (const e of Array.isArray(sum.ep) ? sum.ep : []) {
      if (Array.isArray(e) && isEpochId(e[0]) && Number.isSafeInteger(e[1]) && Number.isSafeInteger(e[2])) this.epochs.push({ id: e[0], first: e[1], last: e[2] })
    }
    person.baseHorizon = num0(sum.h)
    person.edits.horizon = vs
    // The tail, line by line, its versions checked.
    const ctx = { stamps, tombsUpTo: ve }
    let cut = -1
    let reason = ''
    let tailV = vs
    let expect = vs + 1 // the version a change must have right after S or an epoch line
    let prev = null
    let current = null // the epoch the tail is in
    for (const e of this.epochs) if (e.first <= vs) current = e
    let run = []
    const endRun = () => {
      if (run.length > 0) person.applyRemovals(run, ctx)
      run = []
    }
    for (;;) {
      const line = reader.next()
      if (line === null) {
        if (reader.tooLong >= 0) {
          cut = reader.tooLong
          reason = 'a line longer than ' + MAX_LINE + ' bytes'
        }
        break
      }
      const r = parseLine(line.buf)
      if (r === null) {
        cut = line.start
        reason = 'a line that does not parse'
        break
      }
      if (r.e !== undefined) {
        if (!isEpochId(r.e) || !Number.isSafeInteger(r.v) || r.v <= tailV) {
          cut = line.start
          reason = 'an epoch out of sequence'
          break
        }
        endRun()
        // An epoch the snapshot already lists (opened while it was written) is not added twice.
        current = this.epochs.find((x) => x.id === r.e)
        if (current === undefined) {
          current = { id: r.e, first: r.v, last: r.v }
          this.epochs.push(current)
        }
        tailV = r.v
        expect = r.v + 1
        prev = null
      } else if (r.xp !== undefined) {
        endRun()
        const st = validStat(r.xp)
        if (st !== null) this.from = st
      } else if (typeof r.o === 'string' && validChange(r)) {
        if (prev === null ? r.v !== expect : r.v !== prev && r.v !== prev + 1) {
          cut = line.start
          reason = 'a version out of sequence'
          break
        }
        if (r.o === 'xu') run.push(r)
        else {
          endRun()
          person.apply(r, ctx)
        }
        prev = r.v
        tailV = r.v
        if (current !== null && current.last < r.v) current.last = r.v
      } else {
        cut = line.start
        reason = 'an unknown line'
        break
      }
      wholeEnd = line.end
      if (performance.now() - t0 > REPLAY_SLICE_MS) {
        yield
        t0 = performance.now()
      }
    }
    endRun()
    this.person = person
    this.version = Math.max(ve, tailV)
    this.size = cut >= 0 ? cut : wholeEnd
    this.tailBytes = this.size - (snapStart + this.snapBytes)
    return { status: 'ok', cut, end, reason, partial: cut < 0 ? reader.partial : -1 }
  }

  _truncate (at) {
    const fd = this.fsx.openSync(this.file, 'r+')
    try {
      this.fsx.ftruncateSync(fd, at)
    } finally {
      this.fsx.closeSync(fd)
    }
  }

  // What follows the trusted part is kept aside, then the file is cut there.
  _cut (at, end, reason) {
    const aside = this.file + '.cut-' + Date.now()
    try {
      const src = this.fsx.openSync(this.file, 'r')
      const dst = this.fsx.openSync(aside, 'w', 0o600)
      try {
        const buf = Buffer.allocUnsafe(READ_CHUNK)
        for (let pos = at; pos < end;) {
          const n = this.fsx.readSync(src, buf, 0, Math.min(READ_CHUNK, end - pos), pos)
          if (n === 0) break
          this.fsx.writeSync(dst, buf, 0, n)
          pos += n
        }
        this.fsx.fsyncSync(dst)
      } finally {
        this.fsx.closeSync(src)
        this.fsx.closeSync(dst)
      }
      this._truncate(at)
      logError(path.basename(this.file) + ': ' + reason + ' at byte ' + at + ', the rest kept in ' + path.basename(aside))
    } catch (err) {
      logError(path.basename(this.file) + ': ' + reason + ' at byte ' + at + ', not cut: ' + err.message)
    }
  }

  // ---------------------------------------------------------------- whole writes

  /**
   * The log written whole from `person` by a synced rename (a new person, a migration, a
   * merge): every line stamped `v`, which is also the snapshot's start and end; `epochs` the
   * epochs it keeps. Synchronous. The live file, if any, is closed and replaced.
   */
  writeWholeSync (person, { v, epochs, from = this.from, tmp = this.file + '.tmp' }) {
    this.abortCompaction()
    const fsx = this.fsx
    const fd = fsx.openSync(tmp, 'w', 0o600)
    let header
    let eAt
    try {
      header = headerLine(this.key, from)
      const w = new SliceWriter(fsx, fd)
      w.push(header)
      w.push('{"S":{"v":' + v + '}}\n')
      for (const line of person.bodyLines(() => v)) {
        w.push(line)
        if (w.bytes >= this.sliceBytes) w.flush()
      }
      w.push(person.tombs.line())
      if (Object.keys(person.extra).length > 0 || Object.keys(person.coversExtra).length > 0) {
        w.push('{"X":' + JSON.stringify(person.extra) + ',"CX":' + JSON.stringify(person.coversExtra) + '}\n')
      }
      w.flush()
      eAt = w.offset
      w.push(this._endLine(person, v, epochs, person.horizon))
      w.flush()
      this._patchSnap(fd, header, eAt)
      fsx.fsyncSync(fd)
      this.snapBytes = w.offset - Buffer.byteLength(header)
      this.size = w.offset
    } catch (err) {
      try {
        fsx.closeSync(fd)
      } catch {}
      unlinkQuiet(tmp)
      throw err
    }
    fsx.closeSync(fd)
    this._closeFd()
    fsx.renameSync(tmp, this.file)
    fsx.fsyncDir(this.dir)
    this.exists = true
    this.closed = false
    this.tailBytes = 0
    this.from = from
    this.version = v
    this.person = person
    this.fd = fsx.openSync(this.file, 'a', 0o600)
  }

  _patchSnap (fd, header, eAt) {
    const digits = Buffer.from(String(eAt).padStart(12, '0'), 'ascii')
    const n = this.fsx.writeSync(fd, digits, 0, 12, snapDigitsAt(header))
    if (n !== 12) throw Object.assign(new Error('short write'), { code: 'ENOSPC' })
  }

  // The E line: the epochs that still matter (at most MAX_EPOCHS, the horizon raised past
  // any dropped), the horizon, the ids a reader of the summary needs, the counts.
  _endLine (person, ve, epochs, horizon) {
    let h = horizon
    let kept = epochs.filter((e) => e.last >= h)
    while (kept.length > MAX_EPOCHS) {
      h = Math.max(h, kept[0].last)
      kept = kept.slice(1)
    }
    kept = kept.filter((e) => e.last >= h)
    if (h > person.baseHorizon) person.baseHorizon = h
    if (epochs === this.epochs) this.epochs = kept
    const sum = {
      ep: kept.map((e) => [e.id, e.first, e.last]),
      h,
      pl: [...person.playlists.keys()],
      pc: person.coverIds(),
      n: [person.likes.live, person.table.n, person.entries]
    }
    return '{"E":' + ve + ',"sum":' + JSON.stringify(sum) + '}\n'
  }

  // ---------------------------------------------------------------- changes

  /**
   * One batch: its lines share one version and go out in one checked write; only then is each
   * applied (`apply(line)`). The first change of this run opens its epoch in the same write.
   * Throws an HttpError (507, 500) when the write fails: then nothing was applied.
   */
  commit (ops, apply) {
    if (this.broken || this.closed || this.fd === null) throw new HttpError(500, INTERNAL)
    let text = ''
    let opened = null
    let v
    if (this.runEpoch === null) {
      const e = Math.max(this.version + 1, this.now())
      opened = { id: newEpochId(), first: e, last: e + 1 }
      text = '{"e":"' + opened.id + '","v":' + e + '}\n'
      v = e + 1
    } else v = this.version + 1
    const lines = ops.map((op) => ({ v, ...op }))
    for (const r of lines) text += JSON.stringify(r) + '\n'
    const buf = Buffer.from(text, 'utf8')
    this._write(buf)
    for (let k = 0; k < lines.length; k++) apply(lines[k], k)
    this.version = v
    if (opened !== null) {
      this.runEpoch = opened.id
      this.epochs.push(opened)
    } else this.epochs[this.epochs.length - 1].last = v
    this.size += buf.length
    this.tailBytes += buf.length
    if (this.kept !== null) {
      this.kept.push(text)
      this.keptBytes += buf.length
    }
    this._scheduleSync()
    this._maybeCompact()
    return v
  }

  _write (buf) {
    let n
    try {
      n = this.fsx.writeSync(this.fd, buf, 0, buf.length)
    } catch (err) {
      this._cutBack()
      logError(path.basename(this.file) + ': a change not written: ' + err.message)
      throw diskError(err)
    }
    if (n !== buf.length) {
      this._cutBack()
      logError(path.basename(this.file) + ': a change written short (' + n + ' of ' + buf.length + ' bytes), cut back')
      throw apiError('disk_full')
    }
  }

  // After a failed write, the file back to its whole lines (an append handle may not cut a
  // file on every system: then a handle of its own). If even that fails the log is broken
  // until the source restarts: no line may follow half a line.
  _cutBack () {
    try {
      this.fsx.ftruncateSync(this.fd, this.size)
      return
    } catch {}
    try {
      this._truncate(this.size)
    } catch (err) {
      this.broken = true
      logError(path.basename(this.file) + ' could not be cut back after a failed write, no change is taken until a restart: ' + err.message)
    }
  }

  // ---------------------------------------------------------------- syncs

  _scheduleSync () {
    const s = this._sync
    if (s.hold || s.busy) {
      s.again = true
      return
    }
    if (s.timer !== null) return
    const wait = s.last + SYNC_EVERY_MS - performance.now()
    if (wait > 0) {
      s.timer = setTimeout(() => {
        s.timer = null
        this._syncNow()
      }, wait)
      s.timer.unref()
    } else this._syncNow()
  }

  _syncNow () {
    const s = this._sync
    if (this.fd === null || s.hold) {
      if (s.hold) s.again = true
      return
    }
    s.busy = true
    s.again = false
    this.fsx.fdatasync(this.fd, (err) => {
      s.busy = false
      s.last = performance.now()
      if (err && err.code !== 'EBADF') logError(path.basename(this.file) + ' not synced: ' + err.message)
      const idle = s.idle
      s.idle = []
      for (const resolve of idle) resolve()
      if (s.again && !s.hold && !this.closed) this._scheduleSync()
      // A person not loaded keeps no file open once its lines are synced.
      else if (this.person === null && s.timer === null) this._closeFd()
    })
  }

  _syncIdle () {
    const s = this._sync
    return s.busy ? new Promise((resolve) => s.idle.push(resolve)) : Promise.resolve()
  }

  /** Synced now (tests, the end of a run). */
  syncNow () {
    if (this.fd === null) return
    try {
      this.fsx.fdatasyncSync(this.fd)
    } catch (err) {
      logError(path.basename(this.file) + ' not synced: ' + err.message)
    }
  }

  // ---------------------------------------------------------------- compaction

  _maybeCompact () {
    if (this.compaction === null && this.tailBytes > Math.max(this.compactMin, this.snapBytes)) this.compact()
  }

  /** The snapshot written again in the background; resolves when done (or given up). */
  compact () {
    if (this.compaction !== null) return this._compacted
    if (this.person === null || this.broken || this.closed) return Promise.resolve()
    const c = { tmp: this.file + '.tmp', fd: null, aborted: false, done: false, ve: null }
    this.compaction = c
    this._compacted = this._compact(c)
      .catch((err) => {
        if (!c.aborted) logError(path.basename(this.file) + ' not compacted: ' + err.message)
      })
      .finally(() => {
        // Given up on the way (a failure, the log broken meanwhile): its file goes. One given
        // up by abortCompaction() is gone already, and the name may be another one's by now.
        if (!c.done && !c.aborted) this._giveUp(c)
        if (this.compaction === c) {
          this.compaction = null
          this.kept = null
          this.keptBytes = 0
        }
        if (this._sync.hold && this.compaction === null) {
          this._sync.hold = false
          if (this._sync.again) this._scheduleSync()
        }
      })
    return this._compacted
  }

  /** Resolves when no compaction runs. */
  settled () {
    return this.compaction === null ? Promise.resolve() : this._compacted
  }

  _giveUp (c) {
    c.aborted = true
    if (c.fd !== null) {
      try {
        this.fsx.closeSync(c.fd)
      } catch {}
      c.fd = null
    }
    unlinkQuiet(c.tmp)
  }

  /** A compaction under way given up (the old file stays whole). */
  abortCompaction () {
    const c = this.compaction
    if (c === null) return
    this._giveUp(c)
    this.compaction = null
    this.kept = null
    this.keptBytes = 0
    this._sync.hold = false
  }

  async _compact (c) {
    const fsx = this.fsx
    const person = this.person
    const live = () => !c.aborted && this.compaction === c && !this.closed && !this.broken && this.person === person
    try {
      fsx.unlinkSync(c.tmp)
    } catch {}
    c.fd = fsx.openSync(c.tmp, 'w', 0o600)
    const header = headerLine(this.key, this.from)
    const w = new SliceWriter(fsx, c.fd)
    w.push(header)
    // From here every line appended to the live file is also kept for the new one.
    const vs = this.version
    this.kept = []
    this.keptBytes = 0
    w.push('{"S":{"v":' + vs + '}}\n')
    const headerBytes = Buffer.byteLength(header)
    for (const line of person.bodyLines(() => this.version)) {
      w.push(line)
      if (w.bytes >= this.sliceBytes) {
        w.flush()
        await tick()
        if (!live()) return
      }
    }
    // The removals, the unknown fields and the end, made at one moment.
    const ve = this.version
    c.ve = ve
    w.push(person.tombs.line())
    if (Object.keys(person.extra).length > 0 || Object.keys(person.coversExtra).length > 0) {
      w.push('{"X":' + JSON.stringify(person.extra) + ',"CX":' + JSON.stringify(person.coversExtra) + '}\n')
    }
    w.flush()
    const eAt = w.offset
    w.push(this._endLine(person, ve, this.epochs, person.horizon))
    w.flush()
    const snapBytes = w.offset - headerBytes
    this._patchSnap(c.fd, header, eAt)
    await fsyncAsync(fsx, c.fd)
    if (!live()) return
    this._hook('snapshotSynced')
    // The lines appended meanwhile, synced into the new file before it takes the log's place:
    // at least one round, until little is left. No sync of the live file starts meanwhile.
    this._sync.hold = true
    let tail = 0
    do {
      const text = this.kept.join('')
      this.kept = []
      this.keptBytes = 0
      if (text.length > 0) {
        w.push(text)
        tail += Buffer.byteLength(text)
        w.flush()
      }
      await fsyncAsync(fsx, c.fd)
      await this._syncIdle()
      if (!live()) return
      this._hook('roundSynced')
    } while (this.keptBytes >= this.keepRoundBytes)
    // The end, with nothing awaited: no change comes in between.
    const rest = this.kept.join('')
    if (rest.length > 0) {
      w.push(rest)
      tail += Buffer.byteLength(rest)
      w.flush()
    }
    fsx.closeSync(c.fd)
    c.fd = null
    this._hook('beforeRename')
    this._closeFd()
    try {
      fsx.renameSync(c.tmp, this.file)
    } catch (err) {
      this.fd = fsx.openSync(this.file, 'a', 0o600)
      throw err
    }
    this._hook('afterRename')
    fsx.fsyncDir(this.dir)
    this._hook('afterDirSync')
    this.fd = fsx.openSync(this.file, 'a', 0o600)
    this.snapBytes = snapBytes
    this.tailBytes = tail
    this.size = w.offset
    this.kept = null
    this.keptBytes = 0
    this.compactions++
    c.done = true
    this._sync.hold = false
    this._scheduleSync()
    this._hook('done')
  }

  // ---------------------------------------------------------------- a person not loaded

  /** The person leaves memory, its file synced and closed; what the log knows of its versions stays. */
  unload () {
    this.abortCompaction()
    const s = this._sync
    if (s.timer !== null) clearTimeout(s.timer)
    s.timer = null
    if (!s.busy) this.syncNow()
    this._closeFd()
    this.person = null
  }

  /**
   * Removed tracks for a person not loaded: one `xu` line appended with the next version (the
   * epoch of this run opened in the same write when it is the first change of the run).
   */
  appendRemoval (ids, at) {
    return this.appendLines([{ o: 'xu', ids, at }])
  }

  /**
   * Changes for a person not loaded (removed tracks, covers found missing at start), one batch:
   * one version, one checked write, the epoch of this run opened in the same write when they
   * are its first change. The file is opened for it and closed once synced (in the
   * background, as every change: at most one sync per 500 ms).
   * Throws an HttpError (507, 500) when the write fails: then nothing was written.
   */
  appendLines (ops) {
    if (this.person !== null) throw new Error('the person is loaded')
    if (this.broken || !this.exists) throw new HttpError(500, INTERNAL)
    let text = ''
    let opened = null
    let v
    if (this.runEpoch === null) {
      const e = Math.max(this.version + 1, this.now())
      opened = { id: newEpochId(), first: e, last: e + 1 }
      text = '{"e":"' + opened.id + '","v":' + e + '}\n'
      v = e + 1
    } else v = this.version + 1
    for (const op of ops) text += JSON.stringify({ v, ...op }) + '\n'
    const buf = Buffer.from(text, 'utf8')
    if (this.fd === null) this.fd = this.fsx.openSync(this.file, 'a', 0o600)
    this._write(buf)
    this.version = v
    if (opened !== null) {
      this.runEpoch = opened.id
      this.epochs.push(opened)
    } else this.epochs[this.epochs.length - 1].last = v
    this.size += buf.length
    this.tailBytes += buf.length
    this._scheduleSync()
    return v
  }

  /**
   * export-compat wrote the person's .json with this stat, or a start found it with the bytes
   * the log knows: the log knows it from now on. A person not loaded has its file opened for
   * it and closed once synced.
   */
  noteExport (st) {
    if (this.broken || this.closed) throw new HttpError(500, INTERNAL)
    if (this.fd === null) {
      if (this.person !== null || !this.exists) throw new HttpError(500, INTERNAL)
      this.fd = this.fsx.openSync(this.file, 'a', 0o600)
    }
    const from = validStat(st)
    const text = JSON.stringify({ xp: from }) + '\n'
    const buf = Buffer.from(text, 'utf8')
    this._write(buf)
    this.from = from
    this.size += buf.length
    this.tailBytes += buf.length
    if (this.kept !== null) {
      this.kept.push(text)
      this.keptBytes += buf.length
    }
    this._scheduleSync()
  }

  // ---------------------------------------------------------------- the end

  _closeFd () {
    if (this.fd === null) return
    try {
      this.fsx.closeSync(this.fd)
    } catch {}
    this.fd = null
  }

  /** Synced and closed (server stop); a compaction under way is given up. */
  close () {
    if (this.closed) return
    this.closed = true
    this.abortCompaction()
    const s = this._sync
    if (s.timer !== null) clearTimeout(s.timer)
    s.timer = null
    this.syncNow()
    this._closeFd()
  }

  /** The person's log deleted (a merge, a profile removed). */
  remove () {
    this.close()
    unlinkQuiet(this.file)
    this.exists = false
  }
}

function fsyncAsync (fsx, fd) {
  return new Promise((resolve, reject) => fsx.fsync(fd, (err) => (err ? reject(err) : resolve())))
}
