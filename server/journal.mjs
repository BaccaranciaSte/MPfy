// A map kept on disk as an append-only file of JSON lines, so a change costs one
// short write however big the map is:
//   {"schema":1}           the first line
//   ["<key>",<value>]      the key holds this value from here on
//   ["<key>"]              the key is gone
// The file is read once at start, line after line, into memory (the last line
// wins). A last line cut by a crash is dropped and the file cut back to its last
// whole line; a line that does not parse is skipped. Appends are not synced one by
// one: a crash of the process loses nothing, a power cut at most what the system
// had not written yet (whoever uses the map can ask it again).
//
// Every append is checked: a write that throws or writes fewer bytes than asked
// cuts the file back to its last whole line and the change is refused (507 on a
// full disk, 500 otherwise), nothing kept, so a line is never glued to half of
// another. When even the cut fails, the journal refuses every change until the
// process starts again. The file is opened read-write and written at its end
// (Windows refuses to cut back a file opened in append mode).
//
// Compaction: when the lines no longer live (replaced or deleted keys) outnumber
// the live ones (and are at least `minDead`), the file is written again with one
// line per live key, in the background: the lines go out in batches with an await
// between them, so the event loop never waits for the whole map. Changes made
// meanwhile go to the old file as usual and are kept; before the new file takes
// the old one's place they are written into it and synced, in rounds until little
// is left, and only that little is written in the last step (temporary file,
// rename, directory synced). So a power cut at any moment leaves a file that
// replays to the right map, without losing a change the old file had on disk. At
// start the bar is lower (dead lines a quarter of the live ones), so a file left
// long is cleaned when the source starts. So each line is copied a few times at
// most and the file stays within twice its live lines plus `minDead`.

import path from 'node:path'
import { HttpError } from './errors.mjs'
import { logError } from './util.mjs'
import { DEFAULT_IO, appendFailure, openReadWrite, writeAllSync, fsyncAsync, renameRetry } from './vjournal.mjs'

const READ_CHUNK = 1024 * 1024
const BATCH_LINES = 500
const KEPT_LEFT = 64 * 1024
const HEADER = '{"schema":1}\n'
export const MIN_DEAD = 64

export class Journal {
  /**
   * @param {string} file
   * @param {object} [opts]
   * @param {(key: string, value: any) => boolean} [opts.check]  a value read back that fails it is dropped
   * @param {number} [opts.minDead]  the fewest dead lines worth a rewrite
   * @param {number} [opts.batchLines]  lines per write while compacting
   * @param {object} [opts.io]  the file system calls (tests)
   */
  constructor (file, { check = () => true, minDead = MIN_DEAD, batchLines = BATCH_LINES, io = DEFAULT_IO } = {}) {
    this.file = file
    this.check = check
    this.minDead = minDead
    this.batchLines = batchLines
    this.io = io
    /** The live map (never to be changed but through set and delete). */
    this.map = new Map()
    /** Lines in the file after the header. */
    this.lines = 0
    /** Whole rewrites done (tests, health). */
    this.compactions = 0
    /** A cut back failed: every change is refused until the process starts again. */
    this.broken = false
    this._fd = null
    this._size = 0 // bytes of the whole lines in the file
    this._pending = null // lines appended while a compaction runs
    this._compacting = null
    this._closed = false
  }

  get size () {
    return this.map.size
  }

  get dead () {
    return this.lines - this.map.size
  }

  has (key) {
    return this.map.has(key)
  }

  get (key) {
    const v = this.map.get(key)
    return v === undefined ? null : v
  }

