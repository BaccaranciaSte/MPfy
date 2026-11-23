// Chromaprint fingerprints (fpcalc), kept on the source to recognize the same
// recording in another file.
//
// fpcalc -json -raw -length 120 gives one u32 item every 0.12381 s over the first
// 120 s. Two fingerprints are compared by their bit error rate at the best
// offset: BER(k) = sum(popcount(A[i] xor B[i+k])) / (32 n) over the n pairs where
// both exist, the best k being the lowest BER among offsets with n >= minPairs.
//
// fingerprints/<fileHash>.fp: "MPFP", u32 LE version 1, f64 LE duration (s, two
// decimals), then the raw items as u32 LE. An in-memory index keeps the tracks
// with a fingerprint sorted by duration, as two typed arrays outside the heap (the
// durations, and the slots by which the library finds each track and its file
// hash); items are read only for candidates.

import fs from 'node:fs'
import path from 'node:path'
import { ToolRunner } from './tools.mjs'
import { isTrackId, FINGERPRINT_FILE_RE } from './ids.mjs'
import { ensureDir, writeAtomicSync, unlinkQuiet, Limiter } from './util.mjs'

export const STEP = 0.12381
export const FPCALC_TIMEOUT = 120000
const MIN_ITEMS = 16
const MAGIC = Buffer.from('MPFP', 'latin1')
const HEADER = 16

// Matching an upload against the library.
export const MATCH = {
  window: 3, // s, candidates
  offsets: 10, // k in -10..10
  sameBer: 0.10,
  sameDuration: 1.5,
  maybeBer: 0.18,
  maybeDuration: 3,
  tailOffsets: 24 // -24..24 for the last 120 s
}

// ------------------------------------------------------------------- BER

