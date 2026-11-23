// Comments under the tracks of this source, kept in clear: one file per track
// that has any, comments/<trackId>.json (0600, written atomically within a second
// of a change):
//   { schema: 1, comments: [ { id, from, at, text } ] }   newest first
// - One per person per track: a new comment of someone who has one there takes
//   its place (the newer time wins, the id stays the first one). And at most 1,000
//   per track: past that the oldest goes, without a word.
// - comments/index.ndjson (journal.mjs) knows every comment id with its track and
//   its author, so a deletion by id, a removed profile and a removed track find
//   their comments without reading every file; a track nobody commented on is
//   never read. A comment is in the index before it reaches its track's file; a
//   track's file read again puts back in step what a crash left between the two.
// - Served to a caller: never the comments of a removed profile, of someone
//   invisible (but to themself; kept, not deleted) or of someone the caller
//   blocked. A removed profile's comments leave the files in the background (they
//   are never served meanwhile); a track whose file leaves the source takes its
//   comments with it.
// - Files are read when first asked and kept in memory, the last 256 read.

import fs from 'node:fs'
import path from 'node:path'
import { apiError } from './errors.mjs'
import { isProfileId, isTrackId } from './ids.mjs'
import { Journal } from './journal.mjs'
import { cleanLine, codePoints, ensureDir, writeAtomicSync, unlinkQuiet, logError } from './util.mjs'

export const MAX_COMMENT = 300
export const MAX_PER_TRACK = 1000
export const MAX_ASKED = 20
// A comment's time may be this far ahead of this source's clock, or this far behind.
export const AHEAD_MS = 5 * 60 * 1000
export const BEHIND_MS = 30 * 24 * 3600 * 1000
const WRITE_DELAY_MS = 1000
const RETRY_WRITE_MS = 5000
const CACHE = 256
const HEX32_RE = /^[0-9a-f]{32}$/
const FILE_RE = /^([0-9a-f]{24})\.json$/
const POST_KEYS = ['id', 'trackId', 'at', 'text']

function plainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Newest first; at the same time the greater id first (the same order everywhere).
function newestFirst (a, b) {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

function validStored (c) {
  return plainObject(c) && HEX32_RE.test(c.id) && isProfileId(c.from) && Number.isSafeInteger(c.at) && c.at >= 0 &&
    typeof c.text === 'string' && c.text !== '' && codePoints(c.text) <= MAX_COMMENT
}

export class CommentsStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {() => number} [opts.now]  this source's clock (tests)
   * @param {(pid: string) => boolean} [opts.isRemoved]  a profile removed from the source
   * @param {number} [opts.writeDelayMs]
   */
  constructor ({ dataDir, now = Date.now, isRemoved = () => false, writeDelayMs = WRITE_DELAY_MS }) {
    this.dir = path.join(path.resolve(dataDir), 'comments')
    this.now = now
    this.isRemoved = isRemoved
    this.writeDelayMs = writeDelayMs
    this.index = new Journal(path.join(this.dir, 'index.ndjson'), {
      check: (id, v) => HEX32_RE.test(id) && Array.isArray(v) && v.length === 2 && isTrackId(v[0]) && isProfileId(v[1])
    })
    this._byTrack = new Map() // trackId -> Set of comment ids
    this._byAuthor = new Map() // profileId -> Set of comment ids
    this._cache = new Map() // trackId -> newest-first list, least recently used first
    this._due = new Set() // trackIds whose file is to be written
    this._timer = null
    this._closed = false
    /** Files written (tests). */
    this.writes = 0
  }

  fileOf (trackId) {
    return path.join(this.dir, trackId + '.json')
  }

  /** The index, read at start. */
  load () {
    ensureDir(this.dir)
    this.index.load()
    for (const [id, [trackId, pid]] of this.index.map) this._link(id, trackId, pid)
    return this
  }

  /**
   * After the library is open: the comments of tracks no longer here go, and a
   * file the index does not know (an index lost) is read back into it.
   * @param {(trackId: string) => boolean} hasTrack
   */
  async start (hasTrack) {
    for (const trackId of [...this._byTrack.keys()]) if (!hasTrack(trackId)) this.dropTrack(trackId)
    let names = []
    try {
      names = await fs.promises.readdir(this.dir)
    } catch {}
    let n = 0
    for (const name of names) {
      if (this._closed) return
      const m = FILE_RE.exec(name)
      if (m === null) {
        if (name.endsWith('.json.tmp')) unlinkQuiet(path.join(this.dir, name))
        continue
      }
      if (this._byTrack.has(m[1])) continue
      if (!hasTrack(m[1])) unlinkQuiet(this.fileOf(m[1]))
      else this._list(m[1])
      if (++n % 200 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }

  _link (id, trackId, pid) {
    let t = this._byTrack.get(trackId)
    if (t === undefined) this._byTrack.set(trackId, (t = new Set()))
    t.add(id)
    let a = this._byAuthor.get(pid)
    if (a === undefined) this._byAuthor.set(pid, (a = new Set()))
    a.add(id)
  }

  _unlink (id) {
    const v = this.index.get(id)
    if (v === null) return
    this.index.delete(id)
    const [trackId, pid] = v
    const t = this._byTrack.get(trackId)
    if (t !== undefined) {
      t.delete(id)
      if (t.size === 0) this._byTrack.delete(trackId)
    }
    const a = this._byAuthor.get(pid)
    if (a !== undefined) {
      a.delete(id)
      if (a.size === 0) this._byAuthor.delete(pid)
    }
  }

  _add (trackId, c) {
    this.index.set(c.id, [trackId, c.from])
    this._link(c.id, trackId, c.from)
  }

  // The comments of a track, newest first, read from its file when not in memory.
  // What the file and the index disagree on is set right here.
  _list (trackId) {
    const hit = this._cache.get(trackId)
    if (hit !== undefined) {
      this._cache.delete(trackId)
      this._cache.set(trackId, hit)
      return hit
    }
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(this.fileOf(trackId), 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') logError('comments of ' + trackId + ' not readable (' + err.message + '), read as none')
    }
    const list = []
    const authors = new Set()
    const ids = new Set()
    let changed = false
    const stored = raw !== null && Array.isArray(raw.comments) ? raw.comments : []
    for (const c of stored.filter(validStored).sort(newestFirst)) {
      const owner = this.index.get(c.id)
      // One per person, unique ids, nothing of a removed profile, nobody else's id.
      if (authors.has(c.from) || ids.has(c.id) || this.isRemoved(c.from) || (owner !== null && (owner[0] !== trackId || owner[1] !== c.from)) || list.length >= MAX_PER_TRACK) {
        changed = true
        if (owner !== null && owner[0] === trackId && owner[1] === c.from) this._unlink(c.id)
        continue
      }
      authors.add(c.from)
      ids.add(c.id)
      if (owner === null) this._add(trackId, c)
      list.push({ id: c.id, from: c.from, at: c.at, text: c.text })
    }
    // Ids the index gives this track that its file does not hold (a crash before the write).
    for (const id of [...(this._byTrack.get(trackId) || [])]) if (!ids.has(id)) this._unlink(id)
    this._remember(trackId, list)
    if (changed) this._changed(trackId)
    return list
  }

  _remember (trackId, list) {
    this._cache.set(trackId, list)
    if (this._cache.size <= CACHE) return
    for (const key of this._cache.keys()) {
      if (this._cache.size <= CACHE) break
      if (this._due.has(key) || key === trackId) continue
      this._cache.delete(key)
    }
  }

  _changed (trackId) {
    this._due.add(trackId)
    if (this._timer !== null || this._closed) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush()
    }, this.writeDelayMs)
    this._timer.unref()
  }

  /** Write now every file that changed. */
  flush () {
    for (const trackId of [...this._due]) {
      this._due.delete(trackId)
      const list = this._cache.get(trackId)
      if (list === undefined) continue
      try {
        if (list.length === 0) unlinkQuiet(this.fileOf(trackId))
        else writeAtomicSync(this.fileOf(trackId), JSON.stringify({ schema: 1, comments: list }))
        this.writes++
      } catch (err) {
        logError('comments of ' + trackId + ' not written: ' + err.message)
        this._due.add(trackId)
      }
    }
    if (this._due.size > 0 && this._timer === null && !this._closed) {
      this._timer = setTimeout(() => {
        this._timer = null
        this.flush()
      }, RETRY_WRITE_MS)
      this._timer.unref()
    }
  }

  close () {
    this._closed = true
    if (this._timer !== null) clearTimeout(this._timer)
    this._timer = null
    this.flush()
    this.index.close()
  }

  // -------------------------------------------------------------- the API

  /**
   * GET /api/comments for `viewer`: the comments of these tracks (held here) it is
   * served, newest first. `hidden(from)`: an author the viewer must not see
   * (invisible, or blocked by the viewer). `isRemoved`: the store's own, or one that
   * reads the profiles once for the whole answer.
   */
  list (trackIds, viewer, hidden, isRemoved = this.isRemoved) {
    const out = []
    for (const trackId of trackIds) {
      if (!this._byTrack.has(trackId)) continue
      for (const c of this._list(trackId)) {
        if (isRemoved(c.from) || (c.from !== viewer && hidden(c.from))) continue
        out.push({ id: c.id, trackId, from: c.from, at: c.at, text: c.text })
      }
    }
    return out.sort(newestFirst)
  }

  /**
   * POST /api/comments by `pid`: { created, comment }. Throws bad_comment,
   * bad_time, version_gone (`hasTrack` says no).
   */
  post (pid, body, hasTrack) {
    if (!plainObject(body) || Object.keys(body).some((k) => !POST_KEYS.includes(k)) || !HEX32_RE.test(body.id) || !isTrackId(body.trackId)) throw apiError('bad_comment')
    const { id, trackId } = body
    if (!hasTrack(trackId)) throw apiError('version_gone')
    const now = this.now()
    if (typeof body.at !== 'number') throw apiError('bad_comment')
    if (!Number.isSafeInteger(body.at) || body.at > now + AHEAD_MS || body.at < now - BEHIND_MS) throw apiError('bad_time')
    const text = cleanLine(body.text)
    if (text === null || text === '' || codePoints(text) > MAX_COMMENT) throw apiError('bad_comment')
    const owner = this.index.get(id)
    if (owner !== null && (owner[0] !== trackId || owner[1] !== pid)) throw apiError('bad_comment')
    const list = this._list(trackId)
    const mine = list.find((c) => c.from === pid)
    if (mine !== undefined) {
      // One per person: the newer time takes the place of the text, the id stays.
      if (body.at > mine.at) {
        mine.at = body.at
        mine.text = text
        list.sort(newestFirst)
        this._changed(trackId)
      }
      return { created: false, comment: { ...mine, trackId } }
    }
    const c = { id, from: pid, at: body.at, text }
    this._add(trackId, c)
    list.push(c)
    list.sort(newestFirst)
    while (list.length > MAX_PER_TRACK) this._unlink(list.pop().id)
    this._changed(trackId)
    return { created: true, comment: { ...c, trackId } }
  }

  /** DELETE /api/comments/<id>: its author, or the owner (`owner` true). Throws comment_gone, forbidden. */
  remove (pid, id, owner) {
    const where = HEX32_RE.test(id) ? this.index.get(id) : null
    if (where === null) throw apiError('comment_gone')
    const trackId = where[0]
    const list = this._list(trackId)
    const i = list.findIndex((c) => c.id === id)
    if (i === -1 || this.isRemoved(list[i].from)) throw apiError('comment_gone')
    if (list[i].from !== pid && !owner) throw apiError('forbidden')
    list.splice(i, 1)
    this._unlink(id)
    this._changed(trackId)
  }

  /** A track's file left the source: its comments go, file and all. */
  dropTrack (trackId) {
    for (const id of [...(this._byTrack.get(trackId) || [])]) this._unlink(id)
    this._cache.delete(trackId)
    this._due.delete(trackId)
    unlinkQuiet(this.fileOf(trackId))
  }

  /**
   * A profile left the source: its comments go from every file, in the background
   * (one file at a time); nothing of it is served meanwhile. Resolves when done.
   */
  async removeProfile (pid) {
    const ids = this._byAuthor.get(pid)
    if (ids === undefined) return
    const tracks = new Set()
    for (const id of ids) {
      const v = this.index.get(id)
      if (v !== null) tracks.add(v[0])
    }
    for (const trackId of tracks) {
      if (this._closed) return
      const list = this._list(trackId)
      const i = list.findIndex((c) => c.from === pid)
      if (i !== -1) {
        this._unlink(list[i].id)
        list.splice(i, 1)
        this._changed(trackId)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** How many comments the source holds (health). */
  get size () {
    return this.index.size
  }
}
