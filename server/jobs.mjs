// Background media jobs: Opus transcodes, the small/large JPEG versions of
// embedded covers, fingerprints (fpcalc), the quality analysis (quality.mjs), the
// tags of tracks from before (re-read for their technical fields and for the
// fields their file has no tag for) and their lyrics tags (lyrics.mjs: one job
// that reads the files one by one and steps aside whenever a job of a higher
// priority waits), ONE job at a time.
//
// Queue order: jobs asked for by a stream request first, then the jobs of a fresh
// upload (its cover sizes, quality, then high, normal, low), then the background
// fill at start (fingerprints of tracks without one, tags, quality, missing
// cover sizes, then missing levels). First in, first out within the same
// priority; a job queued twice keeps the better priority. Jobs that write wait
// while the disk is down to its floor (disk.mjs).
//
// Levels: low 48, normal 96, high 160 kbps Opus; max is the original. A level
// whose bitrate is at least 90% of the original's is never made (it would not
// save anything) and is never "ready".
//
// transcodes/ is capped (MPFY_TRANSCODE_CAP_GB): when a new transcode pushes it
// over, the least recently streamed ones go first (originals are never touched).
// The background fill does not evict anything: it only uses free room. "Recently
// streamed" is kept in memory and in each file's access time (set explicitly, so
// it survives a restart whatever the mount options).
//
// Transcodes live in places (places.mjs): internal memory first, a memory card
// in use only when internal memory is down to its floor. ffmpeg always writes in
// internal tmp/ and reads an internal file (a card original is copied there
// first): no tool ever holds a card file open. Jobs of a track whose original
// is away are not queued, and one cut because its card went away is no failure:
// it runs again when the card is back. One more job, `move`, carries the
// originals onto the card and back (moves.mjs), one file per run, stepping
// aside whenever a job of a higher priority waits.
//
// A transcode that goes (evicted, its track deleted or given a new file) is moved
// aside into its place's tmp/ before it is deleted: on Windows a file someone streams keeps
// its name until it is closed, and the next transcode needs that name. A finished
// transcode that cannot take its name because a program holds it is not a
// failure: it is made again a little later.
//
// Choosing what to serve for ?q=: the asked level when ready, else the next lower
// ready level, then the next higher, then the original. A playback keeps the
// representation it started with, so a player never mixes the bytes of two
// different files: per requester, track and ?q= the choice is remembered, and
//  - a request that continues a playback (a Range not starting at 0) reuses it
//    for STICKY_MS after the last request;
//  - a request from byte 0 (no Range, or bytes=0-) reuses it too while a response
//    on it is still being sent, or for RESTART_STICKY_MS after the last one ended:
//    players re-read from 0 inside one playback (Chrome probing a file, a seek back
//    to the start), and the server cannot tell that from a new playback. Later, a
//    request from 0 is a new playback and chooses afresh;
//  - a HEAD (the web UI asks X-MPfy-Quality that way) answers what a GET with the
//    same Range would get now, and records nothing.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LEVELS, LEVEL_NAMES, COVER_SIZES, COVER_PIXELS, TRANSCODE_FILE_RE, isTrackId } from './ids.mjs'
import { transcodeArgs, coverArgs } from './ffmpeg.mjs'
import { sniffImage, readAudio, sniffAudio, buildTrack, taglessOf, HEAD_BYTES } from './media.mjs'
import { signatureOf } from './fingerprint.mjs'
import { applyQuality, measureQuality, skipsAnalysis, wantsQualityCheck } from './quality.mjs'
import { loudnessArgs, loudnessOf } from './ffmpeg.mjs'
import { loudFromScan } from '../web/js/loudness.js'
import { renameSyncRetry, removeAside, isBusy, unlinkQuietAsync, log, logError } from './util.mjs'
import { CODE, isCardAway } from './places.mjs'

export const PRIORITY = { DEMAND: 0, UPLOAD: 1, BACKGROUND: 2 }

const SKIP_RATIO = 0.9
const FAIL_BLOCK_MS = 30 * 60 * 1000 // a failed job is not retried for this long
const BUSY_RETRY_MS = 30 * 1000 // a transcode whose name a program held is made again after this (times its tries)
const BUSY_TRIES = 3 // ... at most this many times in a row; then it is a failure
const STICKY_MS = 30 * 60 * 1000 // a paused playback keeps its representation this long
const RESTART_STICKY_MS = 5 * 60 * 1000 // a request from byte 0 this soon is the same playback
const STICKY_MAX = 1000
const ATIME_EVERY_MS = 60 * 1000 // persist "last streamed" at most this often per file

const TRANSCODE_MIME = 'audio/ogg'

export function fallbackOrder (q) {
  const i = LEVEL_NAMES.indexOf(q)
  if (i === -1) return []
  const lower = LEVEL_NAMES.slice(0, i).reverse()
  const higher = LEVEL_NAMES.slice(i + 1)
  return [q, ...lower, ...higher]
}

/** The original's bitrate in bit/s: the tag, else size and duration, else null. */
export function originalBitrate (track) {
  if (typeof track.bitrate === 'number' && track.bitrate > 0) return track.bitrate
  if (typeof track.duration === 'number' && track.duration > 0 && track.size > 0) return (track.size * 8) / track.duration
  return null
}

/** Would `level` save nothing over the original (>= 90% of its bitrate)? */
export function isSkipped (track, level) {
  const bitrate = originalBitrate(track)
  if (bitrate === null) return false
  return LEVELS[level] * 1000 >= SKIP_RATIO * bitrate
}

// A loudness measure decodes the whole file: an hour-long mix on a slow phone included.
const LOUDNESS_TIMEOUT = 15 * 60 * 1000

