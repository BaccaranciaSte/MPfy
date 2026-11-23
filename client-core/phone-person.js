// The person's data while it lives on the phone (the phone store): the playlists,
// likes, plays and playlist covers of the device's profile, kept and answered by the
// core at Locale's address exactly as a source keeps and answers a person's data,
// until a real source is the principal and the page moves the data there.
//
// Files, under `dir` (<statePath>.phone):
// - person.log: the person's log in the source's format, byte for byte (a source's
//   users/<key>.log, server/userlog.mjs): the header
//     {"mpfy":"user-log","schema":2,"key":"<key>","snap":"<12 digits>"}
//   a snapshot from {"S":{"v":Vs}} to {"E":Ve,"sum":{...}} (one line per playlist,
//   likes oldest first in chunks of 1,000, the plays, playlist covers in chunks of
//   1,000, the newest 10,000 removals; each line stamped with the version it was made
//   at), then the epoch lines {"e":"<16 hex>","v":E} and the changes as they were
//   resolved, {"v":V,"o":"pc"|"pu"|"pa"|"pr"|"pd"|"l"|"u"|"lb"|"r"|"cs"|"cc",...}, so
//   a replay runs no rule again. `key` is the profile's id ("owner" without one); a log
//   naming another key is set aside (person.log.wrong-<ms>) and the store starts empty.
// - person-covers/<coverId>.jpg: the playlist covers, the id made from the picture's
//   bytes as a source makes it (metadata left out); a file nothing names any more goes.
// - person.log.moved-<ms>: the log as it was when its data moved to a real source
//   (moved()), the newest only.
//
// Left out, as only a source needs them for its many people: the id tables, the
// summaries of people not loaded, dropping a person from memory, the sweeps of tracks
// deleted (a file of the phone that goes away never removes anything from the person's
// data: it may come back, and the page draws only what resolves), migrations, merges.
//
// A start reads the header and the end of the log only (the version and its epoch:
// summary()); the whole log is read in slices at the first request that needs the
// person, then kept. A change is validated, written in one checked write, then applied;
// one fdatasync at most every 500 ms, never awaited. The snapshot is written again in
// the background when the changes after it outweigh it, while changes keep coming.
//
// Portable: '#fs', '#path', b4a, ./http.js, ./identity.js, ./phone-track.js, ./userops.js.

import fs from '#fs'
import path from '#path'
import b4a from 'b4a'
import { HttpError } from './http.js'
import { randomBytes } from './identity.js'
import { sha256Hex } from './phone-track.js'
import { rebaseOrder, removalSlots } from './userops.js'

export const ZERO_EPOCH = '0000000000000000'
export const PERSON_LOG = 'person.log'
export const PERSON_COVERS = 'person-covers'
// The source's limits on a person's data, the same values (checked against it).
export const MAX_RECENTS = 50
export const MAX_HISTORY = 1000
export const RECENTS_PAGE = 100
export const MAX_RECENTS_PAGE = 200
export const MAX_PLAYLIST_LENGTH = 20000
export const MAX_LIKES = 100000
export const MAX_PLAYLISTS = 10000
export const MAX_PLAYLIST_ENTRIES = 100000
export const MAX_BULK_LIKES = 5000
// A play's own time is kept when it is this recent, and not further ahead than this.
export const PLAYED_AT_MAX_AGE = 30 * 24 * 60 * 60 * 1000
export const PLAYED_AT_MAX_SKEW = 5 * 60 * 1000
export const MAX_COVER_BYTES = 16 * 1024 * 1024
const MAX_JSON_BODY = 4 * 1024 * 1024
const MAX_COVER_BODY = 8 * 1024 * 1024
const MAX_TOMBS = 10000
const MAX_EPOCHS = 64
const MAX_LINE = 64 * 1024 * 1024
const READ_CHUNK = 1024 * 1024
const PEEK_CHUNK = 16 * 1024
const SLICE_BYTES = 256 * 1024
const KEEP_ROUND_BYTES = 64 * 1024
const SYNC_EVERY_MS = 500
const COMPACT_MIN = 1024 * 1024
const COMPACT_OPEN_MIN = 256 * 1024
const LIKES_CHUNK = 1000
const COVERS_CHUNK = 1000
const LIKES_SLICE = 5000
const REPLAY_SLICE_MS = 5
const REPACK_MIN = 4096
const RENAME_TRIES = 8
const COVER_SIZES = ['small', 'large']
const CONTEXT_TYPES = new Set(['playlist', 'album', 'artist', 'liked', 'library', 'search'])
const TOMB_KINDS = new Set(['p', 'l', 'c'])
const KNOWN_OPS = new Set(['pc', 'pu', 'pa', 'pr', 'pd', 'l', 'u', 'lb', 'r', 'cs', 'cc'])
const TRACK_RE = /^[0-9a-f]{24}$/
const PLAYLIST_RE = /^[0-9a-f]{16}$/
const PROFILE_RE = /^[0-9a-f]{32}$/
const NUM_RE = /^\d{1,16}$/
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const INTERNAL = 'Errore interno del server'
const NOT_FOUND = 'Risorsa non trovata'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
const GONE = Symbol('the client left')

const noop = () => {}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const isTime = (x) => typeof x === 'number' && Number.isFinite(x)
const isTrackId = (s) => typeof s === 'string' && TRACK_RE.test(s)
const isPlaylistId = (s) => typeof s === 'string' && PLAYLIST_RE.test(s)
const isCoverId = isTrackId
const isIdList = (a) => Array.isArray(a) && a.every(isTrackId)
const isPosList = (a) => Array.isArray(a) && a.every((i) => Number.isSafeInteger(i) && i >= 0)
const isEpochId = (s) => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s) && s !== ZERO_EPOCH
const num0 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const num = (x) => JSON.stringify(x)

export function newEpochId () {
  for (;;) {
    const id = b4a.toString(randomBytes(8), 'hex')
    if (id !== ZERO_EPOCH) return id
  }
}

/** A string field of a request: a string, control characters as spaces, trimmed, at most `max`. */
export function text (value, max) {
  if (typeof value !== 'string') throw new HttpError(400, 'Valore non valido')
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

function badRequest () {
  return new HttpError(400, 'Richiesta non valida', 'bad_request')
}

function diskError (err) {
  return err && err.code === 'ENOSPC' ? new HttpError(507, 'Spazio su disco esaurito sulla fonte', 'disk_full') : new HttpError(500, INTERNAL)
}

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

function put (o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
  else o[k] = v
}

// A playlist as kept: its fields as served, in their order, `trackIds` (24 hex) where
// the source object had it (at the end when it had none).
function makeRecord (src, trackIds) {
  const p = {}
  let placed = false
  for (const k of Object.keys(src)) {
    if (k === 'trackIds') {
      p.trackIds = trackIds
      placed = true
    } else put(p, k, src[k])
  }
  if (!placed) p.trackIds = trackIds
  return p
}

// ------------------------------------------------------------------ covers

function ascii (d, at, n) {
  return b4a.toString(d.subarray(at, at + n), 'latin1')
}

function sniffImage (d) {
  if (d.byteLength >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpg'
  if (d.byteLength >= 8 && d[0] === 0x89 && ascii(d, 1, 3) === 'PNG') return 'png'
  if (d.byteLength >= 12 && ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WEBP') return 'webp'
  return null
}

const u16be = (d, i) => (d[i] << 8) | d[i + 1]
const u32be = (d, i) => d[i] * 0x1000000 + ((d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3])
const u32le = (d, i) => d[i + 3] * 0x1000000 + ((d[i + 2] << 16) | (d[i + 1] << 8) | d[i])
const JPEG_DROP = new Set([0xe1, 0xec, 0xed, 0xfe])
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf'])

// The parts of a picture that make it (a source's rule): JPEG APP1, APP12, APP13 and COM
// go; PNG text, time and EXIF chunks go; WebP EXIF and XMP chunks and the RIFF size go.
// What does not walk cleanly is taken whole.
function jpegParts (d) {
  const parts = [d.subarray(0, 2)]
  let i = 2
  while (i + 4 <= d.byteLength) {
    if (d[i] !== 0xff) return [d]
    const marker = d[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xda) {
      parts.push(d.subarray(i))
      return parts
    }
    const len = u16be(d, i + 2)
    if (len < 2 || i + 2 + len > d.byteLength) return [d]
    if (!JPEG_DROP.has(marker)) parts.push(d.subarray(i, i + 2 + len))
    i += 2 + len
  }
  return [d]
}

function pngParts (d) {
  const parts = [d.subarray(0, 8)]
  let i = 8
  while (i + 12 <= d.byteLength) {
    const len = u32be(d, i)
    const type = ascii(d, i + 4, 4)
    const end = i + 12 + len
    if (end > d.byteLength) return [d]
    if (!PNG_DROP.has(type)) parts.push(d.subarray(i, end))
    if (type === 'IEND') return parts
    i = end
  }
  return [d]
}

function webpParts (d) {
  const parts = [d.subarray(0, 4), d.subarray(8, 12)]
  let i = 12
  while (i + 8 <= d.byteLength) {
    const type = ascii(d, i, 4)
    const len = u32le(d, i + 4)
    const end = i + 8 + len + (len & 1)
    if (i + 8 + len > d.byteLength) return [d]
    if (type !== 'EXIF' && type !== 'XMP ') parts.push(d.subarray(i, i + 8 + len))
    i = end
  }
  return parts
}

/** The id a source gives these picture bytes, or null when they are no JPEG, PNG or WebP. */
export function coverIdOf (data) {
  const ext = sniffImage(data)
  if (ext === null) return null
  const parts = ext === 'jpg' ? jpegParts(data) : ext === 'png' ? pngParts(data) : webpParts(data)
  return sha256Hex(parts.length === 1 ? parts[0] : b4a.concat(parts)).slice(0, 24)
}

// ------------------------------------------------------------------ the person

/** The likes by slot, oldest first; a removed one leaves a hole (at NaN) until a repack. */
class Likes {
  constructor () {
    this.ids = []
    this.at = []
    this.lv = [] // the version of each like, never decreasing along the slots
    this.slot = new Map() // id -> slot
    this.n = 0 // slots used, holes included
    this.live = 0
    this.walkers = 0 // walks over the slots under way: no repack meanwhile
  }

  has (id) {
    return this.slot.has(id)
  }

  lvOf (id) {
    const s = this.slot.get(id)
    return s === undefined ? null : this.lv[s]
  }

  /** Liked as the newest; false when it was liked already. */
  add (id, at, v) {
    if (this.slot.has(id)) return false
    const s = this.n++
    this.ids[s] = id
    this.at[s] = at
    this.lv[s] = v
    this.slot.set(id, s)
    this.live++
    return true
  }

  remove (id) {
    const s = this.slot.get(id)
    if (s === undefined) return false
    this.slot.delete(id)
    this.at[s] = NaN
    this.live--
    if (this.walkers === 0 && this.n - this.live > Math.max(REPACK_MIN, this.live)) this._repack()
    return true
  }

  _repack () {
    let k = 0
    for (let s = 0; s < this.n; s++) {
      if (Number.isNaN(this.at[s])) continue
      if (k !== s) {
        this.ids[k] = this.ids[s]
        this.at[k] = this.at[s]
        this.lv[k] = this.lv[s]
      }
      this.slot.set(this.ids[k], k)
      k++
    }
    this.n = k
    this.ids.length = k
    this.at.length = k
    this.lv.length = k
  }

  /** The first slot whose version is above u. */
  firstAfter (u) {
    let lo = 0
    let hi = this.n
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.lv[mid] > u) hi = mid
      else lo = mid + 1
    }
    return lo
  }
}

/** The newest removals (deleted playlists `p`, unliked ids `l`, cleared covers `c`) with their versions. */
class Tombs {
  constructor (size = MAX_TOMBS) {
    this.size = size
    this.list = [] // [kind, id, v], oldest first from `start`
    this.start = 0
    // The newest version dropped: no delta reaches below it.
    this.horizon = 0
  }

  push (kind, id, v) {
    this.list.push([kind, id, v])
    if (this.list.length - this.start > this.size) {
      this.horizon = Math.max(this.horizon, this.list[this.start][2])
      this.start++
      if (this.start >= this.size) {
        this.list = this.list.slice(this.start)
        this.start = 0
      }
    }
  }

  /** The removals after version u, oldest first. */
  * since (u = -Infinity) {
    let lo = this.start
    let hi = this.list.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.list[mid][2] > u) hi = mid
      else lo = mid + 1
    }
    for (let j = lo; j < this.list.length; j++) yield this.list[j]
  }

  line () {
    return '{"T":' + JSON.stringify([...this.since()]) + '}\n'
  }
}

