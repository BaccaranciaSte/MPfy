// The file layer of a log of versioned lines (library.log): an append-only file
// of JSON lines, one value per line, each ended by "\n".
//
// Appends are checked: a write that throws or writes fewer bytes than asked cuts
// the file back to its last whole line, so a line is never glued to half of
// another, and the caller refuses the change (507 on a full disk, 500 otherwise).
// When even the cut fails the log is broken: every later append is refused until
// the process starts again (the replay then drops the half line). The file is
// opened read-write and every write lands at its end: Windows refuses to cut back
// a file opened in append mode.
//
// The data reaches the disk in the background: after an append one fdatasync is
// scheduled, at most one in flight and at most one every 500 ms, and nothing
// waits for it. A crash of the process loses nothing (the bytes are in the page
// cache before the answer leaves); a power cut at most about the last 500 ms.
//
// A replay reads the file in chunks of 1 MB and hands each whole line to the
// caller. A last line without "\n" is dropped and the file cut back to its last
// whole line. The first line the caller does not trust (it does not parse, its
// version is out of sequence, it is longer than 64 MB) ends the file: what
// follows is copied to <file>.cut-<ms>, the file is cut there, and the event is
// logged. Nothing is thrown.
//
// Epochs: every run of the process that changes a log opens an epoch, a random
// 16-hex id with the closed range of versions written under it. A version is
// known only inside the range of its own epoch and at or above the horizon.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { HttpError, apiError } from './errors.mjs'
import { fsyncDirSync, logError } from './util.mjs'

export const ZERO_EPOCH = '0000000000000000'
export const MAX_LINE = 64 * 1024 * 1024
export const SYNC_EVERY_MS = 500
export const KEEP_EPOCHS = 64
const READ_CHUNK = 1024 * 1024
const YIELD_MS = 8
const EPOCH_RE = /^[0-9a-f]{16}$/

/** The file system calls the logs use (tests put a layer of their own in between). */
export const DEFAULT_IO = Object.freeze({
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  readSync: fs.readSync,
  writeSync: fs.writeSync,
  ftruncateSync: fs.ftruncateSync,
  fstatSync: fs.fstatSync,
  statSync: fs.statSync,
  fsyncSync: fs.fsyncSync,
  fdatasyncSync: fs.fdatasyncSync,
  fsync: fs.fsync,
  fdatasync: fs.fdatasync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  fsyncDirSync
})

const RW_CREATE = fs.constants.O_RDWR | fs.constants.O_CREAT

/** A random epoch id; never the zero epoch, which no log uses. */
export function newEpochId () {
  for (;;) {
    const id = crypto.randomBytes(8).toString('hex')
    if (id !== ZERO_EPOCH) return id
  }
}

export function isEpochId (v) {
  return typeof v === 'string' && EPOCH_RE.test(v)
}

/** The error a refused append answers: 507 for a full disk, 500 otherwise. */
export function appendFailure (err) {
  if (err && err.code === 'ENOSPC') return apiError('disk_full')
  return new HttpError(500, 'Errore interno del server')
}

function isBusy (err) {
  return !!err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))

/** A rename that tries again for a moment when Windows holds the target. */
export function renameRetry (io, from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      io.renameSync(from, to)
      return
    } catch (err) {
      if (attempt >= 6 || !isBusy(err)) throw err
      Atomics.wait(sleeper, 0, 0, 25 * (attempt + 1))
    }
  }
}

/** Open a file read-write, created when missing. */
export function openReadWrite (io, file, mode = 0o600) {
  return io.openSync(file, RW_CREATE, mode)
}

/** Write all of `buf` at `pos`; a short write is an error (the caller cuts back). */
export function writeAllSync (io, fd, buf, pos) {
  const n = io.writeSync(fd, buf, 0, buf.length, pos)
  if (n !== buf.length) {
    const err = new Error('short write: ' + n + ' of ' + buf.length + ' bytes')
    err.code = 'ESHORT'
    throw err
  }
  return pos + n
}

export function fsyncAsync (io, fd) {
  return new Promise((resolve, reject) => io.fsync(fd, (err) => (err ? reject(err) : resolve())))
}