export class MediaJobs {
  /**
   * @param {object} opts
   * @param {import('./library.mjs').Library} opts.library
   * @param {object|null} opts.ffmpeg  a FfmpegRunner-like { run(args), probe(), close(), commandLine(args) } or null
   * @param {number} opts.capBytes  size cap of transcodes/
   * @param {number} [opts.backgroundDelayMs=0]  wait before the start-up fill
   * @param {import('./disk.mjs').Disk|null} [opts.disk]  the floor jobs keep above
   * @param {import('./fingerprint.mjs').Fingerprints|null} [opts.fingerprints]
   * @param {number} [opts.stickyMs]  how long a continuing request keeps its playback's representation
   * @param {number} [opts.restartStickyMs]  the same for a request from byte 0
   * @param {(track: object) => void} [opts.onTagless]  a track from before just got its `tagless`
   * @param {number} [opts.busyRetryMs]  wait before a transcode whose name was held is made again
   * @param {object|null} [opts.lyricsTags]  what reads the lyrics tags of the tracks from before (lyrics.mjs)
   */
  constructor ({
    library, ffmpeg = null, capBytes = 10 * 1024 ** 3, backgroundDelayMs = 0, disk = null, fingerprints = null,
    stickyMs = STICKY_MS, restartStickyMs = RESTART_STICKY_MS, onTagless = () => {}, busyRetryMs = BUSY_RETRY_MS, lyricsTags = null, loudnessScan = true
  }) {
    this.library = library
    this.ffmpeg = ffmpeg
    this.capBytes = capBytes
    this.backgroundDelayMs = backgroundDelayMs
    this.disk = disk
    this.fingerprints = fingerprints
    this.stickyMs = stickyMs
    this.restartStickyMs = restartStickyMs
    this.onTagless = onTagless
    // The loudness measure of the tracks whose tags have none (off in the tests that count ffmpeg calls).
    this.loudnessScan = loudnessScan
    this.busyRetryMs = busyRetryMs
    this.lyricsTags = lyricsTags
    this.dir = library.transcodesDir
    this.places = library.places
    // What carries the originals onto the card and back (moves.mjs), when one is used.
    this.moves = null

    this.ffmpegAvailable = false // ffmpeg runs (covers can be resized)
    this.opusAvailable = false // ... and has libopus (transcodes can be made)
    this.stats = { done: 0, failed: 0, evicted: 0, skippedForCap: 0, covers: 0, fingerprints: 0, qualityChecks: 0, tags: 0, skippedForDisk: 0 }
    this.totalBytes = 0

    this._ready = new Map() // "<id>.<level>" -> { size, mtimeMs, lastUse, atimeSaved }
    this._queue = []
    this._queued = new Map() // key -> job
    this._seq = 0
    this._running = null
    this._failedAt = new Map()
    this._busy = new Map() // transcode key -> { tries, timer }: its name was held, made again later
    this._sticky = new Map() // "<who>|<id>|<q>" -> { level, at, active }, least recently used first
    this._tagsTried = new Set()
    this._loudTried = new Set()
    this._idleWaiters = []
    // Moves at every job queued (or raised) above the background: a long job of
    // the background steps aside when it changes.
    this._urgentSeq = 0
    this._awayJobs = new Set() // tracks whose job was cut by their card going away
    this._moveTimer = null
    this.scanned = null
    this._bgTimer = null
    this._closed = false
    this._started = false
  }

  // ------------------------------------------------------------------ start

  /** Scan transcodes/, probe ffmpeg, then queue the background fill. */
  async start () {
    this.scanned = this._scan()
    await this.scanned
    if (this.ffmpeg !== null) {
      const probe = await this.ffmpeg.probe()
      this.ffmpegAvailable = probe.ok
      this.opusAvailable = probe.ok && probe.opus
      if (!probe.ok) log('ffmpeg not available: no transcodes, no resized covers')
      else if (!probe.opus) log('ffmpeg has no libopus encoder: no transcodes (covers are still resized)')
    }
    if (this._closed) return
    this._started = true
    if (this.backgroundDelayMs > 0) {
      this._bgTimer = setTimeout(() => {
        this._bgTimer = null
        this._queueBackground()
      }, this.backgroundDelayMs)
      this._bgTimer.unref()
    } else {
      this._queueBackground()
    }
    this._pump()
  }

  // The transcodes of the places: listed shard by shard and stated in batches,
  // never blocking the loop in proportion to their number.
  async _scan () {
    await this._scanPlace(this.places.internal)
    const card = this.places.card
    if (card !== null && card.readable) await this._scanPlace(card)
    if (this.totalBytes > this.capBytes) this._evict(null)
  }

  async _scanPlace (place) {
    const found = []
    await this.places.list(place, 'transcodes', (names) => {
      for (const name of names) {
        const file = place.pathOf('transcodes', name)
        const m = TRANSCODE_FILE_RE.exec(name)
        if (m === null) {
          if (name.endsWith('.part') || name.endsWith('.tmp')) this._removeOn(place, file)
          continue
        }
        const track = this.library.getTrack(m[1])
        if (track === null || isSkipped(track, m[2])) {
          this._removeOn(place, file) // its track is gone (or the level is pointless): free the room
          continue
        }
        const had = this._ready.get(m[1] + '.' + m[2])
        if (had !== undefined && had.place !== place.code) {
          // Two copies of one level: the internal one stays.
          if (place.kind === 'card') this._removeOn(place, file)
          continue
        }
        found.push({ key: m[1] + '.' + m[2], file })
      }
    })
    const sts = await this.places.stats(place, found.map((f) => f.file))
    found.forEach(({ key, file }, i) => {
      const st = sts[i]
      if (st === null) return
      if (st.size === 0) {
        this._removeOn(place, file)
        return
      }
      const previous = this._ready.get(key)
      if (previous) this.totalBytes -= previous.size
      this._ready.set(key, { size: st.size, mtimeMs: st.mtimeMs, lastUse: st.atimeMs, atimeSaved: st.atimeMs, place: place.code })
      this.totalBytes += st.size
    })
  }