/** One person's data in memory, as a source keeps it, with every version a delta needs. */
class Person {
  constructor () {
    this.playlists = new Map() // id -> playlist (fields as served)
    this.pv = new Map() // id -> version of its last change
    this.entries = 0
    // Every track id met since the person was read, as a source's id table counts them
    // (the snapshot's end says how many: the size the source's tables start with).
    this.interned = new Set()
    this.likes = new Likes()
    this.recents = [] // newest first, at most MAX_HISTORY
    this.rv = 0
    this.covers = new Map() // playlist id -> { small, large }
    this.coverV = new Map()
    this.extra = {}
    this.coversExtra = {}
    this.tombs = new Tombs()
    this.baseHorizon = 0
  }

  get horizon () {
    return Math.max(this.tombs.horizon, this.baseHorizon)
  }

  _intern (ids) {
    for (const id of ids) this.interned.add(id)
  }

  likesList () {
    const out = []
    const l = this.likes
    for (let s = l.n - 1; s >= 0; s--) if (!Number.isNaN(l.at[s])) out.push({ id: l.ids[s], at: l.at[s] })
    return out
  }

  coversObject () {
    const o = {}
    for (const [id, e] of this.covers) o[id] = { small: e.small, large: e.large }
    return o
  }

  coverIds () {
    const ids = []
    for (const e of this.covers.values()) {
      if (e.small) ids.push(e.small)
      if (e.large) ids.push(e.large)
    }
    return ids
  }

  names (coverId) {
    for (const e of this.covers.values()) if (e.small === coverId || e.large === coverId) return true
    return false
  }

  _skip (ctx, key, v) {
    if (ctx === null) return false
    const s = ctx.stamps.get(key)
    return s !== undefined && v <= s
  }

  _tomb (ctx, kind, id, v) {
    if (ctx === null || v > ctx.tombsUpTo) this.tombs.push(kind, id, v)
  }

  // An unlike at version v. At replay the like held may be one made after it (written by a
  // snapshot that was walking while it came): its own version is its stamp.
  _unlike (id, ctx, v) {
    if (ctx !== null && this.likes.has(id) && this.likes.lvOf(id) >= v) return
    if (this.likes.remove(id)) this._tomb(ctx, 'l', id, v)
  }

