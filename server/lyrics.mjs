// Lyrics of the tracks of this source, found by the source itself, never by an
// app. Where they come from, in this order:
//   1. the file's tags (lrc.mjs), read at upload from the parse the pipeline does
//      anyway, and once for the tracks from before by a background media job
//      (music-metadata in process, one file at a time, nothing decoded);
//   2. an .lrc file beside the audio (in an archive, or sent after a folder upload:
//      kept only when the track has no synced lyrics), or put on a track by a
//      person (it replaces whatever there is);
//   3. LRCLIB, only while the owner's "details from the network" switch is on, for
//      a track with nothing from 1 or 2, a title, an artist and a duration.
//
// Files:
// - lyrics/index.ndjson (journal.mjs): one line per change of a track's entry
//     ["<trackId>", { kind: synced|plain|instrumental|null, from: tag|lrc|lrclib|null,
//                     key: <16 hex>, lookup: { state: found|none|failed|removed, at, tries }|null }]
//   so a lookup costs one short append, however big the library: the whole index
//   is never written again but when its dead lines outnumber the live ones. Every
//   track whose tags were read has an entry, with lyrics or not.
// - lyrics/<trackId>.json: the text, { kind: "synced", lines: [{ t, text }] } or
//   { kind: "plain", text }, written atomically before its entry names it.
// `key`: the first 16 hex of the SHA-256 of title, artist, album and the rounded
// duration in seconds, joined by NUL: the track as LRCLIB was asked about it.
//
// LRCLIB: GET /api/get with track_name, artist_name, album_name (left out for an
// unknown album) and duration (left out above an hour), User-Agent MPfy/<version>
// and nothing else of the source, a person or a device. One worker with its own
// queue, one request at a time, 1.5 s at least between two starts; 429 and 503
// wait Retry-After (seconds or a date, an hour at most) or 5, 10, 20, 40, 60 s and
// ask again; a 404 is a miss, asked again after 30 days; any other failure is
// tried again after 6, 12, 24, 48 h (four times); no answer at all (no network)
// writes nothing: the queue waits, from a minute doubling to half an hour. A
// change of title, artist, album or duration (`key`) asks again, unless the
// lyrics came from the tags or from a person. Uploads first, then the library, 60 s
// after start and at once when the switch turns on. A retry that is not due yet
// waits in a heap ordered by time, so nothing scans the library to find it.
//
// The library: a track with lyrics carries `"lyrics": "synced"|"plain"` in
// /api/library. A person's change (an upload, a PUT, a DELETE) moves the library
// version at once; the changes of the fill (the tags job, LRCLIB) are gathered and
// move it at most once every 5 minutes, and once more when the fill is over, so the
// apps do not read the whole library again for each track that gains lyrics.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isTrackId } from './ids.mjs'
import { readAudio, UNKNOWN_ARTIST, UNKNOWN_ALBUM } from './media.mjs'
import { Journal } from './journal.mjs'
import { parseLrc, parsePlain, parseLyricsText, lyricsFromTags, LyricsError } from './lrc.mjs'
import { ensureDir, writeAtomicSync, unlinkQuiet, log, logError } from './util.mjs'

export const LRCLIB_URL = 'https://lrclib.net'
export const PRIORITY = { UPLOAD: 0, BACKGROUND: 1 }
export const PACE_MS = 1500
export const BACKOFF = Object.freeze([5000, 10000, 20000, 40000, 60000])
export const MAX_RETRY_AFTER_MS = 3600 * 1000
const OFFLINE_PAUSE = [60000, 120000, 240000, 480000, 960000, 1800000]
export const RETRY_BASE_MS = 6 * 3600 * 1000
export const MAX_TRIES = 5 // the first try and four more
export const MISS_RETRY_MS = 30 * 24 * 3600 * 1000
export const FILL_DELAY_MS = 60000
const POLL_MS = 10000
export const PUBLISH_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT = 20000
const BODY_CAP = 1024 * 1024
const SCAN_BATCH = 2000
const MAX_TIMER = 2 ** 31 - 1
const KINDS = new Set(['synced', 'plain', 'instrumental'])
const FROMS = new Set(['tag', 'lrc', 'lrclib'])
const STATES = new Set(['found', 'none', 'failed', 'removed'])
const KEY_RE = /^[0-9a-f]{16}$/
const FILE_RE = /^([0-9a-f]{24})\.json$/