  /** The card stayed away: its transcodes leave (their levels turn false). */
  dropCardLevels () {
    for (const [key, e] of [...this._ready]) {
      if (e.place !== CODE.card) continue
      this._ready.delete(key)
      this.totalBytes -= e.size
    }
  }

  /**
   * The card is back: its transcodes are read again, and the background jobs
   * skipped while the originals of `ids` were away are queued for them.
   */
  async cardBack (ids) {
    const card = this.places.card
    if (card !== null && card.readable) await this._scanPlace(card)
    const back = new Set([...ids, ...this._awayJobs])
    this._awayJobs.clear()
    if (!this._started || this._closed) return
    const tracks = []
    for (const id of back) {
      const t = this.library.getTrack(id)
      if (t !== null) tracks.push(t)
    }
    this._queueBackground(tracks)
    if (this.moves !== null) this.moves.kick()
  }

  /** Is a job queued or running for this track? (its original moves only after them) */
  hasWorkFor (id) {
    if (this._running !== null && this._running.id === id && this._running.type !== 'move') return true
    for (const job of this._queue) if (job.id === id && job.type !== 'cover') return true
    return false
  }

  _queueBackground (only = null) {
    if (this._closed) return
    const tracks = only !== null ? only : [...this.library.tracks.values()]
    for (const track of tracks) if (track.fpState === 'none') this.requestFingerprint(track, PRIORITY.BACKGROUND)
    for (const track of tracks) if (track.sampleRate === null || track.tagless === null || track.genres === null) this.requestTags(track, PRIORITY.BACKGROUND)
    for (const track of tracks) this.requestQuality(track, PRIORITY.BACKGROUND)
    for (const track of tracks) this.requestLoudness(track)
    if (only === null) for (const coverId of this.library.embeddedCoverIds()) this.requestCoverSizes(coverId, PRIORITY.BACKGROUND)
    for (const track of tracks) this._queueLevels(track, PRIORITY.BACKGROUND)
    if (only === null && this.moves !== null) this.moves.kick()
  }

  /** Queued: a fingerprint (fpcalc) for a track that has none. */
  requestFingerprint (track, priority = PRIORITY.BACKGROUND) {
    if (this.fingerprints === null || !this.fingerprints.available || !this._originalHere(track)) return
    this._enqueue({ key: 'f:' + track.id, type: 'fingerprint', id: track.id, priority })
  }

  /** Queued: the quality analysis of a track not analysed by this version. */
  /**
   * Queued, last of all: the loudness of a track its tags say nothing of (the whole file through
   * ffmpeg's ebur128). Not before its tags were read again (they may have it). Once per start.
   */
  requestLoudness (track, priority = PRIORITY.BACKGROUND) {
    if (!this.ffmpegAvailable || !this.loudnessScan || track.loud !== null || track.genres === null) return
    if (this._loudTried.has(track.id) || !this._originalHere(track)) return
    this._enqueue({ key: 'l:' + track.id, type: 'loudness', id: track.id, priority })
  }

  requestQuality (track, priority = PRIORITY.BACKGROUND) {
    if (!this.ffmpegAvailable || !wantsQualityCheck(track) || !this._originalHere(track)) return
    this._enqueue({ key: 'q:' + track.id, type: 'quality', id: track.id, priority })
  }

  /**
   * Queued: the tags of a track from before, re-read for its codec, sample rate
   * and bit depth, for the fields its file has no tag for and for its genres.
   */
  requestTags (track, priority = PRIORITY.BACKGROUND) {
    if (this._tagsTried.has(track.id) || !this._originalHere(track)) return
    this._enqueue({ key: 'g:' + track.id, type: 'tags', id: track.id, priority })
  }

  /**
   * Queued: the lyrics tags of the tracks from before, ahead of the other
   * background jobs (they are read in process and cost little next to them).
   */
  requestLyricsTags (priority = PRIORITY.BACKGROUND) {
    if (this.lyricsTags === null) return
    this._enqueue({ key: 'y', type: 'lyrics', id: null, priority, seq: -1 })
  }

  // --------------------------------------------------------------- queries

  /** A transcode's path on its place (internal memory when not said). */
  transcodePath (id, level, place = this.places.internal) {
    if (!isTrackId(id) || !LEVELS[level]) throw new Error('invalid transcode')
    return place.transcodePath(id, level)
  }

  _placeOfKey (key) {
    const e = this._ready.get(key)
    return e === undefined ? this.places.internal : this.places.byCode(e.place) || this.places.internal
  }

  _originalHere (track) {
    return this.library.originalReady(track)
  }

  // Known (it counts in the codes until its card stayed away).
  _isReady (track, level) {
    return this._ready.has(track.id + '.' + level) && !isSkipped(track, level)
  }

  // Known and readable now: what may be served.
  _isServable (track, level) {
    const e = this._ready.get(track.id + '.' + level)
    if (e === undefined || isSkipped(track, level)) return false
    const place = this.places.byCode(e.place)
    return place !== null && place.readable
  }

  /** { low, normal, high }: which Opus versions are ready to stream. */
  qualities (track) {
    return {
      low: this._isReady(track, 'low'),
      normal: this._isReady(track, 'normal'),
      high: this._isReady(track, 'high')
    }
  }

