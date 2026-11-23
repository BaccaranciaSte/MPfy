// A loaded person's track ids, outside the V8 heap.
//
// IdTable: every 24-hex id the person's likes and playlist entries name, 12 bytes
// per index in one typed array, found through an open-addressing hash table
// (linear probing, at most half full) whose cell is chosen by a hash that mixes
// all twelve bytes with a seed drawn per table: ids come from clients as any 24
// hex, so ids sharing their first bytes must spread as well as random ones. An
// index never moves and is never freed while the table lives: the likes and the
// playlists hold indexes, small integers, instead of strings. The next load of
// the person builds a fresh table with only the ids still in use.
//
// Likes: the person's likes by slot, oldest first: the id's index, the time and
// the version of the like (lv) in typed arrays, a hole (time NaN) where an unlike
// left one, and slotOf, by id index, the slot + 1 of a liked id (0 when not
// liked). A like appends a slot and takes the newest version, so lv never
// decreases along the slots and "the likes added since version u" is a binary
// search. Holes are dropped by a repack (order kept) when they outnumber the
// live likes, never while a walk over the slots is under way.

import crypto from 'node:crypto'

const HEX_RE = /^[0-9a-f]{24}$/
const MIN_CAP = 64
const TWO_32 = 4294967296

export class IdTable {
  /** @param {number} [capacity]  ids the table holds before it grows */
  constructor (capacity = MIN_CAP) {
    this.n = 0
    this.seed = crypto.randomBytes(4).readUInt32LE(0)
    this._words = null
    this._bytes = null
    this._scratch = new Uint32Array(3)
    this._scratchBytes = Buffer.from(this._scratch.buffer)
    this._alloc(Math.max(MIN_CAP, Math.ceil(capacity)))
  }

  get cap () {
    return this._cap
  }

  _alloc (cap) {
    const words = new Uint32Array(cap * 3)
    if (this._words !== null) words.set(this._words.subarray(0, this.n * 3))
    this._words = words
    this._bytes = Buffer.from(words.buffer, words.byteOffset, words.byteLength)
    this._cap = cap
    // Twice the ids, not rounded to a power of two: the cell comes from a
    // multiply by the size, not from a mask.
    this._hcap = cap * 2
    this._scale = this._hcap / TWO_32
    this.hash = new Int32Array(this._hcap)
    for (let i = 0; i < this.n; i++) this._place(i)
  }

  // A 32-bit hash of the three words of an id, every bit of each one mixed in.
  _mix (a, b, c) {
    let h = this.seed ^ 0x9e3779b9
    h = Math.imul(h ^ a, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h ^ b, 0xc2b2ae35)
    h ^= h >>> 16
    h = Math.imul(h ^ c, 0x27d4eb2f)
    h ^= h >>> 15
    h = Math.imul(h, 0x165667b1)
    h ^= h >>> 16
    return h >>> 0
  }

  _cell (h) {
    const c = Math.floor(h * this._scale)
    return c < this._hcap ? c : this._hcap - 1
  }

  _place (i) {
    const w = this._words
    const k = i * 3
    let c = this._cell(this._mix(w[k], w[k + 1], w[k + 2]))
    while (this.hash[c] !== 0) if (++c === this._hcap) c = 0
    this.hash[c] = i + 1
  }

  // The scratch words hold the id; its index, or -1.
  _lookup () {
    const s = this._scratch
    const a = s[0]
    const b = s[1]
    const d = s[2]
    const w = this._words
    let c = this._cell(this._mix(a, b, d))
    for (;;) {
      const e = this.hash[c]
      if (e === 0) return -1
      const k = (e - 1) * 3
      if (w[k] === a && w[k + 1] === b && w[k + 2] === d) return e - 1
      if (++c === this._hcap) c = 0
    }
  }

  _load (hex) {
    if (typeof hex !== 'string' || !HEX_RE.test(hex)) throw new TypeError('not a 24-hex id')
    this._scratchBytes.write(hex, 0, 12, 'hex')
  }

  /** The index of a 24-hex id, or -1 when the table does not hold it. */
  find (hex) {
    this._load(hex)
    return this._lookup()
  }