/** The key of a track: what LRCLIB is asked about it. */
export function keyOf (t) {
  const seconds = typeof t.duration === 'number' && Number.isFinite(t.duration) ? Math.round(t.duration) : 0
  return crypto.createHash('sha256').update(t.title + '\u0000' + t.artist + '\u0000' + t.album + '\u0000' + seconds).digest('hex').slice(0, 16)
}

/** Can LRCLIB be asked about this track: a title, a known artist, a duration? */
export function askable (t) {
  return typeof t.title === 'string' && t.title !== '' && t.title !== t.id &&
    typeof t.artist === 'string' && t.artist !== '' && t.artist !== UNKNOWN_ARTIST &&
    typeof t.duration === 'number' && Number.isFinite(t.duration) && t.duration > 0
}

/** The query of a track (no host): track_name, artist_name, album_name, duration as LRCLIB takes them. */
export function queryOf (t) {
  const q = new URLSearchParams()
  q.set('track_name', t.title)
  q.set('artist_name', t.artist)
  if (typeof t.album === 'string' && t.album !== '' && t.album !== UNKNOWN_ALBUM) q.set('album_name', t.album)
  const seconds = Math.round(t.duration)
  if (seconds <= 3600) q.set('duration', String(seconds))
  return '/api/get?' + q.toString()
}

