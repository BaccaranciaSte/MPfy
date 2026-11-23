// Small filesystem and logging helpers shared by the server modules.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// The local time as the shell scripts write it (date '+%Y-%m-%d %H:%M:%S').
export function localStamp (d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

export function log (...args) {
  console.log(localStamp(), ...args)
}

export function logError (...args) {
  console.error(localStamp(), ...args)
}

/** mkdir -p with mode 0700 (the mode is applied to the leaf even if it existed). */
export function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))
function sleepSync (ms) {
  Atomics.wait(sleeper, 0, 0, ms)
}

/** EPERM, EBUSY or EACCES: on Windows, a file someone else holds open. */
export function isBusy (err) {
  return !!err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
}

/**
 * Rename with a few retries: on Windows a rename over a file that something else
 * (an antivirus scan, an indexer) holds open fails with EPERM/EBUSY for a moment.
 */
export function renameSyncRetry (from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (attempt >= 6 || !isBusy(err)) throw err
      sleepSync(25 * (attempt + 1))
    }
  }
}

/** A unique name in `dir` for `file` set aside: <tag>-<8 hex>-<its name>. */
export function asidePath (dir, file, tag = 'gone') {
  return path.join(dir, tag + '-' + crypto.randomBytes(4).toString('hex') + '-' + path.basename(file))
}

/**
 * Delete a file by moving it into `dir` (on the same volume) and unlinking it
 * there. On Windows, deleting a file someone reads leaves its name taken until
 * the reader closes it; renaming it away frees the name at once. False when the
 * file is still there (a program holds it and lets nobody move it); a copy that
 * cannot be unlinked yet stays in `dir`. `retry`: wait a little for a file that
 * is busy for a moment.
 */
export function removeAside (file, dir, { retry = false } = {}) {
  const aside = asidePath(dir, file)
  try {
    if (retry) renameSyncRetry(file, aside)
    else fs.renameSync(file, aside)
  } catch (err) {
    return err.code === 'ENOENT' && !fs.existsSync(file)
  }
  unlinkQuiet(aside)
  return true
}

/** fsync a directory so a rename inside it survives power loss (no-op where unsupported). */
export function fsyncDirSync (dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // Windows cannot open directories; nothing to do there.
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch {}
  }
}

/**
 * Write a file atomically: write a temp file next to it, fsync, rename over the
 * target, fsync the directory. A crash leaves either the old or the new content.
 */
export function writeAtomicSync (file, data, mode = 0o600) {
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try { fs.chmodSync(tmp, mode) } catch {}
  renameSyncRetry(tmp, file)
  fsyncDirSync(path.dirname(file))
}

export function unlinkQuiet (file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export async function unlinkQuietAsync (file) {
  try {
    await fs.promises.unlink(file)
    return true
  } catch {
    return false
  }
}

/** rm -rf that never throws (Windows may hold a file a moment longer). */
export function removeTree (target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    return true
  } catch {
    return false
  }
}

/** Read and parse a JSON file; null when missing or unreadable. */
export function readJsonFile (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Write pretty JSON atomically (0600). */
export function writeJsonAtomicSync (file, value) {
  writeAtomicSync(file, JSON.stringify(value, null, 2) + '\n')
}

/** Count of Unicode code points (never UTF-16 units). */
export function codePoints (s) {
  return Array.from(String(s)).length
}

/**
 * A person's or a source's name as typed: control characters removed, runs of
 * white space collapsed, trimmed. Valid when 1 to 40 code points; else null.
 */
export function cleanName (value) {
  if (typeof value !== 'string') return null
  const s = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/gu, ' ').trim()
  const n = codePoints(s)
  return n >= 1 && n <= 40 ? s : null
}

/**
 * A one-line text as people type it (a title, a note, a comment): every control
 * character and line break becomes a space, runs of white space collapse, then
 * trimmed. null for anything but a string.
 */
export function cleanLine (value) {
  if (typeof value !== 'string') return null
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/gu, ' ').trim()
}

/** A tiny async lock: run(fn) waits for the previous holder. */
export class Mutex {
  constructor () {
    this._tail = Promise.resolve()
  }

  run (fn) {
    const result = this._tail.then(fn, fn)
    this._tail = result.then(() => {}, () => {})
    return result
  }
}

/** At most `max` tasks at once; the others wait their turn. */
export class Limiter {
  constructor (max) {
    this.max = max
    this.active = 0
    this._waiting = []
  }

  async run (fn) {
    if (this.active >= this.max) await new Promise((resolve) => this._waiting.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this._waiting.shift()
      if (next) next()
    }
  }
}

/** 16 hex: the id of a session, a pending upload or an archive. */
export function newId16 () {
  return crypto.randomBytes(8).toString('hex')
}