  /**
   * What to serve for ?q=<q>, without stickiness. With the original away, `max`
   * falls back to the best ready level; null: nothing of the track is here now.
   */
  choose (track, q) {
    if (q !== 'max') {
      for (const level of fallbackOrder(q)) {
        if (this._isServable(track, level)) return this._served(track, level)
      }
    }
    if (this.library.originalReady(track)) return this._served(track, 'max')
    for (const level of ['high', 'normal', 'low']) {
      if (this._isServable(track, level)) return this._served(track, level)
    }
    return null
  }

  _served (track, level) {
    if (level === 'max') return { level, file: this.library.trackPath(track), place: this.library.placeOfTrack(track), mime: track.mime, tag: '"' + track.fileHash + '"' }
    const e = this._ready.get(track.id + '.' + level)
    const place = this.places.byCode(e.place) || this.places.internal
    const tag = '"' + track.id + '.' + level + '-' + e.size.toString(36) + '-' + Math.floor(e.mtimeMs).toString(36) + '"'
    return { level, file: place.transcodePath(track.id, level), place, mime: TRANSCODE_MIME, tag }
  }

  /**
   * The representation for a stream request (see the top of this file). A GET
   * passes the result to hold() for as long as its response is being sent.
   * @param {object} track
   * @param {string} q  low | normal | high | max
   * @param {object} [opts]
   * @param {string} [opts.who='local']  requester (client key, or 'local')
   * @param {boolean} [opts.continuation=false]  a Range that does not start at 0
   * @param {boolean} [opts.peek=false]  a HEAD: answer, record nothing, queue nothing
   * @returns {{ level, file, mime, tag, sticky }}  sticky: the playback's entry (null for a peek)
   */
  pick (track, q, { who = 'local', continuation = false, peek = false } = {}) {
    const key = who + '|' + track.id + '|' + q
    const now = Date.now()
    const s = this._sticky.get(key)
    const live = s !== undefined && (s.active > 0 || now - s.at < (continuation ? this.stickyMs : this.restartStickyMs))
    // A playback of the original whose card went away: bytes of another
    // representation never join it; from byte 0 the fallback applies.
    if (live && s.level === 'max' && !this.library.originalReady(track)) {
      if (!peek) this._sticky.delete(key)
      if (continuation) return null
    } else if (live && (s.level === 'max' || this._isServable(track, s.level))) {
      if (peek) return { ...this._served(track, s.level), sticky: null }
      s.at = now
      this._sticky.delete(key) // most recently used last
      this._sticky.set(key, s)
      return { ...this._served(track, s.level), sticky: s }
    }
    const choice = this.choose(track, q)
    if (choice === null) return null
    if (peek) return { ...choice, sticky: null }
    const entry = { level: choice.level, at: now, active: 0 }
    this._sticky.delete(key)
    this._sticky.set(key, entry)
    if (this._sticky.size > STICKY_MAX) {
      // Least recently used first; a playback whose response is still open stays.
      for (const [k, e] of this._sticky) {
        if (this._sticky.size <= STICKY_MAX * 0.8) break
        if (e.active === 0) this._sticky.delete(k)
      }
    }
    // Asked for a level that could exist but does not (yet, or any more): make it.
    if (q !== 'max' && choice.level !== q && !isSkipped(track, q)) this.requestTranscode(track, q, PRIORITY.DEMAND)
    return { ...choice, sticky: entry }
  }

  /**
   * A response for `served` (from pick) is being sent: its playback cannot expire
   * meanwhile, however long it lasts. Returns the release to call when that
   * response is over (finished or cut); the playback's clock restarts then.
   */
  hold (served) {
    const e = served.sticky
    if (!e) return () => {}
    e.active++
    let released = false
    return () => {
      if (released) return
      released = true
      e.active--
      e.at = Date.now()
    }
  }

  /** A transcode file vanished under us: forget it. */
  forget (id, level) {
    const key = id + '.' + level
    const e = this._ready.get(key)
    if (!e) return
    this._ready.delete(key)
    this.totalBytes -= e.size
    this.library.derivedChanged([id])
  }

  /** A transcode is being streamed: it is now the most recently used. */
  noteStreamed (id, level) {
    const e = this._ready.get(id + '.' + level)
    if (!e) return
    const now = Date.now()
    e.lastUse = now
    if (now - e.atimeSaved < ATIME_EVERY_MS) return
    e.atimeSaved = now
    const place = this._placeOfKey(id + '.' + level)
    const file = place.transcodePath(id, level)
    const set = () => fs.promises.utimes(file, new Date(now), new Date(e.mtimeMs))
    const done = place.kind === 'internal' ? set() : this.places.cardCall(set, { write: true })
    done.catch(() => {})
  }

  // ---------------------------------------------------------------- enqueue

  _enqueue (job) {
    if (this._closed) return
    const failed = this._failedAt.get(job.key)
    if (failed !== undefined && Date.now() - failed < FAIL_BLOCK_MS) return
    if (this._running !== null && this._running.key === job.key) return
    if (job.priority < PRIORITY.BACKGROUND) this._urgentSeq++
    const queued = this._queued.get(job.key)
    if (queued) {
      if (job.priority < queued.priority) queued.priority = job.priority
    } else {
      job.seq = job.seq !== undefined ? job.seq : this._seq++
      this._queue.push(job)
      this._queued.set(job.key, job)
    }
    this._pump()
  }

  requestTranscode (track, level, priority = PRIORITY.DEMAND) {
    if (!this.opusAvailable || !LEVELS[level] || isSkipped(track, level) || this._isReady(track, level) || !this._originalHere(track)) return
    this._enqueue({ key: 't:' + track.id + '.' + level, type: 'transcode', id: track.id, level, priority })
  }