export function popcount32 (x) {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

export function minPairsOf (a, b, cap = 80) {
  return Math.min(cap, Math.floor(0.8 * Math.min(a.length, b.length)))
}

/** BER of A[i] against B[i + k]; { ber, n } (ber 1 when there are no pairs). */
export function berAt (a, b, k) {
  const from = Math.max(0, -k)
  const to = Math.min(a.length, b.length - k)
  let bits = 0
  let n = 0
  for (let i = from; i < to; i++) {
    bits += popcount32((a[i] ^ b[i + k]) >>> 0)
    n++
  }
  return { ber: n === 0 ? 1 : bits / (32 * n), n }
}

/** The best offset in -range..range with at least minPairs pairs: { ber, k, n } or null. */
export function bestOffset (a, b, range, minPairs = minPairsOf(a, b)) {
  let best = null
  for (let k = -range; k <= range; k++) {
    const r = berAt(a, b, k)
    if (r.n < minPairs || r.n === 0) continue
    if (best === null || r.ber < best.ber) best = { ber: r.ber, k, n: r.n }
  }
  return best
}

/**
 * Classify a pair: 'same', 'maybe' or null (different).
 * @param {number} ber
 * @param {number} durationDiff  absolute, seconds
 */
export function classify (ber, durationDiff) {
  if (ber <= MATCH.sameBer && durationDiff <= MATCH.sameDuration) return 'same'
  if (ber <= MATCH.maybeBer && durationDiff <= MATCH.maybeDuration) return 'maybe'
  return null
}

// --------------------------------------------------------------- fpcalc

/**
 * fpcalc's -json output: { duration (two decimals), items (u32) } or null when
 * it is not usable (bad JSON, no fingerprint, fewer than 16 items).
 */
export function parseFpcalc (stdout) {
  let data
  try {
    data = JSON.parse(String(stdout))
  } catch {
    return null
  }
  if (!data || !Array.isArray(data.fingerprint) || data.fingerprint.length < MIN_ITEMS) return null
  if (typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration <= 0) return null
  const items = new Uint32Array(data.fingerprint.length)
  for (let i = 0; i < items.length; i++) {
    const n = data.fingerprint[i]
    if (typeof n !== 'number' || !Number.isInteger(n)) return null
    items[i] = n >>> 0
  }
  return { duration: Math.round(data.duration * 100) / 100, items }
}

// ------------------------------------------------------------ signature

/** The app's signature: 64 consecutive raw items from about 4 s in. */
export function signatureOf (items, duration) {
  const b = Math.min(32, Math.max(0, items.length - 64))
  const n = Math.min(64, items.length - b)
  const buf = Buffer.alloc(n * 4)
  for (let j = 0; j < n; j++) buf.writeUInt32LE(items[b + j] >>> 0, j * 4)
  return { d: Math.round(duration * 10) / 10, b, s: buf.toString('base64') }
}

export function packItems (items) {
  const buf = Buffer.alloc(items.length * 4)
  for (let i = 0; i < items.length; i++) buf.writeUInt32LE(items[i] >>> 0, i * 4)
  return buf
}

export function unpackItems (buf) {
  const n = Math.floor(buf.length / 4)
  const items = new Uint32Array(n)
  for (let i = 0; i < n; i++) items[i] = buf.readUInt32LE(i * 4)
  return items
}

// ----------------------------------------------------------------- store

export class Fingerprints {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string|null} [opts.command='fpcalc']  null: no fpcalc
   * @param {object|null} [opts.library]  resolves the slots of the index (slotOf, trackAt);
   *   without it the index keeps its own
   */
  constructor ({ dataDir, command = 'fpcalc', nice, library = null } = {}) {
    this.dir = path.join(path.resolve(dataDir), 'fingerprints')
    this.runner = command ? new ToolRunner({ command, label: 'fpcalc', ...(nice === undefined ? {} : { nice }) }) : null
    this.available = false
    this.limiter = new Limiter(2) // fpcalc on the upload path: 2 at a time
    this.library = library
    // The index, sorted by duration: _dur[i] and _slot[i] for i < _n.
    this._dur = new Float64Array(0)
    this._slot = new Int32Array(0)
    this._n = 0
    // The duration each slot is indexed under (NaN: not in the index), so an entry
    // is found by a binary search.
    this._durOf = new Float64Array(0)
    // Without a library: its own slots (trackId and fileHash by slot).
    this._own = library === null ? { ids: [], hashes: [], byId: new Map(), free: [] } : null
  }

  // The slot of a track, or -1.
  _slotOf (trackId) {
    if (this._own === null) return this.library.slotOf(trackId)
    const s = this._own.byId.get(trackId)
    return s === undefined ? -1 : s
  }

  // { trackId, fileHash } at a slot, or null when no track holds it.
  _at (slot) {
    if (this._own === null) {
      const t = this.library.trackAt(slot)
      return t === null ? null : { trackId: t.id, fileHash: t.fileHash }
    }
    const id = this._own.ids[slot]
    return id === undefined ? null : { trackId: id, fileHash: this._own.hashes[slot] }
  }

  _grow (need) {
    if (need <= this._dur.length) return
    const cap = Math.max(64, Math.ceil(need * 1.25))
    const dur = new Float64Array(cap)
    dur.set(this._dur.subarray(0, this._n))
    const slot = new Int32Array(cap)
    slot.set(this._slot.subarray(0, this._n))
    this._dur = dur
    this._slot = slot
  }

  _durSlots (slot) {
    if (slot < this._durOf.length) return
    const a = new Float64Array(Math.max(64, Math.ceil((slot + 1) * 1.25))).fill(NaN)
    a.set(this._durOf)
    this._durOf = a
  }

  // The first index entry whose duration is not below `d`.
  _lowerBound (d) {
    let lo = 0
    let hi = this._n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this._dur[mid] < d) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // Take a slot's entry out of the index (a binary search and a memory move).
  _removeSlot (slot) {
    if (slot >= this._durOf.length || Number.isNaN(this._durOf[slot])) return false
    const d = this._durOf[slot]
    this._durOf[slot] = NaN
    for (let i = this._lowerBound(d); i < this._n && this._dur[i] === d; i++) {
      if (this._slot[i] !== slot) continue
      this._dur.copyWithin(i, i + 1, this._n)
      this._slot.copyWithin(i, i + 1, this._n)
      this._n--
      return true
    }
    return false
  }

  /** `fpcalc -version` exits 0? */
  async probe () {
    if (this.runner === null) return false
    try {
      await this.runner.run(['-version'], { timeoutMs: 15000, lowPriority: false, quiet: true })
      this.available = true
    } catch {
      this.available = false
    }
    return this.available
  }

  file (fileHash) {
    if (!isTrackId(fileHash)) throw new Error('invalid file hash')
    return path.join(this.dir, fileHash + '.fp')
  }

  /** Build the index from the tracks with a stored fingerprint; drop orphan files. */
  load (tracks) {
    ensureDir(this.dir)
    const wanted = new Map()
    for (const t of tracks) if (t.fpState === 'ok') wanted.set(t.fileHash, t)
    const durs = []
    const slots = []
    const missing = []
    this._n = 0
    this._durOf.fill(NaN)
    if (this._own !== null) this._own = { ids: [], hashes: [], byId: new Map(), free: [] }
    for (const name of fs.readdirSync(this.dir)) {
      const m = FINGERPRINT_FILE_RE.exec(name)
      if (m === null) {
        if (name.endsWith('.tmp')) unlinkQuiet(path.join(this.dir, name))
        continue
      }
      const t = wanted.get(m[1])
      if (!t) {
        unlinkQuiet(path.join(this.dir, name))
        continue
      }
      const duration = this.readDuration(m[1])
      if (duration === null || !Number.isFinite(duration)) continue
      const slot = this._own === null ? this._slotOf(t.id) : this._ownSlot(t.id, m[1])
      if (slot === -1) continue
      durs.push(duration)
      slots.push(slot)
      wanted.delete(m[1])
    }
    for (const t of wanted.values()) missing.push(t)
    // By duration; equal durations keep the order they were found in.
    const order = durs.map((_, i) => i).sort((a, b) => durs[a] - durs[b])
    this._grow(order.length)
    for (let i = 0; i < order.length; i++) {
      this._dur[i] = durs[order[i]]
      this._slot[i] = slots[order[i]]
      this._durSlots(slots[order[i]])
      this._durOf[slots[order[i]]] = durs[order[i]]
    }
    this._n = order.length
    return missing // tracks whose fingerprint file is gone: computed again
  }

  // Without a library: the slot of a track id, taken when it has none.
  _ownSlot (trackId, fileHash) {
    const own = this._own
    let s = own.byId.get(trackId)
    if (s === undefined) {
      s = own.free.length > 0 ? own.free.pop() : own.ids.length
      own.byId.set(trackId, s)
      own.ids[s] = trackId
    }
    own.hashes[s] = fileHash
    return s
  }

  /** Run fpcalc on a file: { duration, items } or null. */
  async compute (file, { timeoutMs = FPCALC_TIMEOUT } = {}) {
    if (!this.available || this.runner === null) return null
    try {
      const { stdout } = await this.runner.run(['-json', '-raw', '-length', '120', file], { timeoutMs, stdout: true, quiet: true })
      return parseFpcalc(stdout)
    } catch {
      return null
    }
  }

  save (fileHash, fp) {
    ensureDir(this.dir)
    const head = Buffer.alloc(HEADER)
    MAGIC.copy(head, 0)
    head.writeUInt32LE(1, 4)
    head.writeDoubleLE(fp.duration, 8)
    writeAtomicSync(this.file(fileHash), Buffer.concat([head, packItems(fp.items)]), 0o600)
  }

  read (fileHash) {
    let data
    try {
      data = fs.readFileSync(this.file(fileHash))
    } catch {
      return null
    }
    if (data.length < HEADER || !data.subarray(0, 4).equals(MAGIC) || data.readUInt32LE(4) !== 1) return null
    return { duration: data.readDoubleLE(8), items: unpackItems(data.subarray(HEADER)) }
  }

  readDuration (fileHash) {
    let fd = null
    try {
      fd = fs.openSync(this.file(fileHash), 'r')
      const head = Buffer.alloc(HEADER)
      if (fs.readSync(fd, head, 0, HEADER, 0) < HEADER) return null
      if (!head.subarray(0, 4).equals(MAGIC) || head.readUInt32LE(4) !== 1) return null
      return head.readDoubleLE(8)
    } catch {
      return null
    } finally {
      if (fd !== null) try { fs.closeSync(fd) } catch {}
    }
  }

  remove (fileHash) {
    if (isTrackId(fileHash)) unlinkQuiet(this.file(fileHash))
  }

  /** The track's fingerprint is in the index (its file hash read from the track). */
  indexAdd (trackId, fileHash, duration) {
    let slot = this._slotOf(trackId)
    if (this._own !== null) slot = this._ownSlot(trackId, fileHash)
    if (slot === -1 || !Number.isFinite(duration)) return // not a track of the library (any more)
    this._removeSlot(slot)
    // After the entries of the same duration (a binary search for the first longer one).
    let lo = 0
    let hi = this._n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this._dur[mid] <= duration) lo = mid + 1
      else hi = mid
    }
    this._grow(this._n + 1)
    this._dur.copyWithin(lo + 1, lo, this._n)
    this._slot.copyWithin(lo + 1, lo, this._n)
    this._dur[lo] = duration
    this._slot[lo] = slot
    this._durSlots(slot)
    this._durOf[slot] = duration
    this._n++
  }

  indexRemove (trackId) {
    const slot = this._slotOf(trackId)
    if (slot === -1) return
    this._removeSlot(slot)
    if (this._own !== null) {
      this._own.byId.delete(trackId)
      this._own.ids[slot] = undefined
      this._own.hashes[slot] = undefined
      this._own.free.push(slot)
    }
  }

  /** No track holds this slot any more (the library freed it): its entry goes. */
  dropSlot (slot) {
    this._removeSlot(slot)
  }

  get size () {
    return this._n
  }

  /** Index entries within `window` seconds of `duration`: { trackId, fileHash, duration }. */
  candidates (duration, window = MATCH.window) {
    const out = []
    // Binary search for the first entry >= duration - window.
    const lo = this._lowerBound(duration - window)
    for (let i = lo; i < this._n && this._dur[i] <= duration + window; i++) {
      const e = this._at(this._slot[i])
      if (e !== null) out.push({ trackId: e.trackId, fileHash: e.fileHash, duration: this._dur[i] })
    }
    return out
  }

  /**
   * The best match of an upload's fingerprint among the library:
   * { kind: 'same'|'maybe', trackId, ber, durationDiff } or null.
   * `isExcluded(trackId)` drops pairs the uploaders said are different songs.
   */
  match (fp, isExcluded = () => false) {
    let same = null
    let maybe = null
    for (const c of this.candidates(fp.duration)) {
      if (isExcluded(c.trackId)) continue
      const stored = this.read(c.fileHash)
      if (stored === null) continue
      const best = bestOffset(fp.items, stored.items, MATCH.offsets)
      if (best === null) continue
      const durationDiff = Math.abs(stored.duration - fp.duration)
      const kind = classify(best.ber, durationDiff)
      if (kind === 'same' && (same === null || best.ber < same.ber)) same = { kind, trackId: c.trackId, ber: best.ber, durationDiff }
      if (kind === 'maybe' && (maybe === null || best.ber < maybe.ber)) maybe = { kind, trackId: c.trackId, ber: best.ber, durationDiff }
    }
    return same || maybe
  }
}