/** Retry-After as a wait in ms (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs (value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const v = value.trim()
  if (/^\d{1,10}$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS)
  const at = Date.parse(v)
  if (!Number.isFinite(at)) return null
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS)
}

function validEntry (id, e) {
  if (!isTrackId(id) || e === null || typeof e !== 'object' || Array.isArray(e)) return false
  if (e.kind !== null && !KINDS.has(e.kind)) return false
  if (e.from !== null && !FROMS.has(e.from)) return false
  if (typeof e.key !== 'string' || !KEY_RE.test(e.key)) return false
  const l = e.lookup
  if (l === null) return true
  return typeof l === 'object' && STATES.has(l.state) && Number.isSafeInteger(l.at) && Number.isSafeInteger(l.tries) && l.tries >= 0
}

function entry (kind, from, key, lookup) {
  return { kind, from, key, lookup }
}

const shownKind = (e) => (e !== null && (e.kind === 'synced' || e.kind === 'plain') ? e.kind : null)

// A min-heap of [at, trackId]: the retries that are not due yet.
class DueHeap {
  constructor () {
    this.at = []
    this.id = []
  }

  get size () {
    return this.at.length
  }

  get top () {
    return this.at.length > 0 ? this.at[0] : Infinity
  }

  push (at, id) {
    let i = this.at.length
    this.at.push(at)
    this.id.push(id)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.at[p] <= at) break
      this.at[i] = this.at[p]
      this.id[i] = this.id[p]
      i = p
    }
    this.at[i] = at
    this.id[i] = id
  }

  pop () {
    const id = this.id[0]
    const lastAt = this.at.pop()
    const lastId = this.id.pop()
    const n = this.at.length
    if (n > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const c = l + 1 < n && this.at[l + 1] < this.at[l] ? l + 1 : l
        if (this.at[c] >= lastAt) break
        this.at[i] = this.at[c]
        this.id[i] = this.id[c]
        i = c
      }
      this.at[i] = lastAt
      this.id[i] = lastId
    }
    return id
  }

  clear () {
    this.at = []
    this.id = []
  }
}

// A first-in first-out list of track ids, each at most once.
class IdQueue {
  constructor () {
    this.list = []
    this.head = 0
    this.has = new Set()
  }

  get size () {
    return this.has.size
  }

  push (id) {
    if (this.has.has(id)) return
    this.has.add(id)
    this.list.push(id)
  }

  shift () {
    while (this.head < this.list.length) {
      const id = this.list[this.head++]
      if (this.head > 1024 && this.head * 2 > this.list.length) {
        this.list = this.list.slice(this.head)
        this.head = 0
      }
      if (this.has.delete(id)) return id
    }
    return null
  }

  delete (id) {
    this.has.delete(id)
  }

  clear () {
    this.list = []
    this.head = 0
    this.has.clear()
  }
}

class Stopped extends Error {}

export class Lyrics {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir
   * @param {import('./library.mjs').Library} deps.library
   * @param {import('./source.mjs').SourceStore} deps.source
   * @param {string|null} [deps.url]  the LRCLIB base URL; null: never asked (tests)
   * @param {string} deps.userAgent
   * @param {object|null} [deps.jobs]  the media jobs (the tags of the tracks from before)
   * @param {() => number} [deps.now]  the clock of the lookup records (tests)
   * @param {number} [deps.fillDelayMs]  wait before the library is looked up
   * @param {number} [deps.paceMs]  least time between two request starts
   * @param {number} [deps.pollMs]  how often source.json is looked at for the switch
   * @param {number[]} [deps.backoff]  the waits after a 429 or 503 with no Retry-After
   * @param {number} [deps.retryBaseMs]  the first wait before a failed lookup runs again
   * @param {number} [deps.missRetryMs]  how long a miss stands
   * @param {number[]} [deps.offlinePause]  the waits while LRCLIB gives no answer at all
   * @param {number} [deps.publishMs]  the least time between two moves of the fill
   */
  constructor ({
    dataDir, library, source, url = null, userAgent, jobs = null, now = Date.now, fillDelayMs = FILL_DELAY_MS, paceMs = PACE_MS,
    pollMs = POLL_MS, backoff = BACKOFF, retryBaseMs = RETRY_BASE_MS, missRetryMs = MISS_RETRY_MS, offlinePause = OFFLINE_PAUSE,
    publishMs = PUBLISH_MS
  }) {
    this.dir = path.join(path.resolve(dataDir), 'lyrics')
    this.library = library
    this.source = source
    this.url = url
    this.userAgent = userAgent
    this.jobs = jobs
    this.now = now
    this.fillDelayMs = fillDelayMs
    this.paceMs = paceMs
    this.pollMs = pollMs
    this.backoff = backoff
    this.retryBaseMs = retryBaseMs
    this.missRetryMs = missRetryMs
    this.offlinePause = offlinePause
    this.publishMs = publishMs
    this.index = new Journal(path.join(this.dir, 'index.ndjson'), { check: validEntry })
    this.stats = { requests: 0, lookups: 0, tagsRead: 0, published: 0 }

    // What /api/library shows (published) and the tracks whose flag may differ.
    this._shown = new Map()
    this._dirty = new Set()
    this._publishTimer = null
    this._lastPublish = Date.now()

    // The tags job: the tracks from before with no entry.
    this._tagsTodo = []
    this._tagsAt = 0

    this._uploads = new IdQueue()
    this._library = new IdQueue()
    this._heap = new DueHeap()
    this._laterTimer = null
    this._laterAt = Infinity
    this._again = null // asked again first (a 429, no network)
    this._running = null
    this._open = false // the library part of the queue runs
    this._enabled = false
    this._scanning = null
    this._lastStart = 0
    this._pauseUntil = 0
    this._level = 0
    this._offlineLevel = 0
    this._wakeTimer = null
    this._abort = null
    this._sleeps = new Set()
    this._timers = new Set()
    this._idleWaiters = []
    this._started = false
    this._closed = false
  }

  fileOf (trackId) {
    return path.join(this.dir, trackId + '.json')
  }

  /** The index, read before the API serves anything; the flags shown from it. */
  load () {
    ensureDir(this.dir)
    this.index.load()
    for (const [id, e] of this.index.map) {
      const kind = shownKind(e)
      if (kind !== null) this._shown.set(id, kind)
    }
    return this
  }

  /** "synced", "plain" or null: what /api/library shows of a track. */
  flagOf (trackId) {
    return this._shown.get(trackId) || null
  }

  /** The entry of a track (never to be changed), or null. */
  entryOf (trackId) {
    return this.index.get(trackId)
  }

  get enabled () {
    return this._enabled
  }

  get active () {
    return this.url !== null && !this._closed
  }

  // ---------------------------------------------------------------- start

  /**
   * After the library and the media jobs: entries of tracks gone are dropped, the
   * tracks with none go to the tags job, and, with the switch on, what is due is
   * queued (the library part after fillDelayMs). Resolves when the scan is done.
   */
  start () {
    this._started = true
    this._enabled = this.source.data.details !== false
    if (this.active) {
      if (this.fillDelayMs <= 0) {
        this._open = true
      } else {
        this._timer(() => {
          this._open = true
          this._pump()
        }, this.fillDelayMs)
      }
      const poll = setInterval(() => this.sourceChanged(), this.pollMs)
      poll.unref()
      this._timers.add(poll)
    }
    this._scanning = this._scan(true).finally(() => { this._scanning = null })
    return this._scanning
  }

  _timer (fn, ms) {
    const timer = setTimeout(() => {
      this._timers.delete(timer)
      if (!this._closed) fn()
    }, Math.min(Math.max(0, ms), MAX_TIMER))
    timer.unref()
    this._timers.add(timer)
    return timer
  }

  // Every track and every entry, a batch at a time with a turn of the event loop
  // between batches. At start also the entries and files of tracks gone.
  async _scan (atStart) {
    const ids = [...this.library.tracks.keys()]
    const todo = []
    for (let i = 0; i < ids.length; i += SCAN_BATCH) {
      if (this._closed) return
      for (const id of ids.slice(i, i + SCAN_BATCH)) {
        const t = this.library.getTrack(id)
        if (t === null) continue
        const e = this.index.get(id)
        if (e === null) {
          if (atStart) todo.push(id)
          continue
        }
        if (this._enabled && this.active) this._place(t, e, PRIORITY.BACKGROUND)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (!atStart) return
    let n = 0
    for (const id of [...this.index.map.keys()]) {
      if (this._closed) return
      if (this.library.getTrack(id) === null) this.dropTrack(id)
      if (++n % SCAN_BATCH === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    let names = []
    try {
      names = await fs.promises.readdir(this.dir)
    } catch {}
    // A text of every track with lyrics: a big library has as many names, looked
    // at a batch at a time.
    n = 0
    for (const name of names) {
      if (this._closed) return
      const m = FILE_RE.exec(name)
      if (m !== null && shownKind(this.index.get(m[1])) === null) unlinkQuiet(path.join(this.dir, name))
      else if (name.endsWith('.json.tmp')) unlinkQuiet(path.join(this.dir, name))
      if (++n % SCAN_BATCH === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    if (this._closed) return
    if (todo.length > 0) {
      this._tagsTodo = todo
      this._tagsAt = 0
      if (this.jobs !== null) this.jobs.requestLyricsTags()
      log('lyrics: the tags of ' + todo.length + ' track(s) from before are read in the background')
    }
  }

  // ------------------------------------------------------------ the queue

  // When the lookup of this track is due: 0 now, a time, or Infinity (only a change
  // of its key would ask again).
  _dueAt (t, e) {
    if (e === null || e.from === 'tag' || e.from === 'lrc' || !askable(t)) return Infinity
    const l = e.lookup
    if (l === null || e.key !== keyOf(t)) return 0
    if (l.state === 'none') return l.at + this.missRetryMs
    if (l.state === 'failed') return l.tries >= MAX_TRIES ? Infinity : l.at + this.retryBaseMs * 2 ** (Math.max(1, l.tries) - 1)
    return Infinity
  }

  // A track goes where its entry says: the queue now, the heap for later, or nowhere.
  _place (t, e, priority) {
    const at = this._dueAt(t, e)
    if (at === Infinity) return
    if (at <= this.now()) {
      if (priority === PRIORITY.UPLOAD) this._uploads.push(t.id)
      else this._library.push(t.id)
      this._pump()
      return
    }
    this._heap.push(at, t.id)
    this._armLater()
  }

  _armLater () {
    const top = this._heap.top
    if (top === Infinity || !this._enabled || !this.active) return
    if (this._laterTimer !== null) {
      if (this._laterAt <= top) return
      clearTimeout(this._laterTimer)
      this._timers.delete(this._laterTimer)
    }
    this._laterAt = top
    this._laterTimer = this._timer(() => {
      this._laterTimer = null
      this._laterAt = Infinity
      const now = this.now()
      while (this._heap.size > 0 && this._heap.top <= now) {
        const id = this._heap.pop()
        const t = this.library.getTrack(id)
        if (t !== null && this._dueAt(t, this.index.get(id)) <= now) this._library.push(id)
      }
      this._armLater()
      this._pump()
    }, top - this.now())
  }

  /** An upload, or a track a person changed: looked up first, when it is due. */
  request (trackId, priority = PRIORITY.UPLOAD) {
    if (!this.active || !this._enabled) return
    const t = this.library.getTrack(trackId)
    const e = this.index.get(trackId)
    if (t !== null && e !== null) this._place(t, e, priority)
  }

  _next () {
    if (this._again !== null) {
      const id = this._again
      this._again = null
      return id
    }
    const up = this._uploads.shift()
    if (up !== null) return up
    return this._open ? this._library.shift() : null
  }

  _pump () {
    if (this._closed || this._running !== null) return
    if (!this._enabled || !this.active) return this._idle()
    const wait = this._pauseUntil - Date.now()
    if (wait > 0) {
      if (this._wakeTimer === null) {
        this._wakeTimer = this._timer(() => {
          this._wakeTimer = null
          this._pump()
        }, wait)
      }
      return
    }
    const id = this._next()
    if (id === null) return this._idle()
    this._running = id
    this._run(id)
      .catch((err) => logError('lyrics of ' + id + ' crashed: ' + (err && err.stack ? err.stack : err)))
      .finally(() => {
        this._running = null
        setImmediate(() => this._pump())
      })
  }

  // Nothing to do now: the waiting tests go on, and a fill that is over shows what it found.
  _idle () {
    const waiters = this._idleWaiters
    this._idleWaiters = []
    for (const resolve of waiters) resolve()
    if (this._uploads.size === 0 && this._library.size === 0 && this._again === null && this._tagsLeft() === 0) this._fillOver()
  }

  /** Resolves when nothing runs and nothing queued may run now (tests). */
  idle () {
    if (this._closed) return Promise.resolve()
    const runnable = this._enabled && this.active && Date.now() >= this._pauseUntil &&
      (this._again !== null || this._uploads.size > 0 || (this._open && this._library.size > 0))
    if (this._running === null && !runnable) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  /** Resolves when the start scan is over (tests). */
  scanned () {
    return this._scanning === null ? Promise.resolve() : this._scanning
  }

  get queued () {
    return this._uploads.size + this._library.size + (this._again !== null ? 1 : 0)
  }

  /** source.json may have changed (a PATCH, the CLI, an edit by hand). */
  sourceChanged () {
    if (!this._started) return
    const enabled = this.source.data.details !== false
    if (enabled === this._enabled) return
    this._enabled = enabled
    if (!enabled) {
      this._uploads.clear()
      this._library.clear()
      this._heap.clear()
      this._again = null
      if (this._laterTimer !== null) {
        clearTimeout(this._laterTimer)
        this._timers.delete(this._laterTimer)
        this._laterTimer = null
        this._laterAt = Infinity
      }
      if (this._abort !== null) this._abort.abort()
      this._wakeSleeps()
      return
    }
    if (!this.active) return
    this._open = true
    this._scan(false).catch((err) => logError('lyrics scan failed: ' + err.message))
  }

  _sleep (ms) {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this._sleeps.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref()
      this._sleeps.add(done)
    })
  }

  _wakeSleeps () {
    for (const done of [...this._sleeps]) done()
  }

  // --------------------------------------------------------------- LRCLIB

  async _run (id) {
    let t = this.library.getTrack(id)
    if (t === null || this._dueAt(t, this.index.get(id)) > this.now()) return
    // At least paceMs between two starts.
    await this._sleep(this._lastStart + this.paceMs - Date.now())
    if (this._closed || !this._enabled) return
    t = this.library.getTrack(id)
    if (t === null || this._dueAt(t, this.index.get(id)) > this.now()) return
    this._lastStart = Date.now()
    this.stats.lookups++
    const key = keyOf(t)
    let res
    try {
      res = await this._fetch(this.url + queryOf(t))
    } catch (err) {
      if (err instanceof Stopped || this._closed || !this._enabled) return
      // No answer at all: the network, not the track. Nothing is written.
      this._again = id
      const pause = this.offlinePause[Math.min(this._offlineLevel, this.offlinePause.length - 1)]
      if (this._offlineLevel === 0) log('lyrics: no answer from LRCLIB (' + err.message + '), lookups wait')
      this._offlineLevel++
      this._pauseUntil = Date.now() + pause
      return
    }
    if (this._offlineLevel > 0) log('lyrics: LRCLIB answers again')
    this._offlineLevel = 0
    if (res.status === 429 || res.status === 503) {
      const wait = retryAfterMs(res.retryAfter)
      this._pauseUntil = Date.now() + (wait !== null ? wait : this.backoff[Math.min(this._level, this.backoff.length - 1)])
      this._level++
      this._again = id
      return
    }
    this._level = 0
    let found = null
    let state = 'failed'
    if (res.status === 200) {
      const data = res.body
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        found = this._answerOf(data)
        state = found !== null ? 'found' : 'none'
      }
    } else if (res.status === 404) {
      state = 'none'
    }
    this._finish(id, key, state, found)
  }

  // What a 200 gives: synced over plain, or instrumental; null when nothing usable.
  _answerOf (data) {
    if (data.instrumental === true) return { kind: 'instrumental' }
    if (typeof data.syncedLyrics === 'string' && data.syncedLyrics.trim() !== '') {
      try {
        return parseLrc(data.syncedLyrics)
      } catch {}
    }
    if (typeof data.plainLyrics === 'string' && data.plainLyrics.trim() !== '') {
      try {
        return parsePlain(data.plainLyrics)
      } catch {}
    }
    return null
  }

  // One answer, written on the entry as it is now: a person's lyrics or the tags
  // that came meanwhile stay; an answer for a key the track no longer has is asked again.
  _finish (id, key, state, found) {
    const t = this.library.getTrack(id)
    const e = this.index.get(id)
    if (t === null || e === null || e.from === 'tag' || e.from === 'lrc') return
    if (keyOf(t) !== key) {
      this.request(id, PRIORITY.BACKGROUND)
      return
    }
    const at = this.now()
    let next
    if (state === 'found') {
      next = entry(found.kind, 'lrclib', key, { state, at, tries: 1 })
      if (found.kind === 'instrumental') this._putEntry(id, next, null)
      else this._putEntry(id, next, found)
    } else if (state === 'none') {
      // A miss for this key: lyrics an earlier key found go.
      this._putEntry(id, entry(null, null, key, { state, at, tries: 1 }), null)
    } else {
      const l = e.lookup
      const tries = l !== null && l.state === 'failed' && e.key === key ? l.tries + 1 : 1
      // Lyrics an earlier key found stay until an answer comes.
      this._putEntry(id, entry(e.kind, e.from, key, { state, at, tries }), undefined)
    }
    this._flagChanged(id, false)
    const n = this.index.get(id)
    const due = this._dueAt(t, n)
    if (due !== Infinity && due > at) {
      this._heap.push(due, id)
      this._armLater()
    }
  }

  async _fetch (url) {
    if (this._closed || !this._enabled) throw new Stopped()
    this._abort = new AbortController()
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT), this._abort.signal])
    this.stats.requests++
    try {
      const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, redirect: 'follow', signal })
      const retryAfter = res.headers.get('retry-after')
      let body = null
      if (res.status === 200) {
        const buf = await readCapped(res, BODY_CAP)
        if (buf !== null) {
          try {
            body = JSON.parse(buf.toString('utf8'))
          } catch {
            body = null
          }
        }
      } else if (res.body) {
        await res.body.cancel().catch(() => {})
      }
      return { status: res.status, body, retryAfter }
    } catch (err) {
      if (this._abort !== null && this._abort.signal.aborted) throw new Stopped()
      throw err
    } finally {
      this._abort = null
    }
  }

  // ------------------------------------------------------------- the entries

  // Write an entry: its text first (null: none, undefined: as it is), then its line.
  _putEntry (id, e, text) {
    if (text !== undefined) {
      if (text !== null) {
        const body = text.kind === 'synced' ? { kind: 'synced', lines: text.lines } : { kind: 'plain', text: text.text }
        writeAtomicSync(this.fileOf(id), JSON.stringify(body))
      }
    }
    const had = this.index.get(id)
    this.index.set(id, e)
    if (text === null && shownKind(had) !== null) unlinkQuiet(this.fileOf(id))
  }

  // A track's flag may have changed. A person's change shows at once; the fill's
  // are gathered (at most one move every publishMs).
  _flagChanged (id, now) {
    const live = shownKind(this.index.get(id))
    if (live === (this._shown.get(id) || null)) {
      this._dirty.delete(id)
      return
    }
    this._dirty.add(id)
    if (now) this.publish()
    else this._armPublish()
  }

  _armPublish () {
    if (this._publishTimer !== null || this._closed) return
    this._publishTimer = setTimeout(() => {
      this._publishTimer = null
      this.publish()
    }, Math.max(0, this._lastPublish + this.publishMs - Date.now()))
    this._publishTimer.unref()
  }

  /** Show every changed flag now (one move of the library version). */
  publish () {
    if (this._publishTimer !== null) clearTimeout(this._publishTimer)
    this._publishTimer = null
    const changed = []
    for (const id of this._dirty) {
      const live = this.library.getTrack(id) !== null ? shownKind(this.index.get(id)) : null
      if (live === (this._shown.get(id) || null)) continue
      if (live === null) this._shown.delete(id)
      else this._shown.set(id, live)
      changed.push(id)
    }
    this._dirty.clear()
    this._lastPublish = Date.now()
    if (changed.length > 0) {
      this.stats.published++
      this.library.derivedChanged(changed)
    }
  }

  // The fill is over (nothing queued, no tags left): what it found shows now.
  _fillOver () {
    if (this._dirty.size > 0) this.publish()
  }

  /** A new track: its entry from its tags (or none), then LRCLIB when it has nothing. */
  added (trackId, lyr) {
    const t = this.library.getTrack(trackId)
    if (t === null) return
    if (this.index.get(trackId) !== null) {
      this.offerTags(trackId, lyr)
      return
    }
    try {
      this._putEntry(trackId, lyr ? entry(lyr.kind, 'tag', keyOf(t), null) : entry(null, null, keyOf(t), null), lyr || null)
    } catch (err) {
      // The upload stands: the tags job reads this track again at the next start.
      logError('lyrics of ' + trackId + ' not written: ' + err.message)
      return
    }
    this._flagChanged(trackId, true)
    if (!lyr) this.request(trackId, PRIORITY.UPLOAD)
  }

  /**
   * Another file of a track (a better file, an upload of the same song) brings
   * the lyrics of its tags: taken when the track has none (not taken away by a
   * person), has only what LRCLIB found, or has plain lyrics from tags and these
   * are synced. A person's lyrics stay.
   */
  offerTags (trackId, lyr) {
    if (!lyr) return
    const t = this.library.getTrack(trackId)
    const e = this.index.get(trackId)
    if (t === null) return
    if (e === null) return this.added(trackId, lyr)
    const takes = (e.kind === null && (e.lookup === null || e.lookup.state !== 'removed')) || e.from === 'lrclib' ||
      (e.from === 'tag' && e.kind === 'plain' && lyr.kind === 'synced')
    if (!takes) return
    try {
      this._putEntry(trackId, entry(lyr.kind, 'tag', keyOf(t), e.lookup), lyr)
    } catch (err) {
      logError('lyrics of ' + trackId + ' not written: ' + err.message)
      return
    }
    this._flagChanged(trackId, true)
  }

  /**
   * PUT /api/lyrics/<trackId>: a text a person sent (an .lrc or plain). It
   * replaces whatever there is; `beside` (an .lrc beside the audio) only when the
   * track has no synced lyrics. Throws LyricsError. Returns the answer of GET.
   */
  async put (trackId, text, { beside = false } = {}) {
    const lyr = parseLyricsText(text)
    const t = this.library.getTrack(trackId)
    if (t === null) return null
    const e = this.index.get(trackId)
    if (!(beside && e !== null && e.kind === 'synced')) {
      this._putEntry(trackId, entry(lyr.kind, 'lrc', keyOf(t), e !== null ? e.lookup : null), lyr)
      this._flagChanged(trackId, true)
    }
    return this.read(trackId)
  }

  /** An .lrc file beside an audio of an archive: as PUT ?beside=1, a text that is no lyrics ignored. */
  beside (trackId, text) {
    try {
      const lyr = parseLyricsText(text)
      const t = this.library.getTrack(trackId)
      const e = this.index.get(trackId)
      if (t === null || (e !== null && e.kind === 'synced')) return false
      this._putEntry(trackId, entry(lyr.kind, 'lrc', keyOf(t), e !== null ? e.lookup : null), lyr)
      this._flagChanged(trackId, true)
      return true
    } catch (err) {
      if (!(err instanceof LyricsError)) logError('lyrics beside ' + trackId + ' not kept: ' + err.message)
      return false
    }
  }

  /** DELETE /api/lyrics/<trackId>: the text goes, and nothing is looked up again until its key changes. */
  remove (trackId) {
    const t = this.library.getTrack(trackId)
    if (t === null) return
    this._putEntry(trackId, entry(null, null, keyOf(t), { state: 'removed', at: this.now(), tries: 0 }), null)
    this._flagChanged(trackId, true)
  }

  /**
   * GET /api/lyrics/<trackId>: { body, tag } with the text and its ETag (from the
   * file's bytes), or null (none, instrumental, an unknown track).
   */
  async read (trackId) {
    const e = this.library.getTrack(trackId) !== null ? this.index.get(trackId) : null
    if (shownKind(e) === null) return null
    let bytes
    try {
      bytes = await fs.promises.readFile(this.fileOf(trackId))
    } catch {
      return null
    }
    let text
    try {
      text = JSON.parse(bytes.toString('utf8'))
    } catch {
      return null
    }
    const body = { trackId, kind: e.kind }
    if (e.kind === 'synced' && Array.isArray(text.lines)) body.lines = text.lines
    else if (e.kind === 'plain' && typeof text.text === 'string') body.text = text.text
    else return null
    body.from = e.from
    const tag = '"y' + crypto.createHash('sha256').update(bytes).update(String(e.from)).digest('hex').slice(0, 16) + '"'
    return { body, tag }
  }

  /** A track's file left the source: its entry and its text go. */
  dropTrack (trackId) {
    const had = this.index.get(trackId)
    if (had === null) return
    this.index.delete(trackId)
    if (shownKind(had) !== null) unlinkQuiet(this.fileOf(trackId))
    this._uploads.delete(trackId)
    this._library.delete(trackId)
    // The track leaves the library anyway: nothing to show, no move of its own.
    this._shown.delete(trackId)
    this._dirty.delete(trackId)
  }

  /**
   * A track's stored fields changed (`how`: 'edit' for a person's PATCH): a new key
   * asks LRCLIB again, a person's change first.
   */
  trackChanged (trackId, how) {
    if (!this.active || !this._enabled) return
    const t = this.library.getTrack(trackId)
    const e = this.index.get(trackId)
    // Never asked yet (it may only now have an artist), or asked about another key.
    if (t === null || e === null || (e.lookup !== null && e.key === keyOf(t))) return
    this._place(t, e, how === 'edit' ? PRIORITY.UPLOAD : PRIORITY.BACKGROUND)
  }

  // ------------------------------------------------------- the tags job

  _tagsLeft () {
    return this._tagsTodo.length - this._tagsAt
  }

  /**
   * The media job of the tags of the tracks from before: one file at a time, a
   * turn of the event loop between two, until the list is over (true), the job is
   * stopped or a job of a higher priority waits (false: it is queued again).
   * `current(id)` tells the jobs which track's file is open.
   */
  async tagsSlice ({ signal, current = () => {}, yieldTo = () => false }) {
    while (this._tagsAt < this._tagsTodo.length) {
      if (this._closed || signal.aborted || yieldTo()) return false
      const id = this._tagsTodo[this._tagsAt++]
      const t = this.library.getTrack(id)
      // Its original on a memory card that is away: read when it is back.
      if (t === null || this.index.get(id) !== null || !this.library.originalReady(t)) continue
      let lyr = null
      current(id)
      try {
        const { metadata } = await this.library.withLocalFile(t, (file) => readAudio(file, null, { covers: false, duration: false }))
        lyr = lyricsFromTags(metadata)
      } catch (err) {
        if (err && err.code !== 'ENOENT') logError('lyrics tags of ' + id + ' unreadable: ' + err.message)
      } finally {
        current(null)
      }
      const now = this.library.getTrack(id)
      // Replaced meanwhile: the new file's tags came with it.
      if (now !== null && now.fileHash === t.fileHash && this.index.get(id) === null) {
        try {
          this._putEntry(id, lyr ? entry(lyr.kind, 'tag', keyOf(now), null) : entry(null, null, keyOf(now), null), lyr || null)
        } catch (err) {
          // Read again at the next start.
          logError('lyrics of ' + id + ' not written: ' + err.message)
          continue
        }
        this.stats.tagsRead++
        this._flagChanged(id, false)
        if (!lyr) this.request(id, PRIORITY.BACKGROUND)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    this._tagsTodo = []
    this._tagsAt = 0
    if (this._running === null && this.queued === 0) this._fillOver()
    return true
  }

  // ----------------------------------------------------------------- the end

  /** The numbers of /admin/health. */
  health () {
    return { enabled: this._enabled && this.active, queued: this.queued, later: this._heap.size, tagsLeft: this._tagsLeft(), entries: this.index.size, shown: this._shown.size }
  }

  /** No more lookups, no more timers (the index stays open until close). */
  stop () {
    this._closed = true
    for (const timer of this._timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this._timers.clear()
    if (this._publishTimer !== null) clearTimeout(this._publishTimer)
    this._publishTimer = null
    if (this._abort !== null) this._abort.abort()
    this._wakeSleeps()
    this._uploads.clear()
    this._library.clear()
    this._heap.clear()
    const waiters = this._idleWaiters
    this._idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  close () {
    this.stop()
    this.index.close()
  }
}

// The body, or null past the cap (the rest is not read).
async function readCapped (res, cap) {
  const chunks = []
  let total = 0
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > cap) return null
      chunks.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(chunks, total)
}