  requestCoverSizes (coverId, priority = PRIORITY.DEMAND) {
    if (!this.ffmpegAvailable || !coverId) return
    for (const size of COVER_SIZES) {
      if (fs.existsSync(this.library.sizedCoverPath(coverId, size))) continue
      this._enqueue({ key: 'c:' + coverId + '.' + size, type: 'cover', id: coverId, size, priority })
    }
  }

  _queueLevels (track, priority) {
    for (const level of ['high', 'normal', 'low']) this.requestTranscode(track, level, priority)
  }

  /** After an upload: its cover sizes, the quality analysis, then high, normal, low. */
  onUpload (track) {
    if (track.coverId) this.requestCoverSizes(track.coverId, PRIORITY.UPLOAD)
    this.requestQuality(track, PRIORITY.UPLOAD)
    this.requestLoudness(track)
    this._queueLevels(track, PRIORITY.UPLOAD)
    if (this.moves !== null) this.moves.note()
  }

  /** A transcode spilled onto the card (the card being left), or null. */
  cardTranscodeKey () {
    for (const [key, e] of this._ready) if (e.place === CODE.card) return key
    return null
  }

  /**
   * A spilled transcode comes back to internal memory while it has room above
   * its floor, else it is deleted (a cache, made again on demand).
   */
  async transcodeOut (key, { signal = null } = {}) {
    const e = this._ready.get(key)
    if (e === undefined || e.place !== CODE.card) return
    const card = this.places.card
    const internal = this.places.internal
    const dot = key.indexOf('.')
    const id = key.slice(0, dot)
    const level = key.slice(dot + 1)
    const src = card.transcodePath(id, level)
    if (await this.places.hasRoom(internal, e.size)) {
      try {
        const dest = await this.places.copy(src, card, internal, 'transcodes/' + id.slice(0, 2) + '/' + key + '.opus', { size: e.size, signal, beforeCommit: () => this._ready.get(key) === e })
        const st = fs.statSync(dest)
        this._ready.set(key, { ...e, size: st.size, mtimeMs: st.mtimeMs, place: CODE.internal })
        this.totalBytes += st.size - e.size
        await this.places.remove(card, src)
        return
      } catch (err) {
        if (isCardAway(err, card) || err.code === 'ABORT_ERR') return
      }
    }
    this._ready.delete(key)
    this.totalBytes -= e.size
    await this.places.remove(card, src)
    this.library.derivedChanged([id])
  }

  /** A better file under a track: its transcodes go and are made again. */
  onFileReplaced (track) {
    this.onTrackDeleted(track)
    for (const key of [...this._sticky.keys()]) if (key.includes('|' + track.id + '|')) this._sticky.delete(key)
    this.onUpload(track)
  }

  /**
   * A track was deleted: its transcodes go, its queued jobs too, and what failed
   * for its file is forgotten (a new file under the same id starts afresh).
   */
  onTrackDeleted (track) {
    for (const [key, job] of [...this._queued]) {
      if (job.id === track.id && job.type !== 'cover') this._unqueue(key)
    }
    let changed = false
    for (const level of LEVEL_NAMES) {
      const key = track.id + '.' + level
      this._failedAt.delete('t:' + key)
      this._notBusy('t:' + key)
      const e = this._ready.get(key)
      if (e) {
        this._ready.delete(key)
        this.totalBytes -= e.size
        changed = true
        const place = this.places.byCode(e.place)
        if (place !== null && place.kind === 'card') this._removeOn(place, place.transcodePath(track.id, level))
      }
      this._removeFile(this.transcodePath(track.id, level))
    }
    if (changed) this.library.derivedChanged([track.id])
  }

  /**
   * Delete a transcode of internal memory, moved aside first so its name is free
   * at once even while a listener reads it (Windows). False when it is still there.
   */
  _removeFile (file) {
    return removeAside(file, this.places.internal.tmpDir)
  }

  // The same on any place (a card's: asynchronous, true when asked).
  _removeOn (place, file) {
    if (place.kind === 'internal') return this._removeFile(file)
    this.places.remove(place, file).catch(() => {})
    return true
  }

  _unqueue (key) {
    const job = this._queued.get(key)
    if (!job) return
    this._queued.delete(key)
    const i = this._queue.indexOf(job)
    if (i !== -1) this._queue.splice(i, 1)
  }

  // ------------------------------------------------------------------- pump

