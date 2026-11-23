// The files of the format before logs (db.json, users/<key>.json), read without
// ever holding them whole, and their content's SHA-256.
//
// readDbJson() hands over the elements of db.json's top-level "tracks" array one
// at a time as they are read, parses every other top-level value on its own, and
// gives back the SHA-256 of the bytes: at 50,000 tracks db.json is about 60 MB,
// and the text plus its parsed copy would not fit a 160 MB heap. What JSON.parse
// refuses is refused here too (an Error with `corrupt` set); so is a file with
// "tracks" twice, which no MPfy writes. Errors of the file system pass as they are.
//
// A log knows the stat and the hash of the .json it came from: a .json whose time
// changed but whose bytes are the same (a copy that did not keep the times) is the
// same file, and the log stays the truth.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

export const HASH_RE = /^[0-9a-f]{64}$/
const CHUNK = 64 * 1024
const YIELD_MS = 8
const yieldNow = () => new Promise((resolve) => setImmediate(resolve))

const WS = new Uint8Array(256)
WS[0x20] = WS[0x09] = WS[0x0a] = WS[0x0d] = 1
const QUOTE = 0x22
const BACKSLASH = 0x5c

function corrupt (message) {
  const err = new Error(message)
  err.corrupt = true
  return err
}

/** The SHA-256 (hex) of a file, read in chunks with a turn of the loop between them. */
export async function hashFile (file) {
  const fd = fs.openSync(file, 'r')
  const hash = crypto.createHash('sha256')
  try {
    let pos = 0
    let since = performance.now()
    for (;;) {
      const buf = Buffer.allocUnsafe(CHUNK * 16)
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      pos += n
      if (performance.now() - since > YIELD_MS) {
        await yieldNow()
        since = performance.now()
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** The SHA-256 (hex) of a file, read in chunks (at a start, before anything is served). */
export function hashFileSync (file) {
  const fd = fs.openSync(file, 'r')
  const hash = crypto.createHash('sha256')
  try {
    const buf = Buffer.allocUnsafe(CHUNK * 16)
    for (let pos = 0; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/** Does this file still hold the bytes of `from` (a stat with its hash)? Same size first. */
export function sameBytesSync (file, from, size) {
  if (from === null || typeof from.hash !== 'string' || from.size !== size) return false
  return hashFileSync(file) === from.hash
}

// One JSON value read across chunks: its bytes kept until it ends.
class Capture {
  constructor () {
    this.pieces = []
    this.depth = 0
    this.inStr = false
    this.esc = false
    this.started = false
    this.scalar = false
    this.start = 0 // where it begins in the chunk being read
  }

  // Feeds buf from i (the value's first byte the first time). Returns the index
  // just past the value, or -1 when it goes on in the next chunk.
  feed (buf, i) {
    const n = buf.length
    while (i < n) {
      if (this.inStr) {
        if (this.esc) {
          this.esc = false
          i++
          continue
        }
        const q = buf.indexOf(QUOTE, i)
        const b = buf.indexOf(BACKSLASH, i)
        const j = q === -1 ? b : b === -1 ? q : Math.min(q, b)
        if (j === -1) return -1
        i = j + 1
        if (buf[j] === BACKSLASH) {
          this.esc = true
          continue
        }
        this.inStr = false
        if (this.depth === 0) return i
        continue
      }
      const c = buf[i]
      if (!this.started) {
        this.started = true
        if (c === QUOTE) this.inStr = true
        else if (c === 0x7b || c === 0x5b) this.depth = 1
        else this.scalar = true
        i++
        continue
      }
      if (this.scalar) {
        if (c === 0x2c || c === 0x7d || c === 0x5d || WS[c] === 1) return i
        i++
        continue
      }
      if (c === QUOTE) this.inStr = true
      else if (c === 0x7b || c === 0x5b) this.depth++
      else if (c === 0x7d || c === 0x5d) {
        if (--this.depth === 0) return i + 1
      }
      i++
    }
    return -1
  }
}

const S_BEGIN = 0
const S_KEY_FIRST = 1
const S_KEY = 2
const S_COLON = 3
const S_VALUE = 4
const S_IN_VALUE = 5
const S_AFTER_VALUE = 6
const S_KEY_NEXT = 7
const S_END = 8
const S_ARR_FIRST = 9
const S_IN_ELEM = 10
const S_ARR_AFTER = 11
const S_ARR_NEXT = 12

// The top level of db.json, fed chunk by chunk.
class Scanner {
  constructor () {
    this.state = S_BEGIN
    this.head = {}
    this.tracks = false // "tracks" was an array
    this.elements = [] // texts of elements read and not taken yet
    this.cap = null
    this.key = null
  }

  _done (buf, start, end) {
    const pieces = this.cap.pieces
    pieces.push(buf.subarray(start, end))
    const text = pieces.length === 1 ? pieces[0].toString('utf8') : Buffer.concat(pieces).toString('utf8')
    this.cap = null
    return text
  }

  _put (key, value) {
    if (key === '__proto__') Object.defineProperty(this.head, key, { value, writable: true, enumerable: true, configurable: true })
    else this.head[key] = value
  }

  feed (buf) {
    const n = buf.length
    let i = 0
    while (i < n) {
      const st = this.state
      if (st === S_KEY || st === S_IN_VALUE || st === S_IN_ELEM) {
        const start = this.cap.start
        this.cap.start = 0
        const end = this.cap.feed(buf, i)
        if (end === -1) {
          this.cap.pieces.push(buf.subarray(start, n))
          return
        }
        const text = this._done(buf, start, end)
        i = end
        if (st === S_KEY) {
          this.key = parse(text)
          if (typeof this.key !== 'string') throw corrupt('a key that is not a string')
          this.state = S_COLON
        } else if (st === S_IN_VALUE) {
          this._put(this.key, parse(text))
          this.state = S_AFTER_VALUE
        } else {
          this.elements.push(text)
          this.state = S_ARR_AFTER
        }
        continue
      }
      const c = buf[i]
      if (WS[c] === 1) {
        i++
        continue
      }
      switch (st) {
        case S_BEGIN:
          if (c !== 0x7b) throw corrupt('not an object')
          this.state = S_KEY_FIRST
          i++
          continue
        case S_KEY_FIRST:
        case S_KEY_NEXT:
          if (c === 0x7d && st === S_KEY_FIRST) {
            this.state = S_END
            i++
            continue
          }
          if (c !== QUOTE) throw corrupt('a key expected')
          this._begin(S_KEY, i)
          continue
        case S_COLON:
          if (c !== 0x3a) throw corrupt('":" expected')
          this.state = S_VALUE
          i++
          continue
        case S_VALUE:
          if (this.key === 'tracks') {
            if (this.tracks) throw corrupt('"tracks" twice')
            if (c !== 0x5b) throw corrupt('tracks is not an array')
            this.tracks = true
            this.state = S_ARR_FIRST
            i++
            continue
          }
          this._begin(S_IN_VALUE, i)
          continue
        case S_AFTER_VALUE:
          if (c === 0x2c) this.state = S_KEY_NEXT
          else if (c === 0x7d) this.state = S_END
          else throw corrupt('"," or "}" expected')
          i++
          continue
        case S_ARR_FIRST:
          if (c === 0x5d) {
            this.state = S_AFTER_VALUE
            i++
            continue
          }
          this._begin(S_IN_ELEM, i)
          continue
        case S_ARR_NEXT:
          this._begin(S_IN_ELEM, i)
          continue
        case S_ARR_AFTER:
          if (c === 0x2c) this.state = S_ARR_NEXT
          else if (c === 0x5d) this.state = S_AFTER_VALUE
          else throw corrupt('"," or "]" expected')
          i++
          continue
        default:
          throw corrupt('more after the end')
      }
    }
  }

  _begin (state, i) {
    this.cap = new Capture()
    this.cap.start = i
    this.state = state
  }

  take () {
    const out = this.elements
    this.elements = []
    return out
  }

  end () {
    if (this.state !== S_END) throw corrupt('cut short')
  }
}

function parse (text) {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw corrupt(err.message)
  }
}

/**
 * Read db.json in chunks. `onTrack(element, head)` gets each element of the
 * top-level "tracks" array as it is read, with the top-level values read before
 * it; it may be called between turns of the event loop. `chunk`: the bytes read
 * at a time (checks).
 * @returns {Promise<{ head: object, tracks: boolean, hash: string, size: number }>}
 *   head: every top-level value but "tracks"; tracks: whether it was there (an array)
 */
export async function readDbJson (file, onTrack, { chunk = CHUNK } = {}) {
  const fd = fs.openSync(file, 'r')
  const hash = crypto.createHash('sha256')
  const sc = new Scanner()
  let size = 0
  let since = performance.now()
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(chunk)
      const n = fs.readSync(fd, buf, 0, chunk, size)
      if (n === 0) break
      const data = buf.subarray(0, n)
      size += n
      hash.update(data)
      sc.feed(data)
      for (const text of sc.take()) {
        onTrack(parse(text), sc.head)
        if (performance.now() - since > YIELD_MS) {
          await yieldNow()
          since = performance.now()
        }
      }
      if (performance.now() - since > YIELD_MS) {
        await yieldNow()
        since = performance.now()
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  sc.end()
  return { head: sc.head, tracks: sc.tracks, hash: hash.digest('hex'), size }
}
