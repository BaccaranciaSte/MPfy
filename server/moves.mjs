// The originals carried onto the memory card the owner chose, and back when the
// owner stops using it: one file per step of the jobs' `move` job (jobs.mjs),
// which steps aside for any job of a higher priority. A file crosses only by a
// copy (places.copy: a .part, flushed every 4 MiB, synced, read back from the
// card past the page cache, renamed), then the old copy goes. Nothing is
// written to the library log: where a file is is not part of a track.
//
// Moving in: every internal original, oldest first, once no job of its track
// waits (its transcodes, fingerprint, quality and tags are made from internal
// memory: no tool ever opens a card file), while the card has room above its
// floor. Moving out (leaving): every original on the card, then the spilled
// transcodes (moved while internal memory has room, else deleted: a cache);
// when nothing of ours is left on the card, its folders and marker go and the
// card is no longer used. While a card stream plays, the move waits.

import { CODE } from './places.mjs'
import { trackFileName } from './ids.mjs'
import { log, logError } from './util.mjs'

export class Moves {
  /**
   * @param {object} opts
   * @param {import('./library.mjs').Library} opts.library
   * @param {import('./jobs.mjs').MediaJobs} opts.jobs
   */
  constructor ({ library, jobs }) {
    this.library = library
    this.places = library.places
    this.jobs = jobs
    this._pass = null
    this.dirty = false // a track was skipped (its jobs not done yet), or a new one came
    this.failures = 0
    jobs.moves = this
  }

  /** { done, total } while a pass runs, else null (the owner's row). */
  get progress () {
    const p = this._pass
    return p === null ? null : { done: p.done, total: p.total }
  }

  /** Queue a step when the card is in use and there may be work. */
  kick () {
    const card = this.places.card
    if (card === null || card.invalid || !card.ready || card.bad) return
    card.full = false
    this.jobs.requestMove()
  }

  /** A new original came (an upload): it moves once its jobs are done. */
  note () {
    this.dirty = true
  }

  /** The jobs' queue drained: a step if tracks were left for later. */
  drained () {
    if (!this.dirty) return
    this.dirty = false
    this.kick()
  }

  /**
   * One file moved. Resolves 'more' (queue again), 'done' (nothing to do now)
   * or 'wait' (a card stream plays: again in a while).
   */
  async step ({ signal, current }) {
    const card = this.places.card
    if (card === null || card.invalid || !card.ready) {
      this._pass = null
      return 'done'
    }
    if (this.places.cardStreamRecently()) return 'wait'
    if (card.leaving) return this._out(card, { signal, current })
    if (card.bad || card.full) {
      this._pass = null
      return 'done'
    }
    return this._in(card, { signal, current })
  }

  _passFor (dir, count) {
    if (this._pass === null || this._pass.dir !== dir) {
      let total = 0
      for (const t of this.library.tracks.values()) if (count(t)) total++
      this._pass = { dir, iter: this.library.tracks.values(), done: 0, total, skipped: 0 }
    }
    return this._pass
  }

  async _in (card, { signal, current }) {
    const internal = this.places.internal
    const lib = this.library
    const pass = this._passFor('in', (t) => lib.placeOfTrack(t) === internal)
    for (;;) {
      const r = pass.iter.next()
      if (r.done) {
        this._pass = null
        if (pass.skipped > 0) this.dirty = true
        if (pass.done > 0) log('memory card: ' + pass.done + ' original(s) moved onto it')
        return 'done'
      }
      const t = r.value
      if (lib.getTrack(t.id) !== t || lib.placeOfTrack(t) !== internal) continue
      // Its transcodes and fingerprint are made from internal memory first.
      if (this.jobs.hasWorkFor(t.id)) {
        pass.skipped++
        continue
      }
      if (!(await this.places.hasRoom(card, t.size))) {
        card.full = true
        this._pass = null
        log('memory card full: the new music stays in internal memory')
        return 'done'
      }
      const out = await this._carry(t, internal, card, { signal, current })
      if (out === 'stop') {
        this._pass = null
        return 'done'
      }
      if (out === 'moved') pass.done++
      return 'more'
    }
  }

  async _out (card, { signal, current }) {
    const internal = this.places.internal
    const lib = this.library
    const pass = this._passFor('out', (t) => lib.placeOfTrack(t) === card)
    for (;;) {
      const r = pass.iter.next()
      if (r.done) break
      const t = r.value
      if (lib.getTrack(t.id) !== t || lib.placeOfTrack(t) !== card) continue
      if (!(await this.places.hasRoom(internal, t.size))) {
        let need = 0
        for (const x of lib.tracks.values()) if (lib.placeOfTrack(x) === card) need += x.size
        this.places.blocked = { needBytes: need }
        this._pass = null
        logError('memory card: internal memory has no room for the music still on the card (' + need + ' bytes)')
        return 'done'
      }
      const out = await this._carry(t, card, internal, { signal, current })
      if (out === 'stop') {
        this._pass = null
        return 'done'
      }
      if (out === 'moved') pass.done++
      return 'more'
    }
    this.places.blocked = null
    // The originals are back: the spilled transcodes, then the card's end.
    for (const t of lib.tracks.values()) {
      if (lib.placeOfTrack(t) === card) {
        this._pass = null
        return 'more'
      }
    }
    const key = this.jobs.cardTranscodeKey()
    if (key !== null) {
      await this.jobs.transcodeOut(key, { signal })
      return 'more'
    }
    this._pass = null
    if (await this.places.finishLeave()) {
      lib.setCardInUse(null)
      log('memory card: the music is back in internal memory, the card is no longer used')
    }
    return 'done'
  }

  // One original from `from` to `to`: 'moved', 'skipped' (it changed, or the
  // copy failed: a later pass sees it again), or 'stop' (the card went away or
  // does not keep what is written).
  async _carry (t, from, to, { signal, current }) {
    const lib = this.library
    const name = trackFileName(t)
    const src = from.libraryPath(name)
    const rel = 'library/' + t.id.slice(0, 2) + '/' + name
    // The commit reads the track again: still the same file, still where it was.
    const still = () => {
      const now = lib.getTrack(t.id)
      return !signal.aborted && now !== null && now.fileHash === t.fileHash && now.size === t.size && lib.placeOfTrack(now) === from
    }
    current(t.id)
    try {
      await this.places.copy(src, from, to, rel, { expectHash: t.fileHash, size: t.size, signal, beforeCommit: still })
    } catch (err) {
      if (err.code === 'ECARDBAD' || err.code === 'ECARDAWAY' || err.code === 'ETIMEDOUT' || (to.kind === 'card' && !to.ready) || (from.kind === 'card' && !from.ready)) return 'stop'
      if (err.code !== 'ABORT_ERR' && err.code !== 'ESTALE_COPY') {
        this.failures++
        logError('memory card: ' + name + ' not moved: ' + err.message)
      }
      return 'skipped'
    }
    if (!still()) {
      // Changed while the copy was being named (a deletion or a replacement
      // waits for this job): the new copy goes, the track is left as it is now.
      const dest = to.libraryPath(name)
      if (to.kind === 'card') await this.places.remove(to, dest)
      else this.places.remove(to, dest)
      return 'skipped'
    }
    lib.setPlace(t.id, to)
    if (from.kind === 'card') await this.places.remove(from, src)
    else this.places.remove(from, src)
    return 'moved'
  }
}