  _pump () {
    if (this._closed || !this._started || this._running !== null) return
    if (this._queue.length === 0) {
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const resolve of waiters) resolve()
      // Originals left for after their jobs may move now.
      if (this.moves !== null) this.moves.drained()
      return
    }
    let best = 0
    for (let i = 1; i < this._queue.length; i++) {
      const a = this._queue[i]
      const b = this._queue[best]
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i
    }
    const job = this._queue.splice(best, 1)[0]
    this._queued.delete(job.key)
    this._running = job
    job.stop = new AbortController()
    const run = { transcode: this._runTranscode, cover: this._runCover, fingerprint: this._runFingerprint, quality: this._runQuality, loudness: this._runLoudness, tags: this._runTags, lyrics: this._runLyrics, move: this._runMove }[job.type]
    const work = run.call(this, job)
    job.work = work.catch((err) => logError('media job ' + job.key + ' crashed: ' + (err && err.stack ? err.stack : err)))
      .finally(() => {
        this._running = null
        // A job that stepped aside takes its place again (its turn kept).
        if (job.requeue === true && !this._closed && !this._queued.has(job.key)) {
          job.requeue = false
          job.id = null
          this._queue.push(job)
          this._queued.set(job.key, job)
        }
        // Next job on a fresh tick: no deep recursion, and close() can interleave.
        setImmediate(() => this._pump())
      })
  }

  /**
   * Before a track's file is replaced or deleted: the job reading it now (if
   * any) is stopped and its end awaited. Its work was for that file, and on
   * Windows a file a tool still holds open cannot be moved or deleted. Resolves
   * with the stopped job (null: none), for again().
   */
  async stopFor (trackId) {
    const job = this._running
    if (job === null || job.id !== trackId || job.type === 'cover') return null
    job.stop.abort()
    await job.work
    return job
  }

  /** A job stopFor() stopped, whose file stayed after all: queued again. */
  again (job) {
    if (job === null || this.library.getTrack(job.id) === null) return
    const { key, type, id, level, size, priority } = job
    this._enqueue({ key, type, id, level, size, priority })
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  idle () {
    if (this._closed || !this._started || (this._running === null && this._queue.length === 0)) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  /** How many jobs of a type wait (admin health). */
  queuedOf (type) {
    let n = 0
    for (const job of this._queue) if (job.type === type) n++
    return n
  }

  get busy () {
    return this._running !== null || this._queue.length > 0
  }

  _tmpFile (key) {
    return path.join(this.library.tmpDir, 'job-' + key.replace(/[^0-9a-z.]/g, '_') + '-' + crypto.randomBytes(4).toString('hex') + '.part')
  }

  // May a background job write now (the disk above its floor)?
  async _mayWrite () {
    if (this.disk === null) return true
    if (await this.disk.jobsMayWrite()) return true
    this.stats.skippedForDisk++
    return false
  }

  async _runFingerprint (job) {
    const fps = this.fingerprints
    const track = this.library.getTrack(job.id)
    if (track === null || fps === null || !fps.available || track.fpState !== 'none') return
    if (!(await this._mayWrite())) return
    const fileHash = track.fileHash
    let fp
    try {
      fp = await this.library.withLocalFile(track, (file) => fps.compute(file), { signal: job.stop.signal })
    } catch (err) {
      if (await this._cutByCard(err, track)) return
      throw err
    }
    const now = this.library.getTrack(job.id)
    if (this._closed || now === null || now.fileHash !== fileHash) return // replaced or deleted meanwhile
    if (fp === null) {
      this.library.setTrack({ ...now, fpState: 'failed' })
      this.stats.failed++
      return
    }
    fps.save(fileHash, fp)
    fps.indexAdd(now.id, fileHash, fp.duration)
    this.library.setTrack({ ...now, fp: signatureOf(fp.items, now.duration !== null ? now.duration : fp.duration), fpState: 'ok' })
    this.stats.fingerprints++
  }

  async _runQuality (job) {
    let track = this.library.getTrack(job.id)
    if (track === null || !this.ffmpegAvailable) return
    if (track.sampleRate === null) {
      await this._runTags(job)
      track = this.library.getTrack(job.id)
      if (track === null) return
    }
    if (!wantsQualityCheck(track)) return
    const fileHash = track.fileHash
    // Every run ends with this version, inconclusive included: no retry loop.
    let measured = null
    try {
      measured = skipsAnalysis(track) ? null : await this.library.withLocalFile(track, (file) => measureQuality(this.ffmpeg, file, track.duration, job.stop.signal), { signal: job.stop.signal })
    } catch (err) {
      if (await this._cutByCard(err, track)) return
      throw err
    }
    const now = this.library.getTrack(job.id)
    if (this._closed || job.stop.signal.aborted || now === null || now.fileHash !== fileHash) return
    this.library.setTrack(applyQuality({ ...now }, measured))
    this.stats.qualityChecks++
  }

  async _runLoudness (job) {
    const track = this.library.getTrack(job.id)
    if (track === null || !this.ffmpegAvailable || track.loud !== null || this._loudTried.has(job.id)) return
    this._loudTried.add(job.id)
    const fileHash = track.fileHash
    let measured = null
    try {
      const { stderr } = await this.library.withLocalFile(track, (file) => this.ffmpeg.run(loudnessArgs(file), { stderr: true, quiet: true, timeoutMs: LOUDNESS_TIMEOUT, signal: job.stop.signal }), { signal: job.stop.signal })
      measured = loudnessOf(stderr)
    } catch (err) {
      if (await this._cutByCard(err, track)) {
        this._loudTried.delete(job.id)
        return
      }
      if (this._closed || job.stop.signal.aborted) return
      logError('loudness of ' + track.id + ' not measured: ' + (err && err.message))
      return
    }
    const now = this.library.getTrack(job.id)
    if (this._closed || job.stop.signal.aborted || now === null || now.fileHash !== fileHash || now.loud !== null) return
    const loud = measured === null ? null : loudFromScan(measured.lufs, measured.peak)
    if (loud !== null) this.library.setTrack({ ...now, loud })
  }

  async _runTags (job) {
    const track = this.library.getTrack(job.id)
    if (track === null || this._tagsTried.has(job.id)) return
    this._tagsTried.add(job.id)
    try {
      const { metadata } = await this.library.withLocalFile(track, async (file) => {
        const head = await readHead(file, HEAD_BYTES)
        return readAudio(file, sniffAudio(head), { covers: false, duration: false })
      })
      const fresh = buildTrack({ id: track.id, format: track.format, metadata, size: track.size, fallbackTitle: track.title, coverId: track.coverId, addedAt: track.addedAt })
      const now = this.library.getTrack(job.id)
      if (now === null || now.fileHash !== track.fileHash) return
      const next = { ...now }
      let changed = false
      if (now.sampleRate === null && !(fresh.sampleRate === null && fresh.bitDepth === null && fresh.codec === now.codec)) {
        next.codec = fresh.codec
        next.sampleRate = fresh.sampleRate
        next.bitDepth = now.lossless ? fresh.bitDepth : null
        changed = true
      }
      // A track from before: which fields its file has no tag for. Its stored
      // values may be a person's edits, which left no trace then.
      const tagless = now.tagless === null
      if (tagless) {
        next.tagless = taglessOf(metadata.common, now.coverId)
        next.editedUnknown = true
        changed = true
      }
      const genresRead = now.genres === null
      if (genresRead) {
        // Read with the genres: its sort tags and the loudness its tags give.
        next.genres = fresh.genres
        next.sort = fresh.sort
        if (now.loud === null) next.loud = fresh.loud
        changed = true
      }
      if (!changed) return
      const saved = this.library.setTrack(next)
      this.stats.tags++
      // Its tags read again: what it misses, its genres included, may be looked up now.
      if (tagless || genresRead) this.onTagless(saved)
      if (genresRead) this.requestLoudness(saved)
    } catch (err) {
      if (await this._cutByCard(err, track)) {
        this._tagsTried.delete(job.id)
        return
      }
      logError('tags of ' + track.id + ' unreadable: ' + err.message)
    }
  }

  // A job cut because the card of its file went away: not a failure (no block,
  // no count); it runs again when the card is back.
  async _cutByCard (err, track) {
    const place = this.library.placeOfTrack(track)
    // An error of the card itself: its marker is read again before deciding.
    if (place !== null && place.kind === 'card' && place.ready && err && err.code !== 'ENOENT' && err.code !== 'ABORT_ERR') await this.places.recheck()
    if (!isCardAway(err, place)) return false
    this._awayJobs.add(track.id)
    return true
  }

  /** Queued: one step of the move of the originals onto the card or back. */
  requestMove () {
    if (this._moveTimer !== null) return
    this._enqueue({ key: 'm', type: 'move', id: null, priority: PRIORITY.BACKGROUND })
  }

  // One file moved, then queued again while there is work; a job of a higher
  // priority waiting makes it step aside first. While a card stream plays it
  // waits, and goes on 10 s after the last one.
  async _runMove (job) {
    if (this.moves === null) return
    if (this._urgentSeq !== (job.seen === undefined ? this._urgentSeq : job.seen)) {
      job.seen = this._urgentSeq
      job.requeue = true
      return
    }
    job.seen = this._urgentSeq
    const r = await this.moves.step({ signal: job.stop.signal, current: (id) => { job.id = id } })
    job.id = null
    if (this._closed) return
    if (r === 'more') {
      job.requeue = true
    } else if (r === 'wait') {
      this._moveTimer = setTimeout(() => {
        this._moveTimer = null
        this.requestMove()
      }, this.places.streamQuietMs)
      this._moveTimer.unref()
    }
  }

  // A slice of the lyrics tags: until they are all read, the job is stopped, or a
  // job of a higher priority waits (then it is queued again, its turn kept). While
  // a file is open, the job names its track, so stopFor() waits for it.
  async _runLyrics (job) {
    if (this.lyricsTags === null) return
    const seen = this._urgentSeq
    const done = await this.lyricsTags.tagsSlice({
      signal: job.stop.signal,
      current: (id) => { job.id = id },
      yieldTo: () => this._urgentSeq !== seen
    })
    if (!done) job.requeue = true
  }

  async _runTranscode (job) {
    const track = this.library.getTrack(job.id)
    if (track === null || !this.opusAvailable || isSkipped(track, job.level) || this._isReady(track, job.level)) return
    if (job.priority >= PRIORITY.BACKGROUND && this.totalBytes >= this.capBytes) {
      this.stats.skippedForCap++
      return
    }
    // Its place: internal memory while it has room above its floor, else a card in use.
    let place = this.places.internal
    if (this.places.card === null) {
      if (!(await this._mayWrite())) {
        log('transcode of ' + job.id + ' ' + job.level + ' skipped: disk almost full')
        return
      }
    } else {
      place = await this.places.forNew('transcode', Math.ceil(LEVELS[job.level] * 1000 / 8 * (track.duration || 0) * 1.05))
      if (place === null) {
        this.stats.skippedForDisk++
        log('transcode of ' + job.id + ' ' + job.level + ' skipped: disk almost full')
        return
      }
    }
    if (this._closed || this.library.getTrack(job.id) === null) return // deleted meanwhile
    const tmp = this._tmpFile(job.key)
    let args = null
    // Made from this file: a file replaced meanwhile makes it worthless.
    const current = () => {
      const now = this.library.getTrack(job.id)
      return now !== null && now.fileHash === track.fileHash
    }
    let naming = false
    try {
      await this.library.withLocalFile(track, async (input) => {
        args = transcodeArgs(input, LEVELS[job.level], tmp)
        await this.ffmpeg.run(args, { signal: job.stop.signal })
      }, { signal: job.stop.signal })
      const ok = await startsWith(tmp, 'OggS')
      if (!ok) throw new Error('output is not an Ogg file: ' + this.ffmpeg.commandLine(args))
      if (this._closed || !current()) {
        await unlinkQuietAsync(tmp)
        return
      }
      const key = job.id + '.' + job.level
      let dest
      if (place.kind === 'internal') {
        dest = this.transcodePath(job.id, job.level)
        this.places.ensureShardSync(place, 'transcodes', job.id.slice(0, 2))
        // A file left under that name (one that could not go before) steps aside.
        this._removeFile(dest)
        naming = true
        renameSyncRetry(tmp, dest)
        naming = false
        try { fs.chmodSync(dest, 0o644) } catch {}
      } else {
        // Spilled onto the card: copied there, read back, then committed.
        dest = await this.places.copy(tmp, this.places.internal, place, 'transcodes/' + job.id.slice(0, 2) + '/' + job.id + '.' + job.level + '.opus', { signal: job.stop.signal, beforeCommit: current })
        await unlinkQuietAsync(tmp)
      }
      this._notBusy(job.key)
      const st = place.kind === 'internal' ? fs.statSync(dest) : (await this.places.stats(place, [dest]))[0]
      if (st === null) throw new Error('the transcode is not where it was put')
      const previous = this._ready.get(key)
      if (previous) this.totalBytes -= previous.size
      const now = Date.now()
      this._ready.set(key, { size: st.size, mtimeMs: st.mtimeMs, lastUse: now, atimeSaved: now, place: place.code })
      this.totalBytes += st.size
      this.stats.done++
      this._evict(key)
      this.library.derivedChanged([job.id])
    } catch (err) {
      await unlinkQuietAsync(tmp)
      if (this._closed || job.stop.signal.aborted || !current()) return // stopping, or the file or track went away
      if (await this._cutByCard(err, track) || (place.kind === 'card' && isCardAway(err, place))) return
      // Made, but a program holds its name (Windows): not a failure of the transcode.
      if (naming && isBusy(err) && this._busyLater(job)) return
      this._failedAt.set(job.key, Date.now())
      this.stats.failed++
      logError('transcode ' + job.id + ' ' + job.level + ' failed: ' + err.message)
    }
  }

  // The transcode is queued again after a while, a few times in a row at most.
  _busyLater (job) {
    const b = this._busy.get(job.key) || { tries: 0, timer: null }
    if (b.tries >= BUSY_TRIES) {
      this._notBusy(job.key)
      return false
    }
    b.tries++
    const wait = this.busyRetryMs * b.tries
    log('transcode ' + job.id + ' ' + job.level + ': its file is in use, made again in ' + Math.round(wait / 1000) + ' s')
    b.timer = setTimeout(() => {
      b.timer = null
      const track = this.library.getTrack(job.id)
      if (track !== null) this.requestTranscode(track, job.level, job.priority)
    }, wait)
    b.timer.unref()
    this._busy.set(job.key, b)
    return true
  }

  _notBusy (key) {
    const b = this._busy.get(key)
    if (b === undefined) return
    if (b.timer !== null) clearTimeout(b.timer)
    this._busy.delete(key)
  }

  async _runCover (job) {
    if (!this.ffmpegAvailable || !this.library.isEmbeddedCover(job.id)) return
    const dest = this.library.sizedCoverPath(job.id, job.size)
    if (fs.existsSync(dest)) return
    const source = this.library.coverPath(job.id)
    if (source === null) return
    if (!(await this._mayWrite())) return
    const tmp = this._tmpFile(job.key)
    const args = coverArgs(source.file, COVER_PIXELS[job.size], tmp)
    try {
      await this.ffmpeg.run(args)
      const head = await readHead(tmp, 16)
      if (head.length === 0 || sniffImage(head) !== 'jpg') throw new Error('output is not a JPEG: ' + this.ffmpeg.commandLine(args))
      if (this._closed || !this.library.isEmbeddedCover(job.id)) {
        await unlinkQuietAsync(tmp)
        return
      }
      renameSyncRetry(tmp, dest)
      try { fs.chmodSync(dest, 0o644) } catch {}
      this.stats.covers++
    } catch (err) {
      await unlinkQuietAsync(tmp)
      if (this._closed) return
      this._failedAt.set(job.key, Date.now())
      this.stats.failed++
      logError('cover ' + job.id + ' ' + job.size + ' failed: ' + err.message)
    }
  }

  // Least recently streamed first, until transcodes/ fits the cap again. `keep`
  // (the transcode just made) is never evicted for its own sake.
  _evict (keep) {
    if (this.totalBytes <= this.capBytes) return
    const order = [...this._ready].filter(([key]) => key !== keep).sort((a, b) => a[1].lastUse - b[1].lastUse)
    const evicted = []
    for (const [key, e] of order) {
      if (this.totalBytes <= this.capBytes) break
      const dot = key.indexOf('.')
      const place = this.places.byCode(e.place) || this.places.internal
      if (place.kind === 'card' && !place.ready) continue
      const file = place.transcodePath(key.slice(0, dot), key.slice(dot + 1))
      if (!this._removeOn(place, file)) continue // held by a program (Windows): try the next one
      this._ready.delete(key)
      this.totalBytes -= e.size
      evicted.push(key.slice(0, dot))
    }
    if (evicted.length > 0) {
      this.stats.evicted += evicted.length
      log('transcodes: evicted ' + evicted.length + ' file(s), ' + Math.round(this.totalBytes / 1048576) + ' MB kept')
      this.library.derivedChanged([...new Set(evicted)])
    }
  }

  close () {
    this._closed = true
    if (this._bgTimer !== null) clearTimeout(this._bgTimer)
    this._bgTimer = null
    if (this._moveTimer !== null) clearTimeout(this._moveTimer)
    this._moveTimer = null
    this._queue = []
    this._queued.clear()
    for (const key of [...this._busy.keys()]) this._notBusy(key)
    if (this.ffmpeg !== null) this.ffmpeg.close()
    const waiters = this._idleWaiters
    this._idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}

async function readHead (file, n) {
  let fh = null
  try {
    fh = await fs.promises.open(file, 'r')
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fh !== null) await fh.close().catch(() => {})
  }
}

async function startsWith (file, magic) {
  const head = await readHead(file, magic.length)
  return head.length === magic.length && head.toString('latin1') === magic
}