  /** The index of a 24-hex id, added when new. */
  intern (hex) {
    this._load(hex)
    const found = this._lookup()
    if (found !== -1) return found
    if (this.n === this._cap) this._alloc(this._cap * 2)
    const i = this.n++
    const k = i * 3
    this._words[k] = this._scratch[0]
    this._words[k + 1] = this._scratch[1]
    this._words[k + 2] = this._scratch[2]
    this._place(i)
    return i
  }

  /** The 24-hex id of an index. */
  hex (i) {
    return this._bytes.toString('hex', i * 12, i * 12 + 12)
  }

  /** Bytes held outside the heap. */
  get bytes () {
    return this._words.byteLength + this.hash.byteLength
  }
}

export class Likes {
  /**
   * @param {IdTable} table
   * @param {number} [capacity]  slots before the arrays grow
   */
  constructor (table, capacity = MIN_CAP) {
    this.table = table
    this.n = 0 // slots used, holes included
    this.live = 0
    const cap = Math.max(MIN_CAP, Math.ceil(capacity))
    this.idx = new Int32Array(cap)
    this.at = new Float64Array(cap)
    this.lv = new Float64Array(cap)
    this.slotOf = new Int32Array(Math.max(MIN_CAP, table.cap))
    // Walks over the slots under way (a snapshot, a list written in slices): no repack meanwhile.
    this.walkers = 0
  }

  _growSlots () {
    const cap = this.idx.length * 2
    const idx = new Int32Array(cap)
    idx.set(this.idx)
    this.idx = idx
    const at = new Float64Array(cap)
    at.set(this.at)
    this.at = at
    const lv = new Float64Array(cap)
    lv.set(this.lv)
    this.lv = lv
  }

  _slotOf (i) {
    if (i >= this.slotOf.length) {
      let cap = this.slotOf.length
      while (cap <= i) cap *= 2
      const s = new Int32Array(cap)
      s.set(this.slotOf)
      this.slotOf = s
    }
    return this.slotOf[i]
  }

  /** Whether the id of this index is liked. */
  has (i) {
    return i >= 0 && this._slotOf(i) !== 0
  }

  /** The time of the like of this index, or null. */
  atOf (i) {
    if (i < 0) return null
    const s = this._slotOf(i)
    return s === 0 ? null : this.at[s - 1]
  }

  /** The version of the like of this index, or null. */
  lvOf (i) {
    if (i < 0) return null
    const s = this._slotOf(i)
    return s === 0 ? null : this.lv[s - 1]
  }

  /** Like (the newest). False when it was liked already. */
  add (i, at, v) {
    if (this._slotOf(i) !== 0) return false
    if (this.n === this.idx.length) this._growSlots()
    const s = this.n++
    this.idx[s] = i
    this.at[s] = at
    this.lv[s] = v
    this.slotOf[i] = s + 1
    this.live++
    return true
  }

  /** Unlike: the slot becomes a hole. False when it was not liked. */
  remove (i) {
    if (i < 0 || this._slotOf(i) === 0) return false
    const s = this.slotOf[i] - 1
    this.slotOf[i] = 0
    this.at[s] = NaN
    this.live--
    if (this.walkers === 0 && this.n - this.live > Math.max(4096, this.live)) this.repack()
    return true
  }

  /** The holes dropped, the order kept. */
  repack () {
    let k = 0
    for (let s = 0; s < this.n; s++) {
      if (Number.isNaN(this.at[s])) continue
      if (k !== s) {
        this.idx[k] = this.idx[s]
        this.at[k] = this.at[s]
        this.lv[k] = this.lv[s]
      }
      this.slotOf[this.idx[k]] = k + 1
      k++
    }
    this.n = k
  }

  /** The first slot whose version is above u (lv never decreases along the slots). */
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

  /** Every live like replaced by these, oldest first (a merge): idx, at, one version. */
  replaceAll (idx, at, v) {
    const n = idx.length
    this.slotOf.fill(0)
    let cap = MIN_CAP
    while (cap < Math.ceil(n * 1.125)) cap *= 2
    this.idx = new Int32Array(cap)
    this.at = new Float64Array(cap)
    this.lv = new Float64Array(cap)
    this.n = 0
    this.live = 0
    for (let k = 0; k < n; k++) this.add(idx[k], at[k], v)
  }

  /** Bytes held outside the heap. */
  get bytes () {
    return this.idx.byteLength + this.at.byteLength + this.lv.byteLength + this.slotOf.byteLength
  }
}
