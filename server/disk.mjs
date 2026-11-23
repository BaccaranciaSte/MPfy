// Disk room: one rule for every write path. A write is refused (507 disk_full)
// when free - reserved - needed < floor, where `reserved` is what unfinished
// upload sessions still have to send, the listed totals of archives being
// extracted and what single uploads streaming now still have to send, and the floor is MPFY_MIN_FREE_BYTES, by default the larger of 2 GiB
// and 5% of the volume (on the Mi A2 the data dir shares Android's own /data).
// Background jobs (transcodes, cover sizes, fingerprints) wait while
// free - reserved < floor.

import fs from 'node:fs'
import { apiError } from './errors.mjs'

const GIB = 1024 ** 3

export class Disk {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {number|null} [opts.minFreeBytes]  null: max(2 GiB, 5% of the volume)
   * @param {(dir: string) => Promise<{ bavail, bsize, blocks }>} [opts.statfs]
   */
  constructor ({ dataDir, minFreeBytes = null, statfs = (dir) => fs.promises.statfs(dir), floorOf = defaultFloor, failClosed = false, onFail = () => {} }) {
    this.dataDir = dataDir
    this.minFreeBytes = minFreeBytes
    this.statfs = statfs
    // The floor of a volume of `total` bytes when no fixed one is set.
    this.floorOf = floorOf
    // A memory card: a failing statfs is no room (and a reason to look at the
    // card again), never "free: Infinity".
    this.failClosed = failClosed
    this.onFail = onFail
    this.reservers = [] // functions (excludeId) -> bytes
    this._holds = new Set()
  }

  /**
   * Bytes a write streaming now still has to make (update `bytes` as they
   * arrive): reserved for everyone else until released.
   */
  hold (bytes) {
    const h = { bytes, release: () => this._holds.delete(h) }
    this._holds.add(h)
    return h
  }

  addReserver (fn) {
    this.reservers.push(fn)
  }

  reserved (exclude = null) {
    let sum = 0
    for (const fn of this.reservers) sum += fn(exclude) || 0
    for (const h of this._holds) if (h !== exclude) sum += h.bytes
    return sum
  }

  /** { free, total, floor }; free Infinity when statfs is not available. */
  async state () {
    let st = null
    try {
      st = await this.statfs(this.dataDir)
    } catch (err) {
      if (this.failClosed) this.onFail(err)
    }
    if (!st) return { free: this.failClosed ? 0 : Infinity, total: null, floor: this.minFreeBytes || 0 }
    const free = st.bavail * st.bsize
    const total = st.blocks * st.bsize
    const floor = this.minFreeBytes !== null ? this.minFreeBytes : this.floorOf(total)
    return { free, total, floor }
  }

  /** Throw 507 disk_full unless `needed` more bytes fit. */
  async check (needed, exclude = null) {
    const { free, floor } = await this.state()
    if (free - this.reserved(exclude) - needed < floor) throw apiError('disk_full')
  }

  /** May background jobs write now? */
  async jobsMayWrite () {
    const { free, floor } = await this.state()
    return free - this.reserved() >= floor
  }
}

/** The floor for a volume of `total` bytes when MPFY_MIN_FREE_BYTES is not set. */
export function defaultFloor (total) {
  return Math.max(2 * GIB, Math.ceil(total * 0.05))
}

/** The floor of a memory card of `total` bytes when MPFY_CARD_MIN_FREE_BYTES is not set. */
export function cardFloor (total) {
  return Math.max(GIB, Math.ceil(total * 0.02))
}