export const yieldNow = () => new Promise((resolve) => setImmediate(resolve))

/** A log file open for appends: checked writes at its end, background syncs. */
export class LogFile {
  /**
   * @param {string} file
   * @param {object} [opts]
   * @param {object} [opts.io]  the file system calls (DEFAULT_IO)
   * @param {number} [opts.syncEveryMs]  the least time between two fdatasyncs
   */
  constructor (file, { io = DEFAULT_IO, syncEveryMs = SYNC_EVERY_MS } = {}) {
    this.file = file
    this.io = io
    this.syncEveryMs = syncEveryMs
    this.fd = null
    /** Bytes of the whole lines in the file. */
    this.size = 0
    /** A cut back failed: nothing more is appended until the process starts again. */
    this.broken = false
    this._syncing = false
    this._syncWanted = false
    this._syncTimer = null
    this._lastSync = -Infinity
  }

  open () {
    if (this.fd !== null) return this
    this.fd = openReadWrite(this.io, this.file)
    this.size = this.io.fstatSync(this.fd).size
    return this
  }

  /**
   * Append `buf` (whole lines) at the end, checked. Throws the answer's error
   * (507 or 500) after cutting the file back; nothing of it stays.
   */
  append (buf) {
    if (this.broken) throw new HttpError(500, 'Errore interno del server')
    if (this.fd === null) this.open()
    try {
      writeAllSync(this.io, this.fd, buf, this.size)
    } catch (err) {
      this.cutBack(this.size)
      logError(path.basename(this.file) + ': append refused (' + (err.code || err.message) + ')')
      throw appendFailure(err)
    }
    this.size += buf.length
    this.scheduleSync()
  }

  /** Cut the file back to `size` bytes; a failure marks the log broken. */
  cutBack (size) {
    try {
      this.io.ftruncateSync(this.fd, size)
      this.size = size
    } catch (err) {
      this.broken = true
      logError(path.basename(this.file) + ': cannot cut back after a failed write (' + (err.code || err.message) + '), no more changes until a restart')
    }
  }

  /** One fdatasync soon: at most one in flight, at most one every syncEveryMs. */
  scheduleSync () {
    if (this.fd === null) return
    if (this._syncing || this._syncTimer !== null) {
      this._syncWanted = true
      return
    }
    const wait = this._lastSync + this.syncEveryMs - performance.now()
    if (wait > 0) {
      this._syncTimer = setTimeout(() => {
        this._syncTimer = null
        this._startSync()
      }, wait)
      this._syncTimer.unref()
      return
    }
    this._startSync()
  }

  _startSync () {
    if (this.fd === null) return
    this._syncing = true
    this._syncWanted = false
    this._lastSync = performance.now()
    const fd = this.fd
    this.io.fdatasync(fd, () => {
      this._syncing = false
      if (this._syncWanted && this.fd === fd) this.scheduleSync()
    })
  }

  /** fdatasync now, synchronously (a stop, a flush). */
  syncNow () {
    if (this.fd === null) return
    if (this._syncTimer !== null) clearTimeout(this._syncTimer)
    this._syncTimer = null
    this._syncWanted = false
    try {
      this.io.fdatasyncSync(this.fd)
    } catch (err) {
      logError(path.basename(this.file) + ': sync failed: ' + (err.code || err.message))
    }
    this._lastSync = performance.now()
  }

  /** Synced (unless `sync` is false: a file about to be replaced) and closed. */
  close ({ sync = true } = {}) {
    if (this.fd === null) return
    if (this._syncTimer !== null) clearTimeout(this._syncTimer)
    this._syncTimer = null
    if (sync) this.syncNow()
    try {
      this.io.closeSync(this.fd)
    } catch {}
    this.fd = null
  }
}

/**
 * Replay a log line by line. `onLine(text, bytes)` gets each whole line (without
 * its "\n") and its length in bytes with the "\n"; it returns false when the
 * line is not trusted, which ends the file there. Work is cut into slices of
 * about 8 ms with a turn of the event loop between them.
 * @returns {Promise<{ size: number, cut: boolean } | null>}  null: no file
 */