  /**
   * One change line applied. `ctx` (a replay): the stamps of the snapshot's objects and
   * the version its removals were kept at; null for a change made now. Never throws on a
   * valid line.
   */
  apply (r, ctx = null) {
    const v = r.v
    switch (r.o) {
      case 'pc': {
        const id = r.p.id
        if (this._skip(ctx, 'p:' + id, v)) return
        const old = this.playlists.get(id)
        if (old !== undefined) {
          this.entries -= old.trackIds.length
          this.playlists.delete(id)
        }
        this.playlists.set(id, makeRecord(r.p, []))
        this.pv.set(id, v)
        return
      }
      case 'pu': {
        const p = this.playlists.get(r.id)
        if (p === undefined || this._skip(ctx, 'p:' + r.id, v)) return
        if (r.name !== undefined) p.name = r.name
        if (r.description !== undefined) p.description = r.description
        if (r.trackIds !== undefined) {
          this._intern(r.trackIds)
          this.entries += r.trackIds.length - p.trackIds.length
          p.trackIds = r.trackIds.slice()
        }
        p.updatedAt = r.at
        this.pv.set(r.id, v)
        return
      }
      case 'pa': {
        const p = this.playlists.get(r.id)
        if (p === undefined) return
        this._intern(r.ids)
        if (this._skip(ctx, 'p:' + r.id, v)) return
        p.trackIds = insertAt(p.trackIds, r.pos, r.ids)
        this.entries += r.ids.length
        p.updatedAt = r.at
        this.pv.set(r.id, v)
        return
      }
      case 'pr': {
        const p = this.playlists.get(r.id)
        if (p === undefined || this._skip(ctx, 'p:' + r.id, v)) return
        const next = dropPositions(p.trackIds, new Set(r.idx))
        this.entries -= p.trackIds.length - next.length
        p.trackIds = next
        p.updatedAt = r.at
        this.pv.set(r.id, v)
        return
      }
      case 'pd': {
        const p = this.playlists.get(r.id)
        if (p !== undefined && !this._skip(ctx, 'p:' + r.id, v)) {
          this.playlists.delete(r.id)
          this.pv.delete(r.id)
          this.entries -= p.trackIds.length
          this._tomb(ctx, 'p', r.id, v)
        }
        if (this.covers.has(r.id) && !this._skip(ctx, 'c:' + r.id, v)) {
          this.covers.delete(r.id)
          this.coverV.delete(r.id)
          this._tomb(ctx, 'c', r.id, v)
        }
        return
      }
      case 'l':
        this.interned.add(r.id)
        this.likes.add(r.id, r.at, v)
        return
      case 'u':
        this._unlike(r.id, ctx, v)
        return
      case 'lb':
        for (const id of r.rm) this._unlike(id, ctx, v)
        for (const [id, at] of r.add) {
          this.interned.add(id)
          this.likes.add(id, at, v)
        }
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
      }
    }
  }

  /** One object line of a snapshot, at replay. False when the line is not one. */
  loadLine (r, stamps) {
    if (isObj(r.P)) {
      if (!isPlaylistId(r.P.id) || !isIdList(r.P.trackIds)) return false
      const id = r.P.id
      const old = this.playlists.get(id)
      // A second line for an id: the playlist was made again while the snapshot was written.
      if (old !== undefined) {
        this.entries -= old.trackIds.length
        this.playlists.delete(id)
      }
      this._intern(r.P.trackIds)
      this.playlists.set(id, makeRecord(r.P, r.P.trackIds.slice()))
      this.pv.set(id, num0(r.pv))
      this.entries += r.P.trackIds.length
      stamps.set('p:' + id, num0(r.s))
      return true
    }
    if (Array.isArray(r.L)) {
      for (const e of r.L) {
        if (!Array.isArray(e) || !isTrackId(e[0])) return false
        this.interned.add(e[0])
        // An id met again: unliked and liked again while the snapshot was written; the
        // later slot is the like that holds.
        this.likes.remove(e[0])
        this.likes.add(e[0], num0(e[1]), num0(e[2]))
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
        if (!Array.isArray(e) || !TOMB_KINDS.has(e[0]) || typeof e[1] !== 'string') return false
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
    for (const [id, p] of this.playlists) yield '{"P":' + JSON.stringify(p) + ',"s":' + stamp() + ',"pv":' + this.pv.get(id) + '}\n'
    const l = this.likes
    l.walkers++
    try {
      let s = 0
      while (s < l.n) {
        const parts = []
        for (; s < l.n && parts.length < LIKES_CHUNK; s++) {
          if (Number.isNaN(l.at[s])) continue
          parts.push('["' + l.ids[s] + '",' + num(l.at[s]) + ',' + num(l.lv[s]) + ']')
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

  /** What moved after version u. */
  changes (u) {
    const removed = new Set()
    const unliked = new Set()
    const coversGone = new Set()
    for (const [kind, id] of this.tombs.since(u)) {
      if (kind === 'p') removed.add(id)
      else if (kind === 'l') unliked.add(id)
      else coversGone.add(id)
    }
    const changed = []
    for (const id of this.playlists.keys()) if (this.pv.get(id) > u) changed.push(id)
    const added = []
    const l = this.likes
    for (let s = l.firstAfter(u); s < l.n; s++) if (!Number.isNaN(l.at[s])) added.push({ id: l.ids[s], at: l.at[s] })
    const covers = []
    for (const [id, cv] of this.coverV) if (cv > u) covers.push(id)
    for (const id of coversGone) if (!this.coverV.has(id) || this.coverV.get(id) <= u) covers.push(id)
    return { changed, removed: [...removed], added, unliked: [...unliked], recents: this.rv > u, covers }
  }
}

// ------------------------------------------------------------------ lines on disk

/** A change line that may be replayed (one that is not ends the trusted part). */
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
  }
  return false
}

function headerLine (key) {
  return JSON.stringify({ mpfy: 'user-log', schema: 2, key, snap: '000000000000' }) + '\n'
}

function parseLine (buf) {
  try {
    const r = JSON.parse(b4a.toString(buf, 'utf8'))
    return isObj(r) ? r : null
  } catch {
    return null
  }
}

const validEnd = (r) => r !== null && Number.isSafeInteger(r.E) && isObj(r.sum)
const START = (s) => b4a.from(s, 'latin1')
const CHANGE_START = START('{"v":')
const EPOCH_START = START('{"e":')
const EXPORT_START = START('{"xp":')
const OP_START = START(',"o":"')

function startsWith (buf, head) {
  if (buf.byteLength < head.byteLength) return false
  for (let i = 0; i < head.byteLength; i++) if (buf[i] !== head[i]) return false
  return true
}

// The version and the op of a change line, from its first bytes ({"v":V,"o":"<op>",...}).
function changeHead (buf) {
  let i = CHANGE_START.byteLength
  let v = 0
  while (i < buf.byteLength && buf[i] >= 48 && buf[i] <= 57 && i < CHANGE_START.byteLength + 17) v = v * 10 + (buf[i++] - 48)
  if (i === CHANGE_START.byteLength || !Number.isSafeInteger(v) || v < 1) return null
  if (buf.byteLength < i + OP_START.byteLength) return null
  for (let k = 0; k < OP_START.byteLength; k++) if (buf[i + k] !== OP_START[k]) return null
  i += OP_START.byteLength
  const at = buf.indexOf(34, i)
  if (at === -1 || at - i > 4) return null
  return { v, op: b4a.toString(buf.subarray(i, at), 'latin1') }
}

/** The lines of a file, read in chunks, never the whole file at once. */
class LineReader {
  constructor (f, fd, pos = 0, chunk = READ_CHUNK) {
    this.f = f
    this.fd = fd
    this.pos = pos
    this.start = pos
    this.buf = b4a.alloc(chunk)
    this.data = this.buf.subarray(0, 0)
    this.i = 0
    this.eof = false
    this.partial = -1 // where a last line without its newline begins
    this.tooLong = -1 // where a line longer than MAX_LINE begins
  }

  /** { buf, start, end } (buf valid until the next call), or null at the end. */
  next () {
    let parts = null
    let bytes = 0
    const start = this.start
    for (;;) {
      if (this.i >= this.data.byteLength) {
        if (this.eof) break
        const n = this.f.readSync(this.fd, this.buf, 0, this.buf.byteLength, this.pos)
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
        const piece = b4a.from(this.data.subarray(this.i))
        if (parts === null) parts = []
        parts.push(piece)
        bytes += piece.byteLength
        this.i = this.data.byteLength
        if (bytes > MAX_LINE) {
          this.tooLong = start
          return null
        }
        continue
      }
      const piece = this.data.subarray(this.i, nl)
      this.i = nl + 1
      const line = parts === null ? piece : b4a.concat([...parts, piece])
      if (line.byteLength > MAX_LINE) {
        this.tooLong = start
        return null
      }
      this.start = start + line.byteLength + 1
      return { buf: line, start, end: this.start }
    }
    if (parts !== null) this.partial = start
    return null
  }
}

/** A file written in slices at known offsets, every write checked. */
class SliceWriter {
  constructor (f, fd) {
    this.f = f
    this.fd = fd
    this.offset = 0
    this.parts = []
    this.bytes = 0
  }

  push (s) {
    this.parts.push(s)
    this.bytes += s.length
  }

  flush () {
    if (this.parts.length === 0) return
    const buf = b4a.from(this.parts.join(''), 'utf8')
    this.parts = []
    this.bytes = 0
    const n = this.f.writeSync(this.fd, buf, 0, buf.byteLength, this.offset)
    if (n !== buf.byteLength) throw Object.assign(new Error('short write'), { code: 'ENOSPC' })
    this.offset += buf.byteLength
  }
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

// A whole number of the query: null when absent, undefined when it is not one.
function wholeParam (query, name) {
  if (!query.has(name)) return null
  const v = query.get(name)
  if (!NUM_RE.test(v)) return undefined
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : undefined
}

function movedCovers (ids, entries) {
  const out = {}
  for (const id of ids) {
    const e = entries.get(id)
    out[id] = e === undefined ? null : { small: e.small, large: e.large }
  }
  return out
}

// ------------------------------------------------------------------ the store

/**
 * @param {object} opts
 * @param {string} opts.dir  <statePath>.phone
 * @param {object} opts.host  the core: profileId(), json(conn, status, obj, headers),
 *   pieces(conn, status, headers, iterable), readBody(conn, req, rest, max),
 *   homeMayHaveMoved(), log(line)
 * Extras for checks: fs, now (the clock of the data: times and epochs), epochId,
 * limits { compactMin, compactOpenMin, sliceBytes, keepRoundBytes }.
 */
export class PhonePerson {
  constructor ({ dir, host, fs: files = fs, now = Date.now, epochId = newEpochId, limits = {} }) {
    this.dir = dir
    this.file = path.join(dir, PERSON_LOG)
    this.coversDir = path.join(dir, PERSON_COVERS)
    this._host = host
    this._fs = files
    this._now = now
    this._epochId = epochId
    this._compactMin = limits.compactMin ?? COMPACT_MIN
    this._compactOpenMin = limits.compactOpenMin ?? COMPACT_OPEN_MIN
    this._sliceBytes = limits.sliceBytes ?? SLICE_BYTES
    this._keepRoundBytes = limits.keepRoundBytes ?? KEEP_ROUND_BYTES
    this._key = null
    this._gen = 0
    this._closed = false
    this.compactions = 0
    this._clear()
  }

  // Nothing of a log known: before its first read, or for another key.
  _clear () {
    this.person = null
    this._open = null // the replay under way: { steps, done, promise }
    this._head = undefined // 'missing' | 'ours' | 'other', read once
    this._end = undefined // { version, epoch } from the end of the log, read once
    this._exists = false
    this._fd = -1
    this._size = 0
    this._snapBytes = 0
    this._tailBytes = 0
    this.version = 0
    this._epochs = [] // { id, first, last }, oldest first
    this._runEpoch = null // the epoch this run opened in this log
    this._broken = false
    this._compaction = null
    this._compacted = null
    this._kept = null
    this._keptBytes = 0
    this._sync = { busy: false, again: false, timer: null, last: 0, hold: false, idle: [] }
  }

  _log (line) {
    if (this._host && typeof this._host.log === 'function') this._host.log('person: ' + line)
  }

  // The home of the person's data may have moved (a log made, moved, or set aside): said
  // once the call that moved it is over.
  _homeMoved () {
    if (this._host && typeof this._host.homeMayHaveMoved === 'function') setTimeout(() => this._host.homeMayHaveMoved(), 0)
  }

  // The key of the log: the profile's id, "owner" without one. Another profile now: the
  // person of the one before leaves, its log is not read as this one's.
  _checkKey () {
    const id = this._host.profileId()
    const key = typeof id === 'string' && PROFILE_RE.test(id) ? id : 'owner'
    if (key === this._key) return
    const first = this._key === null
    if (!first) this._drop()
    this._key = key
    if (!first) this._homeMoved()
  }

  _drop () {
    this._gen++
    if (this._open !== null && !this._open.done) this._open.steps.return()
    this._abortCompaction()
    if (this._sync.timer !== null) clearTimeout(this._sync.timer)
    if (this._fd !== -1) {
      try {
        this._fs.fdatasyncSync(this._fd)
      } catch {}
    }
    this._closeFd()
    this._clear()
  }

  // ------------------------------------------------------------- what the core asks

  /** Whether the store holds the person's data: a log of this profile is there. */
  holds () {
    this._checkKey()
    if (this.person !== null) return this._exists
    return this._readHead() === 'ours'
  }

  /** The person's version and its epoch (0 and the zero epoch while there is no log). */
  summary () {
    this._checkKey()
    if (this.person === null) {
      if (this._readHead() !== 'ours') return { version: 0, epoch: ZERO_EPOCH }
      const end = this._readEnd()
      if (end !== null) return { version: end.version, epoch: end.epoch }
      this._finishOpen()
    }
    return { version: this.version, epoch: this._epochNow() }
  }

  _epochNow () {
    return this._exists && this._epochs.length > 0 ? this._epochs[this._epochs.length - 1].id : ZERO_EPOCH
  }

  /** The person read, at once if it must be (the first request that needs it). */
  ready () {
    this._checkKey()
    if (this.person !== null) return Promise.resolve()
    return this._opening().promise
  }

  /**
   * The person's part of Locale's /api/library: the whole of it, or (delta answers) what
   * moved since the version a client holds when this log can prove it. mode: 0 the answer
   * of before deltas, 1, 2 (edits: none ever needed, every playlist comes whole).
   */
  async libraryPart (uv, ue, mode) {
    this._checkKey()
    const asked = mode !== 0 && uv !== null && ue !== null
    if (asked && isEpochId(ue)) {
      // A client holding the versions now: nothing moved, nothing to read for it.
      const s = this.summary()
      if (uv === s.version && ue === s.epoch) return this._nothingMoved(s, mode)
    }
    await this.ready()
    const P = this.person
    const version = this.version
    const epoch = this._epochNow()
    if (asked && this._known(ue, uv)) {
      const m = P.changes(uv)
      const changed = []
      for (const id of m.changed) {
        const p = P.playlists.get(id)
        if (p !== undefined) changed.push(p)
      }
      const playlists = { changed, removed: m.removed }
      if (mode === 2) playlists.edits = []
      return {
        version,
        epoch,
        delta: true,
        playlists,
        likes: { added: m.added, removed: m.unliked },
        recents: m.recents ? P.recents.slice(0, MAX_RECENTS) : null,
        covers: movedCovers(m.covers, P.covers)
      }
    }
    return {
      version,
      epoch,
      delta: false,
      playlists: [...P.playlists.values()],
      likes: P.likesList(),
      recents: P.recents.slice(0, MAX_RECENTS),
      covers: P.coversObject()
    }
  }

  _nothingMoved (s, mode) {
    const playlists = { changed: [], removed: [] }
    if (mode === 2) playlists.edits = []
    return { version: s.version, epoch: s.epoch, delta: true, playlists, likes: { added: [], removed: [] }, recents: null, covers: {} }
  }

  // Whether a client holding (epoch, u) holds a true state of this log.
  _known (epoch, u) {
    if (!this._exists || !isEpochId(epoch) || !Number.isSafeInteger(u)) return false
    const e = this._epochs.find((x) => x.id === epoch)
    return e !== undefined && e.first <= u && u <= e.last && u >= this.person.horizon
  }

  /**
   * The data moved to a real source: when the store is still at (uv, ue) and `still()`
   * says the move may end, its log is kept aside as person.log.moved-<ms> (the newest
   * one only) and the store is empty, at the zero epoch. False: a change came since.
   */
  async moved (uv, ue, still = () => true) {
    await this.ready()
    for (let attempt = 0; ; attempt++) {
      if (uv !== this.version || ue !== this._epochNow()) return false
      if (!still()) return null
      if (!this._exists) break
      if (this._broken) throw new HttpError(500, INTERNAL)
      // With nothing awaited from here to the rename: no change comes in between.
      this._abortCompaction()
      if (this._sync.timer !== null) clearTimeout(this._sync.timer)
      this._sync.timer = null
      try {
        this._fs.fdatasyncSync(this._fd)
      } catch {}
      this._closeFd()
      const aside = this.file + '.moved-' + Date.now()
      try {
        this._fs.renameSync(this.file, aside)
      } catch (err) {
        this._fd = this._fs.openSync(this.file, 'r+')
        if (attempt + 1 >= RENAME_TRIES || !(err && RETRY_CODES.has(err.code))) {
          this._log('the log could not be set aside for the move: ' + (err && err.message))
          throw new HttpError(500, INTERNAL)
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
        continue
      }
      this._syncDir()
      for (const name of this._names()) {
        if (name.startsWith(PERSON_LOG + '.moved-') && path.join(this.dir, name) !== aside) this._unlink(path.join(this.dir, name))
      }
      break
    }
    const key = this._key
    this._clear()
    this._key = key
    this.person = new Person()
    this._head = 'missing'
    this._homeMoved()
    return true
  }

  // ------------------------------------------------------------- reading the log

  _names () {
    try {
      return this._fs.readdirSync(this.dir)
    } catch {
      return []
    }
  }

  _unlink (file) {
    try {
      this._fs.unlinkSync(file)
    } catch {}
  }

  // Whose the log is, from its first line: read once.
  _readHead () {
    if (this._head !== undefined) return this._head
    let fd
    try {
      fd = this._fs.openSync(this.file, 'r')
    } catch (err) {
      if (err && err.code === 'ENOENT') return (this._head = 'missing')
      return 'ours' // not readable now: the person's data may be there
    }
    try {
      const line = new LineReader(this._fs, fd, 0, 4096).next()
      const h = line === null ? null : parseLine(line.buf)
      this._head = h !== null && h.mpfy === 'user-log' && h.schema === 2 && typeof h.snap === 'string' && h.key === this._key ? 'ours' : 'other'
    } catch {
      return 'ours'
    } finally {
      try {
        this._fs.closeSync(fd)
      } catch {}
    }
    return this._head
  }

  // The version and its epoch from the end of the log, without reading the person: the
  // snapshot's end (where the header says it is), then the changes after it, of which only
  // the epoch lines are parsed. Null when that cannot be said this way.
  _readEnd () {
    if (this._end !== undefined) return this._end
    this._end = null
    let fd
    try {
      fd = this._fs.openSync(this.file, 'r')
    } catch {
      return null
    }
    try {
      const reader = new LineReader(this._fs, fd, 0, PEEK_CHUNK)
      const first = reader.next()
      const h = first === null ? null : parseLine(first.buf)
      const s = reader.next()
      const sv = s === null ? null : parseLine(s.buf)
      if (h === null || sv === null || !isObj(sv.S) || !Number.isSafeInteger(sv.S.v)) return null
      const at = Number(h.snap)
      if (!(at > s.start)) return null
      const tail = new LineReader(this._fs, fd, at, PEEK_CHUNK)
      const eLine = tail.next()
      const e = eLine === null ? null : parseLine(eLine.buf)
      if (!validEnd(e)) return null
      const ep = Array.isArray(e.sum.ep) ? e.sum.ep.filter((x) => Array.isArray(x) && isEpochId(x[0])) : []
      let epoch = ep.length > 0 ? ep[ep.length - 1][0] : ZERO_EPOCH
      let version = e.E
      let tailV = sv.S.v
      let expect = sv.S.v + 1
      let prev = null
      // The changes after the snapshot, as far as a replay trusts them.
      for (;;) {
        const line = tail.next()
        if (line === null) break
        const b = line.buf
        if (startsWith(b, CHANGE_START)) {
          const head = changeHead(b)
          if (head === null || !KNOWN_OPS.has(head.op)) break
          if (prev === null ? head.v !== expect : head.v !== prev && head.v !== prev + 1) break
          prev = head.v
          tailV = head.v
        } else if (startsWith(b, EPOCH_START)) {
          const r = parseLine(b)
          if (r === null || !isEpochId(r.e) || !Number.isSafeInteger(r.v) || r.v <= tailV) break
          epoch = r.e
          tailV = r.v
          expect = r.v + 1
          prev = null
        } else if (!startsWith(b, EXPORT_START)) break
      }
      version = Math.max(version, tailV)
      this._end = { version, epoch }
      return this._end
    } catch {
      return null
    } finally {
      try {
        this._fs.closeSync(fd)
      } catch {}
    }
  }

  _opening () {
    if (this._open !== null) return this._open
    const gen = this._gen
    const o = { steps: this._replay(), done: false, promise: null }
    this._open = o
    o.promise = (async () => {
      let t0 = Date.now()
      while (!o.done) {
        if (Date.now() - t0 >= REPLAY_SLICE_MS) {
          await tick()
          t0 = Date.now()
          if (o.done) break
          if (gen !== this._gen || this._closed) {
            o.done = true
            o.steps.return()
            throw new HttpError(500, INTERNAL)
          }
        }
        this._step(o)
      }
    })()
    o.promise.catch(noop)
    return o
  }

  // The rest of a replay under way done at once (a summary the end of the log cannot give).
  _finishOpen () {
    const o = this._opening()
    while (!o.done) this._step(o)
  }

  _step (o) {
    let r
    try {
      r = o.steps.next()
    } catch (err) {
      o.done = true
      this._open = null
      throw err
    }
    if (r.done) {
      o.done = true
      this._opened(r.value)
    }
  }

  // The replay ended: the person in memory (empty when its log was missing, of another
  // profile, or could not be read, then set aside), the log open for changes.
  _opened (out) {
    const before = this._readHead() === 'ours'
    if (out.status === 'ok') {
      if (out.cut >= 0) this._cut(out.cut, out.end, out.reason)
      else if (out.partial >= 0) {
        try {
          this._truncate(out.partial)
          this._log('a last line cut short dropped')
        } catch (err) {
          this._log('a last line cut short not dropped: ' + err.message)
        }
      }
      this.person = out.person
      this.version = out.version
      this._epochs = out.epochs
      this._size = out.size
      this._snapBytes = out.snapBytes
      this._tailBytes = out.size - out.tailAt
      this._exists = true
      this._head = 'ours'
      this._fd = this._fs.openSync(this.file, 'r+')
    } else {
      if (out.status !== 'missing') {
        const aside = this.file + '.' + (out.status === 'wrong' ? 'wrong' : 'cut') + '-' + Date.now()
        try {
          this._fs.renameSync(this.file, aside)
          this._log((out.status === 'wrong' ? 'a log of another profile' : out.reason) + ', the whole file kept as ' + path.basename(aside))
        } catch (err) {
          this._log('a log not read could not be set aside: ' + err.message)
        }
      }
      this.person = new Person()
      this.version = 0
      this._epochs = []
      this._exists = false
      this._head = 'missing'
    }
    this._end = undefined
    this._sweepCovers()
    if (before !== this._exists) this._homeMoved()
    if (this._exists && this._tailBytes > Math.max(this._compactOpenMin, this._snapBytes / 4)) this.compact()
  }

  * _replay () {
    const f = this._fs
    let fd
    try {
      fd = f.openSync(this.file, 'r')
    } catch (err) {
      if (err && err.code === 'ENOENT') return { status: 'missing' }
      throw err
    }
    try {
      return yield * this._read(fd)
    } finally {
      try {
        f.closeSync(fd)
      } catch {}
    }
  }

  * _read (fd) {
    const damaged = (reason) => ({ status: 'damaged', reason })
    const end = this._fs.fstatSync(fd).size
    const reader = new LineReader(this._fs, fd)
    const first = reader.next()
    const h = first === null ? null : parseLine(first.buf)
    if (h === null || h.mpfy !== 'user-log' || h.schema !== 2 || typeof h.snap !== 'string') return damaged('an unreadable header')
    if (h.key !== this._key) return { status: 'wrong' }
    const person = new Person()
    const sLine = reader.next()
    const s = sLine === null ? null : parseLine(sLine.buf)
    if (s === null || !isObj(s.S) || !Number.isSafeInteger(s.S.v)) return damaged('no snapshot')
    const vs = s.S.v
    const snapStart = sLine.start
    const stamps = new Map()
    let ve = 0
    let sum = null
    let tailAt = 0
    let snapBytes = 0
    let t0 = Date.now()
    for (;;) {
      const line = reader.next()
      if (line === null) return damaged('a snapshot without its end')
      const r = parseLine(line.buf)
      if (r === null) return damaged('a snapshot line that does not parse')
      if (r.E !== undefined) {
        if (!Number.isSafeInteger(r.E) || !isObj(r.sum)) return damaged('a snapshot end that does not parse')
        ve = r.E
        sum = r.sum
        snapBytes = line.end - snapStart
        tailAt = line.end
        break
      }
      if (!person.loadLine(r, stamps)) return damaged('an unknown snapshot line')
      if (Date.now() - t0 > REPLAY_SLICE_MS) {
        yield
        t0 = Date.now()
      }
    }
    const epochs = []
    for (const e of Array.isArray(sum.ep) ? sum.ep : []) {
      if (Array.isArray(e) && isEpochId(e[0]) && Number.isSafeInteger(e[1]) && Number.isSafeInteger(e[2])) epochs.push({ id: e[0], first: e[1], last: e[2] })
    }
    person.baseHorizon = num0(sum.h)
    // The tail, line by line, its versions checked.
    const ctx = { stamps, tombsUpTo: ve }
    let cut = -1
    let reason = ''
    let tailV = vs
    let expect = vs + 1 // the version a change must have right after S or an epoch line
    let prev = null
    let current = null
    for (const e of epochs) if (e.first <= vs) current = e
    let wholeEnd = tailAt
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
        // An epoch the snapshot already lists (opened while it was written) is not added twice.
        current = epochs.find((x) => x.id === r.e)
        if (current === undefined) {
          current = { id: r.e, first: r.v, last: r.v }
          epochs.push(current)
        }
        tailV = r.v
        expect = r.v + 1
        prev = null
      } else if (r.xp !== undefined) {
        // A note of the source's (a file it wrote for an older version): nothing for the phone.
      } else if (typeof r.o === 'string' && KNOWN_OPS.has(r.o) && validChange(r)) {
        if (prev === null ? r.v !== expect : r.v !== prev && r.v !== prev + 1) {
          cut = line.start
          reason = 'a version out of sequence'
          break
        }
        person.apply(r, ctx)
        prev = r.v
        tailV = r.v
        if (current !== null && current.last < r.v) current.last = r.v
      } else {
        cut = line.start
        reason = 'an unknown line'
        break
      }
      wholeEnd = line.end
      if (Date.now() - t0 > REPLAY_SLICE_MS) {
        yield
        t0 = Date.now()
      }
    }
    return {
      status: 'ok',
      person,
      version: Math.max(ve, tailV),
      epochs,
      size: cut >= 0 ? cut : wholeEnd,
      snapBytes,
      tailAt,
      cut,
      end,
      reason,
      partial: cut < 0 ? reader.partial : -1
    }
  }

  _truncate (at) {
    const fd = this._fs.openSync(this.file, 'r+')
    try {
      this._fs.ftruncateSync(fd, at)
    } finally {
      this._fs.closeSync(fd)
    }
  }

  // What follows the trusted part is kept aside, then the file is cut there.
  _cut (at, end, reason) {
    const aside = this.file + '.cut-' + Date.now()
    const f = this._fs
    try {
      const src = f.openSync(this.file, 'r')
      const dst = f.openSync(aside, 'w')
      try {
        const buf = b4a.alloc(Math.min(READ_CHUNK, Math.max(1, end - at)))
        for (let pos = at; pos < end;) {
          const n = f.readSync(src, buf, 0, Math.min(buf.byteLength, end - pos), pos)
          if (n === 0) break
          f.writeSync(dst, buf, 0, n)
          pos += n
        }
        f.fsyncSync(dst)
      } finally {
        f.closeSync(src)
        f.closeSync(dst)
      }
      this._truncate(at)
      this._log(reason + ' at byte ' + at + ', the rest kept in ' + path.basename(aside))
    } catch (err) {
      this._log(reason + ' at byte ' + at + ', not cut: ' + err.message)
    }
  }

  // Covers nothing names (a cover written for a change that never landed, those of a log
  // moved or set aside): gone when the person is read.
  _sweepCovers () {
    let names
    try {
      names = this._fs.readdirSync(this.coversDir)
    } catch {
      return
    }
    const named = new Set(this.person.coverIds())
    for (const name of names) {
      const m = /^([0-9a-f]{24})\.jpg$/.exec(name)
      if (m !== null && named.has(m[1])) continue
      this._unlink(path.join(this.coversDir, name))
    }
  }

  // ------------------------------------------------------------- writing the log

  _closeFd () {
    if (this._fd === -1) return
    try {
      this._fs.closeSync(this._fd)
    } catch {}
    this._fd = -1
  }

  _syncDir () {
    let fd = -1
    try {
      fd = this._fs.openSync(this.dir, 'r')
      this._fs.fsyncSync(fd)
    } catch {
      // Windows opens no directory: nothing to do there.
    } finally {
      if (fd !== -1) {
        try {
          this._fs.closeSync(fd)
        } catch {}
      }
    }
  }

  // The E line: the epochs that still matter (at most 64, the horizon raised past any
  // dropped), the horizon, the ids a reader of the summary needs, the counts.
  _endLine (person, ve, horizon) {
    let h = horizon
    let kept = this._epochs.filter((e) => e.last >= h)
    while (kept.length > MAX_EPOCHS) {
      h = Math.max(h, kept[0].last)
      kept = kept.slice(1)
    }
    kept = kept.filter((e) => e.last >= h)
    if (h > person.baseHorizon) person.baseHorizon = h
    this._epochs = kept
    const sum = {
      ep: kept.map((e) => [e.id, e.first, e.last]),
      h,
      pl: [...person.playlists.keys()],
      pc: person.coverIds(),
      n: [person.likes.live, person.interned.size, person.entries]
    }
    return '{"E":' + ve + ',"sum":' + JSON.stringify(sum) + '}\n'
  }

  _patchSnap (fd, header, eAt) {
    const digits = b4a.from(String(eAt).padStart(12, '0'), 'latin1')
    const at = b4a.byteLength(header.slice(0, header.indexOf('"snap":"') + 8), 'utf8')
    const n = this._fs.writeSync(fd, digits, 0, 12, at)
    if (n !== 12) throw Object.assign(new Error('short write'), { code: 'ENOSPC' })
  }

  // A person with no log gets one: written whole (empty), synced, renamed into place.
  _ensureLog () {
    if (this._exists) return
    const f = this._fs
    const tmp = this.file + '.tmp'
    const v = this.version
    let fd = -1
    let w
    const header = headerLine(this._key)
    try {
      f.mkdirSync(this.dir, { recursive: true })
      fd = f.openSync(tmp, 'w')
      w = new SliceWriter(f, fd)
      w.push(header)
      w.push('{"S":{"v":' + v + '}}\n')
      for (const line of this.person.bodyLines(() => v)) w.push(line)
      w.push(this.person.tombs.line())
      w.flush()
      const eAt = w.offset
      w.push(this._endLine(this.person, v, this.person.horizon))
      w.flush()
      this._patchSnap(fd, header, eAt)
      f.fsyncSync(fd)
      f.closeSync(fd)
      fd = -1
      f.renameSync(tmp, this.file)
    } catch (err) {
      if (fd !== -1) {
        try {
          f.closeSync(fd)
        } catch {}
      }
      this._unlink(tmp)
      this._log('the log not made: ' + err.message)
      throw diskError(err)
    }
    this._syncDir()
    this._fd = f.openSync(this.file, 'r+')
    this._size = w.offset
    this._snapBytes = w.offset - b4a.byteLength(header, 'utf8')
    this._tailBytes = 0
    this._exists = true
    this._head = 'ours'
    this._homeMoved()
  }

  /**
   * One batch of changes: one version, one checked write; only then is each applied. The
   * first change of this run opens its epoch in the same write. Throws (507, 500) when the
   * write fails: then nothing was applied.
   */
  _commit (ops) {
    if (this._broken || this._closed) throw new HttpError(500, INTERNAL)
    this._ensureLog()
    if (this._fd === -1) throw new HttpError(500, INTERNAL)
    let text = ''
    let opened = null
    let v
    if (this._runEpoch === null) {
      const e = Math.max(this.version + 1, this._now())
      opened = { id: this._epochId(), first: e, last: e + 1 }
      text = '{"e":"' + opened.id + '","v":' + e + '}\n'
      v = e + 1
    } else v = this.version + 1
    const lines = ops.map((op) => ({ v, ...op }))
    for (const r of lines) text += JSON.stringify(r) + '\n'
    const buf = b4a.from(text, 'utf8')
    this._write(buf)
    for (const r of lines) this.person.apply(r, null)
    this.version = v
    if (opened !== null) {
      this._runEpoch = opened.id
      this._epochs.push(opened)
    } else this._epochs[this._epochs.length - 1].last = v
    this._size += buf.byteLength
    this._tailBytes += buf.byteLength
    if (this._kept !== null) {
      this._kept.push(text)
      this._keptBytes += buf.byteLength
    }
    this._scheduleSync()
    if (this._compaction === null && this._tailBytes > Math.max(this._compactMin, this._snapBytes)) this.compact()
    return v
  }

  _write (buf) {
    let n
    try {
      n = this._fs.writeSync(this._fd, buf, 0, buf.byteLength, this._size)
    } catch (err) {
      this._cutBack()
      this._log('a change not written: ' + err.message)
      throw diskError(err)
    }
    if (n !== buf.byteLength) {
      this._cutBack()
      this._log('a change written short (' + n + ' of ' + buf.byteLength + ' bytes), cut back')
      throw new HttpError(507, 'Spazio su disco esaurito sulla fonte', 'disk_full')
    }
  }

  // After a failed write, the file back to its whole lines; when even that fails, no change
  // is taken until the next start (no line may follow half a line).
  _cutBack () {
    try {
      this._fs.ftruncateSync(this._fd, this._size)
      return
    } catch {}
    try {
      this._truncate(this._size)
    } catch (err) {
      this._broken = true
      this._log('the log could not be cut back after a failed write, no change is taken until a restart: ' + err.message)
    }
  }

  _scheduleSync () {
    const s = this._sync
    if (s.hold || s.busy) {
      s.again = true
      return
    }
    if (s.timer !== null) return
    const wait = Math.min(SYNC_EVERY_MS, Math.max(0, s.last + SYNC_EVERY_MS - Date.now()))
    s.timer = setTimeout(() => {
      s.timer = null
      this._syncNow()
    }, wait)
  }

  _syncNow () {
    const s = this._sync
    if (this._fd === -1 || s.hold) {
      if (s.hold) s.again = true
      return
    }
    s.busy = true
    s.again = false
    const sync = this._sync
    this._fs.fdatasync(this._fd, (err) => {
      sync.busy = false
      sync.last = Date.now()
      if (err && err.code !== 'EBADF') this._log('not synced: ' + err.message)
      const idle = sync.idle
      sync.idle = []
      for (const resolve of idle) resolve()
      if (sync === this._sync && sync.again && !sync.hold && !this._closed) this._scheduleSync()
    })
  }

  _syncIdle () {
    const s = this._sync
    return s.busy ? new Promise((resolve) => s.idle.push(resolve)) : Promise.resolve()
  }

  /** Synced now (a stop, checks). */
  syncNow () {
    if (this._fd === -1) return
    try {
      this._fs.fdatasyncSync(this._fd)
    } catch (err) {
      this._log('not synced: ' + err.message)
    }
  }

  // ------------------------------------------------------------- compaction

  get compacting () {
    return this._compaction !== null
  }

  /** The snapshot written again in the background; resolves when done (or given up). */
  compact () {
    if (this._compaction !== null) return this._compacted
    if (this.person === null || !this._exists || this._broken || this._closed) return Promise.resolve()
    const c = { tmp: this.file + '.tmp', fd: -1, aborted: false, done: false }
    this._compaction = c
    this._compacted = this._compact(c)
      .catch((err) => {
        if (!c.aborted) this._log('not compacted: ' + ((err && err.message) || err))
      })
      .finally(() => {
        if (!c.done && !c.aborted) this._giveUp(c)
        if (this._compaction === c) {
          this._compaction = null
          this._kept = null
          this._keptBytes = 0
        }
        if (this._sync.hold && this._compaction === null) {
          this._sync.hold = false
          if (this._sync.again) this._scheduleSync()
        }
      })
    return this._compacted
  }

  /** Resolves when no compaction runs. */
  settled () {
    return this._compaction === null ? Promise.resolve() : this._compacted
  }

  _giveUp (c) {
    c.aborted = true
    if (c.fd !== -1) {
      try {
        this._fs.closeSync(c.fd)
      } catch {}
      c.fd = -1
    }
    this._unlink(c.tmp)
  }

  _abortCompaction () {
    const c = this._compaction
    if (c === null) return
    this._giveUp(c)
    this._compaction = null
    this._kept = null
    this._keptBytes = 0
    this._sync.hold = false
  }

  async _compact (c) {
    const f = this._fs
    const person = this.person
    const live = () => !c.aborted && this._compaction === c && !this._closed && !this._broken && this.person === person
    this._unlink(c.tmp)
    c.fd = f.openSync(c.tmp, 'w')
    const header = headerLine(this._key)
    const w = new SliceWriter(f, c.fd)
    w.push(header)
    // From here every line written to the live file is kept for the new one too.
    const vs = this.version
    this._kept = []
    this._keptBytes = 0
    w.push('{"S":{"v":' + vs + '}}\n')
    const headerBytes = b4a.byteLength(header, 'utf8')
    for (const line of person.bodyLines(() => this.version)) {
      w.push(line)
      if (w.bytes >= this._sliceBytes) {
        w.flush()
        await tick()
        if (!live()) return
      }
    }
    // The removals and the end, made at one moment.
    const ve = this.version
    w.push(person.tombs.line())
    if (Object.keys(person.extra).length > 0 || Object.keys(person.coversExtra).length > 0) {
      w.push('{"X":' + JSON.stringify(person.extra) + ',"CX":' + JSON.stringify(person.coversExtra) + '}\n')
    }
    w.flush()
    const eAt = w.offset
    w.push(this._endLine(person, ve, person.horizon))
    w.flush()
    const snapBytes = w.offset - headerBytes
    this._patchSnap(c.fd, header, eAt)
    await fsyncOf(f, c.fd)
    if (!live()) return
    // The lines written meanwhile, synced into the new file before it takes the log's place:
    // at least one round, until little is left. No sync of the live file starts meanwhile.
    this._sync.hold = true
    let tail = 0
    do {
      const more = this._kept.join('')
      this._kept = []
      this._keptBytes = 0
      if (more.length > 0) {
        w.push(more)
        tail += b4a.byteLength(more, 'utf8')
        w.flush()
      }
      await fsyncOf(f, c.fd)
      await this._syncIdle()
      if (!live()) return
    } while (this._keptBytes >= this._keepRoundBytes)
    // The end, with nothing awaited until the rename: no change comes in between. A rename
    // refused for a moment (Windows) is tried again a little later, the lines written
    // meanwhile added first.
    for (let attempt = 0; ; attempt++) {
      const rest = this._kept.join('')
      this._kept = []
      this._keptBytes = 0
      if (rest.length > 0) {
        if (c.fd === -1) c.fd = f.openSync(c.tmp, 'r+')
        w.fd = c.fd
        w.push(rest)
        tail += b4a.byteLength(rest, 'utf8')
        w.flush()
      }
      if (c.fd !== -1) {
        f.closeSync(c.fd)
        c.fd = -1
      }
      this._closeFd()
      try {
        f.renameSync(c.tmp, this.file)
        break
      } catch (err) {
        this._fd = f.openSync(this.file, 'r+')
        if (attempt + 1 >= RENAME_TRIES || !(err && RETRY_CODES.has(err.code))) throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      if (!live()) return
    }
    this._syncDir()
    this._fd = f.openSync(this.file, 'r+')
    this._snapBytes = snapBytes
    this._tailBytes = tail
    this._size = w.offset
    this._kept = null
    this._keptBytes = 0
    this.compactions++
    c.done = true
    this._sync.hold = false
    this._scheduleSync()
  }

  /** Synced and closed; a compaction under way given up. */
  async stop () {
    this._closed = true
    this._gen++
    if (this._open !== null && !this._open.done) this._open.steps.return()
    this._abortCompaction()
    if (this._sync.timer !== null) clearTimeout(this._sync.timer)
    this._sync.timer = null
    this.syncNow()
    this._closeFd()
  }

  // ------------------------------------------------------------- the person's changes
  // The source's rules and refusals, the same texts and codes; each one written whole or
  // not at all. They need the person read (ready()).

  _p () {
    if (this.person === null) throw new HttpError(500, INTERNAL)
    return this.person
  }

  playlist (id) {
    if (!isPlaylistId(id)) throw new HttpError(400, 'Identificativo della playlist non valido')
    const p = this._p().playlists.get(id)
    if (!p) throw new HttpError(404, 'Playlist non trovata')
    return p
  }

  _trackIdList (list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Elenco di brani non valido')
    if (list.length > MAX_PLAYLIST_LENGTH) throw new HttpError(400, 'Troppi brani')
    for (const id of list) if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    return list.slice()
  }

  createPlaylist (body = {}) {
    const P = this._p()
    let id = null
    if (body.id !== undefined && body.id !== null) {
      if (!isPlaylistId(body.id)) throw new HttpError(400, 'Identificativo della playlist non valido')
      if (P.playlists.has(body.id)) throw new HttpError(409, "Playlist gia' presente", 'playlist_exists')
      id = body.id
    }
    if (P.playlists.size >= MAX_PLAYLISTS) throw new HttpError(400, 'Troppe playlist')
    let name = body.name === undefined || body.name === null ? '' : text(body.name, 200)
    if (!name) name = 'La mia playlist n. ' + (P.playlists.size + 1)
    const description = body.description === undefined || body.description === null ? '' : text(body.description, 1000)
    if (id === null) {
      do id = b4a.toString(randomBytes(8), 'hex')
      while (P.playlists.has(id))
    }
    const now = this._now()
    this._commit([{ o: 'pc', p: { id, name, description, trackIds: [], createdAt: now, updatedAt: now } }])
    return P.playlists.get(id)
  }

  /**
   * body: { name?, description?, trackIds?, base? }. trackIds is the whole new order; with
   * base, the list that order was made from, it is laid on the list as it is now.
   */
  updatePlaylist (id, body = {}) {
    const P = this._p()
    const p = this.playlist(id)
    const op = { o: 'pu', id }
    if (body.name !== undefined) {
      op.name = text(body.name, 200)
      if (!op.name) throw new HttpError(400, "Il nome non puo' essere vuoto")
    }
    if (body.description !== undefined) op.description = body.description === null ? '' : text(body.description, 1000)
    if (body.trackIds !== undefined) {
      let ids = this._trackIdList(body.trackIds)
      if (body.base !== undefined && body.base !== null) {
        ids = rebaseOrder(p.trackIds, this._trackIdList(body.base), ids)
        if (ids.length > MAX_PLAYLIST_LENGTH) throw new HttpError(400, 'Playlist troppo lunga')
      }
      if (P.entries - p.trackIds.length + ids.length > MAX_PLAYLIST_ENTRIES) throw new HttpError(400, 'Troppi brani nelle playlist')
      op.trackIds = ids
    }
    op.at = this._now()
    this._commit([op])
    return p
  }

  addToPlaylist (id, trackIds, position) {
    const P = this._p()
    const p = this.playlist(id)
    const ids = this._trackIdList(trackIds)
    if (ids.length === 0) throw new HttpError(400, 'Nessun brano da aggiungere')
    const len = p.trackIds.length
    if (len + ids.length > MAX_PLAYLIST_LENGTH) throw new HttpError(400, 'Playlist troppo lunga')
    if (P.entries + ids.length > MAX_PLAYLIST_ENTRIES) throw new HttpError(400, 'Troppi brani nelle playlist')
    let pos = len
    if (position !== undefined && position !== null) {
      if (!Number.isInteger(position) || position < 0) throw new HttpError(400, 'Posizione non valida')
      pos = Math.min(position, len)
    }
    this._commit([{ o: 'pa', id, pos, ids, at: this._now() }])
    return p
  }

  /**
   * The songs at these positions removed. With ids (the song the client saw at each
   * position) a position is checked against the list as it is now: a song that moved is
   * removed where it is now, one already gone is left alone; with counts, a copy gone
   * since counts as one of those asked.
   */
  removeFromPlaylist (id, indexes, ids, counts) {
    const p = this.playlist(id)
    const len = p.trackIds.length
    if (!Array.isArray(indexes) || indexes.length === 0) throw new HttpError(400, 'Elenco di posizioni non valido')
    const checked = ids !== undefined && ids !== null
    const counted = counts !== undefined && counts !== null
    if (checked && (!Array.isArray(ids) || ids.length !== indexes.length)) throw new HttpError(400, 'Elenco di brani non valido')
    if (counted && (!checked || !Array.isArray(counts) || counts.length !== indexes.length)) throw new HttpError(400, 'Elenco di copie non valido')
    indexes.forEach((i, k) => {
      if (!Number.isInteger(i) || i < 0 || (!checked && i >= len)) throw new HttpError(400, 'Posizione non valida')
      if (checked && !isTrackId(ids[k])) throw new HttpError(400, 'Identificativo del brano non valido')
      if (counted && !(Number.isInteger(counts[k]) && counts[k] >= 1 && counts[k] <= MAX_PLAYLIST_LENGTH)) throw new HttpError(400, 'Elenco di copie non valido')
    })
    const drop = checked ? removalSlots(p.trackIds, indexes, ids, counted ? counts : null) : new Set(indexes)
    if (drop.size === 0) return p
    this._commit([{ o: 'pr', id, idx: [...drop].sort((a, b) => a - b), at: this._now() }])
    return p
  }

  deletePlaylist (id) {
    this.playlist(id)
    const entry = this.person.covers.get(id)
    const released = entry ? [entry.small, entry.large] : []
    this._commit([{ o: 'pd', id }])
    for (const cover of released) if (cover) this._release(cover)
  }

  like (trackId) {
    const P = this._p()
    if (!isTrackId(trackId)) throw new HttpError(400, 'Identificativo del brano non valido')
    if (!P.likes.has(trackId)) {
      if (P.likes.live >= MAX_LIKES) throw new HttpError(400, 'Troppi brani piaciuti')
      this._commit([{ o: 'l', id: trackId, at: this._now() }])
    }
    return P.likesList()
  }

  unlike (trackId) {
    const P = this._p()
    if (!isTrackId(trackId)) throw new HttpError(400, 'Identificativo del brano non valido')
    if (P.likes.has(trackId)) this._commit([{ o: 'u', id: trackId }])
    return P.likesList()
  }

  /**
   * Many likes at once ({ add, remove }, at most 5,000 ids in all): the removes, then the
   * adds in the given order, each as the newest, all at this request's time; an id already
   * liked and not removed here stays where it is; one in both lists is removed then added.
   */
  bulkLikes (body) {
    const P = this._p()
    if (!isObj(body)) throw badRequest()
    const add = body.add === undefined ? [] : body.add
    const remove = body.remove === undefined ? [] : body.remove
    if (!Array.isArray(add) || !Array.isArray(remove) || add.length + remove.length > MAX_BULK_LIKES) throw badRequest()
    for (const id of remove) if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    for (const id of add) if (!isTrackId(id)) throw new HttpError(400, 'Identificativo del brano non valido')
    const removing = new Set(remove)
    const rm = []
    for (const id of removing) if (P.likes.has(id)) rm.push(id)
    const seen = new Set()
    const adds = []
    for (const id of add) {
      if (seen.has(id)) continue
      seen.add(id)
      if (P.likes.has(id) && !removing.has(id)) continue
      adds.push(id)
    }
    if (P.likes.live - rm.length + adds.length > MAX_LIKES) throw new HttpError(400, 'Troppi brani piaciuti', 'too_many_likes')
    if (rm.length === 0 && adds.length === 0) return { added: 0, removed: 0 }
    const now = this._now()
    this._commit([{ o: 'lb', add: adds.map((id) => [id, now]), rm }])
    return { added: adds.length, removed: rm.length }
  }

  /** A play: `at` kept when it lies within the last 30 days (and not ahead), else now. */
  played (trackId, context, at) {
    const P = this._p()
    if (!isTrackId(trackId)) throw new HttpError(400, 'Identificativo del brano non valido')
    let ctx = { type: 'library' }
    if (context !== undefined && context !== null) {
      if (typeof context !== 'object' || Array.isArray(context) || !CONTEXT_TYPES.has(context.type)) throw new HttpError(400, 'Contesto non valido')
      ctx = { type: context.type }
      if (context.id !== undefined && context.id !== null) {
        if (typeof context.id !== 'string' || context.id.length > 200) throw new HttpError(400, 'Contesto non valido')
        ctx.id = context.id
      }
    }
    if (at !== undefined && at !== null && (typeof at !== 'number' || !Number.isFinite(at))) throw new HttpError(400, 'Momento non valido')
    const now = this._now()
    let when = now
    if (typeof at === 'number' && at >= now - PLAYED_AT_MAX_AGE && at <= now + PLAYED_AT_MAX_SKEW) when = Math.min(Math.round(at), now)
    let i = 0
    while (i < P.recents.length && P.recents[i].at > when) i++
    if (i >= MAX_HISTORY) return
    this._commit([{ o: 'r', r: { trackId, at: when, context: ctx } }])
  }

  /** The plays older than `before` (null: from the newest), newest first, at most `limit`. */
  recentsPage (before, limit) {
    const recents = this._p().recents
    let i = 0
    if (before !== null) while (i < recents.length && recents[i].at >= before) i++
    const page = recents.slice(i, i + limit).map((r) => ({ trackId: r.trackId, at: r.at, context: { ...r.context } }))
    return { recents: page, more: i + limit < recents.length }
  }

  setPlaylistCover (id, size, coverId) {
    this.playlist(id)
    if (!COVER_SIZES.includes(size)) throw new HttpError(400, 'Dimensione non valida')
    const entry = this.person.covers.get(id)
    const previous = entry ? entry[size] : null
    this._commit([{ o: 'cs', id, size, cover: coverId }])
    if (previous && previous !== coverId) this._release(previous)
  }

  clearPlaylistCover (id) {
    this.playlist(id)
    const entry = this.person.covers.get(id)
    if (!entry) return
    const released = [entry.small, entry.large]
    this._commit([{ o: 'cc', id }])
    for (const cover of released) if (cover) this._release(cover)
  }

  // A cover file nothing names any more goes.
  _release (coverId) {
    if (this.person.names(coverId)) return
    this._unlink(path.join(this.coversDir, coverId + '.jpg'))
  }

  // The picture kept as person-covers/<id>.jpg (once: the same bytes make the same id).
  // Null: no JPEG, PNG or WebP.
  _saveCover (data) {
    if (data.byteLength === 0 || data.byteLength > MAX_COVER_BYTES) return null
    const id = coverIdOf(data)
    if (id === null) return null
    const f = this._fs
    const file = path.join(this.coversDir, id + '.jpg')
    try {
      f.statSync(file)
      return id
    } catch {}
    const tmp = file + '.tmp'
    let fd = -1
    try {
      f.mkdirSync(this.coversDir, { recursive: true })
      fd = f.openSync(tmp, 'w')
      let off = 0
      while (off < data.byteLength) {
        const n = f.writeSync(fd, data, off, data.byteLength - off)
        if (n <= 0) throw Object.assign(new Error('short write'), { code: 'ENOSPC' })
        off += n
      }
      f.fsyncSync(fd)
      f.closeSync(fd)
      fd = -1
      f.renameSync(tmp, file)
    } catch (err) {
      if (fd !== -1) {
        try {
          f.closeSync(fd)
        } catch {}
      }
      this._unlink(tmp)
      throw diskError(err)
    }
    return id
  }

  // ------------------------------------------------------------- the routes

  /** /s/0000/api/<the person's routes>, while the store is the home. */
  async handle (conn, req, target, rest) {
    let answer
    try {
      answer = await this._route(conn, req, target, rest)
    } catch (err) {
      const known = err instanceof HttpError
      if (!known) this._log('a request failed: ' + ((err && err.stack) || err))
      const body = { error: known ? err.message : INTERNAL }
      if (known && err.code) body.code = err.code
      return this._host.json(conn, known ? err.status : 500, body)
    }
    if (answer === GONE) return
    if (typeof answer.pieces === 'function') return this._host.pieces(conn, 200, { ...JSON_HEADERS, ...answer.headers }, answer.pieces())
    return this._host.json(conn, answer.status || 200, answer.body, answer.headers || null)
  }

  // The answer of a change, with the person's version and epoch once it is applied.
  _done (body) {
    return { body, headers: this._versionHeaders() }
  }

  _versionHeaders () {
    return { 'X-MPfy-User-Version': String(this.version), 'X-MPfy-User-Epoch': this._epochNow() }
  }

  async _jsonBody (conn, req, rest) {
    const raw = await this._host.readBody(conn, req, rest, MAX_JSON_BODY)
    if (raw === null) return GONE
    if (raw.byteLength === 0) return {}
    try {
      return JSON.parse(b4a.toString(raw, 'utf8'))
    } catch {
      throw new HttpError(400, 'JSON non valido')
    }
  }

  async _jsonObject (conn, req, rest) {
    const body = await this._jsonBody(conn, req, rest)
    if (body === GONE) return GONE
    if (!isObj(body)) throw new HttpError(400, 'Corpo della richiesta non valido')
    return body
  }

  async _route (conn, req, target, rest) {
    const q = target.indexOf('?')
    const p = q === -1 ? target : target.slice(0, q)
    const query = parseQuery(q === -1 ? '' : target.slice(q + 1))
    if (!p.startsWith('/api/')) throw new HttpError(404, NOT_FOUND)
    const seg = p.slice(5).split('/').map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        throw new HttpError(400, 'Percorso non valido')
      }
    })
    const method = req.method
    const [a, b, c] = seg
    const n = seg.length

    const playlistRoute = (n === 1 && method === 'POST') || (n === 2 && (method === 'PATCH' || method === 'DELETE')) ||
      (n === 3 && c === 'tracks' && (method === 'POST' || method === 'DELETE'))
    if (a === 'playlists' && playlistRoute) {
      if (n === 2 && method === 'DELETE') {
        await this.ready()
        this.deletePlaylist(b)
        return this._done({ ok: true })
      }
      const body = await this._jsonObject(conn, req, rest)
      if (body === GONE) return GONE
      await this.ready()
      if (n === 1) return this._done({ playlist: this.createPlaylist(body) })
      if (n === 2) return this._done({ playlist: this.updatePlaylist(b, body) })
      if (method === 'POST') return this._done({ playlist: this.addToPlaylist(b, body.trackIds, body.position) })
      return this._done({ playlist: this.removeFromPlaylist(b, body.indexes, body.ids, body.counts) })
    }
    if (n === 1 && a === 'likes' && method === 'POST') {
      let body
      try {
        body = await this._jsonBody(conn, req, rest)
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) throw badRequest()
        throw err
      }
      if (body === GONE) return GONE
      await this.ready()
      const done = this.bulkLikes(body)
      return this._done({ ok: true, added: done.added, removed: done.removed })
    }
    if (n === 2 && a === 'likes' && (method === 'PUT' || method === 'DELETE')) {
      await this.ready()
      if (method === 'PUT') this.like(b)
      else this.unlike(b)
      const headers = this._versionHeaders()
      if (query.get('brief') === '1') return { body: { ok: true }, headers }
      return this._likesAnswer(headers)
    }
    if (n === 1 && a === 'played' && method === 'POST') {
      const body = await this._jsonObject(conn, req, rest)
      if (body === GONE) return GONE
      await this.ready()
      this.played(body.trackId, body.context, body.at)
      return this._done({ ok: true })
    }
    if (n === 3 && a === 'cover-for' && b === 'playlist' && (method === 'PUT' || method === 'DELETE')) {
      await this.ready()
      if (method === 'PUT') {
        const size = query.has('size') ? query.get('size') : null
        if (!COVER_SIZES.includes(size)) throw new HttpError(400, 'Dimensione non valida')
        this.playlist(c)
        const data = await this._host.readBody(conn, req, rest, MAX_COVER_BODY)
        if (data === null) return GONE
        const coverId = this._saveCover(data)
        if (coverId === null) throw new HttpError(415, "L'immagine non e' un JPEG, PNG o WebP")
        this.setPlaylistCover(c, size, coverId)
      } else {
        this.playlist(c)
        this.clearPlaylistCover(c)
      }
      return this._done({ covers: { track: {}, album: {}, playlist: this.person.coversObject() } })
    }
    if (n === 1 && a === 'recents' && (method === 'GET' || method === 'HEAD')) {
      const before = wholeParam(query, 'before')
      const limit = wholeParam(query, 'limit')
      if (before === undefined || limit === undefined || limit === 0) throw badRequest()
      await this.ready()
      return { body: this.recentsPage(before, limit === null ? RECENTS_PAGE : Math.min(limit, MAX_RECENTS_PAGE)) }
    }
    throw new HttpError(404, NOT_FOUND)
  }

  // The whole likes list ({ likes }, newest first): in pieces of 5,000 when it is long.
  _likesAnswer (headers) {
    const l = this.person.likes
    if (l.live <= LIKES_SLICE) return { body: { likes: this.person.likesList() }, headers }
    // The list as it is now, walked later in pieces.
    const ids = l.ids.slice(0, l.n)
    const at = l.at.slice(0, l.n)
    return {
      headers,
      * pieces () {
        let parts = ['{"likes":[']
        let first = true
        for (let s = ids.length - 1, k = 0; s >= 0; s--) {
          if (Number.isNaN(at[s])) continue
          parts.push((first ? '{"id":"' : ',{"id":"') + ids[s] + '","at":' + num(at[s]) + '}')
          first = false
          if (++k % LIKES_SLICE === 0) {
            yield parts.join('')
            parts = []
          }
        }
        parts.push(']}')
        yield parts.join('')
      }
    }
  }
}

function fsyncOf (f, fd) {
  return new Promise((resolve, reject) => f.fsync(fd, (err) => (err ? reject(err) : resolve())))
}