  /** Read the file into memory (once, at start); a compaction follows when it is due. */
  load () {
    const io = this.io
    let fd
    try {
      fd = io.openSync(this.file, 'r+')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      return this
    }
    let whole = 0 // the offset just after the last whole line
    try {
      const buf = Buffer.allocUnsafe(READ_CHUNK)
      let rest = Buffer.alloc(0)
      let pos = 0
      for (;;) {
        const n = io.readSync(fd, buf, 0, READ_CHUNK, pos)
        if (n === 0) break
        pos += n
        const data = rest.length > 0 ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n)
        let i = 0
        for (let nl = data.indexOf(10, i); nl !== -1; nl = data.indexOf(10, i)) {
          this._replay(data.toString('utf8', i, nl))
          whole += nl + 1 - i
          i = nl + 1
        }
        // The buffer is read into again: what is left is copied out of it.
        rest = Buffer.from(data.subarray(i))
      }
      if (rest.length > 0) {
        io.ftruncateSync(fd, whole)
        logError(path.basename(this.file) + ': a last line cut short dropped')
      }
    } finally {
      io.closeSync(fd)
    }
    if (this.dead >= this.minDead && this.dead * 4 > this.map.size) this._compactLater()
    return this
  }

  _replay (line) {
    if (line === '') return
    let v
    try {
      v = JSON.parse(line)
    } catch {
      this.lines++
      return
    }
    if (!Array.isArray(v)) return // the header
    this.lines++
    if (typeof v[0] !== 'string') return
    if (v.length === 1) this.map.delete(v[0])
    else if (v.length === 2 && this.check(v[0], v[1])) this.map.set(v[0], v[1])
    else this.map.delete(v[0])
  }

  _open () {
    if (this._fd !== null) return
    this._fd = openReadWrite(this.io, this.file)
    this._size = this.io.fstatSync(this._fd).size
    if (this._size === 0) this._write(Buffer.from(HEADER))
  }

  // One checked write at the end of the file: on a failure the file is cut back
  // and the error thrown (nothing of it stays).
  _write (buf) {
    if (this.broken) throw new HttpError(500, 'Errore interno del server')
    try {
      writeAllSync(this.io, this._fd, buf, this._size)
    } catch (err) {
      try {
        this.io.ftruncateSync(this._fd, this._size)
      } catch (cut) {
        this.broken = true
        logError(path.basename(this.file) + ': cannot cut back after a failed write (' + (cut.code || cut.message) + '), no more changes until a restart')
      }
      logError(path.basename(this.file) + ': append refused (' + (err.code || err.message) + ')')
      throw appendFailure(err)
    }
    this._size += buf.length
  }

  _append (line) {
    if (this._closed) throw new Error(path.basename(this.file) + ' is closed')
    this._open()
    const buf = Buffer.from(line)
    this._write(buf)
    this.lines++
    if (this._pending !== null) this._pending.push(buf)
  }

  /** The key holds `value` from now on (written before it is kept; a refused write keeps nothing). */
  set (key, value) {
    this._append(JSON.stringify([key, value]) + '\n')
    this.map.set(key, value)
    this._maybeCompact()
  }

  /** The key goes (nothing is written when it was not there). */
  delete (key) {
    if (!this.map.has(key)) return false
    this._append(JSON.stringify([key]) + '\n')
    this.map.delete(key)
    this._maybeCompact()
    return true
  }

  _maybeCompact () {
    if (this._compacting === null && this.dead >= this.minDead && this.dead > this.map.size) this._compactLater()
  }

  _compactLater () {
    if (this._compacting !== null || this._closed) return
    this._compacting = this._compact()
      .catch((err) => logError(path.basename(this.file) + ' not rewritten: ' + err.message))
      .finally(() => { this._compacting = null })
  }

  /** Resolves when no compaction runs (tests, close). */
  settled () {
    return this._compacting === null ? Promise.resolve() : this._compacting
  }

  async _compact () {
    const io = this.io
    const tmp = this.file + '.tmp'
    this._pending = []
    let fd = null
    let written = 0
    let pos = 0
    let given = false
    try {
      fd = io.openSync(tmp, 'w', 0o600)
      pos = writeAllSync(io, fd, Buffer.from(HEADER), pos)
      let batch = []
      // A live walk: a key changed after it was written is in _pending and comes
      // again after; a key deleted before it is reached is never written.
      for (const [key, value] of this.map) {
        batch.push(JSON.stringify([key, value]))
        if (batch.length >= this.batchLines) {
          pos = writeAllSync(io, fd, Buffer.from(batch.join('\n') + '\n'), pos)
          written += batch.length
          batch = []
          await new Promise((resolve) => setImmediate(resolve))
          if (this._closed) break
        }
      }
      if (batch.length > 0 && !this._closed) {
        pos = writeAllSync(io, fd, Buffer.from(batch.join('\n') + '\n'), pos)
        written += batch.length
      }
      await fsyncAsync(io, fd)
      // The lines appended meanwhile, synced in rounds until little is left: the
      // old file may have them on disk already, so the new one takes its place
      // only once it has them on disk too.
      while (!this._closed) {
        const lines = this._pending
        this._pending = []
        for (const buf of lines) pos = writeAllSync(io, fd, buf, pos)
        written += lines.length
        await fsyncAsync(io, fd)
        if (bytesOf(this._pending) < KEPT_LEFT) break
      }
      if (this._closed) {
        given = true
        return
      }
      // From here to the end nothing awaits: no append can come in between.
      const rest = this._pending
      this._pending = null
      for (const buf of rest) pos = writeAllSync(io, fd, buf, pos)
      written += rest.length
      io.closeSync(fd)
      fd = null
      this._closeFd({ sync: false })
      renameRetry(io, tmp, this.file)
      io.fsyncDirSync(path.dirname(this.file))
      this.lines = written
      this.compactions++
      this._open()
    } catch (err) {
      given = true
      throw err
    } finally {
      this._pending = null
      if (fd !== null) try { io.closeSync(fd) } catch {}
      if (given) try { io.unlinkSync(tmp) } catch {}
    }
  }

  _closeFd ({ sync = true } = {}) {
    if (this._fd === null) return
    if (sync) {
      try {
        this.io.fsyncSync(this._fd)
      } catch {}
    }
    try {
      this.io.closeSync(this._fd)
    } catch {}
    this._fd = null
  }

  /** Synced and closed; a compaction under way is given up (the old file stays whole). */
  close () {
    this._closed = true
    this._closeFd()
  }
}

function bytesOf (bufs) {
  let n = 0
  for (const b of bufs) n += b.length
  return n
}