export async function replayLog (file, onLine, { io = DEFAULT_IO, maxLine = MAX_LINE } = {}) {
  let fd
  try {
    fd = io.openSync(file, 'r+')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let whole = 0 // the offset just after the last whole line
  let untrusted = -1
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    let rest = null
    let pos = 0
    let since = performance.now()
    outer: for (;;) {
      const n = io.readSync(fd, buf, 0, READ_CHUNK, pos)
      if (n === 0) break
      pos += n
      const data = rest !== null ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n)
      let i = 0
      for (let nl = data.indexOf(10, i); nl !== -1; nl = data.indexOf(10, i)) {
        const bytes = nl + 1 - i
        if (bytes > maxLine || onLine(data.toString('utf8', i, nl), bytes) === false) {
          untrusted = whole
          break outer
        }
        whole += bytes
        i = nl + 1
        if (performance.now() - since > YIELD_MS) {
          await yieldNow()
          since = performance.now()
        }
      }
      // The buffer is read into again: what is left is copied out of it.
      rest = i < data.length ? Buffer.from(data.subarray(i)) : null
      if (rest !== null && rest.length > maxLine) {
        untrusted = whole
        break
      }
    }
    if (untrusted !== -1) {
      const aside = file + '.cut-' + Date.now()
      copyRest(io, fd, untrusted, aside)
      io.ftruncateSync(fd, untrusted)
      logError(path.basename(file) + ': a line not to be trusted at byte ' + untrusted + ', the rest kept as ' + path.basename(aside))
      return { size: untrusted, cut: true }
    }
    if (rest !== null) {
      io.ftruncateSync(fd, whole)
      logError(path.basename(file) + ': a last line cut short dropped')
    }
    return { size: whole, cut: false }
  } finally {
    io.closeSync(fd)
  }
}

function copyRest (io, fd, from, file) {
  const out = io.openSync(file, 'w', 0o600)
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    let pos = from
    let at = 0
    for (;;) {
      const n = io.readSync(fd, buf, 0, READ_CHUNK, pos)
      if (n === 0) break
      at = writeAllSync(io, out, buf.subarray(0, n), at)
      pos += n
    }
    io.fsyncSync(out)
  } finally {
    io.closeSync(out)
  }
}

/** The epochs of a log, oldest first, each [id, first, last]. */
export class Epochs {
  constructor (list = []) {
    this.list = list
  }

  /** Epochs read back from a file: well formed, distinct ids, ranges in order. */
  static from (value) {
    const out = new Epochs()
    if (!Array.isArray(value)) return out
    const seen = new Set()
    for (const e of value) {
      if (!Array.isArray(e) || e.length !== 3 || !isEpochId(e[0]) || seen.has(e[0])) continue
      if (!Number.isSafeInteger(e[1]) || !Number.isSafeInteger(e[2]) || e[1] > e[2]) continue
      seen.add(e[0])
      out.list.push([e[0], e[1], e[2]])
    }
    return out
  }

  get current () {
    return this.list.length > 0 ? this.list[this.list.length - 1] : null
  }

  begin (id, v) {
    this.list.push([id, v, v])
  }

  /** The newest epoch reaches `v`. */
  extend (v) {
    const c = this.current
    if (c !== null && v > c[2]) c[2] = v
  }

  has (id) {
    for (const e of this.list) if (e[0] === id) return true
    return false
  }

  /** Is (id, v) a version this log wrote, at or above the horizon? */
  known (id, v, horizon) {
    if (!isEpochId(id) || id === ZERO_EPOCH || !Number.isSafeInteger(v) || v < horizon) return false
    for (const e of this.list) if (e[0] === id) return e[1] <= v && v <= e[2]
    return false
  }

  /**
   * What a compaction keeps: every epoch whose range reaches the horizon, at most
   * `max`, the oldest dropped first with the horizon raised to its last version.
   * Returns the horizon.
   */
  trim (horizon, max = KEEP_EPOCHS) {
    let h = horizon
    this.list = this.list.filter((e) => e[2] >= h)
    while (this.list.length > max) h = Math.max(h, this.list.shift()[2])
    return h
  }

  toJSON () {
    return this.list.map((e) => [e[0], e[1], e[2]])
  }
}
